# arsene-cms — Architecture and design

> Gate 2 artifact. Research and assessment only. No production code.

**Status:** architecture passed | **Author:** Lionel Le Boiteux (with Bob) | **Date:** 2026-08-11

## 1. Situation

- **Type:** greenfield (new repo, no existing Arsène code) — but not isolated. Two sibling
  products already exist under the same Fantasy Coach umbrella, both authored by the
  product owner, both shipped on a deliberate $0-hosting pattern:
  - `pronos` ("Jeu des Pronos") — a prediction game, fully shipped through Bob+John's
    gates. Supabase (Postgres + Edge Functions + pg_cron/pg_net) backend, static
    frontend on GitHub Pages at `pronos.fantasy-coach.fr`, TypeScript/Vitest/Testcontainers
    testing, OpenAPI 3.1 contract enforced both sides (Prism + Schemathesis).
  - `DNP` — a static "unavailable players" page sourced from a Google Sheet, GitHub
    Pages at `l1.dnp.fantasy-coach.fr`, no backend.

  Product-owner decisions that bound this architecture:
  1. Arsène gets **unified navigation/branding with pronos and DNP, but each keeps its
     own independent deploy, hosting, and repo** — not a merged monolith, not a reverse
     proxy.
  2. **Fixture/match data stays owned by `pronos`** — it already has a `games` table
     and an API shape for it (`GET /v1/leagues/{leagueId}/current`), even though the
     fixture-ingestion slice that populates real match data hasn't been built there
     yet. Arsène's writers will pull match lists from pronos' (future) API, with
     **manual entry as the v1 default**, not a blocking dependency.

- **Surfaces:** web only — an authenticated writer editor (SPA) and a public website
  (visitor-facing, no auth).
- **Modules touched:** none — new repo.
- **Estimated new code:** whole product; no existing Arsène baseline to size against.
- **Refactoring needed first:** none. The one real precondition is architectural, not
  code: Arsène's Pronos-article structured fields must treat the match reference as
  optional/nullable from day one, because the upstream fixture API doesn't exist yet.

### Testability assessment

| Unit | Currently needs | Proposed seam |
|---|---|---|
| Paste-from-Word/Docs sanitization | real DOM/browser to observe rendering | isolate as a pure function: raw HTML in, sanitized HTML out (e.g. via `rehype`/`sanitize-html`), unit-testable with fixture HTML strings — no browser needed for the logic itself, only for a thin end-to-end check |
| Draft locking (staleness expiry) | real clock | inject a clock/now() function; fake timers in tests, exactly the pattern pronos already uses for kickoff-time locking |
| Image optimization (WebP/AVIF + compression) | real binary files | run the actual WASM codec against fixture files (corrupt, oversized, valid) — no mocking, matches pronos' "real Postgres via Testcontainers" philosophy applied to a real codec instead |
| Publish → telemetry write | real DB | Testcontainers-backed real Postgres, directly reusing pronos' existing pattern |
| Public site rendering (SEO fields, sitemap, empty state) | real content + a build/render pass | seed a test DB, run the render pass against it, assert on output HTML/JSON-LD/sitemap — no live deploy needed |

## 2. Options considered

Three options were explored independently and in depth (each by a separate architect
with no visibility into the others, to avoid one real design and two strawmen).

### Option A — Full custom app, dynamic server-rendered

**Shape:** Single Next.js app (admin `/admin/**` + public routes), SSR/ISR throughout,
custom TipTap/ProseMirror editor, Supabase for Postgres/Auth/Storage, deployed to a
Node/edge host (Vercel-class). Locking via `locked_by`/`locked_at` + heartbeat. Image
pipeline via synchronous server-side `sharp` transcode.
**Build cost:** Highest of the three — nearly every AC maps to hand-built code (editor,
paste sanitization, structured fields, locking, image pipeline, SEO generation, full
admin shell). Multi-week, not multi-day.
**Run cost:** ~$25–45/mo realistic minimum (Supabase Pro to avoid the storage/pause
cliff, Vercel Pro once the site is commercial — **Vercel's Hobby tier explicitly
excludes commercial use**, and Fantasy Coach is a revenue-generating site even before
on-site ads ship). At 10x load, storage and per-seat hosting are what bite, not compute.
**Failure modes:** SSR host down = whole public site down (pronos/DNP unaffected).
Same-writer-two-tabs race isn't covered by an article-level lock. Transient upload
timeouts are indistinguishable from genuinely corrupt files unless coded separately.
**Rollback:** Tier 1 (host retains every deploy, instant promote). DB migrations need
expand/contract discipline — a constraint pronos already lives with successfully.
**Testability:** Fast for pure logic; editor + image pipeline are the two genuinely
slow-to-test subsystems (Playwright-class).
**Closes the door on:** the product owner's stated wish to possibly swap to an
off-the-shelf CMS later. A bespoke editor, hand-rolled structured fields, and custom
locking have no export/portability story — this is the worst option for that concern,
in exchange for zero fights against a platform's constraints.

