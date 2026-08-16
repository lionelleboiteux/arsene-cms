# arsene-cms — Red gate, sixth remediation pass (v6)

> Gate 3 (red), run a sixth time. This document covers **only** the sixth
> remediation pass, for `05-verification.v5.md`'s five Medium findings —
> **M-V5-01**, **M-V5-02** and **M-V5-03** (one fix family), **M-V5-04** (the
> idempotency key shared between publish and upload) and **M-V5-05** (duplicate
> titles colliding on the unique slug) — plus **M-V3-04** (`CDN_ORIGIN`
> hardcoded to an unreachable `.example` placeholder), scheduled off the v3
> backlog by the product owner after three verify passes carried it forward.
> Tests only — no production code was written, changed or deleted by this pass,
> and no file under `src/` or `db/` was touched.
>
> Explicitly out of scope, per the product owner's scoping: L-V5-01 (the
> accumulation DoS vector), L-V5-02 (two clocks deciding one lock window),
> L-V5-03 (`createDraft`/`open` unrated-limited), L-V5-04 (character vs UTF-16
> length semantics), I-V5-01 through I-V5-03, and the remaining v3/v4 backlog
> (M-V3-02, M-V3-03, N5/N5b, N2).

**Status:** red | **Author:** Claude (Opus 5), written by `bob-test-author` |
**Date:** 2026-08-16 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `b5211bb`) | **Baseline:** the green suite as it
stands on this branch — **206 tests, 206 passing, 33 files**, re-run in full
before a line of this pass was written (see §1.1).

---

## 0. What this pass had to cover, and what it produced

