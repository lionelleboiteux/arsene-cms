import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, bearer, mintSupabaseJwt } from '../support/jwt.js';

/**
 * `/v1/admin/writers` — a writer bearer token alone must never be enough
 * here, only an active *admin* writer's. Mirrors
 * `writerAuthorization.test.ts`'s shape for the closest existing precedent
 * (a signed-but-insufficient token must refuse, uniformly, across every
 * operation this route family exposes), against the real spawned server
 * boundary (`startServer`, a child process) and a real Postgres.
 *
 * The invite route's own Supabase Auth Admin API call is deliberately not
 * exercised here — that would mean either real network access to a Supabase
 * project from this suite, or mocking `fetch`, neither of which this
 * repo's e2e tests do anywhere else. `tests/unit/adminWriters.test.ts`
 * already proves `handleInviteWriter`'s own logic against fakes; what this
 * file proves is specifically the authorization boundary, which list/revoke/
 * reinstate exercise just as well as invite would, with real DB writes.
 */

const STRANGER_SUB = 'd51c050b-6084-4815-bd36-e45ffe7f99b7';

type Ctx = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  adminId: string;
  writerId: string;
  adminToken: string;
  writerToken: string;
  strangerToken: string;
  revokedToken: string;
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
    const adminId = await seedWriter(db.client, 'Admin', { is_admin: true });
    const writerId = await seedWriter(db.client, 'Ordinary Writer', { is_admin: false });
    const revokedId = await seedWriter(db.client, 'Revoked Writer', {
      revoked_at: new Date().toISOString(),
    });
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-legacy-token',
      writerId: adminId,
      jwksJson: TEST_JWKS_JSON,
    });
    started = {
      db,
      server,
      adminId,
      writerId,
      adminToken: await mintSupabaseJwt({ sub: adminId }),
      writerToken: await mintSupabaseJwt({ sub: writerId }),
      strangerToken: await mintSupabaseJwt({ sub: STRANGER_SUB }),
      revokedToken: await mintSupabaseJwt({ sub: revokedId }),
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

const listWriters = (token: string) =>
  fetch(`${ctx().server.url}/v1/admin/writers`, { headers: { authorization: bearer(token) } });

const revokeAction = (token: string, writer_id: string, action: 'revoke' | 'reinstate') =>
  fetch(`${ctx().server.url}/v1/admin/writers/${writer_id}/${action}`, {
    method: 'POST',
    headers: { authorization: bearer(token), 'content-type': 'application/json' },
    body: '{}',
  });

async function answer(res: Response): Promise<{ status: number; code: string | undefined }> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}

describe('admin authorization: a writer token is not an admin token', () => {
  it('ADMIN-AUTHZ-01: a signature-valid stranger token (no writers row at all) is refused 401 on list and on a revoke action', async () => {
    const { strangerToken, writerId } = ctx();

    expect(await answer(await listWriters(strangerToken))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
    expect(await answer(await revokeAction(strangerToken, writerId, 'revoke'))).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('ADMIN-AUTHZ-02: a revoked writer’s still-valid JWT is refused — revocation removes admin standing exactly like it removes writer standing', async () => {
    const { revokedToken } = ctx();

    expect(await answer(await listWriters(revokedToken))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('ADMIN-AUTHZ-03: an ordinary, fully active writer — a real, valid writer token — is still refused, because writer and admin are different questions', async () => {
    const { writerToken, writerId } = ctx();

    expect(await answer(await listWriters(writerToken))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
    expect(await answer(await revokeAction(writerToken, writerId, 'revoke'))).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('ADMIN-AUTHZ-04: the real admin succeeds on list, and the seeded writers are all present', async () => {
    const { adminToken, adminId, writerId } = ctx();

    const res = await listWriters(adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { writers: Array<{ id: string }> };
    const ids = body.writers.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([adminId, writerId]));
  });

  it('ADMIN-AUTHZ-05: after the admin revokes a writer through this route, that writer’s own still-valid, not-yet-expired JWT is refused end to end on POST /v1/articles — the revoke has to actually cut off access, not just change what GET /v1/admin/writers reports', async () => {
    const { server, adminToken, writerToken, writerId } = ctx();

    const revokeRes = await revokeAction(adminToken, writerId, 'revoke');
    expect(revokeRes.status).toBe(200);

    const createDraftRes = await fetch(`${server.url}/v1/articles`, {
      method: 'POST',
      headers: { authorization: bearer(writerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should be refused' }),
    });
    expect(await answer(createDraftRes)).toEqual({ status: 401, code: 'UNAUTHORIZED' });

    // Reinstate, so this test doesn't leave the fixture writer permanently
    // revoked for whichever test happens to run after it in this file.
    const reinstateRes = await revokeAction(adminToken, writerId, 'reinstate');
    expect(reinstateRes.status).toBe(200);
  });

  it('ADMIN-AUTHZ-06: the admin cannot revoke themselves when they are the only active admin — LAST_ADMIN_CANNOT_BE_REVOKED, not a silent lockout', async () => {
    const { adminToken, adminId } = ctx();

    const res = await revokeAction(adminToken, adminId, 'revoke');

    expect(await answer(res)).toEqual({ status: 409, code: 'LAST_ADMIN_CANNOT_BE_REVOKED' });
  });
});
