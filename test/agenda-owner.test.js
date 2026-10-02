import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { startAgendaScheduler } from '../src/handlers/agendaScheduler.js';
import { createAgendaService, formatAgendaList } from '../src/services/agenda.js';
import { createAgendaNotifier } from '../src/services/agendaNotifier.js';
import { buildGoogleEvent, buildIcs, createGoogleCalendar, parseServiceAccount } from '../src/services/calendar.js';
import { MemoryStorage } from '../src/services/storage.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-10-01T13:00:00Z'); // quinta-feira, 01/10/2026, 10:00 em São Paulo
const MARIA = '5511911111111@s.whatsapp.net';
const DONA = '5511945788032';

const appointment = (overrides = {}) => ({
  id: 'A7K3Q',
  clienteJid: MARIA,
  clienteNumero: '5511911111111',
  clienteNome: 'Maria Silva',
  protocolo: 'Protocolo Prata',
  duracaoMin: 30,
  valor: 100,
  inicio: new Date('2026-10-03T13:00:00Z'),
  fim: new Date('2026-10-03T13:30:00Z'),
  status: 'confirmado',
  ...overrides
});

const unfold = (ics) => ics.replace(/\r\n /g, '');

test('the .ics file has the event, the alarm and valid line endings', () => {
  const ics = buildIcs(appointment(), { now: new Date('2026-10-01T13:00:00Z') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'toda quebra de linha é CRLF');

  const text = unfold(ics);
  assert.match(text, /\r\nUID:A7K3Q@botphzeus\r\n/);
  assert.match(text, /\r\nDTSTAMP:20261001T130000Z\r\n/);
  assert.match(text, /\r\nDTSTART:20261003T130000Z\r\n/);
  assert.match(text, /\r\nDTEND:20261003T133000Z\r\n/);
  assert.match(text, /\r\nSUMMARY:Bronze: Maria Silva - Protocolo Prata \(30 min\)\r\n/);
  assert.match(text, /LOCATION:Bot PH Zeus\\, R. Dona Primitiva Vianco\\, 145\\, 3º Andar\\, Sala 312/);
  assert.match(text, /DESCRIPTION:Cliente: Maria Silva\\nWhatsApp: https:\/\/wa\.me\/5511911111111\\nProtocolo Prata\\, 30 min\\, R\$ 100\\,00\\nCódigo: A7K3Q\r\n/);
  assert.match(text, /BEGIN:VALARM\r\nTRIGGER:-PT30M\r\nACTION:DISPLAY\r\n/);
});

test('the .ics escapes special characters and folds long lines by bytes without splitting characters', () => {
  const ics = buildIcs(appointment({ clienteNome: 'Silva, Maria; "Mimi" \\ Júnior ção ção ção ção ção ção ção ção ção ção ção ção' }));
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `linha longa demais: ${line}`);
  }
  const summary = unfold(ics).match(/SUMMARY:(.*)\r\n/)[1];
  assert.ok(summary.startsWith('Bronze: Silva\\, Maria\\; "Mimi" \\\\ Júnior ção ção'), summary);
  assert.ok(summary.includes('ção ção ção ção ção ção ção ção ção ção ção ção - Protocolo Prata'), 'nenhum caractere se perdeu na dobra');
  assert.ok(!ics.includes('�'), 'nenhum caractere foi cortado ao meio');
});

test('the .ics omits the WhatsApp line when the number is unknown', () => {
  assert.ok(!buildIcs(appointment({ clienteNumero: null })).includes('wa.me'));
});

test('Google events carry the time zone, the address and popup reminders', () => {
  const event = buildGoogleEvent(appointment(), { timeZone: TZ });
  assert.equal(event.summary, 'Bronze: Maria Silva - Protocolo Prata (30 min)');
  assert.deepEqual(event.start, { dateTime: '2026-10-03T13:00:00.000Z', timeZone: TZ });
  assert.deepEqual(event.end, { dateTime: '2026-10-03T13:30:00.000Z', timeZone: TZ });
  assert.match(event.location, /Sala 312/);
  assert.match(event.description, /https:\/\/wa\.me\/5511911111111/);
  assert.deepEqual(event.reminders.overrides.map(({ minutes }) => minutes), [60, 15]);
});

