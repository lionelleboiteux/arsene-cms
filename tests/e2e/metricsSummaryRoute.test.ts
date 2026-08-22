import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { insertTelemetry, seedArticle, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWT_SECRET, mintSupabaseJwt } from '../support/jwt.js';

/**
 * `GET /internal/metrics/time-to-publish`'s transport wiring — John's
 * dashboard gate (`pdlc/arsene-cms/11-dashboard.v1.md`). The handler's own
 * decision-making is in `tests/unit/metricsSummary.test.ts`, the query's
 * correctness in `tests/db/timeToPublishMetric.test.ts`; this proves the
 * route is actually reachable, actually enforces the dashboard secret
 * (not a writer JWT), and actually rejects the wrong method — over a real
 * spawned router, the same standard every other route here is held to.
 */

const DASHBOARD_SECRET = 'dashboard-shared-secret-not-a-writer-token';

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> }; writerId: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startHttpServer } = await loadApiRouter();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Lionel Le Boiteux');
    const article = await seedArticle(db.client, {
      writer_id: writerId,
      title: 'Metrics fixture article',
      league_name: 'Ligue 1',
      type_name: 'Match Preview',
    });
    await insertTelemetry(db.client, {
      event_type: 'draft_started',
      writer_id: writerId,
      article_id: article,
      occurred_at: '2026-01-01T10:00:00.000Z',
    });
    await insertTelemetry(db.client, {
      event_type: 'article_published',
      writer_id: writerId,
      article_id: article,
      occurred_at: '2026-01-01T10:12:00.000Z',
    });
    const server = await startHttpServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-static-token',
      writerId,
      jwtSecret: TEST_JWT_SECRET,
      dashboardReadSecret: DASHBOARD_SECRET,
    });
    started = { db, server, writerId };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

describe('the real /internal/metrics/time-to-publish route', () => {
  it('DASHBOARD-ROUTE-01: no dashboard secret is refused 401', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/internal/metrics/time-to-publish`);
    expect(res.status).toBe(401);
  });

  it('DASHBOARD-ROUTE-02: a valid writer JWT is not accepted in place of the dashboard secret', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });
    const res = await fetch(`${server.url}/internal/metrics/time-to-publish`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('DASHBOARD-ROUTE-03: POST (the wrong method) is refused 405', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/internal/metrics/time-to-publish`, {
      method: 'POST',
      headers: { 'x-arsene-dashboard-secret': DASHBOARD_SECRET },
    });
    expect(res.status).toBe(405);
  });

  it('DASHBOARD-ROUTE-04: the correct dashboard secret returns the real computed sample from Postgres', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/internal/metrics/time-to-publish`, {
      headers: { 'x-arsene-dashboard-secret': DASHBOARD_SECRET },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      time_to_publish: { published_at: string; minutes: number }[];
      counter_metric: { active_writers_last_30_days: number };
    };
    expect(body.time_to_publish).toHaveLength(1);
    expect(body.time_to_publish[0]?.minutes).toBe(12);
    // The seeded draft_started is dated 2026-01-01 — outside a real 30-day
    // window from whenever this suite runs — so the writer count is 0.
    expect(body.counter_metric).toEqual({ active_writers_last_30_days: 0 });
  });
});
