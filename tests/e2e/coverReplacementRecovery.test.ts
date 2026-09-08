import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer, loadSiteRender } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import {
  seedArticle,
  seedImage,
  seedWriter,
  startTestDatabase,
  type TestDatabase,
} from '../support/pg.js';
import { corruptedJpeg } from '../support/imageFixtures.js';

/**
 * M-V4-01 (`05-verification.v4.md` §6, Medium, recommended blocking) — **a
 * truncated cover upload blanks a live article's cover and then permanently
 * blocks republication.**
 *
 * `uploadImage.ts` demotes the article's *current* cover to `body` before it
 * has established that the newly uploaded file is even a complete container
 * (`demoteCurrentCover()` runs ahead of `isDamagedContainer()`). The verify
 * pass proved, against the real spawned server and real Postgres, what that
 * costs a writer who fat-fingers a truncated file onto an already-published
 * article:
 *
 *   before:  [{role: cover,  status: ready,  cover.jpg}]
 *   upload truncated.jpg as cover           -> 201 {"status":"failed"}
 *   after:   [{role: body,   status: ready,  cover.jpg},
 *             {role: cover,  status: failed, truncated.jpg}]
 *   the live page's cover is now            -> null
 *   republish                               -> 409 IMAGE_NOT_READY
 *   upload a GOOD replacement, republish    -> 409 IMAGE_NOT_READY   (still)
 *   can `authenticated` delete the bad row? -> no (42501), and no route exists
 *
 * AC-08's documented remedy — "the row exists and says why, so the writer is
 * told to replace it and the publish endpoint refuses the article until they
 * do" — is therefore false for this case: replacing does not clear the block,
 * because `publishArticle.ts`'s readiness gate counts *every* image row on the
 * article, including the demoted-and-failed one nothing points at any more.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **Observable behaviour, not a prescribed fix.** The verify report names
 *    three plausible repairs (reorder demote-then-validate; scope publish's
 *    readiness check; grant a scoped `delete` plus a route). Nothing below
 *    asserts which one was chosen, or even what the upload *responds* — a fix
 *    that refuses the file `422` outright and one that still creates a
 *    `failed` row both satisfy these tests. What is asserted is the only part
 *    a writer or a visitor can see: the live cover survives, and the article
 *    can still be published afterwards.
 *
 * 2. **Against real infrastructure, because that is the whole finding.** Six
 *    green gates missed this: every committed upload test aims a corrupt file
 *    at a *fresh draft* with fakes underneath, where there is no live cover to
 *    lose and no publish afterwards. So these run over real HTTP against the
 *    real spawned server, on a real Postgres, and read the world afterwards —
 *    the database row and the real public render pass, not the response.
 *
 * 3. **`AC-08-recovery-03` is the both-sides control.** The cheapest way to
 *    make the first two pass is to stop counting `failed` rows at publish
 *    altogether — which would silently delete AC-08's actual promise. That
 *    control fixes the boundary: a `failed` image the article is genuinely
 *    still using must keep refusing the publish, `409 IMAGE_NOT_READY`. It
 *    passes today, and must still pass after the fix. Its unit-level sibling
 *    (`AC-08b` in tests/unit/publishArticle.test.ts) cannot police this,
 *    because it feeds the handler a hand-built image list: a repository-level
 *    fix that filtered `failed` rows out of `getArticleImages` would leave it
 *    green and the product broken.
 *
 * Legacy static-token auth, exactly as tests/e2e/publishJourney.test.ts uses
 * it and for the same stated reason (`router.ts`'s `verify()` comment, and
 * tests/e2e/failClosedConfig.test.ts / `NFR-FAILCLOSED-01` for the mechanism
 * that makes it a choice rather than an accident). Setup only: authorization
 * is not what any assertion in this file is about.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
const SITE_ORIGIN = 'https://fantasycoach.example';
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';

type Fixtures = {
  /** A live article whose ready cover a failed upload must not cost it. */
  live_article: string;
  live_cover_id: string;
  live_slug: string;
  /** A live article used only for the republish-after-a-failed-upload path. */
  republish_article: string;
  /** A draft whose *current* body image failed — the control's subject. */
  failed_body_article: string;
};

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  writerId: string;
  fx: Fixtures;
};

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

