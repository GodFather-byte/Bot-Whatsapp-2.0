// Recursos de brincadeira do Bot PH Zeus: o aviso do Pix do criador e o reconhecimento de contatos especiais.

// Cada resposta termina com uma destas piadas (sorteada). `{pix}` vira a chave. É sempre brincadeira, nunca cobrança de verdade.
export const PIX_JOKES = [
  '💸 Quer falar com o chefe? Primeiro manda o Pix pro meu patrão: {pix} (é brincadeira, meu amigo... mas o Pix é de verdade 😏)',
  '🕴️ A família aceita Pix como gesto de respeito. Chave do meu patrão: {pix}',
  '🥃 Conversa boa merece um cafezinho: Pix pro meu patrão, {pix}. (Brincadeira! ...ou não.)',
  '💸 Quem quer falar com o chefe passa antes pelo caixa: Pix do meu patrão, {pix}',
  '🎩 Uma oferta que o meu patrão não vai recusar: {pix} (Pix, claro. Brincadeira, só se paga se quiser)',
  '😏 Atendimento de consigliere é de graça, mas o meu patrão aceita um Pix: {pix}'
];

export function pixFooter(pixKey, random = Math.random) {
  const key = String(pixKey || '').trim();
  if (!key) return '';
  const joke = PIX_JOKES[Math.floor(random() * PIX_JOKES.length)];
  return joke.replace('{pix}', key);
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
