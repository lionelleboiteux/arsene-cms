# arsene-cms — Red gate, eighth remediation pass (v8)

> Gate 3 (red), run an eighth time. This document covers **only** the eighth
> remediation pass, for `05-verification.v7.md`'s two blocking findings — **§4**
> (an article can become permanently unpublishable with no recovery, by two
> independent routes both verify agents found separately) and **M-V7-02** (a live
> article's public cover goes blank during any cover replacement) — plus
> **L-V7-01** (no uniqueness constraint on the cover slot), bundled in on the
> verify report's own recommendation because it shares §4.2's root cause and §10
> lists it as "likely worth taking together".
> Tests only — no production code was written, changed or deleted by this pass,
> and no file under `src/` or `db/` was touched.
>
> Explicitly out of scope, per the product owner's scoping: L-V7-02
> (`articles.updated_at` writer-forgeable), I-V7-01 (the `status='ready' ⇒
> optimized_url` `CHECK` constraint — both verify agents confirmed no exploit path
> exists today), I-V7-02, I-V7-03 (workspace hygiene / `.gitignore`), and the
> standing v3/v5/v6 backlog (L-V6-01 `CDN_ORIGIN` validation, L-V6-02, L-V6-03,
> N5/N5b, N2, the idempotency-store TTL and `writer_id` scoping).

**Status:** red | **Author:** Claude (Opus 5), written by `bob-test-author` |
**Date:** 2026-08-19 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `cae887b`) | **Baseline:** the green suite as it
stands on this branch — **221 tests, 221 passing, 37 files**, re-run in full
before a line of this pass was written (see §1.1).

---

## 0. What this pass had to cover, and what it produced

| Finding | Severity | Tests added | New ids |
|---|---|---|---|
| §4 — an article can become **permanently unpublishable with no recovery**, via two independent routes: an ordinary conversion failure (§4.1, security auditor) and a deterministic upload race needing nothing but concurrent use (§4.2, e2e agent). Both terminate in the identical state and share one fix, so the verify report records them as one finding | Medium, blocking | 3 + 1 control | `AC-08-recovery-09`, `AC-08-recovery-10`, `NFR-RECOVERY-INVARIANT-01`, `AC-08-recovery-11` |
| M-V7-02 — a live article's public cover image goes blank: transiently during any ordinary cover replacement, permanently if that replacement's conversion fails | Medium | 1 | `NFR-COVER-FALLBACK-01` |
| L-V7-01 — AC-06's "one cover per article" is unenforced at the data layer; six simultaneous `ready` cover rows reproduced on one article | Low (bundled by §10 rec. 3) | 1 | `NFR-COVER-UNIQUE-01` |

3 + 1 + 1 + 1 = **6**.

**6 new tests. 5 fail, each on exactly one honest assertion reproducing the
trace the verify pass proved by hand.** 1 passes, and is meant to — it is the
both-sides control that stops the new capability becoming the next finding:

- `AC-08-recovery-11`: the recovery capability must **not** be usable to discard
  an image the article genuinely depends on (its live `ready` cover, or a `ready`
  body image embedded in its own `body_html`). Without it, the cheapest way to
  turn the other four green is a delete route with no server-side restriction —
  which reopens AC-08 in a new shape, letting a writer delete their way around
  `IMAGE_NOT_READY` by closing an inconvenient-but-genuinely-needed image. It
  passes today vacuously, since there is nothing to abuse yet; its job is to
  still pass afterwards, and it is stated as an outcome (the rows survive and the
  article still publishes `200` with its real cover URL) so it fails loudly
  against a route that removes them.

**All 221 previously-passing tests still pass**, and no existing test's
assertions were edited.

Test count: 221 → **227**. Test files: 37 → **40**.

---

## 1. The commands, and their output

### 1.1 Baseline, before anything was written

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  37 passed (37)
      Tests  221 passed (221)
   Start at  09:12:10
   Duration  37.09s (transform 1.23s, setup 0ms, collect 11.90s, tests 180.47s, environment 9ms, prepare 2.64s)
