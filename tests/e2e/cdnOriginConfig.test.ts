import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedArticle, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * M-V3-04 (`05-verification.v3.md` §6, Medium — carried unchanged through
 * `05-verification.v4.md` §9 and `05-verification.v5.md` §7, both of which call
 * it "the item most likely to brick a real deployment") — **the CDN origin the
 * status callback is validated against is a hardcoded, unreachable
 * placeholder.**
 *
 *   src/api/router.ts:
 *     const CDN_ORIGIN = 'https://cdn.fantasycoach.example';
 *     const isCdnUrl = (value) => new URL(value).origin === CDN_ORIGIN;
 *     ImageStatusBody: optimized_url … .refine(isCdnUrl, …)
 *
 * `.example` is an IANA-reserved TLD: it can never be a real deployment's CDN
 * origin. Nothing under `src/` reads this value from the environment, and
 * unlike `SUPABASE_JWT_SECRET`, `IMAGE_CALLBACK_SECRET` and
 * `SUPABASE_JWT_ISSUER` it is not threaded through `ServerOptions` →
 * `startServer`'s spawn `env` → `serverMain.ts`. So in any real deployment:
 *
 *   Lambda finishes a conversion, POSTs the real CDN URL back  -> 400 VALIDATION_FAILED
 *   the image row never leaves `processing`                    -> forever
 *   every publish of every article carrying that image         -> 409 IMAGE_NOT_READY
 *
 * — a total, silent functional outage, invisible to every test in this repo
 * because the suite and the in-process storage stand-in both already use the
 * placeholder as if it were the real value. Both the v3 security auditor and
 * the v3 e2e agent confirmed it independently.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **Through the real deployment boundary, not the in-process router.** The
 *    finding is precisely that configuration does not reach the process a
 *    deployment runs. `tests/e2e/deployedAuthBoundary.test.ts` exists because
 *    that exact class of bug already happened once here: `ServerOptions`
 *    advertised `jwtSecret`, `server.ts`'s spawn silently dropped it, and the
 *    defect survived a whole verify pass. So this runs against the spawned
 *    child process, exactly as `VERIFY-03-DEPLOY-01` does.
 *
 * 2. **The configuration is supplied both ways, so no mechanism is
 *    prescribed.** The server is started with a `cdnOrigin` option *and* with
 *    `CDN_ORIGIN` set in this process's environment (which `server.ts` already
 *    forwards wholesale to the child through `env: { ...process.env, … }`).
 *    A fix that threads a new `ServerOptions` field through the spawn, and a
 *    fix that simply reads `process.env.CDN_ORIGIN` in `serverMain.ts` or
 *    `router.ts`, both satisfy these tests. What is asserted is only that the
 *    origin used to validate an inbound callback is the *configured* one.
 *
 * 3. **Both directions, in one table.** `NFR-CDN-CONFIG-01` is the outage:
 *    a genuine callback on the deployment's real origin must be accepted and
 *    must really store the URL. `NFR-CDN-CONFIG-02` is the guard that stops the
 *    cheapest wrong fix — deleting the origin check, or widening it to "any
 *    URL": the reserved placeholder is *not* this deployment's origin, so a
 *    callback carrying it must be refused, on the body alone, with the row left
 *    exactly where it was. `NFR-CALLBACK-04a`/`04b` (L2, verify v2) already pin
 *    the foreign-host and look-alike-host classes against the shipped constant;
 *    this pair adds the class those two cannot see, because they configure
 *    nothing.
 *
 * Both cases fail today, for the same single cause: the check is wired to a
 * compile-time constant instead of to configuration.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
const CALLBACK_SECRET = 'lambda-callback-shared-secret-not-the-writer-token';

/**
 * What a real deployment's CDN origin looks like: a resolvable, non-reserved
 * host. Deliberately not on `.example`, which is the whole finding.
 */
const CONFIGURED_CDN_ORIGIN = 'https://assets.fantasycoach.fr';

/**
 * The compile-time constant `router.ts` ships. Under the configuration above it
 * is simply somebody else's origin, and must be treated as one.
 */
const PLACEHOLDER_CDN_ORIGIN = 'https://cdn.fantasycoach.example';

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  articleId: string;
};

