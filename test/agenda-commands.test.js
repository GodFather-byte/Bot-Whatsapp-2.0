import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdminCommand } from '../src/handlers/admin.js';
import { handleCommand } from '../src/handlers/commands.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { createAgendaService } from '../src/services/agenda.js';
import { MemoryStorage } from '../src/services/storage.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-10-01T13:00:00Z'); // quinta-feira, 01/10/2026, 10:00 em São Paulo
const MARIA = '5511911111111@s.whatsapp.net';
const ANA = '5511922222222@s.whatsapp.net';
const HOURS = 'seg-sex 09:00-12:00; sab 09:00-11:00';

async function setup({ hours = HOURS } = {}) {
  const storage = new MemoryStorage();
  if (hours) await storage.updateBotSettings({ agendaHorario: hours });
  const events = [];
  const agenda = createAgendaService({
    storage,
    timeZone: TZ,
    now: () => NOW,
    hooks: { onCancelled: async (appointment, extra) => { events.push(['cancelled', appointment.id, extra.by, extra.reason]); } }
  });
  const stats = { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [] };
  const admin = (argument) => handleAdminCommand(argument, { storage, stats, agenda, timeZone: TZ, now: () => NOW });
  const client = (text, jid = MARIA) => handleCommand(text, jid, { storage, stats, agenda, timeZone: TZ, now: () => NOW });
  const book = async (clientJid, name, number, protocol, durationMin, date, time) => (await agenda.book({
    clientJid, clientName: name, clientNumber: number, protocol, durationMin, date, time
  })).agendamento;
  return { storage, agenda, events, admin, client, book };
}

test('the owner sees the day, the week and the closed days in the agenda', async () => {
  const { admin, book } = await setup();
  assert.equal(await admin('agenda'), '📅 *Agenda de quinta-feira, 01/10*\nNenhum agendamento.');

  const maria = await book(MARIA, 'Maria Silva', '5511911111111', 'Prata', 30, '2026-10-03', '10:00');
  const ana = await book(ANA, 'Ana', '5511922222222', 'Bronze', 20, '2026-10-03', '09:00');

  const saturday = [
    '📅 *Agenda de sábado, 03/10* (2)',
    `- 09:00 · Ana · Bronze 20 min · R$ 60,00 · ${ana.codigo}`,
    '  https://wa.me/5511922222222',
    `- 10:00 · Maria Silva · Prata 30 min · R$ 100,00 · ${maria.codigo}`,
    '  https://wa.me/5511911111111'
  ].join('\n');
  assert.equal(await admin('agenda 03/10'), saturday);
  assert.equal(await admin('agenda 2026-10-03'), saturday);
  assert.equal(await admin('agenda amanhã'), '📅 *Agenda de sexta-feira, 02/10*\nNenhum agendamento.');
  assert.equal(await admin('agenda semana'), `📅 *Agenda dos próximos 7 dias*\n\n*sábado, 03/10*\n${saturday.split('\n').slice(1).join('\n')}`);
  assert.equal(await admin('agenda 20/10'), '📅 *Agenda de terça-feira, 20/10*\nNenhum agendamento.');
  assert.match(await admin('agenda quando'), /Não entendi a data/);

  await admin('fechar 03/10 feriado');
  assert.match(await admin('agenda 03/10'), /^📅 \*Agenda de sábado, 03\/10\* \(2\)\n🚫 Dia fechado: feriado\n- 09:00/);
});

