import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSISTANT_NAME, buildAssistantPrompt } from '../src/assistant/profile.js';
import { createPresenceTracker } from '../src/services/presence.js';
import { createGeminiService, SYSTEM_INSTRUCTIONS } from '../src/services/gemini.js';
import { toolDeclarations } from '../src/handlers/tools.js';

test('the assistant is called Bot PH Zeus and speaks for the owner without inventing anything', () => {
  assert.equal(ASSISTANT_NAME, 'Bot PH Zeus');
  const prompt = buildAssistantPrompt({ ownerName: 'Paulo', firstContact: true, contactName: 'Ana' });
  assert.match(prompt, /Bot PH Zeus, assistente pessoal de Paulo/);
  assert.match(prompt, /primeira mensagem da conversa com Ana/);
  assert.match(prompt, /Nunca invente nada sobre Paulo/);
  assert.match(prompt, /código de verificação/);
  assert.doesNotMatch(buildAssistantPrompt({ ownerName: 'Paulo' }), /primeira mensagem/);
  assert.match(buildAssistantPrompt({ isGroup: true }), /grupo/);
  assert.match(buildAssistantPrompt({ ownerName: 'Paulo', withOwner: true }), /próprio dono/);
});

test('nothing from the tanning studio is left in the assistant', () => {
  const everything = JSON.stringify(toolDeclarations)
    + buildAssistantPrompt({ ownerName: 'Paulo', firstContact: true })
    + Object.values(SYSTEM_INSTRUCTIONS).join(' ');
  assert.doesNotMatch(everything, /bronze|estúdio|agendamento|agendar|protocolo|Rapha/i);
});

test('the Gemini system prompt carries the assistant rules, the date and the owner instructions', async () => {
  const requests = [];
  const gemini = createGeminiService({
    model: 'm',
    ownerName: 'Paulo',
    now: () => new Date('2026-10-02T15:00:00Z'),
    ai: { models: { generateContent: async (request) => { requests.push(request); return { text: 'ok' }; } } }
  });
  await gemini.generate({ text: 'oi', extraInstruction: 'Estou em reunião.', assistant: { firstContact: true } });
  const system = requests[0].config.systemInstruction;
  assert.match(system, /assistente pessoal de Paulo/);
  assert.match(system, /Data de hoje: sexta, 02\/10\/2026/);
  assert.match(system, /Estou em reunião\./);
});

test('presence: the owner counts as online while typing, and the assistant steps back from chats they answer', () => {
  let now = 1_000_000_000_000;
  const tracker = createPresenceTracker({ idleMinutes: 10, takeoverMinutes: 60, now: () => now });
  const chat = 'a@s.whatsapp.net';

  assert.equal(tracker.isAway({ chatJid: chat }), true, 'sem nenhuma atividade conhecida, está ausente');
  tracker.recordOwnerActivity('outra@s.whatsapp.net');
  assert.equal(tracker.isAway({ chatJid: chat }), false);
  now += 9 * 60_000;
  assert.equal(tracker.isAway({ chatJid: chat }), false);
  now += 2 * 60_000;
  assert.equal(tracker.isAway({ chatJid: chat }), true);

  tracker.recordOwnerActivity(chat);
  now += 30 * 60_000;
  assert.equal(tracker.isAway({ chatJid: chat }), false, 'o dono respondeu nessa conversa há pouco');
  assert.equal(tracker.isAway({ chatJid: 'b@s.whatsapp.net' }), true);
  now += 31 * 60_000;
  assert.equal(tracker.isAway({ chatJid: chat }), true);

  assert.equal(tracker.isAway({ mode: 'off', chatJid: chat }), false);
  tracker.recordOwnerActivity(chat);
  assert.equal(tracker.isAway({ mode: 'on', chatJid: chat }), true);
});

test('presence: an away schedule makes the assistant answer even with the owner online', () => {
  const now = new Date('2026-10-01T13:00:00Z').getTime(); // qui 10:00 em São Paulo
  const tracker = createPresenceTracker({ now: () => now });
  tracker.recordOwnerActivity('x@s.whatsapp.net');
  assert.equal(tracker.isAway({ schedule: 'seg-sex 09:00-18:00', chatJid: 'a@s.whatsapp.net' }), true);
  assert.equal(tracker.isAway({ schedule: 'sab 09:00-18:00', chatJid: 'a@s.whatsapp.net' }), false);
  assert.equal(tracker.isAway({ schedule: 'horário quebrado', chatJid: 'a@s.whatsapp.net' }), false);
});
