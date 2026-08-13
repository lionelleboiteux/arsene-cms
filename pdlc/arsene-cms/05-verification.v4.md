# arsene-cms — Verify gate, fourth pass (v4)

**Status: NOT PASSED — no security or performance blocker, but one Medium
correctness finding (M-V4-01) recommended blocking for consistency with this
gate's own standard: an acceptance criterion (AC-08) that is green in CI and
does not work against real infrastructure, with no in-product recovery.**
**Run:** 2026-08-13, branch `feat/arsene-cms`, against commit `0a56ed4`
(green remediation v4: 200/200, closing H-V3-01, L-V3-02 and the HEIC decode
gap from `05-verification.v3.md`).
**Method:** `bob-security-auditor`, `bob-perf-analyst` and an integration/e2e
runner, run fresh and independently in parallel, each briefed to verify the
remediation adversarially and to specifically chase the `jwtIssuer`
configuration gap `04-green-evidence.v4.md` disclosed against itself. Plus an
instrumentation proof run by hand (Bob), against the real spawned server and
real Postgres.

---

## 0. Executive summary

- **H-V3-01 is genuinely, thoroughly closed.** The security auditor alone
  confirmed it with 72 requests across 18 hostile credential shapes on all
  four writer-facing operations, checking committed database state as well as
  the HTTP response so a guard that answers 401 only after a mutation already
  landed couldn't slip through. The e2e agent independently reconstructed the
  exact `05-verification.v3.md` §2 exploit and got the same result, plus
  ~25,400 cases of higher-depth contract fuzzing (finding nothing new on the
  four touched routes) and a 100-way concurrency stress test showing no
  starvation or race in the doubled `isWriter()` lookup.
- **L-V3-02 is closed**: `exp`/`aud`/`role` are unconditionally enforced;
  `iss` pinning works correctly over the real spawn boundary when configured
  (`jwtIssuer`), confirmed by both agents independently using a decoy-value
  technique that rules out coincidental behavior.
- **The `jwtIssuer` gap `04-green-evidence.v4.md` flagged against itself is
  resolved as a genuine, working control — not a repeat of the `jwtSecret`
  wiring bug from v2.** It is, honestly, still just a test-coverage gap (no
  committed test exercises it), and its opt-in status means every deployment
  path in this repo today still has `iss` unchecked — accurately described as
  a residual gap in the green-v4 evidence, not silently closed.
- **The HEIC fix is confirmed correct at the module level**: the perf agent
  proved the old and new import specifiers resolve to the identical module
  object under Vitest, so the fix changed only module resolution, not
  behavior or timing.
- **No new High findings from any agent.**
- **Two new Medium findings, both correctness/product-design, found by the
  security auditor's adversarial hunt for "the H-V3-01 shape elsewhere" (a
  valid credential being treated as sufficient authorization) rather than
  from anything this pass's diff introduced as a regression:**
  1. **M-V4-01**: a truncated image upload to an article that already has a
     live, `ready` cover demotes/blanks that cover on the public site and
     leaves a `failed` image row that writers have no way to delete —
     permanently blocking republication, defeating AC-08's documented
     recovery story. Pre-existing (not introduced by this pass), found only
     because this pass's adversarial testing tried it against a
     already-published article rather than a fresh draft.
  2. **M-V4-02**: `POST /v1/articles/{id}/images` doesn't check the draft
     lock the way `publish` does — a writer refused `409 DRAFT_LOCKED` on
     publish can still walk in through upload and replace the cover of a
     draft a colleague is actively editing.
