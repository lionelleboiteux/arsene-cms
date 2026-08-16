# arsene-cms — verify gate, fifth pass: integration / e2e

**Run:** 2026-08-14, worktree `arsene-cms+green-v3`, against commit `b159caa`
("Pass green gate, remediation v5: 206/206, closes M-V4-01/M-V4-02").
**Scope:** the integration/e2e portion of Bob's verify gate — full regression
suite run repeatedly, both sides of the contract, higher-depth provider
fuzzing, and hand-driven adversarial re-verification of both fixes against
real Postgres 16 (Testcontainers), the real spawned child-process server over
real HTTP with real multipart image bytes, and the real public render pass.
**Nothing in `src/`, `db/`, `tests/` or `package.json` was modified.** All
probe code lived in `/tmp/v5probe/` and is not part of the repository.

---

## 0. Verdict

| Item | Verdict |
|---|---|
| **M-V4-01** (rejected cover upload blanks a live cover / blocks republication) | **CLOSED for the cover slot**, proven across 13 multi-upload sequences |
| **M-V4-02** (upload ignored the draft lock) | **CLOSED**, proven refused with nothing written, and agreeing with publish at the staleness boundary to the second |
| Full suite | **206/206, four times** |
| `tsc --noEmit` | **clean on the committed tree** |
| Contract, both sides | consumer (Prism) and provider (Schemathesis) green in the suite; **15,452 additional cases** standalone at higher depth |
| **New: nothing High.** | |
| **New: two Medium** | **M-V5-01** (a rejected *body* image permanently blocks publication — M-V4-01's exact shape on the slot the fix deliberately excluded) and **M-V5-02** (two articles with the same title → `500 INTERNAL_ERROR`, deterministic and permanent; AC-14's collision-free slug is not wired up) |
| **New: two Low, three Info** | §6 |

Neither Medium was introduced by this pass. Both are the same failure shape
this gate has now blocked on three times running: an acceptance criterion that
is green in CI and does not work against real infrastructure, because the test
that covers it is aimed at a fake.

---

## 1. Regression suite — four runs, plus types

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test          (x3)

 Test Files  33 passed (33)          Test Files  33 passed (33)          Test Files  33 passed (33)
      Tests  206 passed (206)             Tests  206 passed (206)             Tests  206 passed (206)
   Start at  08:16:11                  Start at  08:17:06                  Start at  08:17:59
   Duration  27.66s                    Duration  30.20s                    Duration  28.49s
```

```
$ npx tsc --noEmit
TSC_EXIT=0
```

`NFR-IMGCPU-01`, the known wall-clock flake, **passed in all three runs** and
needed no isolation:

```
✓ tests/unit/lambdaImage.test.ts > … NFR-IMGCPU-01: a real ~6 megapixel photo … 1122ms
✓ tests/unit/lambdaImage.test.ts > … NFR-IMGCPU-01: a real ~6 megapixel photo … 1201ms
✓ tests/unit/lambdaImage.test.ts > … NFR-IMGCPU-01: a real ~6 megapixel photo … 1085ms
```

(The figure vitest prints is the whole test's wall clock, which includes
encoding the ~6 MP fixture with `sharp`; the assertion is on the conversion
measurement inside it, which is why 1085–1201 ms is still a pass against the
one-second conversion budget. Same reading as green-v5 §1.1's 577 ms — the
difference is fixture-generation cost under load, not conversion cost.)

### 1.1 An environmental hazard worth recording — and why it does not touch the evidence above

**A second agent (a perf run) is writing into this shared worktree
concurrently**, exactly as `05-verification.v4.md` §8 recorded happening at
v4. It creates untracked files under `tests/perf/`:

```
$ git status --short
?? tests/perf/

$ stat -f "%Sm %N" -t "%Y-%m-%d %H:%M:%S" tests/perf/*
2026-08-14 08:18:50 tests/perf/control-src
2026-08-14 08:21:18 tests/perf/httpAB.perf.test.ts
2026-08-14 08:19:22 tests/perf/inprocess.perf.test.ts
2026-08-14 08:19:56 tests/perf/orphan.perf.test.ts
2026-08-14 08:33:54 tests/perf/refusal.perf.test.ts
2026-08-14 08:28:50 tests/perf/scale.perf.test.ts
2026-08-14 08:35:41 tests/perf/warm.perf.test.ts
```

Those files end in `.test.ts`, so `vitest.config.ts`'s
`include: ['tests/**/*.test.ts']` **collects them**, and they are not written
to the repo's `strict` + `noUncheckedIndexedAccess` standard, so `tsc --noEmit`
reports errors from them. Anyone running `npm test` or `tsc` in this worktree
right now will disagree with CI, through no fault of the commit.

