import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, bearer, mintSupabaseJwt } from '../support/jwt.js';

/**
 * CORS-01 — the writer-editor SPA (arsene.fantasy-coach.fr, and local Vite
 * dev at localhost:5173) is a different origin from `arsene-api`, and until
 * now nothing in `router.ts` ever set an `Access-Control-*` header. Every
 * browser call to any of the four writer-facing endpoints — including from
 * local dev against the real deployed backend — was silently blocked by the
 * browser itself before this fix, with no server-side symptom to point at.
 *
 * `route()`'s CORS grant is allow-list based and origin-reflecting, never
 * `*`: this is a bearer-token API, so a request from an origin not in
 * `ServerOptions.corsOrigins` must get no CORS grant at all, not a
 * same-for-everyone wildcard.
 *
 * Runs against the real spawned server and real Postgres, same as
 * `draftJourney.test.ts` — this is a statement about the actual response
 * headers a browser sees, which only a real HTTP round trip can prove.
 */

const ALLOWED_ORIGIN = 'https://arsene.fantasy-coach.fr';
const DISALLOWED_ORIGIN = 'https://evil.example';

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  token: string;
};

let started: Ctx | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startHttpServer } = await loadApiRouter();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Marie D.');
    const server = await startHttpServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-static-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
      imageCallbackSecret: 'lambda-callback-shared-secret-not-the-writer-token',
      corsOrigins: [ALLOWED_ORIGIN, 'http://localhost:5173'],
    });
    started = { db, server, token: await mintSupabaseJwt({ sub: writerId }) };
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

describe('CORS on arsene-api (CORS-01)', () => {
  it('an OPTIONS preflight from an allow-listed origin gets a 204 with the grant and the real allowed method', async () => {
    const { server } = ctx();

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });

    expect({
      status: res.status,
      allow_origin: res.headers.get('access-control-allow-origin'),
      allow_methods: res.headers.get('access-control-allow-methods'),
      allow_headers: res.headers.get('access-control-allow-headers'),
    }).toEqual({
      status: 204,
      allow_origin: ALLOWED_ORIGIN,
      allow_methods: 'POST, OPTIONS',
      allow_headers: 'authorization, content-type, idempotency-key',
    });
  });

  it('a real authenticated call from an allow-listed origin gets the grant on the actual response, not only on preflight', async () => {
    const { server, token } = ctx();

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: {
        authorization: bearer(token),
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
      },
      body: '{}',
    });

    expect({
      status: res.status,
      allow_origin: res.headers.get('access-control-allow-origin'),
    }).toEqual({ status: 201, allow_origin: ALLOWED_ORIGIN });
  });

  it('the same authenticated call from an origin that is not allow-listed gets no CORS grant at all — never a wildcard fallback', async () => {
    const { server, token } = ctx();

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: {
        authorization: bearer(token),
        'content-type': 'application/json',
        origin: DISALLOWED_ORIGIN,
      },
      body: '{}',
    });

    expect({
      status: res.status,
      allow_origin: res.headers.get('access-control-allow-origin'),
    }).toEqual({ status: 201, allow_origin: null });
  });
});
