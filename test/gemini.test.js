import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiService } from '../src/services/gemini.js';
import { loadConfig } from '../src/config.js';

test('configuration parses allowlists and provides safe defaults', () => {
  const config = loadConfig({
    WHATSAPP_ALLOWED_NUMBERS: '["5511999999999", "5511888888888"]',
    PORT: '8080'
  });
  assert.deepEqual(config.allowedNumbers, ['5511999999999', '5511888888888']);
  assert.equal(config.port, 8080);
  assert.equal(config.dashboardEnabled, false);
  assert.equal(config.geminiApiKey, '');
  assert.equal(loadConfig({ WHATSAPP_ALLOWED_NUMBERS: '[]' }).allowedNumbersConfigured, true);
  assert.throws(() => loadConfig({ PORT: '0' }), /inteiro positivo/);
});

test('Gemini requests carry conversation context and configured persona', async () => {
  let capturedRequest;
  const gemini = createGeminiService({
    model: 'test-model',
    ai: {
      models: {
        generateContent: async (request) => {
          capturedRequest = request;
          return { text: 'Olá!' };
        }
      }
    }
  });

  assert.equal(await gemini.generate({
    history: [{ role: 'user', conteudo: 'Oi', tipo: 'texto' }],
    text: 'Tudo bem?',
    user: { persona: 'formal' }
  }), 'Olá!');
  assert.equal(capturedRequest.contents[0].role, 'user');
  assert.match(capturedRequest.config.systemInstruction, /formal e profissional/);
});

test('Gemini stream assembles text chunks', async () => {
  const gemini = createGeminiService({
    model: 'test-model',
    ai: {
      models: {
        generateContentStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { text: 'Olá' };
            yield { text: ' mundo' };
          }
        })
      }
    }
  });
  assert.equal(await gemini.stream({ text: 'Oi' }), 'Olá mundo');
});

test('Gemini function calls return tool results to the next model turn', async () => {
  let requests = 0;
  const gemini = createGeminiService({
    model: 'test-model',
    ai: {
      models: {
        generateContent: async (request) => {
          requests += 1;
          if (requests === 1) {
            return {
              functionCalls: [{ name: 'calcular_expressao', args: { expr: '2+2' } }],
              candidates: [{ content: { parts: [{ functionCall: { name: 'calcular_expressao', args: { expr: '2+2' } } }] } }]
            };
          }
          assert.equal(request.contents.at(-1).parts[0].functionResponse.response.result.resultado, 4);
          return { text: 'O resultado é 4.' };
        }
      }
    }
  });
  assert.equal(await gemini.generate({ text: 'Quanto é 2+2?' }), 'O resultado é 4.');
  assert.equal(requests, 2);
});
