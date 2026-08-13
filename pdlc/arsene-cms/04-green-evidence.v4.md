# arsene-cms — Green gate, fourth remediation pass (v4)

> Gate 4 (green), run a fourth time. This document covers **only** the fourth
> remediation pass: turning the 12 failing tests `03-red-evidence.v4.md`
> landed into passing ones, for `05-verification.v3.md`'s two blocking
> findings — H-V3-01 (High: no writer-authorization check at all) and the HEIC
> decode gap (§3) — plus the hardening item grouped with H-V3-01's fix,
> L-V3-02 (`verifySupabaseJwt` requires neither `exp` nor `iss`/`aud`/`role`).
>
> Explicitly out of scope, unchanged from the red pass: the five further
> Medium/Low/Info findings in `05-verification.v3.md` §6 (M-V3-02 through
> M-V3-05, N1-N6). A separate pass.

**Status:** green | **Author:** Claude (Opus 5), `bob-implementer` |
**Date:** 2026-08-13 | **Branch:** `feat/arsene-cms`, worktree
`arsene-cms+green-v3` | **Baseline in:** 200 tests, **12 failing / 188
passing**, exactly as `03-red-evidence.v4.md` §1 recorded. **Baseline out:**
**200 / 200 passing, 31 files.** No test file was edited — not an assertion,
not a title, not a fixture.

---

## 1. The command, and its output

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test

 Test Files  31 passed (31)
      Tests  200 passed (200)
   Start at  12:35:45
   Duration  20.52s (transform 639ms, setup 0ms, collect 6.78s, tests 79.54s, environment 3ms, prepare 1.80s)
```

```
$ npx tsc --noEmit
$ echo $?
0
```

Two independent full runs were made after the final edit (12:33:40 and
12:35:45); both 200/200. **`NFR-IMGCPU-01` — the known wall-clock flake
documented in `03-red-evidence.v4.md` §3 and `verify/integration-e2e-v3.md`
— did not fire in either run**, so no isolated re-run was needed. It is
still a flake; this pass neither fixed nor touched it.

The 15 target tests, run as a group first, before the full suite:

```
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run tests/unit/authClaims.test.ts \
    tests/unit/auth.test.ts tests/e2e/writerAuthorization.test.ts \
    tests/e2e/heicDeployedRuntime.test.ts

 Test Files  4 passed (4)
      Tests  22 passed (22)
```

`tests/unit/auth.test.ts` is in that list deliberately: its six pre-existing
`NFR-JWT-01`-`06` cases plus `NFR-TIMING-01` are the regression control on
the L-V3-02 change, and they pass unchanged, calling the seam with the same
two required options they always did.

---

## 2. Every finding, what closed it, and the tests that prove it

| Finding | Change | Tests that prove it |
|---|---|---|
| **H-V3-01** — no writer-authorization check on any of the four writer-facing operations | `src/api/router.ts`'s `verify()` now resolves the JWT's `sub` against a real row in `writers` (`repo.isWriter`) and returns `{ valid: false }` when there is none. `verify()` is the seam `route()` already called from the request headers, **before `readBody()` and before `dispatch()`**, so the refusal precedes every mutation on all four routes at once | `NFR-AUTHZ-01a` (create-draft), `01b` (open), `01c` (publish), `01d` (upload) — all four `401 UNAUTHORIZED`; `NFR-AUTHZ-04` (the embargoed draft is still `draft`, `slug` null, 0 rows readable by `anon`); `NFR-AUTHZ-05` (the live article still has exactly its one original cover) |
| **H-V3-01**, the "the FK accident already covers it" half | `repo.isWriter` answers `false` for a `sub` that is not UUID-shaped rather than handing it to Postgres, so the decision is always a query-and-decide about `writers`, never a reaction to a SQLSTATE | `NFR-AUTHZ-03` — `sub: 'not-a-writer-id'` gets `401`, not the `500` the rethrown `22P02` used to produce |
| **H-V3-01**, the both-sides half | The lookup admits a seeded writer unchanged | `NFR-AUTHZ-02` (all four operations, a registered writer's own token, `201/200/200/201`); plus the whole pre-existing e2e/contract suite, which is nothing but registered writers succeeding |
| **L-V3-02** — `exp` not required | `src/api/auth.ts` passes `requiredClaims: ['exp']` to `jwtVerify` | `NFR-JWT-07`; `NFR-JWT-03` (already-expired token) still refuses, `NFR-JWT-01` still accepts |
| **L-V3-02** — `iss` never checked | `verifySupabaseJwt`'s options gained an optional `issuer`; when given it is forwarded to `jwtVerify` as `issuer` | `NFR-JWT-08`; `NFR-JWT-11` accepts with the right issuer, and `NFR-JWT-01`-`06` still pass calling the seam **without** `issuer` |
| **L-V3-02** — `aud`/`role` never checked | `audience: 'authenticated'` on `jwtVerify`, and an explicit `payload.role !== 'authenticated'` check. Both fixed literals, not configuration | `NFR-JWT-09` (`aud: 'apikey'`), `NFR-JWT-10` (`role: 'anon'` — the public anon key's own claim shape) |
| **HEIC dead in the deployed runtime** (`05-verification.v3.md` §3) | `src/images/heic.ts` imports `'libheif-js/wasm-bundle.js'`. `src/images/libheif-js.d.ts`'s `declare module` had to move to the same specifier or `tsc` fails `TS7016` | `VERIFY-HEIC-01` (a real plain-`node` subprocess importing the specifier read out of the source at test time); `VERIFY-HEIC-02`/`AC-07` (real spawned server, real HEVC HEIC, row reaches `ready`); `AC-07/D7-heic` in `lambdaImage.test.ts` still passes |

### 2.1 The HEIC specifier, confirmed by hand rather than trusted

The verify report described the fix as "one character class". It was
confirmed under plain Node before it was written, and again after:

```
$ node --input-type=module -e "await import('libheif-js/wasm-bundle');"
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../node_modules/libheif-js/wasm-bundle'
  code: 'ERR_MODULE_NOT_FOUND',

