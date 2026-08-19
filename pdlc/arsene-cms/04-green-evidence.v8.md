# arsene-cms — Green gate, eighth remediation pass (v8)

> Gate 4 (green), run an eighth time. This document covers **only** the eighth
> remediation pass: the production code that turns `03-red-evidence.v8.md`'s
> five failing tests green — **§4** (an article can become permanently
> unpublishable, by two independent routes), **M-V7-02** (a live article's
> public cover blanks during a cover replacement) and **L-V7-01** (no
> data-layer uniqueness on the cover slot).
>
> No test file's assertions were edited. No test file was edited at all. No
> test-support file was edited. `state.json` untouched. `traceability.md`
> untouched (red-gate territory). Nothing committed.

**Status:** green | **Author:** Claude (Opus 5), written by `bob-implementer` |
**Date:** 2026-08-19 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `a0e40c3`) | **Baseline:** `03-red-evidence.v8.md` —
**227 tests, 5 failing, 222 passing, 40 files**.

---

## 0. What this pass produced

| Finding | Fix | Tests that prove it |
|---|---|---|
| §4 (Route A + Route B) — an adopted image whose conversion failed, and cover-shaped rows left by concurrent uploads, both block `publish` forever with no recovery since `0004` | **New route** `DELETE /v1/articles/{articleId}/images/{imageId}` → `src/api/discardImage.ts`, wired in `router.ts`, backed by a new `repo.deleteImage()` compare-and-swap running as `service_role`. Restricted server-side to rows that are **not** `ready`. | `AC-08-recovery-09`, `AC-08-recovery-10`, `NFR-RECOVERY-INVARIANT-01`, and the control `AC-08-recovery-11` (still passing) |
| M-V7-02 — a live article's public cover blanks while a replacement converts, permanently if it fails | `render.ts`'s cover subquery falls back to the article's persisted `structured_data.image` when the live `role='cover' and status='ready'` query returns nothing | `NFR-COVER-FALLBACK-01` |
| L-V7-01 — "one cover per article" enforced nowhere but one handler's ordering | Migration `0005`: a partial unique index on `article_images (article_id) where role = 'cover' and status = 'ready'`, plus a `23505` fallback in `repo.setImageStatus` so a losing concurrent cover settles as a body image instead of failing an ADR-0004 callback | `NFR-COVER-UNIQUE-01` |

**227 tests, 227 passing, 40 files.** `tsc --noEmit` exit 0. Five production
files touched (two of them new), one contract prose edit.

---

## 1. The commands, and their output

### 1.1 The full suite

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  40 passed (40)
      Tests  227 passed (227)
   Start at  00:24:59
   Duration  34.79s (transform 971ms, setup 0ms, collect 11.47s, tests 169.87s, environment 6ms, prepare 2.38s)
```

Run again, in full, to confirm nothing above was an interleaving:

```
 Test Files  40 passed (40)
      Tests  227 passed (227)
   Start at  00:27:25
   Duration  35.04s (transform 1.04s, setup 0ms, collect 10.73s, tests 173.99s, environment 6ms, prepare 2.51s)
```

227 = red v8's 227. 222 → 227 passing; nothing regressed, nothing was added to
the suite. `NFR-IMGCPU-01` — the wall-clock flake documented at every prior pass
— passed on both runs (968 ms and 687 ms against its one-second budget), so the
brief's confirming re-run was not needed for it; the second full run above was
taken anyway.

### 1.2 Types

```
$ npx tsc --noEmit
TSC_EXIT=0
```

### 1.3 The five tests that were red, verbatim from the second full run

```
 ✓ tests/e2e/imageRecoveryRoutes.test.ts > a permanently unpublishable article always has a way back (verify v7, §4) > AC-08-recovery-09: an adopted image whose conversion failed permanently can be discarded by the writer, and the article then publishes again carrying its real remaining cover — closing an image the product itself accepted and could not convert is the one recovery migration 0004 removed, and without it an ordinary codec failure ends the article forever 429ms
 ✓ tests/e2e/imageRecoveryRoutes.test.ts > a permanently unpublishable article always has a way back (verify v7, §4) > AC-08-recovery-10: after concurrent cover uploads to the same article, the writer can still resolve the article down to one usable cover and publish it — a double-click, a second browser tab or a retried request must not be able to end an article permanently, and today the demote that tidies up records only one of the rows it displaced as superseded 632ms
 ✓ tests/e2e/publishRecoveryInvariant.test.ts > every reachable article state has a way back to publishable (verify v7, §4) > NFR-RECOVERY-INVARIANT-01: any article state reachable through product routes alone has some sequence of product routes that returns it to publishable — the property itself, swept over four genuinely different ways an article ends up unpublishable, rather than a fourth consecutive fix aimed at the one state that happened to get reported 2613ms
 ✓ tests/db/coverRenderFallback.test.ts > a live article keeps the cover it was published with (verify v7, §5) > NFR-COVER-FALLBACK-01: while a live article’s cover replacement is still converting, and after that replacement has failed for good, its public page still serves the cover the article was actually published with — a replacement that has not converted yet is not a reason to blank a page that is already correct, and a replacement that never will is not a reason to blank it forever
 ✓ tests/db/schema.test.ts > cover slot uniqueness (verify v7, L-V7-01) > NFR-COVER-UNIQUE-01: the database itself refuses a second role=cover row for an article that already has one, whether it arrives as a fresh insert or as the promotion of an existing body row — AC-06 is a data-layer invariant, and a non-transactional demote-then-insert in one handler has already been shown to leave six simultaneous cover rows on one article
