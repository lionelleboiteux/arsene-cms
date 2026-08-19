# arsene-cms — Green gate, seventh remediation pass (v7)

> Gate 4 (green), run a seventh time. This document covers **only** the seventh
> remediation pass: turning `03-red-evidence.v7.md`'s four failing tests green
> for `05-verification.v6.md`'s two blocking findings — **H-V6-01 / M-V6-01**
> (an article whose only cover is a rejected upload publishes live with no
> cover image) and **M-V6-02** (a writer deterministically chooses which image
> row is treated as "superseded"). Both live in the publish-readiness logic
> green v6 rewrote, and the product owner scoped them as one fix family.
>
> Out of scope, unchanged from the red pass's scoping: L-V6-01 (`CDN_ORIGIN`
> unvalidated), L-V6-02 (two unordered picks of "the" cover), L-V6-03 (the
> transient slug race), I-V6-01 (the sanitizer record correction), and the
> standing v3/v4/v5 backlog (N5/N5b, N2, the idempotency-store TTL and
> `writer_id` scoping). §6 says where each of those now stands after this pass,
> because two of them moved without being worked on.

**Status:** green | **Author:** Claude (Opus 5), written by `bob-implementer` |
**Date:** 2026-08-19 | **Branch:** `feat/arsene-cms` (worktree
`arsene-cms+green-v3`, on `8eb1834`) | **Baseline:** the red suite as
`03-red-evidence.v7.md` left it — **221 tests, 4 failing, 217 passing, 37
files**, confirmed by the product owner and re-derived here.

**Result: 221 tests, 221 passing, 37 files, three consecutive full runs plus a
coverage run. `tsc --noEmit` exit 0. No test file was created, edited or
deleted — not one assertion, not one fixture, not one line.**

Production changes: **two lines of behaviour** in `src/api/publishArticle.ts`
(one predicate, one resolution, both now calling one new 3-line helper) and
**one `revoke`** in a new expand-only migration. Plus four prose paragraphs in
`contracts/openapi.yaml`, because the revoke removes a capability the contract
described in words (§5).

---

## 1. The commands, and their output

### 1.1 The full suite

Run three times end to end — twice on the code fix alone, once more after the
contract prose edits — against real Postgres 16 (Testcontainers), real spawned
child-process servers over real HTTP, real Prism, real Schemathesis, and the
real `sharp` codec.

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  37 passed (37)
      Tests  221 passed (221)
   Start at  08:23:29
   Duration  33.31s (transform 1.04s, setup 0ms, collect 10.30s, tests 159.88s, environment 6ms, prepare 2.49s)
```

```
 Test Files  37 passed (37)
      Tests  221 passed (221)
   Start at  08:24:10
   Duration  54.95s (transform 1.29s, setup 0ms, collect 13.60s, tests 293.77s, environment 5ms, prepare 3.18s)
```

```
 Test Files  37 passed (37)
      Tests  221 passed (221)
   Start at  08:27:56
   Duration  37.03s (transform 1.30s, setup 0ms, collect 11.03s, tests 179.40s, environment 7ms, prepare 2.74s)
```

`NFR-IMGCPU-01` — the wall-clock-budget flake every prior pass has had to
disclaim — did not fire in any of the four runs (three above plus the coverage
run), so no re-run allowance was used:

```
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 1328ms
```

### 1.2 Types

```
$ npx tsc --noEmit
TSC_EXIT=0
```

### 1.3 What was touched

```
$ git status --short
 M pdlc/arsene-cms/contracts/openapi.yaml
 M src/api/publishArticle.ts
?? db/migrations/0004_image_role_service_role_only.sql

$ git diff --stat
 pdlc/arsene-cms/contracts/openapi.yaml | 40 ++++++++++++++++++++++++----------
 src/api/publishArticle.ts              | 29 +++++++++++++++++++-----
 2 files changed, 52 insertions(+), 17 deletions(-)
