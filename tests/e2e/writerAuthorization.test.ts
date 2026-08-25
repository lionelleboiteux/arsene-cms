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
import { TEST_JWKS_JSON, bearer, mintSupabaseJwt } from '../support/jwt.js';
import { validJpeg } from '../support/imageFixtures.js';

/**
 * H-V3-01 (`05-verification.v3.md` §2, High) — **there is no
 * writer-authorization check at all.**
 *
 * `router.ts`'s `verify()` returns `{ valid: true, writer_id: jwt.sub }` for
 * any token whose HS256 signature checks out and which carries a `sub`. Nothing
 * ever resolves that `sub` against a row in `writers`. Green v2 moved every
 * write behind a `service_role` seam (`db/migrations/0002_service_role.sql`) to
 * close an earlier reachability finding — and `service_role` has `bypassrls`,
 * which is precisely the mechanism `02-architecture.v1.md` §7 named as the
 * spoofing mitigation ("RLS keyed on `auth.uid()` restricts all mutating
 * operations to authenticated writers"). Nothing replaced it at the
 * application layer.
 *
 * The verify pass proved it end to end, with a `sub` belonging to nobody:
 * publish took an embargoed draft live and made it readable by `anon`, and an
 * upload replaced the cover image of an already-published article. Supabase
 * projects allow self-service signup by default and the editor SPA necessarily
 * ships the project's public anon key, so a stranger can obtain a
 * project-signed token and call these routes directly.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **All four writer-facing operations, uniformly.** `create-draft` and
 *    `open` appear protected today, but only because both happen to write a
 *    writer-scoped column and trip a foreign key. `publish` and `upload` write
 *    no such column and succeed outright. A fix that only patches the two
 *    visibly broken routes is not a fix, so `NFR-AUTHZ-01a`-`01d` demand the
 *    same answer from all four.
 *
 * 2. **The status and the code, not "not 200".** Two of the four answer `500
 *    INTERNAL_ERROR` today — a shape that also means the mutation already
 *    happened and nothing was logged (M-V3-05). `401 UNAUTHORIZED` is the
 *    assertion.
 *
 * 3. **`NFR-AUTHZ-03` exists because the foreign key is not an authorization
 *    check.** Same signature-valid token, `sub` that is not even writer-id
 *    shaped: the FK path cannot produce `23503` for it, so `unknownWriter()`
 *    rethrows and the caller gets a `500`. A deliberate lookup against
 *    `writers` answers `401` for every `sub` that is not a writer, whatever it
 *    looks like. This is what stops "the accident already covers it".
 *
 * 4. **`NFR-AUTHZ-04`/`05` assert the world, not the answer.** A guard that
 *    returns `401` *after* `markPublished` or `insertImage` has committed would
 *    satisfy the status assertions and still leak the embargoed article and
 *    still deface the live one. These two read the database and the `anon`
 *    role's own view afterwards.
 *
 * 5. **`NFR-AUTHZ-02` is the both-sides half**: a registered writer's token
 *    must keep working on all four operations, so "refuse everyone" cannot pass
 *    this file. One test rather than four, because it is one behaviour — the
 *    guard admits a real writer — and the operation that broke is visible in
 *    the diff.
 *
 * Everything runs against the **real spawned server** (`startServer`, a child
 * process, the boundary a deployment actually uses) and a real Postgres, which
 * is how the finding was proven. Tokens are real HS256 Supabase-shaped JWTs.
 */

/** A signature-valid `sub` belonging to no row in `writers`. Fixed, not random,
 *  so a failure is reproducible. */
const STRANGER_SUB = 'd51c050b-6084-4815-bd36-e45ffe7f99b7';

/** Signature-valid too, and not even shaped like a writer id — the case the
 *  foreign-key accident cannot answer (see NFR-AUTHZ-03). */
const MALFORMED_SUB = 'not-a-writer-id';

