-- Arsène — apply the arsene_leagues/arsene_telemetry_events rename for real,
-- and close the _migrations_applied RLS hole on the real production project.
--
-- `0001_initial_schema.sql` was edited in place to rename `leagues` ->
-- `arsene_leagues` and `telemetry_events` -> `arsene_telemetry_events`
-- (avoiding a collision with pronos's own same-named tables — moot in
-- practice since pronos and Arsène are separate Supabase projects/databases,
-- but harmless either way). `scripts/deploy-migrations.sh` tracks applied
-- migrations by filename only, so any database that already ran the old
-- `0001_initial_schema.sql` (the real project did, on 2026-08-23, before the
-- rename) silently skipped the edit forever — the rename never actually
-- landed there, while application code (src/api/repo.ts, src/site/render.ts)
-- and the deployed Edge Function already query the new names.
--
-- Expand-only (0001's own header, NFR-MIGRATE-01): this does not rename or
-- drop anything. It creates the new-named tables (a no-op wherever 0001
-- already made them, e.g. the test harness's always-fresh database), copies
-- across any rows from the old-named tables where those still exist, and
-- repoints the two foreign keys that validated against the old `leagues`.
-- The old `leagues`/`telemetry_events` tables are deliberately left in place
-- — empty once copied, still RLS-protected from 0001, no longer referenced —
-- rather than dropped; removing them is a manual out-of-band decision once
-- confirmed safe, not something a migration is allowed to do here.
--
-- Separately: `_migrations_applied` is created directly by
-- `scripts/deploy-migrations.sh`, not by a tracked migration, with RLS never
-- enabled — so it inherits Supabase's default public-schema grants to
-- `anon`/`authenticated` with nothing restricting rows. The exact same shape
-- of bug the writers-table RLS fix (CHANGELOG, v0.2.3) was meant to close,
-- but that fix landed on the wrong Supabase project and was never applied
-- here. Closed the same way: enable RLS with zero policies (zero client
-- access, by design — this table is deploy-tooling-internal) and revoke the
-- inherited default grants. `scripts/deploy-migrations.sh` itself is also
-- fixed so this can't regress on any future project's first deploy.

create table if not exists arsene_leagues (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists arsene_telemetry_events (
  id          uuid primary key default gen_random_uuid(),
  event_type  text not null check (event_type in ('draft_started', 'article_published')),
  writer_id   uuid not null references writers (id),
  article_id  uuid not null references articles (id) on delete cascade,
  occurred_at timestamptz not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists arsene_telemetry_events_article_idx
  on arsene_telemetry_events (article_id, event_type);

create unique index if not exists arsene_telemetry_events_one_draft_started
  on arsene_telemetry_events (article_id)
  where event_type = 'draft_started';

-- Legacy databases only: copy rows forward and repoint FKs dynamically (by
-- whatever name Postgres actually gave the constraint), so this is a true
-- no-op wherever the old-named tables never existed.
do $$
declare
  con record;
begin
  if to_regclass('public.leagues') is not null then
    insert into arsene_leagues (id, name, created_at)
      select id, name, created_at from leagues
      on conflict (id) do nothing;

    for con in
      select conname, conrelid::regclass::text as tbl
      from pg_constraint
      where contype = 'f' and confrelid = 'public.leagues'::regclass
    loop
      execute format('alter table %s drop constraint %I', con.tbl, con.conname);
      execute format(
        'alter table %s add constraint %I foreign key (league_id) references arsene_leagues (id)',
        con.tbl, con.conname
      );
    end loop;
  end if;

  if to_regclass('public.telemetry_events') is not null then
    insert into arsene_telemetry_events (id, event_type, writer_id, article_id, occurred_at, payload, created_at)
      select id, event_type, writer_id, article_id, occurred_at, payload, created_at from telemetry_events
      on conflict (id) do nothing;
  end if;
end
$$;

-- RLS + policies + grants: reassert the desired end state unconditionally.
-- Idempotent either way — a fresh install already has exactly this from
-- 0001, so this just repeats it.
alter table arsene_leagues          enable row level security;
alter table arsene_telemetry_events enable row level security;

drop policy if exists anon_reads_leagues on arsene_leagues;
create policy anon_reads_leagues on arsene_leagues for select to anon using (true);

drop policy if exists writers_manage_leagues on arsene_leagues;
create policy writers_manage_leagues on arsene_leagues for all to authenticated using (true) with check (true);

grant select on arsene_leagues to anon;
grant select, insert on arsene_leagues to authenticated;

-- _migrations_applied: zero client access, by design.
alter table if exists _migrations_applied enable row level security;

do $$
begin
  if to_regclass('public._migrations_applied') is not null then
    revoke all on _migrations_applied from anon, authenticated;
  end if;
end
$$;
