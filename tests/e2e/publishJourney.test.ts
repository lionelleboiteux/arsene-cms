import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedArticle, seedImage, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { validJpeg } from '../support/imageFixtures.js';

/**
 * The only end-to-end journeys in this suite. Everything else is proved at the
 * lowest layer that can prove it; these three exist because their failure in
 * production would be embarrassing and, worse, invisible:
 *
 *   E2E-01  draft -> real image upload -> publish, with the time-to-publish
 *           metric actually computable from what was written.
 *   E2E-02  a publish refused for a missing cover writes NO article_published
 *           row — the denominator of the metric stays honest.
 *   E2E-03  republishing an already-live article updates it immediately, with
 *           no approval step, and is recorded as a republish.
 *
 * All three run against the real Edge Function over HTTP and a real Postgres.
 */

const WRITER_TOKEN = 'red-gate-writer-token';

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> }; writerId: string };

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
    const writerId = await seedWriter(db.client, 'Lionel Le Boiteux');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: WRITER_TOKEN,
      writerId,
      // This file is the pre-JWT end-to-end suite `router.ts`'s `verify()`
      // comment sanctions, so it runs on the static token by design. From the
      // third remediation pass that has to be *stated* rather than inferred
      // from a missing secret — see tests/e2e/failClosedConfig.test.ts
      // (NFR-FAILCLOSED-01). Setup only: no assertion in this file changes.
      allowLegacyAuth: true,
    });
    started = { db, server, writerId };
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

const publish = (baseUrl: string, articleId: string, body: unknown = {}) =>
  fetch(`${baseUrl}/v1/articles/${articleId}/publish`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });

async function uploadCover(baseUrl: string, articleId: string): Promise<Response> {
  const form = new FormData();
  form.set('role', 'cover');
  // A real 4 MB JPEG travels over the wire here, not a placeholder string.
  const bytes = validJpeg();
  form.set(
    'file',
    new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }),
    'psg-om-cover.jpg',
  );
  return fetch(`${baseUrl}/v1/articles/${articleId}/images`, {
    method: 'POST',
    headers: authHeaders({ 'idempotency-key': `e2e-${articleId}` }),
    body: form,
  });
}

/** The contract says `processing` is the common case; a journey test must wait for it. */
async function waitForImageReady(db: TestDatabase, articleId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.client.query(
      `select status from article_images where article_id = $1 and role = 'cover'`,
      [articleId],
    );
    const status = res.rows[0]?.status;
    if (status === 'ready' || status === 'failed') return status;
    if (Date.now() > deadline) return `timed out while ${status ?? 'no row existed'}`;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe('end-to-end publishing journey', () => {
  it('E2E-01: a draft with a real uploaded cover publishes, goes live with a slug, and leaves both telemetry rows needed to compute time-to-publish', async () => {
    const { db, server, writerId } = ctx();
    const articleId = await seedArticle(db.client, {
      writer_id: writerId,
      title: 'Pronos Ligue 1 - Journée 12',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const upload = await uploadCover(server.url, articleId);
    const imageStatus = await waitForImageReady(db, articleId);
    const published = await publish(server.url, articleId);

    const article = await db.client.query(
      `select status, slug from articles where id = $1`,
      [articleId],
    );
    const metric = await db.client.query(
      `select extract(epoch from (p.occurred_at - d.occurred_at)) >= 0 as computable
         from telemetry_events d
         join telemetry_events p on p.article_id = d.article_id
        where d.article_id = $1 and d.event_type = 'draft_started'
          and p.event_type = 'article_published'`,
      [articleId],
    );

    expect({
      upload_status: upload.status,
      image_status: imageStatus,
      publish_status: published.status,
      article_status: article.rows[0]?.status,
      slug: article.rows[0]?.slug,
      time_to_publish_computable: metric.rows[0]?.computable ?? false,
    }).toEqual({
      upload_status: 201,
      image_status: 'ready',
      publish_status: 200,
      article_status: 'published',
      slug: 'pronos-ligue-1-journee-12',
      time_to_publish_computable: true,
    });
  });

  it('E2E-02: a publish refused for a missing cover image leaves the article unpublished and writes no article_published row at all', async () => {
    const { db, server, writerId } = ctx();
    const articleId = await seedArticle(db.client, {
      writer_id: writerId,
      title: 'Pronos Ligue 1 - Journée 13',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const res = await publish(server.url, articleId);
    const body = (await res.json()) as { error?: { code?: string } };

    const article = await db.client.query(`select status from articles where id = $1`, [articleId]);
    const events = await db.client.query(
      `select event_type from telemetry_events where article_id = $1 and event_type = 'article_published'`,
      [articleId],
    );

    expect({
      status: res.status,
      code: body.error?.code,
      article_status: article.rows[0]?.status,
      article_published_rows: events.rowCount,
    }).toEqual({
      status: 400,
      code: 'COVER_IMAGE_REQUIRED',
      article_status: 'draft',
      article_published_rows: 0,
    });
  });

  it('E2E-03: republishing an article that went live 3 days ago updates the live content immediately, with no approval step, and is recorded as a republish', async () => {
    const { db, server, writerId } = ctx();
    const articleId = await seedArticle(db.client, {
      writer_id: writerId,
      title: 'Mercato Bundesliga - Août',
      league_name: 'Bundesliga',
      type_name: 'Mercato',
      status: 'published',
      slug: 'mercato-bundesliga-aout',
      published_at: '2026-08-08T09:03:00Z',
      first_published_at: '2026-08-08T09:03:00Z',
    });
    await seedImage(db.client, { article_id: articleId, role: 'cover', status: 'ready' });

    // The writer edits the text (a direct PostgREST write) and republishes.
    await db.client.query(
      `update articles set body_html = $2, updated_at = now() where id = $1`,
      [articleId, '<h2>Mise à jour</h2><p>Le transfert est officiel depuis ce matin.</p>'],
    );
    const res = await publish(server.url, articleId);
    const body = (await res.json()) as { is_republish?: boolean; published_at?: string };

    const article = await db.client.query(
      `select status, body_html, first_published_at from articles where id = $1`,
      [articleId],
    );
    const events = await db.client.query(
      `select payload->>'is_republish' as is_republish from telemetry_events
        where article_id = $1 and event_type = 'article_published'`,
      [articleId],
    );

    expect({
      status: res.status,
      is_republish: body.is_republish,
      live_body_updated: String(article.rows[0]?.body_html).includes('officiel depuis ce matin'),
      still_published: article.rows[0]?.status,
      first_published_at: new Date(article.rows[0]?.first_published_at).toISOString(),
      telemetry_is_republish: events.rows.map((r) => r.is_republish),
    }).toEqual({
      status: 200,
      is_republish: true,
      live_body_updated: true,
      still_published: 'published',
      first_published_at: '2026-08-08T09:03:00.000Z',
      telemetry_is_republish: ['true'],
    });
  });
});
