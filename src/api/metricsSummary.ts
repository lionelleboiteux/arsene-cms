/**
 * `GET /internal/metrics/time-to-publish` — the data adapter John's
 * dashboard gate needs (`pdlc/arsene-cms/11-dashboard.v1.md`).
 *
 * Pam's one success metric (`state.json`'s `success.metrics[0]`) is "time
 * from draft start to published", computed from the two telemetry events
 * this project already records (`draft_started`, `article_published`). This
 * endpoint is the read side of that data: it returns raw samples — a
 * timestamp and a duration, nothing else — and lets the dashboard's own
 * (tiny, framework-free) JS bucket and aggregate them however it needs to.
 *
 * Also returns the counter-metric (`state.json`'s `success.counter_metric`,
 * "writer adoption must not decline"): a *count* of writers who have started
 * a draft in the last 30 days, never a list — the dashboard needs to know
 * adoption isn't dropping, not who is or isn't drafting.
 *
 * `arsene_telemetry_events` has row level security enabled with no policies
 * (db/migrations/0001_initial_schema.sql), so `anon`/`authenticated` cannot
 * read it at all through Supabase's own Data API — this app doesn't use that
 * API anywhere else either (the public site renders from a direct Postgres
 * connection, not PostgREST). Exposing it through the same Edge Function
 * that already holds `service_role` access reuses existing infrastructure
 * rather than opening a new one, and a shared secret (mirroring
 * `imageStatus.ts`'s pattern) keeps it out of reach of a writer's bearer
 * token or an anonymous caller — a writer JWT proves who is drafting
 * articles, not that they may read team-wide timing aggregates.
 */

import { verifySharedSecret } from './auth.ts';
import { errorResponse, type HandlerResponse } from './http.ts';

export type TimeToPublishSample = { published_at: string; minutes: number };

export type MetricsSummaryRequest = {
  /** The `x-arsene-dashboard-secret` header, never an Authorization one. */
  dashboard_secret: string | null;
};

export type MetricsSummaryDeps = {
  dashboardSecret: string;
  repo: {
    getTimeToPublishSamples(): Promise<TimeToPublishSample[]>;
    getActiveWriterCount(sinceDaysAgo: number): Promise<number>;
  };
};

/** Matches `state.json`'s `success.metrics[0].by_when` window. */
const ADOPTION_WINDOW_DAYS = 30;

export async function handleMetricsSummary(
  req: MetricsSummaryRequest,
  deps: MetricsSummaryDeps,
): Promise<HandlerResponse> {
  if (!verifySharedSecret(req.dashboard_secret, deps.dashboardSecret)) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid dashboard secret is required.');
  }

  const [samples, active_writers] = await Promise.all([
    deps.repo.getTimeToPublishSamples(),
    deps.repo.getActiveWriterCount(ADOPTION_WINDOW_DAYS),
  ]);
  return {
    status: 200,
    body: {
      generated_at: new Date().toISOString(),
      time_to_publish: samples,
      counter_metric: {
        active_writers_last_30_days: active_writers,
      },
    },
  };
}