The three runs above all started **and finished** before the first of those
files existed (run 3: start 08:17:59 + 28.49 s = 08:18:28; first perf file
08:18:50), and each collected exactly **33 files**, which is the committed
tree. To remove all doubt, a fourth run scoped to the committed test
directories, taken *after* the perf files appeared:

```
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run tests/unit tests/telemetry tests/db tests/contract tests/e2e
 Test Files  33 passed (33)
      Tests  206 passed (206)
   Start at  08:36:53
   Duration  27.17s
```

and `tsc` with the foreign directory filtered out:

```
$ npx tsc --noEmit 2>&1 | grep -v "^tests/perf/"
(no output — the committed tree type-checks clean)
```

**206/206 four times, types clean.** No file under `tests/perf/` was created,
edited or deleted by this pass; it belongs to another agent and was left
alone.

---

## 2. M-V4-01 — the multi-upload sequence hunt

Thirteen sequences, each against its **own freshly published live article**
with a working `ready` cover, over real HTTP with real image bytes, checking
after every single step: the `article_images` rows in Postgres, the cover the
**real render pass** (`src/site/render.ts`) puts on the article page *and* on
the homepage card, and whether `publish` still succeeds.

A fresh server was spawned per sequence, deliberately: the rate limiter is an
in-memory 10/min-per-IP bucket and every request here comes from `127.0.0.1`,
so a long sequence run against one server is answered `429` rather than by the
logic under test. (The first attempt at this hunt was — usefully — invalidated
by exactly that, and is why the seven-step sequences below are meaningful.)

Fixtures: `truncated.jpg` = correct JPEG SOI/APP0 magic then garbage, no EOI
(rejected synchronously by `isDamagedContainer`); `good.jpg` = a real
decodable baseline JPEG; `asyncfail.jpg` = magic **and** a correct trailing
EOI so the synchronous check passes, with a garbage payload the real codec
rejects — the only way to reach the asynchronous-failure leg; `not-an-image.pdf`
= a real PDF header.

### 2.1 The original exploit, reconstructed

```
=== SEQ 1: original exploit: one truncated cover on a live article  [bad] ===
  before: [{"role":"cover","status":"ready","file":"original-cover.jpg"}]   page cover: …/cover-original-cover.jpg-optimized.webp
  upload bad  -> 201 "failed"
    rows        [{"role":"cover","status":"ready","file":"original-cover.jpg"},
                 {"role":"cover","status":"failed","file":"truncated.jpg","url":null}]
    page cover  https://cdn.example/…/cover-original-cover.jpg-optimized.webp   <- unchanged
    home img    https://cdn.example/…/cover-original-cover.jpg-optimized.webp   <- unchanged
    publish     200
  FINAL publish -> 200 ok | article {"status":"published","slug":"seq-1"} | ready covers 1
```

Against `05-verification.v4.md` §6's trace: the live cover **is not demoted**,
the live page **still shows it**, and republication **succeeds**. Closed.

### 2.2 Every sequence, and its final state

`ready covers` counts `role='cover' and status='ready'` rows; `page cover` is
what the render pass actually emits as `og:image`.

| # | Sequence | Publish after each step? | FINAL publish | ready covers | page cover correct? | a `failed` row ever rendered? |
|---|---|---|---|---|---|---|
| 1 | bad | yes (200) | **200** | 1 | yes | no |
| 2 | bad, bad | yes (200, 200) | **200** | 1 | yes | no |
| 3 | bad, good, bad | yes (200, 200, 200) | **200** | 1 | yes | no |
| 4 | bad, good, bad | no | **200** | 1 | yes | no |
| 5 | bad, bad, bad, good | yes (200 ×4) | **200** | 1 | yes | no |
| 6 | good, bad | yes (200, 200) | **200** | 1 | yes | no |
| 7 | bad, bad, good, bad, bad, good | no | **200** | 1 | yes | no |
| 8 | pdf, bad, good | yes (200 ×3) | **200** | 1 | yes | no |
| 9 | asyncfail | 409 IMAGE_NOT_READY | **409** | 0 | **blank** | no |
| 10 | asyncfail, good | 409 then 200 | **200** | 1 | yes | no |
| 11 | asyncfail, bad, good | 409, 409, 200 | **200** | 1 | yes | no |
| 12 | **bodybad, bodygood** | 409, 409 | **409** | 1 | yes | no |
| 13 | **bodybad, good(cover)** | 409, 409 | **409** | 1 | yes | no |

The two sequences the brief specifically asked about, verbatim:

```
=== SEQ 2: two consecutive bad uploads  [bad -> bad] (publish after each step) ===
  upload bad -> 201 "failed" | rows [cover/ready original-cover.jpg, cover/failed truncated.jpg]
               | page cover …/cover-original-cover.jpg-optimized.webp | publish 200
  upload bad -> 201 "failed" | rows [cover/ready original-cover.jpg, cover/failed truncated.jpg,
                                     cover/failed truncated.jpg]
               | page cover …/cover-original-cover.jpg-optimized.webp | publish 200
  FINAL publish -> 200 "ok" | ready covers 1

=== SEQ 3: bad, good, bad  [bad -> good -> bad] (publish after each step) ===
  upload bad  -> 201 "failed"     | rows [cover/ready original-cover.jpg, cover/failed truncated.jpg]
                | page cover …/cover-original-cover.jpg-optimized.webp | publish 200
  upload good -> 201 "processing" | rows [body/ready original-cover.jpg, cover/failed truncated.jpg,
                                          cover/ready good.jpg]
                | page cover …/32dfd1b2-…-optimized.webp | publish 200
  upload bad  -> 201 "failed"     | rows [body/ready original-cover.jpg, cover/failed truncated.jpg,
                                          cover/ready good.jpg, cover/failed truncated.jpg]
                | page cover …/32dfd1b2-…-optimized.webp | publish 200
  FINAL publish -> 200 "ok" | ready covers 1
```

**No sequence of cover uploads leaves the article stuck, coverless, or showing
the wrong image.** In particular SEQ 7 confirms the `repo.ts` demote guard
(`status <> 'failed'`) does what green-v5 §3 claims across repeated
good-upload cycles: each new good cover demotes only the previous *working*
cover into the body slot, and the three accumulated `failed` rows are never
promoted into it.

**The render pass never shows a `failed` image as the cover, in any sequence.**
It cannot: `PUBLISHED_ARTICLES_SQL` selects `role='cover' and status='ready'`,
and a `failed` row's `optimized_url` is `null` anyway. The homepage card and
the `og:image` were checked independently at every step and always matched the
one `ready` cover.

### 2.3 The `structured_data` consequence of two `cover` rows — checked, correct

The class of bug `05-verification.v1.md` §6.4 caught (a fabricated
`cover_image_url` persisted into JSON-LD) is the obvious risk of green-v5's
"two rows may now carry `role: cover`" change. Verified directly:

```
rows: [{"role":"cover","status":"ready","file":"real.jpg","url":"https://cdn.example/4e7b1a75-…/cover-real.jpg-optimized.webp"},
       {"role":"cover","status":"failed","file":"truncated.jpg","url":null}]
publish -> 200
response  structured_data.image : ["https://cdn.example/4e7b1a75-…/cover-real.jpg-optimized.webp"]
PERSISTED structured_data.image : ["https://cdn.example/4e7b1a75-…/cover-real.jpg-optimized.webp"]
is it the READY cover?          : true
```

`publishArticle.ts`'s `images.find(role === 'cover' && status === 'ready')` is
correctly wired, in the response **and** in the column, against real Postgres.

### 2.4 The boundary `isRejectedAttempt()` must not cross — all five hold

```
A1 fresh draft, only cover upload rejected   upload 201/"failed"  publish 409 IMAGE_NOT_READY
A2 draft with no images at all                                    publish 400 COVER_IMAGE_REQUIRED
A3 failed cover + PROCESSING cover                                publish 409 IMAGE_NOT_READY on {"role":"cover","status":"processing"}
A4 failed BODY + ready cover                                      publish 409 IMAGE_NOT_READY
A5 processing BODY + ready cover                                  publish 409 IMAGE_NOT_READY
```

A3 is the one worth calling out: `isRejectedAttempt`'s "some other cover is
not `failed`" predicate is satisfied by a `processing` cover, so the `failed`
row is excluded — but the `processing` row then blocks in its own right, and
the 409 correctly names *it*. The exclusion cannot be used to publish an
article whose cover is not actually ready.

### 2.5 SEQ 9 — the async-failure leg, exactly as green-v5 §6.3 disclosed it

```
=== SEQ 9: async-failing cover (passes the sync check, the codec rejects it) ===
  before: [cover/ready original-cover.jpg]                   page cover: …/cover-original-cover.jpg-optimized.webp
  upload asyncfail -> 201 "processing"
    rows       [body/ready original-cover.jpg, cover/failed asyncfail.jpg]
    page cover (blank)   home img (blank)
    publish    409 IMAGE_NOT_READY
  FINAL publish -> 409 IMAGE_NOT_READY | ready covers 0
```

A live article loses its public cover and cannot be republished. **This is not
a gap in the M-V4-01 fix**: green-v5 §2.2/§6.3 documents it explicitly, gives
the reason it was not moved (AC-06 pins `replaced_cover_image_id` to the
demote's return value *in the upload response*, so relocating the demote to
the status callback would change a committed assertion, which a green gate may
not do), and its recovery does work — SEQ 10 shows one good upload restores
both the cover and publishability. Recorded as **I-V5-03**, confirming the
green evidence is accurate rather than optimistic.

---

