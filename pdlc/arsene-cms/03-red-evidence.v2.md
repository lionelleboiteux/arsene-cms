# arsene-cms — Red gate, remediation pass (v2)

> Gate 3 (red), run a second time. `03-red-evidence.v1.md` documented the
> original red gate for the whole build; this document covers **only** the
> remediation pass for `05-verification.v1.md`'s findings. Tests only — no
> production code was written, changed or deleted by this pass.

**Status:** red | **Author:** Claude (Opus 5) | **Date:** 2026-08-12
**Branch:** `feat/arsene-cms` | **Baseline:** commit `21d85df` (green: 127/127)

---

## 0. What this pass had to cover, and what it produced

`05-verification.v1.md` came back **NOT PASSED** on findings #1-#4 (blocking)
and #5-#9 (fix or explicitly defer). `02-architecture.v1.md` §10 and
`adr/0004-s3-lambda-image-pipeline.md` recorded the dispositions. This pass
turned each of them into failing tests.

| Verify finding | Severity | Tests added | New ids |
|---|---|---|---|
| #1 stored XSS — `sanitizePastedHtml` never called from production code | High | 2 | `VERIFY-01a`, `VERIFY-01b` / `NFR-XSS-01` |
| #2 unauthenticated DoS — whole body buffered before auth and before the 20 MB check | High | 2 | `NFR-DOS-01`, `NFR-DOS-02` |
| #3 auth is one static shared secret, not per-writer Supabase JWT | High | 8 | `NFR-JWT-01`…`NFR-JWT-06`, `NFR-AUDIT-01` (extended), `NFR-TIMING-01` |
| #4 no reachable path to create a draft at all | High (functional) | 7 | `VERIFY-04a`, `VERIFY-04b` / `NFR-GRANT-01`, `AC-01`, `AC-05` ×4 |
| #5 image codec at/over Supabase's 2 s CPU budget → S3 + Lambda | Medium | 17 | `VERIFY-05a`, `AC-07/D7-*` ×5, `AC-08-*` ×2, `AC-08`, `NFR-IMGCPU-01`, `NFR-CALLBACK-01/02/03` |
| #6.4 fabricated `cover_image_url` / `structured_data.image` | Medium | 1 | `VERIFY-06` |
| #7 double-JSON-encoded `draft_started.payload.started_at` | Low | 1 | `VERIFY-07` |
| #8 upload endpoint has no rate limiter | Low | 3 | `NFR-RATE-02a/b/c` |
| #9 non-constant-time bearer-token comparison | Low | (counted under #3) | `NFR-TIMING-01` |

2 + 2 + 8 + 7 + 17 + 1 + 1 + 3 = **41**.

**41 new tests. 39 fail. 2 pass** (both explained in §4 — they are the two
halves of the upload rate-limit family that cannot fail while no limiter
exists at all). **All 127 tests the green gate certified still pass**, and no
existing test's assertions were edited.

---

## 1. The command, and its output

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

Tail of the run, verbatim:

```
 Test Files  8 failed | 18 passed (26)
      Tests  39 failed | 129 passed (168)
   Start at  11:52:35
   Duration  13.98s (transform 639ms, setup 0ms, collect 5.39s, tests 54.99s, environment 3ms, prepare 1.47s)
```

168 = the 127 green-gate tests + 41 new. 129 passing = 127 + the 2 explained in
§4. 26 test files = 18 + 8 new; the 8 that fail are exactly the 8 new ones.

---

## 2. Every new test, with its result

Verbatim from the verbose reporter, filtered to the eight new files (the other
18 files' 127 lines are all `✓` and are not repeated here — the counts in §1
account for them):

