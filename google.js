// Utilitários partilhados: autenticação Google (conta de serviço) + regras de horário.
const crypto = require('crypto');

const TZ = 'Europe/Lisbon';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'bsb.rehab@gmail.com';

// Regras de horário (editar aqui se mudarem)
const RULES = {
  weekday: 3,          // 0=Dom ... 3=Quarta
  start: '18:00',
  end: '19:30',        // o último atendimento termina às 19:30
  duration: 20,        // minutos por atleta
  weeksAhead: 4        // quantas semanas à frente se pode marcar
};

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function allSlots() {
  const out = [];
  for (let m = toMin(RULES.start); m + RULES.duration <= toMin(RULES.end); m += RULES.duration) out.push(toHHMM(m));
  return out;
}

// --- Fuso horário Europe/Lisbon (trata de hora de verão automaticamente) ---
function tzOffsetMs(utcMs) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

function lisbonToUtcMs(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

function todayLisbon() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

function validateDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return 'Data inválida.';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return 'Data inválida.';
  if (dt.getUTCDay() !== RULES.weekday) return 'As marcações são apenas às quartas-feiras.';
  const today = todayLisbon();
  const [ty, tm, td] = today.split('-').map(Number);
  const diffDays = Math.round((dt - Date.UTC(ty, tm - 1, td)) / 86400000);
  if (diffDays < 0) return 'Essa data já passou.';
  if (diffDays > RULES.weeksAhead * 7) return 'Data demasiado distante.';
  return null;
}

// --- Google OAuth com conta de serviço (sem dependências externas) ---
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Variáveis GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY em falta.');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key);
  const jwt = `${header}.${claim}.${b64url(signature)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth: ${data.error_description || data.error}`);
  return data.access_token;
}

async function gcal(path, token, options = {}) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${data.error?.message || 'erro'}`);
  return data;
}

// Intervalos ocupados (inclui eventos que o fisioterapeuta crie manualmente no calendário)
async function getBusy(token, dateStr) {
  const timeMin = new Date(lisbonToUtcMs(dateStr, '00:00')).toISOString();
  const timeMax = new Date(lisbonToUtcMs(dateStr, '23:59')).toISOString();
  const data = await gcal('/freeBusy', token, {
    method: 'POST',
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: CALENDAR_ID }] })
  });
  return (data.calendars?.[CALENDAR_ID]?.busy || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
}

function isFree(busy, dateStr, time) {
  const s = lisbonToUtcMs(dateStr, time);
  const e = s + RULES.duration * 60000;
  if (s <= Date.now()) return false;
  return !busy.some(([bs, be]) => s < be && e > bs);
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

module.exports = { TZ, CALENDAR_ID, RULES, allSlots, toMin, toHHMM, validateDate, getAccessToken, gcal, getBusy, isFree, json };