- **Performance shows no regression.** The new `isWriter()` lookup — run
  twice per authenticated request (once in `route()`, once in the handler) —
  costs a measured +0.44 to +0.56ms per request against a <500ms warm p95
  publish-class budget (0.09-0.11% of budget). The perf agent explicitly
  recommends *against* the single-lookup optimization `04-green-evidence.v4.md`
  §7.4 floated, since it would trade away a real safety property (the two
  layers currently can't disagree, because they call the same function) for
  ~0.25ms on a budget with 493ms of headroom.
- **The instrumentation proof succeeds**: the legitimate-writer primary path
  still emits correct, correctly-attributed telemetry with the new
  authorization check in place, and — independently — a stranger's
  create-draft attempt is refused with zero rows actually created.
- A handful of Low/Info findings recorded below (§6), none blocking; several
  are the same "empty-string environment variable isn't treated as unset"
  trap that's now bitten three different config variables across three
  verify passes, still unfixed on the first two.

---

## 1. `bob check verify` — precondition

Fresh `npm test` at the start of this pass confirmed **200/200**, `tsc
--noEmit` clean, matching `04-green-evidence.v4.md`'s claim exactly. Correct
gate to run. (`state.json`'s `green.status` bookkeeping staleness, flagged at
v3 §1, remains unaddressed and is noted again — non-blocking.)

---

## 2. H-V3-01 — disposition: CLOSED, thoroughly re-proven

**Security auditor**, real spawned server, real Postgres, own JWT minting
(independent secret/issuer from the committed tests):

```
18 hostile credential shapes x 4 operations = 72 requests, every one 401 UNAUTHORIZED

  stranger UUID sub, no writers row              401 401 401 401
  sub not UUID-shaped ('not-a-writer-id')        401 401 401 401
  sub = an existing ARTICLE id (real UUID)       401 401 401 401
  sub = writer id with dashes stripped           401 401 401 401   <- pg-valid uuid, regex-invalid: fails CLOSED
  sub = writer id + trailing space / newline     401 401 401 401
  sub = "' or '1'='1"                            401 401 401 401
  sub = empty string / no sub claim              401 401 401 401
  role = 'anon' (the public anon key's shape)    401 401 401 401
  no role / no aud / aud='apikey' / no exp       401 401 401 401
  signed with the WRONG secret / alg=none        401 401 401 401
  no bearer at all                               401 401 401 401

World after all 72 requests, before anything legitimate had run:
  embargoed = {"status":"draft","slug":null,"published_at":null}   anon_can_read = 0
  live_images = [{"role":"cover","status":"ready","original_filename":"cover.jpg"}]
  article_count = 3        <- identical to baseline
```

Both-sides control: the registered writer's own token still gets
`201/200/200/201` on all four operations.

**e2e agent**, independently, reconstructing v3's exact exploit and adding a
100-way concurrency stress test:

```
stranger sub proven claim-valid first: {"valid":true,"writer_id":"d51c050b-..."}, zero rows in writers
all four operations -> 401; DB byte-identical before/after:
  no draft, no lock taken, article still draft/slug:null, 0 rows readable by anon,
  cover unchanged, no image row, no telemetry row

100 concurrent create-drafts on the now-doubled isWriter lookup: 96ms, all 201, no starvation
60 interleaved writer/stranger requests: exactly 30x201 / 30x401, exactly 30 rows written
19 hostile sub shapes (pg_sleep, drop table, newline-injection, 16KB header): all 401 or
  Node's own 431 header-size limit, never a 500 or 200; schema and writers table intact
```

**The legacy static-token branch — verified as correct, not just accepted.**
Both agents independently confirmed `writer_id` on that branch is
`opts.writerId` (deployment configuration, sourced from `argv`), with no
caller-controlled value reaching it — seven spoofing attempts (headers, body
fields, a real JWT presented in legacy mode) all resolved to the configured
identity, never an attacker-supplied one. `04-green-evidence.v4.md` §3.1's
reasoning holds.

**`unknownWriter()` is not load-bearing anywhere an attacker can reach.** In
JWT mode, `isWriter()` runs in `route()` and again in every handler; there is
no dispatch path that skips it. It is only reachable in legacy mode, which
guards a misconfigured deployment, not an attacker (see §7, I-V4-05, for a
related contract-test-harness observation).

---

## 3. L-V3-02 and the `jwtIssuer` gap — both CLOSED

`exp`/`aud`/`role` are unconditional per both agents' probes. `iss` pinning,
chased by both agents independently with a decoy technique (a *different*
`SUPABASE_JWT_ISSUER` set in the parent environment than the value passed via
`opts.jwtIssuer`):

```
security auditor:
  token iss = CORRECT (matches opts)   -> 201
  token iss = DECOY   (matches env)    -> 401
  token iss = a third project          -> 401
  token with NO iss claim              -> 401

e2e agent (independent):
  matching issuer -> 201, parent-env decoy -> 401, different project -> 401, no iss -> 401
```

Only the `opts`-configured value is accepted in both runs — genuine
end-to-end wiring, not accidental. **With no issuer configured (every
deployment path in this repo today), `iss` is unchecked** — both agents
confirmed this live and agree `04-green-evidence.v4.md` §7.5 describes it
accurately as an honest residual gap, not a misdescribed closure. Low
severity, unchanged from L-V3-02's own framing (only matters if the HS256
secret were shared/leaked across projects).

