# arsene-cms — Pipeline gate (v2)

**Status: the finding `10-pipeline.v1.md` raised is closed.** The API server
has been ported to Deno's Fetch-API handler model — the runtime ADR-0001
actually named — and both halves of the pipeline (Postgres migrations, API
server) now have a real, rehearsed deploy + rollback mechanism. What v1 left
blocked is built; what v1 already had stays unchanged and is not repeated
here in full (see `10-pipeline.v1.md` §1, §3, §4, §5 for the migration half).

**Run:** 2026-08-22, branch `feat/arsene-cms`, on top of commit `e66aeb9`
(the commit `10-pipeline.v1.md` was written against).

---

## 0. What changed since v1, in one paragraph

`10-pipeline.v1.md` found that `src/api/router.ts` was built on Node's
`http.createServer`/`node:child_process`, which cannot run on Supabase Edge
Functions (Deno, `Deno.serve((req: Request) => Response)`). Per the user's
explicit instruction ("port the API server to Deno's Fetch-API model"),
`router.ts` was refactored so its routing/business logic — `route()`,
`dispatch()`, every handler-dependency builder, `verify()` — operates
entirely on the standard Fetch API (`Request` in, `Response` out), with two
thin adapters on top: the existing Node one (`startHttpServer`, still in
`router.ts`, unchanged behaviour, used by the whole existing test suite) and
a new, real Deno one (`supabase/functions/arsene-api/index.ts`). Both call
the same `route()`/`buildCtx()`.

---

## 1. Mechanism (API server half — now real, built, rehearsed)

- **The ported core** (`src/api/router.ts`): `route(request: Request, method:
  string, clientIp: string, ctx): Promise<Response>`. `method` travels
  separately from `request.method` because the WHATWG Fetch spec forbids
  constructing a `Request` with method `TRACE`/`TRACK`/`CONNECT` at all — a
  real caller can still send one over the wire (contract fuzzing does), and
  `route()`'s own 405 must still answer it rather than an adapter throwing
  before `route()` is ever reached. Found by the existing contract suite
  (Schemathesis's `TRACE` case) the first time the Node adapter was rebuilt
  on top of a real `Request` object; fixed by threading the wire method
  through explicitly rather than trusting `request.method`. Confirmed fixed
  under both adapters (`tests/e2e/deployedDenoRuntime.test.ts`'s DENO-03,
  and the existing Schemathesis suite for the Node path).
- **The Node adapter** (`startHttpServer`, same file, same exported name and
  `ServerOptions` shape the test suite's seam already expected): converts
  each `http.IncomingMessage` to a `Request` via `Readable.toWeb`, calls
  `route()`, writes the `Response` back. `DEFAULT_READ_TIMEOUT_MS` and
  Node's `requestTimeout`/`connectionsCheckingInterval` mechanism are
  unchanged. All 227 pre-existing tests pass against this adapter unchanged
  — zero test edits.
- **The Deno adapter** (`supabase/functions/arsene-api/index.ts`, new): a
  real `Deno.serve` handler calling the same `route()`/`buildCtx()`. Reads
  its configuration from environment (`SUPABASE_JWT_SECRET`,
  `IMAGE_CALLBACK_SECRET`, `CDN_ORIGIN`, `SUPABASE_DB_URL` — provided
  automatically to every Edge Function — or an explicit `DATABASE_URL`
  override), with the same fail-closed check `serverMain.ts` already had:
  refuses to start with no JWT secret unless `ALLOW_LEGACY_STATIC_AUTH=true`
  is set deliberately.
- **The request-timeout mechanism is genuinely different per adapter, by
  necessity**: `Deno.serve` has no equivalent of Node's
  `requestTimeout`/`connectionsCheckingInterval`, so the Deno adapter races
  `route()` against a timer instead. This is a **disclosed, deliberate
  difference**, not an oversight: it bounds the whole request (body delivery
  *and* handler execution — a superset of the Node guarantee), and it does
  not cancel `route()`'s in-flight work when the timer wins, so a slow query
  keeps running in the background after the client is answered `408`. Fine
  for a first working deploy; a follow-up could wire an `AbortSignal`
  through `readBody()`/the repo calls if the in-flight work needs to
  actually stop, not just stop blocking the response.
- **The dev/test-only Lambda simulation never reaches the Deno deploy
  graph.** `router.ts`'s `convert()` (which simulates ADR-0004's
  S3→Lambda→callback loop in-process, using real `sharp` — a native addon,
  Lambda/Node-only) is wired into `ctx.shared.processUpload` **only** by
  `startHttpServer` (the Node dev/test adapter). The Deno adapter never sets
  it. `convert()`'s own import of `../images/lambdaHandler.ts` (and
  therefore `sharp`) is a lazy, non-literal dynamic import specifically so
  that merely importing `route()`/`buildCtx()` from `router.ts` — which the
  Deno entry point does — never pulls `sharp` into the Edge Function's
  module graph. **Confirmed empirically** (§3 below): a static import here
  makes `deno check` try to download and type-check the entire `sharp`
  package tree (24 platform-specific native packages); the lazy,
  non-literal-specifier form makes both `deno check` and `deno run` skip it
  entirely, because it is never actually reached.