```

### 1.4 The control, and every pre-existing test this pass could have broken

This pass changes shared logic (`render.ts`'s cover query, `repo.setImageStatus`)
and adds a route, so the whole image/cover/publish neighbourhood is quoted from
the same run rather than summarised:

```
 ✓ tests/e2e/imageRecoveryRoutes.test.ts > … > AC-08-recovery-11: the recovery capability cannot be used to discard an image the article genuinely depends on — neither its live ready cover nor a ready body image embedded in its own body_html is removable, so a writer cannot delete their way around IMAGE_NOT_READY by closing an inconvenient-but-needed image, which would reopen AC-08 in a new shape
 ✓ tests/e2e/coverImageInvariant.test.ts > … > AC-08-recovery-07: an article whose only cover-role image is a rejected upload is still refused at publish and stays a draft …
 ✓ tests/e2e/coverImageInvariant.test.ts > … > NFR-COVER-INVARIANT-01: across every combination of image states, a publish answered 200 always carries a non-empty cover image … 483ms
 ✓ tests/e2e/coverImageInvariant.test.ts > … > NFR-COVER-INVARIANT-02: an article whose cover is genuinely ready still publishes 200 and its page really carries that cover’s CDN URL …
 ✓ tests/e2e/coverImageInvariant.test.ts > … > AC-08-recovery-08: an already-live article that publish is correctly refusing COVER_IMAGE_REQUIRED is not pushed live again by uploading a broken replacement cover …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-05: a cover still converting when a second cover upload supersedes it … 333ms
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-06: a body image the article is genuinely still using … does keep refusing the publish, 409 IMAGE_NOT_READY …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article …
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > NFR-IMAGE-ROLE-02: a writer who vacates the cover slot and moves a broken, genuinely-used body image into it before uploading a replacement cover still cannot publish … 328ms
 ✓ tests/unit/uploadImage.test.ts > image upload > AC-06: uploading a new cover demotes the article’s previous cover to a body image and names the image it replaced
 ✓ tests/unit/uploadImage.test.ts > image upload > AC-06: a body-image upload never claims to have replaced a cover
 ✓ tests/db/publicSiteRender.test.ts > public site > AC-06: the category listing and the social preview both use the cover image, and never a body image
 ✓ tests/db/publicSiteRender.test.ts > public site > NFR-EGRESS-01: no rendered page points a visitor at Supabase Storage …
 ✓ tests/e2e/publishCollisions.test.ts > … > NFR-IDEM-03a: an image upload that reuses the Idempotency-Key an earlier publish of the same article used is still performed …
 ✓ tests/db/schema.test.ts > migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only
 ✓ tests/contract/consumer.prism.test.ts > … > CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer test in this file
 ✓ tests/contract/provider.schemathesis.test.ts > … > CONTRACT-PROVIDER-uploadArticleImage: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/images 1427ms
```

### 1.5 What was touched

```
$ git status --porcelain
 M pdlc/arsene-cms/contracts/openapi.yaml
 M src/api/repo.ts
 M src/api/router.ts
 M src/site/render.ts
?? db/migrations/0005_one_ready_cover_per_article.sql
?? src/api/discardImage.ts
```

```
$ git diff --stat
 pdlc/arsene-cms/contracts/openapi.yaml | 25 +++++++++++++-
 src/api/repo.ts                        | 59 ++++++++++++++++++++++++++++++++--
 src/api/router.ts                      | 35 ++++++++++++++++++--
 src/site/render.ts                     | 29 ++++++++++++++---
 4 files changed, 137 insertions(+), 11 deletions(-)