```

221/221, matching `05-verification.v7.md` §1 and `04-green-evidence.v7.md`
exactly. `NFR-IMGCPU-01` — the wall-clock-budget flake documented at every prior
pass — did not fire (221 of 221 passing leaves nothing that could have), so the
single confirming re-run the brief allows for was not needed.

### 1.2 The full suite, with the six new tests in place

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  4 failed | 36 passed (40)
      Tests  5 failed | 222 passed (227)
   Start at  00:03:42
   Duration  44.17s (transform 2.45s, setup 0ms, collect 19.36s, tests 224.73s, environment 7ms, prepare 3.27s)
```

227 = the 221 green-gate tests + 6 new. 222 passing = 221 baseline + the 1 new
control above, so nothing regressed. The 4 failing files are
`tests/e2e/imageRecoveryRoutes.test.ts` (new),
`tests/e2e/publishRecoveryInvariant.test.ts` (new),
`tests/db/coverRenderFallback.test.ts` (new) and `tests/db/schema.test.ts`
(pre-existing, and **only** its one new test fails — all 18 of its existing tests
still pass, quoted in §2.2).

```
$ npx tsc --noEmit
TSC_EXIT=0
```

`NFR-IMGCPU-01` passed in this run too:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 822ms
```

### 1.3 The concurrency route, run four times, to rule out a lucky race

`AC-08-recovery-10` builds §4.2's state from **real concurrent HTTP requests**,
so its redness could in principle depend on an interleaving. It does not: a burst
that serialised completely would leave exactly one adopted, failed cover row,
which an ordinary replacement upload's demote *does* supersede — so the test
would pass. It failed on all four independent runs, which is the same
reproduction rate (`8/8 trials`) the verify report reports for the underlying
race:

```
$ for i in 1 2 3; do NO_COLOR=1 FORCE_COLOR=0 npx vitest run tests/e2e/imageRecoveryRoutes.test.ts; done
```

```
run1:  × … AC-08-recovery-10: after concurrent cover uploads to the same article … 308ms
run1:       Tests  2 failed | 1 passed (3)
run2:  × … AC-08-recovery-10: after concurrent cover uploads to the same article … 309ms
run2:       Tests  2 failed | 1 passed (3)
run3:  × … AC-08-recovery-10: after concurrent cover uploads to the same article … 317ms
run3:       Tests  2 failed | 1 passed (3)
```

(plus the first run in §1.2's file-scoped execution, which failed identically at
338ms.)

---

## 2. Every new test, with its result and its one reason for failing

### 2.1 The five failures

Verbatim, from the run in §1.2 — not summarised, not re-typed:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/db/coverRenderFallback.test.ts > a live article keeps the cover it was published with (verify v7, §5) > NFR-COVER-FALLBACK-01: while a live article’s cover replacement is still converting, and after that replacement has failed for good, its public page still serves the cover the article was actually published with — a replacement that has not converted yet is not a reason to blank a page that is already correct, and a replacement that never will is not a reason to blank it forever
AssertionError: expected [ { …(5) }, { …(5) } ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "homepage_card_img": null,
+     "json_ld_image": "",
+     "og_image": "",
+     "stage": "T1 replacement accepted, still converting",
+     "violates": "the live page lost the cover it was published with",
+   },
+   Object {
+     "homepage_card_img": null,
+     "json_ld_image": "",
+     "og_image": "",
+     "stage": "T2 replacement failed, permanently",
+     "violates": "the live page lost the cover it was published with",
+   },
+ ]

 ❯ tests/db/coverRenderFallback.test.ts:238:24
    236|     );
    237| 
    238|     expect(violations).toEqual([]);
       |                        ^
    239|   });
    240| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯

 FAIL  tests/db/schema.test.ts > cover slot uniqueness (verify v7, L-V7-01) > NFR-COVER-UNIQUE-01: the database itself refuses a second role=cover row for an article that already has one, whether it arrives as a fresh insert or as the promotion of an existing body row — AC-06 is a data-layer invariant, and a non-transactional demote-then-insert in one handler has already been shown to leave six simultaneous cover rows on one article
AssertionError: expected [ { …(3) }, { …(3) } ] to deeply equal [ { …(3) }, { …(3) } ]

- Expected
+ Received

  Array [
    Object {
      "attempt": "inserting a second cover row directly",
-     "cover_rows_after": 1,
-     "refused_by_the_database": true,
+     "cover_rows_after": 2,
+     "refused_by_the_database": false,
    },
    Object {
      "attempt": "promoting an existing body row into the cover slot",
-     "cover_rows_after": 1,
-     "refused_by_the_database": true,
+     "cover_rows_after": 2,
+     "refused_by_the_database": false,
    },
  ]

 ❯ tests/db/schema.test.ts:576:21
    574|     }
    575| 
    576|     expect(results).toEqual([
       |                     ^
    577|       {
    578|         attempt: 'inserting a second cover row directly',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/5]⎯

 FAIL  tests/e2e/imageRecoveryRoutes.test.ts > a permanently unpublishable article always has a way back (verify v7, §4) > AC-08-recovery-09: an adopted image whose conversion failed permanently can be discarded by the writer, and the article then publishes again carrying its real remaining cover — closing an image the product itself accepted and could not convert is the one recovery migration 0004 removed, and without it an ordinary codec failure ends the article forever
AssertionError: expected { …(7) } to deeply equal { …(7) }

- Expected
+ Received

  Object {
-   "article_status": "published",
-   "cover_image_after": "https://cdn.example/route-a/couverture-valide.webp",
-   "publish_after_the_discard": "200",
+   "article_status": "draft",
+   "cover_image_after": undefined,
+   "publish_after_the_discard": "409 IMAGE_NOT_READY",
    "publish_before_the_discard": "409 IMAGE_NOT_READY",
    "the_broken_row_settled_at": "failed",
    "the_broken_row_was_adopted": true,
-   "the_discard_was_answered_by": "a product route",
+   "the_discard_was_answered_by": "no route at all",
  }

 ❯ tests/e2e/imageRecoveryRoutes.test.ts:414:8
    412|       cover_image_after: after.cover_image,
    413|       article_status: await articleStatus(db, fx.route_a_article),
    414|     }).toEqual({
       |        ^
    415|       the_broken_row_was_adopted: true,
    416|       the_broken_row_settled_at: 'failed',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/5]⎯

 FAIL  tests/e2e/imageRecoveryRoutes.test.ts > a permanently unpublishable article always has a way back (verify v7, §4) > AC-08-recovery-10: after concurrent cover uploads to the same article, the writer can still resolve the article down to one usable cover and publish it — a double-click, a second browser tab or a retried request must not be able to end an article permanently, and today the demote that tidies up records only one of the rows it displaced as superseded
AssertionError: expected { …(7) } to deeply equal { …(7) }

- Expected
+ Received

  Object {
-   "article_status": "published",
-   "cover_image_after_is_real": true,
+   "article_status": "draft",
+   "cover_image_after_is_real": false,
    "cover_shaped_rows_left_by_the_burst": true,
    "every_uploaded_row_settled": true,
-   "publish_after_the_recovery": "200",
+   "publish_after_the_recovery": "409 IMAGE_NOT_READY",
    "publish_before_the_recovery": "409 IMAGE_NOT_READY",
    "replacement_cover": "ready",
  }

 ❯ tests/e2e/imageRecoveryRoutes.test.ts:490:8
    488|       cover_image_after_is_real: (after.cover_image ?? '') !== '',
    489|       article_status: await articleStatus(db, fx.route_b_article),
    490|     }).toEqual({
       |        ^
    491|       cover_shaped_rows_left_by_the_burst: true,
    492|       every_uploaded_row_settled: true,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/5]⎯

 FAIL  tests/e2e/publishRecoveryInvariant.test.ts > every reachable article state has a way back to publishable (verify v7, §4) > NFR-RECOVERY-INVARIANT-01: any article state reachable through product routes alone has some sequence of product routes that returns it to publishable — the property itself, swept over four genuinely different ways an article ends up unpublishable, rather than a fourth consecutive fix aimed at the one state that happened to get reported
AssertionError: expected [ { …(5) }, { …(5) } ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "cover_image_after_recovery": "",
+     "publish_after_recovery": 409,
+     "publish_before_recovery": "409 IMAGE_NOT_READY",
+     "state": "adopted-body-failed",
+     "violates": "no sequence of product routes returned it to publishable",
+   },
+   Object {
+     "cover_image_after_recovery": "",
+     "publish_after_recovery": 409,
+     "publish_before_recovery": "409 IMAGE_NOT_READY",
+     "state": "adopted-body-and-cover-both-failed",
+     "violates": "no sequence of product routes returned it to publishable",
+   },
+ ]

 ❯ tests/e2e/publishRecoveryInvariant.test.ts:376:24
    374|     });
    375| 
    376|     expect(violations).toEqual([]);
       |                        ^
    377|   });
```

