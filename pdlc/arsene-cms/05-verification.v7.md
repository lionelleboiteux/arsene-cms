# arsene-cms — Verify gate, seventh pass (v7)

**Status: NOT PASSED — both targeted findings are closed with the strongest
evidence this gate process has produced (two independent adversarial
state-space sweeps, ~250,000 combined states, zero divergence), but the
fix for M-V6-02 had a side effect neither prior document weighted heavily
enough: it removed the only recovery path from a permanently unpublishable
article, and two independent agents found two different, concrete ways to
reach that terminal state — one requiring only an ordinary conversion
failure, one a genuine, deterministic race condition requiring nothing but
ordinary concurrent use.**
**Run:** 2026-08-19, branch `feat/arsene-cms`, against commit `c0172f4`
(green remediation v7: 221/221, closing H-V6-01/M-V6-01 and M-V6-02 from
`05-verification.v6.md`).
**Method:** `bob-security-auditor`, `bob-perf-analyst` and an integration/e2e
runner, run fresh and independently in parallel, each briefed to re-derive
the cover-check unification from scratch — brute-force the image-state space
rather than replay the four committed combinations — and to specifically
hunt for any remaining way to get a `200` publish with no usable cover,
since that invariant is what this entire fix family has been converging on
for three consecutive passes. Plus an instrumentation proof run by hand
(Bob).

---

## 0. Executive summary

- **H-V6-01/M-V6-01 is closed, and closed about as thoroughly as this gate
  has ever demonstrated.** The security auditor wrote an independent model
  of correct behavior from the acceptance criteria (not from reading the
  fix) and swept it against the real code over 161,736 image-state
  combinations (exhaustive at 1-2 rows, 150,000 random at 3 rows): **zero
  divergence**. The e2e agent, working independently, swept 91,737
  combinations (exhaustive at ≤2 rows, 80,000 random at 3-4 rows) plus 7
  hand-built real-infrastructure combinations: **zero violations**. Both
  agents, independently, converged on the same single remaining
  theoretical gap and both concluded it is unreachable — see §2 below.
- **M-V6-02 is closed at the write step, precisely.** Both agents
  reconstructed `05-verification.v6.md` §3's exact exploit sequence against
  a real migrated Postgres database: it now fails at **step one** (a direct
  `role` write refused `42501`), not at a later stage. The security auditor
  additionally probed nine sibling attack shapes (delete, insert, direct
  writes to every other `article_images` column, forging telemetry) — all
  refused; the one legitimate remaining direct-grant write (`alt_text`,
  AC-15) still works.
- **What blocks the gate: removing the `role` grant to close M-V6-02 also
  removed the only recovery mechanism from a permanently unpublishable
  article — and this isn't hypothetical.** Two independent agents found two
  different, concrete routes to the same terminal state:
  1. **Security auditor**: an ordinary, no-attacker scenario. A body image
     is adopted (uploaded, stored) but its Lambda conversion later fails —
     a CMYK JPEG, corrupt data, a timeout, anything. That row now blocks
     publish forever (`articleDependsOn()` correctly keeps treating it as
     in-use), and **every one of the eight recovery actions a writer could
     attempt now fails** — confirmed live, one by one. Before this pass,
     the recovery procedure was exactly the sequence M-V6-02 closed as an
     exploit; closing the exploit closed the only recovery with it.
  2. **E2e agent**: a genuine, deterministic race condition, reproducible
     without any external failure at all. `uploadImage.ts`'s demote-then-
     store-then-insert sequence is not atomic; two concurrent cover uploads
     to the same article reliably (8/8 trials) leave **two** `role='cover'`
     rows, both eventually `ready`. If either later fails conversion in a
     third upload's demote pass, the article reaches the identical
     permanently-blocked state — proven directly: five consecutive good
     cover uploads, each reaching `ready`, and every publish still `409`.
  Both routes terminate in the same place: an article that will never
  publish again, recoverable only by a human running SQL directly against
  production. Recorded as one consolidated finding (§4) since the terminal
  state and the fix are the same, with both discovery paths preserved.
