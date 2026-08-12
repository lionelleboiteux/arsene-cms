# arsene-cms — Red gate, third remediation pass (v3)

> Gate 3 (red), run a third time. `03-red-evidence.v1.md` covered the original
> red gate for the whole build, `03-red-evidence.v2.md` the remediation for
> `05-verification.v1.md`. This document covers **only** the third remediation
> pass, for `05-verification.v2.md`'s four Medium findings, its two Low
> findings and the unnamed `readBody()` timeout finding in §6 /
> `verify/integration-e2e-v2.md` §5. Tests only — no production code was
> written, changed or deleted by this pass.

**Status:** red | **Author:** Claude (Opus 5) | **Date:** 2026-08-12
**Branch:** `feat/arsene-cms` | **Baseline:** the green suite as it stands on
this branch — **176 tests, 176 passing, 27 files** (re-run in full before a
line of this pass was written; see §3).

---

## 0. What this pass had to cover, and what it produced

| Verify v2 finding | Severity | Tests added | New ids |
|---|---|---|---|
| M1 — AC-05's draft lock is stealable via direct PostgREST, bypassing the CAS | Medium | 2 | `NFR-LOCK-GRANT-01a`, `NFR-LOCK-GRANT-01b` |
| M2 — the image-status callback buffers its body before checking its own secret | Medium | 1 | `NFR-DOS-04` |
| M3 — no fail-closed behaviour if `SUPABASE_JWT_SECRET` is unset at runtime | Medium | 2 | `NFR-FAILCLOSED-01a`, `NFR-FAILCLOSED-01b` |
| §5 — `readBody()` has no timeout; a stalled body hangs the request | Medium | 2 | `NFR-DOS-03`, `NFR-DOS-03b` |
| L1 — outdated `sharp@0.34.4` (known libvips CVEs, fix at 0.35.3+) | Low | **0, by design** | — (see §5) |
| L2 — the callback's `optimized_url` is not scoped to the trusted CDN origin | Low | 2 | `NFR-CALLBACK-04a`, `NFR-CALLBACK-04b` |

2 + 1 + 2 + 2 + 0 + 2 = **9**.

**9 new tests. 9 fail, every one on an honest assertion.** No new test passes
at red. **All 176 tests the green gate certified still pass**, and no existing
test's assertions were edited (two setup-only edits are declared in §4).

Test count: 176 → **185**. Test files: 27 → **28**.

---

## 1. The command, and its output

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

Tail of the run, verbatim:

```
 Test Files  3 failed | 25 passed (28)
      Tests  9 failed | 176 passed (185)
   Start at  17:21:18
   Duration  20.01s (transform 733ms, setup 0ms, collect 5.86s, tests 77.21s, environment 3ms, prepare 1.53s)
```

185 = the 176 green-gate tests + 9 new. 176 passing = exactly the baseline, so
nothing regressed. 3 failing files = the one new file plus the two extended
ones; every failure in them is a new test.

