import { extractMedia, UserFacingError } from './media.js';
import { handleCommand } from './commands.js';
import { handleAdminCommand } from './admin.js';
import { fetchLinkContent, findUrl } from '../services/links.js';
import { createPresenceTracker } from '../services/presence.js';
import { splitMessage, toWhatsAppFormat } from '../utils/format.js';
const rateLimitedMessage = 'Calma, meu amigo. A família não é tão rápida assim. Aguarde um pouco. 🥃';
const failureMessage = 'Houve um contratempo nos negócios da família. Tente novamente em instantes. 🕴️';
const oneDayAgo = () => Date.now() - 86_400_000;
const MAX_MESSAGE_AGE_MS = 2 * 60_000;
const MAX_SEEN_IDS = 1000;
const NEW_CONVERSATION_AFTER_MS = 6 * 60 * 60_000;
const MAX_BOT_SENT_IDS = 500;

const jidUser = (jid) => jid?.split(/[:@]/)[0];

function messageTime(msg) {
  const timestamp = msg.messageTimestamp;
  if (timestamp === undefined || timestamp === null) return null;
  const seconds = typeof timestamp === 'object' ? timestamp.toNumber?.() ?? Number(timestamp.low) : Number(timestamp);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function recordEvent(events, timestamp) {
  events.push(timestamp);
  const since = oneDayAgo();
  while (events.length && events[0].getTime() < since) events.shift();
}

function unwrapMessage(message = {}) {
  for (let depth = 0; depth < 3; depth += 1) {
    const inner = message.ephemeralMessage?.message
      || message.viewOnceMessage?.message
      || message.viewOnceMessageV2?.message
      || message.documentWithCaptionMessage?.message;
    if (!inner) break;
    message = inner;
  }
  return message;
}

function getText(message = {}) {
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || '';
}

function getContextInfo(message = {}) {
  return message.extendedTextMessage?.contextInfo
    || message.imageMessage?.contextInfo
    || message.audioMessage?.contextInfo
    || message.documentMessage?.contextInfo
    || message.videoMessage?.contextInfo
    || {};
}

// Números de telefone do remetente: o WhatsApp pode identificá-lo pelo LID, pelo número ou pelos dois.
async function resolveSenderNumbers(sock, jid, altJid, logger) {
  const numbers = new Set([jid, altJid].filter((id) => id && !id.endsWith('@lid')).map(jidUser));
  if (jid?.endsWith('@lid') && !numbers.size) {
    try {
      const phoneJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (phoneJid) numbers.add(jidUser(phoneJid));
    } catch (error) {
      logger.debug({ err: error, jid }, 'Falha ao converter LID em número');
    }
  }
  return [...numbers].filter(Boolean);
}

function isAddressedToBot(sock, contextInfo) {
  const self = new Set([jidUser(sock.user?.id), jidUser(sock.user?.lid)].filter(Boolean));
  if (!self.size) return false;
  return (contextInfo.mentionedJid || []).some((jid) => self.has(jidUser(jid)))
    || self.has(jidUser(contextInfo.participant));
}

async function buildLinkParts(text, url, fetchLink, logger) {
  const question = text.replace(url, '').trim() || 'Resuma o conteúdo deste link.';
  try {
    const page = await fetchLink(url);
    if (page.data) {
      return [
        { text: `${question}\n\nConteúdo do link ${page.url}:` },
        { inlineData: { mimeType: page.mimeType, data: page.data } }
      ];
    }
    const title = page.title ? ` (${page.title})` : '';
    return [{ text: `${question}\n\nConteúdo do link ${page.url}${title}:\n${page.text}` }];
  } catch (error) {
    logger.warn({ err: error, url }, 'Falha ao acessar link');
    return [{ text: `${text}\n\n[Não foi possível abrir o link ${url}: ${error.message} Avise o usuário e responda com o que for possível.]` }];
  }
}

export function createMessageHandler({
  config,
  storage,
  gemini,
  allowlist,
  rateLimiter,
  stats,
  logger,
  fetchLink = fetchLinkContent,
  now = Date.now,
  ignoredNumbers = [],
  ownerNumbers = [],
  timeZone = 'America/Sao_Paulo',
  debounceMs = 0,
  groupsEnabled = true,
  getStatus,
  broadcastDelayMs,
  usage,
  dailyLimit,
  presence = createPresenceTracker({ timeZone, now }),
  notifyOwner = true
}) {
  // Pode ser um Set compartilhado que cresce quando cada número do bot conecta (número e LID).
  const ignored = ignoredNumbers instanceof Set ? ignoredNumbers : new Set(ignoredNumbers);
  const owners = new Set(ownerNumbers);
  const seenIds = new Set();
  const botSentIds = new Set();
  const patchedSockets = new WeakSet();
  const pending = new Map();

  // Mensagens que o próprio bot envia podem voltar como "fromMe"; guardar os ids evita confundi-las com o dono digitando.
  function trackSentIds(sock) {
    if (patchedSockets.has(sock) || typeof sock.sendMessage !== 'function') return;
    patchedSockets.add(sock);
    const original = sock.sendMessage.bind(sock);
    sock.sendMessage = async (...args) => {
      const result = await original(...args);
      const id = result?.key?.id;
      if (id) {
        botSentIds.add(id);
        if (botSentIds.size > MAX_BOT_SENT_IDS) botSentIds.delete(botSentIds.values().next().value);
      }
      return result;
    };
  }

  // Quem recebe os avisos do assistente: os números de dono configurados ou, sem eles, a própria conversa "Você".
  function ownerJids(sock) {
    if (owners.size) return [...owners].map((number) => `${number}@s.whatsapp.net`);
    const self = jidUser(sock.user?.id);
    return self ? [`${self}@s.whatsapp.net`] : [];
  }

  async function notifyOwners(sock, remoteJid, msg, senderNumbers, question, answer) {
    const who = [msg.pushName, senderNumbers[0] && `+${senderNumbers[0]}`].filter(Boolean).join(' · ') || remoteJid;
    const note = [
      `📩 *${who}* escreveu e o assistente respondeu:`,
      `> ${question.slice(0, 300)}`,
      `↳ ${answer.slice(0, 300)}`
    ].join('\n');
    for (const jid of ownerJids(sock)) {
      try {
        await sock.sendMessage(jid, { text: note });
      } catch (error) {
        logger.warn({ err: error, jid }, 'Falha ao avisar o dono');
      }
    }
  }

  // `native`: o texto já está no formato do WhatsApp (*negrito*), então não passa pela conversão de Markdown,
  // que trataria *negrito* como itálico. Só a saída da IA precisa ser convertida.
  async function send(sock, remoteJid, text, quoted, { native = false } = {}) {
    for (const chunk of splitMessage(native ? text : toWhatsAppFormat(text))) {
      await sock.sendMessage(remoteJid, { text: chunk }, quoted ? { quoted } : undefined);
    }
  }

  // Respostas de comando são texto ou { image, caption } (ex.: /imagem).
  async function sendCommandReply(sock, remoteJid, reply) {
    if (typeof reply === 'string') return send(sock, remoteJid, reply, undefined, { native: true });
    await sock.sendMessage(remoteJid, { image: reply.image.buffer, mimetype: reply.image.mimetype, caption: reply.caption || undefined });
  }

  async function reportFailure(sock, remoteJid, error) {
    recordEvent(stats.errorEvents, new Date());
    logger.error({ err: error, remoteJid }, 'Falha ao processar mensagem');
    try {
      await sock.sendMessage(remoteJid, {
        text: error instanceof UserFacingError ? error.message : failureMessage
      });
    } catch (sendError) {
      logger.error({ err: sendError, remoteJid }, 'Falha ao enviar mensagem de erro');
    }
  }

  async function respond({ sock, remoteJid, isGroup, isOwner, msg, text, media, settings, senderNumbers = [] }) {
    const user = await storage.getUser(remoteJid);
    const history = await storage.getHistory(remoteJid, 10);

    const lastAt = history.at(-1)?.timestamp ? new Date(history.at(-1).timestamp).getTime() : 0;
    const firstContact = !isOwner && (!history.length || now() - lastAt > NEW_CONVERSATION_AFTER_MS);

    const speaker = isGroup && msg.pushName ? `${msg.pushName}: ` : '';
    const userText = `${speaker}${media?.text || text}`;
    await sock.sendPresenceUpdate('composing', remoteJid);
    const url = !media && findUrl(text);
    const parts = url ? await buildLinkParts(text, url, fetchLink, logger) : media?.parts;
    const generateResponse = gemini.stream || gemini.generate;
    const answer = await generateResponse.call(gemini, {
      history,
      text: userText,
      parts,
      user,
      extraInstruction: settings.instrucoes,
      assistant: { firstContact, contactName: msg.pushName, isGroup, withOwner: isOwner }
    });
    await storage.addMessage({ remoteJid, role: 'user', conteudo: userText, tipo: media?.type || 'texto' });
    await storage.addMessage({ remoteJid, role: 'assistant', conteudo: answer, tipo: 'texto' });

    await send(sock, remoteJid, answer, isGroup ? msg : undefined);
    if (firstContact && notifyOwner && !isGroup) await notifyOwners(sock, remoteJid, msg, senderNumbers, userText, answer);
    stats.recentMessages.unshift({
      de: remoteJid,
      texto: userText.slice(0, 500),
      respostaPreview: answer.slice(0, 200),
      timestamp: new Date().toISOString()
    });
    stats.recentMessages.length = Math.min(stats.recentMessages.length, 10);
  }

  async function withPresence(sock, remoteJid, task) {
    try {
      await task();
    } catch (error) {
      await reportFailure(sock, remoteJid, error);
    } finally {
      try {
        await sock.sendPresenceUpdate('paused', remoteJid);
      } catch (error) {
        logger.debug({ err: error, remoteJid }, 'Falha ao atualizar presença');
      }
    }
  }

  // Junta mensagens de texto enviadas em sequência para responder tudo de uma vez.
  function queueText(key, request) {
    const entry = pending.get(key) || { texts: [] };
    clearTimeout(entry.timer);
    entry.texts.push(request.text);
    entry.request = request;
    entry.timer = setTimeout(() => {
      pending.delete(key);
      const { sock, remoteJid } = entry.request;
      withPresence(sock, remoteJid, () => respond({ ...entry.request, text: entry.texts.join('\n') }));
    }, debounceMs);
    entry.timer.unref?.();
    pending.set(key, entry);
  }

  // Ignora mensagens antigas (acumuladas com o bot desligado) e repetidas (o WhatsApp pode reentregar).
  function isFreshAndNew(msg, remoteJid, { markSeen = true } = {}) {
    const sentAt = messageTime(msg);
    if (sentAt !== null && now() - sentAt > MAX_MESSAGE_AGE_MS) return false;
    const messageId = msg.key?.id && `${remoteJid}:${msg.key.id}`;
    if (messageId && !markSeen) return !seenIds.has(messageId);
    if (messageId) {
      if (seenIds.has(messageId)) return false;
      seenIds.add(messageId);
      if (seenIds.size > MAX_SEEN_IDS) seenIds.delete(seenIds.values().next().value);
    }
    return true;
  }

  // Comandos escritos no próprio celular, na conversa "Você" (consigo mesmo). Quem tem acesso ao celular é o dono,
  // então isso funciona mesmo sem NUMERO_DONO. Texto comum nessa conversa é anotação do dono e não é respondido.
  async function handleSelfChat(sock, msg, remoteJid) {
    const self = new Set([jidUser(sock.user?.id), jidUser(sock.user?.lid)].filter(Boolean));
    if (!self.has(jidUser(remoteJid)) || remoteJid.endsWith('@g.us')) return;
    const text = getText(unwrapMessage(msg.message)).trim();
    if (!text.startsWith('/') || !isFreshAndNew(msg, remoteJid)) return;
    try {
      const adminMatch = text.match(/^\/admin\b\s*([\s\S]*)$/i);
      const reply = adminMatch
        ? await handleAdminCommand(adminMatch[1], { storage, stats, getStatus, sock, remoteJid, logger, broadcastDelayMs, usage, dailyLimit, timeZone, presence })
        : await handleCommand(text, remoteJid, { storage, gemini, stats, timeZone });
      if (reply !== null) await sendCommandReply(sock, remoteJid, reply);
    } catch (error) {
      await reportFailure(sock, remoteJid, error);
    }
  }

  // Registra por que uma mensagem não foi respondida: sem isso, "o bot não responde" é impossível de diagnosticar pelos logs.
  const skip = (reason, remoteJid) => logger.info?.({ motivo: reason, de: remoteJid }, 'Mensagem não respondida');

  return async function handleMessage(sock, msg) {
    if (!msg?.message) return;
    const remoteJid = msg.key?.remoteJid;
    // Status, listas de transmissão e canais (newsletters) não são conversas: o bot nunca responde a eles.
    if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return;
    trackSentIds(sock);
    logger.info?.({ de: remoteJid, minha: Boolean(msg.key?.fromMe) }, 'Mensagem recebida');
    // Mensagens do próprio número são do dono digitando no celular (ou respostas do bot, que são ignoradas).
    // Elas mostram que o dono está online: o assistente se cala naquela conversa e não responde enquanto ele estiver ativo.
    if (msg.key?.fromMe) {
      if (msg.key.id && botSentIds.has(msg.key.id)) return;
      const self = new Set([jidUser(sock.user?.id), jidUser(sock.user?.lid)].filter(Boolean));
      const isSelfChat = self.has(jidUser(remoteJid));
      if (isFreshAndNew(msg, remoteJid, { markSeen: false })) presence.recordOwnerActivity(isSelfChat ? null : remoteJid);
      await handleSelfChat(sock, msg, remoteJid);
      return;
    }
    const isGroup = remoteJid.endsWith('@g.us');
    if (isGroup && !groupsEnabled) return skip('grupos desligados (GRUPOS_ATIVADOS=false)', remoteJid);

    const senderJid = isGroup ? msg.key.participant : remoteJid;
    const senderAlt = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;
    if (!senderJid) return;
    // Evita que os números do próprio bot fiquem respondendo uns aos outros.
    if (ignored.has(jidUser(senderJid)) || ignored.has(jidUser(senderAlt))) return skip('remetente é um dos números do próprio bot', remoteJid);

    if (!isFreshAndNew(msg, remoteJid)) return skip('mensagem antiga (mais de 2 min) ou repetida', remoteJid);

    const message = unwrapMessage(msg.message);
    // Em grupos, o bot só responde quando é mencionado ou quando respondem a uma mensagem dele.
    if (isGroup && !isAddressedToBot(sock, getContextInfo(message))) return skip('grupo sem menção ao bot', remoteJid);

    await withPresence(sock, remoteJid, async () => {
      const senderNumbers = await resolveSenderNumbers(sock, senderJid, senderAlt, logger);
      const isOwner = senderNumbers.some((number) => owners.has(number));
      if (!isOwner && await storage.isBlocked(senderNumbers)) return skip('número bloqueado', remoteJid);

      // Número fora da lista permitida: o assistente finge que não viu, sem avisar a pessoa.
      if (!isOwner && !allowlist.isAllowed(senderJid, senderAlt, ...senderNumbers)) return skip('número fora de WHATSAPP_ALLOWED_NUMBERS', remoteJid);

      const settings = await storage.getBotSettings();
      // Por padrão o assistente responde a todos (modo "on"); "auto" e "off" continuam disponíveis com /admin ausente.
      if (!isOwner && !presence.isAway({ mode: settings.ausencia || 'on', schedule: settings.ausenciaHorario, chatJid: remoteJid })) return skip(`dono ativo ou modo ausente desligado (modo: ${settings.ausencia || 'on'})`, remoteJid);

      if (!isOwner) {
        const rate = rateLimiter.consume(senderJid);
        if (!rate.allowed) {
          recordEvent(stats.rateLimitEvents, new Date());
          logger.warn({ remoteJid, senderJid }, 'Limite de mensagens acionado');
          if (rate.firstBlock) await sock.sendMessage(remoteJid, { text: rateLimitedMessage });
          return;
        }
      }

      stats.users.add(senderNumbers[0] || senderJid);
      const rawText = getText(message);
      const text = (isGroup ? rawText.replace(/@\d+/g, '') : rawText).trim();
      let media = null;
      if (!text || message.imageMessage || message.audioMessage || message.documentMessage) {
        media = await extractMedia({ ...msg, message }, { logger });
      }
      if (!text && !media) return;

      stats.totalMessages += 1;
      stats.lastMessageAt = new Date();

      // Comandos são do dono. Para os contatos, "/algo" é texto comum e o assistente conversa normalmente.
      const commandText = text || media?.text || '';
      if (isOwner && commandText.startsWith('/')) {
        const adminMatch = commandText.match(/^\/admin\b\s*([\s\S]*)$/i);
        const reply = adminMatch
          ? await handleAdminCommand(adminMatch[1], { storage, stats, getStatus, sock, remoteJid, logger, broadcastDelayMs, usage, dailyLimit, timeZone, presence })
          : await handleCommand(commandText, remoteJid, { storage, gemini, stats, timeZone });
        if (reply !== null) {
          await sendCommandReply(sock, remoteJid, reply);
          return;
        }
      }

      const request = { sock, remoteJid, isGroup, isOwner, msg, text, media, settings, senderNumbers };
      if (debounceMs > 0 && !media) {
        queueText(`${remoteJid}|${senderJid}`, request);
        return;
      }
      await respond(request);
    });
  };
}
