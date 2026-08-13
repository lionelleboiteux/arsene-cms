# Integration / E2E verification — third pass (v3)

Independent, external verification of the third remediation pass (commit
`f0c4f60`, "green remediation v3: 185/185"), driven from outside the vitest
suite: hand-written HTTP clients and hand-written SQL against a real
Testcontainers Postgres 16, a **real spawned child process** (`src/api/server.ts`'s
`startServer()`, not `router.ts`'s in-process `startHttpServer()` shortcut),
real sockets, and a real standalone Schemathesis process. Scope: prove or
disprove every claim in `04-green-evidence.v3.md`, with particular attention to
the two things that document honestly flagged as **not proven by the automated
suite** (§8 there).

**Bottom line.**

- **Both flagged gaps are genuinely closed, and I can show it.** The
  `imageCallbackSecret` really does reach the spawned child (proved with a
  decoy value planted in the parent's environment — the exact `jwtSecret`
  failure shape of `02a3f92` would have made the decoy win, and it didn't), and
  the read timeout really does fire on a stalled body behind a *valid* callback
  secret (`408` at 9 793 ms against the real spawned child, not an early exit
  through M2's guard).
- **M1, M2, L1, L2 are genuinely and completely fixed**, re-verified
  adversarially with cases beyond what the suite covers.
- **M3 is fixed for the case it was written for and broken for a neighbouring
  one**: `SUPABASE_JWT_SECRET=""` **plus** the deliberate legacy opt-in produces
  a server that starts successfully and then rejects **every** request, on every
  credential. It fails closed (no bypass), but it is a silent total outage
  reachable from exactly the half-completed-rotation scenario M3 exists to
  handle.
- **Five new findings**, none of them High: the M3 outage above; a
  contract/implementation divergence that standalone Schemathesis catches on
  `internal-openapi.yaml`; the same divergence as a deployment landmine
  (`CDN_ORIGIN` is a hardcoded fictional domain with no environment override);
  the 8-second whole-request timeout demonstrably refusing ordinary, legitimate
  uploads; and — found by the *committed* suite itself on run 5, because its
  provider contract test uses a fresh random seed every run — a genuine
  unhandled exception, `POST /v1/articles` returning `500` for any `title`
  containing a NUL byte.
- **No High-severity issue was found.** No auth bypass, no data leak, and no
  fix that fails to do what it claims.

Method note: throwaway scripts under `/tmp/arsene-v3/` (outside the repo, with
a symlink to the worktree's `node_modules`), run on Node v26.5.1. **No file in
`src/`, `db/`, `tests/` or `package.json` was modified — `git status` was clean
at the start of this pass and clean at the end.**

---

## 1. Full regression suite — five runs, and it is not deterministically green

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

| Run | 1-min load average at start | Result | Duration |
|---|---|---|---|
| 1 | 57.12 | **184 passed, 1 failed (185)** | 28.42 s |
| 2 | 58.78 | **184 passed, 1 failed (185)** | 42.58 s |
| 3 | ~50 | 185 passed (185) | 23.46 s |
| 4 | 12.04 | 185 passed (185) | 33.10 s |
| 5 | 56.53 | **184 passed, 1 failed (185)** — a *different* test, and a real bug (§5, N5) | 24.23 s |

**Three of five runs were green. The worktree is not at a reproducible
185/185.** Two distinct causes, and they are not the same kind of problem: runs
1–2 are a flaky wall-clock assertion (§1.1); run 5 is the contract suite doing
its job and finding a genuine `500` (N5).

Runs 1 and 2 failed on the same test, verbatim from `/tmp/v3-run1.log`:

```text
 × tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 1599ms
   → expected { ok: true, within_one_second: false } to deeply equal { ok: true, within_one_second: true }

 FAIL  tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: ...
AssertionError: expected { ok: true, within_one_second: false } to deeply equal { ok: true, within_one_second: true }

-   "within_one_second": true,
+   "within_one_second": false,

    142|     expect({ ok: result.ok, within_one_second: elapsedMs < 1_000 }).to…
    144|       within_one_second: true,

 Test Files  1 failed | 27 passed (28)
      Tests  1 failed | 184 passed (185)
```

Run 2 was the same test, at 1 992 ms.

### 1.1 It is not a code regression — it is a wall-clock assertion in a parallel runner

Run in isolation, three times, on the same machine, at the same load:

```text
=== iso run 1, load: 61.29 52.74 30.49 ===
 ✓ ... NFR-IMGCPU-01: ... 457ms
      Tests  8 passed (8)
=== iso run 2, load: 58.78 52.36 30.49 ===
 ✓ ... NFR-IMGCPU-01: ... 462ms
      Tests  8 passed (8)
=== iso run 3, load: 58.78 52.36 30.49 ===
 ✓ ... NFR-IMGCPU-01: ... 495ms
      Tests  8 passed (8)
```

457–495 ms against a 1 000 ms budget — the codec itself is comfortably inside
budget and `sharp` 0.35.3 has not regressed. What fails is the *test*: it asserts
a wall-clock duration while vitest is concurrently running Testcontainers
Postgres containers, a Prism mock and blocking `spawnSync` Schemathesis
processes in sibling files, so it measures machine contention, not codec cost.

The high load was partly this verify gate's own doing — `docker ps` showed an
`arsene-audit-pg` container and a foreign Testcontainers Postgres belonging to
other agents running the same gate concurrently. That is exactly the condition
CI will also present.

**Finding (Low, test quality):** `NFR-IMGCPU-01` is a flaky gate. Its budget is
correct and the code meets it with ~2× headroom when measured fairly; the test
should either measure CPU time rather than wall time, run in an isolated
(non-parallel) vitest project, or carry a headroom factor. `04-green-evidence.v3.md`'s
"six full executions, all 185/185" is true of an unloaded machine and does not
reproduce on a busy one. **This is the only failing test observed in five runs;
the other 184 never varied.**

### 1.2 Typecheck

```text
$ npx tsc --noEmit
tsc exit: 0
```

Clean, no output.

---

## 2. Contracts, both sides

### 2.1 Consumer side — every operation is covered

`tests/contract/consumer.prism.test.ts` drives all four operations declared in
`contracts/openapi.yaml` (`createDraft`, `openDraft`, `publishArticle`,
`uploadArticleImage`) against a real Prism mock, and — better than an eyeball
check — the file contains a self-enforcing coverage assertion:

```ts
it('CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer test in this file', () => {
  const declared = contractOperations().map((o) => o.operationId).sort();
  expect(CONSUMER_CASES.map((c) => c.operationId).sort()).toEqual(declared);
});
```

so an operation added to the contract without a consumer test fails the suite.
Confirmed passing in every run. Plus 7 error-branch cases across
`publishArticle`/`uploadArticleImage`/`openDraft`. **PASS.**

### 2.2 Provider side, public contract — fuzzed 40× deeper than the committed suite

The committed `runSchemathesis` uses `--max-examples 5`. Run standalone at 200
examples per operation, seed 9001, against the **real spawned server** with a
real Supabase-shaped JWT:

| Operation | Test cases | Result |
|---|---|---|
| `openDraft` (the lock-grant change) | 221 generated, 221 passed | ✅ |
| `createDraft` | 623 generated, 623 passed, 386 skipped | ✅ No issues found |
| `publishArticle` | 255 generated, 255 passed | ✅ |
| `uploadArticleImage` | 231 generated, 231 passed | ✅ |

1 330 cases, zero failures, zero network errors. **PASS.**

### 2.3 Provider side, internal contract — the v2 hang is gone, and a new divergence appears

This is the contract `05-verification.v2.md` §6 called out as "never fuzzed
provider-side by the regular suite" (deviation D13), and where the v2 pass's
one-off manual run found the `readBody()` timeout gap by aborting with
`Read timed out after 10.0 seconds` after 171.61 s.

Re-run adversarially, same tool, deeper, against a real spawned server holding
40 seeded `processing` rows (so the fuzzer can reach real logic, not only 404):

```
$ .venv-contract/bin/schemathesis run pdlc/arsene-cms/contracts/internal-openapi.yaml \
    --url http://127.0.0.1:60389 --include-operation-id reportImageStatus \
    --max-examples 400 --seed 7 --checks all --exclude-checks positive_data_acceptance \
    --request-timeout 20 \
    --header 'X-Arsene-Image-Callback-Secret:lambda-callback-shared-secret-not-the-writer-token'
```

```text
 ✅  Fuzzing (in 3.34s)
Test cases:
  478 generated, 478 passed
Seed: 7
============================= 2 warnings in 3.87s ==============================
```

and again at seed 424242: `478 generated, 478 passed`, `in 4.42s`.

**956 fuzz cases, no hang, no read timeout, whole run in under 5 seconds where
v2's aborted after 171 seconds. The §5 timeout finding is genuinely closed at
the provider-contract level, not only in the hand probe.**

**But the same tool found something new.** With all checks enabled (seed 31337,
150 examples):

```text
=================================== FAILURES ===================================
____________________ POST /internal/images/{imageId}/status ____________________
1. Test Case ID: WtcCrN

- API rejected schema-compliant request

    Valid data should have been accepted
    Expected: 2xx, 401, 403, 404, 409, 5xx

[400] Bad Request:

    `{"error":{"code":"VALIDATION_FAILED","message":"Request failed validation.","details":{"fields":[{"field":"optimized_url","message":"must be a URL on https://cdn.fantasycoach.example"}]},"request_id":"4d748bd3-2a0f-4870-9b8e-ec774c626556"}}`

Reproduce with:

    curl -X POST -H 'X-Arsene-Image-Callback-Secret: [Filtered]' -H 'Content-Type: application/json' \
      -d '{"optimized_url": "https://A.COM", "status": "ready"}' \
      http://127.0.0.1:60389/internal/images/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc/status

=================================== WARNINGS ===================================

Schema validation mismatch: 1 operation mostly rejected generated data due to validation errors,
indicating schema constraints don't match API validation

  - POST /internal/images/{imageId}/status

💡 Check your schema constraints - API validation may be stricter than documented
```

See §5 (new finding N2).

---

## 3. Fix-by-fix hand re-verification

Everything below ran against a real Testcontainers Postgres 16 and, where HTTP
is involved, against a **real child process spawned by `src/api/server.ts`'s
`startServer()`** — deliberately not `startHttpServer()`, because the in-process
shortcut is precisely what hid the `jwtSecret` bug through a whole verify pass.

36/36 checks passed in the main script; 11/12 in the M3 script (the one failure
is finding N1).

### 3.1 M1 — draft-lock theft via direct PostgREST — **PASS**

As the `authenticated` Postgres role, four attack shapes (two more than the
suite's `NFR-LOCK-GRANT-01a/b`):

```text
lock held by marie: {"locked_by":"140f556b-…","locked_at":"2026-08-13T07:46:42.199Z"}
  as authenticated: update articles set locked_by = $2, locked_at = now() where id = $1  -> SQLSTATE 42501
  as authenticated: update articles set locked_at = now() where id = $1                  -> SQLSTATE 42501
  as authenticated: update articles set locked_by = $2 where id = $1                     -> SQLSTATE 42501
  as authenticated: update articles set locked_by = null, locked_at = null where id = $1 -> SQLSTATE 42501
PASS  M1-unchanged — lock still held by marie after all 4 attacks: {"locked_by":"140f556b-…","locked_at":"2026-08-13T07:46:42.199Z"}
PASS  M1-not-overbroad — authenticated can still UPDATE articles.title (no collateral revoke): accepted
```

Three further ways to reach the columns, also refused:

```text
  C1-insert-with-lock      -> 42501     (insert … (locked_by, locked_at) values …)
  C2-update-all-columns    -> 42501     (a mixed update touching title AND locked_by)
  C3-delete-row            -> 42501
  article still present after the delete probe: true
```

C2 is the one worth naming: a mixed `UPDATE` that touches a granted column
*and* a revoked one is refused as a whole, so the revoke cannot be smuggled
past by pairing it with a legal write.

**The legitimate path still works, end to end over real HTTP against the real
spawned child:**

```text
  marie opens free draft   -> 200 {"article_id":"5b21267e-…","title":"…","body_html":"…"}
  thief opens held draft   -> 409 {"error":{"code":"DRAFT_LOCKED","message":"This draft is currently locked by another writer.","details":{"locked_by_writer_id":"140f556b-…","locked_by_display_name":"Marie D. (verify v3)"},"request_id":"54e72e9a-…"}}
  marie re-opens her own   -> 200
  DB row shows locked_by = marie via the seam: 140f556b-…
  thief opens 91s-stale    -> 200      (stale takeover through the CAS, no admin unlock)
```

And under a real race — ten writers, ten real JWTs, one free draft,
simultaneously:

```text
  10 simultaneous POST /open on one free draft -> statuses [409,409,200,409,409,409,409,409,409,409]
  granted=1 refused409=9 other=0
  DB locked_by = 5deff0ba-1150-4a2b-bd54-e58d31d77517
  >>> PASS — exactly one writer may win the CAS (got 1)
```

Exactly one winner. The CAS is atomic in the database, and the database is now
the only writer. M1 is closed in substance, not just in appearance.

### 3.2 M2 — body buffered before the callback secret is checked — **PASS**

Real chunked sockets against the real spawned child, 8 MB offered, measuring
bytes actually pushed when the response headers arrived:

```text
  M2-no-secret:     status 401, bytes pushed before answer = 65536 of 8388608
  M2-wrong-secret:  status 401, bytes pushed before answer = 65536 of 8388608
  M2-decoy-secret:  status 401, bytes pushed before answer = 65536 of 8388608
  correct secret, real body -> 200 {"image_id":"edd194a4-…","status":"ready","optimized_url":"https://cdn.fantasycoach.example/articles/edd194a4-…-optimized.webp","failure":null,"updated_at":"2026-08-13T07:46:43.707Z"}
```

64 KiB — one chunk, i.e. whatever was already in flight — out of 8 MiB, 0.78 %.
The refusal is decided from the headers. A correct secret still reaches the
handler and still writes through to Postgres.

### 3.3 M3 — fail-closed on a missing JWT secret — **PARTIAL PASS, one new failure**

Three real spawns of `startServer()`, with `SUPABASE_JWT_SECRET`,
`ALLOW_LEGACY_STATIC_AUTH` and `IMAGE_CALLBACK_SECRET` all deleted from the
parent's environment first so nothing leaks in by inheritance.

**(a) `SUPABASE_JWT_SECRET` entirely unset, no opt-in — refuses. PASS.**

```text
  refusal reported by startServer():
---
Edge Function exited with code 78:
refusing to start: SUPABASE_JWT_SECRET is missing or empty, so every request would be
authenticated by the shared static writer token instead of the caller's own Supabase Auth
JWT. Set SUPABASE_JWT_SECRET, or set ALLOW_LEGACY_STATIC_AUTH=true to choose the legacy
static-token mode deliberately.
---
PASS  M3a-refuses — exit 78 + names SUPABASE_JWT_SECRET
PASS  M3a-explains-remedy — message names the deliberate opt-in
```

**(b) `SUPABASE_JWT_SECRET=""`, no opt-in — refuses. PASS.** Same exit 78, same
message. Also confirmed for an empty value arriving by *inheritance* from the
parent environment rather than through `opts` (`M3b2`, exit 78).

**(c) with `allowLegacyAuth: true` — starts, and here it splits.**

```text
  --- no jwtSecret at all + allowLegacyAuth ---
  started: http://127.0.0.1:60330
  legacy static token -> 200 {"article_id":"432c9a74-…","title":"M3",…}
  wrong static token  -> 401
  a real JWT in legacy mode -> 401     (correct: legacy mode does not verify JWTs)
PASS  M3c1-legacy-serves / M3c1-wrong-refused / M3c1-jwt-not-accepted

  --- jwtSecret: "" + allowLegacyAuth ---
  started: http://127.0.0.1:60333
  legacy static token -> 401 {"error":{"code":"UNAUTHORIZED","message":"A valid Supabase Auth bearer token is required.",…}}
  wrong static token  -> 401
  a real JWT in legacy mode -> 401
FAIL  M3c2-legacy-serves — legacy static token accepted and served: 401
```

**(d) control — a real `jwtSecret`, no opt-in — starts and behaves. PASS.**

```text
  real JWT -> 200
  legacy static token against a JWT-configured server -> 401
PASS  M3d-jwt-mode-works
PASS  M3d-legacy-refused — the H3 regression stays closed on the real spawned child
```

The (d) result is worth keeping: the original H3 regression (legacy static token
accepted alongside a configured JWT secret) is confirmed still closed at the
real deployment boundary, not just in-process.

The (c)/empty-string failure is new finding **N1**, analysed in §5.

### 3.4 L1 — `sharp` CVEs — **PASS**

```text
$ grep '"sharp"' package.json
    "sharp": "0.35.3",
$ npm audit --omit=dev
found 0 vulnerabilities
```

Was 1 High at `0.34.4`. The real-codec suite (`AC-07/D7-*` incl. HEIC,
`AC-08-corrupt`, `AC-08-unsupported`, `NFR-IMGCPU-01`) passes on the new
version, so the bump did not silently lose a decoder.

### 3.5 L2 — `optimized_url` scoped to the CDN origin — **PASS**

Nine cases against the real spawned child with a valid callback secret — the
suite covers two of them:

```text
  L2a-foreign-host         https://images.attacker.test/pwned.webp                    -> 400 VALIDATION_FAILED
  L2b-prefix-confusable    https://cdn.fantasycoach.example.attacker.test/pwned.webp  -> 400 VALIDATION_FAILED
  L2b2-prefix-path-trick   https://cdn.fantasycoach.example@attacker.test/pwned.webp  -> 400 VALIDATION_FAILED
  L2b3-scheme-downgrade    http://cdn.fantasycoach.example/pwned.webp                 -> 400 VALIDATION_FAILED
  L2b4-port-differs        https://cdn.fantasycoach.example:8443/pwned.webp           -> 400 VALIDATION_FAILED
  L2b5-not-a-url           not-a-url-at-all                                           -> 400 VALIDATION_FAILED
  L2b6-javascript-uri      javascript:alert(1)                                        -> 400 VALIDATION_FAILED
  L2b7-uppercase-host      https://CDN.FANTASYCOACH.EXAMPLE/x.webp                    -> 200
  L2c-genuine-cdn          https://cdn.fantasycoach.example/articles/real-…webp       -> 200
PASS  L2-no-write-on-reject — rejected callbacks wrote nothing: {"status":"processing","optimized_url":"https://cdn.example/…/body-optimized.webp"}
```

`L2b2` (userinfo `@` confusion), `L2b3` (scheme downgrade), `L2b4` (port),
`L2b5` (the uncovered `catch` branch `04-green-evidence.v3.md` §6.1 named) and
`L2b6` (`javascript:`) are all beyond the suite's coverage and all correctly
refused — `new URL(v).origin` is doing real work, not a prefix test in
disguise. `L2b7` (uppercase host) is accepted, which is **correct**: DNS is
case-insensitive and `URL.origin` normalises the host, so it is the same
origin. Note only that the row then stores the caller's uppercase spelling
verbatim; harmless, cosmetic.

And the rejections are decided before any repository call — the `processing`
row that received seven 400s was never touched.

---

## 4. The two gaps `04-green-evidence.v3.md` §8 admitted were not proven

### 4.1 Gap 1 — `imageCallbackSecret` forwarding through the `spawn` boundary — **CLOSED, proven**

The concern was the exact shape of the `jwtSecret` bug fixed in `02a3f92`: a
field advertised on `ServerOptions`, silently dropped by `startServer()`'s
`spawn` call, with no test covering it (`server.ts` line 50, "no `startServer`
call site in the suite passes `imageCallbackSecret`" — still true; I re-grepped,
the only call sites are `provider.schemathesis`, `publishJourney`,
`failClosedConfig` and `deployedAuthBoundary`, and none of them pass it).

A pass/fail check alone would be weak here, because the child inherits
`process.env` — so a "correct secret works" result could equally mean
"the secret happened to be in the environment already". I planted a **decoy**
to remove that ambiguity:

```text
parent process.env.IMAGE_CALLBACK_SECRET = DECOY-secret-sitting-in-the-parent-process-environment
startServer({ imageCallbackSecret: GAP1-secret-passed-only-through-startServer-options })
spawned child listening on http://127.0.0.1:60249
```

If `server.ts` did **not** forward `opts.imageCallbackSecret`, the child would
boot with the decoy and the decoy would be the working credential. Results
against the real child over real HTTP:

```text
  no secret                     -> 401 {"error":{"code":"UNAUTHORIZED","message":"A valid image-callback secret is required.",…}}
  parent-env DECOY secret       -> 401 {"error":{"code":"UNAUTHORIZED",…}}
  wrong secret                  -> 401 {"error":{"code":"UNAUTHORIZED",…}}
  CONFIGURED secret             -> 200 {"image_id":"86c225b0-…","status":"ready","optimized_url":"https://cdn.fantasycoach.example/articles/86c225b0-…-optimized.webp","failure":null,"updated_at":"2026-08-13T07:46:43.696Z"}
  DB row after callback: {"status":"ready","optimized_url":"https://cdn.fantasycoach.example/articles/86c225b0-…-optimized.webp"}
  replay of the same callback   -> 409 {"error":{"code":"CONFLICT","message":"This image has already left \"processing\".","details":{"image_id":"86c225b0-…","current_status":"ready"},…}}
  writer JWT as callback secret -> 401
```

**The decoy is rejected and the configured value is accepted.** That is only
possible if `opts.imageCallbackSecret` reached the child and overrode the
inherited environment — which is exactly what `server.ts`'s `env` spread does.
The forwarding is real, the configured secret is the one enforced, the write
lands in real Postgres, the state machine still refuses a replay, and a writer
JWT is still not a callback secret.

**This regression shape is closed. It remains untested by the committed suite;
a test mirroring `VERIFY-03-DEPLOY-01` for the callback secret would make that
permanent.**

### 4.2 Gap 2 — does the read timeout actually fire behind a *valid* secret? — **CLOSED, proven**

`NFR-DOS-03` sends no callback secret, so since M2's fix it is answered `401`
from the headers in milliseconds and never reaches the timeout it was written
to prove. Driven properly — **valid** callback secret, `Content-Length: 1000000`
declared, 1 024 bytes sent, then silence forever, against the **real spawned
child** running the shipped `DEFAULT_READ_TIMEOUT_MS = 8_000` (not the test's
1 500 ms override):

```text
  GAP2-valid-secret-stalls: declaring 1,000,000 bytes, sending 1,024, then silence...
  GAP2-valid-secret-stalls: settled after 9793 ms — response 408
PASS  GAP2-valid-secret-stalls — torn down after 9793ms

  GAP2-writer-jwt-stalls-publish: declaring 1,000,000 bytes, sending 1,024, then silence...
  GAP2-writer-jwt-stalls-publish: settled after 8056 ms — response 408
PASS  GAP2-writer-jwt-stalls-publish — torn down after 8056ms
```

A real `408`, at 9 793 ms and 8 056 ms — consistent with the documented
`8 000 ms` plus the `/4` connection sweep (≤ 1.25× ⇒ ≤ 10 s). The second case
runs the same probe past the *writer JWT* guard on `/v1/articles/{id}/publish`,
confirming the bound is a property of the server rather than of the one route.

Under concurrency:

```text
  10 stalled connections settled in 10027 ms; per-connection:
  10021ms/response, 10015ms/response, 10014ms/response, 10014ms/response, 10014ms/response,
  10014ms/response, 10014ms/response, 10014ms/response, 10014ms/response, 10015ms/response
PASS  GAP2b-concurrent — max 10021ms
  server still serving after the stall storm -> 409
PASS  GAP2b-still-healthy
```

All ten reclaimed together on the sweep, and the server answers normally
straight afterwards. **`NFR-DOS-03`'s green result understates the truth rather
than overstating it: the mechanism works, it just isn't what that test
measures.** Independently corroborated by §2.3 — the Schemathesis run that
aborted on a read timeout at v2 now completes 956 cases in under 5 seconds.

---

## 5. New findings

### N1 (Medium, availability) — `SUPABASE_JWT_SECRET=""` plus the legacy opt-in boots a server that rejects everything

Reproduced in §3.3(c). Mechanism, traced and confirmed by direct probe:

- `serverMain.ts` passes `jwtSecret: process.env.SUPABASE_JWT_SECRET` straight
  through — for an empty variable that is `''`, **not** `undefined`.
- `router.ts`'s `verify()` branches on `if (opts.jwtSecret !== undefined)`.
  `'' !== undefined` is `true`, so it takes the JWT branch and **never** reaches
  the static-token branch.
- Every JWT verification against a zero-length key fails:

```text
minting a token signed with the EMPTY key: SIGNING FAILED: Zero-length key is not supported
verifySupabaseJwt(a REAL token, secret:"") -> {"valid":false,"reason":"Zero-length key is not supported"}
verifySupabaseJwt(alg:none token, secret:"") -> {"valid":false,"reason":"\"alg\" (Algorithm) Header Parameter value not allowed"}
verifySharedSecret('anything', '') -> false
```

**Not a security issue** — it fails closed, an attacker cannot mint a token that
verifies against an empty key, and `alg:none` is refused. It is an availability
issue, and the path to it is the very scenario M3 was written about:

1. A secret rotation half-completes and leaves `SUPABASE_JWT_SECRET=""`.
2. The new fail-closed check does its job: the server refuses to start, exit 78.
3. The operator reads the message, which offers exactly one remedy to get back
   online — "set `ALLOW_LEGACY_STATIC_AUTH=true` to choose the legacy
   static-token mode deliberately" — and does so.
4. The server starts. Health checks that assert "it bound a port" pass. Every
   single request, on every credential, gets `401`.

So the remedy the refusal message recommends does not work in the state that
triggered the refusal. Suggested fix (one line, in whichever module owns it):
treat `''` as `undefined` when handing `jwtSecret` to the router — e.g.
`jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined` in `serverMain.ts` —
so the opt-in genuinely selects legacy mode. `NFR-FAILCLOSED-01b` covers the
refusal but nothing covers what happens after the operator takes the advice.

### N2 (Medium, contract) — the provider now rejects requests its own contract declares valid

`contracts/internal-openapi.yaml` declares:

```yaml
optimized_url:
  type: string
  format: uri
```

with no origin constraint anywhere — the CDN host appears only in `example:`
blocks. Since the L2 fix, `router.ts` rejects any `optimized_url` not on
`https://cdn.fantasycoach.example` with `400 VALIDATION_FAILED`. Schemathesis
names it precisely (§2.3): *"API rejected schema-compliant request … Check your
schema constraints - API validation may be stricter than documented"*, plus a
`Schema validation mismatch` warning that the operation "mostly rejected
generated data".

The documented `400` description does not cover it either — it lists only
"a `ready` call missing `optimized_url`, or a `failed` call missing `failure`,
or an unrecognised `status` value". A Lambda engineer building against this
contract has no way to know the origin rule exists until their callbacks start
failing. The security fix is right; the contract needs to say so (a `pattern`
or an explicit narrative constraint, plus a line in the `400` description). This
is also the reason the suite did not catch it: `runSchemathesis` only ever
drives `openapi.yaml` (D13), so the internal contract has still never been
fuzzed by the committed suite.

### N3 (Medium, deployability) — `CDN_ORIGIN` is a hardcoded fictional domain, and it is now a validation gate

```ts
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';
```

`grep -rn "process.env" src/` returns exactly five lines, all in
`serverMain.ts`/`server.ts`, for `SUPABASE_JWT_SECRET`,
`ALLOW_LEGACY_STATIC_AUTH` and `IMAGE_CALLBACK_SECRET`. There is **no** override
for the CDN origin.

Before green v3 this constant only decided what URL the in-process object-store
stand-in *generated*, so a wrong value was cosmetic. After green v3 it also
decides which callbacks are *accepted*. In any real deployment whose CDN is not
literally `cdn.fantasycoach.example` — i.e. every real deployment, since that is
a reserved-TLD placeholder — **every Lambda callback will be refused `400` and
every uploaded image will sit in `processing` for ever**, breaking AC-07's
pipeline completely, with the failure visible only in production. The rejection
is also silent from the writer's point of view: the upload returns `201
processing` and simply never advances.

N2 and N3 are the same underlying gap (an origin rule that lives only in one
source constant) seen from the contract side and the deploy side. Fix both
together: make the origin configurable (env var, validated at startup like
`SUPABASE_JWT_SECRET`) and document it in `internal-openapi.yaml`. Worth
flagging explicitly to John's pipeline gate either way.

### N4 (Medium, functional regression) — the 8-second whole-request timeout refuses ordinary uploads

`04-green-evidence.v3.md` D1 raised this honestly but framed it as "a writer on
a weak connection". Measured, against the real spawned server, uploading real
multipart bodies at throttled rates:

```text
  A1-6MB-at-1MBps  (6s wire time)                       -> 6240ms  HTTP 422 (request completed)
  A2-6MB-at-500KBps (12s wire time — 4 Mbit/s uplink)   -> 9330ms  HTTP 408
  A3-15MB-at-2MBps  (7.5s wire time)                    -> 7721ms  HTTP 422 (request completed)
  A4-15MB-at-1MBps  (15s wire time — 8 Mbit/s uplink)   -> 8233ms  HTTP 408
```

(The `422 UNSUPPORTED_FORMAT` on A1/A3 is expected — the payload is filler
bytes, not a real photo. The point is that the request *completed* rather than
being cut off.)

`requestTimeout` is a **whole-request** deadline, not an idle-read deadline, so
the arithmetic is unforgiving: the contract advertises a 20 MB cap, and 20 MB
inside 8 seconds requires a sustained ≥ 2.5 MB/s (≈ 20 Mbit/s) uplink. A
4 Mbit/s uplink — an ordinary mobile or ADSL connection, and the CMS's users are
writers uploading match photos — cannot upload a 6 MB cover photo at all. The
`408` also carries no error envelope, so the editor SPA cannot branch on it.

Not a security regression, but a Medium functional one, and the trade-off is
currently unmanageable in production: `readTimeoutMs` is deliberately not
forwarded through `startServer()` and not readable from the environment
(D5/§8), so a deployed server always gets 8 000 ms. The right shape is what D1
itself suggested — an idle/progress-based timeout rather than a whole-request
one, which bounds a *stalled* body without punishing a *slow* one.

### N5 (Medium, robustness / contract) — `POST /v1/articles` returns `500` for a NUL byte in `title`

**Found by the committed suite itself**, on run 5, by
`CONTRACT-PROVIDER-createDraft` — which is the point worth noticing as much as
the bug: `runSchemathesis` passes no `--seed`, so every run fuzzes with a fresh
random seed at `--max-examples 5`. This bug had never surfaced in six green-gate
runs plus four of my five; on run 5, seed
`62394899059392194992633714602316636055` found it in 40 cases.

```text
=================================== FAILURES ===================================
______________________________ POST /v1/articles _______________________________
1. Test Case ID: r168Op

- Server error

[500] Internal Server Error:

    `{"error":{"code":"INTERNAL_ERROR","message":"An unexpected error occurred.","details":null,"request_id":"46facab5-537c-4e4b-aff0-031bc4a917eb"}}`

Reproduce with:

    curl -X POST -H 'Authorization: [Filtered]' -H 'Content-Type: application/json' \
      -d '{"league_name": "", "": {"å": []}, "title": " áÚ", "type_name": "󑧖"}' \
      http://127.0.0.1:61273/v1/articles
```

Reproduced by hand against a real spawned server and minimised — it is the NUL
byte in `title`, nothing else in that generated payload:

```text
  title with a NUL byte          -> 500 INTERNAL_ERROR
  title = a single NUL           -> 500 INTERNAL_ERROR
  league_name with a NUL         -> 201
  type_name with a NUL           -> 201
  lone surrogate in title        -> 201
  title, no NUL (control)        -> 201
  empty body (control)           -> 201
  unknown extra key (control)    -> 201
```

Root cause, confirmed directly against Postgres:

```text
insert into articles (writer_id,title,body_html,status) values ($1,'a\0b','<p>x</p>','draft')
  -> SQLSTATE 22021: invalid byte sequence for encoding "UTF8": 0x00
```

Postgres refuses a NUL in a `text` column. `router.ts`'s `createDraft()` wraps
the handler in `.catch(unknownWriter)`, and `unknownWriter` maps **only**
`23503` (foreign-key violation) and rethrows everything else, so `22021` falls
through to `route()`'s blanket catch and becomes a `500`. `CreateDraftBody`'s
zod schema accepts `title: z.string().optional()` with no character-class
restriction, so nothing rejects it earlier.

Impact and bounds, measured:

- Requires a **valid writer credential** — not anonymously reachable.
- **No partial write**: the row count after seven 500s was exactly the seeded
  row plus the successful creates.
- **Not a crash**: after 25 consecutive 500s the server answered a normal create
  `201`.
- **Not introduced by green v3** — `createDraft.ts` and its error mapping were
  untouched by this pass (which changed `router.ts`, `server.ts`,
  `serverMain.ts`, `lambdaHandler.ts`, `package.json` and added migration 0003).
  This is a pre-existing defect that v1 and v2's verify passes did not happen to
  roll.

Why it matters despite being low-blast-radius: `contracts/openapi.yaml`'s whole
error discipline is "every response is either the documented success schema or
the `Error` envelope, and callers branch on `error.code`". `INTERNAL_ERROR` on
ordinary user-supplied text is an undocumented outcome for a validation
problem — the contract's own `400 VALIDATION_FAILED` with a `fields` entry is
what belongs there. Fix: reject control characters in `CreateDraftBody`'s
`title` (and, for symmetry, the other free-text fields), or map `22021`
alongside `23503`.

**Second-order finding (Medium, process):** the provider contract suite is
**non-deterministic** — no `--seed`, and only `--max-examples 5`. A gate that
can pass or fail on the same commit depending on the dice is not a gate. Two
changes are worth making together: pin a seed for reproducibility, and raise
`--max-examples` substantially (my standalone runs at 200 examples/operation
completed all four public operations in a few seconds each, so the cost is
small). Note that pinning a seed *alone* would have hidden this bug; raising the
example count is the part that finds things.

### Carried over, unchanged

The `pool.on('connect', …)` un-awaited `set role service_role` still emits, on
every run:

```text
(node:32418) DeprecationWarning: Calling client.query() when the client is already executing a query
is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control
mechanism instead.
```

Still not reproduced as a functional fault (the 10-way concurrent `/open` race
in §3.1 and the 10-way stall storm in §4.2 both behaved correctly). Same
informational status as v2.

---

## 6. Verdict table

| Item | Verdict | Evidence |
|---|---|---|
| Full suite 185/185, repeatedly | **NOT reproducible** — 3 of 5 runs green. Runs 1–2: `NFR-IMGCPU-01`, a flaky wall-clock assertion. Run 5: a genuine `500` (N5) | §1, N5 |
| `tsc --noEmit` | **PASS** — exit 0 | §1.2 |
| Consumer contract, all operations | **PASS** — self-enforcing coverage assertion | §2.1 |
| Provider contract, public, deep fuzz | **PASS** — 1 330 cases, 0 failures | §2.2 |
| Provider contract, internal, adversarial fuzz | **hang CLOSED**; new divergence found | §2.3, N2 |
| M1 draft-lock theft | **PASS** — 7 attack shapes all `42501`, CAS atomic under a 10-way race | §3.1 |
| M2 pre-auth body buffering | **PASS** — 401 after 64 KiB of 8 MiB | §3.2 |
| M3 fail-closed | **PARTIAL** — (a)(b)(d) pass; empty-secret + opt-in is a total outage | §3.3, N1 |
| L1 `sharp` CVEs | **PASS** — 0.35.3, 0 production vulnerabilities | §3.4 |
| L2 CDN origin scoping | **PASS** — 9 cases incl. 5 beyond the suite | §3.5 |
| **Gap 1: `imageCallbackSecret` through `spawn`** | **CLOSED, proven** — decoy rejected, configured value accepted | §4.1 |
| **Gap 2: read timeout behind a valid secret** | **CLOSED, proven** — real `408` at 9 793 ms on the real child | §4.2 |
| High-severity issues | **None found** | — |

### New findings, consolidated

| # | Severity | Area | Finding |
|---|---|---|---|
| N1 | Medium | Availability | `SUPABASE_JWT_SECRET=""` + `ALLOW_LEGACY_STATIC_AUTH=true` boots a server that `401`s every request — the remedy the refusal message recommends does not work in the state that triggered it |
| N2 | Medium | Contract | `internal-openapi.yaml` declares `optimized_url` as any `uri`; the provider now requires the CDN origin. Schemathesis: "API rejected schema-compliant request" |
| N3 | Medium | Deployability | `CDN_ORIGIN` hardcoded to a reserved-TLD placeholder with no env override — every real deployment would refuse all its own callbacks and strand images in `processing` |
| N4 | Medium | Functional regression | 8 s *whole-request* timeout refuses ordinary uploads (6 MB at 500 KB/s → `408`); the contract advertises a 20 MB cap that needs ≥ 20 Mbit/s to ever be met |
| N5 | Medium | Robustness / contract | `POST /v1/articles` returns `500` for a NUL byte in `title` (SQLSTATE 22021 unmapped). Pre-existing, not from green v3 |
| N5b | Medium | Process | The provider contract suite is non-deterministic (no `--seed`, `--max-examples 5`) — same commit passes or fails on the dice |
| N6 | Low | Test quality | `NFR-IMGCPU-01` is a wall-clock assertion in a parallel runner; fails under load, 457–495 ms in isolation against a 1 000 ms budget |

## 7. Cleanup

All scratch scripts lived outside the repo, in `/tmp/arsene-v3/`
(`verify-v3.ts`, `verify-v3-m3.ts`, `verify-v3-emptysecret.ts`,
`verify-v3-extra.ts`, `fuzz-server.ts`), with a symlink to the worktree's
`node_modules` so imports resolved. `git status` was clean before and after this
pass: no production file, no test file, no migration and no `package.json` was
modified. The only file this pass adds to the repository is this document.
