-- Arsène — initial schema.
--
-- Expand-only (02-architecture.v1.md §6): later migrations add, never drop or
-- retype. Supabase's `anon` / `authenticated` roles are created here so a bare
-- Postgres matches production, exactly as the sibling pronos project does.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------

create table writers (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- `arsene_` prefix (unlike every other table here): this project shares its
-- Supabase instance with the sibling pronos app (ADR-0002), which already
-- owns an unrelated `leagues` table (fixture/match data, different columns
-- entirely) in the same `public` schema — a bare `leagues` here would collide
-- with it. `telemetry_events` below has the same problem for the same reason.
create table arsene_leagues (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

-- AC-10: a type is always nested under a league, and either level is created
-- on demand. 01-decisions.md #2: near-duplicate names are left alone, so the
-- uniqueness key is the exact name, never a normalised one.
create table categories (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references arsene_leagues (id),
  name       text not null,
  created_at timestamptz not null default now(),
  unique (league_id, name)
);

create table articles (
  id                 uuid primary key default gen_random_uuid(),
  writer_id          uuid not null references writers (id),
  title              text not null,
  body_html          text not null default '',
  league_id          uuid references arsene_leagues (id),
  category_id        uuid references categories (id),
  status             text not null default 'draft' check (status in ('draft', 'published')),
  slug               text unique,
  meta_title         text,
  meta_description   text,
  structured_data    jsonb,
  published_at       timestamptz,
  first_published_at timestamptz,
  -- ADR-0003: whole-article lock, refreshed by a ~20s heartbeat.
  locked_by          uuid references writers (id),
  locked_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index articles_published_at_idx on articles (published_at desc);

-- AC-06: `role` decides cover vs body at upload time, never inferred later.
create table article_images (
  id                       uuid primary key default gen_random_uuid(),
  article_id               uuid not null references articles (id) on delete cascade,
  role                     text not null check (role in ('cover', 'body')),
  status                   text not null default 'processing'
                             check (status in ('processing', 'ready', 'failed')),
  original_filename        text not null,
  alt_text                 text,
  -- The as-uploaded file stays in Supabase Storage and is never served to
  -- visitors; `optimized_url` is the Cloudflare-fronted asset (§4 egress).
  original_url             text,
  optimized_url            text,
  failure_code             text,
  failure_message          text,
  replaced_cover_image_id  uuid,
  created_at               timestamptz not null default now()
);

create index article_images_article_idx on article_images (article_id);

-- AC-04 / ADR-0002: structured predictions. The pronos match reference is a
-- nullable snapshot taken at pick time — never a cross-project foreign key.
create table pronos_entries (
  id                   uuid primary key default gen_random_uuid(),
  article_id           uuid not null references articles (id) on delete cascade,
  home_team            text not null,
  away_team            text not null,
  predicted_home_score integer not null,
  predicted_away_score integer not null,
  confidence_tier      text not null
                         check (confidence_tier in ('Indispensable', 'Prudent', 'Risqué')),
  pronos_league_id     uuid,
  pronos_game_id       uuid,
  match_kickoff_at     timestamptz,
  created_at           timestamptz not null default now()
);

create index pronos_entries_article_idx on pronos_entries (article_id);

-- AC-09: one shared library, visible to every writer.
create table site_assets (
  id          uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references writers (id),
  name        text not null,
  url         text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Telemetry (spec §4)
-- ---------------------------------------------------------------------------

create table arsene_telemetry_events (
  id          uuid primary key default gen_random_uuid(),
  event_type  text not null check (event_type in ('draft_started', 'article_published')),
  writer_id   uuid not null references writers (id),
  article_id  uuid not null references articles (id) on delete cascade,
  occurred_at timestamptz not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index arsene_telemetry_events_article_idx on arsene_telemetry_events (article_id, event_type);

-- A draft starts once. Without this, a crash-and-resume could reset the
-- numerator of time-to-publish and hide the problem this build exists to fix.
create unique index arsene_telemetry_events_one_draft_started
  on arsene_telemetry_events (article_id)
  where event_type = 'draft_started';

-- ---------------------------------------------------------------------------
-- Row level security (02-architecture.v1.md §7)
-- ---------------------------------------------------------------------------

alter table writers                 enable row level security;
alter table arsene_leagues          enable row level security;
alter table categories              enable row level security;
alter table articles                enable row level security;
alter table article_images          enable row level security;
alter table pronos_entries          enable row level security;
alter table site_assets             enable row level security;
alter table arsene_telemetry_events enable row level security;

-- Visitors: published content only. Drafts are invisible to `anon`.
create policy anon_reads_writers on writers for select to anon using (true);
create policy anon_reads_leagues on arsene_leagues for select to anon using (true);
create policy anon_reads_categories on categories for select to anon using (true);

create policy anon_reads_published_articles on articles
  for select to anon using (status = 'published');

create policy anon_reads_published_images on article_images
  for select to anon using (
    exists (select 1 from articles a where a.id = article_id and a.status = 'published')
  );

create policy anon_reads_published_pronos on pronos_entries
  for select to anon using (
    exists (select 1 from articles a where a.id = article_id and a.status = 'published')
  );

-- Writers: every writer may read and edit everything (no role hierarchy,
-- no approval step — spec §2 and §8).
create policy writers_read_writers on writers for select to authenticated using (true);
create policy writers_manage_leagues on arsene_leagues for all to authenticated using (true) with check (true);
create policy writers_manage_categories on categories for all to authenticated using (true) with check (true);
create policy writers_manage_articles on articles for all to authenticated using (true) with check (true);
create policy writers_manage_images on article_images for all to authenticated using (true) with check (true);
create policy writers_manage_pronos on pronos_entries for all to authenticated using (true) with check (true);
create policy writers_manage_assets on site_assets for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Grants (NFR-TAMPER-01)
-- ---------------------------------------------------------------------------

grant select on writers, arsene_leagues, categories, articles, article_images, pronos_entries to anon;

grant select on
  writers, arsene_leagues, categories, articles, article_images, pronos_entries, site_assets
  to authenticated;

grant insert on arsene_leagues, categories, site_assets to authenticated;
grant insert, update, delete on pronos_entries to authenticated;

-- Publish-controlled columns (status, slug, published_at, first_published_at,
-- structured_data) are deliberately absent: only the publish Edge Function,
-- running as the service role, may write them. A writer attempting it gets a
-- loud 42501 rather than a silent zero-row update.
grant update (title, body_html, league_id, category_id, meta_title,
              meta_description, locked_by, locked_at, updated_at)
  on articles to authenticated;

grant update (role, alt_text) on article_images to authenticated;