## 3. M-V4-01's shape, still open on the *body* slot — **M-V5-01 (Medium)**

SEQ 12/13 are the finding. Minimised, against the real server, real Postgres
and the real render pass:

```
live article, before:                                   [cover/ready live-cover.jpg]
writer uploads a truncated BODY image        -> 201 {"status":"failed","failure":{"code":"CORRUPTED_FILE"}}
rows:                                                   [cover/ready  live-cover.jpg,
                                                         body/failed  body-truncated.jpg (optimized_url null)]
republish                                    -> 409 IMAGE_NOT_READY {"role":"body","status":"failed"}

-- AC-08's documented remedy: "the writer is told to replace it" --
upload a GOOD body image, then republish     -> 409 IMAGE_NOT_READY     <- does not clear it
upload a GOOD cover,      then republish     -> 409 IMAGE_NOT_READY     <- does not clear it
three further good body images + republish   -> ["409/IMAGE_NOT_READY","409/IMAGE_NOT_READY","409/IMAGE_NOT_READY"]

-- can the writer remove the row? --
delete       as authenticated                -> 42501 permission denied for table article_images
update status as authenticated               -> 42501 permission denied for table article_images
update role   as authenticated               -> ALLOWED   (the only grant: `update (role, alt_text)`)
```

This is **M-V4-01, verbatim, on the other role**: a live, already-published
article is permanently un-republishable after one fat-fingered file, with no
in-product recovery, because no writer can delete an `article_images` row and
`publishArticle.ts`'s readiness gate counts it forever.

**Why the green pass's justification does not hold.** Green-v5 §2.1 restricts
`isRejectedAttempt()` to covers on the grounds that "a `failed` body image is
still embedded in the body and still refuses the publish (AC-08)… A body image
is referenced from the article's own HTML; nothing supersedes it." That is not
true of a *failed* body image, and the code says so:

- on the synchronous rejection path `uploadImage.ts` stores nothing —
  `original_url: null`, and `insert()` returns `urls: null`;
- on **every** path `insert()` returns `alt_text: null, urls: null`, because
  the contract withholds both "until the row is `ready`".

So a `failed` body image has never had a URL that could be embedded in
`body_html`, on either leg. The distinguishing fact green-v5 §2.1 needed is not
"cover versus body"; it is "was this row ever adopted by the article" — and a
row that never received a URL never was. The `role` split happens to be a
sufficient condition for covers and is simply wrong for bodies.

**Reachability.** Higher than M-V4-01's, if anything: uploading body imagery is
the ordinary flow for an illustrated match report, no live cover has to exist
first, and it is one request.

**Failure mode.** The article stays `published` and keeps serving its old
content — this is a "cannot update" rather than a "site is broken", which is
why it is Medium and not High. `AC-08-recovery-03` in the committed suite pins
exactly this behaviour as *correct*, so closing this needs a red gate to
revisit that test's premise, not just an implementer.

**The one escape, and why it is not a fix.** `db/migrations/0001` grants
`update (role, alt_text) on article_images to authenticated`, so a direct
PostgREST `PATCH role='cover'` on the failed body row turns it into a `failed`
cover — which `isRejectedAttempt()` then excludes, and publish succeeds:

```
direct PostgREST PATCH role='cover' on the failed row -> ALLOWED (1 row); republish -> 200
```

That is an accidental side effect of this pass's own predicate, not a product
path: nothing in the contract, the SPA's documented surface or AC-08 mentions
it, and it leaves a row permanently mislabelled as a cover. Recorded as
**I-V5-02**.

---

## 4. M-V4-02 — refused on publish, therefore refused on upload

Two real writers, two real Supabase-shaped JWTs, real spawned server. Every
refusal checked against the **database**, not the response.

```
########## 1. the exploit from 05-verification.v4.md §6, replayed ##########
  B opens the draft (takes the lock)   -> 200  lock now {"locked_by":"f57d7010-…","locked_at":"2026-08-14T07:23:11.524Z"}
  A publishes                          -> 409 "DRAFT_LOCKED" {"locked_by_writer_id":"f57d7010-…","locked_by_display_name":"Writer B"}
  A uploads a cover to the SAME draft  -> 409 "DRAFT_LOCKED" {"locked_by_writer_id":"f57d7010-…","locked_by_display_name":"Writer B"}
  rows before 1 / after 1  -> rows_created 0
  images in DB: [{"role":"cover","status":"ready","file":"seed-cover.jpg"}]
  A uploads a GOOD cover               -> 409 "DRAFT_LOCKED"
  rows before 1 / after 1  -> rows_created 0
  the seeded cover is still            -> ["cover/ready/seed-cover.jpg"]
  VERDICT: PASS — refused on both routes, nothing written
```

Both routes now refuse with the **same code, same envelope and the same
display name**, and the refusal precedes every side effect.

