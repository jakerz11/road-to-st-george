#!/usr/bin/env node
// Hans's command line for Jake's shared training log (the Road to UVM tracker). Node 18+, no dependencies.
// Talks to /api/sync; the phone picks up every change on its next sync. Commands and examples: HANS.md.
//
// Config: API_URL and SYNC_PASSCODE from the environment; anything missing is read from SYNC_ENV_FILE,
// ~/.config/uvm-tracker/sync.env or /home/box/.config/uvm-tracker/sync.env (KEY=value lines).
// Exit codes: 0 ok, 1 not found, 2 bad arguments, 3 API, network or passcode problem.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `Usage: node scripts/hans-sync.mjs <command>
  list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json] [--deleted]   entries in a range (default: last 14 days)
  get DATE                                                          one day's entry as JSON
  upsert DATE --json '{"done":true,"actualDist":3.1}'               merge fields into a day (null removes a field)
  delete DATE                                                       delete a day's entry
  checkpoint 5k|10k|half TIME                                       set a result: seconds, mm:ss or h:mm:ss ("clear" removes it)
  checkpoints [--json]                                              show checkpoint results
Entry fields: done, rating (0-10), actualDist (miles), actualTime (minutes, or "mm:ss"/"h:mm:ss"),
upgrade, strength, pain (true/false), note (max 500 chars), src.`;

// Same plausible ranges the app accepts for checkpoint results (seconds).
const CHECKPOINTS = { '5k': [600, 3600], '10k': [1200, 7200], half: [3000, 14400] };
const BOOL = v => typeof v === 'boolean';
const FIELDS = {
  done: [BOOL, 'true or false'],
  rating: [v => Number.isInteger(v) && v >= 0 && v <= 10, 'a whole number 0-10'],
  actualDist: [v => typeof v === 'number' && v >= 0 && v < 200, 'miles as a number'],
  actualTime: [v => typeof v === 'number' && v >= 0 && v < 2000, 'minutes as a number, or "mm:ss" / "h:mm:ss"'],
  upgrade: [BOOL, 'true or false'],
  strength: [BOOL, 'true or false'],
  pain: [BOOL, 'true or false'],
  note: [v => typeof v === 'string' && v.length <= 500, 'text up to 500 characters'],
  src: [v => typeof v === 'string' && v.length <= 20, 'a short tag like "hans"'],
};

class CliError extends Error { constructor(code, message) { super(message); this.code = code; } }
const usage = msg => new CliError(2, `${msg}\n\n${USAGE}`); // a malformed command
const invalid = msg => new CliError(2, msg);                     // a well-formed command with a bad value

function loadEnvFile() {
  const files = [process.env.SYNC_ENV_FILE, join(homedir(), '.config/uvm-tracker/sync.env'), '/home/box/.config/uvm-tracker/sync.env'];
  for (const file of files.filter(Boolean)) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const v = /^(["']).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2];
      if (process.env[m[1]] === undefined) process.env[m[1]] = v; // the real environment wins
    }
    return;
  }
}

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (['json', 'deleted'].includes(k) && inline === undefined && (k !== 'json' || pos[0] !== 'upsert')) { opt[k] = true; continue; }
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) throw usage(`--${k} needs a value`);
    opt[k] = v;
  }
  return { pos, opt };
}

function isoDay(s, what = 'DATE') {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== s) throw invalid(`${what} must be a real date as YYYY-MM-DD (got ${JSON.stringify(s)})`);
  return s;
}
function localToday(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// "1540" -> 1540 s, "25:40" -> 1540 s, "1:49:30" -> 6570 s.
function parseSeconds(s) {
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
  const p = String(s).split(':');
  if (p.length < 2 || p.length > 3 || p.some(x => !/^\d+(\.\d+)?$/.test(x))) return NaN;
  return Math.round(p.map(Number).reduce((a, x) => a * 60 + x, 0));
}
function fmtDur(sec) {
  sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
const iso = ms => new Date(ms).toISOString();

async function api(method, query = '', body) {
  const url = process.env.API_URL, pass = process.env.SYNC_PASSCODE;
  if (!url || !pass) throw new CliError(3, 'API_URL and SYNC_PASSCODE are not set (environment or ~/.config/uvm-tracker/sync.env).');
  let r;
  try {
    r = await fetch(url + query, {
      method, signal: AbortSignal.timeout(20000),
      headers: { 'X-Sync-Passcode': pass, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CliError(3, `Could not reach ${url}: ${e.cause?.message || e.message}`);
  }
  const j = await r.json().catch(() => null);
  if (r.status === 401) throw new CliError(3, 'The API rejected the passcode (401). Check SYNC_PASSCODE.');
  if (!r.ok || !j?.ok) throw new CliError(3, `API error ${r.status}: ${j ? [j.error, j.detail].filter(Boolean).join(': ') : 'not JSON'}`);
  return j;
}

const showEntry = r => ({ day: r.day, updated_at: iso(r.updated_at), ...(r.deleted ? { deleted: true } : {}), data: r.data });

function table(rows) {
  const dow = d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T12:00:00Z`).getUTCDay()];
  const lines = [['DATE', 'DAY', 'DONE', 'MILES', 'TIME', 'PACE', 'FEEL', 'FLAGS', 'NOTE']];
  for (const r of rows) {
    const e = r.data || {}, t = +e.actualTime || 0, mi = +e.actualDist || 0;
    lines.push([r.day, dow(r.day), r.deleted ? 'DELETED' : e.done ? 'yes' : 'no', mi ? mi.toFixed(2) : '', t ? fmtDur(t * 60) : '',
      t && mi ? fmtDur(t * 60 / mi) : '', e.rating || '', ['upgrade', 'strength', 'pain'].filter(k => e[k]).join(','), e.note || '']);
  }
  const w = lines[0].map((_, i) => Math.max(...lines.map(l => String(l[i]).length)));
  return lines.map(l => l.map((c, i) => (i === l.length - 1 ? String(c) : String(c).padEnd(w[i]))).join('  ').trimEnd()).join('\n');
}