- **Dependency resolution**: `supabase/functions/arsene-api/deno.json`
  is a function-scoped import map (Supabase's documented, recommended
  mechanism — "Managing dependencies" — over each function's own
  `deno.json`, one per function so a dependency bump never risks breaking a
  sibling function) mapping `pg`, `zod`, `jose`, `sanitize-html` and the
  `@jsquash/*` codec subpaths to their `npm:` specifiers. `pg` (node-postgres)
  is confirmed to work under Deno via `npm:pg@8.22.0` — proven empirically
  earlier in this gate against a disposable local Postgres, and confirmed by
  current Supabase docs as an officially-supported Edge Function Postgres
  client, with Supavisor's transaction-mode pooler (port 6543) recommended
  for edge/serverless callers. This codebase's queries are all
  simple/unnamed (`pool.query(text, params)`, confirmed by inspection of
  `src/api/repo.ts` — never a named prepared statement), which is what
  transaction pooling requires to be safe.
- **Secrets**: `SUPABASE_ACCESS_TOKEN` (a Supabase personal/org access
  token, for the CLI to authenticate) and `SUPABASE_PROJECT_REF`, both
  GitHub Secrets, used only to run `supabase functions deploy`. The
  function's own runtime secrets (`SUPABASE_JWT_SECRET`,
  `IMAGE_CALLBACK_SECRET`, `CDN_ORIGIN`, `WRITER_TOKEN`, `WRITER_ID`) are a
  **separate** concern this workflow does not push on every deploy — they
  are Supabase project secrets, set once via `supabase secrets set` or the
  Dashboard, the same way a Node deployment's environment variables are
  typically set once on its host rather than re-pushed every CI run. Not
  automating that is deliberate, not an oversight: it is genuinely
  infrequent, and scripting it would mean a CI job that can overwrite
  production secrets on every tag push.
- **Rollback**: `supabase functions deploy` re-uploads the rollback target
  tag's own checked-out code as the new active version — the
  "versioned redeploy" mechanism `02-architecture.v1.md` §6 named for Edge
  Functions. There is no separate "promote a previous deployment" API;
  redeploying the old tag's code *is* the mechanism, run from
  `rollback.yml`'s `redeploy-api-server` job exactly like `deploy.yml`'s.

## 2. Rehearsal — what was actually measured, against real infrastructure

Real Deno 2.9.4 (`deno run`, no mocking of the runtime), real Postgres 16
(`docker run postgres:16-alpine`), real HTTP (`curl` and raw `node:http`/raw
TCP sockets) — the same standard `10-pipeline.v1.md` §3 held the migration
half to.

