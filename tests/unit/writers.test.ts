import { describe, expect, it } from 'vitest';
import { handleListActiveWriters, handleGetOwnWriter, type WritersDeps } from '../../src/api/writers.js';

/**
 * The co-author picker's own writer list — `GET /v1/writers` — and the
 * caller's own row — `GET /v1/writers/me`, the avatar-onboarding gate's
 * read (`app.tsx`). Deliberately separate from
 * `tests/unit/adminWriters.test.ts` (`handleListWriters`, admin-only, full
 * `WriterRow`): both routes here are gated by plain `verifyBearer` (any
 * active writer, `router.ts`'s default auth chain), and return only
 * `{id, display_name}` shapes, never the admin fields.
 */

const WRITER_TOKEN = 'writer-bearer-not-a-real-jwt';
const WRITER_ID = '22222222-2222-2222-2222-222222222222';

function buildDeps(overrides: Partial<WritersDeps> = {}): WritersDeps {
  return {
    auth: { verifyBearer: async (token) => ({ valid: token === WRITER_TOKEN, writer_id: WRITER_ID }) },
    repo: {
      listActiveWriters: async () => [
        { id: 'a', display_name: 'Alice Dupont' },
        { id: 'b', display_name: 'Bob Martin' },
      ],
      getWriterDisplayName: async () => 'Alice Dupont',
      getWriterAvatarUrl: async () => null,
    },
    ...overrides,
  };
}

describe('list active writers', () => {
  it('WRITERS-AUTH-01: no bearer token at all is refused 401', async () => {
    const res = await handleListActiveWriters({ authorization: null }, buildDeps());
    expect(res.status).toBe(401);
  });

  it('WRITERS-AUTH-02: a token verifyBearer refuses is refused 401 — no admin gate, but still not anonymous', async () => {
    const deps = buildDeps({ auth: { verifyBearer: async () => ({ valid: false }) } });
    const res = await handleListActiveWriters({ authorization: `Bearer ${WRITER_TOKEN}` }, deps);
    expect(res.status).toBe(401);
  });

  it('WRITERS-LIST-01: any active writer\'s valid token returns every active writer from the repo, trimmed to id/display_name only', async () => {
    const res = await handleListActiveWriters({ authorization: `Bearer ${WRITER_TOKEN}` }, buildDeps());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      writers: [
        { id: 'a', display_name: 'Alice Dupont' },
        { id: 'b', display_name: 'Bob Martin' },
      ],
    });
  });
});

describe('get own writer', () => {
  it('WRITERS-ME-AUTH-01: no bearer token at all is refused 401', async () => {
    const res = await handleGetOwnWriter({ authorization: null }, buildDeps());
    expect(res.status).toBe(401);
  });

  it('WRITERS-ME-01: a valid token returns the caller\'s own id, display name and avatar_url — null when they have none yet', async () => {
    const res = await handleGetOwnWriter({ authorization: `Bearer ${WRITER_TOKEN}` }, buildDeps());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: WRITER_ID, display_name: 'Alice Dupont', avatar_url: null });
  });

  it('WRITERS-ME-02: once the writer has a ready avatar, its optimized_url comes back as avatar_url', async () => {
    const deps = buildDeps({
      repo: {
        listActiveWriters: async () => [],
        getWriterDisplayName: async () => 'Alice Dupont',
        getWriterAvatarUrl: async () => 'https://cdn.fantasycoach.example/optimized/avatar123.webp',
      },
    });

    const res = await handleGetOwnWriter({ authorization: `Bearer ${WRITER_TOKEN}` }, deps);

    expect((res.body as { avatar_url: string | null }).avatar_url).toBe(
      'https://cdn.fantasycoach.example/optimized/avatar123.webp',
    );
  });
});
