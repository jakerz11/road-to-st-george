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

## The app (`index.html`)

- **Setup:** Stats → Cloud sync → paste the passcode → Connect, once per device. On an iPhone, a home-screen app has
  storage separate from Safari, so enter the passcode inside the home-screen app itself. The passcode is kept in
  `localStorage` under `uvm27-sync-v1`, apart from the log, so it never ends up in an export. "Stop syncing on this
  device" forgets it, and the log stays.
- **Which URL:** on `*.vercel.app` the app calls `/api/sync`. Anywhere else, including the GitHub Pages copy at
  `jakerz11.github.io/road-to-st-george/`, where the installed home-screen app lives, it calls
  `https://road-to-st-george.vercel.app/api/sync`. For local testing, `{"api": "<url>"}` in `uvm27-sync-v1` overrides it.
- **What syncs:** day entries, checkpoint results and the pinned pace track. The theme stays per device, and the
  St. George legacy key is never touched.
- **Bookkeeping** lives in the log store (`uvm27-tracker-v1`) under `sync`:
  - `u`: edit time per item.
  - `pend`: items the cloud doesn't have yet.
  - `since`: server time of the last pull.
  - `at`: time of the last successful sync.
- **Edit stamping:** every save compares the log with a snapshot and stamps whatever changed or disappeared with the
  current time. Every way of editing is therefore covered: the log card, "Clear this day", CSV and Strava import,
  checkpoints and the track picker.
- **First run after this update:** existing items get edit time 0 and are queued. The first sync uploads them without
  overriding anything newer in the cloud. Before that first sync, a copy of the whole store is saved once as
  `uvm27-tracker-v1:presync`.
- **When it syncs:**
  - on load;
  - about 2 s after an edit;
  - when the phone comes back online;
  - when the app returns to the foreground, if the last sync was more than a minute ago;
  - when it goes to the background with unsent changes;
  - on "Sync now".

  "Sync now" does a full pull and re-queues anything the cloud is missing. The other syncs pull only changes since
  the last pull, minus a 10-minute overlap.
- **Merging:** per item, the newer edit time wins and a tie goes to the cloud. Cloud entries pass through the app's
  normal `normEntry` cleanup before they're stored.
- **Never wipes local data:** an empty or failed pull changes nothing. A local item only changes when a newer copy, or
  an explicit delete (a tombstone), comes from the cloud. While offline, edits wait in `pend`. The card shows
  "Offline", and the Today tab warns if changes have been waiting more than 2 days.
- **Caching:** there is no service worker, so nothing can cache `/api`. Requests use `cache: 'no-store'`, and the API
  answers with `Cache-Control: no-store`.
