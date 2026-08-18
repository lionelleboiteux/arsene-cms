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
import { corruptedJpeg } from '../support/imageFixtures.js';

/**
 * H-V6-01 / M-V6-01 (`05-verification.v6.md` §2) — an article whose only
 * cover-role row is a **rejected** upload publishes live with no cover image at
 * all. Two ordinary product calls, no attacker, no direct database access.
 *
 * ---------------------------------------------------------------------------
 * THE TRACE, AS BOTH VERIFY AGENTS PROVED IT LIVE (§2)
 * ---------------------------------------------------------------------------
 *
 *   POST /v1/articles                    -> 201
 *   POST .../publish   (no images yet)   -> 400 COVER_IMAGE_REQUIRED   correct
 *   POST .../images    (truncated cover) -> 201 {"status":"failed", CORRUPTED_FILE}
 *   POST .../publish                     -> 200                        WRONG
 *
 *   A/B on identical seed data across the two trees:
 *     v5 (b159caa)  publish 409 IMAGE_NOT_READY, article stays "draft"   PASS
 *     v6 (05badd6)  publish 200, article "published", image [""]         FAIL
 *
 * The public result, confirmed against the real render pass: `<meta
 * property="og:image" content="">`, schema.org `NewsArticle` with `image: [""]`,
 * a homepage card with no `<img>` element at all (AC-06, silently defeated), a
 * sitemap entry, and `article_published` telemetry firing as if it were a
 * normal success.
 *
 * Root cause, traced by both agents to the same line: `refusePublish()`'s
 * `COVER_IMAGE_REQUIRED` check asks `images.some(i => i.role === 'cover')` — a
 * rejected row trivially satisfies it — while the readiness gate's
 * `articleDependsOn()` correctly excludes that same row from blocking (it was
 * never adopted: `uploadImage.ts` writes `original_url: null` on every path
 * where it refuses the file). Until green v6 those two checks agreed by
 * construction; the rewrite that closed M-V5-03 dropped the "is there still a
 * *usable* cover" clause rather than replacing it, and `publishNow()` now falls
 * through to `cover_image_url: ... ?? ''` — a branch `04-green-evidence.v6.md`
 * §4.2 calls "unreachable... defensive typing, not a path".
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **The invariant, not the state.** `NFR-COVER-INVARIANT-01` sweeps four
 *    image-state combinations and asserts one thing about all of them: *a
 *    publish answered 200 always carries a non-empty cover image*. Both verify
 *    agents asked for exactly this in preference to enumerating specific
 *    states, because enumerating states is what let two different bugs through
 *    two different rewrites of this one function (M-V5-01/02/03, then
 *    H-V6-01). The sweep therefore contains combinations nobody has reported —
 *    a rejected cover next to a healthy body image, and two rejected uploads at
 *    once — for the same reason a property test carries generated input.
 *
 * 2. **Outcomes, never a mechanism.** Both agents proposed the same repair
 *    (`images.some(i => i.role === 'cover' && articleDependsOn(i, images))`, so
 *    both checks share one notion of "has a usable cover"). Nothing below
 *    asserts it. `AC-08-recovery-07` accepts **either** `400
 *    COVER_IMAGE_REQUIRED` **or** `409 IMAGE_NOT_READY` — the two refusals the
 *    contract already declares for this endpoint — and asserts only that the
 *    article did not go live. A fix that reconciles the cover check, a fix that
 *    widens the readiness gate, and a fix that does something else entirely are
 *    all equally admissible.
 *
 * 3. **Both sides, so "refuse everything" is not a fix.**
 *    `NFR-COVER-INVARIANT-02` is the control: an article with a genuinely
 *    `ready` cover still publishes 200 carrying that cover's real CDN URL. It
 *    passes today and must still pass afterwards. The sweep's fourth
 *    combination (a rejected cover uploaded *beside* a healthy one — v4's
 *    M-V4-01 shape) is the same guard inside the invariant itself.
 *
 * 4. **Real infrastructure, because the empty string is only observable
 *    there.** Real Postgres, a real spawned child-process server over real
 *    HTTP, real truncated JPEG bytes through the real multipart upload route.
 *    The unit-level publish tests feed the handler a hand-built image list, so
 *    they cannot express "the row the upload route actually wrote".
 *
 * Publish is rate-limited to 10 requests per minute per client IP
 * (`rateLimit.ts`), and every request in this file arrives from the same
 * loopback address, so this file deliberately spends **7** publishes total and
 * asserts preconditions from the database rather than from an extra publish.
 *
 * Legacy static-token auth, exactly as tests/e2e/rejectedImageRecovery.test.ts
 * and tests/e2e/coverReplacementRecovery.test.ts use it and for the same stated
 * reason. Setup only: authorization is not what any assertion here is about.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
/** Every fixture article that is already live went live at this instant. */
const SEEDED_PUBLISHED_AT = '2026-08-10T09:00:00.000Z';
/** The cover URL the already-live article's public page is serving today. */
const LIVE_COVER_URL = 'https://cdn.example/live-article/couverture-en-ligne.webp';
/** The cover URL the control article's `ready` row really carries. */
const CONTROL_COVER_URL = 'https://cdn.example/controle/couverture-valide.webp';

