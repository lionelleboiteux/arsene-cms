import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import {
  seedArticle,
  seedImage,
  seedWriter,
  startTestDatabase,
  type TestDatabase,
} from '../support/pg.js';
import { validJpeg } from '../support/imageFixtures.js';

/**
 * Two independent, deterministic, no-attacker-required collisions on the one
 * request the whole product exists to perform.
 *
 * ---------------------------------------------------------------------------
 * M-V5-04 (`05-verification.v5.md` §4) — one `Idempotency-Key`, two operations
 * ---------------------------------------------------------------------------
 *
 * `router.ts`'s store keys on `${key}::${article_id}`: no `writer_id`, and —
 * the part that makes this worse than v4's L-V4-01 — no *operation* either.
 * `publish` and `upload` share one map, so a client (or a retry helper) that
 * reuses one key across an editing session gets the other operation's cached
 * answer. Proven live by the verify pass:
 *
 *   POST /publish  Idempotency-Key: 1  -> 200, article published
 *   POST /images   Idempotency-Key: 1  -> HTTP 200, body is the PUBLISH response
 *                                         (canonical_url, structured_data…)
 *                                         no image row, the file discarded
 *
 *   reverse order, second article:
 *   POST /images   Idempotency-Key: 1  -> 201, image created
 *   POST /publish  Idempotency-Key: 1  -> HTTP 201, body is the UPLOAD response
 *                                         article afterwards: "draft"  <- never published
 *
 * The contract declares the key as an arbitrary opaque string, so no attack is
 * needed. Both directions are asserted because they are two different harms
 * from one defect — a silently discarded upload, and a "Publish" click that
 * answers 2xx while the article stays a draft — and only the second can be
 * proved from the world rather than from a response body.
 *
 * ---------------------------------------------------------------------------
 * M-V5-05 (`05-verification.v5.md` §5) — two articles, one title, permanent 500
 * ---------------------------------------------------------------------------
 *
 *   create + publish "Match Report"        -> 200
 *   create + publish a second "Match Report" -> 500 INTERNAL_ERROR, permanently
 *     (retrying does not help; only a human renaming the article recovers)
 *
 * `articles.slug` is `unique`. `publishArticle.ts` calls
 * `generateSlug(article.title)` with **no `existingSlugs` argument**, so the
 * dedup branch that `PROP-01`/`PROP-02` exercise directly on the pure function
 * is dead code at the only call site that matters, and the resulting Postgres
 * `23505` is unmapped — it falls through to the generic 500 handler.
 * Contradicts AC-14's "collision-free slug, with no writer action" directly,
 * and `createDraft`'s own default title (`Sans titre`) makes two untitled
 * drafts collide immediately.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **End-to-end is the fastest layer that can prove either one.** The
 *    idempotency store is a private closure inside `router.ts`
 *    (`createIdempotencyStore`), shared between the two handlers by the router
 *    and by nothing else — every handler-level test injects its own fake, so
 *    the collision is invisible below this layer. The slug collision is a real
 *    `unique` constraint in a real Postgres reached through a real UPDATE; a
 *    repository fake cannot have one.
 *
 * 2. **No mechanism is prescribed.** The verify report suggests keying on
 *    `${writer_id}::${operation}::${key}::${article_id}` and passing real
 *    existing slugs to `generateSlug` (or catching `23505` and retrying with a
 *    suffix). Nothing below asserts a key format, a slug format or a suffix
 *    scheme — only that the two operations stop answering for each other, and
 *    that the second publish gets a distinct, real slug and goes live.
 *
 * 3. **`NFR-IDEM-03c` is the both-sides control.** The cheapest way to pass the
 *    two tests above it is to stop replaying cached responses at all, which
 *    would delete the contract's idempotency guarantee (and `NFR-IDEM-01`/`02`
 *    would not notice: they run against the handlers' fake store). It asserts
 *    the genuine replay — same operation, same key, same article — still
 *    returns the original response and still creates nothing new. It passes
 *    today and must still pass afterwards.
 *
 * Legacy static-token auth, as tests/e2e/publishJourney.test.ts uses it and for
 * the same stated reason. Setup only: authorization is not what any assertion
 * in this file is about.
 */

