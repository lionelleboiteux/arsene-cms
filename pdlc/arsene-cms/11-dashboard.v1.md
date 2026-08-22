# arsene-cms — Benefit dashboard gate (v1)

**Status: built, wired to the real store, and rehearsed against real
infrastructure — but honestly "too early" for a real current reading,
because nothing has shipped to production yet.**

**Run:** 2026-08-22, branch `feat/arsene-cms`, on top of commit `f1ee570`.

---

## 0. Pam's metric, as recorded in `state.json`

```json
{
  "metrics": [
    {
      "name": "time from draft start to published",
      "baseline": "approximately 50 minutes (self-reported estimate, not yet precisely measured)",
      "target": "under 10 minutes",
      "by_when": "4 weeks after launch"
    }
  ],
  "counter_metric": "writer adoption must not decline - writers reverting to drafting in Word or Google Docs and manually pasting is a failure signal even if the time metric improves",
  "required_events": ["draft_started", "article_published"]
}
```

Both required events (`draft_started`, `article_published`) have been
recorded in `telemetry_events` since the green gate, and their shape was
pinned by tests as early as the red gate (`tests/telemetry/eventShape.test.ts`).
This gate's job was to build the adapter that turns those rows into the
metric, and the dashboard that shows it — not to invent new instrumentation.

## 1. The store, and why the adapter is a new API route rather than PostgREST

Per `02-architecture.v1.md` (line 259): "Measured: time-to-publish per
article, computed from `telemetry_events`" — a table in the app's own
Postgres database. The dashboard-gate skill's own table names the adapter
for that case: "A read-only endpoint returning aggregates as JSON."

Two ways to build that endpoint were available:

- **Supabase's own Data API (PostgREST)**, exposing a view over
  `telemetry_events` to `anon`/`authenticated`.
- **A new route on the existing Edge Function**, which already holds
  `service_role` access to the database for every other operation.

`telemetry_events` has row level security enabled with **no policies**
(`db/migrations/0001_initial_schema.sql`), so `anon`/`authenticated` cannot
read it via PostgREST at all today — and this app doesn't use PostgREST
anywhere else either; the public site renders from a direct Postgres
connection (`src/site/render.ts`), not the Data API. Opening PostgREST
access here would mean standing up a data-access pattern this project has
never used, purely for one dashboard. Adding `GET /internal/metrics/time-to-publish`
to the Edge Function reuses infrastructure that already exists and is
already deployed — which is what "no new infrastructure" (this gate's own
instruction) actually means in this codebase's case.

**New code, so it gets the same standard as everything else in this repo:**

- `src/api/repo.ts`: `getTimeToPublishSamples()` (joins `draft_started` →
  `article_published` per article, returns `{ published_at, minutes }[]` —
  never a `writer_id` or `article_id`) and `getActiveWriterCount(days)` (a
  count, never a list, for the counter-metric).
- `src/api/metricsSummary.ts`: `handleMetricsSummary`, the handler.
- `src/api/router.ts`: the route itself, `GET /internal/metrics/time-to-publish`,
  guarded by a new shared secret (`x-arsene-dashboard-secret` /
  `DASHBOARD_READ_SECRET`) — checked from the header alone, before dispatch,
  the same pattern `imageStatus.ts`'s callback secret already uses. A writer's
  Supabase Auth JWT is deliberately **not** accepted here: it proves who is
  drafting articles, not that they may read team-wide timing aggregates.
- Threaded through both adapters (`startHttpServer`, the Deno entry point)
  and the Node child-process boundary (`server.ts`/`serverMain.ts`) — the
  same three places every other secret in this codebase has to be threaded
  through, checked against the same historical bug (`server.ts`'s comment:
  "the last time it advertised an option it silently dropped").
- **10 new tests**: `tests/unit/metricsSummary.test.ts` (auth + happy path,
  fake repo), `tests/db/timeToPublishMetric.test.ts` (the real query against
  real Postgres — the join and the arithmetic are the part a fake would not
  honestly exercise), `tests/e2e/metricsSummaryRoute.test.ts` (the route
  wired end-to-end through a real spawned router: no secret → 401, a writer
  JWT → still 401, wrong method → 405, correct secret → the real computed
  value). Full suite: **244/244**, zero regressions.

## 2. The dashboard: `dashboard/index.html`

