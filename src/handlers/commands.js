import { SYSTEM_INSTRUCTIONS } from '../services/gemini.js';
import { formatDateTime, parseReminder, WEEKDAY_LABELS } from '../utils/time.js';
import { formatBooking, formatContact, formatPriceList } from '../business/botPhZeus.js';
import { toWhatsAppFormat } from '../utils/format.js';
import { dateKey, formatDay, parseDateInput, parseDateKey } from '../utils/slots.js';

const commandHelp = [
  '/precos — tabela de preços dos protocolos Bronze, Prata e Ouro',
  '/endereco — endereço, WhatsApp e Instagram do estúdio',
  '/horarios [data] — horários livres para agendar (ex.: /horarios amanhã, /horarios 25/12)',
  '/agendamentos — seus horários marcados',
  '/cancelar_agendamento <código> — cancela um horário seu',
  '/reset — limpa o histórico da conversa',
  '/ajuda — mostra esta lista de comandos',
  '/status — mostra o status do bot e sua persona',
  '/resumo — resume as últimas mensagens',
  '/persona formal|engraçado|técnico — altera o tom das respostas',
  '/idioma pt-BR|en|es — altera o idioma das respostas',
  '/imagem <prompt> — cria uma descrição de imagem',
  '/lembrete <quando> <mensagem> — agenda um lembrete (ex.: 14:30, amanhã 09:00, 25/12 10:00, em 30 min, todo dia 08:00, toda segunda 09:00)',
  '/lembretes — lista seus lembretes',
  '/cancelar_lembrete <id> — cancela um lembrete'
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

const agendaGroupMessage = 'Os agendamentos funcionam só na conversa privada comigo. Me chame no privado! ☀️';
const agendaOffMessage = `A agenda online ainda não está liberada. Para agendar, chame a dona do estúdio no WhatsApp: ${formatBooking()}`;

function formatFreeSlots(days) {
  return days.map(({ data, horarios }) => {
    const parts = parseDateKey(data);
    return `*${formatDay(parts)}*: ${horarios.join(', ')}`;
  }).join('\n');
}

async function freeSlots(agenda, argument, now, timeZone) {
  let result;
  if (argument) {
    const parts = parseDateInput(argument, now(), timeZone);
    if (!parts) return 'Não entendi a data. Exemplos: /horarios amanhã, /horarios 25/12';
    result = await agenda.availability(dateKey(parts));
    if (result.ok && result.fechado) return `Não atendemos em ${formatDay(parts)}${result.motivo ? ` (${result.motivo})` : ''}. Quer ver outro dia?`;
    if (result.ok) result = { ok: true, dias: result.horarios.length ? [result] : [], aviso: `Sem horários livres em ${formatDay(parts)}.` };
  } else {
    result = await agenda.nextAvailability({ maxDays: 3 });
  }
  if (result.indisponivel) return agendaOffMessage;
  if (!result.ok) return result.erro;
  if (!result.dias.length) return `${result.aviso || 'Sem horários livres.'} Tente outro dia!`;
  return `🗓️ *Horários livres*\n${formatFreeSlots(result.dias)}\n\nPara agendar, é só me dizer o dia, o horário e o protocolo. ☀️`;
}

export async function handleCommand(text, remoteJid, {
  storage,
  gemini,
  stats,
  timeZone = 'America/Sao_Paulo',
  now = () => new Date(),
  agenda
}) {
  const match = text.match(/^\/([a-záéíóúç_]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argument = (match[2] || '').trim();

  switch (command) {
    case 'ajuda':
    case 'help':
      return `Comandos disponíveis:\n${commandHelp}`;
    case 'precos':
    case 'preços':
    case 'valores':
    case 'protocolos':
      return formatPriceList();
    case 'endereco':
    case 'endereço':
    case 'contato':
      return formatContact();
    case 'horarios':
    case 'horários':
      return agenda ? freeSlots(agenda, argument, now, timeZone) : agendaGroupMessage;
    case 'agendamentos':
    case 'agenda': {
      if (!agenda) return agendaGroupMessage;
      const bookings = await agenda.listClient(remoteJid);
      if (!bookings.length) return 'Você não tem agendamentos. Quer marcar um horário? É só me dizer o dia e o horário que prefere! ☀️';
      return [
        '📅 *Seus agendamentos*',
        ...bookings.map((item) => `- ${item.quando} · ${item.protocolo.replace(/^Protocolo\s+/i, '')} ${item.duracaoMinutos} min · ${item.valor} · código ${item.codigo}`),
        '',
        `Para cancelar: /cancelar_agendamento ${bookings[0].codigo}`
      ].join('\n');
    }
    case 'cancelar_agendamento': {
      if (!agenda) return agendaGroupMessage;
      if (!argument) return 'Informe o código do agendamento: /cancelar_agendamento <código>. Veja os seus em /agendamentos.';
      const result = await agenda.cancel({ id: argument, requesterJid: remoteJid, by: 'cliente' });
      return result.ok
        ? `Agendamento ${result.agendamento.codigo} (${result.agendamento.quando}) cancelado. Se quiser, posso marcar outro horário! ☀️`
        : result.erro;
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
      if (!argument) return 'Use /imagem seguido da ideia que deseja transformar em um prompt de imagem.';
      const user = await storage.getUser(remoteJid);
      return toWhatsAppFormat(await gemini.generate({
        text: `Crie uma descrição visual detalhada (prompt) para desenhar ou gerar esta imagem: ${argument}. Deixe claro na resposta que você está gerando apenas a descrição em texto e não uma imagem real.`,
        user
      }));
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
