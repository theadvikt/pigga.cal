// Pigga Calendar shared API (Vercel serverless function + Vercel Blob)
//
// GET    /api/calendar                 -> { events, birthdays, updatedAt }        public
// POST   /api/calendar  {kind:'event', event:{...}}                              anyone, 1 per hour + 2 per day per network
// POST   /api/calendar  {kind:'birthday', name, month, day}                      anyone, max 3 per network
// DELETE /api/calendar?id=<id>          header x-owner-key                        owner only
// PUT    /api/calendar                  headers x-owner-key + x-verify-only: 1    owner key check, writes nothing
//
// The owner key lives only in process.env.OWNER_KEY. It is never logged or returned.

import { readJson, writeJson } from '../lib/store.js';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { broadcast } from '../lib/push.js';

const PREFIX = 'pigga-calendar/v2-';
const HOUR = 3600 * 1000;
const DAY_MAX = 2;
const MAX_EVENTS = 1000;
const MAX_BIRTHDAYS = 300;
const BIRTHDAYS_PER_NETWORK = 3;
const COLORS = new Set(['neon', 'pink', 'green', 'red', 'white']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_RE = /^[\p{L}\p{N} .'_-]{1,30}$/u;
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function realDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2200) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function cleanText(s, max) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function validateEvent(e) {
  if (!e || typeof e !== 'object') return { error: 'bad event' };
  const title = cleanText(e.title, 80);
  if (!title) return { error: 'title must be 1–80 characters' };
  if (!realDate(e.start)) return { error: 'start is not a real date' };
  const end = e.end ? e.end : e.start;
  if (!realDate(end) || end < e.start) return { error: 'end must be a real date on or after start' };
  const days = (Date.parse(end) - Date.parse(e.start)) / 864e5;
  if (days > 31) return { error: 'events can be at most 32 days long' };
  const time = e.time == null || e.time === '' ? null : e.time;
  if (time !== null && (typeof time !== 'string' || !TIME_RE.test(time))) return { error: 'bad time' };
  if (!COLORS.has(e.color)) return { error: 'bad color' };
  const note = typeof e.note === 'string' ? e.note.trim().slice(0, 500) : '';
  return { event: { title, start: e.start, end, time, color: e.color, note } };
}

function validateBirthday(b) {
  const name = cleanText(b && b.name, 30);
  if (!name || !NAME_RE.test(name)) return { error: 'name must be 1–30 letters or numbers' };
  const month = Number(b.month), day = Number(b.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: 'bad month' };
  if (!Number.isInteger(day) || day < 1 || day > MONTH_DAYS[month - 1]) return { error: 'bad day' };
  return { birthday: { name, month, day } };
}

function ownerOk(given) {
  const secret = process.env.OWNER_KEY;
  if (!secret) return null;
  if (typeof given !== 'string' || !given || given.length > 512) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

// A salted hash of the sender's IP, used only for the spam limits. The raw IP is never stored.
function networkId(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  return createHash('sha256').update((process.env.OWNER_KEY || 'pigga') + '|' + ip).digest('hex').slice(0, 20);
}

async function readCurrent() {
  const { data, blobs } = await readJson(PREFIX, () => ({ events: [], birthdays: [] }));
  return {
    events: Array.isArray(data.events) ? data.events : [],
    birthdays: Array.isArray(data.birthdays) ? data.birthdays : [],
    updatedAt: data.updatedAt || null,
    blobs,
  };
}

async function write(cur, events, birthdays) {
  const updatedAt = new Date().toISOString();
  await writeJson(PREFIX, { events, birthdays, updatedAt }, cur.blobs);
  return updatedAt;
}

// What the public sees: no network ids.
const publicView = (events, birthdays, updatedAt) => ({
  events: events.map(({ net, ...e }) => e),
  birthdays: birthdays.map(({ net, ...b }) => b),
  updatedAt,
});

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
    return req.body;
  }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const cur = await readCurrent();
      return send(res, 200, req.method === 'HEAD' ? undefined : publicView(cur.events, cur.birthdays, cur.updatedAt));
    }

    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad_json' }); }
      const net = networkId(req);
      const now = Date.now();
      const cur = await readCurrent();

      if (body && body.kind === 'event') {
        const v = validateEvent(body.event);
        if (v.error) return send(res, 400, { error: 'invalid', detail: v.error });
        // 1 per hour and 2 per day (India time) from the same internet connection
        const mine = cur.events.filter((e) => e.net === net).map((e) => Date.parse(e.createdAt) || 0);
        const istDay = (t) => new Date(t + 5.5 * HOUR).toISOString().slice(0, 10);
        const today = istDay(now);
        if (mine.filter((t) => istDay(t) === today).length >= DAY_MAX) {
          const mid = new Date(now + 5.5 * HOUR); mid.setUTCHours(24, 0, 0, 0);
          return send(res, 429, { error: 'rate_limited', rule: 'day', retryAfterMs: mid.getTime() - 5.5 * HOUR - now });
        }
        const last = mine.reduce((m, t) => Math.max(m, t), 0);
        if (last && now - last < HOUR) return send(res, 429, { error: 'rate_limited', rule: 'hour', retryAfterMs: HOUR - (now - last) });
        if (cur.events.length >= MAX_EVENTS) return send(res, 507, { error: 'full' });
        const item = { id: randomUUID(), ...v.event, createdAt: new Date(now).toISOString(), net };
        const events = [...cur.events, item];
        const updatedAt = await write(cur, events, cur.birthdays);
        // Tell people who turned on "new event added". Never wait more than 4 seconds for it.
        const [, mm, dd] = item.start.split('-').map(Number);
        const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        await Promise.race([
          broadcast((p) => p.newEvents, { title: `new on the calendar: ${item.title}`, body: `${dd} ${MON[mm - 1]}${item.time ? ' at ' + item.time : ''} · tap to open`, url: '/' }).catch(() => {}),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
        return send(res, 200, { ok: true, id: item.id, ...publicView(events, cur.birthdays, updatedAt) });
      }

      if (body && body.kind === 'birthday') {
        const v = validateBirthday(body);
        if (v.error) return send(res, 400, { error: 'invalid', detail: v.error });
        if (cur.birthdays.filter((b) => b.net === net).length >= BIRTHDAYS_PER_NETWORK) return send(res, 409, { error: 'birthday_limit' });
        if (cur.birthdays.length >= MAX_BIRTHDAYS) return send(res, 507, { error: 'full' });
        const item = { id: randomUUID(), ...v.birthday, createdAt: new Date(now).toISOString(), net };
        const birthdays = [...cur.birthdays, item];
        const updatedAt = await write(cur, cur.events, birthdays);
        return send(res, 200, { ok: true, id: item.id, ...publicView(cur.events, birthdays, updatedAt) });
      }
      return send(res, 400, { error: 'unknown_kind' });
    }

    if (req.method === 'DELETE' || req.method === 'PUT') {
      const ok = ownerOk(req.headers['x-owner-key']);
      if (ok === null) return send(res, 500, { error: 'not_configured' });
      if (!ok) return send(res, 401, { error: 'unauthorized' });
      if (req.method === 'PUT') return send(res, 204);
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      if (!id) return send(res, 400, { error: 'missing_id' });
      const cur = await readCurrent();
      const events = cur.events.filter((e) => e.id !== id);
      const birthdays = cur.birthdays.filter((b) => b.id !== id);
      if (events.length === cur.events.length && birthdays.length === cur.birthdays.length) return send(res, 404, { error: 'not_found' });
      const updatedAt = await write(cur, events, birthdays);
      return send(res, 200, { ok: true, ...publicView(events, birthdays, updatedAt) });
    }

    res.setHeader('Allow', 'GET, HEAD, POST, PUT, DELETE');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    console.error('calendar api error:', err && err.message); // never logs headers, keys or bodies
    return send(res, 500, { error: 'server_error' });
  }
}
