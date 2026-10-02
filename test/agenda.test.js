import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgendaService } from '../src/services/agenda.js';
import { MemoryStorage } from '../src/services/storage.js';
import {
  dateKey,
  daySlots,
  describeHours,
  formatWhen,
  parseClockMinutes,
  parseDateInput,
  parseDateKey
} from '../src/utils/slots.js';
import { parseBusinessHours } from '../src/utils/time.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-10-01T13:00:00Z'); // quinta-feira, 01/10/2026, 10:00 em São Paulo
const HOURS = 'seg-sex 09:00-12:00; sab 09:00-11:00';
const MARIA = '5511911111111@s.whatsapp.net';
const ANA = '5511922222222@s.whatsapp.net';

async function setup(options = {}) {
  const storage = options.storage || new MemoryStorage();
  if (options.hours !== null) await storage.updateBotSettings({ agendaHorario: options.hours ?? HOURS });
  const events = [];
  const agenda = createAgendaService({
    storage,
    timeZone: TZ,
    now: () => options.now || NOW,
    logger: { warn: (...args) => events.push(['warn', ...args]) },
    hooks: options.hooks ?? {
      onBooked: async (appointment) => { events.push(['booked', appointment.id]); },
      onCancelled: async (appointment, extra) => { events.push(['cancelled', appointment.id, extra.by]); },
      onRescheduled: async (before, next) => { events.push(['rescheduled', before.id, next.id]); }
    },
    ...options.service
  });
  return { agenda, storage, events };
}

const booking = (overrides = {}) => ({
  clientJid: MARIA,
  clientNumber: '5511911111111',
  clientName: 'Maria Silva',
  protocol: 'Prata',
  durationMin: 30,
  date: '2026-10-03',
  time: '10:00',
  ...overrides
});

test('date helpers understand keys, clocks and friendly inputs', () => {
  assert.deepEqual(parseDateKey('2026-10-03'), { year: 2026, month: 10, day: 3 });
  assert.equal(parseDateKey('2026-02-30'), null);
  assert.equal(parseDateKey('03/10/2026'), null);
  assert.equal(dateKey({ year: 2026, month: 3, day: 7 }), '2026-03-07');
  assert.equal(parseClockMinutes('9:30'), 570);
  assert.equal(parseClockMinutes('09h30'), 570);
  assert.equal(parseClockMinutes('25:00'), null);
  assert.equal(formatWhen(NOW, TZ), 'quinta-feira, 01/10 às 10:00');

  assert.deepEqual(parseDateInput('hoje', NOW, TZ), { year: 2026, month: 10, day: 1 });
  assert.deepEqual(parseDateInput('amanhã', NOW, TZ), { year: 2026, month: 10, day: 2 });
  assert.deepEqual(parseDateInput('25/12', NOW, TZ), { year: 2026, month: 12, day: 25 });
  assert.deepEqual(parseDateInput('15/03', NOW, TZ), { year: 2027, month: 3, day: 15 }, 'sem ano e já passou: ano que vem');
  assert.deepEqual(parseDateInput('25/12/27', NOW, TZ), { year: 2027, month: 12, day: 25 });
  assert.deepEqual(parseDateInput('2026-11-02', NOW, TZ), { year: 2026, month: 11, day: 2 });
  assert.equal(parseDateInput('31/02', NOW, TZ), null);
  assert.equal(parseDateInput('qualquer coisa', NOW, TZ), null);
});

