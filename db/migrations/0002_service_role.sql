-- Arsène — the elevated role the server-side seams run as.
--
-- Expand-only (02-architecture.v1.md §6): this migration adds a role and
-- grants, and changes nothing `authenticated` or `anon` already had.
--
-- 05-verification.v1.md §4: `authenticated` has no INSERT on articles /
-- article_images — correctly, so that a client cannot create an article and
-- silently skip the `draft_started` metric, and cannot spoof `writer_id`. That
-- leaves the draft-creation seam (`src/api/createDraft.ts`, wired through
-- `POST /v1/articles`) needing a role that *can*. Supabase provisions exactly
-- such a role, `service_role`, in every hosted project; it is created here so a
-- bare Postgres matches production, the same way 0001 creates `anon` and
-- `authenticated`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- `nologin` + `bypassrls` is Supabase's own definition: the role is only
    -- ever reached by `set role` from an already-authenticated connection, and
    -- RLS policies keyed on `auth.uid()` cannot express "the server itself".
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to service_role;

-- The seam writes the rows RLS deliberately keeps out of `authenticated`'s
-- reach (VERIFY-04b / NFR-GRANT-01), and reads/updates everything the publish
-- and image paths already touch.
grant all on all tables in schema public to service_role;
