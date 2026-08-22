# Arsène CMS — Backend

Arsène is a backend for a content-management system serving football-prediction writers. It provides authenticated draft management, image optimization, and publishing workflows, replacing a previous manual process that took writers ~50 minutes from starting a draft to seeing it live on the public site.

## Stack

- **Backend:** Node.js/TypeScript + Supabase (Postgres + Edge Functions + Auth + Storage)
- **Image processing:** AWS S3 (upload staging) + Lambda (optimization via `sharp` codec, WebP/AVIF/HEIC support)
- **Public site rendering:** Next.js on Cloudflare Pages, using on-demand incremental revalidation (ISR) — only changed pages regenerate on publish, not the entire archive
- **Authentication:** Supabase Auth (JWT-based writer accounts; see [ADR-0001](pdlc/arsene-cms/adr/0001-supabase-backend-isr-frontend.md) for architecture rationale)
- **Testing:** TypeScript/Vitest + Testcontainers (real Postgres) for unit/integration tests; Schemathesis for contract validation against [openapi.yaml](pdlc/arsene-cms/contracts/openapi.yaml)

This repo contains the backend API server (`src/api/`) and the public-site render pass (`src/site/`) — the HTML/JSON-LD an ISR page would serve, read straight from Postgres. It does not contain the writer-facing editor SPA's UI, which is not yet built; `src/api/client.ts` is the typed client that SPA would use, and `src/client/fixturePicker.ts` is the one client-side component that already exists (a pronos fixture picker widget).

## Quick Start

Install and run tests:
```bash
npm install
npm run setup:contract  # Installs Python + Schemathesis for contract tests
npm test               # Runs full test suite (227 tests across unit/db/contract/e2e)
npx tsc --noEmit       # Type-check
```

## API Surface

Four main operations are exposed as Supabase Edge Function endpoints (server-side atomic, require JWT writer auth):

- `POST /v1/articles` — Create a new draft, take its edit lock, emit telemetry
- `POST /v1/articles/{articleId}/open` — Reopen a draft, take its edit lock, check lock holder
- `POST /v1/articles/{articleId}/publish` — Publish a draft, generate slug/JSON-LD, emit telemetry
- `POST /v1/articles/{articleId}/images` — Upload an image for async optimization and alt-text generation

Everything else (draft field autosave, taxonomy CRUD, image alt-text edits, asset library listing) is direct PostgREST access over RLS.

See [contracts/openapi.yaml](pdlc/arsene-cms/contracts/openapi.yaml) for the full contract and error codes. See [02-architecture.v1.md](pdlc/arsene-cms/02-architecture.v1.md) for design rationale and a full cost/rollback/threat analysis.

## Architecture Decisions

- **ADR-0001:** Supabase backend + on-demand-revalidated static frontend (not a full custom SSR app or self-hosted headless CMS) — reuses sibling projects' proven stack, $0/mo at expected load
- **ADR-0002:** Pronos owns fixture/match data; Arsène consumes it as optional with manual entry as v1 fallback — keeps systems independently deployable
- **ADR-0003:** Draft locking via staleness-checked `locked_by`/`locked_at` columns + heartbeat, not Realtime presence or CMS-native — simple, testable, self-heals browser crashes
- **ADR-0004:** Image optimization moved from Supabase Edge Functions to S3 + Lambda — closed a 2-second CPU budget overrun on real photos; Lambda's `sharp` runs uncapped, serving every format the contract advertises

See [pdlc/arsene-cms/adr/](pdlc/arsene-cms/adr/) for full reasoning.

## Known Limitations (Tracked, Accepted)

1. **Database migration incompatibility:** Migration `0005_one_ready_cover_per_article.sql` adds a partial unique index enforcing one ready cover per article. It will abort if applied to a database that already holds duplicate ready-cover rows on a single article — a state proven reachable through ordinary concurrent uploads (see [05-verification.v8.md §4](pdlc/arsene-cms/05-verification.v8.md)). **Mitigation:** if deploying to an existing database with history of concurrent cover uploads, run a pre-flight reconciliation step demoting all but the most-recently-created ready cover on each article before applying the migration.

2. **Discard route not reachable from client:** A new `DELETE /v1/articles/{id}/images/{id}` capability (src/api/discardImage.ts) lets writers recover from permanently stuck articles by discarding failed images. The server-side implementation is complete and thoroughly verified. However, it has no method on `src/api/client.ts` and is documented in openapi.yaml as prose only, not a declared path item — the product's own editor SPA cannot currently call it. **Mitigation:** add a client method and declare the path in the contract before end-users attempt recovery.

## Design Philosophy

This codebase prioritizes:
- **Reusing proven patterns** from sibling products (pronos, DNP) rather than inventing new infrastructure
- **Testability at scale** — real Postgres via Testcontainers, no mocks for correctness-critical paths
- **Honest measurement** — both telemetry events (`draft_started`, `article_published`) required by the success metric are emitted server-side as part of the same atomic transaction that makes them meaningful
- **$0 hosting at launch** — no always-on compute, serverless functions + static rendering, Cloudflare's free tier (no commercial-use restriction unlike Vercel Hobby)

## For New Readers

If you're joining the project, start with:
1. [spec-header.json](spec-header.json) — one-paragraph product summary
2. [02-architecture.v1.md](pdlc/arsene-cms/02-architecture.v1.md) — full design and threat model
3. [docs/architecture.md](docs/architecture.md) — component diagram
4. The relevant ADR in [pdlc/arsene-cms/adr/](pdlc/arsene-cms/adr/) — each ADR is ~2 pages, independent, self-contained
5. [contracts/openapi.yaml](pdlc/arsene-cms/contracts/openapi.yaml) — the four endpoints this code ships