### 2.2 The control, and the pre-existing tests in the file this pass extended

From the same run — the new control, the four v7 tests whose territory this pass
extends, and the neighbouring schema tests in the one pre-existing file touched:

```
 ✓ tests/e2e/imageRecoveryRoutes.test.ts > a permanently unpublishable article always has a way back (verify v7, §4) > AC-08-recovery-11: the recovery capability cannot be used to discard an image the article genuinely depends on — neither its live ready cover nor a ready body image embedded in its own body_html is removable, so a writer cannot delete their way around IMAGE_NOT_READY by closing an inconvenient-but-needed image, which would reopen AC-08 in a new shape
 ✓ tests/e2e/coverImageInvariant.test.ts > … > AC-08-recovery-07: an article whose only cover-role image is a rejected upload is still refused at publish and stays a draft … 304ms
 ✓ tests/e2e/coverImageInvariant.test.ts > … > NFR-COVER-INVARIANT-01: across every combination of image states, a publish answered 200 always carries a non-empty cover image … 594ms
 ✓ tests/e2e/coverImageInvariant.test.ts > … > NFR-COVER-INVARIANT-02: an article whose cover is genuinely ready still publishes 200 and its page really carries that cover’s CDN URL …
 ✓ tests/e2e/coverImageInvariant.test.ts > … > AC-08-recovery-08: an already-live article that publish is correctly refusing COVER_IMAGE_REQUIRED is not pushed live again by uploading a broken replacement cover …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-05: a cover still converting when a second cover upload supersedes it, and which the Lambda only then reports as failed, does not block republication either … 862ms
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-06: a body image the article is genuinely still using — stored, referenced from its own body_html, and broken — does keep refusing the publish, 409 IMAGE_NOT_READY …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > NFR-IMAGE-ROLE-02: a writer who vacates the cover slot and moves a broken, genuinely-used body image into it before uploading a replacement cover still cannot publish … 526ms
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-TAMPER-01: a writer cannot set published_at directly …
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01a: a writer cannot take the draft lock through PostgREST — stealing a colleague’s live lock by writing locked_by directly is refused …
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01b: a writer cannot take the draft lock through PostgREST — keeping a colleague’s abandoned lock alive forever by refreshing locked_at directly is refused …
 ✓ tests/db/schema.test.ts > migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only
```

