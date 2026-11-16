// Daily notifications, run by Vercel Cron (see vercel.json).
//   /api/cron?slot=morning  (about 8:00 IST)  -> "today: …" for events and birthdays
//   /api/cron?slot=evening  (about 19:00 IST) -> "tomorrow: …" for people who turned on day-before reminders
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else is refused.
import { send } from '../lib/store.js';
import { readJson } from '../lib/store.js';
import { broadcast } from '../lib/push.js';

const YEARLY = [
  { month: 10, day: 1, title: 'dilip day' },
  { month: 10, day: 3, title: 'pigga day' },
];

const istDate = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function itemsFor(date, events, birthdays) {
  const [y, m, d] = date.split('-').map(Number);
  const ev = events.filter((e) => e.start === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    .map((e) => (e.time ? `${e.title} at ${e.time}` : e.title));
  const bd = birthdays.filter((b) => b.month === m && (b.day === d || (b.month === 2 && b.day === 29 && d === 28 && !isLeap(y))))
    .map((b) => `${b.name}'s bday 🎂`);
  const days = YEARLY.filter((x) => x.month === m && x.day === d).map((x) => x.title);
  return { ev, bd: [...days, ...bd] };
}

export function message(when, ev, bd, prefs) {
  const parts = [...(prefs.events ? ev : []), ...(prefs.birthdays ? bd : [])];
  if (!parts.length) return null;
  return { title: `${when}: ${parts.length === 1 ? parts[0] : parts.length + ' things'}`, body: parts.length === 1 ? 'tap to open the pigga calendar' : parts.join(' · '), url: '/' };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'unauthorized' });
  try {
    const slot = new URL(req.url, 'http://x').searchParams.get('slot') === 'evening' ? 'evening' : 'morning';
    const { data } = await readJson('pigga-calendar/v2-', () => ({ events: [], birthdays: [] }));
    const events = Array.isArray(data.events) ? data.events : [];
    const birthdays = Array.isArray(data.birthdays) ? data.birthdays : [];
    const date = istDate(slot === 'evening' ? 1 : 0);
    const { ev, bd } = itemsFor(date, events, birthdays);
    if (!ev.length && !bd.length) return send(res, 200, { ok: true, date, sent: 0 });
    const when = slot === 'evening' ? 'tomorrow' : 'today';
    // Each person gets one message built from the kinds they chose.
    const groups = [
      [{ events: true, birthdays: true }, (p) => p.events && p.birthdays],
      [{ events: true, birthdays: false }, (p) => p.events && !p.birthdays],
      [{ events: false, birthdays: true }, (p) => !p.events && p.birthdays],
    ];
    let sent = 0;
    for (const [kinds, match] of groups) {
      const msg = message(when, ev, bd, kinds);
      if (!msg) continue;
      const r = await broadcast((p) => match(p) && (slot === 'morning' || p.dayBefore), msg);
      sent += r.sent || 0;
    }
    return send(res, 200, { ok: true, date, sent });
  } catch (err) {
    console.error('cron error:', err && err.message);
    return send(res, 500, { error: 'server_error' });
  }
}
