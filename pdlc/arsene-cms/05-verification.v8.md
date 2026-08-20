# arsene-cms — Verify gate, eighth pass (v8)

**Status: NOT PASSED — the discard route this pass built to close the
permanently-unpublishable-article gap is itself very thoroughly verified and
holds up under adversarial testing, but two independent agents found two
different, real reasons the fix as shipped doesn't yet deliver on its own
premise: the migration that enforces cover uniqueness cannot apply to a
database already holding the state it was written to fix, and the recovery
route has no client method or contract declaration, so the product's own
editor SPA cannot call it.**
**Run:** 2026-08-20, branch `feat/arsene-cms`, against commit `526847b`
(green remediation v8: 227/227, closing the consolidated §4 recovery-path
finding, M-V7-02, and L-V7-01 from `05-verification.v7.md`).
**Method:** `bob-security-auditor`, `bob-perf-analyst` and an integration/e2e
runner, run fresh and independently in parallel, each briefed to treat the
new discard route with the same "adversarially re-derive from scratch"
discipline the last two passes applied to the readiness gate — this is the
first genuinely new writer-facing capability added in the exact area
(`article_images` state) that has produced a security bypass once and two
correctness bugs since. Plus an instrumentation proof run by hand (Bob).

---

## 0. Executive summary

- **The discard route itself is the best-verified new capability this
  project has shipped.** Both the security auditor and the e2e agent
  independently, adversarially, tried to break it — the security auditor
  built the ADR-0004 callback race by hand and confirmed the compare-and-swap
  resolves correctly both ways; confirmed directly against
  `information_schema` (not the migration's prose) that no new grant was
  added; and confirmed the proactively-added draft-lock check actually works,
  identically to publish and upload, at the exact staleness boundary. The
  e2e agent ran 112 hand-driven checks including 40 randomized product-route
  sequences reaching 33 distinct settled image states, 20 attack shapes
  against the abuse-prevention control, and race trials with a genuinely
  open concurrency window in 5/5 attempts — zero product failures, zero
  ways to discard something still needed, zero 5xx responses anywhere.
- **M-V7-02 (render.ts cover-blanking) and L-V7-01 (cover uniqueness) are
  both genuinely closed**, confirmed independently by both agents — the e2e
  agent's 300-sample conversion-window trace showed exactly one `og:image`
  value throughout (the last-known-good cover, never blank), and the
  perf agent's `EXPLAIN ANALYZE` comparison found the new index doesn't just
  cost nothing on the hot path — it measurably *improves* `render.ts`'s query
  plan by becoming the subquery's own access path.
- **What blocks: two different agents found two different reasons the
  recovery-path fix doesn't yet fully deliver, and both are real:**
  1. **Security auditor**: migration `0005`'s unique index cannot be applied
     to any database that already holds duplicate `ready` cover rows — which
     is exactly the state `05-verification.v7.md`'s L-V7-01 proved is
     reachable through ordinary concurrent use. Reproduced directly: applying
     `0005` to a database seeded with that state aborts with a Postgres
     uniqueness-violation error during index creation, not after. Because
     every test database in this suite starts empty, no test can see this —
     the gate is passing on evidence that wouldn't describe a real deployment
     if this state has ever occurred in production.
  2. **E2e agent**: the discard capability has no client method
     (`src/api/client.ts` exposes 4 methods, not this one) and no contract
     declaration — confirmed by both agents independently, and accurately
     disclosed as a deliberate deviation in `04-green-evidence.v8.md` §7, but
     its consequence wasn't fully weighed: the entire point of this pass was
     giving a writer a way out of a permanently-stuck article, and as shipped
     there is no way for the product's actual editor SPA to reach that route
     at all. The server-side fix is complete; the product-level fix isn't.
- **Two further Low findings, corroborated independently by both agents**:
  the discard route has no rate limit and writes no audit/telemetry record
  (the only mutating route with neither), and every discard permanently
  orphans the file it pointed to in Supabase Storage — no cleanup path
  exists anywhere in the codebase.
- **No performance regression.** The discard route's baseline (warm p95
  3.3-4.5ms, ~0.7-0.9% of the publish-class budget) is cheaper than publish
  itself. The migration's write cost is below the measurement noise floor.
  One technically interesting, non-blocking finding: `setImageStatus`'s rare
  fallback path costs ~9ms — not from the try/catch (confirmed free) but
  because `pg-pool` destroys and reconnects on *any* query error, even a
  correctly-handled one — off the critical path, fires only in the
  concurrent-upload race, no action recommended.
