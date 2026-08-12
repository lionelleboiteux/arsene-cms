# arsene-cms — Green-gate evidence, third remediation pass (v3)

> Gate 4 (green), run a third time. `04-green-evidence.v1.md` covered the
> original build (127/127), `04-green-evidence.v2.md` the remediation of
> `05-verification.v1.md` (174/174). This document covers **only** the
> remediation of `05-verification.v2.md`'s four Medium findings, its two Low
> findings and its §5 timeout finding, against the red gate
> `03-red-evidence.v3.md` left at **185 tests, 9 failing, 176 passing**
> (commit `e23c9c7`).

**Status:** green — **185/185 passing**, `tsc --noEmit` clean.
**Author:** Claude (Opus 5) | **Date:** 2026-08-12
**Worktree:** `.claude/worktrees/arsene-cms+green-v3`, branch
`worktree-arsene-cms+green-v3`, branched from `feat/arsene-cms` at `e23c9c7`.

**No test file was touched — not an assertion, not a fixture, not a setup
line.** `git status` at the end of this pass:

```text
 M package-lock.json
 M package.json
 M src/api/router.ts
 M src/api/server.ts
 M src/api/serverMain.ts
 M src/images/lambdaHandler.ts
?? db/migrations/0003_lock_columns_service_role_only.sql
?? pdlc/arsene-cms/04-green-evidence.v3.md
```

`state.json` is deliberately untouched; it is tracked outside this pass.

---

## 1. Commands run

```text
$ NO_COLOR=1 FORCE_COLOR=0 npm test                     # full suite, for real
$ npx tsc --noEmit                                       # exit 0, no output
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run --coverage
```

Honest count, because the code changed once mid-pass (§7, D2): the suite ran
**3 times plus one coverage run** on the first complete implementation, then
**3 more times plus a second coverage run** on the final code after the
`connectionsCheckingInterval` refinement. Every one of those six runs was
`185 passed (185)`, exit 0. No run was discarded, and no test was retried
individually to get a green.

Every run is against the same real collaborators as v1/v2: Testcontainers
Postgres 16 for `tests/db` and the e2e journeys, a real Prism mock and a real
Schemathesis process for `tests/contract`, the real WASM codec in
`imageOptimize`, real `sharp`/`libheif` over real photographic bytes in
`lambdaImage`, real sockets in `transportGuards`, and a real spawned child
process in `failClosedConfig` / `deployedAuthBoundary`.

---

## 2. Full suite output

