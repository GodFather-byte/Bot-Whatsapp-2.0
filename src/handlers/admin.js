import { normalizePhoneNumber } from '../middleware/security.js';
import { formatAgendaList } from '../services/agenda.js';
import { dateKey, describeHours, formatDay, parseDateInput } from '../utils/slots.js';
import { addDays, parseBusinessHours, zonedParts } from '../utils/time.js';

const adminHelp = [
  'Comandos de dono (valem para o número do bot com que você está falando):',
  '/admin status — estatísticas e conexão de todos os números',
  '/admin uso — quanto da API do Gemini já foi usado (hoje, 7 dias e mês)',
  '/admin config — mostra as configurações deste número',
  '/admin instrucoes <texto> | limpar — instruções extras para a IA deste número',
  '/admin boasvindas <texto> | limpar — mensagem para quem fala com este número pela primeira vez',
  '/admin horario <regras> | desligar — horário de atendimento (ex.: seg-sex 09:00-18:00; sab 09:00-13:00)',
  '/admin foradehorario <texto> — resposta enviada fora do horário',
  '/admin agenda [hoje|amanhã|DD/MM|semana] — agendamentos do dia (ou dos próximos 7 dias)',
  '/admin agenda horario <regras> | desligar — dias e horas em que a IA pode agendar (ex.: seg-sex 09:00-19:00; sab 09:00-14:00)',
  '/admin agenda config — configuração da agenda',
  '/admin cancelar <código> [motivo] — cancela um agendamento e avisa o cliente',
  '/admin fechar <data> [motivo] | abrir <data> — fecha ou reabre um dia (feriado, folga)',
  '/admin bloquear <número> / desbloquear <número> / bloqueados — vale para todos os números',
  '/admin aviso <texto> — envia um recado para todos os contatos deste número'
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeSettings(settings) {
  return [
    `Instruções: ${settings.instrucoes || '(nenhuma)'}`,
    `Boas-vindas: ${settings.boasVindas || '(desligado)'}`,
    `Horário: ${settings.horario || '(sempre aberto)'}`,
    `Fora do horário: ${settings.foraDeHorario || '(mensagem padrão)'}`,
    `Agenda (horários para agendar): ${settings.agendaHorario || '(desligada)'}`
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

const agendaOff = 'A agenda não está disponível neste número.';
const splitFirstWord = (text) => (text.match(/^(\S*)\s*([\s\S]*)$/) || []).slice(1);
const shortDate = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;

async function showDay(agenda, parts) {
  const key = dateKey(parts);
  const [list, closed] = await Promise.all([agenda.listDay(key), agenda.listClosedDays(key)]);
  const closedDay = closed.find(({ dia }) => dia === key);
  return [
    `📅 *Agenda de ${formatDay(parts)}*${list.length ? ` (${list.length})` : ''}`,
    closedDay && `🚫 Dia fechado${closedDay.motivo ? `: ${closedDay.motivo}` : ''}`,
    list.length ? formatAgendaList(list) : 'Nenhum agendamento.'
  ].filter(Boolean).join('\n');
}

async function showWeek(agenda, now, timeZone) {
  const today = zonedParts(now, timeZone);
  const blocks = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const parts = addDays(today, offset);
    const list = await agenda.listDay(dateKey(parts));
    if (list.length) blocks.push(`*${formatDay(parts)}*\n${formatAgendaList(list)}`);
  }
  return blocks.length ? `📅 *Agenda dos próximos 7 dias*\n\n${blocks.join('\n\n')}` : 'Nenhum agendamento nos próximos 7 dias.';
}

async function describeAgenda(agenda, now, timeZone) {
  const { stepMin, minNoticeMin, daysAhead, maxPerClient, reminderHours } = agenda.settings;
  const hours = await agenda.describeHours();
  const closed = await agenda.listClosedDays(dateKey(zonedParts(now, timeZone)));
  return [
    `Horário da agenda: ${hours || '(não configurado: a IA encaminha os clientes para você)'}`,
    `Intervalo entre horários: ${stepMin} min`,
    `Antecedência mínima: ${minNoticeMin} min`,
    `Agenda aberta para os próximos ${daysAhead} dias`,
    `Máximo de agendamentos ativos por cliente: ${maxPerClient}`,
    `Lembretes ao cliente: ${reminderHours.map((hour) => `${hour} h`).join(' e ')} antes`,
    `Dias fechados: ${closed.length ? closed.map(({ dia, motivo }) => `${shortDate(dia)}${motivo ? ` (${motivo})` : ''}`).join(', ') : '(nenhum)'}`
  ].join('\n');
}

async function handleAgendaCommand(value, { agenda, storage, now, timeZone }) {
  if (!agenda) return agendaOff;
  const [word, rest] = splitFirstWord(value);
  const subcommand = word.toLowerCase();

  if (['horario', 'horário'].includes(subcommand)) {
    if (!rest) return 'Informe o horário, por exemplo: /admin agenda horario seg-sex 09:00-19:00; sab 09:00-14:00';
    if (['desligar', 'limpar', 'remover'].includes(rest.toLowerCase())) {
      await storage.updateBotSettings({ agendaHorario: null });
      return 'Agenda desligada. A IA não agenda mais e encaminha os clientes para você.';
    }
    let rules;
    try {
      rules = parseBusinessHours(rest);
    } catch (error) {
      return error.message;
    }
    const { stepMin } = agenda.settings;
    if (rules.some(({ inicio, fim }) => fim - inicio < stepMin)) {
      return `Cada período precisa ter pelo menos ${stepMin} minutos (o intervalo entre horários).`;
    }
    await storage.updateBotSettings({ agendaHorario: rest });
    return `Horário da agenda definido: ${describeHours(rules)}.\nA IA já pode agendar clientes nesses horários, de ${stepMin} em ${stepMin} minutos.`;
  }
  if (['config', 'configuracao', 'configuração'].includes(subcommand)) return describeAgenda(agenda, now(), timeZone);
  if (subcommand === 'semana') return showWeek(agenda, now(), timeZone);

  const parts = parseDateInput(word || 'hoje', now(), timeZone);
  if (!parts) return 'Não entendi a data. Use hoje, amanhã, DD/MM, semana, horario ou config.';
  return showDay(agenda, parts);
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
  agenda,
  now = () => new Date()
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
      return describeSettings(await storage.getBotSettings());
    case 'instrucoes':
    case 'instruções':
      return updateTextSetting(storage, 'instrucoes', value, 'Instruções');
    case 'boasvindas':
      return updateTextSetting(storage, 'boasVindas', value, 'Mensagem de boas-vindas');
    case 'foradehorario':
      return updateTextSetting(storage, 'foraDeHorario', value, 'Mensagem de fora do horário');
    case 'horario':
    case 'horário': {
      if (!value) return 'Informe o horário, por exemplo: /admin horario seg-sex 09:00-18:00; sab 09:00-13:00';
      if (['desligar', 'limpar', 'remover'].includes(value.toLowerCase())) {
        await storage.updateBotSettings({ horario: null });
        return 'Horário de atendimento desligado. O bot responde a qualquer hora.';
      }
      try {
        parseBusinessHours(value);
      } catch (error) {
        return error.message;
      }
      await storage.updateBotSettings({ horario: value });
      return `Horário de atendimento definido: ${value}`;
    }
    case 'agenda':
      return handleAgendaCommand(value, { agenda, storage, now, timeZone });
    case 'cancelar': {
      if (!agenda) return agendaOff;
      const [code, reason] = splitFirstWord(value);
      if (!code) return 'Informe o código do agendamento: /admin cancelar <código> [motivo]';
      const result = await agenda.cancel({ id: code, by: 'dona', reason: reason || undefined });
      return result.ok
        ? `Agendamento ${result.agendamento.codigo} cancelado (${result.agendamento.nome}, ${result.agendamento.quando}). O cliente foi avisado.`
        : result.erro;
    }
    case 'fechar': {
      if (!agenda) return agendaOff;
      const [dateText, reason] = splitFirstWord(value);
      const parts = parseDateInput(dateText, now(), timeZone);
      if (!parts) return 'Informe o dia: /admin fechar <hoje|amanhã|DD/MM> [motivo]';
      const result = await agenda.closeDay(dateKey(parts), reason);
      const closed = `Dia fechado: ${formatDay(parts)}${reason ? ` (${reason})` : ''}. Ninguém consegue marcar nesse dia.`;
      return result.agendamentos.length
        ? `${closed}\n\n⚠️ Já existem agendamentos nesse dia, que não foram cancelados:\n${formatAgendaList(result.agendamentos)}\nPara cancelar e avisar o cliente: /admin cancelar <código>`
        : closed;
    }
    case 'abrir': {
      if (!agenda) return agendaOff;
      const parts = parseDateInput(value, now(), timeZone);
      if (!parts) return 'Informe o dia: /admin abrir <hoje|amanhã|DD/MM>';
      const result = await agenda.openDay(dateKey(parts));
      return result.estavaFechado ? `Dia reaberto: ${formatDay(parts)}.` : `${formatDay(parts)} não estava fechado.`;
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