- **A second, independent Medium**, found only by the security auditor: a
  live article's public cover image goes blank — transiently during any
  ordinary cover replacement, permanently if the replacement's conversion
  fails — because `render.ts` was deliberately not touched by this pass and
  still exhibits H-V6-01's exact public-facing symptom (`empty og:image`,
  `image: [""]`, no `<img>` on the homepage card) through a code path
  `usableCover()` doesn't govern.
- **A factual correction to green v7's own evidence, confirmed
  independently by both agents**: §6.3's claim that "with `0004` in place a
  writer can no longer put it back, so at most one row can satisfy either
  predicate" is wrong. The e2e agent produced **six simultaneous `ready`
  cover rows** on one article via concurrent uploads; L-V6-02 (two
  independent, unordered "pick the cover" queries that can disagree) is
  narrowed, not closed, and is the same underlying non-atomicity as the
  finding above.
- **No performance regression.** The perf agent specifically investigated
  whether losing v6's "zero `articleDependsOn` invocations on a healthy
  publish" property was a problem — it measured the real cost (6-34
  nanoseconds per publish at realistic image counts) and correctly
  concluded the property's loss is structurally required by the fix, not
  an oversight, and its cost is four to five orders of magnitude below
  HTTP-measurable resolution. The migration itself was confirmed, via
  before/after `EXPLAIN ANALYZE` on identically-seeded databases under both
  roles, to have zero query-plan effect.
- **The instrumentation proof succeeds**, confirming the legitimate primary
  path still produces correct telemetry with a real cover image, and
  independently reconfirming both the grant revocation (`42501`) and the
  cover-check fix (rejected-only-cover correctly refused, zero telemetry
  rows).
- Several further Low/Info findings recorded below (§6), including one
  genuinely good piece of news: no exploit path exists today for the one
  theoretical gap both state-space sweeps converged on (§2).

---

## 1. `bob check verify` — precondition

Fresh `npm test` at the start of this pass confirmed **221/221**, `tsc
--noEmit` clean, matching `04-green-evidence.v7.md`'s claim exactly. Correct
gate to run.

**Recurring process note, fourth consecutive pass**: both the security
auditor and the e2e agent independently hit the same workspace-hygiene
hazard flagged at v4 §8, v5 §7, and v6 §9 — untracked scratch files from
concurrently-running agents (`tests/perf/`, `verify-scratch/`) present in
this shared worktree, which broke `npx tsc --noEmit` directly this time
(exit 2, up to 29 errors) rather than just risking it. Both agents verified
the committed tree itself is clean by testing against a pristine `git
archive HEAD` export (`tsc` exit 0, suite 221/221 in both cases) before
reporting. This needs a `.gitignore` entry or an enforced out-of-repo
scratch convention — recorded a fifth time (I-V7-03) in the hope it's the
last.

---

## 2. H-V6-01/M-V6-01 — CLOSED, with the strongest evidence this gate has produced

Both agents worked independently and used different methods to arrive at
the same conclusion.

**Security auditor's method**: wrote an independent correctness model from
the acceptance criteria, before reading `usableCover()`'s implementation,
then swept:

```
1-row states, exhaustive:    72        — 0 divergence
2-row states, exhaustive:    11,664    — 0 divergence
3-row states, random:        150,000   — 0 divergence
                              -------
                              161,736 total, 0 divergence, 0 wrongly-refused
```

**E2e agent's method**: real infrastructure sweep plus targeted hand-built
combinations:

```
Exhaustive at n≤2:            11,737
Randomised at n=3/4:           80,000   (7,800 of which published)
                               -------
                               91,737 total, 0 violations
7 hand-built real-infra combinations (multiple rejected covers, rejected +
  superseded-then-async-failed, alt_text tampering): invariant held
```

