import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fetchLinkContent, findUrl, htmlToText, isBlockedAddress } from '../src/services/links.js';
import { extractMedia } from '../src/handlers/media.js';
import { createMessageHandler } from '../src/handlers/messages.js';
import { MemoryStorage } from '../src/services/storage.js';
import { createAllowlist } from '../src/middleware/security.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test('link reader blocks private and local network addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '169.254.169.254', '::1', 'fd00::1', '::ffff:7f00:1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);

  await assert.rejects(fetchLinkContent('http://127.0.0.1/'), /não pode ser acessado/);
  await assert.rejects(fetchLinkContent('http://[::1]/'), /não pode ser acessado/);
  await assert.rejects(fetchLinkContent('http://localhost/'), /não pode ser acessado/);
  await assert.rejects(fetchLinkContent('http://example.com:8080/'), /não pode ser acessado/);
  await assert.rejects(fetchLinkContent('ftp://example.com/'), /http ou https/);
});

test('link reader finds urls and extracts readable text from html', () => {
  assert.equal(findUrl('veja https://exemplo.com/artigo?id=1, por favor.'), 'https://exemplo.com/artigo?id=1');
  assert.equal(findUrl('sem links aqui'), null);

  const page = htmlToText(`<html><head><title>Notícia &amp; Cia</title><style>p{}</style></head>
    <body><script>alert(1)</script><h1>Título</h1><p>Primeiro&nbsp;parágrafo</p><p>Segundo &#233;</p></body></html>`);
  assert.equal(page.title, 'Notícia & Cia');
  assert.equal(page.text, 'Título\nPrimeiro parágrafo\nSegundo é');
});

test('link reader follows redirects and enforces the page type', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/antigo') {
      res.writeHead(301, { location: '/artigo' }).end();
    } else if (req.url === '/artigo') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<title>Artigo</title><p>Olá mundo</p>');
    } else {
      res.writeHead(200, { 'content-type': 'application/zip' }).end('PK');
    }
  });
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { isBlocked: () => false, allowedPorts: new Set([String(server.address().port)]) };
  const page = await fetchLinkContent(`${base}/antigo`, options);
  assert.deepEqual(page, { url: `${base}/artigo`, title: 'Artigo', text: 'Olá mundo' });
  await assert.rejects(fetchLinkContent(`${base}/arquivo.zip`, options), /application\/zip/);
  await assert.rejects(fetchLinkContent(`${base}/antigo`, { allowedPorts: options.allowedPorts }), /não pode ser acessado/);
});

test('text documents are summarized without storing their full content', async () => {
  const content = 'linha\n'.repeat(10_000);
  const media = await extractMedia({
    message: { documentMessage: { mimetype: 'application/octet-stream', fileName: 'notas.md', caption: 'Quais os pontos?' } }
  }, { download: async () => Buffer.from(content) });

  assert.equal(media.type, 'documento');
  assert.equal(media.text, 'Quais os pontos? [arquivo: notas.md]');
  assert.match(media.parts[0].text, /Conteúdo do documento notas\.md/);
  assert.match(media.parts[0].text, /\[conteúdo cortado\]$/);

  await assert.rejects(extractMedia({
    message: { documentMessage: { mimetype: 'application/zip', fileName: 'x.zip' } }
  }, { download: async () => Buffer.from('') }), /links/);
  await assert.rejects(extractMedia({
    message: { documentMessage: { mimetype: 'application/pdf', fileLength: 50 * 1024 * 1024 } }
  }, { download: async () => assert.fail('não deveria baixar') }), /grande demais/);
});

function createHandler(overrides) {
  const replies = [];
  const requests = [];
  const storage = new MemoryStorage();
  const handler = createMessageHandler({
    config: {},
    storage,
    gemini: { generate: async (request) => { requests.push(request); return 'ok'; } },
    allowlist: createAllowlist([]),
    rateLimiter: new RateLimiter(),
    stats: { totalMessages: 0, users: new Set(), errorEvents: [], rateLimitEvents: [], recentMessages: [] },
    logger,
    ...overrides
  });
  const sock = {
    sendMessage: async (jid, content) => replies.push(content),
    sendPresenceUpdate: async () => {}
  };
  return { handler, sock, replies, requests, storage };
}

test('messages with links send the page content to Gemini', async () => {
  const { handler, sock, requests, storage } = createHandler({
    fetchLink: async (url) => ({ url, title: 'Receita', text: 'Misture farinha e ovos.' })
  });
  const jid = '5511999999999@s.whatsapp.net';

  await handler(sock, { key: { remoteJid: jid }, message: { conversation: 'quais ingredientes? https://site.com/bolo' } });

  assert.equal(requests[0].parts[0].text, 'quais ingredientes?\n\nConteúdo do link https://site.com/bolo (Receita):\nMisture farinha e ovos.');
  assert.equal((await storage.getHistory(jid))[0].conteudo, 'quais ingredientes? https://site.com/bolo');
});

test('unreadable links still get an answer that explains the problem', async () => {
  const { handler, sock, requests, replies } = createHandler({
    fetchLink: async () => { throw new Error('O site respondeu com HTTP 404.'); }
  });

  await handler(sock, { key: { remoteJid: '5511999999999@s.whatsapp.net' }, message: { conversation: 'https://site.com/x' } });

  assert.match(requests[0].parts[0].text, /Não foi possível abrir o link https:\/\/site\.com\/x: O site respondeu com HTTP 404\./);
  assert.equal(replies.at(-1).text, 'ok');
});

test('documents sent with a caption are unwrapped and unsupported files get a clear reply', async () => {
  const { handler, sock, requests, replies } = createHandler({});
  const jid = '5511999999999@s.whatsapp.net';

  await handler(sock, {
    key: { remoteJid: jid },
    message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/zip', fileName: 'a.zip', caption: 'veja' } } } }
  });

  assert.equal(requests.length, 0);
  assert.match(replies.at(-1).text, /posso analisar imagens, áudios, PDFs, documentos de texto e links/);
});