| Check | Result |
|---|---|
| `deno check` (full type-check of the Deno entry point + its whole import graph) | clean, 0 errors |
| `deno run` boots the real Edge Function against real Postgres | boots, logs `Listening on http://0.0.0.0:<port>/` |
| `POST /v1/articles` with a legacy static bearer token | `201`, real row in Postgres |
| `POST /v1/articles` with no `Authorization` header | `401 UNAUTHORIZED` |
| `GET /v1/articles` (wrong method) | `405 CONFLICT`, `Allow: POST` |
| `POST /v1/nope` (unmatched path) | `404 NOT_FOUND` |
| `TRACE /v1/articles` (Fetch-spec-forbidden method) | `405 CONFLICT`, not a crash |
| `POST .../publish` with no cover image | `400 COVER_IMAGE_REQUIRED` (real business logic, not a transport stub) |
| `POST .../images` with `Content-Length: 999999999` and 1 byte actually sent | `413 FILE_TOO_LARGE`, answered from the header alone |
| `POST .../images` with a real JPEG (multipart) | `201`, `status: "processing"` |
| Image row after 2s, no callback yet | still `processing`, no `optimized_url` — **confirms `convert()`/`sharp` was never invoked** |
| `POST /internal/images/{id}/status` with the correct callback secret | `200`, row updated to `ready` with the real `optimized_url` |
| Declared body arriving far slower than `READ_TIMEOUT_MS` (raw socket, partial write, `READ_TIMEOUT_MS=1500`) | `408`, measured wall-clock: **1.502s** |

The `408` figure is a real measured number (a Python script opened a raw
socket, sent headers declaring a 100-byte body, wrote 10 bytes, then timed
how long until a response arrived) — not an estimate, per this gate's own
standard.

**Automated, permanent proof** — not just this rehearsal transcript —lives
in `tests/e2e/deployedDenoRuntime.test.ts` (new) via `tests/support/denoServer.ts`
(new): six tests, each spawning a genuine `deno run` child process against a
real Testcontainers Postgres and driving it over real HTTP, mirroring
`tests/e2e/deployedAuthBoundary.test.ts`'s pattern for the Node boundary.
They cover: JWT auth success, legacy-token rejection once JWT is configured,
the `TRACE`/forbidden-method fix, the `413` size-cap guard, the "upload
stays `processing`, `sharp` never runs" guarantee, and the full ADR-0004
callback loop closing to `ready`. All six pass. The full suite is now
**233/233** (227 pre-existing + 6 new), zero regressions, zero test edits to
any pre-existing file.

`deploy.yml`/`rollback.yml` gained a `denoland/setup-deno@v2` step in their
test jobs so this new file can actually run in CI — without it, `npm test`
would fail in CI with "deno: command not found", which would be a false
negative on every future PR, not a passing gate.

**What was not rehearsed**: the actual `supabase functions deploy` CLI
round-trip against the real linked Supabase project
(`dmytkubjxwwwkroutvdu`). Consistent with this gate's v1 rehearsal (which
also used a disposable local Postgres rather than the real project) and with
this branch's standing practice of not touching a real/paid/shared account
without explicit confirmation first — that step is real CLI syntax, sourced
from current Supabase docs (`supabase/setup-cli@v1` + `supabase functions
deploy --project-ref`), but has not itself been executed against the live
project. Recommended as the next concrete step before the first real tagged
release.

## 3. The `sharp`/Deno landmine — confirmed and closed, not just assumed

Before writing `convert()`'s dynamic import, this gate spiked the exact
failure mode with disposable throwaway files (not the real codebase) to
confirm the mechanism before relying on it:

- A file with a **static** `import sharp from "sharp"` reachable from a
  `deno run` entry point, with `sharp` absent from the import map:
  `deno check` fails immediately (`TS2307`); with `sharp` present in the
  import map, `deno run` **downloads all 24 of `sharp`'s platform-specific
  native packages** just to resolve the module graph, even though the code
  calling it never executes.
