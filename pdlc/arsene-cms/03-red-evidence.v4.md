# arsene-cms — Red gate, fourth remediation pass (v4)

> Gate 3 (red), run a fourth time. This document covers **only** the fourth
> remediation pass, for `05-verification.v3.md`'s two blocking findings:
> H-V3-01 (High — no writer-authorization check at all) and its two named
> hardening companions grouped in the same fix recommendation (L-V3-02 —
> `verifySupabaseJwt` requires neither `exp` nor `iss`/`aud`/`role`), plus the
> HEIC decode gap found independently by the perf-analyst during the v3
> re-check (§3 of the same document). Tests only — no production code was
> written, changed or deleted by this pass.
>
> Explicitly out of scope, per the verify report's own recommendation to
> prioritise: the five further Medium/Low/Info findings in
> `05-verification.v3.md` §6 (M-V3-02 through M-V3-05, N1-N6). Those are a
> separate pass.

**Status:** red | **Author:** Claude (Opus 5), written by `bob-test-author`
and completed by hand after two API-availability interruptions | **Date:**
2026-08-13 | **Branch:** `feat/arsene-cms` | **Baseline:** the green suite as
it stands on this branch — **185 tests, 185 passing, 28 files** (re-run in
full before this document was finalised; see §3).

---

## 0. What this pass had to cover, and what it produced

| Verify v3 finding | Severity | Tests added | New ids |
|---|---|---|---|
| H-V3-01 — no writer-authorization check on any of the four writer-facing operations | High | 8 | `NFR-AUTHZ-01a/01b/01c/01d`, `NFR-AUTHZ-02`, `NFR-AUTHZ-03`, `NFR-AUTHZ-04`, `NFR-AUTHZ-05` |
| L-V3-02 — `verifySupabaseJwt` requires neither `exp` nor `iss`/`aud`/`role` | Low, grouped with H-V3-01's fix | 5 | `NFR-JWT-07`, `NFR-JWT-08`, `NFR-JWT-09`, `NFR-JWT-10`, `NFR-JWT-11` |
| HEIC decode broken under plain Node (verify v3 §3) | Blocking, correctness | 2 | `VERIFY-HEIC-01`, `VERIFY-HEIC-02` / `AC-07` |

8 + 5 + 2 = **15**.

**15 new tests. 12 fail, each on exactly one honest assertion matching the
exploit or defect shape the verify pass proved.** 3 pass, and are meant to:
`NFR-AUTHZ-01a` (create-draft already 401s a stranger today, by the
foreign-key accident the verify report names — a real, if incidental,
control that a fix must not remove), `NFR-AUTHZ-02` (a real writer's own
token keeps working — the both-sides control on H-V3-01) and `NFR-JWT-11` (a
fully correct token is still accepted — the both-sides control on L-V3-02).
**All 185 previously-passing tests still pass**, and no existing test's
assertions were edited.

Test count: 185 → **200**. Test files: 28 → **31**.

---

## 1. The command, and its output

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
```

Tail of the run, verbatim:

```
 Test Files  3 failed | 28 passed (31)
      Tests  12 failed | 188 passed (200)
   Start at  12:24:19
   Duration  31.65s (transform 1.18s, setup 0ms, collect 9.14s, tests 145.24s, environment 7ms, prepare 2.28s)
