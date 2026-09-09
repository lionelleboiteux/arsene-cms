-- Arsène — co-authored articles: a join table for shared byline credit.
--
-- Expand-only (02-architecture.v1.md §6): this adds a table and backfills it
-- from `articles.writer_id`, which itself is untouched — it stays "who
-- created the draft" (locking, telemetry attribution), while
-- `article_authors` becomes the single source of truth for who is *credited*
-- on the public byline. `ordinal` decides display order, not uniqueness: no
-- `unique(article_id, ordinal)` here, since the frontend computes it
-- best-effort (`max(ordinal)+1`) and a rare race on two simultaneous adds
-- should produce a harmless ordering tie, not a write failure.
--
-- RLS mirrors `articles`' own `writers_manage_articles` policy (0008) exactly
-- — any active writer, not ownership-scoped — matching this project's
-- already-established "no role hierarchy" model (spec §2/§8) rather than
-- inventing a stricter one for just this table.

create table if not exists article_authors (
  article_id uuid not null references articles (id) on delete cascade,
  writer_id  uuid not null references writers (id),
  ordinal    smallint not null,
  created_at timestamptz not null default now(),
  primary key (article_id, writer_id)
);

create index if not exists article_authors_article_idx on article_authors (article_id, ordinal);

alter table article_authors enable row level security;

drop policy if exists writers_manage_article_authors on article_authors;
create policy writers_manage_article_authors on article_authors
  for all to authenticated using (is_active_writer()) with check (is_active_writer());

grant select, insert, delete on article_authors to authenticated;

-- `service_role` (0002) has `bypassrls`, but that only skips row-level
-- security policies — it still needs an explicit table-level GRANT, and
-- 0002's own blanket `grant all on all tables in schema public` only ever
-- covered tables that existed at the moment it ran, not this one. Without
-- this, `insertDraft`'s own article_authors insert (src/api/repo.ts) fails
-- `42501 permission denied for table article_authors` — confirmed by
-- reproducing it directly against a real service_role-scoped connection
-- before adding this grant.
grant select, insert, update, delete on article_authors to service_role;

-- Every existing article's sole writer_id becomes its ordinal-1 author, so
-- the public byline (src/site/render.ts) has something to aggregate from
-- for content that predates this migration.
insert into article_authors (article_id, writer_id, ordinal)
  select id, writer_id, 1 from articles
  on conflict do nothing;
