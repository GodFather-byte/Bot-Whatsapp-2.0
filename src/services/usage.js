import { formatDateTime, zonedDate, zonedParts } from '../utils/time.js';

// A cota diária do Gemini zera à meia-noite do horário do Pacífico.
const QUOTA_TIME_ZONE = 'America/Los_Angeles';

const pad = (value) => String(value).padStart(2, '0');
const formatNumber = (value) => (value || 0).toLocaleString('pt-BR');

export function quotaDay(date) {
  const { year, month, day } = zonedParts(date, QUOTA_TIME_ZONE);
  return `${year}-${pad(month)}-${pad(day)}`;
}

function previousDays(date, count) {
  const { year, month, day } = zonedParts(date, QUOTA_TIME_ZONE);
  return Array.from({ length: count }, (_, offset) => {
    const value = new Date(Date.UTC(year, month - 1, day - offset));
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  });
}

function nextReset(date) {
  const { year, month, day } = zonedParts(date, QUOTA_TIME_ZONE);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return zonedDate({
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate()
  }, QUOTA_TIME_ZONE);
}

function sum(entries) {
  const total = { requests: 0, promptTokens: 0, outputTokens: 0, limitErrors: 0 };
  for (const entry of entries) {
    for (const key of Object.keys(total)) total[key] += entry?.[key] || 0;
  }
  return total;
}

function describe(label, total) {
  return [
    `*${label}:* ${formatNumber(total.requests)} chamadas — ${formatNumber(total.promptTokens + total.outputTokens)} tokens`,
    `  (entrada ${formatNumber(total.promptTokens)}, saída ${formatNumber(total.outputTokens)})`,
    total.limitErrors ? `  Erros de limite (429): ${formatNumber(total.limitErrors)}` : ''
  ].filter(Boolean).join('\n');
}

// Conta localmente o uso da API do Gemini, já que o Google não oferece uma API para consultar a cota.
export function createUsageTracker({ storage, logger, now = () => new Date() }) {
  return {
    record({ model, usage, rateLimited = false }) {
      const changes = rateLimited
        ? { limitErrors: 1 }
        : {
          requests: 1,
          promptTokens: usage?.promptTokenCount || 0,
          outputTokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
          [`modelos.${String(model || 'desconhecido').replace(/[.$]/g, '_')}`]: 1
        };
      storage.incrementUsage(quotaDay(now()), changes)
        .catch((error) => logger.warn({ err: error }, 'Falha ao registrar uso da API'));
    },

    async report({ dailyLimit, timeZone }) {
      const current = now();
      const days = previousDays(current, 31);
      const usage = await storage.getUsage(days);
      const today = usage[days[0]] || {};
      const month = days.filter((day) => day.slice(0, 7) === days[0].slice(0, 7));
      const todayTotal = sum([today]);
      const models = Object.entries(today.modelos || {})
        .map(([name, count]) => `  ${name.replace(/_/g, '.')}: ${formatNumber(count)}`);

      return [
        '📊 *Uso da API do Gemini* (contado pelo bot, todos os números juntos)',
        '',
        describe('Hoje', todayTotal),
        dailyLimit ? `  Limite diário: ${formatNumber(todayTotal.requests)} de ${formatNumber(dailyLimit)} (${Math.round((todayTotal.requests / dailyLimit) * 100)}%)` : '',
        models.length ? `  Por modelo:\n${models.join('\n')}` : '',
        '',
        describe('Últimos 7 dias', sum(days.slice(0, 7).map((day) => usage[day]))),
        describe('Este mês', sum(month.map((day) => usage[day]))),
        '',
        `A cota diária zera em ${formatDateTime(nextReset(current), timeZone)} (meia-noite no horário do Pacífico).`,
        'Números oficiais: https://aistudio.google.com/usage'
      ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n').trim();
    }
  };
}
