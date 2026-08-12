# Integration / E2E verification — second pass (v2)

Independent, external verification of the remediation pass (commits through
`8d30acc`), driven from outside the vitest suite: a hand-written HTTP client
against a real `src/api/serverMain.ts`-equivalent server and a real
Testcontainers Postgres, set up fresh for this pass and not reusing anything
from a prior run. Scope: prove or disprove every claim in
`04-green-evidence.v2.md` about what closed since `05-verification.v1.md`,
plus the auth-fallthrough bug Bob found and fixed independently.

**Bottom line: everything claimed as fixed is genuinely fixed, including the
highest-stakes check (the legacy static token is rejected once a JWT secret
is configured — the auth-fallthrough regression does not reproduce). One
new, real, reproducible gap was found by this pass's own adversarial testing
that the existing suite does not cover: an incomplete HTTP request body can
hang the server indefinitely, most seriously on `/internal/images/{id}/status`,
which requires no credentials at all before the hang point. See §6.**

Verification method: temporary scratch scripts under `scripts/tmp-verify-*.ts`
and `scripts/tmp-repro-*.ts` (same convention as the pre-existing
`scripts/tmp-verify-instrumentation-v2.ts`: not test files, not committed,
deleted after this run), executed with Node's native TypeScript support
(`node scripts/....ts`, Node v26.5.1) against real infrastructure — no
mocking anywhere in this document.

---

## 1. Fresh full suite run

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

```
 Test Files  26 passed (26)
      Tests  174 passed (174)
   Start at  16:33:32
   Duration  22.14s (transform 901ms, setup 0ms, collect 9.93s, tests 80.18s, environment 3ms, prepare 2.04s)
```