`npx tsc --noEmit` also runs clean (exit 0) with the new tests in place: the
expectations they place on not-yet-existing production shapes
(`RouterOptions.readTimeoutMs`, `ApiRouterModule.DEFAULT_READ_TIMEOUT_MS`,
`startServer`'s `allowLegacyAuth`) are declared in `tests/support/seams.ts`,
which is where this suite has always kept its side of every seam.

---

## 2. Every new test, with its result and its one reason for failing

Verbatim from the verbose reporter (the `✓` lines around them are shown where
they matter — NFR-DOS-01/02 and NFR-TAMPER-01 are the existing tests each new
family sits next to, and they still pass):

```
 ✓ tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-01: an unauthenticated chunked request is refused 401 on its headers, with only a fraction of its body ever pushed — an anonymous caller cannot make the server buffer megabytes
 ✓ tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-02: an upload declaring more than 20 MB is refused 413 from its Content-Length alone, before the body is buffered and before any codec could run
 × tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-DOS-04: an image-status callback carrying no callback secret is refused 401 on its headers, with only a fraction of its body ever pushed — the route that needs no writer token must still cost an anonymous caller nothing
   → expected { status: 400, …(2) } to deeply equal { status: 401, …(2) }
 × tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-CALLBACK-04a: a status callback claiming ready with an optimized_url on an arbitrary external host is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN
   → expected { status: 500, code: 'INTERNAL_ERROR' } to deeply equal { status: 400, …(1) }
 × tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-CALLBACK-04b: a status callback claiming ready with an optimized_url on a look-alike host that merely begins with the CDN origin string is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN
   → expected { status: 500, code: 'INTERNAL_ERROR' } to deeply equal { status: 400, …(1) }
 × tests/e2e/failClosedConfig.test.ts > the deployable entry point fails closed on a missing JWT secret (verify v2, M3) > NFR-FAILCLOSED-01a: with SUPABASE_JWT_SECRET missing from the environment entirely and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token 407ms
   → expected { refused_to_start: false, …(1) } to deeply equal { refused_to_start: true, …(1) }
 × tests/e2e/failClosedConfig.test.ts > the deployable entry point fails closed on a missing JWT secret (verify v2, M3) > NFR-FAILCLOSED-01b: with SUPABASE_JWT_SECRET present but empty, as a half-completed rotation leaves it and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token 328ms
   → expected { refused_to_start: false, …(1) } to deeply equal { refused_to_start: true, …(1) }
 × tests/e2e/transportGuards.test.ts > stalled request bodies (verify v2 §5) > NFR-DOS-03: a request whose declared body stalls partway through and never completes is answered, and the socket released, within the configured read timeout — an open connection cannot be held indefinitely for free 7052ms
   → expected 7031 to be less than or equal to 5000
 × tests/e2e/transportGuards.test.ts > stalled request bodies (verify v2 §5) > NFR-DOS-03b: the read timeout the router ships with, for a deployment that configures none, is bounded to single-digit seconds rather than Node’s 300-second default
   → expected { is_a_number: false, …(1) } to deeply equal { is_a_number: true, …(1) }
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-TAMPER-01: a writer cannot set published_at directly — publish-controlled columns are not writable through PostgREST
 × tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01a: a writer cannot take the draft lock through PostgREST — stealing a colleague’s live lock by writing locked_by directly is refused, so the only way to hold a lock is the server seam's compare-and-swap
   → expected null to be '42501' // Object.is equality
 × tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01b: a writer cannot take the draft lock through PostgREST — keeping a colleague’s abandoned lock alive forever by refreshing locked_at directly is refused, so the only way to hold a lock is the server seam's compare-and-swap
   → expected null to be '42501' // Object.is equality
```

Full failure detail, verbatim:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 9 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01a: a writer cannot take the draft lock through PostgREST — stealing a colleague’s live lock by writing locked_by directly is refused, so the only way to hold a lock is the server seam's compare-and-swap
 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01b: a writer cannot take the draft lock through PostgREST — keeping a colleague’s abandoned lock alive forever by refreshing locked_at directly is refused, so the only way to hold a lock is the server seam's compare-and-swap
AssertionError: expected null to be '42501' // Object.is equality

- Expected: 
"42501"

+ Received: 
null

 ❯ tests/db/schema.test.ts:452:22
    450|     );
    451| 
    452|     expect(sqlstate).toBe('42501'); // insufficient_privilege
       |                      ^
    453|   });
    454| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/9]⎯

 FAIL  tests/e2e/failClosedConfig.test.ts > the deployable entry point fails closed on a missing JWT secret (verify v2, M3) > NFR-FAILCLOSED-01a: with SUPABASE_JWT_SECRET missing from the environment entirely and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token
 FAIL  tests/e2e/failClosedConfig.test.ts > the deployable entry point fails closed on a missing JWT secret (verify v2, M3) > NFR-FAILCLOSED-01b: with SUPABASE_JWT_SECRET present but empty, as a half-completed rotation leaves it and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token
AssertionError: expected { refused_to_start: false, …(1) } to deeply equal { refused_to_start: true, …(1) }