### Option B — Headless CMS (Payload) + separate frontend

**Shape:** Self-hosted Payload CMS (Node, own Postgres, chosen over Strapi/Directus
because it's the only one of the three that supports arbitrarily nested repeatable
structured fields, which the Pronos/Player-Picks content type needs) for the
admin/editor, paired with a second, separate SSG/ISR frontend app for the public site.
**Build cost:** ~35–40% genuinely off-the-shelf (auth, CRUD, versions/autosave engine,
base rich-text editor, storage adapter, image resizing). The rest — the Pronos/Picks
field schema, the WebP/AVIF hard-fail-blocks-publish gate, the entire SEO/AEO/GEO
advisory panel (no CMS ships this; needs an LLM integration), auto alt-text, the
fixture-API field, and the *entire second frontend app* — is custom regardless.
**Run cost:** ~$10–20/mo at expected load (self-hosting the admin app is a real bill
from day one — no free tier for always-on compute since Fly.io dropped its free tier),
~$20–40/mo at 10x. Never actually reaches $0.
**Failure modes:** admin app crash/OOM blocks all writers (Sharp is memory-hungry);
public site is decoupled and stays up. **Load-bearing finding: Payload's native
document locking is documented as broken when autosave is enabled** (upstream GitHub
issues #11604, #14477) — exactly the two features (AC-01 autosave + AC-05 locking)
this spec requires together, on the same drafts. This is a silent-data-loss risk, not
a minor gap, and "native locking" is not usable as shipped.
**Rollback:** Tier 1 for both apps' code. Payload's own Postgres migrations are tied to
CMS version bumps and community reports describe breaking migrations across upgrades —
rolling back the app image does not roll back an already-applied migration.
**Testability:** the locking+autosave interaction can only be caught by a real-DB,
two-session integration test, and must be re-run on every Payload upgrade since it's
chasing a known upstream bug, not a stable contract.
**Closes the door on:** the framing that "headless CMS = more portable" is not true
here. Payload's content shape (Lexical JSON, its array/block/versions tables) is just
as proprietary as anything hand-built — migrating to any other CMS later requires a
bespoke transform regardless. All of the custom code this option still requires (the
locking workaround, the LLM SEO panel, image hooks, fixture field) has zero transfer
value to a future CMS. It buys API shape, not schema portability, while adding a
documented correctness bug in the exact feature pair this spec needs.

### Option C — Supabase backend + statically-rendered public site (rebuild-on-publish)

**Shape:** Supabase (Postgres/Auth/Storage/Edge Functions) as the entire backend. The
editor is a small authenticated SPA talking directly to Postgres via PostgREST/RLS,
plus two Edge Functions (`publish`, image upload/optimize) for the operations needing
server-side atomicity. The public site is statically generated and rebuilt on publish
via a webhook → GitHub Actions dispatch, deployed to GitHub Pages/Cloudflare Pages —
the same pattern pronos and DNP already use.
**Build cost:** reuses pronos' actual tooling (Supabase provisioning/RLS patterns,
TypeScript/Vitest/Testcontainers). New: the editor, image pipeline, rebuild-trigger
plumbing, SSG templates, the SEO/AEO/GEO advisory generator.
**Run cost:** $0/mo at expected load *if* images are copied into the build output
rather than hotlinked from Supabase Storage to public visitors (hotlinking blows the
5GB/mo egress free tier almost immediately — a real design trap, not a hypothetical
one). At 10x, Supabase **storage** is the first cliff (~2–3 months in), fixed cheaply
by Supabase Pro ($25/mo) or moving assets to Cloudflare R2 (egress-free).
**Failure modes:** a rebuild failure leaves the old static site live — **this design
is accidentally safer here** than a live dynamic server, since GitHub Pages/Cloudflare
Pages just keep serving the last successful deploy. That safety is only real if a
failed rebuild alerts someone; otherwise it's a silent gap against "republish is
reflected immediately."
**Rollback:** Tier 1 for the static site (redeploy last known-good build, no rebuild
needed). Two-part story: the Supabase/Edge Function side rolls back the same way
pronos already does (tag redeploy + expand/contract migrations).
**Testability:** directly reuses pronos' Testcontainers-backed real-Postgres pattern.
The one new untested seam is the rebuild trigger itself (webhook → Edge Function →
GitHub API), best isolated behind an interface so it's fakeable in tests.
**Closes the door on:** as specified (full rebuild per publish), a genuine tension with
the spec's "the article appears immediately on the public site" and AC-17's "reflected
immediately" — realistic rebuild+propagate latency is 1–3 minutes, growing slowly as
the archive grows, since a full SSG rebuild is not incremental. This doesn't blow the
10-minute total publish budget, but it doesn't read as "immediate" either, and needed
either explicit product sign-off or a design fix (see recommendation below). On
portability: Supabase-as-headless-content-store is genuinely reusable by a future CMS;
the rebuild-trigger plumbing and hand-rolled locking are not, but represent a much
smaller sunk cost than Option A's bespoke editor or Option B's CMS-specific schema.