| Finding | Severity | Tests added | New ids |
|---|---|---|---|
| M-V5-01 — a rejected **`body`** upload permanently blocks republication, exactly like the already-fixed cover case (`isRejectedAttempt()` excludes `role === 'cover'` only) | Medium | 1 | `AC-08-recovery-04` |
| M-V5-02 — a `processing` cover, demoted by a second upload and only *then* failing asynchronously, ends in the same permanent block (`demoteCurrentCover()`'s `status <> 'failed'` guard is read before the outcome exists) | Medium | 1 | `AC-08-recovery-05` |
| M-V5-03 — regression introduced by the v5 fix: the publish gate now keys on `article_images.role`, the one column `authenticated` may write directly via PostgREST | Medium | 1 + 1 control | `NFR-IMAGE-ROLE-01`, `AC-08-recovery-06` |
| M-V5-04 — one `Idempotency-Key` reused across a publish and an upload makes each operation answer for the other | Medium | 2 + 1 control | `NFR-IDEM-03a`, `NFR-IDEM-03b`, `NFR-IDEM-03c` |
| M-V5-05 — two articles with the same title permanently `500` on the second publish (unique `slug`, dead dedup branch, unmapped `23505`) | Medium | 1 | `AC-14-collision-01` |
| M-V3-04 — `CDN_ORIGIN` is a compile-time `.example` placeholder used as a hard validation gate on the real Lambda callback | Medium (carried from v3) | 2 | `NFR-CDN-CONFIG-01`, `NFR-CDN-CONFIG-02` |

1 + 1 + 2 + 3 + 1 + 2 = **10**.

**10 new tests. 8 fail, each on exactly one honest assertion reproducing the
trace the verify pass proved by hand.** 2 pass, and are meant to — they are the
both-sides controls that stop the cheapest wrong fix:

- `AC-08-recovery-06`: a `failed` **body** image the article is *genuinely still
  using* (adopted, and referenced from its own `body_html`) must keep refusing
  the publish. Without it, "exempt `body` rows too" or "stop counting `failed`
  rows" would turn `AC-08-recovery-04`/`05` green and delete AC-08's actual
  promise — the same role `AC-08-recovery-03` played at red v5, restated for the
  role the fix now has to touch.
- `NFR-IDEM-03c`: a genuine replay — same operation, same key, same article —
  must still return the original response and still create nothing new. Without
  it, deleting the idempotency store passes `NFR-IDEM-03a`/`03b` outright, and
  the existing `NFR-IDEM-01`/`02` would not notice: they run against the
  handlers' own injected fake store, never against `router.ts`'s shared one.

**All 206 previously-passing tests still pass**, and no existing test's
assertions were edited.

Test count: 206 → **216**. Test files: 33 → **36**.

---

## 1. The commands, and their output

### 1.1 Baseline, before anything was written

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  33 passed (33)
      Tests  206 passed (206)
   Start at  21:17:06
   Duration  37.01s (transform 1.40s, setup 0ms, collect 12.38s, tests 167.07s, environment 12ms, prepare 3.16s)
```

206/206, matching `05-verification.v5.md` §1 and `04-green-evidence.v5.md`
exactly. `NFR-IMGCPU-01` — the wall-clock-budget flake documented at every prior
pass — did not fire, so no isolation re-run was needed.

### 1.2 The full suite, with the ten new tests in place

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  3 failed | 33 passed (36)
      Tests  8 failed | 208 passed (216)
   Start at  21:27:12
   Duration  34.29s (transform 1.19s, setup 0ms, collect 11.68s, tests 157.56s, environment 8ms, prepare 2.90s)
```

216 = the 206 green-gate tests + 10 new. 208 passing = 206 baseline + the 2 new
controls above, so nothing regressed. The 3 failing files are all new
(`tests/e2e/rejectedImageRecovery.test.ts`, `tests/e2e/publishCollisions.test.ts`,
`tests/e2e/cdnOriginConfig.test.ts`); **no pre-existing test file failed**, which
is also why no existing file appears in §2.

```
$ npx tsc --noEmit
TSC_EXIT=0
```

`NFR-IMGCPU-01` passed in this run too:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 707ms
```

---

## 2. Every new test, with its result and its one reason for failing

Verbatim, from the run in §1.2 — not summarised, not re-typed:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/e2e/cdnOriginConfig.test.ts > the CDN origin callbacks are validated against is configuration (verify v3, M-V3-04) > NFR-CDN-CONFIG-01: a status callback whose optimized_url is on this deployment’s own configured CDN origin is accepted and the converted asset is really stored — otherwise every genuine Lambda callback is refused, every image stays processing forever and every publish is refused 409 IMAGE_NOT_READY, silently, in production
AssertionError: expected { callback_status: 400, …(3) } to deeply equal { callback_status: 200, …(3) }

- Expected
+ Received

  Object {
-   "callback_status": 200,
-   "error_code": undefined,
-   "row_status": "ready",
-   "row_stores_the_url": true,
+   "callback_status": 400,
+   "error_code": "VALIDATION_FAILED",
+   "row_status": "processing",
+   "row_stores_the_url": false,
  }

 ❯ tests/e2e/cdnOriginConfig.test.ts:217:8
    215|       row_status: row.rows[0]?.status,
    216|       row_stores_the_url: row.rows[0]?.optimized_url === optimized_url,
    217|     }).toEqual({
       |        ^
    218|       callback_status: c.status,
    219|       error_code: c.code,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/8]⎯

 FAIL  tests/e2e/cdnOriginConfig.test.ts > the CDN origin callbacks are validated against is configuration (verify v3, M-V3-04) > NFR-CDN-CONFIG-02: a status callback whose optimized_url is on the shipped `.example` placeholder — which is not this deployment’s origin — is refused on the body alone with the row untouched, so making the origin configurable cannot be done by widening the check to any URL
AssertionError: expected { callback_status: 200, …(3) } to deeply equal { callback_status: 400, …(3) }

- Expected
+ Received

  Object {
-   "callback_status": 400,
-   "error_code": "VALIDATION_FAILED",
-   "row_status": "processing",
-   "row_stores_the_url": false,
+   "callback_status": 200,
+   "error_code": undefined,
+   "row_status": "ready",
+   "row_stores_the_url": true,
  }

 ❯ tests/e2e/cdnOriginConfig.test.ts:217:8
    215|       row_status: row.rows[0]?.status,
    216|       row_stores_the_url: row.rows[0]?.optimized_url === optimized_url,
    217|     }).toEqual({
       |        ^
    218|       callback_status: c.status,
    219|       error_code: c.code,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/8]⎯

 FAIL  tests/e2e/publishCollisions.test.ts > one idempotency key across two operations (verify v5, M-V5-04) > NFR-IDEM-03a: an image upload that reuses the Idempotency-Key an earlier publish of the same article used is still performed, and is answered as an upload — a key a client reused across two operations must never make one of them answer for the other
AssertionError: expected { publish_status: 200, …(3) } to deeply equal { publish_status: 200, …(3) }

- Expected
+ Received

  Object {
-   "image_rows_for_the_uploaded_file": 1,
+   "image_rows_for_the_uploaded_file": 0,
    "publish_status": 200,
-   "upload_answered_about_an_image": "cover",
-   "upload_status": 201,
+   "upload_answered_about_an_image": undefined,
+   "upload_status": 200,
  }

 ❯ tests/e2e/publishCollisions.test.ts:277:8
    275|       upload_answered_about_an_image: uploaded.body.role,
    276|       image_rows_for_the_uploaded_file: await rowsFor(db, fx.publish_t…
    277|     }).toEqual({
       |        ^
    278|       publish_status: 200,
    279|       upload_status: 201,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/8]⎯

 FAIL  tests/e2e/publishCollisions.test.ts > one idempotency key across two operations (verify v5, M-V5-04) > NFR-IDEM-03b: a publish that reuses the Idempotency-Key an earlier image upload of the same article used really publishes the article — the writer must never be answered 2xx for the one action the product exists to perform while the article silently stays a draft
AssertionError: expected { upload_status: 201, …(3) } to deeply equal { upload_status: 201, …(3) }

- Expected
+ Received

  Object {
-   "article_status": "published",
-   "publish_status": 200,
+   "article_status": "draft",
+   "publish_status": 201,
    "upload_status": 201,
    "uploaded_image": "ready",
  }

 ❯ tests/e2e/publishCollisions.test.ts:305:8
    303|       publish_status: published.status,
    304|       article_status: article.status,
    305|     }).toEqual({
       |        ^
    306|       upload_status: 201,
    307|       uploaded_image: 'ready',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/8]⎯

 FAIL  tests/e2e/publishCollisions.test.ts > two articles with the same title (verify v5, M-V5-05) > AC-14-collision-01: publishing a second article whose title matches an already-published one succeeds and gets its own distinct slug — AC-14 promises a collision-free slug with no writer action, so an ordinary duplicate title cannot be a permanent 500
AssertionError: expected { first_publish_status: 200, …(3) } to deeply equal { first_publish_status: 200, …(3) }

- Expected
+ Received

  Object {
    "first_publish_status": 200,
-   "second_article_got_its_own_real_slug": true,
-   "second_article_status": "published",
-   "second_publish_status": 200,
+   "second_article_got_its_own_real_slug": false,
+   "second_article_status": "draft",
+   "second_publish_status": 500,
  }

 ❯ tests/e2e/publishCollisions.test.ts:353:8
    351|         second_row.slug !== first_row.slug,
    352|       second_article_status: second_row.status,
    353|     }).toEqual({
       |        ^
    354|       first_publish_status: 200,
    355|       second_publish_status: 200,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/8]⎯

 FAIL  tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes — a file the product refused was never embedded in the body, so it cannot leave behind a row that blocks publishing forever, exactly as for a rejected cover
AssertionError: expected { publish_status: 409, …(3) } to deeply equal { publish_status: 200, …(3) }

- Expected
+ Received

  Object {
    "article_status": "published",
-   "error_code": undefined,
-   "publish_status": 200,
-   "republished": true,
+   "error_code": "IMAGE_NOT_READY",
+   "publish_status": 409,
+   "republished": false,
  }

 ❯ tests/e2e/rejectedImageRecovery.test.ts:407:8
    405|       article_status: article.status,
    406|       republished: article.republished,
    407|     }).toEqual({
       |        ^
    408|       publish_status: 200,
    409|       error_code: undefined,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/8]⎯

 FAIL  tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > AC-08-recovery-05: a cover still converting when a second cover upload supersedes it, and which the Lambda only then reports as failed, does not block republication either — the outcome of an upload is decided after the slot was taken, so a guard read at the moment of the upload cannot see it
AssertionError: expected { second_cover: 'ready', …(5) } to deeply equal { second_cover: 'ready', …(5) }

- Expected
+ Received

  Object {
    "callback_status": 200,
-   "error_code": undefined,
-   "publish_status": 200,
-   "republished": true,
+   "error_code": "IMAGE_NOT_READY",
+   "publish_status": 409,
+   "republished": false,
    "second_cover": "ready",
    "slow_cover": "failed",
  }

 ❯ tests/e2e/rejectedImageRecovery.test.ts:459:8
    457|       error_code: code,
    458|       republished: article.republished,
    459|     }).toEqual({
       |        ^
    460|       second_cover: 'ready',
    461|       callback_status: 200,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/8]⎯

 FAIL  tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article — the readiness gate may not be decided by a column any writer can write
AssertionError: expected { publish_status: 200, …(2) } to deeply equal { publish_status: 409, …(2) }

- Expected
+ Received

  Object {
-   "article_status": "draft",
-   "error_code": "IMAGE_NOT_READY",
-   "publish_status": 409,
+   "article_status": "published",
+   "error_code": undefined,
+   "publish_status": 200,
  }

 ❯ tests/e2e/rejectedImageRecovery.test.ts:511:8
    509|       error_code: code,
    510|       article_status: article.status,
    511|     }).toEqual({
       |        ^
    512|       publish_status: 409,
    513|       error_code: 'IMAGE_NOT_READY',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/8]⎯
```

And the two controls, from the same run:

```
 ✓ tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > AC-08-recovery-06: a body image the article is genuinely still using — stored, referenced from its own body_html, and broken — does keep refusing the publish, 409 IMAGE_NOT_READY, so the two fixes above cannot be had by exempting body rows or failed rows wholesale
 ✓ tests/e2e/publishCollisions.test.ts > one idempotency key across two operations (verify v5, M-V5-04) > NFR-IDEM-03c: replaying the very same upload — same operation, same key, same article — still returns the original response and still creates nothing new, so scoping the key cannot be done by dropping replay altogether
```

### 2.1 What each failure proves is missing

| Id | Finding | Failure | What it proves |
|---|---|---|---|
| `AC-08-recovery-04` | M-V5-01 | after one rejected `body` upload, republishing the live article answers `409 IMAGE_NOT_READY` and `articles.published_at` never moves (`republished: false`) | `isRejectedAttempt()` excludes a `failed` row only when `image.role === 'cover'`. The rejected body row has `original_url: null` and `urls: null` — `uploadImage.ts` gives a synchronously rejected upload those on every path — so it was never embeddable in the body HTML, and green v5's stated rationale for the asymmetry does not apply to it. `authenticated` has no `delete` grant on `article_images` and no route removes a row, so this is permanent through the product, on the `body` slot exactly as v4 proved it on the `cover` slot. |
| `AC-08-recovery-05` | M-V5-02 | the second cover really converts (`second_cover: ready`), ADR-0004's real callback really lands (`callback_status: 200`, `slow_cover: failed`), and the republish is still refused `409 IMAGE_NOT_READY` | `demoteCurrentCover()`'s `status <> 'failed'` guard is evaluated when the second upload arrives, but the first upload's outcome is written later, by the Lambda callback. "Not yet failed" and "successfully ready" are different conditions, and the whole bug lives in that gap: the demoted row lands in exactly the state the guard exists to prevent. Every step runs through a product route — real multipart upload, real `POST /internal/images/{id}/status` with the real shared secret, real publish — because the finding *is* the ordering of those steps in time. |
| `AC-08-recovery-06` (passes) | M-V5-01/03 | — | The boundary the fix must not cross, restated for the `body` role: a `failed` body image that was genuinely adopted (`original_url` present) and is genuinely referenced from the article's own `body_html` keeps refusing the publish. Without it, the cheapest way to green `AC-08-recovery-04` is to exempt `body` rows — or `failed` rows — wholesale, which publishes articles with visibly broken images. |
| `NFR-IMAGE-ROLE-01` | M-V5-03 | after `update article_images set role = 'cover'` executed **as the `authenticated` role itself**, publish answers `200` and the draft goes live carrying a broken, embedded image | The regression green v5 introduced: `isRejectedAttempt()` keys on `role`, and `db/migrations/0001_initial_schema.sql`'s `grant update (role, alt_text) on article_images to authenticated` makes `role` the one column on that table any writer can write directly through PostgREST. Before v5, `role` had no bearing on publish-readiness. Run through real RLS with `set role authenticated`, the same technique `NFR-LOCK-GRANT-01a`/`01b` use, and asserting no SQLSTATE — so revoking the grant and ignoring `role` in the gate are equally admissible fixes. |
| `NFR-IDEM-03a` | M-V5-04 | the upload is answered `200` with **the publish's body** (no `role` field at all), and `image_rows_for_the_uploaded_file: 0` — the 4 MB file was accepted over the wire and silently discarded | `router.ts`'s `createIdempotencyStore()` keys on `${key}::${article_id}`: no `writer_id`, and no *operation*. The store is handed to both `publishDeps()` and `uploadDeps()`, so the two routes share one namespace. The row count is what makes a response-only fix insufficient: the harm is the file that never became an image. |
| `NFR-IDEM-03b` | M-V5-04 | the publish is answered `201` with the upload's body and `articles.status` is still `draft` | The same defect in the direction that matters most: a writer clicking "Publish" receives an apparently-successful 2xx while the article never goes live. Asserted from the database, never from the response — a fix that only changed what is returned would leave the article exactly as unpublished. The contract declares `Idempotency-Key` as an arbitrary opaque string, so no attack is needed: a retry helper that reuses one key across an editing session is enough. |
| `NFR-IDEM-03c` (passes) | M-V5-04 | — | The both-sides control: a genuine replay still returns the original response and still creates nothing new. `NFR-IDEM-01`/`NFR-IDEM-02` cannot police this — they inject their own fake store into the handlers, so deleting `router.ts`'s store entirely would leave both green while every retry re-ran a real mutation. |
| `AC-14-collision-01` | M-V5-05 | the second publish of an identically-titled article answers `500`, its `slug` stays `null` and its `status` stays `draft`; retrying does not help | `articles.slug` is `unique`; `publishArticle.ts` calls `generateSlug(article.title)` with no `existingSlugs` argument, so `seo.ts`'s dedup branch is dead code at the only call site that matters — `PROP-01`/`PROP-02` cannot see it, because they call the pure function directly with an array they construct themselves. The resulting Postgres `23505` is mapped nowhere and falls through to `route()`'s generic 500 handler. Directly contradicts AC-14's "collision-free slug, with no writer action", and `createDraft`'s own default title (`Sans titre`) means two untitled drafts collide immediately. |
| `NFR-CDN-CONFIG-01` | M-V3-04 | a callback carrying a URL on the deployment's **configured** origin is refused `400 VALIDATION_FAILED`, and the image row stays `processing` | `router.ts`'s `CDN_ORIGIN` is a compile-time constant on the IANA-reserved `.example` TLD, and `isCdnUrl` compares against it. Nothing under `src/` reads it from the environment, and unlike `jwtSecret`/`imageCallbackSecret`/`jwtIssuer` it is not threaded through `ServerOptions` → `startServer`'s spawn `env` → `serverMain.ts`. In a real deployment that means: every genuine Lambda callback `400`, every image `processing` forever, every publish `409 IMAGE_NOT_READY` — silently. Proved through the spawned child process, because `tests/e2e/deployedAuthBoundary.test.ts` exists precisely because this class of bug (an advertised option the spawn dropped) already shipped here once. |
| `NFR-CDN-CONFIG-02` | M-V3-04 | a callback carrying the shipped `.example` placeholder — a foreign origin under this configuration — is **accepted** `200` and its URL stored | The same single cause seen from the other side, and the guard against "fix it by accepting any URL": the check follows a constant rather than the deployment's configuration, so it accepts exactly the one origin no deployment can ever use. `NFR-CALLBACK-04a`/`04b` (verify v2's L2) cannot see this class: they configure nothing, so they validate the constant against itself. |