The nine tests this pass had to turn green, verbatim from the run
(`/tmp` log of the final code, reporter's own wording):

```text
 ✓ tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-DOS-04: an image-status callback carrying no callback secret is refused 401 on its headers, with only a fraction of its body ever pushed — the route that needs no writer token must still cost an anonymous caller nothing
 ✓ tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-CALLBACK-04a: a status callback claiming ready with an optimized_url on an arbitrary external host is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN
 ✓ tests/e2e/transportGuards.test.ts > the credential-free internal route (verify v2, M2 and §5) > NFR-CALLBACK-04b: a status callback claiming ready with an optimized_url on a look-alike host that merely begins with the CDN origin string is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN
 ✓ tests/e2e/transportGuards.test.ts > stalled request bodies (verify v2 §5) > NFR-DOS-03: a request whose declared body stalls partway through and never completes is answered, and the socket released, within the configured read timeout — an open connection cannot be held indefinitely for free
 ✓ tests/e2e/transportGuards.test.ts > stalled request bodies (verify v2 §5) > NFR-DOS-03b: the read timeout the router ships with, for a deployment that configures none, is bounded to single-digit seconds rather than Node’s 300-second default
 ✓ tests/e2e/failClosedConfig.test.ts > the deployable entry point fails closed on a missing JWT secret (verify v2, M3) > NFR-FAILCLOSED-01a: with SUPABASE_JWT_SECRET missing from the environment entirely and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token 389ms
 ✓ tests/e2e/failClosedConfig.test.ts > the deployable entry point fails closed on a missing JWT secret (verify v2, M3) > NFR-FAILCLOSED-01b: with SUPABASE_JWT_SECRET present but empty, as a half-completed rotation leaves it and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token 353ms
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01a: a writer cannot take the draft lock through PostgREST — stealing a colleague’s live lock by writing locked_by directly is refused, so the only way to hold a lock is the server seam's compare-and-swap
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-LOCK-GRANT-01b: a writer cannot take the draft lock through PostgREST — keeping a colleague’s abandoned lock alive forever by refreshing locked_at directly is refused, so the only way to hold a lock is the server seam's compare-and-swap
```

The neighbours each family was placed next to, which had to keep passing and
did (the grant change and the route re-ordering are exactly the kind of edit
that closes one hole by opening another):

```text
 ✓ tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-01: an unauthenticated chunked request is refused 401 on its headers, with only a fraction of its body ever pushed — an anonymous caller cannot make the server buffer megabytes
 ✓ tests/e2e/transportGuards.test.ts > transport-layer request guards (verify finding #2) > NFR-DOS-02: an upload declaring more than 20 MB is refused 413 from its Content-Length alone, before the body is buffered and before any codec could run
 ✓ tests/db/schema.test.ts > write protection and disclosure > NFR-TAMPER-01: a writer cannot set published_at directly — publish-controlled columns are not writable through PostgREST
 ✓ tests/db/schema.test.ts > migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only
 ✓ tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-free: createRepo().takeLock — a draft nobody holds is locked by the writer opening it
 ✓ tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-held: createRepo().takeLock — a draft another writer’s heartbeat is keeping current is not stolen
 ✓ tests/db/remediation.test.ts > draft creation on the real repository (verify finding #4) > AC-05-stale: createRepo().takeLock — a draft another writer left locked 91 seconds ago is taken over with no admin unlock
 ✓ tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-01: a draft with a real uploaded cover publishes, goes live with a slug, and leaves both telemetry rows needed to compute time-to-publish
 ✓ tests/contract/provider.schemathesis.test.ts > OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-uploadArticleImage: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/images 1609ms
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > AC-07/D7-heic: a real HEVC-compressed HEIC straight off an iPhone, which the contract advertises but the WASM codec never decoded is converted to a modern format, smaller than the source
 ✓ tests/unit/lambdaImage.test.ts > Lambda image optimisation (ADR-0004) > NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought 703ms
```

The remaining 165 `✓` lines are unchanged from `04-green-evidence.v2.md` §2 and
are not re-pasted here; they are one `npm test` away and the totals below are
the check that none of them went missing.

Tail of the run, verbatim:

```text
 Test Files  28 passed (28)
      Tests  185 passed (185)
   Start at  20:42:13
   Duration  17.70s (transform 590ms, setup 0ms, collect 5.72s, tests 63.61s, environment 3ms, prepare 1.68s)
```

185 = the 176 the red gate left passing + the 9 it left failing. 28 files, as
at red. Nothing was skipped, and `vitest` exits 0.

### 2.1 Stability, stated plainly

Six full executions of the suite during this pass, all `185 passed (185)`.
Durations 17.7–24.8 s wall. The two timing-sensitive newcomers
(`NFR-FAILCLOSED-01a/b`, real `spawn`) landed at 353–739 ms across runs,
against a 30 s readiness timeout — two orders of magnitude of headroom.
`NFR-DOS-03` never once appeared with a duration in the reporter, i.e. it
settled under the ~300 ms the reporter prints at; §5.4 explains why that is
true and why it is also less reassuring than it looks.

One warning still appears in every run, unchanged and unaddressed by this
pass (it is `05-verification.v2.md` §7's second informational note, not one of
the seven findings this pass was asked to close):

```text
(node:67864) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0.
```

---

## 3. Typecheck

```text
$ npx tsc --noEmit
tsc exit: 0
```

No output, exit 0, with `strict` + `noUncheckedIndexedAccess` as configured.
One type-level change was *required* by the `sharp` bump and is recorded in
§5.5 and §7 (D4) rather than hidden here.

---

## 4. Finding by finding: what was built, and what proves it

| Verify v2 finding | Built | Proven by |
|---|---|---|
| **M1** — the draft lock is stealable through PostgREST | New expand-only migration `db/migrations/0003_lock_columns_service_role_only.sql`: `revoke update (locked_by, locked_at) on articles from authenticated` | `NFR-LOCK-GRANT-01a/b` (real Postgres, `set role authenticated`, both attacks now `42501`); the CAS still works for the seam — `AC-05-free/held/stale`, `VERIFY-04b` |
| **M2** — the callback buffers before checking its own secret | `router.ts`'s `route()` now checks `x-arsene-image-callback-secret` from the headers, before `readBody()`, alongside the writer-token check it already did for the other four routes | `NFR-DOS-04` (real socket: 401 with ≤1 MB pushed); `NFR-CALLBACK-01a/b` unchanged at the handler layer |
| **M3** — no fail-closed behaviour on a missing JWT secret | `serverMain.ts` refuses to start (exit 78, message naming `SUPABASE_JWT_SECRET`) when it is absent or empty and `ALLOW_LEGACY_STATIC_AUTH=true` is not set; `server.ts` forwards `allowLegacyAuth` to the child as that variable, via `env` | `NFR-FAILCLOSED-01a/b` (real spawned child, both the absent and the empty case); the legitimate opt-in still boots and still serves — `E2E-01/02/03`, `CONTRACT-PROVIDER-*` |
| **§5** — `readBody()` has no timeout | `startHttpServer()` now creates its `http.Server` with `requestTimeout` = `opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS` and a matching `connectionsCheckingInterval`; `DEFAULT_READ_TIMEOUT_MS = 8_000` is exported | `NFR-DOS-03b` (the shipped constant); `NFR-DOS-03` (settles well inside its deadline) — **plus a hand probe, §5.4, because NFR-DOS-03 as written no longer reaches the timeout** |
| **L1** — `sharp@0.34.4`'s libvips CVEs | `sharp` pinned to `0.35.3` (libvips 8.18.3); `npm audit --omit=dev` → 0 vulnerabilities, was 1 High | No dedicated test, by design (`03-red-evidence.v3.md` §5): the real-codec suite is the net — `AC-07/D7-jpeg/png/webp/avif/heic`, `AC-08-corrupt`, `AC-08-unsupported`, `NFR-IMGCPU-01`, all green, HEIC included |
| **L2** — `optimized_url` not scoped to the CDN | `router.ts`'s `ImageStatusBody` refines `optimized_url` with `new URL(v).origin === CDN_ORIGIN` — an origin comparison, not a prefix test | `NFR-CALLBACK-04a` (foreign host) and `NFR-CALLBACK-04b` (prefix-confusion host), both 400 from the body alone against an unreachable database; the positive side still passes — `NFR-CALLBACK-02a`, `NFR-CALLBACK-03` |

---

## 5. The mechanisms, in detail

### 5.1 M1 — the grant, not the application

`0001_initial_schema.sql` granted `authenticated` column-level `UPDATE` on
`locked_by`/`locked_at`, so `repo.takeLock()`'s compare-and-swap was advisory:
a writer could `PATCH /rest/v1/articles?id=eq.<id>` and take a live lock, or
refresh a colleague's heartbeat forever so the 90-second staleness window never
opened. The fix puts those two columns on the same side of the grant line as
the publish-controlled ones `NFR-TAMPER-01` already pinned.

Shipped as a new migration rather than an edit to `0001`, following the
precedent `0002_service_role.sql` set: `0001` is deployed, and Supabase applies
migrations forward. `revoke` is not a drop or a retype, so `NFR-MIGRATE-01`'s
expand-only rule is satisfied in substance as well as by its regex — no data or
column disappears, only a privilege narrows.

The seam side is unaffected: `startHttpServer()`'s pool runs `set role
service_role`, and `0002` grants that role `all on all tables`. `AC-05-free`,
`AC-05-held`, `AC-05-stale` and `NFR-CALLBACK-03` all still pass, which is the
both-sides pair `03-red-evidence.v3.md` §6 asked for.

### 5.2 M2 — the ordering

```ts
if (op.kind === 'image-status') {
  if (!verifySharedSecret(header(req, 'x-arsene-image-callback-secret'), ctx.opts.imageCallbackSecret ?? '')) {
    send(res, errorResponse(401, 'UNAUTHORIZED', 'A valid image-callback secret is required.'));
    return;
  }
} else if (!(await verify(...)).valid) { … }
```

placed exactly where the writer-token check already was — after the 404, the
405 and the `Content-Length` guard, before `readBody()`. The handler keeps its
own check: it is a separate entry point with its own unit tests
(`NFR-CALLBACK-01a/b`), and defence in depth costs one comparison.

`verifySharedSecret` treats an unconfigured (empty) secret as authenticating
nobody, so a deployment that forgets `IMAGE_CALLBACK_SECRET` refuses every
callback rather than accepting all of them — unchanged behaviour, now applied
one step earlier.

### 5.3 M3 — chosen versus arrived at

Implemented exactly as `03-red-evidence.v3.md` and `traceability.md` §6 (15)
specify; no deviation from the prescribed mechanism.

- `serverMain.ts` refuses to start when `SUPABASE_JWT_SECRET` is `undefined`
  **or** `''`, unless `ALLOW_LEGACY_STATIC_AUTH === 'true'`. It exits `78`
  (`EX_CONFIG`) after naming the variable and both remedies.
- `server.ts` gains `SpawnedServerOptions = ServerOptions & { allowLegacyAuth?:
  boolean }` and forwards `ALLOW_LEGACY_STATIC_AUTH=true` through `env`, never
  argv, next to the two secrets it already forwards that way.
- `startHttpServer()` is untouched: it is a library entry point whose
  configuration arrives as arguments.

Two implementation details worth naming, because both are the kind of thing
that silently makes a test flaky rather than wrong:

1. **`writeSync(2, …)` rather than `process.stderr.write`.** Writes to a pipe
   are asynchronous on macOS; the message would be lost when `process.exit()`
   ran immediately after it, and the parent would report a refusal with no
   reason — the exact string `NFR-FAILCLOSED-01` asserts on.
2. **`server.ts` now rejects on the child's `close` event rather than `exit`.**
   `exit` fires when the process dies, which can precede the parent draining
   the child's stdio pipes, so `output` could still be empty at that moment.
   `close` fires once both have happened. This is a change to a code path that
   only runs when a child fails to start, and it is what makes "says why"
   deterministic instead of a race.

### 5.4 §5 — the read timeout, and an honest caveat about NFR-DOS-03

The mechanism is Node's own, which is what `verify/integration-e2e-v2.md` §5
recommended ("`server.requestTimeout` / `server.headersTimeout`"):

```ts
const readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
http.createServer({ requestTimeout: readTimeoutMs,
                    connectionsCheckingInterval: Math.ceil(readTimeoutMs / 4) }, …)
```

`connectionsCheckingInterval` is not decoration: Node only notices an
over-running request when it sweeps its connections, and that sweep defaults to
**30 seconds**, which would leave an 8-second `requestTimeout` meaning "somewhere
between 8 and 38 seconds". Sweeping four times per window bounds the real answer
at ~1.25× the configured value. Measured, by hand, with a script that declares
1 MB, sends 1 KB and stops (the reproduction from `verify/integration-e2e-v2.md`
§5), against the router booted in-process:

```text
readTimeoutMs: 1500   →  response 408  1881 ms
default (8000)        →  response 408  8012 ms
```

(With the sweep left equal to the timeout — the first implementation — the same
default probe answered at 16010 ms. That is why it is `/4`.)

**The caveat, which matters more than the numbers.** `NFR-DOS-03` drives
`/internal/images/{id}/status` and sends **no callback secret**. Since M2's fix
lands in the same `route()`, that request is now answered `401` from its headers
in a few milliseconds — so the test passes, but it passes on M2's guard, not on
the timeout it was written for. The test is not wrong (`03-red-evidence.v3.md`
§6 explicitly accepts "an explicit response" as satisfying it, and the finding
it names — unbounded waiting — is genuinely closed), and I did not edit it. But
its *reason* for passing changed underneath it, and the only thing keeping the
timeout honest inside the suite is `NFR-DOS-03b`, which pins a constant rather
than a behaviour. The hand probe above is what actually demonstrates the
mechanism, and it is the thing a future verify pass should re-run — or better,
turn into a test that sends the valid secret. Recorded here rather than left for
someone to discover.

The exact response is Node's `408`, which is *not* one of `http.ts`'s
`ErrorCode` envelope values — deliberately, per `03-red-evidence.v3.md` §6:
requiring an envelope for a timeout would be an unagreed contract change, and
the test accepts a response, a 408 or a teardown alike.

### 5.5 L1 — the `sharp` bump

`sharp` `0.34.4` → **`0.35.3`** (pinned exactly, as it was before), bringing
libvips 8.18.3.

```text
$ npm audit --omit=dev
found 0 vulnerabilities        # was: 1 High (sharp@0.34.4)
```

The bump required one source change, which is a real API change and not a
workaround: `sharp` 0.35 ships ESM typings whose `Sharp` is a **named type
export**, where 0.34 exposed it through a `sharp.*` namespace alongside the
default export. `src/images/lambdaHandler.ts`'s one type annotation
(`Promise<sharp.Sharp>` → `Promise<Sharp>`) moved with it; runtime code is
untouched.

HEIC was the documented risk (`traceability.md` §6 note 14 — it depends on the
build's HEVC support). It survived: `sharp.format.heif.input` is
`{ file: true, buffer: true, stream: true }` on the installed build, and
`AC-07/D7-heic` converts a real iPhone HEIC in the suite. `NFR-IMGCPU-01` still
converts a ~6 MP photo inside its one-second budget (703 ms in the logged run).

### 5.6 L2 — an origin comparison

```ts
const isCdnUrl = (value: string): boolean => {
  try { return new URL(value).origin === CDN_ORIGIN; } catch { return false; }
};
```

wired into `ImageStatusBody`'s `ready` branch, i.e. at validation time in
`router.ts`, before any repository call — which is what makes the two new tests
answer `400` against a database that is unreachable by design. `startsWith`
would have accepted `https://cdn.fantasycoach.example.attacker.test/…`;
`NFR-CALLBACK-04b` exists to make that implementation impossible to ship, and
`.origin` is what makes it pass. `handleImageStatusCallback`'s own contract and
unit tests are untouched.

---

## 6. Coverage — measured, with the parts that are not measurable named

```text
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run --coverage
```

```text
 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   82.69 |    86.15 |   86.56 |   82.69 |
 api               |   75.38 |    81.25 |   77.63 |   75.38 |
  auth.ts          |     100 |      100 |     100 |     100 |
  client.ts        |   97.64 |    73.68 |     100 |   97.64 | 91,97
  createDraft.ts   |    84.9 |     37.5 |     100 |    84.9 | 50-51,79-80,84-87
  http.ts          |     100 |      100 |     100 |     100 |
  imageStatus.ts   |     100 |    93.33 |     100 |     100 | 82
  ...ishArticle.ts |     100 |    97.87 |     100 |     100 | 223
  rateLimit.ts     |   57.14 |      100 |      50 |   57.14 | 24-29
  repo.ts          |   58.59 |     61.9 |   58.33 |   58.59 | ...96-202,205-227
  router.ts        |    57.1 |       70 |   67.74 |    57.1 | ...25-527,529-532
  server.ts        |   97.95 |    93.75 |     100 |   97.95 | 50
  serverMain.ts    |       0 |        0 |       0 |       0 | 1-58
  uploadImage.ts   |   92.92 |    90.47 |     100 |   92.92 | 79-82,86-89
 client            |     100 |    84.61 |     100 |     100 |
  fixturePicker.ts |     100 |    84.61 |     100 |     100 | 39-41
 domain            |   95.87 |    90.41 |   95.65 |   95.87 |
  autosave.ts      |     100 |       90 |     100 |     100 | 40
  lock.ts          |     100 |      100 |     100 |     100 |
  paste.ts         |     100 |       90 |     100 |     100 | 20
  pronosEntry.ts   |     100 |      100 |     100 |     100 |
  seo.ts           |   90.72 |    79.16 |    92.3 |   90.72 | 45-51,74,87
  taxonomy.ts      |     100 |      100 |     100 |     100 |
 images            |   97.88 |    94.73 |     100 |   97.88 |
  format.ts        |   86.95 |    96.29 |     100 |   86.95 | 50-52
  heic.ts          |     100 |       60 |     100 |     100 | 20,27
  lambdaHandler.ts |     100 |      100 |     100 |     100 |
  optimize.ts      |     100 |      100 |     100 |     100 |
 site              |   97.89 |       96 |     100 |   97.89 |
  render.ts        |   97.89 |       96 |     100 |   97.89 | 137-138
 telemetry         |     100 |      100 |     100 |     100 |
  events.ts        |     100 |      100 |     100 |     100 |
-------------------|---------|----------|---------|---------|-------------------
```

Movement against v2 (81.68 / 86.00 / 84.96): **+1.01 statements, +0.15 branch,
+1.60 functions**, all of it in `router.ts` (48.77 → 57.10 statements), because
this pass's new guards live in `route()`, which the in-process
`transportGuards` harness actually executes. Nothing regressed.

Recomputed from `coverage/coverage-final.json` over `src/**` excluding the four
modules that only ever run out of process, the same four v1 and v2 excluded, so
the numbers are comparable:

```text
all src/**                            stmts 82.69 % (1376/1664)  branch 86.16 %  funcs 86.57 %
src/** minus router/repo/serverMain/rateLimit  stmts 97.01 % (1072/1105)  branch 91.41 %  funcs 98.86 %
```

### 6.1 What this pass added, and whether it is covered

| New code | Covered? |
|---|---|
| `route()`'s image-status secret check (both outcomes) | Yes — `NFR-DOS-04` (refusal) and `NFR-CALLBACK-04a/b` (acceptance, then a body rejection) |
| `isCdnUrl`'s `origin` comparison, true and false | Yes — `NFR-CALLBACK-02a`/`NFR-CALLBACK-03` accept a CDN URL; `NFR-CALLBACK-04a/b` reject two non-CDN ones |
| `isCdnUrl`'s `catch` (a string that is not a URL at all) | **No** — router.ts lines 67–69. No test posts `optimized_url: "not-a-url"` through the router. It returns `false`, i.e. the same 400, so the risk is a wrong *reason*, not a wrong answer; two lines, one `catch`, no state |
| `requestTimeout`/`connectionsCheckingInterval` wiring | Yes as configuration (every in-process boot runs it). The *firing* of the timeout is covered only by the hand probe in §5.4, not by the suite — see the caveat there |
| `DEFAULT_READ_TIMEOUT_MS` | Yes — `NFR-DOS-03b` reads it |
| `server.ts`'s `allowLegacyAuth` forwarding, both branches | Yes — `publishJourney`/`provider.schemathesis` set it, `failClosedConfig`/`deployedAuthBoundary` do not |
| `server.ts`'s `close`-instead-of-`exit` rejection | Yes — it is the path `NFR-FAILCLOSED-01a/b` take |
| `serverMain.ts`'s refusal | **Executed for real, measured as 0 %** — it is the child process (see below) |
| `db/migrations/0003` | Not a coverage subject; proven by `NFR-LOCK-GRANT-01a/b` against real Postgres |

### 6.2 What is uncovered, and whether it matters

- **`src/api/serverMain.ts` 0 % (lines 1–58) is the single most misleading
  number in the table, and it got worse this pass** — the file grew from 31 to
  58 lines, all of the new ones being M3's fail-closed check. That check is
  executed for real, twice, in a real child process by
  `NFR-FAILCLOSED-01a/b`; v8 instruments the parent only, so none of it is
  attributed. "0 %" here means "not measurable", not "not exercised". The same
  was true at v2 and v1.
- **`src/api/router.ts` 57.10 %** — same story, smaller: the uncovered ranges
  are the publish/upload/`convert()` paths and the dependency wiring, all of
  which run for real in `publishJourney` and in four Schemathesis operations,
  in the child process. Genuinely unexercised in-process are `route()`'s 404
  (lines 525–527) and 405 (529–532) branches, which the contract suite drives
  over HTTP instead.
- **`src/api/server.ts` line 50 is newly *visible* and is a real gap.** It is
  the `IMAGE_CALLBACK_SECRET: opts.imageCallbackSecret` consequent: **no
  `startServer` call site in the suite passes `imageCallbackSecret`**, so that
  forwarding is untested through the spawn boundary. This is precisely the
  shape of the bug Bob found by hand at verify v2 (`jwtSecret` was silently
  dropped by this same `spawn` call, commit `02a3f92`); its sibling is proven
  by `VERIFY-03-DEPLOY-01`, this one is not. v2's table showed `server.ts` at
  100 % — that was v8 attributing a multi-line ternary consequent to a covered
  range, not a test that has since been lost. Nothing in this pass changed the
  behaviour; the line moved and the reporter started telling the truth about
  it. **Worth a test; out of scope for a green gate, which may not add tests.**
- Unchanged from v2 §4.2, all still true and all still judged acceptable
  there: `createDraft.ts`'s handler-level 401/404 (shadowed by the router's own
  guard), `format.ts` 50–52 (PNG terminator), `heic.ts` 20/27 (broken-HEIC
  branches), `imageStatus.ts` 82 (lost CAS race — the database half is proven
  by `NFR-CALLBACK-03`), `uploadImage.ts` 79–82/86–89, `seo.ts`, `client.ts`,
  `fixturePicker.ts`, `render.ts`, `rateLimit.ts` 24–29.
