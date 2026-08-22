# arsene-cms — Pipeline gate (v1)

**Status: PARTIAL — the migration deploy/rollback mechanism is real, built,
and rehearsed for real. The API server's deploy mechanism is blocked on an
architecture decision this gate surfaced but cannot resolve on its own.**

**Run:** 2026-08-22, branch `feat/arsene-cms`, against commit `a2b3a3f`.

---

## 0. What this gate found, up front

The architecture document (`02-architecture.v1.md` §6) names its rollback
mechanism precisely: Tier 1 platform-native instant rollback — Cloudflare
Pages retains every deployment (instant promote), Supabase Edge Functions
roll back via versioned redeploy. This gate's job is to implement that
choice and rehearse it for real. Two things happened instead of a clean
implementation:

1. **This repository has no deployable Cloudflare Pages artifact.** No
   Next.js app, no build script, no Pages/Workers config exist anywhere in
   the codebase (confirmed: `package.json` has no frontend framework
   dependency, no `build` script; `src/site/render.ts` is render *logic* —
   HTML/JSON-LD strings computed from Postgres — not a deployable
   application). That half of the architecture's rollback story belongs to
   a codebase that doesn't exist yet, whether that's a separate repo or an
   unscaffolded part of this one. Not this gate's call to resolve.
2. **The API server, as built, cannot run on Supabase Edge Functions.**
   Confirmed by inspection: `src/api/router.ts` is built on Node's
   `http.createServer` (`import http from 'node:http'`), and
   `src/api/server.ts` starts the process via `node:child_process.spawn()`.
   Supabase Edge Functions run on Deno with a Fetch-API handler model
   (`Deno.serve((req: Request) => Promise<Response>)`) and no child-process
   support — this isn't a config difference, it's a different execution
   model. Nothing in eight red/green/verify remediation cycles caught this,
   because every test exercised the code via a real spawned Node child
   process (correctly, for testing) — nothing ever asked whether that
   process could run on the platform the architecture actually named.

Per this gate's own instructions: *"if [the rollback mechanism] is vague or
turns out to be impossible, that is a finding to take back rather than a
gap to improvise around."* This is that finding. It was raised with the
product owner mid-gate rather than silently worked around; the product
owner's direction was to build and rehearse the part of the pipeline that
**is** real (the Postgres migration deploy) and document the API-hosting
gap as blocking, rather than build a deploy step that would fail on first
real use. That's what follows.

---

## 1. Mechanism (migration half — real, built, rehearsed)

- **Deploy trigger**: a pushed tag matching `v*`, or manual dispatch with a
  tag input (`.github/workflows/deploy.yml`).
- **Deploy gate**: the full test suite (`npm test`, 227 tests) and
  `tsc --noEmit`, both against the exact tagged commit, must pass before
  any migration is applied.
- **Migration deploy**: `scripts/deploy-migrations.sh`, applying
  `db/migrations/*.sql` in order against `$DATABASE_URL` (a GitHub Secret,
  `secrets.SUPABASE_DB_URL` — never read from the repo). Idempotent: tracks
  applied migrations in a `_migrations_applied` table, so re-running the
  same deploy is always a safe no-op and an incremental deploy applies only
  what's new.
- **Rollback trigger**: `.github/workflows/rollback.yml`, `workflow_dispatch`
  with a required tag input — a separate workflow, not a job buried inside
  deploy, so it's runnable from the Actions UI with no code change.
- **Migration rollback**: none, deliberately. Every migration (0001-0005) is
  confirmed expand-only (§4 below) — the mechanism is that code rolls back,
  the schema never does, and expand-only discipline is precisely what makes
  that safe. Supabase Free/Pro has no PITR/schema rollback in any case,
  which the architecture doc already names as an accepted, shared
  constraint with the sibling pronos project.
- **Secrets**: `SUPABASE_DB_URL` only, GitHub Secrets, referenced via
  `${{ secrets.SUPABASE_DB_URL }}`, never printed or committed.

## 2. Mechanism (API server half — blocked)