`NFR-COVER-UNIQUE-01` seeds its own two articles and its own writer, and shares
no row, article or fixture with any of `schema.test.ts`'s 18 existing tests,
which is why they are all still green. The two new e2e files each run their own
Testcontainers Postgres and their own spawned server, so neither touches the
other's rate-limit budget or fixtures.

### 2.3 What each failure proves is missing

| Id | Finding | Failure | What it proves |
|---|---|---|---|
| `AC-08-recovery-09` | §4.1 | the row is confirmed **adopted** (`the_broken_row_was_adopted: true`) and **permanently failed** (`settled_at: "failed"`), publish correctly refuses `409 IMAGE_NOT_READY` before *and after* every discard shape is tried, `the_discard_was_answered_by: "no route at all"`, and the article stays a `draft` with no cover in its response | The security auditor's route, end to end through product routes only, with nothing seeded. `undecodableJpeg()` carries a complete container (SOI + APP0 + a real EOI), so `sniffImageFormat()` returns `jpeg`, `isDamagedContainer()` returns `false`, and `uploadImage.ts` **adopts** it: the original really is stored and `original_url` really is written. The real ADR-0004 conversion (`optimizeImageBuffer` → `sharp`, off the request path) then fails it through the real compare-and-swap. `articleDependsOn()` correctly keeps treating that row as in use, so it blocks forever — and `0004` removed the last of the eight recovery actions the verify pass tried live. The article's cover is genuinely `ready` throughout, so the `409` is about the broken row and nothing else. |
| `AC-08-recovery-10` | §4.2 | four **real concurrent** cover uploads leave cover-shaped rows that all settle `failed`; publish refuses `409 IMAGE_NOT_READY`; every not-`ready` row is then discarded through every candidate route shape and a genuinely `ready` replacement cover is uploaded (`replacement_cover: "ready"`) — and publish **still** refuses `409 IMAGE_NOT_READY`, with the article still a `draft` | The e2e agent's route: no attacker, no external failure, nothing but ordinary concurrent use. `demoteCurrentCover()` → `storage.put()` → `insertImage()` is not one transaction, so each concurrent upload demotes (matching nothing) and inserts its own `role='cover'` row; the later demote turns them all into `body` rows while `returning id`/`res.rows[0]` records only **one** as superseded, leaving the rest adopted, unsuperseded and permanently blocking. Proven not to be a lucky interleaving by §1.3's four runs — a fully serialised burst would have made this test pass. How many rows the burst leaves is recorded as an observation and **never asserted**, so L-V7-01's partial unique index satisfies this test too. |
| `NFR-RECOVERY-INVARIANT-01` | §4, §10 rec. 1 | **two of four** swept states have no sequence of product routes back to publishable — `adopted-body-failed` (§4.1 exactly) and `adopted-body-and-cover-both-failed` (a state nobody reported) — each still `409 IMAGE_NOT_READY` after the same generic recovery procedure that returns the other two to `200` | The property `05-verification.v7.md` §10 asked for in preference to another enumeration, stated once: *any article state reachable through product routes alone must have some sequence of product routes that returns it to publishable*. The two states it does **not** flag are the both-sides half and are in the sweep on purpose — a "fix" that refuses more publishes, or that discards rows the article genuinely needs, breaks them. The fourth state was generated by varying the *other* rows rather than by being reported, because `articleDependsOn(image, images)` takes the whole image list and what else is present is exactly what decides the outcome. This is the shape that answers three consecutive passes (M-V4-01 → M-V5-01/02/03 → M-V6-02 → §4) each fixing a reported state rather than the property. |
| `NFR-COVER-FALLBACK-01` | M-V7-02 | at **T1** (replacement accepted, still converting) and again at **T2** (replacement failed, terminal) the live page serves `og:image ""`, schema.org `image: [""]` and **no `<img>` at all** on the homepage card, while the article's persisted `structured_data.image` still names the cover it was published with. **T0 is not flagged** | H-V6-01's exact public symptom through a code path `usableCover()` does not govern — which is why closing H-V6-01 in `publishArticle.ts` did not close this. `render.ts`'s live query (`role='cover' and status='ready' limit 1`) plus `uploadImage.ts`'s demote-before-conversion means every ordinary replacement blanks an already-correct page transiently, and a replacement that never converts blanks it permanently, before the writer gets the `409` that tells them anything is wrong. T0 sitting unflagged in the same list is the assertion's own proof that "render nothing anywhere" is not a fix. |
| `NFR-COVER-UNIQUE-01` | L-V7-01 | both attempts succeed — a direct second `insert` and the `update` promotion of a body row — leaving `cover_rows_after: 2` in each case, with `refused_by_the_database: false` | AC-06's "one cover per article" is enforced nowhere but in one handler's non-atomic sequence. Green v7 §6.3's claim that at most one row can satisfy the cover predicate is false: the e2e agent produced six simultaneous `ready` cover rows on one article through concurrent uploads alone. Executed on the **owning** connection with no `set role`, so the absence of a refusal cannot be confused with a grant question — and `service_role`, which is what the upload route actually runs as, bypasses RLS and holds every grant, so only a constraint could ever refuse this. Both shapes are asserted because a constraint catching only one of them leaves AC-06 exactly as unenforced as it is today. |
| `AC-08-recovery-11` (passes) | §4.3 | — | The boundary the fix must not cross. A discard route restricted server-side to `status <> 'ready'` cannot be abused, because a not-ready row is by definition not something the article can currently be published with; a route *without* that restriction reopens AC-08 in a new shape. Asserted as an outcome — the live `ready` cover and the `ready`, `body_html`-embedded body image both survive, the article still has a usable cover, and it still publishes `200` carrying that cover's real CDN URL — so it fails loudly against a route that removes them, whatever status code that route returns. |

