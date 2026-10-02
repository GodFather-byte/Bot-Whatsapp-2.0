import assert from 'node:assert/strict';
import test from 'node:test';
import { createAllowlist, normalizePhoneNumber } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

test('allowlist normalizes WhatsApp JIDs and stays permissive when unset', () => {
  assert.equal(normalizePhoneNumber('5511999999999@s.whatsapp.net'), '5511999999999');
  assert.equal(createAllowlist([]).isAllowed('5511999999999@s.whatsapp.net'), true);
  assert.equal(createAllowlist([], true).isAllowed('5511999999999@s.whatsapp.net'), false);
  const allowlist = createAllowlist(['5511999999999']);
  assert.equal(allowlist.isAllowed('5511999999999@s.whatsapp.net'), true);
  assert.equal(allowlist.isAllowed('5511888888888@s.whatsapp.net'), false);
});

test('rate limiter allows five messages, blocks the sixth, then resets by window', () => {
  let now = 10_000;
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, now: () => now });
  for (let index = 0; index < 5; index += 1) assert.equal(limiter.consume('user').allowed, true);
  assert.deepEqual(limiter.consume('user'), { allowed: false, firstBlock: true, remaining: 0, resetTime: 70_000 });
  assert.equal(limiter.consume('user').firstBlock, false);
  now += 60_000;
  assert.equal(limiter.consume('user').allowed, true);
});
