import assert from 'node:assert/strict';
import test from 'node:test';
import { splitMessage, toWhatsAppFormat } from '../src/utils/format.js';
import { isWithinBusinessHours, parseBusinessHours } from '../src/utils/time.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const OWNER = '5511900000000';
const BOT = { id: '5511000000000:3@s.whatsapp.net', lid: '777000@lid' };

test('markdown from Gemini is converted to WhatsApp formatting', () => {
  const input = '# Título\n**negrito** e *itálico* e ~~riscado~~\n* item um\n* item dois\n[site](https://x.com)\n---\n```\n**não mexe**\n```';
  assert.equal(
    toWhatsAppFormat(input),
    '*Título*\n*negrito* e _itálico_ e ~riscado~\n- item um\n- item dois\nsite (https://x.com)\n```\n**não mexe**\n```'
  );
});

test('long answers are split between paragraphs without breaking words', () => {
  const paragraph = 'palavra '.repeat(130).trim();
  const chunks = splitMessage(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 3000);
  assert.deepEqual(chunks, [`${paragraph}\n\n${paragraph}`, paragraph]);
  const words = splitMessage('palavra '.repeat(500), 3000);
  assert.ok(words.every((chunk) => chunk.length <= 3000 && /^palavra.*palavra$/s.test(chunk)));
  assert.deepEqual(splitMessage('x'.repeat(10), 4), ['xxxx', 'xxxx', 'xx']);
});

test('business hours follow the configured time zone', () => {
  const rules = parseBusinessHours('seg-sex 09:00-18:00; sab 09:00-13:00');
  const tz = 'America/Sao_Paulo';
  assert.equal(isWithinBusinessHours(rules, new Date('2026-10-01T13:00:00Z'), tz), true); // qui 10:00
  assert.equal(isWithinBusinessHours(rules, new Date('2026-10-01T22:00:00Z'), tz), false); // qui 19:00
  assert.equal(isWithinBusinessHours(rules, new Date('2026-10-03T15:00:00Z'), tz), true); // sáb 12:00
  assert.equal(isWithinBusinessHours(rules, new Date('2026-10-04T15:00:00Z'), tz), false); // dom
  assert.deepEqual(parseBusinessHours('sex-seg 10:00-11:00')[0].dias.sort(), [0, 1, 5, 6]);
  assert.throws(() => parseBusinessHours('seg-sex 18:00-09:00'), /depois do início/);
  assert.throws(() => parseBusinessHours('xyz 09:00-18:00'), /Dia inválido/);
});

function setup(options = {}) {
  const sent = [];
  const prompts = [];
  const storage = options.storage || new MemoryStorage();
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async ({ text, extraInstruction }) => { prompts.push({ text, extraInstruction }); return '**ok**'; } },
    allowlist: createAllowlist(options.allowed || []),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    ownerNumbers: [OWNER],
    getStatus: () => ({ mongoConnected: false, bots: [{ numero: '5511000000000', conectado: true }] }),
    broadcastDelayMs: 0,
    ...options.handler
  });
  const sock = {
    user: BOT,
    signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === '424242@lid' ? `${OWNER}:0@s.whatsapp.net` : null) } },
    sendMessage: async (jid, content, extra) => sent.push({ jid, text: content.text, quoted: Boolean(extra?.quoted) }),
    sendPresenceUpdate: async () => {}
  };
  const from = (jid, text, key = {}) => handler(sock, { key: { remoteJid: jid, ...key }, message: { conversation: text } });
  return { handler, sock, sent, prompts, storage, from };
}

test('only the owner can use admin commands, also when identified by LID', async () => {
  const { from, sent, storage } = setup();

  await from('5531777777777@s.whatsapp.net', '/admin status');
  assert.equal(sent.at(-1).text, 'Apenas o dono do bot pode usar os comandos /admin.');

  await from('424242@lid', '/admin status');
  assert.match(sent.at(-1).text, /Mensagens processadas/);
  assert.match(sent.at(-1).text, /🟢 5511000000000/);

  await from(`${OWNER}@s.whatsapp.net`, '/admin instrucoes Você atende uma pizzaria.');
  await from(`${OWNER}@s.whatsapp.net`, '/admin horario seg-sab 25:00-18:00');
  assert.match(sent.at(-1).text, /Horário inválido/);
  assert.equal((await storage.getBotSettings()).instrucoes, 'Você atende uma pizzaria.');
});

