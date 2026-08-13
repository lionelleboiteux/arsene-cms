# arsene-cms — Verify gate, third pass (v3)

**Status: NOT PASSED — one High authorization finding, plus new correctness and
configuration findings surfaced by this pass's own adversarial testing.**
**Run:** 2026-08-13, branch `feat/arsene-cms`, against commit `f0c4f60`
(green remediation v3: 185/185, closing every M1-M3/L1/L2/timeout finding from
`05-verification.v2.md`).
**Method:** `bob-security-auditor`, `bob-perf-analyst` and an integration/e2e
runner, all run fresh and independently in parallel, each briefed to verify
the remediation rather than trust it and to specifically chase the two gaps
`04-green-evidence.v3.md` honestly flagged as untested. Plus an instrumentation
proof run by hand (Bob), against the real spawned server and real Postgres.

---

## 0. Executive summary

- **Every one of the five findings this pass was asked to close (M1, M2, M3,
  L1, L2) plus the unnamed `readBody()` timeout gap is genuinely closed**,
  confirmed independently by all three agents and by hand — not by trusting
  the green-v3 diff or its own evidence document.
- **Both gaps `04-green-evidence.v3.md` §8 flagged honestly against itself
  have been chased and resolved as non-issues**: `imageCallbackSecret`
  genuinely reaches the spawned child through `startServer()` (proven with a
  decoy-secret discriminator by the e2e agent and independently by Bob's own
  instrumentation script), and the read timeout genuinely fires on the real
  spawned server at 8.0-10.0s against a valid secret (proven three independent
  ways). `NFR-DOS-03`'s green result understates the truth — it's real, just
  proven for the wrong stated reason.
- **One new High finding stops the gate: H-V3-01.** Green v2's remediation
  moved every write behind a `service_role` seam to fix the original auth
  findings — but `service_role` bypasses RLS, which is exactly the mechanism
  `02-architecture.v1.md`'s threat model relied on for authorization. Nothing
  replaced it. Any holder of a Supabase-signed JWT with **no row in `writers`
  at all** can publish arbitrary drafts to the public site and deface the
  cover image of any published article — proven end to end against the real
  server and real Postgres, including a case where the mutation succeeded but
  the response was a 500, leaving **no audit trail**.
- **A second blocking correctness finding, independent of H-V3-01**: HEIC
  upload — a format the contract advertises and AC-07/D7-heic names
  explicitly — **fails for every HEIC file in the real deployed (plain Node)
  runtime**, while its own test passes, because `libheif-js`'s import
  specifier resolves under Vitest's resolver but not under plain Node. The
  same "test shortcut hides a real boundary bug" shape that closed H3 in v2.
- **Five further Medium findings**, three of them direct consequences of this
  pass's own fixes (a revoked grant silently removed ADR-0003's documented
  heartbeat mechanism; a hardcoded placeholder CDN origin is now a validation
  gate that would brick a real Lambda deployment; publish isn't atomic with
  its telemetry write), one a contract/implementation mismatch, one a
  pre-existing crash on malformed input surfaced by higher-depth fuzzing.
- **Performance is not a blocking concern**: every budget from v1/v2 passes
  with a large margin, and the `sharp` 0.34.4→0.35.3 bump is measured
  cost-and-output-neutral on identical inputs. One tension worth an explicit
  product decision, not a block: the new 8s read timeout narrows the
  tolerated sustained uplink for a cap-sized (20MB) upload from ~0.56 Mbit/s
  to ~21 Mbit/s, and is not tunable without a code change.
- **The instrumentation proof succeeds**: both required events are emitted
  from the real primary path (not the backfill), attributed correctly, and
  time-to-publish is genuinely computable by hand from the real store. The
  counter-metric remains honestly uncomputable, unchanged from v1/v2.

---

## 1. `bob check verify` — precondition

