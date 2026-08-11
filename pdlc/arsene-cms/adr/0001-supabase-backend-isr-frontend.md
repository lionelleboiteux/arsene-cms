# ADR-0001: Supabase backend with an on-demand-revalidated static frontend, over a full custom SSR app or a self-hosted headless CMS

- **Status:** proposed
- **Date:** 2026-08-11
- **Unit:** arsene-cms
- **Deciders:** Lionel Le Boiteux, Bob

## Context

Arsène needs a CMS for 2–5 non-technical writers (5–15 articles/week) and a public
website, replacing Wix. Three independently-explored options were compared: a fully
custom dynamic SSR app, a self-hosted headless CMS (Payload) with a separate frontend,
and a Supabase-backed statically-rendered site rebuilt on publish. The product owner
has also said they may want to swap Arsène's CMS for an off-the-shelf product later,
which weighs directly on this choice, and both sibling Fantasy Coach products (pronos,
DNP) already prove out a $0-hosting, Supabase + static-frontend pattern that this
product owner is comfortable operating.

## Decision

Build Arsène on Supabase (Postgres/Auth/Storage/Edge Functions) as the backend, with
an editor SPA talking to it directly via PostgREST/RLS plus two Edge Functions
(`publish`, image upload/optimize), and a Next.js public frontend using ISR with
on-demand revalidation (not a full rebuild) deployed to Cloudflare Pages/Workers.

## Consequences

**Positive**
- Reuses pronos' proven Supabase/RLS patterns and its TypeScript/Vitest/Testcontainers
  testing discipline directly — not a new toolchain to learn.
- $0/month at expected load; the first real cliff (Supabase storage) is months out and
  a cheap fix ($25/mo Pro).
- On-demand revalidation regenerates only the changed pages (article, its category,
  homepage), giving near-immediate publish-to-live latency without the cost of a fully
  dynamic server for every request.
- Cloudflare Pages avoids Vercel Hobby's non-commercial-use restriction, which a
  revenue-generating site would trip.
- The Postgres content model is the most reusable asset if the CMS layer is swapped
  for an off-the-shelf product later — a future CMS can read the same tables far more
  readily than it could import a bespoke editor's internal state or a specific headless
  CMS's proprietary schema (Payload's Lexical JSON/versions tables, for instance).

**Negative**
- Still requires building a real rich-text editor, image pipeline, and locking from
  scratch — this is not "off-the-shelf CRUD," it's a genuine build, just a smaller one
  than the two rejected options.
- Two-part rollback story (static frontend vs. Supabase/Edge Functions) rather than one
  unified mechanism — must be documented and rehearsed as two procedures.
- On-demand revalidation is new plumbing (webhook → Edge Function → cache purge/
  regenerate) with no existing precedent in pronos or DNP to lean on; its one failure
  mode (silent no-op on a failed revalidation) needs an explicit alert, not just a
  green build.

**Neutral / accepted**
- Images must be served through Cloudflare rather than hotlinked from Supabase Storage
  to public visitors, to stay inside the 5GB/mo Supabase egress free tier — an
  implementation constraint the team must enforce, not a risk to design around later.

## Options rejected

| Option | Why not |
|---|---|
| Full custom dynamic SSR app (Next.js/Vercel, custom editor, live server for every request) | Highest build cost of the three (nearly every AC hand-built); ~$25–45/mo run cost; Vercel Hobby explicitly excludes commercial use; worst option for a future off-the-shelf CMS swap — a bespoke editor and hand-rolled structured fields have no export story. |
| Self-hosted headless CMS (Payload) + separate frontend | Only ~35–40% of the build is genuinely off-the-shelf — most ACs (image pipeline, SEO/AEO/GEO panel, alt-text, fixture integration, the entire frontend) are custom regardless. Documented upstream bug: Payload's native document locking is broken when autosave is enabled (payloadcms/payload#11604, #14477) — exactly the two features (AC-01, AC-05) this spec needs together, on the same drafts, risking silent data loss. Never reaches $0/mo (always-on compute has no free tier). "Headless" does not mean portable — its content shape is just as proprietary as anything hand-built. |

## Revisit when

Supabase storage approaches its free-tier limit (fixed cheaply, not a re-architecture
trigger) — not a revisit condition on its own. Actually revisit this decision if: (a)
on-demand revalidation proves unreliable in practice (frequent silent no-ops despite
alerting), suggesting a simpler full-rebuild trigger is more trustworthy even at the
cost of latency; or (b) the product owner decides to actually execute the "swap to an
off-the-shelf CMS" option — at that point, re-evaluate whether Payload or another
headless CMS has since fixed its locking bug and become viable.
