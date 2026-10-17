import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, parseVipContacts } from '../src/config.js';
import { buildAssistantPrompt } from '../src/assistant/profile.js';
import { PIX_JOKES, pixFooter } from '../src/assistant/extras.js';
import { handleCommand } from '../src/handlers/commands.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const CREATOR = '5511915168336';
const OWNER = '5511900000000';
const SISTER = '5511900000001';
const STRANGER = '5531777777777';
const FAKE_PIX = 'chave-pix-de-teste';
const BOT = { id: '5511000000000:3@s.whatsapp.net', lid: '777000@lid' };

function setup(options = {}) {
  const sent = [];
  const prompts = [];
  const storage = options.storage || new MemoryStorage();
  const handler = createMessageHandler({
    config: { pixKey: FAKE_PIX, vipContacts: { [SISTER]: 'a irmã do PH e chefe' }, ...options.config },
    storage,
    gemini: { generate: async ({ text, assistant, extraInstruction }) => { prompts.push({ text, assistant, extraInstruction }); return 'ok'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} },
    ownerNumbers: [OWNER],
    creatorNumbers: [CREATOR],
    getStatus: () => ({ mongoConnected: false, bots: [] }),
    broadcastDelayMs: 0,
    notifyOwner: false,
    ...options.handler
  });
  const sock = {
    user: BOT,
    sendMessage: async (jid, content) => sent.push({ jid, text: content.text }),
    sendPresenceUpdate: async () => {}
  };
  const from = (number, text) => handler(sock, { key: { remoteJid: `${number}@s.whatsapp.net` }, message: { conversation: text } });
  return { sent, prompts, storage, from };
}

test('every answer to a contact ends with the Pix joke, and it is the plain configured key', async () => {
  const { sent, prompts, from } = setup();
  await from(STRANGER, 'oi');
  await from(STRANGER, 'tudo bem?');
  assert.equal(sent.length, 2);
  for (const message of sent) {
    assert.ok(message.text.startsWith('ok\n\n'), 'a resposta da IA vem primeiro');
    assert.ok(message.text.includes(FAKE_PIX), 'a chave aparece no aviso');
  }
  assert.equal(prompts[0].assistant.pixNotice, true);
  assert.doesNotMatch(prompts[0].text, new RegExp(FAKE_PIX), 'a chave nunca vai para o modelo');
});

test('the owner, the creator and VIP contacts do not get the Pix joke', async () => {
  const { sent, prompts, from } = setup();
  await from(OWNER, 'oi');
  await from(CREATOR, 'oi');
  await from(SISTER, 'oi');
  assert.deepEqual(sent.map(({ text }) => text), ['ok', 'ok', 'ok']);
  assert.equal(prompts[2].assistant.vip, 'a irmã do PH e chefe');
  assert.equal(prompts[0].assistant.vip, undefined);
});

test('without a Pix key nothing is added, and /criador pix turns it on, changes it and off', async () => {
  const { sent, from, storage } = setup({ config: { pixKey: '' } });
  await from(STRANGER, 'oi');
  assert.equal(sent.at(-1).text, 'ok');

  await from(CREATOR, '/criador pix outra-chave');
  assert.match(sent.at(-1).text, /Pix atualizado/);
  assert.equal((await storage.getBotSettings()).pix, 'outra-chave');
  await from(STRANGER, 'oi');
  assert.ok(sent.at(-1).text.includes('outra-chave'));

  await from(CREATOR, '/criador pix');
  assert.match(sent.at(-1).text, /Pix ativo: outra-chave/);
  await from(CREATOR, '/criador pix desligar');
  await from(STRANGER, 'oi');
  assert.equal(sent.at(-1).text, 'ok');
  await from(CREATOR, '/criador pix com espaço');
  assert.match(sent.at(-1).text, /Chave inválida/);
});

test('only the creator can change the Pix, VIPs and tone', async () => {
  const { sent, prompts, from, storage } = setup();
  await from(STRANGER, '/criador pix hacker');
  await from(OWNER, '/criador vip 5511999999999 amigo');
  await from(OWNER, '/criador tom só em rimas');
  assert.equal((await storage.getBotSettings()).pix, undefined);
  assert.equal((await storage.getBotSettings()).vips, undefined);
  assert.equal(prompts.length, 1, 'para um contato comum o texto vai para a IA; para o dono vira comando desconhecido');
  assert.match(sent.at(-1).text, /Comando desconhecido/);
  assert.ok(sent.every(({ text }) => !/atualizado|reconhecido/.test(text)));
});

test('/criador vip adds, lists and removes recognized contacts, who then get the VIP treatment', async () => {
  const { sent, prompts, from } = setup();
  await from(CREATOR, '/criador vip 5511999999999 prima do chefe');
  assert.match(sent.at(-1).text, /prima do chefe/);
  await from(CREATOR, '/criador vip sem-numero');
  assert.match(sent.at(-1).text, /Use: \/criador vip/);

  await from(CREATOR, '/criador vips');
  assert.match(sent.at(-1).text, new RegExp(`${SISTER}: a irmã do PH e chefe`));
  assert.match(sent.at(-1).text, /5511999999999: prima do chefe/);

  await from('5511999999999', 'oi');
  assert.equal(prompts.at(-1).assistant.vip, 'prima do chefe');
  assert.ok(!sent.at(-1).text.includes(FAKE_PIX));

  await from(CREATOR, '/criador vip remover 5511999999999');
  assert.match(sent.at(-1).text, /não é mais VIP/);
  await from('5511999999999', 'oi');
  assert.equal(prompts.at(-1).assistant.vip, undefined);
  await from(CREATOR, `/criador vip remover ${SISTER}`);
  assert.match(sent.at(-1).text, /vem da configuração/);
});