test('the owner sets, checks and turns off the agenda hours', async () => {
  const { admin, storage } = await setup({ hours: null });

  assert.match(await admin('agenda config'), /^Horário da agenda: \(não configurado: a IA encaminha os clientes para você\)/);
  assert.match(await admin('agenda horario'), /Informe o horário/);
  assert.match(await admin('agenda horario xyz'), /Regra inválida/);
  assert.match(await admin('agenda horario seg-sex 18:00-09:00'), /depois do início/);
  assert.match(await admin('agenda horario seg-sex 09:00-09:20'), /pelo menos 30 minutos/);
  assert.equal((await storage.getBotSettings()).agendaHorario, undefined, 'horário inválido não é gravado');

  assert.equal(
    await admin('agenda horario seg-sex 09:00-19:00; sab 09:00-14:00'),
    'Horário da agenda definido: segunda a sexta, das 09:00 às 19:00; sábado, das 09:00 às 14:00.\nA IA já pode agendar clientes nesses horários, de 30 em 30 minutos.'
  );
  assert.equal((await storage.getBotSettings()).agendaHorario, 'seg-sex 09:00-19:00; sab 09:00-14:00');
  assert.match(await admin('config'), /Agenda \(horários para agendar\): seg-sex 09:00-19:00; sab 09:00-14:00/);

  assert.equal(await admin('agenda config'), [
    'Horário da agenda: segunda a sexta, das 09:00 às 19:00; sábado, das 09:00 às 14:00',
    'Intervalo entre horários: 30 min',
    'Antecedência mínima: 60 min',
    'Agenda aberta para os próximos 30 dias',
    'Máximo de agendamentos ativos por cliente: 2',
    'Lembretes ao cliente: 24 h e 2 h antes',
    'Dias fechados: (nenhum)'
  ].join('\n'));

  assert.match(await admin('agenda horario desligar'), /Agenda desligada/);
  assert.equal((await storage.getBotSettings()).agendaHorario, undefined);
  assert.match(await admin('config'), /Agenda \(horários para agendar\): \(desligada\)/);
});

test('the owner cancels a booking by code and the agenda is told it was her', async () => {
  const { admin, book, events, client } = await setup();
  const maria = await book(MARIA, 'Maria Silva', '5511911111111', 'Prata', 30, '2026-10-03', '10:00');

  assert.match(await admin('cancelar'), /Informe o código/);
  assert.equal(await admin('cancelar ZZZZZ'), 'Agendamento não encontrado ou já cancelado.');
  assert.equal(
    await admin(`cancelar ${maria.codigo.toLowerCase()} imprevisto de saúde`),
    `Agendamento ${maria.codigo} cancelado (Maria Silva, sábado, 03/10 às 10:00). O cliente foi avisado.`
  );
  assert.deepEqual(events, [['cancelled', maria.codigo, 'dona', 'imprevisto de saúde']]);
  assert.equal(await admin(`cancelar ${maria.codigo}`), 'Agendamento não encontrado ou já cancelado.');
  assert.match(await client('/agendamentos'), /não tem agendamentos/);
});

test('the owner closes and reopens days, and is warned about bookings that stay', async () => {
  const { admin, book } = await setup();
  const ana = await book(ANA, 'Ana', '5511922222222', 'Bronze', 20, '2026-10-03', '09:00');

  assert.equal(await admin('fechar 12/10'), 'Dia fechado: segunda-feira, 12/10. Ninguém consegue marcar nesse dia.');
  assert.equal(
    await admin('fechar 03/10 feriado'),
    [
      'Dia fechado: sábado, 03/10 (feriado). Ninguém consegue marcar nesse dia.',
      '',
      '⚠️ Já existem agendamentos nesse dia, que não foram cancelados:',
      `- 09:00 · Ana · Bronze 20 min · R$ 60,00 · ${ana.codigo}`,
      '  https://wa.me/5511922222222',
      'Para cancelar e avisar o cliente: /admin cancelar <código>'
    ].join('\n')
  );
  assert.match(await admin('agenda config'), /Dias fechados: 03\/10 \(feriado\), 12\/10$/);

  assert.equal(await admin('abrir 12/10'), 'Dia reaberto: segunda-feira, 12/10.');
  assert.equal(await admin('abrir 12/10'), 'segunda-feira, 12/10 não estava fechado.');
  assert.match(await admin('fechar'), /Informe o dia/);
  assert.match(await admin('fechar xyz'), /Informe o dia/);
  assert.match(await admin('abrir'), /Informe o dia/);
});

