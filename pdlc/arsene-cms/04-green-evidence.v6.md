# arsene-cms — Green gate, sixth remediation pass (v6)

> Gate 4 (green), run a sixth time. This document covers **only** the sixth
> remediation pass: the production code that turns `03-red-evidence.v6.md`'s
> eight failing tests green, for `05-verification.v5.md`'s five Medium findings
> — **M-V5-01**, **M-V5-02** and **M-V5-03** (one fix family), **M-V5-04** (one
> idempotency key shared between publish and upload) and **M-V5-05** (duplicate
> titles colliding on the unique slug) — plus **M-V3-04** (`CDN_ORIGIN`
> hardcoded to a reserved `.example` placeholder), scheduled off the v3 backlog
> by the product owner after three verify passes carried it forward.
>
> Out of scope, exactly as the red pass scoped it: L-V5-01 (accumulation DoS),
> L-V5-02 (two clocks, one lock window), L-V5-03 (`createDraft`/`open` unrated),
> L-V5-04 (character vs UTF-16 length), I-V5-01 … I-V5-03, and the remaining
> v3/v4 backlog (M-V3-02, M-V3-03, N5/N5b, N2). None of it is touched here, and
> none of it is closed. In particular the idempotency store still has **no
> TTL** (§6.4).

**Status:** green | **Author:** Claude (Opus 5), written by `bob-implementer` |
**Date:** 2026-08-16 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `57fa2dd`) | **Starting point:** the red-v6 suite —
**216 tests, 8 failing, 208 passing, 36 files**, re-confirmed by the product
owner before a line of production code was written.

---

## 1. The commands, and their output

### 1.1 The full suite

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  36 passed (36)
      Tests  216 passed (216)
   Start at  21:56:06
   Duration  52.46s (transform 1.41s, setup 0ms, collect 15.23s, tests 259.96s, environment 11ms, prepare 3.88s)
```

216/216, 36/36 files. Run four times end to end during this pass (twice bare,
twice under `--coverage`); every run was 216/216. `NFR-IMGCPU-01` — the
wall-clock flake documented at every prior pass — did not fire once, so no
isolation re-run was needed:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo … is converted well inside a one-second budget … 776ms
```

The eight tests that were red, now verbatim from the run:

```
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes — a file the product refused was never embedded in the body, so it cannot leave behind a row that blocks publishing forever, exactly as for a rejected cover
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-05: a cover still converting when a second cover upload supersedes it, and which the Lambda only then reports as failed, does not block republication either — the outcome of an upload is decided after the slot was taken, so a guard read at the moment of the upload cannot see it 371ms
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article — the readiness gate may not be decided by a column any writer can write
 ✓ tests/e2e/publishCollisions.test.ts > … > NFR-IDEM-03a: an image upload that reuses the Idempotency-Key an earlier publish of the same article used is still performed, and is answered as an upload … 306ms
 ✓ tests/e2e/publishCollisions.test.ts > … > NFR-IDEM-03b: a publish that reuses the Idempotency-Key an earlier image upload of the same article used really publishes the article … 368ms
 ✓ tests/e2e/publishCollisions.test.ts > … > AC-14-collision-01: publishing a second article whose title matches an already-published one succeeds and gets its own distinct slug …
 ✓ tests/e2e/cdnOriginConfig.test.ts > … > NFR-CDN-CONFIG-01: a status callback whose optimized_url is on this deployment’s own configured CDN origin is accepted and the converted asset is really stored …
 ✓ tests/e2e/cdnOriginConfig.test.ts > … > NFR-CDN-CONFIG-02: a status callback whose optimized_url is on the shipped `.example` placeholder — which is not this deployment’s origin — is refused on the body alone with the row untouched …
```

And the four controls that had to stay green — the two the red pass added, plus
the two the earlier passes added for the same fix family:

```
 ✓ tests/e2e/rejectedImageRecovery.test.ts > … > AC-08-recovery-06: a body image the article is genuinely still using — stored, referenced from its own body_html, and broken — does keep refusing the publish, 409 IMAGE_NOT_READY …
 ✓ tests/e2e/publishCollisions.test.ts > … > NFR-IDEM-03c: replaying the very same upload — same operation, same key, same article — still returns the original response and still creates nothing new …
 ✓ tests/e2e/coverReplacementRecovery.test.ts > … > AC-08-recovery-02: after a truncated cover upload is rejected, the article still republishes …
 ✓ tests/e2e/coverReplacementRecovery.test.ts > … > AC-08-recovery-03: an image the article is genuinely still using and that failed to convert does keep refusing the publish, 409 IMAGE_NOT_READY …
```

