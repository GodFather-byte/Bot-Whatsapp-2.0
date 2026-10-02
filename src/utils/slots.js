import { addDays, zonedDate, zonedParts } from './time.js';

const pad = (value) => String(value).padStart(2, '0');

// Segunda primeiro, para descrever horários como "segunda a sexta".
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const LONG_DAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** { year, month, day } -> "AAAA-MM-DD" */
export function dateKey({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "AAAA-MM-DD" -> { year, month, day }, ou null se não for uma data real. */
export function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const real = check.getUTCFullYear() === parts.year && check.getUTCMonth() === parts.month - 1 && check.getUTCDate() === parts.day;
  return real ? parts : null;
}

export function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekdayName(weekday) {
  return LONG_DAY_NAMES[weekday];
}

/** Dias de calendário entre duas datas ({ year, month, day }). */
export function daysBetween(from, to) {
  const utc = ({ year, month, day }) => Date.UTC(year, month - 1, day);
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** "9:30", "09h30" ou "09:30" -> minutos desde a meia-noite, ou null. */
export function parseClockMinutes(value) {
  const match = /^(\d{1,2})[:h](\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export function formatClock(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * Inícios possíveis (em minutos desde a meia-noite) de um dia, segundo as regras de horário.
 * Cada horário ocupa um intervalo inteiro de `stepMin` minutos, então dois agendamentos nunca se sobrepõem.
 */
export function daySlots(rules, parts, stepMin) {
  const weekday = weekdayOf(parts);
  const slots = new Set();
  for (const { dias, inicio, fim } of rules) {
    if (!dias.includes(weekday)) continue;
    for (let start = inicio; start + stepMin <= fim; start += stepMin) slots.add(start);
  }
  return [...slots].sort((left, right) => left - right);
}

/** Instante correspondente a uma data e a minutos desde a meia-noite, no fuso do estúdio. */
export function slotInstant(parts, minutes, timeZone) {
  return zonedDate({ ...parts, hour: Math.floor(minutes / 60), minute: minutes % 60 }, timeZone);
}

/** "quinta-feira, 02/10 às 14:30" */
export function formatWhen(date, timeZone) {
  const local = zonedParts(new Date(date), timeZone);
  return `${LONG_DAY_NAMES[local.weekday]}, ${pad(local.day)}/${pad(local.month)} às ${pad(local.hour)}:${pad(local.minute)}`;
}

/** "quinta-feira, 02/10" */
export function formatDay(parts) {
  return `${LONG_DAY_NAMES[weekdayOf(parts)]}, ${pad(parts.day)}/${pad(parts.month)}`;
}

function describeDays(days) {
  const ordered = WEEK_ORDER.filter((day) => days.includes(day));
  const runs = [];
  for (const day of ordered) {
    const last = runs.at(-1);
    if (last && WEEK_ORDER.indexOf(day) === WEEK_ORDER.indexOf(last.at(-1)) + 1) last.push(day);
    else runs.push([day]);
  }
  return runs.map((run) => {
    if (run.length === 1) return DAY_NAMES[run[0]];
    if (run.length === 2) return `${DAY_NAMES[run[0]]} e ${DAY_NAMES[run[1]]}`;
    return `${DAY_NAMES[run[0]]} a ${DAY_NAMES[run.at(-1)]}`;
  }).join(', ');
}

/** [{ dias, inicio, fim }] -> "segunda a sexta, das 09:00 às 19:00; sábado, das 09:00 às 14:00" */
export function describeHours(rules) {
  return rules.map(({ dias, inicio, fim }) =>
    `${describeDays(dias)}, das ${formatClock(inicio)} às ${formatClock(fim)}`).join('; ');
}

/**
 * Entende "hoje", "amanhã", "DD/MM", "DD/MM/AAAA" e "AAAA-MM-DD" e devolve { year, month, day }.
 * Sem o ano, vale o ano atual, ou o próximo se a data já passou.
 */
export function parseDateInput(input, now, timeZone) {
  const text = String(input ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const today = zonedParts(now, timeZone);
  if (text === 'hoje') return { year: today.year, month: today.month, day: today.day };
  if (text === 'amanha') return addDays(today, 1);
  if (text === 'depois de amanha') return addDays(today, 2);

  const iso = parseDateKey(text);
  if (iso) return iso;

  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(text);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[1]);
  if (match[3]) {
    return parseDateKey(`${match[3].length === 2 ? `20${match[3]}` : match[3]}-${pad(month)}-${pad(day)}`);
  }
  const thisYear = parseDateKey(`${today.year}-${pad(month)}-${pad(day)}`);
  if (!thisYear) return null;
  return daysBetween(today, thisYear) >= 0 ? thisYear : parseDateKey(`${today.year + 1}-${pad(month)}-${pad(day)}`);
}