- **Fully covered and it is the code that matters most**, unchanged: `auth.ts`
  100/100, `imageStatus.ts` 100 statements, `publishArticle.ts` 100/97.87,
  `lambdaHandler.ts` 100/100 (now against `sharp` 0.35.3 and five real source
  formats), `optimize.ts`, `lock.ts`, `pronosEntry.ts`, `taxonomy.ts`,
  `events.ts`, `http.ts`.

No coverage thresholds were added to `vitest.config.ts`, for the same reason as
v1 and v2: the 80 % floor lives in `state.json`, and a second copy in the test
config is configuration nobody asked for.

---

## 7. Decisions and deviations, each deliberate

**D1. `DEFAULT_READ_TIMEOUT_MS = 8_000`, and what it costs.** `NFR-DOS-03b`
requires `0 < value ≤ 10_000` and its title asks for single-digit seconds; 8 s
is the most upload headroom available inside that. It is still a real
trade-off, and it deserves to be said out loud rather than buried: the same
router accepts uploads up to 20 MB, and 20 MB cannot arrive in 8 seconds on an
uplink slower than ~20 Mbit/s. A writer on a weak connection uploading a large
photo will now get a `408` where they previously waited. The pairing of "20 MB
cap" and "single-digit-second whole-request window" is worth revisiting as a
product question (a body-progress-based idle timeout would serve both), but it
was fixed by the red gate and this pass honoured it rather than re-litigating
it in code.

