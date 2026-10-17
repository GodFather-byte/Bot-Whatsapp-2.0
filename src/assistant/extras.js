// Extras do Bot PH Zeus: o Pix do criador (só quando pedem) e o reconhecimento de contatos especiais.

// A chave só é enviada quando alguém pede. `{pix}` vira a chave.
export const PIX_KEY_LINES = [
  'Segue a chave Pix: {pix}',
  'Chave Pix: {pix}',
  'Conforme solicitado, a chave Pix: {pix}'
];

// Pedidos de chave ("me passa o pix", "qual a chave?", "quero pagar"). A mensagem atual é o que vale.
const ASKS_FOR_PIX = /\b(pix|chave|pagamento|pagar|transfer[eê]ncia|transferir|depositar)\b/i;

export function asksForPix(text = '') {
  return ASKS_FOR_PIX.test(String(text));
}

const pick = (items, random) => items[Math.floor(random() * items.length)];

// Rodapé da resposta: a chave quando pediram; senão, nada.
export function pixFooter({ key, asked = false, random = Math.random } = {}) {
  const pixKey = String(key || '').trim();
  if (!pixKey || !asked) return '';
  return pick(PIX_KEY_LINES, random).replace('{pix}', pixKey);
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
