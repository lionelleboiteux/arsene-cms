# arsene-cms — Verify gate, second pass (v2)

**Status: NOT PASSED — four new Medium findings, pending disposition. All
prior blocking findings (#1-#4, High) are genuinely closed.**
**Run:** 2026-08-12, branch `feat/arsene-cms`, against commit `8d30acc`
(green remediation: 174/174) plus two further fixes made during this pass
(commits after `8d30acc`, see §2).
**Method:** same structure as v1 — `bob-security-auditor`, `bob-perf-analyst`,
an integration/e2e runner, all run fresh and independently, briefed to verify
the remediation rather than trust it. Plus an instrumentation proof run twice
by hand: once before this pass's own fix (§2), once after.

---

## 0. Executive summary

- **Every High-severity finding from `05-verification.v1.md` is genuinely
  closed**, confirmed independently by the security re-audit, the e2e
  re-verification, and — for the auth findings specifically — by two real bugs
  Bob found and fixed personally during this pass (§2), neither of which any
  subagent's test suite had caught.
- **Finding #5 (image codec vs. Supabase's CPU budget) is genuinely resolved**:
  upload response time is now 40-126ms across every real photo size tested,
  down from 1.4-4.0s, confirmed by the perf re-check.
- **The time-to-publish metric is now computable via its real, designed
  primary path**, not only the publish-time backfill v1 relied on — confirmed
  by hand against a real Postgres store (§3).
- **The verify gate still does not pass**, because of four new Medium findings
  discovered by this pass's own adversarial testing (not present in, or not
  fully covered by, v1's assessment):
  1. **AC-05's draft lock can be stolen via direct PostgREST**, bypassing the
     compare-and-swap entirely — the database grants don't mirror the
     application-level lock logic.
  2. **The image-status callback route still buffers its body before checking
     its own credential** — the same pattern H2 fixed elsewhere, narrower and
     bounded, but present.
  3. **No fail-closed behaviour if `SUPABASE_JWT_SECRET` is unset at
     runtime** — a missing env var silently reopens H3 rather than refusing
     to start.
  4. **`readBody()` has no timeout** — a request whose declared body never
     finishes arriving hangs indefinitely, worst on the one route that
     requires no credentials at all before hitting the hang.
- Two Low findings (an outdated `sharp` version with narrowed-but-real CVE
  exposure; an un-scoped `optimized_url` in the image callback) and two
  informational notes (harmless double JWT verification per request; a
  possibly-racy un-awaited `SET ROLE` query, unconfirmed as a real bug).

---

## 1. `bob check verify` — precondition

`state.json`: `green.status = "passed"` for the remediation pass (commit
`8d30acc`), `verify.status = "pending"`. Correct gate to run.

---

## 2. Two auth bugs Bob found and fixed personally during this pass

Both found while trying to re-prove the instrumentation via the real,
now-wired `POST /v1/articles` route (§3) — not by any subagent.

**2.1 — `verify()`'s fallthrough.** `router.ts`'s auth check fell through to
the legacy static-secret comparison even when `jwtSecret` was configured and
the presented JWT failed to verify — meaning the static token from finding #3
still worked *in parallel with* real JWT verification, not only in its
absence. Reproduced (a draft was created with the static token against a
JWT-configured server, `201` instead of `401`), closed with a new regression
test (`tests/e2e/draftJourney.test.ts`'s `VERIFY-03-REGRESSION`) added before
the fix, then `verify()` corrected to return immediately after a failed JWT
attempt whenever `jwtSecret` is set. Committed as `8d30acc`.

**2.2 — The real deployment boundary silently ignored `jwtSecret` entirely.**
`src/api/server.ts`'s `startServer()` — the child-process boundary
`serverMain.ts` runs behind, which is what any real deployment actually
uses — only ever forwarded `port`/`databaseUrl`/`writerToken`/`writerId` to
the spawned process. `opts.jwtSecret`/`opts.imageCallbackSecret` were silently
discarded, even though `ServerOptions` advertises both fields and
`serverMain.ts` reads them from `SUPABASE_JWT_SECRET`/`IMAGE_CALLBACK_SECRET`
environment variables that nothing was setting. A real deployment configured
via `startServer({..., jwtSecret})` would have silently stayed on the legacy
static token — 2.1's fix closed the logic bug but not this wiring bug, and
`tests/e2e/draftJourney.test.ts` never caught it because it uses the
in-process `startHttpServer()` shortcut, not the real spawned-child path.
Reproduced with a manual script (real JWT rejected `401`, legacy token
accepted `201`, against the real `server.ts`-spawned server), closed with a
new test file (`tests/e2e/deployedAuthBoundary.test.ts`,
`VERIFY-03-DEPLOY-01/02`, both confirmed failing before the fix) and a fix to
`server.ts` forwarding both secrets via the child's `env`. Committed as
`02a3f92`.

Both fixes were caught only because Bob chose to drive the real, deployable
entry point by hand rather than trust that "the tests pass" meant "the
deployed system is authenticated" — the in-process test shortcut used
throughout the suite is faster and was the right default for most coverage,
but it papered over exactly the boundary where the bug lived. Recorded here so
the pattern is visible, not just the fix.

---

## 3. Instrumentation proof, second pass — via the real primary path this time

`05-verification.v1.md` §8 could only prove the metric via the publish-time
backfill, because `POST /v1/articles` didn't exist. It exists now. Run by hand
against a real Postgres 16 (Testcontainers) and the real spawned server
(`server.ts`, post-§2.2-fix), with a real Supabase-shaped JWT:

```
create response: 201 {"article_id":"97987812-...","locked_by":"31bdf3c4-..."}

telemetry_events immediately after create:
{"event_type":"draft_started","writer_id":"31bdf3c4-...","article_id":"97987812-...",
 "occurred_at":"2026-08-12T15:37:47.383Z","payload":{"started_at":"2026-08-12T15:37:47.383Z"}}

CONFIRMED: draft_started was emitted by the real POST /v1/articles route, not a backfill.
```

`payload.started_at` is now a clean ISO string (`"2026-08-12T15:37:47.383Z"`),
not the double-JSON-encoded value v1 found (finding #7) — that fix holds on
the real route's own emission path, independent of the backfill's own fix.

After upload + publish, both events retrieved and the metric hand-computed
from real rows:

```
{"event_type":"draft_started", ..., "occurred_at":"2026-08-12T15:37:47.383Z", ...}
{"event_type":"article_published", ..., "occurred_at":"2026-08-12T15:37:50.643Z", ...}

HAND-COMPUTED time-to-publish = 0.0543 minutes (from the REAL route's draft_started, not a backfill)
attributed writer_id (draft):   31bdf3c4-... == seeded writer: true
attributed writer_id (publish): 31bdf3c4-... == seeded writer: true
```

Regression re-check in the same run: the legacy static token against this
same JWT-configured, real-spawned server — `401`, as required.

A second, independent instrumentation run (5 articles, backdated 4/7/9/22/48
minutes) was done by the integration/e2e subagent as part of its own pass;
durations and writer attribution matched expectations there too (see
`verify/integration-e2e-v2.md` §2).

**Counter-metric**: unchanged from v1, still correctly and honestly
uncomputable from any event this build emits, still the documented manual
proxy. Not re-litigated this pass.

---

## 4. Security re-audit (`bob-security-auditor`, run fresh, briefed to verify not trust)

Full method: semgrep (`p/typescript`, `p/secrets`, `p/sql-injection`, `p/xss`,
`p/owasp-top-ten`, `--config auto` — 210 rules), gitleaks (working tree + full
history, 9 commits), `npm audit` (both full and `--production`), and manual
tracing of every original finding plus the new S3+Lambda trust boundary.

**Tooling**: 0 semgrep findings. Gitleaks: 4-5 hits, all confirmed
false-positive test-fixture UUIDs. `npm audit --production`: 1 High
(`sharp@0.34.4`, see L1 below) — full audit's Critical/High/Moderate counts
are all dev-only tooling, not shipped.

**The four original findings, verified by hand, not by trusting the
description:**

- **H1 (stored XSS) — genuinely CLOSED.** Traced `body_html` from both write
  paths through to output. `publishArticle.ts` sanitizes before persisting;
  `render.ts` sanitizes **again**, unconditionally, immediately before
  interpolation — the important part, since it means even a row poisoned by a
  direct PostgREST write to an already-published article still can't execute,
  because render is the single choke point regardless of how the row got
  poisoned.
- **H2 (DoS via pre-auth body buffering) — CLOSED for 4 of 5 routes, one gap
  remains** (see M2 below, and the independently-found timeout gap in §5).
- **H3 (weak/shared auth) — CLOSED when `jwtSecret` is configured**, traced
  all four code paths by hand and confirmed no fallthrough exists (matching
  §2.1's fix). One residual, structural risk: nothing asserts the secret is
  actually set at runtime (see M3).
- **Draft creation / AC-05 — reachability CLOSED, but locking is not actually
  enforced at the data layer** (see M1).

**New findings:**

- **M1 (Medium)** — `db/migrations/0001_initial_schema.sql`'s grant to
  `authenticated` includes `locked_by`/`locked_at` directly, and RLS on
  `articles` is `using (true) with check (true)` for that role. Any writer can
  `PATCH /rest/v1/articles?id=eq.<id>` with a new `locked_by`/fresh
  `locked_at`, instantly stealing another writer's active lock — bypassing
  `repo.ts`'s CAS entirely, with no recovery path for the writer who lost it.
  This defeats the exact purpose ADR-0003 states for building the mechanism.
  Fix: remove `locked_by`/`locked_at` from the direct grant and route all lock
  writes through the server seam, or mirror the same predicate in RLS.
- **M2 (Medium)** — `/internal/images/{id}/status`'s credential check happens
  inside the handler, after `readBody()` — an anonymous caller can force up to
  ~20MB of buffering before being rejected. Bounded, but the same pre-auth-read
  pattern H2 fixed elsewhere. Fix: move the secret check into `route()` before
  body read, mirroring the other four routes.
- **M3 (Medium)** — `serverMain.ts` reads `jwtSecret` from
  `process.env.SUPABASE_JWT_SECRET` with no assertion it's set. If ever
  missing in a real deployment (failed secret rotation, an environment cloned
  without full parity), the server silently drops to the single static-token
  world with no error or warning. Fix: fail closed — refuse to start (or
  refuse authenticated routes) rather than silently downgrading.
- **L1 (Low)** — `sharp@0.34.4` has known libvips CVEs (fix at 0.35.3+).
  Exploit path narrowed by `format.ts`'s allow-list (only jpeg/png/webp/avif/
  heic reach the decoder), not eliminated. Cheap upgrade worth doing as
  defense-in-depth.
- **L2 (Low/informational)** — the image-status callback doesn't scope
  `optimized_url` to the trusted CDN origin; traced every render path and
  confirmed no XSS chains through it (consistently escaped), so this is
  hardening, not a demonstrated exploit.

**Confirmed closed from v1's Medium/Low list**: upload rate limiting is wired;
the shared-secret comparison is constant-time (`crypto.timingSafeEqual`),
used for both the legacy token and the callback secret.

---

## 5. Performance re-check (`bob-perf-analyst`, run fresh)

Method: real HTTP, real Postgres, real `sharp`/WASM-HEIC codec, real
photographic fixtures (genuine decoded photos, not synthetic/padded ones).
Apple M1 Pro, Node v26.5.1, Docker 28.4.0.

**Finding #5 — genuinely resolved.** Upload response time, real photos
6.6-18.4MB: **40-126ms**, regardless of size — the codec no longer blocks the
response (`uploadImage.ts` returns after storing the original; conversion is
fire-and-forget). Confirmed by reading the code and by measurement.

**Codec in isolation** (now free to run in Lambda's minutes-not-seconds
budget): worst case (36.2MP JPEG near the 20MB cap) ~1.1-1.3s; HEIC (real
HEVC, WASM-decoded) ~660-820ms. Nothing close to a sizing concern.

**Everything else measured comfortably passes** the proposed budgets: publish
handler warm p95 15.8ms; JWT verification ~0.04-0.15ms (found, but not
flagged as worth fixing: verified **twice** per request — once in `route()`'s
guard, again inside the handler — harmless at this cost); public-site render
max 26.8ms at 1000 articles (confirmed sanitization runs once per
article-detail render, not per listing row); draft creation/lock-heartbeat
warm p95 under 10ms.

**Not new, still true, still not urgent**: the published-articles listing
query still selects `body_html` and does category filtering in JS rather than
SQL — same O(archive-size) trend v1 flagged, still comfortably inside budget
at this scale.

---

## 6. Integration / e2e re-verification (real HTTP, real Postgres, outside Vitest)

Full method: fresh `npm test` (174/174 confirmed), then a hand-driven writer
journey via a real client against a real Testcontainers Postgres and
`router.ts`'s `startHttpServer()` — every step (create, lock contention,
upload-to-ready, publish, contract re-verification for all 5 operations)
passed, including confirming #6.4's fix byte-for-byte (published
`structured_data.image` matched the real stored `optimized_url` exactly).

**The highest-stakes single check** — the legacy static token against a
JWT-configured server — passed at the level this pass tested it (the
in-process boundary). It also **correctly flagged, mid-report, that a deeper
version of the same question was being fixed concurrently by Bob** (§2.2) and
declined to re-test against a moving target, recommending re-verification once
it landed — which §2.2/§3 above are that re-verification.

**New finding, from this pass's own adversarial testing, not previously
reported:** `router.ts`'s `readBody()` has no timeout. A request with a
declared `Content-Length` under the 20MB cap that never finishes sending its
body hangs the request indefinitely — reproduced directly (8+ seconds, no
response, socket had to be force-closed) and independently via a Schemathesis
run against `internal-openapi.yaml` (the one contract never fuzzed
provider-side by the regular suite) hitting its own 10-second client timeout
against the same route. Worst on `/internal/images/{id}/status` specifically,
since M2 above means **no credential of any kind is required** to reach the
hang point on that route — `publish`/`upload`/`create-draft`/`open` at least
require a request that passes the pre-body writer-auth check first. Plain
Node's default `requestTimeout` (300s) may eventually tear down the
connection — not independently confirmed in this pass — but the code sets no
explicit bound of its own, the same shape of gap finding #2 was written to
close for the other two DoS vectors. Recommended fix: an explicit read timeout
in `readBody()` (or `server.requestTimeout`/`headersTimeout` on the
`http.Server`), plus a regression test alongside `NFR-DOS-01`/`02` for
"declared-under-cap, body stalls, never completes."

**Secondary, unconfirmed observation**: every run in this pass emitted a
`DeprecationWarning` from an un-awaited `pool.on('connect', ...)` query
(`SET ROLE service_role`) racing whatever query triggered the connection.
A 12-way concurrent-request stress test did not reproduce a hang from this
alone — reported as a code-quality note worth a look, not a confirmed second
cause of the timeout finding above.

Full detail, every command, every response: `pdlc/arsene-cms/verify/integration-e2e-v2.md`.

---

## 7. Consolidated findings

| # | Severity | Area | Finding | Status |
|---|---|---|---|---|
| — | — | Auth | `verify()` fallthrough to static token when JWT configured but invalid | **Fixed this pass** (§2.1, commit `8d30acc`) |
| — | — | Auth | Real deployment boundary (`server.ts`) never forwarded `jwtSecret` to the spawned process | **Fixed this pass** (§2.2, commit `02a3f92`) |
| M1 | Medium | Data integrity | AC-05 draft lock stealable via direct PostgREST, bypassing the CAS | Open |
| M2 | Medium | Security | Image-status callback buffers body before checking its own secret | Open |
| M3 | Medium | Security | No fail-closed if `SUPABASE_JWT_SECRET` unset at runtime | Open |
| — | Medium | Availability | `readBody()` has no timeout — an incomplete body hangs the request indefinitely, worst on the credential-free internal route | Open |
| L1 | Low | Dependency | `sharp@0.34.4` has known CVEs, narrowed exposure, cheap upgrade available | Open |
| L2 | Low | Hardening | Callback's `optimized_url` not scoped to the trusted CDN origin | Open |
| — | Info | Perf | JWT verified twice per request — harmless, not worth fixing | Noted |
| — | Info | Code quality | Un-awaited `SET ROLE` query on pool connect — possibly racy, unconfirmed as a real bug | Noted |
| — | Info | Perf | Listing query still O(archive-size) — unchanged from v1, comfortably in budget | Noted |

## 8. Gate verdict

**NOT PASSED.** Every High-severity and functional-completeness finding from
v1 is genuinely closed, confirmed independently multiple ways, including two
further auth bugs Bob found and fixed during this pass that no automated test
had caught. What remains is four Medium findings — meaningfully lower stakes
than what blocked v1 (no unauthenticated data leak, no stored XSS, no
complete auth bypass for a stranger with no credentials at all except on one
narrow, arguably-not-publicly-reachable internal route) — plus two Low and
three informational notes. `state.json`'s `gates.verify` is left at
`"pending"`. Recommend a decision from the product owner: close all four
Mediums now in a third remediation pass, or accept some as documented,
lower-severity risk for John's pipeline gate to mitigate at the
infrastructure layer (e.g. a platform-level request timeout, a WAF) — but not
silently.
