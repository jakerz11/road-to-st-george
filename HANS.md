# Hans: reading and writing Jake's training log

Jake's tracker app and this command line share one cloud log, so Hans no longer needs CSV round-trips. Anything
written here shows up on Jake's phone the next time the app syncs: when it opens, when it comes back to the
foreground, or when he taps Stats → Cloud sync → Sync now. Anything Jake logs is readable here a few seconds later.

```sh
node /workspace/road-to-st-george/scripts/hans-sync.mjs <command>
```

Node 18+ and no install. For brevity, the examples below use this alias:

```sh
alias hans-sync='node /workspace/road-to-st-george/scripts/hans-sync.mjs'
```

## Config

The CLI needs `API_URL` and `SYNC_PASSCODE`. Values from the environment are used first; anything missing is read
from `/home/box/.config/uvm-tracker/sync.env` (mode 600). Set `SYNC_ENV_FILE` to point at another file.

```sh
API_URL=https://road-to-st-george.vercel.app/api/sync
SYNC_PASSCODE=...   # never paste it into chats, notes or commits
```

## Commands

| Command | Does |
|---|---|
| `hans-sync list --from 2026-10-05 --to 2026-10-11` | Table of logged days in the range (default: the last 14 days). Add `--json` for exact data, `--deleted` to include deleted days. |
| `hans-sync get 2026-10-13` | One day's entry as JSON. Exits 1 if there is no entry. |
| `hans-sync upsert 2026-10-13 --json '{"done":true,"actualDist":3.1,"actualTime":"31:30","rating":7}'` | Merges these fields into the day, creating it if needed. Fields you leave out stay as they are; `null` removes a field. |
| `hans-sync delete 2026-10-13` | Deletes the day's entry, on every device. |
| `hans-sync checkpoint 5k 25:40` | Sets a checkpoint result: `5k`, `10k` or `half`; seconds (`1540`), `mm:ss` or `h:mm:ss` (`1:49:30`). `clear` removes it. The app picks the pace track from it. |
| `hans-sync checkpoints` | Shows the three checkpoint results (`--json` available). |

Entry fields (the same ones the app stores):

| Field | Type |
|---|---|
| `done` | `true` / `false`: the run (or walk) happened |
| `actualDist` | miles, number |
| `actualTime` | minutes, number, or `"mm:ss"` / `"h:mm:ss"` (converted to minutes) |
| `rating` | feel, whole number 0–10 (0 = not rated) |
| `upgrade` | `true` if the upgrade version was run (Tue workout, Mon/Thu easy, wk31 22-miler) |
| `strength` | `true` if a strength session was done that day |
| `pain` | `true` raises the "stop, 2 days off, reassess" alert in the app |
| `note` | text, up to 500 characters |
| `src` | short source tag (the app uses `"strava"`); optional |

A run counts when `done` is true and `actualDist` > 0. Dates are Jake's local calendar days.

## Examples

```sh
# Weekly review (Mon–Sun)
hans-sync list --from 2026-10-12 --to 2026-10-18

# Fill in a run Jake told you about
hans-sync upsert 2026-10-14 --json '{"done":true,"actualDist":4,"actualTime":"41:20","rating":6,"note":"4 mi + 6 strides"}'

# Fix one field, clear another
hans-sync upsert 2026-10-14 --json '{"rating":7,"note":null}'

# Strength-only day
hans-sync upsert 2026-10-15 --json '{"strength":true}'

# 5K time trial result (sets the pace track)
hans-sync checkpoint 5k 25:40
```

## Rules of the road

- **Last write wins, per day.** If Jake edits the same day after you, his version stays, and the other way round.
  `upsert` reports `"applied": false` (exit 3) in the rare case a newer edit got there first. Read the day again and
  retry.
- **Deletes are tombstones**, so they reach the phone instead of being re-uploaded from it.
- Exit codes: `0` ok, `1` not found (`get`), `2` bad arguments, `3` API, network or passcode problem.
- The raw API (`GET`/`POST`/`DELETE` on `$API_URL` with an `X-Sync-Passcode` header) is documented in `SYNC.md`.