Nothing above is an import error, a missing fixture or a typo in the new tests.
Every failure is an assertion comparing a real observed value with the required
one, against real Postgres 16 (Testcontainers), real spawned child-process
servers over real HTTP, real multipart image bytes, ADR-0004's real status
callback carrying its real shared secret, and — for `NFR-IMAGE-ROLE-01` — a
direct write executed as the `authenticated` role through real RLS and real
column grants.

---

## 3. Why each test sits at the layer it does

- **M-V5-01/02/03 → end-to-end, real infrastructure.** All three findings live
  in the interaction between the upload handler, the asynchronous callback, the
  publish handler, the real `article_images` rows and the real grants. A
  handler-level test with a hand-built image list cannot express "and *then* the
  Lambda reported failure", and cannot express "a writer wrote this column
  directly" at all — which is exactly why six green gates and one green
  remediation missed them.
- **M-V5-04 → end-to-end, because the store has no other seam.**
  `createIdempotencyStore()` is a private closure inside `router.ts`, shared
  between the two handlers by the router and by nothing else. Every
  handler-level test injects its own fake store, so the collision is
  structurally invisible below this layer.
- **M-V5-05 → end-to-end, because the constraint is the test.** The bug is a
  real `unique` index rejecting a real UPDATE and the error not being mapped. A
  repository fake has no unique index; the existing pure-function properties
  (`PROP-01`/`PROP-02`) pass an `existingSlugs` array the real caller never
  passes, which is precisely how the dead branch stayed invisible.