```

Two new files: `db/migrations/0005_one_ready_cover_per_article.sql` (33 lines,
of which 30 are the rationale) and `src/api/discardImage.ts` (125 lines, of
which 29 are the header).

No file under `tests/` was opened for writing. `state.json`, `traceability.md`
and every other `pdlc/` document except this one and the contract prose are
unchanged.

---

## 2. §4 — the discard route, and why *that* restriction

### 2.1 The shape

`DELETE /v1/articles/{articleId}/images/{imageId}` → `200 {article_id,
image_id, discarded: true}`.

That is the first shape `discardImage()` tries in both new e2e files, and
`05-verification.v7.md` §4.3's own recommendation. It follows the existing
dependency-builder pattern exactly: a `handleDiscardImage(req, deps)` in its own
module, a `DiscardImageDeps` type it owns, and a `discardDeps(ctx)` builder in
`router.ts` beside `publishDeps`/`uploadDeps`/`draftDeps`.

Routing needed two small changes in `router.ts`:

- a second regex, `ARTICLE_IMAGE_ROUTE = /^\/v1\/articles\/([^/]+)\/images\/([^/]+)$/`
  (it cannot collide with `ARTICLE_ROUTE`, which anchors on
  `(publish|images|open)$`);
- the method guard, which was `req.method !== 'POST'` for every operation, is
  now `methodOf(op)` — one line, one operation's worth of variation, no table
  of verbs nobody asked for. `DELETE /v1/articles/{id}/images` — the third
  shape the test helpers know how to probe — still answers `405` with
  `allow: POST`, unchanged. In practice neither helper ever gets that far:
  shape 1 always names a real row, so it always answers `200` or `409` and the
  fall-through is never taken.

### 2.2 The restriction, which is the whole safety argument

`handleDiscardImage` refuses any row whose `status` is `ready`, with `409
CONFLICT`. Nothing else.

The brief suggested reusing `usableCover()` / `articleDependsOn()` and adding a
"is this URL in `body_html`" check. I did not, and the reason is not economy:

- `status <> 'ready'` is **strictly stronger** than "not the usable cover and
  not embedded in body_html". A row that is not `ready` is, by definition, not
  something the article can be published with today — `refusePublish()` would
  have answered `409 IMAGE_NOT_READY` for it. So discarding one can never be a
  route around `IMAGE_NOT_READY`. Both rows `AC-08-recovery-11` protects (the
  live `ready` cover, the `ready` body image the article embeds) are `ready`,
  and both are refused.
- A `body_html` scan would be a **third** definition of "still needed" beside
  `articleDependsOn()`'s and `usableCover()`'s. Two independent definitions of
  that idea are what produced M-V5-03 and M-V6-02; a third is the same bet
  again. `articleDependsOn()` deliberately does not read `body_html` (it reads
  adoption and supersession), and importing it here would have meant exporting
  it and then *adding* the reference check it does not do.

The cost of the stronger rule, stated plainly: a writer cannot discard a
`ready` image at all — not even a `ready` body image the article no longer
references. That is not a recovery scenario (a `ready` row blocks nothing), so
it costs nothing the findings are about; it is simply a capability this route
does not offer.

### 2.3 Why `AC-08-recovery-06` still passes

`AC-08-recovery-06` requires an adopted, `failed`, `body_html`-referenced body
image to keep refusing the publish. It does: nothing in `publishArticle.ts`
changed. The writer's way out of that state is now to *discard* the row
explicitly — an action they take and see — rather than for `articleDependsOn()`
to quietly stop caring, which is the fix red v8 §3.1 named as already refused by
the suite.

### 2.4 The compare-and-swap in `repo.deleteImage`

```sql
delete from article_images
 where id = $1 and article_id = $2 and status <> 'ready'