```

200 = the 185 green-gate tests + 15 new. 188 passing = 185 baseline + the 3
new controls above, so nothing regressed. 3 failing files (all newly added:
`tests/e2e/writerAuthorization.test.ts`, `tests/unit/authClaims.test.ts`,
`tests/e2e/heicDeployedRuntime.test.ts`) — every failure in them is a new
test.

`npx tsc --noEmit` also runs clean (exit 0) with the new tests and their two
additive support-seam changes in place.

---

## 2. Every new test, with its result and its one reason for failing

### 2.1 `NFR-AUTHZ-*` — writer authorization (H-V3-01)

```
 × NFR-AUTHZ-01b: open refuses 401 UNAUTHORIZED a signature-valid Supabase JWT whose sub has no row in writers…
   → expected { status: 500, code: 'INTERNAL_ERROR' } to deeply equal { status: 401, code: 'UNAUTHORIZED' }
 × NFR-AUTHZ-01c: publish refuses 401 UNAUTHORIZED a signature-valid Supabase JWT whose sub has no row in writers…
   → expected { status: 500, code: 'INTERNAL_ERROR' } to deeply equal { status: 401, code: 'UNAUTHORIZED' }
 × NFR-AUTHZ-01d: upload refuses 401 UNAUTHORIZED a signature-valid Supabase JWT whose sub has no row in writers…
   → expected { status: 201, code: undefined } to deeply equal { status: 401, code: 'UNAUTHORIZED' }
 × NFR-AUTHZ-03: a signature-valid token whose sub is not even shaped like a writer id is refused 401…
   → expected { status: 500, code: 'INTERNAL_ERROR' } to deeply equal { status: 401, code: 'UNAUTHORIZED' }
 × NFR-AUTHZ-04: a stranger's publish leaves the embargoed draft unpublished and still invisible to the anon role…
   → expected { status: 'published', slug: 'confidentiel-brouillon-sous-embargo-impact',
                published_at: 2026-08-13T…, rows_the_public_role_can_read: 1 }
     to deeply equal { status: 'draft', slug: null, published_at: null, rows_the_public_role_can_read: 0 }
 × NFR-AUTHZ-05: a stranger's cover upload against a live article leaves that article's cover image exactly as it was…
   → expected [{ role: 'body', original_filename: 'cover.jpg' }, { role: 'cover', original_filename: 'evil.jpg' }]
     to deeply equal [{ role: 'cover', original_filename: 'cover.jpg' }]
 ✓ NFR-AUTHZ-01a: create-draft refuses 401 UNAUTHORIZED a signature-valid Supabase JWT whose sub has no row in writers…
 ✓ NFR-AUTHZ-02: a registered writer's own signed token still succeeds on all four writer-facing operations…
```

| Id | Failure | What it proves is missing |
|---|---|---|
| `NFR-AUTHZ-01b` | `500` instead of `401` | `open` has no authorization check at all; the request reaches far enough to hit an unhandled path and crash generically. |
| `NFR-AUTHZ-01c` | `500` instead of `401` | `publish` has no authorization check; worse, per `NFR-AUTHZ-04` below, the 500 is returned *after* the mutation already committed. |
| `NFR-AUTHZ-01d` | `201` instead of `401` | `upload` has no authorization check and no accidental FK to catch it either — a stranger's request simply succeeds. |
| `NFR-AUTHZ-03` | `500` instead of `401` on a `sub` that isn't even writer-id-shaped | Proves the "looks protected" routes (`create-draft`/`open`) are protected by a Postgres error code, not a decision about writers — a `sub` shaped so the FK can't produce `23503` slips past whatever accidental check exists and crashes instead. |
| `NFR-AUTHZ-04` | the embargoed draft is `published`, has a real `slug`/`published_at`, and one row is now visible to `anon` | The world actually changed: a status-only fix (return 401 without also preventing the write) would not make this pass. |
| `NFR-AUTHZ-05` | the live article now has two `cover`-shaped images: the original demoted to `body`, the attacker's `evil.jpg` now `cover` | Same shape: the defacement is a real committed write, not just a misleading response. |
| `NFR-AUTHZ-01a` (passes) | — | `create-draft` already answers `401` for a stranger today, via the foreign-key accident the verify report names. A fix must keep this working, not just add a new check that happens to agree with the old accident. |
| `NFR-AUTHZ-02` (passes) | — | A real writer's own token is unaffected today, and must stay unaffected — the both-sides control that stops "refuse everyone" from passing this file. |

### 2.2 `NFR-JWT-07` through `NFR-JWT-11` — claim validation (L-V3-02)

```
 × NFR-JWT-07: a correctly signed token carrying no exp claim at all… is refused, with no writer attributed
 × NFR-JWT-08: a token whose iss names a different Supabase project… is refused, with no writer attributed
 × NFR-JWT-09: a token whose aud is not this API at all is refused, with no writer attributed
 × NFR-JWT-10: a token whose role is anon rather than authenticated… is refused, with no writer attributed
   → (all four) expected { valid: true, writer_id: '<WRITER_A>' } to deeply equal { valid: false, writer_id: undefined }
 ✓ NFR-JWT-11: a fully Supabase-shaped token… is accepted, with writer_id taken from its sub claim
