# arsene-cms — Red gate, seventh remediation pass (v7)

> Gate 3 (red), run a seventh time. This document covers **only** the seventh
> remediation pass, for `05-verification.v6.md`'s two blocking findings —
> **H-V6-01 / M-V6-01** (an article whose only cover is a rejected upload
> publishes live with no cover image at all) and **M-V6-02** (a writer can
> deterministically choose which image row gets treated as "superseded",
> bypassing AC-08). Both live in the same area of code — the publish-readiness
> logic green v6 rewrote — and the product owner scoped them as **one fix
> family** for this gate, which is also the order `05-verification.v6.md` §10
> recommends.
> Tests only — no production code was written, changed or deleted by this pass,
> and no file under `src/` or `db/` was touched.
>
> Explicitly out of scope, per the product owner's scoping: L-V6-01
> (`CDN_ORIGIN` configurable but unvalidated — noted in §5 below because the
> verify report asks for it to land *with* M-V6-02's migration), L-V6-02 (two
> unordered picks of "the" cover), L-V6-03 (the transient slug race), I-V6-01
> (the sanitizer correction — a finding that changes framing, not behaviour),
> and the standing v3/v4/v5 backlog (N5/N5b, N2, the idempotency-store TTL and
> `writer_id` scoping).

**Status:** red | **Author:** Claude (Opus 5), written by `bob-test-author` |
**Date:** 2026-08-18 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `b0746e6`) | **Baseline:** the green suite as it
stands on this branch — **216 tests, 216 passing, 36 files**, re-run in full
before a line of this pass was written (see §1.1).

---

## 0. What this pass had to cover, and what it produced

| Finding | Severity | Tests added | New ids |
|---|---|---|---|
| H-V6-01 / M-V6-01 — an article whose only cover-role row is a rejected upload publishes live with `cover_image_url: ''`; `COVER_IMAGE_REQUIRED` and the readiness gate no longer agree on what "has a cover" means | High (e2e agent) / Medium (security auditor) — recorded as a preserved disagreement, blocking either way | 3 + 1 control | `AC-08-recovery-07`, `NFR-COVER-INVARIANT-01`, `AC-08-recovery-08`, `NFR-COVER-INVARIANT-02` |
| M-V6-02 — a writer vacates the cover slot, moves a broken, genuinely-used image into it, then uploads a good cover; `demoteCurrentCover()` matches exactly one row, so the target is recorded as superseded and stops blocking | Medium | 1 | `NFR-IMAGE-ROLE-02` |

3 + 1 + 1 = **5**.

**5 new tests. 4 fail, each on exactly one honest assertion reproducing the
trace the verify pass proved by hand.** 1 passes, and is meant to — it is the
both-sides control that stops the cheapest wrong fix:

- `NFR-COVER-INVARIANT-02`: an article whose cover is genuinely `ready` still
  publishes `200`, and both the response and the persisted
  `articles.structured_data` carry that cover's real CDN URL. Without it,
  "refuse any publish whose cover looks doubtful" turns
  `AC-08-recovery-07`/`08` and the invariant sweep green while deleting the
  product. The sweep's fourth combination (a rejected cover arriving *beside* a
  healthy one — M-V4-01's shape) is the same guard restated inside the
  invariant itself, and it is already the one combination the sweep does not
  flag today.

**All 216 previously-passing tests still pass**, and no existing test's
assertions were edited.

Test count: 216 → **221**. Test files: 36 → **37**.

---

## 1. The commands, and their output

### 1.1 Baseline, before anything was written

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  36 passed (36)
      Tests  216 passed (216)
   Start at  23:25:38
   Duration  32.71s (transform 1.10s, setup 0ms, collect 10.79s, tests 154.40s, environment 6ms, prepare 2.64s)
```

216/216, matching `05-verification.v6.md` §1 and `04-green-evidence.v6.md`
exactly. `NFR-IMGCPU-01` — the wall-clock-budget flake documented at every prior
pass — did not fire, so the single confirming re-run the brief allows for was
not needed:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 779ms
```

### 1.2 The full suite, with the five new tests in place

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  2 failed | 35 passed (37)
      Tests  4 failed | 217 passed (221)
   Start at  23:33:29
   Duration  34.16s (transform 1.20s, setup 0ms, collect 11.68s, tests 164.16s, environment 5ms, prepare 2.45s)
```

221 = the 216 green-gate tests + 5 new. 217 passing = 216 baseline + the 1 new
control above, so nothing regressed. The 2 failing files are
`tests/e2e/coverImageInvariant.test.ts` (new) and
`tests/e2e/rejectedImageRecovery.test.ts` (pre-existing, and **only** its one
new test fails — its four v6 tests all still pass, quoted in §2.2).

```
$ npx tsc --noEmit
TSC_EXIT=0
```

`NFR-IMGCPU-01` passed in this run too:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 655ms
```

