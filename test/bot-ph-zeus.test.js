import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCommand } from '../src/handlers/commands.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { createGeminiService, SYSTEM_INSTRUCTIONS } from '../src/services/gemini.js';
import { MemoryStorage } from '../src/services/storage.js';
import {
  buildBusinessPrompt,
  business,
  formatContact,
  formatPrice,
  formatPriceList,
  whatsappUrl
} from '../src/business/botPhZeus.js';

// Preços do folheto: [protocolo, 20 min, 30 min].
const flyerPrices = [
  ['Protocolo Bronze', 'R$ 60,00', 'R$ 80,00'],
  ['Protocolo Prata', 'R$ 80,00', 'R$ 100,00'],
  ['Protocolo Ouro', 'R$ 100,00', 'R$ 120,00']
];

test('prices are formatted in reais', () => {
  assert.equal(formatPrice(60), 'R$ 60,00');
  assert.equal(formatPrice(120), 'R$ 120,00');
});

test('the price list matches the flyer for every protocol and session length', () => {
  const list = formatPriceList();
  for (const [name, twenty, thirty] of flyerPrices) {
    const block = list.split('\n\n').find((section) => section.includes(name));
    assert.ok(block, `${name} ausente`);
    assert.ok(block.includes(`- 20 minutos (equivalente a 40 minutos): *${twenty}*`), `${name} 20 min`);
    assert.ok(block.includes(`- 30 minutos (equivalente a 60 minutos): *${thirty}*`), `${name} 30 min`);
  }
  assert.match(list, /ativador de marquinha, parafina, banho de lua e fitagem/);
  assert.match(list, /Para agendar, é só me dizer o dia e o horário que prefere\. Se preferir falar com a dona do estúdio: \(11\) 94578-8032/);
});

test('the owner WhatsApp is the human fallback, with a direct chat link', () => {
  assert.equal(whatsappUrl('(11) 94578-8032'), 'https://wa.me/5511945788032');
  const contact = formatContact();
  assert.match(contact, /Se preferir falar com a dona do estúdio: \(11\) 94578-8032 \(https:\/\/wa\.me\/5511945788032\)/);
  const prompt = buildBusinessPrompt();
  assert.match(prompt, /Você atende neste WhatsApp \(\(11\) 99136-1386\).*nunca peça para ele chamar esse número/);
  assert.match(prompt, /A dona do estúdio atende pelo WhatsApp \(11\) 94578-8032 \(https:\/\/wa\.me\/5511945788032\) quem preferir falar com uma pessoa/);
  assert.match(prompt, /agenda online não está disponível, mande o cliente chamar a dona do estúdio no WhatsApp/);
  for (const tool of ['consultar_horarios_livres', 'agendar_horario', 'meus_agendamentos', 'cancelar_agendamento', 'remarcar_agendamento']) {
    assert.ok(prompt.includes(tool), `${tool} ausente do prompt`);
  }
  assert.match(prompt, /NUNCA diga que agendou antes de a ferramenta responder ok: true/);
});

test('contact info carries address, WhatsApp and Instagram, and no invented opening hours', () => {
  const contact = formatContact();
  assert.match(contact, /R\. Dona Primitiva Vianco, 145, 3º Andar, Sala 312 - Centro de Osasco\/SP/);
  assert.match(contact, /a 70 metros da Estação Osasco/);
  assert.doesNotMatch(contact, /99136/, 'o número do próprio bot não é listado como contato');
  assert.doesNotMatch(contact, /97821/, 'o número antigo do folheto não deve aparecer');
  assert.match(contact, /@bronze_na_rapha/);
  assert.match(contact, /https:\/\/share\.google\/gm6G4VSD3dDOVdFMu/);
  assert.doesNotMatch(contact, /Horário/);
  assert.match(formatContact({ ...business, openingHours: 'seg-sex 09:00-19:00' }), /Horário: seg-sex 09:00-19:00/);
});

