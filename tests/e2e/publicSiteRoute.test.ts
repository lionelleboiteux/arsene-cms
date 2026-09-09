import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedArticle, seedImage, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * The public reader-facing routes' transport wiring — homepage, the nested
 * league/season/category article and listing routes, and the legacy flat
 * `/articles/{slug}` redirect — added on top of the Edge Function that is
 * already deployed, standing in for ADR-0001's not-yet-built Next.js/ISR
 * app. The render pass's own correctness (listing order, cover fallback,
 * JSON-LD, sitemap, season scoping) is proven in
 * `tests/db/publicSiteRender.test.ts` against `src/site/render.ts` directly;
 * this proves the routes are actually reachable over the real spawned
 * router, require no credential (unlike every other route here), answer
 * HTML rather than this API's JSON envelope, and 404 an unknown slug.
 */

const SITE_ORIGIN = 'https://fantasycoach.example';

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> } };

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
      title: 'PP test',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'pp-test',
      published_at: '2026-08-26T20:36:26.641Z',
    });
    await seedImage(db.client, {
      article_id: article,
      role: 'cover',
      optimized_url: 'https://cdn.fantasycoach.example/pp-test/cover-optimized.webp',
    });
    const server = await startHttpServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-static-token',
      writerId,
      siteOrigin: SITE_ORIGIN,
    });
    started = { db, server };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

describe('the real public site routes', () => {
  it('PUBLIC-ROUTE-01: the homepage requires no credential and lists the published article, as JSON-wrapped HTML', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/`);

    // Supabase rewrites any GET response with `Content-Type: text/html` to
    // `text/plain` (functions/http-methods docs) — confirmed against the real
    // deployment. So this route hands the rendered HTML back as JSON
    // (`{ html }`), and the Cloudflare proxy in front of it (not this route)
    // is what actually serves `text/html` to a browser.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { html } = (await res.json()) as { html: string };
    expect(html).toContain('data-article-title="PP test"');
  });

  it('PUBLIC-ROUTE-02: the nested article page requires no credential and renders the published article, as JSON-wrapped HTML', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/ligue-1/26-27/pronos/pp-test`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { html } = (await res.json()) as { html: string };
    expect(html).toContain('data-article-title="PP test"');
    expect(html).toContain(SITE_ORIGIN);
  });

  it('PUBLIC-ROUTE-03: an unknown slug under a real league/season/category is a real 404, not a 200 with an empty page', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/ligue-1/26-27/pronos/does-not-exist`);

    expect(res.status).toBe(404);
  });

  it('PUBLIC-ROUTE-03b: the right slug under the wrong league/season/category prefix is also a 404, not the article', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/premier-league/26-27/pronos/pp-test`);

    expect(res.status).toBe(404);
  });

  it('PUBLIC-ROUTE-06: the league/season/category listing requires no credential and lists the published article', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/ligue-1/26-27/pronos`);

    expect(res.status).toBe(200);
    const { html } = (await res.json()) as { html: string };
    expect(html).toContain('data-article-title="PP test"');
  });

  it('PUBLIC-ROUTE-07: the legacy flat /articles/{slug} URL signals a redirect to the real nested path as JSON, not a real 3xx', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/pp-test`);

    // JSON, not a real HTTP redirect: the Cloudflare proxy in front of this
    // route (public-site/functions/[[path]].ts) is the one that turns this
    // into an actual 301 for a browser — confirmed by trial against the real
    // deployment that a genuine 301 here does not survive that proxy's own
    // fetch of it intact (its own doc comment has the full story).
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe(`${SITE_ORIGIN}/articles/ligue-1/26-27/pronos/pp-test`);
  });

  it('PUBLIC-ROUTE-08: the legacy flat URL 404s for a slug that never existed, rather than redirecting anywhere', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/never-existed`);

    expect(res.status).toBe(404);
  });

  it('PUBLIC-ROUTE-10: an old Wix bookmark (/public/post/{slug}) whose slug matches exactly signals a redirect to the real nested path as JSON, not a real 3xx', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/post/pp-test`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe(`${SITE_ORIGIN}/articles/ligue-1/26-27/pronos/pp-test`);
  });

  it('PUBLIC-ROUTE-11: an old Wix bookmark whose slug only differs by Wix\'s own dedup suffix still resolves', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/post/pp-test-4`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe(`${SITE_ORIGIN}/articles/ligue-1/26-27/pronos/pp-test`);
  });

  it('PUBLIC-ROUTE-12: an old Wix bookmark for a post never migrated to Arsène is a real 404, not a homepage bounce', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/post/never-migrated-from-wix`);

    expect(res.status).toBe(404);
  });

  it('PUBLIC-ROUTE-09: /public/articles/{league_slug} requires no credential and lists every published article in that league', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/ligue-1`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { html } = (await res.json()) as { html: string };
    expect(html).toContain('data-article-title="PP test"');
  });

  it('PUBLIC-ROUTE-04: POST (the wrong method) is refused 405', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/articles/ligue-1/26-27/pronos/pp-test`, { method: 'POST' });

    expect(res.status).toBe(405);
  });

  it('PUBLIC-ROUTE-05: an Authorization header is not required, unlike every other route', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/`);

    expect(res.status).not.toBe(401);
  });
});