---

## 2. Every new test, with its result and its one reason for failing

### 2.1 The four failures

Verbatim, from the run in §1.2 — not summarised, not re-typed:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > AC-08-recovery-07: an article whose only cover-role image is a rejected upload is still refused at publish and stays a draft — a file the product itself refused, stored nowhere and convertible into nothing, is not a cover image, and answering COVER_IMAGE_REQUIRED before it was uploaded but 200 afterwards is the two checks disagreeing about what "has a cover" means
AssertionError: expected { …(6) } to deeply equal { …(6) }

- Expected
+ Received

  Object {
-   "article_status": "draft",
+   "article_status": "published",
    "cover_rows_before_the_upload": 0,
-   "publish": "refused",
+   "publish": "200, live with cover image \"\"",
    "upload_says": "failed",
    "upload_status": 201,
    "usable_cover_rows_after_the_upload": 0,
  }

 ❯ tests/e2e/coverImageInvariant.test.ts:344:8
    342|       publish: outcomeOf(result),
    343|       article_status: article.status,
    344|     }).toEqual({
       |        ^
    345|       cover_rows_before_the_upload: 0,
    346|       upload_status: 201,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > NFR-COVER-INVARIANT-01: across every combination of image states, a publish answered 200 always carries a non-empty cover image — the invariant itself, rather than another enumeration of the specific states this one function has now silently dropped twice
AssertionError: expected [ { …(5) }, { …(5) }, { …(5) } ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "combination": "rejected-cover-only",
+     "cover_image": "",
+     "publish_status": 200,
+     "stored_cover_image": "",
+     "violates": "published 200 with no cover image",
+   },
+   Object {
+     "combination": "rejected-cover-beside-a-ready-body-image",
+     "cover_image": "",
+     "publish_status": 200,
+     "stored_cover_image": "",
+     "violates": "published 200 with no cover image",
+   },
+   Object {
+     "combination": "rejected-cover-and-rejected-body",
+     "cover_image": "",
+     "publish_status": 200,
+     "stored_cover_image": "",
+     "violates": "published 200 with no cover image",
+   },
+ ]

 ❯ tests/e2e/coverImageInvariant.test.ts:449:24
    447|     });
    448| 
    449|     expect(violations).toEqual([]);
       |                        ^
    450|   });
    451| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > AC-08-recovery-08: an already-live article that publish is correctly refusing COVER_IMAGE_REQUIRED is not pushed live again by uploading a broken replacement cover, and the cover its public page is already serving is not overwritten with an empty one — the same disagreement as AC-08-recovery-07, reached from the state where it costs a page that was already correct
AssertionError: expected { …(6) } to deeply equal { …(6) }