```
########## 2. the lock holder can still upload ##########
  B opens -> 200; B uploads -> 201 "processing"                                   PASS

########## 3. an unlocked draft ##########
  lock {"locked_by":null,"locked_at":null}
  A uploads with no lock held anywhere -> 201 "processing"                        PASS

########## 4. a STALE / abandoned lock (LOCK_STALENESS_MS = 90s) ##########
  lock age   89s -> upload 409 DRAFT_LOCKED | publish 409 DRAFT_LOCKED | rows_created 0
  lock age   91s -> upload 201 processing   | publish 200 ok           | rows_created 1
  lock age  200s -> upload 201 processing   | publish 200 ok           | rows_created 1
  lock age 3600s -> upload 201 processing   | publish 200 ok           | rows_created 1
```

The two routes **agree exactly** at the staleness boundary — which is the real
proof that `evaluateLock` was called rather than re-implemented, and that
AC-05's takeover of an abandoned lock survives for uploads.

```
########## 5. the 409 arrives before any side effect, on every upload branch ##########
  truncated cover    -> 409 DRAFT_LOCKED | rows_created 0 | cover still ["ready/seed-cover.jpg"]
  good cover         -> 409 DRAFT_LOCKED | rows_created 0 | cover still ["ready/seed-cover.jpg"]
  truncated body     -> 409 DRAFT_LOCKED | rows_created 0 | cover still ["ready/seed-cover.jpg"]
  unsupported (PDF)  -> 409 DRAFT_LOCKED | rows_created 0 | cover still ["ready/seed-cover.jpg"]
```

No branch of `createImage` is reachable behind a held lock: no row, no
`storage.put`, no `demoteCurrentCover`. **M-V4-02 is closed.**

One ordering observation, informational (**I-V5-04**): the idempotency replay
is consulted *before* the lock check on both routes, so a writer who uploaded
successfully and then had the draft locked by a colleague still gets their
earlier `201` replayed for the same key:

```
  A uploads (unlocked, key=shared-key-1)   -> 201 image 19359bc4-…
  B takes the lock; A replays the SAME key -> 201 image 19359bc4-… | rows_created 0
```

`rows_created 0` — it is a cached response, not a mutation, so this is
harmless. Recorded only so the next pass does not rediscover it as a bypass.

L-V4-01 (unscoped idempotency store) was re-confirmed unchanged and remains
correctly out of scope: `A key="1" -> 201 b99d3a47-…; B key="1" -> 201
b99d3a47-…; same row: true`.

---

## 5. The same-shape check — other route pairs that mutate and check differently

Four writer-facing routes (`createDraft`, `openDraft`, `publishArticle`,
`uploadArticleImage`) plus the internal `reportImageStatus`. What each checks,
by reading the handlers and confirming empirically:

| Check | createDraft | openDraft | uploadArticleImage | publishArticle |
|---|---|---|---|---|
| JWT verified + `sub` resolved against `writers` | yes | yes | yes | yes |
| article exists (404) | n/a | yes | yes | yes |
| idempotency replay | n/a (none offered) | n/a | required key | optional key |
| **rate limit (10/min per IP)** | **NO** | **NO** | yes | yes |
| **draft lock** | n/a | yes (`repo.takeLock`, SQL, DB clock) | yes (`evaluateLock`, JS, server clock) | yes (`evaluateLock`, JS, server clock) |
| ownership of the article | n/a | no | no | no |
| article status (draft vs published) | n/a | no | no | no |

- **Ownership is consistently absent on all three article routes** —
  `B on A's article: open 200 | upload 201 | publish 200`. That is the
  documented "writers have equal rights" design, applied uniformly. Not a
  finding.
- **Article status is consistently ignored** on all three — `openDraft` on a
  published article returns 200 and takes a lock on live content. Uniform, and
  republishing is an intended feature. Not a finding.
- **Rate limiting is the inconsistency.** `traceability.md` line 180 states
  NFR-RATE-01 as "Rate limit on mutating endpoints (§7 DoS)", and its tests
  live only in `tests/unit/publishArticle.test.ts`. Two mutating endpoints are
  uncovered:

```
  40 back-to-back createDraft -> {"201":40} in 80ms; rows actually created: 40
  40 back-to-back openDraft   -> {"200":40}
```

  Recorded as **L-V5-01**. `createDraft` writes an `articles` row **and** a
  `draft_started` telemetry row per call, which is the numerator of the
  product's headline success metric — so unbounded draft creation is a metric
  integrity problem as well as a DoS one.
- **The lock rule has two implementations** — `openDraft` uses
  `TAKE_LOCK_SQL`'s `locked_at < now() - '90 seconds'` against the *database*
  clock, while publish and upload use `evaluateLock`'s `LOCK_STALENESS_MS`
  against the *server* clock. Same 90 s value today, and §4's boundary probe
  shows publish and upload agreeing to the second, so nothing is currently
  wrong. Two clocks and two constants encoding one rule is worth a note
  (**I-V5-05**), not a finding.

