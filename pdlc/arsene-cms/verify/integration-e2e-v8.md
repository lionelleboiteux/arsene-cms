# arsène-cms — Verify gate v8, integration/e2e portion

**Run:** 2026-08-20, worktree `arsene-cms+green-v3`, against commit `526847b`
("Pass green gate, remediation v8: 227/227").
**Scope:** the integration/e2e portion only — full regression, both sides of the
contract, and a hand-driven adversarial re-verification of the three fix areas
green v8 delivered (§4 recovery route, M-V7-02 render fallback, L-V7-01 cover
uniqueness).
**Method:** four full suite runs (two against a pristine `git archive HEAD`
export), `tsc --noEmit`, 886 Schemathesis cases at 400 examples/check, and
eight hand-built scenario batteries driven over real HTTP against a real
spawned server and a real migrated Postgres 16 — **101 hand-driven checks,
0 failures**.

**Nothing High-severity was found.** All three fix areas verify as real.

---

## 0. Executive summary

- **All three fixes are genuine, and hold up under attack far past what the
  committed tests try.** 101 hand-driven checks across 8 batteries, 0 failures.
  The recovery route resolves both of v7 §4's original routes to a permanently
  stuck article; it also resolves chained and simultaneous stuck states, and it
  refuses everything the article genuinely needs through all 20 request shapes
  and 1,344 ad-hoc fuzz cases I could construct. M-V7-02 is closed with 300
  consecutive samples of a genuinely-open conversion window, every one serving
  the last-known-good cover. `0005` holds, and the `23505 → body` fallback that
  green v8 §6.2 records as reached by *no test in the suite* is reached here,
  repeatedly, and works.
- **An independent randomised re-derivation of the recovery invariant passes.**
  40 randomised sequences of product routes only, reaching 33 distinct settled
  image-state shapes; every one recovers to a `200` publish with a real cover
  through product routes alone, always inside 12 rounds, with no 5xx.
- **The contract-coverage gap green v8 §7 declares is real, and slightly wider
  than the document frames it.** The discard route is not a path item, so
  `contractOperations()` returns 4 operations, `CONTRACT-COVERAGE` demands no
  consumer case, and `provider.schemathesis.test.ts`'s `it.each` generates no
  provider test — **zero contract coverage on both sides**, exactly as
  declared. What the document does not say plainly: `src/api/client.ts` has no
  `discardArticleImage` method either, so **the editor SPA has no supported way
  to call the capability this entire pass exists to deliver** (M-V8-01 below).
  That is a completeness gap, not a correctness defect — the server side is
  verified working end to end.
- **The workspace-hygiene hazard flagged five times has now actually corrupted
  gate evidence**, not merely risked it: an untracked `tests/perf/` written by a
  concurrently-running agent turned my third full-suite run into **41 files /
  228 tests** mid-pass. Verified against a pristine export (§1). Sixth mention.
- Three further Low/Info findings, all new this pass: no rate-limit budget on
  the discard route (confirmed quantitatively), the discard is a hard delete
  with no audit trail and orphaned storage, and the render fallback's source is
  "last *published* cover" rather than "last known good", which can visibly
  rewind a live page's image backwards without a writer action.

---

## 1. Regression suite — four clean runs, and one contaminated one worth reading

| # | Tree | Files | Tests | Exit | `NFR-IMGCPU-01` |
|---|---|---|---|---|---|
| 1 | worktree | 40 | **227 passed** | 0 | 592 ms |
| 2 | worktree | 40 | **227 passed** | 0 | 747 ms |
| 3 | worktree | **41** | **228 passed** | 0 | 759 ms |
| 4 | pristine `git archive HEAD` | 40 | **227 passed** | 0 | 850 ms |
| 5 | pristine `git archive HEAD` | 40 | **227 passed** | 0 | 824 ms |

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test          # runs 1, 2
 Test Files  40 passed (40)
      Tests  227 passed (227)
   Duration  37.51s / 39.39s

$ cd /tmp/arsene-pristine && npx vitest run   # runs 4, 5, from git archive HEAD
 Test Files  40 passed (40)
      Tests  227 passed (227)
   Duration  39.20s / (run 5) EXIT=0
