import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStorage } from '../src/services/storage.js';
import { startReminderScheduler } from '../src/handlers/reminders.js';
import { parseReminder } from '../src/utils/time.js';
import { executeTool } from '../src/handlers/tools.js';

test('memory storage retains only the latest requested conversation history', async () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < 12; index += 1) {
    await storage.addMessage({
      remoteJid: 'user@s.whatsapp.net',
      role: 'user',
      conteudo: `message ${index}`,
      tipo: 'texto'
    });
  }
  const history = await storage.getHistory('user@s.whatsapp.net', 10);
  assert.equal(history.length, 10);
  assert.equal(history[0].conteudo, 'message 2');
  await storage.resetHistory('user@s.whatsapp.net');
  assert.deepEqual(await storage.getHistory('user@s.whatsapp.net'), []);
});

test('reminder parser understands dates, relative times and recurrence in the configured time zone', () => {
  const now = new Date('2026-10-01T13:00:00Z'); // quinta-feira, 10:00 em São Paulo
  const tz = 'America/Sao_Paulo';
  const at = (input) => parseReminder(input, now, tz)?.agendadoPara.toISOString();

  assert.equal(at('11:30 reunião'), '2026-10-01T14:30:00.000Z');
  assert.equal(parseReminder('11:30 reunião', now, tz).mensagem, 'reunião');
  assert.equal(at('amanhã 09:00 pagar conta'), '2026-10-02T12:00:00.000Z');
  assert.equal(parseReminder('amanhã 09:00 ligar para João', now, tz).mensagem, 'ligar para João');
  assert.equal(at('25/12 10:00 natal'), '2026-12-25T13:00:00.000Z');
  assert.equal(at('15/03 08:00 aniversário'), '2027-03-15T11:00:00.000Z');
  assert.equal(at('01/01/2027 00:00 ano novo'), '2027-01-01T03:00:00.000Z');
  assert.equal(at('em 30 min tirar o bolo'), '2026-10-01T13:30:00.000Z');
  assert.equal(at('em 2 horas sair'), '2026-10-01T15:00:00.000Z');
  assert.deepEqual(parseReminder('todo dia 08:00 remédio', now, tz), {
    agendadoPara: new Date('2026-10-02T11:00:00Z'),
    mensagem: 'remédio',
    recorrencia: { tipo: 'diaria', hora: 8, minuto: 0 }
  });
  assert.equal(at('toda segunda 09:00 reunião'), '2026-10-05T12:00:00.000Z');
  assert.equal(at('todas as segundas-feiras 09:00 reunião'), '2026-10-05T12:00:00.000Z');
  assert.equal(at('todo sábado 10:00 feira'), '2026-10-03T13:00:00.000Z');

  for (const invalid of ['09:00 já passou', '25:00 x', '31/02 10:00 x', 'toda blabla 09:00 x', 'soon', '14:30']) {
    assert.equal(parseReminder(invalid, now, tz), null, invalid);
  }
});

test('recurring reminders are rescheduled after being sent', async (t) => {
  const storage = new MemoryStorage();
  const sent = [];
  const reminder = await storage.createReminder({
    usuarioId: 'user@s.whatsapp.net',
    mensagem: 'remédio',
    agendadoPara: new Date('2026-10-01T11:00:00Z'),
    recorrencia: { tipo: 'diaria', hora: 8, minuto: 0 }
  });
  const once = await storage.createReminder({ usuarioId: 'user@s.whatsapp.net', mensagem: 'único', agendadoPara: new Date(0) });
  const stop = startReminderScheduler({
    storage,
    sock: { sendMessage: async (jid, { text }) => sent.push(text) },
    intervalMs: 5,
    logger: { error() {} },
    timeZone: 'America/Sao_Paulo',
    now: () => new Date('2026-10-01T11:00:30Z')
  });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(sent.sort(), ['📌 Lembrete: remédio', '📌 Lembrete: único']);
  assert.equal(storage.reminders.get(reminder.id).enviado, false);
  assert.deepEqual(storage.reminders.get(reminder.id).agendadoPara, new Date('2026-10-02T11:00:00Z'));
  assert.equal(storage.reminders.get(once.id).enviado, true);
});

test('calculator handles arithmetic without evaluating arbitrary code', async () => {
  assert.deepEqual(await executeTool('calcular_expressao', { expr: '2+2*3' }), { resultado: 8 });
  await assert.rejects(executeTool('calcular_expressao', { expr: 'process.exit()' }));
});