### 1.2 Types

```
$ npx tsc --noEmit
TSC_EXIT=0
```

### 1.3 What was touched

```
$ git status --short
 M pdlc/arsene-cms/contracts/internal-openapi.yaml
 M pdlc/arsene-cms/contracts/openapi.yaml
 M src/api/publishArticle.ts
 M src/api/repo.ts
 M src/api/router.ts
 M src/api/server.ts
 M src/api/serverMain.ts
 M tests/support/fakes.ts
 M tests/support/seams.ts
```

Nine files. **Two of them are under `tests/`, and that is a deviation I am
flagging up front rather than burying: `tests/support/seams.ts` and
`tests/support/fakes.ts` each gained one additive collaborator (`takenSlugs`)
for M-V5-05.** No test file was edited; no assertion was relaxed, reworded,
reordered or deleted; nothing under `tests/unit`, `tests/e2e`, `tests/db`,
`tests/contract` or `tests/telemetry` was touched at all. The full reasoning,
and the alternative I rejected, is §6.1. `db/migrations/*` untouched.
`state.json` untouched. Nothing committed.

---

## 2. Every finding, what closed it, and the tests that prove it

| Finding | The defect | The change | Proved by |
|---|---|---|---|
| **M-V5-01** — a rejected `body` upload blocks republication forever | `isRejectedAttempt()` excluded a `failed` row only when `image.role === 'cover'`. A synchronously-rejected body upload has `original_url: null` on every path, so it was never embeddable — but it counted | `src/api/publishArticle.ts`: the readiness gate's predicate is now `articleDependsOn()`, and its first clause excludes any row with **`original_url is null`**, whatever its `role` | `AC-08-recovery-04` (200 + `published_at` moved, read from Postgres) |
| **M-V5-02** — a `processing` cover, demoted and only *then* failing | `demoteCurrentCover()`'s `status <> 'failed'` guard was read at demote time; the outcome arrives later, from ADR-0004's callback | `articleDependsOn()`'s second clause excludes any row named by another row's **`replaced_cover_image_id`** — a server-written record of the slot takeover, taken at demote time but *read* at publish time, after the outcome exists. `src/api/repo.ts`: the demote now matches every `role='cover'` row, so the record is always made (§2.2) | `AC-08-recovery-05` (real multipart upload + real `POST /internal/images/{id}/status` + real publish, all through product routes) |
| **M-V5-03** — the gate keyed on a writer-writable column | `role` is the one `article_images` column `authenticated` may write (`grant update (role, alt_text)`), and green v5 made the publish decision depend on it | Neither clause of `articleDependsOn()` reads `role`. The `grant` is unchanged — the gate simply stopped trusting it | `NFR-IMAGE-ROLE-01` (`update … set role='cover'` executed **as `authenticated`** through real RLS, then 409) |
| **M-V5-04** — one key, two operations | `createIdempotencyStore()` keyed on `${key}::${article_id}`; the same store object was handed to `publishDeps()` and `uploadDeps()` | `src/api/router.ts`: the factory now returns a **per-operation view** over one map, keyed `${operation}::${key}::${article_id}`; `publishDeps` takes `'publish'`, `uploadDeps` takes `'upload'` | `NFR-IDEM-03a` (upload really happens, 1 image row), `NFR-IDEM-03b` (`articles.status = 'published'`), `NFR-IDEM-03c` (genuine replay still replays) |
| **M-V5-05** — two articles, one title, permanent 500 | `generateSlug(article.title)` was called with no `existingSlugs`, so `seo.ts`'s dedup branch was dead at the only call site that matters, and the `23505` was unmapped | `src/api/repo.ts`: a new `takenSlugs(base_slug)` (`slug = $1 or slug like $1 || '-%'`). `src/api/publishArticle.ts`: `uniqueSlug()` feeds them to `generateSlug` **before** `structured_data` is built, so the slug in the row, the response, the canonical URL and the sitemap entry are all the same one | `AC-14-collision-01` (second publish 200, distinct non-empty slug, `status: published`) |
| **M-V3-04** — CDN origin hardcoded to a reserved TLD | `const CDN_ORIGIN` was compile-time, and `isCdnUrl` compared against it | `ServerOptions.cdnOrigin` (optional, `DEFAULT_CDN_ORIGIN` when unset) → `server.ts` spawn `env.CDN_ORIGIN` → `serverMain.ts` `process.env.CDN_ORIGIN`, exactly the path `jwtSecret`/`imageCallbackSecret`/`jwtIssuer` already take. `imageStatusBody(cdnOrigin)` builds the zod schema once per server; `createObjectStore(cdnOrigin)` writes URLs on the same origin | `NFR-CDN-CONFIG-01` (configured origin accepted, row `ready`, URL stored), `NFR-CDN-CONFIG-02` (the placeholder refused `400`, row untouched) |

