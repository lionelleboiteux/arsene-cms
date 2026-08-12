# arsene-cms — Performance measurement (verify gate)

> Run by the perf-analyst subagent, against real Postgres 16 (Testcontainers)
> and the real Edge Function router (`src/api/server.ts`/`serverMain.ts`) over
> real HTTP, and the real `@jsquash` WASM codec — nothing mocked. Measurement
> scripts were written under `tests/perf/*.perf.test.ts`, run, and deleted in
> the same shell invocation; none are committed. Real photographic-content
> image fixtures were generated once into `/tmp/arsene-perf/` (outside the
> repo) using the same `@jsquash` encoders the production codec already
> depends on — not committed either.

## Conditions (state honestly)

- **Hardware:** Apple M1 Pro, 16 GB RAM, macOS 25.4.0 (arm64).
- **Node:** v26.5.1. **Docker:** 28.4.0 (Testcontainers, `postgres:16-alpine`).
- **Database:** a *fresh* container per test group, production migrations
  (`db/migrations/0001_initial_schema.sql`) applied before any measurement —
  never a frozen copy of the schema. Container startup (~2-4s) is excluded
  from every reported timing; only calls made after `beforeAll` resolves are
  timed.
- **Cold vs warm:** "cold" = the first call/request made after the
  server/container/codec has finished starting (process already running, but
  JIT not warmed on that code path, WASM codec not yet invoked once, DB
  connection not yet used for a real query). "Warm" = subsequent back-to-back
  calls in the same process/connection. Every number below states which one
  it is — no number here is a p95 measured on an empty database or after
  1000 discarded warm-up iterations.
- **This is a small system** (5-15 articles/week, 2-5 writers expected per
  `02-architecture.v1.md` §4): per-operation latency is what's measured, not
  raw throughput/concurrency. No k6/autocannon load test was run — it would
  answer a question nobody asked at this scale.

## Proposed budgets — MY proposal, not agreed by the product owner

No budget was set at the architecture gate. §4/ADR-0001 name the concern
(on-demand ISR to avoid a 1-3 minute full-rebuild latency) but never pin a
number. The spec's only real agreed number is **draft-to-publish under 10
minutes total** (AC-18, dominated by human writing/review time), plus the
qualitative "appears immediately" (spec §5) / "reflected immediately"
(AC-17). Those are not directly measurable as written, so here is a proposed,
measurable replacement — **flagged for the product owner's confirmation, not
something already agreed:**

| # | Operation | Proposed budget | Why this number |
|---|---|---|---|
| 1 | `POST /v1/articles/{id}/publish` server-side round trip (cover already uploaded) | warm p95 < 500 ms; cold (first request after idle) < 2 s | The one click writers will judge "immediate" against. 500ms leaves headroom under the ~1s threshold generally cited for an action feeling instantaneous, once real browser/network RTT is added on top of server time. |
| 2 | Image optimization (`src/images/optimize.ts`), which runs synchronously inside the upload request (confirmed in code, see below) | typical (≤~8MB) < 5s; worst case (near the 20MB contract ceiling) < 15s | This is the single largest synchronous per-operation delay writers experience today, and there is no async/queued path in this build to hide it behind. 15s is a deliberately generous ceiling for the rare large-file case. |
| 3 | Public-site render pass (`src/site/render.ts`), invoked by ISR revalidation, not by visitor requests | homepage / category page < 200ms, at any archive size up to the 10x-load ~1000-article proxy | Off the writer's critical publish-click path (revalidation is recorded, not synchronously awaited — see Finding 3 below), but still gates how fast the regenerated page becomes available. |
| 4 | Draft lock heartbeat (ADR-0003, ~20s cadence) | < 50ms per heartbeat write | Fires continuously in the background per active writer; must stay negligible relative to its own 20s cadence so 2-5 concurrent writers never contend meaningfully. |

## Results

### 1. Publish handler latency — PASS

Real HTTP `POST /v1/articles/{id}/publish` against the real router, real
Postgres, cover image pre-seeded as `ready` (upload/optimize timed
separately, §2). 9 requests total (kept under the 10/min/IP rate limit,
NFR-RATE-01 — itself confirmed working, since a 10th request in the same
minute returned `429`).