- **The instrumentation proof succeeds**, confirming the full stuck →
  discard → republish flow end to end with exactly one correct
  `article_published` telemetry row.
- Recurring: workspace-hygiene contamination (untracked scratch from
  concurrently-running agents) hit this pass too, and for the first time
  actually corrupted a headline test count (228/41 instead of 227/40) before
  both agents caught it and re-verified against a pristine export. Sixth
  consecutive mention (I-V8-04 below) — genuinely needs fixing before a
  seventh.

---

## 1. `bob check verify` — precondition

Fresh `npm test` at the start of this pass confirmed **227/227**, `tsc
--noEmit` clean, matching `04-green-evidence.v8.md`'s claim exactly. Correct
gate to run.

**Process note**: all three verify agents were interrupted by a session
usage limit mid-run this pass; each was resumed from its own transcript with
no work lost, confirmed by checking the worktree was untouched at the moment
of interruption in each case.

---

## 2. The discard route — adversarially verified, holds up

Both agents treated this route with the "re-derive from scratch" discipline
the last two passes applied to the readiness gate, since it's the first
genuinely new writer-facing capability added in an area that's produced one
security bypass and two correctness bugs already.

**The compare-and-swap race** (security auditor, constructed by hand — the
ADR-0004 callback landing in the exact window between the handler's read and
the delete):

```
RACE-1  read sees "processing"; callback settles it "ready" in the window
  -> 409 CONFLICT, row survives, final state cover/ready          CORRECT
RACE-2  read sees "processing"; callback settles it "failed" in the window
  -> 200, row deleted                                             CORRECT
```

The e2e agent independently ran 11 race trials with a genuinely open
`processing` window in 5/5 attempts using real 6MP photos: no 5xx, never two
concurrent `200`s for one row, no row that settled `ready` was ever deleted.

**"No new grant"** (security auditor), confirmed directly against
`information_schema.column_privileges` and `has_column_privilege`, not
inferred from the migration's SQL text: `authenticated` holds exactly
`SELECT` + `UPDATE(alt_text)` on `article_images` — byte-identical to what
migration `0004` left. No `DELETE`, no `INSERT`, no `role`, no `status`. The
route is reachable only through the `service_role` seam.

**The proactively-added draft-lock check** (security auditor): confirmed to
work identically to publish and upload — same `evaluateLock` call, same
error envelope, same 89s/91s staleness boundary — and confirmed to run
*before* the image lookup and the delete, so a refusal can never be preceded
by a mutation.

**The abuse-prevention control** (e2e agent): attacked with 20 distinct
request shapes (dot-segments, percent-encoding, method-override, query
params, casing variants, 4 credential shapes) plus cross-article and
injection-shaped ids — every attempt left both the live cover and any
still-referenced body image intact, and the article still published
correctly afterward.

**Independent invariant re-derivation** (e2e agent, not just replaying the
committed scenarios): 40 randomized product-route sequences reaching 33
distinct settled image-state shapes. Zero unrecoverable, zero
non-terminating, zero 5xx, zero empty-cover publishes.

**Verdict: the route's core mechanism is sound.** What blocks the gate is
not a flaw in the route itself — see §4/§5.

---

## 3. M-V7-02 and L-V7-01 — closed, confirmed multiple independent ways

**M-V7-02 (render.ts cover-blanking)**: e2e agent's 300-sample trace across
a real conversion window showed exactly one distinct `og:image` value
throughout — the article's last-known-good cover, never blank, including
through permanent failure and after a discard. Edge cases confirmed
correct: a never-published draft renders nothing (no fallback to conjure);
`structured_data` NULL renders no cover; a legacy row with `image: ['']`
renders no `<img>` at all (the `nullif` is load-bearing, not decorative).
Security auditor independently confirmed the fallback introduces no new
trust dependency — `structured_data` remains unwritable by `authenticated`
(`42501`, confirmed directly), so the fallback can't be poisoned by a
writer.