No deploy or rollback mechanism is built for the API server. Both
`deploy.yml`'s `deploy-api-server` job and `rollback.yml`'s
`redeploy-api-server` job exist as explicit, loudly-failing stubs that name
this exact gap rather than silently omitting the step — so anyone who
triggers a full pipeline run gets a clear, immediate answer, not a false
sense of completeness or a confusing failure three steps later.

**What needs to happen before this can be built for real** (not this gate's
decision, recorded here so it reaches whoever's decision it is):
- **Option A** — port `src/api/router.ts`'s transport layer from
  `http.createServer` to a Fetch-API handler (`Deno.serve`), and remove the
  `child_process.spawn` pattern from the real (non-test) entry point. This
  is a real engineering task — arguably its own red/green/verify cycle, not
  pipeline-gate work — since it changes how every route is invoked and
  needs the same rigor the rest of this codebase has had.
- **Option B** — deploy the Node server as built to a Node-compatible host
  (a small always-on process, a serverless-Node platform, etc.). This
  reopens ADR-0001's cost analysis: Edge Functions were chosen specifically
  for $0/mo hosting with no always-on compute, which most Node-hosting
  options don't offer without cost or unpredictable cold starts. Whichever
  host is chosen, this gate would then build and rehearse that host's real
  deploy + rollback mechanism, the same way the migration half was rehearsed
  below.

Once either path is chosen and built, it needs the same standard the
migration half was held to here: rehearsed for real, with a measured
number, not an estimate.

## 3. Rehearsal — what was actually measured, against real infrastructure

Real Postgres 16 (`docker run postgres:16-alpine`), not mocked, not the
project's Testcontainers test harness (deliberately — this rehearses the
actual deploy script a real pipeline run would execute, `scripts/deploy-migrations.sh`,
against a real `psql`, exactly as `deploy.yml` invokes it).

| Scenario | Result | Time |
|---|---|---|
| Fresh deploy (all 5 migrations, empty database) | 5/5 applied, exit 0 | **1.08s** |
| Re-deploy, same tag (idempotency check) | 5/5 skipped, exit 0, no changes | **0.24s** |
| Incremental deploy (0001-0004 already live, only 0005 new) | 4 skipped + 1 applied, exit 0 | **0.29s** |

All three runs against the real script (`scripts/deploy-migrations.sh`),
real `psql`, real Postgres — not simulated, not estimated.

### The known one-way door, reproduced and its fix verified

`05-verification.v8.md` §4 (accepted as a known limitation in
`state.json`'s `overrides[0]`) found that migration `0005` can't apply to a
database already holding duplicate `ready`-cover rows. This gate reproduced
that failure for real, and verified the fix:

```
-- seeded the exact reported state: two ready cover rows on one article
$ psql $DATABASE_URL -f db/migrations/0005_one_ready_cover_per_article.sql
ERROR:  could not create unique index "article_images_one_ready_cover_per_article"
DETAIL:  Key (article_id)=(22222222-2222-2222-2222-222222222222) is duplicated.
-- (0.09s to fail; no partial state, no corruption — the duplicate rows are untouched,
--  the index simply doesn't exist yet)

-- applied the pre-flight reconciliation the verify report recommended:
update article_images src set role = 'body'
 where role = 'cover' and status = 'ready'
   and id <> (select dst.id from article_images dst
               where dst.article_id = src.article_id
                 and dst.role = 'cover' and dst.status = 'ready'
               order by dst.created_at desc, dst.id limit 1);
-- UPDATE 1 (demoted the older of the two rows)

$ psql $DATABASE_URL -f db/migrations/0005_one_ready_cover_per_article.sql
CREATE INDEX
-- (0.09s, succeeds cleanly)
```

**This reconciliation step is not yet automated into `0005`'s own SQL or
into `scripts/deploy-migrations.sh`.** It's verified to work, but a real
deploy against a database that has ever exhibited the duplicate-cover state
still needs a human (or a future automated pre-flight check) to run it
first. Recommended for the next migration-tooling pass: either fold the
reconciliation into `0005` itself (making the migration self-healing) or
add a pre-flight check to `deploy-migrations.sh` that detects the violating
state and refuses to proceed without `--force-reconcile`, rather than
letting the bare index-creation error be the first signal.

## 4. Migration safety — expand-only, confirmed by inspection of every migration

| Migration | Change | Expand-only? |
|---|---|---|
| `0001_initial_schema.sql` | Initial schema (baseline) | N/A — nothing precedes it |
| `0002_service_role.sql` | Adds a role + grants | Yes — pure addition |
| `0003_lock_columns_service_role_only.sql` | `REVOKE UPDATE` on two columns | Yes — narrows a privilege, drops/retypes nothing |
| `0004_image_role_service_role_only.sql` | `REVOKE UPDATE` on one column | Yes — same |
| `0005_one_ready_cover_per_article.sql` | `CREATE UNIQUE INDEX` | Yes — pure addition |

No `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN ... TYPE`, or `RENAME`
anywhere in the five files. Confirmed by reading every migration in full,
not by trusting each file's own header comment (though every one carries an
accurate one).

