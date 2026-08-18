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
import { corruptedJpeg, validJpeg } from '../support/imageFixtures.js';

/**
 * M-V5-01, M-V5-02 and M-V5-03 (`05-verification.v5.md` §3) — **one fix
 * family**: the permanent-block bug M-V4-01 described is still reachable
 * through two further states, and the fix that closed the first one tied the
 * publish gate to the single `article_images` column a writer can write
 * directly.
 *
 * ---------------------------------------------------------------------------
 * THE THREE TRACES, AS THE VERIFY PASS PROVED THEM LIVE
 * ---------------------------------------------------------------------------
 *
 * M-V5-01 (§3.2) — the identical bug, through the `body` slot:
 *
 *   publish before anything                         -> 200
 *   upload truncated-body.jpg as role=body          -> 201 {"status":"failed"}
 *   publish                                         -> 409 IMAGE_NOT_READY {role: body}
 *   upload a GOOD body image (the documented remedy)-> 201, converts to ready
 *   publish                                         -> 409 IMAGE_NOT_READY   <- still
 *   authenticated: delete -> 42501, update status -> 42501, update url -> 42501
 *
 *   `publishArticle.ts`'s `isRejectedAttempt()` excludes a `failed` row only
 *   when `image.role === 'cover'`. Green v5's stated reason for the asymmetry
 *   ("a body image is referenced from the article's own HTML") does not hold
 *   for a *rejected* body image: `uploadImage.ts` gives a synchronously
 *   rejected upload `original_url: null` and `urls: null` on every path, so it
 *   was never embeddable in the first place. It is exactly as orphaned as the
 *   rejected-cover case the fix already handles; only its `role` differs.
 *
 * M-V5-02 (§3.3) — a `processing` cover, demoted and only *then* failing:
 *
 *   article with cover/ready
 *     upload cover X (large, slow to convert)  -> 201; X = cover/processing
 *     upload cover Y                           -> 201; X is now body/processing
 *     Lambda reports X failed (real callback)  -> 200; X is now body/failed
 *     publish                                  -> 409 IMAGE_NOT_READY
 *     upload another good cover Z, converts    -> ready
 *     publish                                  -> 409 IMAGE_NOT_READY  <- permanent
 *
 *   `repo.ts`'s `demoteCurrentCover()` guard (`status <> 'failed'`) is
 *   evaluated at demote time, but `status` is decided asynchronously by the
 *   Lambda callback — so "not yet failed" is not "successfully ready", and the
 *   bug lives in that gap.
 *
 * M-V5-03 (§3.4, a regression introduced by the v5 fix) — the gate now keys on
 * a writer-writable column:
 *
 *   article with cover/ready + a body image genuinely referenced from body_html
 *     that body image's conversion fails       -> body/failed
 *     publish                                  -> 409 IMAGE_NOT_READY (correct)
 *     any writer, direct PostgREST as `authenticated`:
 *       update article_images set role='cover' -> ALLOWED
 *     publish                                  -> 200, live with a broken image
 *
 *   `db/migrations/0001_initial_schema.sql` grants `authenticated`
 *   `update (role, alt_text)` on `article_images`. Before green v5, `role` had
 *   no bearing on publish-readiness; it does now.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **Outcomes, never a mechanism.** Both verify agents converged on the same
 *    repair (key the exclusion on whether a row was ever *adopted* —
 *    `original_url is null` or slot supersession — rather than on `role`, and
 *    narrow the demote guard to `status = 'ready'`). Nothing below asserts any
 *    of that. In particular `AC-08-recovery-05` deliberately does **not**
 *    assert that the slow cover was demoted, because the recommended fix stops
 *    demoting it at all; it asserts only what a writer can see, so a fix that
 *    never demotes, a fix that re-scopes the readiness gate, and a fix that
 *    grants a scoped `delete` plus a route are all equally admissible.
 *
 * 2. **Real infrastructure, because that is the finding.** Real Postgres, a
 *    real spawned child-process server over real HTTP, real multipart bytes,
 *    and — for `AC-08-recovery-05` — ADR-0004's **real Lambda status callback**
 *    (`POST /internal/images/{id}/status`, carrying the real shared secret),
 *    because the whole point of M-V5-02 is that the failure arrives *after* the
 *    demote decision was taken. A handler-level test with a hand-built image
 *    list cannot express "later".
 *
 * 3. **Two both-sides controls, for the two cheapest wrong fixes.**
 *    `AC-08-recovery-06` is the boundary: a `failed` body image the article is
 *    genuinely still using — adopted (`original_url` present) and referenced
 *    from `body_html` — must keep refusing the publish, so M-V5-01 cannot be
 *    closed by exempting `body` rows, or `failed` rows, wholesale. It passes
 *    today and must still pass afterwards. `NFR-IMAGE-ROLE-01` is the same
 *    article with one difference — a writer has flipped that row's `role` to
 *    `cover` through the exact grant PostgREST exposes — and it must reach the
 *    same refusal. It fails today.
 *
 * 4. **`NFR-IMAGE-ROLE-01` asserts no SQLSTATE.** Revoking the `update (role)`
 *    grant is as admissible a fix as ignoring `role` in the gate, so the test
 *    records only what the product does after the attempt: publish still
 *    refuses, and the draft stays a draft.
 *
 * Legacy static-token auth, exactly as tests/e2e/publishJourney.test.ts and
 * tests/e2e/coverReplacementRecovery.test.ts use it and for the same stated
 * reason (`router.ts`'s `verify()` comment; tests/e2e/failClosedConfig.test.ts
 * for the mechanism that makes it a choice). Setup only: authorization is not
 * what any assertion in this file is about.
 *
 * ===========================================================================
 * ADDED BY THE SEVENTH REMEDIATION PASS — M-V6-02 (`05-verification.v6.md` §3)
 * ===========================================================================
 *
 * `04-green-evidence.v6.md` §6.3 disclosed, as an accepted residual, that a
 * writer can still influence *which* row gets treated as "superseded" by
 * flipping `role` before uploading a replacement cover — describing it as
 * "bounded, **non-deterministic** (depends on which row `returning id` yields
 * first)". Both verify agents chased it independently and both concluded the
 * "non-deterministic" half is wrong. The security auditor's construction
 * removes the ordering question entirely by reducing `demoteCurrentCover()`'s
 * match set to exactly one row first:
 *
 *   draft: cover A (ready) + body image B (adopted, failed, in body_html)
 *   publish                                    -> 409 IMAGE_NOT_READY   correct
 *
 *   as `authenticated`, over the one `article_images` grant that exists:
 *     update article_images set role='body'  where id = A   -- vacate the slot
 *     update article_images set role='cover' where id = B   -- put B in it
 *
 *   POST .../images  role=cover  (an ordinary good file)
 *     -> `update … where role='cover' returning id` matches EXACTLY ONE row (B)
 *     -> the new cover records replaced_cover_image_id = B, on every run
 *
 *   publish                                    -> 200, live               WRONG
 *
 * `NFR-IMAGE-ROLE-02` below is that sequence. It asserts the same thing
 * `NFR-IMAGE-ROLE-01` does and for the same reason — publish still refuses,
 * the draft stays a draft — and, like it, asserts **no SQLSTATE** on either
 * direct write, so the fix the verify report recommends (`revoke update (role)
 * on article_images from authenticated`, paired with a server-side route for
 * cover selection) and a fix that keeps the grant but stops letting
 * supersession excuse a row the article still genuinely uses are equally
 * admissible. Both produce `409 IMAGE_NOT_READY` here: under the revocation,
 * both writes are refused, A keeps the slot, the replacement supersedes A, and
 * B — adopted, failed, still referenced from `body_html` — goes on blocking.
 *
 * `NFR-IMAGE-ROLE-01` is unaffected by that revocation for the same reason: it
 * already tolerates the write being refused, and the row it targets keeps
 * blocking either way.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
/** ADR-0004's Lambda callback secret, as configured on the server below. */
const CALLBACK_SECRET = 'lambda-callback-shared-secret-not-the-writer-token';
/** Every fixture article below went live at this instant; a republish moves it. */
const SEEDED_PUBLISHED_AT = '2026-08-10T09:00:00.000Z';

