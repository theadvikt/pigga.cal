// Push notifications: subscriptions live in Vercel Blob, messages go out with web-push (VAPID).
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from './store.js';

export const SUBS_PREFIX = 'pigga-calendar/subs-';
export const DEFAULT_PREFS = { events: true, birthdays: true, newEvents: false, dayBefore: false };
const MAX_SUBS = 1000;

export const subId = (endpoint) => createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);

export function cleanPrefs(p) {
  const o = {};
  for (const k of Object.keys(DEFAULT_PREFS)) o[k] = p && typeof p[k] === 'boolean' ? p[k] : DEFAULT_PREFS[k];
  return o;
}

export function validSubscription(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000) return false;
  const k = s.keys || {};
  return typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh.length < 200 && k.auth.length < 100;
}

export function pushReady() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function configure() {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:pigga@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

export async function readSubs() {
  const { data, blobs } = await readJson(SUBS_PREFIX, () => ({ subs: [] }));
  return { subs: Array.isArray(data.subs) ? data.subs : [], blobs };
}
export async function saveSubs(subs, blobs) {
  await writeJson(SUBS_PREFIX, { subs: subs.slice(-MAX_SUBS), updatedAt: new Date().toISOString() }, blobs);
}

// Send one payload to every subscription that `wants` it. Dead subscriptions (404/410) are removed.
export async function broadcast(wants, payload) {
  if (!pushReady()) return { sent: 0, skipped: 'not_configured' };
  configure();
  const { subs, blobs } = await readSubs();
  const targets = subs.filter((s) => wants(cleanPrefs(s.prefs)));
  const dead = new Set();
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 12 * 3600 }); sent++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.add(s.id); }
  }));
  if (dead.size) { try { await saveSubs(subs.filter((s) => !dead.has(s.id)), blobs); } catch { /* retry next time */ } }
  return { sent, removed: dead.size };
}
