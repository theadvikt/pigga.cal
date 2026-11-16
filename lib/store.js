// Small versioned JSON store on Vercel Blob: every save is a new file, the newest one wins,
// and the last few versions are kept as a safety net.
// Works with both kinds of Blob store: private or public, and with either a
// BLOB_READ_WRITE_TOKEN or the newer automatic connection (BLOB_STORE_ID).
import { put, list, del, get } from '@vercel/blob';

const KEEP_VERSIONS = 5;
let ACCESS = process.env.BLOB_ACCESS || null; // 'private' or 'public', found automatically if not set

const accessError = (e) => /access|private|public/i.test(String(e && (e.message || e.name)));

async function withAccess(fn) {
  const order = ACCESS ? [ACCESS] : ['private', 'public'];
  let last;
  for (const a of order) {
    try { const r = await fn(a); ACCESS = a; return r; }
    catch (e) { last = e; if (!accessError(e)) throw e; }
  }
  throw last;
}

async function readText(pathname) {
  return withAccess(async (access) => {
    const r = await get(pathname, { access, useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) throw new Error('blob read failed');
    return await new Response(r.stream).text();
  });
}

export async function readJson(prefix, empty) {
  const { blobs } = await list({ prefix, limit: 100 });
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if (!blobs.length) return { data: empty(), blobs };
  return { data: JSON.parse(await readText(blobs[0].pathname)), blobs };
}

export async function writeJson(prefix, data, blobs) {
  const body = JSON.stringify(data);
  await withAccess((access) => put(`${prefix}${Date.now()}.json`, body, {
    access, addRandomSuffix: true, contentType: 'application/json', cacheControlMaxAge: 60,
  }));
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
