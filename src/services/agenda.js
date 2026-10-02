import { randomInt } from 'node:crypto';
import { business as studio, formatAddress, formatPrice } from '../business/botPhZeus.js';
import { addDays, parseBusinessHours, zonedParts } from '../utils/time.js';
import {
  dateKey,
  daySlots,
  daysBetween,
  describeHours,
  formatClock,
  formatWhen,
  parseClockMinutes,
  parseDateKey,
  slotInstant,
  weekdayName,
  weekdayOf
} from '../utils/slots.js';

// Sem 0/O, 1/I/L, para o código ser fácil de ditar e digitar.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();
const normalizeText = (value) => String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Cliente';

/** Linhas de uma lista de agendamentos (no formato de `view`), para a dona ler no WhatsApp. */
export function formatAgendaList(views) {
  return views.map((item) => [
    `- ${item.hora} · ${item.nome} · ${item.protocolo.replace(/^Protocolo\s+/i, '')} ${item.duracaoMinutos} min · ${item.valor} · ${item.codigo}`,
    item.numero && `  https://wa.me/${item.numero}`
  ].filter(Boolean).join('\n')).join('\n');
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tempo limite excedido.')), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * Agenda do estúdio. Cada horário da grade (de `stepMin` em `stepMin` minutos, dentro do horário
 * configurado com /admin agenda horario) aceita um único agendamento, porque só há uma máquina.
 *
 * `hooks` recebem os eventos (onBooked, onCancelled, onRescheduled) para avisar a dona e sincronizar
 * calendários. Uma falha ali nunca desfaz o agendamento. Um hook pode devolver campos a gravar no
 * agendamento (ex.: googleEventId).
 */