**D2. `connectionsCheckingInterval: Math.ceil(readTimeoutMs / 4)`.** Not a
configuration knob — a derived value, and the only thing that makes
`DEFAULT_READ_TIMEOUT_MS` mean approximately what it says (§5.4). The first
implementation left the sweep equal to the timeout and measured a 16 s real
bound for an 8 s setting; that was changed mid-pass, and the suite was re-run in
full three more times afterwards.

**D3. `server.ts` rejects on `close`, not `exit`.** A behaviour change to an
existing, previously-green code path, made because M3's message would otherwise
race the pipe drain (§5.3). No test asserted `exit` specifically; every test
that uses this path still passes.

**D4. `import sharp, { type Sharp } from 'sharp'`.** Forced by 0.35's typings
(§5.5). Runtime behaviour identical.

**D5. `SpawnedServerOptions` in `server.ts` rather than `allowLegacyAuth` on
`RouterOptions`.** `allowLegacyAuth` is meaningless to `startHttpServer` — it
describes how a *process* was configured, not how the router behaves — so it
lives on the process-boundary module's own type. `tests/support/seams.ts`
declares it on `startServer`'s options and nowhere else, which agrees. That
type is `Omit<ServerOptions, 'readTimeoutMs'> & { allowLegacyAuth?: boolean }`:
`startServer` does not forward a read timeout to the child (the child gets the
shipped default, §8), and this boundary has already shipped one option it
advertised and silently dropped — `jwtSecret`, commit `02a3f92` — so it does
not advertise a second one.

