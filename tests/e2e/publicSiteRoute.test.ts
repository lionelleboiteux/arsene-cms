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
    // PUBLIC-ROUTE-11b's own fixture: a real Arsène slug is always plain
    // ASCII (`toSlug()` strips accents at publish time), but the Wix
    // bookmark for it can carry one — exercises the actual HTTP-level bug
    // (`new URL(...).pathname` never percent-decodes non-ASCII, confirmed
    // live) that no `tests/db/publicSiteRender.test.ts` unit test can see,
    // since those call `resolveWixPostPath` directly with an
    // already-decoded string.
    await seedArticle(db.client, {
      writer_id: writerId,
      title: 'Guide Eliteserien Mi-saison',
      league_name: 'Eliteserien',
      type_name: 'Guides',
      status: 'published',
      slug: 'eliteserien-2026-bilan-a-mi-saison',
      published_at: '2026-08-20T17:13:28Z',
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
  it('PUBLIC-ROUTE-01: the homepage requires no credential and renders the portal, as JSON-wrapped HTML', async () => {
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
    // The home page portal (`homePage()`, `src/site/render.ts`) only ever
    // features a Ligue 1 *Player Picks* article as its hero — this file's
    // fixture is Ligue 1 / Pronos (its real job is exercising the nested
    // article/category/legacy-redirect routes below, at that exact path),
    // so no hero renders here. That content match belongs to
    // `tests/db/publicSiteRender.test.ts`; this just proves the route is
    // reachable, credential-free, and answers the real portal chrome.
    expect(html).toContain('<div class="home-page">');
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

  it("PUBLIC-ROUTE-11b: an old Wix bookmark carrying a real accent resolves over an actual HTTP request, not just at the render-function level", async () => {
    const { server } = ctx();
    // The literal 'à' below is what a real browser/curl sends — `fetch`
    // percent-encodes it into the request line itself, the same as any
    // real old Wix bookmark would arrive at this route over the wire.
    const res = await fetch(`${server.url}/public/post/eliteserien-2026-bilan-à-mi-saison`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe(`${SITE_ORIGIN}/articles/eliteserien/26-27/guides/eliteserien-2026-bilan-a-mi-saison`);
  });

  it('PUBLIC-ROUTE-12: an old Wix bookmark for a post never manually migrated to Arsène signals a redirect to the static Wix archive, not a 404', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/post/never-migrated-from-wix`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe('https://archive.fantasy-coach.fr/never-migrated-from-wix');
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

  it('PUBLIC-ROUTE-13: /sitemap.xml requires no credential and lists the published article, as JSON-wrapped XML', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/sitemap.xml`);

    // Same JSON-envelope reasoning as every other public route: the real
    // `application/xml` response only ever reaches a browser via the
    // Cloudflare proxy in front of this route.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { body, content_type } = (await res.json()) as { body: string; content_type: string };
    expect(content_type).toBe('application/xml');
    expect(body).toContain(`${SITE_ORIGIN}/articles/ligue-1/26-27/pronos/pp-test`);
  });

  it('PUBLIC-ROUTE-14: /robots.txt requires no credential and points at the sitemap', async () => {
    const { server } = ctx();
    const res = await fetch(`${server.url}/public/robots.txt`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { body, content_type } = (await res.json()) as { body: string; content_type: string };
    expect(content_type).toBe('text/plain');
    expect(body).toContain('Allow: /');
    expect(body).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });
});