`state.json`'s recorded `green.status` is stale (still points at green v1),
but the actual gate history — `04-green-evidence.v1.md` → `05-verification.v1.md`
→ `03/04-*.v2.md` → `05-verification.v2.md` → `03/04-*.v3.md` — is unbroken,
and the code at `f0c4f60` is the real green-v3 state: fresh `npm test` at the
start of this pass confirmed **185/185**, `tsc --noEmit` clean. Correct gate
to run. (This staleness in `state.json` was flagged at the last `/john-status`
check and is a separate, non-blocking bookkeeping item — noted again here so
it isn't lost.)

---

## 2. STOP THE GATE — H-V3-01 (High)

**Any authenticated caller — not just a registered writer — can publish
arbitrary unpublished drafts to the public site and replace the cover image
of any published article. No check ties a valid JWT's `sub` claim to an
actual row in `writers`.**

Proven end to end by `bob-security-auditor` against the real spawned server
and a real Postgres, with a `sub` for a user who has no `writers` row at all:

```
stranger sub: d51c050b-6084-4815-bd36-e45ffe7f99b7 -> is a row in writers? false
POST /v1/articles (create draft) -> 401 "This account is not a registered writer."
POST /open                       -> 500 INTERNAL_ERROR
POST /publish                    -> 500 INTERNAL_ERROR
DB after stranger publish        -> {"status":"published","slug":"confidential-unpublished-draft",
                                     "published_at":"2026-08-13T07:50:58.339Z"}
what the anon (public) role now sees -> [{"title":"CONFIDENTIAL unpublished draft","body_html":"<p>secret</p>"}]

stranger uploads a cover to a PUBLISHED article -> 201 {"id":"327bc144-...","status":"processing",...}
images now: [{"role":"body",...,"original_filename":"c.jpg"},   <- the real cover, demoted
             {"role":"cover","status":"ready","original_filename":"evil.jpg"}]
```

**Root cause.** `db/migrations/0002_service_role.sql` (green v2) runs the
draft-creation/publish/upload seams as `service_role` (`bypassrls`) to close
finding #4's reachability gap. `02-architecture.v1.md` §7 names "Supabase
Auth for writers; RLS keyed on `auth.uid()` restricts all mutating operations
to authenticated writers" as the spoofing mitigation — that mitigation does
not apply to `service_role` code paths, and nothing replaced it at the
application layer. `verify()` (`src/api/router.ts:200-211`) returns
`{ valid: true, writer_id: jwt.sub }` for any signature-valid token; neither
`publishArticle.ts` nor `uploadImage.ts` checks `auth.writer_id` against
`writers`. The only thing that has been protecting `create-draft`/`open` is
an **accident**: both hit an FK violation on a writer-scoped column. Publish
and upload write no such column, so they succeed outright.

**Impact.** Information disclosure of embargoed drafts to the public
internet; defacement/tampering of live articles; and — because
`recordTelemetry` FK-violates for a non-writer, turning a successful publish
into a client-visible 500 (see M-V3-05) — **no audit row for the incident**.

**Exploit path.** Supabase projects allow self-service signup by default; the
editor SPA necessarily ships the project's public anon key. A stranger signs
up, receives a project-signed token with a `sub`, and calls Arsène's public
routes directly. Preconditions on the Supabase project's auth settings vary,
but the missing check itself is unconditional.

**Fix.** In `verify()` (or a shared guard early in `route()`), resolve
`jwt.sub` against `writers` and reject 401 with no row — the check
`handleCreateDraft` gets only by FK accident, applied deliberately to every
route. Add `iss`/`aud`/`role` validation as defense in depth (see L-V3-02).

**Gate verdict:** blocks. Not a regression from this pass's own changes to
M1-M3/L1/L2 — a pre-existing hole in the remediation architecture chosen at
green v2, invisible to static scanners, that neither v1 nor v2's verify pass
thought to check because the accidental FK protection made two of the four
affected routes *look* protected.

---

## 3. A second blocking finding, independent of H-V3-01: HEIC is broken in the deployed runtime

Found by `bob-perf-analyst` while re-measuring codec timing, not by looking
for it. `src/images/heic.ts`'s `await import('libheif-js/wasm-bundle')` has
no `exports` map in `libheif-js@1.19.8` and no extension; Vite's resolver
guesses `.js` in Vitest, but plain Node's ESM resolver does not — it throws
`ERR_MODULE_NOT_FOUND`, which `optimizeImageBuffer`'s `try/catch` swallows
and reports as `CORRUPTED_FILE`. Confirmed both ways:

```
$ npx vitest run tests/unit/lambdaImage.test.ts -t heic
  ✓ AC-07/D7-heic: a real HEVC-compressed HEIC ... converted   (1 passed)

end-to-end, real spawned server + real Postgres, real 12.2MP HEIC:
  upload response 201/processing in 23ms -> row "failed" after 74ms
  CORRUPTED_FILE: photo.heic passed format detection but could not be decoded.
```

Every other format (JPEG/PNG/WebP/AVIF) converts correctly on the same run.
Pre-existing since green v2 (`git log` puts the specifier at `8d30acc`,
unchanged since) — v2's "HEIC ~660-820ms" perf number never actually
exercised this path as plain Node runs it. **AC-07/D7-heic and deviation D7
are green in CI and dead in the shipped artifact.** Fix is one character
class: `import('libheif-js/wasm-bundle.js')` — confirmed to resolve under
plain Node v26 by the perf agent. Needs a regression test that runs outside
Vitest's module resolver (a spawned-`node` check, or driving the real e2e
upload path and asserting the row reaches `ready`, which is how this was
found).