**D6. Migration `0003` revokes rather than editing `0001`.** Forward-only, the
precedent `0002` set. `NFR-MIGRATE-01` passes.

**No deviation from the M3 mechanism** `03-red-evidence.v3.md` prescribed, and
**no test file changed** — including the two the red pass pre-marked with
`allowLegacyAuth: true`, which needed nothing further.

---

## 8. What is *not* done, and left honestly open

- **`NFR-DOS-03` no longer measures what it was written to measure** (§5.4).
  The finding is closed and demonstrated by hand; the *suite's* proof of it is
  now `NFR-DOS-03b`'s constant plus a wiring that no assertion drives to
  firing. The cheapest fix, for whoever owns the next red gate: give that test
  the valid callback secret.
- **`IMAGE_CALLBACK_SECRET`'s forwarding through `spawn` is untested** (§6.2).
  Same shape as a bug this project has already been bitten by once.
- **`readTimeoutMs` is not readable from the environment**, so a deployed
  server (`serverMain.ts`) always gets `DEFAULT_READ_TIMEOUT_MS`. That is the
  intent — the shipped default is the protection, and nobody asked for a knob —
  but it means D1's trade-off cannot be tuned per environment without a code
  change.
- **The two informational notes in `05-verification.v2.md` §7 are untouched**:
  the double JWT verification per request (measured harmless), and the
  un-awaited `set role service_role` on pool connect, which still emits its
  `DeprecationWarning` on every run (§2.1). Neither is one of the seven
  findings this pass was scoped to, and neither has a failing test.
- **`state.json` was not modified**, by instruction.

---

## 9. Gate statement

185 tests, 185 passing, 28 files, six full runs. `tsc --noEmit` exit 0.
Coverage 82.69 % statements / 86.15 % branch over all `src/**`, 97.01 % /
91.41 % excluding the four modules that only run out of process — with the
uncovered code named above rather than averaged away. Nine red tests turned
green by four edited source files, one new migration and one dependency bump —
no test file touched, no assertion relaxed. Green.
