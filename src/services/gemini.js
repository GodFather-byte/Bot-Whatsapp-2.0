import { GoogleGenAI } from '@google/genai';
import { toolDeclarations, executeTool } from '../handlers/tools.js';
import { buildAssistantPrompt } from '../assistant/profile.js';
import { WEEKDAY_LABELS, zonedParts } from '../utils/time.js';

// A persona só ajusta o tom: as regras do assistente (buildAssistantPrompt) vão em toda resposta.
export const SYSTEM_INSTRUCTIONS = {
  padrao: 'Tom acolhedor, simpático e direto.',
  formal: 'Seja formal e profissional: linguagem cuidadosa e sem emojis.',
  engraçado: 'Seja divertido e bem-humorado: tom casual e emojis, sem perder a clareza das informações.',
  técnico: 'Seja técnico e detalhado ao explicar, sem inventar nada.'
};

const MAX_TOOL_ROUNDS = 6;

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tempo limite da API Gemini excedido.')), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function isRateLimit(error) {
  return error?.status === 429 || error?.code === 429 || /429|resource.?exhausted/i.test(error?.message || '');
}

function retryDelay(error, attempt) {
  const retryInfo = error?.details?.find?.((detail) => detail['@type']?.includes('RetryInfo'));
  const delay = retryInfo?.retryDelay?.match?.(/^(\d+(?:\.\d+)?)s$/);
  return delay ? Math.min(Number(delay[1]) * 1000, 10_000) : 500 * (2 ** attempt);
}

// A data de hoje (e não a hora) mantém o prompt estável durante o dia e basta para entender "amanhã" ou "sexta".
function todayLine(now, timeZone) {
  const local = zonedParts(now, timeZone);
  const date = `${String(local.day).padStart(2, '0')}/${String(local.month).padStart(2, '0')}/${local.year}`;
  return `Data de hoje: ${WEEKDAY_LABELS[local.weekday]}, ${date}, fuso ${timeZone}.`;
}

function instructionFor(user, extraInstruction, { assistant, now, timeZone }) {
  const persona = user?.persona || 'padrao';
  const base = SYSTEM_INSTRUCTIONS[persona] || SYSTEM_INSTRUCTIONS.padrao;
  const language = user?.idioma ? `Responda sempre no idioma ${user.idioma}.` : '';
  const extra = extraInstruction ? `\nInformações e instruções do dono deste número (siga e pode usar): ${extraInstruction}` : '';
  const format = '\nVocê está no WhatsApp: use *negrito*, _itálico_ e listas com "-"; evite tabelas e títulos com #.';
  return `${buildAssistantPrompt(assistant)}\n\n${todayLine(now, timeZone)}\n\nTom das respostas: ${base} ${language}${format}${extra}`;
}

export function createGeminiService({
  apiKey,
  model,
  maxTokens,
  timeoutMs,
  apiKeys = {},
  ai,
  onUsage = () => {},
  timeZone = 'America/Sao_Paulo',
  now = () => new Date(),
  ownerName = ''
} = {}) {
  const client = ai || (apiKey ? new GoogleGenAI({ apiKey }) : null);

  async function callWithRetry(request) {
    if (!client) throw new Error('GEMINI_API_KEY não foi configurada.');
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await withTimeout(client.models.generateContent(request), timeoutMs || 30_000);
        onUsage({ model, usage: response.usageMetadata });
        return response;
      } catch (error) {
        if (isRateLimit(error)) onUsage({ model, rateLimited: true });
        if (!isRateLimit(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelay(error, attempt)));
      }
    }
  }

  async function generate({ history = [], parts, text, user = {}, extraInstruction, assistant }) {
    const contents = history.map(({ role, conteudo }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: conteudo }]
    }));
    contents.push({ role: 'user', parts: parts || [{ text }] });

    let request = {
      model,
      contents,
      config: {
        maxOutputTokens: maxTokens || 2048,
        systemInstruction: instructionFor(user, extraInstruction, { assistant: { ownerName, ...assistant }, now: now(), timeZone }),
        tools: [{ functionDeclarations: toolDeclarations }]
      }
    };

    for (let call = 0; call < MAX_TOOL_ROUNDS; call += 1) {
      const response = await callWithRetry(request);
      const functionCalls = response.functionCalls || [];
      if (!functionCalls.length) return response.text || 'Não consegui gerar uma resposta.';

      const modelParts = response.candidates?.[0]?.content?.parts || [];
      const functionResponses = await Promise.all(functionCalls.map(async ({ name, args }) => {
        try {
          return { functionResponse: { name, response: { result: await executeTool(name, args, { apiKeys }) } } };
        } catch (error) {
          return { functionResponse: { name, response: { error: error.message } } };
        }
      }));
      request = {
        ...request,
        contents: [
          ...request.contents,
          { role: 'model', parts: modelParts },
          { role: 'user', parts: functionResponses }
        ]
      };
    }

    throw new Error('O Gemini excedeu o limite de chamadas de ferramentas.');
  }

  async function stream({ history = [], parts, text, user = {}, extraInstruction, assistant }) {
    if (!client) throw new Error('GEMINI_API_KEY não foi configurada.');
    const contents = history.map(({ role, conteudo }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: conteudo }]
    }));
    contents.push({ role: 'user', parts: parts || [{ text }] });
    let request = {
      model,
      contents,
      config: {
        maxOutputTokens: maxTokens || 2048,
        systemInstruction: instructionFor(user, extraInstruction, { assistant: { ownerName, ...assistant }, now: now(), timeZone }),
        tools: [{ functionDeclarations: toolDeclarations }]
      }
    };

    for (let call = 0; call < MAX_TOOL_ROUNDS; call += 1) {
      let result;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await withTimeout((async () => {
            const response = await client.models.generateContentStream(request);
            let textResult = '';
            let usage;
            const functionCalls = [];
            for await (const chunk of response) {
              textResult += chunk.text || '';
              functionCalls.push(...(chunk.functionCalls || []));
              usage = chunk.usageMetadata || usage;
            }
            return { text: textResult, functionCalls, usage };
          })(), timeoutMs || 30_000);
          onUsage({ model, usage: result.usage });
          break;
        } catch (error) {
          if (isRateLimit(error)) onUsage({ model, rateLimited: true });
          if (!isRateLimit(error) || attempt >= 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelay(error, attempt)));
        }
      }

      if (!result.functionCalls.length) return result.text || 'Não consegui gerar uma resposta.';
      const functionResponses = await Promise.all(result.functionCalls.map(async ({ name, args }) => {
        try {
          return { functionResponse: { name, response: { result: await executeTool(name, args, { apiKeys }) } } };
        } catch (error) {
          return { functionResponse: { name, response: { error: error.message } } };
        }
      }));
      request = {
        ...request,
        contents: [
          ...request.contents,
          { 
            role: 'model', 
            parts: [
              ...(result.text ? [{ text: result.text }] : []),
              ...result.functionCalls.map((functionCall) => ({ functionCall }))
            ]
          },
          { role: 'user', parts: functionResponses }
        ]
      };
    }

    throw new Error('O Gemini excedeu o limite de chamadas de ferramentas.');
  }

  return { generate, stream };
}