- Cold (1st request): **47.3 ms**
- Warm (8 back-to-back requests): min 4.13 ms, p50 **4.63 ms**, p95 **6.37 ms**, max 6.37 ms

Both comfortably inside budget #1 (cold 47.3ms ≪ 2s; warm p95 6.4ms ≪ 500ms).
Caveat stated honestly: only 8 warm samples — a real p95 needs more, but at
this margin (β under 1.5% of budget) more samples would not change the
pass/fail call.

### 2. Image optimization time — PASS, but the tightest margin in the system

`src/api/uploadImage.ts`'s `handleUploadImage` **awaits `optimizer.optimize()`
directly inline**, before ever composing the HTTP response — this is not a
"processing" placeholder followed by async completion; the codec's time is
100% writer-facing upload latency, exactly as `optimize.ts`'s own docstring
claims. Confirmed by reading the handler, not assumed.

Fixtures matter here: the repo's existing `tests/support/imageFixtures.ts`
generates *decodable but degenerate* files (a real 1×1-pixel image padded to
size with legal-but-content-free JPEG comment / PNG `tEXt` chunks) — timing
against those would understate real cost, since a codec spends most of its
time on actual pixel data, not padding. So four **real photographic-content**
fixtures (smooth gradient + noise, i.e. genuine entropy for the codec to
decode/compress) were generated with the same `@jsquash` encoders this
pipeline already depends on:

| Fixture | Resolution | File size | Cold | Warm (4 runs) |
|---|---|---|---|---|
| JPEG, "4MB" case | 3800×2850 (10.8MP) | 4.03 MB | 1776 ms | 1582-1971 ms (avg ~1720ms) |
| PNG, "4MB" case | 1300×975 (1.27MP) | 4.18 MB | 438 ms | 202-250 ms (avg ~215ms) |
| JPEG, near 20MB contract limit | 6500×4900 (31.9MP) | 19.58 MB | 9690 ms | 9073-10636 ms (avg ~9754ms) |
| PNG, near 20MB contract limit | 2700×2025 (5.5MP) | 18.03 MB | 845 ms | 809-836 ms (avg ~817ms) |

All four pass the proposed budget (§2), but the near-cap JPEG case uses
**~65-70% of the 15s worst-case budget** — by a wide margin the least
comfortable number in this whole review. Two things worth stating precisely:

- **PNG "near 20MB" is not a fair worst case.** PNG is lossless, so a 20MB PNG
  represents far fewer real pixels (5.5MP here) than a 20MB JPEG (31.9MP) —
  a real photo that's large enough to hit the 20MB PNG ceiling would need to
  be genuinely huge in resolution, which is unusual; a real photo that hits
  the 20MB **JPEG** ceiling (a high-resolution DSLR/phone export) is the
  realistic worst case, and that's the ~9.7-10.6s number.
- **This repo has no editor/upload UI to check against.** Whether ~1.7-2s
  (typical) or ~10s (worst case) *feels* acceptable depends on whether the
  writer sees a "processing" indicator during the wait — that UI doesn't
  exist in this repo (`src/client/` only has `fixturePicker.ts`), so this is
  flagged as an open question for the product owner rather than assumed
  either way.