```

`tsc --noEmit` exit 0 on the worktree, and exit 0 again on the pristine export.

**`NFR-IMGCPU-01` did not flake in any run** — 592/747/759/850/824 ms against a
1,000 ms budget. The confirming isolated re-run the brief allows for was never
needed.

### 1.1 Run 3 — the contaminated run, and why it is reported rather than dropped

Run 3 reported 41 files / 228 tests. The diff of collected files against run 1:

```
$ diff run1-files run3-files
> tests/perf/discardRoute.perf.test.ts

$ git status --porcelain
?? tests/perf/
$ ls tests/perf/
discardRoute.perf.test.ts    indexCost.perf.test.ts
```

Untracked scratch files written into this shared worktree by a concurrently
running perf agent, mid-pass, between my run 2 and run 3. They were picked up by
`vitest`'s glob and silently changed the suite's headline number — the single
number every gate document in this chain quotes as its evidence.

This is the hazard recorded at v4 §8, v5 §7, v6 §9, v7 §1 and as I-V7-03. Every
prior mention was "this risks contaminating a measurement". **This pass is the
one where it did.** Runs 4 and 5 against a pristine `git archive HEAD` export are
therefore the authoritative ones, and they confirm the committed tree is exactly
227/227. Recorded again as **I-V8-01** with a recommendation to stop asking
nicely (§6).

---

## 2. Both sides of the contract

### 2.1 The committed suite, as it stands

Both contract test files enumerate through `contractOperations()`
(`tests/support/openapi.ts`), which walks `paths` and collects anything with an
`operationId`. Against the committed `openapi.yaml` that is exactly four:

```
POST   /v1/articles                               createDraft
POST   /v1/articles/{articleId}/open              openDraft
POST   /v1/articles/{articleId}/publish           publishArticle
POST   /v1/articles/{articleId}/images            uploadArticleImage
```

All four `CONTRACT-PROVIDER-*` and all consumer cases pass in every full run.

### 2.2 The gap, confirmed precisely

green v8 §7 says the discard route is "documented in prose rather than as its
own path item". Confirmed, and here is what that costs, mechanically:

| Question | Answer | Evidence |
|---|---|---|
| Is `/v1/articles/{articleId}/images/{imageId}` a declared path item? | **No** | `paths` keys are the four above |
| Does any operation in the contract use `DELETE`? | **No** | zero `DELETE` verbs in the document |
| Does `CONTRACT-COVERAGE` require a consumer case for it? | **No** — it asserts `CONSUMER_CASES == declared operationIds`, and it is not declared | `consumer.prism.test.ts:194-198` |
| Does Schemathesis fuzz it? | **No** — `it.each(contractOperations())` yields 4 tests | `provider.schemathesis.test.ts:62-66` |
| Is it described in prose? | **Yes**, with an explicit `> Contract status` note | `openapi.yaml` ~line 673-691 |
| Does `src/api/client.ts` expose it? | **No** — `createDraft`, `openDraft`, `publishArticle`, `uploadArticleImage` only | — |

So green v8's own description is **accurate**: the committed consumer/provider
contract suite does not fuzz or test this route at all, on either side. The
deviation is declared honestly and the reasoning (declaring the operation would
require editing `CONTRACT-COVERAGE`'s assertion, which the gate forbids) is
sound.

The part the document under-states is the last row of that table — see
**M-V8-01** in §6.

### 2.3 Higher-depth Schemathesis on the two entangled operations

`--max-examples 400 --checks all`, against the real spawned server on a real
migrated database:

```
--- publishArticle (max-examples 400) exit=0 ---
     Examples / Coverage / Fuzzing: all passed
     Test cases: 455 generated, 455 passed

--- uploadArticleImage (max-examples 400) exit=0 ---
     Examples / Coverage / Fuzzing: all passed
     Test cases: 431 generated, 431 passed
