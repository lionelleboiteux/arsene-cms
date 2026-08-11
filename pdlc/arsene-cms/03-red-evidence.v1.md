# arsene-cms — Red-gate evidence

> Gate 3 (red) artifact. Tests only. No production code was written — that is
> precisely what this evidence exists to demonstrate.

**Status:** red | **Author:** Claude (Opus 5) | **Date:** 2026-08-11 | **Branch:** `feat/arsene-cms`

## 1. Command

Run from `/Users/lionelleboiteux/work/arsene-cms`:

```
NO_COLOR=1 FORCE_COLOR=0 npm test
```

which is `vitest run` over `tests/**/*.test.ts` (see `vitest.config.ts`).

One-off setup, both actually performed in this environment before the run:

```
npm install
npm run setup:contract   # python3 -m venv .venv-contract && pip install schemathesis
```

Docker must be running: `tests/db` starts a real `postgres:16-alpine` container
through Testcontainers, and `tests/e2e` / the provider contract test would too
once a provider exists to point them at.

Everything in the repo before this gate was documentation (`pdlc/**`). The only
non-test files added here are the scaffolding a first commit needs —
`package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`,
`scripts/update-pronos-vendor.sh` — plus the vendored copy of pronos' contract
(`pdlc/arsene-cms/contracts/vendor/pronos-openapi.yaml`), which is an input to a
test, not production code.

## 2. Result

| | |
|---|---|
| Test files | 18 |
| **Total tests** | **126** |
| **Failed** | **124** |
| **Passed** | **2** |
| Skipped | 0 |
| Exit code | 1 |
| Duration | 5.36 s |
| `npx tsc --noEmit` | clean (0 errors) |

The two passing tests are guard tests that read only artifacts already
delivered at earlier gates, and assert nothing whatsoever about production
code:

1. `CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer
   test in this file` — reads `pdlc/arsene-cms/contracts/openapi.yaml`
   (delivered at the architecture gate) and fails the moment an operation is
   added to the contract without a matching consumer test.
2. `FIXTURE-GUARD-01: the image fixtures are real files of the right kind and
   size` — proves the four image fixtures are genuine JPEG/PDF bytes of the
   sizes each test case claims (1 real baseline JPEG, one padded past 4 MB, one
   padded past 20 MB, one corrupted, one PDF). Without it, a future green run
   could pass because a fixture had quietly become an empty buffer.

## 3. Toolchain actually exercised by this run

Nothing below is stubbed. Each was proven to work by this same run (or by the
directly-recorded check noted), which is how we know the 124 failures are about
absent production code and not a broken harness.