174/174, matching the claim (173 remediation tests + `VERIFY-03-REGRESSION`,
Bob's own test for the auth-fallthrough bug). Full pass list included every
file the green-evidence doc names: `tests/e2e/draftJourney.test.ts`,
`tests/e2e/publishJourney.test.ts`, `tests/e2e/transportGuards.test.ts`,
`tests/db/remediation.test.ts`, `tests/unit/publishRemediation.test.ts`,
`tests/unit/auth.test.ts`, `tests/unit/imageStatusCallback.test.ts`,
`tests/unit/lambdaImage.test.ts`, `tests/unit/uploadImageAsync.test.ts`, and
all four `CONTRACT-PROVIDER-*` Schemathesis tests. Notably absent from any
file in the suite: a Schemathesis **provider** run against
`contracts/internal-openapi.yaml` — confirmed intentional, documented as
deviation D13 in `04-green-evidence.v2.md` ("the internal contract is not
fuzzed — `runSchemathesis` only drives `openapi.yaml`"). §5 and §6 below
close that gap independently, and it is exactly where this pass found
something.

---

## 2. The complete real writer journey, over real HTTP

Setup: `startTestDatabase()` (real Testcontainers Postgres, real production
migrations from `db/migrations/*.sql`, freshly started for this run — new
container, not reused) + `startHttpServer()` from `src/api/router.ts`, with
both `jwtSecret` (Supabase HS256) **and** the legacy `writerToken` configured
simultaneously — the exact configuration under which the auth-fallthrough bug
existed. Two real writers seeded (`Marie D.` / writer A, `Lionel Le Boiteux`
/ writer B), two real Supabase-shaped JWTs minted with `tests/support/jwt.ts`
(`jose`, HS256, real signatures).

### Step 1 — create draft (writer A)

```
POST /v1/articles  Authorization: Bearer <tokenA>
{"title":"Verify v2 - Journée 99"}

-> 201 {"article_id":"4bfd1058-1892-48a2-acf1-e483e16a099e","locked_by":"90404a11-9b90-4366-8d85-ffea82b9cb9d"}
```

Direct SQL against the real container:

```sql
select event_type, writer_id, article_id, payload
  from telemetry_events
 where article_id = '4bfd1058-1892-48a2-acf1-e483e16a099e' and event_type = 'draft_started';
```
```json
[{"event_type":"draft_started","writer_id":"90404a11-9b90-4366-8d85-ffea82b9cb9d",
  "article_id":"4bfd1058-1892-48a2-acf1-e483e16a099e",
  "payload":{"started_at":"2026-08-12T15:39:43.401Z"}}]
```

**PASS** — 201, one `draft_started` row, attributed to writer A's real `sub`
claim, `payload.started_at` a clean ISO string (finding #7 — not
double-JSON-encoded; no leading `"` character, parses with `Date.parse`).

### Step 2 — writer B tries to open writer A's draft (lock contention)

```
POST /v1/articles/4bfd1058-1892-48a2-acf1-e483e16a099e/open  Authorization: Bearer <tokenB>
{}

-> 409 {"error":{"code":"DRAFT_LOCKED","message":"This draft is currently locked by another writer.",
  "details":{"locked_by_writer_id":"90404a11-...","locked_by_display_name":"Marie D."},...}}
```

**PASS** — 409 `DRAFT_LOCKED`, names writer A (`Marie D.`) by id and display
name, exactly per contract.

### Step 3 — upload a real cover photo, drive the async pipeline to `ready`

A genuine photographic JPEG was generated (`sharp`, deterministic spatially-
correlated pixel data — not a padded 1×1, same technique as
`tests/support/imageFixtures.ts`'s `realPhoto()`), 1.76 MB at quality 92 (the
target was "around 4 MB"; real photographic content compresses well at that
resolution/quality — the point, a genuinely decodable multi-megapixel photo
rather than a padded placeholder, holds regardless of the exact byte count).

```
POST /v1/articles/{id}/images  Authorization: Bearer <tokenA>  Idempotency-Key: verify-v2-...
multipart/form-data; role=cover; file=verify-v2-cover.jpg (1.76 MB real JPEG)

-> 201 {"id":"7876016d-...","status":"processing","urls":null,"alt_text":null,...}
```

**PASS** — 201, `status: "processing"`, `urls: null`, matching contract's
"Server-side image processing constraint."

Per deviation D9, `router.ts`'s `convert()` stands in for the S3-event →
Lambda trigger, running `optimizeImageBuffer` (real `sharp`) after answering
the writer and applying the same `repo.setImageStatus` compare-and-swap the
real HTTP callback would. Polled directly via SQL (no second API call):

```sql
select status, optimized_url from article_images where id = '7876016d-...';
-- ready | https://cdn.fantasycoach.example/articles/7876016d-8304-48e7-98e7-f13543afba13-optimized.webp
```

**PASS** — reached `ready`, `optimized_url` set to a real value derived from
the image id, not fabricated.

### Step 3b — the internal callback endpoint itself, over real HTTP

Because D9's automatic pipeline bypasses `POST /internal/images/{id}/status`
entirely (it calls `repo.setImageStatus` directly), that route needed its own
independent exercise. A `processing` row was inserted directly via SQL (the
same way a real upload would leave one mid-flight), then hit over real HTTP:

```
POST /internal/images/{id}/status   (no header)                          -> 401
POST /internal/images/{id}/status   X-Arsene-Image-Callback-Secret: wrong -> 401
POST /internal/images/{id}/status   X-Arsene-Image-Callback-Secret: <real>, {"status":"ready","optimized_url":"..."}
  -> 200 {"image_id":"...","status":"ready","optimized_url":"...","failure":null,"updated_at":"..."}
POST /internal/images/{id}/status   (same request again)
  -> 409 {"error":{"code":"CONFLICT","message":"This image has already left \"processing\".",...}}
```

**PASS** on all four — own secret enforced (not the writer JWT, not the
legacy token), constant-time compare (`verifySharedSecret`, confirmed by
reading `src/api/auth.ts`), state machine only moves `processing → ready`
once, a replay gets `409` and changes nothing.

### Step 4 — publish

```
POST /v1/articles/{id}/publish  Authorization: Bearer <tokenA>
{}

-> 200 {"article_id":"...","slug":"verify-v2-journee-99","status":"published",
  "structured_data":{"...","image":["https://cdn.fantasycoach.example/articles/7876016d-8304-48e7-98e7-f13543afba13-optimized.webp"],...},
  "telemetry_event_id":"778db87c-..."}
```

**PASS** — 200. `structured_data.image[0]` compared byte-for-byte against the
`optimized_url` read directly from Postgres in step 3: **identical**. Finding
#6.4 (fabricated `cover_image_url` built from `article.id`) is genuinely
fixed — `publishArticle.ts`'s `publishNow()` reads
`images.find(i => i.role === 'cover')?.optimized_url`, never constructs a
path.

`telemetry_events` for `article_published`:
```json
{"published_at":"2026-08-12T15:39:44.284Z"}
```
**PASS** — clean ISO string, not double-quoted/double-encoded (finding #7,
confirmed on the publish path too, not only the backfill path this pass's
main script exercised in step 1).

### Step 5 — auth-defeat attempts

| Attempt | Expected | Observed |
|---|---|---|
| No token | 401 | **401** — PASS |
| Garbage token (`Bearer not-a-jwt-at-all-#$%`) | 401, not 500 | **401** — PASS |
| Valid-shape JWT signed with the **wrong** secret | 401 | **401** — PASS |
| **Legacy static token (`unused-static-token`) against a server with `jwtSecret` configured** | 401 | **401** — PASS |

The last row is the highest-stakes single check in this pass — the exact bug
Bob found and fixed once already (`router.ts`'s `verify()` used to fall
through to the static-secret comparison even when a JWT secret was
configured). Full response:

```
POST /v1/articles  Authorization: Bearer unused-static-token
{"title":"should be rejected"}

-> 401 {"error":{"code":"UNAUTHORIZED","message":"A valid Supabase Auth bearer token is required.","details":null,...}}
```

**The fix holds.** Reading `router.ts`'s `verify()` confirms why: when
`opts.jwtSecret !== undefined`, the function returns based **solely** on
`verifySupabaseJwt`'s result — it never falls through to
`verifySharedSecret(token, opts.writerToken)` in that branch. The static
token is only ever consulted in the `else` branch, i.e. only for deployments
with no JWT secret configured at all. This matches `tests/e2e/draftJourney.test.ts`'s
own `VERIFY-03-REGRESSION` test, which this pass reproduced independently
from a hand-written client rather than trusting the suite's assertion.

### Step 6 — XSS-defeat

An article's `body_html` was set directly via SQL (simulating the direct
PostgREST write a writer's editor would make) to real content plus
`<script>window.__xss_script_executed = true;</script>` and
`<img src="x" onerror="window.__xss_onerror_executed = true">`, then
published through the real API and rendered through `src/site/render.ts`'s
`renderArticlePage()` (the real ISR render pass, same as production would
serve).

Stored (post-publish, i.e. post-sanitisation) `body_html`:
```html
<p>Real content that is long enough to pass any advisory checks we might hit along the way, padded with more real words describing the match so the introduction length threshold is not the thing under test here at all, it is purely about whether script tags and event handlers survive.</p>
```

Both the `<script>` element and the `onerror` handler are gone entirely —
not escaped, not neutralised in place, simply absent. Rendered `<article>`
body: identical, no script tag, no `onerror`, and neither
`__xss_script_executed` nor `__xss_onerror_executed` marker string appears
anywhere in the rendered page (the page's only `<script>` tag is the
legitimate `application/ld+json` block `render.ts` itself emits for
structured data — this pass's first check was a false positive against that
tag, corrected to scope the check to inside `<article>...</article>` and to
search the whole page for the injected markers). **PASS** — finding #1 (H1,
unsanitized publish-time HTML) is genuinely fixed, confirmed against both the
publish-time sanitiser (`sanitizePastedHtml` in `publishArticle.ts`) and the
render-time defence-in-depth pass (`render.ts` sanitises again).

### Step 7 — DoS-defeat (existing guard)

```
Unauthenticated, chunked (no Content-Length), 8 MB streamed body -> /v1/articles/{id}/publish
-> 401, only 131072 bytes (128 KB) ever pushed to the socket before the answer arrived
```

**PASS** — matches `tests/e2e/transportGuards.test.ts`'s `NFR-DOS-01`,
reproduced independently: the server answers 401 from headers alone, long
before an 8 MB body could ever finish streaming.

---

## 3. Contract re-verification — both sides, fresh

**`contracts/openapi.yaml` (4 operations: createDraft, openDraft,
publishArticle, uploadArticleImage).** Both sides re-verified fresh by the
`npm test` run in §1 against a freshly-started provider each time (not
reused): `tests/contract/consumer.prism.test.ts` (Prism mock, consumer side)
and `tests/contract/provider.schemathesis.test.ts` (Schemathesis fuzzing the
real running Edge Function, provider side) — all passed. This pass's own
hand-written client in §2 additionally exercised every one of the four
operations over real HTTP independently of both, and every response matched
the documented shapes (`201`/`409`/`201`/`200` with the documented fields).

**`contracts/vendor/pronos-openapi.yaml` (vendored consumer contract).**
`tests/contract/pronos-fixtures.prism.test.ts` — 4/4 passed fresh in the same
run. No change expected or found.

**`contracts/internal-openapi.yaml` (the image-status callback — 1
operation, `reportImageStatus`).** This is the one contract the existing
suite does **not** fuzz from the provider side (D13, confirmed in §1). This
pass ran Schemathesis against it independently, for the first time against a
real running server:

```
$ .venv-contract/bin/schemathesis run pdlc/arsene-cms/contracts/internal-openapi.yaml \
    --url http://127.0.0.1:<port> --include-operation-id reportImageStatus \
    --max-examples 20 --checks all \
    --header 'X-Arsene-Image-Callback-Secret:lambda-callback-shared-secret-not-the-writer-token'
```

Result: **1 error, run aborted.**

```
==================================== ERRORS ====================================
____________________ POST /internal/images/{imageId}/status ____________________
Network Error

Read timed out after 10.0 seconds

Reproduce with:
    curl -X POST -H 'X-Arsene-Image-Callback-Secret: [Filtered]' -H 'Content-Type: application/json' \
      -d '{"status": "failed", "failure": {"code": "CORRUPTED_FILE", "message": "could not be decoded"}}' \
      http://127.0.0.1:54308/internal/images/d4d4d4d4-0000-4a2b-9c3d-dddddddddddd/status

Test cases: 15 generated, 15 skipped
1 error in 171.61s
```

The correct-secret, correctly-shaped auth checks (§2 step 3b) all passed,
including this exact endpoint's happy path minutes earlier on a different
image id — so this was not "the endpoint is broken." Investigated below.

---

## 4. Own contract auth check

`securitySchemes.lambdaCallbackSecret` (apiKey header) is independent of the
writer JWT, as documented — confirmed directly: a writer's own valid bearer
token, sent as `X-Arsene-Image-Callback-Secret`, is rejected (it's compared
against `imageCallbackSecret`, never against `jwtSecret`/`writerToken`); the
real callback secret works; the constant-time comparator
(`verifySharedSecret`) is used, per `src/api/auth.ts` and `NFR-TIMING-01`.
This matches the contract's "Auth model" section exactly.

---

## 5. Discrepancy found — no timeout on an incomplete request body (new, not previously reported)

**What was found.** `src/api/router.ts`'s `readBody()`:

```ts
async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_UPLOAD_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
```

has no timeout of its own, and `startHttpServer()` sets no
`server.requestTimeout` / `server.headersTimeout` override on the
`http.Server` it creates. If a client declares a `Content-Length` under the
20 MB cap but never actually sends that many bytes and never closes the
connection, `for await (const chunk of req)` simply waits — the loop only
ends when the stream ends, and the stream doesn't end.

**Reproduction (isolated from Schemathesis, own script):**

```ts
// scripts/tmp-repro-content-length-hang.ts (deleted after this run)
const req = http.request({ ...,
  path: '/internal/images/00000000-0000-4000-8000-000000000000/status',
  headers: { 'content-length': '500', 'x-arsene-image-callback-secret': '<real secret>', ... },
});
req.write(body.slice(0, 10)); // 10 of the declared 500 bytes; no req.end()
```

```
server http://127.0.0.1:54581
After 8000ms of an incomplete body: answered=false
req error after 8023ms: socket hang up   (the script's own guard destroyed the socket at 8s)
```

**No response at all within 8 full seconds.** This is exactly what tripped
Schemathesis's own 10-second client read timeout in §3 — its negative-testing
generator produced a request whose body didn't arrive as declared, and the
server never answered.

**Why this evaded the existing DoS tests.** `tests/e2e/transportGuards.test.ts`
covers two cases: `NFR-DOS-01` (no credentials, chunked, real bytes actually
streamed) and `NFR-DOS-02` (declared over the 20 MB cap). Neither is "declared
size under the cap, but the promised bytes never actually arrive." The fix
those tests prove — check credentials/size from headers before buffering — is
real and holds (§2 step 7 above). It just doesn't cover a body that stalls
partway through.

**Why this is worse specifically on `/internal/images/{id}/status`.**
`router.ts`'s top-level `route()` guard explicitly skips the writer-bearer
check for this one operation kind (`op.kind !== 'image-status' && ...`),
because its own secret is checked inside `handleImageStatusCallback` — which
only runs *after* `readBody()` returns. So this route can be hung by a caller
holding **no credentials of any kind**, unlike `publish`/`upload`/
`create-draft`/`open`, where an attacker at least needs a request that gets
past the pre-body writer-auth check first (itself not nothing, but a
materially smaller attack surface than "no credentials required at all").

**Bound on the exposure.** Plain Node `http.Server` has its own default
`requestTimeout` (300 000 ms) which should eventually tear down a stalled
connection even though this code sets nothing explicitly — not independently
re-verified in this pass (a 5-minute wait was judged not worth the time
budget), so treat "eventually" as unconfirmed, not as "never." Either way,
the code contains **no explicit bound of its own**, which is the same shape
of gap finding #2/H2 was written to close for the other two DoS vectors.

**Severity assessment (informational, not adjudicated by this report).**
Requires either an unauthenticated slow/broken client hitting the internal
route (network-reachability of that route is itself a deploy-time question —
ADR-0004 says it's a separate Edge Function deployment, not necessarily
public) or an authenticated-but-slow client on the writer-facing routes. Not
a full unauthenticated remote crash, but a real, adversarially-discovered gap
in the DoS mitigation's coverage that the claimed-fixed status of finding #2
did not disclose. Recommend triage against the same rubric H2 was fixed
under, and a regression test alongside `NFR-DOS-01`/`NFR-DOS-02` for
"declared-under-cap, body stalls, never completes."

A related but unconfirmed observation: every run in this pass (including the
official `npm test`) emits `DeprecationWarning: Calling client.query() when
the client is already executing a query is deprecated`, sourced from
`router.ts`'s `pool.on('connect', (client) => void client.query('set role
service_role'))` — an un-awaited query fired the moment a new pool
connection is created, racing whatever query triggered that connection's
creation. This is a plausible contributing mechanism to intermittent
connection-handling weirdness under load; a 12-way concurrent-request stress
test against a cold pool (own script, 3 runs) did **not** reproduce a hang
from this alone, so it is reported as a code-quality/race-condition
observation worth a look, not as a confirmed cause of §5's hang (whose cause
is fully explained by the missing body-read timeout regardless).

