import { downloadMediaMessage } from '@whiskeysockets/baileys';

const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 30_000;
const TEXT_MIME_TYPES = new Set(['application/json', 'application/xml', 'application/x-yaml']);
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?)$/i;

export class UserFacingError extends Error {}

function isTextDocument(mimeType, fileName = '') {
  return mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType) || TEXT_EXTENSIONS.test(fileName);
}

export async function extractMedia(msg, { logger, download = downloadMediaMessage } = {}) {
  const content = msg.message || {};
  const image = content.imageMessage;
  const audio = content.audioMessage;
  const document = content.documentMessage;
  if (!image && !audio && !document) return null;

  const media = image || audio || document;
  const mimeType = media.mimetype || (image ? 'image/jpeg' : audio ? 'audio/ogg' : 'application/octet-stream');
  const fileName = document?.fileName || '';
  if (document && mimeType !== 'application/pdf' && !isTextDocument(mimeType, fileName)) {
    throw new UserFacingError('No momento, posso analisar imagens, áudios, PDFs, documentos de texto e links.');
  }
  if (Number(media.fileLength) > MAX_MEDIA_BYTES) {
    throw new UserFacingError('Esse arquivo é grande demais. Envie arquivos de até 15 MB.');
  }

  const buffer = await download(msg, 'buffer', {}, { logger });
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new UserFacingError('Esse arquivo é grande demais. Envie arquivos de até 15 MB.');
  }

  if (document && isTextDocument(mimeType, fileName)) {
    const prompt = document.caption || 'Resuma e explique o conteúdo deste documento.';
    let text = buffer.toString('utf8');
    if (text.length > MAX_DOCUMENT_CHARS) text = `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[conteúdo cortado]`;
    return {
      type: 'documento',
      text: fileName ? `${prompt} [arquivo: ${fileName}]` : prompt,
      parts: [{ text: `${prompt}\n\nConteúdo do documento${fileName ? ` ${fileName}` : ''}:\n${text}` }]
    };
  }

  let prompt;
  let tipo;
  if (image) {
    prompt = image.caption || 'Descreva esta imagem.';
    tipo = 'imagem';
  } else if (audio) {
    prompt = 'Transcreva este áudio e responda ao que foi dito, em português.';
    tipo = 'audio';
  } else {
    prompt = document.caption || 'Resuma este documento.';
    tipo = 'documento';
  }

  return {
    type: tipo,
    text: fileName ? `${prompt} [arquivo: ${fileName}]` : prompt,
    parts: [{ text: prompt }, { inlineData: { mimeType, data: buffer.toString('base64') } }]
  };
}