```

No file under `tests/` appears, including the test-*support* modules — unlike
v5 and v6, this pass needed no new seam and no new fake. `state.json`
untouched. Nothing committed; the tree is left unstaged for review.

---

## 2. Every finding, what closed it, and the tests that prove it

| Finding | What was actually wrong | The change | Tests that prove it |
|---|---|---|---|
| **H-V6-01 / M-V6-01** — an article whose only cover row is a rejected upload publishes live with `cover_image_url: ''` | `refusePublish()` asked `images.some(i => i.role === 'cover')` while the readiness gate asked `articleDependsOn(i, images)`. A rejected upload (`original_url is null`) satisfies the first and is correctly excluded by the second, so nothing refused the publish and `publishNow()` fell through to `?? ''`. The two checks agreed by construction until green v6 stopped keying `articleDependsOn()` on `role` | `src/api/publishArticle.ts`: one new `usableCover(images)` — `role === 'cover' && articleDependsOn(image, images)` — used **both** by the `COVER_IMAGE_REQUIRED` refusal **and** by `publishNow()`'s `cover_image_url` resolution. One notion of "has a cover", in the only two places that have one | `AC-08-recovery-07`, `AC-08-recovery-08`, `NFR-COVER-INVARIANT-01` (4-combination sweep), with `NFR-COVER-INVARIANT-02` as the both-sides control |
| **M-V6-02** — a writer vacates the cover slot, moves a broken, genuinely-used image into it, and the next ordinary cover upload records *that* row as superseded, so it stops blocking | `db/migrations/0001_initial_schema.sql`'s `grant update (role, alt_text) on article_images to authenticated`. `demoteCurrentCover()`'s `update … where role='cover' returning id` is correct; the writer choosing which row it matches is not | `db/migrations/0004_image_role_service_role_only.sql`: `revoke update (role) on article_images from authenticated;` — the precedent `0003_lock_columns_service_role_only.sql` set for `locked_by`/`locked_at`, for the same reason: an application-level rule is only a rule if the grant line agrees | `NFR-IMAGE-ROLE-02`, with `NFR-IMAGE-ROLE-01` and `AC-08-recovery-06` unchanged and still green |

Verbatim, from the third run in §1.1 — the five tests the red pass added:

```
 ✓ tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > AC-08-recovery-07: an article whose only cover-role image is a rejected upload is still refused at publish and stays a draft — a file the product itself refused, stored nowhere and convertible into nothing, is not a cover image, and answering COVER_IMAGE_REQUIRED before it was uploaded but 200 afterwards is the two checks disagreeing about what "has a cover" means 571ms
 ✓ tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > NFR-COVER-INVARIANT-01: across every combination of image states, a publish answered 200 always carries a non-empty cover image — the invariant itself, rather than another enumeration of the specific states this one function has now silently dropped twice 836ms
 ✓ tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > NFR-COVER-INVARIANT-02: an article whose cover is genuinely ready still publishes 200 and its page really carries that cover’s CDN URL — the both-sides half, so reconciling the two checks cannot be done by refusing publishes that were always legitimate
 ✓ tests/e2e/coverImageInvariant.test.ts > a publish that succeeds always has a cover image (verify v6, §2) > AC-08-recovery-08: an already-live article that publish is correctly refusing COVER_IMAGE_REQUIRED is not pushed live again by uploading a broken replacement cover, and the cover its public page is already serving is not overwritten with an empty one — the same disagreement as AC-08-recovery-07, reached from the state where it costs a page that was already correct
 ✓ tests/e2e/rejectedImageRecovery.test.ts > recovering from rejected and superseded image uploads (verify v5, §3) > NFR-IMAGE-ROLE-02: a writer who vacates the cover slot and moves a broken, genuinely-used body image into it before uploading a replacement cover still cannot publish — choosing which row the next upload supersedes is choosing which row stops blocking, and one image row per article is not a decision a writer gets to make about their own article’s integrity 333ms
