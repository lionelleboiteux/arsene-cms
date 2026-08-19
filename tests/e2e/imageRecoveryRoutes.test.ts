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
import { undecodableJpeg, validJpeg } from '../support/imageFixtures.js';

/**
 * `05-verification.v7.md` §4 — **an article can become permanently
 * unpublishable, with no recovery, through two independent routes**. Two verify
 * agents found them independently, by genuinely different mechanisms, and both
 * terminate in the identical state: an article that will never publish again,
 * recoverable only by a human running SQL directly against production.
 *
 * ---------------------------------------------------------------------------
 * ROUTE A (§4.1, security auditor) — an ordinary conversion failure
 * ---------------------------------------------------------------------------
 *
 * An image is *adopted* — uploaded, accepted, its original really stored, so
 * `original_url` is set — and its Lambda conversion later fails. A CMYK JPEG, a
 * corrupt interior, a timeout, an OOM. `articleDependsOn()` correctly goes on
 * treating that row as in use (it was adopted and nothing ever superseded it),
 * so it blocks publish forever. The verify pass tried all eight recovery
 * actions a writer could take, live, against a real migrated database:
 *
 *   [state] adopted body image, conversion failed
 *     publish                                            -> 409 IMAGE_NOT_READY
 *     1. remove the reference from body_html   -> succeeds, changes nothing (409)
 *     2. upload a good replacement body image  -> new row; old row untouched (409)
 *     3. delete the broken row directly                     -> REFUSED 42501
 *     4. re-tag it role='cover' (the pre-0004 recovery)     -> REFUSED 42501
 *     5. clear original_url directly                        -> REFUSED 42501
 *     6. mark it ready directly                             -> REFUSED 42501
 *     7. re-drive the Lambda callback          -> false (row settled, CAS refuses)
 *     8. upload a fresh good cover -> demote finds the COVER row, not this one (409)
 *
 * Recovery action 4 *was* the exploit `05-verification.v6.md` §3 described.
 * Migration `0004` closed the abuse and the only recovery procedure with the
 * same line, because they were one mechanism seen from two directions.
 *
 * ---------------------------------------------------------------------------
 * ROUTE B (§4.2, e2e agent) — a race, with no external failure at all
 * ---------------------------------------------------------------------------
 *
 * `uploadImage.ts`'s sequence — `demoteCurrentCover()` -> `storage.put()`
 * (network I/O) -> `insertImage()` — is not one transaction. Concurrent cover
 * uploads each demote (matching nothing, since the first has already vacated
 * the slot) and each insert a fresh `role='cover'` row:
 *
 *   8/8 trials, two concurrent cover uploads   -> TWO role='cover' rows
 *   4 concurrent cover uploads, separate trial -> FOUR role='cover' rows
 *   (and, on one article, SIX simultaneous ready cover rows — §6, L-V7-01)
 *
 * A later demote then turns every one of them into a `body` row while recording
 * only *one* id as superseded (`update … returning id`, `res.rows[0]`). Any of
 * the unrecorded ones that is not `ready` is now adopted, unsuperseded and
 * permanently blocking — §4.1's terminal state, reached with no attacker, no
 * external failure and no direct database access. Two browser tabs, a flaky
 * retry or a double-click is sufficient.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ASSERT, AND WHAT THEY DELIBERATELY DO NOT
 * ---------------------------------------------------------------------------
 *
 * 1. **The outcome, never the route shape.** §4.3's recommended fix is a narrow
 *    writer-facing capability: `DELETE /v1/articles/{id}/images/{imageId}`,
 *    restricted server-side to rows that are `status <> 'ready'` — which cannot
 *    be abused, since a not-ready row is by definition not something the
 *    article can currently be published with. `discardImage()` below tries that
 *    shape first, because the verify report names it, but falls through to two
 *    materially-equivalent alternatives, and every assertion in this file is
 *    about the article ending up publishable with a real cover — never about a
 *    verb, a path or a status code the capability returns.
 *
 * 2. **Nothing is seeded into the state under test.** Route A's broken row is a
 *    real multipart upload of `undecodableJpeg()` through the real route: the
 *    product itself decides to adopt it (complete container, so
 *    `isDamagedContainer()` passes and the original is really stored) and the
 *    real ADR-0004 conversion — real `sharp`, off the request path — is what
 *    then reports it `failed` through the real compare-and-swap. Route B's
 *    duplicate rows come from real concurrent HTTP requests, as the verify
 *    report reproduced them, not from `insert into article_images`.
 *
 * 3. **`AC-08-recovery-11` is the both-sides control**, and it is the reason
 *    this capability cannot be the next finding. A discard route that is too
 *    permissive would reopen AC-08 in a new shape: a writer would delete their
 *    way around `IMAGE_NOT_READY` by discarding an inconvenient-but-genuinely-
 *    needed image. It passes today — vacuously, since there is nothing to abuse
 *    yet — and its job is to still pass afterwards. Stated as an outcome (the
 *    depended-on rows survive and the article still publishes with its real
 *    cover), so it fails loudly against a route that removes them.
 *
 * Publish and upload are rate-limited to 10 per minute per client IP each
 * (`rateLimit.ts`, separate keys), and every request here arrives from the same
 * loopback address, so this file spends at most **9 uploads and 5 publishes**
 * and reads every precondition from the database rather than from an extra
 * request. Route B's construction is the expensive one and is budgeted for a
 * single retry.
 *
 * Legacy static-token auth, exactly as tests/e2e/rejectedImageRecovery.test.ts
 * and tests/e2e/coverImageInvariant.test.ts use it and for the same stated
 * reason. Setup only: authorization is not what any assertion here is about.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
/** The cover the Route A article really has, and must still publish with. */
const ROUTE_A_COVER_URL = 'https://cdn.example/route-a/couverture-valide.webp';
/** The live cover the abuse control's article depends on. */
const DEPENDED_ON_COVER_URL = 'https://cdn.example/controle/couverture-en-service.webp';
/** The body image that article genuinely embeds in its own body_html. */
const DEPENDED_ON_BODY_URL = 'https://cdn.example/controle/illustration-en-service.webp';