- **M-V3-04 → through the spawned deployment boundary.** The finding is that
  configuration never reaches the process a deployment runs. An in-process
  `startHttpServer()` test taking an option would prove configurability while
  leaving the deployment path — the half that broke before, for `jwtSecret` —
  untested.
- **Three files, ten tests, three containers.** Findings that share a fixture
  shape share a file and a database: the M-V5-01/02/03 family in
  `rejectedImageRecovery.test.ts`, the two publish-time collisions in
  `publishCollisions.test.ts`, and the callback-origin pair as one two-row table
  in `cdnOriginConfig.test.ts`.

**Nothing prescribes an implementation.** Both verify agents converged on one
repair for the first family (key the exclusion on whether a row was ever
*adopted* — `original_url is null`, or slot supersession — rather than on
`role`, and narrow the demote guard to `status = 'ready'`). No assertion here
names any of it. In particular:

- `AC-08-recovery-05` deliberately does **not** assert that the slow cover was
  demoted, because the recommended fix stops demoting it; it asserts only that
  the callback landed, the row ended `failed`, and the article republishes.
- `NFR-IMAGE-ROLE-01` deliberately does **not** assert an SQLSTATE for the
  direct `role` write, so revoking the `update (role)` grant is as admissible as
  ignoring `role` in the gate.
