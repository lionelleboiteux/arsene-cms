import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSiteRender } from '../support/seams.js';
import {
  seedArticle,
  seedImage,
  seedWriter,
  startTestDatabase,
  type TestDatabase,
} from '../support/pg.js';

/**
 * M-V7-02 (`05-verification.v7.md` §5, security auditor) — **a live article's
 * public cover image goes blank during an ordinary cover replacement**:
 * transiently while the replacement converts, and permanently if that
 * replacement's conversion fails.
 *
 * `render.ts` was deliberately left untouched by green v7
 * (`04-green-evidence.v7.md` §6.3), so it still resolves the cover with a live
 * query:
 *
 *     (select i.optimized_url from article_images i
 *       where i.article_id = a.id and i.role = 'cover' and i.status = 'ready'
 *       limit 1) as cover_image_url
 *
 * while `uploadImage.ts` vacates the cover slot *before* the replacement has
 * converted (`demoteCurrentCover()` runs ahead of the pipeline, by design —
 * ADR-0004 decides the outcome asynchronously). Between those two facts the
 * live query returns nothing for a page that is already published and already
 * correct. The trace the verify pass recorded:
 *
 *   T0  live article, healthy ready cover
 *       -> og:image and homepage <img> both correct
 *   T1  a VALID replacement cover is uploaded (demote already happened,
 *       conversion in flight)
 *       -> og:image content="", homepage <img> ABSENT, json_ld image: [""]
 *       -> the persisted structured_data.image is still correct, and now
 *          disagrees with the live page
 *   T2  the replacement's conversion FAILS (terminal)
 *       -> the blank state is now PERMANENT; publish itself correctly refuses
 *          409 IMAGE_NOT_READY from here on, but the page was already blanked
 *          before the writer got that signal
 *
 * This is H-V6-01's exact public symptom (`empty og:image`, `image: [""]`, no
 * `<img>` on the homepage card, AC-06 silently defeated) reached through a code
 * path `usableCover()` does not govern — which is why closing H-V6-01 in
 * `publishArticle.ts` did not close this.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST ASSERTS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * One thing: **at no point does the article's public page lose the cover image
 * it was published with.** T0 is in the same swept list as T1 and T2 and must
 * not be flagged — it is the both-sides half, so "render nothing at all" and
 * "render some placeholder" are not ways through.
 *
 * Nothing prescribes the mechanism. §5's recommended fix is to fall back to the
 * article's persisted `structured_data.image` when the live "ready cover" query
 * returns nothing; a persisted `cover_image_id` column (which L-V6-02 and
 * L-V7-01 both ultimately want) satisfies this test just as well, and so does
 * not vacating the slot until the replacement is ready. No assertion below
 * names a column, a query or a fallback.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATABASE LAYER, AND WHY THESE ROWS ARE FAITHFUL
 * ---------------------------------------------------------------------------
 *
 * The established seam for the render pass is `tests/db/publicSiteRender.test.ts`:
 * real Postgres with the production migrations, the real `createSiteRenderer`,
 * no browser and no deploy (02-architecture.v1.md §1). The replacement is
 * therefore applied as the two statements the product itself issues, quoted
 * from `src/api/repo.ts`:
 *
 *   demoteCurrentCover()  update article_images set role = 'body'
 *                          where article_id = $1 and role = 'cover' returning id
 *   insertImage()         a new role='cover' row, status='processing',
 *                         original_url set (the original really is stored
 *                         first), optimized_url null, and
 *                         replaced_cover_image_id = the demoted row's id
 *   setImageStatus()      update … set status='failed' … where id = $1
 *                          and status = 'processing'
 *
 * — so this is the state the upload route writes, not a state invented to make
 * a point. Driving it over HTTP instead would add nothing to the assertion and
 * would make T1 (a window that closes as soon as `sharp` returns) a race.
 * `structured_data` is written in `buildStructuredData()`'s own shape
 * (`image: [cover_image_url]`), exactly as `tests/e2e/coverImageInvariant.test.ts`
 * already seeds it for its live-article fixture.
 */

const SITE_ORIGIN = 'https://fantasycoach.example';
const SLUG = 'pronos-ligue-1-journee-14';
/** The cover this article was published with, and is serving to visitors. */
const PUBLISHED_COVER_URL = 'https://cdn.fantasycoach.example/live/couverture-publiee.webp';
const PUBLISHED_AT = '2026-08-10T09:00:00Z';

type Renderer = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadSiteRender>>['createSiteRenderer']>
>;

