const MAX_MESSAGE_LENGTH = 3000;

// Converte o Markdown que o Gemini costuma escrever para a formatação do WhatsApp.
export function toWhatsAppFormat(text) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return block;
    return block
      .replace(/^(\s*)[*+]\s+/gm, '$1- ')
      .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
      .replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '*$1*')
      .replace(/__(?!\s)([^_\n]+?)__/g, '*$1*')
      .replace(/~~(?!\s)([^~\n]+?)~~/g, '~$1~')
      .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*')
      .replace(/!?\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`))
      .replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n');
  }).join('').trim();
}

// Divide respostas longas preferindo quebras de parágrafo, depois de linha, de frase e de palavra.
export function splitMessage(text, maxLength = MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' ')]
      .find((position) => position > maxLength / 2);
    const end = cut === undefined ? maxLength : cut + 1;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
