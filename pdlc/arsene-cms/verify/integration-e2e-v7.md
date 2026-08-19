# arsene-cms — verify gate, seventh pass: integration / e2e

**Scope:** the integration/e2e leg of Bob's verify gate, seventh pass.
**Run:** 2026-08-19, worktree `arsene-cms+green-v3`, against commit `c0172f4`
("Pass green gate, remediation v7: 221/221, closes H-V6-01/M-V6-01 + M-V6-02").
**Target:** `05-verification.v6.md`'s two blocking findings, as closed by
`04-green-evidence.v7.md` — **H-V6-01/M-V6-01** (the cover-check unification,
one shared `usableCover(images)`) and **M-V6-02** (migration `0004`, revoking
`update (role) on article_images` from `authenticated`).
**Method:** full regression suite four times (three in the worktree, one against
a pristine `git archive HEAD` export), both contract sides, a standalone
higher-depth Schemathesis pass on the two touched operations, and hand-driven
adversarial re-verification against real Postgres 16 + real spawned
child-process servers + real multipart bytes + the real ADR-0004 status
callback. No file under `src/`, `db/`, `tests/` or `package.json` was modified.

---

## 0. Verdict

| Area | Verdict |
|---|---|
| H-V6-01 / M-V6-01 — the cover-check unification | **CLOSED.** Held under 91,737 swept state combinations and 7 hand-built real-infrastructure combinations of 3-4 rows |
| M-V6-02 — the `role` grant revocation | **CLOSED**, and it fails at the right place: the direct-grant write itself, `42501` |
| §6.1's acknowledged gap (no cover-selection route) | **Behaves exactly as the evidence doc claims.** Re-upload is genuinely the only path, and it behaves sanely |
| Remaining way to get a `200` publish with no usable cover | **None found.** See §2 for how hard this was looked for, and §5 for the single assumption it still rests on |
| **New: M-V7-01 (Medium)** | Concurrent cover uploads leave several rows in the cover slot, which can make an article **permanently unpublishable** |
| **New: M-V7-02 (Low)** | `04-green-evidence.v7.md` §6.3's claim that `0004` narrows L-V6-02 to "at most one row" is factually wrong |
| **New: I-V7-01 (Info)** | The one invariant the whole fix now rests on has no data-layer backing |
| **New: I-V7-02 (Info)** | A Schemathesis `ignored_auth` failure at depth is a harness artifact, not a defect |
| Workspace hygiene | **Broke `npx tsc --noEmit` again**, fourth consecutive pass |

**Nothing High-severity was found.** M-V7-01 is the only finding this pass
considers blocking-adjacent, and it fails *closed*.

---

## 1. Regression suite and types

`NO_COLOR=1 FORCE_COLOR=0 npm test`, four times.

```
run 1  (worktree)   Test Files  37 passed (37)   Tests  221 passed (221)   Start at 08:36:35   44.64s
run 2  (worktree)   Test Files  37 passed (37)   Tests  221 passed (221)   Start at 08:37:33   EXIT=0
run 3  (worktree)   Test Files  37 passed (37)   Tests  221 passed (221)   Start at 08:38:11   EXIT=0
run 4  (pristine)   Test Files  37 passed (37)   Tests  221 passed (221)   EXIT=0
```

Run 4 was executed against `/tmp/v7-pristine`, a `git archive HEAD | tar -x`
export with `node_modules` symlinked in — specifically to rule out worktree
contamination (§8).

**`NFR-IMGCPU-01` did not flake in any of the four runs**, so no re-run
allowance was spent:

```
run 1: ✓ NFR-IMGCPU-01 ... 712ms
run 2: ✓ NFR-IMGCPU-01 ... 698ms
run 3: ✓ NFR-IMGCPU-01 ... 1079ms
run 4: ✓ NFR-IMGCPU-01 ... 722ms
```

`npx tsc --noEmit` in the worktree: **exit 2, 7 errors**, all in
`tests/perf/usableCover.perf.test.ts`, an untracked file belonging to a
concurrently-running perf agent (§8). Against the pristine export:

```
$ cd /tmp/v7-pristine && npx tsc --noEmit
PRISTINE_TSC_EXIT=0
```

The committed tree types cleanly.

---

## 2. H-V6-01 / M-V6-01 — the cover-check unification: **CLOSED**

### 2.1 The original exploit, reconstructed