type Ctx = { db: TestDatabase; renderer: Renderer; article: string; cover: string };

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

    const writer = await seedWriter(db.client, 'Lionel Le Boiteux');
    const article = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Pronos Ligue 1 - Journée 14',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: SLUG,
      published_at: PUBLISHED_AT,
      first_published_at: PUBLISHED_AT,
    });
    const cover = await seedImage(db.client, {
      article_id: article,
      role: 'cover',
      status: 'ready',
      optimized_url: PUBLISHED_COVER_URL,
    });
    // What the last successful publish baked into the row — `markPublished`
    // persists exactly `buildStructuredData()`'s output, whose `image` is
    // `[cover_image_url]`.
    await db.client.query(`update articles set structured_data = $2::jsonb where id = $1`, [
      article,
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: 'Pronos Ligue 1 - Journée 14',
        image: [PUBLISHED_COVER_URL],
        datePublished: PUBLISHED_AT,
        dateModified: PUBLISHED_AT,
        author: { '@type': 'Person', name: 'Lionel Le Boiteux' },
        mainEntityOfPage: `${SITE_ORIGIN}/articles/ligue-1/26-27/pronos/${SLUG}`,
      }),
    ]);

    const renderer = await createSiteRenderer({
      databaseUrl: db.connectionUri,
      siteOrigin: SITE_ORIGIN,
    });
    started = { db, renderer, article, cover };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.renderer.close().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

/** Everything §5 names as the public symptom, read off the real render pass. */
async function coverAsPublicallyServed(c: Ctx) {
  const page = await c.renderer.renderArticlePage({
    league_slug: 'ligue-1',
    season_slug: '26-27',
    type_slug: 'pronos',
    slug: SLUG,
  });
  const home = await c.renderer.renderHomepage();
  const jsonLdImage = page.json_ld[0]?.image;
  return {
    og_image: page.html.match(/property="og:image"\s+content="([^"]*)"/)?.[1] ?? null,
    json_ld_image: Array.isArray(jsonLdImage) ? (jsonLdImage[0] ?? null) : null,
    homepage_card_img: home.html.match(/<img src="([^"]*)"/)?.[1] ?? null,
  };
}

describe('a live article keeps the cover it was published with (verify v7, §5)', () => {
  it('NFR-COVER-FALLBACK-01: while a live article’s cover replacement is still converting, and after that replacement has failed for good, its public page still serves the cover the article was actually published with — a replacement that has not converted yet is not a reason to blank a page that is already correct, and a replacement that never will is not a reason to blank it forever', async () => {
    const c = ctx();
    const stages: Array<{ stage: string; shown: Awaited<ReturnType<typeof coverAsPublicallyServed>> }> = [];

    // T0 — the article as visitors see it right now: healthy, ready cover.
    stages.push({ stage: 'T0 before any replacement', shown: await coverAsPublicallyServed(c) });

    // T1 — an ordinary replacement upload has been accepted. `uploadImage.ts`
    // has already vacated the cover slot and the pipeline has not answered yet.
    const demoted = await c.db.client.query<{ id: string }>(
      `update article_images set role = 'body'
        where article_id = $1 and role = 'cover' returning id`,
      [c.article],
    );
    const replacement = await c.db.client.query<{ id: string }>(
      `insert into article_images
         (article_id, role, status, original_filename, alt_text,
          original_url, optimized_url, replaced_cover_image_id)
       values ($1, 'cover', 'processing', 'couverture-de-remplacement.jpg', null, $2, null, $3)
       returning id`,
      [
        c.article,
        `https://projectref.supabase.co/storage/v1/object/articles/${c.article}/couverture-de-remplacement.jpg`,
        demoted.rows[0]?.id ?? null,
      ],
    );
    stages.push({
      stage: 'T1 replacement accepted, still converting',
      shown: await coverAsPublicallyServed(c),
    });

    // T2 — ADR-0004's callback reports the replacement failed. Terminal.
    await c.db.client.query(
      `update article_images
          set status = 'failed', failure_code = 'CORRUPTED_FILE',
              failure_message = 'couverture-de-remplacement.jpg passed format detection but could not be decoded.'
        where id = $1 and status = 'processing'`,
      [replacement.rows[0]?.id],
    );
    stages.push({
      stage: 'T2 replacement failed, permanently',
      shown: await coverAsPublicallyServed(c),
    });

    /**
     * One statement about all three stages, T0 included so that "serve nothing
     * anywhere" is not a way through: the page a visitor gets still carries the
     * cover this article was published with, in the social preview, in the
     * schema.org block and on the homepage card (AC-06).
     */
    const violations = stages.flatMap(({ stage, shown }) =>
      shown.og_image === PUBLISHED_COVER_URL &&
      shown.json_ld_image === PUBLISHED_COVER_URL &&
      shown.homepage_card_img === PUBLISHED_COVER_URL
        ? []
        : [{ stage, ...shown, violates: 'the live page lost the cover it was published with' }],
    );

    expect(violations).toEqual([]);
  });
});