async function seedFixtures(db: TestDatabase, writerId: string): Promise<Fixtures> {
  const live_slug = 'article-en-ligne-avec-couverture';
  const live_article = await seedArticle(db.client, {
    writer_id: writerId,
    title: 'Article en ligne avec couverture',
    league_name: 'Ligue 1',
    type_name: 'Pronos',
    status: 'published',
    slug: live_slug,
    published_at: '2026-08-10T09:00:00Z',
    first_published_at: '2026-08-10T09:00:00Z',
  });
  const live_cover_id = await seedImage(db.client, {
    article_id: live_article,
    role: 'cover',
    status: 'ready',
  });

  const republish_article = await seedArticle(db.client, {
    writer_id: writerId,
    title: 'Article à republier après un envoi raté',
    league_name: 'Bundesliga',
    type_name: 'Mercato',
    status: 'published',
    slug: 'article-a-republier-apres-un-envoi-rate',
    published_at: '2026-08-10T09:00:00Z',
    first_published_at: '2026-08-10T09:00:00Z',
  });
  await seedImage(db.client, { article_id: republish_article, role: 'cover', status: 'ready' });

  const failed_body_article = await seedArticle(db.client, {
    writer_id: writerId,
    title: 'Brouillon avec une image de corps en échec',
    league_name: 'Serie A',
    type_name: 'Pronos',
  });
  await seedImage(db.client, { article_id: failed_body_article, role: 'cover', status: 'ready' });
  await seedImage(db.client, { article_id: failed_body_article, role: 'body', status: 'failed' });

  return { live_article, live_cover_id, live_slug, republish_article, failed_body_article };
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Lionel Le Boiteux');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: WRITER_TOKEN,
      writerId,
      allowLegacyAuth: true,
    });
    started = { db, server, writerId, fx: await seedFixtures(db, writerId) };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

const authHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${WRITER_TOKEN}`,
  ...extra,
});

/**
 * The writer's mistake: a file that sniffs as a JPEG (correct SOI/APP0 magic)
 * and is not decodable — the truncated/damaged container of the finding. Real
 * bytes, over real multipart, exactly as the browser would send them.
 */
async function uploadTruncatedCover(baseUrl: string, articleId: string): Promise<number> {
  const form = new FormData();
  form.set('role', 'cover');
  const bytes = corruptedJpeg();
  form.set('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }), 'truncated.jpg');
  const res = await fetch(`${baseUrl}/v1/articles/${articleId}/images`, {
    method: 'POST',
    headers: authHeaders({ 'idempotency-key': `recovery-${articleId}` }),
    body: form,
  });
  return res.status;
}

const publish = (baseUrl: string, articleId: string) =>
  fetch(`${baseUrl}/v1/articles/${articleId}/publish`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({}),
  });

describe('recovering from a rejected cover upload (verify v4, M-V4-01)', () => {
  it('AC-08-recovery-01: a truncated file uploaded as a new cover leaves the article’s existing ready cover exactly where it was, and the live page still shows it — a file that was never good enough to publish is never good enough to displace the one that is', async () => {
    const { db, server, fx } = ctx();
    const { createSiteRenderer } = await loadSiteRender();
    const before = await db.client.query(
      `select optimized_url from article_images where id = $1`,
      [fx.live_cover_id],
    );
    const coverUrl: string = before.rows[0]?.optimized_url;

    await uploadTruncatedCover(server.url, fx.live_article);

    const after = await db.client.query(`select role, status from article_images where id = $1`, [
      fx.live_cover_id,
    ]);
    const renderer = await createSiteRenderer({
      databaseUrl: db.connectionUri,
      siteOrigin: SITE_ORIGIN,
      cdnOrigin: CDN_ORIGIN,
    });
    let html = '';
    try {
      html = (
        await renderer.renderArticlePage({
          league_slug: 'ligue-1',
          season_slug: '26-27',
          type_slug: 'pronos',
          slug: fx.live_slug,
        })
      ).html;
    } finally {
      await renderer.close().catch(() => undefined);
    }

    expect({
      live_cover_role: after.rows[0]?.role,
      live_cover_status: after.rows[0]?.status,
      live_page_still_shows_that_cover: html.includes(coverUrl),
    }).toEqual({
      live_cover_role: 'cover',
      live_cover_status: 'ready',
      live_page_still_shows_that_cover: true,
    });
  });

  it('AC-08-recovery-02: after a truncated cover upload is rejected, the article still republishes — a file the product refused cannot leave behind a row that blocks publishing forever, since no writer can delete one', async () => {
    const { db, server, fx } = ctx();

    await uploadTruncatedCover(server.url, fx.republish_article);
    const res = await publish(server.url, fx.republish_article);
    const body = (await res.json()) as { error?: { code?: string } };

    const article = await db.client.query(`select status from articles where id = $1`, [
      fx.republish_article,
    ]);

    expect({
      publish_status: res.status,
      error_code: body.error?.code,
      article_status: article.rows[0]?.status,
    }).toEqual({ publish_status: 200, error_code: undefined, article_status: 'published' });
  });

  it('AC-08-recovery-03: an image the article is genuinely still using and that failed to convert does keep refusing the publish, 409 IMAGE_NOT_READY — AC-08’s real promise, which the fix above must not trade away by ignoring failed rows wholesale', async () => {
    const { db, server, fx } = ctx();

    const res = await publish(server.url, fx.failed_body_article);
    const body = (await res.json()) as { error?: { code?: string } };

    const article = await db.client.query(`select status from articles where id = $1`, [
      fx.failed_body_article,
    ]);

    expect({
      publish_status: res.status,
      error_code: body.error?.code,
      article_status: article.rows[0]?.status,
    }).toEqual({ publish_status: 409, error_code: 'IMAGE_NOT_READY', article_status: 'draft' });
  });
});
