import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { createDashboardRouter } from '../src/routes/dashboard.js';

function createStats() {
  return {
    totalMessages: 0,
    lastMessageAt: null,
    users: new Set(),
    errorEvents: [],
    rateLimitEvents: [],
    recentMessages: []
  };
}

test('message handler saves user and assistant turns, and enforces allowlisting', async () => {
  const storage = new MemoryStorage();
  const stats = createStats();
  const replies = [];
  let generationCount = 0;
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async ({ text }) => { generationCount += 1; return `Resposta: ${text}`; } },
    allowlist: createAllowlist(['5511999999999']),
    rateLimiter: new RateLimiter(),
    stats,
    logger: { warn() {}, error() {}, debug() {} }
  });
  const sock = {
    sendMessage: async (jid, content) => replies.push({ jid, ...content }),
    sendPresenceUpdate: async () => {}
  };

  await handler(sock, {
    key: { remoteJid: '5511999999999@s.whatsapp.net' },
    message: { conversation: 'Olá' }
  });
  await handler(sock, {
    key: { remoteJid: '5511888888888@s.whatsapp.net' },
    message: { conversation: 'Olá' }
  });

  assert.equal(generationCount, 1);
  assert.deepEqual((await storage.getHistory('5511999999999@s.whatsapp.net')).map(({ role }) => role), ['user', 'assistant']);
  assert.equal(replies.length, 1, 'números fora da lista permitida não recebem resposta');
  assert.equal(stats.totalMessages, 1);
});

test('dashboard requires bearer authentication and reports live counters', async (t) => {
  const stats = createStats();
  stats.totalMessages = 3;
  const app = express();
  app.use(createDashboardRouter({
    config: { dashboardAuthToken: 'test-token', geminiModel: 'test-model' },
    stats,
    startedAt: Date.now() - 60_000,
    getConnectionStatus: () => ({ whatsappConnected: true, mongoConnected: false })
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const url = `http://127.0.0.1:${server.address().port}/dashboard`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + 'test-token' } });
  const dashboard = await response.json();
  assert.equal(dashboard.totalMensagensProcessadas, 3);
  assert.equal(dashboard.whatsappConnected, true);
  assert.equal(dashboard.geminiModel, 'test-model');
});

test('message handler skips stale and duplicated messages and warns about the rate limit only once', async () => {
  const replies = [];
  let generationCount = 0;
  const now = 1_800_000_000_000;
  const handler = createMessageHandler({
    config: {},
    storage: new MemoryStorage(),
    gemini: { generate: async () => { generationCount += 1; return 'ok'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter({ limit: 2, now: () => now }),
    stats: createStats(),
    logger: { warn() {}, error() {}, debug() {} },
    now: () => now
  });
  const sock = {
    sendMessage: async (jid, content) => replies.push(content.text),
    sendPresenceUpdate: async () => {}
  };
  const message = (id, secondsAgo) => ({
    key: { remoteJid: '5511999999999@s.whatsapp.net', id },
    messageTimestamp: { low: now / 1000 - secondsAgo, toNumber() { return now / 1000 - secondsAgo; } },
    message: { conversation: 'Olá' }
  });

  await handler(sock, message('antiga', 3600));
  await handler(sock, message('a', 5));
  await handler(sock, message('a', 5));
  for (const id of ['b', 'c', 'd', 'e']) await handler(sock, message(id, 1));

  assert.equal(generationCount, 2);
  assert.deepEqual(replies, ['ok', 'ok', 'Você está enviando muitas mensagens. Aguarde um pouco.']);
});