- `NFR-IDEM-03a`/`03b` assert no key format.
- `AC-14-collision-01` asserts no slug format or suffix scheme — only that the
  second slug is real, distinct and live.
- `NFR-CDN-CONFIG-01`/`02` supply the origin **both** as a `startServer` option
  and as a `CDN_ORIGIN` environment variable (which `server.ts` already forwards
  wholesale to the child), so an option-threading fix and an
  environment-reading fix are equally admissible.

---

## 4. What this pass touched, and why none of it is an assertion change

| File | Change |
|---|---|
| `tests/e2e/rejectedImageRecovery.test.ts` | **New file.** `AC-08-recovery-04`/`05`/`06`, `NFR-IMAGE-ROLE-01`. Real spawned server (legacy static auth, exactly as `tests/e2e/publishJourney.test.ts` and `tests/e2e/coverReplacementRecovery.test.ts` use it and for the same stated reason — setup only), real Postgres, real multipart uploads, ADR-0004's real status callback, and one direct write executed as `authenticated`. |
| `tests/e2e/publishCollisions.test.ts` | **New file.** `NFR-IDEM-03a`/`03b`/`03c`, `AC-14-collision-01`. Real spawned server, real 4 MB JPEGs over the wire, world-state read from `articles`/`article_images` rather than from responses. |
| `tests/e2e/cdnOriginConfig.test.ts` | **New file.** `NFR-CDN-CONFIG-01`/`02`, one two-row table. Real spawned child process configured with a non-`.example` CDN origin. |
| `tests/support/seams.ts` | **Additive only**: `ApiServerModule.startServer` gained an **optional** `cdnOrigin`, declared exactly as `jwtSecret`/`imageCallbackSecret` are. Every existing caller is unchanged; no pre-existing test passes it. |
| `pdlc/arsene-cms/traceability.md` | New "Added by the sixth remediation pass (v6)" section, the header amendment paragraph the earlier passes' format implies, and the seam note above. |

