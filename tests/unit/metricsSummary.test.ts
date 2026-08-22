import { describe, expect, it } from 'vitest';
import { handleMetricsSummary, type MetricsSummaryDeps, type TimeToPublishSample } from '../../src/api/metricsSummary.js';

/**
 * `GET /internal/metrics/time-to-publish` — John's dashboard gate
 * (`pdlc/arsene-cms/11-dashboard.v1.md`). The DB-level correctness of the
 * query itself is in `tests/db/timeToPublishMetric.test.ts`; this file is
 * the handler's own decision-making, so it needs neither Postgres nor a
 * spawned server.
 */

const DASHBOARD_SECRET = 'dashboard-shared-secret-not-a-writer-token';

function buildDeps(samples: TimeToPublishSample[] = [], activeWriters = 0): MetricsSummaryDeps {
  return {
    dashboardSecret: DASHBOARD_SECRET,
    repo: {
      getTimeToPublishSamples: async () => samples,
      getActiveWriterCount: async () => activeWriters,
    },
  };
}

describe('metrics summary authentication', () => {
  it('DASHBOARD-AUTH-01: no dashboard secret at all is refused 401', async () => {
    const res = await handleMetricsSummary({ dashboard_secret: null }, buildDeps());
    expect(res.status).toBe(401);
  });

  it('DASHBOARD-AUTH-02: a writer bearer token is not accepted in place of the dashboard secret', async () => {
    const res = await handleMetricsSummary(
      { dashboard_secret: 'Bearer some-writer-jwt' },
      buildDeps(),
    );
    expect(res.status).toBe(401);
  });

  it('DASHBOARD-AUTH-03: an unconfigured deployment (empty dashboardSecret) refuses every caller, including one guessing an empty string', async () => {
    const deps: MetricsSummaryDeps = {
      dashboardSecret: '',
      repo: { getTimeToPublishSamples: async () => [], getActiveWriterCount: async () => 0 },
    };
    const res = await handleMetricsSummary({ dashboard_secret: '' }, deps);
    expect(res.status).toBe(401);
  });
});

describe('metrics summary happy path', () => {
  it('DASHBOARD-02: returns the raw samples untouched, plus the counter-metric and a generation timestamp', async () => {
    const samples: TimeToPublishSample[] = [
      { published_at: '2026-01-01T10:08:00.000Z', minutes: 8 },
      { published_at: '2026-01-02T09:15:00.000Z', minutes: 15 },
    ];

    const res = await handleMetricsSummary(
      { dashboard_secret: DASHBOARD_SECRET },
      buildDeps(samples, 4),
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      generated_at: string;
      time_to_publish: TimeToPublishSample[];
      counter_metric: { active_writers_last_30_days: number };
    };
    expect(body.time_to_publish).toEqual(samples);
    expect(body.counter_metric).toEqual({ active_writers_last_30_days: 4 });
    expect(typeof body.generated_at).toBe('string');
    expect(() => new Date(body.generated_at).toISOString()).not.toThrow();
  });

  it('DASHBOARD-03: no samples yet (nothing published in production) is answered 200 with an empty list, not an error — "too early" is a dashboard state, not a failure', async () => {
    const res = await handleMetricsSummary({ dashboard_secret: DASHBOARD_SECRET }, buildDeps([]));

    expect(res.status).toBe(200);
    expect((res.body as { time_to_publish: unknown[] }).time_to_publish).toEqual([]);
  });
});