test('service account credentials are read from raw JSON or base64, and bad ones are explained', () => {
  const json = JSON.stringify({ client_email: 'bot@projeto.iam.gserviceaccount.com', private_key: 'linha1\\nlinha2' });
  const expected = { clientEmail: 'bot@projeto.iam.gserviceaccount.com', privateKey: 'linha1\nlinha2' };
  assert.deepEqual(parseServiceAccount(json), expected);
  assert.deepEqual(parseServiceAccount(Buffer.from(json).toString('base64')), expected);
  assert.equal(parseServiceAccount(''), null);
  assert.equal(parseServiceAccount(undefined), null);
  assert.throws(() => parseServiceAccount('{não é json'), /JSON da conta de serviço/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ client_email: 'x@y' })), /client_email e private_key/);
});

function googleSetup(options = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const requests = [];
  let clock = 1_800_000_000_000;
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), ...init });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return Response.json(options.tokenResponse || { access_token: `token-${requests.length}`, expires_in: 3600 }, { status: options.tokenStatus || 200 });
    }
    if (init.method === 'DELETE') return new Response(null, { status: options.deleteStatus || 204 });
    return Response.json(options.eventResponse || { id: 'evento-1' }, { status: options.eventStatus || 200 });
  };
  const calendar = createGoogleCalendar({
    calendarId: 'dona@gmail.com',
    credentials: { clientEmail: 'bot@projeto.iam.gserviceaccount.com', privateKey },
    fetchImpl,
    now: () => clock
  });
  return { calendar, requests, publicKey, advance: (ms) => { clock += ms; } };
}

test('the Google client signs a valid JWT, creates events and reuses the token', async () => {
  const { calendar, requests, publicKey } = googleSetup();

  assert.equal(await calendar.createEvent({ summary: 'teste' }), 'evento-1');

  const [tokenRequest, eventRequest] = requests;
  const assertion = new URLSearchParams(tokenRequest.body.toString());
  assert.equal(assertion.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = assertion.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.iss, 'bot@projeto.iam.gserviceaccount.com');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/calendar.events');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.exp - payload.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'), 'assinatura RS256 válida');

  assert.equal(eventRequest.url, 'https://www.googleapis.com/calendar/v3/calendars/dona%40gmail.com/events');
  assert.equal(eventRequest.method, 'POST');
  assert.equal(eventRequest.headers.authorization, 'Bearer token-1');
  assert.deepEqual(JSON.parse(eventRequest.body), { summary: 'teste' });

  await calendar.createEvent({ summary: 'outro' });
  assert.equal(requests.filter(({ url }) => url.includes('oauth2')).length, 1, 'token reaproveitado');
});

test('the Google client refreshes an expired token and deletes events, tolerating events already gone', async () => {
  const { calendar, requests, advance } = googleSetup();
  await calendar.createEvent({ summary: 'a' });
  advance(3_600_000);
  await calendar.deleteEvent('evento/1');

  assert.equal(requests.filter(({ url }) => url.includes('oauth2')).length, 2, 'token renovado depois de vencer');
  const deletion = requests.at(-1);
  assert.equal(deletion.method, 'DELETE');
  assert.equal(deletion.url, 'https://www.googleapis.com/calendar/v3/calendars/dona%40gmail.com/events/evento%2F1');
  assert.equal(deletion.headers.authorization, 'Bearer token-3');

  for (const deleteStatus of [404, 410]) {
    await googleSetup({ deleteStatus }).calendar.deleteEvent('x');
  }
});

test('Google failures explain what went wrong without leaking secrets', async () => {
  const denied = googleSetup({ eventStatus: 404, eventResponse: { error: { message: 'Not Found' } } });
  await assert.rejects(denied.calendar.createEvent({}), /Criar evento no Google Agenda falhou: HTTP 404 \(Not Found\)/);

  const login = googleSetup({ tokenStatus: 400, tokenResponse: { error: 'invalid_grant' } });
  await assert.rejects(login.calendar.createEvent({}), /Login no Google falhou: HTTP 400/);

  await assert.rejects(googleSetup({ deleteStatus: 500 }).calendar.deleteEvent('x'), /Apagar evento no Google Agenda falhou: HTTP 500/);
});