const WRITER_TOKEN = 'red-gate-writer-token';

/** The single opaque key a client reuses across an editing session. */
const SHARED_KEY = 'a3f1c2d4-5e6b-4c7d-8e9f-0a1b2c3d4e5f';

/** M-V5-05: one title, two articles — the whole reproduction. */
const DUPLICATE_TITLE = 'Débrief de la 3e journée';

type Fixtures = {
  /** M-V5-04, publish-then-upload: a draft with a ready cover. */
  publish_then_upload: string;
  /** M-V5-04, upload-then-publish. */
  upload_then_publish: string;
  /** The control: a genuine same-operation replay. */
  replayed_upload: string;
  /** M-V5-05: two drafts that share one title, and therefore one slug. */
  duplicate_title_first: string;
  duplicate_title_second: string;
};

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  fx: Fixtures;
};

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

async function publishableDraft(
  db: TestDatabase,
  writer_id: string,
  title: string,
  type_name = 'Pronos',
): Promise<string> {
  const article_id = await seedArticle(db.client, {
    writer_id,
    title,
    league_name: 'Ligue 1',
    type_name,
  });
  await seedImage(db.client, { article_id, role: 'cover', status: 'ready' });
  return article_id;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Marie D.');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: WRITER_TOKEN,
      writerId,
      allowLegacyAuth: true,
    });
    started = {
      db,
      server,
      fx: {
        publish_then_upload: await publishableDraft(
          db,
          writerId,
          'Publier puis envoyer une image avec la même clé',
        ),
        upload_then_publish: await publishableDraft(
          db,
          writerId,
          'Envoyer une image puis publier avec la même clé',
        ),
        replayed_upload: await publishableDraft(db, writerId, 'Rejouer exactement le même envoi'),
        duplicate_title_first: await publishableDraft(db, writerId, DUPLICATE_TITLE, 'Mercato'),
        duplicate_title_second: await publishableDraft(db, writerId, DUPLICATE_TITLE, 'Analyses'),
      },
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

const authHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${WRITER_TOKEN}`,
  ...extra,
});

type Answer = { status: number; body: Record<string, unknown> };

async function publish(
  baseUrl: string,
  articleId: string,
  idempotencyKey?: string,
): Promise<Answer> {
  const res = await fetch(`${baseUrl}/v1/articles/${articleId}/publish`, {
    method: 'POST',
    headers: authHeaders({
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    }),
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function upload(
  baseUrl: string,
  articleId: string,
  o: { role: 'cover' | 'body'; filename: string; key: string },
): Promise<Answer> {
  const form = new FormData();
  form.set('role', o.role);
  // A real 4 MB JPEG travels over the wire: the harm in M-V5-04 is that this
  // file is silently discarded, so it has to genuinely be sent.
  const bytes = validJpeg();
  form.set('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }), o.filename);
  const res = await fetch(`${baseUrl}/v1/articles/${articleId}/images`, {
    method: 'POST',
    headers: authHeaders({ 'idempotency-key': o.key }),
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** How many image rows this exact file produced — 0 means it was discarded. */
async function rowsFor(db: TestDatabase, article_id: string, filename: string): Promise<number> {
  const res = await db.client.query<{ n: string }>(
    `select count(*)::text as n from article_images
      where article_id = $1 and original_filename = $2`,
    [article_id, filename],
  );
  return Number(res.rows[0]?.n ?? '-1');
}

/** ADR-0004's pipeline is asynchronous: the row settles after the response. */
async function waitForImage(db: TestDatabase, image_id: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.client.query<{ status: string }>(
      `select status from article_images where id = $1`,
      [image_id],
    );
    const status = res.rows[0]?.status;
    if (status === 'ready' || status === 'failed') return status;
    if (Date.now() > deadline) return `timed out while ${status ?? 'no row existed'}`;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function articleRow(db: TestDatabase, article_id: string) {
  const res = await db.client.query<{ status: string; slug: string | null }>(
    `select status, slug from articles where id = $1`,
    [article_id],
  );
  return { status: res.rows[0]?.status, slug: res.rows[0]?.slug ?? null };
}

describe('one idempotency key across two operations (verify v5, M-V5-04)', () => {
  it('NFR-IDEM-03a: an image upload that reuses the Idempotency-Key an earlier publish of the same article used is still performed, and is answered as an upload — a key a client reused across two operations must never make one of them answer for the other', async () => {
    const { db, server, fx } = ctx();
    const filename = 'couverture-apres-publication.jpg';

    const published = await publish(server.url, fx.publish_then_upload, SHARED_KEY);
    const uploaded = await upload(server.url, fx.publish_then_upload, {
      role: 'cover',
      filename,
      key: SHARED_KEY,
    });

    expect({
      publish_status: published.status,
      upload_status: uploaded.status,
      upload_answered_about_an_image: uploaded.body.role,
      image_rows_for_the_uploaded_file: await rowsFor(db, fx.publish_then_upload, filename),
    }).toEqual({
      publish_status: 200,
      upload_status: 201,
      upload_answered_about_an_image: 'cover',
      image_rows_for_the_uploaded_file: 1,
    });
  });

  it('NFR-IDEM-03b: a publish that reuses the Idempotency-Key an earlier image upload of the same article used really publishes the article — the writer must never be answered 2xx for the one action the product exists to perform while the article silently stays a draft', async () => {
    const { db, server, fx } = ctx();

    const uploaded = await upload(server.url, fx.upload_then_publish, {
      role: 'body',
      filename: 'illustration-avant-publication.jpg',
      key: SHARED_KEY,
    });
    // Publishing is refused while any image is still converting (AC-08), so the
    // pipeline is allowed to settle first: the only thing under test here is
    // the shared key.
    const image = await waitForImage(db, String(uploaded.body.id));
    const published = await publish(server.url, fx.upload_then_publish, SHARED_KEY);
    const article = await articleRow(db, fx.upload_then_publish);

    expect({
      upload_status: uploaded.status,
      uploaded_image: image,
      publish_status: published.status,
      article_status: article.status,
    }).toEqual({
      upload_status: 201,
      uploaded_image: 'ready',
      publish_status: 200,
      article_status: 'published',
    });
  });

  it('NFR-IDEM-03c: replaying the very same upload — same operation, same key, same article — still returns the original response and still creates nothing new, so scoping the key cannot be done by dropping replay altogether', async () => {
    const { db, server, fx } = ctx();
    const filename = 'illustration-rejouee.jpg';
    const key = 'c0ffee00-1111-4222-8333-444444444444';

    const first = await upload(server.url, fx.replayed_upload, { role: 'body', filename, key });
    const replay = await upload(server.url, fx.replayed_upload, { role: 'body', filename, key });

    expect({
      first_status: first.status,
      replay_status: replay.status,
      replay_returned_the_same_image: replay.body.id === first.body.id,
      image_rows_for_the_uploaded_file: await rowsFor(db, fx.replayed_upload, filename),
    }).toEqual({
      first_status: 201,
      replay_status: 201,
      replay_returned_the_same_image: true,
      image_rows_for_the_uploaded_file: 1,
    });
  });
});

describe('two articles with the same title (verify v5, M-V5-05)', () => {
  it('AC-14-collision-01: publishing a second article whose title matches an already-published one succeeds and gets its own distinct slug — AC-14 promises a collision-free slug with no writer action, so an ordinary duplicate title cannot be a permanent 500', async () => {
    const { db, server, fx } = ctx();

    const first = await publish(server.url, fx.duplicate_title_first);
    const second = await publish(server.url, fx.duplicate_title_second);

    const first_row = await articleRow(db, fx.duplicate_title_first);
    const second_row = await articleRow(db, fx.duplicate_title_second);

    expect({
      first_publish_status: first.status,
      second_publish_status: second.status,
      second_article_got_its_own_real_slug:
        typeof second_row.slug === 'string' &&
        second_row.slug.length > 0 &&
        second_row.slug !== first_row.slug,
      second_article_status: second_row.status,
    }).toEqual({
      first_publish_status: 200,
      second_publish_status: 200,
      second_article_got_its_own_real_slug: true,
      second_article_status: 'published',
    });
  });
});