```

**886 combined cases, zero failures.** Nothing new surfaced on either operation.

Both runs emit the same advisory Schemathesis has emitted in prior passes
("Schema validation mismatch: 1 operation mostly rejected generated data due to
validation errors") — the contract's `multipart/form-data` body is looser than
`uploadImage.ts`'s real validation, so most generated bodies are correctly
`400`ed. Not a check failure, exit 0 either way, and unchanged by this pass.

### 2.4 Ad-hoc fuzzing of the undeclared route, to fill the gap the suite cannot reach

Since no committed test can reach it, I fuzzed it by hand: 13 article ids × 12
image ids × 8 methods × 7 credential shapes, pruned to **1,344 executed cases**
(auth variants only on real ids). Ids included non-UUIDs, the nil UUID, empty,
`..`, `%2e%2e`, `%00`, a 300-character id, SQL-injection strings and
`../../../etc/passwd`.

```
1344 ad-hoc cases; status distribution: -1:168  200:1  401:12  404:610  405:552  409:1
```

- **0 responses ≥ 500.**
- The live `ready` cover was **never** removed by any shape.
- No unauthenticated or bad-credential shape ever deleted anything (all `401`,
  refused in `route()` before `dispatch()`).
- The one `200` is the legitimate discard of the one genuinely-discardable row;
  the one `409` is the correct refusal of the live cover.
- The 168 `-1`s are `TRACE`/`CONNECT` which `fetch()` refuses to send. Retested
  over a raw socket (§3.4) — `405`, no credential reflection.

---

## 3. Fix area 1 — the recovery route (§4 family): **PASS**

All scenarios run over real HTTP against the real spawned server, real
Testcontainers Postgres with the production migrations, real `sharp` conversion
off the request path. Nothing is seeded into the state under test except the
pre-existing good cover.

### 3.1 Both original routes reconstructed (battery `s1`, 17/17)

**Route A — an ordinary conversion failure** (v7 §4.1). A complete-container,
undecodable JPEG uploaded as a body image through the real route: adopted
(`original_url` set), then permanently `failed` by the real conversion.

```
A1.1 broken body image is adopted then permanently failed        :: status=failed
A1.2 publish blocked before discard                              :: 409 IMAGE_NOT_READY
A1.3 discard succeeds                                            :: 200 {"discarded":true}
A1.4 publish now 200 with the REAL cover                         :: 200 cover=https://cdn.example/a1/cover.webp
A1.5 the discarded row is really gone
```

**Route B — the concurrent-upload race** (v7 §4.2). Four genuinely concurrent
cover uploads:

```
A2.1 every concurrent upload answered 201 (no 500)               :: 201,201,201,201
     rows: cover/failed | cover/failed | cover/failed | cover/failed
A2.2 concurrent uploads DID leave several cover-shaped rows      :: 4 cover rows
A2.3 article is stuck before discard                             :: 409 IMAGE_NOT_READY
A2.4 all not-ready rows discardable
A2.5 after discard, a clean actionable answer                    :: 400 COVER_IMAGE_REQUIRED
A2.6 upload a good cover -> publish 200 with a real CDN cover     :: ready 200
```

A2.2 confirms green v8 §8.3's honest disclosure: **the demote-then-insert race
is still present.** It is no longer terminal, which is what this pass claimed.

### 3.2 Further than the committed tests

**Chained recovery — stuck, discard, stuck a *different* way, discard again:**

```
A3.1 stuck#1 (failed body)                 -> discard -> publishable    :: IMAGE_NOT_READY/200/200
A3.2 stuck#2 (failed replacement cover) blocks publish                  :: 409 IMAGE_NOT_READY
A3.3 discard#2 succeeds, clean actionable state                         :: 200 -> 400 COVER_IMAGE_REQUIRED
A3.4 stuck#3 (sync-refused corrupt cover) also discardable, publishes    :: discard=200 final=200
```

**A body image AND a cover stuck simultaneously:**

```
rows: body/ready | body/failed/adopted | cover/failed/adopted/superseded
A4.1 both stuck -> publish refused                              :: 409 IMAGE_NOT_READY
     discard body/failed -> 200 ; discard cover/failed -> 200