const commands = {
  async list({ opt }) {
    const from = isoDay(opt.from || localToday(-13), '--from'), to = isoDay(opt.to || localToday(), '--to');
    if (from > to) throw invalid('--from is after --to');
    const res = await api('GET', `?from=${from}&to=${to}`);
    const rows = res.entries.filter(r => opt.deleted || !r.deleted);
    if (opt.json) return console.log(JSON.stringify(rows.map(showEntry), null, 2));
    console.log(rows.length ? table(rows) : `No entries from ${from} to ${to}.`);
  },

  async get({ pos }) {
    const day = isoDay(pos[1]);
    const r = (await api('GET', `?day=${day}`)).entries[0];
    if (!r || r.deleted) throw new CliError(1, r ? `No entry for ${day} (deleted ${iso(r.updated_at)}).` : `No entry for ${day}.`);
    console.log(JSON.stringify(showEntry(r), null, 2));
  },

  async upsert({ pos, opt }) {
    const day = isoDay(pos[1]);
    if (typeof opt.json !== 'string') throw usage(`upsert needs --json '{"field": value, ...}'`);
    let data;
    try { data = JSON.parse(opt.json); } catch (e) { throw invalid(`--json is not valid JSON: ${e.message}`); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) throw invalid('--json must be an object with at least one field');
    for (const [k, v] of Object.entries(data)) {
      if (!FIELDS[k]) throw invalid(`Unknown field "${k}". Fields: ${Object.keys(FIELDS).join(', ')}`);
      if (k === 'actualTime' && typeof v === 'string') {
        const sec = parseSeconds(v);
        if (!(sec >= 0) || !v.includes(':')) throw invalid(`actualTime "${v}" should be minutes or "mm:ss" / "h:mm:ss"`);
        data[k] = Math.round(sec / 60 * 1000) / 1000;
      }
      if (v !== null && !FIELDS[k][0](data[k])) throw invalid(`${k} must be ${FIELDS[k][1]} (got ${JSON.stringify(v)})`);
    }
    const res = await api('POST', '', { entries: [{ day, data, updated_at: Date.now(), merge: true }] });
    const r = res.entries.find(x => x.day === day);
    const applied = res.applied.entries.includes(day);
    console.log(JSON.stringify({ applied, ...showEntry(r) }, null, 2));
    if (!applied) console.error(`Not saved: the log already has a newer version of ${day} (edited ${iso(r.updated_at)}). Run the command again.`);
    if (!applied) process.exitCode = 3;
  },

  async delete({ pos }) {
    const day = isoDay(pos[1]);
    const res = await api('DELETE', `?day=${day}`);
    const r = res.entries.find(x => x.day === day);
    if (!res.applied.entries.includes(day)) throw new CliError(3, `Not deleted: ${day} has a newer edit (${iso(r.updated_at)}).`);
    console.log(`Deleted ${day}.`);
  },

  async checkpoint({ pos }) {
    const id = pos[1], val = pos[2];
    if (!CHECKPOINTS[id]) throw usage('checkpoint needs 5k, 10k or half');
    if (!val) throw usage('checkpoint needs a time: seconds, mm:ss or h:mm:ss (or "clear")');
    let item;
    if (val === 'clear') item = { key: `checkpoint:${id}`, deleted: true, updated_at: Date.now() };
    else {
      const sec = parseSeconds(val), [lo, hi] = CHECKPOINTS[id];
      if (!(sec >= lo && sec <= hi)) throw invalid(`${val} is not a plausible ${id} time (${fmtDur(lo)} to ${fmtDur(hi)}). Use seconds, mm:ss or h:mm:ss.`);
      item = { key: `checkpoint:${id}`, data: { sec, at: new Date().toISOString() }, updated_at: Date.now() };
    }
    const res = await api('POST', '', { kv: [item] });
    if (!res.applied.kv.includes(item.key)) throw new CliError(3, `Not saved: the ${id} result has a newer edit.`);
    console.log(val === 'clear' ? `Cleared the ${id} result.` : `Set ${id} to ${fmtDur(item.data.sec)} (${item.data.sec} s).`);
  },

  async checkpoints({ opt }) {
    const kv = (await api('GET', '?from=1900-01-01&to=1900-01-01')).kv; // kv rows come with every pull
    const out = Object.keys(CHECKPOINTS).map(id => {
      const r = kv.find(x => x.key === `checkpoint:${id}` && !x.deleted);
      return r ? { id, time: fmtDur(r.data.sec), sec: r.data.sec, set_at: r.data.at, updated_at: iso(r.updated_at) } : { id, time: null };
    });
    if (opt.json) return console.log(JSON.stringify(out, null, 2));
    for (const c of out) console.log(c.time ? `${c.id.padEnd(5)} ${c.time.padStart(8)}  (${c.sec} s, set ${c.set_at})` : `${c.id.padEnd(5)}        –  (no result yet)`);
  },
};

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2)), cmd = args.pos[0];
  if (!cmd || cmd === 'help' || args.opt.help) return console.log(USAGE);
  if (!commands[cmd]) throw usage(`Unknown command "${cmd}".`);
  await commands[cmd](args);
}

main().catch(err => {
  console.error(err instanceof CliError ? err.message : err.stack || String(err));
  process.exitCode = err instanceof CliError ? err.code : 3;
});
