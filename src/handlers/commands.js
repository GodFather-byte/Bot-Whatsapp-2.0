import { SYSTEM_INSTRUCTIONS } from '../services/gemini.js';
import { formatDateTime, parseReminder, WEEKDAY_LABELS } from '../utils/time.js';
import { toWhatsAppFormat } from '../utils/format.js';
import { executeTool } from './tools.js';

const commandHelp = [
  '/reset — limpa o histórico da conversa',
  '/ajuda — mostra esta lista de comandos',
  '/status — mostra o status do bot e sua persona',
  '/resumo — resume as últimas mensagens',
  '/persona formal|engraçado|técnico — altera o tom das respostas',
  '/idioma pt-BR|en|es — altera o idioma das respostas',
  '/imagem <descrição> — gera uma imagem com o Gemini',
  '/lembrete <quando> <mensagem> — agenda um lembrete (ex.: 14:30, amanhã 09:00, 25/12 10:00, em 30 min, todo dia 08:00, toda segunda 09:00)',
  '/lembretes — lista seus lembretes',
  '/cancelar_lembrete <id> — cancela um lembrete',
  '/calc <conta> — calcula (ex.: /calc 2*(3+4))',
  '/hora [fuso] — hora de qualquer fuso (ex.: /hora Europe/Lisbon)',
  '/clima <cidade> e /noticias <assunto> — precisam das chaves de clima e notícias',
  '/cambio <valor> <de> <para> — converte moedas (ex.: /cambio 100 usd brl)',
  '/traduzir <idioma> <texto> — traduz um texto (ex.: /traduzir inglês bom dia)',
  '/dado [lados], /moeda e /sorteio a, b, c — decisões no acaso'
].join('\n');

const reminderHelp = [
  'Não entendi o horário. Exemplos:',
  '/lembrete 14:30 reunião',
  '/lembrete amanhã 09:00 pagar conta',
  '/lembrete 25/12 10:00 ligar para a família',
  '/lembrete em 30 min tirar o bolo do forno',
  '/lembrete todo dia 08:00 tomar remédio',
  '/lembrete toda segunda 09:00 reunião semanal'
].join('\n');

function describeRecurrence(recurrence) {
  if (!recurrence) return '';
  return recurrence.tipo === 'diaria' ? ' (todo dia)' : ` (toda ${WEEKDAY_LABELS[recurrence.diaSemana]})`;
}

// Ferramentas que viram comando: o erro vira uma mensagem legível em vez de derrubar a resposta.
async function runTool(name, args, apiKeys) {
  try {
    const result = await executeTool(name, args, { apiKeys });
    return result.erro ? result.erro : result;
  } catch (error) {
    return `Não consegui: ${error.message}`;
  }
}