A single self-contained static HTML file — no framework, no build step, no
new infrastructure (the skill's own requirement). Deployable anywhere static
files are served, same free tier as the rest of the app.

- One card for the metric: baseline, current (median of real samples),
  target, deadline — plus a sparkline of the daily median, drawn as a plain
  inline SVG polyline (no charting library).
- One card for the counter-metric, styled distinctly (a dashed warning
  border) so a reader can't miss it while focused on the metric moving in
  the right direction — the skill's own instruction ("shown prominently
  enough that a regression is obvious rather than discoverable").
- The base URL and the dashboard secret are entered by whoever opens the
  page and stored in `localStorage`, never baked into the file. The file
  itself carries no secret and works against any environment (local
  rehearsal, staging, production) it's pointed at.
- Empty/error states are explicit: zero samples renders "too early... the
  baseline is Pam's estimate, not yet confirmed" rather than a blank chart
  or a fabricated number; a fetch failure shows the HTTP status and the
  likely cause (base URL or secret) rather than failing silently.

## 3. Rehearsal — what was actually run, and the one thing that wasn't

Real Postgres 16 (`docker run postgres:16-alpine`), the real migrations, a
real `serverMain.ts` process (run directly by Node's native TypeScript
support, no compile step), seeded with three real `draft_started`/
`article_published` pairs across two writers.

```
$ curl http://127.0.0.1:38400/internal/metrics/time-to-publish \
    -H "x-arsene-dashboard-secret: rehearsal-dashboard-secret"
{
  "generated_at": "2026-08-22T20:48:19.527Z",
  "time_to_publish": [
    { "published_at": "2026-08-20T20:48:02.085Z", "minutes": 9 },
    { "published_at": "2026-08-21T20:48:02.085Z", "minutes": 14 },
    { "published_at": "2026-08-22T20:48:02.085Z", "minutes": 6 }
  ],
  "counter_metric": { "active_writers_last_30_days": 2 }
}
```

The dashboard's client-side aggregation logic (median, daily bucketing) was
verified against this exact real payload in Node — median 9, three distinct
daily buckets, matching by hand. **What was not verified: the page actually
rendering in a browser.** This environment has no connected browser
extension and no headless-browser tooling installed (`playwright`/
`puppeteer`/`jsdom` are not project dependencies), so the HTML/CSS/DOM side
— does the config panel accept input, does the sparkline actually draw,
does the layout hold — was reviewed by hand but not driven by an automated
or interactive browser session. Recorded here plainly rather than claimed as
done: **open `dashboard/index.html` in an actual browser against a real or
rehearsed deployment before trusting it in front of Pam.**

## 4. The baseline — captured, and why "current" cannot be captured yet

Per this gate's own instructions: "Where Pam wrote 'unknown - must be
measured before release', this is the moment that gets resolved." Pam did
not write "unknown" — she gave a number, but flagged it as a self-reported
estimate, not a measurement. That distinction matters here because nothing
in this build has shipped to production: **zero articles have been drafted
or published by a real writer through the real system.** `telemetry_events`
in the real Supabase project (if a schema were even deployed there yet — see
`10-pipeline.v2.md` §2, not yet rehearsed against the live project) has no
rows and cannot have any until real usage begins.

- **Baseline**: Pam's self-reported estimate, unchanged — **~50 minutes**,
  captured 2026-08-22, source: product spec / stated by Pam, not measured.
- **Current**: not establishable yet. The dashboard shows "too early" rather
  than a fabricated number when the sample count is zero (§2 above) — this
  is the gate's own instruction ("a dashboard showing invented numbers is
  worse than no dashboard") applied literally, not worked around.
- **How long until a stable current reading exists**: unknown until launch
  happens and writers start drafting through the real system. A reasonable
  first check-in would be after the first 5-10 real published articles, or
  2 weeks post-launch, whichever comes first — a single early publish
  finishing in 4 minutes because it was a trivial test article would say
  nothing about the real distribution.
- **Counter-metric baseline**: no writers are using the system yet either, so
  "0 active writers" is not a decline from a nonexistent prior state — it is
  the starting point. The number to watch is whether it *grows* toward the
  real team's size after launch and then holds, not any specific value now.

## 5. What this gate did not do

- Deploy `dashboard/index.html` anywhere. It is a static file in this repo;
  hosting it (Cloudflare Pages, GitHub Pages, or any static host) is a
  release-gate concern, not this one's.
- Deploy the new `DASHBOARD_READ_SECRET` to a real Supabase project — no
  real deployment exists yet to configure (`10-pipeline.v2.md` §2).
- Verify the dashboard visually in a browser (§3 above) — a real, disclosed
  gap, not silently skipped.
- Add any UI for viewing this dashboard inside the writer-facing editor SPA
  — this is Pam's/the team's dashboard, deliberately separate from the
  product itself.

## 6. Gate verdict

**Built, and honest about what it can and cannot show yet.** The adapter is
real, tested three ways (unit, real-DB, real-spawned-route), and proven
against a real running server with real seeded data. The dashboard correctly
distinguishes "no data yet" from "the metric is bad" — the one failure mode
this gate's own instructions singled out as worse than not building a
dashboard at all. What it cannot do is show a true "current" value, because
this product has not shipped to real users yet; that is a fact about the
project's timeline, not a defect in the dashboard.

**Recommended next steps, in order:**
1. Open `dashboard/index.html` in a real browser against a rehearsed local
   server (§3) before showing it to Pam, to close the one unverified gap.
2. Once `10-pipeline.v2.md`'s remaining step (a real deploy) happens, set
   `DASHBOARD_READ_SECRET` on the real project and host this file statically
   somewhere Pam can reach it.
3. Revisit this document after the first 5-10 real published articles (or 2
   weeks post-launch) to record the first real "current" reading — that is
   also the natural moment for John's review gate to start being meaningful.
