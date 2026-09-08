-- Arsène — RLS actually requires an active writer, not just `authenticated`.
--
-- The change that makes 0007's columns (and the admin allow-list UI built on
-- top of them) mean anything, rather than just adding an invite form next to
-- a database anyone signed-in can still read and deface directly. Every
-- `writers_manage_*` policy from 0001 is `using (true) with check (true)` —
-- zero ownership scoping. Combined with the blanket grants also from 0001,
-- any Supabase Auth session (self-signup or otherwise, whether or not a
-- `writers` row exists for it) can currently read every draft and update
-- any existing article's title/body/taxonomy via direct PostgREST, with the
-- Edge Function's own isWriter() gate never in the picture — that gate only
-- protects `/v1/*` Edge Function routes, not raw PostgREST calls. This
-- closes that: `authenticated` alone stops being sufficient; an active
-- (non-revoked) `writers` row now is the actual authorization decision,
-- matching what 02-architecture.v1.md §7 already assumed was true.

-- Mirrors the real project's own auth.uid() exactly (confirmed by reading
-- pg_get_functiondef('auth.uid()'::regprocedure) against the live project
-- immediately before writing this migration — Supabase-owned, not this
-- project's, so this is a snapshot, not something this migration should ever
-- need to touch again). Guarded to be a true no-op in production, where the
-- function already exists: it only ever fires against tests/db's bare
-- Testcontainers Postgres, which has no `auth` schema at all — no migration
-- or test in this repo has ever referenced auth.uid() before this one, since
-- no policy has ever depended on who the caller is.
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    create schema if not exists auth;
    create function auth.uid() returns uuid language sql stable as $fn$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $fn$;
  end if;
end
$$;

-- `security definer`, not `stable` alone: this function's own `select ...
-- from writers` must not be subject to writers' own RLS (narrowed to
-- nothing, below) or the check recurses into itself and locks out every
-- caller, admin included. This is the single easiest way to get this
-- migration subtly wrong.
create or replace function public.is_active_writer() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from writers where id = auth.uid() and revoked_at is null
    )
$$;

revoke all on function public.is_active_writer() from public;
grant execute on function public.is_active_writer() to authenticated;

-- Same shape everywhere `using (true) with check (true)` was the policy.
-- pronos_entries/site_assets are included alongside the four the product ask
-- named directly — same vulnerability, same fix, for consistency rather than
-- leaving two tables writable by any authenticated session while their
-- siblings require an active writer.
drop policy if exists writers_manage_leagues    on arsene_leagues;
drop policy if exists writers_manage_categories on categories;
drop policy if exists writers_manage_articles   on articles;
drop policy if exists writers_manage_images     on article_images;
drop policy if exists writers_manage_pronos     on pronos_entries;
drop policy if exists writers_manage_assets     on site_assets;

create policy writers_manage_leagues    on arsene_leagues  for all to authenticated using (is_active_writer()) with check (is_active_writer());
create policy writers_manage_categories on categories      for all to authenticated using (is_active_writer()) with check (is_active_writer());
create policy writers_manage_articles   on articles        for all to authenticated using (is_active_writer()) with check (is_active_writer());
create policy writers_manage_images     on article_images  for all to authenticated using (is_active_writer()) with check (is_active_writer());
create policy writers_manage_pronos     on pronos_entries  for all to authenticated using (is_active_writer()) with check (is_active_writer());
create policy writers_manage_assets     on site_assets     for all to authenticated using (is_active_writer()) with check (is_active_writer());

-- writers' own blanket read: confirmed nothing in the frontend or tests ever
-- selects from `writers` via PostgREST — the public byline (src/site/
-- render.ts) and the SPA's lock-holder display name both go through a
-- service_role-backed path instead, RLS-exempt regardless of this policy.
-- With `email` now a column (0007), leaving this open would hand every
-- writer's email to any signed-in session (writers_read_writers) or any
-- anonymous visitor at all (anon_reads_writers) — closing both outright
-- rather than narrowing, since nothing needs even "read your own row".
drop policy if exists anon_reads_writers   on writers;
drop policy if exists writers_read_writers on writers;
revoke select on writers from anon, authenticated;