**Both agents, independently, converged on the same single remaining
theoretical gap and both concluded it is currently unreachable**: the
invariant `200 ⇒ non-empty cover_image_url` ultimately depends on one
unproven link — that `status === 'ready'` implies `optimized_url` is a
non-empty string. Nothing in the `article_images` schema enforces this (no
`CHECK` constraint), and `repo.setImageStatus`'s own type signature
(`optimized_url: string | null`) permits the violating write. The security
auditor traced every path that could set `status: 'ready'` and confirmed
each is gated by a Zod refinement in `router.ts` requiring a non-empty,
CDN-origin URL, and confirmed `authenticated` is refused `42501` on both
`status` and `optimized_url` directly. The e2e agent independently attacked
the same state five ways (empty/null/absent/foreign-origin/suffix-confused
callback bodies, all `400`) plus direct-grant writes (all `42501`) and
reached the same conclusion. **No exploit path exists today** — recorded as
I-V7-01, an info-level hardening note (a one-line `CHECK` constraint would
make the guarantee structural rather than dependent on two files agreeing),
explicitly not something to action under pressure since neither agent could
construct a way to reach it.

Both agents also confirmed the "other direction" — a legitimately `ready`
cover being wrongly refused — does not happen anywhere in the swept space,
including the specific regression-guard case (a `ready` cover beside a
rejected one, M-V4-01's original shape) and order-independence (confirmed:
`getArticleImages` has no `ORDER BY`, and the invariant holds regardless of
row order).

**Telemetry, confirmed by Bob's instrumentation proof and the e2e agent
both**: a publish refused because the only cover is rejected writes zero
`article_published` rows — closing the specific "telemetry records it as a
success" half of v6's severity argument for this finding.

---

## 3. M-V6-02 — CLOSED, at the write step, precisely

Both agents reconstructed `05-verification.v6.md` §3's exact sequence
against a real, fully-migrated Postgres 16 database, executing as the
`authenticated` role itself against real RLS:

```
step 1: update article_images set role='body' where id = A  (vacate the real cover)
  -> 42501 permission denied for table article_images

[sequence never reaches step 2 or the demote — B, the target, stays role='body']
```

The security auditor additionally probed nine further attack shapes against
the same fixture — self-assignment, smuggling `role` alongside the
permitted `alt_text` in one statement, direct delete, direct insert, direct
`replaced_cover_image_id`/`status`/`optimized_url`/`original_url` writes,
and forging `articles`/`telemetry_events` rows — **all refused `42501`**.
The one legitimate remaining capability, `alt_text` (AC-15), still writes
and lands correctly — confirmed by both agents.

`information_schema.column_privileges`, checked directly rather than
inferred from the migration's SQL text: `authenticated` retains exactly
`alt_text` on `article_images` post-migration; `role`, `status`,
`optimized_url`, `original_url`, `replaced_cover_image_id` are all gone.

The e2e agent confirmed the legitimate path is not over-broadly closed: the
normal upload→demote→publish flow completes correctly twice end to end with
fresh CDN URLs. Both agents note an unclaimed bonus: a writer can no longer
blank a *live*, already-published article's cover via direct grant tampering
either (six tamper vectors tried, all `42501`).

---

## 4. What blocks the gate: closing M-V6-02 removed the only recovery from a permanently unpublishable article

This is presented as one finding because both agents' discoveries terminate
in the identical state and share the identical fix, even though they found
it via genuinely different mechanisms — both are preserved below because
the fact that there are *two* independent routes to the same terminal state
(one needing an external failure, one needing nothing but ordinary
concurrent use) is itself informative about how exposed this gap is.

### 4.1 Security auditor's route — an ordinary conversion failure, zero recovery options

A body image is adopted (uploaded, stored, `original_url` set) but its
Lambda conversion later fails — a CMYK JPEG, corrupt data, a timeout, an
OOM, anything. `articleDependsOn()` correctly keeps treating that row as
in-use (it was adopted and never superseded), so it blocks publish forever.
**Every recovery action a writer could take was tried live, against a real
migrated database, and every one now fails:**

