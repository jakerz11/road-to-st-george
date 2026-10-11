// Gateway between /api/sync (Vercel) and the tracker tables. Supabase injects this project's secret key into
// the function, so the key never leaves Supabase. A caller must present the sync passcode, which is checked
// against the SHA-256 in public.tracker_auth, and can then run only tracker_pull or tracker_push.
// Deployed with verify_jwt = false: the passcode is the authentication.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SECRET_KEY = secretKey();
const FUNCTIONS = new Set(['tracker_pull', 'tracker_push']);
const MAX_BODY = 1_000_000;
let hashCache: { hash: Uint8Array; at: number } | null = null;

function secretKey(): string {
  try {
    const key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default;
    if (key) return key;
  } catch { /* fall back to the legacy key */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

// sb_secret_ keys go on the apikey header only; the legacy service_role JWT also needs Authorization.
function keyHeaders(): Record<string, string> {
  return SECRET_KEY.startsWith('sb_') ? { apikey: SECRET_KEY } : { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function expectedHash(): Promise<Uint8Array> {
  if (hashCache && Date.now() - hashCache.at < 60_000) return hashCache.hash;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tracker_auth?select=passcode_sha256&id=eq.1`, { headers: keyHeaders() });
  if (!r.ok) throw new Error(`passcode lookup failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const hex: string | undefined = (await r.json())[0]?.passcode_sha256;
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('no passcode hash in tracker_auth');
  hashCache = { hash: Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))), at: Date.now() };
  return hashCache.hash;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  let want: Uint8Array;
  try {
    want = await expectedHash();
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: 'sync is not configured' }, 500);
  }
  const given = req.headers.get('x-sync-passcode') ?? '';
  if (!given || !sameBytes(await sha256(given), want)) return json({ ok: false, error: 'unauthorized' }, 401);

  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'body too large' }, 413);
  let call: { fn?: string; args?: Record<string, unknown> };
  try {
    call = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'body is not valid JSON' }, 400);
  }
  if (!call || typeof call.fn !== 'string' || !FUNCTIONS.has(call.fn)) return json({ ok: false, error: 'unknown function' }, 400);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${call.fn}`, {
    method: 'POST',
    headers: { ...keyHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(call.args ?? {}),
  });
  const out = await r.text();
  if (!r.ok) console.error(`${call.fn} failed: ${r.status} ${out.slice(0, 500)}`);
  return new Response(out, { status: r.ok ? 200 : 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
});
