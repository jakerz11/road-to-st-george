-- Cloud sync for the Road to UVM tracker (index.html <-> api/sync.js <-> scripts/hans-sync.mjs).
-- One row per training day, plus a small key/value table for checkpoint results and synced settings.
-- Only api/sync.js can reach this data: it calls the two functions below with the project's secret key.
-- RLS is on with no policies, and anon/authenticated have no table or function grants at all.

create table public.tracker_entries (
  day        date        primary key,
  data       jsonb       not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null,                -- when a client last edited the day; last write wins
  deleted    boolean     not null default false,  -- tombstone, so a delete reaches every device
  synced_at  timestamptz not null default now()   -- when the server stored this version; drives "since" pulls
);

create table public.tracker_kv (
  key        text        primary key check (key ~ '^[a-z0-9][a-z0-9:._-]{0,63}$'),  -- e.g. checkpoint:5k, settings
  data       jsonb       not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null,
  deleted    boolean     not null default false,
  synced_at  timestamptz not null default now()
);

alter table public.tracker_entries enable row level security;
alter table public.tracker_kv enable row level security;
revoke all on table public.tracker_entries, public.tracker_kv from public, anon, authenticated;

-- Changes since a server time (ms since epoch; null = everything), optionally limited to a day range.
-- Tombstones are included so clients can apply deletes. "now" is the server time to pass as the next "since".
create function public.tracker_pull(p_since bigint default null, p_from date default null, p_to date default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'now', round(extract(epoch from now()) * 1000),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('day', t.day, 'data', t.data,
               'updated_at', round(extract(epoch from t.updated_at) * 1000), 'deleted', t.deleted) order by t.day)
      from public.tracker_entries t
      where (p_since is null or t.synced_at > to_timestamp(p_since / 1000.0))
        and (p_from is null or t.day >= p_from)
        and (p_to is null or t.day <= p_to)), '[]'::jsonb),
    'kv', coalesce((
      select jsonb_agg(jsonb_build_object('key', k.key, 'data', k.data,
               'updated_at', round(extract(epoch from k.updated_at) * 1000), 'deleted', k.deleted) order by k.key)
      from public.tracker_kv k
      where p_since is null or k.synced_at > to_timestamp(p_since / 1000.0)), '[]'::jsonb));
$$;

-- Store a batch of client changes. Items: {day | key, data, updated_at (ms since epoch), deleted?, merge?}.
-- An item only replaces the stored row when its updated_at is newer (a tie keeps the stored row), so replays
-- and out-of-order pushes are harmless. merge=true (entries only) merges data into the stored fields instead
-- of replacing them, and a null value removes that field. Returns the resulting rows for every pushed item.
create function public.tracker_push(p_entries jsonb default '[]'::jsonb, p_kv jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  it        jsonb;
  v_ts      timestamptz;
  v_cap     timestamptz := now() + interval '5 minutes';  -- a client clock running fast can't pin a row forever
  v_del     boolean;
  v_merge   boolean;
  v_data    jsonb;
  v_drop    text[];
  v_n       int;
  v_days    date[] := '{}';
  v_keys    text[] := '{}';
  v_ap_days date[] := '{}';
  v_ap_keys text[] := '{}';
begin
  for it in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if it->>'day' is null or it->>'updated_at' is null then raise exception 'entry needs day and updated_at'; end if;
    v_ts    := least(to_timestamp((it->>'updated_at')::numeric / 1000), v_cap);
    v_del   := coalesce((it->>'deleted')::boolean, false);
    v_merge := coalesce((it->>'merge')::boolean, false) and not v_del;
    v_data  := case when v_del then '{}'::jsonb else coalesce(it->'data', '{}'::jsonb) end;
    v_drop  := '{}';
    if v_merge then
      v_drop := array(select j.k from jsonb_each(v_data) as j(k, v) where j.v = 'null'::jsonb);
    end if;
    insert into public.tracker_entries as t (day, data, updated_at, deleted)
    values ((it->>'day')::date, v_data - v_drop, v_ts, v_del)
    on conflict (day) do update
      set data       = case when v_merge and not t.deleted then (t.data || excluded.data) - v_drop else excluded.data end,
          updated_at = excluded.updated_at,
          deleted    = excluded.deleted,
          synced_at  = now()
      where t.updated_at < excluded.updated_at;
    get diagnostics v_n = row_count;
    v_days := v_days || (it->>'day')::date;
    if v_n > 0 then v_ap_days := v_ap_days || (it->>'day')::date; end if;
  end loop;

  for it in select value from jsonb_array_elements(coalesce(p_kv, '[]'::jsonb)) loop
    if it->>'key' is null or it->>'updated_at' is null then raise exception 'kv item needs key and updated_at'; end if;
    v_ts  := least(to_timestamp((it->>'updated_at')::numeric / 1000), v_cap);
    v_del := coalesce((it->>'deleted')::boolean, false);
    insert into public.tracker_kv as k (key, data, updated_at, deleted)
    values (it->>'key', case when v_del then '{}'::jsonb else coalesce(it->'data', '{}'::jsonb) end, v_ts, v_del)
    on conflict (key) do update
      set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, synced_at = now()
      where k.updated_at < excluded.updated_at;
    get diagnostics v_n = row_count;
    v_keys := v_keys || (it->>'key');
    if v_n > 0 then v_ap_keys := v_ap_keys || (it->>'key'); end if;
  end loop;

  return jsonb_build_object(
    'now', round(extract(epoch from now()) * 1000),
    'applied', jsonb_build_object('entries', to_jsonb(v_ap_days), 'kv', to_jsonb(v_ap_keys)),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('day', t.day, 'data', t.data,
               'updated_at', round(extract(epoch from t.updated_at) * 1000), 'deleted', t.deleted) order by t.day)
      from public.tracker_entries t where t.day = any (v_days)), '[]'::jsonb),
    'kv', coalesce((
      select jsonb_agg(jsonb_build_object('key', k.key, 'data', k.data,
               'updated_at', round(extract(epoch from k.updated_at) * 1000), 'deleted', k.deleted) order by k.key)
      from public.tracker_kv k where k.key = any (v_keys)), '[]'::jsonb));
end;
$$;

revoke all on function public.tracker_pull(bigint, date, date) from public, anon, authenticated;
revoke all on function public.tracker_push(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.tracker_pull(bigint, date, date) to service_role;
grant execute on function public.tracker_push(jsonb, jsonb) to service_role;
