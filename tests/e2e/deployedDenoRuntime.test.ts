import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDenoServer, type RunningDenoServer } from '../support/denoServer.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { mintSupabaseJwt, TEST_JWKS_JSON } from '../support/jwt.js';
import { BASE_JPEG } from '../support/imageFixtures.js';

/**
 * `fetch` (undici) refuses, client-side, to send a `TRACE` request or a body
 * whose length disagrees with a declared `Content-Length` — exactly the
 * WHATWG Fetch-spec restrictions `router.ts`'s Node adapter had to work
 * around on the *server* side (see its `nodeRequestToWebRequest` comment).
 * `node:http`'s low-level client has no such restriction, so it is the tool
 * for driving the two cases that specifically exercise those guards.
 */
function rawRequest(opts: {
  baseUrl: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(opts.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: opts.path, method: opts.method, headers: opts.headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/**
 * The pipeline gate (`pdlc/arsene-cms/10-pipeline.v1.md` §0) found that
 * `src/api/router.ts`, as built, could not run on Supabase Edge Functions:
 * ADR-0001 named Deno's Fetch-API handler model, but eight remediation cycles
 * had only ever proved the code against a real *Node* child process
 * (`src/api/server.ts`). This is the test that closes that gap: it spawns the
 * real, deployed entry point (`supabase/functions/arsene-api/index.ts`) as a
 * genuine `deno run` process — not the in-process router, not the Node
 * child-process boundary — and drives it over real HTTP against real
 * Postgres. If this file cannot run, the Deno port is not actually proven,
 * whatever the Node suite says.
 */

type Ctx = { db: TestDatabase; server: RunningDenoServer; writerId: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Lionel Le Boiteux');
    const server = await startDenoServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-legacy-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
      imageCallbackSecret: 'test-callback-secret',
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

describe('the real Deno Edge Function entry point (Deno-port pipeline finding, closed)', () => {
  it('DENO-01: a validly-signed Supabase JWT creates a draft against the real deno run process, over real HTTP, against real Postgres', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Preuve du vrai runtime Deno' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { article_id: string };
    expect(typeof body.article_id).toBe('string');
  });

  it('DENO-02: the legacy static token is refused once a JWKS is configured — the same auth boundary the Node deployment enforces, verified through the runtime that actually ships', async () => {
    const { server } = ctx();

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: 'Bearer unused-legacy-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
  });

  it("DENO-03: an HTTP method the Fetch API Request constructor forbids (TRACE) is answered 405, not a crash — route()'s own guard, not request.method, decides this under Deno too", async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await rawRequest({
      baseUrl: server.url,
      path: '/v1/articles',
      method: 'TRACE',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('DENO-04: a declared Content-Length over the 20 MB cap is refused from the header alone (413), before any body is read', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await rawRequest({
      baseUrl: server.url,
      path: '/v1/articles/00000000-0000-0000-0000-000000000000/images',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(21 * 1024 * 1024),
      },
      body: 'x',
    });

    expect(res.status).toBe(413);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('DENO-05: an uploaded image stays "processing" under the real Deno runtime — the dev/test Lambda simulation (`convert()`, which needs real `sharp`) is never wired here, exactly as production must never touch a native addon Deno cannot load', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const draft = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Article pour upload' }),
    });
    const { article_id } = (await draft.json()) as { article_id: string };

    const form = new FormData();
    form.set('role', 'cover');
    form.set('file', new File([BASE_JPEG as BlobPart], 'cover.jpg', { type: 'image/jpeg' }));

    const res = await fetch(`${server.url}/v1/articles/${article_id}/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'deno-upload-1' },
      body: form,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    // Never "ready": that would mean the dev/test-only `convert()` (real
    // `sharp`, a native addon Deno cannot load) had somehow run here. This
    // server never wires `shared.processUpload` — production relies solely
    // on the real external Lambda's callback (DENO-06 proves that half).
    expect(body.status).toBe('processing');
  });

  it('DENO-06: the ADR-0004 status callback closes the loop under the real Deno runtime — the real external Lambda\'s report lands correctly even though this process never generated it itself', async () => {
    const { server, writerId, db } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const draft = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Article pour callback' }),
    });
    const { article_id } = (await draft.json()) as { article_id: string };

    const image = await db.client.query(
      `insert into article_images (article_id, role, status, original_filename, original_url)
       values ($1, 'cover', 'processing', 'cover.jpg', 'https://storage.example/original.jpg')
       returning id`,
      [article_id],
    );
    const image_id: string = image.rows[0].id;

    const res = await fetch(`${server.url}/internal/images/${image_id}/status`, {
      method: 'POST',
      headers: {
        'x-arsene-image-callback-secret': 'test-callback-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'ready',
        optimized_url: 'https://cdn.fantasycoach.example/articles/x-optimized.webp',
      }),
    });

    expect(res.status).toBe(200);
    const row = await db.client.query('select status from article_images where id = $1', [image_id]);
    expect(row.rows[0].status).toBe('ready');
  });

  it('DENO-07: a request shaped exactly like Supabase\'s real gateway presents it — path prefixed with the function\'s own name, not just /v1/... — is routed correctly, not 404d', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    // Confirmed empirically against the real deployed project: Supabase's
    // gateway strips `/functions/v1` but leaves the function name itself in
    // the path the handler sees (`https://<ref>.supabase.co/functions/v1/
    // arsene-api/v1/articles` arrives as pathname `/arsene-api/v1/articles`,
    // per the platform's own routing guide — Hono examples there set
    // `basePath('/<function-name>')` for exactly this reason). Every local
    // rehearsal and e2e test up to this one talks to this server on its bare
    // path (`/v1/articles`), which is why this gap went unnoticed: nothing
    // ever simulated the platform's own prefix until now.
    const res = await fetch(`${server.url}/arsene-api/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Preuve du vrai prefixe de la plateforme' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { article_id: string };
    expect(typeof body.article_id).toBe('string');
  });
});