test('admin agenda commands explain when the agenda is not available', async () => {
  const stats = { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [] };
  const run = (argument) => handleAdminCommand(argument, { storage: new MemoryStorage(), stats });
  for (const command of ['agenda', 'agenda horario seg 09:00-10:00', 'cancelar ABCDE', 'fechar 12/10', 'abrir 12/10']) {
    assert.equal(await run(command), 'A agenda não está disponível neste número.', command);
  }
  const help = await run('ajuda');
  for (const expected of ['/admin agenda', '/admin agenda horario', '/admin cancelar <código>', '/admin fechar <data>']) {
    assert.ok(help.includes(expected), `ajuda sem ${expected}`);
  }
});

test('clients see free slots for the next days or for a chosen day', async () => {
  const { client, admin } = await setup();

  assert.equal(await client('/horarios'), [
    '🗓️ *Horários livres*',
    '*quinta-feira, 01/10*: 11:00, 11:30',
    '*sexta-feira, 02/10*: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30',
    '*sábado, 03/10*: 09:00, 09:30, 10:00, 10:30',
    '',
    'Para agendar, é só me dizer o dia, o horário e o protocolo. ☀️'
  ].join('\n'));
  assert.equal(
    await client('/horarios amanhã'),
    '🗓️ *Horários livres*\n*sexta-feira, 02/10*: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30\n\nPara agendar, é só me dizer o dia, o horário e o protocolo. ☀️'
  );
  assert.equal(await client('/horários 04/10'), 'Sem horários livres em domingo, 04/10. Tente outro dia!');
  assert.match(await client('/horarios quando'), /Não entendi a data/);
  assert.match(await client('/horarios 30/09'), /próximos 30 dias/);

  await admin('fechar 03/10 feriado');
  assert.equal(await client('/horarios 03/10'), 'Não atendemos em sábado, 03/10 (feriado). Quer ver outro dia?');
  assert.ok(!(await client('/horarios')).includes('03/10'), 'dia fechado some da lista');
});

test('without agenda hours, or outside private chats, slot commands point to the owner or the private chat', async () => {
  const { client } = await setup({ hours: null });
  assert.match(await client('/horarios'), /A agenda online ainda não está liberada\. Para agendar, chame a dona do estúdio no WhatsApp: \(11\) 94578-8032/);

  const stats = { totalMessages: 0, users: new Set() };
  const inGroup = (text) => handleCommand(text, '123@g.us', { storage: new MemoryStorage(), stats });
  for (const command of ['/horarios', '/agendamentos', '/agenda', '/cancelar_agendamento ABCDE']) {
    assert.match(await inGroup(command), /conversa privada/, command);
  }
});

test('clients list and cancel only their own bookings', async () => {
  const { client, book, events } = await setup();
  assert.match(await client('/agendamentos'), /Você não tem agendamentos\. Quer marcar um horário\?/);

  const maria = await book(MARIA, 'Maria Silva', '5511911111111', 'Prata', 30, '2026-10-03', '10:00');
  await book(MARIA, 'Maria Silva', '5511911111111', 'Ouro', 20, '2026-10-02', '09:00');

  const list = await client('/agendamentos');
  assert.match(list, /^📅 \*Seus agendamentos\*\n- sexta-feira, 02\/10 às 09:00 · Ouro 20 min · R\$ 100,00 · código [A-Z0-9]{5}\n- sábado, 03\/10 às 10:00 · Prata 30 min · R\$ 100,00 · código [A-Z0-9]{5}\n\nPara cancelar: \/cancelar_agendamento [A-Z0-9]{5}$/);
  assert.equal(await client('/agenda'), list, '/agenda é atalho de /agendamentos');
  assert.equal(await client('/agendamentos', ANA), 'Você não tem agendamentos. Quer marcar um horário? É só me dizer o dia e o horário que prefere! ☀️');

  assert.match(await client('/cancelar_agendamento'), /Informe o código/);
  assert.equal(await client(`/cancelar_agendamento ${maria.codigo}`, ANA), 'Agendamento não encontrado ou já cancelado.');
  assert.equal(
    await client(`/cancelar_agendamento ${maria.codigo.toLowerCase()}`),
    `Agendamento ${maria.codigo} (sábado, 03/10 às 10:00) cancelado. Se quiser, posso marcar outro horário! ☀️`
  );
  assert.deepEqual(events, [['cancelled', maria.codigo, 'cliente', undefined]]);
  assert.equal(await client(`/cancelar_agendamento ${maria.codigo}`), 'Agendamento não encontrado ou já cancelado.');
});