function notifierSetup(options = {}) {
  const sent = [];
  const warnings = [];
  const googleCalls = [];
  let created = 0;
  const googleCalendar = options.google === false ? null : {
    createEvent: async (event) => {
      if (options.googleFails) throw new Error('Google fora do ar');
      googleCalls.push(['create', event.summary]);
      created += 1;
      return `evento-${created}`;
    },
    deleteEvent: async (id) => { googleCalls.push(['delete', id]); }
  };
  const sock = { sendMessage: async (jid, content) => { sent.push({ jid, ...content }); } };
  const notifier = createAgendaNotifier({
    getSocket: () => (options.disconnected ? null : sock),
    ownerNumbers: options.owners ?? [DONA],
    timeZone: TZ,
    googleCalendar,
    logger: { warn: (...args) => warnings.push(args) },
    now: () => NOW
  });
  return { notifier, sent, warnings, googleCalls };
}

test('a new booking warns the owner on WhatsApp with a calendar file and syncs Google Agenda', async () => {
  const { notifier, sent, googleCalls } = notifierSetup({ owners: [DONA, '5511900000000'] });

  const changes = await notifier.hooks.onBooked(appointment());

  assert.deepEqual(sent.map(({ jid }) => jid), [`${DONA}@s.whatsapp.net`, '5511900000000@s.whatsapp.net']);
  const [message] = sent;
  assert.equal(message.mimetype, 'text/calendar');
  assert.equal(message.fileName, 'agendamento-A7K3Q.ics');
  assert.match(message.document.toString('utf8'), /BEGIN:VEVENT[\s\S]*DTSTART:20261003T130000Z/);
  for (const expected of [
    'Novo agendamento* · código *A7K3Q*',
    '👤 Maria Silva — https://wa.me/5511911111111',
    '☀️ Protocolo Prata · 30 min · R$ 100,00',
    '🗓️ sábado, 03/10 às 10:00',
    '/admin cancelar A7K3Q'
  ]) {
    assert.ok(message.caption.includes(expected), `falta: ${expected}`);
  }
  assert.deepEqual(googleCalls, [['create', 'Bronze: Maria Silva - Protocolo Prata (30 min)']]);
  assert.deepEqual(changes, { googleEventId: 'evento-1' });
});

test('a booking still works when WhatsApp or Google are down', async () => {
  const offline = notifierSetup({ disconnected: true });
  assert.deepEqual(await offline.notifier.hooks.onBooked(appointment()), { googleEventId: 'evento-1' });
  assert.equal(offline.sent.length, 0);
  assert.match(offline.warnings[0][1], /avisar a dona/);

  const googleDown = notifierSetup({ googleFails: true });
  assert.equal(await googleDown.notifier.hooks.onBooked(appointment()), undefined);
  assert.equal(googleDown.sent.length, 1, 'a dona foi avisada mesmo assim');

  const noGoogle = notifierSetup({ google: false });
  assert.equal(await noGoogle.notifier.hooks.onBooked(appointment()), undefined);
  assert.equal(noGoogle.sent.length, 1);
});

test('without an owner number nobody is warned, and the logs say why', async () => {
  const { notifier, sent, warnings } = notifierSetup({ owners: [] });
  assert.match(warnings[0][0], /NUMERO_DONO não configurado/);
  await notifier.hooks.onBooked(appointment());
  assert.deepEqual(sent, []);
});