Real Postgres, real spawned server, real truncated JPEG bytes through the real
multipart route (`verify-scratch/realInfra.test.ts`, case A1):

```json
{
  "before": { "status": 400, "code": "COVER_IMAGE_REQUIRED" },
  "up":     { "status": 201, "said": "failed" },
  "after":  { "status": 400, "code": "COVER_IMAGE_REQUIRED" },
  "state":  { "status": "draft" },
  "published_events": 0
}
```

The v6 trace was `400 → upload → 200 (WRONG)`. It is now `400 → upload → 400`,
the article stays a draft, and — checked from the `telemetry_events` table
rather than from the response — **no `article_published` row is written at
all**, closing the "telemetry records it as a normal success" half of the e2e
agent's High argument at v6.

### 2.2 Beyond the committed four: 91,737 swept combinations

`NFR-COVER-INVARIANT-01` sweeps 4 combinations. This pass swept the whole
`images` state space at the handler level (`verify-scratch/invariantSweep.test.ts`),
with each row drawn from `role × status × original_url × optimized_url ×
supersedes-pointer` and the invariant recomputed independently of the
production predicate:

| Sweep | Evaluated | Answered `200` | Violations in DB-**reachable** states | Violations only in unreachable states |
|---|---|---|---|---|
| n = 0,1,2 exhaustive | 11,737 | 786 | **0** | 262 |
| n = 3,4 randomised | 80,000 | 7,014 | **0** | 2,390 |

The asserted invariant is stronger than the committed one — not merely
"non-empty cover" but: *a `200` implies a row with `role='cover'`,
`original_url != null`, superseded by nobody, `status='ready'`, non-empty
`optimized_url`, and `cover_image_url` is exactly that row's `optimized_url`.*

**Every one of the 2,652 violations has the same single shape**, and it is the
same shape in all of them:

```json
{
  "kind": "200 with an empty cover_image_url",
  "images": [{
    "role": "cover", "status": "ready",
    "original_url": "https://projectref.supabase.co/storage/orig",
    "optimized_url": null, "replaced_cover_image_id": null
  }],
  "status": 200, "cover": ""
}
```

A `ready` cover row whose `optimized_url` is `null` or `''`. That is precisely
— and only — the state `04-green-evidence.v7.md` §2.1 argues is unreachable and
§4.2 honestly flags as "still an argument, and the thing I would attack first
if I were the verify pass". So the sweep does not find a bug; it *locates the
entire remaining risk surface at one state*, which is what §5 then attacks.

### 2.3 Real infrastructure, 3-4 rows, mixed states

Seven combinations the committed sweep does not contain, each built through the
real routes and the real ADR-0004 callback (case A2). Every one satisfied the
invariant, and — the both-sides half — nothing that should have published was
refused:

| Combination | Rows | Publish | Cover |
|---|---|---|---|
| three rejected covers | 3 | `400 COVER_IMAGE_REQUIRED` | — |
| two rejected covers + a rejected body | 3 | `400 COVER_IMAGE_REQUIRED` | — |
| rejected cover + async-failed **adopted** cover | 2 | `409 IMAGE_NOT_READY` | — |
| rejected cover + superseded-then-async-failed cover + real cover | 3 | `200` | the real cover's CDN URL |
| ready cover + two rejected covers + broken body | 4 | `200` | the ready cover's URL |
| ready cover with `alt_text` tampered via the surviving grant | 1 | `200` | the ready cover's URL |
| ready cover + adopted async-failed body image | 2 | `409 IMAGE_NOT_READY` | — |

