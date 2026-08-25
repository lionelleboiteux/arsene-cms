import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, bearer, mintSupabaseJwt } from '../support/jwt.js';

/**
 * VERIFY-04 — `05-verification.v1.md` §4: there is currently **no way to create
 * a draft article at all** in the running system. `handleCreateDraft` /
 * `handleOpenDraft` are unit-tested against a fake repo, `createRepo()`
 * implements neither of the methods they call, and no route reaches them —
 * `POST /v1/articles`, `/v1/drafts` and `/v1/articles/draft` all 404. AC-05's
 * lock enforcement consequently has no reachable path either: the DB-level CAS
 * in `tests/db/schema.test.ts` proves the SQL, and nothing proves a writer
 * hitting it through a request.
 *
 * These tests close that. The routes asserted here are the ones this pass
 * chose, and they are the assertion, not an implementation detail:
 *
 *   POST /v1/articles            create a draft (emits `draft_started`)
 *   POST /v1/articles/{id}/open  reopen an existing draft, i.e. take its lock
 *
 * Reopening gets its own route rather than folding into create: it is a
 * different operation with a different outcome (409 `DRAFT_LOCKED` is
 * meaningful for one and impossible for the other), and `handleOpenDraft`
 * already exists as a separate handler.
 *
 * Auth is a real Supabase-shaped JWT, minted and signed by the test — which is
 * also what makes the `writer_id` assertions meaningful (verify finding #3:
 * today every request is attributed to one process-wide constant).
 */

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  writerA: string;
  writerB: string;
  tokenA: string;
  tokenB: string;
};

let started: Ctx | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startHttpServer } = await loadApiRouter();
    db = await startTestDatabase();
    const writerA = await seedWriter(db.client, 'Marie D.');
    const writerB = await seedWriter(db.client, 'Lionel Le Boiteux');
    const server = await startHttpServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      // Kept only so the option shape stays compatible; the static token is
      // exactly what verify finding #3 says must stop being the credential.
      writerToken: 'unused-static-token',
      writerId: writerA,
      jwksJson: TEST_JWKS_JSON,
      imageCallbackSecret: 'lambda-callback-shared-secret-not-the-writer-token',
    });
    started = {
      db,
      server,
      writerA,
      writerB,
      tokenA: await mintSupabaseJwt({ sub: writerA }),
      tokenB: await mintSupabaseJwt({ sub: writerB }),
    };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

const createDraft = (baseUrl: string, token: string, body: Record<string, unknown> = {}) =>
  fetch(`${baseUrl}/v1/articles`, {
    method: 'POST',
    headers: { authorization: bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const openDraft = (baseUrl: string, token: string, articleId: string) =>
  fetch(`${baseUrl}/v1/articles/${articleId}/open`, {
    method: 'POST',
    headers: { authorization: bearer(token), 'content-type': 'application/json' },
    body: '{}',
  });

describe('draft creation over its real route (verify finding #4)', () => {
  it('AC-01 / TELEMETRY-draft_started: POST /v1/articles creates the draft and emits draft_started from the same server call, so the metric’s numerator no longer depends on the publish-time backfill', async () => {
    const { db, server, tokenA, writerA } = ctx();

    const res = await createDraft(server.url, tokenA, { title: 'Pronos Ligue 1 - Journée 17' });
    const body = (await res.json()) as { article_id?: string };

    const article = await db.client.query(
      `select writer_id, title, status from articles where id = $1`,
      [body.article_id],
    );
    const events = await db.client.query(
      `select event_type, writer_id from arsene_telemetry_events
        where article_id = $1 and event_type = 'draft_started'`,
      [body.article_id],
    );

    expect({
      status: res.status,
      returned_an_article_id: typeof body.article_id === 'string' && body.article_id.length > 0,
      article: article.rows[0],
      draft_started_rows: events.rowCount,
      attributed_to: events.rows[0]?.writer_id,
    }).toEqual({
      status: 201,
      returned_an_article_id: true,
      article: { writer_id: writerA, title: 'Pronos Ligue 1 - Journée 17', status: 'draft' },
      draft_started_rows: 1,
      attributed_to: writerA,
    });
  });

  it('AC-05: a second writer opening a draft whose lock is still current is refused 409 DRAFT_LOCKED and told who is holding it — over HTTP, not only in SQL', async () => {
    const { server, tokenA, tokenB } = ctx();

    const created = (await createDraft(server.url, tokenA, { title: 'Verrou partagé' }).then((r) =>
      r.json(),
    )) as { article_id?: string };
    const res = await openDraft(server.url, tokenB, String(created.article_id));
    const body = (await res.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };

    expect({
      status: res.status,
      code: body.error?.code,
      names_the_holder: body.error?.details?.locked_by_display_name,
    }).toEqual({ status: 409, code: 'DRAFT_LOCKED', names_the_holder: 'Marie D.' });
  });

  it('NFR-AUDIT-01: two drafts created with two differently signed tokens are attributed to two different writers, because writer_id comes from each token’s sub claim and not from one process-wide constant', async () => {
    const { db, server, tokenA, tokenB, writerA, writerB } = ctx();

    const first = (await createDraft(server.url, tokenA, { title: 'Brouillon de Marie' }).then((r) =>
      r.json(),
    )) as { article_id?: string };
    const second = (await createDraft(server.url, tokenB, { title: 'Brouillon de Lionel' }).then(
      (r) => r.json(),
    )) as { article_id?: string };

    const rows = await db.client.query(
      `select a.title, a.writer_id as article_writer, e.writer_id as event_writer
         from articles a
         join arsene_telemetry_events e
           on e.article_id = a.id and e.event_type = 'draft_started'
        where a.id::text = any($1::text[])
        order by a.title`,
      [[String(first.article_id), String(second.article_id)]],
    );

    expect(rows.rows).toEqual([
      { title: 'Brouillon de Lionel', article_writer: writerB, event_writer: writerB },
      { title: 'Brouillon de Marie', article_writer: writerA, event_writer: writerA },
    ]);
  });

  it('VERIFY-03-REGRESSION: the legacy static writer token is refused once a JWT secret is configured, so it cannot act as a permanent bypass of real per-writer auth', async () => {
    const { server } = ctx();

    // This server was started with BOTH jwksJson (see beforeAll) and the
    // legacy writerToken option 'unused-static-token' — kept only so the
    // option shape stays compatible with deployments that have no JWT secret
    // at all. Presenting that static credential here must fail exactly like
    // any other invalid bearer token: verify finding #3 is not actually fixed
    // if a hardcoded shared secret still authenticates in parallel with real
    // per-writer JWT verification.
    const res = await createDraft(server.url, 'unused-static-token', { title: 'Devrait échouer' });

    expect(res.status).toBe(401);
  });
});