let started: Ctx | null = null;
let startupError: Error | null = null;
let previousEnv: string | undefined;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  previousEnv = process.env.CDN_ORIGIN;
  // Forwarded to the child by `server.ts`'s existing `env: { ...process.env }`,
  // so a fix that reads the environment needs no new option at all.
  process.env.CDN_ORIGIN = CONFIGURED_CDN_ORIGIN;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Marie D.');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: WRITER_TOKEN,
      writerId,
      imageCallbackSecret: CALLBACK_SECRET,
      // The same shape `jwtSecret`/`imageCallbackSecret`/`jwtIssuer` already
      // take; supplied alongside the environment variable above so either
      // mechanism satisfies these tests.
      cdnOrigin: CONFIGURED_CDN_ORIGIN,
      allowLegacyAuth: true,
    });
    started = {
      db,
      server,
      articleId: await seedArticle(db.client, {
        writer_id: writerId,
        title: 'Article dont les images passent par le vrai CDN',
        league_name: 'Ligue 1',
        type_name: 'Pronos',
      }),
    };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
  if (previousEnv === undefined) delete process.env.CDN_ORIGIN;
  else process.env.CDN_ORIGIN = previousEnv;
});

/** A `processing` row, exactly as `uploadImage.ts` leaves one for the pipeline. */
async function processingImage(db: TestDatabase, article_id: string, filename: string) {
  const res = await db.client.query<{ id: string }>(
    `insert into article_images (article_id, role, status, original_filename, original_url)
     values ($1, 'cover', 'processing', $2, 'https://projectref.supabase.co/storage/v1/object/x.jpg')
     returning id`,
    [article_id, filename],
  );
  return res.rows[0]?.id ?? '';
}

type OriginCase = {
  id: string;
  klass: string;
  origin: string;
  status: number;
  code: string | undefined;
  row_status: string;
  stores_the_url: boolean;
};

const ORIGIN_CASES: OriginCase[] = [
  {
    id: 'NFR-CDN-CONFIG-01',
    klass:
      'this deployment’s own configured CDN origin is accepted and the converted asset is really stored — otherwise every genuine Lambda callback is refused, every image stays processing forever and every publish is refused 409 IMAGE_NOT_READY, silently, in production',
    origin: CONFIGURED_CDN_ORIGIN,
    status: 200,
    code: undefined,
    row_status: 'ready',
    stores_the_url: true,
  },
  {
    id: 'NFR-CDN-CONFIG-02',
    klass:
      'the shipped `.example` placeholder — which is not this deployment’s origin — is refused on the body alone with the row untouched, so making the origin configurable cannot be done by widening the check to any URL',
    origin: PLACEHOLDER_CDN_ORIGIN,
    status: 400,
    code: 'VALIDATION_FAILED',
    row_status: 'processing',
    stores_the_url: false,
  },
];

describe('the CDN origin callbacks are validated against is configuration (verify v3, M-V3-04)', () => {
  it.each(
    ORIGIN_CASES.map(
      (c) => [`${c.id}: a status callback whose optimized_url is on ${c.klass}`, c] as const,
    ),
  )('%s', async (_title, c) => {
    const { db, server, articleId } = ctx();
    const image_id = await processingImage(db, articleId, `${c.id}.jpg`);
    const optimized_url = `${c.origin}/articles/${image_id}-optimized.webp`;

    const res = await fetch(`${server.url}/internal/images/${image_id}/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arsene-image-callback-secret': CALLBACK_SECRET,
      },
      body: JSON.stringify({ status: 'ready', optimized_url, failure: null }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    const row = await db.client.query<{ status: string; optimized_url: string | null }>(
      `select status, optimized_url from article_images where id = $1`,
      [image_id],
    );

    expect({
      callback_status: res.status,
      error_code: body.error?.code,
      row_status: row.rows[0]?.status,
      row_stores_the_url: row.rows[0]?.optimized_url === optimized_url,
    }).toEqual({
      callback_status: c.status,
      error_code: c.code,
      row_status: c.row_status,
      row_stores_the_url: c.stores_the_url,
    });
  });
});