```

And the twelve pre-existing tests in this family, none of them touched, all
still green (same run):

```
 ✓ tests/unit/publishArticle.test.ts > publish refusals > AC-08a: publishing a cover image still being optimised is refused with 409 IMAGE_NOT_READY
 ✓ tests/unit/publishArticle.test.ts > publish refusals > AC-08b: publishing a body image that failed optimisation and was never replaced is refused with 409 IMAGE_NOT_READY
 ✓ tests/e2e/rejectedImageRecovery.test.ts > ... > AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes ...
 ✓ tests/e2e/rejectedImageRecovery.test.ts > ... > AC-08-recovery-05: a cover still converting when a second cover upload supersedes it, and which the Lambda only then reports as failed, does not block republication either ... 402ms
 ✓ tests/e2e/rejectedImageRecovery.test.ts > ... > AC-08-recovery-06: a body image the article is genuinely still using — stored, referenced from its own body_html, and broken — does keep refusing the publish, 409 IMAGE_NOT_READY ...
 ✓ tests/e2e/rejectedImageRecovery.test.ts > ... > NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article ...
 ✓ tests/e2e/coverReplacementRecovery.test.ts > ... > AC-08-recovery-01: a truncated file uploaded as a new cover leaves the article’s existing ready cover exactly where it was, and the live page still shows it ... 533ms
 ✓ tests/e2e/coverReplacementRecovery.test.ts > ... > AC-08-recovery-02: after a truncated cover upload is rejected, the article still republishes ... 641ms
 ✓ tests/e2e/coverReplacementRecovery.test.ts > ... > AC-08-recovery-03: an image the article is genuinely still using and that failed to convert does keep refusing the publish, 409 IMAGE_NOT_READY ...
 ✓ tests/db/schema.test.ts > alt text > AC-15: a writer can overwrite generated alt text with a direct row update, no endpoint involved 316ms
 ✓ tests/db/schema.test.ts > migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only
 ✓ tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-02: a publish refused for a missing cover image leaves the article unpublished and writes no article_published row at all
```

`AC-15` and `NFR-MIGRATE-01` are in that list on purpose: they are the two
tests the migration could plausibly have broken, and neither did (§3.2).

### 2.1 The cover check, in full

Before:

```ts
if (!images.some((image) => image.role === 'cover')) { … 400 COVER_IMAGE_REQUIRED }
…
cover_image_url:
  images.find((image) => image.role === 'cover' && image.status === 'ready')?.optimized_url ?? '',
```

After — three call sites, one predicate:

```ts
if (usableCover(images) === undefined) { … 400 COVER_IMAGE_REQUIRED }
…
cover_image_url: usableCover(images)?.optimized_url ?? '',

