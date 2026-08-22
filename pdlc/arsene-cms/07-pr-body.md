## Summary

Ships the Arsène CMS backend: the draft → upload → publish flow for
football-prediction writers, built to cut time-to-publish from ~50 minutes
(self-reported, manual) to under 10, at $0/mo hosting cost at launch.

- **Draft management**: create/reopen with staleness-checked edit locking
  (90s timeout, 20s heartbeat), so a crashed browser self-heals without an
  admin unlock.
- **Real Supabase Auth**: every writer-facing operation requires a valid
  JWT; `writer_id` comes from the token's `sub` claim, not a shared secret.
- **Async image pipeline**: uploads return immediately; S3 + Lambda (real
  `sharp`) convert to WebP/AVIF/HEIC off the request path, closing an
  earlier CPU-budget overrun on Supabase Edge Functions.
- **Publish**: slug + JSON-LD generation, on-demand ISR revalidation (only
  the changed article/category/homepage regenerate), and a recovery route
  (`DELETE /v1/articles/{id}/images/{id}`) for writers whose article gets
  stuck behind an image that will never convert.
- **Telemetry**: both events the success metric depends on
  (`draft_started`, `article_published`) are emitted server-side in the
  same request that makes them true — proven by hand against a real
  Postgres store at every one of the eight verify passes below, not just
  asserted by a unit test.

## How this got here

This branch went through **eight red → green → verify remediation cycles**
(2026-08-11 through 2026-08-20) before shipping. That's not a sign of
instability — it's the record of a verify gate that kept adversarially
re-deriving each fix from scratch rather than replaying the specific case
that was reported, and kept finding the next case two more times before the
underlying class of bug was actually closed. The full trail, one document
per gate per cycle, is in `pdlc/arsene-cms/`:

| Cycle | What it closed |
|---|---|
| 1 | Original build: draft/upload/publish, 127 tests |
| 2 | 3 High security findings (stored XSS, DoS ordering, weak auth) |
| 3 | 4 Medium + 2 Low findings from the security re-audit |
| 4 | A new High (no writer-authorization check at all) + HEIC decode broken in the real runtime |
| 5 | A truncated-image-upload bug that could permanently blank a live article's cover |
| 6 | Five further Medium findings, including two the previous pass's own fix had introduced |
| 7 | Two more findings in the same fix family (a regression, and a "non-deterministic" residual that turned out to be fully deterministic) |
| 8 | The consolidated recovery-path fix (see below), a render-side cover-blanking bug, and a database-level cover-uniqueness constraint |

Full detail per cycle: `03-red-evidence.v{1-8}.md`, `04-green-evidence.v{1-8}.md`,
`05-verification.v{1-8}.md` (plus `verify/integration-e2e-v{2-8}.md` for the
e2e agent's raw evidence). `traceability.md` maps every acceptance criterion
and NFR to the test(s) that prove it.

## Known limitations, shipped deliberately

Verify gate v8 found the eighth cycle's fixes structurally sound under very
thorough independent adversarial testing (a from-scratch state-space sweep,
a hand-constructed compare-and-swap race, direct privilege-table checks —
no High-severity finding anywhere). What remained were two findings about
**reach**, not correctness, and the product owner reviewed them and decided
to ship rather than continue remediation. Both are recorded in
`pdlc/arsene-cms/state.json`'s `overrides[0]`:

1. **Migration `0005` can't apply to a database already holding duplicate
   ready-cover rows** — a state proven reachable through ordinary
   concurrent use, invisible to this suite because every test database
   starts empty. If this branch is deployed to a database that has ever
   exhibited that state, the migration needs a manual pre-flight
   reconciliation first (see README § Known Limitations for the exact
   step). Tracked, not yet automated.
2. **The image-recovery route has no client method or contract
   declaration** — `src/api/discardImage.ts` is complete and correct
   server-side, but nothing in `src/api/client.ts` or
   `contracts/openapi.yaml` lets the (not-yet-built) editor SPA call it
   yet. A writer can recover a stuck article via a direct HTTP request
   today, not yet through the product.

Two further Low findings are tracked but weren't part of the override
(open, non-blocking): the recovery route has no rate limit or audit
trail, and every discard permanently orphans the file it pointed to in
Supabase Storage. See `05-verification.v8.md` §6.

## What this PR does not include

- The writer-facing editor SPA's actual UI — not built. `src/api/client.ts`
  is the typed client it will consume.
- A deploy pipeline, artifact versioning, or rollback mechanism — that's
  John's upcoming work (`pdlc/arsene-cms/state.json`'s `pipeline` gate is
  still `pending`).
- A way to measure the counter-metric (writer adoption must not decline) —
  flagged as an honest, documented gap since the architecture gate, not
  silently dropped. Re-confirmed uncomputable-from-events at every verify
  pass; the fallback is a manual proxy (published-article count per
  writer), not yet wired up.

## Test plan

- `npm install && npm run setup:contract && npm test` — 227/227 passing.
- `npx tsc --noEmit` — clean.
- Both sides of the OpenAPI contract exercised in-suite (Prism consumer,
  Schemathesis provider); higher-depth standalone fuzzing run at most
  verify passes found real bugs early (documented per-cycle in the
  verification docs) and nothing outstanding now beyond the two items
  above and the pre-existing, out-of-scope backlog noted in
  `05-verification.v8.md` §6.
- Polish gate run (`bob-janitor`): one unused test import removed, suite
  re-confirmed 227/227 unchanged before and after.

## Reviewer notes

- `state.json` was brought current as part of this cycle (previously stale
  since the first green pass) — it now reflects the real eight-cycle
  history and the override decision above, rather than looking like a
  single clean pass.
- If you're short on time, read `05-verification.v8.md` (the final verify
  report) and `state.json`'s `overrides[0]` — between them they're the
  complete, honest picture of what's solid and what's accepted risk.