```
 × tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-01: an unauthenticated chunked request is refused 401 on its headers, with only a fraction of its body ever pushed — an anonymous caller cannot make the server buffer megabytes
   → expected { status: 400, …(2) } to deeply equal { status: 401, …(2) }
 × tests/unit/uploadImageAsync.test.ts > asynchronous image pipeline (ADR-0004) > VERIFY-05a / AC-07: an upload stores the original and returns 201 processing without ever handing the bytes to a codec, so the request cannot exceed the runtime’s CPU budget
   → expected { status: 201, …(6) } to deeply equal { status: 201, …(6) }
 × tests/unit/uploadImageAsync.test.ts > asynchronous image pipeline (ADR-0004) > AC-08: an article whose cover is still processing after the asynchronous upload is refused at publish with IMAGE_NOT_READY, exactly as it was under the synchronous pipeline
   → expected { status: 200, code: undefined } to deeply equal { Object (status, code) }
 ✓ tests/unit/uploadImageAsync.test.ts > upload rate limiting > NFR-RATE-02a: the 10th upload in a minute from one IP is still served
 × tests/unit/uploadImageAsync.test.ts > upload rate limiting > NFR-RATE-02b: the 11th upload in a minute from the same IP is rejected with 429
   → expected 201 to be 429 // Object.is equality
 ✓ tests/unit/uploadImageAsync.test.ts > upload rate limiting > NFR-RATE-02c: a second writer on a different IP is unaffected by the first IP exhausting its budget
 × tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-02: an upload declaring more than 20 MB is refused 413 from its Content-Length alone, before the body is buffered and before any codec could run 541ms
   → expected { status: 400, code: undefined, …(1) } to deeply equal { status: 413, …(2) }
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-jpeg: a real photographic JPEG is converted to a modern format, smaller than the source
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-png: a real photographic PNG is converted to a modern format, smaller than the source
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-webp: a real WebP, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-avif: a real AVIF, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-heic: a real HEVC-compressed HEIC straight off an iPhone, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-08-corrupt: a file with valid JPEG magic bytes and an undecodable body is refused cleanly as CORRUPTED_FILE, never a thrown exception
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-08-unsupported: a container this pipeline does not support at all (a real PDF) is refused cleanly as UNSUPPORTED_FORMAT, never a thrown exception
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought
   → Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageStatusCallback.test.ts > image status callback authentication > NFR-CALLBACK-01a: a status callback carrying no callback secret at all is refused 401 and flips nothing
   → Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageStatusCallback.test.ts > image status callback authentication > NFR-CALLBACK-01b: a status callback carrying a writer’s bearer token instead of the callback secret is refused 401 and flips nothing
   → Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02a: a processing row told the conversion succeeded becomes ready
   → Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02b: a processing row told the conversion failed becomes failed, carrying the reason
   → Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02c: a row that already left processing is not flipped a second time, so a replayed or forged callback cannot overwrite a settled image
   → Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02d: a callback naming an image id that does not exist is a 404 rather than a crash or a silent success
   → Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-01: a token Supabase signed with this project’s JWT secret, still within its expiry is accepted, with writer_id taken from its sub claim
   → Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-02: a well-formed token signed with somebody else’s secret is refused, with no writer attributed
   → Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-03: a correctly signed token whose exp has already passed is refused, with no writer attributed
   → Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-04: a string that is not a JWT at all (the old static shared secret, in fact) is refused, with no writer attributed
   → Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-05: no Authorization header at all is refused, with no writer attributed
   → Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-06: a correctly signed, unexpired token carrying no sub claim, so no writer can be attributed is refused, with no writer attributed
   → Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/auth.test.ts > shared-secret comparison > NFR-TIMING-01: the auth module compares secrets with a constant-time comparator, not ===, so a byte-by-byte guessing oracle never exists
   → ENOENT: no such file or directory, open '/Users/lionelleboiteux/work/arsene-cms/src/api/auth.ts'
 × tests/unit/publishRemediation.test.ts > publish-time sanitisation (verify finding #1) > VERIFY-01a / AC-03: publishing an article whose stored body_html contains a script tag, an inline event handler and a javascript: href persists sanitised HTML, keeping the writer’s real content
   → expected { …(5) } to deeply equal { …(5) }
 × tests/unit/publishRemediation.test.ts > published JSON-LD image (verify finding #6.4) > VERIFY-06 / AC-14: the publish response’s structured_data.image is the cover image’s real stored URL, not a path built from the article id
   → expected { …(2) } to deeply equal { …(2) }
 × tests/db/remediation.test.ts > public site XSS defence in depth (verify finding #1) > VERIFY-01b / NFR-XSS-01: an article row whose body_html was poisoned directly in the database still renders with no script tag, no inline event handler and no javascript: href
   → expected { executable_script_tags: 1, …(3) } to deeply equal { executable_script_tags: +0, …(3) }
 × tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-01 / VERIFY-04a: createRepo().insertDraft writes a real draft row attributed to the calling writer
   → repo.insertDraft is not a function
 × tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-free: createRepo().takeLock — a draft nobody holds is locked by the writer opening it
   → repo.takeLock is not a function
 × tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-held: createRepo().takeLock — a draft another writer’s heartbeat is keeping current is not stolen
   → repo.takeLock is not a function
 × tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-stale: createRepo().takeLock — a draft another writer left locked 91 seconds ago is taken over with no admin unlock
   → repo.takeLock is not a function
 × tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > VERIFY-04b / NFR-GRANT-01: the elevated role the draft-creation seam runs as can insert an article, while `authenticated` still cannot — the privilege split the seam exists to enforce
   → expected { service_role: '22023', …(1) } to deeply equal { service_role: null, …(1) }
 × tests/db/remediation.test.ts > telemetry payload encoding (verify finding #7) > VERIFY-07 / TELEMETRY-draft_started: the publish-time backfill writes payload.started_at as a plain ISO timestamp, not a JSON string wrapped in a second set of quotes
   → expected { rows: 1, …(2) } to deeply equal { rows: 1, …(2) }
 × tests/db/remediation.test.ts > image status callback persistence (ADR-0004) > NFR-CALLBACK-03: flipping a processing image to ready stores the optimized URL, and a second flip of the same row changes nothing — the compare-and-swap is in the database, not only in the handler
   → repo.setImageStatus is not a function
 × tests/e2e/draftJourney.test.ts > draft creation over its real route (verify finding #4) > AC-01 / TELEMETRY-draft_started: POST /v1/articles creates the draft and emits draft_started from the same server call, so the metric’s numerator no longer depends on the publish-time backfill
   → expected { status: 404, …(4) } to deeply equal { status: 201, …(4) }
 × tests/e2e/draftJourney.test.ts > draft creation over its real route (verify finding #4) > AC-05: a second writer opening a draft whose lock is still current is refused 409 DRAFT_LOCKED and told who is holding it — over HTTP, not only in SQL
   → expected { Object (status, code, ...) } to deeply equal { status: 409, …(2) }
 × tests/e2e/draftJourney.test.ts > draft creation over its real route (verify finding #4) > NFR-AUDIT-01: two drafts created with two differently signed tokens are attributed to two different writers, because writer_id comes from each token’s sub claim and not from one process-wide constant
   → expected [] to deeply equal [ { …(3) }, { …(3) } ]
```

---

## 3. Full failure output, pasted

Verbatim, the whole `Failed Tests` section of the run above — 39 failures, in
the runner's own order and wording:

```
⎯⎯⎯⎯⎯⎯ Failed Tests 39 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/db/remediation.test.ts > public site XSS defence in depth (verify finding #1) > VERIFY-01b / NFR-XSS-01: an article row whose body_html was poisoned directly in the database still renders with no script tag, no inline event handler and no javascript: href
AssertionError: expected { executable_script_tags: 1, …(3) } to deeply equal { executable_script_tags: +0, …(3) }

- Expected
+ Received

  Object {
-   "executable_script_tags": 0,
-   "inline_event_handlers": false,
-   "javascript_href": false,
+   "executable_script_tags": 1,
+   "inline_event_handlers": true,
+   "javascript_href": true,
    "still_renders_the_article": true,
  }

 ❯ tests/db/remediation.test.ts:116:8
    114|       javascript_href: /href\s*=\s*["']?\s*javascript:/i.test(html),
    115|       still_renders_the_article: html.includes('PSG reçoit Marseille d…
    116|     }).toEqual({
       |        ^
    117|       executable_script_tags: 0,
    118|       inline_event_handlers: false,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/39]⎯

 FAIL  tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-01 / VERIFY-04a: createRepo().insertDraft writes a real draft row attributed to the calling writer
TypeError: repo.insertDraft is not a function
 ❯ tests/db/remediation.test.ts:134:30
    132|     const repo = (await loadRepo()).createRepo(pool);
    133| 
    134|     const draft = await repo.insertDraft({ writer_id: writerB, title: …
       |                              ^
    135|     const row = await db.client.query(
    136|       `select writer_id, title, status from articles where id = $1`,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/39]⎯

 FAIL  tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-free: createRepo().takeLock — a draft nobody holds is locked by the writer opening it
 FAIL  tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-held: createRepo().takeLock — a draft another writer’s heartbeat is keeping current is not stolen
 FAIL  tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-stale: createRepo().takeLock — a draft another writer left locked 91 seconds ago is taken over with no admin unlock
TypeError: repo.takeLock is not a function
 ❯ tests/db/remediation.test.ts:193:32
    191|       }
    192| 
    193|       const taken = await repo.takeLock({ article_id: article, writer_…
       |                                ^
    194|       const after = await db.client.query(`select locked_by from artic…
    195| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/39]⎯

 FAIL  tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > VERIFY-04b / NFR-GRANT-01: the elevated role the draft-creation seam runs as can insert an article, while `authenticated` still cannot — the privilege split the seam exists to enforce
AssertionError: expected { service_role: '22023', …(1) } to deeply equal { service_role: null, …(1) }

- Expected
+ Received

  Object {
    "authenticated": "42501",
-   "service_role": null,
+   "service_role": "22023",
  }

 ❯ tests/db/remediation.test.ts:223:8
    221|       service_role: await attemptInsertAs('service_role'),
    222|       authenticated: await attemptInsertAs('authenticated'),
    223|     }).toEqual({
       |        ^
    224|       service_role: null, // no error: the new expand-only migration g…
    225|       authenticated: '42501', // insufficient_privilege, unchanged

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/39]⎯

 FAIL  tests/db/remediation.test.ts > telemetry payload encoding (verify finding #7) > VERIFY-07 / TELEMETRY-draft_started: the publish-time backfill writes payload.started_at as a plain ISO timestamp, not a JSON string wrapped in a second set of quotes
AssertionError: expected { rows: 1, …(2) } to deeply equal { rows: 1, …(2) }

- Expected
+ Received

  Object {
-   "parses_as_a_timestamp": true,
+   "parses_as_a_timestamp": false,
    "rows": 1,
-   "wrapped_in_literal_quotes": false,
+   "wrapped_in_literal_quotes": true,
  }

 ❯ tests/db/remediation.test.ts:266:8
    264|       wrapped_in_literal_quotes: started_at.startsWith('"'),
    265|       parses_as_a_timestamp: Number.isFinite(Date.parse(started_at)),
    266|     }).toEqual({ rows: 1, wrapped_in_literal_quotes: false, parses_as_…
       |        ^
    267|   });
    268| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/39]⎯

 FAIL  tests/db/remediation.test.ts > image status callback persistence (ADR-0004) > NFR-CALLBACK-03: flipping a processing image to ready stores the optimized URL, and a second flip of the same row changes nothing — the compare-and-swap is in the database, not only in the handler
