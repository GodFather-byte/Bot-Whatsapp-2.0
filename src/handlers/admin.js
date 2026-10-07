import { normalizePhoneNumber } from '../middleware/security.js';
import { AWAY_MODES } from '../services/presence.js';
import { parseBusinessHours } from '../utils/time.js';

const adminHelp = [
  'Comandos do dono (escreva na conversa "Você", consigo mesmo):',
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
  presence
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
    default:
      return `Comando de dono desconhecido.\n\n${adminHelp}`;
  }
}