test('the AI prompt lists every price and tells the model not to invent facts', () => {
  const prompt = buildBusinessPrompt();
  for (const [, twenty, thirty] of flyerPrices) {
    assert.ok(prompt.includes(twenty), `${twenty} ausente do prompt`);
    assert.ok(prompt.includes(thirty), `${thirty} ausente do prompt`);
  }
  assert.match(prompt, /Sala 312/);
  assert.match(prompt, /\(11\) 99136-1386/);
  assert.doesNotMatch(prompt, /97821/);
  assert.match(prompt, /Realçando sua melhor versão/);
  assert.match(prompt, /Bronzeamento profissional/);
  assert.match(prompt, /share\.google\/gm6G4VSD3dDOVdFMu/);
  assert.match(prompt, /Horário de funcionamento: não informado/);
  assert.match(prompt, /Nunca invente descontos/);
  assert.match(prompt, /não dê conselho médico/);
});

test('commands /precos and /endereco answer without calling Gemini', async () => {
  const gemini = { generate: async () => assert.fail('o Gemini não deve ser chamado') };
  const context = { storage: new MemoryStorage(), gemini, stats: {} };

  for (const command of ['/precos', '/preços', '/valores', '/protocolos']) {
    assert.equal(await handleCommand(command, 'cliente@s.whatsapp.net', context), formatPriceList());
  }
  for (const command of ['/endereco', '/endereço', '/contato']) {
    assert.equal(await handleCommand(command, 'cliente@s.whatsapp.net', context), formatContact());
  }
  assert.match(await handleCommand('/ajuda', 'cliente@s.whatsapp.net', context), /\/precos/);
});

test('every persona keeps the studio knowledge and only changes the tone', async () => {
  for (const persona of [undefined, ...Object.keys(SYSTEM_INSTRUCTIONS)]) {
    let instruction;
    const gemini = createGeminiService({
      model: 'test-model',
      ai: {
        models: {
          generateContent: async ({ config }) => {
            instruction = config.systemInstruction;
            return { text: 'ok' };
          }
        }
      }
    });
    await gemini.generate({ text: 'Quanto custa?', user: { persona }, extraInstruction: 'Hoje temos vaga às 15h.' });
    assert.match(instruction, /Bot PH Zeus/, `persona ${persona}`);
    assert.match(instruction, /R\$ 120,00/, `persona ${persona}`);
    assert.match(instruction, /Hoje temos vaga às 15h\./, `persona ${persona}`);
  }
});

test('command replies keep WhatsApp bold, while AI answers still have their Markdown converted', async () => {
  const sent = [];
  const storage = new MemoryStorage();
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async () => 'Resumo com **negrito** e *itálico* do Gemini' },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger: { warn() {}, error() {}, debug() {} }
  });
  const jid = '5511911111111@s.whatsapp.net';
  const sock = { sendMessage: async (to, content) => { sent.push(content.text); }, sendPresenceUpdate: async () => {} };
  const say = (text) => handler(sock, { key: { remoteJid: jid }, message: { conversation: text } });

  await say('/precos');
  assert.ok(sent.at(-1).includes('*Protocolo Bronze*'), 'nome do protocolo em negrito');
  assert.ok(sent.at(-1).includes('*R$ 60,00*'), 'preço em negrito');
  assert.ok(!sent.at(-1).includes('_Protocolo'), 'sem itálico indevido');
  assert.ok(sent.at(-1).includes('_ativador de marquinha e fitagem_'), 'o que cada protocolo inclui continua em itálico');

  await say('/endereco');
  assert.ok(sent.at(-1).startsWith('📍 *Bot PH Zeus*'));

  await storage.addMessage({ remoteJid: jid, role: 'user', conteudo: 'oi' });
  await say('/resumo');
  assert.equal(sent.at(-1), 'Resumo com *negrito* e _itálico_ do Gemini');
});