TypeError: repo.setImageStatus is not a function
 ❯ tests/db/remediation.test.ts:293:30
    291|     const optimized_url = `https://cdn.fantasycoach.example/articles/$…
    292| 
    293|     const first = await repo.setImageStatus({ image_id, status: 'ready…
       |                              ^
    294|     const second = await repo.setImageStatus({
    295|       image_id,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/39]⎯

 FAIL  tests/e2e/draftJourney.test.ts > draft creation over its real route (verify finding #4) > AC-01 / TELEMETRY-draft_started: POST /v1/articles creates the draft and emits draft_started from the same server call, so the metric’s numerator no longer depends on the publish-time backfill
AssertionError: expected { status: 404, …(4) } to deeply equal { status: 201, …(4) }

- Expected
+ Received

  Object {
-   "article": Object {
-     "status": "draft",
-     "title": "Pronos Ligue 1 - Journée 17",
-     "writer_id": "22ab04f6-5876-4afd-87aa-91cf8648f7f4",
-   },
-   "attributed_to": "22ab04f6-5876-4afd-87aa-91cf8648f7f4",
-   "draft_started_rows": 1,
-   "returned_an_article_id": true,
-   "status": 201,
+   "article": undefined,
+   "attributed_to": undefined,
+   "draft_started_rows": 0,
+   "returned_an_article_id": false,
+   "status": 404,
  }

 ❯ tests/e2e/draftJourney.test.ts:123:8
    121|       draft_started_rows: events.rowCount,
    122|       attributed_to: events.rows[0]?.writer_id,
    123|     }).toEqual({
       |        ^
    124|       status: 201,
    125|       returned_an_article_id: true,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/39]⎯

 FAIL  tests/e2e/draftJourney.test.ts > draft creation over its real route (verify finding #4) > AC-05: a second writer opening a draft whose lock is still current is refused 409 DRAFT_LOCKED and told who is holding it — over HTTP, not only in SQL
AssertionError: expected { Object (status, code, ...) } to deeply equal { status: 409, …(2) }

- Expected
+ Received

  Object {
-   "code": "DRAFT_LOCKED",
-   "names_the_holder": "Marie D.",
-   "status": 409,
+   "code": "NOT_FOUND",
+   "names_the_holder": undefined,
+   "status": 404,
  }

 ❯ tests/e2e/draftJourney.test.ts:147:8
    145|       code: body.error?.code,
    146|       names_the_holder: body.error?.details?.locked_by_display_name,
    147|     }).toEqual({ status: 409, code: 'DRAFT_LOCKED', names_the_holder: …
       |        ^
    148|   });
    149| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/39]⎯

 FAIL  tests/e2e/draftJourney.test.ts > draft creation over its real route (verify finding #4) > NFR-AUDIT-01: two drafts created with two differently signed tokens are attributed to two different writers, because writer_id comes from each token’s sub claim and not from one process-wide constant
AssertionError: expected [] to deeply equal [ { …(3) }, { …(3) } ]

- Expected
+ Received

- Array [
-   Object {
-     "article_writer": "b5ce7493-2f2a-4819-b9a3-9292e34060f3",
-     "event_writer": "b5ce7493-2f2a-4819-b9a3-9292e34060f3",
-     "title": "Brouillon de Lionel",
-   },
-   Object {
-     "article_writer": "22ab04f6-5876-4afd-87aa-91cf8648f7f4",
-     "event_writer": "22ab04f6-5876-4afd-87aa-91cf8648f7f4",
-     "title": "Brouillon de Marie",
-   },
- ]
+ Array []

 ❯ tests/e2e/draftJourney.test.ts:170:23
    168|     );
    169| 
    170|     expect(rows.rows).toEqual([
       |                       ^
    171|       { title: 'Brouillon de Lionel', article_writer: writerB, event_w…
    172|       { title: 'Brouillon de Marie', article_writer: writerA, event_wr…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/39]⎯

 FAIL  tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-01: an unauthenticated chunked request is refused 401 on its headers, with only a fraction of its body ever pushed — an anonymous caller cannot make the server buffer megabytes
AssertionError: expected { status: 400, …(2) } to deeply equal { status: 401, …(2) }

- Expected
+ Received

  Object {
-   "body_bytes_pushed_before_the_answer_stayed_bounded": true,
-   "code": "UNAUTHORIZED",
-   "status": 401,
+   "body_bytes_pushed_before_the_answer_stayed_bounded": false,
+   "code": "VALIDATION_FAILED",
+   "status": 400,
  }

 ❯ tests/e2e/transportGuards.test.ts:185:8
    183|       body_bytes_pushed_before_the_answer_stayed_bounded:
    184|         result.sent_when_answered <= BOUNDED_MEMORY_BYTES,
    185|     }).toEqual({
       |        ^
    186|       status: 401,
    187|       code: 'UNAUTHORIZED',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[10/39]⎯

 FAIL  tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-02: an upload declaring more than 20 MB is refused 413 from its Content-Length alone, before the body is buffered and before any codec could run
AssertionError: expected { status: 400, code: undefined, …(1) } to deeply equal { status: 413, …(2) }

- Expected
+ Received

  Object {
-   "body_bytes_pushed_before_the_answer_stayed_bounded": true,
-   "code": "FILE_TOO_LARGE",
-   "status": 413,
+   "body_bytes_pushed_before_the_answer_stayed_bounded": false,
+   "code": undefined,
+   "status": 400,
  }

 ❯ tests/e2e/transportGuards.test.ts:212:8
    210|       body_bytes_pushed_before_the_answer_stayed_bounded:
    211|         result.sent_when_answered <= BOUNDED_MEMORY_BYTES,
    212|     }).toEqual({
       |        ^
    213|       status: 413,
    214|       code: 'FILE_TOO_LARGE',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[11/39]⎯

 FAIL  tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-01: a token Supabase signed with this project’s JWT secret, still within its expiry is accepted, with writer_id taken from its sub claim
 FAIL  tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-02: a well-formed token signed with somebody else’s secret is refused, with no writer attributed
 FAIL  tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-03: a correctly signed token whose exp has already passed is refused, with no writer attributed
 FAIL  tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-04: a string that is not a JWT at all (the old static shared secret, in fact) is refused, with no writer attributed
 FAIL  tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-05: no Authorization header at all is refused, with no writer attributed
 FAIL  tests/unit/auth.test.ts > Supabase Auth JWT verification > NFR-JWT-06: a correctly signed, unexpired token carrying no sub claim, so no writer can be attributed is refused, with no writer attributed
Error: Failed to load url ../../src/api/auth (resolved id: ../../src/api/auth) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[12/39]⎯

 FAIL  tests/unit/auth.test.ts > shared-secret comparison > NFR-TIMING-01: the auth module compares secrets with a constant-time comparator, not ===, so a byte-by-byte guessing oracle never exists
Error: ENOENT: no such file or directory, open '/Users/lionelleboiteux/work/arsene-cms/src/api/auth.ts'
 ❯ tests/unit/auth.test.ts:118:20
    116|     // would be a flaky test that proves nothing. 05-verification.v1.m…
    117|     // item 9 asks only that the cheap defense be in place.
    118|     const source = readFileSync(path.join(REPO_ROOT, AUTH_MODULE_PATH)…
       |                    ^
    119|     const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/…
    120| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { errno: -2, code: 'ENOENT', syscall: 'open', path: '/Users/lionelleboiteux/work/arsene-cms/src/api/auth.ts' }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/39]⎯

 FAIL  tests/unit/imageStatusCallback.test.ts > image status callback authentication > NFR-CALLBACK-01a: a status callback carrying no callback secret at all is refused 401 and flips nothing
 FAIL  tests/unit/imageStatusCallback.test.ts > image status callback authentication > NFR-CALLBACK-01b: a status callback carrying a writer’s bearer token instead of the callback secret is refused 401 and flips nothing
 FAIL  tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02a: a processing row told the conversion succeeded becomes ready
 FAIL  tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02b: a processing row told the conversion failed becomes failed, carrying the reason
 FAIL  tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02c: a row that already left processing is not flipped a second time, so a replayed or forged callback cannot overwrite a settled image
 FAIL  tests/unit/imageStatusCallback.test.ts > image status callback state machine > NFR-CALLBACK-02d: a callback naming an image id that does not exist is a 404 rather than a crash or a silent success
Error: Failed to load url ../../src/api/imageStatus (resolved id: ../../src/api/imageStatus) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/39]⎯

 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-jpeg: a real photographic JPEG is converted to a modern format, smaller than the source
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-png: a real photographic PNG is converted to a modern format, smaller than the source
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-webp: a real WebP, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-avif: a real AVIF, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-heic: a real HEVC-compressed HEIC straight off an iPhone, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-08-corrupt: a file with valid JPEG magic bytes and an undecodable body is refused cleanly as CORRUPTED_FILE, never a thrown exception
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-08-unsupported: a container this pipeline does not support at all (a real PDF) is refused cleanly as UNSUPPORTED_FORMAT, never a thrown exception
 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought
Error: Failed to load url ../../src/images/lambdaHandler (resolved id: ../../src/images/lambdaHandler) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[15/39]⎯

 FAIL  tests/unit/publishRemediation.test.ts > publish-time sanitisation (verify finding #1) > VERIFY-01a / AC-03: publishing an article whose stored body_html contains a script tag, an inline event handler and a javascript: href persists sanitised HTML, keeping the writer’s real content
AssertionError: expected { …(5) } to deeply equal { …(5) }

- Expected
+ Received

  Object {
    "contains_inline_event_handler": false,
    "contains_javascript_href": false,
    "contains_script_tag": false,
-   "keeps_the_writers_own_words": true,
-   "persisted_body_html_was_written": true,
+   "keeps_the_writers_own_words": false,
+   "persisted_body_html_was_written": false,
  }

 ❯ tests/unit/publishRemediation.test.ts:70:8
     68|       contains_javascript_href: /javascript:/i.test(persisted),
     69|       keeps_the_writers_own_words: persisted.includes('PSG reçoit Mars…
     70|     }).toEqual({
       |        ^
     71|       persisted_body_html_was_written: true,
     72|       contains_script_tag: false,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[16/39]⎯

 FAIL  tests/unit/publishRemediation.test.ts > published JSON-LD image (verify finding #6.4) > VERIFY-06 / AC-14: the publish response’s structured_data.image is the cover image’s real stored URL, not a path built from the article id
AssertionError: expected { …(2) } to deeply equal { …(2) }

- Expected
+ Received

  Object {
    "persisted_image": Array [
-     "https://cdn.fantasycoach.example/articles/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-optimized.webp",
+     "https://cdn.fantasycoach.example/articles/a1a1a1a1-0000-4a2b-9c3d-000000000001/cover-optimized.webp",
    ],
    "returned_image": Array [
-     "https://cdn.fantasycoach.example/articles/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-optimized.webp",
+     "https://cdn.fantasycoach.example/articles/a1a1a1a1-0000-4a2b-9c3d-000000000001/cover-optimized.webp",
    ],
  }

 ❯ tests/unit/publishRemediation.test.ts:98:8
     96|       // stored column has to be checked too, not just the response.
     97|       persisted_image: stored?.image,
     98|     }).toEqual({
       |        ^
     99|       returned_image: [COVER_OPTIMIZED_URL],
    100|       persisted_image: [COVER_OPTIMIZED_URL],

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[17/39]⎯

 FAIL  tests/unit/uploadImageAsync.test.ts > asynchronous image pipeline (ADR-0004) > VERIFY-05a / AC-07: an upload stores the original and returns 201 processing without ever handing the bytes to a codec, so the request cannot exceed the runtime’s CPU budget
AssertionError: expected { status: 201, …(6) } to deeply equal { status: 201, …(6) }

- Expected
+ Received

  Object {
-   "codec_invocations": 0,
+   "codec_invocations": 1,
    "contract_errors": Array [],
-   "image_status": "processing",
-   "objects_stored": 1,
+   "image_status": "ready",
+   "objects_stored": 2,
    "status": 201,
-   "stored_the_original": true,
-   "urls_while_processing": null,
+   "stored_the_original": false,
+   "urls_while_processing": Object {
+     "optimized": "https://cdn.fantasycoach.example/articles/a1a1a1a1-0000-4a2b-9c3d-000000000001/591879a1-a95c-4d9c-af14-77cb522671e8-optimized.webp",
+     "original": "https://cdn.fantasycoach.example/articles/a1a1a1a1-0000-4a2b-9c3d-000000000001/591879a1-a95c-4d9c-af14-77cb522671e8-original-psg-om-cover.jpg",
+   },
  }

 ❯ tests/unit/uploadImageAsync.test.ts:57:8
     55|       objects_stored: built.stored.length,
     56|       stored_the_original: built.stored.every((s) => /original/.test(s…
     57|     }).toEqual({
       |        ^
     58|       status: 201,
     59|       contract_errors: [],

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[18/39]⎯

 FAIL  tests/unit/uploadImageAsync.test.ts > asynchronous image pipeline (ADR-0004) > AC-08: an article whose cover is still processing after the asynchronous upload is refused at publish with IMAGE_NOT_READY, exactly as it was under the synchronous pipeline
AssertionError: expected { status: 200, code: undefined } to deeply equal { Object (status, code) }

- Expected
+ Received

  Object {
-   "code": "IMAGE_NOT_READY",
-   "status": 409,
+   "code": undefined,
+   "status": 200,
  }

 ❯ tests/unit/uploadImageAsync.test.ts:96:74
     94|     );
     95| 
     96|     expect({ status: res.status, code: (res.body as any)?.error?.code …
       |                                                                          ^
     97|       status: 409,
     98|       code: 'IMAGE_NOT_READY',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[19/39]⎯

 FAIL  tests/unit/uploadImageAsync.test.ts > upload rate limiting > NFR-RATE-02b: the 11th upload in a minute from the same IP is rejected with 429
AssertionError: expected 201 to be 429 // Object.is equality

- Expected
+ Received

- 429
+ 201

 ❯ tests/unit/uploadImageAsync.test.ts:161:24
    159|     const res = await spam(c.attempts, c.from);
    160| 
    161|     expect(res.status).toBe(c.status);
       |                        ^
    162|   });
    163| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[20/39]⎯
```

