import { describe, expect, it } from 'vitest';
import { handleDeleteArticle, handleUnpublishArticle, type AdminArticlesDeps } from '../../src/api/adminArticles.js';

/**
 * The home page's admin-only "delete an unneeded draft" action.
 * `router.ts`'s own `verifyAdmin()` gating is proven end to end in
 * `tests/e2e/adminAuthorization.test.ts`; this file is the handler's own
 * decision-making against fakes, matching `tests/unit/adminWriters.test.ts`'s
 * shape for the closest existing precedent.
 */

const ADMIN_TOKEN = 'admin-bearer-not-a-real-jwt';
const ARTICLE_ID = '22222222-2222-2222-2222-222222222222';

function buildDeps(overrides: Partial<AdminArticlesDeps> = {}): AdminArticlesDeps {
  return {
    auth: { verifyAdmin: async (token) => ({ valid: token === ADMIN_TOKEN, writer_id: 'admin-id' }) },
    repo: {
      deleteDraftArticle: async () => 'deleted',
      unpublishArticle: async () => 'unpublished',
    },
    ...overrides,
  };
}

describe('admin authentication', () => {
  it('ADMIN-DELETE-AUTH-01: no bearer token at all is refused 401', async () => {
    const res = await handleDeleteArticle({ authorization: null, article_id: ARTICLE_ID }, buildDeps());
    expect(res.status).toBe(401);
  });

  it('ADMIN-DELETE-AUTH-02: a token verifyAdmin refuses (e.g. a non-admin writer) is refused 401', async () => {
    const deps = buildDeps({ auth: { verifyAdmin: async () => ({ valid: false }) } });
    const res = await handleDeleteArticle({ authorization: `Bearer ${ADMIN_TOKEN}`, article_id: ARTICLE_ID }, deps);
    expect(res.status).toBe(401);
  });

  it('ADMIN-UNPUBLISH-AUTH-01: no bearer token at all is refused 401', async () => {
    const res = await handleUnpublishArticle({ authorization: null, article_id: ARTICLE_ID }, buildDeps());
    expect(res.status).toBe(401);
  });

  it('ADMIN-UNPUBLISH-AUTH-02: a token verifyAdmin refuses (e.g. a non-admin writer) is refused 401', async () => {
    const deps = buildDeps({ auth: { verifyAdmin: async () => ({ valid: false }) } });
    const res = await handleUnpublishArticle(
      { authorization: `Bearer ${ADMIN_TOKEN}`, article_id: ARTICLE_ID },
      deps,
    );
    expect(res.status).toBe(401);
  });
});

describe('delete article', () => {
  it('ADMIN-DELETE-01: a draft is deleted and the response confirms it', async () => {
    const deps = buildDeps();

    const res = await handleDeleteArticle({ authorization: `Bearer ${ADMIN_TOKEN}`, article_id: ARTICLE_ID }, deps);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ article_id: ARTICLE_ID, deleted: true });
  });

  it('ADMIN-DELETE-02: an id with no article row at all is 404, not a silent no-op', async () => {
    const deps = buildDeps({
      repo: { deleteDraftArticle: async () => 'not_found', unpublishArticle: async () => 'unpublished' },
    });

    const res = await handleDeleteArticle(
      { authorization: `Bearer ${ADMIN_TOKEN}`, article_id: 'does-not-exist' },
      deps,
    );

    expect(res.status).toBe(404);
  });

  it('ADMIN-DELETE-03: a published article is refused 409 CONFLICT rather than deleted — publish is a materially bigger action than clearing test clutter', async () => {
    const deps = buildDeps({
      repo: { deleteDraftArticle: async () => 'not_draft', unpublishArticle: async () => 'unpublished' },
    });

    const res = await handleDeleteArticle({ authorization: `Bearer ${ADMIN_TOKEN}`, article_id: ARTICLE_ID }, deps);

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CONFLICT');
  });
});

describe('unpublish article', () => {
  it('ADMIN-UNPUBLISH-01: a published article is unpublished and the response confirms it', async () => {
    const deps = buildDeps();

    const res = await handleUnpublishArticle(
      { authorization: `Bearer ${ADMIN_TOKEN}`, article_id: ARTICLE_ID },
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ article_id: ARTICLE_ID, unpublished: true });
  });

  it('ADMIN-UNPUBLISH-02: an id with no article row at all is 404, not a silent no-op', async () => {
    const deps = buildDeps({
      repo: { deleteDraftArticle: async () => 'deleted', unpublishArticle: async () => 'not_found' },
    });

    const res = await handleUnpublishArticle(
      { authorization: `Bearer ${ADMIN_TOKEN}`, article_id: 'does-not-exist' },
      deps,
    );

    expect(res.status).toBe(404);
  });

  it('ADMIN-UNPUBLISH-03: an article that is already a draft is refused 409 CONFLICT rather than silently no-op\'d', async () => {
    const deps = buildDeps({
      repo: { deleteDraftArticle: async () => 'deleted', unpublishArticle: async () => 'not_published' },
    });

    const res = await handleUnpublishArticle(
      { authorization: `Bearer ${ADMIN_TOKEN}`, article_id: ARTICLE_ID },
      deps,
    );

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CONFLICT');
  });
});
