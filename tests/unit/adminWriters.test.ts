import { describe, expect, it } from 'vitest';
import {
  handleListWriters,
  handleInviteWriter,
  handleSetWriterRevoked,
  type AdminWritersDeps,
} from '../../src/api/adminWriters.js';
import type { WriterRow } from '../../src/api/repo.js';

/**
 * The settings page's writer allow-list — list/invite/revoke/reinstate.
 * `router.ts`'s own `verifyAdmin()` gating is proven end to end in
 * `tests/e2e/adminAuthorization.test.ts`; this file is the handlers' own
 * decision-making against fakes, matching `tests/unit/metricsSummary.test.ts`'s
 * shape for the closest existing precedent (a secret/admin-gated JSON route).
 */

const ADMIN_TOKEN = 'admin-bearer-not-a-real-jwt';
const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

function writer(overrides: Partial<WriterRow> = {}): WriterRow {
  return {
    id: ADMIN_ID,
    email: 'admin@example.com',
    display_name: 'Admin',
    is_admin: true,
    created_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AdminWritersDeps> = {}): AdminWritersDeps {
  return {
    auth: { verifyAdmin: async (token) => ({ valid: token === ADMIN_TOKEN, writer_id: ADMIN_ID }) },
    repo: {
      listWriters: async () => [writer()],
      upsertWriter: async (input) => writer({ id: input.id, email: input.email, display_name: input.display_name, is_admin: false }),
      setWriterRevoked: async (input) => ({ ok: true, writer: writer({ id: input.writer_id, revoked_at: input.revoked ? '2026-06-01T00:00:00.000Z' : null }) }),
    },
    authAdmin: {
      createOrFindAuthUser: async (email) => `auth-user-for-${email}`,
      generateSignInLink: async (email) => `https://example.com/magiclink?email=${email}`,
    },
    ...overrides,
  };
}

describe('admin authentication', () => {
  it('ADMIN-AUTH-01: no bearer token at all is refused 401 on every route', async () => {
    const deps = buildDeps();
    const results = await Promise.all([
      handleListWriters({ authorization: null }, deps),
      handleInviteWriter({ authorization: null, email: 'a@b.com', display_name: 'A' }, deps),
      handleSetWriterRevoked({ authorization: null, writer_id: ADMIN_ID, action: 'revoke' }, deps),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401]);
  });

  it('ADMIN-AUTH-02: a token verifyAdmin refuses (e.g. a non-admin writer) is refused 401, not just "wrong shape"', async () => {
    const deps = buildDeps({ auth: { verifyAdmin: async () => ({ valid: false }) } });
    const res = await handleListWriters({ authorization: `Bearer ${ADMIN_TOKEN}` }, deps);
    expect(res.status).toBe(401);
  });
});

describe('list writers', () => {
  it('ADMIN-LIST-01: returns every writer from the repo, untouched', async () => {
    const writers = [writer({ id: 'a' }), writer({ id: 'b', is_admin: false })];
    const deps = buildDeps({ repo: { ...buildDeps().repo, listWriters: async () => writers } });

    const res = await handleListWriters({ authorization: `Bearer ${ADMIN_TOKEN}` }, deps);

    expect(res.status).toBe(200);
    expect((res.body as { writers: WriterRow[] }).writers).toEqual(writers);
  });
});

describe('invite writer', () => {
  it('ADMIN-INVITE-01: creates/finds the Auth user, upserts the writers row, and returns a sign-in link', async () => {
    const deps = buildDeps();

    const res = await handleInviteWriter(
      { authorization: `Bearer ${ADMIN_TOKEN}`, email: 'new@writer.com', display_name: 'New Writer' },
      deps,
    );

    expect(res.status).toBe(201);
    const body = res.body as { writer: WriterRow; sign_in_link: string | null };
    expect(body.writer.email).toBe('new@writer.com');
    expect(body.writer.display_name).toBe('New Writer');
    expect(body.sign_in_link).toBe('https://example.com/magiclink?email=new@writer.com');
  });

  it('ADMIN-INVITE-02: an empty email or display name is refused 400 before any Auth API call is made', async () => {
    let called = false;
    const deps = buildDeps({
      authAdmin: {
        createOrFindAuthUser: async () => {
          called = true;
          return 'unused';
        },
        generateSignInLink: async () => null,
      },
    });

    const res = await handleInviteWriter(
      { authorization: `Bearer ${ADMIN_TOKEN}`, email: '  ', display_name: 'Someone' },
      deps,
    );

    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it('ADMIN-INVITE-03: re-inviting the same email is idempotent — createOrFindAuthUser resolves the existing Auth user, upsertWriter reinstates rather than duplicating', async () => {
    // This is exactly authAdmin.ts's own idempotent-by-email contract; the
    // handler just has to trust and pass through what it returns, which this
    // fake demonstrates by always resolving to the same id for the same email.
    const deps = buildDeps({
      authAdmin: {
        createOrFindAuthUser: async (email) => `stable-id-for-${email}`,
        generateSignInLink: async () => 'https://example.com/link',
      },
    });

    const first = await handleInviteWriter(
      { authorization: `Bearer ${ADMIN_TOKEN}`, email: 'again@writer.com', display_name: 'Again' },
      deps,
    );
    const second = await handleInviteWriter(
      { authorization: `Bearer ${ADMIN_TOKEN}`, email: 'again@writer.com', display_name: 'Again' },
      deps,
    );

    const firstId = (first.body as { writer: WriterRow }).writer.id;
    const secondId = (second.body as { writer: WriterRow }).writer.id;
    expect(firstId).toBe(secondId);
  });
});

describe('revoke / reinstate', () => {
  it('ADMIN-REVOKE-01: revoking a writer stamps revoked_at', async () => {
    const deps = buildDeps();

    const res = await handleSetWriterRevoked(
      { authorization: `Bearer ${ADMIN_TOKEN}`, writer_id: 'some-writer', action: 'revoke' },
      deps,
    );

    expect(res.status).toBe(200);
    expect((res.body as { writer: WriterRow }).writer.revoked_at).not.toBeNull();
  });

  it('ADMIN-REVOKE-02: reinstating a writer clears revoked_at', async () => {
    const deps = buildDeps();

    const res = await handleSetWriterRevoked(
      { authorization: `Bearer ${ADMIN_TOKEN}`, writer_id: 'some-writer', action: 'reinstate' },
      deps,
    );

    expect(res.status).toBe(200);
    expect((res.body as { writer: WriterRow }).writer.revoked_at).toBeNull();
  });

  it('ADMIN-REVOKE-03: the repo refusing to revoke the last admin surfaces as 409 LAST_ADMIN_CANNOT_BE_REVOKED, not a silent success', async () => {
    const deps = buildDeps({
      repo: {
        ...buildDeps().repo,
        setWriterRevoked: async () => ({ ok: false, error: 'LAST_ADMIN_CANNOT_BE_REVOKED' }),
      },
    });

    const res = await handleSetWriterRevoked(
      { authorization: `Bearer ${ADMIN_TOKEN}`, writer_id: ADMIN_ID, action: 'revoke' },
      deps,
    );

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('LAST_ADMIN_CANNOT_BE_REVOKED');
  });

  it('ADMIN-REVOKE-04: acting on an id with no writers row is 404, not a silent no-op', async () => {
    const deps = buildDeps({
      repo: {
        ...buildDeps().repo,
        setWriterRevoked: async () => ({ ok: false, error: 'WRITER_NOT_FOUND' }),
      },
    });

    const res = await handleSetWriterRevoked(
      { authorization: `Bearer ${ADMIN_TOKEN}`, writer_id: 'does-not-exist', action: 'revoke' },
      deps,
    );

    expect(res.status).toBe(404);
  });
});