---

## 4. Per-test failure reason, and why each one is honest

A failure is only useful if it has exactly one cause. The 39 fall into three
kinds, none of which is a broken test:

**(a) A production module that genuinely does not exist yet — 20 tests.**
The seam loader names the missing path in the message, so the reason is
unambiguous:

| Missing module | Tests | Reason, verbatim |
|---|---|---|
| `src/api/auth.ts` | `NFR-JWT-01`…`06` (6) | `Failed to load url ../../src/api/auth … Does the file exist?` |
| `src/api/auth.ts` (read as text) | `NFR-TIMING-01` (1) | `Error: ENOENT: no such file or directory, open '…/src/api/auth.ts'` |
| `src/images/lambdaHandler.ts` | `AC-07/D7-jpeg`, `-png`, `-webp`, `-avif`, `-heic`, `AC-08-corrupt`, `AC-08-unsupported`, `NFR-IMGCPU-01` (8) | `Failed to load url ../../src/images/lambdaHandler … Does the file exist?` |
| `src/api/imageStatus.ts` | `NFR-CALLBACK-01a`, `01b`, `02a`, `02b`, `02c`, `02d` (6) | `Failed to load url ../../src/api/imageStatus … Does the file exist?` |

Every one of these fails inside a test body, never at collection time: the
loaders in `tests/support/seams.ts` are lazy by design, so one missing module
fails its own tests and nothing else's. Note in particular that the eight
`lambdaHandler` failures are *not* fixture failures — the fixtures they use
(real JPEG/PNG/WebP/AVIF encodes and a real HEVC HEIC) were built and decoded
successfully before these tests were written, and `AC-07/D7-heic` reached the
module load, i.e. the HEIC bytes were read without error.