type Fixtures = {
  /** M-V5-01: a live article that receives one rejected `body` upload. */
  body_reject_article: string;
  /** M-V5-02: a live article whose slow cover is demoted, then fails. */
  demoted_cover_article: string;
  demoted_cover_image: string;
  /** The control: a live article whose in-use body image genuinely failed. */
  in_use_body_article: string;
  /** M-V5-03: the same shape, as a draft, for the `role`-flip bypass. */
  role_flip_article: string;
  role_flip_image: string;
  /** M-V6-02: the same shape again, for the deterministic slot swap. */
  slot_swap_article: string;
  /** The article's real, converted cover — the row the swap vacates. */
  slot_swap_cover: string;
  /** The broken, genuinely-used body image the swap moves into the slot. */
  slot_swap_image: string;
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

/**
 * An `article_images` row with full control over the columns `seedImage` fixes
 * for its own callers — specifically `original_url` (whether the row was ever
 * adopted) and `optimized_url` (a failed conversion has none).
 */
async function insertImageRow(
  db: TestDatabase,
  o: {
    article_id: string;
    role: 'cover' | 'body';
    status: 'processing' | 'ready' | 'failed';
    original_filename: string;
    original_url: string | null;
    optimized_url: string | null;
    failure_code?: string | null;
  },
): Promise<string> {
  const res = await db.client.query<{ id: string }>(
    `insert into article_images
       (article_id, role, status, original_filename, alt_text,
        original_url, optimized_url, failure_code, failure_message)
     values ($1, $2, $3, $4, null, $5, $6, $7, $8)
     returning id`,
    [
      o.article_id,
      o.role,
      o.status,
      o.original_filename,
      o.original_url,
      o.optimized_url,
      o.failure_code ?? null,
      o.failure_code === undefined || o.failure_code === null
        ? null
        : `${o.original_filename} passed format detection but could not be decoded.`,
    ],
  );
  return res.rows[0]?.id ?? '';
}

async function seedFixtures(db: TestDatabase, writer_id: string): Promise<Fixtures> {
  const published = {
    status: 'published' as const,
    published_at: SEEDED_PUBLISHED_AT,
    first_published_at: SEEDED_PUBLISHED_AT,
  };

  // --- M-V5-01 -------------------------------------------------------------
  const body_reject_article = await seedArticle(db.client, {
    writer_id,
    title: 'Article à republier après un envoi de corps raté',
    league_name: 'Ligue 1',
    type_name: 'Pronos',
    slug: 'article-a-republier-apres-un-envoi-de-corps-rate',
    ...published,
  });
  await seedImage(db.client, { article_id: body_reject_article, role: 'cover', status: 'ready' });

  // --- M-V5-02 -------------------------------------------------------------
  // No cover row yet: the "slow" upload below *is* this article's cover, still
  // converting, exactly as it is between the 201 and the Lambda's callback.
  const demoted_cover_article = await seedArticle(db.client, {
    writer_id,
    title: 'Article dont la couverture lente échoue après coup',
    league_name: 'Bundesliga',
    type_name: 'Mercato',
    slug: 'article-dont-la-couverture-lente-echoue-apres-coup',
    ...published,
  });
  const demoted_cover_image = await insertImageRow(db, {
    article_id: demoted_cover_article,
    role: 'cover',
    status: 'processing',
    original_filename: 'couverture-lente.jpg',
    // Adopted: `uploadImage.ts` stored the original before handing it to the
    // pipeline. Only the *conversion* is still outstanding.
    original_url: `https://projectref.supabase.co/storage/v1/object/articles/${demoted_cover_article}/couverture-lente.jpg`,
    optimized_url: null,
  });

  // --- The control ---------------------------------------------------------
  const in_use_body_article = await seedArticle(db.client, {
    writer_id,
    title: 'Article dont une image de corps réellement utilisée a échoué',
    league_name: 'Serie A',
    type_name: 'Pronos',
    slug: 'article-dont-une-image-de-corps-reellement-utilisee-a-echoue',
    ...published,
  });
  await seedImage(db.client, { article_id: in_use_body_article, role: 'cover', status: 'ready' });
  await embedFailedBodyImage(db, in_use_body_article, 'illustration-utilisee.jpg');

  // --- M-V5-03 -------------------------------------------------------------
  const role_flip_article = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon dont une image de corps cassée est renommée en couverture',
    league_name: 'Premier League',
    type_name: 'Mercato',
  });
  await seedImage(db.client, { article_id: role_flip_article, role: 'cover', status: 'ready' });
  const role_flip_image = await embedFailedBodyImage(
    db,
    role_flip_article,
    'illustration-cassee.jpg',
  );

  // --- M-V6-02 -------------------------------------------------------------
  // Identical in shape to the M-V5-03 fixture above, and deliberately a
  // separate article: the swap needs its own untouched cover row to vacate.
  const slot_swap_article = await seedArticle(db.client, {
    writer_id,
    title: 'Brouillon dont l’emplacement de couverture est libéré puis repris',
    league_name: 'Liga',
    type_name: 'Pronos',
  });
  const slot_swap_cover = await seedImage(db.client, {
    article_id: slot_swap_article,
    role: 'cover',
    status: 'ready',
  });
  const slot_swap_image = await embedFailedBodyImage(
    db,
    slot_swap_article,
    'illustration-toujours-utilisee.jpg',
  );

  return {
    body_reject_article,
    demoted_cover_article,
    demoted_cover_image,
    in_use_body_article,
    role_flip_article,
    role_flip_image,
    slot_swap_article,
    slot_swap_cover,
    slot_swap_image,
  };
}

