import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildAssistantPrompt } from '../src/assistant/profile.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const CREATOR = '5511915168336';
const STRANGER = '5531777777777';
const BOT = { id: '5511000000000:3@s.whatsapp.net', lid: '777000@lid' };

function setup(options = {}) {
  const sent = [];
  const prompts = [];
  const storage = options.storage || new MemoryStorage();
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async ({ text, assistant }) => { prompts.push({ text, assistant }); return 'ok'; } },
    allowlist: createAllowlist(options.allowed || []),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    ownerNumbers: [],
    creatorNumbers: [CREATOR],
    getStatus: () => ({ mongoConnected: false, bots: [{ numero: '5511000000000', conectado: true }] }),
    broadcastDelayMs: 0,
    notifyOwner: false,
    ...options.handler
  });
  const sock = {
    user: options.user || BOT,
    signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === '424242@lid' ? `${CREATOR}:0@s.whatsapp.net` : null) } },
    sendMessage: async (jid, content) => sent.push({ jid, text: content.text }),
    sendPresenceUpdate: async () => {}
  };
  const from = (jid, text, key = {}) => handler(sock, { key: { remoteJid: jid, ...key }, message: { conversation: text } });
  return { handler, sock, sent, prompts, storage, from };
}

test('the creator number is configured by default and can be changed or disabled', () => {
  assert.deepEqual(loadConfig({}).creatorNumbers, [CREATOR]);
  assert.deepEqual(loadConfig({ NUMERO_CRIADOR: '+55 (11) 98888-7777' }).creatorNumbers, ['5511988887777']);
  assert.deepEqual(loadConfig({ NUMERO_CRIADOR: '' }).creatorNumbers, []);
});

test('the assistant knows it is talking to its creator', () => {
  const prompt = buildAssistantPrompt({ ownerName: 'Paulo', withOwner: true, isCreator: true });
  assert.match(prompt, /CRIADOR/);
  assert.match(prompt, /\/criador ajuda/);
  assert.doesNotMatch(buildAssistantPrompt({ withOwner: true }), /CRIADOR/);
});

test('the creator is recognized by number or LID and also gets the owner commands', async () => {
  const { from, sent, prompts } = setup();

  await from(`${CREATOR}@s.whatsapp.net`, '/criador ping');
  assert.match(sent.at(-1).text, /Reconheço você, meu criador/);

  await from('424242@lid', '/criador sistema');
  assert.match(sent.at(-1).text, /🟢 5511000000000/);

  await from(`${CREATOR}@s.whatsapp.net`, '/admin status');
  assert.match(sent.at(-1).text, /Mensagens processadas/);

  await from(`${CREATOR}@s.whatsapp.net`, 'oi, sou eu');
  assert.equal(prompts.at(-1).assistant.isCreator, true);
  assert.equal(prompts.at(-1).assistant.withOwner, true);
});

test('nobody else can use /criador, it is plain text for them', async () => {
  const { from, sent, prompts } = setup();

  await from(`${STRANGER}@s.whatsapp.net`, '/criador falar 5511999999999 oi');
  assert.equal(prompts.at(-1).text, '/criador falar 5511999999999 oi');
  assert.equal(prompts.at(-1).assistant.isCreator, false);
  assert.equal(sent.some(({ jid }) => jid === '5511999999999@s.whatsapp.net'), false);
});

test('/criador is not available in groups', async () => {
  const { handler, sock, sent, prompts } = setup();
  await handler(sock, {
    key: { remoteJid: '1203630@g.us', participant: `${CREATOR}@s.whatsapp.net`, id: 'g1' },
    message: { extendedTextMessage: { text: '/criador ping', contextInfo: { mentionedJid: [BOT.id] } } }
  });
  assert.equal(sent.some(({ text }) => /Reconheço/.test(text)), false);
  assert.equal(prompts.length, 0);
});

test('creator commands: contacts, history, clear and talking through the bot', async () => {
  const { from, sent, storage } = setup({ handler: { debounceMs: 0 } });
  const creatorJid = `${CREATOR}@s.whatsapp.net`;
  const stranger = `${STRANGER}@s.whatsapp.net`;
  await storage.addMessage({ remoteJid: stranger, role: 'user', conteudo: 'oi, tudo bem?' });
  await storage.addMessage({ remoteJid: stranger, role: 'assistant', conteudo: 'Tudo certo, meu amigo.' });

  await from(creatorJid, '/criador contatos');
  assert.match(sent.at(-1).text, /1 contatos/);

  await from(creatorJid, `/criador historico +${STRANGER}`);
  assert.equal(sent.at(-1).text, 'Contato: oi, tudo bem?\nBot: Tudo certo, meu amigo.');

  await from(creatorJid, '/criador historico abc');
  assert.match(sent.at(-1).text, /Informe o número/);

  await from(creatorJid, '/criador falar 5511999999999 Olá, aqui é o bot!');
  assert.deepEqual(sent.at(-2), { jid: '5511999999999@s.whatsapp.net', text: 'Olá, aqui é o bot!' });
  assert.match(sent.at(-1).text, /Mensagem enviada para 5511999999999/);

  await from(creatorJid, '/criador falar 5511999999999');
  assert.match(sent.at(-1).text, /Use: \/criador falar/);

  await from(creatorJid, `/criador limpar ${STRANGER}`);
  assert.deepEqual(await storage.getHistory(stranger), []);

  await from(creatorJid, '/criador xyz');
  assert.match(sent.at(-1).text, /Comando de criador desconhecido/);
});

