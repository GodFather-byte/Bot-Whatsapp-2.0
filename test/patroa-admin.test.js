import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { resolvePatroa } from '../src/assistant/extras.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const CREATOR = '5511915168336';
const OWNER = '5511900000000';
const PATROA = '558699028292';
const STRANGER = '5531777777777';
const BOT = { id: '5511000000000:3@s.whatsapp.net', lid: '777000@lid' };
const HOUR = 3_600_000;

function setup(options = {}) {
  const sent = [];
  const prompts = [];
  const storage = options.storage || new MemoryStorage();
  let model = 'gemini-teste';
  const gemini = {
    generate: async ({ text, assistant }) => { prompts.push({ text, assistant }); return 'ok'; },
    getModel: () => model,
    setModel: (name) => { model = name; }
  };
  let now = options.now ?? new Date('2026-10-01T13:00:00Z').getTime();
  const handler = createMessageHandler({
    config: { patroa: { number: PATROA, name: 'Paulina' }, ...options.config },
    storage,
    gemini,
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    ownerNumbers: [OWNER],
    creatorNumbers: [CREATOR],
    getStatus: () => ({ mongoConnected: false, bots: [] }),
    broadcastDelayMs: 0,
    notifyOwner: false,
    now: () => now,
    ...options.handler
  });
  const sock = {
    user: BOT,
    sendMessage: async (jid, content) => sent.push({ jid, text: content.text }),
    sendPresenceUpdate: async () => {}
  };
  const from = (number, text) => handler(sock, { key: { remoteJid: `${number}@s.whatsapp.net` }, message: { conversation: text } });
  return { handler, sock, sent, prompts, storage, from, gemini, advance: (ms) => { now += ms; } };
}

test('the patroa is never answered, not even on her first message, and nobody else is affected', async () => {
  const { sent, prompts, from, advance } = setup();

  await from(PATROA, 'oi, o PH está?');
  await from(PATROA, 'e então?');
  assert.equal(sent.length, 0, 'nenhuma resposta, nem para a primeira mensagem');
  assert.equal(prompts.length, 0, 'a mensagem nem chega à IA');

  advance(24 * HOUR);
  await from(PATROA, 'um dia depois');
  assert.equal(sent.length, 0, 'e o silêncio não expira');

  await from(STRANGER, 'oi');
  assert.equal(sent.length, 1, 'os outros contatos seguem sendo atendidos');
  assert.equal(prompts.length, 1);
});

test('the patroa is ignored when she sends a burst or is identified by LID', async () => {
  const { sent, prompts, from, handler, sock } = setup({ handler: { debounceMs: 20 } });
  await from(PATROA, 'oi');
  await from(PATROA, 'tudo bem?');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sent.length, 0);
  assert.equal(prompts.length, 0);

  // O WhatsApp pode identificá-la pelo LID, com o número só no campo alternativo.
  await handler(sock, { key: { remoteJid: '987@lid', remoteJidAlt: `${PATROA}@s.whatsapp.net`, id: 'lid1' }, message: { conversation: 'oi pelo lid' } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sent.length, 0);
  assert.equal(prompts.length, 0);
});

test('the patroa comes from the environment and can be set and removed by the creator', async () => {
  const env = loadConfig({ NUMERO_PATROA: '+55 86 99028-292', NOME_PATROA: 'Paulina' });
  assert.deepEqual(env.patroa, { number: '558699028292', name: 'Paulina' });
  assert.equal(loadConfig({}).patroa, null);
  assert.equal(resolvePatroa(null, null), null);

  const { sent, prompts, from } = setup({ config: { patroa: null } });
  await from(PATROA, 'oi');
  assert.equal(prompts.length, 1, 'sem configuração ela é contato comum');

  await from(CREATOR, '/criador patroa 558699028292 Paulina');
  assert.match(sent.at(-1).text, /Patroa definida: Paulina \(558699028292\).*não responde mais a ela, de jeito nenhum/s);
  await from(CREATOR, '/criador patroa');
  assert.match(sent.at(-1).text, /Paulina.*nunca responde a ela/s);
  const count = sent.length;
  await from(PATROA, 'oi de novo');
  await from(PATROA, 'alô?');
  assert.equal(sent.length, count, 'depois de definida, nunca mais é respondida');
  assert.equal(prompts.length, 1);

  await from(CREATOR, '/criador patroa abc');
  assert.match(sent.at(-1).text, /Use: \/criador patroa/);
  await from(CREATOR, '/criador patroa remover');
  assert.match(sent.at(-1).text, /Patroa removida/);
  await from(PATROA, 'sou eu');
  assert.equal(prompts.length, 2, 'removida, volta a ser contato comum');
});

