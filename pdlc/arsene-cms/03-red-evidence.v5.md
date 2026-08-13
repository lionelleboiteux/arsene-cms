# arsene-cms — Red gate, fifth remediation pass (v5)

> Gate 3 (red), run a fifth time. This document covers **only** the fifth
> remediation pass, for `05-verification.v4.md`'s two Medium findings:
> **M-V4-01** (recommended blocking — a truncated cover upload blanks a live
> article's cover and then permanently blocks republication) and **M-V4-02**
> (upload never checks the draft lock publish enforces). Tests only — no
> production code was written, changed or deleted by this pass, and no file
> under `src/` or `db/` was touched.
>
> Explicitly out of scope, per the verify report's own "recommended next cycle"
> ordering: L-V4-01 (unscoped idempotency store), L-V4-02 (`SUPABASE_JWT_ISSUER=""`),
> I-V4-01 through I-V4-04, and the whole v3 backlog carried in
> `05-verification.v4.md` §9 — including M-V3-04 (`CDN_ORIGIN`), which that
> report still names the item most likely to brick a real deployment.

**Status:** red | **Author:** Claude (Opus 5), written by `bob-test-author` |
**Date:** 2026-08-13 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `57b58bc`) | **Baseline:** the green suite as it
stands on this branch — **200 tests, 200 passing, 31 files**, re-run in full
before a line of this pass was written (see §1).

---

## 0. What this pass had to cover, and what it produced

| Verify v4 finding | Severity | Tests added | New ids |
|---|---|---|---|
| M-V4-01 — a truncated cover upload demotes the live cover before validating the new file, and leaves an undeletable `failed` row that blocks republication forever | Medium, recommended blocking | 3 | `AC-08-recovery-01`, `AC-08-recovery-02`, `AC-08-recovery-03` |
| M-V4-02 — `POST /v1/articles/{id}/images` never calls `evaluateLock`, so a writer refused `409 DRAFT_LOCKED` on publish walks in through upload | Medium | 3 | `NFR-UPLOAD-LOCK-01`, `NFR-UPLOAD-LOCK-02`, `NFR-UPLOAD-LOCK-03` |

3 + 3 = **6**.

**6 new tests. 4 fail, each on exactly one honest assertion reproducing the
exploit the verify pass proved by hand.** 2 pass, and are meant to — they are
the both-sides controls that stop the cheapest wrong fix:

- `AC-08-recovery-03`: an image the article is *genuinely still using* that
  failed to convert must keep refusing the publish. Without it, "stop counting
  `failed` rows at publish" would turn `AC-08-recovery-02` green and delete
  AC-08's actual promise.
- `NFR-UPLOAD-LOCK-02`: a lock abandoned 102 seconds ago is stale and the
  upload must still succeed. Without it, a hand-rolled `locked_by !== me` check
  would turn `NFR-UPLOAD-LOCK-01` green and break AC-05's takeover-with-no-
  admin-unlock for uploads.

**All 200 previously-passing tests still pass**, and no existing test's
assertions were edited.

Test count: 200 → **206**. Test files: 31 → **33**.

---

## 1. The commands, and their output

### 1.1 Baseline, before anything was written

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  31 passed (31)
      Tests  200 passed (200)
   Start at  15:17:15
   Duration  23.35s (transform 793ms, setup 0ms, collect 7.76s, tests 96.56s, environment 5ms, prepare 1.98s)
```

200/200, matching `05-verification.v4.md` §1 exactly. `NFR-IMGCPU-01` (the
known wall-clock flake) did not fire.

### 1.2 The full suite, with the six new tests in place

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  3 failed | 30 passed (33)
      Tests  4 failed | 202 passed (206)
   Start at  18:07:32
   Duration  25.73s (transform 946ms, setup 0ms, collect 8.32s, tests 112.55s, environment 10ms, prepare 2.18s)
```

206 = the 200 green-gate tests + 6 new. 202 passing = 200 baseline + the 2 new
controls above, so nothing regressed. The 3 failing files are
`tests/e2e/coverReplacementRecovery.test.ts` (new),
`tests/unit/uploadImageLock.test.ts` (new) and
`tests/contract/consumer.prism.test.ts` (pre-existing file, one new
table-driven case appended — every other case in it still passes).

