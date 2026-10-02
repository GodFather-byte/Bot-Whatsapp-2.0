import { createSign } from 'node:crypto';
import { business as studio, formatAddress, formatPrice } from '../business/botPhZeus.js';

const CRLF = '\r\n';

function eventTexts(appointment, business) {
  const lines = [
    `Cliente: ${appointment.clienteNome}`,
    appointment.clienteNumero && `WhatsApp: https://wa.me/${appointment.clienteNumero}`,
    `${appointment.protocolo}, ${appointment.duracaoMin} min, ${formatPrice(appointment.valor)}`,
    `Código: ${appointment.id}`
  ].filter(Boolean);
  return {
    summary: `Bronze: ${appointment.clienteNome} - ${appointment.protocolo} (${appointment.duracaoMin} min)`,
    description: lines.join('\n'),
    location: `${business.name}, ${formatAddress(business)}`
  };
}

// ---------- Arquivo .ics (iCalendar) ----------

const icsDate = (date) => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsEscape = (text) => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Linhas do iCalendar têm no máximo 75 bytes; o excesso continua na linha seguinte, iniciada por um espaço.
function foldLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      folded.push(current);
      current = ' ';
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  folded.push(current);
  return folded.join(CRLF);
}

/** Arquivo de calendário de um agendamento. Ao tocar nele no celular, o evento entra na agenda, com alarme. */
export function buildIcs(appointment, { business = studio, now = new Date() } = {}) {
  const { summary, description, location } = eventTexts(appointment, business);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bot PH Zeus//Agenda//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@botphzeus`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(appointment.inicio)}`,
    `DTEND:${icsDate(appointment.fim)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(location)}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(`Bronze em 30 minutos: ${appointment.clienteNome}`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].map(foldLine).join(CRLF) + CRLF;
}

// ---------- Google Agenda ----------

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** Lê a chave da conta de serviço: o JSON do Google, puro ou em base64 (mais fácil de colar em variáveis de ambiente). */
export function parseServiceAccount(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const text = value.startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
  let credentials;
  try {
    credentials = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON deve ser o JSON da conta de serviço do Google (puro ou em base64).');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON precisa ter client_email e private_key.');
  }
  return { clientEmail: credentials.client_email, privateKey: String(credentials.private_key).replace(/\\n/g, '\n') };
}

export function buildGoogleEvent(appointment, { business = studio, timeZone }) {
  const { summary, description, location } = eventTexts(appointment, business);
  return {
    summary,
    description,
    location,
    start: { dateTime: new Date(appointment.inicio).toISOString(), timeZone },
    end: { dateTime: new Date(appointment.fim).toISOString(), timeZone },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }] }
  };
}

/**
 * Cliente mínimo do Google Agenda para uma conta de serviço. A agenda precisa ser compartilhada com o
 * e-mail da conta de serviço, com permissão para fazer alterações em eventos.
 */
export function createGoogleCalendar({ calendarId, credentials, fetchImpl = fetch, now = () => Date.now(), timeoutMs = 8000 }) {
  let token = null;
  let tokenExpiresAt = 0;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

  async function describeFailure(response, action) {
    let detail = '';
    try {
      detail = (await response.json())?.error?.message || '';
    } catch {
      // resposta sem corpo JSON
    }
    return new Error(`${action} falhou: HTTP ${response.status}${detail ? ` (${detail})` : ''}.`);
  }

  async function accessToken() {
    if (token && now() < tokenExpiresAt - 60_000) return token;
    const issuedAt = Math.floor(now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: credentials.clientEmail,
      scope: CALENDAR_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey, 'base64url');
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw await describeFailure(response, 'Login no Google');
    const body = await response.json();
    token = body.access_token;
    tokenExpiresAt = now() + (body.expires_in || 3600) * 1000;
    return token;
  }

  async function call(method, path, body) {
    return fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  return {
    async createEvent(event) {
      const response = await call('POST', '/events', event);
      if (!response.ok) throw await describeFailure(response, 'Criar evento no Google Agenda');
      return (await response.json()).id;
    },
    async deleteEvent(eventId) {
      const response = await call('DELETE', `/events/${encodeURIComponent(eventId)}`);
      // 404/410: o evento já não existe (por exemplo, a dona apagou), então o objetivo foi cumprido.
      if (!response.ok && ![404, 410].includes(response.status)) throw await describeFailure(response, 'Apagar evento no Google Agenda');
    }
  };
}
