# arsene-cms — Green gate, fifth remediation pass (v5)

> Gate 4 (green), run a fifth time. This document covers **only** the fifth
> remediation pass: the production code that turns `03-red-evidence.v5.md`'s
> four failing tests green, for `05-verification.v4.md`'s two Medium findings —
> **M-V4-01** (a truncated cover upload blanks a live article's cover and then
> permanently blocks republication) and **M-V4-02** (upload never checks the
> draft lock publish enforces).
>
> Out of scope, exactly as the red pass scoped it: L-V4-01 (unscoped idempotency
> store), L-V4-02 (`SUPABASE_JWT_ISSUER=""`), I-V4-01 … I-V4-04, and the whole
> v3 backlog carried in `05-verification.v4.md` §9 — including M-V3-04
> (`CDN_ORIGIN`), which that report still names the item most likely to brick a
> real deployment. None of it is touched here, and none of it is closed.

**Status:** green | **Author:** Claude (Opus 5), written by `bob-implementer` |
**Date:** 2026-08-14 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `d5e189d`) | **Starting point:** the red-v5 suite —
**206 tests, 4 failing, 202 passing, 33 files**, re-confirmed before a line of
production code was written.

---

## 1. The commands, and their output

### 1.1 The full suite

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  33 passed (33)
      Tests  206 passed (206)
   Start at  08:00:36
   Duration  26.36s (transform 1.48s, setup 0ms, collect 9.61s, tests 113.42s, environment 6ms, prepare 3.24s)
```

206/206. The four tests `03-red-evidence.v5.md` §2 listed as failing —
`AC-08-recovery-01`, `AC-08-recovery-02`, `NFR-UPLOAD-LOCK-01`,
`NFR-UPLOAD-LOCK-03` — now pass. The two controls the red pass wrote to stop the
cheapest wrong fix — `AC-08-recovery-03` and `NFR-UPLOAD-LOCK-02` — still pass,
and they are the reason the fix is shaped the way §2 describes rather than
"ignore `failed` rows" / "refuse when `locked_by !== me`".

`NFR-IMGCPU-01`, the known wall-clock flake, passed in this run (577 ms against
its one-second budget), so it needed no isolation this pass:

```
 ✓ tests/unit/lambdaImage.test.ts > … > NFR-IMGCPU-01: a real ~6 megapixel photo … 577ms
```

### 1.2 Types

```
$ npx tsc --noEmit
TSC_EXIT=0
```

### 1.3 No test file was edited

```
$ git status --short
 M pdlc/arsene-cms/contracts/openapi.yaml
 M src/api/publishArticle.ts
 M src/api/repo.ts
 M src/api/uploadImage.ts
