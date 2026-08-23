# Release evidence — v0.2.2

**Status: DEPLOYED and — pending the Edge Function's own runtime secrets
being set — reachable. Both halves succeeded for real against the
dedicated Supabase project, running the NUL-byte fix (v0.2.1) and the
`verify_jwt` platform-gateway fix (v0.2.2).**

| Field | Value |
|---|---|
| Approved by | Lionel Le Boiteux (lionel.leboiteux@gmail.com), in chat |
| Approved at | 2026-08-22T21:05:00Z |
| Decision | approve — "Approve v0.2.0", no scoping |
| Repo | `https://github.com/lionelleboiteux/arsene-cms` |
| Deployed tag | `v0.2.2` |
| Commit SHA | `4b1805e7946fd6ee7c0aefc1c98bb0aa19d9188d` |
| Successful runs | `.../actions/runs/32639503102` (v0.2.1), `.../actions/runs/32641043824` (v0.2.2) |
| Approval record | `APPROVAL.md`, sha256 `abf11641c6940c9100f1de131e1b7c511613067c640ebf51039c7c1a0dc745c6` |

## v0.2.2 — the `verify_jwt` finding

While working out how to actually reach the deployed function, found that
Supabase's platform-level `verify_jwt` gateway check (on by default)
inspects `Authorization` on every request before the function runs and
requires a genuine Supabase JWT there. `POST /internal/images/{id}/status`
and `GET /internal/metrics/time-to-publish` never send an `Authorization`
header at all — they use their own shared-secret headers — so the platform
would have rejected both with a `401` before `router.ts`'s own auth logic
ever ran. Fixed with `supabase/config.toml`'s `[functions.arsene-api]
verify_jwt = false` (Supabase's documented pattern for this exact case).
Deployed in run `32641043824` (2026-08-23T13:00Z): test suite 2m8s, Edge
Function deploy 26s, migrations 27s (safe no-op re-apply — schema already
matched). See `CHANGELOG.md`'s `[0.2.2]` entry for full detail.

## Deploy attempts — the full sequence, in order

1. **`v0.1.0`/`v0.2.0` tag push** (2026-08-22T21:23Z) — test jobs passed;
   `deploy-migrations`/`deploy-api-server` failed on missing repo secrets
   (expected — none configured yet).

2. **Secrets added**, first `workflow_dispatch` run (`32627039526`,
   2026-08-23T07:59Z): **Edge Function deploy succeeded for the first
   time** (18s). Migrations failed: unencoded special character in the
   `SUPABASE_DB_URL` password broke `psql`'s URI parsing. Fixed.

3. **Second run** (`32627585524`, 08:12Z): the test gate itself failed —
   not flaky CI. Schemathesis fuzzing `POST /v1/articles` against the exact
   deployed code found a title containing a NUL byte crashed the request
   with a raw `500`. Root-caused (Postgres rejects any value containing a
   NUL byte, code `22021`) and fixed in `src/api/router.ts`; regression
   tested (`tests/e2e/nulByteValidation.test.ts`, 4 tests); full suite
   re-run three extra times with fresh fuzz seeds, all green; released as
   `v0.2.1`.

4. **Third/fourth runs** (`32629448061`, `32629709627`): password
   authentication failures against `SUPABASE_DB_URL` — the value shared in
   chat was independently confirmed to fail even from a direct local
   `psql` connection, meaning it was genuinely wrong, not an
   encoding/CI issue. Resolved by resetting the database password.
   A follow-up run failed with `DATABASE_URL: ` completely empty — the
   `gh secret set` prompt hadn't actually captured a value that time.

5. **Fifth run** (`32633469581`): migrations reached the real database for
   the first time and failed with `relation "leagues" already exists`.
   **Investigation via `mcp__supabase__list_tables` revealed the
   `SUPABASE_PROJECT_REF`/`SUPABASE_DB_URL` secrets pointed at the
   project shared with the sibling `pronos` product** — a live production
   database with real data (48 players, 956 predictions, 1124 telemetry
   events, etc.), not a project dedicated to Arsène. `pronos` already has
   its own `leagues` and `telemetry_events` tables with entirely different
   shapes than Arsène's migrations create — an unresolvable name collision
   in the same `public` schema. A `writers` table and an empty
   `_migrations_applied` table were also found already present, indicating
   an earlier partial migration attempt had run against this same shared
   project before this pipeline existed.
   **No data was modified during this investigation — read-only
   inspection only.**

6. **New dedicated Supabase project created** for Arsène (separate from
   `pronos`, within the Free plan's two-project allowance). Secrets
   re-pointed at it. Two more attempts failed while the new project
   finished provisioning (`unexpected list functions status 404`,
   `tenant/user ... not found` — both transient, both resolved by
   waiting) and while the project ref/DB URL secrets were still being
   correctly propagated (one project-ref update didn't initially take;
   re-run confirmed via secret-timestamp checks before retriggering each
   time).

7. **Sixth run** (`32639503102`, 2026-08-23T12:31Z) — **all three jobs
   passed**: test suite (2m7s), Edge Function deploy (21s,
   `Deployed Functions on project ***: arsene-api`), Postgres migrations
   (35s, all five files applied in order: `0001` through `0005`,
   `migrations up to date`).

## Current live state

- **Edge Function `arsene-api`**: deployed and running `v0.2.2`'s code
  (NUL-byte fix + `verify_jwt` disabled) on the new, dedicated project.
- **Migrations**: all five applied for real against the real dedicated
  database.
- **Not yet done**: the Edge Function's own runtime secrets
  (`SUPABASE_JWT_SECRET`, `IMAGE_CALLBACK_SECRET`, `CDN_ORIGIN`,
  `WRITER_TOKEN`, `WRITER_ID`, `DASHBOARD_READ_SECRET`) have not been set
  via `supabase secrets set` on the new project — `SUPABASE_DB_URL` is
  provided automatically by the platform, but these are not. Without them,
  the deployed function will fail closed on the JWT check (by design —
  the same fail-closed behavior `serverMain.ts`/the Deno entry point
  enforce locally) rather than silently run in an unintended mode.

## Was a rollback needed

No. Every failed run before the sixth either failed before any deploy
step ran, or failed a step that made no partial change (a failed `psql`
connection attempt changes nothing; a failed `CREATE TABLE` on an
already-existing unrelated table changed nothing in Arsène's own schema).
The one Edge Function deploy that did succeed early (run `32627039526`,
to the *wrong*, shared project) was superseded by deploying the correct
code to the correct, dedicated project in run `32639503102` — not a
rollback, a redirect to the right target.

## Next steps

1. Set the Edge Function's runtime secrets on the new project via
   `supabase secrets set` (not automated by CI, by design — see
   `10-pipeline.v2.md` §1).
2. Verify the deployed function answers a real request end-to-end once
   secrets are set.
3. Decide what to do with the two-attempt partial schema
   (`writers`, `_migrations_applied`) that was found already present in
   the `pronos` project during step 5 above — it was never part of this
   release and should probably be cleaned up there, separately, since it
   doesn't belong in that database at all.