export async function handleCommand(text, remoteJid, {
  storage,
  gemini,
  stats,
  timeZone = 'America/Sao_Paulo',
  now = () => new Date(),
  apiKeys = {},
  random = Math.random
}) {
  const match = text.match(/^\/([a-záéíóúç_]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argument = (match[2] || '').trim();

  switch (command) {
    case 'ajuda':
    case 'help':
      return `Comandos disponíveis:\n${commandHelp}`;
    case 'dado': {
      const sides = argument ? Number.parseInt(argument, 10) : 6;
      if (!Number.isInteger(sides) || sides < 2 || sides > 1000) return 'Use /dado [lados], de 2 a 1000. Ex.: /dado 20';
      return `🎲 Caiu ${Math.floor(random() * sides) + 1} (dado de ${sides} lados)`;
    }
    case 'moeda':
      return random() < 0.5 ? '🪙 Deu *cara*.' : '🪙 Deu *coroa*.';
    case 'sorteio': {
      const options = argument.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
      if (options.length < 2) return 'Use /sorteio opção 1, opção 2, opção 3 (separe com vírgula).';
      return `🎯 O destino escolheu: *${options[Math.floor(random() * options.length)]}*`;
    }
    case 'calc': {
      if (!argument) return 'Use /calc 2*(3+4)';
      const result = await runTool('calcular_expressao', { expr: argument }, apiKeys);
      return typeof result === 'string' ? result : `🧮 ${argument} = *${Number(result.resultado.toFixed(10))}*`;
    }
    case 'hora': {
      const result = await runTool('consultar_horario', { fuso: argument || timeZone }, apiKeys);
      return typeof result === 'string' ? `${result} Use um fuso como America/Sao_Paulo ou Europe/Lisbon.` : `🕒 ${result.horario}`;
    }
    case 'clima': {
      if (!argument) return 'Use /clima <cidade>. Ex.: /clima Osasco';
      const result = await runTool('obter_clima', { cidade: argument }, apiKeys);
      return typeof result === 'string' ? result : `🌤️ ${result.cidade}: ${result.temperatura}°C, ${result.descricao}`;
    }
    case 'noticias':
    case 'notícias': {
      if (!argument) return 'Use /noticias <assunto>. Ex.: /noticias futebol';
      const result = await runTool('buscar_noticias', { topico: argument }, apiKeys);
      if (typeof result === 'string') return result;
      return result.artigos.length
        ? `📰 *${argument}*\n${result.artigos.slice(0, 5).map(({ title, url }) => `- ${title}\n  ${url}`).join('\n')}`
        : 'Nada encontrado sobre esse assunto.';
    }
    case 'cambio':
    case 'câmbio': {
      const [, value, from, to] = argument.match(/^(\d+(?:[.,]\d+)?)\s*([a-z]{3})\s+(?:para\s+)?([a-z]{3})$/i) || [];
      if (!value) return 'Use /cambio <valor> <de> <para>. Ex.: /cambio 100 usd brl';
      const result = await runTool('converter_moeda', { valor: Number(value.replace(',', '.')), de: from, para: to }, apiKeys);
      return typeof result === 'string' ? result : `💱 ${result.valor} ${result.de} = *${result.convertido} ${result.para}*`;
    }
    case 'traduzir': {
      const [, language, content] = argument.match(/^(\S+)\s+([\s\S]+)$/) || [];
      if (!language) return 'Use /traduzir <idioma> <texto>. Ex.: /traduzir inglês bom dia, tudo bem?';
      return toWhatsAppFormat(await gemini.generate({
        text: `Traduza o texto a seguir para ${language}. Responda só com a tradução, sem comentários.\n\n${content}`,
        user: {},
        assistant: { withOwner: true }
      }));
    }
    case 'reset':
      await storage.resetHistory(remoteJid);
      return 'Histórico da conversa apagado.';
    case 'status': {
      const user = await storage.getUser(remoteJid);
      return [
        `Mensagens processadas: ${stats.totalMessages}`,
        `Última mensagem: ${stats.lastMessageAt?.toISOString() || 'nenhuma'}`,
        `Persona atual: ${user.persona || 'padrão'}`,
        `Idioma atual: ${user.idioma || 'padrão'}`
      ].join('\n');
    }
    case 'resumo': {
      const history = (await storage.getHistory(remoteJid, 10)).slice(-10);
      if (!history.length) return 'Ainda não há mensagens para resumir.';
      const user = await storage.getUser(remoteJid);
      return toWhatsAppFormat(await gemini.generate({
        history,
        text: 'Resuma em poucas frases os últimos turnos desta conversa.',
        user
      }));
    }
    case 'persona': {
      const personas = Object.keys(SYSTEM_INSTRUCTIONS).filter((persona) => persona !== 'padrao');
      if (!argument) return `Sua persona atual é "${(await storage.getUser(remoteJid)).persona || 'padrão'}". Opções: ${personas.join(', ')}.`;
      if (!personas.includes(argument.toLowerCase())) return `Persona inválida. Escolha: ${personas.join(', ')}.`;
      const persona = argument.toLowerCase();
      await storage.updateUser(remoteJid, { persona, systemInstruction: SYSTEM_INSTRUCTIONS[persona] });
      return `Persona alterada para "${argument.toLowerCase()}".`;
    }
    case 'idioma': {
      const languages = { 'pt-br': 'pt-BR', en: 'en', es: 'es' };
      const language = languages[argument.toLowerCase()];
      if (!language) return 'Idioma inválido. Escolha: pt-BR, en ou es.';
      await storage.updateUser(remoteJid, { idioma: language });
      return `Idioma alterado para ${language}.`;
    }
    case 'imagem': {
      if (!argument) return 'Use /imagem seguido do que você quer ver. Ex.: /imagem um leão de terno em um escritório escuro';
      const image = await gemini.generateImage({ prompt: argument });
      return { image: { buffer: image.buffer, mimetype: image.mimetype }, caption: image.text ? toWhatsAppFormat(image.text) : '' };
    }
    case 'lembrete': {
      const reminder = parseReminder(argument, now(), timeZone);
      if (!reminder) return reminderHelp;
      const created = await storage.createReminder({
        usuarioId: remoteJid,
        mensagem: reminder.mensagem,
        agendadoPara: reminder.agendadoPara,
        ...(reminder.recorrencia && { recorrencia: reminder.recorrencia })
      });
      return `Lembrete agendado para ${formatDateTime(reminder.agendadoPara, timeZone)}${describeRecurrence(reminder.recorrencia)}. ID: ${created.id}`;
    }
    case 'lembretes': {
      const reminders = await storage.getReminders(remoteJid);
      if (!reminders.length) return 'Você não tem lembretes pendentes.';
      return reminders.map((item) =>
        `${formatDateTime(item.agendadoPara, timeZone)}${describeRecurrence(item.recorrencia)} — ${item.mensagem} (ID: ${item.id})`
      ).join('\n');
    }
    case 'cancelar_lembrete': {
      if (!argument) return 'Informe o ID do lembrete que deseja cancelar.';
      const cancelled = await storage.cancelReminder(remoteJid, argument);
      return cancelled ? 'Lembrete cancelado.' : 'Lembrete não encontrado.';
    }
    default:
      return `Comando desconhecido. Envie /ajuda para ver os comandos disponíveis.`;
  }
}