The third and fourth rows are the interesting pair: the *same* async-failed
adopted cover blocks when nothing superseded it and correctly stops blocking
once a real replacement recorded it as superseded (M-V5-02's shape), which is
the discrimination the whole `articleDependsOn` design exists to make.

The `alt_text` case is worth a line: the write **succeeded** (`sqlstate: null` —
AC-15 is intact), and it changed nothing observable, because
`src/site/render.ts`'s `PUBLISHED_ARTICLES_SQL` never selects `alt_text` and no
render path reads it. This corroborates v6's I-V6-01 from a second direction:
the one `article_images` column a writer can still write has no rendering path
either.

---

## 3. M-V6-02 — the grant revocation: **CLOSED, and it fails in the right place**

### 3.1 The exact `05-verification.v6.md` §3 sequence (case B1)

```json
{
  "control": { "status": 409, "code": "IMAGE_NOT_READY" },
  "vacate":  "42501",
  "occupy":  "42501",
  "rowsAfterExploit": [
    { "role": "cover", "status": "ready",  "adopted": true },
    { "role": "body",  "status": "failed", "adopted": true }
  ],
  "after":   { "status": 409, "code": "IMAGE_NOT_READY" },
  "state":   { "status": "draft" }
}
```

The brief asked specifically *where* it now fails. **It fails at step one.**
`update article_images set role='body' where id = A`, run as `authenticated`
exactly as PostgREST would, returns Postgres `42501` (`insufficient_privilege`)
— not a zero-row update, not a later-stage refusal. The second step fails the
same way, both rows keep their roles, and after the replacement cover upload the
publish is still `409 IMAGE_NOT_READY` because `B` goes on blocking. The article
stays a draft.

### 3.2 The revoke is not over-broad (cases B2, B3)

The legitimate path, run twice end to end over real HTTP:

```json
{
  "first":  { "status": 201, "settled": "ready" },
  "p1":     { "status": 200, "cover": ".../4e1c18b5-...-optimized.webp" },
  "second": { "status": 201, "settled": "ready", "replaced": "4e1c18b5-..." },
  "p2":     { "status": 200, "cover": ".../a792c84c-...-optimized.webp" }
}
```

The second upload demoted the first **server-side**, recorded it as superseded,
and the new cover reached the public structured data — with no `role` grant
involved anywhere. This is the flow every acceptance criterion uses, and it is
unaffected.

The full column matrix as `authenticated`, and the grants read back from
`information_schema.column_privileges`:

```json
{
  "alt_text": null,          "role": "42501",
  "status": "42501",         "optimized_url": "42501",
  "original_url": "42501",   "original_filename": "42501",
  "failure_code": "42501",   "replaced_cover_image_id": "42501",
  "article_id": "42501",     "created_at": "42501"
}
UPDATE-able columns for `authenticated` on article_images: ["alt_text"]
```

`alt_text` is the only writable column left, which is exactly the narrowness
`04-green-evidence.v7.md` §2.3 claimed and `AC-15` depends on. Additionally
confirmed in A3: `authenticated` has **no `insert` and no `delete`** on
`article_images` either (`42501` both).

### 3.3 An unclaimed benefit of the revoke (case C3)

After a legitimate publish, six tamper vectors against the live article's
cover, all as `authenticated`:

```json
{ "role_to_body": "42501", "status_to_failed": "42501", "blank_url": "42501",
  "delete_cover": "42501", "article_structured_data": "42501",
  "article_status": "42501" }
```

Worth recording because the committed `coverImageInvariant.test.ts` fixture
`live_article` is seeded into the state "already live, cover moved out of the
cover slot" with the comment that this is "the one thing `authenticated` may
write directly". **After `0004` that state is no longer writer-reachable at
all.** The fixture is still a valid state to test (a service-role path could
produce it); its stated provenance is now out of date.

---

## 4. §6.1's acknowledged gap — behaves as the evidence doc claims (case C1)

```json
{
  "noCover":   { "status": 400, "code": "COVER_IMAGE_REQUIRED" },
  "flip":      "42501",
  "dup":       { "status": 201, "replaced": null, "settled": "ready" },
  "published": { "status": 200, "cover": ".../a1d42860-...-optimized.webp" },
  "rows": [
    { "role": "body",  "status": "ready", "replaced_cover_image_id": null },
    { "role": "cover", "status": "ready", "replaced_cover_image_id": null }
  ]
}
```

- **Is re-uploading really the only path?** Yes. The direct `role` flip is
  `42501`; no route in the contract accepts a `role` change on an existing
  image (`uploadArticleImage` is the only operation carrying `role`, and it
  creates a row); `demoteCurrentCover()` is the only server-side writer of
  `role` and it only ever demotes.
- **Does uploading a duplicate of an already-stored body image behave sanely?**
  Yes. It creates a second row, converts normally, correctly reports
  `replaced_cover_image_id: null` (there was no previous cover to demote), and
  publishes carrying the new row's URL. The original body row is untouched —
  still `role='body'`, still `ready` — and does not block. The only cost is a
  duplicated stored asset, which is a storage-bill question, not a correctness
  one.

Nothing subtly broken here. `04-green-evidence.v7.md` §6.1's description is
accurate, and the regression it declares is a genuine but bounded product
regression, correctly recorded as open rather than closed.

---

## 5. The one assumption the fix rests on — attacked, and it holds (case A3)

§2.2 reduced the entire remaining risk to a single state: a `ready` cover row
with a null or empty `optimized_url`. Attacked from every direction that
exists.

Through the real ADR-0004 callback route, carrying the real shared secret:

```json
{ "empty_string": 400, "null_url": 400, "absent_url": 400,
  "foreign_origin": 400, "suffix_confusion": 400 }
```

(`suffix_confusion` is `https://cdn.fantasycoach.example.evil.test/x.webp` —
still refused, so `isCdnUrl`'s real origin comparison holds.)

Directly, as `authenticated`:

```json
{ "status": "42501", "optimized_url": "42501", "original_url": "42501",
  "replaced_cover_image_id": "42501", "insert_row": "42501", "delete_row": "42501" }
```

The row was still `processing` with `optimized_url: null` afterwards. **No
reachable path to the state exists**, which is why the sweep's 2,652 violations
are all in unreachable territory.

### I-V7-01 (Info) — but nothing in the data layer says so

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'article_images'::regclass and contype = 'c';
```

```
article_images_role_check    CHECK (role = ANY (ARRAY['cover','body']))
article_images_status_check  CHECK (status = ANY (ARRAY['processing','ready','failed']))
```

There is no constraint expressing `status = 'ready' ⇒ optimized_url is not null
and <> ''`. That rule lives in exactly one place: a zod refinement
(`imageStatusBody`) in `router.ts`. `handleImageStatusCallback` itself does
`optimized_url: req.body.optimized_url ?? null` with no check, so any future
caller that reaches the handler without the router — or any future `set role
service_role` path — writes the state unchallenged.

This is **defence in depth, not an exploit**: no writer-reachable path exists
today, and this pass proved that live. But it is the *single* assumption the
whole H-V6-01 fix now rests on, in a fix family where "unreachable" has already
been disproved twice. The project's own precedent argues for closing it — the
sentence `04-green-evidence.v3.md` §5.1 wrote and `04-green-evidence.v7.md`
§2.3 quotes approvingly: *"the application-level CAS is only a lock if the data
layer agrees it is."* Migrations `0003` and `0004` both exist because of it. A
one-line expand-only `check` would make all 2,652 swept violations structurally
impossible rather than argued-impossible.

---

## 6. NEW — M-V7-01 (Medium): concurrent cover uploads can make an article permanently unpublishable

**This is the one genuinely new defect this pass found.** It is not in the fix
family v7 targeted, it was not introduced by v7, and it does **not** violate the
cover invariant — but it is the same defect *class* the `articleDependsOn`
doc-comment says the design exists to prevent, reached through a different door.

### 6.1 Two concurrent cover uploads always leave two rows in the cover slot

`uploadImage.ts` does `demoteCurrentCover()` and then `insertImage()` as two
separate, unsynchronised statements — no transaction, no lock. The second
upload's demote runs before the first upload's insert, finds nothing to demote,
and returns `null`. Both rows are then inserted with `role='cover'`.

Case D4, two concurrent `POST .../images` with `role=cover` on a **fresh draft
with no cover at all**, eight rounds:

```
rounds_leaving_more_than_one_cover_row: 8 / 8   (cover_rows: 2 every round)
```

Case C2, four concurrent uploads onto an article that already had a cover:

```
cover_rows: 4,  ready_cover_rows: 4
uploads: [ {replaced: null}, {replaced: null}, {replaced: null}, {replaced: <the seeded cover>} ]
```

Not a narrow race — deterministic under any real concurrency. The trigger is
ordinary: a writer selecting two cover files, an editor SPA retrying a slow
upload with a fresh idempotency key, or two browser tabs.

### 6.2 The consequence: an article no upload can ever un-block

If one of the co-resident cover rows later fails conversion — an entirely
ordinary production event — the next cover upload's
`update … where role='cover' returning id` demotes **all** the co-resident rows
but records only **one** of them in `replaced_cover_image_id`. The failed row is
left `role='body'`, adopted (`original_url` present), and named by nobody. That
satisfies `articleDependsOn()` while `status !== 'ready'`, so the readiness gate
answers `409 IMAGE_NOT_READY` — and nothing can ever change that.

Case D2 hit it by chance (1 of 6 rounds, over real HTTP with the real callback).
Case D3 constructs it deterministically and then tries the documented recovery
five times:

```json
{
  "initial": { "status": 409, "code": "IMAGE_NOT_READY" },
  "recoveries": [
    { "attempt": 1, "replaced": "c9c94dbc-...", "publish": { "status": 409, "code": "IMAGE_NOT_READY" } },
    { "attempt": 2, "replaced": "a79e8412-...", "publish": { "status": 409, "code": "IMAGE_NOT_READY" } },
    { "attempt": 3, "replaced": "4e47e229-...", "publish": { "status": 409, "code": "IMAGE_NOT_READY" } },
    { "attempt": 4, "replaced": "8c3091a4-...", "publish": { "status": 409, "code": "IMAGE_NOT_READY" } },
    { "attempt": 5, "replaced": "a2d871e9-...", "publish": { "status": 409, "code": "IMAGE_NOT_READY" } }
  ],
  "broken_still_blocks": true
}
```

Five consecutive good cover uploads, each converting to `ready`, each correctly
demoting and recording *the previous cover* — and the orphaned broken row
`bd3e6e68` sits there through all of it as `role='body'`, `status='failed'`,
`adopted: true`, `replaced_cover_image_id` referenced by nobody.

**Recovery is impossible through any product route**, all confirmed live in
§3.2/§5: no `delete` grant, no grant on `role`, `status`, `original_url` or
`replaced_cover_image_id`, and `demoteCurrentCover()` only ever matches
`role='cover'` rows — which this one no longer is. The article is permanently
unpublishable and the writer has no action available.

### 6.3 Severity

**Medium.** It fails *closed*: no attacker, no credential, no data exposure, no
publish-with-no-cover. What it costs is one article, permanently, with a
`409` the writer cannot act on. That is the same severity class M-V4-01 and
M-V5-01 carried, and the same failure mode `articleDependsOn`'s own comment
names as the thing it exists to prevent:

> *"No writer can delete a row … so a row the article does not depend on would
> otherwise block republication permanently: M-V4-01, and M-V5-01 for the same
> trap on the `body` slot."*

Two obvious shapes for a fix, neither prescribed: make
`demoteCurrentCover()` + `insertImage()` one transaction (or take a per-article
advisory lock) so the cover slot can only ever hold one row; and/or have the
demote record supersession on *every* row it demotes rather than only the one
`returning id` yields.

---

## 7. NEW — M-V7-02 (Low): green v7 §6.3's narrowing claim is wrong

`04-green-evidence.v7.md` §6.3 says of L-V6-02:

> *"They agree for every state the product can now produce — a superseded row
> has had its `role` set to `'body'` by the demote, and with `0004` in place a
> writer can no longer put it back, **so at most one row can satisfy either
> predicate.**"*

Case D1 produced **six simultaneous `role='cover'`, `status='ready'` rows** via
six concurrent uploads, with no direct database access:

```json
{ "simultaneous_ready_cover_rows": 6,
  "publish_baked_into_structured_data": ".../0a238880-...-optimized.webp",
  "public_page_og_image":              ".../0a238880-...-optimized.webp",
  "they_agree": true }
```

The premise is false. In this particular run the two unordered picks
(`publishNow()`'s `.find()` and `render.ts`'s `limit 1` with no `order by`)
happened to select the same row, so the symptom did not manifest — but the
precondition L-V6-02 needs is proven reachable through ordinary product calls.
`0004` did not narrow L-V6-02; M-V7-01's fix would.

Recorded in the same spirit v6 struck "non-deterministic" from the record: the
finding is not new, the correction to the claim about it is.

---

## 8. Contracts — both sides, and one harness artifact

Both sides run inside the committed suite and were green in all four runs:
`tests/contract/consumer.prism.test.ts` (13 Prism consumer tests, including
`CONTRACT-COVERAGE`), `tests/contract/pronos-fixtures.prism.test.ts` (4), and
`tests/contract/provider.schemathesis.test.ts` (4 Schemathesis provider tests).

Standalone higher-depth pass on the two operations this remediation touched:

```
E-publishArticle     exit=0   2055 generated, 2055 passed   (27.28s fuzzing)
E-uploadArticleImage exit=0   2031 generated, 2031 passed   (26.45s fuzzing)
```

**4,086 generated cases, zero failures** — including `uploadArticleImage`,
which is the only operation in the contract that carries `role`. The grant
revocation surfaces nowhere client-visible that the committed suite misses; the
contract never exposed a `role`-mutation operation, only prose (which §5 of the
green doc updated).

### I-V7-02 (Info) — a Schemathesis failure that is not a defect

At `--max-examples 500`, `createDraft` fails:

```
❌ API accepts requests without authentication
   Expected 401, got `201 Created` for `POST /v1/articles`
   Failures: API accepts requests without authentication: 1
   34 generated, 1 found 1 unique failures
```

Checked by hand against the same spawned server rather than believed:

```json
{ "none": 401, "empty": 401, "bearer_empty": 401, "wrong": 401, "right": 201 }
```

The server refuses unauthenticated `POST /v1/articles` correctly in every
shape. The check misfires because the harness injects credentials with
`--header authorization:…` rather than through the schema's declared security
scheme, so Schemathesis's `ignored_auth` check believes it stripped auth when it
did not. The committed suite runs `--max-examples 5` and never reaches the
check. Recorded so the next pass does not spend time on it — and because it is
a real (if small) limitation of `tests/support/schemathesis.ts`'s header
injection.

---

## 9. Workspace hygiene — fourth consecutive pass, and it broke a gate command again

`05-verification.v4.md` §8/I-V4-04, `v5` §7 and `v6` §9 all recorded this.
It happened again, mid-run, and again it was not merely a risk:

```
$ git status --short
?? tests/perf/

$ ls tests/perf/
migrationPlan.perf.test.ts   usableCover.perf.test.ts

$ npx tsc --noEmit
tests/perf/usableCover.perf.test.ts(41,38): error TS2532: Object is possibly 'undefined'.
... 7 errors ...
TSC_EXIT=2
```

The files are a concurrently-running perf agent's, they appeared between this
pass's run 1 and run 3, and they are picked up by `tsconfig.json`'s
`include: ["tests/**/*.ts", ...]` and by `vitest.config.ts`'s
`include: ['tests/**/*.test.ts']`. The committed tree is clean (pristine export,
`TSC_EXIT=0`, 221/221).

Fourth consecutive recommendation, unchanged: a `.gitignore` entry or an
enforced out-of-repo scratch convention, not another paragraph in a verify
document. This pass kept its own scratch work in `verify-scratch/`, which
`tsconfig.json` does not include, and deleted it afterwards.

---

## 10. Method notes

All adversarial work ran from `verify-scratch/` under its own vitest config,
against the same real infrastructure the committed e2e suite uses
(`tests/support/pg.ts` Testcontainers Postgres 16 with the production
migrations applied in order, `src/api/server.ts`'s spawned child process,
real `FormData` multipart uploads of real JPEG bytes, and
`POST /internal/images/{id}/status` with the real shared secret). Direct
PostgREST writes are simulated as `set role authenticated` on a real
connection against real RLS, the same technique `NFR-IMAGE-ROLE-01` and
`NFR-LOCK-GRANT-01` use.

Publish is rate-limited to 10/minute per client IP and every request arrives
from loopback, so each scenario ran against its own freshly spawned server to
reset the limiter rather than sharing one budget.

Scratch files (`invariantSweep`, `realInfra`, `raceConsequences`, `deadEnd`,
`fuzz`, `authcheck`, and their vitest config) were removed after the run;
nothing was committed and `state.json` was not touched.

---

## 11. Recommended next cycle

1. **M-V7-01** — make the cover slot single-occupancy under concurrency
   (transaction or per-article lock around `demoteCurrentCover()` +
   `insertImage()`), and/or record supersession on every row the demote
   touches. This closes M-V7-02 as a side effect.
2. **I-V7-01** — one expand-only `check (status <> 'ready' or (optimized_url is
   not null and optimized_url <> ''))`, so the invariant this entire fix family
   protects is enforced where migrations `0003` and `0004` already established
   such rules belong.
3. **§6.1's gap** — the cover-selection route, still owed, still correctly
   recorded as open by green v7.
4. Then the standing backlog, unchanged: L-V6-01 (`CDN_ORIGIN` unvalidated),
   L-V6-02 (single source of truth for "the cover"), L-V6-03 (the transient
   slug race), the idempotency store's TTL and `writer_id` scoping, N5/N5b/N2.
5. **Workspace hygiene**, for the fourth time.