**Gate verdict:** blocks, on correctness grounds — the same class of
verdict v1 gave AC-05's unreachable draft-creation gap.

---

## 4. Disposition of the five targeted findings — all CLOSED

Confirmed independently by at least two of the three agents, each tracing the
fix by hand against real infrastructure rather than trusting the diff.

| Finding | Verdict | Strongest evidence |
|---|---|---|
| M1 — lock theft via direct PostgREST | **CLOSED** | `authenticated` gets `42501` on 7 distinct attack shapes (steal, refresh, null, writable-CTE, mixed-column, delete, insert); `service_role`'s CAS still works and a 10-way concurrent race resolves to exactly 1×200/9×409 |
| M2 — callback body buffered before secret check | **CLOSED** | 401 after **65,536 of 8,388,608 declared bytes** (0.78%) on a real chunked socket, across 3 credential variants; correct secret still writes through |
| M3 — no fail-closed on missing `SUPABASE_JWT_SECRET` | **CLOSED**, correct polarity — see N1/L-V3-01 for a related config gap | 11 real spawns of `serverMain.ts`: missing/empty secret exits 78 with the right message in every variant tried (including case/value variants of the opt-in); `ALLOW_LEGACY_STATIC_AUTH=true` is the only value that starts |
| L1 — outdated `sharp` | **CLOSED** | `sharp@0.35.3`/libvips 8.18.3 confirmed installed, past the fix for the CVE that affected `<0.35.0`; `npm audit --omit=dev` → 0 (was 1 High) |
| L2 — unscoped `optimized_url` | **CLOSED**, genuine origin comparison | 9 origin-confusion cases (prefix, userinfo `@`, scheme downgrade, port, `javascript:`, non-URL, case-folding) all resolve correctly — 8 rejected 400, the one genuinely-same-origin case-folded host accepted |
| `readBody()` timeout | **CLOSED**, mechanism real even though `NFR-DOS-03` passes for the disclosed wrong reason | Real 408s at 8.0-10.0s on 3 independent probes (both subagents + Bob's own run), including the headers-never-complete variant nobody had tested; standalone Schemathesis against `internal-openapi.yaml`, which hung 171s before timing out at v2, now completes 956-1330 cases in under 5s |

---

## 5. The two flagged gaps — both resolved as non-issues

### 5.1 `imageCallbackSecret` spawn-forwarding — works correctly, not a repeat of the `jwtSecret` bug

Two independent proofs, both with a discriminator ruling out "it happened to
work by accident":

- **Bob's own instrumentation run** (§7 below): a wrong secret got 401; the
  configured secret got a real handler response (409 CONFLICT — the image
  was already `ready`), not 401 — proving the secret reached the handler and
  was compared correctly.
- **The e2e agent's decoy test**: set `process.env.IMAGE_CALLBACK_SECRET` to
  a *different* value in the parent process, configure `startServer()` with
  a distinct value via `opts`. The parent-env decoy is rejected (401); the
  `opts`-configured value succeeds (200, DB row flips to `ready`) — only
  possible if `startServer()`'s explicit forwarding, not env inheritance, is
  what won.

`src/api/server.ts:50-57` does forward `SUPABASE_JWT_SECRET`,
`IMAGE_CALLBACK_SECRET` and `ALLOW_LEGACY_STATIC_AUTH` through `env`. This
finding is now purely a **red-gate test-coverage gap** (no committed test
exercises this), not a security finding — worth a sibling test to
`VERIFY-03-DEPLOY-01` at the next red gate.

### 5.2 The read timeout behind a valid secret — fires for real

Three independent probes, all against the real spawned child (not the
in-process shortcut), all with a *valid* credential so the request doesn't
just fail fast on M2's guard:

```
callback route, VALID secret, 1MB declared, stalled -> 408 at 9793-9971ms
publish route,  VALID JWT,    1MB declared, stalled -> 408 at 8007-10002ms
upload route,   VALID JWT,   19MB declared, stalled -> 408 at 8007ms
headers never complete at all                       -> 408 at 8008ms
10 concurrent stalled connections                    -> all reclaimed within 10027ms, server healthy after
```

All inside the ~1.25× bound the `connectionsCheckingInterval = readTimeoutMs/4`
derivation predicts. `04-green-evidence.v3.md`'s own disclosure — that
`NFR-DOS-03` passes via M2's guard, not the timeout — is accurate; the
underlying mechanism is nonetheless real and independently confirmed three
times. Root cause of the test passing for the "wrong" reason, read directly:
`stallPost` in `tests/e2e/transportGuards.test.ts:358` takes no headers
parameter, so it can never send a valid secret. Same red-gate fix as before:
give that test a valid secret.

---

## 6. New findings, this pass

### M-V3-02 (Medium) — migration 0003 silently removed ADR-0003's documented heartbeat, with no replacement written down

`0003_lock_columns_service_role_only.sql` revokes `update (locked_by,
locked_at)` from `authenticated` (correctly, per M1) — but ADR-0003 specifies
the lock is refreshed by "a heartbeat write from the editor SPA roughly every
20 seconds", and `src/domain/lock.ts` still ships `HEARTBEAT_INTERVAL_MS =
20_000` for an SPA that would now get `42501` on every heartbeat attempt.
Demonstrated live: a writer holding a lock, with no way to refresh it,
silently loses it to a second writer 91 seconds later while still actively
editing — the exact concurrent-edit scenario ADR-0003 exists to prevent.
Mitigation exists (`POST /v1/articles/{id}/open` also refreshes
`locked_at`, and can serve as the heartbeat) but isn't written down anywhere.
**Fix: document that `/open` is now the heartbeat mechanism in ADR-0003 and
`02-architecture.v1.md`, or add an explicit heartbeat operation to the
contract — either way the (not-yet-built) SPA's design depends on which.**

### M-V3-03 (Medium) — the lock is closed against theft, not against bypass

A writer refused `409 DRAFT_LOCKED` can still write the article body directly
via PostgREST while the lock-holder is actively mid-session — `authenticated`
retains `update (body_html, title, ...)` under a `using (true) with check
(true)` RLS policy that doesn't reference the lock columns at all. Same
severity class as M1 (defeats ADR-0003's purpose), the larger half of the
same problem. Fix: route body writes through the seam, or mirror the lock
predicate in RLS (`locked_by is null or locked_by = auth.uid() or locked_at <
now() - interval '90 seconds'`).

### M-V3-04 (Medium) — `CDN_ORIGIN` is a hardcoded `.example` placeholder now used as a hard validation gate

L2's fix (correctly) turned `CDN_ORIGIN` into a strict origin check on
inbound callback data — but `CDN_ORIGIN` is a compile-time constant
(`https://cdn.fantasycoach.example`, a reserved TLD that can never be a real
CDN origin), not configuration, and nothing in `src/` reads it from the
environment. Confirmed independently by both the security auditor and the
e2e agent: a real Lambda deployment would have every callback rejected 400,
every image stuck `processing` forever, and every publish refused `409
IMAGE_NOT_READY` — a **total, silent functional outage** invisible to any
test in this repo, because the suite and the in-process storage stand-in
both already use the placeholder as the real value. **Fix: make `CDN_ORIGIN`
an environment variable, forwarded through `startServer`'s `env` alongside
the two secrets, fail closed if unset.** Flag to John's pipeline gate
regardless of whether it's fixed here.