A4.2 recovery terminates (both discarded, one upload restores)  :: 200
```

**Discarding right as the ADR-0004 callback lands for that same row** — green
v8 §2.4 claims the SQL-level CAS handles this. Tested twice: once with a fast
conversion (row already `ready`, 6 trials × 25 concurrent discards) and once
with a genuinely-wide window using a real ~6 MP photo, where the row was
verifiably still `processing` when the discard storm landed in **5/5 trials**:

```
trial 0: processing-at-discard=true settled=gone row=GONE 200s=1 409s=7  404s=12 publish=400/COVER_IMAGE_REQUIRED
trial 1: processing-at-discard=true settled=gone row=GONE 200s=1 409s=19 404s=0  publish=400/COVER_IMAGE_REQUIRED
trial 2: processing-at-discard=true settled=gone row=GONE 200s=1 409s=14 404s=5  publish=400/COVER_IMAGE_REQUIRED
trial 3: processing-at-discard=true settled=gone row=GONE 200s=1 409s=15 404s=4  publish=400/COVER_IMAGE_REQUIRED
trial 4: processing-at-discard=true settled=gone row=GONE 200s=1 404s=19         publish=400/COVER_IMAGE_REQUIRED
```

Across 11 race trials: **no 5xx, never two concurrent `200`s for one row, and
no row that settled `ready` was ever deleted.** The invariant the CAS exists to
protect holds. (Honest note: I never *observed* the CAS-returned-false `409`
branch specifically — it needs an interleaving inside a few hundred
microseconds. What I verified is the outcome it guarantees.)

**Discard racing an in-flight publish** — 4 trials, both interleavings
observed:

```
trial 0: publish 200                  discard 200 -> re-publish 200 cover=…/b4/0.webp
trial 1: publish 409/IMAGE_NOT_READY  discard 200 -> re-publish 200 cover=…/b4/1.webp
trial 2: publish 200                  discard 200 -> re-publish 200 cover=…/b4/2.webp
trial 3: publish 409/IMAGE_NOT_READY  discard 200 -> re-publish 200 cover=…/b4/3.webp
```

No 5xx, and no `200` publish ever carried an empty cover.

### 3.3 Attacking the control much harder than `AC-08-recovery-11` does

The committed control tries one shape. I tried twenty against an article whose
live `ready` cover *and* whose `ready` body image is genuinely embedded in its
own `body_html`:

```
plain DELETE (the committed shape)          -> 409     DELETE dot-segment path              -> 409
DELETE with a JSON body                     -> 409     DELETE encoded dot-segment (%2e%2e)  -> 409
DELETE with ?force=true&status=failed       -> 409     POST + X-HTTP-Method-Override        -> 405
DELETE trailing slash                       -> 404     POST .../discard                     -> 404
DELETE uppercased uuid                      -> 404     DELETE /images?image_id=             -> 405
DELETE url-encoded uuid                     -> 409     PATCH / PUT                          -> 405
DELETE double-slash prefix                  -> 404     lowercase verb "delete"              -> 409
no auth / wrong bearer / empty bearer / callback-secret-instead-of-bearer -> 401 (×4)
discard the NEEDED body image                                            -> 409
```

**Every one of the twenty left both needed rows intact**, and afterwards:

```
B1.final article still publishes 200 with its real cover :: 200 cover=https://cdn.example/ctrl/couverture.webp
```

Cross-article attempts (`image X of article Y`, both directions) → `404`, row
untouched. Junk and injection ids (`' or 1=1 --`, `%00`, `-1`, `null`) → never
a 5xx.

The `status <> 'ready'` restriction really is the whole safety property, and
green v8 §2.2's argument that it is *strictly stronger* than a `body_html` scan
holds: the embedded body image is `ready`, so it is refused without anyone
needing a third definition of "still needed".

### 3.4 The branches green v8 §6.2 names as untested — now exercised

Green v8 is candid that four exit paths have no test. Three of the four are
verified working here:

```
G1.1 a colleague's in-flight draft refuses the discard 409 DRAFT_LOCKED   :: 409 DRAFT_LOCKED
G1.3 the refusal names who holds the lock (same envelope as publish)      :: {"locked_by_display_name":"Une Collegue"}
G1.4 once unlocked the same discard succeeds                              :: 200
G2.1 unknown article -> 404 NOT_FOUND, never a 500                        :: 404
G2.2 unknown image on a real article -> 404 NOT_FOUND                     :: 404
G2.3 non-UUID article id -> 404, not a Postgres error                     :: 404
```

The `409 DRAFT_LOCKED` check green v8 calls "my most exposed choice" is
correct, complete, and carries the same envelope as `publish` and `upload`.
Keeping it was the right call. A future red gate should still pin it
(`NFR-DISCARD-LOCK-01`), but it is not currently broken.

Raw-socket verbs `fetch()` refuses to send:

```
TRACE     -> HTTP/1.1 405 Method Not Allowed      (no credential reflection)
CONNECT   -> (connection closed, no response)
HEAD      -> HTTP/1.1 405 Method Not Allowed
OPTIONS   -> HTTP/1.1 405 Method Not Allowed
```

### 3.5 Independent randomised re-derivation of the recovery invariant

Rather than replay the committed test's four scenarios, I swept the property
itself. 40 trials; each starts as a draft or as an already-live article, then
applies 2-5 randomised product-route actions (cover/body uploads of
valid/undecodable/truncated bytes, 30% of them fired as concurrent pairs,
interleaved publishes, and discards of randomly-chosen rows). Then a **fixed**
recovery procedure — publish; if refused, discard every not-ready row; if
nothing is left to discard, upload one good cover; repeat — must return the
article to a `200` publish.