type Fixtures = {
  /** §4.1: a draft with a real, ready cover, about to receive a broken body image. */
  route_a_article: string;
  /** §4.2: a fresh draft with no images at all, for the concurrent burst. */
  route_b_article: string;
  /** The control: an article both of whose images it genuinely depends on. */
  depended_on_article: string;
  depended_on_cover: string;
  depended_on_body: string;
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

async function seedFixtures(db: TestDatabase, writer_id: string): Promise<Fixtures> {
  const route_a_article = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon dont une image de corps adoptée échoue définitivement',
    league_name: 'Ligue 1',
    type_name: 'Pronos',
  });
  // A genuinely converted cover: the article has everything it needs to publish
  // except the broken row the test is about to create through the real route.
  await seedImage(db.client, {
    article_id: route_a_article,
    role: 'cover',
    status: 'ready',
    optimized_url: ROUTE_A_COVER_URL,
  });

  const route_b_article = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon recevant plusieurs envois de couverture simultanés',
    league_name: 'Bundesliga',
    type_name: 'Mercato',
  });

  const depended_on_article = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon dont les deux images sont réellement utilisées',
    league_name: 'Serie A',
    type_name: 'Pronos',
  });
  const depended_on_cover = await seedImage(db.client, {
    article_id: depended_on_article,
    role: 'cover',
    status: 'ready',
    optimized_url: DEPENDED_ON_COVER_URL,
  });
  const depended_on_body = await seedImage(db.client, {
    article_id: depended_on_article,
    role: 'body',
    status: 'ready',
    optimized_url: DEPENDED_ON_BODY_URL,
  });
  // The body image is genuinely embedded — this is the row AC-08 exists for.
  await db.client.query(`update articles set body_html = $2 where id = $1`, [
    depended_on_article,
    `<h2>Les affiches</h2><p>Analyse match par match.</p>` +
      `<figure><img src="${DEPENDED_ON_BODY_URL}" data-image-id="${depended_on_body}"></figure>`,
  ]);

  return {
    route_a_article,
    route_b_article,
    depended_on_article,
    depended_on_cover,
    depended_on_body,
  };
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