| Tool | Version | Proof it ran |
|---|---|---|
| Node | v26.5.1 | — |
| TypeScript | 5.9.3 | `npx tsc --noEmit` returns clean over `tests/**/*.ts` |
| Vitest | 2.1.9 | banner in the output below (`RUN v2.1.9`) |
| Testcontainers + Postgres | `@testcontainers/postgresql` 12.1.0, `postgres:16-alpine` | `tests/db/schema.test.ts` starts the container **before** migrations are read, so its failure comes from `readMigrationFiles`, i.e. after a real container was up. Independently confirmed in this environment: starting the same container and querying it returned `PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit` in 1937 ms. |
| Prism (consumer mock, Arsène's contract) | `@stoplight/prism-cli` 5.16.0 | `tests/contract/consumer.prism.test.ts`'s `beforeAll` completed — had Prism failed to boot, all 9 tests would report a hook error instead of a missing-client error. Each `Prefer` selector used by a test was additionally verified by hand against a live mock (see §5). |
| Prism (consumer mock, vendored pronos contract) | same | `tests/contract/pronos-fixtures.prism.test.ts`'s `beforeAll` completed against `contracts/vendor/pronos-openapi.yaml`; its named examples were verified by hand too (§5). |
| Schemathesis (provider fuzzing) | 4.24.3 | its full CLI output is embedded in both provider failures below, including `Loaded specification from .../openapi.yaml`, `Operations: 1 selected / 2 total`, and the Examples/Coverage/Fuzzing phases each reporting `1 error` (network error — there is no provider yet). |
| fast-check (property tests) | 3.23.2 | 5 property tests present |
| Ajv 2020 + ajv-formats | 8.20.0 / 3.0.1 | compiles both contracts' component schemas at import time; no schema-compile error appears |
| zod | 4.4.3 | available as a dependency, matching pronos; not yet needed by a test |

## 4. Every failure, and its single reason

124 failures. Every one is either **"this production module does not exist
yet"** or **"the production migrations do not exist yet"**. There is not a
single import error in a *test* file, missing fixture, or typo — those would be
broken, not red, and would turn green later for reasons unrelated to the
implementation.

Grouped by cause:

| Cause | Failures |
|---|---|
| `src/api/publishArticle.ts` absent | 23 |
| `db/migrations/*.sql` absent | 16 |
| `src/api/uploadImage.ts` absent | 9 |
| `src/domain/lock.ts` absent | 9 |
| `src/domain/paste.ts` absent | 8 |
| `src/domain/seo.ts` absent | 8 |
| `src/api/client.ts` absent | 8 |
| `src/telemetry/events.ts` absent | 7 |
| `src/site/render.ts` absent | 6 |
| `src/domain/pronosEntry.ts` absent | 6 |
| `src/images/optimize.ts` absent | 5 |
| `src/api/server.ts` absent | 5 (2 provider + 3 e2e) |
| `src/client/fixturePicker.ts` absent | 4 |
| `src/domain/autosave.ts` absent | 4 |
| `src/domain/taxonomy.ts` absent | 3 |
| `src/api/createDraft.ts` absent | 2 |
| `src/api/rateLimit.ts` absent | 1 |

Per test:

| # | File | Test (tag + name) | Failure reason |
|---|---|---|---|
| 1 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle: the client parses a contract-valid response into the shape the contract declares | genuinely absent module `src/api/client` |
| 2 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage: the client parses a contract-valid response into the shape the contract declares | genuinely absent module `src/api/client` |
| 3 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / DEC-01: the client surfaces COVER_IMAGE_REQUIRED as a branchable code, so the editor can point the writer at "add a cover image", not a generic banner | genuinely absent module `src/api/client` |
| 4 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / AC-08: the client surfaces IMAGE_NOT_READY as a branchable code, so the editor can say "try again in a few seconds" rather than "locked" | genuinely absent module `src/api/client` |
| 5 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / AC-05: the client surfaces DRAFT_LOCKED as a branchable code, so the editor names the writer holding the lock — the same 409 as IMAGE_NOT_READY | genuinely absent module `src/api/client` |
| 6 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / NFR-AUTH-01: the client surfaces UNAUTHORIZED as a branchable code, so an expired session prompts re-login instead of looking like a content error | genuinely absent module `src/api/client` |
| 7 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / NFR-UPLOAD-01: the client surfaces FILE_TOO_LARGE as a branchable code, so the writer is told the file is too big, not that it is broken | genuinely absent module `src/api/client` |
| 8 | `tests/contract/consumer.prism.test.ts` | OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / AC-08: the client surfaces UNSUPPORTED_FORMAT as a branchable code, so the writer is asked to upload a different file (AC-08’s clear error message) | genuinely absent module `src/api/client` |
| 9 | `tests/contract/pronos-fixtures.prism.test.ts` | pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-populated: the picker renders one row per fixture, read out of the contract’s own response shape | genuinely absent module `src/client/fixturePicker` |
| 10 | `tests/contract/pronos-fixtures.prism.test.ts` | pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-emptyGameweek: a league with no open gameweek falls through to manual entry, and is not treated as an error | genuinely absent module `src/client/fixturePicker` |
| 11 | `tests/contract/pronos-fixtures.prism.test.ts` | pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-notFound: an unrecognised league id falls through to manual entry rather than blocking the writer | genuinely absent module `src/client/fixturePicker` |
| 12 | `tests/contract/pronos-fixtures.prism.test.ts` | pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-unreachable: pronos being undeployed, down or CORS-blocked also falls through to manual entry, never an unhandled failure | genuinely absent module `src/client/fixturePicker` |
| 13 | `tests/contract/provider.schemathesis.test.ts` | OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-publishArticle: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/publish | genuinely absent module `src/api/server` |
| 14 | `tests/contract/provider.schemathesis.test.ts` | OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-uploadArticleImage: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/images | genuinely absent module `src/api/server` |
| 15 | `tests/db/publicSiteRender.test.ts` | public site > AC-12: the homepage lists every league’s articles newest first, regardless of league | genuinely absent module `src/site/render` |
| 16 | `tests/db/publicSiteRender.test.ts` | public site > AC-11: a category with no published article shows "No articles yet" rather than an error or a blank page | genuinely absent module `src/site/render` |
| 17 | `tests/db/publicSiteRender.test.ts` | public site > AC-06: the category listing and the social preview both use the cover image, and never a body image | genuinely absent module `src/site/render` |
| 18 | `tests/db/publicSiteRender.test.ts` | public site > AC-14: the published article page embeds its schema.org markup and the sitemap carries its canonical URL, with no writer action | genuinely absent module `src/site/render` |
| 19 | `tests/db/publicSiteRender.test.ts` | public site > NFR-EGRESS-01: no rendered page points a visitor at Supabase Storage, because hotlinking blows the 5 GB/month egress free tier | genuinely absent module `src/site/render` |
| 20 | `tests/db/publicSiteRender.test.ts` | public site > NFR-RLS-02: no draft ever reaches the rendered public site, on the homepage or in the sitemap | genuinely absent module `src/site/render` |
| 21 | `tests/db/schema.test.ts` | shared asset library > AC-09: a logo uploaded by one writer is listed for every other writer, with no re-upload | genuinely absent `db/migrations/*.sql` |
| 22 | `tests/db/schema.test.ts` | draft locking under real timing > AC-05: while writer A’s heartbeat is current, writer B’s attempt to take the lock updates no row | genuinely absent `db/migrations/*.sql` |
| 23 | `tests/db/schema.test.ts` | draft locking under real timing > AC-05: once writer A’s lock is 91 seconds stale, writer B takes it without any admin unlock | genuinely absent `db/migrations/*.sql` |
| 24 | `tests/db/schema.test.ts` | taxonomy storage > DEC-02: "ligue1" is stored alongside "Ligue 1" instead of being merged into it, because v1 leaves near-duplicates to manual cleanup | genuinely absent `db/migrations/*.sql` |
| 25 | `tests/db/schema.test.ts` | alt text > AC-15: a writer can overwrite generated alt text with a direct row update, no endpoint involved | genuinely absent `db/migrations/*.sql` |
| 26 | `tests/db/schema.test.ts` | pronos fixture reference (ADR-0002) > ADR-0002: the pronos match reference is nullable and carries no cross-project foreign key, so manual entry is never blocked | genuinely absent `db/migrations/*.sql` |
| 27 | `tests/db/schema.test.ts` | telemetry_events store > TELEMETRY-draft_started: the telemetry_events store accepts this required event type | genuinely absent `db/migrations/*.sql` |
| 28 | `tests/db/schema.test.ts` | telemetry_events store > TELEMETRY-article_published: the telemetry_events store accepts this required event type | genuinely absent `db/migrations/*.sql` |
| 29 | `tests/db/schema.test.ts` | telemetry_events store > TELEMETRY-REGISTRY: the store rejects an event type outside the agreed two, so the metric cannot be polluted | genuinely absent `db/migrations/*.sql` |
| 30 | `tests/db/schema.test.ts` | telemetry_events store > AC-18: a draft started at 10:00 and published at 10:47 yields a 47-minute time-to-publish from the stored events alone | genuinely absent `db/migrations/*.sql` |
| 31 | `tests/db/schema.test.ts` | write protection and disclosure > NFR-RLS-01: row level security is enabled on every table the editor reaches through PostgREST | genuinely absent `db/migrations/*.sql` |
| 32 | `tests/db/schema.test.ts` | write protection and disclosure > NFR-RLS-02: the anon role can read a published article but never an unpublished one | genuinely absent `db/migrations/*.sql` |
| 33 | `tests/db/schema.test.ts` | write protection and disclosure > NFR-RLS-03: the anon role cannot read images belonging to an unpublished article | genuinely absent `db/migrations/*.sql` |
| 34 | `tests/db/schema.test.ts` | write protection and disclosure > NFR-TAMPER-01: a writer cannot set published_at directly — publish-controlled columns are not writable through PostgREST | genuinely absent `db/migrations/*.sql` |
| 35 | `tests/db/schema.test.ts` | write protection and disclosure > NFR-AUDIT-01: every article and every telemetry row is stamped with a writer id that cannot be null | genuinely absent `db/migrations/*.sql` |
| 36 | `tests/db/schema.test.ts` | migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only | genuinely absent `db/migrations/*.sql` |
| 37 | `tests/e2e/publishJourney.test.ts` | end-to-end publishing journey > E2E-01: a draft with a real uploaded cover publishes, goes live with a slug, and leaves both telemetry rows needed to compute time-to-publish | genuinely absent module `src/api/server` |
| 38 | `tests/e2e/publishJourney.test.ts` | end-to-end publishing journey > E2E-02: a publish refused for a missing cover image leaves the article unpublished and writes no article_published row at all | genuinely absent module `src/api/server` |
| 39 | `tests/e2e/publishJourney.test.ts` | end-to-end publishing journey > E2E-03: republishing an article that went live 3 days ago updates the live content immediately, with no approval step, and is recorded as a republish | genuinely absent module `src/api/server` |
| 40 | `tests/telemetry/emission.test.ts` | telemetry: draft_started > TELEMETRY-draft_started: creating a new draft emits exactly one draft_started carrying the writer, the article and the start time | genuinely absent module `src/api/createDraft` |
| 41 | `tests/telemetry/emission.test.ts` | telemetry: draft_started > TELEMETRY-draft_started (negative): reopening an existing draft emits no second draft_started, so a crash-and-resume cannot reset the clock | genuinely absent module `src/api/createDraft` |
| 42 | `tests/telemetry/emission.test.ts` | telemetry: article_published > TELEMETRY-article_published: a successful first publish emits exactly one event, flagged as not a republish | genuinely absent module `src/api/publishArticle` |
| 43 | `tests/telemetry/emission.test.ts` | telemetry: article_published > TELEMETRY-article_published: republishing emits an event flagged is_republish, so republishes cannot be counted as first publishes | genuinely absent module `src/api/publishArticle` |
| 44 | `tests/telemetry/emission.test.ts` | telemetry: article_published > TELEMETRY-article_published (negative) / DEC-01: a publish refused for a missing cover image emits no article_published event | genuinely absent module `src/api/publishArticle` |
| 45 | `tests/telemetry/emission.test.ts` | telemetry: article_published > TELEMETRY-article_published (negative) / AC-08: a publish refused because an image is still processing emits no article_published event | genuinely absent module `src/api/publishArticle` |
| 46 | `tests/telemetry/emission.test.ts` | telemetry: article_published > TELEMETRY-article_published (negative) / AC-05: a publish refused because another writer holds the draft lock emits no article_published event | genuinely absent module `src/api/publishArticle` |
| 47 | `tests/telemetry/emission.test.ts` | telemetry: article_published > TELEMETRY-article_published (negative) / NFR-AUTH-01: a publish refused for a missing bearer token emits no article_published event | genuinely absent module `src/api/publishArticle` |
| 48 | `tests/unit/publishArticle.test.ts` | publish refusals > DEC-01: publishing an article with no cover image at all (01-decisions.md #1: cover is mandatory) is refused with 400 COVER_IMAGE_REQUIRED | genuinely absent module `src/api/publishArticle` |
| 49 | `tests/unit/publishArticle.test.ts` | publish refusals > AC-04: publishing a Pronos article whose structured match fields are invalid is refused with 400 VALIDATION_FAILED | genuinely absent module `src/api/publishArticle` |
| 50 | `tests/unit/publishArticle.test.ts` | publish refusals > AC-08a: publishing a cover image still being optimised is refused with 409 IMAGE_NOT_READY | genuinely absent module `src/api/publishArticle` |
| 51 | `tests/unit/publishArticle.test.ts` | publish refusals > AC-08b: publishing a body image that failed optimisation and was never replaced is refused with 409 IMAGE_NOT_READY | genuinely absent module `src/api/publishArticle` |
| 52 | `tests/unit/publishArticle.test.ts` | publish refusals > AC-05: publishing a draft another writer currently holds the edit lock on is refused with 409 DRAFT_LOCKED | genuinely absent module `src/api/publishArticle` |
| 53 | `tests/unit/publishArticle.test.ts` | publish refusals > NFR-AUTH-01: publishing a request carrying no writer bearer token is refused with 401 UNAUTHORIZED | genuinely absent module `src/api/publishArticle` |
| 54 | `tests/unit/publishArticle.test.ts` | publish refusals > CONTRACT-publish-404: publishing an article id that does not exist is refused with 404 NOT_FOUND | genuinely absent module `src/api/publishArticle` |
| 55 | `tests/unit/publishArticle.test.ts` | publish > AC-14: a successful first publish returns the automatically generated slug, JSON-LD and sitemap entry in the shape the contract declares | genuinely absent module `src/api/publishArticle` |
| 56 | `tests/unit/publishArticle.test.ts` | publish > AC-13: meta title and description edited by the writer at the publish step are used verbatim instead of the suggestion | genuinely absent module `src/api/publishArticle` |
| 57 | `tests/unit/publishArticle.test.ts` | publish > AC-16: an article the content check flagged still publishes when the writer chooses to publish anyway | genuinely absent module `src/api/publishArticle` |
| 58 | `tests/unit/publishArticle.test.ts` | publish > AC-17: republishing an article that went live 3 days ago refreshes published_at, keeps first_published_at, and is flagged as a republish | genuinely absent module `src/api/publishArticle` |
| 59 | `tests/unit/publishArticle.test.ts` | publish > AC-17: publishing triggers on-demand revalidation of the article, its category page and the homepage, so the update is live immediately | genuinely absent module `src/api/publishArticle` |
| 60 | `tests/unit/publishArticle.test.ts` | publish > NFR-OBS-01: a failed revalidation is recorded as a failure rather than passing silently, because a writer seeing no change is otherwise invisible | genuinely absent module `src/api/publishArticle` |
| 61 | `tests/unit/publishArticle.test.ts` | publish > NFR-IDEM-01: replaying the same Idempotency-Key does not record a second article_published event, so time-to-publish is not skewed by a retry | genuinely absent module `src/api/publishArticle` |
| 62 | `tests/unit/publishArticle.test.ts` | publish rate limiting > NFR-RATE-01a: the 10th publish attempt in a minute from one IP is still served | genuinely absent module `src/api/publishArticle` |
| 63 | `tests/unit/publishArticle.test.ts` | publish rate limiting > NFR-RATE-01b: the 11th publish attempt in a minute from the same IP is rejected with 429 | genuinely absent module `src/api/publishArticle` |
| 64 | `tests/unit/publishArticle.test.ts` | publish rate limiting > NFR-RATE-01c: a second writer on a different IP is unaffected by the first IP exhausting its budget | genuinely absent module `src/api/publishArticle` |
| 65 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-draft_started: builds a row carrying the writer, the article and the moment the draft started | genuinely absent module `src/telemetry/events` |
| 66 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-article_published: builds a row carrying the writer, the article, the publish time and whether it was a republish | genuinely absent module `src/telemetry/events` |
| 67 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-draft_started: a payload missing started_at is rejected, because the numerator of time-to-publish has no start without it | genuinely absent module `src/telemetry/events` |
| 68 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-article_published: a payload missing is_republish is rejected, because first publishes and republishes cannot be told apart without it | genuinely absent module `src/telemetry/events` |
| 69 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-article_published: a payload missing article_id is rejected, because the two events are joined on article_id to compute the duration | genuinely absent module `src/telemetry/events` |
| 70 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-REGISTRY: the shipped registry lists exactly the two required event types and no others | genuinely absent module `src/telemetry/events` |
| 71 | `tests/telemetry/eventShape.test.ts` | telemetry event shape > TELEMETRY-REGISTRY: an event type outside the agreed two is rejected rather than silently stored | genuinely absent module `src/telemetry/events` |
| 72 | `tests/unit/draft.test.ts` | draft autosave > AC-01: after 35 seconds of typing with no manual save, the autosave tick saves the draft and stamps the indicator with the save time | genuinely absent module `src/domain/autosave` |
| 73 | `tests/unit/draft.test.ts` | draft autosave > AC-01: a tick with nothing typed since the last save writes nothing and leaves the existing indicator alone | genuinely absent module `src/domain/autosave` |
| 74 | `tests/unit/draft.test.ts` | draft autosave > AC-01: the shipped autosave interval is the assumed 30 seconds | genuinely absent module `src/domain/autosave` |
| 75 | `tests/unit/draft.test.ts` | draft recovery after a crash > AC-02: reopening a draft whose browser died restores the last autosaved version, not an earlier one | genuinely absent module `src/domain/autosave` |
| 76 | `tests/unit/imageOptimize.test.ts` | image optimisation (real codec, real files) > AC-07: a valid 4 MB JPEG is handled distinguishably | genuinely absent module `src/images/optimize` |
| 77 | `tests/unit/imageOptimize.test.ts` | image optimisation (real codec, real files) > AC-08a: a corrupted file that still sniffs as a JPEG is handled distinguishably | genuinely absent module `src/images/optimize` |
| 78 | `tests/unit/imageOptimize.test.ts` | image optimisation (real codec, real files) > AC-08b: a container this pipeline does not support at all is handled distinguishably | genuinely absent module `src/images/optimize` |
| 79 | `tests/unit/imageOptimize.test.ts` | image optimisation (real codec, real files) > NFR-UPLOAD-01: a decodable JPEG over the 20 MB limit is handled distinguishably | genuinely absent module `src/images/optimize` |
| 80 | `tests/unit/imageOptimize.test.ts` | image optimisation (real codec, real files) > NFR-UPLOAD-01: the shipped maximum upload size is the 20 MB the contract promises callers | genuinely absent module `src/images/optimize` |
| 81 | `tests/unit/lock.test.ts` | draft locking > AC-05: writer B opening a draft writer A is actively editing is refused, and told who holds it | genuinely absent module `src/domain/lock` |
| 82 | `tests/unit/lock.test.ts` | draft locking > AC-05: writer A is never locked out of the draft they themselves hold | genuinely absent module `src/domain/lock` |
| 83 | `tests/unit/lock.test.ts` | draft locking > AC-05: a lock left behind by a crashed browser expires on its own, so writer B can edit without an admin unlock | genuinely absent module `src/domain/lock` |
| 84 | `tests/unit/lock.test.ts` | draft locking > AC-05: a draft nobody holds is editable | genuinely absent module `src/domain/lock` |
| 85 | `tests/unit/lock.test.ts` | draft locking > NFR-LOCK-01a: a lock one heartbeat old gives isLockStale=false | genuinely absent module `src/domain/lock` |
| 86 | `tests/unit/lock.test.ts` | draft locking > NFR-LOCK-01b: a lock exactly at the staleness threshold gives isLockStale=false | genuinely absent module `src/domain/lock` |
| 87 | `tests/unit/lock.test.ts` | draft locking > NFR-LOCK-01c: a lock one millisecond past the threshold gives isLockStale=true | genuinely absent module `src/domain/lock` |
| 88 | `tests/unit/lock.test.ts` | draft locking > NFR-LOCK-02: the shipped heartbeat and staleness constants are ADR-0003’s, and the window spans several heartbeats so a slow network cannot steal a live lock | genuinely absent module `src/domain/lock` |
| 89 | `tests/unit/properties.test.ts` | lock invariants (AC-05, ADR-0003) > PROP-03: any two timestamps further apart than the staleness threshold mean the lock has expired — for every pair, not just the ones we thought of | genuinely absent module `src/domain/lock` |
| 90 | `tests/unit/paste.test.ts` | paste sanitization > AC-03: pasting a Word document keeps its "Heading 2" paragraph as an H2 and discards the custom font and styling | genuinely absent module `src/domain/paste` |
| 91 | `tests/unit/paste.test.ts` | paste sanitization > AC-03a: an inline style attribute (colour, background, font-size) is cleaned up automatically | genuinely absent module `src/domain/paste` |
| 92 | `tests/unit/paste.test.ts` | paste sanitization > AC-03b: a presentational element (<font>) wrapping real text is cleaned up automatically | genuinely absent module `src/domain/paste` |
| 93 | `tests/unit/paste.test.ts` | paste sanitization > AC-03c: a Google Docs heading, whose structure lives in classes not tags is cleaned up automatically | genuinely absent module `src/domain/paste` |
| 94 | `tests/unit/paste.test.ts` | paste sanitization > AC-03d: a deeper heading level, which must survive as H3 rather than flatten is cleaned up automatically | genuinely absent module `src/domain/paste` |
| 95 | `tests/unit/paste.test.ts` | paste sanitization > AC-03e: an executable/unsafe node smuggled in by the clipboard is cleaned up automatically | genuinely absent module `src/domain/paste` |
| 96 | `tests/unit/properties.test.ts` | paste sanitization invariants (AC-03) > PROP-04: no styling, class or executable node ever survives sanitization, for any clipboard payload | genuinely absent module `src/domain/paste` |
| 97 | `tests/unit/properties.test.ts` | paste sanitization invariants (AC-03) > PROP-05: sanitization is idempotent — re-pasting already-clean content changes nothing | genuinely absent module `src/domain/paste` |
| 98 | `tests/unit/pronosEntry.test.ts` | structured pronos entry > AC-04: PSG 2-1 Marseille with tier "Indispensable" is stored as typed fields, with no pronos fixture reference required | genuinely absent module `src/domain/pronosEntry` |
| 99 | `tests/unit/pronosEntry.test.ts` | structured pronos entry > ADR-0002: picking a fixture from pronos stores a denormalised snapshot of it alongside the writer-editable team names | genuinely absent module `src/domain/pronosEntry` |
| 100 | `tests/unit/pronosEntry.test.ts` | structured pronos entry > AC-04a: a confidence tier outside the agreed three is rejected as a field error, not stored as free text | genuinely absent module `src/domain/pronosEntry` |
| 101 | `tests/unit/pronosEntry.test.ts` | structured pronos entry > AC-04b: a missing team name is rejected as a field error, not stored as free text | genuinely absent module `src/domain/pronosEntry` |
| 102 | `tests/unit/pronosEntry.test.ts` | structured pronos entry > AC-04c: a non-integer predicted score is rejected as a field error, not stored as free text | genuinely absent module `src/domain/pronosEntry` |
| 103 | `tests/unit/pronosEntry.test.ts` | structured pronos entry > AC-04: the shipped confidence tiers are exactly the three the contract documents | genuinely absent module `src/domain/pronosEntry` |
| 104 | `tests/unit/properties.test.ts` | slug invariants (AC-14) > PROP-01: every generated slug is URL-safe and non-empty, whatever punctuation, accents or emoji the title contains | genuinely absent module `src/domain/seo` |
| 105 | `tests/unit/properties.test.ts` | slug invariants (AC-14) > PROP-02: a slug never collides with one already taken, and stays URL-safe while avoiding it | genuinely absent module `src/domain/seo` |
| 106 | `tests/unit/seo.test.ts` | meta suggestion > AC-13: reaching the publish step yields a meta title and description pre-filled from the article and short enough for the contract to accept | genuinely absent module `src/domain/seo` |
| 107 | `tests/unit/seo.test.ts` | technical SEO fields > AC-14: the URL slug is derived from the title with no writer action, matching the slug the contract documents | genuinely absent module `src/domain/seo` |
| 108 | `tests/unit/seo.test.ts` | technical SEO fields > AC-14: the generated schema.org markup is a valid NewsArticle carrying the cover image and both publish timestamps | genuinely absent module `src/domain/seo` |
| 109 | `tests/unit/seo.test.ts` | technical SEO fields > AC-14: the sitemap entry points at the article’s canonical URL and is dated by this publish | genuinely absent module `src/domain/seo` |
| 110 | `tests/unit/seo.test.ts` | image alt text > AC-15: alt text is generated from the article’s own context rather than the file name | genuinely absent module `src/domain/seo` |
| 111 | `tests/unit/seo.test.ts` | SEO/AEO/GEO advisory check > AC-16: an article with a too-short introduction is flagged, and no advisory ever claims to block publishing | genuinely absent module `src/domain/seo` |
| 112 | `tests/unit/publishArticle.test.ts` | publish rate limiting > NFR-RATE-01d: the shipped limiter exposes the assumed 10-per-minute-per-IP threshold | genuinely absent module `src/api/rateLimit` |
| 113 | `tests/unit/taxonomy.test.ts` | category creation > AC-10: assigning an article to a league and type that do not exist creates both, nested league-then-type, with no approval step | genuinely absent module `src/domain/taxonomy` |
| 114 | `tests/unit/taxonomy.test.ts` | category creation > AC-10: an existing league is reused rather than duplicated when only the type is new | genuinely absent module `src/domain/taxonomy` |
| 115 | `tests/unit/taxonomy.test.ts` | category creation > DEC-02: a near-duplicate league name ("ligue1" next to "Ligue 1") is created as its own category, because v1 does no automatic merging | genuinely absent module `src/domain/taxonomy` |
| 116 | `tests/unit/uploadImage.test.ts` | image upload > AC-07: a 4 MB JPEG comes back as a compressed WebP/AVIF resource, and the bytes actually stored for visitors are far smaller than the upload | genuinely absent module `src/api/uploadImage` |
| 117 | `tests/unit/uploadImage.test.ts` | image upload > AC-15: a processed image carries auto-generated alt text, ready for the writer to override | genuinely absent module `src/api/uploadImage` |
| 118 | `tests/unit/uploadImage.test.ts` | image upload > AC-06: uploading a new cover demotes the article’s previous cover to a body image and names the image it replaced | genuinely absent module `src/api/uploadImage` |
| 119 | `tests/unit/uploadImage.test.ts` | image upload > AC-06: a body-image upload never claims to have replaced a cover | genuinely absent module `src/api/uploadImage` |
| 120 | `tests/unit/uploadImage.test.ts` | image upload > AC-08: a file whose format cannot be recognised is refused with a clear error and creates no image row at all | genuinely absent module `src/api/uploadImage` |
| 121 | `tests/unit/uploadImage.test.ts` | image upload > AC-08: a file that passes format detection but fails to decode becomes a failed image the writer is told to replace, never a silently broken one | genuinely absent module `src/api/uploadImage` |
| 122 | `tests/unit/uploadImage.test.ts` | image upload > NFR-UPLOAD-01: a file over the contract’s 20 MB limit is rejected with 413 before the codec is ever handed the bytes | genuinely absent module `src/api/uploadImage` |
| 123 | `tests/unit/uploadImage.test.ts` | image upload > NFR-AUTH-01: an image upload with no writer bearer token is rejected 401 before anything is stored | genuinely absent module `src/api/uploadImage` |
| 124 | `tests/unit/uploadImage.test.ts` | image upload > NFR-IDEM-02: replaying an upload with the same Idempotency-Key returns the original resource and uploads nothing a second time | genuinely absent module `src/api/uploadImage` |

## 5. Harness checks performed outside the suite

Two things a red run cannot prove on its own — because the tests that would
exercise them fail earlier, on the missing client/picker module — were verified
by hand against live mocks so the green gate does not discover a mis-wired
harness. Commands and real responses:

```
$ node node_modules/@stoplight/prism-cli/dist/index.js mock --port 4712 --host 127.0.0.1 \
    pdlc/arsene-cms/contracts/openapi.yaml
$ A=a1a1a1a1-0000-4a2b-9c3d-000000000001 ; H='Authorization: Bearer test.jwt'

--- publish 200 ---
{"article_id":"a1a1a1a1-0000-4a2b-9c3d-000000000001","slug":"pronos-ligue-1-journee-12","status":"published","published_at":"2026-08-11T10:47:12Z","first_published_at":"2026-08-11T10:47:12Z","is_repub
--- publish 400 missingCoverImage ---
{"error":{"code":"COVER_IMAGE_REQUIRED","message":"This article has no cover image. Upload one and set it as the cover before publishing.","details":{"article_id":"a1a1a1a1-0000-4a2b-9c3d-000000000001
--- publish 409 draftLocked ---
{"error":{"code":"DRAFT_LOCKED","message":"This draft is currently locked for editing by another writer.","details":{"locked_by_writer_id":"e5e5e5e5-0000-4a2b-9c3d-eeeeeeeeeeee","locked_by_display_nam
--- publish 409 imageStillProcessing ---
{"error":{"code":"IMAGE_NOT_READY","message":"The cover image is still being optimised and cannot be published yet. Try again in a few seconds.","details":{"image_id":"c3c3c3c3-0000-4a2b-9c3d-cccccccc
--- publish 401 ---
{"error":{"code":"UNAUTHORIZED","message":"A valid Supabase Auth bearer token is required for this endpoint.","details":
--- images 201 multipart ---
{"id":"c3c3c3c3-0000-4a2b-9c3d-cccccccccccc","article_id":"a1a1a1a1-0000-4a2b-9c3d-000000000001","role":"cover","status":"ready","original_filename":"psg-om-cover.jpg","alt_text":"PSG face à l’OM au Parc des Princes","urls":{"original":"https://cd
--- images 413 ---
{"error":{"code":"FILE_TOO_LARGE","message":"Files must be 20 MB or smaller; this file is 34 MB.","details":{"max_bytes":20971520,"received_bytes":35651584},"request_id":"6f6f6f6f-6666-4a2b-9c3d-fffff
--- images 422 ---
{"error":{"code":"UNSUPPORTED_FORMAT","message":"This file could not be recognised as a supported image format. Please upload a JPEG, PNG, WebP, AVIF, or HEIC file.","details":{"detected_content_type"
```

Note the first attempt without an `Authorization` header returned
`401 UNAUTHORIZED` for every operation — Prism enforces the contract's
`security` block, which is itself a useful confirmation that the contract
declares auth on both operations (NFR-AUTH-01).

```
$ node node_modules/@stoplight/prism-cli/dist/index.js mock --port 4713 --host 127.0.0.1 \
    pdlc/arsene-cms/contracts/vendor/pronos-openapi.yaml
$ L=3f29b6d2-8b1a-4e2b-9c3a-111111111111

--- populated ---
{"league":{"id":"3f29b6d2-8b1a-4e2b-9c3a-111111111111","code":"ligue-1","name":"Ligue 1","logo_url":"https://cdn.pronos.example/logos/ligue-1.png"},"season_id":"8a9c6f10-1111-4a2b-9c3d-444444444444","gameweek":{"id":"9d2f6a10-2222-4a2b-9c3d-555555555555","number":15,"starts_at":"2026-08-09T18:45:00Z","ends_at":"2026-08-11T20:00:00Z","stage_name":"Journée 15"},"games":[{"game":{"id":"9c1e4a2e-0000
--- noOpenGameweek ---
{"league":{"id":"7a1d9e60-9d5c-4a2f-9b3e-333333333333","code":"bundesliga","name":"Bundesliga","logo_url":"https://cdn.pronos.example/logos/bundesliga.png"},"season_id":null,"gameweek":null,"games":[]}
--- 404 ---
{"error":{"code":"NOT_FOUND","message":"No resource was found matching the given identifier(s).","details":{"league_id":"00000000-0000-0000-0000-000000000000"},"request_id":"8e9f0a1b-2c3d-4e5f-8a9b-6c
```

And the JPEG fixture generator, whose output must be a *genuinely decodable*
image rather than a renamed blob — verified with a real decoder (macOS
ImageIO via `sips`), both the 160-byte baseline and the same file padded to
4 MB with legal JPEG COM segments:

```
$ sips -g pixelWidth -g pixelHeight tiny.jpg
  pixelWidth: 1
  pixelHeight: 1
$ sips -g pixelWidth -g pixelHeight padded.jpg     # 4 194 528 bytes
  pixelWidth: 1
  pixelHeight: 1
```

## 6. Assumptions this suite pins, needing product-owner confirmation

Each is written against a named constant so the number lives in one place, and
each is listed again in `traceability.md` §6.

1. **Lock staleness = 90 000 ms; heartbeat = 20 000 ms.** ADR-0003 gives a
   range (60–90 s) and a "roughly every 20 seconds" heartbeat. The suite pins
   the top of that range as the concrete value (`NFR-LOCK-02`,
   `tests/unit/lock.test.ts`).
2. **Autosave interval = 30 000 ms.** AC-01 says "typing for over 30 seconds
   without manually saving … when the autosave interval elapses" but never
   fixes the interval (`tests/unit/draft.test.ts`).
3. **Publish rate limit = 10 requests/minute/IP.** §7 of the architecture says
   "mirroring pronos' existing 10 req/min per IP precedent"; that precedent is
   adopted verbatim (`NFR-RATE-01`).
4. **Max upload = 20 MB, not 10 MB.** The threat model says "Max upload size
   enforced (e.g. 10MB)" while `contracts/openapi.yaml` documents `413
   FILE_TOO_LARGE` with `max_bytes: 20971520`. The contract is the tighter
   commitment to callers and wins; the architecture's "e.g." is illustrative.
   **This discrepancy should be confirmed rather than assumed.**
5. **The autosave indicator reads `Last saved at HH:MM` in UTC.** Rendering it
   in the writer's timezone is presentation; the seam must be deterministic.
6. **Supabase's `anon` / `authenticated` roles exist**, created by the first
   migration, exactly as pronos does — the RLS tests `set role` to them.
7. **`draft_started` is emitted server-side** (trigger or RPC on draft
   creation), because the editor SPA creates drafts through PostgREST, not
   through an Edge Function. `E2E-01` asserts the event exists for an article
   inserted the same way the SPA inserts it; if the event were emitted only by
   client code, the metric could be lost silently by any client bug.

## 7. Full, unedited output

Pasted verbatim, not summarised or reconstructed. The only transformation
applied is stripping ANSI colour/cursor escape sequences (`\e[...m`,
`\e[?25l`), which the terminal would have rendered invisibly; no line of
content was removed, reordered or shortened. That includes Schemathesis'
progress-spinner lines, which are repetitive precisely because they are real.

```text

> arsene-cms@0.0.0 test
> vitest run


 RUN  v2.1.9 /Users/lionelleboiteux/work/arsene-cms

 × tests/telemetry/emission.test.ts > telemetry: draft_started > TELEMETRY-draft_started: creating a new draft emits exactly one draft_started carrying the writer, the article and the start time
   → Failed to load url ../../src/api/createDraft (resolved id: ../../src/api/createDraft) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: draft_started > TELEMETRY-draft_started (negative): reopening an existing draft emits no second draft_started, so a crash-and-resume cannot reset the clock
   → Failed to load url ../../src/api/createDraft (resolved id: ../../src/api/createDraft) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published: a successful first publish emits exactly one event, flagged as not a republish
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published: republishing emits an event flagged is_republish, so republishes cannot be counted as first publishes
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / DEC-01: a publish refused for a missing cover image emits no article_published event
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / AC-08: a publish refused because an image is still processing emits no article_published event
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / AC-05: a publish refused because another writer holds the draft lock emits no article_published event
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / NFR-AUTH-01: a publish refused for a missing bearer token emits no article_published event
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > AC-07: a 4 MB JPEG comes back as a compressed WebP/AVIF resource, and the bytes actually stored for visitors are far smaller than the upload
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > AC-15: a processed image carries auto-generated alt text, ready for the writer to override
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > AC-06: uploading a new cover demotes the article’s previous cover to a body image and names the image it replaced
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > AC-06: a body-image upload never claims to have replaced a cover
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > AC-08: a file whose format cannot be recognised is refused with a clear error and creates no image row at all
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > AC-08: a file that passes format detection but fails to decode becomes a failed image the writer is told to replace, never a silently broken one
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > NFR-UPLOAD-01: a file over the contract’s 20 MB limit is rejected with 413 before the codec is ever handed the bytes
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > NFR-AUTH-01: an image upload with no writer bearer token is rejected 401 before anything is stored
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/uploadImage.test.ts > image upload > NFR-IDEM-02: replaying an upload with the same Idempotency-Key returns the original resource and uploads nothing a second time
   → Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/seo.test.ts > meta suggestion > AC-13: reaching the publish step yields a meta title and description pre-filled from the article and short enough for the contract to accept
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/seo.test.ts > technical SEO fields > AC-14: the URL slug is derived from the title with no writer action, matching the slug the contract documents
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/seo.test.ts > technical SEO fields > AC-14: the generated schema.org markup is a valid NewsArticle carrying the cover image and both publish timestamps
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/seo.test.ts > technical SEO fields > AC-14: the sitemap entry points at the article’s canonical URL and is dated by this publish
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/seo.test.ts > image alt text > AC-15: alt text is generated from the article’s own context rather than the file name
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/seo.test.ts > SEO/AEO/GEO advisory check > AC-16: an article with a too-short introduction is flagged, and no advisory ever claims to block publishing
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > DEC-01: publishing an article with no cover image at all (01-decisions.md #1: cover is mandatory) is refused with 400 COVER_IMAGE_REQUIRED
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > AC-04: publishing a Pronos article whose structured match fields are invalid is refused with 400 VALIDATION_FAILED
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > AC-08a: publishing a cover image still being optimised is refused with 409 IMAGE_NOT_READY
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > AC-08b: publishing a body image that failed optimisation and was never replaced is refused with 409 IMAGE_NOT_READY
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > AC-05: publishing a draft another writer currently holds the edit lock on is refused with 409 DRAFT_LOCKED
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > NFR-AUTH-01: publishing a request carrying no writer bearer token is refused with 401 UNAUTHORIZED
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish refusals > CONTRACT-publish-404: publishing an article id that does not exist is refused with 404 NOT_FOUND
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > AC-14: a successful first publish returns the automatically generated slug, JSON-LD and sitemap entry in the shape the contract declares
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > AC-13: meta title and description edited by the writer at the publish step are used verbatim instead of the suggestion
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > AC-16: an article the content check flagged still publishes when the writer chooses to publish anyway
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > AC-17: republishing an article that went live 3 days ago refreshes published_at, keeps first_published_at, and is flagged as a republish
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > AC-17: publishing triggers on-demand revalidation of the article, its category page and the homepage, so the update is live immediately
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > NFR-OBS-01: a failed revalidation is recorded as a failure rather than passing silently, because a writer seeing no change is otherwise invisible
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish > NFR-IDEM-01: replaying the same Idempotency-Key does not record a second article_published event, so time-to-publish is not skewed by a retry
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01a: the 10th publish attempt in a minute from one IP is still served
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01b: the 11th publish attempt in a minute from the same IP is rejected with 429
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01c: a second writer on a different IP is unaffected by the first IP exhausting its budget
   → Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01d: the shipped limiter exposes the assumed 10-per-minute-per-IP threshold
   → Failed to load url ../../src/api/rateLimit (resolved id: ../../src/api/rateLimit) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > AC-07: a valid 4 MB JPEG is handled distinguishably
   → Failed to load url ../../src/images/optimize (resolved id: ../../src/images/optimize) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > AC-08a: a corrupted file that still sniffs as a JPEG is handled distinguishably
   → Failed to load url ../../src/images/optimize (resolved id: ../../src/images/optimize) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > AC-08b: a container this pipeline does not support at all is handled distinguishably
   → Failed to load url ../../src/images/optimize (resolved id: ../../src/images/optimize) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > NFR-UPLOAD-01: a decodable JPEG over the 20 MB limit is handled distinguishably
   → Failed to load url ../../src/images/optimize (resolved id: ../../src/images/optimize) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > NFR-UPLOAD-01: the shipped maximum upload size is the 20 MB the contract promises callers
   → Failed to load url ../../src/images/optimize (resolved id: ../../src/images/optimize) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ✓ tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > FIXTURE-GUARD-01: the image fixtures are real files of the right kind and size
 × tests/unit/lock.test.ts > draft locking > AC-05: writer B opening a draft writer A is actively editing is refused, and told who holds it
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > AC-05: writer A is never locked out of the draft they themselves hold
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > AC-05: a lock left behind by a crashed browser expires on its own, so writer B can edit without an admin unlock
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > AC-05: a draft nobody holds is editable
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > NFR-LOCK-01a: a lock one heartbeat old gives isLockStale=false
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > NFR-LOCK-01b: a lock exactly at the staleness threshold gives isLockStale=false
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > NFR-LOCK-01c: a lock one millisecond past the threshold gives isLockStale=true
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/lock.test.ts > draft locking > NFR-LOCK-02: the shipped heartbeat and staleness constants are ADR-0003’s, and the window spans several heartbeats so a slow network cannot steal a live lock
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-01: a draft with a real uploaded cover publishes, goes live with a slug, and leaves both telemetry rows needed to compute time-to-publish
   → Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-02: a publish refused for a missing cover image leaves the article unpublished and writes no article_published row at all
   → Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-03: republishing an article that went live 3 days ago updates the live content immediately, with no approval step, and is recorded as a republish
   → Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/publicSiteRender.test.ts > public site > AC-12: the homepage lists every league’s articles newest first, regardless of league
   → Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/publicSiteRender.test.ts > public site > AC-11: a category with no published article shows "No articles yet" rather than an error or a blank page
   → Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/publicSiteRender.test.ts > public site > AC-06: the category listing and the social preview both use the cover image, and never a body image
   → Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/publicSiteRender.test.ts > public site > AC-14: the published article page embeds its schema.org markup and the sitemap carries its canonical URL, with no writer action
   → Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/publicSiteRender.test.ts > public site > NFR-EGRESS-01: no rendered page points a visitor at Supabase Storage, because hotlinking blows the 5 GB/month egress free tier
   → Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/publicSiteRender.test.ts > public site > NFR-RLS-02: no draft ever reaches the rendered public site, on the homepage or in the sitemap
   → Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-draft_started: builds a row carrying the writer, the article and the moment the draft started
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-article_published: builds a row carrying the writer, the article, the publish time and whether it was a republish
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-draft_started: a payload missing started_at is rejected, because the numerator of time-to-publish has no start without it
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-article_published: a payload missing is_republish is rejected, because first publishes and republishes cannot be told apart without it
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-article_published: a payload missing article_id is rejected, because the two events are joined on article_id to compute the duration
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-REGISTRY: the shipped registry lists exactly the two required event types and no others
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-REGISTRY: an event type outside the agreed two is rejected rather than silently stored
   → Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/draft.test.ts > draft autosave > AC-01: after 35 seconds of typing with no manual save, the autosave tick saves the draft and stamps the indicator with the save time
   → Failed to load url ../../src/domain/autosave (resolved id: ../../src/domain/autosave) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/draft.test.ts > draft autosave > AC-01: a tick with nothing typed since the last save writes nothing and leaves the existing indicator alone
   → Failed to load url ../../src/domain/autosave (resolved id: ../../src/domain/autosave) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/draft.test.ts > draft autosave > AC-01: the shipped autosave interval is the assumed 30 seconds
   → Failed to load url ../../src/domain/autosave (resolved id: ../../src/domain/autosave) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/draft.test.ts > draft recovery after a crash > AC-02: reopening a draft whose browser died restores the last autosaved version, not an earlier one
   → Failed to load url ../../src/domain/autosave (resolved id: ../../src/domain/autosave) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04: PSG 2-1 Marseille with tier "Indispensable" is stored as typed fields, with no pronos fixture reference required
   → Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/pronosEntry.test.ts > structured pronos entry > ADR-0002: picking a fixture from pronos stores a denormalised snapshot of it alongside the writer-editable team names
   → Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04a: a confidence tier outside the agreed three is rejected as a field error, not stored as free text
   → Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04b: a missing team name is rejected as a field error, not stored as free text
   → Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04c: a non-integer predicted score is rejected as a field error, not stored as free text
   → Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04: the shipped confidence tiers are exactly the three the contract documents
   → Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/paste.test.ts > paste sanitization > AC-03: pasting a Word document keeps its "Heading 2" paragraph as an H2 and discards the custom font and styling
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/paste.test.ts > paste sanitization > AC-03a: an inline style attribute (colour, background, font-size) is cleaned up automatically
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/paste.test.ts > paste sanitization > AC-03b: a presentational element (<font>) wrapping real text is cleaned up automatically
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/paste.test.ts > paste sanitization > AC-03c: a Google Docs heading, whose structure lives in classes not tags is cleaned up automatically
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/paste.test.ts > paste sanitization > AC-03d: a deeper heading level, which must survive as H3 rather than flatten is cleaned up automatically
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/paste.test.ts > paste sanitization > AC-03e: an executable/unsafe node smuggled in by the clipboard is cleaned up automatically
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/taxonomy.test.ts > category creation > AC-10: assigning an article to a league and type that do not exist creates both, nested league-then-type, with no approval step
   → Failed to load url ../../src/domain/taxonomy (resolved id: ../../src/domain/taxonomy) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/taxonomy.test.ts > category creation > AC-10: an existing league is reused rather than duplicated when only the type is new
   → Failed to load url ../../src/domain/taxonomy (resolved id: ../../src/domain/taxonomy) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/taxonomy.test.ts > category creation > DEC-02: a near-duplicate league name ("ligue1" next to "Ligue 1") is created as its own category, because v1 does no automatic merging
   → Failed to load url ../../src/domain/taxonomy (resolved id: ../../src/domain/taxonomy) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/properties.test.ts > slug invariants (AC-14) > PROP-01: every generated slug is URL-safe and non-empty, whatever punctuation, accents or emoji the title contains
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/properties.test.ts > slug invariants (AC-14) > PROP-02: a slug never collides with one already taken, and stays URL-safe while avoiding it
   → Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/properties.test.ts > lock invariants (AC-05, ADR-0003) > PROP-03: any two timestamps further apart than the staleness threshold mean the lock has expired — for every pair, not just the ones we thought of
   → Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/properties.test.ts > paste sanitization invariants (AC-03) > PROP-04: no styling, class or executable node ever survives sanitization, for any clipboard payload
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/unit/properties.test.ts > paste sanitization invariants (AC-03) > PROP-05: sanitization is idempotent — re-pasting already-clean content changes nothing
   → Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle: the client parses a contract-valid response into the shape the contract declares
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage: the client parses a contract-valid response into the shape the contract declares
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / DEC-01: the client surfaces COVER_IMAGE_REQUIRED as a branchable code, so the editor can point the writer at "add a cover image", not a generic banner
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / AC-08: the client surfaces IMAGE_NOT_READY as a branchable code, so the editor can say "try again in a few seconds" rather than "locked"
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / AC-05: the client surfaces DRAFT_LOCKED as a branchable code, so the editor names the writer holding the lock — the same 409 as IMAGE_NOT_READY
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / NFR-AUTH-01: the client surfaces UNAUTHORIZED as a branchable code, so an expired session prompts re-login instead of looking like a content error
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / NFR-UPLOAD-01: the client surfaces FILE_TOO_LARGE as a branchable code, so the writer is told the file is too big, not that it is broken
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / AC-08: the client surfaces UNSUPPORTED_FORMAT as a branchable code, so the writer is asked to upload a different file (AC-08’s clear error message)
   → Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ✓ tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer test in this file
 × tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-populated: the picker renders one row per fixture, read out of the contract’s own response shape
   → Failed to load url ../../src/client/fixturePicker (resolved id: ../../src/client/fixturePicker) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-emptyGameweek: a league with no open gameweek falls through to manual entry, and is not treated as an error
   → Failed to load url ../../src/client/fixturePicker (resolved id: ../../src/client/fixturePicker) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-notFound: an unrecognised league id falls through to manual entry rather than blocking the writer
   → Failed to load url ../../src/client/fixturePicker (resolved id: ../../src/client/fixturePicker) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-unreachable: pronos being undeployed, down or CORS-blocked also falls through to manual entry, never an unhandled failure
   → Failed to load url ../../src/client/fixturePicker (resolved id: ../../src/client/fixturePicker) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 × tests/db/schema.test.ts > shared asset library > AC-09: a logo uploaded by one writer is listed for every other writer, with no re-upload
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > draft locking under real timing > AC-05: while writer A’s heartbeat is current, writer B’s attempt to take the lock updates no row
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > draft locking under real timing > AC-05: once writer A’s lock is 91 seconds stale, writer B takes it without any admin unlock
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > taxonomy storage > DEC-02: "ligue1" is stored alongside "Ligue 1" instead of being merged into it, because v1 leaves near-duplicates to manual cleanup
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > alt text > AC-15: a writer can overwrite generated alt text with a direct row update, no endpoint involved
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > pronos fixture reference (ADR-0002) > ADR-0002: the pronos match reference is nullable and carries no cross-project foreign key, so manual entry is never blocked
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > telemetry_events store > TELEMETRY-draft_started: the telemetry_events store accepts this required event type
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > telemetry_events store > TELEMETRY-article_published: the telemetry_events store accepts this required event type
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > telemetry_events store > TELEMETRY-REGISTRY: the store rejects an event type outside the agreed two, so the metric cannot be polluted
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > telemetry_events store > AC-18: a draft started at 10:00 and published at 10:47 yields a 47-minute time-to-publish from the stored events alone
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > write protection and disclosure > NFR-RLS-01: row level security is enabled on every table the editor reaches through PostgREST
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > write protection and disclosure > NFR-RLS-02: the anon role can read a published article but never an unpublished one
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > write protection and disclosure > NFR-RLS-03: the anon role cannot read images belonging to an unpublished article
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > write protection and disclosure > NFR-TAMPER-01: a writer cannot set published_at directly — publish-controlled columns are not writable through PostgREST
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > write protection and disclosure > NFR-AUDIT-01: every article and every telemetry row is stamped with a writer id that cannot be null
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/db/schema.test.ts > migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only
   → No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 × tests/contract/provider.schemathesis.test.ts > OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-publishArticle: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/publish 2097ms
   → provider status: Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?

schemathesis output:
Schemathesis v4.24.3
━━━━━━━━━━━━━━━━━━━━

 🕛  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y… 🕐  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y… 🕐  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y…
 ✅  Loaded specification from                                                  
 /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.yaml  
 (in 0.14s)                                                                     

     Base URL:         http://127.0.0.1:62739                                   
     Specification:    Open API 3.1.0                                           
     Operations:       1 selected / 2 total                                     

 🕛  Probing API capabilities 🕛  Probing API capabilities
 ✅  API capabilities:                                                          

     Supports NULL byte in headers:                            ✘                
     Accepts backslash and control characters in URL paths:    ✘                

     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Examples (in 0.17s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Coverage

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/publish

       🕐  Coverage

     0:00:00                                                            0% (0/1)

   ⠙ 0:00:00  POST /v1/articles/{articleId}/publish

       🕑  Coverage

     0:00:00                                                            0% (0/1)

   ⠹ 0:00:00  POST /v1/articles/{articleId}/publish

       🕒  Coverage

     0:00:00                                                            0% (0/1)

   ⠸ 0:00:00  POST /v1/articles/{articleId}/publish

       🕓  Coverage

     0:00:00                                                            0% (0/1)

   ⠴ 0:00:00  POST /v1/articles/{articleId}/publish

           Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Coverage (in 0.68s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Fuzzing

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/publish

           Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Fuzzing (in 0.26s)                                                         
                                                                                
     🚫 1 error                                                                 

==================================== ERRORS ====================================
____________________ POST /v1/articles/{articleId}/publish _____________________
Network Error

Connection failed

    Failed to establish a new connection: [Errno 61] Connection refused

Need more help?
    Join our Discord server: https://discord.gg/R9ASRAmHnA
=================================== SUMMARY ====================================

API Operations:
  Selected: 1/2
  Tested: 0
  Errored: 1

Test Phases:
  🚫 Examples
  🚫 Coverage
  🚫 Fuzzing
  ⏭  Stateful (not applicable)

Errors:
  🚫 Network Error: 1

Test cases:
  63 generated, 63 skipped

Seed: 82645410212407609112543761377404395273

=============================== 1 error in 1.15s ===============================
: expected 1 to be +0 // Object.is equality
 × tests/contract/provider.schemathesis.test.ts > OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-uploadArticleImage: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/images 1512ms
   → provider status: Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?

schemathesis output:
Schemathesis v4.24.3
━━━━━━━━━━━━━━━━━━━━

 🕛  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y… 🕛  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y…
 ✅  Loaded specification from                                                  
 /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.yaml  
 (in 0.09s)                                                                     

     Base URL:         http://127.0.0.1:62739                                   
     Specification:    Open API 3.1.0                                           
     Operations:       1 selected / 2 total                                     

 🕛  Probing API capabilities 🕛  Probing API capabilities
 ✅  API capabilities:                                                          

     Supports NULL byte in headers:                            ✘                
     Accepts backslash and control characters in URL paths:    ✘                

     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Examples (in 0.15s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Coverage

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/images

       🕐  Coverage

     0:00:00                                                            0% (0/1)

   ⠙ 0:00:00  POST /v1/articles/{articleId}/images

       🕑  Coverage

     0:00:00                                                            0% (0/1)

   ⠹ 0:00:00  POST /v1/articles/{articleId}/images

           Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Coverage (in 0.53s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Fuzzing

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/images

           Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Fuzzing (in 0.24s)                                                         
                                                                                
     🚫 1 error                                                                 

==================================== ERRORS ====================================
_____________________ POST /v1/articles/{articleId}/images _____________________
Network Error

Connection failed

    Failed to establish a new connection: [Errno 61] Connection refused

Need more help?
    Join our Discord server: https://discord.gg/R9ASRAmHnA
=================================== SUMMARY ====================================

API Operations:
  Selected: 1/2
  Tested: 0
  Errored: 1

Test Phases:
  🚫 Examples
  🚫 Coverage
  🚫 Fuzzing
  ⏭  Stateful (not applicable)

Errors:
  🚫 Network Error: 1

Test cases:
  40 generated, 40 skipped

Seed: 234475988524990842599965334684321659700

=============================== 1 error in 0.96s ===============================
: expected 1 to be +0 // Object.is equality

⎯⎯⎯⎯⎯⎯ Failed Tests 124 ⎯⎯⎯⎯⎯⎯

 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle: the client parses a contract-valid response into the shape the contract declares
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage: the client parses a contract-valid response into the shape the contract declares
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / DEC-01: the client surfaces COVER_IMAGE_REQUIRED as a branchable code, so the editor can point the writer at "add a cover image", not a generic banner
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / AC-08: the client surfaces IMAGE_NOT_READY as a branchable code, so the editor can say "try again in a few seconds" rather than "locked"
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / AC-05: the client surfaces DRAFT_LOCKED as a branchable code, so the editor names the writer holding the lock — the same 409 as IMAGE_NOT_READY
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-publishArticle / NFR-AUTH-01: the client surfaces UNAUTHORIZED as a branchable code, so an expired session prompts re-login instead of looking like a content error
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / NFR-UPLOAD-01: the client surfaces FILE_TOO_LARGE as a branchable code, so the writer is told the file is too big, not that it is broken
 FAIL  tests/contract/consumer.prism.test.ts > OpenAPI consumer contract (Prism mock) > CONTRACT-CONSUMER-uploadArticleImage / AC-08: the client surfaces UNSUPPORTED_FORMAT as a branchable code, so the writer is asked to upload a different file (AC-08’s clear error message)
Error: Failed to load url ../../src/api/client (resolved id: ../../src/api/client) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/124]⎯

 FAIL  tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-populated: the picker renders one row per fixture, read out of the contract’s own response shape
 FAIL  tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-emptyGameweek: a league with no open gameweek falls through to manual entry, and is not treated as an error
 FAIL  tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-notFound: an unrecognised league id falls through to manual entry rather than blocking the writer
 FAIL  tests/contract/pronos-fixtures.prism.test.ts > pronos fixture picker (consumer contract) > CONTRACT-CONSUMER-fixturePicker-unreachable: pronos being undeployed, down or CORS-blocked also falls through to manual entry, never an unhandled failure
Error: Failed to load url ../../src/client/fixturePicker (resolved id: ../../src/client/fixturePicker) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/124]⎯

 FAIL  tests/contract/provider.schemathesis.test.ts > OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-publishArticle: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/publish
AssertionError: provider status: Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?

schemathesis output:
Schemathesis v4.24.3
━━━━━━━━━━━━━━━━━━━━

 🕛  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y… 🕐  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y… 🕐  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y…
 ✅  Loaded specification from                                                  
 /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.yaml  
 (in 0.14s)                                                                     

     Base URL:         http://127.0.0.1:62739                                   
     Specification:    Open API 3.1.0                                           
     Operations:       1 selected / 2 total                                     

 🕛  Probing API capabilities 🕛  Probing API capabilities
 ✅  API capabilities:                                                          

     Supports NULL byte in headers:                            ✘                
     Accepts backslash and control characters in URL paths:    ✘                

     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Examples (in 0.17s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Coverage

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/publish

       🕐  Coverage

     0:00:00                                                            0% (0/1)

   ⠙ 0:00:00  POST /v1/articles/{articleId}/publish

       🕑  Coverage

     0:00:00                                                            0% (0/1)

   ⠹ 0:00:00  POST /v1/articles/{articleId}/publish

       🕒  Coverage

     0:00:00                                                            0% (0/1)

   ⠸ 0:00:00  POST /v1/articles/{articleId}/publish

       🕓  Coverage

     0:00:00                                                            0% (0/1)

   ⠴ 0:00:00  POST /v1/articles/{articleId}/publish

           Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Coverage (in 0.68s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Fuzzing

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/publish

           Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Fuzzing (in 0.26s)                                                         
                                                                                
     🚫 1 error                                                                 

==================================== ERRORS ====================================
____________________ POST /v1/articles/{articleId}/publish _____________________
Network Error

Connection failed

    Failed to establish a new connection: [Errno 61] Connection refused

Need more help?
    Join our Discord server: https://discord.gg/R9ASRAmHnA
=================================== SUMMARY ====================================

API Operations:
  Selected: 1/2
  Tested: 0
  Errored: 1

Test Phases:
  🚫 Examples
  🚫 Coverage
  🚫 Fuzzing
  ⏭  Stateful (not applicable)

Errors:
  🚫 Network Error: 1

Test cases:
  63 generated, 63 skipped

Seed: 82645410212407609112543761377404395273

=============================== 1 error in 1.15s ===============================
: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/contract/provider.schemathesis.test.ts:74:7
     72|       result.exitCode,
     73|       `provider status: ${providerStartFailure}\n\nschemathesis output…
     74|     ).toBe(0);
       |       ^
     75|   });
     76| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/124]⎯

 FAIL  tests/contract/provider.schemathesis.test.ts > OpenAPI provider contract (Schemathesis) > CONTRACT-PROVIDER-uploadArticleImage: the running Edge Function satisfies the contract for POST /v1/articles/{articleId}/images
AssertionError: provider status: Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?

schemathesis output:
Schemathesis v4.24.3
━━━━━━━━━━━━━━━━━━━━

 🕛  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y… 🕛  Loading specification from                                                 
     /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.y…
 ✅  Loaded specification from                                                  
 /Users/lionelleboiteux/work/arsene-cms/pdlc/arsene-cms/contracts/openapi.yaml  
 (in 0.09s)                                                                     

     Base URL:         http://127.0.0.1:62739                                   
     Specification:    Open API 3.1.0                                           
     Operations:       1 selected / 2 total                                     

 🕛  Probing API capabilities 🕛  Probing API capabilities
 ✅  API capabilities:                                                          

     Supports NULL byte in headers:                            ✘                
     Accepts backslash and control characters in URL paths:    ✘                

     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Examples

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Examples (in 0.15s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Coverage

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/images

       🕐  Coverage

     0:00:00                                                            0% (0/1)

   ⠙ 0:00:00  POST /v1/articles/{articleId}/images

       🕑  Coverage

     0:00:00                                                            0% (0/1)

   ⠹ 0:00:00  POST /v1/articles/{articleId}/images

           Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Coverage

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Coverage (in 0.53s)                                                        
                                                                                
     🚫 1 error                                                                 

 🕛  Fuzzing

     0:00:00                                                            0% (0/1)

   ⠋ 0:00:00  POST /v1/articles/{articleId}/images

           Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error     Fuzzing

     0:00:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% (1/1)


     🚫 1 error
 🚫  Fuzzing (in 0.24s)                                                         
                                                                                
     🚫 1 error                                                                 

==================================== ERRORS ====================================
_____________________ POST /v1/articles/{articleId}/images _____________________
Network Error

Connection failed

    Failed to establish a new connection: [Errno 61] Connection refused

Need more help?
    Join our Discord server: https://discord.gg/R9ASRAmHnA
=================================== SUMMARY ====================================

API Operations:
  Selected: 1/2
  Tested: 0
  Errored: 1

Test Phases:
  🚫 Examples
  🚫 Coverage
  🚫 Fuzzing
  ⏭  Stateful (not applicable)

Errors:
  🚫 Network Error: 1

Test cases:
  40 generated, 40 skipped

Seed: 234475988524990842599965334684321659700

=============================== 1 error in 0.96s ===============================
: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/contract/provider.schemathesis.test.ts:74:7
     72|       result.exitCode,
     73|       `provider status: ${providerStartFailure}\n\nschemathesis output…
     74|     ).toBe(0);
       |       ^
     75|   });
     76| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/124]⎯

 FAIL  tests/db/publicSiteRender.test.ts > public site > AC-12: the homepage lists every league’s articles newest first, regardless of league
 FAIL  tests/db/publicSiteRender.test.ts > public site > AC-11: a category with no published article shows "No articles yet" rather than an error or a blank page
 FAIL  tests/db/publicSiteRender.test.ts > public site > AC-06: the category listing and the social preview both use the cover image, and never a body image
 FAIL  tests/db/publicSiteRender.test.ts > public site > AC-14: the published article page embeds its schema.org markup and the sitemap carries its canonical URL, with no writer action
 FAIL  tests/db/publicSiteRender.test.ts > public site > NFR-EGRESS-01: no rendered page points a visitor at Supabase Storage, because hotlinking blows the 5 GB/month egress free tier
 FAIL  tests/db/publicSiteRender.test.ts > public site > NFR-RLS-02: no draft ever reaches the rendered public site, on the homepage or in the sitemap
Error: Failed to load url ../../src/site/render (resolved id: ../../src/site/render) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/124]⎯

 FAIL  tests/db/schema.test.ts > shared asset library > AC-09: a logo uploaded by one writer is listed for every other writer, with no re-upload
 FAIL  tests/db/schema.test.ts > draft locking under real timing > AC-05: while writer A’s heartbeat is current, writer B’s attempt to take the lock updates no row
 FAIL  tests/db/schema.test.ts > draft locking under real timing > AC-05: once writer A’s lock is 91 seconds stale, writer B takes it without any admin unlock
 FAIL  tests/db/schema.test.ts > taxonomy storage > DEC-02: "ligue1" is stored alongside "Ligue 1" instead of being merged into it, because v1 leaves near-duplicates to manual cleanup
 FAIL  tests/db/schema.test.ts > alt text > AC-15: a writer can overwrite generated alt text with a direct row update, no endpoint involved
 FAIL  tests/db/schema.test.ts > pronos fixture reference (ADR-0002) > ADR-0002: the pronos match reference is nullable and carries no cross-project foreign key, so manual entry is never blocked
 FAIL  tests/db/schema.test.ts > telemetry_events store > TELEMETRY-draft_started: the telemetry_events store accepts this required event type
 FAIL  tests/db/schema.test.ts > telemetry_events store > TELEMETRY-article_published: the telemetry_events store accepts this required event type
 FAIL  tests/db/schema.test.ts > telemetry_events store > TELEMETRY-REGISTRY: the store rejects an event type outside the agreed two, so the metric cannot be polluted
 FAIL  tests/db/schema.test.ts > telemetry_events store > AC-18: a draft started at 10:00 and published at 10:47 yields a 47-minute time-to-publish from the stored events alone
 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-RLS-01: row level security is enabled on every table the editor reaches through PostgREST
 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-RLS-02: the anon role can read a published article but never an unpublished one
 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-RLS-03: the anon role cannot read images belonging to an unpublished article
 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-TAMPER-01: a writer cannot set published_at directly — publish-controlled columns are not writable through PostgREST
 FAIL  tests/db/schema.test.ts > write protection and disclosure > NFR-AUDIT-01: every article and every telemetry row is stamped with a writer id that cannot be null
Error: No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 ❯ readMigrationFiles tests/support/pg.ts:34:11
     32| export function readMigrationFiles(): string[] {
     33|   if (!existsSync(MIGRATIONS_DIR)) {
     34|     throw new Error(
       |           ^
     35|       `No production migrations found: ${MIGRATIONS_DIR} does not exis…
     36|         `Arsène's Postgres schema (articles, article_images, categorie…
 ❯ Module.startTestDatabase tests/support/pg.ts:61:18
 ❯ tests/db/schema.test.ts:37:15

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/124]⎯

 FAIL  tests/db/schema.test.ts > migration discipline > NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only
Error: No production migrations found: /Users/lionelleboiteux/work/arsene-cms/db/migrations does not exist. Arsène's Postgres schema (articles, article_images, categories, leagues, pronos_entries, site_assets, telemetry_events + their RLS policies) must be delivered as expand-only migrations in db/migrations/*.sql (02-architecture.v1.md §6 "Migration safety: expand-only").
 ❯ Module.readMigrationFiles tests/support/pg.ts:34:11
     32| export function readMigrationFiles(): string[] {
     33|   if (!existsSync(MIGRATIONS_DIR)) {
     34|     throw new Error(
       |           ^
     35|       `No production migrations found: ${MIGRATIONS_DIR} does not exis…
     36|         `Arsène's Postgres schema (articles, article_images, categorie…
 ❯ tests/db/schema.test.ts:403:23

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/124]⎯

 FAIL  tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-01: a draft with a real uploaded cover publishes, goes live with a slug, and leaves both telemetry rows needed to compute time-to-publish
 FAIL  tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-02: a publish refused for a missing cover image leaves the article unpublished and writes no article_published row at all
 FAIL  tests/e2e/publishJourney.test.ts > end-to-end publishing journey > E2E-03: republishing an article that went live 3 days ago updates the live content immediately, with no approval step, and is recorded as a republish
Error: Failed to load url ../../src/api/server (resolved id: ../../src/api/server) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/124]⎯

 FAIL  tests/telemetry/emission.test.ts > telemetry: draft_started > TELEMETRY-draft_started: creating a new draft emits exactly one draft_started carrying the writer, the article and the start time
 FAIL  tests/telemetry/emission.test.ts > telemetry: draft_started > TELEMETRY-draft_started (negative): reopening an existing draft emits no second draft_started, so a crash-and-resume cannot reset the clock
Error: Failed to load url ../../src/api/createDraft (resolved id: ../../src/api/createDraft) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/124]⎯

 FAIL  tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published: a successful first publish emits exactly one event, flagged as not a republish
 FAIL  tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published: republishing emits an event flagged is_republish, so republishes cannot be counted as first publishes
 FAIL  tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / DEC-01: a publish refused for a missing cover image emits no article_published event
 FAIL  tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / AC-08: a publish refused because an image is still processing emits no article_published event
 FAIL  tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / AC-05: a publish refused because another writer holds the draft lock emits no article_published event
 FAIL  tests/telemetry/emission.test.ts > telemetry: article_published > TELEMETRY-article_published (negative) / NFR-AUTH-01: a publish refused for a missing bearer token emits no article_published event
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > DEC-01: publishing an article with no cover image at all (01-decisions.md #1: cover is mandatory) is refused with 400 COVER_IMAGE_REQUIRED
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > AC-04: publishing a Pronos article whose structured match fields are invalid is refused with 400 VALIDATION_FAILED
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > AC-08a: publishing a cover image still being optimised is refused with 409 IMAGE_NOT_READY
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > AC-08b: publishing a body image that failed optimisation and was never replaced is refused with 409 IMAGE_NOT_READY
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > AC-05: publishing a draft another writer currently holds the edit lock on is refused with 409 DRAFT_LOCKED
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > NFR-AUTH-01: publishing a request carrying no writer bearer token is refused with 401 UNAUTHORIZED
 FAIL  tests/unit/publishArticle.test.ts > publish refusals > CONTRACT-publish-404: publishing an article id that does not exist is refused with 404 NOT_FOUND
 FAIL  tests/unit/publishArticle.test.ts > publish > AC-14: a successful first publish returns the automatically generated slug, JSON-LD and sitemap entry in the shape the contract declares
 FAIL  tests/unit/publishArticle.test.ts > publish > AC-13: meta title and description edited by the writer at the publish step are used verbatim instead of the suggestion
 FAIL  tests/unit/publishArticle.test.ts > publish > AC-16: an article the content check flagged still publishes when the writer chooses to publish anyway
 FAIL  tests/unit/publishArticle.test.ts > publish > AC-17: republishing an article that went live 3 days ago refreshes published_at, keeps first_published_at, and is flagged as a republish
 FAIL  tests/unit/publishArticle.test.ts > publish > AC-17: publishing triggers on-demand revalidation of the article, its category page and the homepage, so the update is live immediately
 FAIL  tests/unit/publishArticle.test.ts > publish > NFR-OBS-01: a failed revalidation is recorded as a failure rather than passing silently, because a writer seeing no change is otherwise invisible
 FAIL  tests/unit/publishArticle.test.ts > publish > NFR-IDEM-01: replaying the same Idempotency-Key does not record a second article_published event, so time-to-publish is not skewed by a retry
 FAIL  tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01a: the 10th publish attempt in a minute from one IP is still served
 FAIL  tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01b: the 11th publish attempt in a minute from the same IP is rejected with 429
 FAIL  tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01c: a second writer on a different IP is unaffected by the first IP exhausting its budget
Error: Failed to load url ../../src/api/publishArticle (resolved id: ../../src/api/publishArticle) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[10/124]⎯

 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-draft_started: builds a row carrying the writer, the article and the moment the draft started
 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-article_published: builds a row carrying the writer, the article, the publish time and whether it was a republish
 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-draft_started: a payload missing started_at is rejected, because the numerator of time-to-publish has no start without it
 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-article_published: a payload missing is_republish is rejected, because first publishes and republishes cannot be told apart without it
 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-article_published: a payload missing article_id is rejected, because the two events are joined on article_id to compute the duration
 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-REGISTRY: the shipped registry lists exactly the two required event types and no others
 FAIL  tests/telemetry/eventShape.test.ts > telemetry event shape > TELEMETRY-REGISTRY: an event type outside the agreed two is rejected rather than silently stored
Error: Failed to load url ../../src/telemetry/events (resolved id: ../../src/telemetry/events) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[11/124]⎯

 FAIL  tests/unit/draft.test.ts > draft autosave > AC-01: after 35 seconds of typing with no manual save, the autosave tick saves the draft and stamps the indicator with the save time
 FAIL  tests/unit/draft.test.ts > draft autosave > AC-01: a tick with nothing typed since the last save writes nothing and leaves the existing indicator alone
 FAIL  tests/unit/draft.test.ts > draft autosave > AC-01: the shipped autosave interval is the assumed 30 seconds
 FAIL  tests/unit/draft.test.ts > draft recovery after a crash > AC-02: reopening a draft whose browser died restores the last autosaved version, not an earlier one
Error: Failed to load url ../../src/domain/autosave (resolved id: ../../src/domain/autosave) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[12/124]⎯

 FAIL  tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > AC-07: a valid 4 MB JPEG is handled distinguishably
 FAIL  tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > AC-08a: a corrupted file that still sniffs as a JPEG is handled distinguishably
 FAIL  tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > AC-08b: a container this pipeline does not support at all is handled distinguishably
 FAIL  tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > NFR-UPLOAD-01: a decodable JPEG over the 20 MB limit is handled distinguishably
 FAIL  tests/unit/imageOptimize.test.ts > image optimisation (real codec, real files) > NFR-UPLOAD-01: the shipped maximum upload size is the 20 MB the contract promises callers
Error: Failed to load url ../../src/images/optimize (resolved id: ../../src/images/optimize) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/124]⎯

 FAIL  tests/unit/lock.test.ts > draft locking > AC-05: writer B opening a draft writer A is actively editing is refused, and told who holds it
 FAIL  tests/unit/lock.test.ts > draft locking > AC-05: writer A is never locked out of the draft they themselves hold
 FAIL  tests/unit/lock.test.ts > draft locking > AC-05: a lock left behind by a crashed browser expires on its own, so writer B can edit without an admin unlock
 FAIL  tests/unit/lock.test.ts > draft locking > AC-05: a draft nobody holds is editable
 FAIL  tests/unit/lock.test.ts > draft locking > NFR-LOCK-01a: a lock one heartbeat old gives isLockStale=false
 FAIL  tests/unit/lock.test.ts > draft locking > NFR-LOCK-01b: a lock exactly at the staleness threshold gives isLockStale=false
 FAIL  tests/unit/lock.test.ts > draft locking > NFR-LOCK-01c: a lock one millisecond past the threshold gives isLockStale=true
 FAIL  tests/unit/lock.test.ts > draft locking > NFR-LOCK-02: the shipped heartbeat and staleness constants are ADR-0003’s, and the window spans several heartbeats so a slow network cannot steal a live lock
 FAIL  tests/unit/properties.test.ts > lock invariants (AC-05, ADR-0003) > PROP-03: any two timestamps further apart than the staleness threshold mean the lock has expired — for every pair, not just the ones we thought of
Error: Failed to load url ../../src/domain/lock (resolved id: ../../src/domain/lock) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/124]⎯

 FAIL  tests/unit/paste.test.ts > paste sanitization > AC-03: pasting a Word document keeps its "Heading 2" paragraph as an H2 and discards the custom font and styling
 FAIL  tests/unit/paste.test.ts > paste sanitization > AC-03a: an inline style attribute (colour, background, font-size) is cleaned up automatically
 FAIL  tests/unit/paste.test.ts > paste sanitization > AC-03b: a presentational element (<font>) wrapping real text is cleaned up automatically
 FAIL  tests/unit/paste.test.ts > paste sanitization > AC-03c: a Google Docs heading, whose structure lives in classes not tags is cleaned up automatically
 FAIL  tests/unit/paste.test.ts > paste sanitization > AC-03d: a deeper heading level, which must survive as H3 rather than flatten is cleaned up automatically
 FAIL  tests/unit/paste.test.ts > paste sanitization > AC-03e: an executable/unsafe node smuggled in by the clipboard is cleaned up automatically
 FAIL  tests/unit/properties.test.ts > paste sanitization invariants (AC-03) > PROP-04: no styling, class or executable node ever survives sanitization, for any clipboard payload
 FAIL  tests/unit/properties.test.ts > paste sanitization invariants (AC-03) > PROP-05: sanitization is idempotent — re-pasting already-clean content changes nothing
Error: Failed to load url ../../src/domain/paste (resolved id: ../../src/domain/paste) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[15/124]⎯

 FAIL  tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04: PSG 2-1 Marseille with tier "Indispensable" is stored as typed fields, with no pronos fixture reference required
 FAIL  tests/unit/pronosEntry.test.ts > structured pronos entry > ADR-0002: picking a fixture from pronos stores a denormalised snapshot of it alongside the writer-editable team names
 FAIL  tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04a: a confidence tier outside the agreed three is rejected as a field error, not stored as free text
 FAIL  tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04b: a missing team name is rejected as a field error, not stored as free text
 FAIL  tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04c: a non-integer predicted score is rejected as a field error, not stored as free text
 FAIL  tests/unit/pronosEntry.test.ts > structured pronos entry > AC-04: the shipped confidence tiers are exactly the three the contract documents
Error: Failed to load url ../../src/domain/pronosEntry (resolved id: ../../src/domain/pronosEntry) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[16/124]⎯

 FAIL  tests/unit/properties.test.ts > slug invariants (AC-14) > PROP-01: every generated slug is URL-safe and non-empty, whatever punctuation, accents or emoji the title contains
 FAIL  tests/unit/properties.test.ts > slug invariants (AC-14) > PROP-02: a slug never collides with one already taken, and stays URL-safe while avoiding it
 FAIL  tests/unit/seo.test.ts > meta suggestion > AC-13: reaching the publish step yields a meta title and description pre-filled from the article and short enough for the contract to accept
 FAIL  tests/unit/seo.test.ts > technical SEO fields > AC-14: the URL slug is derived from the title with no writer action, matching the slug the contract documents
 FAIL  tests/unit/seo.test.ts > technical SEO fields > AC-14: the generated schema.org markup is a valid NewsArticle carrying the cover image and both publish timestamps
 FAIL  tests/unit/seo.test.ts > technical SEO fields > AC-14: the sitemap entry points at the article’s canonical URL and is dated by this publish
 FAIL  tests/unit/seo.test.ts > image alt text > AC-15: alt text is generated from the article’s own context rather than the file name
 FAIL  tests/unit/seo.test.ts > SEO/AEO/GEO advisory check > AC-16: an article with a too-short introduction is flagged, and no advisory ever claims to block publishing
Error: Failed to load url ../../src/domain/seo (resolved id: ../../src/domain/seo) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[17/124]⎯

 FAIL  tests/unit/publishArticle.test.ts > publish rate limiting > NFR-RATE-01d: the shipped limiter exposes the assumed 10-per-minute-per-IP threshold
Error: Failed to load url ../../src/api/rateLimit (resolved id: ../../src/api/rateLimit) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[18/124]⎯

 FAIL  tests/unit/taxonomy.test.ts > category creation > AC-10: assigning an article to a league and type that do not exist creates both, nested league-then-type, with no approval step
 FAIL  tests/unit/taxonomy.test.ts > category creation > AC-10: an existing league is reused rather than duplicated when only the type is new
 FAIL  tests/unit/taxonomy.test.ts > category creation > DEC-02: a near-duplicate league name ("ligue1" next to "Ligue 1") is created as its own category, because v1 does no automatic merging
Error: Failed to load url ../../src/domain/taxonomy (resolved id: ../../src/domain/taxonomy) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[19/124]⎯

 FAIL  tests/unit/uploadImage.test.ts > image upload > AC-07: a 4 MB JPEG comes back as a compressed WebP/AVIF resource, and the bytes actually stored for visitors are far smaller than the upload
 FAIL  tests/unit/uploadImage.test.ts > image upload > AC-15: a processed image carries auto-generated alt text, ready for the writer to override
 FAIL  tests/unit/uploadImage.test.ts > image upload > AC-06: uploading a new cover demotes the article’s previous cover to a body image and names the image it replaced
 FAIL  tests/unit/uploadImage.test.ts > image upload > AC-06: a body-image upload never claims to have replaced a cover
 FAIL  tests/unit/uploadImage.test.ts > image upload > AC-08: a file whose format cannot be recognised is refused with a clear error and creates no image row at all
 FAIL  tests/unit/uploadImage.test.ts > image upload > AC-08: a file that passes format detection but fails to decode becomes a failed image the writer is told to replace, never a silently broken one
 FAIL  tests/unit/uploadImage.test.ts > image upload > NFR-UPLOAD-01: a file over the contract’s 20 MB limit is rejected with 413 before the codec is ever handed the bytes
 FAIL  tests/unit/uploadImage.test.ts > image upload > NFR-AUTH-01: an image upload with no writer bearer token is rejected 401 before anything is stored
 FAIL  tests/unit/uploadImage.test.ts > image upload > NFR-IDEM-02: replaying an upload with the same Idempotency-Key returns the original resource and uploads nothing a second time
Error: Failed to load url ../../src/api/uploadImage (resolved id: ../../src/api/uploadImage) in /Users/lionelleboiteux/work/arsene-cms/tests/support/seams.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[20/124]⎯

 Test Files  18 failed (18)
      Tests  124 failed | 2 passed (126)
   Start at  16:07:56
   Duration  5.36s (transform 381ms, setup 0ms, collect 3.68s, tests 9.42s, environment 3ms, prepare 1.05s)

```
