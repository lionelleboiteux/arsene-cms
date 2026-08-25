import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, mintSupabaseJwt } from '../support/jwt.js';

/**
 * Schemathesis fuzzing `POST /v1/articles` found a title containing a NUL
 * byte crashes the request with a raw `500 Internal Server
 * Error`, caught for real against a live deploy (GitHub Actions run
 * 32627585524, 2026-08-23) — the first real production deploy this project
 * ever attempted. Root cause: Postgres text columns cannot store a NUL byte
 * at all (`error: invalid byte sequence for encoding "UTF8": 0x00`, code
 * `22021`), and nothing validated against it before `repo.ts`'s insert, so
 * Postgres's own rejection surfaced as an uncaught exception instead of a
 * clean `400`.
 *
 * Fixed by rejecting a NUL byte in every free-text field these two bodies
 * accept, at the same Zod-validation layer that already rejects other
 * malformed input — before any query, exactly like every other guard in
 * `router.ts`.
 *
 * A real database is needed here, unlike `transportGuards.test.ts`'s
 * unreachable-`databaseUrl` shortcut: these tests use a validly-signed JWT,
 * and `verify()` resolves that JWT's `sub` against `writers` (H-V3-01)
 * *before* `route()` ever reaches the body validation this file is testing
 * — an unauthenticated-only pattern doesn't reach this code path at all.
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
    const { startHttpServer } = await loadApiRouter();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'NUL-byte regression writer');
    const server = await startHttpServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-static-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
    });
    started = { db, server, writerId };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 120_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

describe('a NUL byte in a free-text field is rejected cleanly, never a 500', () => {
  it('NUL-BYTE-01: POST /v1/articles with a NUL byte in title is refused 400 VALIDATION_FAILED, not 500', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `hello${String.fromCharCode(0)}world` }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: unknown[] } } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.fields).toEqual([{ field: 'title', message: 'must not contain a NUL byte' }]);
  });

  it('NUL-BYTE-02: a NUL byte in league_name or type_name is refused the same way', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ league_name: `Ligue${String.fromCharCode(0)}1`, type_name: 'Preview' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('NUL-BYTE-03: POST /v1/articles/{id}/publish with a NUL byte in meta_title or meta_description is refused 400, not 500', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await fetch(`${server.url}/v1/articles/a1a1a1a1-0000-4a2b-9c3d-000000000001/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ meta_title: `Title${String.fromCharCode(0)}Here` }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('NUL-BYTE-04: a title with ordinary Unicode (including astral-plane characters) is unaffected — this guard is specific to NUL, not Unicode in general', async () => {
    const { server, writerId } = ctx();
    const token = await mintSupabaseJwt({ sub: writerId });

    const res = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ligue 1 preview 🏆 — Ünïcödé tëst' }),
    });

    // This input passes validation and is never rejected as 400 — the
    // create-draft flow succeeds normally, the point of this test.
    expect(res.status).toBe(201);
  });
});