- Expected
+ Received

  Object {
-   "reason_names_the_missing_secret": true,
-   "refused_to_start": true,
+   "reason_names_the_missing_secret": false,
+   "refused_to_start": false,
  }

 ❯ tests/e2e/failClosedConfig.test.ts:125:8
    123|       refused_to_start: !outcome.started,
    124|       reason_names_the_missing_secret: /SUPABASE_JWT_SECRET/.test(outc…
    125|     }).toEqual({ refused_to_start: true, reason_names_the_missing_secr…
       |        ^
    126|   });
    127| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/9]⎯

 FAIL  tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-DOS-04: an image-status callback carrying no callback secret is refused 401 on its headers, with only a fraction of its body ever pushed — the route that needs no writer token must still cost an anonymous caller nothing
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

 ❯ tests/e2e/transportGuards.test.ts:264:8
    262|       body_bytes_pushed_before_the_answer_stayed_bounded:
    263|         result.sent_when_answered <= BOUNDED_MEMORY_BYTES,
    264|     }).toEqual({
       |        ^
    265|       status: 401,
    266|       code: 'UNAUTHORIZED',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/9]⎯

 FAIL  tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-CALLBACK-04a: a status callback claiming ready with an optimized_url on an arbitrary external host is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN
 FAIL  tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-CALLBACK-04b: a status callback claiming ready with an optimized_url on a look-alike host that merely begins with the CDN origin string is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN
AssertionError: expected { status: 500, code: 'INTERNAL_ERROR' } to deeply equal { status: 400, …(1) }

- Expected
+ Received

  Object {
-   "code": "VALIDATION_FAILED",
-   "status": 400,
+   "code": "INTERNAL_ERROR",
+   "status": 500,
  }

 ❯ tests/e2e/transportGuards.test.ts:332:60
    330|     const body = (await res.json()) as { error?: { code?: string } };
    331| 
    332|     expect({ status: res.status, code: body.error?.code }).toEqual({
       |                                                            ^
    333|       status: 400,
    334|       code: 'VALIDATION_FAILED',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/9]⎯

 FAIL  tests/e2e/transportGuards.test.ts > stalled request bodies (verify v2 §5) > NFR-DOS-03: a request whose declared body stalls partway through and never completes is answered, and the socket released, within the configured read timeout — an open connection cannot be held indefinitely for free
AssertionError: expected 7031 to be less than or equal to 5000
 ❯ tests/e2e/transportGuards.test.ts:448:39
    446|       });
    447| 
    448|       expect(result.settled_after_ms).toBeLessThanOrEqual(ANSWER_DEADL…
       |                                       ^
    449|     } finally {
    450|       await server.stop().catch(() => undefined);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/9]⎯

 FAIL  tests/e2e/transportGuards.test.ts > stalled request bodies (verify v2 §5) > NFR-DOS-03b: the read timeout the router ships with, for a deployment that configures none, is bounded to single-digit seconds rather than Node’s 300-second default
AssertionError: expected { is_a_number: false, …(1) } to deeply equal { is_a_number: true, …(1) }

- Expected
+ Received

  Object {
-   "bounded_to_ten_seconds": true,
-   "is_a_number": true,
+   "bounded_to_ten_seconds": false,
+   "is_a_number": false,
  }

 ❯ tests/e2e/transportGuards.test.ts:461:8
    459|       is_a_number: typeof shipped === 'number',
    460|       bounded_to_ten_seconds: typeof shipped === 'number' && shipped >…
    461|     }).toEqual({ is_a_number: true, bounded_to_ten_seconds: true });
       |        ^
    462|   });
    463| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/9]⎯

 Test Files  3 failed | 25 passed (28)
      Tests  9 failed | 176 passed (185)
```

### Reading each failure — one cause each

| Id | Failure | What it proves is missing |
|---|---|---|
| `NFR-LOCK-GRANT-01a` | `expected null to be '42501'` | As `authenticated`, `update articles set locked_by = …, locked_at = now()` **succeeds**. `null` is `captureSqlError`'s "no error at all": the lock was stolen from a writer whose heartbeat was one second old, without touching `repo.takeLock()`. |
| `NFR-LOCK-GRANT-01b` | `expected null to be '42501'` | Same grant, the other attack: `update articles set locked_at = now()` succeeds, so a writer can refresh a colleague's heartbeat forever and the 90-second staleness window AC-05 relies on never opens. Two rows because one grant edit could close only one of them. |
| `NFR-DOS-04` | `expected { status: 400, …} to deeply equal { status: 401, …}` | The 8 MB chunked body was drained in full before anything was decided (`body_bytes_pushed_before_the_answer_stayed_bounded: false`), and the answer was then `400 VALIDATION_FAILED` — i.e. a **JSON parse verdict on an anonymous caller's 8 MB**. The callback secret is never consulted at the point where it would have cost nothing. |
| `NFR-CALLBACK-04a` | `expected { status: 500, code: 'INTERNAL_ERROR' } …` | A callback claiming `ready` with `optimized_url` on `images.attacker.test` passed validation and went on to hit the database — which is unreachable in this test by design, hence the `500`. The `500` *is* the finding: the URL was not rejected from the body alone. |
| `NFR-CALLBACK-04b` | `expected { status: 500, code: 'INTERNAL_ERROR' } …` | Same, for `cdn.fantasycoach.example.attacker.test` — the host that a `startsWith(CDN_ORIGIN)` fix would still accept. Its own row so that a prefix-based implementation cannot pass this family. |
| `NFR-FAILCLOSED-01a` | `refused_to_start: false` | With no `SUPABASE_JWT_SECRET` anywhere in the environment and no opt-in, the real spawned server **started happily** — silently back on the single static token, every article attributed to one constant, exactly H3. |
| `NFR-FAILCLOSED-01b` | `refused_to_start: false` | Same for `SUPABASE_JWT_SECRET=""`. A separate row because it is a separate code path (`!== undefined` accepts it) and the more dangerous one: an empty HS256 key is a key anyone can sign with. |
| `NFR-DOS-03` | `expected 7031 to be less than or equal to 5000` | A request declaring 1 MB, sending 1 KB, then stopping: **no response and no socket teardown for the full 7-second guard**. The number is the test's own guard expiring, i.e. the request was still hanging when the test gave up — the reproduction from `verify/integration-e2e-v2.md` §5, on the route M2 leaves credential-free. |
| `NFR-DOS-03b` | `expected { is_a_number: false, …}` | `router.ts` exports no `DEFAULT_READ_TIMEOUT_MS` at all: there is no shipped bound, only Node's 300 s. Separate from `NFR-DOS-03` so that "honour the test's override, leave production at 300 s" is not a way through the gate. |

Nothing here is an import error, a missing fixture or a typo. Every failure is
an assertion comparing a real observed value to the required one, against real
Postgres 16 (Testcontainers), real HTTP sockets and the real spawned child
process — the same seams the existing suite uses.

---

## 3. The 176 baseline, re-confirmed

Run in full **before** any test in this pass was written, on the working tree
as it stood:

```
 Test Files  27 passed (27)
      Tests  176 passed (176)
   Start at  17:16:41
   Duration  26.57s (transform 787ms, setup 0ms, collect 6.27s, tests 104.45s, environment 8ms, prepare 1.96s)