## 3. Recommendation

**Option C, with one refinement: on-demand incremental revalidation instead of a full
static rebuild.** Keep everything else — Supabase backend, direct PostgREST/RLS from
the editor, the two Edge Functions, staleness-based locking — but build the public site
as a Next.js app using ISR with on-demand revalidation (only the new article's page,
its category page, and the homepage are regenerated, not the whole site), deployed to
**Cloudflare Pages/Workers** rather than Vercel — Cloudflare's free tier has no
non-commercial restriction (Vercel Hobby's does, and Fantasy Coach is a
revenue-generating, if not-yet-ad-monetized, site), and it supports the same
on-demand-purge mechanics. This closes Option C's one real gap (publish latency) for a
fraction of Option A's build/run cost, without inheriting Option B's documented
locking+autosave data-loss bug or its CMS-schema lock-in.

**One line:** C (refined) reuses the sibling projects' proven low-cost stack and
testing discipline, keeps the most portable data layer if the CMS is swapped later,
and fixes its only real weakness — publish latency — with targeted revalidation
instead of a full rebuild, at a fraction of A's cost and without B's locking bug.

**User decision:** pending — presented for agreement before this gate passes.

## 4. Cost and free-tier fit

| Provider | Component | Free-tier limit | Expected use (5–15 art/wk, 2–5 writers) | 10x use | First cliff |
|---|---|---|---|---|---|
| Supabase | Postgres + Auth | generous on Free | trivial at this scale | trivial | none expected |
| Supabase | File storage | 1GB free, $25/mo Pro → 100GB | ~60–100MB/mo (images) | ~600MB–1GB/mo | **Storage — ~10–15mo expected, ~10wk at 10x**, fixed by $25/mo Pro |
| Supabase | Egress | 5GB/mo free | fine **only if** public visitors never hit Supabase Storage URLs directly (images must be proxied/copied via Cloudflare) | breached same day if hotlinked | **Egress — a design constraint to enforce, not just a number to watch** |
| Supabase | Edge Function invocations | 500K/mo free | trivial (publish + image calls only) | trivial | none expected |
| Cloudflare Pages/Workers | requests, on-demand revalidation | very generous (100K req/day Workers free) | trivial | still comfortably free | none expected at this scale |
| GitHub | repo/CI (editor + IaC, not the rebuild pipeline this time) | 2,000 min/mo private, unlimited public | minimal — public repo like pronos/DNP | still minimal | none, provided the repo stays public |

Realistic cost: **$0/month at expected load**, provided images are served through
Cloudflare rather than hotlinked. At 10x, Supabase storage is the first and only near-
term cliff, several months out, solved by a $25/mo tier bump — not urgent, but should
be a known trigger rather than a surprise.

## 5. API contracts

