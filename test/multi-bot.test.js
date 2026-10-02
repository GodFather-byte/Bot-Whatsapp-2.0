import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { MongoStorage } from '../src/services/storage.js';
import { useMongoDBAuthState } from '../mongoAuthState.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const mongoUri = process.env.MONGODB_TEST_URI;
const skipMongo = mongoUri ? false : 'defina MONGODB_TEST_URI para testar com MongoDB';

test('configuration lists one bot per number and keeps the legacy single-bot mode', () => {
  assert.deepEqual(loadConfig({ NUMEROS_BOT: '+55 11 99999-9999, 5521888888888,5511999999999' }).bots, [
    { id: '5511999999999', number: '5511999999999' },
    { id: '5521888888888', number: '5521888888888' }
  ]);
  assert.deepEqual(loadConfig({ NUMERO_BOT: '5511999999999' }).bots, [{ id: '5511999999999', number: '5511999999999' }]);
  assert.deepEqual(loadConfig({}).bots, [{ id: 'principal', number: '' }]);
});

test('bots never answer each other', async () => {
  let generations = 0;
  const identities = new Set(['5511999999999', '5521888888888']);
  const handler = createMessageHandler({
    config: {},
    storage: new MemoryStorage(),
    gemini: { generate: async () => { generations += 1; return 'ok'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    ignoredNumbers: identities
  });
  const sock = { sendMessage: async () => {}, sendPresenceUpdate: async () => {} };
  const send = (key) => handler(sock, { key, message: { conversation: 'Oi' } });

  await send({ remoteJid: '5521888888888@s.whatsapp.net' });
  await send({ remoteJid: '111111111111111@lid', remoteJidAlt: '5521888888888@s.whatsapp.net' });
  await send({ remoteJid: '222222222222222@lid' });
  identities.add('222222222222222');
  await send({ remoteJid: '222222222222222@lid' });
  await send({ remoteJid: '5531777777777@s.whatsapp.net' });

  assert.equal(generations, 2);
});

test('each bot number keeps its own history, preferences and reminders in MongoDB', { skip: skipMongo }, async (t) => {
  const client = await new MongoClient(mongoUri).connect();
  const dbName = `teste-${randomUUID()}`;
  t.after(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });
  const contact = '5531777777777@s.whatsapp.net';
  await client.db(dbName).collection('conversas').insertOne({ remoteJid: contact, role: 'user', conteudo: 'antiga', timestamp: new Date(0) });

  const root = new MongoStorage(client, dbName);
  await root.adoptUntaggedData('5511999999999');
  const botA = root.forBot('5511999999999');
  const botB = root.forBot('5521888888888');

  await botA.addMessage({ remoteJid: contact, role: 'user', conteudo: 'para A' });
  await botB.addMessage({ remoteJid: contact, role: 'user', conteudo: 'para B' });
  await botA.updateUser(contact, { persona: 'formal' });
  await botB.createReminder({ usuarioId: contact, mensagem: 'lembrete B', agendadoPara: new Date(0) });

  assert.deepEqual((await root.forBot('5511999999999').getHistory(contact)).map(({ conteudo }) => conteudo), ['antiga', 'para A']);
  assert.deepEqual((await root.forBot('5521888888888').getHistory(contact)).map(({ conteudo }) => conteudo), ['para B']);
  assert.equal((await root.forBot('5511999999999').getUser(contact)).persona, 'formal');
  assert.equal((await root.forBot('5521888888888').getUser(contact)).persona, undefined);
  assert.deepEqual((await root.forBot('5511999999999').getDueReminders()), []);
  assert.deepEqual((await root.forBot('5521888888888').getDueReminders()).map(({ mensagem }) => mensagem), ['lembrete B']);

  await botA.close();
  assert.equal((await client.db(dbName).collection('conversas').countDocuments()), 3);
});

test('the existing WhatsApp session moves to the number it belongs to', { skip: skipMongo }, async (t) => {
  const client = await new MongoClient(mongoUri).connect();
  const dbName = `teste-${randomUUID()}`;
  const opened = [];
  t.after(async () => {
    await Promise.all(opened.map((auth) => auth.close()));
    await client.db(dbName).dropDatabase();
    await client.close();
  });
  const database = client.db(dbName);
  await database.collection('auth_state').insertMany([
    { _id: 'creds', value: JSON.stringify({ me: { id: '5511999999999:7@s.whatsapp.net' } }) },
    { _id: 'pre-key-1', value: '"chave"' }
  ]);

  const other = await useMongoDBAuthState(mongoUri, dbName, 'auth_state_5521888888888', {
    migrateFrom: 'auth_state',
    phoneNumber: '5521888888888'
  });
  opened.push(other);
  assert.equal(other.state.creds.me, undefined);
  assert.equal(await database.collection('auth_state').countDocuments(), 2);

  const owner = await useMongoDBAuthState(mongoUri, dbName, 'auth_state_5511999999999', {
    migrateFrom: 'auth_state',
    phoneNumber: '5511999999999'
  });
  opened.push(owner);
  assert.equal(owner.state.creds.me.id, '5511999999999:7@s.whatsapp.net');
  assert.equal(await database.collection('auth_state').countDocuments(), 0);
  assert.equal(await database.collection('auth_state_5511999999999').countDocuments(), 2);
});

test('owner settings, blocks, contacts and stats are stored in MongoDB', { skip: skipMongo }, async (t) => {
  const client = await new MongoClient(mongoUri).connect();
  const dbName = `teste-${randomUUID()}`;
  t.after(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });
  const root = new MongoStorage(client, dbName);
  const botA = root.forBot('5511999999999');
  const botB = root.forBot('5521888888888');

  await botA.updateBotSettings({ instrucoes: 'pizzaria', horario: 'seg-sex 09:00-18:00' });
  await botA.updateBotSettings({ horario: null });
  assert.deepEqual(await root.forBot('5511999999999').getBotSettings(), { instrucoes: 'pizzaria' });
  assert.deepEqual(await botB.getBotSettings(), {});

  await botA.blockNumber('5531777777777');
  assert.equal(await root.forBot('5521888888888').isBlocked(['5531777777777']), true);
  assert.equal(await botB.unblockNumber('5531777777777'), true);
  assert.deepEqual(await botA.listBlocked(), []);

  await botA.addMessage({ remoteJid: 'a@s.whatsapp.net', role: 'user', conteudo: 'oi' });
  await botA.addMessage({ remoteJid: 'grupo@g.us', role: 'user', conteudo: 'oi' });
  await botB.addMessage({ remoteJid: 'b@s.whatsapp.net', role: 'user', conteudo: 'oi' });
  assert.deepEqual(await root.forBot('5511999999999').listContacts(), ['a@s.whatsapp.net']);

  const reminder = await botA.createReminder({ usuarioId: 'a@s.whatsapp.net', mensagem: 'x', agendadoPara: new Date(0) });
  await root.forBot('5511999999999').rescheduleReminder(reminder.id, new Date('2030-01-01T00:00:00Z'));
  assert.deepEqual(await root.forBot('5511999999999').getDueReminders(), []);

  await root.saveStats({ totalMessages: 7, users: ['5531777777777'] });
  const saved = await root.loadStats();
  assert.equal(saved.totalMessages, 7);
  assert.deepEqual(saved.users, ['5531777777777']);
});

test('Gemini usage is accumulated per quota day in MongoDB', { skip: skipMongo }, async (t) => {
  const client = await new MongoClient(mongoUri).connect();
  const dbName = `teste-${randomUUID()}`;
  t.after(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });
  const storage = new MongoStorage(client, dbName);
  await storage.incrementUsage('2026-10-01', { requests: 1, promptTokens: 10, 'modelos.gemini-3_5-flash': 1 });
  await storage.incrementUsage('2026-10-01', { requests: 1, promptTokens: 5, 'modelos.gemini-3_5-flash': 1 });
  assert.deepEqual(await storage.getUsage(['2026-10-01', '2026-09-30']), {
    '2026-10-01': { requests: 2, promptTokens: 15, modelos: { 'gemini-3_5-flash': 2 } }
  });
});