```

| Id | Failure | What it proves is missing |
|---|---|---|
| `NFR-JWT-07` | a token with no `exp` claim at all is accepted | `jose`'s `jwtVerify` only enforces `exp` when the claim is present; nothing in `verifySupabaseJwt` requires it, so a token that never expires is indistinguishable from a normal one. |
| `NFR-JWT-08` | a token whose `iss` names a different Supabase project is accepted | No `issuer` is passed to `jwtVerify` today, so `iss` is never checked — relevant if the signing secret were ever shared or leaked across projects. |
| `NFR-JWT-09` | a token whose `aud` is `apikey` (a real Supabase claim shape, just the wrong one) is accepted | No `audience` is passed to `jwtVerify` today. |
| `NFR-JWT-10` | a token whose `role` is `anon` — the exact claim shape carried by the project's own **public** anon key — is accepted | Nothing checks `role` at all; the anon key every editor SPA ships to the browser is a signature-valid, `sub`-bearing token by construction, so today it would be accepted as a writer credential if it reached this verifier. |
| `NFR-JWT-11` (passes) | — | The both-sides control: a token that is genuinely correct on every axis must still be accepted, with `writer_id` from `sub`, exactly as the six pre-existing `NFR-JWT-01`-`06` cases already prove for the axes they cover. |

### 2.3 `VERIFY-HEIC-01`/`02` — HEIC decode in the real runtime

```
 × VERIFY-HEIC-01: the libheif specifier src/images/heic.ts ships resolves under plain Node's ESM resolver…
   → expected { specifier: 'libheif-js/wasm-bundle', resolved_under_plain_node: true, module_not_found: false }
     to deeply equal (received) { …, resolved_under_plain_node: false, module_not_found: true }
 × VERIFY-HEIC-02 / AC-07: a real HEVC-compressed HEIC uploaded to the real spawned server is converted and its image row reaches ready…
   → expected { upload_status: 201, image_status: 'ready', failure_code: null }
     to deeply equal (received) { upload_status: 201, image_status: 'failed', failure_code: 'CORRUPTED_FILE' }
```

| Id | Failure | What it proves is missing |
|---|---|---|
| `VERIFY-HEIC-01` | a real `node -e` subprocess running the **exact** specifier read out of `src/images/heic.ts` at test time (not hardcoded — so a fix isn't graded against a stale string) throws `ERR_MODULE_NOT_FOUND` | `libheif-js/wasm-bundle` has no extension and `libheif-js@1.19.8` publishes no `exports` map; plain Node's ESM resolver, unlike Vite's, does not guess. This is the whole defect, isolated with no database, no server, no codec involved. |
| `VERIFY-HEIC-02` / `AC-07` | the real spawned server (`startServer`, not the in-process `startHttpServer()` shortcut `AC-07/D7-heic` in `lambdaImage.test.ts` uses) converts a real HEVC HEIC fixture and the row ends `status: 'failed', failure_code: 'CORRUPTED_FILE'` instead of `ready` | Confirms the import failure actually breaks the end-to-end path a writer depends on, not just the isolated specifier — and confirms it fails silently as a normal-looking `failed` image rather than a crash, exactly as `optimizeImageBuffer`'s `try`/`catch` was found to do. |

Nothing here is an import error, a missing fixture or a typo in the *new*
tests. Every failure is an assertion comparing a real observed value to the
required one, against real Postgres 16 (Testcontainers), real HTTP against
the real spawned child process, and — for `VERIFY-HEIC-01` — a real plain
`node` subprocess with no test-runner resolver involved.

---

## 3. The 185 baseline, re-confirmed

```
$ NO_COLOR=1 FORCE_COLOR=0 npx vitest run tests/e2e/writerAuthorization.test.ts tests/unit/authClaims.test.ts tests/e2e/heicDeployedRuntime.test.ts
 Test Files  3 failed (3)
      Tests  12 failed | 3 passed (15)