---

## 6. Everything else — matches the claims

| Claim (04-green-evidence.v2.md / 05-verification.v1.md) | This pass's verdict |
|---|---|
| Draft creation reachable via `POST /v1/articles`, emits `draft_started` synchronously | **Confirmed**, real HTTP, real telemetry row |
| `POST .../open` lock contention, 409 names the holder | **Confirmed** |
| Real per-writer Supabase JWT auth (`writer_id` from `sub`, not a process constant) | **Confirmed** — two different writers, two different tokens, two different `writer_id`s recorded |
| Legacy static token rejected once `jwtSecret` is configured (the regression Bob fixed) | **Confirmed, holds** — the highest-stakes check in this pass |
| S3+Lambda-style async image pipeline reaches `ready` with a real stored `optimized_url` | **Confirmed** via SQL |
| `POST /internal/images/{id}/status` auth (own secret, not writer JWT), state machine (`processing`→ once) | **Confirmed** over real HTTP, both auth and state-machine sides |
| `structured_data.image`/cover URL is the real stored URL, not fabricated (finding #6.4) | **Confirmed**, byte-for-byte match against SQL |
| Telemetry payloads are clean ISO strings, not double-JSON-encoded (finding #7) | **Confirmed**, both `draft_started` and `article_published` |
| Publish-time HTML sanitisation (finding #1/H1) | **Confirmed** — script and event-handler payloads do not survive storage or render |
| Transport-layer DoS guard order (finding #2/H2) — the two cases the suite tests | **Confirmed**, reproduced independently |
| Contract `openapi.yaml`, both sides | **Confirmed**, fresh run |
| Vendored pronos contract still passes | **Confirmed**, fresh run |
| Contract `internal-openapi.yaml`, provider side | **Not previously covered by the suite (D13); this pass covered it directly and found §5** |

---

## 7. Addendum — a second, deeper auth-boundary finding, observed mid-flight from concurrent work

While finishing this report, the working tree showed uncommitted changes this
pass did not make: `src/api/server.ts`, `tests/support/seams.ts`, and a new
`tests/e2e/deployedAuthBoundary.test.ts`, consistent with another agent in
this same verify gate (per that file's own comment, found "while re-proving
the instrumentation for the second verify pass"). Recorded here rather than
silently ignored, because it bears directly on this pass's highest-priority
question — auth — and on a real gap in this pass's own coverage:

**Everything in §2 step 5 of this report was driven through
`src/api/router.ts`'s `startHttpServer()` directly, in-process** — the same
starter `tests/e2e/draftJourney.test.ts`'s `VERIFY-03-REGRESSION` uses. That
check is real and solid (§2 confirms it independently), but it is **not**
the boundary a real deployment uses. `src/api/server.ts`'s `startServer()`
spawns `src/api/serverMain.ts` as a genuine child process, and
`serverMain.ts` deliberately reads `jwtSecret`/`imageCallbackSecret` from
**environment variables**, never argv, "so they must not show up in a
process listing." Per the diff observed:

```diff
   const child = spawn(process.execPath, [ENTRY, String(opts.port), opts.databaseUrl, opts.writerToken, opts.writerId], {
-    stdio: ['ignore', 'pipe', 'pipe'],
+    stdio: ['ignore', 'pipe', 'pipe'],
+    env: {
+      ...process.env,
+      ...(opts.jwtSecret !== undefined ? { SUPABASE_JWT_SECRET: opts.jwtSecret } : {}),
+      ...(opts.imageCallbackSecret !== undefined ? { IMAGE_CALLBACK_SECRET: opts.imageCallbackSecret } : {}),
+    },
   });
```

Before this (uncommitted, in-progress) fix, `startServer()`'s spawn call
never forwarded `opts.jwtSecret`/`opts.imageCallbackSecret` to the child's
environment at all — `ServerOptions` advertised the fields, but they were a
silent no-op through this one entry point. Any real deployment or test
configured via `startServer({ ..., jwtSecret })` would have had its child
process boot with `jwtSecret: undefined` regardless, meaning `verify()`
would take the `else` branch every time and accept **only** the legacy
static token — the exact failure mode Bob's fix and this pass's §2 step 5
were both concerned with, just one level further out, in how the secret
reaches the process rather than in `verify()`'s own branching logic.

This pass did not discover this independently (it tested the in-process
starter, not the spawn boundary) and did not verify the fix now sitting
uncommitted in the tree — that work was still in progress from another
agent as this report was being finished, and re-running the suite against
a mid-flight, uncommitted change would risk conflating this pass's findings
with someone else's not-yet-settled work. **Flagging for the coordinator:**
before this verify gate is considered closed, `npm test` should be re-run
once `src/api/server.ts` / `tests/e2e/deployedAuthBoundary.test.ts` land, to
confirm `VERIFY-03-DEPLOY-01`/`02` pass against the real spawned-child
boundary — that is a materially different, and materially more
production-relevant, proof than anything in §2 step 5 of this report.

## 8. Cleanup

Scratch verification scripts used for this pass
(`scripts/tmp-verify-integration-e2e-v2.ts`,
`scripts/tmp-repro-internal-hang.ts`, `scripts/tmp-repro-concurrency-hang.ts`,
`scripts/tmp-repro-content-length-hang.ts`) were deleted after this run, per
the same convention as the pre-existing
`scripts/tmp-verify-instrumentation-v2.ts`. No test file and no production
code was modified by this pass.
