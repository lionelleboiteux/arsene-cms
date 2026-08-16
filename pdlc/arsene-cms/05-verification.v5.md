# arsene-cms — Verify gate, fifth pass (v5)

**Status: NOT PASSED — no High finding, no performance blocker, but M-V4-01's
fix turns out to have closed only one of (at least) three reachable states
that produce the identical permanent-block bug, plus a regression this pass's
own fix introduced and one unrelated deterministic bug found by fuzzing.**
**Run:** 2026-08-14, branch `feat/arsene-cms`, against commit `b159caa`
(green remediation v5: 206/206, closing M-V4-01 and M-V4-02 from
`05-verification.v4.md`).
**Method:** `bob-security-auditor`, `bob-perf-analyst` and an integration/e2e
runner, run fresh and independently in parallel, each briefed to adversarially
re-verify both fixes and specifically hunt for "the next version" of M-V4-01
(what happens with two consecutive bad uploads, a bad-then-good-then-bad
sequence, the equivalent bug on the `body` role, etc.) rather than just
re-running the committed tests. Plus an instrumentation proof run by hand
(Bob).

---

## 0. Executive summary

- **M-V4-02 (upload ignoring the draft lock) is fully, cleanly CLOSED.** Both
  agents independently proved it against real infrastructure, including the
  strongest confirmation yet that a shared mechanism is genuinely shared: the
  90-second staleness boundary agrees between `open` (decided in SQL) and
  `upload`/`publish` (decided in the API process) to the second, on both
  sides of the boundary.
- **M-V4-01 (truncated cover upload blanking a live article) is only
  PARTIALLY closed.** The exact reproduction from `05-verification.v4.md` §6
  no longer works — confirmed by both agents, including 13+ multi-step upload
  sequences by the e2e agent that all end in a publishable article with
  exactly one correct cover. But the fix (`isRejectedAttempt()`, gated on
  `image.role === 'cover'`) only covers the cover slot. **Both agents
  independently found the identical bug still reachable via the `body`
  slot**: a rejected body-image upload permanently blocks republication of a
  live article, with the exact same "no delete grant, no recovery" shape —
  and the stated rationale for treating body images differently
  ("a body image is referenced from the article's own HTML") is
  contradicted by the code itself: a rejected upload never gets a URL, so it
  was never actually embeddable.
- **The security auditor additionally found a third reachable state**: a
  `processing` cover, demoted into the body slot by a second upload (the
  legitimate, intended behavior) and only *then* failing asynchronously,
  produces the same permanent block — the guard added in green v5
  (`status <> 'failed'`) is evaluated at demote time, but status is decided
  later by the async Lambda callback.
- **This pass's own fix introduced a new regression**: keying the exclusion
  on `image.role` ties a publish-gate security/correctness decision to the
  one `article_images` column writers can write directly via PostgREST — the
  security auditor proved live that flipping a broken, actually-in-use body
  image's `role` to `cover` makes the `IMAGE_NOT_READY` gate wave it through.
- **The e2e agent independently found an unrelated, deterministic bug via
  contract fuzzing**: two articles with the same title collide on the unique
  `slug` constraint, and `publishArticle.ts` never passes existing slugs to
  the dedup logic — so the collision path is dead code, and the resulting
  database error is unmapped, surfacing as a permanent `500`. No attacker
  required; two ordinarily-titled articles are enough. `createDraft`'s
  default title (`Sans titre`) makes this easy to hit by accident.
- **The security auditor's same-shape hunt found a second, more severe
  version of a finding v4 already carried at Low**: the idempotency store is
  shared between `publish` and `upload` with no operation in its key, so a
  client reusing one `Idempotency-Key` across the two calls can make a
  publish silently no-op (the caller sees a 2xx, the article stays a draft)
  or an upload silently vanish behind a stale publish response.
