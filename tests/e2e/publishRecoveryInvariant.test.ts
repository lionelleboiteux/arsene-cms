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
import { corruptedJpeg, undecodableJpeg, validJpeg } from '../support/imageFixtures.js';

/**
 * `05-verification.v7.md` §10, recommendation 1 — **the invariant, not another
 * enumeration**:
 *
 *   "Pair the red gate with an invariant test in the pattern that finally
 *    worked for H-V6-01 — *any article state reachable through product routes
 *    alone must have some sequence of product routes that returns it to
 *    publishable* — rather than enumerating specific recovery scenarios, since
 *    specific-scenario enumeration is exactly what's been incomplete three
 *    times running in this fix family."
 *
 * That history, briefly, because it is the whole argument for this file's
 * shape. Three consecutive passes fixed a *reported state* rather than the
 * property, and each time the next verify pass found another state of the same
 * kind:
 *
 *   M-V4-01  a rejected cover blocks republication forever
 *            -> fixed for the cover slot            -> M-V5-01 found the body slot
 *   M-V5-01/02/03 fixed by keying on adoption + supersession
 *            -> M-V6-02 found a way to choose which row counts as superseded
 *   M-V6-02  fixed by revoking the `role` grant (migration 0004)
 *            -> v7 §4 found that this removed the only recovery there was,
 *               by two independent routes
 *
 * So this test does not ask "can the writer recover from *this* state". It
 * sweeps several genuinely different ways an article can end up unpublishable,
 * applies **one generic recovery procedure** to each — the same procedure, not
 * a bespoke one per state — and asserts a single thing about all of them: the
 * article ends up published, carrying a real cover image. A state nobody has
 * reported is covered by construction, which is the point.
 *
 * ---------------------------------------------------------------------------
 * THE RECOVERY PROCEDURE, IDENTICAL FOR EVERY STATE
 * ---------------------------------------------------------------------------
 *
 *   1. discard every image row the article cannot currently be published with
 *      (`status <> 'ready'`), through the product route for it;
 *   2. if no usable cover is left, upload one good cover through the ordinary
 *      upload route;
 *   3. publish.
 *
 * Only step 1 does not exist today. Steps 2 and 3 are ordinary product routes,
 * and the image ids in step 1 are *read* from the database and never written
 * there — every state-changing action in this file is an HTTP request to the
 * real server.
 *
 * ---------------------------------------------------------------------------
 * THE STATES, AND WHY THESE FOUR
 * ---------------------------------------------------------------------------
 *
 * Two of the four already recover today, and they are in the sweep on purpose —
 * they are the both-sides half, exactly as `NFR-COVER-INVARIANT-01`'s fourth
 * combination was. A "fix" that satisfies this test by refusing more publishes,
 * or by discarding rows the article genuinely needs, breaks them:
 *
 *   rejected-cover-only          synchronously refused upload, never adopted,
 *                                `original_url: null`     — recovers today
 *   adopted-cover-failed         real conversion failure in the cover slot; a
 *                                fresh cover upload supersedes it
 *                                                          — recovers today
 *   adopted-body-failed          §4.1 exactly: the row is adopted, failed, in
 *                                no slot a later demote will ever touch
 *                                                          — STUCK today
 *   adopted-body-and-cover-both-failed
 *                                both slots broken at once — a state nobody
 *                                reported, produced by varying the *other*
 *                                rows, since `articleDependsOn(image, images)`
 *                                takes the whole list and what else is present
 *                                is exactly what decides the outcome
 *                                                          — STUCK today
 *
 * Every broken row here is created by a real multipart upload through the real
 * route and settled by the real ADR-0004 conversion — `undecodableJpeg()` is
 * adopted by the product (complete container, original really stored) and can
 * only fail in `sharp`; `corruptedJpeg()` is refused inside the request. No row
 * in any state is seeded, except the genuinely-converted cover the third state
 * needs in order to be about its body image and nothing else.
 *
 * Publish and upload are each rate-limited to 10 per minute per client IP
 * (`rateLimit.ts`), and every request here arrives from the same loopback
 * address: this file spends **8 publishes and 8 uploads**, which is why the
 * concurrency route (§4.2) lives in tests/e2e/imageRecoveryRoutes.test.ts with
 * its own server and its own budget rather than as a fifth state here.
 *
 * Legacy static-token auth, exactly as the sibling e2e files use it and for the
 * same stated reason. Setup only.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
/** The converted cover the `adopted-body-failed` state keeps throughout. */
const INTACT_COVER_URL = 'https://cdn.example/balayage/couverture-intacte.webp';

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  writerId: string;
};

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
 * Step 1 of the recovery procedure, asked for by outcome rather than by shape.
 * `05-verification.v7.md` §4.3 recommends `DELETE
 * /v1/articles/{id}/images/{imageId}` restricted server-side to `status <>
 * 'ready'`; that shape is tried first, with two materially-equivalent
 * alternatives behind it, so a green pass choosing either of those satisfies
 * this test unedited. `404`/`405` from all three means no such capability
 * exists — which is the state this pass is red against.
 */
async function discardImage(baseUrl: string, articleId: string, imageId: string): Promise<number> {
  const shapes: Array<[string, string]> = [
    ['DELETE', `/v1/articles/${articleId}/images/${imageId}`],
    ['POST', `/v1/articles/${articleId}/images/${imageId}/discard`],
    ['DELETE', `/v1/articles/${articleId}/images?image_id=${imageId}`],
  ];
  let first = 0;
  for (const [method, path] of shapes) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: authHeaders({ 'idempotency-key': `discard-${imageId}` }),
    });
    await res.text();
    if (first === 0) first = res.status;
    if (res.status !== 404 && res.status !== 405) return res.status;
  }
  return first;
}