```
$ npx tsc --noEmit
TSC_EXIT=0
```

`NFR-IMGCPU-01` passed in this run too, so the known flake did not need
isolating this pass:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo …
```

---

## 2. Every new test, with its result and its one reason for failing

Verbatim, from the run in §1.2 — not summarised, not re-typed:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / NFR-UPLOAD-LOCK-03: the client surfaces DRAFT_LOCKED as a branchable code, so a writer whose colleague is mid-edit is told who holds the draft, instead of the upload silently replacing their cover
AssertionError: expected 'INTERNAL_ERROR' to be 'DRAFT_LOCKED' // Object.is equality

Expected: "DRAFT_LOCKED"
Received: "INTERNAL_ERROR"

 ❯ tests/contract/consumer.prism.test.ts:191:18
    189|       .catch((err: { code?: string }) => err.code);
    190| 
    191|     expect(code).toBe(expectedCode);
       |                  ^
    192|   });
    193| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  tests/e2e/coverReplacementRecovery.test.ts > recovering from a rejected cover upload (verify v4, M-V4-01) > AC-08-recovery-01: a truncated file uploaded as a new cover leaves the article’s existing ready cover exactly where it was, and the live page still shows it — a file that was never good enough to publish is never good enough to displace the one that is
AssertionError: expected { live_cover_role: 'body', …(2) } to deeply equal { live_cover_role: 'cover', …(2) }

- Expected
+ Received

  Object {
-   "live_cover_role": "cover",
+   "live_cover_role": "body",
    "live_cover_status": "ready",
-   "live_page_still_shows_that_cover": true,
+   "live_page_still_shows_that_cover": false,
  }

 ❯ tests/e2e/coverReplacementRecovery.test.ts:234:8
    232|       live_cover_status: after.rows[0]?.status,
    233|       live_page_still_shows_that_cover: html.includes(coverUrl),
    234|     }).toEqual({
       |        ^
    235|       live_cover_role: 'cover',
    236|       live_cover_status: 'ready',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  tests/e2e/coverReplacementRecovery.test.ts > recovering from a rejected cover upload (verify v4, M-V4-01) > AC-08-recovery-02: after a truncated cover upload is rejected, the article still republishes — a file the product refused cannot leave behind a row that blocks publishing forever, since no writer can delete one
AssertionError: expected { publish_status: 409, …(2) } to deeply equal { publish_status: 200, …(2) }

- Expected
+ Received

  Object {
    "article_status": "published",
-   "error_code": undefined,
-   "publish_status": 200,
+   "error_code": "IMAGE_NOT_READY",
+   "publish_status": 409,
  }

 ❯ tests/e2e/coverReplacementRecovery.test.ts:256:8
    254|       error_code: body.error?.code,
    255|       article_status: article.rows[0]?.status,
    256|     }).toEqual({ publish_status: 200, error_code: undefined, article_s…
       |        ^
    257|   });
    258| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  tests/unit/uploadImageLock.test.ts > image upload and the draft lock (verify v4, M-V4-02) > NFR-UPLOAD-LOCK-01: uploading a cover to a draft another writer is actively holding the edit lock on (12 s old, well inside the staleness window) is refused 409 DRAFT_LOCKED with nothing written — the same refusal publish already gives, so a writer turned away there cannot replace the same colleague’s cover through here
AssertionError: expected { status: 201, code: undefined, …(2) } to deeply equal { status: 409, …(3) }

- Expected
+ Received

  Object {
-   "code": "DRAFT_LOCKED",
-   "locked_by_writer_id": "e5e5e5e5-0000-4a2b-9c3d-eeeeeeeeeeee",
-   "rows_created": 0,
-   "status": 409,
+   "code": undefined,
+   "locked_by_writer_id": undefined,
+   "rows_created": 1,
+   "status": 201,
  }

 ❯ tests/unit/uploadImageLock.test.ts:110:10
    108|         locked_by_writer_id: (res.body as any)?.error?.details?.locked…
    109|         rows_created: inserted.length,
    110|       }).toEqual({
       |          ^
    111|         status: c.status,
    112|         code: c.code,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
```

And the two controls, from the same run:

```
 ✓ tests/e2e/coverReplacementRecovery.test.ts > … > AC-08-recovery-03: an image the article is genuinely still using and that failed to convert does keep refusing the publish, 409 IMAGE_NOT_READY …
 ✓ tests/unit/uploadImageLock.test.ts > … > NFR-UPLOAD-LOCK-02: uploading a cover to a draft another writer left locked 102 seconds ago …
```

### 2.1 What each failure proves is missing

| Id | Finding | Failure | What it proves |
|---|---|---|---|
| `AC-08-recovery-01` | M-V4-01 | the live article's `ready` cover row is now `role: body`, and the real render pass no longer emits its URL anywhere on the live page (`live_page_still_shows_that_cover: false`) | `demoteCurrentCover()` runs before `isDamagedContainer()`, so a file the product itself is about to reject has already cost the writer the working cover. Both halves are read from the world after the request — the `article_images` row through real Postgres, the page through `createSiteRenderer`'s real SQL and HTML — never from the upload response, which is why a fix that merely changes the response cannot pass. |
| `AC-08-recovery-02` | M-V4-01 | republishing the same already-live article answers `409 IMAGE_NOT_READY` | The stale `failed` row is counted by `publishArticle.ts`'s readiness gate (`images.find(image => image.status !== 'ready')`), which considers every image on the article. Since `authenticated` has no `delete` grant on `article_images` (`db/migrations/0001_initial_schema.sql` grants `select` + `update (role, alt_text)` only) and no route deletes an image row, this is permanent through the product: AC-08's "replace it and publish will let you through" is provably false. |
| `AC-08-recovery-03` (passes) | M-V4-01 | — | The boundary the fix must not cross: a `failed` image the article is genuinely still using keeps refusing the publish. Asserted over real HTTP and real Postgres precisely because the unit-level `AC-08b` in `tests/unit/publishArticle.test.ts` hands the handler a literal image list — a repository-level fix that filtered `failed` rows out of `getArticleImages` would leave `AC-08b` green and the product silently publishing broken images. |
| `NFR-UPLOAD-LOCK-01` | M-V4-02 | the upload answers `201`, with no `DRAFT_LOCKED`, and **an image row was created** (`rows_created: 1`) against a draft another writer has held for 12 seconds | `uploadImage.ts` never calls `evaluateLock`, unlike `publishArticle.ts`. The `rows_created` field is what makes a status-only fix insufficient: a `409` returned after `insertImage` had already run would have replaced the colleague's cover anyway. |
| `NFR-UPLOAD-LOCK-02` (passes) | M-V4-02 | — | The both-sides control: 102 seconds is past `LOCK_STALENESS_MS` (90 s), so the lock is stale and AC-05's takeover-with-no-admin-unlock applies to uploads as much as to publish. A fix that refuses whenever `locked_by !== me` would break this. |
| `NFR-UPLOAD-LOCK-03` | M-V4-02 | Prism, generated from `contracts/openapi.yaml` at run time, cannot serve a `409 DRAFT_LOCKED` for `uploadArticleImage` — it falls through and the client surfaces `INTERNAL_ERROR` | The consumer half of the same refusal. `uploadArticleImage` declares `201/400/401/404/413/422/default` and no `409` at all, so the branch the editor must render does not exist in the contract. This binds the green pass to add the same `DRAFT_LOCKED` response `publishArticle` and `openDraft` already carry — a server that answers `409` while the contract stays silent is only half the fix. |

Nothing above is an import error, a missing fixture or a typo in the new tests.
Every failure is an assertion comparing a real observed value with the required
one, against real Postgres 16 (Testcontainers), a real spawned child-process
server over real HTTP with real multipart image bytes, the real public render
pass, and — for `NFR-UPLOAD-LOCK-03` — a real Prism mock generated from the
contract document itself.

---

## 3. Why each test sits at the layer it does

- **M-V4-01 → end-to-end, real infrastructure.** This is the whole reason six
  green gates missed it: every committed upload test aims a corrupt file at a
  *fresh draft* with fakes underneath, where there is no live cover to lose and
  no publish afterwards. The finding only exists in the interaction between the
  upload handler, the publish handler, the real `article_images` rows and the
  real grants — so it is asserted there, exactly as the verify pass proved it.