test('in the "Você" chat /criador works only when the creator is the phone owner', async () => {
  const mine = (sock, handler, id) => handler(sock, { key: { remoteJid: `${CREATOR}@s.whatsapp.net`, fromMe: true, id }, message: { conversation: '/criador ping' } });

  const creatorPhone = setup({ user: { id: `${CREATOR}:5@s.whatsapp.net`, lid: '555@lid' } });
  await mine(creatorPhone.sock, creatorPhone.handler, 'm1');
  assert.match(creatorPhone.sent.at(-1).text, /Reconheço você/);

  const otherPhone = setup();
  await otherPhone.handler(otherPhone.sock, {
    key: { remoteJid: `${BOT.id.split(/[:@]/)[0]}@s.whatsapp.net`, fromMe: true, id: 'm2' },
    message: { conversation: '/criador ping' }
  });
  assert.match(otherPhone.sent.at(-1).text, /Comando desconhecido/);
});

test('the creator is always greeted as "meu criador"', () => {
  assert.match(buildAssistantPrompt({ withOwner: true, isCreator: true }), /sempre o chame de "meu criador"/);
});

test('every answer gets a different way of speaking and avoids the recent openings', async () => {
  const { createGeminiService } = await import('../src/services/gemini.js');
  const { VARIATION_STYLES } = await import('../src/assistant/profile.js');
  const requests = [];
  const draws = [0, 0.99];
  const gemini = createGeminiService({
    model: 'm',
    random: () => draws.shift() ?? 0.5,
    ai: { models: { generateContent: async (request) => { requests.push(request); return { text: 'ok' }; } } }
  });
  const history = [
    { role: 'user', conteudo: 'oi' },
    { role: 'assistant', conteudo: 'Meu amigo, a família agradece o contato e já anota tudo.' }
  ];

  await gemini.generate({ text: 'oi', history });
  await gemini.generate({ text: 'oi', history });
  await gemini.generate({ text: 'oi', user: { persona: 'formal' } });

  const [first, second, formal] = requests.map((request) => request.config.systemInstruction);
  assert.ok(first.includes(VARIATION_STYLES[0]));
  assert.ok(second.includes(VARIATION_STYLES.at(-1)));
  assert.notEqual(first, second);
  assert.match(first, /começaram assim: "Meu amigo, a família agradece o"/);
  assert.doesNotMatch(formal, /o jeito de falar é/);
});

test('contacts get a real conversation in a mafia tone, not just "I will tell the boss"', () => {
  const prompt = buildAssistantPrompt({ ownerName: 'Paulo' });
  assert.match(prompt, /Conversar de verdade/);
  assert.match(prompt, /tom mafioso de filme/);
  assert.match(prompt, /não repita isso em toda resposta/);
  assert.match(prompt, /Nunca invente nada sobre Paulo/);
  assert.match(prompt, /nunca ameace/);
});

test('when a human answers a chat the assistant stops talking there, even in the default "on" mode', async () => {
  const jid = '5531777777777@s.whatsapp.net';
  const { handler, sock, from, prompts, sent } = setup({ handler: { creatorNumbers: [] } });
  const human = (remoteJid, id) => handler(sock, { key: { remoteJid, fromMe: true, id }, message: { conversation: 'Oi, sou eu mesmo' } });

  await from(jid, 'oi');
  assert.equal(prompts.length, 1);

  await human(jid, 'h1');
  await from(jid, 'e aí?');
  assert.equal(prompts.length, 1, 'depois que o humano respondeu, o bot se cala nessa conversa');

  await from('5531888888888@s.whatsapp.net', 'oi');
  assert.equal(prompts.length, 2, 'as outras conversas continuam sendo atendidas');
  assert.ok(sent.length >= 2);
});

test('messages waiting to be answered are dropped when the human replies first', async () => {
  const jid = '5531777777777@s.whatsapp.net';
  const { handler, sock, from, prompts } = setup({ handler: { creatorNumbers: [], debounceMs: 30 } });

  await from(jid, 'oi');
  await handler(sock, { key: { remoteJid: jid, fromMe: true, id: 'h2' }, message: { conversation: 'Já te respondo' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(prompts.length, 0);
});

test('an answer generated while the human was replying is not sent', async () => {
  const jid = '5531777777777@s.whatsapp.net';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const handler = createMessageHandler({
    config: {},
    storage: new MemoryStorage(),
    gemini: { generate: async () => { await gate; return 'resposta tardia'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {}, info() {} },
    creatorNumbers: [],
    notifyOwner: false
  });
  const sock = {
    user: BOT,
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
    sendMessage: async (to, content) => sent.push({ to, text: content.text }),
    sendPresenceUpdate: async () => {}
  };

  const pendingAnswer = handler(sock, { key: { remoteJid: jid }, message: { conversation: 'oi' } });
  await handler(sock, { key: { remoteJid: jid, fromMe: true, id: 'h3' }, message: { conversation: 'Eu respondo' } });
  release();
  await pendingAnswer;
  assert.deepEqual(sent, []);
});