| Interface | Type | File | Consumer test | Provider test |
|---|---|---|---|---|
| `POST /v1/articles/{id}/publish` | OpenAPI 3.1 | `pdlc/arsene-cms/contracts/openapi.yaml` | Prism mock (editor SPA) | Schemathesis |
| `POST /v1/articles/{id}/images` (+ alt-text patch) | OpenAPI 3.1 | `pdlc/arsene-cms/contracts/openapi.yaml` | Prism mock (editor SPA) | Schemathesis |
| `GET /v1/leagues/{leagueId}/current` (pronos, consumed not owned) | OpenAPI 3.1 (upstream) | referenced from `/Users/lionelleboiteux/work/pronos/pdlc/jeu-des-pronos/contracts/openapi.yaml`; consumer approach documented at `pdlc/arsene-cms/contracts/pronos-fixtures.consumer.md` | Prism mock against pronos' schema, in Arsène's own CI | N/A — owned by pronos, not this build |

All direct Postgres reads/writes from the editor SPA (drafts, taxonomy, asset library
listing) go through PostgREST/RLS and are **not** custom endpoints — RLS policies are
the contract there, tested at red via Testcontainers, not via OpenAPI.

Versioning strategy: `/v1` prefix on Arsène's own endpoints; a breaking change gets
`/v2` rather than a mutation, matching pronos' precedent. The pronos fixture dependency
is versioned by pronos' own contract — Arsène pins to the operation shape at
integration time and the consumer test will fail loudly (not silently degrade) if that
shape changes, so it surfaces immediately as a broken build rather than a broken
production feature.

## 6. Rollback plan

- **Mechanism:** Tier 1 platform-native instant rollback. Cloudflare Pages/Workers
  retains every deployment — promoting a previous one is seconds and genuinely
  blue/green. Supabase Edge Functions (`publish`, image) roll back via versioned
  redeploy (Tier 0 — tag, redeploy previous tag).
- **Detected by:** public-site 5xx/error-rate monitor; Edge Function invocation error
  rate (Supabase logs); a synthetic check exercising the publish flow end-to-end; and
  explicitly, a failed on-demand-revalidation call must alert (this doesn't fail loud
  on its own — a writer publishing and seeing no change is otherwise a silent gap).
- **Triggered by:** whoever's on call — currently the product owner solo — via
  Cloudflare dashboard/CLI or redeploying the previous Supabase function tag.
- **Time to roll back:** seconds for both surfaces (platform-native), to be measured
  for real (not estimated) and rehearsed at John's pipeline gate.
- **One-way doors:** none identified, provided every Postgres migration follows
  expand/contract — Supabase Free/Pro has no PITR/schema rollback, the same constraint
  pronos already lives with (its ADR-0003).
- **Migration safety:** expand-only.

## 7. Threat model (STRIDE-lite)

| Threat | Applies? | Mitigation | NFR |
|---|---|---|---|
| Spoofing | Yes | Supabase Auth for writers; RLS keyed on `auth.uid()` restricts all mutating operations to authenticated writers | All editor writes require a valid Supabase session |
| Tampering | Yes | `publish`/image Edge Functions validate server-side (cover image presence, file type/size) rather than trusting the client; writer-controlled columns (e.g. `published_at`, slug, schema markup) are not directly writable via PostgREST, only via the publish function | RLS/grants deny direct writer writes to publish-controlled columns |
| Repudiation | Low | `telemetry_events` plus `writer_id`/`updated_at` on every article give an audit trail of who published/edited what and when | Article history retains `writer_id` on every publish |
| Information disclosure | Yes | Drafts are not readable by the `anon` role — RLS restricts unpublished articles to authenticated writers; the image bucket must not allow public listing of unpublished assets | RLS policy denying `anon` SELECT on unpublished articles/images |
| Denial of service | Low | Upload size limits on the image Edge Function (bounded memory/time budget for the WASM codec); rate limiting on `publish`, mirroring pronos' existing 10 req/min per IP precedent | Max upload size enforced at 20MB (fixed by the contract's `FILE_TOO_LARGE` response, `max_bytes: 20971520` — this is the binding number; an earlier draft of this row said "e.g. 10MB" before the contract fixed it); rate limit on mutating endpoints, assumed at pronos' 10 req/min/IP precedent pending explicit confirmation |
| Elevation of privilege | N/A | The spec has no role hierarchy — every writer has equal, full publish rights by design, no approval step exists to escalate around | Not applicable — confirmed by spec section 2 and section 8 (no approval workflow) |

## 8. Observability

