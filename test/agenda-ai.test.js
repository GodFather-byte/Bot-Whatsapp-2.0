import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool, toolDeclarations } from '../src/handlers/tools.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { createAgendaService } from '../src/services/agenda.js';
import { createGeminiService } from '../src/services/gemini.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-10-01T13:00:00Z'); // quinta-feira, 01/10/2026, 10:00 em São Paulo
const MARIA = '5511911111111@s.whatsapp.net';
const ANA = '5511922222222@s.whatsapp.net';
const maria = { jid: MARIA, name: 'Maria do WhatsApp', number: '5511911111111' };
const ana = { jid: ANA, name: 'Ana', number: '5511922222222' };

async function setup() {
  const storage = new MemoryStorage();
  await storage.updateBotSettings({ agendaHorario: 'seg-sex 09:00-12:00; sab 09:00-11:00' });
  const agenda = createAgendaService({ storage, timeZone: TZ, now: () => NOW });
  return { storage, agenda };
}

test('the new agenda tools are declared with the arguments the model must fill in', () => {
  const byName = Object.fromEntries(toolDeclarations.map((tool) => [tool.name, tool]));
  for (const name of ['consultar_horarios_livres', 'agendar_horario', 'meus_agendamentos', 'cancelar_agendamento', 'remarcar_agendamento']) {
    assert.ok(byName[name], `${name} não declarada`);
  }
  assert.deepEqual(byName.agendar_horario.parameters.required, ['data', 'hora', 'protocolo', 'duracao_minutos', 'nome']);
  assert.deepEqual(byName.remarcar_agendamento.parameters.required, ['codigo', 'data', 'hora']);
  assert.equal(byName.agendar_horario.parameters.properties.duracao_minutos.type, 'INTEGER');
  for (const tool of toolDeclarations) {
    for (const required of tool.parameters?.required || []) {
      assert.ok(tool.parameters.properties[required], `${tool.name}: "${required}" obrigatório mas não descrito`);
    }
  }
});

test('tools check availability, book, list, move and cancel for the client of the conversation', async () => {
  const { agenda } = await setup();
  const run = (name, args, client = maria) => executeTool(name, args, { agenda, client });

  const day = await run('consultar_horarios_livres', { data: '2026-10-03' });
  assert.deepEqual(day.horarios, ['09:00', '09:30', '10:00', '10:30']);
  assert.equal((await run('consultar_horarios_livres', {})).dias[0].data, '2026-10-01');

  const booked = await run('agendar_horario', { data: '2026-10-03', hora: '10:00', protocolo: 'Prata', duracao_minutos: 30, nome: '  Maria  Silva ' });
  assert.equal(booked.ok, true);
  assert.equal(booked.agendamento.nome, 'Maria Silva');
  assert.equal(booked.agendamento.valor, 'R$ 100,00');
  const code = booked.agendamento.codigo;

  assert.deepEqual((await run('meus_agendamentos', {})).agendamentos.map(({ codigo }) => codigo), [code]);
  assert.deepEqual((await run('meus_agendamentos', {}, ana)).agendamentos, []);

  // A cliente Ana não consegue mexer no agendamento da Maria, mesmo sabendo o código.
  assert.equal((await run('cancelar_agendamento', { codigo: code }, ana)).ok, false);
  assert.equal((await run('remarcar_agendamento', { codigo: code, data: '2026-10-02', hora: '09:00' }, ana)).ok, false);

  const moved = await run('remarcar_agendamento', { codigo: code, data: '2026-10-02', hora: '09:00' });
  assert.equal(moved.ok, true);
  assert.equal(moved.agendamento.quando, 'sexta-feira, 02/10 às 09:00');
  assert.equal((await run('cancelar_agendamento', { codigo: moved.agendamento.codigo })).ok, true);
  assert.deepEqual((await run('meus_agendamentos', {})).agendamentos, []);
});

test('the client name falls back to the WhatsApp name when the model sends none', async () => {
  const { agenda, storage } = await setup();
  const result = await executeTool('agendar_horario', { data: '2026-10-03', hora: '09:00', protocolo: 'Bronze', duracao_minutos: 20, nome: '   ' }, { agenda, client: maria });
  assert.equal(result.ok, true);
  assert.equal((await storage.getAppointment(result.agendamento.codigo)).clienteNome, 'Maria do WhatsApp');
  assert.equal((await storage.getAppointment(result.agendamento.codigo)).clienteNumero, '5511911111111');
});