```
distinct settled image-state shapes reached: 33

INV.1 every one of 40 randomised reachable states recovers to a 200 publish
      via product routes alone                                  :: 0 unrecoverable
INV.2 the recovery procedure always terminated (<=12 rounds)    :: 0 non-terminating
INV.3 no 5xx anywhere in the sweep                              :: 0 5xx
INV.4 no 200 publish ever carried an empty cover                :: 0 violations
```

INV.4 also independently re-confirms H-V6-01's invariant survives the
introduction of a delete route — the concern that a discard capability could
reopen AC-08 in a new shape.

**Verdict: the recovery-path fix is real.** Both original routes are closed,
elaborate and chained stuck states recover, the races behave, and the control
holds against everything I could throw at it.

---

## 4. Fix area 2 — the render fallback (M-V7-02): **PASS**

### 4.1 The conversion window, sampled 300 times

My first attempt to catch the window failed for a harness reason worth
recording: a small JPEG converts in a few milliseconds, so the replacement was
already `ready` before I could render. Re-run with a real ~6 MP photo
(conversion ≈ 0.5-1 s), sampling the public page continuously:

```
301 samples, 300 taken while the replacement was still 'processing'

E1 the processing window was genuinely sampled                          :: 300 samples
E2 EVERY sample during the conversion window served cover A —
   never blank, never empty og:image
   distinct og values during window: https://cdn.example/render/couverture-A.webp
E3 once ready, the live row takes over (no stale A left behind)          :: settled=ready og=<B>
E4 page and JSON-LD read the same value (both B) while the persisted
   structured_data still says A until a republish
```

One distinct `og:image` value across 300 samples of the open window. v7 §5's T1
symptom (`og:image content=""`, `image: [""]`, no `<img>` on the card) is gone.

### 4.2 Permanent failure, and the discard interaction

```
D3.1 after the replacement fails PERMANENTLY the page still serves cover A  :: settled=failed og=A
D3.2 publish still fails CLOSED while the failed replacement sits there     :: 409 IMAGE_NOT_READY
D3.3 after DISCARDING the failed replacement the page still serves cover A  :: discard=200 og=A
     rows after discard: body/ready
D3.4 …and republish is refused COVER_IMAGE_REQUIRED                         :: 400 COVER_IMAGE_REQUIRED
```

v7 §5's T2 (permanently blank) is closed, and green v8 §8.2's claim that the
public page keeps serving the old cover after the discard is **confirmed**, as
is the awkward-but-terminating consequence it discloses.

### 4.3 The "first-ever cover" edge case, and other ways the fallback could render garbage

This is the case the brief specifically asked about, plus everything adjacent:

```
D4.1 a never-published draft with a cover in progress renders nowhere        :: absent from homepage
D4.2 published article, structured_data NULL, no ready cover -> NO cover      :: og="" jsonLd="" no <img>
D4.3 legacy structured_data.image=[""] -> NO <img> at all (nullif works)      :: <li>…<a>…</a></li>, no <img>
D4.4 a first-ever cover that FAILS, on an article with no prior published
     cover, still renders nothing                                            :: og="" jsonLd=""
```

The `nullif(…, '')` is load-bearing and correct: without it D4.3 would emit
`<img src="">`. No case renders a garbage or fabricated fallback value.

### 4.4 Can the fallback resurrect something stale? — one observation

```
D5.1 live ready cover B wins over the persisted A even though the article
     was never republished                                        :: og=B
D5.2 with no live ready cover the page reverts to the last PUBLISHED
     cover A, not to the never-published B                        :: og=A
```

Sequence: publish with cover A → upload B, which converts to `ready` (page
correctly shows B, no republish needed) → upload C, which fails (C demotes B).
The page now **rewinds from B back to A**.

A is genuinely the last cover the article was *published* with, so this is
correct by the letter of the fix — the fallback's source is
`structured_data.image`, which is written at publish. But the visitor-visible
image changes backwards with no writer action, while B is still sitting on the
article as a perfectly good `ready` body image. Recorded as **I-V8-02**, not a
defect: the persisted-`cover_image_id` work (L-V6-02) is what would make
"last known good" and "last published" the same thing.