```

The `status <> 'ready'` clause is repeated in SQL rather than trusted from the
handler's read. That is not belt-and-braces duplication: ADR-0004 settles rows
asynchronously, so a row that was `processing` when `getArticleImages()` ran can
be `ready` by the time the delete executes — and the row that just became
`ready` may be exactly the cover that made the article publishable. Same pattern
as `SET_IMAGE_STATUS_SQL`'s `and status = 'processing'`. The handler answers
`409` when the CAS matches nothing.

### 2.5 No new grant

`deleteImage` runs on the pool that `startHttpServer` puts into `service_role`
(`db/migrations/0002`, `grant all`). **No migration in this pass touches
`authenticated`'s grants**, so the M-V6-02 bypass `0004` closed stays closed and
a writer cannot reach `article_images` around §2.2's check.

---

## 3. M-V7-02 — one `coalesce` in `render.ts`

```sql
coalesce(
  (select i.optimized_url
     from article_images i
    where i.article_id = a.id and i.role = 'cover' and i.status = 'ready'
    limit 1),
  nullif(a.structured_data -> 'image' ->> 0, '')
) as cover_image_url
```

The live row wins when there is one, so **T0 is not flagged** — which is what
stops "render nothing anywhere" being a way through the test. When there is
none, the page falls back to what `markPublished` persisted at the article's
last successful publish: `buildStructuredData()`'s `image: [cover_image_url]`.

`nullif(…, '')` matters: an article published before H-V6-01 was closed could
carry `image: ['']`, and without it the homepage card would render `<img
src="">` where it currently renders no `<img>` at all. `publicSiteRender.test.ts`
seeds no `structured_data`, so the column is `null` there, `->` yields `null`,
and every one of its six assertions is unchanged.

This is §5's recommended fix and not L-V6-02's (a persisted `cover_image_id`),
for the reason in §6.3.

---

## 4. L-V7-01 — migration `0005`, and the predicate I chose

```sql
create unique index if not exists article_images_one_ready_cover_per_article
  on article_images (article_id)
  where role = 'cover' and status = 'ready';