No fix is recommended here: the WASM-codec choice is an explicit,
already-argued architecture decision (Deno Edge Functions can't run `sharp`),
and the measured worst case still passes the proposed budget. If the product
owner sets a tighter budget than proposed here, revisit.

### 3. Public site render time — PASS today, clear linear-growth trend

`src/site/render.ts` measured at 0, 50, and 1000 published articles (spread
across 10 categories, so any one category page only ever shows ~1/10th of
the total). `renderHomepage()` and `renderCategoryPage()` each timed 6x
back-to-back (1 cold + 5 warm) per volume.

| N published articles | Homepage warm (ms) | Category page warm (ms) |
|---|---|---|
| 0 | 0.45 - 0.52 | 0.48 - 0.51 |
| 50 | 1.16 - 1.38 | 1.01 - 1.27 |
| 1000 | 8.10 - 8.81 | 6.15 - 8.77 |

Both comfortably pass the proposed 200ms budget even at N=1000 (~4-5% of
budget used). But the trend answers the question the architecture doc asked
for directly: **render time is not independent of total archive size, even
for a page that only displays a fraction of it.** The category page (always
~100 of the 1000 articles at N=1000) tracks the *homepage's* growth curve
almost exactly, rather than staying flat like the homepage-vs-empty-DB
baseline would predict if cost were proportional to result-set size.

**Root cause, found in code, not by guessing from `EXPLAIN`:**
`render.ts`'s single `published()` helper runs one unfiltered query for
*every* published article on *every* call — homepage, category page, article
page, and sitemap all fetch the full published set, and `renderCategoryPage`
filters it down to one category in **JavaScript**, after the fetch, not in
SQL. `EXPLAIN ANALYZE` on that query at N=1000 confirms Postgres itself is
not the bottleneck:

```
Sort  (cost=37.90..37.91 rows=3 width=24) (actual time=0.212..0.241 rows=1000 loops=1)
  Sort Key: published_at DESC
  ->  Seq Scan on articles a  (actual time=0.005..0.131 rows=1000 loops=1)
        Filter: ((slug IS NOT NULL) AND (status = 'published'::text))
Execution Time: 0.284 ms
```

Postgres resolves the whole query in 0.284ms even at 1000 rows — this is
**not a missing-index problem** (the existing `articles_published_at_idx` on
`articles(published_at desc)` is adequate for the query as currently shaped;
the planner correctly prefers a seq-scan+sort over it at this table size).
The ~8-9ms of app-side cost is Node/pg fetching and iterating all 1000 rows —
each carrying a full `body_html` column that only the single article-detail
page actually needs, plus a correlated per-row subquery for the cover image
— every single time any page is rendered, regardless of which page.

**Not a budget miss today** (8.8ms of a 200ms budget), but it's the clearest
trend in this review, and it's exactly the dimension `02-architecture.v1.md`
§4 flags as capable of 10x growth (150 articles/week sustained) over the
years an archive like this will exist. **Recommended fix, low cost, not
urgent:** move category/league filtering into the SQL `WHERE` clause instead
of the in-memory `.filter()`, add a `LIMIT` to the homepage query, and select
`body_html` only in `renderArticlePage`, not in the shared listing query.
That turns homepage/category cost into O(page size) rather than O(total
archive size) — which is what "the archive can grow without slowing down
already-published pages" structurally requires, not just what happens to be
true while N is small. Flagging, not fixing now, per the instruction to only
optimize where a budget is missed or a trend is heading toward one — this
trend is real but not yet urgent.

**Separate, non-performance observation worth a product decision:** the
homepage query has no `LIMIT` at all — it will render literally every
published article ever, unpaginated, forever. That's a product/UX question
(should the homepage paginate or cap at "latest N"?) independent of the
timing numbers above; noted here because it compounds the same trend, not
fixed here because it isn't this gate's call to make.

### 4. Draft lock / heartbeat overhead — cheap, confirmed; but not reachable end-to-end in this build

- `evaluateLock` (`src/domain/lock.ts`, pure, no I/O): **~0.027 µs/call** (50,000 calls, 1.33ms total).
- `evaluateAutosave` (`src/domain/autosave.ts`, pure, no I/O): **~0.59 µs/call** (50,000 calls, 29.4ms total).
- The heartbeat's actual DB write — `update articles set locked_by=…, locked_at=now() where …` (the exact pattern `tests/db/schema.test.ts` and `createDraft.ts`'s `takeLock` use) — timed directly against real Postgres, 20 back-to-back calls: cold **0.87ms**, warm avg **0.68ms** (range 0.53-0.94ms).