- **M-V4-02 → the handler, with fakes.** The whole mechanism is one
  `evaluateLock` call over `article.locked_by`/`locked_at`, and `repo.getArticle`
  already selects both columns for every route (`ARTICLE_SQL`), so the handler
  is the fastest layer that can prove it — the same layer and the same fixture
  shape as the `AC-05` refusal `publishArticle` is already held to. One
  table-driven test with two lock states, not two hand-written tests.
- **The contract, once.** `NFR-UPLOAD-LOCK-03` is a single appended row in the
  existing `ERROR_CASES` table, not a new file.

**Nothing prescribes an implementation.** The verify report names three
plausible repairs for M-V4-01 (reorder demote-then-validate; scope publish's
readiness check; grant a scoped `delete` plus a route). No assertion here names
any of them — `AC-08-recovery-01`/`02` deliberately do **not** assert the upload
response's status or body, so a fix that refuses the file `422` outright and one
that still creates a `failed` row are equally admissible. What is asserted is
the only part a writer or a visitor can see.

---

## 4. What this pass touched, and why none of it is an assertion change

| File | Change |
|---|---|
| `tests/e2e/coverReplacementRecovery.test.ts` | **New file.** `AC-08-recovery-01`/`02`/`03`. Real spawned server (`startServer`, legacy static auth as `tests/e2e/publishJourney.test.ts` uses it and for the same stated reason — setup only, authorization is not what any assertion here is about), real Postgres, real `createSiteRenderer`. |
| `tests/unit/uploadImageLock.test.ts` | **New file.** `NFR-UPLOAD-LOCK-01`/`02`, one table-driven case each. |
| `tests/contract/consumer.prism.test.ts` | **One appended `ERROR_CASES` row** (`NFR-UPLOAD-LOCK-03`). The table's shared assertion is untouched; every pre-existing case in the file still passes. |
| `tests/support/fakes.ts` | **Additive only**: `buildUploadDeps`' repo fake gained `getWriterDisplayName` and the overrides gained `display_name`, so a fix mirroring `publishArticle.ts`'s `DRAFT_LOCKED` envelope (which names the lock holder) runs against the fake instead of tripping over a missing collaborator. No pre-existing test calls it; all nine existing `uploadImage` tests pass unchanged. |
| `tests/support/seams.ts` | **Additive only**: `UploadDeps.repo` gained an **optional** `getWriterDisplayName`, matching the fake above. Optional, so a fix that builds the envelope from `article.locked_by` alone is equally admissible. |
| `pdlc/arsene-cms/traceability.md` | New "Added by the fifth remediation pass (v5)" section, the two amendment paragraphs the v3 header note's format implies (v4's was never written; it is added here for completeness), and the `uploadArticleImage` consumer-branch cell updated with `DRAFT_LOCKED`. |

No file in `src/` or `db/` was touched. No existing test's assertions were
edited. `state.json` untouched. Nothing committed — the working tree is left
unstaged for review.

---

## 5. Two observations recorded for the green pass (not tests, not blockers)

1. **The contract must move for M-V4-02.** `uploadArticleImage` declares no
   `409`. `NFR-UPLOAD-LOCK-03` fails on exactly that today; the fix is the same
   `DRAFT_LOCKED` response body `publish` and `open` already declare, added to
   `contracts/openapi.yaml`. Worth doing in the same change as the handler, or
   `CONTRACT-PROVIDER-uploadArticleImage` will be validating a `409` against the
   `default` `UnexpectedError` catch-all rather than against a real declaration.
2. **The absent `delete` capability is still absent after any fix that passes
   these tests.** `AC-08-recovery-02` can be satisfied by scoping publish's
   readiness check, which leaves the orphaned `failed` rows in the table
   forever — harmless for publication, but they accumulate, and no writer can
   remove one. That is the verify report's third fix option, and it is
   deliberately *not* forced here (it would prescribe an implementation).
   Recorded so it is a decision rather than an oversight.

---

## 6. Gate statement

6 new tests, 4 failing on exactly one honest assertion each, against real
Postgres 16, a real spawned child-process server over real HTTP, the real
public render pass and a real Prism mock generated from the contract. 2 passing
by design, as the both-sides controls that stop the cheapest wrong fix to each
finding. 200 previously-passing tests still passing, `tsc --noEmit` clean. No
production code written. Red.
