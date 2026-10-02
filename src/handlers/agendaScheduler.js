import { formatAgendaList } from '../services/agenda.js';
import { dateKey, formatDay } from '../utils/slots.js';
import { zonedParts } from '../utils/time.js';

/**
 * Todo dia, na hora configurada, manda para a dona a agenda do dia. Só envia se houver
 * agendamentos, e no máximo uma vez por dia (o dia enviado fica gravado, então um reinício não repete).
 */
export function startAgendaScheduler({
  agenda,
  storage,
  sendToOwners,
  summaryHour,
  timeZone,
  intervalMs = 60_000,
  logger,
  now = () => new Date()
}) {
  if (summaryHour === null || summaryHour === undefined) return () => {};

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const local = zonedParts(now(), timeZone);
      if (local.hour !== summaryHour) return;
      const today = dateKey(local);
      const settings = await storage.getBotSettings();
      if (settings.ultimoResumoDia === today) return;

      const appointments = await agenda.listDay(today);
      if (appointments.length) {
        const count = appointments.length;
        await sendToOwners([
          `☀️ *Agenda de hoje* — ${formatDay(local)} (${count} ${count === 1 ? 'horário' : 'horários'})`,
          formatAgendaList(appointments)
        ].join('\n'));
      }
      await storage.updateBotSettings({ ultimoResumoDia: today });
    } catch (error) {
      logger.error({ err: error }, 'Falha ao enviar o resumo diário da agenda');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
