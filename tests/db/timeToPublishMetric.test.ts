import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { insertTelemetry, seedArticle, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { createRepo } from '../../src/api/repo.js';

/**
 * The read side of Pam's one success metric (`state.json`'s
 * `success.metrics[0]`, "time from draft start to published") — John's
 * dashboard gate (`pdlc/arsene-cms/11-dashboard.v1.md`). Against real
 * Postgres, not a fake repo: the whole point of this query is the join and
 * the arithmetic, neither of which a mock would exercise honestly.
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

describe('time-to-publish metric samples', () => {
  it('DASHBOARD-01: computes minutes between draft_started and article_published per article, across writers, and never surfaces a draft with no publish yet', async () => {
    const writerA = await seedWriter(db.client, 'Dashboard Writer A');
    const writerB = await seedWriter(db.client, 'Dashboard Writer B');
    const articleA = await seedArticle(db.client, {
      writer_id: writerA,
      title: 'Article A',
      league_name: 'Ligue 1',
      type_name: 'Match Preview',
    });
    const articleB = await seedArticle(db.client, {
      writer_id: writerB,
      title: 'Article B',
      league_name: 'Ligue 1',
      type_name: 'Match Preview',
    });
    const unpublished = await seedArticle(db.client, {
      writer_id: writerA,
      title: 'Still drafting',
      league_name: 'Ligue 1',
      type_name: 'Match Preview',
    });

    const startA = new Date('2026-01-01T10:00:00Z');
    const publishA = new Date('2026-01-01T10:08:00Z'); // 8 minutes
    const startB = new Date('2026-01-02T09:00:00Z');
    const publishB = new Date('2026-01-02T09:15:00Z'); // 15 minutes

    await insertTelemetry(db.client, {
      event_type: 'draft_started',
      writer_id: writerA,
      article_id: articleA,
      occurred_at: startA.toISOString(),
    });
    await insertTelemetry(db.client, {
      event_type: 'article_published',
      writer_id: writerA,
      article_id: articleA,
      occurred_at: publishA.toISOString(),
    });
    await insertTelemetry(db.client, {
      event_type: 'draft_started',
      writer_id: writerB,
      article_id: articleB,
      occurred_at: startB.toISOString(),
    });
    await insertTelemetry(db.client, {
      event_type: 'article_published',
      writer_id: writerB,
      article_id: articleB,
      occurred_at: publishB.toISOString(),
    });
    // Still drafting: only draft_started, no publish — must not appear below.
    // Dated 2026-01-03 (not "now") so this fixture doesn't also count as a
    // recently-active writer in DASHBOARD-04's counter-metric test below.
    await insertTelemetry(db.client, {
      event_type: 'draft_started',
      writer_id: writerA,
      article_id: unpublished,
      occurred_at: '2026-01-03T00:00:00.000Z',
    });

    const samples = await createRepo(pool).getTimeToPublishSamples();

    expect(samples).toHaveLength(2);
    expect(samples.map((s) => Math.round(s.minutes)).sort((a, b) => a - b)).toEqual([8, 15]);
    // Never a writer_id or article_id — the dashboard aggregates client-side
    // from timing alone, nothing that identifies who published what.
    for (const sample of samples) {
      expect(Object.keys(sample).sort()).toEqual(['minutes', 'published_at']);
    }
  });

  it('DASHBOARD-04: the counter-metric counts distinct writers, never lists them, and ignores drafts started outside the window', async () => {
    const writerRecent = await seedWriter(db.client, 'Recent Writer');
    const writerStale = await seedWriter(db.client, 'Stale Writer');
    const articleRecent = await seedArticle(db.client, {
      writer_id: writerRecent,
      title: 'Recent draft',
      league_name: 'Ligue 1',
      type_name: 'Match Preview',
    });
    const articleStale = await seedArticle(db.client, {
      writer_id: writerStale,
      title: 'Old draft',
      league_name: 'Ligue 1',
      type_name: 'Match Preview',
    });

    await insertTelemetry(db.client, {
      event_type: 'draft_started',
      writer_id: writerRecent,
      article_id: articleRecent,
      occurred_at: new Date().toISOString(),
    });
    await insertTelemetry(db.client, {
      event_type: 'draft_started',
      writer_id: writerStale,
      article_id: articleStale,
      occurred_at: '2000-01-01T00:00:00.000Z', // decades outside any real window
    });

    // DASHBOARD-01's fixtures are all dated 2026-01-01/02 — outside any real
    // 30-day window from whenever this suite actually runs — so writerRecent
    // is the only one this count can include.
    const count = await createRepo(pool).getActiveWriterCount(30);
    expect(count).toBe(1);
  });
});