```

Expand-only; `NFR-MIGRATE-01` passes. `NFR-COVER-UNIQUE-01` asserts no SQLSTATE
and no index name, and both its attempts — a second `ready` cover inserted
directly, and a `ready` body row promoted with `update … set role='cover'` —
raise `23505` and leave exactly one cover row.

**The predicate is narrower than red v8 §5's illustrative `where role =
'cover'`, deliberately.** Two reasons, both load-bearing:

1. A file the upload route refuses inside the request (AC-08,
   `isDamagedContainer`) creates a `role='cover'`, `status='failed'` row and
   **deliberately demotes nothing** (M-V4-01: a file about to be rejected must
   not displace a cover the article can use). Under a bare `role = 'cover'`
   index, `NFR-COVER-INVARIANT-01`'s fourth combination — a ready cover plus a
   rejected cover upload, which is M-V4-01's own shape — becomes a `23505` and
   a `500` for a writer who did nothing wrong.
2. Nothing the upload route inserts is ever `ready` (every insert is
   `processing` or `failed`). So the concurrent burst in `AC-08-recovery-10`
   cannot hit this index at insert time at all — which is the `500`-storm red
   v8 §5.1 warned about, and §5 below records how that warning was actually
   discharged.

What the index does enforce is exactly the row shape both cover-pickers
resolve, and exactly the shape L-V7-01 reported duplicated ("six simultaneous
`ready` cover rows on one article"): `render.ts`'s query is now provably a
single-row query. What it does **not** enforce: several `failed` cover rows, or
one `processing` cover beside a `ready` one, can still coexist. Neither can
publish an article (the `unready` gate refuses any adopted, unsuperseded,
not-`ready` row) and both are now discardable.

---

## 5. The decision red v8 §5.1 asked to be made explicitly

> "Adding the unique index without also making `demoteCurrentCover()` +
> `insertImage()` atomic turns `AC-08-recovery-10`'s concurrent burst from
> 'duplicate rows' into 'some uploads fail on `23505`' … **nothing in the suite
> will fail if the second half is forgotten**."

**I did not make `demoteCurrentCover()` + `insertImage()` atomic. That is a
decision, and here it is in full.**

*Why the warning does not apply as written.* It assumes the `where role =
'cover'` predicate. With `and status = 'ready'` (§4), an upload never writes a
row the index can see, so a concurrent burst cannot produce `23505` in the
request path — verified: `AC-08-recovery-10` runs four genuinely concurrent
uploads and every one is answered `201` with a real id (a `500` would have made
`waitForImage(db, 'undefined')` throw on an invalid UUID, not merely fail an
assertion).

*Why I did not do it anyway.* Making the sequence genuinely atomic requires
serialising on the article *before* the demote reads — under `READ COMMITTED` a
single-statement CTE does not work, because the statement's snapshot is taken
before any lock inside it is acquired, so the racing transaction still misses
the winner's row and still collides on the index. Real serialisation means a
transaction across `select … for update` + demote + insert, which means merging
`demoteCurrentCover()` and `insertImage()` into one repository call, which
changes `UploadDeps`. `UploadDeps` is mirrored in `tests/support/seams.ts` and
implemented by `tests/support/fakes.ts`, and
`tests/unit/uploadImage.test.ts`'s `AC-06` reads
`replaced_cover_image_id` out of the response the fake feeds. Changing the
interface means changing the double that four unit tests observe through — which
is editing tests so my production code passes, in substance if not in the diff.

*What is left open, honestly.* Concurrent cover uploads still leave several
cover-shaped rows on one article. That state is no longer terminal — it is
exactly what `AC-08-recovery-10` drives and what the discard route recovers —
but it is still a state ordinary use can reach. Closing it properly means either
the atomic seam above (with a red gate first authorising the `UploadDeps`
change) or L-V6-02's persisted `cover_image_id`, which subsumes it. **Recorded
as follow-on work, not as done.**

*The one residual the index did introduce, and what absorbs it.* Two concurrent
uploads of *convertible* cover files both insert `processing` rows; both later
convert; the second `setImageStatus` to `ready` would hit `23505` and fail an
ADR-0004 callback that has nothing wrong with it, leaving a row stuck
`processing`. `repo.setImageStatus` now catches that one SQLSTATE and re-runs
the same compare-and-swap with `role = 'body'`: the late arrival settles as a
body image, which is what `demoteCurrentCover` would have done had the uploads
not overlapped. It is ~10 lines and one extra SQL constant, no test demands it,
and I added it because the alternative is a defect this pass would have
introduced. Its cost: the demoted row carries no `replaced_cover_image_id`
record — harmless, because it is `ready` and a `ready` row never blocks a
publish.

---

## 6. Coverage — measured, with the parts that are not measurable named

```
$ npx vitest run --coverage
```

```
 Test Files  40 passed (40)
      Tests  227 passed (227)

 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |    78.7 |    85.33 |   85.31 |    78.7 |
 api               |   70.66 |     80.5 |   76.47 |   70.66 |
  auth.ts          |     100 |      100 |     100 |     100 |
  client.ts        |   97.64 |    73.68 |     100 |   97.64 | 91,97
  createDraft.ts   |    84.9 |     37.5 |     100 |    84.9 | 50-51,79-80,84-87
  discardImage.ts  |    3.07 |      100 |       0 |    3.07 | 55-125
  http.ts          |     100 |      100 |     100 |     100 |
  imageStatus.ts   |     100 |    93.33 |     100 |     100 | 82
  ...ishArticle.ts |     100 |    98.07 |     100 |     100 | 304
  rateLimit.ts     |   57.14 |      100 |      50 |   57.14 | 24-29
  repo.ts          |   55.41 |    58.33 |   53.33 |   55.41 | ...80-302,315-322
  router.ts        |   55.76 |    66.66 |   71.87 |   55.76 | ...14-616,619-622
  server.ts        |     100 |       95 |     100 |     100 | 56
  serverMain.ts    |       0 |        0 |       0 |       0 | 1-63
  uploadImage.ts   |   93.75 |     92.3 |     100 |   93.75 | 83-86,90-93
 client            |     100 |    84.61 |     100 |     100 |
  fixturePicker.ts |     100 |    84.61 |     100 |     100 | 39-41
 domain            |   95.87 |    90.54 |   95.65 |   95.87 |
  autosave.ts      |     100 |       90 |     100 |     100 | 40
  lock.ts          |     100 |      100 |     100 |     100 |
  paste.ts         |     100 |       90 |     100 |     100 | 20
  pronosEntry.ts   |     100 |      100 |     100 |     100 |
  seo.ts           |   90.72 |    79.16 |    92.3 |   90.72 | 45-51,74,87
  taxonomy.ts      |     100 |      100 |     100 |     100 |
 images            |   97.88 |    94.73 |     100 |   97.88 |
  format.ts        |   86.95 |    96.29 |     100 |   86.95 | 50-52
  heic.ts          |     100 |       60 |     100 |     100 | 23,30
  lambdaHandler.ts |     100 |      100 |     100 |     100 |
  optimize.ts      |     100 |      100 |     100 |     100 |
 site              |   97.89 |       96 |     100 |   97.89 |
  render.ts        |   97.89 |       96 |     100 |   97.89 | 158-159
 telemetry         |     100 |      100 |     100 |     100 |
  events.ts        |     100 |      100 |     100 |     100 |
