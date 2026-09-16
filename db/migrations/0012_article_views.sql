-- Arsène — first-party, server-side article view counter.
--
-- A separate table from arsene_telemetry_events, not a widened event type
-- there: that table's schema requires a non-null writer_id on every row
-- (0006_rename_leagues_telemetry_and_lock_migrations_table.sql), because
-- it's specifically writer-workflow telemetry (draft_started,
-- article_published). A page view has no writer — it's an anonymous
-- visitor reading published content — so forcing a writer_id there would
-- mean inventing a misleading value.
--
-- Append-only event log, not a running counter column on `articles`, so
-- per-day/week trends stay queryable later without a second migration —
-- the storage cost is trivial at this site's real traffic scale. No
-- visitor identity, IP, or any other client-side signal is ever stored —
-- just which article, and when — so this carries less privacy exposure
-- than a third-party analytics cookie ever would, not more.
--
-- The write path is src/site/render.ts's renderArticlePage — it already
-- holds a live Postgres connection and the matched article's id at
-- exactly the point a real (non-404) visitor request resolves.

create table if not exists arsene_article_views (
  id         uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles (id) on delete cascade,
  viewed_at  timestamptz not null default now()
);

create index if not exists arsene_article_views_article_id_idx
  on arsene_article_views (article_id);

create index if not exists arsene_article_views_viewed_at_idx
  on arsene_article_views (viewed_at);

-- RLS enabled, zero policies — same shape as arsene_telemetry_events:
-- reachable only through the service-role Postgres connection the Edge
-- Function already holds for public-page rendering and the
-- metrics-summary endpoint, never through PostgREST directly.
alter table arsene_article_views enable row level security;

-- service_role's own bypassrls skips row-level security, not table-level
-- grants, and 0002's blanket grant only covered tables that existed when
-- it ran — learned the hard way this session with article_authors (0009)
-- and writer_avatars (0010), and confirmed again live here: the render
-- pass's own view-insert 500'd with a plain Postgres "permission denied
-- for table" until this line was added.
grant select, insert, update, delete on arsene_article_views to service_role;