type Fixtures = {
  /** An unlocked draft, for `open`. */
  open_article: string;
  /** An embargoed draft with a ready cover: only authorization stands between
   *  it and the public site. */
  publish_article: string;
  /** A live article whose cover is the one a stranger must not be able to
   *  replace. */
  upload_article: string;
};

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  writerId: string;
  writerToken: string;
  strangerToken: string;
  malformedSubToken: string;
  /** For the `NFR-AUTHZ-01` family. */
  attack: Fixtures;
  /** For `NFR-AUTHZ-04`/`05`, so neither reads state another test left behind. */
  impact: Fixtures;
  /** For `NFR-AUTHZ-02`. */
  legit: Fixtures;
};

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

async function seedFixtures(db: TestDatabase, writerId: string, tag: string): Promise<Fixtures> {
  const open_article = await seedArticle(db.client, {
    writer_id: writerId,
    title: `Brouillon ouvrable ${tag}`,
    league_name: 'Ligue 1',
    type_name: 'Pronos',
  });

  const publish_article = await seedArticle(db.client, {
    writer_id: writerId,
    title: `CONFIDENTIEL brouillon sous embargo ${tag}`,
    league_name: 'Ligue 1',
    type_name: 'Pronos',
    body_html: '<p>Sous embargo jusqu’à samedi.</p>',
  });
  await seedImage(db.client, { article_id: publish_article, role: 'cover', status: 'ready' });

  const upload_article = await seedArticle(db.client, {
    writer_id: writerId,
    title: `Article en ligne ${tag}`,
    league_name: 'Bundesliga',
    type_name: 'Mercato',
    status: 'published',
    slug: `article-en-ligne-${tag}`,
    published_at: '2026-08-10T09:00:00Z',
  });
  await seedImage(db.client, { article_id: upload_article, role: 'cover', status: 'ready' });

  return { open_article, publish_article, upload_article };
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
      // Kept only so the option shape stays compatible; `jwksJson` below is
      // the credential this file exercises.
      writerToken: 'unused-legacy-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
    });
    started = {
      db,
      server,
      writerId,
      writerToken: await mintSupabaseJwt({ sub: writerId }),
      strangerToken: await mintSupabaseJwt({ sub: STRANGER_SUB }),
      malformedSubToken: await mintSupabaseJwt({ sub: MALFORMED_SUB }),
      attack: await seedFixtures(db, writerId, 'attaque'),
      impact: await seedFixtures(db, writerId, 'impact'),
      legit: await seedFixtures(db, writerId, 'legitime'),
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

// ---------------------------------------------------------------------------
// The four writer-facing operations, each callable with any bearer token.
// ---------------------------------------------------------------------------

const jsonPost = (url: string, token: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function coverForm(): FormData {
  const form = new FormData();
  form.set('role', 'cover');
  const bytes = validJpeg();
  form.set('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }), 'evil.jpg');
  return form;
}

type Operation = {
  id: string;
  name: string;
  /** What a *registered* writer gets from this operation when it works. */
  ok_status: number;
  call(token: string, f: Fixtures): Promise<Response>;
};

const OPERATIONS: Operation[] = [
  {
    id: 'NFR-AUTHZ-01a',
    name: 'create-draft (POST /v1/articles)',
    ok_status: 201,
    call: (token) =>
      jsonPost(`${ctx().server.url}/v1/articles`, token, { title: 'Brouillon d’un inconnu' }),
  },
  {
    id: 'NFR-AUTHZ-01b',
    name: 'open (POST /v1/articles/{id}/open)',
    ok_status: 200,
    call: (token, f) => jsonPost(`${ctx().server.url}/v1/articles/${f.open_article}/open`, token, {}),
  },
  {
    id: 'NFR-AUTHZ-01c',
    name: 'publish (POST /v1/articles/{id}/publish)',
    ok_status: 200,
    call: (token, f) =>
      jsonPost(`${ctx().server.url}/v1/articles/${f.publish_article}/publish`, token, {}),
  },
  {
    id: 'NFR-AUTHZ-01d',
    name: 'upload (POST /v1/articles/{id}/images)',
    ok_status: 201,
    call: (token, f) =>
      fetch(`${ctx().server.url}/v1/articles/${f.upload_article}/images`, {
        method: 'POST',
        headers: { authorization: bearer(token), 'idempotency-key': `authz-${f.upload_article}` },
        body: coverForm(),
      }),
  },
];

async function answer(res: Response): Promise<{ status: number; code: string | undefined }> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}

describe('writer authorization: a signed token is not a writer (verify v3, H-V3-01)', () => {
  it.each(
    OPERATIONS.map(
      (op) =>
        [
          `${op.id}: ${op.name} refuses 401 UNAUTHORIZED a signature-valid Supabase JWT whose sub has no row in writers — authentication is not authorization, and service_role bypasses the RLS that used to be the only check`,
          op,
        ] as const,
    ),
  )('%s', async (_title, op) => {
    const { strangerToken, attack } = ctx();

    expect(await answer(await op.call(strangerToken, attack))).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('NFR-AUTHZ-02: a registered writer’s own signed token still succeeds on all four writer-facing operations, so the missing check cannot be closed by refusing everybody', async () => {
    const { writerToken, legit } = ctx();

    const statuses: Record<string, number> = {};
    for (const op of OPERATIONS) {
      statuses[op.name] = (await op.call(writerToken, legit)).status;
    }

    expect(statuses).toEqual(
      Object.fromEntries(OPERATIONS.map((op) => [op.name, op.ok_status])),
    );
  });

  it('NFR-AUTHZ-03: a signature-valid token whose sub is not even shaped like a writer id is refused 401 UNAUTHORIZED, not answered 500 — the refusal has to come from an authorization decision about writers, never from whatever the database happens to say about the value', async () => {
    const { server, malformedSubToken } = ctx();

    // The one probe the foreign-key accident cannot answer: `insertDraft` gets
    // SQLSTATE 22021/22P02 rather than 23503, so `unknownWriter()` rethrows and
    // the generic handler turns it into a 500. The two routes that look
    // protected today are protected by that accident and by nothing else.
    const res = await jsonPost(`${server.url}/v1/articles`, malformedSubToken, {
      title: 'Sub malformé',
    });

    expect(await answer(res)).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('NFR-AUTHZ-04: a stranger’s publish leaves the embargoed draft unpublished and still invisible to the anon role, so a guard that answers 401 only after markPublished has committed does not count as closing this', async () => {
    const { db, server, strangerToken, impact } = ctx();

    await jsonPost(`${server.url}/v1/articles/${impact.publish_article}/publish`, strangerToken, {});

    const article = await db.client.query(
      `select status, slug, published_at from articles where id = $1`,
      [impact.publish_article],
    );
    await db.client.query('set role anon');
    let visibleToAnon: number | null;
    try {
      const anonView = await db.client.query(
        `select id from articles where id = $1`,
        [impact.publish_article],
      );
      visibleToAnon = anonView.rowCount;
    } finally {
      await db.client.query('reset role');
    }

    expect({
      status: article.rows[0]?.status,
      slug: article.rows[0]?.slug,
      published_at: article.rows[0]?.published_at,
      rows_the_public_role_can_read: visibleToAnon,
    }).toEqual({
      status: 'draft',
      slug: null,
      published_at: null,
      rows_the_public_role_can_read: 0,
    });
  });

  it('NFR-AUTHZ-05: a stranger’s cover upload against a live article leaves that article’s cover image exactly as it was, so the defacement path is closed at the write and not only in the response', async () => {
    const { db, server, strangerToken, impact } = ctx();

    await fetch(`${server.url}/v1/articles/${impact.upload_article}/images`, {
      method: 'POST',
      headers: {
        authorization: bearer(strangerToken),
        'idempotency-key': `authz-deface-${impact.upload_article}`,
      },
      body: coverForm(),
    });

    const images = await db.client.query(
      `select role, original_filename from article_images
        where article_id = $1 order by role, original_filename`,
      [impact.upload_article],
    );

    expect(images.rows).toEqual([{ role: 'cover', original_filename: 'cover.jpg' }]);
  });
});