```

then the full suite together:

```
$ NO_COLOR=1 FORCE_COLOR=0 npm test
 Test Files  3 failed | 28 passed (31)
      Tests  12 failed | 188 passed (200)
```

188 = 185 (unchanged baseline) + 3 (the new controls, §2). `npx tsc --noEmit`
exits 0 with the new files and the two additive support-seam changes in
place.

**Note on `NFR-IMGCPU-01`**: this pre-existing test (a 1000ms wall-clock
budget assertion, `tests/unit/lambdaImage.test.ts`) was seen to fail once
during this pass under concurrent Docker/CPU load from other agents running
in parallel on the same machine (`verify/integration-e2e-v3.md` §"N6"
documents the same flake independently). Re-run in isolation, it measured
588ms, comfortably inside budget. Not treated as a red-gate finding — a known,
previously-documented flake in an unrelated pre-existing test, not something
this pass touched or caused.

---

## 4. What this pass touched, and why it is not an assertion change

| File | Change |
|---|---|
| `tests/e2e/writerAuthorization.test.ts` | **New file.** `NFR-AUTHZ-01a`-`05`. |
| `tests/unit/authClaims.test.ts` | **New file.** `NFR-JWT-07`-`11`. |
| `tests/e2e/heicDeployedRuntime.test.ts` | **New file.** `VERIFY-HEIC-01`/`02`. |
| `tests/support/jwt.ts` | **Additive only**: `MintOptions` gained `noExpiry`, `issuer`, `audience`, `role`, each defaulting to exactly what `mintSupabaseJwt` produced before this pass (`SUPABASE_ISSUER`, `'authenticated'` audience, `'authenticated'` role, a real `exp`). No existing call site's output changes shape — confirmed by the unchanged 185-test baseline, which includes every pre-existing caller of this function. |
| `tests/support/seams.ts` | **Additive only**: `AuthModule.verifySupabaseJwt`'s options gained an optional `issuer` field. The six pre-existing `NFR-JWT-01`-`06` cases in `tests/unit/auth.test.ts` call this seam with the same two required fields (`secret`, `now`) they always have, and pass unchanged. |
| `pdlc/arsene-cms/traceability.md` | New "Added by the fourth remediation pass (v4)" section, same format as the v2/v3 sections it follows. |

No file in `src/` or `db/` was touched. No existing test's assertions were
edited.

---

## 5. Process note: two interruptions during this pass

This pass was interrupted twice by transient infrastructure issues unrelated
to the work itself — once by a server-side API overload, once by a session
usage limit — after the test files themselves were written and an initial
suite run had been reported complete but not yet captured verbatim. The test
files, and the additive changes to `tests/support/jwt.ts`/`seams.ts`, were
confirmed intact and unmodified on resumption both times. §§1-3 above are a
fresh, complete re-run performed after the second interruption, not a
reconstruction — every command and every number in this document was
executed and captured in one continuous session. `traceability.md` and this
evidence document were completed in that same final session.

---

## 6. Gate statement

15 new tests, 12 failing, each on exactly one honest assertion against real
infrastructure (real Postgres, real spawned child processes, and — for the
HEIC specifier check — a real plain Node subprocess with no test-runner
resolver involved). 185 previously-passing tests still passing. No production
code written. Red.
