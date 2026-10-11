// Cloud sync API for the tracker (see SYNC.md). Every request needs the X-Sync-Passcode header.
//   GET    /api/sync?since=MS&from=YYYY-MM-DD&to=YYYY-MM-DD&day=YYYY-MM-DD  pull rows (tombstones included)
//   POST   /api/sync {entries:[{day,data,updated_at,deleted?,merge?}], kv:[{key,data,updated_at,deleted?}]}
//   DELETE /api/sync?day=YYYY-MM-DD  or  ?key=checkpoint:5k                  tombstone one item
// The database keeps the newer copy of each day/key (last write wins on updated_at).
//
// Two ways to reach the database:
//  - relay (default): forward the call to the tracker-sync Edge Function, which checks the passcode against
//    the hash stored in Supabase and runs the query with the key Supabase gives it. No secret lives on Vercel.
//  - direct: when SUPABASE_URL, SUPABASE_SERVICE_KEY and SYNC_PASSCODE are all set on Vercel, check the
//    passcode here and call the Postgres functions through Supabase REST with that key.
'use strict';
const crypto = require('crypto');

const RELAY_URL = process.env.SYNC_RELAY_URL || 'https://kkmpbpcbtmzivmpyypmz.supabase.co/functions/v1/tracker-sync';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PASSCODE = process.env.SYNC_PASSCODE || '';
const DIRECT = !!(SUPABASE_URL && SERVICE_KEY && PASSCODE);
// Pages allowed to call this API from another origin (the installed app runs from GitHub Pages).
const ALLOWED_ORIGINS = new Set(['https://jakerz11.github.io', 'https://road-to-st-george.vercel.app']);

const MAX_ENTRIES = 1000, MAX_KV = 100, MAX_ITEM_BYTES = 4096, MAX_BODY_BYTES = 1000000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