---

## 4. The HEIC fix — confirmed at the module level

Perf agent: under Vitest's resolver, the old (`libheif-js/wasm-bundle`) and
new (`libheif-js/wasm-bundle.js`) specifiers both resolve, and
`(await import(old)).default === (await import(new)).default` → **true** —
the identical module object. Decode timing on real HEVC bytes is unaffected
(3.0-3.1ms warm, both specifiers). The fix changed module resolution only, as
intended; nothing about codec behavior moved. (Plain-Node resolution of the
new specifier was independently confirmed three times across this pass: once
by Bob directly at green-v4 review, once by the security auditor, once by the
e2e agent reading the specifier out of the shipped source at probe time.)

---

## 5. Performance — no regression

Full detail: perf agent's report, folded in here.

### 5.1 The new `isWriter()` check's cost

In isolation (real Postgres, production-shaped pool, n=1000): `isWriter`'s
p50/p95 (0.247/0.491ms) are statistically indistinguishable from a bare
parameterized `select 1` (0.259/0.490ms) — the primary-key lookup itself
isn't measurable above round-trip noise, and doesn't change as the `writers`
table grows from 1 to 101 rows. The non-UUID guard is free (short-circuits
before Postgres).

End-to-end over HTTP, interleaved A/B against a throwaway no-lookup control
(same container, same run, alternating requests to cancel drift):

| Operation | With `isWriter()` | Without (control) | Δ p50 |
|---|---|---|---|
| create-draft (n=300/arm) | p50 2.67 / p95 4.43ms | p50 2.17 / p95 3.93ms | +0.503ms |
| open (n=300/arm) | p50 2.17 / p95 4.76ms | p50 1.70 / p95 3.08ms | +0.462ms |
| publish (n=180/arm) | p50 3.98 / p95 6.96ms | p50 3.43 / p95 5.58ms | +0.545ms |

**+0.44 to +0.56ms per request, twice per request as designed (once in
`route()`, once in the handler) — 0.09-0.11% of the <500ms warm p95 budget.**
Production extrapolation (flagged as extrapolation, not measured — no
deployed environment exists in this repo): at a plausible same-region 0.5-3ms
Postgres RTT, the cost becomes ~1-6ms, still ≤1.2% of budget.

**Explicitly recommended against**: the single-lookup optimization
`04-green-evidence.v4.md` §7.4 floated (passing `route()`'s verification
result into the handler instead of re-checking) — it would save ~0.25ms on a
budget with 493ms of headroom, in exchange for a real safety property (the
two layers currently cannot disagree, because they call the same function).

### 5.2 Existing budgets, re-confirmed with the extra round trip included

| Area | Budget | v3 | v4 | Verdict |
|---|---|---|---|---|
| Publish handler, warm | p95 < 500ms | 8.4-9.7ms | p50 3.78 / p95 6.83 / p99 14.31ms (n=300) | PASS, 1.4% of budget |
| Publish handler, cold | < 2s | 41.7-44.8ms | 42.5ms | PASS |
| Image conversion, near-cap | < 15s | 1.90s | 1.33-1.47s | PASS |
| Public render, N=1000 | < 200ms | 9.4-19.1ms | 5.66-9.88ms (home) | PASS, same O(archive) trend, still not urgent |
| Lock/heartbeat write | < 50ms | p50 0.80/p95 3.28ms | p50 0.33/p95 0.77ms | PASS |
| `open` over real HTTP | (publish class) | — | p50 1.78-1.91/p95 2.56-3.19ms | PASS |

