# Release evidence — v0.2.0 / v0.2.1

**Status: real deploy attempted. Edge Function deployed successfully;
migrations blocked on a connection-string encoding issue; a real,
previously-unknown bug was found by contract fuzzing against the live
deploy and fixed in v0.2.1, not yet re-deployed.**

| Field | Value |
|---|---|
| Approved by | Lionel Le Boiteux (lionel.leboiteux@gmail.com), in chat |
| Approved at | 2026-08-22T21:05:00Z |
| Decision | approve — "Approve v0.2.0", no scoping |
| Repo | `https://github.com/lionelleboiteux/arsene-cms` (created and pushed 2026-08-23) |
| Tags | `v0.1.0`, `v0.2.0` pushed 2026-08-22T21:23Z; `v0.2.1` not yet cut |
| Commit SHA (v0.2.0) | `186adf92d0a223bf6268bfaba8e34fb52978f0a4` |
| Approval record | `APPROVAL.md`, sha256 `abf11641c6940c9100f1de131e1b7c511613067c640ebf51039c7c1a0dc745c6` |

## Deploy attempts — what actually happened, in order

1. **`v0.1.0`/`v0.2.0` tag push** (2026-08-22T21:23Z) — both triggered
   `deploy.yml` automatically. Test job passed on both (real CI, real
   suite). `deploy-migrations` failed on both: `DATABASE_URL must be set`
   (no repo secrets configured yet — expected). `deploy-api-server` failed
   on `v0.2.0` (`Missing value for flag --project-ref`, expected) and hit
   its own deliberate loud-failure stub on `v0.1.0` (expected, by design).

2. **Secrets added** (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
   `SUPABASE_DB_URL`) — 2026-08-23T07:52–07:54Z.

3. **First real `workflow_dispatch` run** (run `32627039526`,
   2026-08-23T07:59Z, `--ref v0.2.0`): test job passed (1m46s).
   **`Deploy API server (Supabase Edge Function)` succeeded in 18s** — the
   first real Edge Function deploy this project has ever made.
   `Deploy Postgres migrations` **failed** in 21s:
   `psql: error: invalid integer value ".QH*nbi+DC" for connection option
   "port"` — the `SUPABASE_DB_URL` secret's password contained an
   un-percent-encoded special character, which shifted `psql`'s URI
   parsing. Fixed by re-setting the secret with the password properly
   encoded.

4. **Second real run** (run `32627585524`, 2026-08-23T08:12Z, `--ref
   v0.2.0`): test job **failed** at `npm test` — not flaky CI. Schemathesis
   fuzzing `POST /v1/articles` found a title containing a NUL byte crashed
   the request with a raw `500`, caught for real, in CI, against the exact
   code being deployed. Since the test gate failed, `deploy-migrations` and
   `deploy-api-server` were both skipped — **the already-deployed Edge
   Function from run `32627039526` was never rolled back or replaced by
   this run**; it is still the last thing actually deployed as of this
   writing.

5. **Root-caused and fixed** locally: Postgres text columns reject any
   value containing a NUL byte (`error: invalid byte sequence for encoding
   "UTF8": 0x00`, code `22021`); nothing validated against it before
   `repo.ts`'s insert. Fixed in `src/api/router.ts` by rejecting a NUL byte
   in every free-text field `CreateDraftBody`/`PublishBody` accept, at the
   same Zod-validation layer that already rejects other malformed input.
   Confirmed against a real server (500 → clean 400); regression-tested in
   `tests/e2e/nulByteValidation.test.ts` (4 new tests, all passing). Full
   suite re-run three extra times with fresh random fuzz seeds, all green.
   `CHANGELOG.md`'s `[0.2.1]` entry has the full detail.

## Current live state (as of this writing)

- **Edge Function `arsene-api`**: deployed, from `v0.2.0`'s code — the
  version **with** the NUL-byte bug. Not yet redeployed with the fix.
- **Migrations**: not yet applied to the real project (blocked on the
  connection-string issue during the run that would have applied them;
  that run's migration job failed before the fix above existed).
- **`v0.2.1`**: fix committed locally, not yet tagged, pushed, or deployed.

## Was a rollback needed

Not for the Edge Function deploy itself (it succeeded). No migration was
ever applied to the real database, so there is nothing to roll back there
either. The live Edge Function currently running v0.2.0's code (with the
known NUL-byte bug) should be treated as **needing a follow-up deploy of
v0.2.1**, not as a rollback target — the fix is forward, not a revert.

## Next update to this file

Once `v0.2.1` is tagged, pushed, and its deploy workflow run completes:
record the new tag, the workflow run URL, migration apply output (this
will be the *first* real migration apply against the live project), and
confirm the NUL-byte fix is live by re-running the same fuzz case (or
trusting the regression test, now that it passed in CI once already).
