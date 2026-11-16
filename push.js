// GET    /api/push               -> { publicKey }            the key the browser needs to subscribe
// POST   /api/push  { subscription, prefs }                   subscribe, or update what you get notified for
// DELETE /api/push  { endpoint }                              unsubscribe
import { send, readBody } from '../lib/store.js';
import { readSubs, saveSubs, subId, cleanPrefs, validSubscription, pushReady } from '../lib/push.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!pushReady()) return send(res, 503, { error: 'not_configured' });
      return send(res, 200, { publicKey: process.env.VAPID_PUBLIC_KEY });
    }
    if (req.method === 'POST' || req.method === 'DELETE') {
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad_json' }); }
      const { subs, blobs } = await readSubs();
      if (req.method === 'DELETE') {
        const id = subId(body && body.endpoint);
        const next = subs.filter((s) => s.id !== id);
        if (next.length !== subs.length) await saveSubs(next, blobs);
        return send(res, 200, { ok: true });
      }
      if (!pushReady()) return send(res, 503, { error: 'not_configured' });
      const sub = body && body.subscription;
      if (!validSubscription(sub)) return send(res, 400, { error: 'bad_subscription' });
      const id = subId(sub.endpoint);
      const item = { id, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs: cleanPrefs(body.prefs), updatedAt: new Date().toISOString() };
      await saveSubs([...subs.filter((s) => s.id !== id), item], blobs);
      return send(res, 200, { ok: true, prefs: item.prefs });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    console.error('push api error:', err && err.message);
    return send(res, 500, { error: 'server_error' });
  }
}
