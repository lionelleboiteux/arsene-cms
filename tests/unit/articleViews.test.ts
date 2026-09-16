import { describe, expect, it } from 'vitest';
import { handleGetArticleViews, type ArticleViewsDeps } from '../../src/api/articleViews.js';

/**
 * `GET /v1/articles/views` — the writer home page's per-article view
 * counts. Same plain `verifyBearer` gate as `tests/unit/writers.test.ts`,
 * not admin-only.
 */

const WRITER_TOKEN = 'writer-bearer-not-a-real-jwt';
const WRITER_ID = '22222222-2222-2222-2222-222222222222';

function buildDeps(overrides: Partial<ArticleViewsDeps> = {}): ArticleViewsDeps {
  return {
    auth: { verifyBearer: async (token) => ({ valid: token === WRITER_TOKEN, writer_id: WRITER_ID }) },
    repo: {
      getAllArticleViewCounts: async () => [
        { article_id: 'a', views: 12 },
        { article_id: 'b', views: 3 },
      ],
    },
    ...overrides,
  };
}

describe('get article views', () => {
  it('ARTICLE-VIEWS-AUTH-01: no bearer token at all is refused 401', async () => {
    const res = await handleGetArticleViews({ authorization: null }, buildDeps());
    expect(res.status).toBe(401);
  });

  it('ARTICLE-VIEWS-AUTH-02: a token verifyBearer refuses is refused 401', async () => {
    const deps = buildDeps({ auth: { verifyBearer: async () => ({ valid: false }) } });
    const res = await handleGetArticleViews({ authorization: `Bearer ${WRITER_TOKEN}` }, deps);
    expect(res.status).toBe(401);
  });

  it('ARTICLE-VIEWS-01: any active writer\'s valid token returns every article with at least one view', async () => {
    const res = await handleGetArticleViews({ authorization: `Bearer ${WRITER_TOKEN}` }, buildDeps());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      views: [
        { article_id: 'a', views: 12 },
        { article_id: 'b', views: 3 },
      ],
    });
  });
});