**(b) A method that genuinely does not exist on an existing module — 5 tests.**
Verify finding #4's `tsc` error, now expressed as behaviour:

| Test | Reason, verbatim |
|---|---|
| `AC-01 / VERIFY-04a: createRepo().insertDraft writes a real draft row…` | `TypeError: repo.insertDraft is not a function` |
| `AC-05-free`, `AC-05-held`, `AC-05-stale: createRepo().takeLock — …` | `TypeError: repo.takeLock is not a function` |
| `NFR-CALLBACK-03: flipping a processing image to ready stores the optimized URL…` | `TypeError: repo.setImageStatus is not a function` |

**(c) An honest assertion failure — 14 tests.** Each one reproduces the
verify report's finding as a diff:

| Test | Expected | Actually got |
|---|---|---|
| `VERIFY-01a / AC-03: … persists sanitised HTML…` | `persisted_body_html_was_written: true`, `keeps_the_writers_own_words: true` | `false`, `false` — `markPublished` is never given `body_html` at all, so nothing is sanitised and nothing is stored |
| `VERIFY-01b / NFR-XSS-01: an article row whose body_html was poisoned…` | `executable_script_tags: 0` | `1` — `render.ts:145` interpolates `row.body_html` with zero escaping, exactly as §3 H1 describes |
| `VERIFY-06 / AC-14: … structured_data.image is the cover image's real stored URL` | `…/articles/c3c3c3c3-…-optimized.webp` | `…/articles/a1a1a1a1-…/cover-optimized.webp` — the fabricated path from §6.4, in both the response and the persisted column |
| `VERIFY-07 / TELEMETRY-draft_started: … a plain ISO timestamp…` | `wrapped_in_literal_quotes: false`, `parses_as_a_timestamp: true` | `true`, `false` — §8.1's double-JSON-encoding, reproduced from the production `ENSURE_DRAFT_STARTED_SQL` |
| `VERIFY-04b / NFR-GRANT-01: the elevated role … can insert an article…` | `service_role: null` (insert succeeds) | `'22023'` — the role does not exist; no `0002_*.sql` migration has been written |
| `VERIFY-05a / AC-07: an upload … without ever handing the bytes to a codec` | `image_status: 'processing'`, `codec_invocations: 0`, `objects_stored: 1` | `'ready'`, `1`, `2` — the codec still runs inline, synchronously, in the request |
| `AC-08: an article whose cover is still processing … refused with IMAGE_NOT_READY` | `409 IMAGE_NOT_READY` | `200` — the upload returns `ready`, so there is no `processing` state to refuse |
| `NFR-RATE-02b: the 11th upload in a minute from the same IP is rejected with 429` | `429` | `201` — `uploadImage.ts` never calls the rate limiter |
| `NFR-DOS-01: an unauthenticated chunked request is refused 401 on its headers…` | `401 UNAUTHORIZED`, body bytes bounded | `400 VALIDATION_FAILED`, bound exceeded — `readBody()` drains all 8 MB, then fails to parse it, all before `verify()` runs |
| `NFR-DOS-02: an upload declaring more than 20 MB is refused 413 from its Content-Length…` | `413 FILE_TOO_LARGE`, body bytes bounded | `400`, bound exceeded — the declared 21 MB is fully buffered before anything is checked |
| `AC-01 / TELEMETRY-draft_started: POST /v1/articles creates the draft…` | `201`, 1 `draft_started` row | `404`, 0 rows — the route does not exist, reproducing §4's live probe |
| `AC-05: a second writer opening a draft … 409 DRAFT_LOCKED…` | `409 DRAFT_LOCKED`, holder named | `404 NOT_FOUND` — `POST /v1/articles/{id}/open` does not exist |
| `NFR-AUDIT-01: two drafts created with two differently signed tokens…` | two rows, two distinct writers | `[]` — nothing was created, because nothing accepts a real JWT |

