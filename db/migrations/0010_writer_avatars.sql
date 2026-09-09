-- Arsène — writer avatars: a photo per writer, shown in the public byline.
--
-- Expand-only (02-architecture.v1.md §6): a new table alongside
-- `article_images`, not a generalisation of it. The pipeline underneath
-- both (S3 → Lambda → CDN, `src/api/s3Storage.ts`, `lambda/imageConvert/
-- handler.ts`, `/internal/images/{id}/status`) is already keyed purely by
-- the image's own UUID — no "article" concept below `uploadImage.ts` and
-- `article_images`' own schema (the `role` lockdown, the one-ready-cover
-- index), none of which applies to a one-per-writer avatar. Reused as-is.
--
-- No unique constraint on writer_id and no demotion logic: "current
-- avatar" is simply the most recent `ready` row. A re-upload never blanks
-- or blocks anything while the new one converts — the exact M-V7-02 bug
-- class already fixed this session for article covers — and a superseded
-- row is just harmless clutter, same as this codebase already accepts for
-- superseded article images.

create table if not exists writer_avatars (
  id                uuid primary key default gen_random_uuid(),
  writer_id         uuid not null references writers (id),
  status            text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  original_filename text not null,
  original_url      text,
  optimized_url     text,
  failure_code      text,
  failure_message   text,
  created_at        timestamptz not null default now()
);

create index if not exists writer_avatars_writer_idx on writer_avatars (writer_id, created_at desc);

alter table writer_avatars enable row level security;

-- Self-scoped, unlike articles/article_authors' "any active writer" model:
-- nothing else needs to poll another writer's avatar upload status via
-- PostgREST — the public byline reads through render.ts's own superuser
-- connection, RLS-exempt regardless of this policy.
drop policy if exists writer_reads_own_avatar on writer_avatars;
create policy writer_reads_own_avatar on writer_avatars
  for select to authenticated using (writer_id = auth.uid() and is_active_writer());

grant select on writer_avatars to authenticated;

-- service_role's own bypassrls skips row-level security, not table-level
-- grants, and 0002's blanket grant only covered tables that existed when
-- it ran — learned the hard way this session with article_authors (0009).
grant select, insert, update, delete on writer_avatars to service_role;
