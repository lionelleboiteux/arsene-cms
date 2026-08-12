-- Arsène — the draft lock belongs to the server seam, not to PostgREST.
--
-- 05-verification.v2.md M1 (NFR-LOCK-GRANT-01a/b): 0001's column grant let
-- `authenticated` write `locked_by`/`locked_at` directly, so any writer could
-- `PATCH /rest/v1/articles?id=eq.<id>` and take a colleague's live lock — or
-- keep refreshing an abandoned one — without ever going through
-- `repo.takeLock()`'s compare-and-swap (ADR-0003). The application-level CAS is
-- only a lock if the data layer agrees it is.
--
-- After this migration the lock columns sit on the same side of the grant line
-- as the publish-controlled ones (status, slug, published_at, ...): written
-- only by the seams running as `service_role`, i.e. reachable only through
-- `POST /v1/articles/{id}/open`, which is where the CAS lives. A writer who
-- tries it directly gets a loud 42501 rather than a silent theft.
--
-- Expand-only (02-architecture.v1.md §6): no column or table is dropped or
-- retyped; only a privilege is narrowed.

revoke update (locked_by, locked_at) on articles from authenticated;