All comfortably pass the proposed 50ms budget (under 2% of it). **However:**
this had to be measured piecewise rather than end-to-end, and that gap is
itself worth reporting plainly. `src/api/createDraft.ts` (`handleCreateDraft`
/ `handleOpenDraft` — the actual code that would issue this heartbeat write
in production) **is not reachable over HTTP in this build**:
`src/api/router.ts`'s route table only matches `/publish` and `/images`, and
`src/api/repo.ts` does not implement the `insertDraft`/`takeLock` methods
`createDraft.ts` depends on. This was independently confirmed, more
authoritatively, by `pdlc/arsene-cms/verify/instrumentation.md` (written
concurrently as part of this same verify gate), which blocks the gate on
correctness grounds (AC-05 has no reachable enforcement path). That is a
correctness finding, not a performance one, and this document doesn't
duplicate it as a perf failure — but it means **the number above is a proxy
for what the wired version's cost floor will be (raw query time), not a
measurement of the real end-to-end path**, because no such path exists yet
to measure. Once `createDraft.ts` is wired (per instrumentation.md's
recommended fix), this should be re-measured over real HTTP the same way §1
was — the publish handler's ~4-6ms warm overhead for auth+routing+one extra
query suggests the wired heartbeat endpoint will land well inside the 50ms
budget, but that is an estimate, not a measurement, until it exists.

## What could not be measured, and why

- **Cloudflare on-demand revalidation propagation time** (the actual "does
  the page go live" latency ADR-0001 exists to fix) is unmeasurable from this
  repo as built: `router.ts`'s `revalidation.revalidate()` is a literal stub
  (`async () => ({ ok: true })`) — by design, per its own comment ("the
  Cloudflare purge itself is a deploy concern, so this entry point records
  the call rather than performing it"). There is no Cloudflare integration
  in this repo to measure yet. Proposed measurable replacement for a later
  gate (once that wiring exists): a synthetic check — publish an article,
  then poll the actual public URL until the new content appears — with a
  budget of, say, p95 < 10s from publish-response to visible-on-the-public-
  URL. This is the same "synthetic check exercising the publish flow
  end-to-end" `02-architecture.v1.md` §6 already names for rollback
  detection; it would serve double duty here.
- **Draft heartbeat over real HTTP** — see §4 above; unmeasurable until
  `createDraft.ts` is wired to a route and a working repo implementation.
- **Concurrent-writer contention** (2-5 writers publishing/heartbeating at
  once) was not load-tested. Per `02-architecture.v1.md` §4 this is a
  5-15-article/week, 2-5-writer system; raw concurrency is not the stated
  concern, and nothing measured above (single-digit ms warm publish, <1ms
  heartbeat writes) suggests contention would be the first thing to break at
  this scale. If the product owner wants this checked anyway, it's a
  cheap follow-up (k6, a handful of virtual users) rather than something
  this gate needs to block on.

## Summary

| Area | Proposed budget | Measured | Verdict |
|---|---|---|---|
| Publish handler (warm) | p95 < 500ms | p50 4.6ms / p95 6.4ms | PASS (large margin) |
| Publish handler (cold) | < 2s | 47.3ms | PASS (large margin) |
| Image optimize, typical (~4MB) | < 5s | 1.7-2.0s (JPEG), 0.2-0.44s (PNG) | PASS |
| Image optimize, near 20MB cap | < 15s | 9.1-10.6s (JPEG), 0.8-0.85s (PNG) | PASS (tightest margin — ~65-70% of budget for the realistic JPEG worst case) |
| Public render, homepage/category | < 200ms | 0.45ms (N=0) → 8.8ms (N=1000) | PASS, but the only real growth *trend* found — flagged, not urgent |
| Lock/heartbeat decision + write | < 50ms | ~0.68ms (DB write); ~0µs (pure functions) | PASS, but only measurable piecewise — the real endpoint doesn't exist yet (see instrumentation.md) |

**Nothing here blocks the verify gate on performance grounds.** The one
finding worth carrying forward as a tracked, non-urgent item is render.ts's
O(archive size) cost for every page (§3) — cheap to fix, not yet worth
spending the complexity on. The one number worth watching if usage grows is
image optimization near the 20MB ceiling (§2) — already comfortably passing,
but the least comfortable pass in the system.