test('when the client cancels, the owner is told and the Google event is removed', async () => {
  const { notifier, sent, googleCalls } = notifierSetup();
  await notifier.hooks.onCancelled(appointment({ googleEventId: 'evento-9' }), { by: 'cliente' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, `${DONA}@s.whatsapp.net`);
  assert.match(sent[0].text, /Agendamento cancelado pelo cliente\* · código \*A7K3Q\*/);
  assert.match(sent[0].text, /sábado, 03\/10 às 10:00/);
  assert.match(sent[0].text, /O horário voltou a ficar livre/);
  assert.deepEqual(googleCalls, [['delete', 'evento-9']]);
});

test('when the owner cancels, the client is told and the owner is not messaged again', async () => {
  const { notifier, sent, googleCalls } = notifierSetup();
  await notifier.hooks.onCancelled(appointment({ googleEventId: 'evento-9' }), { by: 'dona', reason: 'imprevisto' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, MARIA);
  assert.match(sent[0].text, /Olá, Maria! Precisei cancelar o seu horário de sábado, 03\/10 às 10:00 \(código A7K3Q\)\. Motivo: imprevisto\./);
  assert.match(sent[0].text, /me dizer outro dia e horário/);
  assert.deepEqual(googleCalls, [['delete', 'evento-9']]);

  const withoutReason = notifierSetup();
  await withoutReason.notifier.hooks.onCancelled(appointment(), { by: 'dona' });
  assert.ok(!withoutReason.sent[0].text.includes('Motivo'));
  assert.deepEqual(withoutReason.googleCalls, [], 'sem evento no Google, nada a apagar');
});

test('a reschedule warns the owner with before and after and swaps the Google event', async () => {
  const { notifier, sent, googleCalls } = notifierSetup();
  const before = appointment({ googleEventId: 'evento-antigo' });
  const next = appointment({ id: 'B8M4R', inicio: new Date('2026-10-02T12:00:00Z'), fim: new Date('2026-10-02T12:30:00Z') });

  const changes = await notifier.hooks.onRescheduled(before, next);

  assert.equal(sent[0].fileName, 'agendamento-B8M4R.ics');
  assert.match(sent[0].caption, /Agendamento remarcado\* · código \*B8M4R\*/);
  assert.match(sent[0].caption, /❌ Antes: sábado, 03\/10 às 10:00/);
  assert.match(sent[0].caption, /✅ Agora: sexta-feira, 02\/10 às 09:00/);
  assert.deepEqual(googleCalls.map(([action]) => action), ['delete', 'create']);
  assert.equal(googleCalls[0][1], 'evento-antigo');
  assert.deepEqual(changes, { googleEventId: 'evento-1' });
});

test('the agenda service and the notifier work together end to end', async () => {
  const storage = new MemoryStorage();
  await storage.updateBotSettings({ agendaHorario: 'seg-sex 09:00-12:00; sab 09:00-11:00' });
  const { notifier, sent, googleCalls } = notifierSetup();
  const agenda = createAgendaService({ storage, timeZone: TZ, now: () => NOW, hooks: notifier.hooks });

  const booked = await agenda.book({
    clientJid: MARIA, clientNumber: '5511911111111', clientName: 'Maria Silva',
    protocol: 'Prata', durationMin: 30, date: '2026-10-03', time: '10:00'
  });
  assert.equal(booked.ok, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].caption.includes(`*${booked.agendamento.codigo}*`));
  assert.equal((await storage.getAppointment(booked.agendamento.codigo)).googleEventId, 'evento-1');

  const moved = await agenda.reschedule({ id: booked.agendamento.codigo, requesterJid: MARIA, date: '2026-10-02', time: '09:00' });
  assert.equal(moved.ok, true);
  assert.equal((await storage.getAppointment(moved.agendamento.codigo)).googleEventId, 'evento-2');

  await agenda.cancel({ id: moved.agendamento.codigo, requesterJid: MARIA });
  assert.deepEqual(googleCalls.map(([action]) => action), ['create', 'delete', 'create', 'delete']);
  assert.match(sent.at(-1).text, /cancelado pelo cliente/);

  const byOwner = await agenda.book({ clientJid: MARIA, clientName: 'Maria', protocol: 'Bronze', durationMin: 20, date: '2026-10-03', time: '09:00' });
  await agenda.cancel({ id: byOwner.agendamento.codigo, by: 'dona', reason: 'folga' });
  assert.equal(sent.at(-1).jid, MARIA);
  assert.match(sent.at(-1).text, /Motivo: folga/);
});

test('the day list for the owner shows time, client, service, price, code and contact', () => {
  const list = formatAgendaList([
    { hora: '09:00', nome: 'Ana', protocolo: 'Protocolo Bronze', duracaoMinutos: 20, valor: 'R$ 60,00', codigo: 'AAAAA', numero: '5511922222222' },
    { hora: '10:30', nome: 'Maria Silva', protocolo: 'Protocolo Ouro', duracaoMinutos: 30, valor: 'R$ 120,00', codigo: 'BBBBB' }
  ]);
  assert.equal(list, [
    '- 09:00 · Ana · Bronze 20 min · R$ 60,00 · AAAAA',
    '  https://wa.me/5511922222222',
    '- 10:30 · Maria Silva · Ouro 30 min · R$ 120,00 · BBBBB'
  ].join('\n'));
});

async function schedulerSetup({ now, bookings = true, sendFails = 0, hour = 8 } = {}) {
  const storage = new MemoryStorage();
  await storage.updateBotSettings({ agendaHorario: 'seg-sex 09:00-12:00; sab 09:00-11:00' });
  const agenda = createAgendaService({ storage, timeZone: TZ, now: () => NOW });
  if (bookings) {
    await agenda.book({ clientJid: MARIA, clientNumber: '5511911111111', clientName: 'Maria Silva', protocol: 'Prata', durationMin: 30, date: '2026-10-03', time: '10:00' });
    await agenda.book({ clientJid: '5511922222222@s.whatsapp.net', clientName: 'Ana', protocol: 'Bronze', durationMin: 20, date: '2026-10-03', time: '09:00' });
  }
  const sent = [];
  let failures = sendFails;
  const stop = startAgendaScheduler({
    agenda,
    storage,
    sendToOwners: async (text) => {
      if (failures-- > 0) throw new Error('WhatsApp desconectado.');
      sent.push(text);
    },
    summaryHour: hour,
    timeZone: TZ,
    intervalMs: 5,
    logger: { error() {} },
    now: () => now
  });
  return { storage, sent, stop };
}

test('the daily summary goes out once, at the configured hour, only when there are bookings', async (t) => {
  const { sent, stop, storage } = await schedulerSetup({ now: new Date('2026-10-03T11:05:00Z') }); // sábado, 08:05
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(sent.length, 1, 'enviado uma vez, mesmo com vários ciclos do relógio');
  assert.match(sent[0], /^☀️ \*Agenda de hoje\* — sábado, 03\/10 \(2 horários\)\n- 09:00 · Ana · Bronze 20 min · R\$ 60,00 · /);
  assert.match(sent[0], /- 10:00 · Maria Silva · Prata 30 min · R\$ 100,00 · /);
  assert.equal((await storage.getBotSettings()).ultimoResumoDia, '2026-10-03');
});

test('the daily summary stays quiet outside the hour and on empty days', async (t) => {
  const wrongHour = await schedulerSetup({ now: new Date('2026-10-03T13:00:00Z') }); // 10:00
  const emptyDay = await schedulerSetup({ now: new Date('2026-10-03T11:05:00Z'), bookings: false });
  const disabled = await schedulerSetup({ now: new Date('2026-10-03T11:05:00Z'), hour: null });
  t.after(() => { wrongHour.stop(); emptyDay.stop(); disabled.stop(); });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(wrongHour.sent, []);
  assert.equal((await wrongHour.storage.getBotSettings()).ultimoResumoDia, undefined);
  assert.deepEqual(emptyDay.sent, []);
  assert.equal((await emptyDay.storage.getBotSettings()).ultimoResumoDia, '2026-10-03', 'dia sem agendamentos também é marcado');
  assert.deepEqual(disabled.sent, []);
});

test('a failed daily summary is retried on the next cycle', async (t) => {
  const { sent, stop } = await schedulerSetup({ now: new Date('2026-10-03T11:05:00Z'), sendFails: 2 });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.length, 1);
});