### The two new tests that pass at red, and why that is correct

```
 ✓ tests/unit/uploadImageAsync.test.ts > upload rate limiting > NFR-RATE-02a: the 10th upload in a minute from one IP is still served
 ✓ tests/unit/uploadImageAsync.test.ts > upload rate limiting > NFR-RATE-02c: a second writer on a different IP is unaffected by the first IP exhausting its budget
```

`NFR-RATE-02a` ("the 10th is still served") and `NFR-RATE-02c` ("another IP is
unaffected") cannot fail while there is no limiter at all — an endpoint that
throttles nothing serves everything. Only `NFR-RATE-02b` can be red before the
fix, and it is. The pair exists because a limiter that is too aggressive is as
much a defect as one that is missing, and that is only detectable once one
exists. This is the same structure as the already-shipped `NFR-RATE-01a/c`,
which were green at the original red gate for the same reason
(`03-red-evidence.v1.md` recorded 2 passing tests then, for an analogous
reason).

---

## 5. Two conflicts the green gate must resolve, stated now rather than found later

**5.1 ADR-0004 contradicts two assertions in the existing
`tests/unit/uploadImage.test.ts`.** That file is byte-for-byte what green
certified and this pass did not touch it, as instructed. But it encodes the
synchronous pipeline:

- `AC-07: a 4 MB JPEG comes back as a compressed WebP/AVIF resource…` asserts
  `urls.optimized` is present on the **upload** response.
- `AC-15: a processed image carries auto-generated alt text…` asserts the
  upload response's `status` is `'ready'` with non-empty `alt_text`.

Under ADR-0004 the upload returns `201` with `status: 'processing'` and
`urls: null` — which `contracts/openapi.yaml` already documents as the normal
case ("`processing` and `ready` are both non-error outcomes of a successful
upload"; "`urls`: `null` until `status` is `ready`"; "`alt_text`: `null` while
`processing`"). **Both assertions cannot hold at once.** The green gate has to
re-point those two tests: AC-07's compression claim now belongs to
`tests/unit/lambdaImage.test.ts` (where it is asserted against five real source
formats instead of one padded fixture), and AC-15's alt-text claim belongs
wherever alt text ends up being generated — at insert time with the row still
`processing`, or at callback time when it flips to `ready`. That is a decision,
not a mechanical edit, which is why this pass surfaced it instead of making it.

**5.2 The two new routes are not in the contract.** `POST /v1/articles`,
`POST /v1/articles/{id}/open` and `POST /internal/images/{id}/status` do not
exist in `contracts/openapi.yaml`. The first two are writer-facing and belong
in it; the third is an internal service-to-service callback and arguably does
not. Schemathesis drives the provider side from that document, so anything
added there is fuzzed for free — and anything left out is unfuzzed.

---

### Resolutions, recorded by Bob at the close of this red gate (not by green)

**5.1 resolved.** `contracts/openapi.yaml`'s own "Alt text (AC-15)" note,
already published, settles this precisely: alt text is generated as part of
the async pipeline and is `null` in the API response until `status: ready` —
regardless of when it is computed internally. So:

- The old `AC-07` assertion (`urls.optimized` on the upload response) was
  **deleted** from `tests/unit/uploadImage.test.ts` — fully superseded by
  `VERIFY-05a / AC-07` (this response layer) and `AC-07/D7-*`
  (the codec itself, in `lambdaImage.test.ts`). Both already existed from this
  pass; nothing new was added for AC-07 beyond the deletion.
- The old `AC-15` assertion was **split into two**, both in
  `tests/unit/uploadImage.test.ts`: "an upload response keeps alt_text null
  while processing" (matches the contract's documented response shape —
  fails honestly against the still-synchronous current handler) and "alt text
  is nonetheless generated from the article's own context and persisted at
  upload time" (checks the fake's `inserted` capture, i.e. the row that will
  later be exposed once the callback flips it to `ready` — this one **passes
  today**, correctly, because the current handler already computes alt text
  from the article's title; that behavior isn't changing, only when it's
  *exposed* is).
- Full suite after this reconciliation: **168 tests, 40 failed, 128 passed**
  (was 168/39/129 before — net one more honest failure, one fewer pass, from
  splitting one test into two where only one half changes).

