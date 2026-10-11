# Cloud sync

The tracker still runs entirely from `localStorage` and works offline. Sync copies the log to a small
Supabase database, so Jake's phone, any other browser and Hans (through `scripts/hans-sync.mjs`) share one log.

```
index.html (phone: GitHub Pages or Vercel) ─┐
scripts/hans-sync.mjs (Hans)                ┴─► /api/sync on Vercel ─► Postgres functions tracker_pull / tracker_push
                                                passcode, validation,    (Supabase project road-to-uvm-sync)
                                                CORS, last write wins
```

## Supabase

- Project `road-to-uvm-sync`, ref `kkmpbpcbtmzivmpyypmz`, region us-east-1, free plan, in jakerz11's Org.
- Schema: `supabase/migrations/` (applied in this order).

| Table | Columns | Holds |
|---|---|---|
| `tracker_entries` | `day date pk`, `data jsonb`, `updated_at timestamptz`, `deleted bool`, `synced_at timestamptz` | One row per day. `data` is the app's entry object: `done, rating, actualDist, actualTime, upgrade, strength, pain, note, src`. |
| `tracker_kv` | `key text pk`, `data jsonb`, `updated_at`, `deleted`, `synced_at` | `checkpoint:5k`, `checkpoint:10k`, `checkpoint:half` (`{sec, at}`) and `settings` (`{track}`). |
| `tracker_auth` | `id = 1`, `passcode_sha256` | SHA-256 of the sync passcode. |

- `updated_at` is when a client edited the item (ms precision). It decides conflicts.
- `synced_at` is when the server stored that version. It drives incremental `since` pulls, so a device with a slow clock can't hide its changes from the others.
- `deleted = true` is a tombstone (its `data` is emptied). Tombstones are kept so a delete reaches every device instead of being re-uploaded by one that still has the entry.

Access: RLS is on with **no policies**, and `anon`/`authenticated` have no grants on the tables or the functions. Only the
service role (the project's secret key) can call `tracker_pull` / `tracker_push`, and only server code holds that key.
The Supabase security advisor's "RLS enabled, no policy" notice on these tables is expected.

## Conflict rule: last write wins, per day and per key

- `tracker_push` stores an item only if its `updated_at` is newer than the stored row's. On a tie the stored row
  stays. Replayed or out-of-order pushes are therefore harmless.
- A `merge: true` entry (used by Hans's `upsert`) merges its fields into the stored entry instead of replacing it.
  A `null` value removes a field. Merging onto a tombstone starts a fresh entry.
- `updated_at` values more than 5 minutes in the future are capped at server time + 5 min. A device with a wrong
  clock therefore can't pin a row forever.

## API: `/api/sync` (`api/sync.js` on Vercel)

`https://road-to-st-george.vercel.app/api/sync`. Every request needs the header `X-Sync-Passcode: <passcode>`.
A request without it, or with a wrong passcode, gets `401 {"ok":false,"error":"unauthorized"}`. Responses are JSON
with `Cache-Control: no-store`. Times are milliseconds since 1970.

| Request | Does |
|---|---|
| `GET ?since=MS` | Rows the server stored after `since` (pass the previous response's `now`). Omit `since` to get everything. |
| `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD` or `?day=YYYY-MM-DD` | Entries in a day range (can be combined with `since`). |
| `POST {"entries":[…],"kv":[…]}` | Push changes. Entry: `{day, data, updated_at, deleted?, merge?}`. kv item: `{key, data, updated_at, deleted?}`. A missing `updated_at` means now. |
| `DELETE ?day=YYYY-MM-DD` or `?key=NAME` | Tombstone one item (`updated_at` = now). |

- GET returns `{ok, now, entries:[{day, data, updated_at, deleted}], kv:[{key, data, updated_at, deleted}]}`, tombstones included.
- POST and DELETE return `{ok, now, applied:{entries:[days], kv:[keys]}, entries, kv}`. `entries` and `kv` hold the
  server's row for every item sent. An item missing from `applied` lost to a newer copy already on the server.
- Errors: 400 bad input, 401 passcode, 405 method, 413 too large, 502/503 database problem (`detail` carries the
  database message).
- CORS allows only `https://jakerz11.github.io` and `https://road-to-st-george.vercel.app`. The copy of the app on
  GitHub Pages calls the Vercel API cross-origin. The CLI is not a browser, so CORS doesn't apply to it.

### How `/api/sync` reaches the database

- **Relay (current setup).** `api/sync.js` validates the request, then forwards `{fn, args}` with the caller's
  passcode to the Supabase Edge Function `tracker-sync` (`supabase/functions/tracker-sync/index.ts`, deployed with
  `verify_jwt = false`). The function checks the SHA-256 of the passcode against `tracker_auth` (in constant time,
  hash cached for 60 s), then runs `tracker_pull`/`tracker_push` with the secret key that Supabase injects into
  Edge Functions. No secret is stored on Vercel. This was needed because the Vercel connection available while
  setting this up could not write project environment variables (403).
- **Direct (optional).** If `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (the project's `sb_secret_…` key, or a legacy
  `service_role` JWT) and `SYNC_PASSCODE` are all set on Vercel (Production + Preview), `api/sync.js` checks the
  passcode itself with `crypto.timingSafeEqual` and calls the two Postgres functions through Supabase REST. A
  redeploy is needed after setting them. If `SYNC_PASSCODE` alone is set, it is checked as well.

Supabase retires the legacy `anon`/`service_role` JWT keys at the end of 2026, so use an `sb_secret_…` key for
direct mode. Those keys go on the `apikey` header only, and `api/sync.js` handles both kinds.
