-- SHA-256 (hex) of the sync passcode. The tracker-sync Edge Function checks callers against it before it
-- touches the tracker tables. The passcode itself lives only on Jake's devices and in Hans's sync.env.
-- Rotate: update this row, then update sync.env and re-enter the passcode in the app.
create table public.tracker_auth (
  id              smallint    primary key default 1 check (id = 1),
  passcode_sha256 text        not null check (passcode_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at      timestamptz not null default now()
);

alter table public.tracker_auth enable row level security;
revoke all on table public.tracker_auth from public, anon, authenticated;
