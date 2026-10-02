import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageTracker, quotaDay } from '../src/services/usage.js';
import { createGeminiService } from '../src/services/gemini.js';
import { MemoryStorage } from '../src/services/storage.js';

const logger = { warn() {} };

test('quota days follow Pacific time, when the Gemini daily quota resets', () => {
  assert.equal(quotaDay(new Date('2026-10-02T06:59:00Z')), '2026-10-01');
  assert.equal(quotaDay(new Date('2026-10-02T07:00:00Z')), '2026-10-02');
});

test('Gemini calls report their token usage and rate limit errors', async () => {
  const events = [];
  let calls = 0;
  const ai = {
    models: {
      generateContent: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429, details: [{ '@type': 'RetryInfo', retryDelay: '0s' }] });
        return { text: 'oi', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
      },
      generateContentStream: async () => (async function* () {
        yield { text: 'o' };
        yield { text: 'i', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 3 } };
      })()
    }
  };
  const gemini = createGeminiService({ ai, model: 'modelo-x', onUsage: (event) => events.push(event) });

  await gemini.generate({ text: 'oi' });
  await gemini.stream({ text: 'oi' });

  assert.deepEqual(events, [
    { model: 'modelo-x', rateLimited: true },
    { model: 'modelo-x', usage: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    { model: 'modelo-x', usage: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }
  ]);
});

test('the usage report sums today, the last 7 days and the month', async () => {
  const storage = new MemoryStorage();
  let now = new Date('2026-09-28T15:00:00Z');
  const usage = createUsageTracker({ storage, logger, now: () => now });

  usage.record({ model: 'gemini-3.5-flash-lite', usage: { promptTokenCount: 1000, candidatesTokenCount: 200 } });
  now = new Date('2026-10-01T15:00:00Z');
  usage.record({ model: 'gemini-3.5-flash-lite', usage: { promptTokenCount: 1500, candidatesTokenCount: 300, thoughtsTokenCount: 100 } });
  usage.record({ model: 'gemini-3.5-flash', usage: { promptTokenCount: 500, candidatesTokenCount: 100 } });
  usage.record({ model: 'gemini-3.5-flash', rateLimited: true });
  await new Promise((resolve) => setImmediate(resolve));

  const report = await usage.report({ dailyLimit: 20, timeZone: 'America/Sao_Paulo' });
  assert.match(report, /\*Hoje:\* 2 chamadas — 2\.500 tokens\n  \(entrada 2\.000, saída 500\)\n  Erros de limite \(429\): 1/);
  assert.match(report, /Limite diário: 2 de 20 \(10%\)/);
  assert.match(report, /gemini-3\.5-flash-lite: 1\n  gemini-3\.5-flash: 1/);
  assert.match(report, /\*Últimos 7 dias:\* 3 chamadas — 3\.700 tokens/);
  assert.match(report, /\*Este mês:\* 2 chamadas/);
  assert.match(report, /zera em 02\/10\/2026, 04:00/);
});
