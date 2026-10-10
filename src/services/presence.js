import { isWithinBusinessHours, parseBusinessHours } from '../utils/time.js';

const MINUTE = 60_000;

export const AWAY_MODES = ['auto', 'on', 'off'];

// Decide se o dono está "ausente", ou seja, se o assistente deve responder por ele.
//   on   — ausente (o assistente responde a tudo), exceto nas conversas em que o dono respondeu há `takeoverMinutes`
//   off  — nunca ausente (o assistente fica quieto)
//   auto — ausente quando o dono não mexeu no WhatsApp há `idleMinutes` ou dentro do horário de ausência
//          configurado; e também se cala nas conversas em que o dono respondeu há `takeoverMinutes`.
// Em qualquer modo, quando um humano (o dono) responde numa conversa o assistente sai dela: ninguém atende em dobro.
// O WhatsApp não avisa quando o dono "está online", então a atividade é medida pelas mensagens que ele envia do celular.
export function createPresenceTracker({
  idleMinutes = 10,
  takeoverMinutes = 60,
  timeZone = 'America/Sao_Paulo',
  now = Date.now
} = {}) {
  let lastActivity = null;
  const lastByChat = new Map();

  function recordOwnerActivity(chatJid) {
    const at = now();
    lastActivity = at;
    if (!chatJid) return;
    lastByChat.set(chatJid, at);
    if (lastByChat.size > 1000) lastByChat.delete(lastByChat.keys().next().value);
  }

  // O dono respondeu nessa conversa há pouco: um humano assumiu e o assistente deve ficar quieto.
  function isTakenOver(chatJid) {
    const lastInChat = lastByChat.get(chatJid);
    return lastInChat !== undefined && now() - lastInChat < takeoverMinutes * MINUTE;
  }

  function isAway({ mode = 'auto', schedule, chatJid } = {}) {
    if (mode === 'off' || isTakenOver(chatJid)) return false;
    if (mode === 'on') return true;
    if (schedule) {
      try {
        if (isWithinBusinessHours(parseBusinessHours(schedule), new Date(now()), timeZone)) return true;
      } catch {
        // Horário inválido salvo antes: cai no critério de inatividade.
      }
    }
    return lastActivity === null || now() - lastActivity >= idleMinutes * MINUTE;
  }

  const lastOwnerActivityIn = (chatJid) => lastByChat.get(chatJid) ?? 0;

  return { recordOwnerActivity, lastOwnerActivityIn, isTakenOver, isAway, idleMinutes, takeoverMinutes };
}