No file in `src/` or `db/` was touched. No existing test's assertions were
edited. `state.json` untouched. Nothing committed — the working tree is left
unstaged for review.

---

## 5. Three observations recorded for the green pass (not tests, not blockers)

1. **`CDN_ORIGIN` also builds URLs, not just validates them.** `router.ts`'s
   `createObjectStore()` returns `${CDN_ORIGIN}/articles/${key}` as the stored
   asset's URL. Making the origin configurable should move that with it, or a
   deployment will validate against its real CDN while writing placeholder URLs
   into `article_images.optimized_url`. `NFR-CDN-CONFIG-01` asserts the stored
   URL is the one the callback supplied, so it covers the callback half; nothing
   here forces the object-store half, deliberately, because it is a different
   decision. Recorded so it is a decision rather than an oversight.
2. **The internal contract must move with M-V3-04.** `05-verification.v3.md`'s
   N2 already records that `contracts/internal-openapi.yaml` declares
   `optimized_url` as any `format: uri` while the implementation narrows it to
   one origin. Once the origin is configuration, a `pattern` anchored to a
   compile-time constant is no longer expressible — worth resolving in the same
   change, or `CONTRACT-PROVIDER-*` keeps flagging correct behaviour.
3. **A TTL is still missing from the idempotency store.** `NFR-IDEM-03a`/`03b`
   force an operation component into the key; nothing here forces the 24h/5min
   expiry windows the contract states (carried from v4's L-V4-01, and compounded
   by I-V5-02's unbounded key length). Not tested this pass because it was not
   in scope; noted so the green pass can close it in the same one-line change.

---

## 6. Gate statement

10 new tests, 8 failing on exactly one honest assertion each, against real
Postgres 16, three real spawned child-process servers over real HTTP, real
multipart image bytes, ADR-0004's real Lambda status callback and a direct
PostgREST-shaped write executed as the `authenticated` role through real RLS and
real column grants. 2 passing by design, as the both-sides controls that stop
the cheapest wrong fix to the two findings that have one. 206 previously-passing
tests still passing, `tsc --noEmit` clean. No production code written. Red.