```

And after this pass, the same 176 still pass (§1: `9 failed | 176 passed
(185)`). The passing count is identical, not merely similar — including the
7 tests in the two files this pass edited for setup (§4).

---

## 4. What this pass touched, and why it is not an assertion change

| File | Change |
|---|---|
| `tests/db/schema.test.ts` | **Added** the `NFR-LOCK-GRANT-01` family, next to `NFR-TAMPER-01` so it reuses that file's container and sits beside the grant statement it extends. No existing test altered. |
| `tests/e2e/transportGuards.test.ts` | **Added** `NFR-DOS-04`, `NFR-CALLBACK-04a/b`, `NFR-DOS-03`, `NFR-DOS-03b`, plus the `stallPost` helper. `NFR-DOS-01`/`02` and the `streamPost` helper they use are untouched. One import line gained `COVER_IMAGE_ID`. |
| `tests/e2e/failClosedConfig.test.ts` | **New file.** |
| `tests/support/seams.ts` | Declared the test suite's side of three not-yet-existing shapes: `RouterOptions.readTimeoutMs`, `ApiRouterModule.DEFAULT_READ_TIMEOUT_MS`, `startServer`'s `allowLegacyAuth`. This is what `seams.ts` is for. |
| `tests/e2e/publishJourney.test.ts` | **Setup only**: `allowLegacyAuth: true` added to its `startServer(…)` call. No assertion touched. |
| `tests/contract/provider.schemathesis.test.ts` | **Setup only**: the same flag, for the same reason. No assertion touched. |

The last two need justifying, because they are edits to green tests.

Both files are the "pre-JWT end-to-end suite" `router.ts`'s `verify()` comment
names as a legitimate reason to run with no JWT secret, and both boot the
**real spawned server**, which is the process M3's fix guards. Under the
mechanism chosen for M3 (§ below), a green implementation that did not know
these two call sites are deliberate would break them. Marking the intent now,
in the call site, is the honest fix: at red the extra option is inert (the
current `startServer` ignores unknown fields, and both files still pass —
verified in §1's run), and at green it is what keeps the legitimate mode
working. The alternative — leaving green to discover it by breakage and edit
them itself — is the same edit, made later and with less context.

### The mechanism chosen for M3

Documented in full at the top of `tests/e2e/failClosedConfig.test.ts` and as
assumption 15 in `traceability.md` §6, summarised here:

- `serverMain.ts` — the deployable entry point M3 names — **refuses to start**
  when `SUPABASE_JWT_SECRET` is absent *or empty*, unless
  `ALLOW_LEGACY_STATIC_AUTH=true` is present in its environment. It exits
  non-zero and names the missing variable.
- `server.ts`'s `startServer()` forwards a new
  `ServerOptions.allowLegacyAuth === true` to the child as that variable, via
  `env` rather than argv, exactly as it already forwards `jwtSecret` and
  `imageCallbackSecret`.
- The check is deliberately **not** placed in `startHttpServer()`. That is a
  library entry point whose configuration arrives as arguments, where omitting
  a secret is already an explicit act by the caller; the silent-downgrade risk
  M3 describes is environment variables going missing, and only the deployable
  entry point reads those.

The distinction being enforced is not "with or without a JWT secret" — that
would break a mode the codebase documents as legitimate. It is **chosen versus
arrived at**. Change the mechanism freely; keep that distinction, and change
the test with it.

---

## 5. L1 (`sharp@0.34.4`) — no new test, deliberately

L1 is a dependency version bump with no new behaviour to assert. A test that
read `package.json` and compared a version string would pass the moment the
number changed, whether or not the codec still worked — it would prove the
bump happened, which `package.json` already proves, and nothing about whether
it was safe.

The regression net that matters already exists and is strong:
`tests/unit/lambdaImage.test.ts` drives the **real** `sharp` build over real
photographic fixtures across JPEG, PNG, WebP, AVIF and HEIC
(`AC-07/D7-*`, `AC-08-*`, `NFR-IMGCPU-01`), and
`tests/unit/imageOptimize.test.ts` and `tests/unit/uploadImage*.test.ts` cover
the size guard, the corrupted-file and unsupported-format paths.

**What green must do:** bump `sharp` to `0.35.3` or later, re-run the full
suite, and confirm those files still pass — with one caveat carried over from
`traceability.md` §6 note 14: the HEIC case depends on the `sharp` build's
HEVC decoder. If it fails after the bump, check the build before treating it
as a product regression.

---

## 6. Coverage of the v2 findings, and what is left uncovered

| Finding | Covered by | Left uncovered |
|---|---|---|
| M1 | `NFR-LOCK-GRANT-01a/b` (real Postgres, `set role authenticated`) | Nothing. The corresponding positive — the seam's CAS still works as `service_role` — is already `AC-05-free/held/stale` in `tests/db/remediation.test.ts` and must stay green through the grant change; that is the both-sides pair. |
| M2 | `NFR-DOS-04` (real socket, bytes-pushed-before-answered) | The positive side (a correct secret is accepted) is `NFR-CALLBACK-01a/b` + `NFR-CALLBACK-02a/b` at the handler layer and `CONTRACT-PROVIDER-*` over HTTP; not repeated here. |
| M3 | `NFR-FAILCLOSED-01a/b` (real spawned child) | The positive side — the explicit legacy opt-in still boots and still serves — is not a *new* test: it is `tests/e2e/publishJourney.test.ts` and `tests/contract/provider.schemathesis.test.ts`, both of which now carry `allowLegacyAuth: true` and both of which must stay green. A dedicated test would have passed at red (it asserts today's behaviour) and would have added nothing the existing 7 tests do not already prove. |
| §5 timeout | `NFR-DOS-03` (mechanism, ~2 s via a test override) + `NFR-DOS-03b` (the shipped default) | The exact response for a timed-out request is not asserted: `src/api/http.ts`'s `ErrorCode` set is closed and has no timeout member, so requiring one would be an unagreed contract change. Any of "an explicit response", "Node's `408`" or "the socket torn down" satisfies `NFR-DOS-03`; the finding is unbounded waiting, not a status code. |
| L1 | — | See §5: no new test by design; the existing image suite is the regression net. |
| L2 | `NFR-CALLBACK-04a/b` (foreign host; prefix-confusion host) | The positive side (a genuine `cdn.fantasycoach.example` URL is accepted and stored) is `NFR-CALLBACK-02a` and `NFR-CALLBACK-03`, both already green and both using a CDN-origin URL, so they keep working only if the check is implemented as an origin comparison rather than something stricter. |

Also not covered, and consciously so: the two **informational** notes in
`05-verification.v2.md` §7 — the double JWT verification per request (measured
harmless, ~0.04-0.15 ms, and a test would pin an implementation detail rather
than a commitment) and the un-awaited `SET ROLE` query on pool connect
(reported as unconfirmed; a 12-way concurrency stress did not reproduce a
failure, so there is no behaviour to assert yet — if it is real, it will
surface as a flake in the existing DB suite, which is the right detector).

---

## 7. Gate statement

9 new tests, 9 failing, each on exactly one honest assertion against real
infrastructure. 176 previously-passing tests still passing. No production code
written. Red.
