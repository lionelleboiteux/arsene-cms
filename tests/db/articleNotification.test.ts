import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { seedArticle, seedImage, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { createRepo } from '../../src/api/repo.js';

/**
 * `claimArticleNotification` / `releaseArticleNotification` — the
 * compare-and-set that makes the home page's "Notification" button send at
 * most one push per article. Real Postgres: the whole guarantee lives in the
 * `where notified_at is null` of a single UPDATE, which a fake can't prove.
 */

let db: TestDatabase;
let pool: pg.Pool;
let writer: string;

beforeAll(async () => {
  db = await startTestDatabase();
  pool = new pg.Pool({ connectionString: db.connectionUri });
  writer = await seedWriter(db.client, 'Notifier Writer');
}, 120_000);

afterAll(async () => {
  await pool.end();
  await db.stop();
});

async function published(title: string, slug: string, teaser: string | null = 'Un résumé.') {
  return seedArticle(db.client, {
    writer_id: writer,
    title,
    league_name: 'Ligue 1',
    type_name: 'Player Picks',
    status: 'published',
    slug,
    teaser,
    published_at: '2026-10-09T09:00:00Z',
  });
}

describe('claimArticleNotification', () => {
  it('NOTIFY-DB-01: claims a published article once and returns title, teaser, slug and the og cover', async () => {
    const id = await published('Claim me', 'claim-me');
    await seedImage(db.client, {
      article_id: id,
      role: 'cover',
      optimized_url: 'https://cdn.example/opt.webp',
      og_image_url: 'https://cdn.example/og.jpg',
    });
    const repo = createRepo(pool);

    const first = await repo.claimArticleNotification(id);
    const second = await repo.claimArticleNotification(id);

    expect(first).toEqual({
      result: 'claimed',
      article: { title: 'Claim me', teaser: 'Un résumé.', slug: 'claim-me', image_url: 'https://cdn.example/og.jpg' },
    });
    expect(second).toEqual({ result: 'already_notified' });
  });

  it('NOTIFY-DB-02: two simultaneous presses produce exactly one claim', async () => {
    const id = await published('Race', 'race');
    const repo = createRepo(pool);

    const results = await Promise.all(Array.from({ length: 8 }, () => repo.claimArticleNotification(id)));

    expect(results.filter((r) => r.result === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'already_notified')).toHaveLength(7);
  });

  it('NOTIFY-DB-03: falls back to optimized_url when the og crop is not built, and to null with no ready cover', async () => {
    const withOptimized = await published('No og', 'no-og');
    await seedImage(db.client, { article_id: withOptimized, role: 'cover', optimized_url: 'https://cdn.example/opt.webp' });
    const noCover = await published('No cover', 'no-cover', null);
    await seedImage(db.client, { article_id: noCover, role: 'cover', status: 'processing' });
    const repo = createRepo(pool);

    const a = await repo.claimArticleNotification(withOptimized);
    const b = await repo.claimArticleNotification(noCover);

    expect(a).toMatchObject({ result: 'claimed', article: { image_url: 'https://cdn.example/opt.webp' } });
    expect(b).toMatchObject({ result: 'claimed', article: { teaser: null, image_url: null } });
  });

  it('NOTIFY-DB-04: a draft is not_published, an unknown or malformed id is not_found, and neither is marked', async () => {
    const draft = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Draft',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
    });
    const repo = createRepo(pool);

    expect(await repo.claimArticleNotification(draft)).toEqual({ result: 'not_published' });
    expect(await repo.claimArticleNotification('00000000-0000-4000-8000-000000000000')).toEqual({ result: 'not_found' });
    expect(await repo.claimArticleNotification('not-a-uuid')).toEqual({ result: 'not_found' });
    const row = await pool.query(`select notified_at from articles where id = $1`, [draft]);
    expect(row.rows[0].notified_at).toBeNull();
  });
});

describe('releaseArticleNotification', () => {
  it('NOTIFY-DB-05: clears the claim so the article can be announced again', async () => {
    const id = await published('Retry', 'retry');
    const repo = createRepo(pool);
    await repo.claimArticleNotification(id);

    await repo.releaseArticleNotification(id);

    expect((await repo.claimArticleNotification(id)).result).toBe('claimed');
  });
});

describe('column privileges', () => {
  it('NOTIFY-DB-06: a writer (authenticated) cannot reset notified_at through PostgREST to re-send', async () => {
    const id = await published('Locked', 'locked');
    await createRepo(pool).claimArticleNotification(id);

    await db.client.query('set role authenticated');
    try {
      await expect(db.client.query(`update articles set notified_at = null where id = $1`, [id])).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await db.client.query('reset role');
    }
  });
});