type Fixtures = {
  /** §2 step 1: a fresh draft with no image rows at all. */
  fresh_draft: string;
  /** The control: a draft whose cover is genuinely `ready`. */
  control_draft: string;
  /**
   * §2's "E2c" variant: an article that is *already live*, whose public page
   * carries a real cover image, but which has no `role='cover'` row left (its
   * cover was moved into the body slot), so publish correctly refuses it
   * `COVER_IMAGE_REQUIRED` today.
   */
  live_article: string;
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
  const fresh_draft = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon dont la seule couverture sera un fichier refusé',
    league_name: 'Ligue 1',
    type_name: 'Pronos',
  });

  const control_draft = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon dont la couverture est réellement convertie',
    league_name: 'Serie A',
    type_name: 'Mercato',
  });
  await seedImage(db.client, {
    article_id: control_draft,
    role: 'cover',
    status: 'ready',
    optimized_url: CONTROL_COVER_URL,
  });

  const live_article = await seedArticle(db.client, {
    writer_id,
    title: 'Article en ligne dont la couverture a quitté son emplacement',
    league_name: 'Bundesliga',
    type_name: 'Pronos',
    slug: 'article-en-ligne-dont-la-couverture-a-quitte-son-emplacement',
    status: 'published',
    published_at: SEEDED_PUBLISHED_AT,
    first_published_at: SEEDED_PUBLISHED_AT,
  });
  // The image is still there and still converted — it is simply no longer in
  // the cover slot, which is the one thing `authenticated` may write directly
  // (`grant update (role, alt_text) on article_images`).
  await seedImage(db.client, {
    article_id: live_article,
    role: 'body',
    status: 'ready',
    optimized_url: LIVE_COVER_URL,
  });
  // What the live page is serving right now: the structured data baked in at
  // its last successful publish.
  await db.client.query(
    `update articles set structured_data = $2::jsonb where id = $1`,
    [
      live_article,
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: 'Article en ligne dont la couverture a quitté son emplacement',
        image: [LIVE_COVER_URL],
      }),
    ],
  );

  return { fresh_draft, control_draft, live_article };
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

type PublishOutcome = {
  status: number;
  code: string | undefined;
  /** `structured_data.image[0]` — what the public page's og:image becomes. */
  cover_image: string | undefined;
};

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
  return {
    status: res.status,
    code: body.error?.code,
    cover_image: firstImage(body.structured_data),
  };
}

function firstImage(structured_data: { image?: unknown } | undefined): string | undefined {
  const image = Array.isArray(structured_data?.image)
    ? structured_data?.image[0]
    : structured_data?.image;
  return typeof image === 'string' ? image : undefined;
}

/** The cover image the article's *stored* page data names, after the attempt. */
async function storedCoverImage(db: TestDatabase, article_id: string): Promise<string | undefined> {
  const res = await db.client.query<{ structured_data: { image?: unknown } | null }>(
    `select structured_data from articles where id = $1`,
    [article_id],
  );
  return firstImage(res.rows[0]?.structured_data ?? undefined);
}

async function articleState(db: TestDatabase, article_id: string) {
  const res = await db.client.query<{ status: string; published_at: Date | null }>(
    `select status, published_at from articles where id = $1`,
    [article_id],
  );
  const row = res.rows[0];
  return {
    status: row?.status,
    republished:
      row?.published_at instanceof Date && row.published_at.toISOString() > SEEDED_PUBLISHED_AT,
  };
}