---

## 6. New findings

### M-V5-01 (Medium) — a rejected **body** image permanently blocks publication of a live article

Full evidence in §3. Same shape as M-V4-01; AC-08's documented remedy proven
not to work; no in-product recovery; the green pass's stated rationale for
scoping the fix to covers is contradicted by `uploadImage.ts`'s own
`urls: null` / `original_url: null`. Pre-existing, not introduced by this
pass — but this pass is the one that established the principle that a row the
article never adopted must not block publication, and applied it to one of the
two roles.

Suggested repair (for a red gate, since `AC-08-recovery-03`'s premise moves):
key the exclusion on adoption rather than role — a `failed` row that has no
`optimized_url` and was never served is a rejected attempt whatever its role —
or take `05-verification.v4.md` §6's third option (a scoped `delete` grant plus
a route), which green-v5 §6.1 explicitly deferred and which would close both
halves at once.

### M-V5-02 (Medium) — two articles with the same title make the second publish `500`, permanently

Found while minimising a `positive_data_acceptance` failure from the
higher-depth fuzzing. `articles.slug` is `text unique`
(`db/migrations/0001_initial_schema.sql:55`); `publishArticle.ts` calls
`generateSlug(article.title)` **with no `existingSlugs`**, so the
de-duplicating branch of `generateSlug` is dead code in production; the
resulting `23505` is unmapped and falls through to `route()`'s catch-all.

```
########## two articles, same title, same writer ##########
  first  publish -> 200 slug="pronos-ligue-1-journee-12"
  second publish -> 500 "INTERNAL_ERROR" "An unexpected error occurred."
  article 1 state: {"status":"published","slug":"pronos-ligue-1-journee-12", …}
  article 2 state: {"status":"draft","slug":null,"published_at":null,"has_sd":false}
  retrying the second publish -> 500 "INTERNAL_ERROR"   (deterministic, no way through)

########## two writers, both leaving the DEFAULT draft title ##########
  writer A publishes "Sans titre" -> 200 slug="sans-titre"
  writer B publishes "Sans titre" -> 500 "INTERNAL_ERROR"

########## is the collision-avoiding branch reachable at all? ##########
  generateSlug('Journée 12')                                    -> "journee-12"
  generateSlug('Journée 12', { existingSlugs: ['journee-12'] })  -> "journee-12-2"
  publishArticle.ts calls it as: generateSlug(article.title)     -> no existingSlugs are ever passed

########## renaming is the only escape, and it works ##########
  before renaming -> 500 INTERNAL_ERROR
  after renaming  -> 200 slug="mercato-hiver-bis"

########## does the failure leave anything behind? ##########
  telemetry rows for the failed article: before 0, after 0
  article: {"status":"draft","slug":null,"published_at":null,"has_sd":false}
  the failed article appears on the public homepage: false
```

- **Directly contradicts AC-14**, "URL-safe, collision-free slug, generated
  with no writer action". `traceability.md` line 126 lists AC-14 as covered by
  five tests; the only one that exercises collisions is `PROP-01` in
  `tests/unit/properties.test.ts`, which calls `generateSlug` **directly with
  an `existingSlugs` array it builds itself** — it proves the pure function and
  can never see that the caller does not pass one. Same "unit test aimed at a
  fake" shape as the HEIC gap (v3) and M-V4-01 (v4).
- **Very reachable for this product**: a weekly-fixture football CMS produces
  recurring titles by construction, and `createDraft`'s default title is the
  constant `'Sans titre'` for every draft.
- **Fails safe**: no partial row, no telemetry, nothing public, article left a
  clean `draft`. That is why it is Medium, not High.
- **But it is unfixable by the writer**: `INTERNAL_ERROR` / "An unexpected
  error occurred" gives no clue that the title is the problem, and the contract
  declares no branchable code for it (it surfaces through `default`). This is
  the same class as the still-open N5 (an unmapped SQLSTATE becoming a 500
  instead of a 4xx with a code), reached by a far more ordinary action.

Suggested repair: pass the taken slugs into `generateSlug`, or do the insert
with a retry on `23505`, or map `23505` to a `409`/`400` with a real code —
the last being the minimum needed to stop it being a 500.

### L-V5-01 (Low) — `createDraft` and `openDraft` are not rate-limited, while publish and upload are

Evidence and reasoning in §5. NFR-RATE-01 is stated for "mutating endpoints";
two of the four are uncovered, and one of them writes the success metric's
numerator.

### L-V5-02 (Low) — `meta_title` / `meta_description` length: characters in the contract, UTF-16 code units in the implementation