export function createAgendaService({
  storage,
  business = studio,
  timeZone = 'America/Sao_Paulo',
  stepMin = 30,
  minNoticeMin = 60,
  daysAhead = 30,
  maxPerClient = 2,
  reminderHours = [24, 2],
  hooks = {},
  hookTimeoutMs = 10_000,
  logger = console,
  now = () => new Date()
} = {}) {
  const longestSession = Math.max(...business.sessionLengths.map(({ minutes }) => minutes));
  if (stepMin < longestSession) {
    throw new Error(`O intervalo da agenda (${stepMin} min) não pode ser menor que a maior sessão (${longestSession} min).`);
  }

  const notConfigured = {
    ok: false,
    indisponivel: true,
    erro: 'A agenda online ainda não está liberada.',
    orientacao: `Peça para o cliente agendar direto com a dona do estúdio, pelo WhatsApp ${business.bookingWhatsapp}.`
  };

  function findProtocol(input) {
    const wanted = normalizeText(input).replace(/^protocolo\s+/, '');
    return business.protocols.find(({ name }) => normalizeText(name).replace(/^protocolo\s+/, '') === wanted) || null;
  }

  function findSession(minutes) {
    return business.sessionLengths.find((session) => session.minutes === Number(minutes)) || null;
  }

  async function loadHours() {
    const { agendaHorario } = await storage.getBotSettings();
    if (!agendaHorario) return null;
    try {
      return parseBusinessHours(agendaHorario);
    } catch {
      return null;
    }
  }

  // Tudo que é preciso para calcular os horários livres de `days` dias, a partir de `fromParts`.
  async function loadContext(fromParts, days) {
    const rules = await loadHours();
    if (!rules) return null;
    const [booked, closedDays] = await Promise.all([
      storage.listAppointments({ from: slotInstant(fromParts, 0, timeZone), to: slotInstant(addDays(fromParts, days), 0, timeZone) }),
      storage.listClosedDays(dateKey(fromParts))
    ]);
    return {
      rules,
      taken: new Set(booked.map(({ inicio }) => new Date(inicio).getTime())),
      closed: new Map(closedDays.map(({ dia, motivo }) => [dia, motivo])),
      earliest: now().getTime() + minNoticeMin * 60_000
    };
  }

  function openSlots(parts, { rules, taken, closed, earliest }) {
    if (closed.has(dateKey(parts))) return [];
    return daySlots(rules, parts, stepMin).filter((minutes) => {
      const start = slotInstant(parts, minutes, timeZone).getTime();
      return start >= earliest && !taken.has(start);
    });
  }

  function checkWindow(parts) {
    const distance = daysBetween(zonedParts(now(), timeZone), parts);
    if (distance < 0) return 'Essa data já passou.';
    if (distance > daysAhead) return `Só é possível agendar para os próximos ${daysAhead} dias.`;
    return null;
  }

  function view(appointment) {
    const start = new Date(appointment.inicio);
    const local = zonedParts(start, timeZone);
    return {
      codigo: appointment.id,
      nome: appointment.clienteNome,
      protocolo: appointment.protocolo,
      duracaoMinutos: appointment.duracaoMin,
      valor: formatPrice(appointment.valor),
      data: dateKey(local),
      hora: formatClock(local.hour * 60 + local.minute),
      quando: formatWhen(start, timeZone),
      ...(appointment.clienteNumero && { numero: appointment.clienteNumero })
    };
  }

  async function runHook(name, ...args) {
    if (!hooks[name]) return null;
    try {
      return await withTimeout(Promise.resolve(hooks[name](...args)), hookTimeoutMs);
    } catch (error) {
      logger.warn?.({ err: error, hook: name }, 'Falha ao avisar sobre a agenda');
      return null;
    }
  }

  async function saveHookChanges(appointment, changes) {
    if (!changes || !Object.keys(changes).length) return appointment;
    return (await storage.updateAppointment(appointment.id, changes)) || { ...appointment, ...changes };
  }

  function reminderText(appointment, hours) {
    const lead = hours === 24
      ? 'amanhã'
      : hours % 24 === 0 ? `em ${hours / 24} dias` : `daqui a ${hours} hora${hours === 1 ? '' : 's'}`;
    return `seu horário no ${business.name} é ${lead}: ${formatWhen(appointment.inicio, timeZone)} (${appointment.protocolo}, ${appointment.duracaoMin} min).\n`
      + `📍 ${formatAddress(business)}\nSe não puder vir, me avise por aqui para liberar o horário.`;
  }

  // Os lembretes ao cliente reaproveitam o sistema de lembretes do bot.
  async function scheduleReminders(appointment) {
    const reminderIds = [];
    for (const hours of reminderHours) {
      const at = new Date(new Date(appointment.inicio).getTime() - hours * 3_600_000);
      if (at.getTime() <= now().getTime() + 60_000) continue;
      try {
        const reminder = await storage.createReminder({
          usuarioId: appointment.clienteJid,
          mensagem: reminderText(appointment, hours),
          agendadoPara: at
        });
        reminderIds.push(reminder.id);
      } catch (error) {
        logger.warn?.({ err: error }, 'Falha ao criar lembrete do agendamento');
      }
    }
    if (!reminderIds.length) return appointment;
    return (await storage.updateAppointment(appointment.id, { lembreteIds: reminderIds }))
      || { ...appointment, lembreteIds: reminderIds };
  }

  async function cancelReminders(appointment) {
    for (const reminderId of appointment.lembreteIds || []) {
      try {
        await storage.cancelReminder(appointment.clienteJid, reminderId);
      } catch (error) {
        logger.warn?.({ err: error }, 'Falha ao cancelar lembrete do agendamento');
      }
    }
  }

  async function freshCode() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newCode();
      if (!(await storage.getAppointment(code))) return code;
    }
    throw new Error('Não foi possível gerar um código de agendamento.');
  }

  async function availability(dateInput) {
    const parts = parseDateKey(dateInput);
    if (!parts) return { ok: false, erro: 'Data inválida. Use o formato AAAA-MM-DD.' };
    const problem = checkWindow(parts);
    if (problem) return { ok: false, erro: problem };
    const context = await loadContext(parts, 1);
    if (!context) return notConfigured;

    const key = dateKey(parts);
    const day = { ok: true, data: key, diaSemana: weekdayName(weekdayOf(parts)) };
    if (context.closed.has(key)) {
      return { ...day, fechado: true, motivo: context.closed.get(key) || undefined, horarios: [] };
    }
    return { ...day, horarios: openSlots(parts, context).map(formatClock) };
  }

  // Os próximos dias que ainda têm horário livre.
  async function nextAvailability({ maxDays = 3 } = {}) {
    const today = zonedParts(now(), timeZone);
    const context = await loadContext(today, daysAhead + 1);
    if (!context) return notConfigured;

    const days = [];
    for (let offset = 0; offset <= daysAhead && days.length < maxDays; offset += 1) {
      const parts = addDays(today, offset);
      const horarios = openSlots(parts, context).map(formatClock);
      if (horarios.length) days.push({ data: dateKey(parts), diaSemana: weekdayName(weekdayOf(parts)), horarios });
    }
    return { ok: true, dias: days, ...(!days.length && { aviso: `Sem horários livres nos próximos ${daysAhead} dias.` }) };
  }

  async function createBooking({ clientJid, clientNumber, clientName, protocol, durationMin, date, time, ignoreLimit = false, replaces }) {
    const chosenProtocol = findProtocol(protocol);
    if (!chosenProtocol) {
      return { ok: false, erro: `Protocolo inválido. Opções: ${business.protocols.map(({ name }) => name).join(', ')}.` };
    }
    const session = findSession(durationMin);
    if (!session) {
      return { ok: false, erro: `Duração inválida. Opções: ${business.sessionLengths.map(({ minutes }) => minutes).join(' ou ')} minutos.` };
    }
    const minutes = parseClockMinutes(time);
    if (minutes === null) return { ok: false, erro: 'Horário inválido. Use o formato HH:MM.' };

    const day = await availability(date);
    if (!day.ok) return day;
    if (day.fechado) return { ok: false, erro: 'O estúdio não atende nesse dia.', motivo: day.motivo };
    if (!day.horarios.includes(formatClock(minutes))) {
      return { ok: false, erro: 'Esse horário não está disponível.', horariosLivres: day.horarios };
    }

    if (!ignoreLimit) {
      const active = await storage.listClientAppointments(clientJid, { from: now() });
      if (active.length >= maxPerClient) {
        return {
          ok: false,
          erro: `O cliente já tem ${active.length} agendamentos ativos (o máximo é ${maxPerClient}). Para marcar outro, é preciso cancelar ou remarcar um deles.`,
          agendamentosAtivos: active.map(view)
        };
      }
    }

    const start = slotInstant(parseDateKey(date), minutes, timeZone);
    const created = await storage.createAppointment({
      id: await freshCode(),
      clienteJid: clientJid,
      clienteNumero: clientNumber || null,
      clienteNome: cleanName(clientName),
      protocolo: chosenProtocol.name,
      duracaoMin: session.minutes,
      valor: chosenProtocol.prices[session.minutes],
      inicio: start,
      fim: new Date(start.getTime() + session.minutes * 60_000),
      lembreteIds: [],
      ...(replaces && { remarcadoDe: replaces })
    });
    if (!created.ok) {
      const refreshed = await availability(date);
      return { ok: false, erro: 'Esse horário acabou de ser ocupado por outra pessoa.', horariosLivres: refreshed.horarios || [] };
    }
    return { ok: true, appointment: await scheduleReminders(created.appointment) };
  }

  // Busca um agendamento futuro e confirmado; com `requesterJid`, só se for desse cliente.
  async function findActive(id, requesterJid) {
    const code = normalizeCode(id);
    const appointment = code ? await storage.getAppointment(code) : null;
    if (!appointment || appointment.status !== 'confirmado' || (requesterJid && appointment.clienteJid !== requesterJid)) {
      return { error: { ok: false, erro: 'Agendamento não encontrado ou já cancelado.' } };
    }
    if (new Date(appointment.inicio) <= now()) {
      return { error: { ok: false, erro: 'Esse horário já passou.' } };
    }
    return { appointment };
  }

  async function book(params) {
    const result = await createBooking(params);
    if (!result.ok) return result;
    const appointment = await saveHookChanges(result.appointment, await runHook('onBooked', result.appointment));
    return { ok: true, agendamento: { ...view(appointment), endereco: formatAddress(business) } };
  }

  async function cancel({ id, requesterJid, by = 'cliente', reason }) {
    const { appointment, error } = await findActive(id, requesterJid);
    if (error) return error;
    const cancelled = await storage.cancelAppointment(appointment.id, { por: by, motivo: reason });
    if (!cancelled) return { ok: false, erro: 'Agendamento não encontrado ou já cancelado.' };
    await cancelReminders(appointment);
    await runHook('onCancelled', appointment, { by, reason });
    return { ok: true, agendamento: view(appointment) };
  }

  async function reschedule({ id, requesterJid, date, time }) {
    const { appointment, error } = await findActive(id, requesterJid);
    if (error) return error;

    const before = view(appointment);
    const minutes = parseClockMinutes(time);
    if (before.data === String(date).trim() && minutes !== null && before.hora === formatClock(minutes)) {
      return { ok: false, erro: 'O agendamento já está nesse horário.' };
    }

    // O novo horário é reservado antes de liberar o antigo: se falhar, o cliente não perde o que tinha.
    const result = await createBooking({
      clientJid: appointment.clienteJid,
      clientNumber: appointment.clienteNumero,
      clientName: appointment.clienteNome,
      protocol: appointment.protocolo,
      durationMin: appointment.duracaoMin,
      date,
      time,
      ignoreLimit: true,
      replaces: appointment.id
    });
    if (!result.ok) return result;

    await storage.cancelAppointment(appointment.id, { por: 'remarcado' });
    await cancelReminders(appointment);
    const next = await saveHookChanges(result.appointment, await runHook('onRescheduled', appointment, result.appointment));
    return { ok: true, agendamento: { ...view(next), endereco: formatAddress(business) }, anterior: before };
  }

  async function listClient(clientJid) {
    return (await storage.listClientAppointments(clientJid, { from: now() })).map(view);
  }

  async function listDay(key) {
    const parts = parseDateKey(key);
    if (!parts) return [];
    const appointments = await storage.listAppointments({
      from: slotInstant(parts, 0, timeZone),
      to: slotInstant(addDays(parts, 1), 0, timeZone)
    });
    return appointments.map(view);
  }

  async function closeDay(key, reason = '') {
    if (!parseDateKey(key)) return { ok: false, erro: 'Data inválida.' };
    const affected = await listDay(key);
    await storage.closeDay(key, reason);
    return { ok: true, data: key, agendamentos: affected };
  }

  async function openDay(key) {
    if (!parseDateKey(key)) return { ok: false, erro: 'Data inválida.' };
    return { ok: true, data: key, estavaFechado: await storage.openDay(key) };
  }

  return {
    availability,
    nextAvailability,
    book,
    cancel,
    reschedule,
    listClient,
    listDay,
    closeDay,
    openDay,
    view,
    listClosedDays: (fromKey) => storage.listClosedDays(fromKey),
    describeHours: async () => {
      const rules = await loadHours();
      return rules ? describeHours(rules) : null;
    },
    settings: { stepMin, minNoticeMin, daysAhead, maxPerClient, reminderHours }
  };
}
