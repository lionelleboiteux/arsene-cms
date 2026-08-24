# Changelog

All notable changes to Arsène CMS will be documented in this file.

## [Unreleased]

### Added

- **Writer provisioning script:** there was no way to actually create a writer — `writers` is a real table (`db/migrations/0001_initial_schema.sql`) and `auth.ts` already treats a JWT's `sub` claim as `writers.id`, but nothing ever created either half. `scripts/create-writer.ts` creates the Supabase Auth user via the Admin REST API (or finds the existing one if the email is already registered, so it's safe to re-run), upserts the matching `writers` row with that same id, and prints a one-time sign-in link so the writer doesn't need project SMTP configured to get in. `npm run create-writer -- <email> "<display name>"`.

### Fixed

- **`writers` table was fully writable by the public `anon` key (Critical):** discovered via Supabase's own security advisor while provisioning the first real writer. `writers` (and the deploy-tracking table `_migrations_applied`) had RLS disabled and full `INSERT/UPDATE/DELETE/TRUNCATE` grants to `anon`/`authenticated` — neither table matched what `db/migrations/0001_initial_schema.sql` specifies, because neither was ever created by that migration (see below). Fixed by bringing both in line with the migration's intent: RLS enabled, grants narrowed to `select` only for `writers` (via `anon_reads_writers`/`writers_read_writers` policies), and zero client access to `_migrations_applied`.
- **Arsène's Postgres schema had never actually been deployed to production (Critical):** the real gap the RLS finding was a symptom of. CI's "Deploy Postgres migrations" job has reported success on every deploy since v0.1.0, but it was applying migrations to a different database than the one `arsene-api` (the deployed Edge Function) actually queries — the GitHub Actions secret `SUPABASE_DB_URL`, a manually-pasted connection string, doesn't point at the same database Supabase auto-injects into the Edge Function runtime under that same variable name. Net effect: `arsene-api` has been live since v0.2.0 with no `articles`/`categories`/`article_images`/`pronos_entries`/`site_assets` tables behind it — every database-touching request would have failed. Root-caused and the real schema applied directly to the linked project (`dmytkubjxwwwkroutvdu`), which also serves the sibling pronos app. **Follow-up still open:** the `SUPABASE_DB_URL` GitHub secret itself needs correcting so future CI deploys stop silently targeting the wrong database — tracked separately, not fixed here.
- **`leagues`/`telemetry_events` renamed to `arsene_leagues`/`arsene_telemetry_events`:** the migration above surfaced a name collision — this project shares its Supabase instance with pronos (ADR-0002), which already owns unrelated `leagues` and `telemetry_events` tables (different columns entirely) in the same `public` schema. Arsène's two tables of the same name are renamed with an `arsene_` prefix throughout the schema, `src/api/repo.ts`, `src/site/render.ts`, and every test that queries them directly; nothing else (`categories`, `articles`, `article_images`, `pronos_entries`, `site_assets`) collided. `src/client/fixturePicker.ts`'s `GET /v1/leagues/{leagueId}/current` is pronos's own HTTP API path, not this table, and is unchanged. Full suite still 248/248.
- **Correction to the two entries above — wrong project:** `dmytkubjxwwwkroutvdu` is **pronos/DNP's** Supabase project, not Arsène's. `pdlc/arsene-cms/state.json` and `10-pipeline.v1.md`/`v2.md` name it as "the real linked project," and a genuine `arsene-api` Edge Function (matching this repo's build) is deployed there, which is what led the schema deploy above to target it — but the RLS fix, the full schema deploy, and the writer account/invite email all landed on pronos's live database by mistake. All of it has been reverted there: the 7 tables dropped, the writer row and `_migrations_applied` rows deleted, the real Supabase Auth user deleted via the dashboard. The `writers`/`_migrations_applied` RLS lockdown was left in place (a strict improvement regardless of which project it's on). Arsène's actual Supabase project is `wpicvtlfjhdofpmfdzrb` — untouched by any of this — and still needs the real schema deployed there. Whether the `arsene_leagues`/`arsene_telemetry_events` rename is even necessary on that project (i.e., whether it *actually* shares an instance with pronos) is unconfirmed; the rename is left in place since it's harmless either way, pending verification. The `arsene-api` function deployed to `dmytkubjxwwwkroutvdu` and the `SUPABASE_DB_URL`/`SUPABASE_PROJECT_REF` GitHub secrets are unresolved — likely all pointing at the wrong project — and still need fixing.
- **The real project's state, verified directly, and the two bugs that were actually live there (Critical):** connected to `wpicvtlfjhdofpmfdzrb` directly via the Supabase CLI (confirmed against the dashboard: it's the project named "Arsene" in `fantasycoachfr@gmail.com`'s org, the same org that owns pronos/DNP's `dmytkubjxwwwkroutvdu`), read-only, rather than trusting the GitHub secrets flagged above as possibly still wrong. Found the real project already had a schema — CI's migration job *did* work, contradicting the entry above's root-cause — but two things were actually broken: (1) `0001_initial_schema.sql` had been edited in place to rename `leagues`/`telemetry_events` to `arsene_leagues`/`arsene_telemetry_events`, but `scripts/deploy-migrations.sh` tracks applied migrations by filename only, so the real project (which ran the pre-rename file on 2026-08-23) silently skipped the edit forever — the deployed Edge Function's code queried tables that were never actually renamed, breaking every article fetch and every `draft_started`/`article_published` telemetry write; (2) `_migrations_applied` had the exact same RLS-disabled hole described above, on the real project this time, never actually fixed by that entry. Both closed: a new expand-only migration (`db/migrations/0006_rename_leagues_telemetry_and_lock_migrations_table.sql`, `NFR-MIGRATE-01` forbids renaming/dropping) creates the new-named tables, copies rows forward, and repoints the two foreign keys that referenced the old `leagues`; `_migrations_applied` gets RLS enabled and its inherited default grants revoked, and `scripts/deploy-migrations.sh` now does the same immediately after creating that table so this can't regress on any future project's first deploy. Applied directly to `wpicvtlfjhdofpmfdzrb`; `supabase db advisors --linked` now reports zero issues, both foreign keys point at `arsene_leagues`, full suite still 248/248.

## [0.2.2] — 2026-08-23

### Fixed

- **Platform-level `verify_jwt` blocks both shared-secret routes (High):** discovered while working out how to actually reach the deployed `v0.2.1` function. Supabase Edge Functions have a platform gateway check (`verify_jwt`, on by default) that inspects `Authorization` on every request *before* the function runs, and requires a genuine Supabase JWT there. `POST /internal/images/{id}/status` (the Lambda callback) and `GET /internal/metrics/time-to-publish` (the dashboard) never send an `Authorization` header at all — they use their own shared-secret headers — so the platform would reject both with a `401` before `router.ts`'s own (already-correct) auth logic ever ran. Not catchable by any existing test: neither the Node adapter nor a local `deno run` process has this extra gateway layer — it only exists in the real managed platform. Fixed by adding `supabase/config.toml` with `[functions.arsene-api] verify_jwt = false`, Supabase's documented pattern for functions that mix JWT and non-JWT callers — router.ts's own `route()` already gates every request regardless (JWT for writer routes, shared secret for the other two), so this removes a redundant, actively-breaking platform check without removing any real protection.

## [0.2.1] — 2026-08-23

### Fixed

- **NUL byte crashes create-draft/publish (High):** Schemathesis fuzzing `POST /v1/articles` against the real deployed `v0.2.0` (GitHub Actions run 32627585524, the first real production deploy) found a title containing a NUL byte crashed the request with a raw `500 Internal Server Error`. Root cause: Postgres text columns cannot store a NUL byte at all (`error: invalid byte sequence for encoding "UTF8": 0x00`, code `22021`), and nothing validated against it before `repo.ts`'s insert. Fixed by rejecting a NUL byte in every free-text field `CreateDraftBody`/`PublishBody` accept (`title`, `league_name`, `type_name`, `meta_title`, `meta_description`), at the same Zod-validation layer that already rejects other malformed input, before any query. Confirmed fixed against a real server; regression-tested in `tests/e2e/nulByteValidation.test.ts` (4 new tests). Full suite: 248/248.

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