- **No performance regression.** Both new checks (`evaluateLock` in upload,
  `isRejectedAttempt` in publish) are pure in-memory operations measuring
  below noise on the healthy-article path — `isRejectedAttempt` in
  particular is never even invoked when every image is `ready`, which is
  every normal publish. The one genuinely new round trip (a display-name
  lookup on upload's new `409` refusal) costs the same as publish's
  equivalent refusal, comfortably inside budget. The accumulation trade-off
  accepted in green v5 was quantified precisely: negligible below ~100
  orphaned rows on one article, ~1.4% of the publish budget even at 2000.
- **The instrumentation proof succeeds**, including specifically confirming
  telemetry survives a bad-then-good upload sequence through the modified
  handlers.
- A handful of further Low/Info findings recorded below (§7), none blocking.

---

## 1. `bob check verify` — precondition

Fresh `npm test` at the start of this pass confirmed **206/206**, `tsc
--noEmit` clean, matching `04-green-evidence.v5.md`'s claim exactly. Correct
gate to run.

---

## 2. M-V4-02 — disposition: CLOSED

Both agents reconstructed the finding independently against real Postgres and
a real spawned server:

```
security auditor:
  writer B holds a fresh lock
    publish       -> 409 DRAFT_LOCKED {holder: Marie D.}
    upload cover  -> 409 DRAFT_LOCKED {holder: Marie D.}, rows created: 0
  lock aged to 89s (inside window)  -> upload still 409
  lock aged to 102s (stale)         -> upload 201, takeover works

e2e agent (independent):
  publish 409 DRAFT_LOCKED -> upload 409 DRAFT_LOCKED, same envelope + display name
  rows_created 0 on all four upload branches tried (truncated cover, good cover,
    truncated body, PDF) -- no row, no storage, no demote
  staleness boundary AGREES BETWEEN THE TWO ROUTES TO THE SECOND:
    89s -> both 409 | 91s/200s/3600s -> both allowed
```

The e2e agent's boundary-agreement test is the strongest possible proof that
`upload` calls the same `evaluateLock` function publish does, rather than a
parallel reimplementation that happens to agree today. No further action
needed on this finding.

---

## 3. M-V4-01 — disposition: PARTIALLY CLOSED, three related findings

### 3.1 The original v4 reproduction is genuinely closed

```
e2e agent, 13 distinct upload sequences, each on a freshly published live article:
  bad; bad,bad; bad,good,bad (with/without intermediate publishes);
  bad x3 + good; good + bad; pdf + bad + good; bad,bad,good,bad,bad,good (6 steps)
  -- every sequence ends: publishable, exactly 1 ready cover, correct image live
  -- render pass never shows a failed image as the cover in any sequence
     (structurally can't: status='ready' filter + failed rows have optimized_url null)
```

Bob's own instrumentation proof (§8) independently confirms the same for a
bad-then-good sequence, with correct telemetry throughout.

### 3.2 M-V5-01 (Medium) — the identical bug is still reachable via the `body` role

Found independently by both the security auditor and the e2e agent. Proven
live by the security auditor:

```
publish before anything                          -> 200
upload truncated-body.jpg as role=body            -> 201 {"status":"failed"}
publish                                           -> 409 IMAGE_NOT_READY {role: "body"}
upload a GOOD body image (the documented remedy)  -> 201, converts to ready
publish                                           -> 409 IMAGE_NOT_READY {role: "body"}   <- still
upload a GOOD cover as well                       -> 201, converts to ready
publish                                           -> 409 IMAGE_NOT_READY {role: "body"}   <- still, forever
authenticated: delete -> 42501, update status -> 42501, update optimized_url -> 42501
```

`isRejectedAttempt()`'s exclusion only applies to `image.role === 'cover'`.
Green-v5's stated reason for the asymmetry — "a body image is referenced from
the article's own HTML; nothing supersedes it" — does not hold for a
*rejected* body image specifically: `uploadImage.ts` gives a synchronously-
rejected upload `original_url: null`/`urls: null` on every path, so it was
never embeddable in the body HTML in the first place. It is exactly as
orphaned as the rejected-cover case the fix already handles; only its `role`
column differs. The e2e agent independently reproduced the identical trace
and reached the identical root-cause conclusion.

### 3.3 M-V5-02 (Medium) — a `processing` cover demoted then failing asynchronously hits the same trap

Found by the security auditor, proven entirely through product routes
including the real Lambda-status callback:

```
article with cover/ready
  upload cover X (large, slow to convert)   -> 201; X = cover/processing
  upload cover Y                            -> 201; X is now  body/processing   <- demoted while processing
  Lambda reports X failed (real callback)   -> 200; X is now  body/failed
  publish                                   -> 409 IMAGE_NOT_READY {role: "body", status: "failed"}
  upload yet another good cover Z, converts -> ready
  publish                                   -> 409 IMAGE_NOT_READY {role: "body", status: "failed"}  <- permanent
```

The `repo.ts` `status <> 'failed'` guard (green v5's self-found fix for the
second-order case) is evaluated at demote time — but `status` is asynchronous
(written later by the Lambda callback), so a cover that's merely `processing`
at demote time and *later* fails slips through, ending up exactly where the
guard was meant to prevent it from ending up. This is one lifecycle step
later than the bug green v5 already found and fixed for itself — the same
shape, recurring.

### 3.4 M-V5-03 (Medium, regression introduced by this pass) — the publish-readiness decision now depends on a writer-writable column

Found by the security auditor, proven live:

```
article with cover/ready, plus a body image genuinely referenced from body_html
  the body image's conversion fails          -> body/failed
  publish                                    -> 409 IMAGE_NOT_READY     (correct, AC-08 working)
  any writer, direct PostgREST as `authenticated`:
    update article_images set role='cover'   -> ALLOWED (authenticated's only image grant)
  publish                                    -> 200, article live with a broken embedded image
```

`isRejectedAttempt()` keys its exclusion on `role`, which is precisely the
one `article_images` column `authenticated` may write directly
(`db/migrations/0001_initial_schema.sql`: `grant update (role, alt_text)`).
Before this pass, `role` had no bearing on publish-readiness. This is not
privilege escalation (any writer can already do this to any article, matching
the "writers have equal rights" design named at v1) but it is a new integrity
control defeated by a client-supplied value — the same class as the
still-open M-V3-03. Medium.

### 3.5 The unifying fix, per both agents converging independently

Both the security auditor and the e2e agent independently landed on the same
conclusion: the correct discriminator is **whether the row was ever
adopted** (e.g. `original_url is null`, or equivalent supersession-in-slot
logic), not `role`. That single change closes M-V5-01 and M-V5-03 together
and keeps the existing `AC-08-recovery-03` control green (its seeded
still-in-use row has real URLs, unlike a synchronously-rejected one).
M-V5-02 additionally needs the demote guard narrowed to `status = 'ready'`
(only take over a slot that's actually settled), since "not yet failed" and
"successfully ready" are different conditions and the bug lives in that gap.

---

## 4. M-V5-04 (Medium, upgraded from v4's L-V4-01) — a shared idempotency key between publish and upload can silently swallow a publish

Found by the security auditor's same-shape hunt (checking every pair of
routes that mutate the same or adjacent resources for inconsistent handling)
and framed independently by the e2e agent as a related item. Proven live:

```
POST /publish  Idempotency-Key: 1   -> 200, article published
POST /images   Idempotency-Key: 1   -> HTTP 200, body is the PUBLISH response
                                        (canonical_url, structured_data, sitemap...)
                                        no image row created, the file silently discarded

reverse order, second article:
POST /images   Idempotency-Key: 1   -> 201, image created
POST /publish  Idempotency-Key: 1   -> HTTP 201, body is the UPLOAD response
                                        article status afterwards: "draft"    <- never published
```

The store's key (`${key}::${article_id}`, in `router.ts`) has no `writer_id`
and — the part that makes this worse than v4's L-V4-01 — no *operation*
component either. `05-verification.v4.md` recorded the cross-writer version
of this at Low; the cross-operation version means a writer clicking "Publish"
can receive an apparently-successful response while the article silently
stays a draft, on the one action the whole product exists to perform. The
contract declares the key as an arbitrary opaque string, so no attack is
needed — just a client (or a retry helper) that reuses one key across an
editing session. Fix: key on `${writer_id}::${operation}::${key}::${article_id}`,
with a TTL matching the contract's stated 24h/5min windows (also still
missing, carried over from v4's L-V4-01).

---

## 5. M-V5-05 (Medium) — two articles with the same title permanently 500 on the second publish

Found by the e2e agent's higher-depth contract fuzzing, not adversarial
security testing — a genuine, ordinary-use bug. Minimized:

```
create + publish article "Match Report"     -> 200
create + publish a second "Match Report"    -> 500 INTERNAL_ERROR, permanently
  (retrying does not help; only a human renaming the article recovers)
```

`articles.slug` is `unique` in the schema. `publishArticle.ts` calls
`generateSlug(article.title)` with **no `existingSlugs` argument**, so the
function's own dedup branch is dead code at every call site that matters —
the only test coverage (`PROP-01`) calls the pure function directly with an
`existingSlugs` array it constructs itself, so it can never observe that the
real caller doesn't pass one. The resulting Postgres `23505` unique-violation
is not mapped to a handled error code anywhere, so it falls through to the
generic 500 handler. Contradicts AC-14's "collision-free slug, with no writer
action" promise directly. Easy to hit by accident: `createDraft`'s own
default title (`"Sans titre"`) means two untitled drafts collide immediately.
Fails safe (no partial write, no telemetry, nothing goes public) — Medium,
not High. Fix: pass real existing slugs to `generateSlug` (a `select slug
from articles where slug like ...` at publish time), or catch `23505`
specifically and retry with a suffix.

---

## 6. Performance — no regression

Full detail: perf agent's report, folded in here.

### 6.1 The two new checks' cost

`evaluateLock` (pure function, M-V4-02): **2.5-3.4 nanoseconds per call** —
below any meaningful measurement. `isRejectedAttempt` (M-V4-01): **never
invoked on a healthy publish** — it sits behind `image.status !== 'ready' &&`
in the `find` callback, so every normal publish (every image `ready`) costs
it exactly zero work, not "small" work. In-process A/B against a pre-v5
control (interleaved, 9,000 calls/arm) found v5 numbers statistically
indistinguishable from — in one arm, marginally *faster* than — the control,
confirming both additions are noise-level.

The one genuinely new round trip: upload's new `409 DRAFT_LOCKED` refusal now
calls `repo.getWriterDisplayName` (a lookup upload never made before). Real
Postgres: p50 3.69ms, same shape and cost class as publish's identical
existing refusal — 0.7% of the publish-class budget.

### 6.2 The accumulation trade-off (green v5 §6.1), quantified

`isRejectedAttempt` is technically O(k²) in the number of orphaned `failed`
rows on one article (accepted in green v5 as a known, unfixed trade-off since
there's no delete path). Measured directly:

| Orphan rows on one article | Cost |
|---|---|
| 0-100 | indistinguishable from zero (16-28µs in-process) |
| 1000 | ~1.8ms extrapolated in-process; +4.4ms over real HTTP (dominated by fetching 1001 rows with no `LIMIT`, not by the scan itself) |
| 2000 | 7.04ms — 1.4% of the 500ms publish budget |

At this system's stated scale (5-15 articles/week, 2-5 writers), reaching
k>10 on one article already implies ten rejected uploads to that single
article. **No optimization is warranted or recommended.** If §6.1's delete
path is ever added, this concern disappears entirely. (The security auditor
separately flagged the accumulation itself as a very weak, multi-day,
single-writer-credential DoS vector — see L-V5-01 below; the perf numbers
here quantify exactly how weak.)

### 6.3 Existing budgets, re-confirmed

| Area | Budget | v4 | v5 measured | Verdict |
|---|---|---|---|---|
| Publish, back-to-back warm | p95 < 500ms | p50 3.78/p95 6.83ms | p50 4.93/p95 8.70/p99 11.27ms (n=120) | PASS, 1.7% of budget |
| Publish, cold | < 2s | 42.5ms | 31.9-47.5ms | PASS |
| Image conversion, near cap | < 15s | 1.33-1.47s | 1.28-1.35s (18.4MB/31.9MP) | PASS, 9% |
| Public render, N=1000 | < 200ms | 5.66-9.88ms | home warm 5.9-6.5ms, category 4.0-5.2ms | PASS, same O(archive) trend, still not urgent |
| Lock/heartbeat write | < 50ms | p50 0.33/p95 0.77ms | p50 0.41/p95 0.81ms | PASS |
| Upload response (async) | publish class | 12-142ms | cold 21-41ms, warm p50 19.1/p95 43.0ms | PASS, 8.6% |

`NFR-IMGCPU-01` didn't fire in any run; re-run in isolation for completeness
at 442ms against its 1000ms budget — consistent with its documented
characterization as a concurrent-load flake across every prior pass, not a
regression.

---

## 7. Further findings, Low/Info

### L-V5-01 (Low) — the accepted accumulation trade-off is a very weak DoS vector, not purely a data-hygiene concern
Security auditor: with the shipped 10 uploads/min/IP limit, a writer can add
~14,400 orphaned rows/day to a single article, which per §6.2 extrapolates
into the same order of magnitude as the publish budget at very large k. Needs
a valid writer credential, targets one article, takes days — weak, but real
and newly relevant because this pass introduced the quadratic scan on top of
the already-accepted row growth.

### L-V5-02 (Low) — two different clocks decide the same 90-second lock window
Security auditor: `open` decides staleness in Postgres (`locked_at < now() -
'90 seconds'`, the database's clock); `publish`/`upload` decide it in the API
process (`evaluateLock` against `deps.now()`). Any skew between the API host
and the database host opens a band where the two routes could disagree about
who holds a lock — no attacker needed, just drift. One layer down from
M-V4-02's now-closed shape: the same rule enforced from two sources of truth.
Fix: have `evaluateLock`'s callers source `now` from the database, or move
the check into the same SQL predicate `open` uses.

### L-V5-03 (Low, confirmed by both agents, e2e with concrete numbers) — `createDraft`/`open` are not rate limited
E2e agent: 40 back-to-back drafts → 40 rows in 80ms, each also writing a
`draft_started` row (the success metric's own numerator). `NFR-RATE-01`'s
stated scope is "mutating endpoints" generically; these two are the
exception. Needs a valid writer credential; not urgent at 2-5 writers, but
cheap to close for consistency and because it directly touches the success
metric's data.

### L-V5-04 (Low) — `meta_title`/`meta_description` length limits disagree between the contract (characters) and the implementation (UTF-16 code units)
E2e agent, found via fuzzing: a 43-character title using astral-plane script
characters is refused as "over 70 characters" by zod's `.max()`, which counts
UTF-16 code units, not the contract's declared character-count semantics.
Realistic trigger: emoji in a headline. Low — cosmetic for this system's
likely content (French football commentary), but a real contract/implementation
mismatch.

### I-V5-01 (Info) — contract doesn't declare `429` responses
Security auditor: `publish` and `upload` both return `429 CONFLICT` in
practice; the contract has no explicit `429` on either operation, so it
validates against the generic `default` catch-all and Schemathesis doesn't
flag it. No functional issue, just undocumented.

### I-V5-02 (Info) — unenforced `Idempotency-Key` length bounds feed an unbounded, no-TTL map
E2e agent: compounds M-V5-04 above — the store already has no TTL against
the contract's stated windows; unbounded key length makes the growth
unbounded in size as well as count.

### I-V5-03 (Info) — idempotency replay is checked before the lock check
E2e agent: ordering note only; no mutation risk, since a replay short-circuits
before any write regardless of lock state.

### Workspace hygiene, recurring (not a new finding)
Both agents independently flagged the same hazard v4 §8/I-V4-04 already
recorded: a concurrently-running perf agent's own throwaway `tests/perf/`
directory was untracked and briefly present in this shared worktree mid-pass,
which would make `npm test`/`tsc` disagree with CI for anyone running them in
that exact window. Cleaned up by the agent itself each time; `git status` is
clean now. Noted again only because it's now recurred at two consecutive
verify passes — worth a `.gitignore` entry or a firmer scratch-location
convention for agents so it stops needing to be re-discovered.

### Still open from v3/v4, confirmed unchanged
M-V3-02 (heartbeat documentation), M-V3-03 (lock bypass via direct
PostgREST — note L-V5-02 above is now a close cousin), M-V3-04 (`CDN_ORIGIN`
hardcoded — still the highest-priority backlog item, still bricks any real
deployment), N5/N5b (NUL byte in `title` → 500; the e2e agent's 4,000+
`createDraft` fuzz cases this pass did *not* rediscover it, reconfirming
N5b's point about suite non-determinism), N2 (internal contract not
re-fuzzed this pass).

---

## 8. Instrumentation proof, fifth pass

Run by hand by Bob, real Postgres 16, real spawned server. This pass touched
both the upload and publish handlers, so the primary path was re-exercised
with a bad-then-good upload sequence specifically, to confirm telemetry
survives the modified code correctly:

```
create: 201
bad upload:  201 {"status":"failed", "failure":{"code":"CORRUPTED_FILE",...}}
good upload: 201
a ready cover exists: true
publish (after bad-then-good upload): 200

telemetry rows:
  {"event_type":"draft_started", "occurred_at":"...07:16:33.380Z"}
  {"event_type":"article_published", "occurred_at":"...07:16:33.445Z"}
HAND-COMPUTED time-to-publish = 0.0011 minutes

final image rows: [{"role":"cover","status":"failed","original_filename":"bad.jpg"},
                    {"role":"cover","status":"ready","original_filename":"good.jpg"}]

-- M-V4-02, independently reconfirmed --
stranger-to-the-lock upload: 409 DRAFT_LOCKED {holder: "Colleague"}
image rows created despite the lock: 0
```

Metric remains computable, attribution correct, telemetry unaffected by the
bad-then-good sequence, final image state exactly matches M-V4-01's intended
design (one orphaned `failed`, one `ready`). M-V4-02 independently
reconfirmed a third time. Counter-metric unchanged, still the documented
honest gap from v1-v4.

---

## 9. Tooling — clean

- **semgrep**: 0 findings across `src`/`db`/`scripts` (129 rules, multiple
  rulesets). Note: the `tests/` run reported 0 findings but **0 files
  scanned** — semgrep's default ignore file silently excludes `tests/`,
  which may mean v4's claimed tests-directory scan had the same silent skip.
  Worth fixing the invocation (an explicit `--include`) at the next pass so
  this stops being an open question.
- **gitleaks**: all hits (working tree + 19-commit history) confirmed
  false-positive test fixtures or doc-comment text. No real secret.
- **`npm audit --omit=dev`**: 0 vulnerabilities.
- **Full suite**: 206/206, confirmed by both the security auditor and 4 fresh
  e2e-agent runs. `tsc --noEmit` clean.
- **Contracts at depth**: e2e agent ran ~15,452 unpinned cases across
  JWT-registered-writer, JWT-stranger and legacy-seeded modes (including the
  JWT-mode provider fuzzing flagged as missing at v4, `I-V4-04` — now done),
  plus a **pinned** 3,220-case run targeting specific article states (locked,
  mixed ready/failed images, publishable) to aim fuzzing squarely at this
  pass's new logic. Found nothing new around the lock-check or
  readiness-filter mechanisms themselves — M-V5-05 (the slug collision) came
  from the unpinned run's broader coverage, not from targeting this pass's
  changes specifically.

---

## 10. Gate verdict

**NOT PASSED.**

M-V4-02 is fully and cleanly closed, confirmed three independent ways
(security auditor, e2e agent, Bob's own instrumentation proof) including the
strongest evidence yet that a shared check is genuinely shared rather than
duplicated-and-coincidentally-agreeing.

M-V4-01 is not: the fix closed the specific reproduction the v4 report
demonstrated, but both verify agents — independently, using different
methods (adversarial exploitation vs. systematic sequence/fuzz testing) —
found the identical underlying bug still reachable through the `body` slot
and, less directly, through an async timing window on the `cover` slot the
fix's own new guard didn't fully close. Applying this gate's own standard
from v3 (HEIC) and v4 (the original M-V4-01): an acceptance criterion whose
documented recovery story is provably false against real infrastructure
blocks the gate, regardless of how the gap was found.

Two further items make this a genuinely five-finding pass rather than a
narrow miss: this pass's fix introduced a real (if Medium, not High)
regression of its own (M-V5-03, the `role`-column integrity bypass), and
ordinary fuzzing — not adversarial testing — found a fully unrelated,
deterministic, no-attacker-required bug (M-V5-05, duplicate-title slug
collision) that AC-14 explicitly promises can't happen.

**Recommended next cycle, per both agents' converging analysis:**
1. M-V5-01 + M-V5-02 + M-V5-03 together, as one fix family: key
   `isRejectedAttempt`'s exclusion on whether a row was ever adopted
   (`original_url is null`, or slot-supersession) rather than on `role`, and
   narrow `demoteCurrentCover`'s guard to `status = 'ready'` rather than
   `status <> 'failed'`. One coherent change closes all three.
2. M-V5-04 (idempotency key scoping — one line, `${writer_id}::${operation}::${key}::${article_id}`, plus a TTL).
3. M-V5-05 (pass real existing slugs to `generateSlug`, or catch `23505` and retry with a suffix).

Then the growing v3/v4 backlog, with M-V3-04 (`CDN_ORIGIN`) still the item
most likely to brick a real deployment.