**L-V7-01 (cover uniqueness)**: perf agent's `EXPLAIN ANALYZE` comparison
found the migration's index doesn't just avoid costing anything on the hot
path (write cost below the measurement noise floor on a ~0.5ms statement) —
it measurably *improves* `render.ts`'s existing query, becoming the
subquery's own access path and cutting total buffer reads by 25% at
N=1000 articles. E2e agent confirmed the writer-facing consequence directly:
concurrent uploads of genuinely convertible photos (2-way and 4-way) now
resolve to exactly one `ready` cover with no raw `500` and nothing stuck —
"the writer's end-to-end experience is that the article just publishes."
Both agents independently exercised `repo.setImageStatus`'s `23505`-catch
fallback (previously reached by no committed test) under real concurrent
load and confirmed it's load-bearing: without it, each concurrent burst
would leave 1-3 rows stuck.

---

## 4. What blocks (1 of 2): migration `0005` cannot apply to the state it was written to fix

Found by the security auditor. `db/migrations/0005_one_ready_cover_per_article.sql`'s
`create unique index if not exists` only skips when the index already
exists — it does nothing to reconcile pre-existing data that violates the
constraint it's about to create. `05-verification.v7.md`'s L-V7-01 proved,
through ordinary concurrent uploads with no attacker involved, that a
database can hold six simultaneous `role='cover', status='ready'` rows on
one article. Reproduced directly:

```
-- database migrated to 0004, seeded with two ready covers on one article
-- then 0005 applied:
ERROR:  could not create unique index "article_images_one_ready_cover_per_article"
DETAIL:  Key (article_id)=(...) is duplicated.
psql exit=3
-- indexes on article_images afterwards: article_images_pkey, article_images_article_idx
--   (the new index is simply absent)
```

**Why no test in the suite catches this**: `tests/support/pg.ts` starts a
fresh Testcontainers Postgres and applies every migration to an **empty**
database on every single run. This class of defect — a later migration that
can't apply given data an earlier state of the schema permitted — is
structurally invisible to a harness where every test database starts from
nothing.