No archive-size growth found in publish itself (flat across 0→300 published
articles; the pre-existing O(archive) trend lives only in `render.ts`,
unchanged, still flagged not urgent). One methodology note worth carrying
forward: a writer publishing after real idle time (not back-to-back warm
traffic) sees ~30-40ms (idle-socket/pool recovery, confirmed present in the
no-lookup control too, so not attributable to this pass) — still only ~8% of
budget, but a more honest description of what "warm p95" means for this
system's actual traffic pattern than the phrase usually implies. Not a
verdict-changing observation, recorded for whoever next revisits the budget
document.

`NFR-IMGCPU-01` (the known wall-clock flake) did not fire in any run either
subagent made, and passed in isolation at 215-222ms against its 1000ms
budget — consistent with prior passes' characterization as a concurrent-load
flake, not a real regression.

---

## 6. New findings

### M-V4-01 (Medium, recommended blocking) — a truncated cover upload permanently blocks republication and blanks a live article's cover

Found by the security auditor's adversarial hunt, not by anything this
pass's diff touched. Proven live against the real spawned server and real
Postgres:

```
live article, before:  [{"role":"cover","status":"ready","original_filename":"cover.jpg"}]
writer uploads truncated.jpg as cover      -> 201 {"status":"failed"}
after:  [{"role":"body","status":"ready","original_filename":"cover.jpg"},
         {"role":"cover","status":"failed","original_filename":"truncated.jpg"}]
public render pass now sees this live article's cover as: null
republish                                  -> 409 IMAGE_NOT_READY
a second writer uploads a GOOD replacement -> 201, converts to ready
after:  [..., {"role":"body","status":"failed","original_filename":"truncated.jpg"},
         {"role":"cover","status":"ready","original_filename":"good.jpg"}]
republish AGAIN                            -> 409 IMAGE_NOT_READY      <- still blocked
can authenticated delete the failed row?   -> NO (42501)
```

Root cause: `uploadImage.ts` demotes the current cover *before* checking
whether the new file is even decodable (`demoteCurrentCover()` runs ahead of
`isDamagedContainer()`), and `publishArticle.ts`'s readiness gate considers
*every* image on the article, including demoted/failed ones no longer
relevant to publication — with no grant letting a writer delete a failed row
to clear it. **AC-08's documented remedy ("the writer is told to replace it
and the publish endpoint refuses until they do") is proven not to work**:
replacing does not remove the blocking row. The live article silently loses
its public-facing cover in the meantime. Recovery today requires manual
`service_role` SQL.

Fix (two independent, small halves): reorder the demote-then-validate
sequence so a rejected file never touches the existing cover; and either
scope publish's readiness check to exclude `failed` rows that aren't the
current cover/body slot, or grant `authenticated` a scoped `delete` (with a
route) so a failed row is removable through the product.

**Why recommended blocking**: same shape as v3's HEIC finding — an
acceptance criterion green in CI, broken against real infrastructure, with no
test in the suite that happens to upload a corrupt file to an article that
already has a ready cover (which is why six green gates missed it).

### M-V4-02 (Medium) — upload doesn't check the draft lock; publish does

```
writer B opens the draft (takes the lock)      -> 200
writer A publishes it                          -> 409 DRAFT_LOCKED   (correctly refused)
writer A uploads a cover to the SAME draft     -> 201                (accepted — should also be refused)
```

`uploadImage.ts` never calls `evaluateLock`, unlike `publishArticle.ts`. A
writer explicitly refused on one route walks straight through another and
replaces the cover of a draft a colleague is actively editing — the same
concurrent-edit conflict class as the still-open M-V3-03, but inside the
server seam rather than a PostgREST bypass. Fix: call `evaluateLock` in
`handleUploadImage`, same `409 DRAFT_LOCKED` envelope.

### L-V4-01 (Low) — the idempotency store has no writer scoping

```
upload:  A sends Idempotency-Key "shared-idem-key-1", file from-A.jpg  -> 201, image X
         B sends the SAME key, file from-B.jpg                          -> 201, image X (A's)
         B receives A's response verbatim; B's file is silently discarded; no new row.
```

Keyed only on `${key}::${article_id}` with no `writer_id` component; the
contract declares the key as an arbitrary opaque string, not a UUID, so a
collision needs no attack — just two clients both choosing e.g. `"1"`.
Bounded by the "writers have equal rights" design (Low, not Medium), but the
concrete harm — silent data loss reported as `201 Created` — is real. Also
unbounded/unexpiring against the contract's stated 24h/5min windows. Fix: key
on `${writer_id}::${key}::${article_id}` with a TTL.

