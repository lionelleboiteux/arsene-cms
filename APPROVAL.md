# Release approval — v0.2.0

**Decision: APPROVED.**
**Approved by:** Lionel Le Boiteux (lionel.leboiteux@gmail.com), in chat.
**Approved at:** 2026-08-22T21:05:00Z.
**Tag:** `v0.2.0`, commit `186adf92d0a223bf6268bfaba8e34fb52978f0a4` (annotated, created locally — not yet pushed; see "Deploy status" below).
**Note:** "Approve v0.2.0" — full release approved, no scoping to a subset.

This file is committed so a colleague running the deploy on a fresh checkout
can see the approval, what it covers, and what it does not, without having
to reconstruct the conversation that produced it.

---

## What shipped

The full draft-to-publish CMS backend for Fantasy Coach's writers (autosave/
crash-recovery, paste sanitization, structured pronos entries, staleness-
based locking, async S3+Lambda image pipeline with a recovery route,
SEO/JSON-LD/sitemap generation, republish, time-to-publish telemetry —
AC-01 through AC-18, full matrix in `pdlc/arsene-cms/traceability.md`), plus
two additions since v0.1.0:

1. The API server ported from Node's `http.createServer` to Deno's Fetch-API
   model (`src/api/router.ts`'s core + `supabase/functions/arsene-api/index.ts`)
   — the runtime `pdlc/arsene-cms/adr/` (ADR-0001) actually named.
2. A benefit dashboard (`dashboard/index.html`) and its read-only data
   adapter (`GET /internal/metrics/time-to-publish`).

Full detail: `CHANGELOG.md`'s `[0.2.0]` entry, `pdlc/arsene-cms/10-pipeline.v2.md`,
`pdlc/arsene-cms/11-dashboard.v1.md`.

## Verification results

- Verify gate v8 (2026-08-20): no High-severity finding; two Medium findings
  accepted below.
- Success metric proven computable for real at verify v1 §8 (corroborated
  through v8): two seeded articles published over real HTTP, telemetry read
  back with raw SQL — 8.01 min (meets the <10 min target) and 55.01 min
  (misses, worse than baseline, by design of that test case).
- This release: 244/244 tests pass (227 original + 6 real-`deno run` e2e +
  10 dashboard), `tsc --noEmit` and `deno check` both clean, zero
  regressions across both additions.

## Baseline captured

Pam's success metric — **~50 minutes, self-reported estimate**, captured
2026-08-22. Not yet confirmed by real usage: zero articles have been
published in production, so "current" is not measurable yet. The dashboard
shows this state explicitly (`state.json`'s `success.metrics[0].current`)
rather than a fabricated number. Counter-metric (writer adoption)
similarly unmeasured.

## Rollback mechanism and measured time

- **Migrations** (`db/migrations/0001`–`0005`, all confirmed expand-only,
  unchanged this release): code-only rollback. Measured against real
  Postgres: fresh deploy 1.08s, no-op re-deploy 0.24s, incremental 0.29s.
- **API server**: versioned redeploy via `supabase functions deploy`. Deno
  request-timeout mechanism measured at 1.502s against a configured 1500ms.
- **`v0.1.0` is not a safe rollback target for the API server** — it
  predates the Deno port and cannot run on the real Edge Function target at
  all. This is the first real deploy this product has ever attempted, so
  there is no previously-*deployed* good version to fall back to; "rollback"
  here means un-deploying, not redeploying an older tag. The stale `v0.1.0`
  tag (which pointed at a commit two features behind) was not reused —
  `v0.2.0` was cut fresh against current `HEAD`.
- The actual `supabase functions deploy` round-trip has **not been executed**
  against the real linked Supabase project — only local rehearsal (real Deno
  process, real Postgres, real HTTP; see `10-pipeline.v2.md` §2).

## One-way doors

- Migration `0005`'s data-compatibility gap (accepted risk, tracked,
  `state.json`'s `overrides[0]`) — not new to this release, no new migration
  added.
- No new schema one-way doors this release.
- Structural: being the first deploy means no rollback safety net the way a
  second-or-later deploy would have (see above).

## Residual risks (accepted as part of this approval)

1. Real deploy never rehearsed against the actual Supabase project.
2. `auth.ts` uses Supabase's legacy JWT-secret model (disclosed,
   non-blocking; current docs call it superseded — `10-pipeline.v2.md` §4).
3. Dashboard's browser rendering was not visually verified (no Chrome
   extension connected in the environment that built it).
4. Migration `0005`'s reconciliation step is still manual, not automated;
   the Cloudflare/public-site half of the architecture has no deployable
   artifact anywhere in this repo yet.

## Deploy status — the concrete next blocker

**Not yet deployed.** This repository has no git remote configured
(confirmed via `git remote -v` at approval time), so `.github/workflows/deploy.yml`
cannot run: there is nothing to push the `v0.2.0` tag to, and GitHub Actions
has nothing to trigger against. Before a real deploy can happen:

1. A remote must exist (a GitHub repo this project pushes to).
2. That repo needs `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, and
   `SUPABASE_DB_URL` configured as repository secrets.
3. The Edge Function's own runtime secrets (`SUPABASE_JWT_SECRET`,
   `IMAGE_CALLBACK_SECRET`, `CDN_ORIGIN`, `WRITER_TOKEN`, `WRITER_ID`,
   `DASHBOARD_READ_SECRET`) must be set on the real Supabase project via
   `supabase secrets set` — separately, not via CI.

This approval covers the release itself; it does not by itself set up a
remote or configure secrets neither this session nor any prior one has had
access to.
