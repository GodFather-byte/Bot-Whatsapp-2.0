import { business as studio, formatPrice } from '../business/botPhZeus.js';
import { formatWhen } from '../utils/slots.js';
import { buildGoogleEvent, buildIcs } from './calendar.js';

/**
 * Liga a agenda ao mundo: avisa a dona no WhatsApp (com um arquivo .ics que entra na agenda do
 * celular com um toque), avisa o cliente quando a dona cancela e, se configurado, mantém o Google Agenda.
 * Cada parte falha sozinha: se o WhatsApp cair, o Google Agenda continua, e vice-versa.
 */
export function createAgendaNotifier({
  getSocket,
  ownerNumbers = [],
  business = studio,
  timeZone = 'America/Sao_Paulo',
  googleCalendar = null,
  logger = console,
  now = () => new Date()
}) {
  const ownerJids = ownerNumbers.map((number) => `${number}@s.whatsapp.net`);
  if (!ownerJids.length) logger.warn?.('NUMERO_DONO não configurado: ninguém será avisado sobre novos agendamentos.');

  const when = (appointment) => formatWhen(appointment.inicio, timeZone);

  async function sendToOwners(content) {
    const sock = getSocket();
    if (!sock) throw new Error('WhatsApp desconectado.');
    for (const jid of ownerJids) {
      try {
        await sock.sendMessage(jid, content);
      } catch (error) {
        logger.warn?.({ err: error, jid }, 'Falha ao avisar a dona');
      }
    }
  }

  const describeClient = (appointment) =>
    `👤 ${appointment.clienteNome}${appointment.clienteNumero ? ` — https://wa.me/${appointment.clienteNumero}` : ''}`;
  const describeService = (appointment) =>
    `☀️ ${appointment.protocolo} · ${appointment.duracaoMin} min · ${formatPrice(appointment.valor)}`;

  const calendarFile = (appointment) => ({
    document: Buffer.from(buildIcs(appointment, { business, now: now() }), 'utf8'),
    mimetype: 'text/calendar',
    fileName: `agendamento-${appointment.id}.ics`
  });

  async function attempt(action, task) {
    try {
      return await task();
    } catch (error) {
      logger.warn?.({ err: error }, `Falha ao ${action}`);
      return undefined;
    }
  }

  async function createGoogleEvent(appointment) {
    if (!googleCalendar) return undefined;
    return attempt('criar o evento no Google Agenda', () =>
      googleCalendar.createEvent(buildGoogleEvent(appointment, { business, timeZone })));
  }

  async function deleteGoogleEvent(appointment) {
    if (!googleCalendar || !appointment.googleEventId) return;
    await attempt('apagar o evento do Google Agenda', () => googleCalendar.deleteEvent(appointment.googleEventId));
  }

  const hooks = {
    async onBooked(appointment) {
      await attempt('avisar a dona sobre o agendamento', () => sendToOwners({
        ...calendarFile(appointment),
        caption: [
          `📅 *Novo agendamento* · código *${appointment.id}*`,
          describeClient(appointment),
          describeService(appointment),
          `🗓️ ${when(appointment)}`,
          '',
          `Toque no arquivo para colocar na agenda do celular. Para cancelar: /admin cancelar ${appointment.id}`
        ].join('\n')
      }));
      const googleEventId = await createGoogleEvent(appointment);
      return googleEventId ? { googleEventId } : undefined;
    },

    async onCancelled(appointment, { by, reason } = {}) {
      if (by === 'dona') {
        // O cliente precisa saber: a dona cancelou pelo comando /admin.
        const firstName = appointment.clienteNome.split(' ')[0];
        await attempt('avisar o cliente sobre o cancelamento', async () => {
          const sock = getSocket();
          if (!sock) throw new Error('WhatsApp desconectado.');
          await sock.sendMessage(appointment.clienteJid, {
            text: `Olá, ${firstName}! Precisei cancelar o seu horário de ${when(appointment)} (código ${appointment.id}).`
              + `${reason ? ` Motivo: ${reason}.` : ''} Peço desculpas pelo transtorno! `
              + 'Se quiser, é só me dizer outro dia e horário que eu marco para você. ☀️'
          });
        });
      } else {
        await attempt('avisar a dona sobre o cancelamento', () => sendToOwners({
          text: [
            `❌ *Agendamento cancelado pelo cliente* · código *${appointment.id}*`,
            describeClient(appointment),
            describeService(appointment),
            `🗓️ ${when(appointment)}`,
            '',
            'O horário voltou a ficar livre.'
          ].join('\n')
        }));
      }
      await deleteGoogleEvent(appointment);
    },

    async onRescheduled(before, next) {
      await attempt('avisar a dona sobre a remarcação', () => sendToOwners({
        ...calendarFile(next),
        caption: [
          `🔁 *Agendamento remarcado* · código *${next.id}*`,
          describeClient(next),
          describeService(next),
          `❌ Antes: ${when(before)}`,
          `✅ Agora: ${when(next)}`,
          '',
          'Toque no arquivo para colocar o novo horário na agenda do celular.'
        ].join('\n')
      }));
      await deleteGoogleEvent(before);
      const googleEventId = await createGoogleEvent(next);
      return googleEventId ? { googleEventId } : undefined;
    }
  };

  return { hooks, sendToOwners: (text) => sendToOwners({ text }) };
}