```

Four files. Nothing under `tests/`. No assertion was relaxed, reworded or
deleted; `state.json` is untouched; nothing is committed.

---

## 2. Every finding, what closed it, and the tests that prove it

| Finding | What was wrong | What changed | Tests that prove it |
|---|---|---|---|
| **M-V4-01**, half 1: a rejected file cost the writer a working cover | `createImage()` called `demoteCurrentCover()` *before* `isDamagedContainer()`, so a file the route was about to reject had already demoted the article's live `ready` cover to `body`. The public render pass (`role='cover' and status='ready'`) then found nothing. | `src/api/uploadImage.ts`: the demote moved *below* the damaged-container check. The rejected upload's `replaced_cover_image_id` is now `null`, because it genuinely replaced nothing. | `AC-08-recovery-01` (real Postgres row + real `createSiteRenderer` HTML) |
| **M-V4-01**, half 2: the rejected row blocked republication forever | `refusePublish()` refused on `images.find(i => i.status !== 'ready')` — *every* row on the article, including one nothing points at. With no `delete` grant on `article_images` and no route to remove a row, that block is permanent. | `src/api/publishArticle.ts`: a new `isRejectedAttempt()` predicate excludes a `failed` **cover** row when the article has a cover it can actually use beside it. Nothing else is excluded. | `AC-08-recovery-02` (200 + `status: published` read back from Postgres) |
| **M-V4-01**, the boundary it must not cross | — | `isRejectedAttempt()` is deliberately narrow: `failed` **body** images always block (they are embedded in the body), and a `failed` cover with no usable cover beside it *is* the article's cover and still blocks. | `AC-08-recovery-03` (control, was passing, still passing) |
| **M-V4-01**, the leg no test covers | After the writer uploads a *good* replacement, `demoteCurrentCover` demoted **all** cover rows, dragging the rejected `failed` one into the body slot — where it becomes an image the article is genuinely using again, and blocks publish forever. This is the verify report's own trace, and no committed test reaches it. | `src/api/repo.ts`: `demoteCurrentCover` demotes `role='cover' and status <> 'failed'`. A rejected attempt is never promoted into the body slot. | No committed test. Proven by hand, §3. |
| **M-V4-02**: upload ignored the draft lock | `handleUploadImage` never called `evaluateLock`. A writer refused `409 DRAFT_LOCKED` on publish walked in through upload and replaced a colleague's cover. | `src/api/uploadImage.ts`: the same `evaluateLock` call, in the same position publish puts it (after the rate-limit check), with the same envelope — `locked_by_writer_id` plus the holder's display name from `repo.getWriterDisplayName`. Returns before anything is inserted or stored. | `NFR-UPLOAD-LOCK-01` (409, correct `locked_by_writer_id`, **`rows_created: 0`**) |
| **M-V4-02**, the staleness control | — | `evaluateLock` is called, not re-implemented, so `LOCK_STALENESS_MS` applies unchanged. | `NFR-UPLOAD-LOCK-02` (control, 102 s → 201, was passing, still passing) |
| **M-V4-02**, the consumer half | `uploadArticleImage` declared `201/400/401/404/413/422/default` and no `409` at all, so Prism could not serve the branch and the client surfaced `INTERNAL_ERROR`. | `pdlc/arsene-cms/contracts/openapi.yaml`: a `'409'` response on `uploadArticleImage`, mirroring `openDraft`'s existing one verbatim — same `Error` schema ref, same `draftLocked` example, same writer id and display name. | `NFR-UPLOAD-LOCK-03` (real Prism mock generated from the contract at run time) |

### 2.1 Why the publish-side filter is a *cover*-only rule, and nothing broader

The obvious way to make `AC-08-recovery-02` green is `images.filter(i => i.status !== 'failed')`. `AC-08-recovery-03` exists precisely to
refuse that, and it does: a `failed` body image on a draft still answers
`409 IMAGE_NOT_READY`, which is AC-08's whole promise.

So the rule had to distinguish "a `failed` row still in active use" from "a
`failed` row that was never adopted, or has been superseded". The distinguishing
fact is that **only the cover has a slot another image can take over**. A body
image is referenced from the article's own HTML; nothing supersedes it. A cover
is a single slot, and after this pass a `failed` cover row means one of exactly
two things:

1. an upload that was rejected and therefore never took the slot (half 1 above
   guarantees the previous cover is still sitting there), or
2. an upload that took the slot, failed conversion asynchronously, and has since
   been superseded by a working one.

In both cases there is another `cover` row that is not `failed`, and in both
cases the rejected row is dead weight the writer cannot delete. When there is
*no* usable cover beside it — a fresh draft whose only cover upload failed, or a
cover that failed async conversion and has not been replaced yet — it *is* the
article's cover, it blocks, and the writer is told to replace it. That is AC-08
working as documented, and it is the first time it actually has.

### 2.2 The asynchronous-failure path, which the tests only reach obliquely

`AC-08-recovery-01`/`02` use `corruptedJpeg()`, which `isDamagedContainer()`
catches synchronously — so the tests pin the *synchronous* rejection path only.
The other path matters and was checked deliberately:

- **A file that passes the sync check and fails async conversion** still demotes
  the previous cover at upload time. That is not an oversight: `AC-06` in
  `tests/unit/uploadImage.test.ts` pins `replaced_cover_image_id` to the id
  `demoteCurrentCover()` returns *in the upload response*, so the demote cannot
  move to the Lambda status callback without changing an assertion, which this
  pass may not do. It is also defensible on its own terms — the writer asked for
  that file to become the cover, and it was accepted.
- The consequence is that between upload and the Lambda callback, a live
  article's cover is blank on the public site, and if conversion fails it stays
  blank and republication is refused `409 IMAGE_NOT_READY`. The refusal is
  correct (the cover the writer chose is broken). The blank window is
  pre-existing behaviour of *every* cover replacement, valid or not, and is not
  what M-V4-01 is about. Recorded, not fixed. See §6.
- What this pass *does* fix for that path is recovery: once a good replacement
  lands, the failed cover is superseded, publish goes through, and the failed row
  is never dragged into the body slot (the `repo.ts` change). Before this pass
  that article was unpublishable forever.

---

## 3. The verify report's trace, replayed by hand

The `repo.ts` demote guard closes the second half of `05-verification.v4.md`
§6's trace — the "a second writer uploads a GOOD replacement → still blocked"
leg — which **no committed test covers**. Writing a test for it was not in this
gate's remit (the red pass owns test authorship), so it was proven by hand
instead, with a throwaway script against the real spawned server, real Postgres
16 and the real render pass, deleted immediately after the run.

Verify v4's trace, and this run, side by side:

```
                                              05-verification.v4.md §6        this pass