test('/criador tom changes how the bot talks to everyone, /criador ficha shows a contact and /criador reiniciar exits', async () => {
  const { sent, prompts, from } = setup();
  await from(CREATOR, '/criador tom bem debochado');
  await from(STRANGER, 'oi');
  assert.match(prompts.at(-1).extraInstruction, /Tom pedido pelo criador: bem debochado/);
  await from(CREATOR, '/criador tom limpar');
  await from(STRANGER, 'oi de novo');
  assert.equal(prompts.at(-1).extraInstruction, undefined);

  await from(CREATOR, `/criador ficha ${STRANGER}`);
  assert.match(sent.at(-1).text, new RegExp(`Ficha de ${STRANGER}`));
  assert.match(sent.at(-1).text, /VIP: não/);
  assert.match(sent.at(-1).text, /Bloqueado: não/);

  const { handleCreatorCommand } = await import('../src/handlers/creator.js');
  let exited = false;
  const reply = await handleCreatorCommand('reiniciar', { storage: new MemoryStorage(), stats: {}, exit: () => { exited = true; } });
  assert.match(reply, /Reiniciando/);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(exited, true);
});

test('configuration reads the Pix key and the VIP list from the environment', () => {
  assert.equal(loadConfig({ PIX_CHAVE: ` ${FAKE_PIX} ` }).pixKey, FAKE_PIX);
  assert.equal(loadConfig({}).pixKey, '');
  assert.deepEqual(parseVipContacts('+55 (11) 90000-0001=irmã do PH e chefe; 5511988887777=amigo; 123=curto'), {
    5511900000001: 'irmã do PH e chefe',
    5511988887777: 'amigo'
  });
  assert.deepEqual(loadConfig({}).vipContacts, {});
});

test('the Pix footer rotates jokes, is always a joke and the prompts tell the model not to touch the key', () => {
  assert.equal(pixFooter(''), '');
  const seen = new Set(PIX_JOKES.map((_, index) => pixFooter(FAKE_PIX, () => index / PIX_JOKES.length)));
  assert.equal(seen.size, PIX_JOKES.length);
  assert.ok([...seen].every((text) => text.includes(FAKE_PIX) && !text.includes('{pix}')));

  const prompt = buildAssistantPrompt({ ownerName: 'PH', pixNotice: true, vip: 'a irmã do PH e chefe' });
  assert.match(prompt, /não escreva nem repita nenhuma chave Pix/i);
  assert.match(prompt, /ninguém é obrigado a pagar/);
  assert.match(prompt, /Quem escreve agora é a irmã do PH e chefe/);
  assert.match(prompt, /fofo, doce e carinhoso/);
  assert.doesNotMatch(buildAssistantPrompt({ ownerName: 'PH' }), /Pix/);
});

test('new owner commands: dado, moeda, sorteio, calc, hora, cambio, traduzir and piada', async () => {
  const gemini = { generate: async ({ text }) => `IA:${text.slice(0, 20)}` };
  const run = (text, extra = {}) => handleCommand(text, 'x@s.whatsapp.net', { storage: new MemoryStorage(), gemini, stats: {}, random: () => 0.5, ...extra });

  assert.match(await run('/dado'), /Caiu 4 .*6 lados/);
  assert.match(await run('/dado 20'), /Caiu 11 .*20 lados/);
  assert.match(await run('/dado 1'), /Use \/dado/);
  assert.match(await run('/moeda'), /coroa/);
  assert.match(await run('/sorteio pizza, sushi, hambúrguer'), /\*sushi\*/);
  assert.match(await run('/sorteio só uma'), /Use \/sorteio/);
  assert.match(await run('/calc 2*(3+4)'), /= \*14\*/);
  assert.match(await run('/calc 2+abc'), /Expressão inválida/);
  assert.match(await run('/hora America/Sao_Paulo'), /🕒/);
  assert.match(await run('/hora Marte/Fobos'), /Não consegui/);
  assert.match(await run('/clima Osasco'), /TOOL_WEATHER_API_KEY/);
  assert.match(await run('/noticias futebol'), /TOOL_NEWS_API_KEY/);
  assert.match(await run('/cambio 100 usd brl'), /TOOL_EXCHANGE_RATE_API_KEY/);
  assert.match(await run('/cambio cem dólares'), /Use \/cambio/);
  assert.match(await run('/traduzir inglês bom dia'), /^IA:Traduza o texto a/);
  assert.match(await run('/piada gatos'), /^IA:Conte uma piada cu/);
  assert.match(await run('/ajuda'), /\/calc[\s\S]*\/cambio[\s\S]*\/piada/);
});