### M-V3-05 (Medium) — publish is not atomic with its telemetry write

`handlePublishArticle` commits `markPublished` (a real UPDATE) before
`recordTelemetry` runs; a throw in the latter (observed directly in the
H-V3-01 probe, via an FK violation, but reachable from any transient
telemetry failure) is caught generically and answered 500 — while the
article is already live. The caller sees a failure and may retry; the world
already changed; the metric's numerator/denominator diverge from reality.
Fix: one transaction, or emit telemetry before responding and treat its own
failure as logged-non-fatal rather than a 500.

### N2 (Medium) — the internal contract disagrees with L2's implementation

`contracts/internal-openapi.yaml` declares `optimized_url` as any `format:
uri`; L2 narrowed the implementation to CDN-origin-only without updating the
contract. A fresh, higher-depth Schemathesis run (956-1330 cases, up from the
committed suite's default depth) surfaces this directly: `API rejected
schema-compliant request … must be a URL on https://cdn.fantasycoach.example`.
Contract and implementation must agree — update the schema (`format: uri,
pattern` anchored to the real CDN origin once M-V3-04 makes it configurable)
so a provider-contract fuzz run stops flagging correct behavior as a
violation.

### N5 (Medium, pre-existing, not introduced by this pass) — a NUL byte in `title` crashes `POST /v1/articles` with a 500

Found by the e2e agent's higher-depth Schemathesis run, minimized by hand to
`title` alone (`league_name`/`type_name` with the same input still 201; a
lone surrogate still 201). Root cause: Postgres itself refuses the byte
sequence (`SQLSTATE 22021`), and the error-mapping in `createDraft.ts`
handles only `23503` (the FK case), rethrowing everything else as a generic
500. Bounded (needs a valid writer credential, writes no partial row) but
violates the contract's own "always the `Error` envelope, branch on
`error.code`" discipline — a 400 `VALIDATION_FAILED` is what every other
malformed-input case in this codebase returns. Also flagging **N5b**: the
provider-contract test pins no seed and no explicit example count, so this
bug (and potentially others) passed silently through six green-gate runs and
4 of 5 fresh runs this pass purely by chance — recommend pinning a seed *and*
raising the per-operation example count at the next red gate, not pinning
alone (which would have permanently buried this one).

### N1 / L-V3-01 (Low, confirmed independently by both the security auditor and the e2e agent) — `SUPABASE_JWT_SECRET=""` plus the legacy opt-in boots a server that authenticates nobody

`serverMain.ts` passes an empty string through unchanged; `verify()`
branches on `!== undefined`, so `''` takes the JWT path (never the intended
legacy fallback) and jose refuses a zero-length HMAC key. Fails **closed**,
not open (explicitly checked: no forgeable token, `alg:none` refused) — so
this is availability, not a security bypass, but the failure mode is severe:
the server starts cleanly, health checks pass, and **every request 401s on
every credential**, with the operator's only guidance (the fail-closed
message) pointing them toward the exact setting that causes this. Direct
consequence of M3's own scenario (a half-completed secret rotation). One-line
fix: `process.env.SUPABASE_JWT_SECRET || undefined` in `serverMain.ts`, or
reject the empty-plus-opt-in combination explicitly at startup.

