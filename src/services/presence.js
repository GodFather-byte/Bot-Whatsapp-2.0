import { isWithinBusinessHours, parseBusinessHours } from '../utils/time.js';

const MINUTE = 60_000;

export const AWAY_MODES = ['auto', 'on', 'off'];

// Decide se o dono está "ausente", ou seja, se o assistente deve responder por ele.
//   on   — sempre ausente (o assistente responde a tudo)
//   off  — nunca ausente (o assistente fica quieto)
//   auto — ausente quando o dono não mexeu no WhatsApp há `idleMinutes` ou dentro do horário de ausência
//          configurado; e o assistente se cala numa conversa em que o dono respondeu há `takeoverMinutes`.
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

  function isAway({ mode = 'auto', schedule, chatJid } = {}) {
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    const lastInChat = lastByChat.get(chatJid);
    if (lastInChat !== undefined && now() - lastInChat < takeoverMinutes * MINUTE) return false;
    if (schedule) {
      try {
        if (isWithinBusinessHours(parseBusinessHours(schedule), new Date(now()), timeZone)) return true;
      } catch {
        // Horário inválido salvo antes: cai no critério de inatividade.
      }
    }
    return lastActivity === null || now() - lastActivity >= idleMinutes * MINUTE;
  }

  return { recordOwnerActivity, isAway, idleMinutes, takeoverMinutes };
}