class HttpError extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail; }
}
const bad = msg => new HttpError(400, msg);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function cors(req, res) {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Passcode');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Constant time: compares SHA-256 digests, which always have the same length.
function samePasscode(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function day(s, name) {
  const d = typeof s === 'string' && DAY_RE.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== s) throw bad(`${name} must be a real date as YYYY-MM-DD`);
  return s;
}
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Milliseconds since 1970 (an ISO time string is accepted too).
function millis(v, name) {
  const n = typeof v === 'string' && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} must be milliseconds since 1970 or an ISO time`);
  return Math.round(n);
}
function payload(data, what) {
  if (!plainObject(data)) throw bad(`${what}: data must be an object`);
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_ITEM_BYTES) throw bad(`${what}: data is over ${MAX_ITEM_BYTES} bytes`);
  return data;
}
function cleanEntry(it, now) {
  if (!plainObject(it)) throw bad('each entry must be an object');
  const d = day(it.day, 'entry day'), deleted = it.deleted === true;
  const out = { day: d, updated_at: it.updated_at == null ? now : millis(it.updated_at, `${d} updated_at`), deleted };
  if (!deleted) {
    out.data = payload(it.data === undefined ? {} : it.data, d);
    if (it.merge === true) out.merge = true;
  }
  return out;
}
function cleanKv(it, now) {
  if (!plainObject(it)) throw bad('each kv item must be an object');
  if (typeof it.key !== 'string' || !KEY_RE.test(it.key)) throw bad(`kv key must match ${KEY_RE}`);
  const deleted = it.deleted === true;
  const out = { key: it.key, updated_at: it.updated_at == null ? now : millis(it.updated_at, `${it.key} updated_at`), deleted };
  if (!deleted) out.data = payload(it.data === undefined ? {} : it.data, it.key);
  return out;
}

async function readJson(req) {
  let body;
  try { body = req.body; } catch (e) { throw bad('body is not valid JSON'); } // Vercel parses JSON bodies lazily
  if (body === undefined) { // plain Node (local runs): read the stream
    body = await new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', c => { n += c.length; if (n <= MAX_BODY_BYTES) chunks.push(c); });
      req.on('end', () => (n > MAX_BODY_BYTES ? reject(new HttpError(413, 'body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    try { return JSON.parse(body); } catch (e) { throw bad('body is not valid JSON'); }
  }
  return body == null ? {} : body;
}

async function db(fn, args, passcode) {
  const headers = { 'Content-Type': 'application/json' };
  if (DIRECT) {
    headers.apikey = SERVICE_KEY;
    if (SERVICE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SERVICE_KEY}`; // legacy service_role JWT
  } else {
    headers['X-Sync-Passcode'] = passcode;
  }
  let r;
  try {
    r = await fetch(DIRECT ? `${SUPABASE_URL}/rest/v1/rpc/${fn}` : RELAY_URL, {
      method: 'POST', headers, body: JSON.stringify(DIRECT ? args : { fn, args }), signal: AbortSignal.timeout(9000),
    });
  } catch (e) {
    console.error(`sync: ${fn} unreachable: ${e && e.message}`);
    throw new HttpError(503, 'database unreachable');
  }
  const text = await r.text();
  if (r.status === 401 && !DIRECT) throw new HttpError(401, 'unauthorized');
  if (!r.ok) {
    let detail;
    try { const j = JSON.parse(text); detail = j.message || j.error; } catch (e) { /* not JSON */ }
    console.error(`sync: ${fn} failed with ${r.status}: ${text.slice(0, 300)}`);
    throw new HttpError(502, 'database error', detail);
  }
  return JSON.parse(text);
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  try {
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      throw new HttpError(405, 'method not allowed');
    }
    const passcode = req.headers['x-sync-passcode'];
    if (typeof passcode !== 'string' || !passcode) throw new HttpError(401, 'unauthorized');
    if (PASSCODE && !samePasscode(passcode, PASSCODE)) throw new HttpError(401, 'unauthorized');

    const q = new URL(req.url, 'http://localhost').searchParams;
    const now = Date.now();
    let out;
    if (req.method === 'GET') {
      let from = q.get('from'), to = q.get('to');
      if (q.get('day')) from = to = day(q.get('day'), 'day');
      if (from) day(from, 'from');
      if (to) day(to, 'to');
      if (from && to && from > to) throw bad('from is after to');
      const since = q.get('since') ? millis(q.get('since'), 'since') : null;
      out = await db('tracker_pull', { p_since: since, p_from: from || null, p_to: to || null }, passcode);
    } else if (req.method === 'POST') {
      const body = await readJson(req);
      if (!plainObject(body)) throw bad('body must be a JSON object');
      const entries = body.entries === undefined ? [] : body.entries, kv = body.kv === undefined ? [] : body.kv;
      if (!Array.isArray(entries) || !Array.isArray(kv)) throw bad('entries and kv must be arrays');
      if (entries.length > MAX_ENTRIES || kv.length > MAX_KV) throw new HttpError(413, `at most ${MAX_ENTRIES} entries and ${MAX_KV} kv items per request`);
      out = await db('tracker_push', { p_entries: entries.map(it => cleanEntry(it, now)), p_kv: kv.map(it => cleanKv(it, now)) }, passcode);
    } else {
      const d = q.get('day'), key = q.get('key');
      if (!d === !key) throw bad('DELETE needs ?day=YYYY-MM-DD or ?key=NAME');
      out = await db('tracker_push', d
        ? { p_entries: [{ day: day(d, 'day'), updated_at: now, deleted: true }], p_kv: [] }
        : { p_entries: [], p_kv: [cleanKv({ key, deleted: true }, now)] }, passcode);
    }
    send(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('sync: unexpected error', err);
    const e = err instanceof HttpError ? err : new HttpError(500, 'internal error');
    send(res, e.status, Object.assign({ ok: false, error: e.message }, e.detail ? { detail: e.detail } : {}));
  }
};