Nothing above is an import error, a missing fixture or a typo in the new tests.
Every failure is an assertion comparing a real observed value with the required
one, against real Postgres 16 (Testcontainers) with the production migrations,
real spawned child-process servers over real HTTP, real multipart JPEG bytes
through the real upload route, real concurrent HTTP requests, the real ADR-0004
conversion carried to a real `failed` status through the real compare-and-swap,
and the real public render pass.

---

## 3. Why each test sits at the layer it does, and what none of them prescribe

- **§4 → end-to-end, real infrastructure, nothing seeded into the state under
  test.** Both routes are about what the *upload route itself* writes meeting
  what the *publish handler* decides, over time. The unit-level publish tests
  (`tests/unit/publishArticle.test.ts`, `publishRemediation.test.ts`) feed the
  handler a hand-built `ImageRecord[]`, so they can express any state a test
  author thinks of but never the state the product actually produces — which is
  how this fix family has now leaked through four gates. Route B additionally
  needs genuine request concurrency, which exists at no layer below this one.
- **M-V7-02 → the database layer, with the real renderer.** The established seam
  is `tests/db/publicSiteRender.test.ts`: real Postgres with the production
  migrations, the real `createSiteRenderer`, no browser and no deploy
  (02-architecture.v1.md §1). The replacement is applied as the exact statements
  `src/api/repo.ts` issues (`demoteCurrentCover`'s `update … set role='body'`,
  `insertImage`'s row with `original_url` set and `optimized_url` null and
  `replaced_cover_image_id` pointing at the demoted row, then `setImageStatus`'s
  CAS to `failed`), quoted in the file's header. Driving it over HTTP would add
  nothing to the assertion and would turn T1 — a window that closes as soon as
  `sharp` returns — into a race.