test('blocked numbers are ignored and the block is shared by every bot number', async () => {
  const root = new MemoryStorage();
  const botA = setup({ storage: root.forBot('a') });
  const botB = setup({ storage: root.forBot('b') });

  await botA.from(`${OWNER}@s.whatsapp.net`, '/admin bloquear +55 (31) 77777-7777');
  await botB.from('5531777777777@s.whatsapp.net', 'oi');
  await botB.from('888@lid', 'oi', { remoteJidAlt: '5531777777777@s.whatsapp.net' });
  assert.equal(botB.prompts.length, 0);

  await botA.from(`${OWNER}@s.whatsapp.net`, '/admin desbloquear 5531777777777');
  await botB.from('5531777777777@s.whatsapp.net', 'oi de novo');
  assert.equal(botB.prompts.length, 1);
});

test('the allowlist recognizes contacts identified by LID', async () => {
  const { from, prompts, sent } = setup({ allowed: ['5531777777777'] });
  await from('888@lid', 'oi', { remoteJidAlt: '5531777777777@s.whatsapp.net' });
  await from('999@lid', 'oi');
  assert.equal(prompts.length, 1);
  assert.equal(sent.at(-1).text, 'Desculpe, você não está autorizado a usar este bot.');
});

test('in groups the bot only answers when mentioned or replied to, quoting the message', async () => {
  const { handler, sock, prompts, sent } = setup();
  const group = '1203630@g.us';
  const groupMessage = (id, message) => handler(sock, {
    key: { remoteJid: group, participant: '5531777777777@s.whatsapp.net', id },
    pushName: 'Ana',
    message
  });

  await groupMessage('1', { conversation: 'conversa normal do grupo' });
  await groupMessage('2', { extendedTextMessage: { text: '@5511000000000 qual a capital da França?', contextInfo: { mentionedJid: ['5511000000000@s.whatsapp.net'] } } });
  await groupMessage('3', { extendedTextMessage: { text: 'e da Itália?', contextInfo: { participant: '777000@lid' } } });

  assert.deepEqual(prompts.map(({ text }) => text), ['Ana: qual a capital da França?', 'Ana: e da Itália?']);
  assert.deepEqual(sent.map(({ jid, quoted }) => [jid, quoted]), [[group, true], [group, true]]);
  assert.equal(sent[0].text, '*ok*');
});

test('messages sent in quick succession get a single answer', async () => {
  const { from, prompts, sent } = setup({ handler: { debounceMs: 30 } });
  const jid = '5531777777777@s.whatsapp.net';

  await from(jid, 'oi');
  await from(jid, 'tudo bem?');
  await from(jid, 'queria saber o horário');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(prompts.map(({ text }) => text), ['oi\ntudo bem?\nqueria saber o horário']);
  assert.equal(sent.length, 1);
});

test('welcome message, per-number instructions and business hours', async () => {
  let now = new Date('2026-10-01T13:00:00Z').getTime(); // qui 10:00 em São Paulo
  const { from, prompts, sent, storage } = setup({ handler: { now: () => now } });
  await storage.updateBotSettings({
    boasVindas: 'Bem-vindo à Pizzaria!',
    instrucoes: 'Você atende uma pizzaria.',
    horario: 'seg-sex 09:00-18:00',
    foraDeHorario: 'Abrimos às 9h.'
  });
  const jid = '5531777777777@s.whatsapp.net';

  await from(jid, 'oi');
  await from(jid, 'tem calabresa?');
  assert.deepEqual(sent.map(({ text }) => text), ['Bem-vindo à Pizzaria!', '*ok*', '*ok*']);
  assert.equal(prompts[0].extraInstruction, 'Você atende uma pizzaria.');

  now = new Date('2026-10-01T23:00:00Z').getTime(); // 20:00
  await from(jid, 'ainda aberto?');
  await from(jid, 'alô?');
  await from(`${OWNER}@s.whatsapp.net`, 'dono fala a qualquer hora');
  assert.deepEqual(sent.slice(3).map(({ text }) => text), ['Abrimos às 9h.', '*ok*']);
  assert.equal(prompts.length, 3);
});

test('admin commands work in the bot phone "message yourself" chat, without answering anything else', async () => {
  const { handler, sock, sent, prompts } = setup({ handler: { ownerNumbers: [] } });
  const own = (remoteJid, text, id) => handler(sock, { key: { remoteJid, fromMe: true, id }, message: { conversation: text } });

  await own('5511000000000@s.whatsapp.net', '/admin status', '1');
  await own('777000@lid', '/admin config', '2');
  await own('5511000000000@s.whatsapp.net', '/admin status', '1');
  await own('5511000000000@s.whatsapp.net', 'anotação qualquer', '3');
  await own('5511000000000@s.whatsapp.net', 'Mensagens processadas: 0', '4');
  await own('5531777777777@s.whatsapp.net', '/admin status', '5');

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Mensagens processadas/);
  assert.match(sent[1].text, /Instruções/);
  assert.deepEqual(sent.map(({ jid }) => jid), ['5511000000000@s.whatsapp.net', '777000@lid']);
  assert.equal(prompts.length, 0);
});