/** How many `role='cover'` rows the article has, and how many are usable. */
async function coverRows(db: TestDatabase, article_id: string) {
  const res = await db.client.query<{ status: string; original_url: string | null }>(
    `select status, original_url from article_images where article_id = $1 and role = 'cover'`,
    [article_id],
  );
  return {
    cover_rows: res.rowCount ?? 0,
    usable_cover_rows: res.rows.filter((r) => r.status === 'ready' && r.original_url !== null)
      .length,
  };
}

/**
 * One line describing what the writer got, in a form that reads the same
 * whichever refusal the fix chooses. `400 COVER_IMAGE_REQUIRED` and `409
 * IMAGE_NOT_READY` are the two refusals `publishArticle`'s contract already
 * declares for an article whose images are not publishable; both are correct
 * answers here, and neither is prescribed.
 */
function outcomeOf(publish: PublishOutcome): string {
  return publish.status === 400 || publish.status === 409
    ? 'refused'
    : `${publish.status}, live with cover image ${JSON.stringify(publish.cover_image)}`;
}

describe('a publish that succeeds always has a cover image (verify v6, §2)', () => {
  it('AC-08-recovery-07: an article whose only cover-role image is a rejected upload is still refused at publish and stays a draft — a file the product itself refused, stored nowhere and convertible into nothing, is not a cover image, and answering COVER_IMAGE_REQUIRED before it was uploaded but 200 afterwards is the two checks disagreeing about what "has a cover" means', async () => {
    const { db, server, fx } = ctx();

    // Precondition, read from the database rather than spent on a publish
    // (this file's budget is 10 publishes per minute for the whole IP): the
    // draft starts with no cover row whatsoever, which is the state that
    // correctly answers 400 COVER_IMAGE_REQUIRED.
    const before = await coverRows(db, fx.fresh_draft);

    const rejected = await upload(server.url, fx.fresh_draft, {
      role: 'cover',
      filename: 'couverture-tronquee.jpg',
      bytes: corruptedJpeg(),
      key: `rejected-cover-${fx.fresh_draft}`,
    });
    const after = await coverRows(db, fx.fresh_draft);

    const result = await publish(server.url, fx.fresh_draft);
    const article = await articleState(db, fx.fresh_draft);

    expect({
      cover_rows_before_the_upload: before.cover_rows,
      upload_status: rejected.status,
      upload_says: rejected.body.status,
      usable_cover_rows_after_the_upload: after.usable_cover_rows,
      publish: outcomeOf(result),
      article_status: article.status,
    }).toEqual({
      cover_rows_before_the_upload: 0,
      upload_status: 201,
      upload_says: 'failed',
      usable_cover_rows_after_the_upload: 0,
      publish: 'refused',
      article_status: 'draft',
    });
  });

  it('NFR-COVER-INVARIANT-01: across every combination of image states, a publish answered 200 always carries a non-empty cover image — the invariant itself, rather than another enumeration of the specific states this one function has now silently dropped twice', async () => {
    const { db, server, writerId } = ctx();

    /**
     * Four combinations, chosen so that the *other* rows differ — the second
     * argument to `articleDependsOn(image, images)` is the whole article's
     * image list, so what else is present is exactly what decides the outcome.
     * `seeded` rows are written straight to `article_images` (a converted
     * asset the pipeline already finished); `uploads` are real truncated files
     * pushed through the real multipart route, which the product refuses
     * synchronously and records as `failed` with no stored original.
     */
    const combinations: Array<{
      id: string;
      title: string;
      seeded: Array<{ role: 'cover' | 'body'; optimized_url: string }>;
      uploads: Array<{ role: 'cover' | 'body' }>;
    }> = [
      {
        id: 'rejected-cover-only',
        title: 'Balayage — une couverture refusée et rien d’autre',
        seeded: [],
        uploads: [{ role: 'cover' }],
      },
      {
        id: 'rejected-cover-beside-a-ready-body-image',
        title: 'Balayage — une couverture refusée à côté d’une image de corps prête',
        seeded: [{ role: 'body', optimized_url: 'https://cdn.example/balayage/corps.webp' }],
        uploads: [{ role: 'cover' }],
      },
      {
        id: 'rejected-cover-and-rejected-body',
        title: 'Balayage — une couverture refusée et une image de corps refusée',
        seeded: [],
        uploads: [{ role: 'cover' }, { role: 'body' }],
      },
      {
        // M-V4-01's shape, kept inside the invariant: a rejected upload
        // arriving beside a cover that is genuinely ready must still publish,
        // carrying the real cover — so "refuse everything" cannot satisfy this.
        id: 'ready-cover-plus-a-rejected-cover',
        title: 'Balayage — une couverture prête puis un fichier de couverture refusé',
        seeded: [
          { role: 'cover', optimized_url: 'https://cdn.example/balayage/couverture-prete.webp' },
        ],
        uploads: [{ role: 'cover' }],
      },
    ];

    const results = [];
    for (const combination of combinations) {
      const article_id = await seedArticle(db.client, {
        writer_id: writerId,
        title: combination.title,
        league_name: 'Premier League',
        type_name: 'Pronos',
      });
      for (const row of combination.seeded) {
        await seedImage(db.client, {
          article_id,
          role: row.role,
          status: 'ready',
          optimized_url: row.optimized_url,
        });
      }
      for (const file of combination.uploads) {
        await upload(server.url, article_id, {
          role: file.role,
          filename: `${file.role}-tronque.jpg`,
          bytes: corruptedJpeg(),
          key: `sweep-${combination.id}-${file.role}`,
        });
      }
      const result = await publish(server.url, article_id);
      results.push({
        combination: combination.id,
        publish_status: result.status,
        cover_image: result.cover_image,
        stored_cover_image: await storedCoverImage(db, article_id),
      });
    }

    // The one thing asserted: nothing went live without a cover image. A
    // refusal (400/409) satisfies the invariant as well as a publish carrying a
    // real URL does — this test does not decide which combination gets which.
    const violations = results.flatMap((r) => {
      if (r.publish_status === 200 && (r.cover_image === undefined || r.cover_image === '')) {
        return [{ ...r, violates: 'published 200 with no cover image' }];
      }
      if (![200, 400, 409].includes(r.publish_status)) {
        return [{ ...r, violates: 'publish neither succeeded nor refused' }];
      }
      return [];
    });

    expect(violations).toEqual([]);
  });

  it('NFR-COVER-INVARIANT-02: an article whose cover is genuinely ready still publishes 200 and its page really carries that cover’s CDN URL — the both-sides half, so reconciling the two checks cannot be done by refusing publishes that were always legitimate', async () => {
    const { db, server, fx } = ctx();

    const result = await publish(server.url, fx.control_draft);
    const article = await articleState(db, fx.control_draft);

    expect({
      publish_status: result.status,
      error_code: result.code,
      cover_image_in_the_response: result.cover_image,
      cover_image_stored_on_the_article: await storedCoverImage(db, fx.control_draft),
      article_status: article.status,
    }).toEqual({
      publish_status: 200,
      error_code: undefined,
      cover_image_in_the_response: CONTROL_COVER_URL,
      cover_image_stored_on_the_article: CONTROL_COVER_URL,
      article_status: 'published',
    });
  });

  it('AC-08-recovery-08: an already-live article that publish is correctly refusing COVER_IMAGE_REQUIRED is not pushed live again by uploading a broken replacement cover, and the cover its public page is already serving is not overwritten with an empty one — the same disagreement as AC-08-recovery-07, reached from the state where it costs a page that was already correct', async () => {
    const { db, server, fx } = ctx();

    // Precondition, read from the database (see AC-08-recovery-07 on why not a
    // publish): the live article has no cover row at all today, so publish
    // refuses it 400 COVER_IMAGE_REQUIRED — while its stored page data still
    // names the cover visitors are being served.
    const before = await coverRows(db, fx.live_article);
    const served_before = await storedCoverImage(db, fx.live_article);

    const rejected = await upload(server.url, fx.live_article, {
      role: 'cover',
      filename: 'remplacement-tronque.jpg',
      bytes: corruptedJpeg(),
      key: `rejected-replacement-${fx.live_article}`,
    });

    const result = await publish(server.url, fx.live_article);
    const article = await articleState(db, fx.live_article);

    expect({
      cover_rows_before_the_upload: before.cover_rows,
      cover_image_served_before: served_before,
      upload_says: rejected.body.status,
      publish: outcomeOf(result),
      cover_image_served_after: await storedCoverImage(db, fx.live_article),
      republished: article.republished,
    }).toEqual({
      cover_rows_before_the_upload: 0,
      cover_image_served_before: LIVE_COVER_URL,
      upload_says: 'failed',
      publish: 'refused',
      cover_image_served_after: LIVE_COVER_URL,
      republished: false,
    });
  });
});