### L-V4-02 (Low, confirmed independently by both agents) — `SUPABASE_JWT_ISSUER=""` boots a server that authenticates nobody

Same shape as L-V3-01/N1 (the `SUPABASE_JWT_SECRET=""` trap), on the new
variable this pass added. `serverMain.ts` passes `''` through unchanged;
`jose` treats an empty string as a real `iss` constraint, so **every** real
token — including from a correctly-configured writer — gets 401, on a server
that started cleanly and passes health checks. Fails closed (availability,
not bypass), but this is now the **third** config variable in this codebase
with the identical empty-string trap, still unfixed on the first two. Fix:
`process.env.SUPABASE_JWT_ISSUER || undefined` in `serverMain.ts`, ideally
alongside the equivalent one-liner for `SUPABASE_JWT_SECRET` still open since
v3.

### I-V4-01 (Info, confirmed by both agents) — the spawned child inherits ambient environment for any unconfigured secret/issuer

`server.ts` spreads `...process.env` before applying `opts.*` overrides, so
with `opts.jwtIssuer` unset, a `SUPABASE_JWT_ISSUER` present in the parent
process's environment silently reaches the child. Correct-by-design for a
real deployment, but a trap for a future test that assumes "unset" means
"absent" — the same hazard applies to `jwtSecret`/`imageCallbackSecret`.
Worth a comment in `server.ts`.

### I-V4-02 (Info) — no way to revoke a writer

`isWriter()` answers "has a `writers` row ever existed", not "is currently
allowed" — a row can't be deleted once referenced by `telemetry_events`'
foreign key, and there's no `active`/`disabled` column. Off-boarding today
means deleting the Supabase Auth user and waiting out the token's lifetime
(up to 1h). Not urgent at 2-5 writers; worth a column in a future expand
migration.

### I-V4-03 (Info) — `set role service_role` is still fire-and-forget

Unchanged since it would have been observable at v2/v3 too, newly noted here:
the promise from `pool.on('connect', ...)`'s role-elevation query is
discarded. Fails closed by accident (an unhandled rejection under Node's
default terminates the process) rather than by design. An explicit `.catch()`
that logs and destroys the client would make the intent legible.

### I-V4-04 — the provider contract suite still never exercises the JWT auth path it should be testing