### 2.1 The readiness gate, in full

```ts
function articleDependsOn(image: ImageRecord, images: ImageRecord[]): boolean {
  return (
    image.original_url !== null &&
    !images.some((other) => other.replaced_cover_image_id === image.id)
  );
}
```

Two exclusions, both keyed on server-written columns, neither reading `role`.
The four cases the suite pins, and why each lands where it does:

| Case | `original_url` | superseded? | Gate |
|---|---|---|---|
| `AC-08-recovery-04` — rejected `body` upload | `null` | no | **excluded** — nothing was ever stored, so nothing was ever embedded |
| `AC-08-recovery-05` — slow cover, demoted, then failed | present | **yes** (the second upload named it) | **excluded** |
| `AC-08-recovery-03` / `-06` — a `failed` image the article genuinely uses | present | no | **counted → 409**, which is AC-08's whole promise |
| `NFR-IMAGE-ROLE-01` — the same row, `role` flipped to `cover` by a writer | present | no | **counted → 409**; the flip changes nothing the gate looks at |

The last two rows are structurally identical in `article_images` to
`AC-08-recovery-05` *except* for `replaced_cover_image_id`. That is not an
accident of the fixtures — it is the load-bearing fact. `AC-08-recovery-03`'s
seeded row is adopted, `failed`, and **not** referenced from the article's own
`body_html`; so "is it referenced from the body HTML?" cannot be the
discriminator (it would turn `AC-08-recovery-03` green-by-publishing, which is
exactly the regression its control exists to catch). Supersession is the only
signal that separates "the slot was taken over by a real upload" from "a writer
renamed a row", and it is the only one the writer cannot forge directly.

### 2.2 A regression I introduced, found by hand, and closed before shipping

Dropping the `role`-keyed rule silently lost a case the old rule *did* handle,
and which no committed test covers:

```
article with cover X (adopted, processing)
  Lambda reports X failed                     -> X = cover/failed, adopted
  publish                                     -> 409 IMAGE_NOT_READY   (correct: the only cover is broken)
  upload a GOOD replacement cover Z           -> demote skipped X, because X.status = 'failed'
  Z converts to ready
  publish                                     -> 409 IMAGE_NOT_READY   <- permanent
```

The old `isRejectedAttempt()` excluded X (`failed` cover next to a non-`failed`
cover). The new predicate would not have: X is adopted, and with the v5 demote
guard (`status <> 'failed'`) nothing ever superseded it. That is M-V4-01's
permanent block, reintroduced through a different door.

Proved by hand against real Postgres and the real spawned server, with a
throwaway test file created, run, and **deleted** (it is not in the tree):

```
$ npx vitest run tests/e2e/scratchManualProof.test.ts     # demote guard = status <> 'failed'
AssertionError: expected { … "republish": 409 } to deeply equal { … "republish": 200 }
  Object {
    "article": "published",
    "callback": 200,
    "refused_while_only_cover_broken": 409,
-   "republish": 200,
+   "republish": 409,
  }

$ npx vitest run tests/e2e/scratchManualProof.test.ts     # demote guard removed
 ✓ MANUAL: a cover that fails BEFORE its replacement is uploaded does not block republication either 366ms
```

