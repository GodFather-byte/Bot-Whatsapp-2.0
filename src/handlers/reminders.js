import { nextOccurrence } from '../utils/time.js';

export function startReminderScheduler({ storage, sock, intervalMs, logger, timeZone, now = () => new Date() }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const dueReminders = await storage.getDueReminders(now());
      for (const reminder of dueReminders) {
        try {
          await sock.sendMessage(reminder.usuarioId, { text: `📌 Lembrete: ${reminder.mensagem}` });
          const next = reminder.recorrencia && nextOccurrence(reminder.recorrencia, now(), timeZone);
          if (next) await storage.rescheduleReminder(reminder.id, next);
          else await storage.markReminderSent(reminder.id);
        } catch (error) {
          logger.error({ err: error, reminderId: reminder.id }, 'Falha ao enviar lembrete');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Falha ao verificar lembretes');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