### 4.5 The fix's new trust dependency — checked, and clean

`render.ts` previously read only `article_images.optimized_url`, which is
server-written. The fallback makes the public page depend on
`articles.structured_data` as well. If a writer could forge that column, the
fix would be an og:image/`<img src>` injection vector. Checked live, executing
as the `authenticated` role against real RLS:

```
D6.1 `authenticated` cannot write articles.structured_data          :: 42501
D6.2 `authenticated` cannot flip articles.status                     :: 42501
D6.3 `authenticated` cannot write article_images.optimized_url       :: 42501
D6.4 `authenticated` still cannot write article_images.role (0004)   :: 42501
D6.5 `authenticated` still has no DELETE on article_images           :: 42501
```

`structured_data` was deliberately withheld from `authenticated`'s column grant
in `0001` and still is. **The fallback introduces no new writer-forgeable trust
dependency**, and D6.4/D6.5 independently re-confirm that green v8 added no new
grant, so `0004`'s closure of M-V6-02 holds.

**Verdict: the render fallback is real, correct at the edges, and safe.**

---

## 5. Fix area 3 — the uniqueness constraint (L-V7-01) and its interaction with discard: **PASS**

### 5.1 The index

```
C0.1 CREATE UNIQUE INDEX article_images_one_ready_cover_per_article
       ON public.article_images USING btree (article_id)
       WHERE ((role = 'cover'::text) AND (status = 'ready'::text))
C0.2 a second ready cover is refused 23505 at the database          :: 23505
C0.3 a second FAILED cover is still permitted (narrow by design)    :: no error
```

C0.3 confirms green v8 §4's reasoning for the narrow predicate: a bare
`role = 'cover'` index would have turned M-V4-01's own already-tested case into
a `500`.

### 5.2 What a writer actually experiences in the scenario `0005` was engineered for

The failure mode green v8 engineered around is a raw `500` from concurrent
cover uploads. Tested end to end with genuinely *convertible* ~6 MP photos, so
the `23505` path is really reached:

```
2 concurrent cover uploads:
  C1.2a every upload answered 201 — no raw 500                     :: 201,201
        rows: cover/ready | body/ready
  C1.2b exactly ONE ready cover survives (0005 holds)              :: 1
  C1.2c the 23505 fallback settled the losers — nothing 'processing':: 0 stuck
  C1.2d publish 200 with a real cover, no manual cleanup            :: 200

4 concurrent cover uploads:
  C1.4a every upload answered 201 — no raw 500                     :: 201,201,201,201
        rows: body/ready | body/ready | cover/ready | body/ready
  C1.4b exactly ONE ready cover survives                            :: 1
  C1.4c nothing stuck in 'processing'                               :: 0 stuck
  C1.4d publish 200 with a real cover, no manual cleanup            :: 200
```

**No raw 500 in any trial, and the writer's end-to-end experience is that the
article simply publishes** — no discard needed, no manual cleanup, one cover
wins and the losers settle as ordinary body images.

This is worth calling out: `repo.setImageStatus`'s `23505 → role='body'`
fallback is the code green v8 §6.2 records as *"No test reaches it"* and offers
to have removed. **It is reached here, repeatedly, and it is exactly what makes
C1 come out clean.** Removing it would leave 1-3 rows stuck `processing` per
concurrent burst. It should stay.

### 5.3 Discard combined with concurrent uploads — can they produce a new bad state?

The specific question the brief raises: discard racing `repo.setImageStatus`'s
retry logic. Three trials of three concurrent good-cover uploads with a
six-request discard storm fired while all three conversions were in flight:

```
trial 0: rows=[] discard200s=3 publish=400/COVER_IMAGE_REQUIRED -> recovered to 200 after cleanup
trial 1: rows=[] discard200s=3 publish=400/COVER_IMAGE_REQUIRED -> recovered to 200 after cleanup
trial 2: rows=[] discard200s=3 publish=400/COVER_IMAGE_REQUIRED -> recovered to 200 after cleanup

C3.1 no 5xx, <=1 ready cover, nothing stuck, always recoverable :: 0 violations
```

The discard storm won every race and removed all three `processing` rows; the
three conversions then completed against rows that no longer existed
(`setImageStatus` matches nothing, returns `false`, no throw). The article lands
on `400 COVER_IMAGE_REQUIRED` — a clean, actionable state — and recovers.
**No new bad state emerges from combining the two fixes.**