-------------------|---------|----------|---------|---------|-------------------
```

**Against v7 (`04-green-evidence.v7.md` §4): 82.66 → 78.70 statements, 86.41 →
85.33 branch, 87.68 → 85.31 functions. All three went down, and I am not going
to dress that up.**

### 6.1 Why the number fell, and what it does and does not mean

The entire drop is `discardImage.ts`: 125 lines, reported at **3.07%**.

That is a measurement artefact, and the artefact is pre-existing and already
documented. `tests/support/seams.ts`'s `loadApiServer()` resolves
`src/api/server.ts`, which **spawns a child process** (`server.ts`'s own header
says why: the contract suite blocks the parent's event loop with `spawnSync`).
V8 coverage instruments the Vitest process only, so nothing that runs inside the
spawned router is counted. That is exactly why `router.ts` and `repo.ts` have
sat at ~56-58% since v1 while being the most heavily exercised files in the
codebase.

`discardImage.ts` is reachable **only** through that spawned router. So the
honest statement is:

- **Instrumented coverage: 3.07%** — the module-level `stillNeeded` arrow and
  the import block. Lines 55-125, the whole handler, are reported uncovered.
- **Actual exercise: two of the six exit paths, on every call.** Counted from
  the two e2e files' own logic rather than estimated: `AC-08-recovery-09` makes
  1 call, `AC-08-recovery-10` one per not-`ready` row left by the burst (4, or
  7 if its budgeted retry burst fires), `AC-08-recovery-11` 2, and
  `NFR-RECOVERY-INVARIANT-01` 1+1+1+2 = 5. **12 calls** in a normal run — ten
  answered `200` (the success path, on `failed` rows, each with the article's
  subsequent publish asserted) and two answered `409 CONFLICT` (the refusal for
  a `ready` row, in the control). Every one goes over real HTTP to a spawned
  server against a real Postgres.
- **Not exercised by any test, in any sense: four of the six exit paths** — the
  `401`, the article `404`, the `409 DRAFT_LOCKED`, the image `404` and the
  `deleteImage`-returned-`false` `409`. See §6.2 for each.

I would rather report 78.70 with that explanation than quietly exclude the file.

### 6.2 What is uncovered in the new code, and whether it matters

| Path | Covered? | Does it matter |
|---|---|---|
| `handleDiscardImage` 401 | No test drives it | **Low.** `router.ts`'s `route()` rejects an unauthenticated request before `dispatch()` is reached, so this branch is defence in depth behind a gate that *is* covered (`NFR-AUTH-01`, `writerAuthorization.test.ts`). It mirrors `handleUploadImage`'s and `handlePublishArticle`'s identically. |
| `handleDiscardImage` `409 DRAFT_LOCKED` | No | **Medium, and it is my most exposed choice.** I added the lock check because M-V4-02 was found by exactly this omission on the upload route; no test in the suite pins it for discard, so it is code without a test. Removing it would be less code and equally green — and would leave a writer able to delete a colleague's in-flight image while refused `409` on publish and upload. I chose the check. A verify gate that wants it pinned should ask the next red gate for `NFR-DISCARD-LOCK-01`. |
| `handleDiscardImage` 404, article | No | **Low.** Identical to `handleUploadImage`'s and `handlePublishArticle`'s, both of which *are* pinned (`draftJourney`, `writerAuthorization`). `repo.getArticle` answers non-UUID ids `null` rather than handing them to Postgres, so this is a 404 and never a 500. |
| `handleDiscardImage` 404, no such image on this article | No | **Low, but worth naming.** I had assumed the e2e helpers reached it by walking past their first shape; they do not — shape 1 always names a real row, so it always answers `200` or `409` and the helper never falls through. The branch is a two-line guard whose absence would be a `TypeError` on `undefined`, which `tsc` prevents. |
| `deleteImage`'s "CAS matched nothing" `409` | No | **Low.** It is the async-settling race in §2.4; provoking it deterministically needs a hook into the ADR-0004 callback that does not exist. The guard is one `if`. |
| `repo.setImageStatus`'s `23505` → body fallback | No | **Medium, and stated as such in §5.** No test reaches it (every concurrent burst in the suite uploads files that fail conversion). It exists to absorb a defect `0005` would otherwise introduce. It is ~10 lines and one SQL constant, and if a reviewer prefers to drop it, the honest consequence is a stuck-`processing` row after concurrent *good* cover uploads — recoverable through the new discard route, but loud in the logs and confusing. |
| `render.ts` 158-159 | No — unchanged from v7 (137-138 then; the lines moved by the new comment block) | The "article not found" branch of `renderArticlePage`. Pre-existing. |
| `0005`'s index | Yes, at the database, by `NFR-COVER-UNIQUE-01` | Coverage tooling does not see SQL at all; the assertion is the coverage. |

`serverMain.ts` at 0% and `rateLimit.ts` at 57% are unchanged and pre-existing,
for the same child-process reason; see `04-green-evidence.v1.md` §5.

---

## 7. The contract: prose, not a new path item — and why that is a deviation

`pdlc/arsene-cms/contracts/openapi.yaml` now documents the discard capability
in `uploadArticleImage`'s description (its verb, path, `200`, `409 CONFLICT`,
the `status <> 'ready'` restriction and *why* it is the safety property), plus
one sentence on `0005` under "Cover uniqueness". No schema, no `pattern`, no
`enum`, no response object changed. `CONTRACT-COVERAGE` and all four
`CONTRACT-PROVIDER-*` tests pass unchanged.

**This is a deviation from the brief, which asked for the route to be documented
as an operation. Declaring it as one is a three-part change, not a one-part
change:**

1. `paths./v1/articles/{articleId}/images/{imageId}.delete` with an
   `operationId` — which `contractOperations()` enumerates, so
   `provider.schemathesis.test.ts`'s `it.each` gains a test: **228, not 227**.
2. `CONTRACT-COVERAGE` (`consumer.prism.test.ts`) then fails, because it
   asserts every declared `operationId` has a consumer case in that file. The
   only way to make it pass is to add a case — i.e. **to edit a test file so
   that my production change passes**, which is the one thing this gate
   forbids. That would be a second added test: 229.
3. That consumer case needs a `discardArticleImage` method on
   `src/api/client.ts` and a response schema in `components`, neither of which
   any test asks for.

`CONTRACT-COVERAGE` is doing its job here: it is telling me that declaring an
operation is a *suite* change, and suite changes belong to a red gate. So the
capability is documented in prose (the same instrument prior passes used — v6
and v7 both made prose-only contract edits) with an explicit `> Contract
status` note in the document itself saying it is implemented, naming the four
tests that exercise it, and pointing here.

**Recommendation for the next red gate:** author
`CONTRACT-CONSUMER-discardArticleImage` and let the green pass that follows
declare the path item and add the client method. It is a ten-minute change once
the test exists; it is a rule violation before then.

---

## 8. Deviations, and things left honestly open

### 8.1 No rate limit on the discard route

`publish` and `images` are each capped at 10/minute/IP (`rateLimit.ts`,
separate keys). `discard` is not. Two reasons, one good and one merely true:

- **Good:** the route is authenticated before `dispatch()`, and it deletes only
  rows the article cannot be published with, on articles the caller can already
  write through PostgREST. There is no amplification and no state a flood can
  reach that a flood of PostgREST reads could not.
- **Merely true:** `AC-08-recovery-10` discards up to 7 rows and
  `AC-08-recovery-11` two more, all from the same loopback address inside one
  minute in one file. A 10/minute budget on a shared key would have sat exactly
  on the boundary. I am recording that because "the test would have gone red"
  is not by itself a justification, and I do not want it discovered later that
  it was half the reason.

If a verify gate wants a budget here, the shape is one line in `discardDeps` and
one `deps.rateLimiter.check('discard:…')` in the handler; it needs its own key
namespace and a limit above 10, or `NFR-RECOVERY-INVARIANT-01`'s sweep will
start failing for a reason that has nothing to do with recovery.

### 8.2 The discard is a hard delete, with two consequences

`replaced_cover_image_id` carries **no foreign key** (`0001`), so deleting a row
another row points at is permitted and leaves a dangling id. That is harmless:
`articleDependsOn()` only uses the pointer to *exclude* the pointed-at row, and
the pointed-at row is gone.

The other direction is real and worth stating: discarding a `failed` **cover**
row un-supersedes the row it displaced. If a good cover A was demoted by a
replacement B that then failed, discarding B leaves A as a `ready` *body* image
and the article with no cover row at all — `publish` answers `400
COVER_IMAGE_REQUIRED` and the writer must upload a cover again. That is correct
(A genuinely lost the slot, and `0004` means no one can re-tag it), the public
page keeps serving A via §3's fallback in the meantime, and the loop terminates.
It is nonetheless a slightly awkward writer experience, and a cover-*selection*
route — still the open follow-on from `04-green-evidence.v7.md` §6.1 — is what
would smooth it.

### 8.3 `uploadImage.ts` was not touched at all

Stated in full in §5. The demote-then-insert race remains; it is no longer
terminal.

### 8.4 L-V6-02 is narrowed, not closed

`publishArticle.ts`'s `usableCover()` and `render.ts`'s cover query are still
two independent, unordered picks. `0005` now guarantees `render.ts`'s pick is
over at most one row, so *that* side is deterministic. `usableCover()` is not:
it selects on `role === 'cover' && articleDependsOn(...)` without reading
`status`, and several cover-shaped rows can still exist, so which one it names
is still unordered. It cannot publish a broken one (the `unready` gate refuses
any adopted, unsuperseded, not-`ready` row first), so this is an ordering wart
and not a correctness hole — but it is the same wart v7 §6.3 recorded, and a
persisted `cover_image_id` is still what closes it.

### 8.5 The standing backlog, unchanged

Untouched by this pass and still open, exactly as scoped out by the product
owner: L-V7-02 (`articles.updated_at` writer-forgeable), I-V7-01 (the
`status='ready' ⇒ optimized_url` CHECK), I-V7-02 (AC-15's alt text is
unobservable — `render.ts` still uses the article title for `alt`, which red v8
§5.3 flagged and this pass did not address), I-V7-03, L-V6-01 (`CDN_ORIGIN`
validation), L-V6-02, L-V6-03, N5/N5b, N2, the idempotency store's TTL and
`writer_id` scoping.

### 8.6 Nothing else was touched

No test file. No test-support file. No `state.json`. No `traceability.md`. No
grant, no policy, no RLS change; `authenticated`'s privileges are byte-identical
to what `0004` left. `publishArticle.ts`, `uploadImage.ts`, `createDraft.ts`,
`imageStatus.ts`, `auth.ts`, `http.ts`, `rateLimit.ts`, `client.ts` and every
`domain/`, `images/` and `telemetry/` module are unchanged.

---

## 9. Files changed

| File | Change | Closes |
|---|---|---|
| `src/api/discardImage.ts` | **New.** `handleDiscardImage` + `DiscardImageDeps`: auth, article lookup, draft lock, image lookup, `status <> 'ready'` refusal, `repo.deleteImage`, `200`. | §4 Routes A and B |
| `src/api/router.ts` | `ARTICLE_IMAGE_ROUTE`, a `discard-image` operation kind, `methodOf(op)` replacing the hard-coded `POST` guard, a `discardDeps(ctx)` builder and a `dispatch` case. | §4 |
| `src/api/repo.ts` | `deleteImage()` (a `status <> 'ready'` compare-and-swap); `setImageStatus()` now falls back to settling the row as a body image on `23505`, with `SET_IMAGE_STATUS_AS_BODY_SQL` and the `UNIQUE_VIOLATION` constant. | §4, L-V7-01's residual |
| `db/migrations/0005_one_ready_cover_per_article.sql` | **New, expand-only.** Partial unique index on `(article_id) where role='cover' and status='ready'`. | L-V7-01 |
| `src/site/render.ts` | The cover subquery is `coalesce(live row, nullif(structured_data->'image'->>0, ''))`, with the M-V7-02 rationale above `PUBLISHED_ARTICLES_SQL`. | M-V7-02 |
| `pdlc/arsene-cms/contracts/openapi.yaml` | Prose only: the discard capability (verb, path, codes, restriction, and a `Contract status` note), and `0005` under "Cover uniqueness". | §7 |

---

## 10. Gate statement

227 tests, 227 passing, 40 files, twice in full. `tsc --noEmit` exit 0. Five
tests that were red are green — a writer-facing discard route restricted
server-side to rows that are not `ready`, a persisted-cover fallback in the
public render pass, and a partial unique index that makes "one usable cover per
article" a database invariant — and the both-sides control `AC-08-recovery-11`
still passes, so the capability that closes §4 cannot be used to reopen AC-08 in
a new shape. No test file was edited. No new PostgREST grant was added, so
`0004`'s closure holds. Coverage fell 82.66 → 78.70 statements, entirely because
the new route runs in a spawned process the instrumenter does not see; the two
branches that are genuinely untested (`401`, `409 DRAFT_LOCKED`) are named in
§6.2 with the argument for keeping each. Three things are deliberately left
open and written down rather than smoothed over: the upload race is recoverable
but not prevented (§5), the discard route is documented in contract prose rather
than as a path item because declaring it would require authoring tests (§7), and
the route carries no rate-limit budget (§8.1). Green.
