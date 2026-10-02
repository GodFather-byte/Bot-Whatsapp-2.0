import dotenv from 'dotenv';

dotenv.config();

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

function parseAllowedNumbers(value = '', variable = 'WHATSAPP_ALLOWED_NUMBERS') {
  if (!value.trim()) return [];

  let numbers;
  if (value.trim().startsWith('[')) {
    try {
      numbers = JSON.parse(value);
    } catch {
      throw new Error(`${variable} deve ser JSON válido ou uma lista separada por vírgulas.`);
    }
    if (!Array.isArray(numbers) || numbers.some((number) => typeof number !== 'string')) {
      throw new Error(`${variable} deve conter uma lista de números em texto.`);
    }
  } else {
    numbers = value.split(',');
  }

  return numbers.map((number) => number.replace(/\D/g, '')).filter(Boolean);
}

function nonNegativeInteger(value, fallback, variable) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${variable} deve ser um número inteiro maior ou igual a zero.`);
  }
  return parsed;
}

function parseTimeZone(value) {
  const timeZone = value || 'America/Sao_Paulo';
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone });
  } catch {
    throw new Error(`FUSO_HORARIO inválido: ${timeZone}. Use um fuso IANA, como America/Sao_Paulo.`);
  }
  return timeZone;
}

function positiveInteger(value, fallback, variable) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${variable} deve ser um número inteiro positivo.`);
  }
  return parsed;
}

// Hora do dia (0-23) em que a dona recebe o resumo da agenda. Vazio usa 8h; "desligado" não envia.
function parseSummaryHour(value) {
  if (value === undefined || value.trim() === '') return 8;
  if (['desligado', 'desligar', 'off', 'false', 'nao', 'não'].includes(value.trim().toLowerCase())) return null;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('AGENDA_RESUMO_HORA deve ser uma hora entre 0 e 23, ou "desligado".');
  }
  return hour;
}

export function loadConfig(env = process.env) {
  const port = positiveInteger(env.PORT, 3000, 'PORT');
  const reminderCheckInterval = positiveInteger(
    env.REMINDER_CHECK_INTERVAL,
    60_000,
    'REMINDER_CHECK_INTERVAL'
  );
  const maxTokens = positiveInteger(env.GEMINI_MAX_TOKENS, 2048, 'GEMINI_MAX_TOKENS');
  const geminiTimeout = positiveInteger(env.GEMINI_TIMEOUT, 30_000, 'GEMINI_TIMEOUT');
  const botNumbers = [...new Set(env.NUMEROS_BOT
    ? parseAllowedNumbers(env.NUMEROS_BOT, 'NUMEROS_BOT')
    : parseAllowedNumbers(env.NUMERO_BOT, 'NUMERO_BOT'))];
  // Sem número configurado, o bot usa a sessão e os dados no formato antigo (um único número).
  const bots = botNumbers.length
    ? botNumbers.map((number) => ({ id: number, number }))
    : [{ id: 'principal', number: '' }];

  return {
    port,
    nodeEnv: env.NODE_ENV || 'development',
    logLevel: env.LOG_LEVEL || 'info',
    bots,
    ownerNumbers: parseAllowedNumbers(env.NUMERO_DONO, 'NUMERO_DONO'),
    timeZone: parseTimeZone(env.FUSO_HORARIO),
    messageDebounceMs: nonNegativeInteger(env.JUNTAR_MENSAGENS_MS, 2500, 'JUNTAR_MENSAGENS_MS'),
    groupsEnabled: parseBoolean(env.GRUPOS_ATIVADOS, true),
    allowedNumbers: parseAllowedNumbers(env.WHATSAPP_ALLOWED_NUMBERS),
    allowedNumbersConfigured: env.WHATSAPP_ALLOWED_NUMBERS !== undefined,
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    geminiMaxTokens: maxTokens,
    geminiTimeout,
    geminiDailyLimit: nonNegativeInteger(env.GEMINI_LIMITE_DIARIO, 0, 'GEMINI_LIMITE_DIARIO'),
    mongoUri: env.MONGODB_URI || '',
    mongoDbName: env.MONGODB_DB_NAME || 'whatsapp-gemini-bot',
    dashboardEnabled: parseBoolean(env.DASHBOARD_ENABLED, false),
    dashboardAuthToken: env.DASHBOARD_AUTH_TOKEN || '',
    reminderCheckInterval,
    agenda: {
      stepMin: positiveInteger(env.AGENDA_INTERVALO_MIN, 30, 'AGENDA_INTERVALO_MIN'),
      minNoticeMin: nonNegativeInteger(env.AGENDA_ANTECEDENCIA_MIN, 60, 'AGENDA_ANTECEDENCIA_MIN'),
      daysAhead: positiveInteger(env.AGENDA_DIAS_A_FRENTE, 30, 'AGENDA_DIAS_A_FRENTE'),
      maxPerClient: positiveInteger(env.AGENDA_MAX_POR_CLIENTE, 2, 'AGENDA_MAX_POR_CLIENTE'),
      summaryHour: parseSummaryHour(env.AGENDA_RESUMO_HORA)
    },
    googleCalendarId: env.GOOGLE_CALENDAR_ID || '',
    googleServiceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    toolApiKeys: {
      weather: env.TOOL_WEATHER_API_KEY || '',
      news: env.TOOL_NEWS_API_KEY || '',
      exchangeRate: env.TOOL_EXCHANGE_RATE_API_KEY || ''
    }
  };
}

export const config = loadConfig();
