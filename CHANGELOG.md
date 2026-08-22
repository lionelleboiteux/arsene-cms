# Changelog

All notable changes to Arsène CMS will be documented in this file.

## [Unreleased]

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