test('the slot grid follows the weekly rules and the step', () => {
  const rules = parseBusinessHours(HOURS);
  const clock = (parts) => daySlots(rules, parts, 30).map((minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  assert.deepEqual(clock({ year: 2026, month: 10, day: 1 }), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  assert.deepEqual(clock({ year: 2026, month: 10, day: 3 }), ['09:00', '09:30', '10:00', '10:30']);
  assert.deepEqual(clock({ year: 2026, month: 10, day: 4 }), [], 'domingo fechado');
  // Passo de 50 min: 11:30 começaria às 690 e terminaria às 740, depois do fim (720), então não existe.
  assert.deepEqual(daySlots(rules, { year: 2026, month: 10, day: 1 }, 50), [540, 590, 640], 'o último horário precisa caber antes do fim');
  assert.equal(describeHours(rules), 'segunda a sexta, das 09:00 às 12:00; sábado, das 09:00 às 11:00');
  assert.equal(
    describeHours(parseBusinessHours('seg,qua,sex 08:00-10:00; dom 10:00-12:00')),
    'segunda, quarta, sexta, das 08:00 às 10:00; domingo, das 10:00 às 12:00'
  );
});

test('the agenda refuses a step shorter than the longest session', async () => {
  assert.throws(() => createAgendaService({ storage: new MemoryStorage(), stepMin: 20 }), /não pode ser menor/);
});

test('availability hides past slots, the notice window, taken slots and closed days', async () => {
  const { agenda } = await setup();

  // 10:00 de quinta com 60 min de antecedência: só sobram 11:00 e 11:30.
  assert.deepEqual((await agenda.availability('2026-10-01')).horarios, ['11:00', '11:30']);
  assert.deepEqual((await agenda.availability('2026-10-02')).horarios, ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  const saturday = await agenda.availability('2026-10-03');
  assert.equal(saturday.diaSemana, 'sábado');
  assert.deepEqual(saturday.horarios, ['09:00', '09:30', '10:00', '10:30']);
  assert.deepEqual((await agenda.availability('2026-10-04')).horarios, []);

  assert.match((await agenda.availability('2026-09-30')).erro, /já passou/);
  assert.match((await agenda.availability('2026-11-15')).erro, /próximos 30 dias/);
  assert.match((await agenda.availability('amanhã')).erro, /AAAA-MM-DD/);

  const next = await agenda.nextAvailability({ maxDays: 3 });
  assert.deepEqual(next.dias.map(({ data }) => data), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('without opening hours the agenda is not available and tells the model to use the owner', async () => {
  const { agenda } = await setup({ hours: null });
  for (const result of [await agenda.availability('2026-10-03'), await agenda.nextAvailability(), await agenda.book(booking())]) {
    assert.equal(result.ok, false);
    assert.equal(result.indisponivel, true);
    assert.match(result.orientacao, /\(11\) 94578-8032/);
  }
  assert.equal(await agenda.describeHours(), null);
});

test('booking validates the request, prices it from the table and blocks the slot', async () => {
  const { agenda, events, storage } = await setup();

  const result = await agenda.book(booking());
  assert.equal(result.ok, true);
  const { agendamento } = result;
  assert.match(agendamento.codigo, /^[A-HJ-KM-NP-Z2-9]{5}$/);
  assert.equal(agendamento.protocolo, 'Protocolo Prata');
  assert.equal(agendamento.valor, 'R$ 100,00');
  assert.equal(agendamento.quando, 'sábado, 03/10 às 10:00');
  assert.equal(agendamento.hora, '10:00');
  assert.match(agendamento.endereco, /Sala 312/);
  assert.deepEqual(events.at(-1), ['booked', agendamento.codigo]);

  const stored = await storage.getAppointment(agendamento.codigo);
  assert.equal(stored.inicio.toISOString(), '2026-10-03T13:00:00.000Z');
  assert.equal(stored.fim.toISOString(), '2026-10-03T13:30:00.000Z');
  assert.equal(stored.clienteNome, 'Maria Silva');

  assert.deepEqual((await agenda.availability('2026-10-03')).horarios, ['09:00', '09:30', '10:30']);

  // 24 h e 2 h antes: dois lembretes para o cliente, nas horas certas.
  const reminders = await storage.getReminders(MARIA);
  assert.deepEqual(reminders.map(({ agendadoPara }) => agendadoPara.toISOString()), ['2026-10-02T13:00:00.000Z', '2026-10-03T11:00:00.000Z']);
  assert.match(reminders[0].mensagem, /amanhã: sábado, 03\/10 às 10:00 \(Protocolo Prata, 30 min\)/);
  assert.match(reminders[1].mensagem, /daqui a 2 horas/);
  assert.deepEqual(stored.lembreteIds.sort(), reminders.map(({ id }) => id).sort());
});

test('booking rejects invalid or unavailable requests with a useful answer', async () => {
  const { agenda } = await setup();

  assert.match((await agenda.book(booking({ protocol: 'Diamante' }))).erro, /Protocolo inválido.*Protocolo Bronze, Protocolo Prata, Protocolo Ouro/);
  assert.match((await agenda.book(booking({ durationMin: 45 }))).erro, /20 ou 30 minutos/);
  assert.match((await agenda.book(booking({ time: '9 da manhã' }))).erro, /HH:MM/);
  assert.match((await agenda.book(booking({ date: '2026-09-01' }))).erro, /já passou/);

  const outside = await agenda.book(booking({ time: '15:00' }));
  assert.equal(outside.ok, false);
  assert.match(outside.erro, /não está disponível/);
  assert.deepEqual(outside.horariosLivres, ['09:00', '09:30', '10:00', '10:30']);

  const sunday = await agenda.book(booking({ date: '2026-10-04', time: '10:00' }));
  assert.equal(sunday.ok, false);
  assert.deepEqual(sunday.horariosLivres, []);

  const tooSoon = await agenda.book(booking({ date: '2026-10-01', time: '10:30' }));
  assert.equal(tooSoon.ok, false, 'dentro da antecedência mínima');
  assert.equal((await agenda.book(booking({ date: '2026-10-01', time: '11:00' }))).ok, true);
});

test('protocols are matched without accents or the word "Protocolo"', async () => {
  const { agenda } = await setup();
  const result = await agenda.book(booking({ protocol: 'protocolo OURO', durationMin: '20', time: '09:00' }));
  assert.equal(result.ok, true);
  assert.equal(result.agendamento.protocolo, 'Protocolo Ouro');
  assert.equal(result.agendamento.valor, 'R$ 100,00');
});

test('two people racing for the same slot get exactly one booking', async () => {
  const { agenda } = await setup();
  const results = await Promise.all([
    agenda.book(booking()),
    agenda.book(booking({ clientJid: ANA, clientName: 'Ana' }))
  ]);
  assert.deepEqual(results.map(({ ok }) => ok).sort(), [false, true]);
  const loser = results.find(({ ok }) => !ok);
  assert.match(loser.erro, /ocupado|não está disponível/);
  assert.ok(Array.isArray(loser.horariosLivres));
});

test('a client has a limited number of active bookings', async () => {
  const { agenda } = await setup();
  assert.equal((await agenda.book(booking({ time: '09:00' }))).ok, true);
  assert.equal((await agenda.book(booking({ time: '09:30' }))).ok, true);
  const third = await agenda.book(booking({ time: '10:00' }));
  assert.equal(third.ok, false);
  assert.match(third.erro, /já tem 2 agendamentos ativos/);
  assert.equal(third.agendamentosAtivos.length, 2);
  assert.equal((await agenda.book(booking({ clientJid: ANA, time: '10:00' }))).ok, true, 'o limite é por cliente');
});

test('only the owner of a booking can cancel it, which frees the slot and the reminders', async () => {
  const { agenda, storage, events } = await setup();
  const { agendamento } = await agenda.book(booking());

  const stranger = await agenda.cancel({ id: agendamento.codigo, requesterJid: ANA });
  assert.equal(stranger.ok, false);
  assert.match(stranger.erro, /não encontrado/);
  assert.equal((await agenda.cancel({ id: 'ZZZZZ', requesterJid: MARIA })).ok, false);

  const cancelled = await agenda.cancel({ id: agendamento.codigo.toLowerCase(), requesterJid: MARIA });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(events.at(-1), ['cancelled', agendamento.codigo, 'cliente']);
  assert.ok((await agenda.availability('2026-10-03')).horarios.includes('10:00'));
  assert.deepEqual(await storage.getReminders(MARIA), []);
  assert.equal((await storage.getAppointment(agendamento.codigo)).canceladoPor, 'cliente');
  assert.equal((await agenda.cancel({ id: agendamento.codigo, requesterJid: MARIA })).ok, false, 'já cancelado');
  assert.deepEqual(await agenda.listClient(MARIA), []);
});

test('the owner can cancel any booking, and past bookings cannot be cancelled', async () => {
  const { agenda } = await setup();
  const { agendamento } = await agenda.book(booking());
  const result = await agenda.cancel({ id: agendamento.codigo, by: 'dona', reason: 'imprevisto' });
  assert.equal(result.ok, true);

  const later = await setup({ now: new Date('2026-10-03T14:00:00Z') });
  const past = await later.agenda.book(booking({ date: '2026-10-05', time: '09:00' }));
  assert.equal(past.ok, true);
  const afterIt = createAgendaService({ storage: later.storage, timeZone: TZ, now: () => new Date('2026-10-05T13:00:00Z') });
  assert.match((await afterIt.cancel({ id: past.agendamento.codigo })).erro, /já passou/);
});

test('rescheduling books the new slot first and releases the old one', async () => {
  const { agenda, storage, events } = await setup();
  const { agendamento } = await agenda.book(booking());

  const moved = await agenda.reschedule({ id: agendamento.codigo, requesterJid: MARIA, date: '2026-10-02', time: '11:00' });
  assert.equal(moved.ok, true);
  assert.equal(moved.anterior.quando, 'sábado, 03/10 às 10:00');
  assert.equal(moved.agendamento.quando, 'sexta-feira, 02/10 às 11:00');
  assert.notEqual(moved.agendamento.codigo, agendamento.codigo);
  assert.deepEqual(events.at(-1), ['rescheduled', agendamento.codigo, moved.agendamento.codigo]);

  assert.equal((await storage.getAppointment(agendamento.codigo)).status, 'cancelado');
  assert.equal((await storage.getAppointment(agendamento.codigo)).canceladoPor, 'remarcado');
  assert.equal((await storage.getAppointment(moved.agendamento.codigo)).remarcadoDe, agendamento.codigo);
  assert.ok((await agenda.availability('2026-10-03')).horarios.includes('10:00'));
  assert.ok(!(await agenda.availability('2026-10-02')).horarios.includes('11:00'));
  assert.deepEqual((await agenda.listClient(MARIA)).map(({ codigo }) => codigo), [moved.agendamento.codigo]);
  // Os lembretes do horário antigo foram cancelados e os do novo criados (sexta 11:00: 24 h antes é hoje 11:00, ainda no futuro).
  assert.deepEqual((await storage.getReminders(MARIA)).map(({ agendadoPara }) => agendadoPara.toISOString()), ['2026-10-01T14:00:00.000Z', '2026-10-02T12:00:00.000Z']);
});

test('a failed reschedule keeps the original booking', async () => {
  const { agenda, storage } = await setup();
  const { agendamento } = await agenda.book(booking());
  await agenda.book(booking({ clientJid: ANA, date: '2026-10-02', time: '11:00' }));

  const failed = await agenda.reschedule({ id: agendamento.codigo, requesterJid: MARIA, date: '2026-10-02', time: '11:00' });
  assert.equal(failed.ok, false);
  assert.equal((await storage.getAppointment(agendamento.codigo)).status, 'confirmado');

  const same = await agenda.reschedule({ id: agendamento.codigo, requesterJid: MARIA, date: '2026-10-03', time: '10:00' });
  assert.match(same.erro, /já está nesse horário/);
  assert.equal((await agenda.reschedule({ id: agendamento.codigo, requesterJid: ANA, date: '2026-10-02', time: '09:00' })).ok, false);
});

test('closed days block new bookings but keep existing ones visible to the owner', async () => {
  const { agenda } = await setup();
  const { agendamento } = await agenda.book(booking());

  const closed = await agenda.closeDay('2026-10-03', 'feriado');
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.agendamentos.map(({ codigo }) => codigo), [agendamento.codigo]);

  const day = await agenda.availability('2026-10-03');
  assert.equal(day.fechado, true);
  assert.equal(day.motivo, 'feriado');
  assert.deepEqual(day.horarios, []);
  assert.match((await agenda.book(booking({ clientJid: ANA, time: '09:00' }))).erro, /não atende nesse dia/);
  assert.ok(!(await agenda.nextAvailability({ maxDays: 5 })).dias.some(({ data }) => data === '2026-10-03'));
  assert.deepEqual((await agenda.listClosedDays('2026-10-01')).map(({ dia }) => dia), ['2026-10-03']);

  assert.equal((await agenda.openDay('2026-10-03')).estavaFechado, true);
  assert.equal((await agenda.openDay('2026-10-03')).estavaFechado, false);
  assert.equal((await agenda.availability('2026-10-03')).fechado, undefined);
  assert.equal((await agenda.closeDay('amanhã')).ok, false);
});

test('hooks may store extra fields, and a failing or slow hook never breaks the booking', async () => {
  const withGoogle = await setup({ hooks: { onBooked: async () => ({ googleEventId: 'evento-1' }) } });
  const { agendamento } = await withGoogle.agenda.book(booking());
  assert.equal((await withGoogle.storage.getAppointment(agendamento.codigo)).googleEventId, 'evento-1');

  const broken = await setup({
    hooks: { onBooked: async () => { throw new Error('WhatsApp caiu'); } }
  });
  assert.equal((await broken.agenda.book(booking())).ok, true);
  assert.equal(broken.events.at(-1)[0], 'warn');

  const slow = await setup({
    hooks: { onBooked: () => new Promise(() => {}) },
    service: { hookTimeoutMs: 20 }
  });
  assert.equal((await slow.agenda.book(booking())).ok, true);
});

test('reminders that would already be in the past are not created', async () => {
  const { agenda, storage } = await setup();
  // Amanhã às 09:00: o lembrete de 24 h seria hoje 09:00 (já passou); só o de 2 h vale.
  const { agendamento } = await agenda.book(booking({ date: '2026-10-02', time: '09:00' }));
  const reminders = await storage.getReminders(MARIA);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].agendadoPara.toISOString(), '2026-10-02T10:00:00.000Z');
  assert.equal((await storage.getAppointment(agendamento.codigo)).lembreteIds.length, 1);
});

test('the day list shows bookings in time order', async () => {
  const { agenda } = await setup();
  await agenda.book(booking({ time: '10:30' }));
  await agenda.book(booking({ clientJid: ANA, clientName: 'Ana', clientNumber: '5511922222222', protocol: 'Bronze', durationMin: 20, time: '09:00' }));
  const list = await agenda.listDay('2026-10-03');
  assert.deepEqual(list.map(({ hora, nome }) => `${hora} ${nome}`), ['09:00 Ana', '10:30 Maria Silva']);
  assert.equal(list[0].numero, '5511922222222');
  assert.deepEqual(await agenda.listDay('2026-10-09'), []);
});