test('the patroa is left out of mass notices', async () => {
  const { sent, from, storage } = setup({ handler: { broadcastDelayMs: 0 } });
  await storage.addMessage({ remoteJid: `${PATROA}@s.whatsapp.net`, role: 'user', conteudo: 'oi antigo' });
  await from(STRANGER, 'oi');
  await from(OWNER, '/admin aviso Reunião amanhã');
  assert.match(sent.at(-1).text, /Enviando o aviso para 1 contatos/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const notices = sent.filter(({ text }) => text === 'Reunião amanhã');
  assert.deepEqual(notices.map(({ jid }) => jid), [`${STRANGER}@s.whatsapp.net`]);
});

test('only the creator can set the patroa, and the creator is not answered in plain text', async () => {
  const { sent, prompts, from, storage } = setup({ config: { patroa: null } });
  await from(STRANGER, '/criador patroa 5511999999999 Fulana');
  await from(OWNER, '/criador patroa 5511999999999 Fulana');
  assert.equal((await storage.getBotSettings()).patroa, undefined);

  const before = sent.length;
  await from(CREATOR, 'oi, tudo bem?');
  assert.equal(sent.length, before, 'texto comum do criador não recebe resposta');
  assert.ok(prompts.every(({ text }) => text !== 'oi, tudo bem?'));
});

test('new creator commands: config, ligar, desligar and modelo', async () => {
  const { sent, from, storage, gemini } = setup();
  await from(CREATOR, '/criador vip 5511999999999 prima do chefe');
  await from(CREATOR, '/criador tom bem calado');
  await from(CREATOR, '/criador config');
  const panel = sent.at(-1).text;
  assert.match(panel, /Painel do criador/);
  assert.match(panel, /Modo: on/);
  assert.match(panel, /Modelo do Gemini: gemini-teste/);
  assert.match(panel, /Patroa \(nunca respondida\): Paulina \(558699028292\)/);
  assert.match(panel, /5511999999999 \(prima do chefe\)/);
  assert.match(panel, /Tom extra: bem calado/);

  await from(CREATOR, '/criador desligar');
  assert.equal((await storage.getBotSettings()).ausencia, 'off');
  const count = sent.length;
  await from(STRANGER, 'oi');
  assert.equal(sent.length, count, 'desligado, ninguém é respondido');
  await from(CREATOR, '/criador ligar');
  assert.equal((await storage.getBotSettings()).ausencia, 'on');
  await from(STRANGER, 'oi');
  assert.equal(sent.at(-1).text, 'ok');

  await from(CREATOR, '/criador modelo');
  assert.match(sent.at(-1).text, /Modelo atual: gemini-teste/);
  await from(CREATOR, '/criador modelo gemini-2.5-flash');
  assert.equal(gemini.getModel(), 'gemini-2.5-flash');
  assert.match(sent.at(-1).text, /gemini-teste → gemini-2.5-flash/);
  await from(CREATOR, '/criador modelo nome inválido!');
  assert.match(sent.at(-1).text, /Nome de modelo inválido/);
  assert.equal(gemini.getModel(), 'gemini-2.5-flash');
});

test('stronger owner commands: conversas, ver, resumo, responder, pausar, retomar and limpar', async () => {
  const { sent, prompts, from, storage, advance } = setup({ config: { patroa: null } });
  await from(STRANGER, 'quero falar com o PH sobre o carro');
  advance(60_000);
  await from('5531888888888', 'oi, tudo bem?');

  // O histórico em memória usa o relógio real; fixa um horário explícito para a ordem não depender de milissegundos.
  await storage.addMessage({ remoteJid: '5531888888888@s.whatsapp.net', role: 'user', conteudo: 'mensagem mais nova', timestamp: new Date(Date.now() + 60_000) });

  await from(OWNER, '/admin conversas');
  const list = sent.at(-1).text;
  assert.match(list, /Últimas 2 conversas\* \(de 2 contatos\)/);
  assert.ok(list.indexOf('5531888888888') < list.indexOf(STRANGER), 'a mais recente vem primeiro');
  assert.match(list, /Contato: mensagem mais nova/);

  await from(OWNER, `/admin ver ${STRANGER}`);
  assert.match(sent.at(-1).text, /Contato: quero falar com o PH sobre o carro\nAssistente: ok/);
  await from(OWNER, '/admin ver abc');
  assert.match(sent.at(-1).text, /Use: \/admin ver/);

  await from(OWNER, `/admin resumo ${STRANGER}`);
  assert.match(prompts.at(-1).text, /Resuma em até 5 linhas[\s\S]*quero falar com o PH sobre o carro/);
  assert.equal(sent.at(-1).text, 'ok');

  await from(OWNER, `/admin responder ${STRANGER} Ele retorna amanhã.`);
  assert.deepEqual(sent.at(-2), { jid: `${STRANGER}@s.whatsapp.net`, text: 'Ele retorna amanhã.' });
  assert.match(sent.at(-1).text, /Mensagem enviada para 5531777777777/);

  await from(OWNER, '/admin pausar 30 min');
  assert.match(sent.at(-1).text, /Assistente em silêncio com todos os contatos até/);
  const count = prompts.length;
  await from(STRANGER, 'alô?');
  assert.equal(prompts.length, count, 'em pausa não responde');
  await from(OWNER, '/admin retomar');
  assert.match(sent.at(-1).text, /Silêncio encerrado/);
  await from(STRANGER, 'alô?');
  assert.equal(prompts.length, count + 1);

  await from(OWNER, `/admin pausar ${STRANGER} 1 hora`);
  assert.match(sent.at(-1).text, /na conversa com 5531777777777/);
  await from('5531888888888', 'e eu?');
  assert.equal(prompts.length, count + 2, 'só a conversa pausada fica em silêncio');
  await from(OWNER, '/admin pausar banana');
  assert.match(sent.at(-1).text, /Use: \/admin pausar/);

  await from(OWNER, `/admin limpar ${STRANGER}`);
  assert.equal((await storage.getHistory(`${STRANGER}@s.whatsapp.net`)).length, 0);
  await from(OWNER, '/admin ajuda');
  assert.match(sent.at(-1).text, /\/admin conversas[\s\S]*\/admin resumo[\s\S]*\/admin responder[\s\S]*\/admin pausar/);
});

test('contacts cannot use the owner commands', async () => {
  const { sent, prompts, from } = setup({ config: { patroa: null } });
  await from(STRANGER, '/admin conversas');
  await from(STRANGER, '/admin responder 5531888888888 oi');
  assert.equal(prompts.length, 2, 'viram texto comum');
  assert.ok(sent.every(({ jid }) => jid === `${STRANGER}@s.whatsapp.net`));
});
