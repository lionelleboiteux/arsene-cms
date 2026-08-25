import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { mintSupabaseJwt, TEST_JWKS_JSON } from '../support/jwt.js';

/**
 * Every other test that proves JWT verification works (tests/e2e/draftJourney.test.ts,
 * tests/unit/auth.test.ts) does so either in-process (`startHttpServer`,
 * router.ts's own in-process starter) or against the auth module directly.
 * Neither exercises the boundary a real deployment actually uses:
 * src/api/server.ts's `startServer` spawns src/api/serverMain.ts as a real
 * child process, and serverMain.ts deliberately reads `jwtSecret`/
 * `imageCallbackSecret` from environment variables, never argv (its own
 * comment: "they must not show up in a process listing"). Nothing proved
 * `startServer(opts)`'s `jwtSecret` field actually reaches that child.
 *
 * It didn't. `server.ts`'s spawn call forwarded only port/databaseUrl/
 * writerToken/writerId — `opts.jwtSecret` and `opts.imageCallbackSecret` were
 * silently discarded, so a real deployment configured via `startServer({...,
 * jwtSecret})` would silently keep running on the legacy static token,
 * despite `ServerOptions` advertising a `jwtSecret` field that looks like it
 * should work. Found by hand while re-proving the instrumentation for the
 * second verify pass; closed by making `server.ts` forward both secrets to
 * the child via `env`, keeping them out of argv as designed.
 */

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> }; writerId: string };

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
      writerToken: 'unused-legacy-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
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

describe('the real child-process server boundary honours a configured JWKS (verify finding #3, second pass)', () => {
  it('VERIFY-03-DEPLOY-01: a request carrying a validly-signed JWT succeeds against the real spawned server, so the JWKS config genuinely reaches the child process, not just the in-process test harness', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Preuve du vrai serveur' }),
    });

    expect(res.status).toBe(201);
  });

  it('VERIFY-03-DEPLOY-02: the legacy static token is refused against the real spawned server once a JWKS is configured, exactly as the in-process check already proved — this is the same regression, verified through the boundary a real deployment actually uses', async () => {
    const { server } = ctx();

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: 'Bearer unused-legacy-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
  });
});