$ node --input-type=module -e "await import('libheif-js/wasm-bundle.js'); console.log('resolved');"
resolved

$ node -p "require('libheif-js/package.json').version"
1.19.8
```

`VERIFY-HEIC-01` reads the specifier out of `src/images/heic.ts` with a regex
at test time, so it is asserting against what ships and not against a string
copied into the test. Worth noting for whoever touches `heic.ts` next: the
first `import(...)` in that file is now the one that test grades.

---

## 3. Where the guard was put, and why there

`route()` in `src/api/router.ts` already had the shape H-V3-01's fix needed:

```
path -> 404?  ->  method -> 405?  ->  content-length -> 413?
  ->  credentials -> 401?          <-- verify(), from headers alone
  ->  readBody()
  ->  dispatch()
```

The credentials step was `verify()`. Extending `verify()` — rather than adding
a per-handler check — is what makes `NFR-AUTHZ-01a`-`01d` all pass from one
change instead of four, and is what makes `NFR-AUTHZ-04`/`05` pass at all:
the refusal happens before a body is even read, so `markPublished` and
`insertImage` are not merely undone, they are never called.

`verify()` needed the repository to do the lookup, so its second parameter
moved from `ServerOptions` to the already-existing `Ctx` (`{ opts, repo,
shared }`). That let `publishDeps`/`uploadDeps`/`draftDeps` drop from three
positional parameters to one, which is why `router.ts`'s diff is larger than
the fix itself — it is mostly `publishDeps(ctx.opts, ctx.repo, ctx.shared)`
becoming `publishDeps(ctx)`. No behaviour rides on that.

The handlers still call `deps.auth.verifyBearer` themselves and now get the
same authorization decision through the same function, so the two layers
cannot disagree. The cost is one extra `select 1 from writers where id = $1`
per verified request (two per request, since `route()` and the handler each
verify — as they already both did for the signature). It is a primary-key
lookup on a pooled connection; the perf suite is unchanged and passing.

### 3.1 The legacy static-token branch was deliberately left alone

`verify()`'s other branch — no `jwtSecret` configured, credential is the
static `writerToken`, `writer_id` is the configured `writerId` — does **not**
do the `writers` lookup. That is a decision, not an oversight:

- The finding is about a `sub` the *caller* supplies. `writerId` is
  deployment configuration; a stranger cannot influence it, so resolving it
  against `writers` adds no authorization.
- `tests/contract/provider.schemathesis.test.ts` runs in exactly this mode,
  with `WRITER_ID = 'b2b2b2b2-…'` and a database where that writer is **not**
  seeded. Applying the lookup uniformly would change all four fuzzed
  operations' answers in a mode this pass was not asked to change.

### 3.2 `unknownWriter()` is not dead code — I proved that the hard way

The task brief and the verify report both suggested `unknownWriter()` (the
`23503` → `401` catch in `createDraft`) would become unnecessary once a real
lookup existed. I removed it on that reasoning, and the full suite caught it:

```
CONTRACT-PROVIDER-createDraft
  [500] Internal Server Error on POST /v1/articles
  {"error":{"code":"INTERNAL_ERROR",...}}
 Test Files  1 failed | 30 passed (31)
      Tests  1 failed | 199 passed (200)