Both agents independently landed on this: `tests/contract/provider.schemathesis.test.ts`
runs only in legacy static-token mode with an unseeded configured `WRITER_ID`,
at a low example count. Two consequences worth recording together: (1) it
never fuzzes the JWT-mode authorization path this pass built, so a future
regression there wouldn't be caught by the highest-volume test in the suite;
(2) it's the concrete reason `unknownWriter()` still has a real caller today
(green v4 §3.2's inference was that this was surprising — it isn't, once the
harness's own configuration is read). Recommend at the next red gate: seed
`WRITER_ID`, add a JWT-mode provider run alongside the legacy one, and raise
the example count (both agents' higher-depth ad hoc runs found real bugs at
depth the committed suite's default never reaches — see N5/N5b, unchanged
from v3).

---

## 7. Instrumentation proof, fourth pass

Run by hand by Bob, real Postgres 16 (Testcontainers), real spawned server.
This pass touched every writer-facing route's auth check, so the primary
path was re-exercised specifically to confirm the new `isWriter()` lookup
doesn't silently break telemetry emission for a legitimate writer:

```
create response: 201 {"article_id":"ef4572eb-...","locked_by":"e3964b0e-..."}
upload response: 201
publish response: 200 {"article_id":"ef4572eb-...","status":"published", ...}

telemetry rows:
  {"event_type":"draft_started", "writer_id":"e3964b0e-...", "occurred_at":"...11:51:26.348Z"}
  {"event_type":"article_published", "writer_id":"e3964b0e-...", "occurred_at":"...11:51:26.503Z"}

HAND-COMPUTED time-to-publish = 0.0026 minutes
attributed writer_id correct: true

-- independently reconfirming H-V3-01 stays closed --
stranger create-draft: 401 UNAUTHORIZED
rows actually created by the stranger: 0 (expect 0)
```

Metric remains computable via the real primary path, attribution correct,
world-state matches the response for both the legitimate and the stranger
case. Counter-metric unchanged, still the documented honest gap from v1-v3.

---

## 8. Tooling — clean

- **semgrep** (217 rules over `src`/`db`/`scripts`, plus a separate run over
  `tests/` since semgrep's default ignore file silently excludes it): **0
  findings**, both runs.
- **gitleaks** (working tree + 16-commit history): all hits confirmed
  false-positive test fixtures or doc-comment text; no real secret in the
  tree or history.
- **`npm audit --omit=dev`**: **0 vulnerabilities.** Full audit unchanged in
  character from v1-v3 (dev-tooling only).
- **Full suite**: 200/200, confirmed by the security auditor's own run and
  by 4 fresh e2e-agent runs (26-31s each), `NFR-IMGCPU-01` never fired.
  `tsc --noEmit`: clean on the committed tree (one caveat: a concurrently-running
  perf agent's own throwaway `tests/perf/` directory was untracked and
  present mid-run in the shared worktree, briefly making `tsc`/`npm test`
  disagree with CI for anyone running them in that exact window — cleaned up
  by the agent itself before this document was written; `git status` is
  clean now, confirmed).
- **Contracts, both sides, at depth**: ~25,400 cases across four operations x
  three auth modes plus the internal contract (up from the committed suite's
  default of 5 examples/operation). Found only already-known, explicitly
  out-of-scope items (N5, N2 — unchanged from v3) — nothing new on any of the
  four routes this pass's auth-check change touched. Schemathesis itself
  flagged, unprompted, that all four operations returned only 401/403 under a
  stranger token across 944 cases — an independent corroboration of H-V3-01's
  closure from the fuzzer's own heuristics.

---

## 9. Still open from v3, confirmed unchanged (correctly out of scope this pass)

Verified by inspection by the security auditor, not re-litigated: M-V3-02
(heartbeat), M-V3-03 (lock bypass via direct PostgREST — note this is now a
close cousin of this pass's own M-V4-02), M-V3-04 (`CDN_ORIGIN` still
hardcoded — still bricks any real deployment of the image pipeline, still the
highest-priority item in the backlog), M-V3-05 (publish/telemetry
non-atomicity — the e2e agent traced its exact mechanism further this pass:
in legacy mode with an unseeded configured writer, publish answers 500 while
the article is genuinely live, because `ENSURE_DRAFT_STARTED_SQL` succeeds
off the article's own row while `recordTelemetry`'s FK violates and is lost —
the success metric's numerator silently disappears in exactly this case),
N1/L-V3-01, N2, N4, N5/N5b, I-V3-01, I-V3-02.

---

## 10. Gate verdict

**NOT PASSED**, on M-V4-01 alone, for consistency with this gate's own
standard set at v3.

Every targeted item this pass was scoped to — H-V3-01, L-V3-02, and the HEIC
decode gap — is genuinely, adversarially closed, confirmed independently
multiple ways by every agent involved, including the one gap
(`jwtIssuer`) `04-green-evidence.v4.md` flagged honestly against its own
work. No security finding blocks this gate. No performance finding blocks
this gate — the new authorization check's cost is negligible against budget,
and the perf agent's recommendation to leave the double-check as-is (rather
than "optimize" away a safety property for a fraction of a millisecond) is
worth taking.

What blocks is M-V4-01: an acceptance criterion (AC-08) whose documented
recovery story is proven not to work against real infrastructure, found only
because this pass's adversarial testing happened to try a corrupt upload
against an *already-published* article rather than a fresh draft — the same
shape of gap v3 blocked on for HEIC, and the same reason: real infrastructure
finds what unit tests aim at fakes don't.

**Recommended next cycle**: M-V4-01 (two small, independent fixes: reorder
demote-then-validate; either scope publish's readiness check past `failed`
rows or add a delete path) and M-V4-02 (one `evaluateLock` call in
`uploadImage.ts`) together, since both were found in the same pass and both
touch the upload handler. Then the v3 backlog, prioritizing M-V3-04 (still
the item most likely to brick a real deployment).