function usableCover(images: ImageRecord[]): ImageRecord | undefined {
  return images.find((image) => image.role === 'cover' && articleDependsOn(image, images));
}
```

`articleDependsOn()` itself is **unchanged**. That matters: it is the function
this fix family has rewritten twice, and the finding was never that it was
wrong — verify v6 §2 says so explicitly ("correctly redesigned in principle").
The bug was that one of its two callers wasn't calling it.

Why the invariant now holds structurally rather than by enumeration, which is
what `NFR-COVER-INVARIANT-01` exists to force:

1. A `200` requires `refusePublish()` to return `null`, which requires
   `usableCover(images) !== undefined` — some row `C` with `role === 'cover'`,
   `original_url !== null`, and named by no other row's
   `replaced_cover_image_id`.
2. The readiness gate then refuses `409 IMAGE_NOT_READY` for **any** image with
   `status !== 'ready' && articleDependsOn(...)`. `C` satisfies
   `articleDependsOn` by (1), so if `C` were not `ready` the publish would have
   been refused. Therefore `C.status === 'ready'`.
3. `publishNow()` reads `usableCover(images)` — the same `find`, the same
   array, the same predicate, so the same row `C`.

So a `200` carries `C.optimized_url`, and the only way that is empty is a
`ready` row with a null `optimized_url`. The callback route refuses that
(`router.ts`'s `imageStatusBody`: `status: 'ready'` requires a non-empty
`optimized_url` on the configured CDN origin), and `authenticated` has no grant
on `status` or `optimized_url`. That is why the `?? ''` fallback is now the one
uncovered branch in the file (§4.2) — this time provably, not by assumption.
Green v6 called the same fallback "unreachable" and it was reachable in two
product calls; I would rather show the argument than repeat the claim.

### 2.2 The four sweep combinations, and why the fourth still publishes

`NFR-COVER-INVARIANT-01` is the test I trusted least to pass for the right
reason, because a "refuse everything" fix passes three of its four
combinations. Traced by hand against the code, then confirmed by the run:

| Combination | Rows at publish time | Outcome | Why |
|---|---|---|---|
| `rejected-cover-only` | one `cover`/`failed`, `original_url null` | `400 COVER_IMAGE_REQUIRED` | no `usableCover` |
| `rejected-cover-beside-a-ready-body-image` | above + a `body`/`ready` seeded row | `400 COVER_IMAGE_REQUIRED` | a body image is not a cover; the cover slot is still empty |
| `rejected-cover-and-rejected-body` | two rejected rows, both `original_url null` | `400 COVER_IMAGE_REQUIRED` | neither is adopted; the rejected *body* row still correctly does not block (M-V5-01 stays closed) |
| `ready-cover-plus-a-rejected-cover` | a `cover`/`ready` seeded row + a `cover`/`failed` rejected upload | **`200`, with the ready cover's real URL** | `uploadImage.ts` demotes nothing for a file it rejects (M-V4-01), so the ready row keeps `role='cover'`, is adopted, is unsuperseded — `usableCover` finds it and skips the rejected row |

The fourth is M-V4-01's shape and the reason a "tighten `COVER_IMAGE_REQUIRED`
until it stops failing" fix is not admissible. `NFR-COVER-INVARIANT-02` and
`AC-08-recovery-02` say the same thing from the other side, and both are green.

### 2.3 The mechanism I chose for M-V6-02, and the one I rejected

`NFR-IMAGE-ROLE-02` admits two shapes, and its header says so: revoke the
grant, or keep it and stop letting supersession excuse a row the article still
genuinely uses. **I took the revoke.** The reasoning, since this is the
decision most worth arguing with:

- **The gate-side alternative has no clean discriminator.** The row the exploit
  targets (`B`: adopted, `failed`, referenced from `body_html`) and the row
  M-V5-02's fix legitimately excuses (a cover demoted while `processing`, later
  reported `failed`) are *identical* on every column the gate reads:
  `original_url` present, `optimized_url` null, `status: 'failed'`, named by
  another row's `replaced_cover_image_id`. The only thing that distinguishes
  them is that `B` is referenced from the article's own `body_html`. Closing
  M-V6-02 gate-side therefore means parsing `body_html` for `data-image-id`
  inside the readiness gate — a new HTML dependency in the publish path, in the
  one function this family has already rewritten twice — and it would still be
  decided by a column any writer can write, because `body_html` is *also*
  directly writable (`grant update (title, body_html, …)`). It trades one
  writer-controlled input for another and costs an order of magnitude more code.
- **The revoke is one line and matches an existing precedent exactly.**
  `0003_lock_columns_service_role_only.sql` is the same fix for the same class
  of defect: 0001 granted a column that an application-level rule depended on,
  so the rule was advisory. `04-green-evidence.v3.md` §5.1's sentence — "the
  application-level CAS is only a lock if the data layer agrees it is" — is
  this finding restated.
- **Nothing in the suite or in `src/` needs the grant.** Checked, not assumed:
  no test writes `article_images.role` except the two adversarial ones
  (`NFR-IMAGE-ROLE-01`/`02`, both `.catch(() => undefined)` and both asserting
  the downstream `409`); no code in `src/` writes it as `authenticated`
  (`demoteCurrentCover()` is `repo.ts`, and `router.ts`'s pool runs `set role
  service_role`, which `0002` grants `all on all tables`); the only `article_images`
  grant assertion in the schema suite is `AC-15`, which is `alt_text` and is
  untouched. The contract *prose* did describe the capability, which is a real
  cost and is dealt with in §5 and §6.1 rather than glossed over.

**Instrumentation proof** that the revoke does what the argument says, rather
than `NFR-IMAGE-ROLE-02` passing for some other reason. A throwaway
`tests/tmp-grant-proof.test.ts`, run once against the real container and then
deleted (it is not in the diff, and no test file was added to the suite):

```
{
  "role_to_body": "42501",
  "role_to_cover": "42501",
  "alt_text": null,
  "row": {
    "role": "cover",
    "alt_text": "ok"
  }
}
```

Both `role` writes get `42501` as `authenticated`; the `alt_text` write still
succeeds and lands (AC-15); the row's `role` is unchanged. So in
`NFR-IMAGE-ROLE-02` the real cover keeps the slot, the replacement supersedes
*it*, and `B` — adopted, `failed`, still in `body_html` — goes on blocking:
`409 IMAGE_NOT_READY`, which is what the test observes.

---

## 3. Where each change was put, and why there

### 3.1 `usableCover` is in `publishArticle.ts`, next to `articleDependsOn`

Not in `repo.ts` (it is a publish-time policy question, not a storage one, and
every other publish refusal is decided and unit-tested in this handler), not in
`domain/` (it reads `ImageRecord`, which is this module's type), and not
inlined twice (inlining it twice is precisely the defect being fixed — two
copies of "has a cover" that drifted apart). It is three lines and has exactly
two call sites; extracting it is the smallest change that makes the drift
impossible rather than merely fixed.

I did **not** thread the resolved row from `refusePublish()` through to
`publishNow()`, which would make step 3 of §2.1's argument a compile-time fact
instead of a `find` repeated on the same array. That is a signature change to
two functions and a restructuring of the refusal/publish split for a property
`find` already gives; not worth it at this size, and recorded here so the next
verify pass evaluates it as a decision rather than an oversight.

### 3.2 The revoke is a new migration, not an edit to `0001`

`0001` is deployed and Supabase applies migrations forward, so it is edited by
nobody — the precedent `0002` and `0003` both set. `NFR-MIGRATE-01`'s
expand-only rule is satisfied in substance as well as by its regex: `revoke` is
not a drop or a retype, no column or data disappears, only a privilege narrows.
The file is `0004_image_role_service_role_only.sql`, named after `0003` because
it is the same move on a different table.

The test database (`tests/support/pg.ts`) applies `db/migrations/*.sql` in
order for every container, so all 37 files ran against the revoked grant — this
is not a change only the two adversarial tests saw.

---

## 4. Coverage — measured, with the parts that are not measurable named

```
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run --coverage
```

```
 Test Files  37 passed (37)
      Tests  221 passed (221)

 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   82.66 |    86.41 |   87.68 |   82.66 |
 api               |   75.76 |    82.02 |      80 |   75.76 |
  auth.ts          |     100 |      100 |     100 |     100 |
  client.ts        |   97.64 |    73.68 |     100 |   97.64 | 91,97
  createDraft.ts   |    84.9 |     37.5 |     100 |    84.9 | 50-51,79-80,84-87
  http.ts          |     100 |      100 |     100 |     100 |
  imageStatus.ts   |     100 |    93.33 |     100 |     100 | 82
  ...ishArticle.ts |     100 |    98.07 |     100 |     100 | 304
  rateLimit.ts     |   57.14 |      100 |      50 |   57.14 | 24-29
  repo.ts          |   57.85 |    60.86 |   57.14 |   57.85 | ...38-244,247-269
  router.ts        |   57.46 |    69.33 |   73.33 |   57.46 | ...86-588,590-593
  server.ts        |     100 |       95 |     100 |     100 | 56
  serverMain.ts    |       0 |        0 |       0 |       0 | 1-63
  uploadImage.ts   |   93.75 |     92.3 |     100 |   93.75 | 83-86,90-93
 client            |     100 |    84.61 |     100 |     100 |
  fixturePicker.ts |     100 |    84.61 |     100 |     100 | 39-41
 domain            |   95.87 |    90.78 |   95.65 |   95.87 |
  autosave.ts      |     100 |       90 |     100 |     100 | 40
  lock.ts          |     100 |      100 |     100 |     100 |
  paste.ts         |     100 |       90 |     100 |     100 | 20
  pronosEntry.ts   |     100 |      100 |     100 |     100 |
  seo.ts           |   90.72 |    80.76 |    92.3 |   90.72 | 45-51,74,87
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

Against v6 (`04-green-evidence.v6.md` §4): **82.60 → 82.66 statements, 86.32 →
86.41 branch, 87.59 → 87.68 functions**. Up on all three, by a fraction — five
new e2e tests exercise paths that were already covered, and the fix removed one
partly-covered expression. Nothing structural moved; these numbers are noise
around an unchanged shape, and I would not defend the deltas as meaning
anything.

The same measurement caveat every prior pass recorded still applies and is the
reason the aggregate sits in the low 80s rather than higher: the e2e and
contract suites drive **spawned child processes**, which the in-process v8
instrumenter cannot see. `router.ts` (57.46), `repo.ts` (57.85) and
`serverMain.ts` (0.00) are the three files most exercised by this pass's five
new tests and the three that report lowest, because every one of those requests
executed in a different process. `serverMain.ts` at 0% is not untested code; it
is the entry point of the process every e2e test in this pass talks to.

### 4.1 What this pass added, and whether it is covered

| Added | Covered | By what |
|---|---|---|
| `usableCover()` (3 lines, `publishArticle.ts`) | **Yes**, both call sites, both outcomes | Refusal side: `AC-08-recovery-07`, `-08`, three sweep combinations, `E2E-02`, `tests/unit/publishArticle.test.ts`'s `COVER_IMAGE_REQUIRED` case. Publish side: `NFR-COVER-INVARIANT-02` (asserts the exact URL in both the response and the persisted `structured_data`), sweep combination 4, `E2E-01`, `E2E-03` |
| `0004_image_role_service_role_only.sql` | **Yes, in effect; no, as a line** | Migrations are SQL and are not instrumented. Its effect is asserted by `NFR-IMAGE-ROLE-02` (which needs it to reach `409`) and, more weakly, by `NFR-IMAGE-ROLE-01` (which passes either way — its header says so). `AC-15` proves the revoke was *narrow*: `alt_text` still writes |

`publishArticle.ts` goes 99.44 → **100.00 statements / lines**, because v6's
uncovered line 287 was the multi-line `cover_image_url` expression whose second
line the suite never reached; it is now one line that every successful publish
executes.

### 4.2 What is uncovered, and whether it matters

- **`publishArticle.ts` line 304, one branch** — the `?? ''` in
  `usableCover(images)?.optimized_url ?? ''`. This is the empty-cover fallback,
  and **its being uncovered is the point of this pass**: no test in the suite
  can reach it any more, including the four written specifically to reach it.
  §2.1 gives the argument for why no product path can either. It stays in the
  code because `ImageRecord.optimized_url` is typed `string | null | undefined`
  and the view field is `string`; removing it would mean a non-null assertion,
  which is a worse way to say the same thing. **Honest caveat:** "uncovered
  because unreachable" is exactly what green v6 said about this expression
  before verify v6 published it in two calls. The difference is that the claim
  now rests on a refusal that runs first in the same function, not on a
  property of the upload route — but it is still an argument, and it is the
  thing I would attack first if I were the verify pass.
- **`repo.ts` 57.85 / `router.ts` 57.46 / `serverMain.ts` 0.00** — the
  child-process measurement gap above. `demoteCurrentCover()` sits in that gap:
  it is executed by `AC-08-recovery-05` and `NFR-IMAGE-ROLE-02` over real HTTP
  against a real database, and reported as uncovered. Unchanged by this pass,
  and the reason no number here should be read as "this code is untested".
- **`rateLimit.ts` 57.14, `createDraft.ts` 37.5 branch, `client.ts` 73.68
  branch, `heic.ts` 60 branch** — all pre-existing, all unchanged, all
  documented at v4-v6. Not re-argued here.
- **Error paths of this pass's own change:** there are none beyond the two
  refusals, and both are covered by end-to-end tests that assert the status
  code, the error code and the database state after the refusal — including
  that the already-live article's `structured_data` was *not* overwritten
  (`AC-08-recovery-08`), which is the assertion I would most want if I were
  reviewing this.

---

## 5. Contract prose changed; no schema did

Four prose edits to `pdlc/arsene-cms/contracts/openapi.yaml`. No `pattern`,
`type`, `enum`, `required`, `example` shape or response schema changed, which
is why Prism and Schemathesis are both still green (§1.1, all four
`CONTRACT-PROVIDER-*` and every `CONTRACT-CONSUMER-*`). The file still parses
as OpenAPI 3.1 with four paths.

- **`info.summary`** and **"What is in scope"** listed "cover/body re-tagging
  after upload" among the things the editor does by direct PostgREST. After
  migration `0004` it cannot. Both now say so, and the in-scope section carries
  a short paragraph naming the migration, the reason (which row holds the cover
  slot decides which row the next upload supersedes), and the fact that
  re-tagging an existing image has no route yet.
- **"What is out of scope"** said "alt-text/role edits after upload" are direct
  PostgREST operations. Now "alt-text edits"; the `role` half points at the
  paragraph above.
- **`publishArticle`'s `COVER_IMAGE_REQUIRED` paragraph** said the refusal
  fires when the article "has no image with `role: cover`". That is the exact
  sentence the code implemented and the exact sentence H-V6-01 disproved. It now
  says "no *usable* cover", names the same two exclusions the
  `IMAGE_NOT_READY` paragraph below it already lists, and states the case
  outright: a file this API refused is a `cover` row but not a cover image.

Leaving the first three would have documented a capability the product no
longer has; leaving the fourth would have documented behaviour the code no
longer has, which is what verify v6 §2 caught green v6 doing in the other
direction.

**One stale sentence I deliberately did not fix.** "What is out of scope" still
lists "lock **heartbeat refresh** by the writer who already holds it" among the
direct PostgREST operations. That has been untrue since
`0003_lock_columns_service_role_only.sql` revoked `update (locked_by,
locked_at)` at green v3 — the same drift, one pass earlier, on the same kind of
change. It is not this pass's finding and fixing it would be an undeclared
edit to a document under someone else's gate; recorded here so it is a known
gap rather than a discovery.

---

## 6. Deviations, and things left honestly open

### 6.1 The revoke removes a capability and ships without its replacement

This is the one I most want reviewed. `revoke update (role) on article_images
from authenticated` deletes the only mechanism a writer has to designate an
*existing* image as the cover. After this pass:

- **Still works:** uploading a new file with `role=cover`
  (`POST /v1/articles/{id}/images`), which demotes the previous cover
  server-side and is where AC-06's cover uniqueness was always decided. This is
  the flow every acceptance criterion and every test uses.
- **No longer works:** "make this image I already uploaded the cover", and its
  mirror "demote the cover to a body image". A writer who wants a different
  cover must re-upload the file.

`05-verification.v6.md` §3 says the revoke "must land together with a
server-side route for cover selection"; `03-red-evidence.v7.md` §5.1 says
plainly that nothing in the suite tests such a route, so **nothing will notice
if it is forgotten**. It is forgotten as of this commit: I did not build it.
The reasons, stated so they can be disagreed with:

- Its shape is a product decision (a new endpoint? a `role` parameter on an
  existing one? a `cover_image_id` on `articles`, which L-V6-02 would also
  want?) and inventing one to satisfy a finding nobody tested is exactly the
  speculative work this gate is supposed to refuse.
- No acceptance criterion, no test, and no code in `src/` exercises the
  capability. The only place it was ever promised is the contract's prose, and
  §5 now records that it is gone rather than leaving the promise standing.
- The security defect is live in the deployed grant today; the missing
  convenience is not a regression against any tested behaviour. Shipping the
  revoke now and the route when it is specified is the ordering that leaves the
  smaller hole.

**This is a real product regression, not a technicality**, and it should be
scheduled rather than closed. If the reviewer disagrees, the alternative is
§2.3's gate-side fix, which keeps the capability and costs `body_html` parsing
in the publish path — I would take that trade only if a writer flow genuinely
depends on re-tagging.

### 6.2 `articleDependsOn()` and `demoteCurrentCover()` were not touched

Deliberately. Both were correct; the finding was in their caller and in the
grant. Verify v6 §2 confirms the redesign is right in principle and that the
"excluded when it shouldn't be" class had exactly one reachable member, which
this pass closed at the other end. Rewriting the predicate a third time to
close a bug that lives outside it is how this family produced M-V5-03 and then
H-V6-01.

### 6.3 `publishNow()` and `render.ts` still pick the cover independently

L-V6-02, explicitly out of scope. `publishNow()` now picks
`role === 'cover' && articleDependsOn(...)`; `src/site/render.ts` still runs
`where i.role = 'cover' and i.status = 'ready' limit 1`, unordered. They agree
for every state the product can now produce — a superseded row has had its
`role` set to `'body'` by the demote, and with `0004` in place a writer can no
longer put it back, so at most one row can satisfy either predicate. That is a
narrowing of L-V6-02, not a fix: the finding's real content is that the two
picks are written twice and would diverge again if two `ready` cover rows ever
coexisted. The durable fix is a persisted `cover_image_id` or a shared
`order by`, and it belongs with L-V6-02.

### 6.4 The standing backlog, unchanged

L-V6-01 (`CDN_ORIGIN` accepted unvalidated), L-V6-03 (the transient slug race,
still a 500 under concurrency), I-V6-01 (the sanitizer record correction), the
idempotency store's missing TTL and `writer_id` scoping, and N5/N5b/N2 are all
untouched and still open. L-V6-01 was scheduled by verify v6 to land "with
M-V6-02's migration"; it did not, because the product owner's scoping for this
pass excluded it and it shares nothing with the revoke but a filename prefix.
Named here rather than allowed to disappear between documents.

### 6.5 Nothing else was touched

No test file, no test-support file, no `state.json`, no `traceability.md` (red
passes own it in this workflow, and its v7 section already records the
`NFR-IMAGE-ROLE-01`-under-revocation note this pass relied on), no
`uploadImage.ts`, no `repo.ts`, no `router.ts`. Nothing committed; the working
tree is left unstaged for review.

---

## 7. Files changed

| File | Change | Finding |
|---|---|---|
| `src/api/publishArticle.ts` | New `usableCover(images)`; `COVER_IMAGE_REQUIRED` now refuses on it instead of on `role === 'cover'`; `publishNow()`'s `cover_image_url` resolves through the same helper instead of its own `role/status` `find`. `articleDependsOn()` unchanged | H-V6-01 / M-V6-01 |
| `db/migrations/0004_image_role_service_role_only.sql` | **New.** `revoke update (role) on article_images from authenticated;` — expand-only, following `0003`'s precedent for the lock columns. `alt_text` untouched | M-V6-02 |
| `pdlc/arsene-cms/contracts/openapi.yaml` | Prose only (§5): `role` re-tagging is no longer a direct-PostgREST capability (3 places), and `COVER_IMAGE_REQUIRED` is described as "no *usable* cover" rather than "no `role: cover` row" | M-V6-02, H-V6-01 |

---

## 8. Gate statement

221 tests, 221 passing, 37 files, three consecutive full runs plus a coverage
run, all against real Postgres 16 (Testcontainers), real spawned child-process
servers over real HTTP, real truncated and real valid multipart JPEG bytes, a
real image conversion carried to `ready`, real Prism and real Schemathesis.
`tsc --noEmit` exit 0. The red pass's four failing tests are green; its control
(`NFR-COVER-INVARIANT-02`) and the twelve pre-existing image/publish tests are
still green and were not touched. **No test file was created, edited or deleted
— no assertion, no fixture, no line.** The whole behavioural change is one
3-line helper called from two places, and one `revoke` in a new expand-only
migration. Coverage 82.66% statements / 86.41% branch / 87.68% functions, up a
fraction on v6 and meaningless at that resolution; the one uncovered branch in
`publishArticle.ts` is the empty-cover fallback, and §4.2 says both why that is
the point and why I do not fully trust the word "unreachable" about it. One
capability was removed without a replacement and is recorded as open, not
closed (§6.1). `state.json` untouched, nothing committed. Green.
