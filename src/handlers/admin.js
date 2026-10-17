import { normalizePhoneNumber } from '../middleware/security.js';
import { AWAY_MODES } from '../services/presence.js';
import { formatDateTime, parseBusinessHours } from '../utils/time.js';
import { toWhatsAppFormat } from '../utils/format.js';
import { findChatJid, parseDuration, parseNumber } from './creator.js';

const adminHelp = [
  'Comandos do dono (escreva na conversa "Você", consigo mesmo):',
  '/admin conversas [n] — as últimas conversas, com a última mensagem de cada',
  '/admin ver <número> [n] — as últimas mensagens trocadas com esse número',
  '/admin resumo <número> — a IA resume a conversa e aponta o que exige resposta sua',
  '/admin responder <número> <texto> — o assistente envia essa mensagem para o número',
  '/admin pausar [número] <tempo> / retomar [número] — silencia o assistente (geral ou numa conversa); ex.: /admin pausar 2 horas',
  '/admin limpar <número> — apaga o histórico da conversa com esse número',
  '/admin ausente [auto|on|off] — on (padrão): responde sempre; auto: só quando você está offline; off: fica quieto',
  '/admin horarioausente <regras> | desligar — horários em que você está sempre ausente (ex.: seg-sex 09:00-18:00; dom 00:00-23:59)',
  '/admin instrucoes <texto> | limpar — o que o assistente pode saber/dizer por você (ex.: "Estou em viagem até sexta.")',
  '/admin status — estatísticas e conexão',
  '/admin uso — quanto da API do Gemini já foi usado (hoje, 7 dias e mês)',
  '/admin config — mostra as configurações atuais',
  '/admin bloquear <número> / desbloquear <número> / bloqueados — o assistente ignora esses números',
  '/admin aviso <texto> — envia um recado para todos os contatos que já conversaram com o assistente'
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeSettings(settings, presence) {
  return [
    `Modo ausente: ${settings.ausencia || 'on'}`,
    `Horário de ausência: ${settings.ausenciaHorario || '(nenhum)'}`,
    `No modo auto, o assistente responde se você ficou ${presence?.idleMinutes ?? '?'} min sem enviar mensagens, e se cala ${presence?.takeoverMinutes ?? '?'} min numa conversa em que você respondeu.`,
    `Instruções: ${settings.instrucoes || '(nenhuma)'}`
  ].join('\n');
}

async function updateTextSetting(storage, key, value, label) {
  if (!value) return `Informe o texto. Para remover, use "limpar".`;
  const clear = ['limpar', 'desligar', 'remover'].includes(value.toLowerCase());
  await storage.updateBotSettings({ [key]: clear ? null : value });
  return clear ? `${label} removido(a).` : `${label} atualizado(a).`;
}

async function broadcast({ sock, storage, text, logger, delayMs, ownerJid }) {
  const contacts = (await storage.listContacts()).filter((jid) => jid !== ownerJid);
  let sent = 0;
  for (const jid of contacts) {
    try {
      await sock.sendMessage(jid, { text });
      sent += 1;
    } catch (error) {
      logger.warn({ err: error, jid }, 'Falha ao enviar aviso');
    }
    // Intervalo entre envios para reduzir o risco de bloqueio pelo WhatsApp.
    await sleep(delayMs);
  }
  return { sent, total: contacts.length };
}

export async function handleAdminCommand(argument, {
  storage,
  stats,
  getStatus = () => ({}),
  sock,
  remoteJid,
  logger,
  broadcastDelayMs = 2000,
  usage,
  dailyLimit,
  timeZone = 'America/Sao_Paulo',
  presence,
  gemini
}) {
  const [, subcommand = '', rest = ''] = argument.match(/^(\S*)\s*([\s\S]*)$/) || [];
  const value = rest.trim();

  switch (subcommand.toLowerCase()) {
    case '':
    case 'ajuda':
      return adminHelp;
    case 'status': {
      const status = getStatus();
      const bots = (status.bots || []).map(({ numero, conectado }) => `${conectado ? '🟢' : '🔴'} ${numero}`).join('\n');
      return [
        `Mensagens processadas: ${stats.totalMessages}`,
        `Contatos únicos: ${stats.users.size}`,
        `Erros nas últimas 24h: ${stats.errorEvents.length}`,
        `Bloqueados: ${(await storage.listBlocked()).length}`,
        `MongoDB: ${status.mongoConnected ? 'conectado' : 'não conectado'}`,
        bots && `Números do bot:\n${bots}`
      ].filter(Boolean).join('\n');
    }
    case 'uso':
      return usage ? usage.report({ dailyLimit, timeZone }) : 'A contagem de uso não está disponível.';
    case 'config':
      return describeSettings(await storage.getBotSettings(), presence);
    case 'instrucoes':
    case 'instruções':
      return updateTextSetting(storage, 'instrucoes', value, 'Instruções');
    case 'ausente': {
      const mode = value.toLowerCase();
      if (!mode) return `Modo ausente: ${(await storage.getBotSettings()).ausencia || 'on'}. Use /admin ausente auto|on|off.`;
      if (!AWAY_MODES.includes(mode)) return 'Use /admin ausente auto, on ou off.';
      await storage.updateBotSettings({ ausencia: mode });
      return {
        auto: 'Modo automático: o assistente responde quando você está offline e se cala quando você responde.',
        on: 'Assistente ligado: ele responde a todas as mensagens por você até você mandar /admin ausente auto ou off.',
        off: 'Assistente desligado: ele não responde a ninguém até você mandar /admin ausente auto ou on.'
      }[mode];
    }
    case 'horarioausente':
    case 'horárioausente': {
      if (!value) return 'Informe o horário, por exemplo: /admin horarioausente seg-sex 09:00-18:00; sab 00:00-23:59';
      if (['desligar', 'limpar', 'remover'].includes(value.toLowerCase())) {
        await storage.updateBotSettings({ ausenciaHorario: null });
        return 'Horário de ausência removido.';
      }
      try {
        parseBusinessHours(value);
      } catch (error) {
        return error.message;
      }
      await storage.updateBotSettings({ ausenciaHorario: value });
      return `Horário de ausência definido: ${value}. No modo auto, nesses horários o assistente responde mesmo que você esteja online.`;
    }
    case 'bloquear':
    case 'desbloquear': {
      const number = normalizePhoneNumber(value);
      if (!number) return `Informe o número com DDI e DDD, por exemplo: /admin ${subcommand} 5511999999999`;
      if (subcommand === 'bloquear') {
        await storage.blockNumber(number);
        return `${number} bloqueado. O bot vai ignorar as mensagens dele em todos os números.`;
      }
      return (await storage.unblockNumber(number)) ? `${number} desbloqueado.` : `${number} não estava bloqueado.`;
    }
    case 'bloqueados': {
      const blocked = await storage.listBlocked();
      return blocked.length ? `Números bloqueados:\n${blocked.join('\n')}` : 'Nenhum número bloqueado.';
    }
    case 'aviso': {
      if (!value) return 'Informe o texto do aviso: /admin aviso <texto>';
      const total = (await storage.listContacts()).filter((jid) => jid !== remoteJid).length;
      if (!total) return 'Este número ainda não tem contatos para avisar.';
      broadcast({ sock, storage, text: value, logger, delayMs: broadcastDelayMs, ownerJid: remoteJid })
        .then(({ sent }) => sock.sendMessage(remoteJid, { text: `Aviso enviado para ${sent} de ${total} contatos.` }))
        .catch((error) => logger.error({ err: error }, 'Falha ao enviar avisos'));
      return `Enviando o aviso para ${total} contatos, um a cada ${Math.round(broadcastDelayMs / 1000)}s. Aviso quando terminar.`;
    }
    case 'conversas': {
      const limit = Math.min(Math.max(Number.parseInt(value, 10) || 8, 1), 20);
      const contacts = (await storage.listContacts()).filter((jid) => jid !== remoteJid).slice(0, 100);
      if (!contacts.length) return 'Ninguém conversou com o assistente ainda.';
      const rows = (await Promise.all(contacts.map(async (jid) => ({ jid, last: (await storage.getHistory(jid, 1)).at(-1) }))))
        .filter(({ last }) => last)
        .sort((a, b) => new Date(b.last.timestamp || 0) - new Date(a.last.timestamp || 0))
        .slice(0, limit);
      return [
        `*Últimas ${rows.length} conversas* (de ${contacts.length} contatos)`,
        ...rows.map(({ jid, last }) => {
          const when = last.timestamp ? formatDateTime(new Date(last.timestamp), timeZone) : 's/d';
          const who = last.role === 'assistant' ? 'Assistente' : 'Contato';
          return `- ${normalizePhoneNumber(jid)} · ${when}\n  ${who}: ${String(last.conteudo).replace(/\s+/g, ' ').slice(0, 120)}`;
        }),
        '',
        'Veja uma conversa inteira com /admin ver <número> ou peça um resumo com /admin resumo <número>.'
      ].join('\n');
    }
    case 'ver': {
      const [numberText, limitText] = value.split(/\s+/);
      const number = parseNumber(numberText);
      if (!number) return 'Use: /admin ver 5511999999999 [quantidade]';
      const limit = Math.min(Math.max(Number.parseInt(limitText, 10) || 10, 1), 30);
      const history = await storage.getHistory(await findChatJid(storage, number), limit);
      if (!history.length) return `Nenhuma mensagem guardada com ${number}.`;
      return history.map(({ role, conteudo }) => `${role === 'assistant' ? 'Assistente' : 'Contato'}: ${String(conteudo).slice(0, 400)}`).join('\n');
    }
    case 'resumo': {
      const number = parseNumber(value);
      if (!number) return 'Use: /admin resumo 5511999999999';
      if (!gemini?.generate) return 'O resumo não está disponível.';
      const history = await storage.getHistory(await findChatJid(storage, number), 30);
      if (!history.length) return `Nenhuma mensagem guardada com ${number}.`;
      const transcript = history.map(({ role, conteudo }) => `${role === 'assistant' ? 'Assistente' : 'Contato'}: ${String(conteudo).slice(0, 500)}`).join('\n');
      return toWhatsAppFormat(await gemini.generate({
        text: `Resuma em até 5 linhas esta conversa entre um contato e o assistente do dono, destacando o que o contato quer, recados deixados e se algo exige resposta do dono:\n\n${transcript}`,
        user: {},
        assistant: { withOwner: true }
      }));
    }
    case 'responder': {
      const [, numberText = '', text = ''] = value.match(/^(\S+)\s+([\s\S]+)$/) || [];
      const number = parseNumber(numberText);
      if (!number || !text.trim()) return 'Use: /admin responder 5511999999999 <texto>';
      await sock.sendMessage(await findChatJid(storage, number), { text: text.trim() });
      return `Mensagem enviada para ${number}.`;
    }
    case 'pausar': {
      if (!presence?.silence) return 'O controle de pausa não está disponível.';
      const [first = '', ...others] = value.split(/\s+/);
      const target = parseNumber(first);
      const minutes = parseDuration(target ? others.join(' ') : value);
      if (!minutes) return 'Use: /admin pausar 30 min | /admin pausar 5511999999999 2 horas';
      const until = presence.silence({ chatJid: target ? await findChatJid(storage, target) : undefined, minutes });
      return `Assistente em silêncio ${target ? `na conversa com ${target}` : 'com todos os contatos'} até ${formatDateTime(new Date(until), timeZone)}. Para voltar antes: /admin retomar${target ? ` ${target}` : ''}`;
    }
    case 'retomar': {
      if (!presence?.clearSilence) return 'O controle de pausa não está disponível.';
      const target = parseNumber(value);
      const had = presence.clearSilence(target ? await findChatJid(storage, target) : undefined);
      return had ? 'Silêncio encerrado: o assistente voltou a responder.' : 'O assistente não estava em silêncio.';
    }
    case 'limpar': {
      const number = parseNumber(value);
      if (!number) return 'Use: /admin limpar 5511999999999';
      await storage.resetHistory(await findChatJid(storage, number));
      return `Histórico com ${number} apagado.`;
    }
    default:
      return `Comando de dono desconhecido.\n\n${adminHelp}`;
  }
}