**One nuance worth stating plainly, since it's exactly the kind of thing a
future migration could get wrong**: `0003` and `0004` revoke privileges
that `authenticated` (i.e., direct PostgREST access) held — but the
legitimate server-side code paths never depended on those grants; they run
as `service_role` and always did. The revocations closed unauthorized
direct-database-access patterns (M-V4-02, M-V6-02), not anything the
application itself used. This is *why* revoking them is safe under
code-rollback: rolling back to a pre-`0004` version of the API server does
not need the `role` grant back, because that version's legitimate code
never used it either.

## 5. One-way doors found

**One, previously known and now independently reproduced**: migration
`0005` cannot apply to a database already holding duplicate ready-cover
rows without a manual pre-flight step (§3 above). This is not a schema
one-way door (the migration itself is expand-only) — it's a **data-state**
one-way door: expand-only schema changes can still fail to apply if
existing data violates a newly-added constraint. Worth generalizing as a
standing check for any future migration in this project that adds a
`UNIQUE` or `CHECK` constraint: expand-only-in-shape does not automatically
mean deployable-to-every-existing-database-state.

No other one-way doors found across `0001`-`0005`.

## 6. What this gate did not touch

- `state.json`'s `overrides[0]` (the two accepted verify-v8 limitations) —
  unchanged, this gate's findings are additive to that record, not a
  replacement for it.
- Any real deployment. Nothing in this rehearsal touched the actual linked
  Supabase project (`dmytkubjxwwwkroutvdu`) or any Cloudflare account.
  Everything measured above ran against disposable local Postgres
  containers, created and destroyed within this gate's own session.
- Git tags were created locally (`v0.1.0`, matching `CHANGELOG.md`) but not
  pushed — consistent with this branch's standing practice of not pushing
  or opening PRs without explicit confirmation.

## 7. Gate verdict

**Not a clean pass.** The migration half of the pipeline is genuinely done:
built, idempotent, rehearsed three ways against real infrastructure, with
the one known one-way door reproduced and its fix verified. The API server
half cannot be built without first resolving which runtime it actually
targets — a finding this gate is required to take back rather than
improvise around, per its own instructions.

**Recommended next steps, in order:**
1. Product/architecture decision on the API server's real hosting target
   (Option A — port to Deno/Edge Functions, or Option B — a Node-compatible
   host, reopening ADR-0001's cost analysis). Not resolvable by this gate.
2. Once decided: build and rehearse that half's deploy + rollback mechanism
   to the same standard as §3 above — a real deploy, a real rollback, a
   real measured number.
3. Fold `0005`'s pre-flight reconciliation into either the migration itself
   or `deploy-migrations.sh`, so the known one-way door stops requiring a
   human to remember it.
4. Resolve where the Cloudflare Pages / public-site deployable artifact
   actually lives (a separate repo, or an unscaffolded part of this one) —
   needed before that half of the architecture's rollback plan can be
   implemented at all.
