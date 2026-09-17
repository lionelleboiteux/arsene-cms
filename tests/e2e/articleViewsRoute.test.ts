import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { insertArticleView, seedArticle, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, mintSupabaseJwt } from '../support/jwt.js';

/**
 * `GET /v1/articles/views` — the home page's per-article view counts,
 * driven against the real spawned server (`startServer`, not the in-process
 * shortcut `tests/unit/articleViews.test.ts` uses), so `router.ts`'s own
 * `route()`/`methodOf()` method-matching is actually exercised. That gap is
 * exactly what shipped a real bug: `methodOf()` never listed `article-views`
 * among its GET kinds, so `route()` fell through to its `POST` default and
 * every real GET from the home page 405'd with "Only POST is supported on
 * this path" — invisible to the unit test, which calls `handleGetArticleViews`
 * directly and never goes through `route()` at all. Confirmed live
 * (2026-09-17): the writer home page's "N vues" badges stayed stuck at 0
 * indefinitely, even after a real, DB-confirmed view.
 */

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> }; writerId: string; token: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Lionel (article-views e2e)');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-legacy-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
    });
    started = { db, server, writerId, token: await mintSupabaseJwt({ sub: writerId }) };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

describe('GET /v1/articles/views (real server)', () => {
  it('ARTICLE-VIEWS-ROUTE-01: a real GET is accepted, not refused 405 for a POST-only mismatch', async () => {
    const { db, server, writerId, token } = ctx();
    const article = await seedArticle(db.client, {
      writer_id: writerId,
      title: 'Article Views Route E2E',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'article-views-route-e2e',
    });
    await insertArticleView(db.client, { article_id: article });

    const res = await fetch(`${server.url}/v1/articles/views`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { views: { article_id: string; views: number }[] };

    expect(res.status).toBe(200);
    expect(body.views).toContainEqual({ article_id: article, views: 1 });
  });
});
