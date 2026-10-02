const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ALIASES = {
  dom: 0, domingo: 0,
  seg: 1, segunda: 1,
  ter: 2, terca: 2,
  qua: 3, quarta: 3,
  qui: 4, quinta: 4,
  sex: 5, sexta: 5,
  sab: 6, sabado: 6
};
export const WEEKDAY_LABELS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function stripAccents(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Data e hora "de parede" de um instante em um fuso horário IANA.
export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAY_NAMES.indexOf(get('weekday'))
  };
}

// Converte data e hora "de parede" em um fuso para o instante correspondente.
export function zonedDate({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shown = zonedParts(new Date(guess), timeZone);
    guess += target - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
  }
  return new Date(guess);
}

export function addDays({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function formatDateTime(date, timeZone) {
  return new Date(date).toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });
}

function parseClock(hours, minutes) {
  const hour = Number(hours);
  const minute = Number(minutes);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function nextOccurrence(recurrence, after, timeZone) {
  const today = zonedParts(after, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = addDays(today, offset);
    const candidate = zonedDate({ ...day, hour: recurrence.hora, minute: recurrence.minuto }, timeZone);
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    if (recurrence.tipo === 'semanal' && weekday !== recurrence.diaSemana) continue;
    if (candidate > after) return candidate;
  }
  return null;
}

const CLOCK = '(\\d{1,2})[:h](\\d{2})';

/**
 * Entende: "HH:mm", "hoje HH:mm", "amanhã HH:mm", "DD/MM[/AAAA] HH:mm",
 * "em N min|h", "todo dia HH:mm" e "toda segunda HH:mm", seguidos da mensagem.
 */
export function parseReminder(input, now, timeZone) {
  const text = stripAccents(input.trim());
  const original = input.trim();
  const messageFrom = (match) => original.slice(match[0].length - match.at(-1).length).trim();
  const today = zonedParts(now, timeZone);
  let match;

  if ((match = text.match(/^em\s+(\d+)\s*(min|mins|minuto|minutos|m|h|hr|hrs|hora|horas)\s+([\s\S]+)$/i))) {
    const amount = Number(match[1]);
    const minutes = /^h/i.test(match[2]) ? amount * 60 : amount;
    if (!amount || minutes > 60 * 24 * 365) return null;
    return { agendadoPara: new Date(now.getTime() + minutes * 60_000), mensagem: messageFrom(match) };
  }

  if ((match = text.match(new RegExp(`^tod[oa]\\s+dia\\s+${CLOCK}\\s+([\\s\\S]+)$`, 'i')))) {
    const clock = parseClock(match[1], match[2]);
    if (!clock) return null;
    const recorrencia = { tipo: 'diaria', hora: clock.hour, minuto: clock.minute };
    return { agendadoPara: nextOccurrence(recorrencia, now, timeZone), mensagem: messageFrom(match), recorrencia };
  }

  if ((match = text.match(new RegExp(`^tod[oa]s?\\s+(?:as\\s+|os\\s+)?([a-z]+)(?:-feira)?s?\\s+${CLOCK}\\s+([\\s\\S]+)$`, 'i')))) {
    const name = match[1].toLowerCase();
    const diaSemana = DAY_ALIASES[name] ?? DAY_ALIASES[name.replace(/s$/, '')];
    const clock = parseClock(match[2], match[3]);
    if (diaSemana === undefined || !clock) return null;
    const recorrencia = { tipo: 'semanal', diaSemana, hora: clock.hour, minuto: clock.minute };
    return { agendadoPara: nextOccurrence(recorrencia, now, timeZone), mensagem: messageFrom(match), recorrencia };
  }

  let day;
  let clock;
  if ((match = text.match(new RegExp(`^(hoje\\s+|amanha\\s+)?${CLOCK}\\s+([\\s\\S]+)$`, 'i')))) {
    day = match[1]?.toLowerCase().startsWith('amanha') ? addDays(today, 1) : today;
    clock = parseClock(match[2], match[3]);
  } else if ((match = text.match(new RegExp(`^(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2}|\\d{4}))?\\s+${CLOCK}\\s+([\\s\\S]+)$`, 'i')))) {
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : today.year;
    day = { year, month: Number(match[2]), day: Number(match[1]) };
    clock = parseClock(match[4], match[5]);
    const check = new Date(Date.UTC(day.year, day.month - 1, day.day));
    if (check.getUTCMonth() !== day.month - 1 || check.getUTCDate() !== day.day) return null;
    if (!match[3] && clock && zonedDate({ ...day, ...clock }, timeZone) <= now) day = { ...day, year: day.year + 1 };
  } else {
    return null;
  }
  if (!clock) return null;
  const agendadoPara = zonedDate({ ...day, ...clock }, timeZone);
  if (agendadoPara <= now) return null;
  return { agendadoPara, mensagem: messageFrom(match) };
}

function toMinutes(clock) {
  const match = clock.match(/^(\d{1,2})[:h](\d{2})$/);
  const parsed = match && parseClock(match[1], match[2]);
  if (!parsed) throw new Error(`Horário inválido: ${clock}`);
  return parsed.hour * 60 + parsed.minute;
}

function parseDays(spec) {
  const text = stripAccents(spec.toLowerCase());
  if (['todos', 'todo-dia', 'diario'].includes(text)) return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set();
  for (const item of text.split(',')) {
    const [start, end] = item.split('-').map((name) => DAY_ALIASES[name.replace(/-feira$/, '')]);
    if (start === undefined || (item.includes('-') && end === undefined)) throw new Error(`Dia inválido: ${item}`);
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (end === undefined || day === end) break;
    }
  }
  return [...days];
}

/** Ex.: "seg-sex 09:00-18:00; sab 09:00-13:00" */
export function parseBusinessHours(spec) {
  return spec.split(';').map((rule) => rule.trim()).filter(Boolean).map((rule) => {
    const match = rule.match(/^(\S+)\s+(\S+)-(\S+)$/);
    if (!match) throw new Error(`Regra inválida: "${rule}". Use, por exemplo, seg-sex 09:00-18:00.`);
    const inicio = toMinutes(match[2]);
    const fim = toMinutes(match[3]);
    if (fim <= inicio) throw new Error(`O fim deve ser depois do início em "${rule}".`);
    return { dias: parseDays(match[1]), inicio, fim };
  });
}

export function isWithinBusinessHours(rules, now, timeZone) {
  const local = zonedParts(now, timeZone);
  const minutes = local.hour * 60 + local.minute;
  return rules.some(({ dias, inicio, fim }) => dias.includes(local.weekday) && minutes >= inicio && minutes < fim);
}
