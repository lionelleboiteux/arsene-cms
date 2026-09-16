import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { insertArticleView, seedArticle, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { createRepo } from '../../src/api/repo.js';

/**
 * The read side of the article-view counter (0012_article_views.sql) —
 * `getArticleViewCounts`'s own aggregate/join/ordering logic. Against real
 * Postgres, not a fake repo, same reasoning as `timeToPublishMetric.test.ts`:
 * the whole point of this query is the join and the count, neither of which
 * a mock would exercise honestly. The write side (`renderArticlePage`
 * actually inserting a row on a real page view) is covered in
 * `tests/db/publicSiteRender.test.ts`, against the renderer directly.
 */

let db: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  db = await startTestDatabase();
  pool = new pg.Pool({ connectionString: db.connectionUri });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await db.stop();
});

describe('article view counts', () => {
  it('counts views per article and orders by view count descending', async () => {
    const writer = await seedWriter(db.client, 'Views Writer');
    const popular = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Popular Article',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'popular-article-views-test',
    });
    const lessPopular = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Less Popular Article',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'less-popular-article-views-test',
    });

    for (let i = 0; i < 3; i += 1) await insertArticleView(db.client, { article_id: popular });
    await insertArticleView(db.client, { article_id: lessPopular });

    const counts = await createRepo(pool).getArticleViewCounts(50);

    expect(counts).toContainEqual({
      article_id: popular,
      title: 'Popular Article',
      slug: 'popular-article-views-test',
      views: 3,
    });
    expect(counts).toContainEqual({
      article_id: lessPopular,
      title: 'Less Popular Article',
      slug: 'less-popular-article-views-test',
      views: 1,
    });
    const popularIndex = counts.findIndex((c) => c.article_id === popular);
    const lessPopularIndex = counts.findIndex((c) => c.article_id === lessPopular);
    expect(popularIndex).toBeLessThan(lessPopularIndex);
  });

  it('an article with zero views is simply absent, not a zero-count row', async () => {
    const writer = await seedWriter(db.client, 'Zero Views Writer');
    const neverViewed = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Never Viewed Article',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'never-viewed-article-views-test',
    });

    const counts = await createRepo(pool).getArticleViewCounts(50);

    expect(counts.some((c) => c.article_id === neverViewed)).toBe(false);
  });

  it('respects the limit, keeping the highest view counts', async () => {
    const writer = await seedWriter(db.client, 'Limit Test Writer');
    const high = await seedArticle(db.client, {
      writer_id: writer,
      title: 'High Views Limit Test',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'high-views-limit-test',
    });
    const low = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Low Views Limit Test',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'low-views-limit-test',
    });
    for (let i = 0; i < 5; i += 1) await insertArticleView(db.client, { article_id: high });
    await insertArticleView(db.client, { article_id: low });

    const counts = await createRepo(pool).getArticleViewCounts(1);

    expect(counts).toHaveLength(1);
    expect(counts[0]?.article_id).toBe(high);
  });
});

describe('all article view counts', () => {
  it('counts views per article, no title/slug/limit, an article with zero views simply absent', async () => {
    const writer = await seedWriter(db.client, 'All Views Writer');
    const viewed = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Viewed Article',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'viewed-article-all-views-test',
    });
    const neverViewed = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Never Viewed Article All Views',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'never-viewed-article-all-views-test',
    });

    for (let i = 0; i < 2; i += 1) await insertArticleView(db.client, { article_id: viewed });

    const counts = await createRepo(pool).getAllArticleViewCounts();

    expect(counts).toContainEqual({ article_id: viewed, views: 2 });
    expect(counts.some((c) => c.article_id === neverViewed)).toBe(false);
  });
});