The one failure the unpinned higher-depth run found on `publishArticle`:

```
1. Test Case ID: URby2H
- API rejected schema-compliant request
    Valid data should have been accepted
    Expected: 2xx, 401, 403, 404, 409, 5xx
[400] Bad Request:
    {"error":{"code":"VALIDATION_FAILED","details":{"fields":[
      {"field":"meta_title","message":"Too big: expected string to have <=70 characters"}]}}}
```

Minimised by hand (`chars` = code points, which is what JSON Schema
`maxLength` counts; `utf16` = code units, which is what zod's `.max()`
counts):

```
  43 plain ASCII chars                              chars= 43 utf16= 43 -> accepted
  71 plain ASCII chars (over the cap)               chars= 71 utf16= 71 -> 400 "Too big: expected string to have <=70 characters"
  43 characters, all astral (mathematical script)   chars= 43 utf16= 78 -> 400 "Too big: expected string to have <=70 characters"
```

A title of **43 characters** is refused as being over a 70-character limit.
Contract and implementation disagree; for a French football CMS the realistic
trigger is emoji in headlines (`🏆` is one character, two code units), which
silently halves the usable length near the cap. Low: it fails closed, with a
correct `VALIDATION_FAILED` envelope and an accurate-sounding but wrong
message.

### I-V5-01 (Info) — the `Idempotency-Key` header's declared bounds are not enforced

`components/parameters/IdempotencyKeyHeader` declares `minLength: 1,
maxLength: 128`. The pinned fuzzing flagged both bounds as accepted
(`Invalid component: parameter 'Idempotency-Key' in header - string larger
than maxLength`), confirmed by hand:

```
  a 128-char key (the cap)             len=   128 -> 200 ok
  a 4096-char key (32x over the cap)   len=  4096 -> 200 ok
  a 100000-char key                    len=100000 -> 431   (Node's own header-size limit, not the app's)
```

Every accepted key becomes a permanent entry in `createIdempotencyStore()`'s
unbounded `Map` with no TTL — which compounds L-V4-01's "unbounded/unexpiring"
half rather than being new. The only bound today is Node's header size limit.

### I-V5-02 (Info) — `update (role)` on `article_images` is the only thing that can clear M-V5-01

See §3. A direct PostgREST `PATCH role='cover'` on a failed body row makes
`isRejectedAttempt()` exclude it and publish succeed. An accidental
consequence of this pass's predicate, not a designed recovery path, and it
leaves the row mislabelled.

### I-V5-03 (Info) — green-v5 §6.3's disclosed residual, confirmed accurate

See §2.5 (SEQ 9/10). A cover that passes the synchronous check and fails
conversion asynchronously does blank a live article's cover and refuse
republication until a good replacement lands. Documented honestly by the green
pass, correctly out of scope for it, and genuinely recoverable.

### I-V5-04 (Info) — the idempotency replay precedes the lock check

See §4. No mutation, cached response only.

### I-V5-05 (Info) — one lock rule, two implementations and two clocks

See §5. `openDraft` decides staleness in SQL against the database clock;
publish and upload decide it in JS against the server clock. Same 90 s today,
and the two agree at the boundary; a divergence would be silent.

---

## 7. Contracts — both sides

### 7.1 In the committed suite

Consumer (Prism) and provider (Schemathesis) both ran as part of every one of
the four suite runs, green each time — 16 `CONTRACT-CONSUMER-*` assertions per
run, including the new `NFR-UPLOAD-LOCK-03` that pins the `409 DRAFT_LOCKED`
branch green-v5 added to `uploadArticleImage`, served by a real Prism mock
generated from the contract at run time:

```
✓ CONTRACT-CONSUMER-uploadArticleImage / NFR-UPLOAD-LOCK-03: the client surfaces DRAFT_LOCKED
  as a branchable code, so a writer whose colleague is mid-edit is told who holds the draft,
  instead of the upload silently replacing their cover  1183ms
✓ CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer test in this file
✓ CONTRACT-PROVIDER-createDraft / openDraft / publishArticle / uploadArticleImage
```

### 7.2 Standalone, at higher depth — 15,452 cases

Two shapes, because the committed harness's default (5 examples/operation,
legacy static auth, an *unseeded* `WRITER_ID` — `05-verification.v4.md`
I-V4-04) reaches neither depth nor the JWT path.

**(1) Unpinned, at depth** — random `articleId`s, so the handler answers 404
before the rate limiter is consulted. This is what v3/v4's e2e agents ran.

| Auth mode | Operation | Cases | Result |
|---|---|---|---|
| **JWT, registered writer** | uploadArticleImage | 1531 | pass |
| **JWT, registered writer** | publishArticle | 1555 | **1 failure → L-V5-02** |
| **JWT, registered writer** | openDraft | 521 | pass |
| **JWT, registered writer** | createDraft | 1395 | pass |
| JWT, stranger `sub` | uploadArticleImage / publishArticle / openDraft / createDraft | 1531 / 1555 / 521 / 537 | pass |
| legacy static, **seeded** writer id | uploadArticleImage / publishArticle | 1531 / 1555 | pass |