/**
 * A body image the article genuinely uses: adopted (it has a stored original,
 * so the writer's upload was accepted), referenced from the article's own
 * `body_html`, and broken (its conversion failed, so it has no CDN asset).
 * This is the row AC-08 exists for — the one the publish gate must keep
 * refusing.
 */
async function embedFailedBodyImage(
  db: TestDatabase,
  article_id: string,
  filename: string,
): Promise<string> {
  const original_url = `https://projectref.supabase.co/storage/v1/object/articles/${article_id}/${filename}`;
  const image_id = await insertImageRow(db, {
    article_id,
    role: 'body',
    status: 'failed',
    original_filename: filename,
    original_url,
    optimized_url: null,
    failure_code: 'CORRUPTED_FILE',
  });
  await db.client.query(
    `update articles
        set body_html = $2
      where id = $1`,
    [
      article_id,
      `<h2>Les affiches</h2><p>Analyse match par match.</p>` +
        `<figure><img src="${original_url}" data-image-id="${image_id}"></figure>`,
    ],
  );
  return image_id;
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
      imageCallbackSecret: CALLBACK_SECRET,
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

async function upload(
  baseUrl: string,
  articleId: string,
  o: { role: 'cover' | 'body'; filename: string; bytes: Uint8Array; key: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.set('role', o.role);
  form.set(
    'file',
    new Blob([o.bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }),
    o.filename,
  );
  const res = await fetch(`${baseUrl}/v1/articles/${articleId}/images`, {
    method: 'POST',
    headers: authHeaders({ 'idempotency-key': o.key }),
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const publish = (baseUrl: string, articleId: string) =>
  fetch(`${baseUrl}/v1/articles/${articleId}/publish`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({}),
  });

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

/** What the writer sees: did this publish actually move the article on? */
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

const errorCode = async (res: Response): Promise<string | undefined> =>
  ((await res.json()) as { error?: { code?: string } }).error?.code;

describe('recovering from rejected and superseded image uploads (verify v5, §3)', () => {
  it('AC-08-recovery-04: after a truncated file uploaded as a body image is rejected, the live article still republishes — a file the product refused was never embedded in the body, so it cannot leave behind a row that blocks publishing forever, exactly as for a rejected cover', async () => {
    const { db, server, fx } = ctx();

    await upload(server.url, fx.body_reject_article, {
      role: 'body',
      filename: 'illustration-tronquee.jpg',
      bytes: corruptedJpeg(),
      key: `body-reject-${fx.body_reject_article}`,
    });
    const res = await publish(server.url, fx.body_reject_article);
    const code = await errorCode(res);
    const article = await articleState(db, fx.body_reject_article);

    expect({
      publish_status: res.status,
      error_code: code,
      article_status: article.status,
      republished: article.republished,
    }).toEqual({
      publish_status: 200,
      error_code: undefined,
      article_status: 'published',
      republished: true,
    });
  });

  it('AC-08-recovery-05: a cover still converting when a second cover upload supersedes it, and which the Lambda only then reports as failed, does not block republication either — the outcome of an upload is decided after the slot was taken, so a guard read at the moment of the upload cannot see it', async () => {
    const { db, server, fx } = ctx();

    // The second upload: the legitimate, intended "changed my mind" case.
    const second = await upload(server.url, fx.demoted_cover_article, {
      role: 'cover',
      filename: 'couverture-definitive.jpg',
      bytes: validJpeg(),
      key: `demoted-cover-${fx.demoted_cover_article}`,
    });
    const second_status = await waitForImage(db, String(second.body.id));

    // ADR-0004's real callback, only now reporting on the first upload.
    const callback = await fetch(
      `${server.url}/internal/images/${fx.demoted_cover_image}/status`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-arsene-image-callback-secret': CALLBACK_SECRET,
        },
        body: JSON.stringify({
          status: 'failed',
          optimized_url: null,
          failure: { code: 'CORRUPTED_FILE', message: 'couverture-lente.jpg failed to convert.' },
        }),
      },
    );
    const slow = await db.client.query<{ status: string }>(
      `select status from article_images where id = $1`,
      [fx.demoted_cover_image],
    );

    const res = await publish(server.url, fx.demoted_cover_article);
    const code = await errorCode(res);
    const article = await articleState(db, fx.demoted_cover_article);

    expect({
      second_cover: second_status,
      callback_status: callback.status,
      slow_cover: slow.rows[0]?.status,
      publish_status: res.status,
      error_code: code,
      republished: article.republished,
    }).toEqual({
      second_cover: 'ready',
      callback_status: 200,
      slow_cover: 'failed',
      publish_status: 200,
      error_code: undefined,
      republished: true,
    });
  });

  it('AC-08-recovery-06: a body image the article is genuinely still using — stored, referenced from its own body_html, and broken — does keep refusing the publish, 409 IMAGE_NOT_READY, so the two fixes above cannot be had by exempting body rows or failed rows wholesale', async () => {
    const { db, server, fx } = ctx();

    const res = await publish(server.url, fx.in_use_body_article);
    const code = await errorCode(res);
    const article = await articleState(db, fx.in_use_body_article);

    expect({
      publish_status: res.status,
      error_code: code,
      republished: article.republished,
    }).toEqual({
      publish_status: 409,
      error_code: 'IMAGE_NOT_READY',
      republished: false,
    });
  });

  it('NFR-IMAGE-ROLE-01: a writer who renames a broken, genuinely-embedded body image to role=cover through the direct PostgREST grant still cannot publish the article — the readiness gate may not be decided by a column any writer can write', async () => {
    const { db, server, fx } = ctx();

    // The one `article_images` grant `authenticated` holds
    // (`grant update (role, alt_text)`), exercised as PostgREST would: as the
    // role itself, against real RLS, with no server seam in the way — the same
    // technique NFR-LOCK-GRANT-01 uses in tests/db/schema.test.ts.
    await db.client.query('set role authenticated');
    try {
      await db.client
        .query(`update article_images set role = 'cover' where id = $1`, [fx.role_flip_image])
        .catch(() => undefined);
    } finally {
      await db.client.query('reset role');
    }

    const res = await publish(server.url, fx.role_flip_article);
    const code = await errorCode(res);
    const article = await articleState(db, fx.role_flip_article);

    expect({
      publish_status: res.status,
      error_code: code,
      article_status: article.status,
    }).toEqual({
      publish_status: 409,
      error_code: 'IMAGE_NOT_READY',
      article_status: 'draft',
    });
  });

  it('NFR-IMAGE-ROLE-02: a writer who vacates the cover slot and moves a broken, genuinely-used body image into it before uploading a replacement cover still cannot publish — choosing which row the next upload supersedes is choosing which row stops blocking, and one image row per article is not a decision a writer gets to make about their own article’s integrity', async () => {
    const { db, server, fx } = ctx();

    // AC-08 is working before the swap: the broken body image blocks.
    const before = await publish(server.url, fx.slot_swap_article);
    const before_code = await errorCode(before);

    // The security auditor's construction, as `05-verification.v6.md` §3 gives
    // it: two writes over the one `article_images` grant `authenticated` holds
    // (`grant update (role, alt_text)`), executed as the role itself against
    // real RLS, exactly as NFR-IMAGE-ROLE-01 and NFR-LOCK-GRANT-01 do. Vacating
    // the slot first leaves the next demote exactly one row to match, so the
    // outcome is forced rather than raced. Neither write's SQLSTATE is
    // asserted: revoking the grant is as admissible a fix as any other.
    await db.client.query('set role authenticated');
    try {
      await db.client
        .query(`update article_images set role = 'body' where id = $1`, [fx.slot_swap_cover])
        .catch(() => undefined);
      await db.client
        .query(`update article_images set role = 'cover' where id = $1`, [fx.slot_swap_image])
        .catch(() => undefined);
    } finally {
      await db.client.query('reset role');
    }

    // An ordinary, valid cover upload — nothing about this request is hostile.
    const replacement = await upload(server.url, fx.slot_swap_article, {
      role: 'cover',
      filename: 'couverture-de-remplacement.jpg',
      bytes: validJpeg(),
      key: `slot-swap-${fx.slot_swap_article}`,
    });
    // The replacement must really be ready, or the publish below would be
    // refused for the replacement's own sake and prove nothing.
    const replacement_status = await waitForImage(db, String(replacement.body.id));

    const after = await publish(server.url, fx.slot_swap_article);
    const after_code = await errorCode(after);
    const article = await articleState(db, fx.slot_swap_article);

    expect({
      publish_before_the_swap: `${before.status} ${before_code}`,
      replacement_cover: replacement_status,
      publish_after_the_swap: `${after.status} ${after_code}`,
      article_status: article.status,
    }).toEqual({
      publish_before_the_swap: '409 IMAGE_NOT_READY',
      replacement_cover: 'ready',
      publish_after_the_swap: '409 IMAGE_NOT_READY',
      article_status: 'draft',
    });
  });
});
