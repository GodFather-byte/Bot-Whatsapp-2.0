// Recursos de brincadeira do Bot PH Zeus: o Pix do criador e o reconhecimento de contatos especiais.

// A chave só é enviada quando alguém pede. `{pix}` vira a chave.
export const PIX_KEY_LINES = [
  '💸 Aqui está, meu amigo. Pix do meu patrão: {pix}',
  '🕴️ Pedido atendido. A chave do meu patrão: {pix}',
  '🥃 Com prazer! Pix do meu patrão: {pix} (ninguém é obrigado a nada, hein)',
  '🎩 Chave Pix do meu patrão, como solicitado: {pix}'
];

// Piadas de vez em quando, SEM a chave: quem quiser, é só pedir.
export const PIX_JOKES = [
  '💸 Quer falar com o chefe? Manda um Pix pro meu patrão... brincadeira! (Se quiser a chave, é só pedir 😏)',
  '🕴️ A família aceita Pix como gesto de respeito. É só pedir a chave que eu passo (mas ninguém é obrigado).',
  '🥃 Conversa boa merece um cafezinho pro meu patrão. A chave do Pix? Só pedir. (Brincadeira! ...ou não.)',
  '🎩 Uma oferta que o meu patrão não vai recusar: um Pix. Peça a chave se quiser, mas é só zoeira.',
  '😏 Atendimento de consigliere é de graça, mas o meu patrão não reclama de um Pix. Quer a chave? É só falar.'
];

// Pedidos de chave ("me passa o pix", "qual a chave?", "quero pagar"). A mensagem atual é o que vale.
const ASKS_FOR_PIX = /\b(pix|chave|pagamento|pagar|transfer[eê]ncia|transferir|depositar)\b/i;

export function asksForPix(text = '') {
  return ASKS_FOR_PIX.test(String(text));
}

const pick = (items, random) => items[Math.floor(random() * items.length)];

// Rodapé da resposta: a chave quando pediram; senão, de vez em quando (`jokeChance` de 0 a 1), uma piada sem a chave.
export function pixFooter({ key, asked = false, allowJoke = true, jokeChance = 0.2, random = Math.random } = {}) {
  const pixKey = String(key || '').trim();
  if (!pixKey) return '';
  if (asked) return pick(PIX_KEY_LINES, random).replace('{pix}', pixKey);
  if (allowJoke && random() < jokeChance) return pick(PIX_JOKES, random);
  return '';
}

// Junta os contatos reconhecidos vindos da configuração e os salvos com /criador vip (o salvo vale mais).
export function mergeVips(configured = {}, stored = {}) {
  return { ...configured, ...stored };
}

// Descrição do contato especial para um dos números do remetente, ou null.
export function findVip(vips, numbers = []) {
  for (const number of numbers) {
    if (vips[number]) return { number, description: vips[number] };
  }
  return null;
}