**Consequence, stated precisely**: under a stop-on-error migration runner
(e.g. Supabase's `db push`), the deploy fails loudly and needs manual data
surgery before it can proceed — recoverable, but blocking, and requiring a
human to intervene in production data. Under a more tolerant runner, the
index could silently never get created, in which case three of this pass's
own claims become false in production while remaining true in CI: cover
uniqueness isn't actually enforced, `render.ts`'s cover subquery isn't
provably single-row, and `setImageStatus`'s `23505` fallback becomes dead
code that never runs. That second scenario is the one that matters most —
the gate would be certifying behavior that doesn't describe the system it's
actually shipping.

**Severity: Medium.** No security boundary crossed on its own, but this is a
migration that cannot safely reach every real deployment path, discovered
only because a verify pass tested it against realistic pre-existing state
rather than an empty database.

**Fix**: a self-healing step ahead of the index creation — demote every
`role='cover', status='ready'` row on an article except the most recently
created one to `role='body'` before building the index, matching what
`demoteCurrentCover()` would have done had the conflicting uploads not
overlapped. Pair it with a red-gate test that migrates a database seeded at
`0004` with the duplicate state, not just a fresh one — this class of
migration-ordering bug needs a non-empty-database test as its own test
category going forward, not just this one instance fixed.

---

## 5. What blocks (2 of 2): the recovery route is unreachable from the product's own client

Found by the e2e agent, corroborating and extending what
`04-green-evidence.v8.md` §7 already disclosed as a deliberate deviation
(the route was documented in `openapi.yaml` as prose only, specifically to
avoid needing to edit `CONTRACT-COVERAGE`'s assertion in a test file). The
e2e agent confirmed the gap is real and precisely as described — zero
consumer test cases, zero provider fuzz cases, `contractOperations()`
returns exactly the 4 pre-existing operations — but found the disclosed
deviation understated its own consequence: **`src/api/client.ts`, the
typed editor-SPA client this project builds specifically so the frontend
never hand-writes fetch calls, has no `discardArticleImage` method either.**

**Why this matters more than a missing test.** This entire eighth
remediation cycle exists because `05-verification.v7.md` §4 proved a writer
could reach a permanently unpublishable article with zero recovery options.
The server-side fix is real and well-built (§2 above). But the premise of
"a writer has a way out" implicitly means *the writer*, using *the product*
— and as shipped, nothing in the codebase gives the editor SPA a way to call
this route. The fix closes the server-side gap and leaves the product-level
gap exactly where it was, one layer up.

**Severity: Medium**, not High — the server-side capability is complete,
correct, and reachable by any client that constructs the right HTTP request
(confirmed extensively in §2), so this isn't a security or data-integrity
issue. It's a completeness gap in a fix whose entire stated purpose was
completeness.

**Fix**: the same small change on both sides that closes I-V8-03/§7's
disclosed gap — the next red gate authors a consumer contract test
(`CONTRACT-CONSUMER-discardArticleImage`), which forces the green gate to
declare the path item in `openapi.yaml` and add the corresponding
`client.ts` method, closing this and the contract-coverage gap in one pass.

---

## 6. Further findings, Low/Info

### L-V8-01 (Low, corroborated independently by both agents) — the discard route has no rate limit and writes no audit record
Security auditor: verified directly that `DiscardImageDeps` has neither an
`observability` nor a `rateLimiter` field, unlike every other mutating
route. `telemetry_events.event_type`'s `CHECK` constraint admits only
`draft_started`/`article_published`, so no record of a deletion *can* be
written even in principle. `02-architecture.v1.md` §7 names
`telemetry_events` as part of the Repudiation mitigation for publishing and
editing; deletion isn't covered by it at all. E2e agent independently
quantified the rate-limit gap: 40 discards succeeded in 50ms on one IP with
zero refused, while publish on the same IP refused 4 of 14 in the same
window. Severity Low rather than higher: every writer already has equal
trust by design (no role hierarchy to escalate within), only not-`ready`
rows are reachable at all, and published content is protected by both the
`ready` refusal and the render fallback. But it's the only destructive
route with neither protection, and the blast radius (a colleague's
in-flight upload, silently gone after the 90-second lock window expires) is
real. Fix: add an `observability` record call and a `discard:` rate-limit
key, following the exact shape every other mutating route already uses.

### L-V8-02 (Low, corroborated independently by both agents) — every discard permanently orphans its stored file
Security auditor confirmed via direct grep that no storage-deletion call
exists anywhere in `src/` — `deleteImage` removes only the database row.
E2e agent confirmed the practical extent: the original is always orphaned,
and when a discard wins a race against an in-flight conversion, the
optimized asset is orphaned too (`convert()`'s `storage.put()` runs before
`setImageStatus`). `02-architecture.v1.md` §4's cost argument rests on
staying inside Supabase Storage's free tier — routine use of the recovery
procedure this pass builds (per `NFR-RECOVERY-INVARIANT-01`, this *is* the
intended recovery path, not an edge case) will now leak storage
continuously with nothing to reclaim it. Fix: delete the object alongside
the row, or record the orphan for a sweeper to reclaim later — naturally
folds into L-V8-01's fix, since both want the same observability hook.

### I-V8-01 (Info) — `articleDependsOn()`'s doc comment states two things that are no longer true
Security auditor: the comment claims "no route removes a row" (now false —
this pass's route does) and that `role` is "the one column `authenticated`
may write directly" (false since migration `0004`; `alt_text` is now the
only one). Both sentences are load-bearing reasoning in the file that has
produced findings across four consecutive passes — worth correcting on
sight rather than compounding.

### I-V8-02 (Info) — the contract still promises an atomicity the implementation explicitly doesn't provide
Security auditor: `uploadArticleImage`'s description claims the demote
happens "in the same transaction as the new upload" — explicitly untrue per
`04-green-evidence.v8.md` §5's own reasoning for why the upload sequence
was deliberately left non-atomic. Pre-existing text this pass edited
adjacent lines of without correcting.

### I-V8-03 (Info) — corroborates §5: the discard route has no contract or fuzz coverage on either side
Both agents independently confirmed the same gap from different angles
(security auditor: the `23505`-fallback interaction is consequently
untested by the committed suite too; e2e agent: zero provider fuzz cases
generated). Same fix as §5.

### I-V8-04 (Info) — workspace hygiene, sixth mention, and this time it actually corrupted a result
Both agents hit the same recurring hazard (v4 §8, v5 §7, v6 §9, v7 §1) — a
concurrently-running perf agent's untracked `tests/perf/` in this shared
worktree. The e2e agent's third of five suite runs reported 228/41 instead
of 227/40 because of it, the first time in this project's history the
contamination actually altered a reported headline number rather than only
risking it. Both agents caught it and re-verified against a pristine `git
archive HEAD` export (227/227 in both cases, matching green v8 exactly).
Needs a `.gitignore` entry or an enforced scratch convention — recorded a
sixth time in the hope it doesn't need a seventh.

---

## 7. Performance — no regression

Full detail: perf agent's report, folded in here.

### 7.1 The discard route's baseline

| Path | warm p50 | warm p95 |
|---|---|---|
| `200` discard | 1.9-2.7ms | 3.3-4.5ms |
| `409` (row is ready) | 1.3-2.0ms | 1.7-4.4ms |
| `404` unknown image | 1.5-1.8ms | 1.8-3.3ms |
| `401` no bearer | 0.3-0.4ms | 0.4-0.7ms |

Against the publish-class budget (<500ms warm p95, by analogy — no budget
was previously defined for this new route): **0.7-0.9% of budget**, cheaper
than publish itself. Indistinguishable in shape from the existing
lock-refresh (`open`) route measured in the same session, which is the
right result given both do three reads plus one single-row write/CAS.

### 7.2 Migration `0005`'s cost — negligible on the hot path, a net improvement on render

Write cost on the hot transition (`status: processing → ready`, every
successful conversion): **below the measurement noise floor** on a ~0.5ms
statement (delta -0.026ms, i.e. the "with index" arm measured nominally
faster). Every `article_images` query plan except `render.ts`'s own cover
subquery is structurally unchanged, confirmed via `EXPLAIN (ANALYZE,
BUFFERS, VERBOSE)` under both roles. The one plan that *does* change
changes for the better — see §3 above, a 25% buffer-read reduction at
N=1000.

### 7.3 `setImageStatus`'s fallback path — a real number, correctly attributed

Common case (no violation): free, confirmed indistinguishable from a bare
`pool.query` of the identical SQL (delta -0.025ms). Fallback case (a
genuine `23505`): **+9.1ms per occurrence** — but not from the try/catch or
the fallback query itself (both confirmed near-free in isolation); the cost
is `pg-pool` destroying and reconnecting the database connection on *any*
query error, confirmed directly (20 consecutive violations through a
`max: 1` pool produced 20 distinct backend PIDs). This is pre-existing `pg`
behavior that migration `0005` makes newly reachable in normal (non-buggy)
operation, not something the try/catch introduced. Not on any writer-facing
budget (fires only inside a fire-and-forget conversion callback, only in
the rare concurrent-upload race) — recorded for accuracy, no action
recommended.

### 7.4 Existing budgets, re-confirmed

`render.ts`'s app-level budget holds at N=1000 (homepage warm p95
8.6-9.6ms, 4.3-4.8% of the <200ms budget), matching v7's measurement within
noise despite similar background machine load. `NFR-IMGCPU-01` did not
flake in either agent's runs.

---

## 8. Tooling — clean

- **semgrep**: 0 findings, 131 files genuinely scanned (the v6/v7 working
  invocation — `git archive HEAD` export with `tests/` renamed — reused
  correctly rather than repeating the silent no-op).
- **gitleaks**: all hits confirmed false-positive test fixtures or
  doc-comment text.
- **`npm audit --omit=dev`**: 0 vulnerabilities.
- **Full suite**: 227/227, confirmed by both agents across 9 combined runs
  including two pristine `git archive HEAD` exports specifically to rule out
  the workspace contamination that hit this pass directly (see I-V8-04).
- **Contracts at depth**: 886 combined higher-depth cases (455 + 431) on the
  two operations this pass touched most, zero failures. An ad-hoc 1,344-case
  fuzz of the undeclared discard route (13 article ids × 12 image ids × 8
  methods × 7 credential shapes) found zero ≥500 responses, the live cover
  never removed, and no bad-credential shape ever deleting anything —
  reassuring given the route has no committed test coverage at all, but not
  a substitute for real contract declaration (§5).

---

## 9. Disposition of v7's findings

| Finding | Verdict |
|---|---|
| §4 (permanently unpublishable, two routes) | **Server-side mechanism CLOSED and thoroughly verified** (§2); **blocked from fully delivering** by §4/§5 above (migration data-compat + client unreachability) |
| M-V7-02 (public cover blanks) | **CLOSED**, confirmed independently by both agents |
| L-V7-01 (no DB uniqueness on cover slot) | **CLOSED on a fresh database; NOT deployable to an existing one** — this pass's own §4 |
| L-V6-02 (two unordered cover picks) | Practically closed by the new index — conditional on §4's migration fix landing |
| L-V7-02 (`updated_at` forgeable) | Still open, correctly out of scope, re-confirmed unchanged |
| I-V7-01 (`ready ⇒ optimized_url` CHECK) | Still open, correctly out of scope |

---

## 10. Instrumentation proof, eighth pass

Run by hand by Bob, real Postgres 16, real spawned server. This pass built
the entire recovery mechanism, so the primary path exercised was the full
stuck-article recovery flow end to end:

```
create: 201
stuck upload: 201
cover ready: true | stuck body failed: true
publish while stuck: 409
discard: 200 {"discarded":true}
publish after discard: 200, cover: https://cdn.fantasycoach.example/articles/...

telemetry rows: draft_started, article_published (exactly one of each)
exactly one article_published row despite the earlier 409: true
```

The full stuck → discard → republish flow works correctly end to end, with
telemetry that's accurate throughout — the earlier `409` correctly emitted
no `article_published` row, and the eventual successful publish emitted
exactly one. Metric remains computable, counter-metric unchanged, still the
documented honest gap from v1-v7.

---

## 11. Gate verdict

**NOT PASSED.**

This is a genuinely unusual verify pass in this project's history: the new
capability at its center — the discard route — is the most thoroughly
adversarially-verified piece of code this six-week remediation saga has
produced, and it holds up completely. Neither verify agent found a way to
break its safety argument, its concurrency handling, or its grant boundary.
That is real progress, and it's worth stating plainly rather than letting
the two blockers below overshadow it.

What blocks is not a flaw in what was built, but two different gaps in
whether it actually reaches the people and data it needs to reach:
migration `0005` can't apply to a database that's already in the state it
exists to fix (§4), and the route it protects can't currently be called by
the product's own client (§5). Both were found independently by different
agents using different methods, which is itself a useful signal that
they're real rather than an artifact of one agent's framing.

**Recommended next cycle, in order:**
1. **§4** — the pre-flight demote ahead of migration `0005`'s index
   creation, plus a red-gate test that migrates a database seeded at `0004`
   with the duplicate-cover state rather than only testing against empty
   databases. This is the higher-priority blocker: it's a deploy-time risk
   to real data, not just a product gap.
2. **§5** — `CONTRACT-CONSUMER-discardArticleImage` at red, the path-item
   declaration and `client.ts` method at green. Closes this and I-V8-03
   together.
3. **L-V8-01 + L-V8-02** — one `observability` call, one rate-limit key, one
   orphan-tracking mechanism; naturally bundled since they share the same
   hook point in `discardImage.ts`.
4. **I-V8-01 / I-V8-02** — two stale comments and one stale contract
   sentence in files that have each produced multiple findings; cheap to
   fix whenever next touched.
5. **I-V8-04** — the `.gitignore` entry, before a seventh mention becomes
   necessary.

Standing backlog, unchanged: L-V7-02 (`updated_at` forgeable), I-V7-01 (the
`CHECK` constraint hardening), L-V6-01 (`CDN_ORIGIN` validation), L-V6-03
(transient slug race), N5/N5b, N2, the idempotency store's TTL/`writer_id`
scoping.

`state.json` left untouched, per the established pattern.