One production-only side effect this exposes, which the in-memory object store
hides: `convert()` calls `storage.put()` for the optimized asset *before*
`setImageStatus`. When the discard wins, the optimized object is written to
storage and then orphaned, with no row referencing it. Folded into **L-V8-02**.

**Verdict: the uniqueness constraint is real, its residual is genuinely
absorbed, and it composes safely with the discard route.**

---

## 6. Findings

Nothing High. Nothing that blocks on correctness grounds.

### M-V8-01 (Medium) — the recovery capability has no client method, so the editor SPA cannot call it

`src/api/client.ts` is described in `tests/support/seams.ts` as "typed editor-SPA
client (contract consumer side)". It exposes `createDraft`, `openDraft`,
`publishArticle` and `uploadArticleImage`. It does **not** expose the discard
route, and the route is not a declared operation, so nothing generates it either.

Green v8 §7 mentions the missing client method, but only as one of the three
things that *declaring the path item* would require. Stated on its own it is
sharper: **the fix for v7 §4 — a blocking finding whose whole premise was "a
writer has no way out" — currently ships with no way for the product's own
client to invoke it.** A writer still cannot recover from a stuck article
through the editor; only a hand-rolled `fetch` or `curl` reaches it.

Not High: the server side is complete and verified working end to end (§3), the
route is correct and safe, and adding a client method plus a path item is small
and well understood. But "the writer can now recover" is not yet true from where
the writer sits.

**Fix**: exactly what green v8 §7 recommends, and it should be scheduled rather
than noted — a red gate authoring `CONTRACT-CONSUMER-discardArticleImage`, then
a green pass declaring
`paths./v1/articles/{articleId}/images/{imageId}.delete` and adding
`client.discardArticleImage()`. That also closes §2.2's contract-coverage gap on
both sides in the same change.

### L-V8-01 (Low) — no rate-limit budget on the discard route, confirmed quantitatively

Green v8 §8.1 declares this. Measured:

```
40 discards in 50ms: 40 accepted, 0 rate-limited
…while publish on the same IP is still capped at 10/min: 4/14 rate-limited
```

It is the only mutating route in the product with no budget, and it is the only
one that performs a **hard delete**. A stolen token or a runaway client can
remove every not-ready image row on every article at line rate, with nothing to
slow it down and no record afterwards (see L-V8-02). Green v8's "no
amplification" argument is fair as far as it goes; the counter-argument is that
the other two mutating routes have budgets for the same reason and this one is
more destructive than either.

Low because it needs valid credentials, it can only remove rows the article
cannot be published with anyway, and it fails closed. **Fix**: the shape green
v8 already gives — its own key namespace and a limit above 10, so
`NFR-RECOVERY-INVARIANT-01`'s sweep is unaffected.

### L-V8-02 (Low) — the discard is a hard delete with no audit trail and orphaned storage

Three consequences, none individually serious:

1. **No telemetry, no audit row.** Discard writes nothing to `telemetry_events`.
   `article_images` rows vanish with no tombstone. Combined with L-V7-02
   (`articles.updated_at` is writer-forgeable), there is no server-side record
   that a discarded image ever existed. For the one route whose justification is
   "the writer needs a way out", not recording the way out is a gap — and
   `telemetry_events` is the trail v7 §6 called "the trustworthy independent
   one".
2. **Orphaned storage objects.** `deleteImage` removes the row only. Both the
   stored original and (when the discard wins a race against a completing
   conversion, §5.3) the optimized asset stay in Supabase Storage forever, with
   nothing referencing them. Relevant to the 5 GB free-tier concern
   `02-architecture.v1.md` §4 raises.
3. **Dangling `replaced_cover_image_id`.** Confirmed harmless in behaviour, as
   green v8 §8.2 argues — verified in A3/D3, where deleting the pointing row
   correctly un-superseded its target and deleting the pointed-at row changed
   nothing.

**Fix**: a `discard` telemetry event is a few lines and closes (1); (2) wants a
storage cleanup path, which is deploy-side work; (3) needs nothing.

### I-V8-01 (Info, sixth mention) — workspace hygiene has now corrupted gate evidence

See §1.1. Five prior documents recorded this as a risk. This pass is the one
where an untracked `tests/perf/` from a concurrent agent silently changed a full
suite run from 227 to 228 tests. A sixth note will not fix it; a `.gitignore`
entry for scratch paths, or an enforced out-of-repo scratch convention, will.
Every scratch artefact from this pass lives in `/tmp/arsene-v8` and
`/tmp/arsene-pristine`, and nothing was written into the repo except this
document.