test('the client help lists the new commands', async () => {
  const { client } = await setup();
  const help = await client('/ajuda');
  for (const expected of ['/horarios [data]', '/agendamentos', '/cancelar_agendamento <código>']) {
    assert.ok(help.includes(expected), `ajuda sem ${expected}`);
  }
});

test('agenda commands work through the real message handler, in private chats, groups and the owner self-chat', async () => {
  const storage = new MemoryStorage();
  const agenda = createAgendaService({ storage, timeZone: TZ, now: () => NOW });
  const aiCalls = [];
  const sent = [];
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async (request) => { aiCalls.push(request); return 'resposta da IA'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    ownerNumbers: ['5511945788032'],
    agenda,
    now: () => NOW.getTime()
  });
  const sock = {
    user: { id: '5511991361386:3@s.whatsapp.net' },
    sendMessage: async (jid, content) => { sent.push({ jid, text: content.text }); },
    sendPresenceUpdate: async () => {}
  };
  const OWNER = '5511945788032@s.whatsapp.net';
  const say = (jid, text, extra = {}) => handler(sock, { key: { remoteJid: jid }, message: { conversation: text }, ...extra });

  // A dona define o horário da agenda de qualquer conversa, e um cliente já enxerga os horários.
  await say(OWNER, '/admin agenda horario seg-sex 09:00-12:00; sab 09:00-11:00');
  assert.match(sent.at(-1).text, /^Horário da agenda definido: segunda a sexta/);
  assert.equal(sent.at(-1).jid, OWNER);

  await say(MARIA, '/horarios amanhã');
  assert.match(sent.at(-1).text, /\*sexta-feira, 02\/10\*: 09:00, 09:30/);
  assert.equal(sent.at(-1).jid, MARIA);
  await say(MARIA, '/agendamentos');
  assert.match(sent.at(-1).text, /não tem agendamentos/);

  // Um cliente não consegue usar os comandos da dona.
  await say(MARIA, '/admin agenda config');
  assert.equal(sent.at(-1).text, 'Apenas o dono do bot pode usar os comandos /admin.');

  // Em grupo (com o bot mencionado), a agenda não está disponível.
  await handler(sock, {
    key: { remoteJid: '12345@g.us', participant: ANA },
    message: { extendedTextMessage: { text: '@5511991361386 /horarios', contextInfo: { mentionedJid: ['5511991361386@s.whatsapp.net'] } } }
  });
  assert.match(sent.at(-1).text, /conversa privada/);

  // Na conversa "Você" do celular do bot, a dona também comanda a agenda.
  const selfJid = '5511991361386@s.whatsapp.net';
  await handler(sock, { key: { remoteJid: selfJid, fromMe: true }, message: { conversation: '/admin agenda config' } });
  assert.equal(sent.at(-1).jid, selfJid);
  assert.match(sent.at(-1).text, /^Horário da agenda: segunda a sexta, das 09:00 às 12:00; sábado, das 09:00 às 11:00/);

  assert.deepEqual(aiCalls, [], 'comandos não gastam chamadas da IA');
});