- Expected
+ Received

  Object {
-   "cover_image_served_after": "https://cdn.example/live-article/couverture-en-ligne.webp",
+   "cover_image_served_after": "",
    "cover_image_served_before": "https://cdn.example/live-article/couverture-en-ligne.webp",
    "cover_rows_before_the_upload": 0,
-   "publish": "refused",
-   "republished": false,
+   "publish": "200, live with cover image \"\"",
+   "republished": true,
    "upload_says": "failed",
  }

 ❯ tests/e2e/coverImageInvariant.test.ts:500:8
    498|       cover_image_served_after: await storedCoverImage(db, fx.live_art…
    499|       republished: article.republished,
    500|     }).toEqual({
       |        ^
    501|       cover_rows_before_the_upload: 0,
    502|       cover_image_served_before: LIVE_COVER_URL,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > NFR-IMAGE-ROLE-02: a writer who vacates the cover slot and moves a broken, genuinely-used body image into it before uploading a replacement cover still cannot publish — choosing which row the next upload supersedes is choosing which row stops blocking, and one image row per article is not a decision a writer gets to make about their own article’s integrity
AssertionError: expected { …(4) } to deeply equal { …(4) }

- Expected
+ Received

  Object {
-   "article_status": "draft",
-   "publish_after_the_swap": "409 IMAGE_NOT_READY",
+   "article_status": "published",
+   "publish_after_the_swap": "200 undefined",
    "publish_before_the_swap": "409 IMAGE_NOT_READY",
    "replacement_cover": "ready",
  }

 ❯ tests/e2e/rejectedImageRecovery.test.ts:634:8
    632|       publish_after_the_swap: `${after.status} ${after_code}`,
    633|       article_status: article.status,
    634|     }).toEqual({
       |        ^
    635|       publish_before_the_swap: '409 IMAGE_NOT_READY',
    636|       replacement_cover: 'ready',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
```

### 2.2 The control, and the four v6 tests in the file this pass extended

From the same run:

```
 ✓ tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > NFR-COVER-INVARIANT-02: an article whose cover is genuinely ready still publishes 200 and its page really carries that cover’s CDN URL — the both-sides half, so reconciling the two checks cannot be done by refusing publishes that were always legitimate
 ✓ tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes — a file the product refused was never embedded in the body, so it cannot leave behind a row that blocks publishing forever, exactly as for a rejected cover
 ✓ tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > AC-08-recovery-05: a cover still converting when a second cover upload supersedes it, and which the Lambda only then reports as failed, does not block republication either — the outcome of an upload is decided after the slot was taken, so a guard read at the moment of the upload cannot see it 344ms
 ✓ tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > AC-08-recovery-06: a body image the article is genuinely still using — stored, referenced from its own body_html, and broken — does keep refusing the publish, 409 IMAGE_NOT_READY, so the two fixes above cannot be had by exempting body rows or failed rows wholesale
 ✓ tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article — the readiness gate may not be decided by a column any writer can write
```

The three fixture articles the new `NFR-IMAGE-ROLE-02` adds are its own; none
of the four pre-existing tests in that file share a row, an article or an
`Idempotency-Key` with it, which is why they are all still green.

### 2.3 What each failure proves is missing

| Id | Finding | Failure | What it proves |
|---|---|---|---|
| `AC-08-recovery-07` | H-V6-01/M-V6-01 | the draft has **0** cover rows, one truncated cover upload is answered `201 {"status":"failed"}` leaving **0** *usable* cover rows, and the publish that follows answers `200` and takes the article live carrying `cover image ""` | The two checks disagreeing, end to end through product routes only. `refusePublish()` asks `images.some(i => i.role === 'cover')`, which the rejected row satisfies; the readiness gate asks `articleDependsOn()`, which correctly excludes that same row (`original_url is null` — `uploadImage.ts` stores nothing for a file it refuses); so nothing refuses the publish, and `publishNow()` falls through to `cover_image_url: ... ?? ''`, the branch `04-green-evidence.v6.md` §4.2 calls "unreachable... defensive typing, not a path". `usable_cover_rows_after_the_upload: 0` is the assertion's own statement that the article genuinely has no cover to publish. |
| `NFR-COVER-INVARIANT-01` | H-V6-01/M-V6-01 | **three of four** combinations publish `200` with `structured_data.image` of `""`, both in the response and in the row `markPublished` persisted; the fourth (a rejected cover beside a `ready` one) does not, and is not flagged | The invariant both verify agents asked for, stated once instead of enumerated. Two of the three violating combinations — a rejected cover beside a healthy **body** image, and a rejected cover plus a rejected body — are states nobody reported; they were generated by varying the *other* rows, because `articleDependsOn(image, images)` takes the whole image list as its second argument, so what else is present is exactly what decides the outcome. That is the class of case this one function has now dropped twice (M-V5-01/02/03, then H-V6-01) while every enumerated case was green. The fourth combination not being flagged is the invariant's own proof that "refuse everything" is not a fix. |
| `AC-08-recovery-08` | H-V6-01/M-V6-01, §2's "E2c" | the live article's page is serving a real cover before the attempt; after one rejected replacement upload the republish answers `200`, `articles.structured_data`'s image becomes `""`, and `published_at` moves | The same code path as `AC-08-recovery-07` (no separate defect), reached from the state where it costs something that was already correct: a page that had a valid `og:image` loses it, silently, in the same request that reports success. Kept as its own test because the observable is different — the harm is the *overwrite* of live page data, not a draft failing to be refused — and because `is_republish` telemetry fires on this path as a normal success. |
| `NFR-IMAGE-ROLE-02` | M-V6-02 | before the swap, publish correctly refuses `409 IMAGE_NOT_READY`; after two direct `role` writes as `authenticated` and one ordinary good cover upload that really converts (`replacement_cover: ready`), publish answers `200` and the draft goes live | The security auditor's construction from `05-verification.v6.md` §3, run for real. Vacating the slot first (`role='body'` on the real cover) leaves `demoteCurrentCover()`'s `update … where role='cover' returning id` exactly one row to match, so `replaced_cover_image_id` lands on the attacker-chosen row **by construction, not by luck** — which is precisely what green v6 §6.3's "non-deterministic (depends on which row `returning id` yields first)" characterization got wrong. The row so excluded is adopted (`original_url` present), `failed`, and referenced from the article's own `body_html`: the exact row AC-08 exists to block. Executed as the `authenticated` role itself, against real RLS and real column grants — the same technique `NFR-LOCK-GRANT-01a`/`01b` and `NFR-IMAGE-ROLE-01` use. |
| `NFR-COVER-INVARIANT-02` (passes) | H-V6-01/M-V6-01 | — | The boundary the fix must not cross: a genuinely `ready` cover still publishes `200` and its real CDN URL reaches both the response and the persisted `structured_data`. Without it, the cheapest way to green the other three is to tighten `COVER_IMAGE_REQUIRED` until legitimate articles stop publishing — which is the failure direction every finding before this one in this family took (`M-V4-01` through `M-V5-05` all failed *closed*). |

Nothing above is an import error, a missing fixture or a typo in the new tests.
Every failure is an assertion comparing a real observed value with the required
one, against real Postgres 16 (Testcontainers), real spawned child-process
servers over real HTTP, real truncated and real valid multipart JPEG bytes
through the real upload route, and — for `NFR-IMAGE-ROLE-02` — two direct writes
executed as the `authenticated` role through real RLS and real column grants.

---

## 3. Why each test sits at the layer it does, and what none of them prescribe

- **Both findings → end-to-end, real infrastructure.** The empty string is only
  observable where the *upload route's own row* meets the *publish handler's
  own checks*: the unit-level publish tests (`tests/unit/publishArticle.test.ts`,
  `publishRemediation.test.ts`) feed the handler a hand-built `ImageRecord[]`,
  so they can express any state a test author thinks of but never the state the
  product actually writes — which is how a rejected cover row satisfying
  `COVER_IMAGE_REQUIRED` while failing `articleDependsOn()` stayed invisible
  through a green gate. M-V6-02 additionally needs the real
  `update … where role='cover' returning id`, real grants and a real conversion,
  none of which exist below this layer.
- **Two files, five tests, two containers.** M-V6-02 belongs beside
  `NFR-IMAGE-ROLE-01` — same fixture shape, same direct-grant technique, same
  file — so it went there. The four H-V6-01 tests went into a new file rather
  than the same one for a concrete reason: `rateLimit.ts` caps publishes at **10
  per minute per client IP**, every request in a spawned-server e2e file arrives
  from the same loopback address, and `rejectedImageRecovery.test.ts` already
  spends 4. Adding 7 more there would have produced `429`s — failures for a
  reason that has nothing to do with either finding. The new file spends 7 of
  its own 10 and reads its preconditions from the database rather than from
  extra publishes; the file this pass extended now spends 6.

**Nothing prescribes an implementation.** Both verify agents converged on one
repair for H-V6-01 (`images.some(i => i.role === 'cover' && articleDependsOn(i,
images))`, so both checks share one notion of "usable cover") and one for
M-V6-02 (`revoke update (role) on article_images from authenticated`, paired
with a server-side cover-selection route). No assertion here names any of it. In
particular:

- `AC-08-recovery-07` and `AC-08-recovery-08` accept **either** `400
  COVER_IMAGE_REQUIRED` **or** `409 IMAGE_NOT_READY` — both are refusals
  `publishArticle`'s contract already declares — and assert only that the
  article did not go live. Reconciling the cover check, widening the readiness
  gate, and refusing earlier are all equally admissible.
- `NFR-COVER-INVARIANT-01` asserts nothing about *which* combination is refused
  and which publishes; only that nothing goes live without a cover image. A fix
  that refuses all three violating combinations and a fix that publishes them
  with some other genuinely non-empty cover both satisfy it.
- `NFR-IMAGE-ROLE-02` asserts **no SQLSTATE** on either direct `role` write
  (both are `.catch(() => undefined)`), exactly as `NFR-IMAGE-ROLE-01` does.

### 3.1 The one place agnosticism was deliberately *not* forced

The brief asked whether `NFR-IMAGE-ROLE-02` should assert the `42501` the
recommended revocation would produce, rather than the downstream `409`. It
should not, and neither should `NFR-IMAGE-ROLE-01` be reshaped:

- Asserting `42501` would pin one of the two fix shapes into the suite. It would
  also be a *weaker* test: it would prove the write is refused while proving
  nothing about whether the publish gate is still correct — and the publish gate
  is the thing that has now been wrong three passes running.
- The downstream assertion is genuinely agnostic here, because both candidate
  fixes converge on the same observable. Under the revocation, both writes fail,
  the real cover keeps the slot, the replacement upload supersedes *it*, and the
  broken body row — adopted, `failed`, still referenced from `body_html` — goes
  on blocking: `409 IMAGE_NOT_READY`. Under a gate-side fix that stops letting
  supersession excuse a row the article genuinely uses, the swap happens and the
  same row blocks anyway: `409 IMAGE_NOT_READY`. The two shapes are
  distinguishable in the database, and not in the product's answer — so the
  product's answer is the honest thing to assert.
- **`NFR-IMAGE-ROLE-01` therefore does not need reconciling by the green pass
  either.** Its direct write is setup, already tolerant of refusal, and the row
  it targets keeps blocking under either fix. Both tests are expected to be
  green after the fix without being edited. This is recorded in
  `traceability.md`'s v7 section too, so the green pass does not rediscover it.

---

## 4. What this pass touched, and why none of it is an assertion change

| File | Change |
|---|---|
| `tests/e2e/coverImageInvariant.test.ts` | **New file.** `AC-08-recovery-07`, `NFR-COVER-INVARIANT-01`/`02`, `AC-08-recovery-08`. Real spawned server (legacy static auth, exactly as `tests/e2e/rejectedImageRecovery.test.ts` and `tests/e2e/coverReplacementRecovery.test.ts` use it, and for the same stated reason — setup only), real Postgres, real truncated JPEG bytes through the real multipart route, and both the response's and the persisted article's `structured_data` read for every outcome. |
| `tests/e2e/rejectedImageRecovery.test.ts` | **Additive only**: a header section documenting M-V6-02's trace, three new fields on the file's own private `Fixtures` type (`slot_swap_article`, `slot_swap_cover`, `slot_swap_image`) with their seeding, and the new `NFR-IMAGE-ROLE-02` test. No existing test's assertions, fixtures or data were changed; all four of its v6 tests still pass (§2.2). |
| `pdlc/arsene-cms/traceability.md` | New "Added by the seventh remediation pass (v7)" section, the header amendment paragraph the earlier passes' format implies, and the `NFR-IMAGE-ROLE-01`-under-revocation note from §3.1. |

No file in `src/` or `db/` was touched. No test-support module was touched — the
new file is built entirely from the existing `pg.ts`, `seams.ts`, `prism.ts` and
`imageFixtures.ts` helpers, so unlike v5 and v6 this pass adds no seam. No
existing test's assertions were edited. `state.json` untouched. Nothing
committed — the working tree is left unstaged for review.

---

## 5. Three observations recorded for the green pass (not tests, not blockers)

1. **M-V6-02's recommended fix removes a capability with no replacement.**
   `revoke update (role) on article_images from authenticated` deletes the only
   mechanism a writer currently has to designate an image as the cover;
   `05-verification.v6.md` §3 and L-V6-01 both say the revocation must land
   *with* a server-side cover-selection route. Nothing in this pass tests that
   route, deliberately — it does not exist yet and its shape is a product
   decision, not a red-gate assertion. But `NFR-IMAGE-ROLE-02` will pass on the
   revocation alone, so nothing in the suite will notice if the route is
   forgotten. Recorded so it is a decision rather than an oversight.
2. **L-V6-01 (`CDN_ORIGIN` configurable but unvalidated) is out of scope but
   scheduled into the same change.** The verify report groups it with M-V6-02
   because both touch the same migration/config pass. `NFR-CDN-CONFIG-01`/`02`
   (v6) pin the origin's *use*; nothing pins the refusal of a malformed one
   (trailing slash, path suffix, missing scheme, uppercase host), each of which
   silently reproduces M-V3-04's original symptom. Not tested here because it
   was not in this pass's scope.
3. **L-V6-02 sits one step beyond `NFR-COVER-INVARIANT-02`.** That control
   asserts the response's cover URL and the persisted `structured_data` agree
   with each other. It does **not** assert that `render.ts`'s own unordered
   `limit 1` pick agrees with either — the two-`ready`-covers divergence L-V6-02
   describes. Deliberately left alone: it is a separate finding with a separate
   fix (`order by created_at desc limit 1` in both places, or a persisted
   `cover_image_id`), and folding it in would have given the control two reasons
   to fail.

---

## 6. Gate statement

5 new tests, 4 failing on exactly one honest assertion each, against real
Postgres 16, two real spawned child-process servers over real HTTP, real
truncated and real valid multipart JPEG bytes, a real image conversion carried
to `ready`, and two direct PostgREST-shaped writes executed as the
`authenticated` role through real RLS and real column grants. 1 passing by
design, as the both-sides control that stops the cheapest wrong fix — the
"refuse everything" direction that every earlier finding in this family failed
in. 216 previously-passing tests still passing, `tsc --noEmit` clean. No
production code written. Red.