**5.2 resolution in progress.** `POST /v1/articles` and
`POST /v1/articles/{id}/open` are being added to `contracts/openapi.yaml` now,
so Schemathesis can fuzz the provider side. `POST /internal/images/{id}/status`
is being documented separately (service-to-service, not writer-facing) rather
than folded into the same public contract — see whatever file this note is
superseded by once that work lands.

---

## 6. Dependencies added, and why each was unavoidable

| Package | Where | Why |
|---|---|---|
| `sharp@0.34.4` | `dependencies` | ADR-0004's decision, not a test convenience: the Lambda handler *is* `sharp`. Also the only encoder in reach that can produce real photographic JPEG/PNG/WebP/AVIF fixtures without committing binaries to git. |
| `jose@6` | `devDependencies` | Mints real HS256 Supabase-shaped tokens for `tests/support/jwt.ts`. Test-only: production verification is what `src/api/auth.ts` must implement, and it may use whatever it likes. |

`TEST_JWT_SECRET` in `tests/support/jwt.ts` is a value invented for this suite.
No real project secret appears anywhere in this pass; the production secret is
injected through `deps`/`ServerOptions`, which is the seam these tests
configure.

---

## 7. What this pass could not close, and why

- **HEIC decoding is environment-dependent.** `AC-07/D7-heic` uses a real
  4,503-byte HEVC-in-HEIF file with genuine photographic content, and
  `sharp@0.34.4`'s prebuilt binary on this machine (macOS arm64, libheif
  1.20.2) decodes it — confirmed directly before writing the test. It ships an
  AV1 encoder only (`heifsave: Unsupported compression` for
  `compression: hevc`), which is why the fixture is committed as base64 rather
  than generated. **If CI runs a `sharp` build without an HEVC decoder, that
  one case will fail for an environment reason, not a product one.** Check it
  on the CI image before treating a failure there as a regression; if it is
  absent there, the honest options are a system libheif with HEVC, or dropping
  HEIC from the contract's advertised source formats.
- **`NFR-TIMING-01` is a code-presence check, not a timing measurement.** A
  timing side channel of this size is not observable from a unit test's own
  timings; a test that tried would be flaky and would prove nothing. It asserts
  the auth module uses `timingSafeEqual` and does not compare a secret with
  `===`. `05-verification.v1.md` §9 item 9 asks only that the cheap defence
  exist, and that is what is asserted.
- **`NFR-DOS-01`/`NFR-DOS-02` measure bytes pushed to the socket, not bytes the
  server allocated.** There is no portable way to observe the server's
  allocation from a client. Bytes written before the response headers arrive is
  a strict upper bound on what the server can have consumed, which is the right
  direction for this assertion: if the client pushed under 1 MB, the server
  cannot have buffered more.
- **The rendered-page XSS assertion is a property of the output HTML, not a
  CSP.** `05-verification.v1.md` §3 H1 also notes "No CSP anywhere in the
  repo". A CSP is a deploy-time response header, not something this render-pass
  seam emits, so it is not asserted here — it belongs to John's pipeline gate,
  and it should not be forgotten just because it is out of scope for this file.
- **Nothing here proves the real S3 or the real Lambda deployment.** The
  storage seam is a fake, exactly as `tests/support/fakes.ts` does for every
  other collaborator, so the suite needs no AWS credentials. The `sharp`
  conversion itself runs for real. IAM, the S3 event notification and the
  Lambda packaging are deploy concerns for the pipeline gate.
- **The counter-metric is still not event-computable**, unchanged from
  `03-red-evidence.v1.md` and `05-verification.v1.md` §8.3. Nothing in this
  pass changes that, and nothing in this pass pretended to.

---

## 8. Final reconciliation, by Bob, after the two conflicts in §5

The two items §5 flagged as decisions rather than mechanical edits were
resolved (see §5's "Resolutions" subsection, added at the same time as this
section) and the contract gap was closed:

- `tests/unit/uploadImage.test.ts`'s old `AC-07` was deleted (superseded by
  `VERIFY-05a / AC-07` and `AC-07/D7-*`); its old `AC-15` was split into two
  tests matching what `contracts/openapi.yaml` already documented (`alt_text`
  stays `null` in the response while `processing`, but is generated and
  persisted at upload time regardless).
- `contracts/openapi.yaml` gained `createDraft` (`POST /v1/articles`) and
  `openDraft` (`POST /v1/articles/{articleId}/open`); a new, separate
  `contracts/internal-openapi.yaml` documents the Lambda callback
  (`POST /internal/images/{imageId}/status`), kept out of the writer-facing
  document since it's service-to-service, not writer-facing.
- Adding those two writer-facing operations correctly broke
  `CONTRACT-COVERAGE` (the guard test proving every declared operation has a
  consumer test) — closed by adding `createDraft`/`openDraft` to
  `tests/contract/consumer.prism.test.ts`'s `CONSUMER_CASES`, plus one new
  `ERROR_CASES` entry (`AC-05` / `DRAFT_LOCKED` on `openDraft`, mirroring
  publish's existing one), and extending `ArseneClient`'s type in
  `tests/support/seams.ts` with `createDraft`/`openDraft` signatures.

**Final count for this whole remediation pass, command
`NO_COLOR=1 FORCE_COLOR=0 npm test`, run for real:**

```
Test Files  11 failed | 15 passed (26)
     Tests  45 failed | 128 passed (173)
```

All new failures were re-scanned for broken-vs-red honesty (import errors,
missing fixtures, typos) — none found. The one `ENOENT` in the run
(`src/api/auth.ts` does not exist) is a correct "production module genuinely
absent" failure, not a broken test — it's the new real-JWT-verification
module this pass expects green to create.