test('without an agenda or a client (groups, not configured) the tools send the customer to the owner', async () => {
  const { agenda } = await setup();
  for (const context of [{}, { agenda }, { client: maria }]) {
    for (const name of ['agendar_horario', 'meus_agendamentos', 'cancelar_agendamento', 'remarcar_agendamento']) {
      const result = await executeTool(name, { codigo: 'AAAAA', data: '2026-10-03', hora: '09:00', protocolo: 'Bronze', duracao_minutos: 20, nome: 'X' }, context);
      assert.equal(result.indisponivel, true, `${name} ${JSON.stringify(Object.keys(context))}`);
      assert.match(result.orientacao, /\(11\) 94578-8032/);
    }
  }
  assert.equal((await executeTool('consultar_horarios_livres', {}, {})).indisponivel, true);
});

test('Gemini can complete a booking through a function call, and knows today and the opening hours', async () => {
  const { agenda, storage } = await setup();
  const prompts = [];
  let calls = 0;
  const bookingCall = { name: 'agendar_horario', args: { data: '2026-10-03', hora: '10:00', protocolo: 'Prata', duracao_minutos: 30, nome: 'Maria' } };
  const gemini = createGeminiService({
    model: 'test-model',
    timeZone: TZ,
    now: () => NOW,
    ai: {
      models: {
        generateContent: async (request) => {
          calls += 1;
          prompts.push(request.config.systemInstruction);
          if (calls === 1) {
            return { functionCalls: [bookingCall], candidates: [{ content: { parts: [{ functionCall: bookingCall }] } }] };
          }
          const { result } = request.contents.at(-1).parts[0].functionResponse.response;
          return { text: `Agendado! Código ${result.agendamento.codigo}` };
        }
      }
    }
  });

  const answer = await gemini.generate({
    text: 'Quero agendar sábado às 10h',
    openingHours: 'segunda a sexta, das 09:00 às 12:00; sábado, das 09:00 às 11:00',
    toolContext: { agenda, client: maria }
  });

  const [stored] = await storage.listClientAppointments(MARIA, { from: NOW });
  assert.equal(answer, `Agendado! Código ${stored.id}`);
  assert.equal(stored.protocolo, 'Protocolo Prata');
  assert.equal(stored.inicio.toISOString(), '2026-10-03T13:00:00.000Z');
  assert.match(prompts[0], /Data de hoje: quinta-feira, 01\/10\/2026 \(2026-10-01\), fuso America\/Sao_Paulo/);
  assert.match(prompts[0], /Horário de funcionamento: segunda a sexta, das 09:00 às 12:00; sábado, das 09:00 às 11:00\./);
  assert.ok(!prompts[0].includes('Horário de funcionamento: não informado'));
});

test('the system prompt keeps saying the opening hours are unknown until the owner configures them', async () => {
  let instruction;
  const gemini = createGeminiService({
    model: 'test-model',
    ai: { models: { generateContent: async ({ config }) => { instruction = config.systemInstruction; return { text: 'ok' }; } } }
  });
  await gemini.generate({ text: 'Que horas vocês abrem?' });
  assert.match(instruction, /Horário de funcionamento: não informado\./);
  assert.match(instruction, /Data de hoje: /);
});