The fix is one clause in `repo.ts`: `demoteCurrentCover()` now matches every
`role='cover'` row on the article, `status` notwithstanding, so the takeover is
always recorded. Green v5 added the `status <> 'failed'` guard to stop a
rejected upload being *promoted* into the body slot; that reason no longer
applies, because a row nothing was ever stored for is now excluded whatever
slot it sits in. Rejected uploads still never displace a working cover — the
upload route returns before `demoteCurrentCover()` is reached for a file it is
refusing (`uploadImage.ts`'s `isDamagedContainer` branch), which is what
`AC-08-recovery-01` pins and which still passes.

This is also the one place my implementation departs from the direction both
verify agents recommended — see §6.2.

### 2.3 `AC-14-collision-01` does **not** interact with the image family

Asked explicitly, and checked explicitly: **no.** The two live in different
parts of `publishNow`, touch disjoint state, and neither reads the other's
inputs.

- `articleDependsOn()` runs inside `refusePublish()`, over `article_images`
  rows, and decides only whether to return `409 IMAGE_NOT_READY`.
- `uniqueSlug()` runs inside `publishNow()`, after every refusal has already
  been cleared, over `articles.slug`, and decides only the slug string.

`AC-14-collision-01`'s two fixtures each have exactly one `ready` cover and no
other image rows, so the gate is a no-op for them; the image-family fixtures
have distinct titles and pre-seeded slugs, so `uniqueSlug()` is never even
called for the ones that are already published (`article.slug ?? …`
short-circuits). The only shared surface is that both changes touch
`publishArticle.ts` — and, incidentally, that `takenSlugs` made `PublishDeps`
grow a collaborator, which is why §6.1 exists. They were implemented,
validated and can be reverted independently.

---

## 3. Where each change was put, and why there

**The readiness rule stayed in `publishArticle.ts`, not in `repo.ts`.** It is a
publish-time policy decision ("does this article depend on this image?"), and
the handler is where every other publish refusal is decided and unit-tested. A
repository-level filter would also have made `AC-08-recovery-06` unfalsifiable:
a fix that filtered rows out of `getArticleImages` looks identical from the
handler's side.

**The supersession record stayed in `repo.ts`.** `replaced_cover_image_id`
already existed, was already server-written, was already returned to the caller
in the upload response, and is already documented in the public contract's
"Cover uniqueness" paragraph. Nothing new was invented for it — it was being
computed and stored and then never read. Notably, the contract's prose ("*any*
image that was previously this article's cover") described the demote *without*
the v5 status guard; the guard was the thing that disagreed with the contract,
and removing it brings the two back into line.

**The idempotency scope stayed in `router.ts`.** The store is a private closure
there, handed to both handlers; that sharing *is* the defect. Making the factory
return a per-operation view keeps one map (so one eviction story, whenever a TTL
finally lands) while making the namespace explicit at each call site —
`ctx.shared.idempotency('publish')` / `('upload')`. The handlers' own
`idempotency` dependency type is unchanged, so `NFR-IDEM-01`/`02` still test
exactly what they tested.

**The slug lookup went through the handler, not inside `markPublished`.**
Tempting to catch `23505` in the repository and retry with a suffix — but the
slug is baked into `structured_data`, `canonical_url` and the sitemap entry
*before* the UPDATE runs. A repository-level retry would have persisted a
`structured_data` blob whose canonical URL pointed at the slug the article did
not get. Resolving the slug first is the only ordering that keeps all four
consistent, and `AC-14-collision-01` would not have caught the difference.

**The CDN origin went through `ServerOptions` → spawn `env` → `serverMain.ts`.**
`tests/e2e/deployedAuthBoundary.test.ts` exists because this repo already
shipped an advertised option that the spawn silently dropped (`jwtSecret`). The
red pass supplied the origin **both** as an option and as `process.env.CDN_ORIGIN`
so either mechanism would pass; both are wired, because the option is what a
caller reads in `ServerOptions` and the environment variable is what a real
deployment sets. The zod schema is built once, in `startHttpServer`, and lives
on `Shared` — the origin is per-server, not per-request, and rebuilding a
discriminated union on every callback would be waste.

---

## 4. Coverage — measured, with the parts that are not measurable named

```
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run --coverage
```

```
 Test Files  36 passed (36)
      Tests  216 passed (216)

 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |    82.6 |    86.32 |   87.59 |    82.6 |
 api               |   75.65 |    81.95 |   79.74 |   75.65 |
  auth.ts          |     100 |      100 |     100 |     100 |
  client.ts        |   97.64 |    73.68 |     100 |   97.64 | 91,97
  createDraft.ts   |    84.9 |     37.5 |     100 |    84.9 | 50-51,79-80,84-87
  http.ts          |     100 |      100 |     100 |     100 |
  imageStatus.ts   |     100 |    93.33 |     100 |     100 | 82
  ...ishArticle.ts |   99.44 |    98.03 |     100 |   99.44 | 287
  rateLimit.ts     |   57.14 |      100 |      50 |   57.14 | 24-29
  repo.ts          |   57.85 |    60.86 |   57.14 |   57.85 | ...38-244,247-269
  router.ts        |   57.46 |    69.33 |   73.33 |   57.46 | ...86-588,590-593
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
  render.ts        |   97.89 |       96 |     100 |   97.89 | 137-138
 telemetry         |     100 |      100 |     100 |     100 |
  events.ts        |     100 |      100 |     100 |     100 |
-------------------|---------|----------|---------|---------|-------------------
```

Against green v5 (82.93 / 85.71 / 86.76 / 82.93):

| | v5 | v6 | |
|---|---|---|---|
| Statements | 82.93 | **82.60** | −0.33 |
| Branch | 85.71 | **86.32** | +0.61 |
| Functions | 86.76 | **87.59** | +0.83 |

Statements dipped because `repo.ts` gained a method (`takenSlugs`, 7 statements)
that v8 structurally cannot see (§4.2), and `router.ts` grew. Branch and
function coverage rose, which is the honest signal here: the new decisions are
mostly *branchless* (`articleDependsOn` is two conditions with no early return
that tests miss), and `server.ts`'s new spawn branch is genuinely exercised.

### 4.1 What this pass added, and whether it is covered

| Added | Covered by v8? | Notes |
|---|---|---|
| `publishArticle.ts` — `articleDependsOn()` | **Yes, both clauses, both outcomes.** File went 98.87% → **99.44%** stmts, **98.03%** branch | Unlike v5's `isRejectedAttempt`, this predicate is reached in-process by the unit refusal table (`AC-08a`, `AC-08b`, `DEC-01`) as well as end-to-end, so v8 sees it |
| `publishArticle.ts` — `uniqueSlug()` | **Yes**, in-process, on every unit publish test (the fake returns `[]`) | The *collision* branch of `generateSlug` is covered by `PROP-02` at the pure-function level and end-to-end by `AC-14-collision-01`; v8 cannot attribute the latter (§4.2) |
| `repo.ts` — `takenSlugs()` | **No** (inside the `…238-244` uncovered range) | Every caller is the spawned server. Behaviourally proved by `AC-14-collision-01` |
| `repo.ts` — the widened `demoteCurrentCover` | **No** (same range, same reason) | Behaviourally proved by `AC-08-recovery-05`; the regression it prevents is proved by hand in §2.2 and by nothing in the committed suite (§6.3) |
| `repo.ts` — the two new `select` columns | **No** (same range) | If they were missing, `AC-08-recovery-04`/`05` would fail immediately — `original_url` would be `undefined`, not `null` |
| `router.ts` — per-operation idempotency views | **No** (`router.ts` is 57%, §4.2) | Proved by `NFR-IDEM-03a`/`03b`/`03c` |
| `router.ts` — `imageStatusBody(cdnOrigin)` / `createObjectStore(cdnOrigin)` | **No** (same) | Proved by `NFR-CDN-CONFIG-01`/`02` |
| `server.ts` — `CDN_ORIGIN` spawn forwarding | **Yes.** File went 98 → **100%** stmts, 88.23 → **95%** branch | `cdnOriginConfig.test.ts` passes the option, so both sides of the new ternary are hit. The one branch still uncovered is line 56, `jwtIssuer` — pre-existing, not mine |
| `serverMain.ts` — `cdnOrigin: process.env.CDN_ORIGIN` | **No, and it can never be** — the file reads 0% and always has | It *is* the child process; v8 instruments the parent. This is precisely why `NFR-CDN-CONFIG-01` was written to run through the spawn |

### 4.2 What is uncovered, and whether it matters

- **`serverMain.ts` — 0%.** Unchanged and unchangeable in this harness: the
  file is the entry point of a spawned child, so no in-process instrumentation
  can attribute a line of it. Four end-to-end suites (`deployedAuthBoundary`,
  `failClosedConfig`, `heicDeployedRuntime`, and now `cdnOriginConfig`) exist
  specifically because 0% here means "prove it through the boundary instead".
  **It matters, and it is covered — just not by v8.**
- **`router.ts` — 57.46%** and **`repo.ts` — 57.85%.** Same artefact: both run
  almost exclusively inside the spawned server. `repo.ts` reads 57 rather than 0
  because `tests/db/remediation.test.ts` drives `createRepo` directly, and it
  does not call `demoteCurrentCover` or `takenSlugs`. Every line I added to
  either file sits inside those unattributed ranges. The behaviours are pinned
  end-to-end; what is genuinely *not* pinned is enumerated in §6.3.
- **`publishArticle.ts` line 287** — the `?? ''` fallback on `cover_image_url`
  when no `ready` cover exists. Unreachable through the handler (a publish with
  no ready cover is refused earlier by `COVER_IMAGE_REQUIRED` or the readiness
  gate); it is defensive typing, not a path. Same line as v4/v5 flagged, just
  moved. Does not matter.
- **`createDraft.ts` branch 37.5%** and **`rateLimit.ts` 57%** — pre-existing,
  untouched, and unrelated to this pass. Recorded so the number is not read as
  a change.
- **Error paths specifically.** The refusal table in
  `tests/unit/publishArticle.test.ts` covers every documented `error.code` on
  publish, and `publishArticle.ts` is at 99.44/98.03 — the error paths on the
  file this pass changed most are the *best*-covered part of it. The weakest
  error coverage in the repo remains `createDraft.ts`'s 37.5% branch, which
  this pass neither improved nor worsened.

---

## 5. The verify report's traces, replayed

Every trace in `05-verification.v5.md` §3–§5 is now executed as a committed
test, end to end, against real infrastructure — that is what the red pass
bought, and I did not need to re-prove them by hand. The one trace that is
**not** a committed test is the regression I found in §2.2, which I proved by
hand and then closed. Three points worth recording:

1. **`AC-08-recovery-05` really does exercise the asynchronous ordering.** The
   second cover genuinely converts (`second_cover: 'ready'` comes from polling
   the row, not from the response), and the first cover's failure arrives
   afterwards over `POST /internal/images/{id}/status` with the real shared
   secret (`callback_status: 200`, `slow_cover: 'failed'`). The 200 on that
   callback also confirms the demote left the row in `processing` — `repo.ts`'s
   `SET_IMAGE_STATUS_SQL` refuses any row that has already settled.
2. **`NFR-IMAGE-ROLE-01`'s write really lands.** The test wraps it in
   `.catch(() => undefined)` so that revoking the grant would be an equally
   valid fix; I did not revoke it, so the `update … set role='cover'` executed
   as `authenticated` genuinely succeeded, and the article afterwards has two
   `role='cover'` rows. The 409 is therefore the gate ignoring `role`, not the
   database refusing the write. (Confirmed by the shape of the failure before
   the fix: the same test returned `200 / published`.)
3. **`NFR-IDEM-03a` proves the *file* survived, not just the response.** It
   counts `article_images` rows for the uploaded filename. A fix that only
   changed what was returned would still have discarded the 4 MB upload.

---

## 6. Deviations, and things left honestly open

### 6.1 Two test-support files were edited, additively — the deviation I most want reviewed

`publishArticle.ts` needed a new repository collaborator to answer "which slugs
are taken?". `tests/support/fakes.ts` builds `PublishDeps` as an object literal
typed by `tests/support/seams.ts`, so a required production method that the fake
does not implement is a runtime `TypeError` in every unit publish test, and
adding it to the fake is an excess-property error unless the seam declares it.
Hence one line in each:

- `tests/support/seams.ts`: `takenSlugs?(base_slug: string): Promise<string[]>`
  — **optional**, so every pre-existing caller of the seam is unchanged and a
  different fix (mapping `23505` and retrying) remains admissible.
- `tests/support/fakes.ts`: `takenSlugs: async () => []` — nothing is taken, so
  every pre-existing expectation about the slug a publish produces is bit-for-bit
  unchanged.

**The alternative I rejected**, and why: make the method optional in production
too and fall back to `?? []`. That needs no test-support edit at all, but it
adds a production branch that no deployment ever takes and that exists purely
to satisfy a fake — speculative generality dressed as caution. Given the choice
between an untested dead branch in `src/` and one additive line in a fake, I
took the fake. The precedent is this repo's own: `getWriterDisplayName` is
declared optional in the upload seam and provided by the same fake for exactly
this reason, added by the red-v5 pass with an inline comment saying so. I have
matched that comment style.

**No assertion was touched.** If the reviewer disagrees with the principle, the
mechanical alternative above is a five-line change and I will make it.

### 6.2 I did not narrow the demote guard to `status = 'ready'`

Both verify agents recommended two things: key the exclusion on adoption rather
than `role`, **and** narrow `demoteCurrentCover()`'s guard from
`status <> 'failed'` to `status = 'ready'`. I did the first and did the
**opposite** of the second: the guard is gone entirely, and the demote now
matches every `role='cover'` row.

The reason is the mechanism I chose for M-V5-02. The recommendation assumes the
gate learns about supersession from the *absence* of a demote ("only take over
a slot from a row that's actually settled-good"). My gate learns it from the
*presence* of a `replaced_cover_image_id` record, which the demote is what
writes. Under `status = 'ready'`, a `processing` cover would never be demoted,
so it would never be recorded as superseded, so `AC-08-recovery-05` would still
be `409` — the fix would defeat itself. Under the v5 guard, an
asynchronously-*failed* cover is likewise never recorded, which is the
regression in §2.2. Matching every cover row is the only variant that records
the takeover in both orderings.

The safety property the v5 guard was protecting — "a rejected upload must not be
promoted into the body slot, where it becomes an image the article is genuinely
using again" — is now enforced somewhere better: by the gate itself, which
excludes a never-adopted row regardless of which slot it sits in. Both the
verify agents' concern and mine are satisfied; only the location moved.
`AC-08-recovery-01`, `-02` and `-03` all still pass, unmodified.

### 6.3 A residual on M-V5-03 that this fix narrows but does not eliminate

Honest statement of what is still reachable. The gate no longer reads `role` —
but `demoteCurrentCover()` necessarily does, because `role` *is* the cover slot.
So a writer can still influence supersession indirectly:

```
article with a broken, genuinely-embedded body image B (blocks publish, correctly)
  authenticated, direct PostgREST:  update article_images set role='cover' where id = B
  upload a new cover                -> the demote matches B (and the real cover),
                                       and names one of them as replaced
  if the row it names is B          -> B is excluded, and the article publishes broken
```

Compared with what shipped at v5 this is strictly narrower — v5 needed only the
`role` flip and no upload at all — but it is not closed. Three notes:

- It requires the writer's own deliberate direct-PostgREST write plus a
  subsequent cover upload, and which row `returning id` yields first when two
  match is **not deterministic**, so it is not a reliable technique.
- The impact is bounded: a writer publishing their own article with a broken
  image, in a system where every writer already has full edit and publish rights
  over every article (the "writers have equal rights" design named at v1). It is
  not privilege escalation.
- **The complete fix is to revoke `grant update (role) on article_images from
  authenticated`**, which `03-red-evidence.v6.md` §3 explicitly names as an
  admissible fix and which `NFR-IMAGE-ROLE-01` deliberately does not assert
  against. I did not do it: no test requires it, nothing in the product writes
  `role` through PostgREST today as far as I can see, but a `revoke` is a
  behavioural change to the public data API that the architecture document does
  not authorise and that I would rather the verify gate rule on than assume.
  **Recommended as a one-line migration for the next pass.**

I would rather this be read as an open item than as a closed finding.

### 6.4 The idempotency store still has no TTL, and is still unbounded

`03-red-evidence.v6.md` §5.3 asked the green pass to consider closing this "in
the same one-line change". I did not. Adding an operation component to the key
is what the tests force; an expiry window is a different behaviour with
different edge cases (the contract states 24h for publish and 5min for upload —
*two* windows, not one), no test in this suite specifies it, and inventing the
eviction semantics without one is exactly the kind of speculative work this
gate is supposed to refuse. Recorded as still open, carried from v4's L-V4-01
and compounded by I-V5-02 (unbounded key length). **It is now slightly worse in
one dimension: keys carry an operation prefix, so a client reusing one key
across both operations now occupies two map entries instead of one.**

### 6.5 The slug fix has a race, and it is a 500

`uniqueSlug()` reads the taken slugs and then writes; two publishes of two
identically-titled articles racing between the read and the write can still
collide on the `unique` index, and `23505` is still unmapped, so that would
still be a `500`. This closes the deterministic, single-user, permanently
reproducible bug M-V5-05 describes and does not close the concurrent one. No
test covers the race; adding a `23505` catch-and-retry means restructuring
`publishNow` so `structured_data` can be rebuilt with the new slug (§3), which
is real work for a case no requirement names. **Recorded as a known, narrow
residual** rather than fixed silently or claimed as closed.

### 6.6 The object store's URLs moved with the origin

`03-red-evidence.v6.md` §5.1 flagged this as a decision the green pass should
make rather than stumble into: `createObjectStore()` also *builds*
`${CDN_ORIGIN}/articles/${key}`, and nothing in the new tests forces it to move.
**I moved it.** A deployment that validated inbound callbacks against its real
CDN while writing placeholder URLs into `article_images.optimized_url` would be
half-fixed in the worst possible way — the visible symptom (broken images on the
live site) would be different from the configured symptom, and `NFR-EGRESS-01`'s
promise that no visitor is pointed at a wrong origin would be quietly untrue.
One origin, one source, both uses.

### 6.7 Contract prose changed; no schema did

Three prose edits, no `pattern`, `type`, `enum`, `required` or example-shape
change, so every contract test is unaffected (Prism and Schemathesis both still
pass — see §1.1):

- `contracts/openapi.yaml`, `publishArticle`'s `IMAGE_NOT_READY` paragraph. It
  said the exception was "a `failed` **cover** upload … since the article has a
  usable cover beside it". That described v5's rule, which this pass replaced;
  leaving it would have documented behaviour the code no longer has. It now
  describes the two exclusions in `articleDependsOn()`, explicitly "whatever
  their `role`".
- `contracts/internal-openapi.yaml`, the callback's `400` description and
  `optimized_url`'s description. The origin check was **never documented at all**
  (`05-verification.v3.md` N2 recorded exactly that gap), and now that the origin
  is configuration it also cannot be expressed as a `pattern`. Both are now said
  in words, and the `.example` example is labelled as the unconfigured fallback
  rather than a requirement. **No `pattern` was added or removed** — there was
  none to begin with, so the follow-on the red pass anticipated turned out to be
  documentation only.

`traceability.md` §6 note 17 still says the CDN-origin check lives "where the
`CDN_ORIGIN` constant already lives". That sentence is now stale by one word
(constant → configured value); the placement claim it makes — validation-time,
before any repository call — is still exactly true, and `NFR-CALLBACK-04`'s
unreachable-database test still proves it. I have **not** edited that file: red
passes own it in this workflow, and I would rather flag the word than quietly
rewrite a document I am not the author of.

### 6.8 Nothing else was touched

No test file. No `db/migrations/*`. No `state.json`. No `uploadImage.ts` — the
upload route needed no change for any of the six findings, which is worth
stating because two of them are about uploads. Nothing committed; the working
tree is left unstaged for review.

---

## 7. Files changed

| File | Change | Finding |
|---|---|---|
| `src/api/publishArticle.ts` | `isRejectedAttempt()` → `articleDependsOn()`, keyed on `original_url`/`replaced_cover_image_id` and never on `role`; `ImageRecord` gained those two columns; `PublishDeps.repo.takenSlugs`; `uniqueSlug()` feeds real existing slugs to `generateSlug` before `structured_data` is built | M-V5-01, M-V5-02, M-V5-03, M-V5-05 |
| `src/api/repo.ts` | `getArticleImages` selects `original_url, replaced_cover_image_id`; `demoteCurrentCover` matches every `role='cover'` row (v5's `status <> 'failed'` guard removed, §2.2/§6.2); new `takenSlugs(base_slug)` | M-V5-01, M-V5-02, M-V5-05 |
| `src/api/router.ts` | Idempotency store is now one map with a per-operation namespace; `CDN_ORIGIN` constant → `DEFAULT_CDN_ORIGIN` + `ServerOptions.cdnOrigin`; `isCdnUrl`/`imageStatusBody`/`createObjectStore` all take the configured origin; the callback schema is built once on `Shared` | M-V5-04, M-V3-04 |
| `src/api/server.ts` | The spawn forwards `CDN_ORIGIN` to the child, alongside the three variables it already forwarded | M-V3-04 |
| `src/api/serverMain.ts` | Reads `process.env.CDN_ORIGIN` into `startHttpServer` | M-V3-04 |
| `tests/support/seams.ts` | **Additive only**: optional `takenSlugs?` on the publish seam's `repo` (§6.1) | M-V5-05 |
| `tests/support/fakes.ts` | **Additive only**: `takenSlugs: async () => []` on `buildPublishDeps` (§6.1) | M-V5-05 |
| `pdlc/arsene-cms/contracts/openapi.yaml` | Prose: the `IMAGE_NOT_READY` exception is described as it now behaves, role-independently | M-V5-01/02/03 |
| `pdlc/arsene-cms/contracts/internal-openapi.yaml` | Prose: the callback's origin check is documented, and named as per-deployment configuration rather than a fixed value | M-V3-04 |

---

## 8. Gate statement

216 tests, 216 passing, 36 files, four consecutive full runs, `tsc --noEmit`
clean. The eight red tests are green; the four both-sides controls
(`AC-08-recovery-02`, `-03`, `-06`, `NFR-IDEM-03c`) are still green and were not
touched. No test file's assertions were edited, added or removed; two
test-*support* files gained one additive collaborator each, declared openly in
§1.3, §6.1 and §7. Coverage 82.60% statements / 86.32% branch / 87.59%
functions — statements down 0.33 on v5 for a structural reason (new repository
code the in-process instrumenter cannot see), branch and functions up. One
regression I introduced was caught by hand before shipping, proved both ways,
and closed (§2.2). One residual on M-V5-03 is narrowed but open, with the
complete fix named (§6.3); the idempotency TTL (§6.4) and the slug race (§6.5)
are open and named. `state.json` untouched, nothing committed. Green.
