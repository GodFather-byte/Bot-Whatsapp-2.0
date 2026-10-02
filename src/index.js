import express from 'express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createStorage, MongoStorage } from './services/storage.js';
import { createGeminiService } from './services/gemini.js';
import { createWhatsAppService } from './services/whatsapp.js';
import { createAllowlist } from './middleware/security.js';
import { RateLimiter } from './middleware/rateLimiter.js';
import { createMessageHandler } from './handlers/messages.js';
import { startReminderScheduler } from './handlers/reminders.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createUsageTracker } from './services/usage.js';
import { createAgendaService } from './services/agenda.js';
import { createAgendaNotifier } from './services/agendaNotifier.js';
import { createGoogleCalendar, parseServiceAccount } from './services/calendar.js';
import { startAgendaScheduler } from './handlers/agendaScheduler.js';

const startedAt = Date.now();
const stats = {
  totalMessages: 0,
  lastMessageAt: null,
  users: new Set(),
  errorEvents: [],
  rateLimitEvents: [],
  recentMessages: []
};

let storage;
let bots = [];
const getConnectionStatus = () => ({
  whatsappConnected: bots.length > 0 && bots.every(({ whatsapp }) => whatsapp.isConnected()),
  mongoConnected: storage instanceof MongoStorage,
  bots: bots.map(({ bot, whatsapp }) => ({ numero: bot.number || bot.id, conectado: whatsapp.isConnected() }))
});
const app = express();
app.get('/', (_req, res) => res.send('🤖 Bot do WhatsApp Online na Nuvem!'));
// Para monitores como o UptimeRobot: responde 503 quando algum número do WhatsApp está desconectado.
app.get('/health', (_req, res) => {
  const { whatsappConnected } = getConnectionStatus();
  res.status(whatsappConnected ? 200 : 503).json({ status: whatsappConnected ? 'ok' : 'whatsapp_desconectado' });
});
if (config.dashboardEnabled) {
  app.use(createDashboardRouter({ config, stats, startedAt, getConnectionStatus }));
}
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'Servidor HTTP iniciado'));

storage = await createStorage(config.mongoUri, logger, config.mongoDbName);
const savedStats = await storage.loadStats();
if (savedStats) {
  stats.totalMessages = savedStats.totalMessages || 0;
  for (const user of savedStats.users || []) stats.users.add(user);
}
const saveStats = () => storage.saveStats({ totalMessages: stats.totalMessages, users: [...stats.users] })
  .catch((error) => logger.warn({ err: error }, 'Falha ao salvar estatísticas'));
const statsTimer = setInterval(saveStats, 60_000);
statsTimer.unref();
const gemini = createGeminiService({
  apiKey: config.geminiApiKey,
  model: config.geminiModel,
  maxTokens: config.geminiMaxTokens,
  timeoutMs: config.geminiTimeout,
  apiKeys: config.toolApiKeys,
  timeZone: config.timeZone,
  onUsage: (event) => usage.record(event)
});
const usage = createUsageTracker({ storage, logger });
const allowlist = createAllowlist(config.allowedNumbers, config.allowedNumbersConfigured);
const botNumbers = config.bots.map(({ number }) => number).filter(Boolean);
if (botNumbers.length) await storage.adoptUntaggedData(config.bots[0].id);
// Números e LIDs dos próprios bots, para que eles nunca respondam uns aos outros.
const botIdentities = new Set(botNumbers);

// Google Agenda é opcional: sem as duas variáveis, a dona recebe só o aviso e o arquivo .ics no WhatsApp.
let googleCalendar = null;
if (config.googleCalendarId && config.googleServiceAccount) {
  try {
    googleCalendar = createGoogleCalendar({
      calendarId: config.googleCalendarId,
      credentials: parseServiceAccount(config.googleServiceAccount)
    });
    logger.info('Google Agenda ligado: os agendamentos serão criados na agenda configurada.');
  } catch (error) {
    logger.warn({ err: error }, 'Google Agenda desativado: credenciais inválidas');
  }
} else if (config.googleCalendarId || config.googleServiceAccount) {
  logger.warn('Google Agenda desativado: defina GOOGLE_CALENDAR_ID e GOOGLE_SERVICE_ACCOUNT_JSON juntos.');
}

bots = config.bots.map((bot) => {
  const botStorage = bot.number ? storage.forBot(bot.id) : storage;
  const botLogger = logger.child({ bot: bot.id });
  // O notificador só usa o WhatsApp depois que a conexão abre, então pode referenciá-lo de forma preguiçosa.
  const notifier = createAgendaNotifier({
    getSocket: () => whatsapp.getSocket(),
    ownerNumbers: config.ownerNumbers,
    timeZone: config.timeZone,
    googleCalendar,
    logger: botLogger
  });
  const { summaryHour, ...agendaRules } = config.agenda;
  const agenda = createAgendaService({
    storage: botStorage,
    timeZone: config.timeZone,
    ...agendaRules,
    hooks: notifier.hooks,
    logger: botLogger
  });
  const whatsapp = createWhatsAppService({
    config,
    bot,
    logger,
    onOpen: (user) => {
      for (const jid of [user?.id, user?.lid]) {
        if (jid) botIdentities.add(jid.split(/[:@]/)[0]);
      }
    },
    onMessage: createMessageHandler({
      config,
      storage: botStorage,
      gemini,
      allowlist,
      rateLimiter: new RateLimiter(),
      stats,
      logger: botLogger,
      ignoredNumbers: botIdentities,
      ownerNumbers: config.ownerNumbers,
      timeZone: config.timeZone,
      debounceMs: config.messageDebounceMs,
      groupsEnabled: config.groupsEnabled,
      getStatus: getConnectionStatus,
      usage,
      dailyLimit: config.geminiDailyLimit,
      agenda
    })
  });
  const stopReminderScheduler = startReminderScheduler({
    storage: botStorage,
    sock: {
      sendMessage: (...args) => {
        const socket = whatsapp.getSocket();
        if (!socket) throw new Error('WhatsApp desconectado.');
        return socket.sendMessage(...args);
      }
    },
    intervalMs: config.reminderCheckInterval,
    logger: botLogger,
    timeZone: config.timeZone
  });
  const stopAgendaScheduler = startAgendaScheduler({
    agenda,
    storage: botStorage,
    sendToOwners: notifier.sendToOwners,
    summaryHour,
    timeZone: config.timeZone,
    logger: botLogger
  });
  return { bot, whatsapp, stopReminderScheduler, stopAgendaScheduler };
});
logger.info({ numeros: bots.map(({ bot }) => bot.number || bot.id) }, 'Iniciando bots do WhatsApp');

for (const { whatsapp } of bots) await whatsapp.connect();

async function shutdown() {
  clearInterval(statsTimer);
  await saveStats();
  for (const { whatsapp, stopReminderScheduler, stopAgendaScheduler } of bots) {
    stopReminderScheduler();
    stopAgendaScheduler();
    await whatsapp.close();
  }
  await storage.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