function handlerSetup(agenda) {
  const calls = [];
  const sent = [];
  const handler = createMessageHandler({
    config: {},
    storage: new MemoryStorage(),
    gemini: { generate: async (request) => { calls.push(request); return 'Claro!'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    agenda
  });
  const sock = {
    user: { id: '5511991361386:3@s.whatsapp.net', lid: '999000@lid' },
    sendMessage: async (jid, content) => sent.push({ jid, text: content.text }),
    sendPresenceUpdate: async () => {}
  };
  return { handler, sock, calls, sent };
}

test('private chats hand the agenda and the client identity to the AI; groups do not', async () => {
  const { agenda } = await setup();
  const { handler, sock, calls } = handlerSetup(agenda);

  await handler(sock, { key: { remoteJid: MARIA }, pushName: 'Maria', message: { conversation: 'Quero agendar' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolContext.agenda, agenda);
  assert.deepEqual(calls[0].toolContext.client, { jid: MARIA, name: 'Maria', number: '5511911111111' });

  // Sem o nome do WhatsApp (pushName), o nome fica em branco e a IA pergunta.
  await handler(sock, { key: { remoteJid: ANA }, message: { conversation: 'Oi' } });
  assert.equal(calls[1].toolContext.client.name, undefined);
  assert.equal(calls[1].toolContext.client.number, '5511922222222');

  await handler(sock, {
    key: { remoteJid: '12345@g.us', participant: ANA },
    pushName: 'Ana',
    message: { extendedTextMessage: { text: '@bot quero agendar', contextInfo: { mentionedJid: ['5511991361386@s.whatsapp.net'] } } }
  });
  assert.equal(calls.length, 3, 'o bot respondeu ao grupo');
  assert.equal(calls[2].toolContext, undefined, 'mas sem acesso à agenda');
});

test('the opening hours configured for the agenda reach the AI in plain Portuguese', async () => {
  const { agenda } = await setup();
  const calls = [];
  const storage = new MemoryStorage();
  await storage.updateBotSettings({ agendaHorario: 'seg-sex 09:00-19:00; sab 09:00-14:00' });
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async (request) => { calls.push(request); return 'ok'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    agenda
  });
  const sock = { user: { id: '5511991361386:3@s.whatsapp.net' }, sendMessage: async () => {}, sendPresenceUpdate: async () => {} };
  await handler(sock, { key: { remoteJid: MARIA }, message: { conversation: 'Que horas vocês abrem?' } });
  assert.equal(calls[0].openingHours, 'segunda a sexta, das 09:00 às 19:00; sábado, das 09:00 às 14:00');
});

test('Gemini can recover from a failed booking attempt within the tool-call limit', async () => {
  const { agenda, storage } = await setup();
  const steps = [
    { name: 'consultar_horarios_livres', args: { data: '2026-10-03' } },
    { name: 'agendar_horario', args: { data: '2026-10-03', hora: '15:00', protocolo: 'Prata', duracao_minutos: 30, nome: 'Maria' } }, // fora do horário: erro
    { name: 'consultar_horarios_livres', args: { data: '2026-10-03' } },
    { name: 'agendar_horario', args: { data: '2026-10-03', hora: '10:30', protocolo: 'Prata', duracao_minutos: 30, nome: 'Maria' } }
  ];
  const results = [];
  let requests = 0;
  const gemini = createGeminiService({
    model: 'test-model',
    ai: {
      models: {
        generateContent: async (request) => {
          if (requests > 0) results.push(request.contents.at(-1).parts[0].functionResponse.response.result);
          const step = steps[requests];
          requests += 1;
          return step
            ? { functionCalls: [step], candidates: [{ content: { parts: [{ functionCall: step }] } }] }
            : { text: 'Pronto, agendei às 10:30!' };
        }
      }
    }
  });

  assert.equal(await gemini.generate({ text: 'Quero sábado às 15h', toolContext: { agenda, client: maria } }), 'Pronto, agendei às 10:30!');
  assert.equal(requests, 5);
  assert.equal(results[1].ok, false, 'a primeira tentativa falhou');
  assert.deepEqual(results[1].horariosLivres, ['09:00', '09:30', '10:00', '10:30']);
  assert.equal(results[3].ok, true);
  assert.equal((await storage.listClientAppointments(MARIA, { from: NOW })).length, 1);
});

test('Gemini gives up on endless tool loops instead of spinning forever', async () => {
  let requests = 0;
  const call = { name: 'consultar_horarios_livres', args: {} };
  const gemini = createGeminiService({
    model: 'test-model',
    ai: { models: { generateContent: async () => { requests += 1; return { functionCalls: [call], candidates: [{ content: { parts: [{ functionCall: call }] } }] }; } } }
  });
  await assert.rejects(gemini.generate({ text: 'oi' }), /excedeu o limite de chamadas de ferramentas/);
  assert.equal(requests, 6);
});