type PublishOutcome = { status: number; code: string | undefined; cover_image: string | undefined };

async function publish(baseUrl: string, articleId: string): Promise<PublishOutcome> {
  const res = await fetch(`${baseUrl}/v1/articles/${articleId}/publish`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({}),
  });
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
         from article_images where article_id = $1`,
      [article_id],
    )
  ).rows;

/** The article still has a cover row it could actually be published with. */
const hasUsableCover = (rows: ImageRow[]): boolean =>
  rows.some(
    (row) =>
      row.role === 'cover' &&
      row.status === 'ready' &&
      row.original_url !== null &&
      !rows.some((other) => other.replaced_cover_image_id === row.id),
  );

/** One upload description, as the writer would perform it. */
type Step = { role: 'cover' | 'body'; file: 'refused-in-the-request' | 'adopted-then-fails' };

type StuckState = {
  id: string;
  title: string;
  /** A genuinely converted cover the state starts with, when it needs one. */
  seeded_cover: string | null;
  steps: Step[];
};

const STUCK_STATES: StuckState[] = [
  {
    id: 'rejected-cover-only',
    title: 'Balayage — la seule couverture est un fichier refusé',
    seeded_cover: null,
    steps: [{ role: 'cover', file: 'refused-in-the-request' }],
  },
  {
    id: 'adopted-cover-failed',
    title: 'Balayage — la couverture a été adoptée puis sa conversion a échoué',
    seeded_cover: null,
    steps: [{ role: 'cover', file: 'adopted-then-fails' }],
  },
  {
    id: 'adopted-body-failed',
    title: 'Balayage — une image de corps adoptée dont la conversion a échoué',
    seeded_cover: INTACT_COVER_URL,
    steps: [{ role: 'body', file: 'adopted-then-fails' }],
  },
  {
    id: 'adopted-body-and-cover-both-failed',
    title: 'Balayage — la couverture et une image de corps ont toutes deux échoué',
    seeded_cover: null,
    steps: [
      { role: 'cover', file: 'adopted-then-fails' },
      { role: 'body', file: 'adopted-then-fails' },
    ],
  },
];

describe('every reachable article state has a way back to publishable (verify v7, §4)', () => {
  it('NFR-RECOVERY-INVARIANT-01: any article state reachable through product routes alone has some sequence of product routes that returns it to publishable — the property itself, swept over four genuinely different ways an article ends up unpublishable, rather than a fourth consecutive fix aimed at the one state that happened to get reported', async () => {
    const { db, server, writerId } = ctx();

    const results = [];

    for (const state of STUCK_STATES) {
      // --- reach the state, through product routes only ---------------------
      const article_id = await seedArticle(db.client, {
        writer_id: writerId,
        title: state.title,
        league_name: 'Premier League',
        type_name: 'Pronos',
      });
      if (state.seeded_cover !== null) {
        await seedImage(db.client, {
          article_id,
          role: 'cover',
          status: 'ready',
          optimized_url: state.seeded_cover,
        });
      }
      for (const [index, step] of state.steps.entries()) {
        const uploaded = await upload(server.url, article_id, {
          role: step.role,
          filename: `${state.id}-${index}.jpg`,
          bytes: step.file === 'adopted-then-fails' ? undecodableJpeg() : corruptedJpeg(),
          key: `sweep-${state.id}-${index}`,
        });
        if (uploaded.body.status === 'processing') await waitForImage(db, String(uploaded.body.id));
      }

      const before = await publish(server.url, article_id);

      // --- the one recovery procedure, identical for every state -------------
      for (const row of (await imageRows(db, article_id)).filter((r) => r.status !== 'ready')) {
        await discardImage(server.url, article_id, row.id);
      }
      if (!hasUsableCover(await imageRows(db, article_id))) {
        const replacement = await upload(server.url, article_id, {
          role: 'cover',
          filename: `${state.id}-couverture-de-remplacement.jpg`,
          bytes: validJpeg(),
          key: `sweep-${state.id}-replacement`,
        });
        await waitForImage(db, String(replacement.body.id));
      }

      const after = await publish(server.url, article_id);

      results.push({
        state: state.id,
        publish_before_recovery: `${before.status} ${before.code ?? ''}`.trim(),
        publish_after_recovery: after.status,
        cover_image_after_recovery: after.cover_image ?? '',
      });
    }

    /**
     * One statement about all four: a state the product itself can be driven
     * into is never terminal. A refusal after the recovery procedure is a
     * violation; so is publishing with no cover image, because "recovered" that
     * publishes a blank page is not recovered (H-V6-01). The precondition guard
     * is in the same list so that a state that was never actually unpublishable
     * is reported as such rather than passing silently.
     */
    const violations = results.flatMap((r) => {
      if (r.publish_before_recovery.startsWith('200')) {
        return [{ ...r, violates: 'the state was already publishable, so it proves nothing' }];
      }
      if (r.publish_after_recovery !== 200) {
        return [{ ...r, violates: 'no sequence of product routes returned it to publishable' }];
      }
      if (r.cover_image_after_recovery === '') {
        return [{ ...r, violates: 'it published again with no cover image' }];
      }
      return [];
    });

    expect(violations).toEqual([]);
  });
});