- The same file reached only through a **dynamic, non-literal-specifier**
  import (`const specifier = "./x.ts"; await import(specifier)`), never
  invoked at runtime: both `deno check` and `deno run` skip it completely —
  no download, no type error, no attempt to resolve `sharp` at all.

`router.ts`'s real `convert()` uses exactly the second form. This is the
concrete mechanism that keeps `sharp` out of the Deno deploy entirely, not a
hopeful assumption about how bundlers generally behave.

## 4. A new, disclosed, out-of-scope finding: JWT signing keys

Current Supabase docs ("JWT Signing Keys") state plainly that the shared
HS256 `JWT secret` model `src/api/auth.ts` verifies against — what this
whole project's `SUPABASE_JWT_SECRET` configuration is — is the **Legacy**
system: "No longer recommended. Available for backward compatibility."
Supabase now offers a **Signing keys** system (asymmetric or a managed
shared secret, both rotatable independently, exposed via a JWKS endpoint —
`SUPABASE_JWKS` is now one of the secrets Edge Functions receive by
default). The legacy system continues to work and is what this gate's Deno
port targets (matching the code as it exists today) — this is **not** a
regression the port introduced, and not something this gate has fixed.

Flagging it now, in the same spirit as `10-pipeline.v1.md`'s own finding:
`auth.ts`'s HS256-shared-secret verification is a real, working, but no
longer recommended pattern, and migrating to the Signing keys system would
be its own scoped piece of work (`jose`'s `jwtVerify` already supports JWKS
verification via `createRemoteJWKSet`, so the change would be
`auth.ts`-local) — not something to fold silently into a transport-layer
port. Recorded here so it reaches whoever's decision it is next, not left
to be rediscovered.

## 5. What this gate did not touch

- The Cloudflare Pages / public-site deployable artifact — still doesn't
  exist in this repo, per `10-pipeline.v1.md` §0, unchanged.
- `state.json`'s `overrides[0]` (the two accepted verify-v8 limitations) and
  the migration one-way-door reconciliation gap (`10-pipeline.v1.md` §3) —
  unchanged, additive only.
- The real linked Supabase project — no secret was set on it, no function
  was deployed to it, no real invocation was made against it (§2 above).
- `auth.ts`'s JWT verification mechanism — deliberately not migrated to
  Supabase's newer Signing keys system (§4 above); this gate ported the
  transport layer, not the auth model.

## 6. Gate verdict

**The finding is closed.** Both halves of the pipeline — Postgres
migrations (`10-pipeline.v1.md`) and the API server (this document) — now
have a real, built, rehearsed deploy + rollback mechanism, each proven
against real infrastructure with real measured numbers, and the API
server's mechanism is additionally pinned by six new automated tests that
spawn the actual deployed runtime rather than trusting the Node suite by
proxy.

**Recommended next steps, in order:**
1. Run the real `supabase functions deploy arsene-api` round-trip against
   the actual linked project at least once before the first tagged release,
   to close the one gap named in §2 — the CLI syntax is sourced from current
   docs but has not itself been executed against a live project.
2. Set the Edge Function's runtime secrets (`SUPABASE_JWT_SECRET`,
   `IMAGE_CALLBACK_SECRET`, `CDN_ORIGIN`, `WRITER_TOKEN`, `WRITER_ID`) on the
   real project via `supabase secrets set`, once, outside CI.
3. Decide, separately, whether/when to migrate `auth.ts` off the legacy
   HS256 shared-secret model (§4) — not blocking, not part of this gate.
4. `10-pipeline.v1.md`'s still-open items, unchanged: fold migration `0005`'s
   pre-flight reconciliation into the deploy script or the migration itself;
   resolve where the Cloudflare Pages / public-site artifact actually lives.