### I-V8-02 (Info) — the render fallback's source is "last published", not "last known good"

See §4.4. The page can visibly rewind to an older cover without a writer action,
because `structured_data.image` is written at publish and a newer, perfectly
good cover may never have been published. Correct by the letter of M-V7-02's
fix; subsumed by L-V6-02's persisted `cover_image_id`.

### I-V8-03 (Info) — no per-writer ownership check on discard

```
G5.1 writer A discarding a row on writer B's article -> 200
```

Consistent with every other route (equal rights by design; v7 §6 makes the same
observation about `updated_at`), so **not a regression**. Named only because the
discard route is the product's first destructive one, so the equal-rights
assumption now has a delete attached to it. The draft lock is the only
mitigation and it only applies while someone holds the lock.

### Confirmations of green v8's own open items

| Green v8 says | Verified |
|---|---|
| §5 — the demote-then-insert race is still present, but no longer terminal | **Confirmed** (A2.2: 4 cover rows; all recoverable) |
| §6.2 — `409 DRAFT_LOCKED` is code without a test | **Confirmed present and correct** (G1) |
| §6.2 — the `23505 → body` fallback is reached by no test | **Confirmed, and reached here — it works and should stay** (C1) |
| §7 — contract is prose-only, suite skips the route entirely | **Confirmed exactly as described** (§2.2) |
| §8.1 — no rate limit | **Confirmed quantitatively** (G3, L-V8-01) |
| §8.2 — discard un-supersedes, page keeps serving the old cover, loop terminates | **Confirmed** (D3.3, D3.4, A3.3, A4) |
| §8.4 — L-V6-02 narrowed not closed | **Confirmed**; `render.ts`'s pick is now provably single-row (C0.2), `usableCover()`'s is not |

---

## 7. Check tally

| Battery | Subject | Checks | Failed |
|---|---|---|---|
| `s1-recovery` | Routes A and B, chained and simultaneous stuck states | 17 | 0 |
| `s2-control` | 20 attack shapes on needed rows, cross-article, discard/callback and discard/publish races | 27 | 0 |
| `s3-unique` | `0005`, concurrent convertible covers, `23505` fallback, discard storm | 14 | 0 |
| `s4-render` | Fallback, first-ever-cover edge cases, stale check, grant checks | 19 | 1\* |
| `s5-window` | 300-sample sweep of the real conversion window | 4 | 0 |
| `s6-contract` | Contract enumeration, 886 Schemathesis cases, 1,344 ad-hoc fuzz cases | 10 | 0 |
| `s7-gaps` | Untested branches, rate limit, raw-socket verbs, ownership | 17 | 0 |
| `s8-invariant` | 40 randomised recovery-invariant trials, 33 state shapes | 4 | 0 |
| **Total** | | **112** | **1\*** |

\* `s4`'s D2.1 was a harness timing artefact, not a product failure: a small
JPEG converted before the page could be sampled. Re-run properly as `s5`, where
the window was held open for 300 consecutive samples and every one was correct.
Net: **111 checks executed to a valid conclusion, 0 product failures**, plus one
retired harness check.

---

## 8. Integration/e2e verdict

**PASS**, for this portion of the gate.

All three fixes green v8 delivered are real, and they hold up well beyond what
the committed suite asks of them. The recovery route closes both of v7 §4's
routes and every elaborate variant I could construct, and it cannot be turned
against an article that needs its images — twenty request shapes and 1,344
ad-hoc fuzz cases all refused. The render fallback keeps the last-known-good
cover through 300 samples of a real conversion window and after a permanent
failure, renders nothing rather than garbage in every never-published and legacy
case, and introduces no writer-forgeable trust dependency. The uniqueness index
holds, and the `23505 → body` fallback the green document offered to delete is
precisely what makes concurrent cover uploads a non-event for the writer.

The one finding worth a scheduling decision is **M-V8-01**: the capability that
closes v7 §4 has no client method and no declared operation, so a writer cannot
yet reach it from the editor. That is a completeness gap on an otherwise
correct fix, and the same small change closes the contract-coverage gap on both
sides.

And **I-V8-01** should stop being a note. It corrupted a measurement in this
pass; the next pass should not have to check whether its own headline number is
real.

`state.json` untouched, per the established pattern. Nothing committed.
