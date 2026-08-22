# Changelog

All notable changes to Arsène CMS will be documented in this file.

## [Unreleased]

## [0.2.0] — 2026-08-22

### Added

- **Deno port:** `src/api/router.ts`'s core (`route()`, `dispatch()`, every handler-dependency builder) now runs on the standard Fetch API (`Request` in, `Response` out) instead of Node's `http` types. A real Deno entry point (`supabase/functions/arsene-api/index.ts`, a genuine `Deno.serve` handler) deploys to Supabase Edge Functions — the runtime ADR-0001 named and that 0.1.0 could not actually run on. The Node adapter (`startHttpServer`) is unchanged; the whole 0.1.0 test suite passes against it unedited.
- **Benefit dashboard:** `dashboard/index.html`, a single self-contained static file (no framework, no build step) showing the project's one success metric ("time from draft start to published") and its counter-metric ("writer adoption must not decline"), backed by a new read-only adapter, `GET /internal/metrics/time-to-publish` on the same Edge Function.
- **Deploy/rollback mechanism, both halves:** `.github/workflows/deploy.yml`/`rollback.yml` now run real commands for both the Postgres migration half and the API-server half (`supabase functions deploy`), replacing 0.1.0's migration-only mechanism and its loudly-failing API-server stub.

### Fixed

- **Forbidden-method crash:** the WHATWG Fetch spec forbids constructing a `Request` with method `TRACE`/`TRACK`/`CONNECT`. Found by the existing Schemathesis contract suite the moment the Node adapter was rebuilt on a real `Request` object; fixed by passing the real wire method to `route()` explicitly rather than trusting `request.method`.

### Known Limitations

0.1.0's two accepted findings (migration data compatibility, discard route not client-accessible — see below) remain open and tracked, unchanged. Two more are disclosed here, non-blocking, from this release's own gates:

3. **Real deploy not yet rehearsed:** the actual `supabase functions deploy` round-trip against the real linked Supabase project has not been executed — only local rehearsal (real Deno process, real Postgres, real HTTP). See [10-pipeline.v2.md](pdlc/arsene-cms/10-pipeline.v2.md) §2.
4. **JWT signing model is Supabase's legacy one:** current Supabase docs describe the shared HS256 secret `src/api/auth.ts` verifies against as "no longer recommended," superseded by a newer Signing Keys system. Not a regression, not fixed here. See [10-pipeline.v2.md](pdlc/arsene-cms/10-pipeline.v2.md) §4.

## [0.1.0] — 2026-08-22

### Added

- **Core drafting flow:** `POST /v1/articles` creates a draft, takes the edit lock for the creating writer, and synchronously records the `draft_started` telemetry event (required for the project's success metric). `POST /v1/articles/{id}/open` reopens an existing draft with a staleness-checked compare-and-swap lock mechanism.
- **Publishing:** `POST /v1/articles/{id}/publish` publishes a draft to the public site, generates slug and JSON-LD structured data, and synchronously records the `article_published` telemetry event.
- **Supabase Auth (JWT):** Real Supabase Auth integration for writer authentication. Every API operation requires a valid bearer JWT; RLS policies restrict all data access to authenticated writers.
- **Image upload and async optimization:** `POST /v1/articles/{id}/images` accepts cover and body images, uploads to S3, and returns immediately with `status: processing`. An S3 event notification triggers a Lambda function running `sharp` for WebP/AVIF/HEIC conversion and compression; Lambda calls back to flip `article_images.status` to `ready` or `failed`. The editor polls/subscribes on Realtime to observe completion.
- **Draft locking via staleness:** Locks expire automatically 90 seconds after the last heartbeat (heartbeat every 20 seconds), enabling self-healing if a writer's browser crashes. Implemented via `locked_by` and `locked_at` columns.
- **Image recovery:** `DELETE /v1/articles/{id}/images/{id}` (server-side only, via direct Edge Function call — see Known Limitations below) lets writers discard failed/rejected images and unblock articles stuck in an unpublishable state.
- **Cover-slot uniqueness:** Migration `0005_one_ready_cover_per_article.sql` adds a partial unique index enforcing one ready cover per article. Public-site render falls back to the persisted `structured_data.image` if no live ready cover exists.
- **Test suite:** 227 tests covering unit/integration/contract/e2e scenarios using Vitest, Testcontainers (real Postgres), and Schemathesis (contract validation).

### Fixed

- **Writer authorization:** Verify gate found a placeholder (static secret comparison) that was never replaced. Fixed: all Edge Functions now verify real Supabase JWT signatures and extract the writer's `sub` claim → `writer_id`.
- **Image optimization timeout risk:** Real photos (6-12MP) exceeded Supabase Edge Functions' 2-second CPU budget with the WASM codec. Fixed: moved optimization to Lambda + S3, removing the CPU ceiling and enabling full `sharp` codec support (JPEG, PNG, WebP, AVIF, HEIC).
- **Upload race on cover slot:** Concurrent cover uploads could leave the database in an inconsistent state (multiple ready covers per article). Fixed: `db/migrations/0004_image_role_service_role_only.sql` revoked the `update (role)` grant from the `authenticated` role; only `POST .../images` (server-side, validated) can set the cover slot now.

### Known Limitations

Two findings from the verify gate were accepted by the product owner and shipped as known limitations rather than continuing remediation:

1. **Migration data compatibility (Medium):** `0005_one_ready_cover_per_article.sql` will abort if applied to a database already holding duplicate ready-cover rows on a single article — a state proven reachable through ordinary concurrent use. No auto-reconciliation step is included in the migration itself. See README for mitigation.

2. **Discard route not client-accessible (Medium):** The `DELETE /v1/articles/{id}/images/{id}` recovery capability was added to the server (`src/api/discardImage.ts`), but has no method on `src/api/client.ts` and no declared path item in `contracts/openapi.yaml`. The editor SPA cannot construct a request to it without a direct HTTP call or a client release. See README for mitigation.

### See Also

- [02-architecture.v1.md](pdlc/arsene-cms/02-architecture.v1.md) — full design rationale, cost analysis, threat model
- [ADRs 0001–0004](pdlc/arsene-cms/adr/) — architectural decisions with consequences
- [05-verification.v8.md](pdlc/arsene-cms/05-verification.v8.md) — the final verify gate report, including the full set of eight remediation cycles