/** A real multipart upload of real bytes, through the real route. */
async function upload(
  baseUrl: string,
  articleId: string,
  o: { role: 'cover' | 'body'; filename: string; bytes: Uint8Array; key: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.set('role', o.role);
  form.set('file', new Blob([o.bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }), o.filename);
  const res = await fetch(`${baseUrl}/v1/articles/${articleId}/images`, {
    method: 'POST',
    headers: authHeaders({ 'idempotency-key': o.key }),
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * The writer-facing capability `05-verification.v7.md` §4.3 recommends, asked
 * for by outcome rather than by shape.
 *
 * The report's own recommendation — `DELETE /v1/articles/{id}/images/{imageId}`,
 * server-side restricted to `status <> 'ready'` — is tried first because it is
 * a strong enough recommendation to be the primary shape. The two alternatives
 * are materially equivalent ways of expressing the same capability, so a green
 * pass that chooses one of them satisfies these tests without editing them.
 *
 * A `404`/`405` from every shape means the capability does not exist at all,
 * which is the state this pass is red against; `route: 'none'` records that.
 * Every other answer is the capability responding, and it is the *article's*
 * subsequent state, never this status code, that the assertions read.
 */
async function discardImage(
  baseUrl: string,
  articleId: string,
  imageId: string,
): Promise<{ status: number; route: string }> {
  const shapes: Array<{ route: string; method: string; path: string }> = [
    {
      route: 'DELETE /v1/articles/{id}/images/{imageId}',
      method: 'DELETE',
      path: `/v1/articles/${articleId}/images/${imageId}`,
    },
    {
      route: 'POST /v1/articles/{id}/images/{imageId}/discard',
      method: 'POST',
      path: `/v1/articles/${articleId}/images/${imageId}/discard`,
    },
    {
      route: 'DELETE /v1/articles/{id}/images?image_id=',
      method: 'DELETE',
      path: `/v1/articles/${articleId}/images?image_id=${imageId}`,
    },
  ];

  let first = 0;
  for (const shape of shapes) {
    const res = await fetch(`${baseUrl}${shape.path}`, {
      method: shape.method,
      headers: authHeaders({ 'idempotency-key': `discard-${imageId}` }),
    });
    // Drain the body so the socket is released between shapes.
    await res.text();
    if (first === 0) first = res.status;
    if (res.status !== 404 && res.status !== 405) {
      return { status: res.status, route: shape.route };
    }
  }
  return { status: first, route: 'none' };
}

const publish = (baseUrl: string, articleId: string) =>
  fetch(`${baseUrl}/v1/articles/${articleId}/publish`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({}),
  });

type PublishOutcome = {
  status: number;
  code: string | undefined;
  /** `structured_data.image[0]` — what the public page's og:image becomes. */
  cover_image: string | undefined;
};

async function publishOutcome(baseUrl: string, articleId: string): Promise<PublishOutcome> {
  const res = await publish(baseUrl, articleId);
  const body = (await res.json()) as {
    error?: { code?: string };
    structured_data?: { image?: unknown };
  };
  const image = Array.isArray(body.structured_data?.image)
    ? body.structured_data?.image[0]
    : body.structured_data?.image;
  return {
    status: res.status,
    code: body.error?.code,
    cover_image: typeof image === 'string' ? image : undefined,
  };
}

/** One line that reads the same whichever refusal the product chooses. */
const outcomeOf = (o: PublishOutcome): string =>
  o.status === 200 ? '200' : `${o.status} ${o.code ?? ''}`.trim();

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

type ImageRow = {
  id: string;
  role: 'cover' | 'body';
  status: string;
  original_url: string | null;
  replaced_cover_image_id: string | null;
};

const imageRows = async (db: TestDatabase, article_id: string): Promise<ImageRow[]> =>
  (
    await db.client.query<ImageRow>(
      `select id, role, status, original_url, replaced_cover_image_id
         from article_images where article_id = $1 order by created_at`,
      [article_id],
    )
  ).rows;

/** Whether the article still has a cover row it could actually be published with. */
const hasUsableCover = (rows: ImageRow[]): boolean =>
  rows.some(
    (row) =>
      row.role === 'cover' &&
      row.status === 'ready' &&
      row.original_url !== null &&
      !rows.some((other) => other.replaced_cover_image_id === row.id),
  );

const articleStatus = async (db: TestDatabase, article_id: string): Promise<string | undefined> =>
  (await db.client.query<{ status: string }>(`select status from articles where id = $1`, [article_id]))
    .rows[0]?.status;

describe('a permanently unpublishable article always has a way back (verify v7, §4)', () => {
  it('AC-08-recovery-09: an adopted image whose conversion failed permanently can be discarded by the writer, and the article then publishes again carrying its real remaining cover — closing an image the product itself accepted and could not convert is the one recovery migration 0004 removed, and without it an ordinary codec failure ends the article forever', async () => {
    const { db, server, fx } = ctx();

    // The real route adopts this file — complete container, original really
    // stored — and the real ADR-0004 conversion then fails it. Nothing seeded.
    const broken = await upload(server.url, fx.route_a_article, {
      role: 'body',
      filename: 'illustration-indecodable.jpg',
      bytes: undecodableJpeg(),
      key: `route-a-body-${fx.route_a_article}`,
    });
    const broken_id = String(broken.body.id);
    const settled = await waitForImage(db, broken_id);
    const adopted = (await imageRows(db, fx.route_a_article)).find((r) => r.id === broken_id);

    const before = await publishOutcome(server.url, fx.route_a_article);

    // The whole finding, in one call: is there any product route at all that
    // clears a row the article can never be published with?
    const discarded = await discardImage(server.url, fx.route_a_article, broken_id);

    const after = await publishOutcome(server.url, fx.route_a_article);

    expect({
      the_broken_row_was_adopted: adopted !== undefined && adopted.original_url !== null,
      the_broken_row_settled_at: settled,
      publish_before_the_discard: outcomeOf(before),
      the_discard_was_answered_by: discarded.route === 'none' ? 'no route at all' : 'a product route',
      publish_after_the_discard: outcomeOf(after),
      cover_image_after: after.cover_image,
      article_status: await articleStatus(db, fx.route_a_article),
    }).toEqual({
      the_broken_row_was_adopted: true,
      the_broken_row_settled_at: 'failed',
      publish_before_the_discard: '409 IMAGE_NOT_READY',
      the_discard_was_answered_by: 'a product route',
      publish_after_the_discard: '200',
      cover_image_after: ROUTE_A_COVER_URL,
      article_status: 'published',
    });
  });

  it('AC-08-recovery-10: after concurrent cover uploads to the same article, the writer can still resolve the article down to one usable cover and publish it — a double-click, a second browser tab or a retried request must not be able to end an article permanently, and today the demote that tidies up records only one of the rows it displaced as superseded', async () => {
    const { db, server, fx } = ctx();

    /**
     * The verify report's own reproduction: real concurrent HTTP requests, not
     * seeded rows. Every file is adopted (complete container) and every one
     * will fail conversion, so whatever the interleaving leaves behind is a set
     * of adopted, not-ready, cover-shaped rows — §4.2's state.
     *
     * How many rows result is an *observation*, not an assertion: the report's
     * own recommended fix for L-V7-01 (a partial unique index on the cover
     * slot) would legitimately reduce this to one, and this test must pass
     * under that fix too. What is asserted is only that the writer can get back
     * to a publishable article afterwards.
     */
    const burst = async (size: number, tag: string): Promise<string[]> => {
      const results = await Promise.all(
        Array.from({ length: size }, (_, i) =>
          upload(server.url, fx.route_b_article, {
            role: 'cover',
            filename: `couverture-simultanee-${tag}-${i}.jpg`,
            bytes: undecodableJpeg(),
            key: `route-b-${tag}-${i}-${fx.route_b_article}`,
          }),
        ),
      );
      return results.map((r) => String(r.body.id));
    };

    const uploaded = await burst(4, 'a');
    const coverRowsAfter = async () =>
      (await imageRows(db, fx.route_b_article)).filter((r) => r.role === 'cover').length;
    // One retry, budgeted: the race is reported at 8/8 trials, but a burst that
    // happened to serialise completely would prove nothing about §4.2.
    if ((await coverRowsAfter()) < 2) uploaded.push(...(await burst(3, 'b')));

    for (const id of uploaded) await waitForImage(db, id);
    const after_the_burst = await imageRows(db, fx.route_b_article);

    const before = await publishOutcome(server.url, fx.route_b_article);

    // The recovery a writer must have: close every row the article cannot be
    // published with, then give it a cover that really converts. Both steps are
    // product routes; the ids are only *read* from the database.
    for (const row of after_the_burst.filter((r) => r.status !== 'ready')) {
      await discardImage(server.url, fx.route_b_article, row.id);
    }
    const replacement = await upload(server.url, fx.route_b_article, {
      role: 'cover',
      filename: 'couverture-de-remplacement.jpg',
      bytes: validJpeg(),
      key: `route-b-replacement-${fx.route_b_article}`,
    });
    const replacement_status = await waitForImage(db, String(replacement.body.id));

    const after = await publishOutcome(server.url, fx.route_b_article);

    expect({
      cover_shaped_rows_left_by_the_burst: after_the_burst.filter((r) => r.role === 'cover').length > 0,
      every_uploaded_row_settled: after_the_burst.every((r) => r.status === 'failed'),
      publish_before_the_recovery: outcomeOf(before),
      replacement_cover: replacement_status,
      publish_after_the_recovery: outcomeOf(after),
      cover_image_after_is_real: (after.cover_image ?? '') !== '',
      article_status: await articleStatus(db, fx.route_b_article),
    }).toEqual({
      cover_shaped_rows_left_by_the_burst: true,
      every_uploaded_row_settled: true,
      publish_before_the_recovery: '409 IMAGE_NOT_READY',
      replacement_cover: 'ready',
      publish_after_the_recovery: '200',
      cover_image_after_is_real: true,
      article_status: 'published',
    });
  });

  it('AC-08-recovery-11: the recovery capability cannot be used to discard an image the article genuinely depends on — neither its live ready cover nor a ready body image embedded in its own body_html is removable, so a writer cannot delete their way around IMAGE_NOT_READY by closing an inconvenient-but-needed image, which would reopen AC-08 in a new shape', async () => {
    const { db, server, fx } = ctx();

    const cover_attempt = await discardImage(server.url, fx.depended_on_article, fx.depended_on_cover);
    const body_attempt = await discardImage(server.url, fx.depended_on_article, fx.depended_on_body);

    const rows = await imageRows(db, fx.depended_on_article);
    const result = await publishOutcome(server.url, fx.depended_on_article);

    /** Anything that is not a success is a refusal; which refusal is not pinned. */
    const refused = (o: { status: number }): string =>
      [200, 201, 202, 204].includes(o.status) ? 'accepted' : 'refused';

    expect({
      discarding_the_live_cover: refused(cover_attempt),
      discarding_the_embedded_body_image: refused(body_attempt),
      the_cover_row_survived: rows.some((r) => r.id === fx.depended_on_cover),
      the_body_row_survived: rows.some((r) => r.id === fx.depended_on_body),
      the_article_still_has_a_usable_cover: hasUsableCover(rows),
      publish: outcomeOf(result),
      cover_image: result.cover_image,
    }).toEqual({
      discarding_the_live_cover: 'refused',
      discarding_the_embedded_body_image: 'refused',
      the_cover_row_survived: true,
      the_body_row_survived: true,
      the_article_still_has_a_usable_cover: true,
      publish: '200',
      cover_image: DEPENDED_ON_COVER_URL,
    });
  });
});
