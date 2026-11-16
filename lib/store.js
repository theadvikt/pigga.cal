// Small versioned JSON store on Vercel Blob: every save is a new file, the newest one wins,
// and the last few versions are kept as a safety net.
import { put, list, del } from '@vercel/blob';

const KEEP_VERSIONS = 5;

export async function readJson(prefix, empty) {
  const { blobs } = await list({ prefix, limit: 100 });
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!blobs.length) return { data: empty(), blobs };
  const r = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`blob read ${r.status}`);
  return { data: await r.json(), blobs };
}

export async function writeJson(prefix, data, blobs) {
  await put(`${prefix}${Date.now()}.json`, JSON.stringify(data), {
    access: 'public', addRandomSuffix: true, contentType: 'application/json', cacheControlMaxAge: 60,
  });
  const stale = (blobs || []).slice(KEEP_VERSIONS - 1).map((b) => b.url);
  if (stale.length) { try { await del(stale); } catch { /* best effort */ } }
}

export async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
    return req.body;
  }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