**Logged:** Edge Function invocation logs (Supabase built-in); image-optimization
failures logged with a distinguishable reason (corrupt / unsupported format / timeout,
per Option A's finding that these must not be conflated); revalidation-webhook
outcomes (success/failure, not just fired).

**Measured:** time-to-publish per article, computed from `telemetry_events`
(`draft_started` → `article_published`, joined on `article_id`); publish success/
failure rate; image-optimization failure rate.

**Alerts:** public-site error rate; Edge Function error rate; a failed on-demand
revalidation (silent-gap risk called out above); `telemetry_events` receiving zero
`article_published` rows in a period writers report publishing — the strongest signal
that the pipeline is silently broken.

**Feature-specific broken signal:** time-to-publish trending back up toward the
50-minute baseline is the direct signal this build isn't delivering its success
metric — that's what John's dashboard will chart.

**Counter-metric gap — flagged, not silently solved:** Pam's counter-metric ("writer
adoption must not decline — writers reverting to Word/Docs and manually pasting is a
failure even if the time metric improves") has **no event that can observe it**,
because reverting to an external tool happens entirely outside Arsène. No event was
invented to cover this — that would be a requirement nobody agreed to. The honest
proxy: weekly published-article count per writer, compared against the pre-launch
baseline, reviewed manually at John's review gate rather than dashboarded
automatically. This should be confirmed with the product owner/Pam as an accepted
measurement approach before John's review gate, not assumed.

## 9. Addendum — refined during the red gate

Two points from this document were sharpened while writing the test suite (see
`03-red-evidence.v1.md` §6 and `traceability.md` §6 for the full reasoning). Recorded
here so the architecture document stays the source of truth, not just the traceability
notes:

- **Draft creation cannot be a bare client-side PostgREST insert.** §1's shape implies
  the editor writes drafts directly to Postgres for everything, including creation.
  But `draft_started` is one of the two events the whole success metric depends on
  (§4/§8), and if the SPA is what's responsible for emitting it after an insert it
  controls, a client bug can silently drop the metric's numerator with nothing to
  detect it. Draft **creation** and **reopening** go through a thin server-side
  seam (`src/api/createDraft.ts` — an RPC or Edge Function, not a raw insert) that
  emits `draft_started` itself, exactly once, as part of the same transaction. Every
  other draft field edit (title, body, structured fields) stays direct PostgREST/RLS
  as originally designed — this refinement is scoped to the two moments that touch
  telemetry, not the whole drafting flow.
- **The DoS row's upload-size figure was provisional text ("e.g. 10MB") written before
  the contract fixed a real number.** `contracts/openapi.yaml`'s `FILE_TOO_LARGE`
  response is the binding limit (20MB) — §7's table has been corrected to match. The
  contract is a promise already made to callers; the architecture note was the stale
  one.

## 10. Addendum — remediation after the verify gate

`05-verification.v1.md` found the green-gate build did not implement what this
document already specified in two places, plus one genuine architecture change:

- **Auth.** §7 already said "Supabase Auth for writers… RLS keyed on `auth.uid()`" —
  this was never ambiguous. What shipped at green was a placeholder (one static
  shared-secret comparison) that was never replaced with real verification. The fix
  is implementation catching up to what was already decided here, not a new
  decision: verify real Supabase-issued JWTs (signature + `sub` claim → `writer_id`).
  Writer accounts themselves are managed through Supabase Auth's own tooling
  (dashboard/CLI) — Arsène does not get a custom writer-management screen; at
  2-5 writers who change rarely, building one would be scope this product doesn't
  need.
- **Draft creation.** Also implementation catching up to §9 above, not a new
  decision: `src/api/createDraft.ts` gets wired to the real repository (which
  needs `insertDraft`/`takeLock` added) and to an actual route, exactly as §9
  already specified.
- **Image optimization moves to S3 + Lambda.** This *is* a genuine change from
  the Supabase-Edge-Function approach this document originally specified — see
  `adr/0004-s3-lambda-image-pipeline.md` for the full reasoning. In short:
  verify found the WASM codec takes 1.4-4.0s against real photos, at or above
  Supabase Edge Functions' 2s CPU budget, for an ordinary upload. Uploads now
  land in S3; a Lambda function (real `sharp`, no CPU ceiling problem, and
  every format the contract advertises) does the conversion and calls back to
  flip `article_images.status` from `processing` to `ready`/`failed`. The
  `processing`/`ready`/`failed` state machine `article_images.status` was
  already built to express — the contract, the public-site rendering, and
  `publishArticle.ts`'s `IMAGE_NOT_READY` check all needed no shape change,
  only a different system flipping the status.