```

In legacy static-token mode there is no lookup (§3.1), so `insertDraft`'s
foreign key is still the only thing that answers a `writerId` with no row —
and Schemathesis was relying on the `401` it produced. `unknownWriter()` was
restored, with its comment rewritten to say what it is now: the legacy mode's
answer and a genuine FK edge case, **not** the authorization mechanism.
Restoring it took the suite back to 200/200.

This is recorded rather than quietly fixed because it corrects a claim in the
inputs to this pass. The FK accident is still load-bearing for one configured
mode; H-V3-01 is closed on the JWT path, which is the path an attacker has.

---

## 4. `jwtIssuer`: new configuration, and the argument for it

`verifySupabaseJwt`'s `issuer` option is required by `NFR-JWT-08`/`11`, but
nothing in the suite makes `router.ts` *pass* one. Left there, `iss` pinning
would be a parameter that no deployment can reach — a control that exists in
the unit test and not in the product. That is the exact shape of H3 from
verify v2, where `ServerOptions.jwtSecret` was advertised and silently
dropped by `server.ts`'s spawn call and survived a whole verify pass.

So the same three-line pattern already established for
`jwtSecret`/`imageCallbackSecret` was followed:

- `ServerOptions.jwtIssuer?: string` (`router.ts`), forwarded to
  `verifySupabaseJwt` only when set;
- `server.ts`'s spawn `env` gains
  `...(opts.jwtIssuer !== undefined ? { SUPABASE_JWT_ISSUER: … } : {})`;
- `serverMain.ts` reads `process.env.SUPABASE_JWT_ISSUER`.

**This is configuration no test asked for, and I am flagging it as such.** It
is optional, defaults to today's behaviour (`iss` unchecked), and no existing
test configures it, so nothing regressed — `writerAuthorization.test.ts` and
`heicDeployedRuntime.test.ts` both start servers without it and pass. Its
enabled branch is **not covered** (§5.2). If a reviewer prefers to drop it and
leave `iss` validation reachable only from the unit seam, that is a coherent
position and the deletion is three lines; I judged an unreachable security
control worse than three untested lines of plumbing, and say so here rather
than burying it in the diff.

---

## 5. Coverage — measured, with the parts that are not measurable named

```
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run --coverage

 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   82.79 |    85.68 |   86.66 |   82.79 |
 api               |   75.68 |    80.55 |   77.92 |   75.68 |
  auth.ts          |     100 |      100 |     100 |     100 |
  client.ts        |   97.64 |    73.68 |     100 |   97.64 | 91,97
  createDraft.ts   |    84.9 |     37.5 |     100 |    84.9 | 50-51,79-80,84-87
  http.ts          |     100 |      100 |     100 |     100 |
  imageStatus.ts   |     100 |    93.33 |     100 |     100 | 82
  ...ishArticle.ts |     100 |    97.87 |     100 |     100 | 223
  rateLimit.ts     |   57.14 |      100 |      50 |   57.14 | 24-29
  repo.ts          |   60.15 |    60.86 |   61.53 |   60.15 | ...08-214,217-239
  router.ts        |   57.72 |    68.49 |   67.74 |   57.72 | ...54-556,558-561
  server.ts        |      98 |    88.23 |     100 |      98 | 54
  serverMain.ts    |       0 |        0 |       0 |       0 | 1-59
  uploadImage.ts   |   92.92 |    90.47 |     100 |   92.92 | 79-82,86-89
 client            |     100 |    84.61 |     100 |     100 |
  fixturePicker.ts |     100 |    84.61 |     100 |     100 | 39-41
 domain            |   95.87 |    90.66 |   95.65 |   95.87 |
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

Movement against v3 (82.69 / 86.15 / 86.56): **+0.10 statements, −0.47
branch, +0.10 functions.** The branch figure went *down*, and it should be
read as what it is: this pass added five new branches (`isWriter`'s UUID
guard, `verify()`'s `isWriter` outcome, `verify()`'s `jwtIssuer` spread,
`auth.ts`'s `role` check, `server.ts`'s `jwtIssuer` forwarding) of which
three are exercised only in the spawned child process and one (§4) is not
exercised at all. Nothing regressed; the denominator grew faster than the
in-process numerator.

Recomputed from `coverage/coverage-final.json` over `src/**` excluding the
four modules that only ever run out of process — the same four v1-v3 excluded,
so the numbers are comparable:

```text
all src/**                                     stmts 82.80 % (1396/1686)  branch 85.68 % (371/433)  funcs 86.67 % (117/135)
src/** minus router/repo/serverMain/rateLimit  stmts 97.04 % (1080/1113)  branch 91.34 % (306/335)  funcs 98.86 % (87/88)
```

(v3: 82.69 / 86.16 / 86.57 and 97.01 / 91.41 / 98.86.)

### 5.1 What this pass added, and whether it is covered

| New code | Covered? |
|---|---|
| `auth.ts` — `requiredClaims: ['exp']`, `audience`, the `role` check, the optional `issuer` spread (both branches) | **Yes, fully.** `auth.ts` is 100 % statements *and* 100 % branch. `NFR-JWT-01`-`06` take the no-`issuer` branch, `NFR-JWT-07`-`11` take the with-`issuer` one, and every refusal reason has its own case |
| `repo.isWriter` — the query and the `rowCount === 1` decision | **Yes in-process** (lines 157-160 all executed, via `draftJourney`'s in-process server) |
| `repo.isWriter` — the non-UUID early return | **Not in-process** (branch at line 158). It is executed for real in the child process by `NFR-AUTHZ-03`, which is the only test that can reach it, because it needs a signed token and a spawned server |
| `router.verify()` — the `isWriter`-true path | **Yes in-process** (`draftJourney`, `transportGuards`) |
| `router.verify()` — the `isWriter`-false path (line 223, the actual refusal) | **Not in-process.** Executed for real in the child process by `NFR-AUTHZ-01a`-`01d`, `03`, `04`, `05` — seven tests, four routes, plus two database-state assertions |
| `router.verify()` — the `jwtIssuer` spread, disabled branch | Yes (every server the suite starts) |
| `router.verify()` — the `jwtIssuer` spread, enabled branch | **No.** §4 |
| `server.ts` line 56 — `SUPABASE_JWT_ISSUER` forwarding, enabled branch | **No.** §4, §5.2 |
| `serverMain.ts` — reading `SUPABASE_JWT_ISSUER` | **Not measurable** (child process), and not exercised either, since nothing sets the variable |
| `heic.ts`'s specifier | Yes, three ways: `VERIFY-HEIC-01` (plain `node`), `VERIFY-HEIC-02` (spawned server), `AC-07/D7-heic` (in-process) |

### 5.2 What is uncovered, and whether it matters

- **The single genuinely new gap this pass created is the `jwtIssuer`
  plumbing**: `server.ts` line 56's enabled branch, and `serverMain.ts`'s read
  of `SUPABASE_JWT_ISSUER`. No test configures an issuer through the spawn
  boundary, so the same class of bug that hid in `jwtSecret` for a whole
  verify cycle could hide here. It is inert by default and cannot break an
  unconfigured deployment, but it is exactly the shape that has burned this
  project before. **This should get a test in the next red pass, or the option
  should be deleted.** Stated plainly so it is not lost.
- **`server.ts` line 54 remains uncovered — `IMAGE_CALLBACK_SECRET`'s enabled
  branch.** Pre-existing, unchanged, and already flagged at v3 §6.2. My
  addition means `server.ts` now has *two* untested forwarding branches
  instead of one; the file's branch figure fell 93.75 → 88.23 for that reason
  and no other.
- **`src/api/serverMain.ts` 0 % (lines 1-59)** — still the most misleading
  number in the table, and one line longer than at v3. Every line of it runs
  for real in a child process in `NFR-FAILCLOSED-01a/b`, `E2E-*`,
  `CONTRACT-PROVIDER-*`, `NFR-AUTHZ-*` and `VERIFY-HEIC-02`; v8 instruments
  the parent only. "Not measurable", not "not exercised".
- **`src/api/router.ts` 57.72 %** (up from 57.10) — same story. The
  authorization refusal itself is in the uncovered set, and is nevertheless
  the most heavily tested behaviour this pass produced: seven tests drive it
  through a real HTTP socket into a real child process against real Postgres,
  two of them asserting the database afterwards rather than the response.
  Genuinely unexercised in-process: `route()`'s 404/405 branches (the contract
  suite drives them over HTTP), and `verify()`'s legacy static branch, which
  the schemathesis provider run exercises out of process.
- **`src/api/repo.ts` 60.15 %** (up from 58.59) — `isWriter` is the increase.
  Same out-of-process caveat for the rest.
- **`heic.ts` 100 % statements / 60 % branch, lines 23 and 30** — unchanged in
  substance from v2/v3 (the line numbers shifted by the three-line comment I
  added). These are the "container holds no image" and "display() failed"
  branches: a HEIF that parses but decodes to nothing. No fixture in the suite
  produces one.