The JWT-mode runs are the coverage I-V4-04 asked for: the authorization path
this codebase's last two passes built has now been fuzzed at depth, in both
the registered-writer and stranger shapes, and is clean.

**(2) Pinned** — a copy of the contract whose `articleId` is an `enum` of five
**real** article ids, one per state this pass's fixes care about: publishable;
locked by another writer; ready cover + rejected `failed` cover; ready cover +
`failed` body; only a `failed` cover. These reach the handler, so the in-memory
10/min-per-IP limiter applies — each of 14 bursts got a freshly spawned server.

| Auth mode | Operation | Cases | Result |
|---|---|---|---|
| JWT, registered writer | uploadArticleImage | 546 | rate-limit artefact + I-V5-01 only |
| JWT, registered writer | publishArticle | 1162 | rate-limit artefact + I-V5-01 only |
| JWT, stranger `sub` | uploadArticleImage | 546 | **clean** |
| JWT, stranger `sub` | publishArticle | 966 | **clean** |

Every reported failure in the pinned runs classified to one of exactly two
things, neither of them logic:

```
- API rejected schema-compliant request
  [429] {"error":{"code":"CONFLICT","message":"More than 10 publishes per minute."}}   <- my burst size, not a bug

- API accepted schema-violating request
  Invalid component: parameter `Idempotency-Key` in header - string larger than maxLength   <- I-V5-01
```

**Answer to the brief's question: higher-depth fuzzing found nothing new
around the lock-check or the readiness-filter logic.** Across 3,220 pinned
cases aimed squarely at a draft locked by another writer, an article carrying
a rejected `failed` cover beside a working one, and an article carrying a
`failed` body, there was no server error, no undocumented status, no schema
non-conformance, and no case where a locked draft was mutated or an unready
article published. Every stranger-token case on both target operations was
answered `401`.

### 7.3 Known items, re-checked

- **N5** (NUL byte in `createDraft`'s `title` → 500) — **still open**,
  unchanged, correctly out of scope:
  `NUL byte in title -> 500 INTERNAL_ERROR`, while
  `lone surrogate in title -> 201` and `NUL byte in league_name -> 201`,
  matching `05-verification.v3.md` N5's minimisation exactly. Note that the
  4,000+ `createDraft` cases in §7.2 did **not** rediscover it, which is
  N5b's point about pinning a seed *and* raising the example count.
- **N2** (internal contract's `optimized_url` vs the CDN-origin narrowing) —
  not re-encountered this pass; the internal contract was not fuzzed here.
- **429 is undeclared on every operation** and reaches clients only through
  `default`, carrying `code: "CONFLICT"` — the same code `405` uses.
  Pre-existing, cosmetic, mentioned for completeness.

---

## 8. What was checked and found correct (no finding)

- The `repo.ts` demote guard (`status <> 'failed'`), which green-v5 §5.1 flags
  as covered by **no committed test** — behaviourally confirmed by SEQ 3–8 and
  especially SEQ 7's two good-upload cycles.
- `publishArticle.ts`'s `cover_image_url` change — §2.3, response and
  persisted column.
- `evaluateLock` in upload being *called* rather than re-implemented — proven
  by the 89 s/91 s staleness boundary agreeing with publish (§4).
- The render pass never emitting a `failed` image as a cover, on the article
  page or the homepage card, across all 13 sequences.
- `AC-08-recovery-03`'s boundary, plus four more the committed suite does not
  cover (§2.4).
- The publish-side refusal ordering: lock → cover-required → pronos → image
  readiness, unchanged and correct in every probe.

---

## 9. Recommendation

Nothing High. **M-V5-01** and **M-V5-02** are both the pattern this gate has
now blocked on at v3 (HEIC), v4 (M-V4-01) and here: an acceptance criterion
green in CI, broken against real infrastructure, because the covering test is
aimed at a fake. Applying that standard consistently, both should block.

M-V5-01 is arguably the more urgent of the two in principle (it is the
unfinished half of the finding this pass was convened to close, and the
reasoning that left it open is factually wrong), but M-V5-02 is the one a
writer will hit first — a weekly-fixture CMS whose every new draft is called
`Sans titre` will produce duplicate titles within days, and the writer gets a
bare 500 with no way to understand it.

Both are small, independent repairs, and both belong to a red gate rather than
an implementer: M-V5-01 moves `AC-08-recovery-03`'s premise, and M-V5-02 needs
a test that publishes two same-titled articles through the real server, which
is precisely the test that does not exist today.
