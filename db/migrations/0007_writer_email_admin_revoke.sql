-- Arsène — writers gain an email, an admin flag, and a soft-revoke.
--
-- Closing an access-control gap: today anyone with a valid Supabase Auth
-- session — whether or not a `writers` row exists for them — can read every
-- draft and edit any existing article via direct PostgREST (0001's RLS
-- policies are `using (true)`, no ownership check at all; only the Edge
-- Function's own isWriter() gate gets scoped, and that's invisible to a raw
-- PostgREST caller). This migration is the additive first half of the fix —
-- 0008 does the actual RLS tightening once these columns exist to check.
--
-- `email` is needed to show/manage an allow-list at all (the Admin API's
-- email lives in `auth.users`, which PostgREST/RLS cannot see, so this is a
-- deliberate denormalised copy, written by whichever path creates the
-- writer). `revoked_at` is a flag, not a row removal, because
-- `articles.writer_id` is `not null references writers (id)` with default
-- RESTRICT delete — hard-deleting a writer with existing articles fails
-- outright, so revocation has to preserve the row to preserve authorship
-- history. `is_admin` gives this project its first-ever admin/role concept;
-- there is exactly one admin as of this migration, seeded below.
--
-- Expand-only: additive columns, then one narrowing (`email` to not null)
-- only after backfilling the one real row — the same category of change
-- 0003–0005 already established as compatible with this project's
-- expand-only discipline.

alter table writers add column if not exists email text;
alter table writers add column if not exists is_admin boolean not null default false;
alter table writers add column if not exists revoked_at timestamptz;

-- Case-insensitive: stops "Racc@x.com" and "racc@x.com" being invited twice
-- and racing to create two Auth users for what the operator intends as one.
create unique index if not exists writers_email_unique_idx
  on writers (lower(email)) where email is not null;

-- The one real writer as of this migration (confirmed live against
-- production, not assumed): id 24f0b74e-2064-4bb3-bf76-046b84da0f34,
-- auth.users.email racc.leraccoon@gmail.com — already the admin email named
-- in the product ask. Guarded by id so this only ever touches that one row,
-- anywhere this migration runs (a fresh test database has no such row at
-- all, so this is a genuine no-op there).
update writers set email = 'racc.leraccoon@gmail.com', is_admin = true
 where id = '24f0b74e-2064-4bb3-bf76-046b84da0f34' and email is null;

-- Safe to tighten now: every writer-creation path (scripts/create-writer.ts
-- and the new admin-invite Edge Function route, both updated in this same
-- rollout) supplies email going forward, and the one existing row is backfilled
-- above.
alter table writers alter column email set not null;