- Unchanged from v3 §6.2, all still true and all still judged acceptable
  there: `createDraft.ts`'s handler-level 401/404 (shadowed by the router's own
  guard, and now doubly so), `format.ts` 50-52, `imageStatus.ts` 82,
  `uploadImage.ts` 79-82/86-89, `seo.ts`, `client.ts`, `fixturePicker.ts`,
  `render.ts`, `rateLimit.ts` 24-29.
- **Fully covered, and it is the code that matters most here**: `auth.ts`
  100 statements / 100 branch / 100 functions. Every claim-validation
  decision L-V3-02 asked for is exercised on both sides.

---

## 6. Files changed

| File | Why |
|---|---|
| `src/api/auth.ts` | L-V3-02. `requiredClaims: ['exp']`, `audience: 'authenticated'`, an optional `issuer` pinned when supplied, and an explicit `role === 'authenticated'` check. The two `'authenticated'` literals share one named constant because they are the same fixed Supabase value |
| `src/api/repo.ts` | H-V3-01. New `isWriter(writer_id)`: UUID guard, then `select 1 from writers where id = $1`. Twelve lines, no new abstraction — it sits beside the eleven other query methods and follows their existing non-UUID convention |
| `src/api/router.ts` | H-V3-01. `verify()` resolves the JWT `sub` through `repo.isWriter` and takes `Ctx` instead of `ServerOptions`; the three `*Deps` builders follow that signature change; `ServerOptions.jwtIssuer` added (§4); `unknownWriter()` kept, comment corrected (§3.2) |
| `src/api/server.ts` | One line: forward `jwtIssuer` to the child as `SUPABASE_JWT_ISSUER`, same pattern as its two siblings (§4) |
| `src/api/serverMain.ts` | One line: read `SUPABASE_JWT_ISSUER` from the environment (§4) |
| `src/images/heic.ts` | The specifier gains `.js`, with a comment naming why (§2.1) |
| `src/images/libheif-js.d.ts` | `declare module 'libheif-js/wasm-bundle'` → `'…wasm-bundle.js'`. **Required, not cosmetic**: without it `tsc --noEmit` fails `TS7016` + `TS7006` on `heic.ts`. Not mentioned in the verify report's "one character class" description of the fix |

No test file was modified. No file under `db/` was modified. `state.json` was
not touched. Nothing was committed.

---

## 7. Deviations, and things left honestly open

1. **`jwtIssuer` is configuration nobody's test asked for.** Added anyway, with
   the reasoning in §4, and its untested branch named in §5.2. Reviewer's call.
2. **The legacy static-token branch does not do the `writers` lookup**, so
   `unknownWriter()`'s FK accident is still the only guard in that mode. §3.1
   and §3.2. Justified — the mode's `writer_id` is configuration, not a claim —
   but it means H-V3-01 is closed on the JWT path specifically, and the
   evidence for the other path is "the attacker cannot reach it", not "there is
   a check".
3. **The brief's expectation that `unknownWriter()` would become unnecessary
   was wrong**, and I found that out by breaking `CONTRACT-PROVIDER-createDraft`
   rather than by reasoning. Recorded in §3.2 rather than silently reverted.
4. **`verify()` now costs two extra primary-key lookups per authenticated
   request** (once in `route()`, once in the handler, mirroring the existing
   double signature verification). Measured nowhere specifically; the perf
   suite is unchanged and green. If someone wants it at one lookup, the seam is
   to pass `route()`'s verification result into `dispatch()` — a real
   refactor, not this pass's business.
5. **`iss` is unchecked by default in production**, because no deployment
   config in this repo sets `SUPABASE_JWT_ISSUER`. `exp`, `aud` and `role` are
   checked unconditionally. That matches what the tests specify and what
   L-V3-02 recommended, but the `iss` half is opt-in and currently opted out.
6. **Out of scope and still open**, unchanged from the red pass: M-V3-02
   through M-V3-05 and N1-N6 in `05-verification.v3.md` §6, including the
   revoked heartbeat grant, the hardcoded CDN origin, publish's non-atomic
   telemetry write, and N4's upload-bandwidth tension.

---

## 8. Gate statement

12 failing tests turned green by 93 inserted / 28 deleted lines across seven
production files, no test edited, no new abstraction, no new module. 200/200
passing across two consecutive full runs against real Postgres 16
(Testcontainers), real spawned child processes, real Prism and real
Schemathesis. `tsc --noEmit` exit 0. Coverage 82.79 % statements / 85.68 %
branch over all `src/**`, 97.04 % / 91.34 % over the modules v8 can actually
see, with the branch drop, the one new untested branch and the one corrected
assumption all named above. Green.
