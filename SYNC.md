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
