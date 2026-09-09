import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSiteRender } from '../support/seams.js';
import { seedArticle, seedAvatar, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * The byline's own avatar markup (src/site/render.ts's `authorAvatarHtml`) —
 * split out from `tests/db/publicSiteRender.test.ts`'s "co-authored bylines"
 * block, which only asserts *whose names appear, in what order* and strips
 * this markup out entirely. This file asserts the markup itself: a writer
 * with a `ready` `writer_avatars` (0010) row gets an `<img>` pointing at its
 * `optimized_url`, and a writer with none gets the initial-letter
 * placeholder, never a broken `<img src="">`.
 */

const SITE_ORIGIN = 'https://fantasycoach.example';
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';

type Renderer = Awaited<ReturnType<Awaited<ReturnType<typeof loadSiteRender>>['createSiteRenderer']>>;

type Ctx = { db: TestDatabase; renderer: Renderer };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { createSiteRenderer } = await loadSiteRender();
    db = await startTestDatabase();

    const renderer = await createSiteRenderer({
      databaseUrl: db.connectionUri,
      siteOrigin: SITE_ORIGIN,
      cdnOrigin: CDN_ORIGIN,
    });
    started = { db, renderer };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.renderer.close().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

describe('writer avatars in the public byline (0010)', () => {
  it('a writer with a ready avatar gets an <img> in the byline pointing at its optimized_url', async () => {
    const { db, renderer } = ctx();
    const writer = await seedWriter(db.client, 'Avatar Ready');
    const avatarUrl = 'https://cdn.fantasycoach.example/writer-avatars/avatar-ready.webp';
    await seedAvatar(db.client, { writer_id: writer, status: 'ready', optimized_url: avatarUrl });
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Article avec avatar',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'article-avec-avatar',
      published_at: '2026-08-14T09:00:00Z',
    });

    const page = await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'article-avec-avatar',
    });

    expect(page.html).toContain(`<img class="author-avatar" src="${avatarUrl}" alt=""/>`);
  });

  it('a writer with no avatar row at all gets the initial-letter placeholder, never a broken <img>', async () => {
    const { db, renderer } = ctx();
    const writer = await seedWriter(db.client, 'Sans Avatar');
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Article sans avatar',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'article-sans-avatar',
      published_at: '2026-08-15T09:00:00Z',
    });

    const page = await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'article-sans-avatar',
    });

    expect({
      has_placeholder: page.html.includes('<span class="author-avatar author-avatar-placeholder">S</span>'),
      has_img_tag: page.html.includes('<img class="author-avatar"'),
    }).toEqual({ has_placeholder: true, has_img_tag: false });
  });

  it('a writer whose only avatar row is still processing is treated the same as having none — no half-uploaded image is ever shown', async () => {
    const { db, renderer } = ctx();
    const writer = await seedWriter(db.client, 'Photo En Cours');
    await seedAvatar(db.client, { writer_id: writer, status: 'processing' });
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Article avatar en cours',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'article-avatar-en-cours',
      published_at: '2026-08-16T09:00:00Z',
    });

    const page = await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'article-avatar-en-cours',
    });

    expect(page.html).not.toContain('<img class="author-avatar"');
  });
});
