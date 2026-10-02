import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const ALLOWED_PORTS = new Set(['', '80', '443']);

const blockList = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
]) blockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blockList.addSubnet(address, prefix, 'ipv6');

// Bloqueia endereços internos para que links não sejam usados para acessar a rede do servidor (SSRF).
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  return blockList.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function findUrl(text = '') {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[.,;:!?)\]}]+$/, '') : null;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return entities[code.toLowerCase()] ?? entity;
  });
}

export function htmlToText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|template|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '',
    text: decodeEntities(text)
      .replace(/[ \t\f\v\r]+/g, ' ')
      .replace(/ *\n[\s]*/g, '\n')
      .trim()
  };
}

function truncate(text) {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[conteúdo cortado]` : text;
}

function createSafeLookup(isBlocked) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(({ address }) => isBlocked(address))) {
        return callback(new Error('Este endereço não pode ser acessado.'));
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function download(url, { isBlocked, allowedPorts, signal }) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Só consigo abrir links http ou https.');
  if (!allowedPorts.has(url.port)) throw new Error('Este endereço não pode ser acessado.');
  if (net.isIP(hostname) && isBlocked(hostname)) throw new Error('Este endereço não pode ser acessado.');

  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      lookup: createSafeLookup(isBlocked),
      signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; WhatsAppGeminiBot/1.0)',
        accept: 'text/html,text/plain,application/pdf;q=0.9,*/*;q=0.5'
      }
    }, (response) => {
      const { statusCode = 0, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        resolve({ redirect: new URL(headers.location, url) });
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`O site respondeu com HTTP ${statusCode}.`));
        return;
      }
      if (Number(headers['content-length']) > MAX_BYTES) {
        response.destroy();
        reject(new Error('A página é grande demais.'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          response.destroy();
          reject(new Error('A página é grande demais.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        contentType: String(headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        buffer: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

export async function fetchLinkContent(link, {
  isBlocked = isBlockedAddress,
  allowedPorts = ALLOWED_PORTS,
  timeoutMs = TIMEOUT_MS
} = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(link);
  let result;
  for (let redirects = 0; ; redirects += 1) {
    try {
      result = await download(url, { isBlocked, allowedPorts, signal });
    } catch (error) {
      if (signal.aborted) throw new Error('O site demorou demais para responder.');
      throw error;
    }
    if (!result.redirect) break;
    if (redirects >= MAX_REDIRECTS) throw new Error('O link redirecionou vezes demais.');
    url = result.redirect;
  }

  const { contentType, buffer } = result;
  if (contentType === 'application/pdf') {
    return { url: url.href, mimeType: contentType, data: buffer.toString('base64') };
  }
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    const page = htmlToText(buffer.toString('utf8'));
    if (!page.text) throw new Error('A página não tem texto legível.');
    return { url: url.href, title: page.title, text: truncate(page.text) };
  }
  if (contentType.startsWith('text/') || contentType === 'application/json') {
    return { url: url.href, title: '', text: truncate(buffer.toString('utf8')) };
  }
  throw new Error(`Não sei ler conteúdo do tipo ${contentType || 'desconhecido'}.`);
}