```
[state] adopted body image, conversion failed
  publish                                              -> 409 IMAGE_NOT_READY

  1. remove the reference from body_html                -> succeeds, but changes nothing:
     publish                                              articleDependsOn() never reads
                                                            body_html (correctly, per green
                                                            v7 §2.3's own reasoning) -> still 409
  2. upload a good replacement body image                -> new row created; old row untouched
     publish                                                                          -> still 409
  3. delete the broken row directly                       -> REFUSED 42501
  4. re-tag it role='cover' (the pre-0004 recovery path)   -> REFUSED 42501
  5. clear original_url directly                          -> REFUSED 42501
  6. mark it ready directly                                -> REFUSED 42501
  7. re-drive the Lambda callback                          -> false (row already settled, CAS refuses)
  8. upload a fresh good cover                             -> demote finds the COVER row, not the
                                                               stuck body row -> still 409
```

Before `0004`, recovery step 4 above **was** the "exploit" M-V6-02
described — vacate the real cover, re-tag the broken row as `cover`, upload
a replacement so the demote supersedes it. `0004` closed the abuse and the
only recovery procedure with the same line, because they were the same
mechanism viewed from two directions. Neither the red-gate evidence
(`03-red-evidence.v7.md` §5.1: "nothing will notice if it is forgotten") nor
the green-gate evidence (`04-green-evidence.v7.md` §6.1, which named this
exact risk and called it "a real product regression... should be
scheduled") weighted it as blocking — this verify pass's job is to make
that call, and does.

### 4.2 E2e agent's route — a genuine race condition, no external failure required

`uploadImage.ts`'s upload sequence — `demoteCurrentCover()` → `storage.put()`
(network I/O) → `insertImage()` — is not wrapped in one transaction. Two
concurrent cover uploads to the same article each independently demote
(matching nothing on the second call, since the first has already vacated
the slot) and each insert a new `role='cover'` row:

```
8/8 trials, two concurrent cover uploads: TWO role='cover' rows result, both eventually ready
4 concurrent cover uploads on a separate trial: FOUR role='cover' rows result
```

If a later upload's demote pass runs while one of those extra `ready`
covers is present, and that extra cover's row is the one that later fails
conversion in some other timing, the orphaned row is adopted, `failed`, and
matches nothing's `replaced_cover_image_id` — permanently blocking, by the
identical mechanism as §4.1. Proven directly and deterministically by the
e2e agent: **five consecutive good cover uploads, each individually reaching
`ready`, and the publish still refuses `409` afterward.** No conversion
failure, no attacker, no direct database access — ordinary concurrent
upload traffic (two browser tabs, a flaky retry, a double-click) is
sufficient.

### 4.3 Severity and recommended fix

**Severity: Medium**, matching both agents' individual assessments. Neither
route crosses a security boundary (no data leak, no privilege escalation,
no credential exposure) and both fail *closed* (the article stays a
correctly-labeled draft/unpublishable, never goes live in a broken state).
But the state is permanent, requires a human with `service_role` access to
fix, is reachable without any attacker in both discovered routes, and one
of the two routes needs nothing more than ordinary concurrent use to
trigger deterministically.

**Recommended fix, converged on by the security auditor and endorsed here**:
a narrow, server-side, writer-facing capability — either (a) a dedicated
cover-selection/re-tag route (restores full recovery, the fix `0004` was
always expected to ship alongside per every document in this chain since
green v7), or (b) the cheaper option: `DELETE
/v1/articles/{id}/images/{imageId}`, restricted server-side to rows that
are `status <> 'ready'` — cannot be abused, since a not-ready row is by
definition not something the article can currently be published with. (b)
also directly closes §4.2's race, since a writer who ends up with duplicate
cover rows or an orphaned failed row would have a way to clean it up
without needing the `role` grant back.

---

## 5. M-V7-02 (Medium, security auditor only) — a live article's public cover goes blank on cover replacement

`render.ts` was deliberately not touched this pass (`04-green-evidence.v7.md`
§6.3). Its cover-resolution query (`where role='cover' and status='ready'
limit 1`) and `uploadImage.ts`'s synchronous demote-before-conversion
sequence combine to produce exactly H-V6-01's public symptom, through a
different code path than the one this pass fixed:

```
T0  live article, healthy ready cover: og:image and homepage <img> both correct
T1  a VALID replacement cover is uploaded (demote already happened, conversion in flight)
    -> og:image content="", homepage <img> ABSENT, json_ld image: [""]
    -> the persisted structured_data.image is still correct and now disagrees with the live page
T2  the replacement's conversion FAILS (terminal)
    -> the blank state is now PERMANENT; publish itself correctly refuses 409 IMAGE_NOT_READY
       going forward, but the page was already blanked before the writer got that signal
```

**Why Medium, not High**: publish itself fails closed correctly on the next
attempt (the writer does eventually get a `409` telling them something is
wrong), and no security boundary is crossed — this is the "fails open
silently, no signal" shape v6's severity debate was about, but only for the
transient/permanent-blank-page window, not for the publish decision itself.

**Fix, cheap and recommended**: have `render.ts` fall back to the article's
persisted `structured_data.image` when the live "ready cover" query returns
nothing — keeps the last-known-good cover on the page at zero cost, and
naturally folds into the "one source of truth for the cover" work §6 below
already recommends for a different reason.

---

## 6. Further findings, Low/Info

### L-V7-01 (Low) — AC-06 (one cover per article) is unenforced at the data layer, confirmed with the strongest possible reproduction
Green v7 §6.3's claim that only one row can satisfy the cover predicate is
false. The e2e agent produced **six simultaneous `ready` cover rows** on one
article via concurrent uploads (a stronger reproduction than the security
auditor's independent 2-row finding of the same underlying non-atomicity).
`demoteCurrentCover()`/`insertImage()` racing is the shared root cause with
§4.2 above. `publishArticle.ts`'s `usableCover()` and `render.ts`'s cover
query are two independent, unordered picks over a state that can now
genuinely have multiple candidates — they happened to agree in every trial
run this pass (matching v6's own heap-order observation), but nothing
guarantees it. **Fix**: a partial unique index,
`create unique index on article_images (article_id) where role = 'cover'`,
or wrap the demote+insert in one transaction — the index is the durable
answer and pairs naturally with persisting a single `cover_image_id` (the
fix both this and v6's L-V6-02 ultimately want).

### L-V7-02 (Low) — `articles.updated_at`, the stated audit column, is writer-forgeable
Security auditor: `02-architecture.v1.md` §7 names `updated_at` alongside
`writer_id` as part of the audit-trail mitigation for Repudiation. It's in
`authenticated`'s grant, with no trigger enforcing it's set by the server.
Confirmed live: a direct write to an arbitrary timestamp succeeds. Same
shape as `role` was, one table over — a column a stated control depends on,
left on the writer's side of the grant line. Low severity: the threat model
itself rates Repudiation Low, there's no privilege hierarchy to escalate
within (every writer already has equal rights by design), and
`telemetry_events` — which remains genuinely unwritable by `authenticated`
— is the trustworthy independent trail. Fix: same one-line pattern as
`0003`/`0004`, plus a `before update` trigger.

### I-V7-01 (Info, corroborated independently by both agents) — no database-level guarantee that `status='ready' ⇒ optimized_url` is non-empty
See §2 above — this is the one theoretical gap both state-space sweeps
converged on, and both agents confirmed no exploit path exists today. A
one-line expand-only `CHECK` constraint would make the guarantee structural
rather than resting on two files (a Zod schema in `router.ts`, a type
signature in `repo.ts`) staying in agreement — worth doing next time
someone's already in the migrations, not urgent enough to action alone.

### I-V7-02 (Info) — `alt_text` correctly has no decision-shaped risk
Security auditor traced every read of `alt_text` and confirmed it currently
feeds no decision anywhere (not the readiness gate, not `render.ts`, which
uses the article title for the `alt` attribute instead) — the migration's
narrowness (leaving `alt_text` writable, revoking only `role`) was the
right call, not an oversight. Side note, not a finding: this also means
AC-15's "a writer can overwrite generated alt text" is currently
unobservable to any real visitor — worth a line for whoever next touches
accessibility, unrelated to this verify pass's scope.

### I-V7-03 — workspace hygiene, fifth mention
See §1. Needs a `.gitignore` entry or an enforced scratch convention, not a
sixth note in a future verify document.

---

## 7. Performance — no regression, and the specific concern this pass raised was investigated properly

Full detail: perf agent's report, folded in here.

### 7.1 `usableCover()`'s cost, and the short-circuit question

v6 measured `articleDependsOn()` invoked **zero times** on any healthy
publish (short-circuited behind `image.status !== 'ready'`). This pass's
fix calls `usableCover()` — which calls `articleDependsOn()`
unconditionally for every cover-role row — from two call sites. The perf
agent confirmed directly (accessor-property call counting on a fake repo,
no production code touched) that **this short-circuit property is lost**:
exactly 2 invocations per healthy publish now, each a full O(k) scan.

**Correctly identified as structurally required by the fix, not an
oversight**: H-V6-01 was precisely that the success path never asked "is
this cover usable" — any fix that closes it must evaluate that predicate on
the success path. The perf agent's job was then to measure what that costs,
not to flag the change itself as a regression:

| k (image rows) | v6 cover-check cost | v7 cover-check cost | delta |
|---|---|---|---|
| 1 | 10.1 ns | 16.2 ns | +6 ns |
| 3 | 9.6 ns | 19.7 ns | +10 ns |
| 10 | 9.6 ns | 43.7 ns | +34 ns |
| 1000 (unreachable in product) | 14.4 ns | 3.6 µs | +3.6 µs |

At realistic image counts: **6-34 nanoseconds per publish, ~0.000007% of
the 500ms warm publish budget** — four to five orders of magnitude below
what an HTTP-level measurement could resolve, confirmed by k=10 vs k=1
publishes being indistinguishable in real HTTP runs (p50 4.4-5.8ms either
way). The unreachable worst case (every row an adopted, superseded cover,
which the product cannot produce) still costs only 0.87% of budget at
k=1000.

### 7.2 Migration `0004` — confirmed, not assumed, to have zero query-plan effect

Two identically-seeded fresh containers (one at `0003`, one at `0004`),
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` on every `article_images` statement in
`src/`, under both `service_role` and `authenticated`. **Every plan is
byte-identical** except `demoteCurrentCover` under `authenticated`, which
now correctly errors `42501` (a role that never runs this statement in
production). `getArticleImages`'s plan and median wall time (0.356ms vs
0.358ms) are unchanged. Privilege state confirmed directly via
`has_column_privilege`, not inferred from the migration's SQL text.

### 7.3 Existing budgets, re-confirmed

All budgets pass with equal or better margins than v6, despite this
session running under significantly heavier concurrent machine load (1-minute
load averages 48-165 on 8 cores, attributed to other agents' concurrent
work in the same shared worktree) — publish warm p95 8.2-11.4ms (≤2.3% of
budget), image conversion near cap 1.29-1.31s (8.7%), public render N=1000
home p95 7.69ms (≤3.8%). One standing measurement gap closed this pass: the
lock-heartbeat-over-real-HTTP path (`POST .../open`), previously only
measurable via a raw-query proxy since no reachable endpoint existed, is
now measured end to end (warm p50 3.14/p95 6.06ms, 12% of budget) — not a
regression, a gap in measurement coverage closing.

`NFR-IMGCPU-01` did not flake in any run.

---

## 8. Tooling — clean, with the semgrep working invocation now documented for reuse

- **semgrep**: 0 findings on a `git archive HEAD` export with `tests/`
  renamed to `suite/` (the working invocation identified at v6, confirmed
  and reused here rather than repeating the silent no-op — 250 rules, 122
  files genuinely scanned).
- **gitleaks**: all hits (working tree + 25-commit history) confirmed
  false-positive test fixtures or doc-comment text.
- **`npm audit --omit=dev`**: 0 vulnerabilities.
- **Full suite**: 221/221, confirmed by both agents across 7 combined runs
  including two against pristine `git archive HEAD` exports specifically to
  rule out worktree contamination (see §1).
- **Contracts at depth**: 4,086 combined cases (2,055 + 2,031) on the two
  operations this pass touched, zero failures. The grant revocation
  surfaces nowhere client-visible the committed suite misses — the contract
  never exposed a `role`-mutation operation to begin with, only prose. One
  false-positive Schemathesis flag (an `ignored_auth` check tripped by the
  fuzzing harness's own auth-injection mechanism, not a real bypass —
  verified by hand: no-header/empty/malformed/wrong-token all correctly
  401).

---

## 9. Disposition of v6's findings

| Finding | Verdict | Strongest evidence |
|---|---|---|
| H-V6-01/M-V6-01 | **CLOSED** | 161,736 + 91,737 combined swept states, 0 divergence from two independent models |
| M-V6-02 | **CLOSED** | Both agents: exploit sequence fails at write step 1, `42501`, against real migrated Postgres |
| L-V6-01 (`CDN_ORIGIN` unvalidated) | Still open, correctly out of scope this pass | — |
| L-V6-02 (two unordered cover picks can disagree) | **Narrower claim than green v7 stated, not closed** | See L-V7-01 above — six simultaneous ready covers reproduced |
| L-V6-03 (transient slug race) | Still open, unchanged | — |
| I-V6-01 (sanitizer allows no img/figure — record correction) | Reconfirmed; noted to cut both ways — narrows M-V4-01-family stakes but doesn't affect §4's permanent-block findings, which are about publish-ability, not renderability | — |

---

## 10. Gate verdict

**NOT PASSED.**

This is the strongest pass of evidence this gate process has produced for
the findings it *does* close: two independently-derived correctness models,
swept against real code over a quarter of a million combined states, with
zero divergence, is a materially stronger claim than any prior verify
document in this six-week saga has been able to make. H-V6-01/M-V6-01 and
M-V6-02 are both genuinely, thoroughly closed.

What blocks is a consequence of *how* M-V6-02 was closed, not a flaw in the
closure itself: revoking the `role` grant correctly removed the deterministic
bypass, but it also removed the only mechanism a writer had to recover from
a broken image — and both verify agents, working independently, found real,
concrete routes to that terminal state. One needs nothing but an ordinary
codec failure; the other needs nothing but ordinary concurrent use and is
fully deterministic. Every document in this chain since green v7 flagged
this risk in the abstract (red v7 §5.1, green v7 §6.1) — this pass is where
the abstract risk became two reproduced bugs, which is exactly what a
verify gate is for.

The mitigating context: neither blocking finding crosses a security
boundary, both fail closed (an article that won't publish, never one that
publishes wrong), and the fix for both is small, well-understood, and
already named across three documents.

**Recommended next cycle, in order:**
1. **§4** (the consolidated recovery-path finding): a narrow, server-side
   writer-facing capability — a scoped delete route for not-ready image
   rows is the cheapest option that closes both discovered routes at once.
   Pair the red gate with an invariant test in the pattern that finally
   worked for H-V6-01 — "any article state reachable through product routes
   alone must have some sequence of product routes that returns it to
   publishable" — rather than enumerating specific recovery scenarios,
   since specific-scenario enumeration is exactly what's been incomplete
   three times running in this fix family.
2. **M-V7-02** (`render.ts` cover-blanking): cheap, falls back to persisted
   `structured_data.image`.
3. **L-V7-01** (partial unique index on the cover slot) — same root cause
   as §4.2, likely worth taking together.
4. **L-V7-02** (`updated_at` grant + trigger) and the still-open **L-V6-01**
   (`CDN_ORIGIN` validation) — both cheap, natural to land in the same pass.
5. **I-V7-01** (the `CHECK` constraint) whenever next in the migrations.
6. **I-V7-03** — the `.gitignore` entry, before it's mentioned a sixth time.

`state.json` left untouched, per the established pattern.