live article, before:                         [cover/ready cover.jpg]         [cover/ready cover.jpg]
upload truncated.jpg as cover              -> 201 {"status":"failed"}         201 {"status":"failed"}
after:                                        [body/ready  cover.jpg,         [cover/ready  cover.jpg,
                                               cover/failed truncated.jpg]     cover/failed truncated.jpg]
public render pass sees this cover as:        null                            https://cdn.example/…/cover-optimized.webp
republish                                  -> 409 IMAGE_NOT_READY             200 OK
upload a GOOD replacement                  -> 201, converts to ready          201, converts to ready
after:                                        [… body/failed truncated.jpg,   [body/ready  cover.jpg,
                                               cover/ready  good.jpg]          cover/failed truncated.jpg,
                                                                               cover/ready  good.jpg]
republish AGAIN                            -> 409 IMAGE_NOT_READY  <- stuck   200 OK
public render pass sees this cover as:        (n/a)                           https://cdn.fantasycoach.example/…-optimized.webp
```

Verbatim from the run:

```
===TRACE===
live article, before:  [{"role":"cover","status":"ready","original_filename":"cover.jpg"}]
upload truncated.jpg as cover              -> 201 {"status":"failed"}
after:  [{"role":"cover","status":"ready","original_filename":"cover.jpg"},{"role":"cover","status":"failed","original_filename":"truncated.jpg"}]
public render pass sees this cover as:     https://cdn.example/a17dd6d6-4d61-4702-8b97-1d02d135eff3/cover-optimized.webp
republish                                  -> 200 OK
upload a GOOD replacement                  -> 201 {"status":"processing"}
after:  [{"role":"body","status":"ready","original_filename":"cover.jpg"},{"role":"cover","status":"failed","original_filename":"truncated.jpg"},{"role":"cover","status":"ready","original_filename":"good.jpg"}]
republish AGAIN                            -> 200 OK
public render pass sees this cover as:     https://cdn.fantasycoach.example/013339f4-ca55-4f3a-9871-d0b8b0662b20-optimized.webp
===END===
```

Two things in that output are worth saying out loud rather than leaving for the
next verify pass to find:

1. **The `truncated.jpg` row is still there, forever.** Nothing deletes it. See
   §6.1 — that is a deliberate, recorded trade-off, not an oversight.
2. **The article now has two rows with `role: 'cover'`.** AC-06's invariant is
   no longer "at most one `cover` row per article"; it is "at most one *usable*
   cover per article". Both readers of that slot agree on which one it is by
   filtering on `status`: `src/site/render.ts` already did
   (`role='cover' and status='ready'`), and `publishArticle.ts`'s
   `cover_image_url` was changed in this pass to do the same rather than take
   the first `role='cover'` row it found (which could have written an empty
   `cover_image_url` into `structured_data` — silently, exactly the class of bug
   `05-verification.v1.md` §6.4 caught). See §6.2 for who else reads that column.

---

## 4. Where each guard was put, and why there

**The lock check goes after the rate limiter, before the size check.** That is
the position `publishArticle.ts` puts it in: `refusePublish()` runs after
`rateLimiter.check`, and the lock is the first refusal inside it. Keeping the
two routes in the same order means a writer refused on one is refused on the
other for the same reason at the same point, which is the substance of M-V4-02.
It is also before every write: no `storage.put`, no `insertImage`, no
`demoteCurrentCover`. `NFR-UPLOAD-LOCK-01`'s `rows_created: 0` is what pins
that — a `409` returned after the insert would have replaced the colleague's
cover anyway and passed a status-only assertion.

**`auth.writer_id` is now required for upload, not just `auth.valid`.** The lock
decision needs to know who is asking. `handlePublishArticle` has required it
since it was written; `handleUploadImage` did not, because it never used the
value. Both `router.ts` branches (JWT and legacy static) already return a
`writer_id` whenever `valid` is true, so this narrows a type, not a behaviour —
and `NFR-AUTH-01` in `tests/unit/uploadImage.test.ts` still passes unchanged.

**`getWriterDisplayName` was made a required member of the production
`UploadDeps.repo`, not optional.** The red pass added it as *optional* on the
test-side seam so a fix building the envelope from `article.locked_by` alone
would also be admissible. The envelope publish actually emits carries the
holder's display name, and the contract's `draftLocked` example carries it on
all three operations, so upload emits it too. `router.ts` needed no change:
`uploadDeps()` already passes the whole `ctx.repo`, which has had
`getWriterDisplayName` since publish needed it.

**The demote guard went in `repo.ts`, not in the handler.** `demoteCurrentCover`
is a single `update … where` — "demote the cover the article is using" is the
statement's own business, and expressing it as one extra SQL predicate is
smaller and racier-proof than fetching rows into the handler to decide. It is
also the only place that can express it: the handler does not read the image
list on this path at all.

---

## 5. Coverage — measured, with the parts that are not measurable named

```
$ npx vitest run --coverage
```

```
 Test Files  33 passed (33)
      Tests  206 passed (206)

 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   82.93 |    85.71 |   86.76 |   82.93 |
 api               |   76.03 |    80.84 |    78.2 |   76.03 |
  auth.ts          |     100 |      100 |     100 |     100 |
  client.ts        |   97.64 |    73.68 |     100 |   97.64 | 91,97
  createDraft.ts   |    84.9 |     37.5 |     100 |    84.9 | 50-51,79-80,84-87
  http.ts          |     100 |      100 |     100 |     100 |
  imageStatus.ts   |     100 |    93.33 |     100 |     100 | 82
  ...ishArticle.ts |   98.87 |    96.07 |     100 |   98.87 | 201,251
  rateLimit.ts     |   57.14 |      100 |      50 |   57.14 | 24-29
  repo.ts          |   60.15 |    60.86 |   61.53 |   60.15 | ...15-221,224-246
  router.ts        |   57.72 |    68.49 |   67.74 |   57.72 | ...54-556,558-561
  server.ts        |      98 |    88.23 |     100 |      98 | 54
  serverMain.ts    |       0 |        0 |       0 |       0 | 1-59
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
  render.ts        |   97.89 |       96 |     100 |   97.89 | 137-138
 telemetry         |     100 |      100 |     100 |     100 |