### L-V3-02 (Low) — `verifySupabaseJwt` doesn't require `exp`, `iss`, `aud`, or `role`

A token with no `exp` claim at all is accepted and never expires; any
`iss`/`aud`/`role` is accepted so long as the signature and `sub` verify.
Supabase always issues `exp`, so there's no exploit path on its own today —
but it's the hardening half of H-V3-01 and should land in the same change:
require `exp`, pin `issuer` to the project's `/auth/v1` URL, require
`role === 'authenticated'`.

### N4 (flagged, not a defect — a product decision, corroborating the perf agent's independent finding) — the 8s read timeout narrows tolerated upload bandwidth

Both the perf agent and the e2e agent independently measured and confirmed
the same effect from different angles: a legitimate, continuously-progressing
(never-stalled) upload can be cut off mid-transfer purely for arriving too
slowly. Perf agent's numbers: 20MiB now requires ≥21.0 Mbit/s sustained
(previously ≥0.56 Mbit/s under Node's 300s default) — a 37× narrowing, with a
non-deterministic 8-10s boundary band. E2e agent's throttled-rate probe
corroborates directly: a 6MB cover photo at 500KB/s (4 Mbit/s — an ordinary
4G/ADSL uplink) gets `408`; the same file at 1MB/s succeeds. **Not a code
bug** — `requestTimeout` is working exactly as documented, and closing v2's
stalled-body finding requires *some* bound — but it's a total-request
deadline where an inactivity timeout was the actual intent, it's not
configurable without a code change (`readTimeoutMs` isn't forwarded through
`startServer()` or env-readable), and it now measurably refuses ordinary
mobile-uplink photo uploads for a CMS whose writers photograph football
matches. **Recommend**: replace with `server.setTimeout()`/
`socket.setTimeout()` (an inactivity timer, which directly targets "a caller
must not park a connection cheaply" without penalizing a slow-but-progressing
upload) paired with a generous hard ceiling (60-120s). This is a product
trade-off, not something fixed unilaterally here.

### I-V3-01 (Info) — a whitespace-only `SUPABASE_JWT_SECRET` passes the fail-closed check
`'   '` starts normally; the check is `=== ''`, not trimmed. Requires an
operator to have set exactly this value; one-line fix if addressed alongside
L-V3-01/N1.

### I-V3-02 (Info) — no rate limit on draft creation or the image-status callback
Both require a credential first, so this is unlimited-row-creation by an
authenticated party, not an anonymous DoS vector. Not worth fixing at
2-5 writers.

### N6 / the suite is not reproducibly 185/185 under load (methodology finding, not a product defect)
The e2e agent's fresh runs were 3-of-5 clean; the other two failed
`NFR-IMGCPU-01` (a 1000ms wall-clock budget) at 1599-1992ms while other
verify-gate agents' Docker containers were running concurrently on the same
machine — in isolation the same code measures 457-495ms. Green v3's own
"six runs, all 185/185" claim doesn't hold under contention. Not a code
regression, but worth noting: a wall-clock performance assertion inside the
correctness test suite is exactly the kind of test that becomes flaky under
CI contention. Consider moving `NFR-IMGCPU-01` to the perf-analyst's
domain (a measured, reported number) rather than a hard pass/fail gate in
`npm test`.

---

## 7. Instrumentation proof, third pass — via the real primary path, plus the two-gap chase

Run by hand by Bob, real Postgres 16 (Testcontainers), real spawned server
(`server.ts`/`serverMain.ts`), real HTTP.

**Part A — the metric is genuinely computable via the real primary path:**

```
create response: 201 {"article_id":"ee8bcc67-...","locked_by":"e31933f1-..."}
draft_started row immediately after create:
  {"event_type":"draft_started","writer_id":"e31933f1-...","article_id":"ee8bcc67-...",
   "occurred_at":"2026-08-13T07:44:26.910Z","payload":{"started_at":"2026-08-13T07:44:26.910Z"}}

[real cover upload -> async pipeline -> row flips to ready]

publish response: 200 {"article_id":"ee8bcc67-...","status":"published", ...}

all telemetry rows for this article:
  {"event_type":"draft_started", ..., "occurred_at":"2026-08-13T07:44:26.910Z", ...}
  {"event_type":"article_published", ..., "occurred_at":"2026-08-13T07:44:27.102Z", ...}

HAND-COMPUTED time-to-publish = 0.0032 minutes
attributed writer_id (draft):   == seeded writer: true
attributed writer_id (publish): == seeded writer: true
```

(The duration here is trivially short because this run exercised the primary
path in real wall-clock time rather than backdating `created_at` — it proves
computability and correct attribution, not a realistic session length; v1's
proof used a backdated seed for that reason instead. Both are valid proofs of
different things and neither substitutes for the other.)

**Part B — the denominator stays honest:** a second draft published with no
cover was refused `400 COVER_IMAGE_REQUIRED`; querying `telemetry_events`
afterward returned zero rows for that article. A refusal doesn't inflate or
deflate a rate computed from these two events.

**Part C — the `imageCallbackSecret` gap, chased directly (see §5.1):** a
wrong secret against the real spawned child got 401; the configured secret
got a genuine handler response (409 CONFLICT, "already left processing" — the
image had already flipped `ready` via the async pipeline before this manual
call) — proof the secret reached and was checked by the handler, not
silently ignored the way `jwtSecret` was before `02a3f92`.

**Counter-metric**: unchanged from v1/v2, still correctly and honestly
uncomputable from any event this build emits, still the documented manual
proxy. Not re-litigated this pass.

---

## 8. Performance — not a blocking concern

Full detail: `pdlc/arsene-cms/verify/performance.md` (superseded in its
architecture description — the upload path is async since green v2 — but its
methodology and historical numbers remain the baseline) plus this pass's perf
agent report, folded in above (§3, §6 N4).

| Area | Budget | v1 | v2 | v3 | Verdict |
|---|---|---|---|---|---|
| Publish handler, warm | p95 < 500ms | 6.4ms | 15.8ms | 8.4-9.7ms | PASS |
| Publish handler, cold | < 2s | 47.3ms | — | 41.7-44.8ms | PASS |
| Image conversion, near-cap | < 15s | 9.1-10.6s (sync) | ~1.1-1.3s (async) | 1.90s warm avg | PASS |
| Upload response (async) | none set | n/a | 40-126ms | 12-142ms | PASS, no regression |
| Public render, N=1000 | < 200ms | 8.8ms | 26.8ms | 9.4-19.1ms (home) | PASS, same O(archive) trend, still not urgent |
| Lock/heartbeat write | < 50ms | 0.68ms | <10ms | p50 0.80/p95 3.28ms (1 outlier 56.5ms/100) | PASS |
| `sharp` 0.34.4→0.35.3 A/B, identical inputs | n/a | — | — | Δ within noise on 6/7 fixtures, output bytes identical | No regression |

The one item this table doesn't capture is N4 (§6) — not a budget miss, a
narrowing of tolerated upload bandwidth worth an explicit product decision.

---

## 9. Tooling — clean

- **semgrep** (2 independent ruleset combinations, 114+ rules): **0
  findings**, both runs.
- **gitleaks** (working tree + full 13-commit history): all hits confirmed
  false-positive test-fixture UUIDs or a doc filename matching a secret
  pattern; no real secret ever committed.
- **`npm audit --omit=dev`**: **0 vulnerabilities** (was 1 High at v2 —
  `sharp` bump confirmed effective). Full audit's remaining findings are all
  dev-only tooling, unchanged in character from v1/v2.
- **Full suite**: 185/185 confirmed at the start of this pass and by the
  security auditor's independent run; the e2e agent's 5 fresh runs were 3
  clean / 2 flaky under concurrent-agent load (§6 N6) plus 1 genuine bug find
  (N5) — not a suite-integrity problem, a suite-determinism gap (N5b).
- **`tsc --noEmit`**: clean.
- **Contracts, both sides**: consumer (`CONTRACT-COVERAGE` self-enforcing
  over all 4 declared operations) and provider (fuzzed at up to 40x the
  committed suite's depth: 956-1330 cases, only the pre-existing N5 and the
  contract/implementation mismatch N2 found — no crash, no hang, the
  previously-hanging internal-contract run now completes in under 5s).

---

## 10. Gate verdict

**NOT PASSED.**

The targeted remediation itself is good and is confirmed, independently and
by hand, to have worked: all five findings from `05-verification.v2.md` are
genuinely closed, and both gaps green v3 flagged against its own work came
back clean. That is exactly the discipline this gate process is designed to
reward, and it held.

What blocks this pass is two things neither v1 nor v2 thought to ask, found
only by this pass's own adversarial testing:

1. **H-V3-01**: green v2's fix for the *original* auth findings (routing
   writes through `service_role`) silently removed the application's only
   authorization check as a side effect, with no replacement. Any Supabase
   account — not just a writer — can publish embargoed drafts and deface live
   articles, with no audit trail on top.
2. **The HEIC decode gap (§3)**: an advertised, acceptance-criterion-named
   format has never worked in the actual deployed runtime, hidden by a test
   resolver that behaves differently from production Node.

Five further Medium findings and a handful of Low/Info items are recorded
above (§6) — none block on their own, but M-V3-02/03 both weaken ADR-0003's
locking guarantee in ways this pass's own fix (M1) didn't anticipate, and
M-V3-04 would cause a silent total outage of the image pipeline on first real
deployment if not addressed before John's pipeline gate.

**Recommended next step**: a fourth red/green remediation cycle scoped to
H-V3-01 (writer-authorization check + `iss`/`aud`/`role` validation), the
HEIC import fix, and — product owner's call on priority — the Medium
findings, particularly M-V3-04 (blocks any real deployment) and M-V3-02/03
(weakens the locking guarantee ADR-0003 exists for).