- **L-V7-01 → the database, on the owning connection.** `NFR-MIGRATE-01`,
  `NFR-TAMPER-01` and `NFR-LOCK-GRANT-01a`/`01b` are all asserted at this layer
  for the same reason: a constraint the database enforces is a different kind of
  promise from a code path that currently behaves. The whole finding is that
  application-level ordering has already proved insufficient — `usableCover()`
  and `render.ts`'s cover query are two independent, unordered picks that
  happened to agree in every trial rather than by guarantee.
- **Four files, six tests, four containers.** Publish and upload are each capped
  at 10 per minute per client IP (`rateLimit.ts`, separate keys), and every
  request in a spawned-server e2e file arrives from the same loopback address.
  `imageRecoveryRoutes.test.ts` spends at most **9 uploads and 5 publishes**;
  `publishRecoveryInvariant.test.ts` spends **8 and 8**. Putting the sweep in the
  same file would have produced `429`s — failures for a reason that has nothing
  to do with either finding — which is the same reasoning that split
  `coverImageInvariant.test.ts` out at v7. Both files read every precondition
  from the database rather than spending an extra request on it.

**Nothing prescribes an implementation.**

- **The recovery route's shape is not pinned.** §4.3 recommends `DELETE
  /v1/articles/{id}/images/{imageId}`, restricted server-side to `status <>
  'ready'`. That is a strong enough recommendation to be the primary shape, so
  `discardImage()` tries it first — and then falls through to `POST
  …/images/{imageId}/discard` and `DELETE …/images?image_id=`, two materially
  equivalent expressions of the same capability. A `404`/`405` from all three is
  read as "no such capability exists". No assertion names a verb, a path or a
  status code the capability returns; every one of them reads the *article's*
  subsequent state instead.
- **`NFR-RECOVERY-INVARIANT-01` asserts nothing about *which* state is recovered
  how**, only that none is terminal and that none is "recovered" into publishing
  a blank page. The two states it does not flag today constrain the fix from the
  other side.
- **`NFR-COVER-FALLBACK-01` names no column and no query.** §5's persisted
  `structured_data.image` fallback, a persisted `cover_image_id` (which L-V6-02
  and L-V7-01 both ultimately want), and not vacating the cover slot until the
  replacement is ready all satisfy it.
- **`NFR-COVER-UNIQUE-01` asserts no SQLSTATE and no index name** — only that the
  database itself refused and that one cover row remains. The recommended partial
  unique index, an exclusion constraint and a `check`-plus-trigger are equally
  admissible. This is a deliberate departure from `NFR-TAMPER-01`/
  `NFR-LOCK-GRANT-01`'s `42501` assertions, which pin a *grant* because the grant
  is the fix; here the fix shape is genuinely open.

### 3.1 The one place agnosticism was deliberately *not* forced

`AC-08-recovery-09` asserts `the_discard_was_answered_by: 'a product route'` —
i.e. that a writer-facing capability exists at all — rather than only that the
article ends up publishable. That is deliberate, and it is the only
mechanism-shaped assertion in this pass:

- The finding **is** the absence of the capability. §4.1's whole content is that
  all eight recovery actions fail and the only remaining fix is a human with
  `service_role` access running SQL against production. A test that accepted
  "publish stopped caring about the row" as a pass would let the gate be cleared
  without giving the writer anything.
- The cheapest alternative fix — widening `articleDependsOn()` so an adopted,
  permanently-failed row that nothing references stops blocking — is already
  refused by the suite: `AC-08-recovery-06` (v6, passing) requires an adopted,
  `failed`, `body_html`-referenced body image to keep refusing the publish.
  Asserting the capability here makes that constraint explicit rather than
  emergent.
- `NFR-RECOVERY-INVARIANT-01` deliberately does **not** carry the same
  assertion. The invariant is about the property, and pinning a mechanism inside
  it would give it a second reason to fail. The division is intentional: one test
  pins that the capability exists, the sweep pins the general property without
  naming how it is met.

---

## 4. What this pass touched, and why none of it is an assertion change

| File | Change |
|---|---|
| `tests/e2e/imageRecoveryRoutes.test.ts` | **New file.** `AC-08-recovery-09`, `AC-08-recovery-10`, `AC-08-recovery-11`. Real spawned server (legacy static auth, exactly as `tests/e2e/rejectedImageRecovery.test.ts` and `tests/e2e/coverImageInvariant.test.ts` use it, and for the same stated reason — setup only), real Postgres, real multipart bytes through the real upload route, real concurrent HTTP requests, and the real ADR-0004 conversion settling each row. |
| `tests/e2e/publishRecoveryInvariant.test.ts` | **New file.** `NFR-RECOVERY-INVARIANT-01`. Four stuck states built through product routes only, one generic recovery procedure applied identically to each, one assertion. |
| `tests/db/coverRenderFallback.test.ts` | **New file.** `NFR-COVER-FALLBACK-01`. Real Postgres with the production migrations and the real `createSiteRenderer`, following `tests/db/publicSiteRender.test.ts`'s established pattern; its own container, because `publicSiteRender.test.ts`'s `AC-12` asserts an exact homepage listing that a further published article would change. |
| `tests/db/schema.test.ts` | **Additive only**: a new `cover slot uniqueness (verify v7, L-V7-01)` describe block containing `NFR-COVER-UNIQUE-01`, seeding its own writer and its own two articles. No existing test's assertions, fixtures or data were changed; all 18 of its existing tests still pass (§2.2). |
| `tests/support/imageFixtures.ts` | **Additive only**: one new fixture, `undecodableJpeg()`. No existing export changed. |
| `pdlc/arsene-cms/traceability.md` | New "Added by the eighth remediation pass (v8)" section, the header amendment the earlier passes' format implies, and the two notes on route-shape agnosticism and the deliberate `AC-08-recovery-10`/`NFR-COVER-UNIQUE-01` overlap. |

No file in `src/` or `db/` was touched. No seam was added — `tests/support/seams.ts`
is unchanged, and both new e2e files are built entirely from the existing
`pg.ts`, `seams.ts`, `prism.ts` and `imageFixtures.ts` helpers. No existing
test's assertions were edited. `state.json` untouched. Nothing committed — the
working tree is left unstaged for review.

### 4.1 The one new fixture, and why it was necessary

`undecodableJpeg()` is what makes §4.1 reproducible **through product routes
alone**, with nothing seeded:

```
sniff = jpeg
isDamagedContainer = false
optimize = {"ok":false,"code":"CORRUPTED_FILE"}
```

(verified against the real `sniffImageFormat`, `isDamagedContainer` and
`optimizeImageBuffer` before a test was written).

The existing `corruptedJpeg()` cannot reproduce it, and that is not an oversight
in the fixture — it is the mechanism. `corruptedJpeg()` stops short of EOI, so
`isDamagedContainer()` catches it *inside the request*, `uploadImage.ts` stores
nothing, writes `original_url: null`, and `articleDependsOn()` therefore
correctly never lets that row block a publish. The whole of §4.1 is about a row
the product **accepted** — original really stored — and only later could not
convert. `undecodableJpeg()` carries a complete container (SOI, APP0 magic, a
real EOI terminator) with a garbage interior carrying no SOF/SOS/Huffman tables,
so the upload route adopts it and the real `sharp` conversion can only fail. The
row that results is the product's own, not a fixture's.

---

## 5. Three observations recorded for the green pass (not tests, not blockers)

1. **The partial unique index and the upload race must land together.** Adding
   `create unique index on article_images (article_id) where role = 'cover'`
   without also making `demoteCurrentCover()` + `insertImage()` atomic turns
   `AC-08-recovery-10`'s concurrent burst from "duplicate rows" into "some
   uploads fail on `23505`" — a `500` for a writer who did nothing wrong.
   `AC-08-recovery-10` is written not to care which way that is resolved (the row
   count it observes is never asserted), so **nothing in the suite will fail if
   the second half is forgotten**. Recorded so it is a decision rather than an
   oversight, in the same spirit as red v7 §5.1's note about the cover-selection
   route — which is precisely the note that became this pass's blocking finding.
2. **`NFR-COVER-FALLBACK-01` and L-V6-02 are one column apart.** The fix §5
   recommends (fall back to the persisted `structured_data.image`) closes
   M-V7-02 but leaves `render.ts` and `publishArticle.ts` picking "the" cover by
   two independent unordered queries whenever a `ready` cover *does* exist —
   L-V6-02, narrowed by L-V7-01 but still open. A persisted `cover_image_id`
   closes M-V7-02, L-V6-02 and L-V7-01 at once and satisfies every test in this
   pass. Not asserted, because it is a design choice and three findings' worth of
   scope.
3. **AC-15 remains unobservable to a real visitor** (I-V7-02): `render.ts` uses
   the article title for the `alt` attribute, so a writer's overwritten alt text
   reaches no page. Untouched by this pass and not tested here — noting it only
   because `NFR-COVER-FALLBACK-01` is the first test in this suite to read
   `render.ts`'s `<img>` output closely enough to make it obvious.

---

## 6. Gate statement

6 new tests, 5 failing on exactly one honest assertion each, against real
Postgres 16 (Testcontainers, production migrations), three real spawned
child-process servers over real HTTP, real multipart JPEG bytes through the real
upload route, four genuinely concurrent HTTP uploads (reproduced on four
independent runs), a real ADR-0004 conversion carried to a real `failed` status
through the real compare-and-swap, the real public render pass, and two direct
constraint probes on the owning database connection. 1 passing by design, as the
both-sides control that stops the new capability becoming the next finding — a
discard route permissive enough to remove an image the article genuinely depends
on would reopen AC-08 in a new shape, which is the failure direction this fix
family has taken at every previous turn. 221 previously-passing tests still
passing, `tsc --noEmit` clean. No production code written. Red.