-------------------|---------|----------|---------|---------|-------------------
```

Movement against v4 (82.79 / 85.68 / 86.66): **+0.14 statements, +0.03 branch,
+0.10 functions.** Effectively flat, which is the honest reading — this pass
added roughly twenty lines of production code and the tests that force them run
mostly out of process.

### 5.1 What this pass added, and whether it is covered

| New code | Covered in-process? | By what |
|---|---|---|
| `uploadImage.ts` — the `evaluateLock` call and the `409 DRAFT_LOCKED` envelope | **Yes**, both branches | `NFR-UPLOAD-LOCK-01` (refused) and `NFR-UPLOAD-LOCK-02` (stale → allowed), plus every existing `uploadImage` test taking the "I hold the lock" branch |
| `uploadImage.ts` — the reordered demote / `replaced_cover_image_id: null` | Partly | The `AC-08` corrupted-file unit test runs the rejection branch in-process; that the *demote* no longer happens on it is asserted only by `AC-08-recovery-01`, out of process |
| `uploadImage.ts` — `auth.writer_id === undefined` in the 401 guard | The `!auth.valid` half only | No fake or router path produces `valid: true` with no `writer_id`, so the second half of the `||` is defensive and unreached. Honest label: unreachable-by-construction today, one line, kept because the type otherwise forces a non-null assertion |
| `publishArticle.ts` — `isRejectedAttempt()` | **Function yes, superseding branch no** (line 201) | Every in-process publish test short-circuits on `role`/`status` before the `.some(…)` callback. The callback is exercised only by `AC-08-recovery-02`, which runs against the spawned server, so v8 cannot see it |
| `publishArticle.ts` — the `status === 'ready'` cover pick | Yes for the found case; line 251 (the `?? ''` fallback) no | Same fallback that was uncovered at v4 (then line 223); it has simply moved |
| `repo.ts` — `and status <> 'failed'` on the demote | **No** (lines 215-221) | `tests/db/remediation.test.ts` drives `createRepo` in process, which is why `repo.ts` reads 60% and not 0% — but nothing in it calls `demoteCurrentCover`. Every caller of that method is the spawned server. Behaviourally proven by hand in §3 and by nothing else |

That is the whole answer to "is 82.93% with the error paths covered": the two
error paths this pass created (`409 DRAFT_LOCKED`, and the rejected-attempt
exclusion) are both asserted, but only one of them is asserted *in process*.
`publishArticle.ts` fell from 100% to 98.87% for exactly that reason, and I would
rather say so than move the assertion to a unit test that could not have caught
the bug — which is `AC-08-recovery-03`'s stated reason for existing.

### 5.2 What is uncovered, and whether it matters

Unchanged from v4 in substance; restated so this document stands alone.

- **`serverMain.ts` — 0%.** The deployable entry point. Its behaviour is
  asserted end to end (`NFR-FAILCLOSED-01a`/`b` spawn it as a real child
  process), but a child process is invisible to v8 instrumentation. This is the
  single largest contributor to the overall figure being 83 rather than 90, and
  it is a measurement artefact, not an untested file. **Still true**: nothing in
  it is covered *as measured*, including L-V4-02's `SUPABASE_JWT_ISSUER=""` trap,
  which remains open and out of scope this pass.
- **`router.ts` — 57.72%** and **`repo.ts` — 60.15%.** Same artefact: both run
  almost entirely inside the spawned server for e2e/provider tests (the
  in-process part of `repo.ts` is what `tests/db/remediation.test.ts` drives
  directly). `repo.ts`'s uncovered range still includes my demote guard (§5.1).
- **`rateLimit.ts` — 57.14%.** The eviction/sweep path is only reached after a
  full window elapses; the limiter's decisions are covered by
  `NFR-RATE-01a`–`d`. Matters little; a leak there is a memory concern on a
  5-writer deployment.
- **`createDraft.ts` — 37.5% branch.** Pre-existing, unchanged, and the weakest
  number in the table. It is not this pass's finding, but it is the file I would
  point the next red gate at first after M-V3-04.
- **`heic.ts` — 60% branch**, **`format.ts` lines 50-52.** Pre-existing decoder
  edge branches; `format.ts` 50-52 is the damaged-container path for a format
  the fixtures do not produce a truncated example of.

---

## 6. Deviations, and things left honestly open

### 6.1 Orphaned `failed` rows accumulate, with no way to remove them

**This is a deliberate, accepted trade-off, and it is the exact thing
`03-red-evidence.v5.md` §5.2 said would survive any fix that passes these
tests.** The verify report named three repairs; this pass took the first two
(reorder the demote, scope the readiness check) and not the third (a scoped
`delete` grant plus a route). So:

- every rejected cover upload leaves a `failed` row on the article, forever;
- `authenticated` still has no `delete` grant on `article_images`
  (`db/migrations/0001_initial_schema.sql` grants `select` + `update (role,
  alt_text)`), and no route removes a row;
- the rows are harmless to publication and to the public site after this pass —
  publish ignores them, the render pass never selected them — but they are
  visible to any direct PostgREST read the editor SPA does, and they grow
  without bound in proportion to how often writers fat-finger a file.

I did not add the grant or the route because no test asks for it and adding a
`delete` capability is a security-surface decision (which rows? whose?) that
belongs to a red gate with an adversary looking at it, not to an implementer
inferring it. It should be a finding in the next verify pass if it is not
scheduled first.

### 6.2 AC-06's invariant changed shape, and one reader is outside this repo

"At most one image with `role: cover` per article" is now "at most one *usable*
cover per article": a `failed` cover row can sit beside the real one (§3). Every
reader inside this repo disambiguates on `status` — `src/site/render.ts` always
did, `publishArticle.ts` now does. The contract text for `uploadArticleImage`
and `publishArticle` was updated to say so.

The reader I cannot see is the editor SPA's direct PostgREST reads, which
`contracts/openapi.yaml` explicitly puts out of scope ("the writer overrides
[alt text] afterward via a direct PostgREST `PATCH`… out of scope of this
contract"). If it lists an article's images with `role=eq.cover` and expects
exactly one row, it will now sometimes get two. There is no test in this repo
that can catch that, and I am recording it rather than guessing at the SPA's
queries.

### 6.3 A cover replacement still blanks a live article's cover while it converts

Covered in §2.2. Uploading *any* new cover to a published article — a good one
included — demotes the current cover immediately, so between the upload and the
Lambda callback the live page has no cover, and if conversion fails
asynchronously it stays that way until the writer uploads a replacement. That is
pre-existing behaviour, it is pinned in place by `AC-06`'s assertion on
`replaced_cover_image_id` in the upload *response*, and M-V4-01 is about the case
where the file was rejected outright — which is now fixed. Moving the demote to
the status callback would close the remaining window, but it changes an
assertion and therefore belongs to a red gate.

### 6.4 Contract prose changed, not just the response list

Beyond the new `409` on `uploadArticleImage` (which `NFR-UPLOAD-LOCK-03`
required), I edited two description blocks in
`pdlc/arsene-cms/contracts/openapi.yaml`:

- `publishArticle`'s AC-08 paragraph said `409 IMAGE_NOT_READY` fires if "any
  image attached to the article" is not `ready`. After §2's change that is no
  longer true, so the paragraph now says "any image the article is actually
  using" and spells out the single exception and why it exists.
- `uploadArticleImage`'s cover-uniqueness paragraph gained one sentence — a
  rejected file demotes nothing — and the AC-05 locking paragraph publish and
  open already carried.

Prose in the contract is not machine-checked by anything in the suite, so
leaving it stale would have been invisible in CI and wrong in the document
writers read. Flagged here because a description change is still a contract
change.

### 6.5 Nothing else was touched

No new configuration, no new module, no abstraction over the two call sites of
`evaluateLock`, no delete/cleanup machinery, no change to
`tests/support/seams.ts`' optional `getWriterDisplayName` (the production type
requires it; the seam stays optional, which is a superset and type-checks). The
v3/v4 backlog — M-V3-04 (`CDN_ORIGIN`), L-V4-01, L-V4-02, I-V4-01…04 — is
untouched and still open.

---

## 7. Files changed

| File | Change | Why |
|---|---|---|
| `src/api/uploadImage.ts` | `evaluateLock` + `409 DRAFT_LOCKED` after the rate-limit check; `auth.writer_id` required; `demoteCurrentCover()` moved below `isDamagedContainer()`; rejected uploads carry `replaced_cover_image_id: null`; `getWriterDisplayName` added to `UploadDeps.repo` | M-V4-02 in full; M-V4-01 half 1 |
| `src/api/publishArticle.ts` | `isRejectedAttempt()` predicate excludes a superseded/never-adopted `failed` **cover** from the readiness gate; `cover_image_url` now reads the `ready` cover rather than the first `role='cover'` row | M-V4-01 half 2, and the `structured_data` consequence of two cover rows existing |
| `src/api/repo.ts` | `demoteCurrentCover` demotes `role='cover' and status <> 'failed'` | M-V4-01: stops a rejected row being promoted into the body slot by a later good upload — the leg of the verify trace no test covers (§3) |
| `pdlc/arsene-cms/contracts/openapi.yaml` | `409 DRAFT_LOCKED` on `uploadArticleImage`, mirroring `openDraft`'s verbatim; two description blocks corrected (§6.4) | `NFR-UPLOAD-LOCK-03` fails without the response; the prose would otherwise be stale |

No test file, no `db/migrations/*`, no `state.json`, no `router.ts` (the deps it
builds already carried everything the new code needs). Nothing committed.

---

## 8. Gate statement

206 tests, 206 passing, 33 files, against real Postgres 16 (Testcontainers), a
real spawned child-process server over real HTTP with real multipart image
bytes, the real public render pass, a real Prism mock generated from the
contract, and real Schemathesis provider fuzzing. `tsc --noEmit` clean. Four
production/contract files changed, ~25 lines of behaviour. No test assertion
edited, added or removed. Coverage 82.93% statements / 85.71% branch, flat
against v4, with the one file that regressed (`publishArticle.ts`, 100% → 98.87%)
named and explained rather than smoothed over. Two Medium findings closed; one
accepted trade-off (§6.1), two pre-existing gaps re-recorded (§6.2, §6.3), and
the v3/v4 backlog untouched and still open. Green.
