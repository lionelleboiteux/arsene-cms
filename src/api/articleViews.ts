/**
 * `GET /v1/articles/views` — per-article view counts for the writer home
 * page (`arsene_article_views`, 0012_article_views.sql). Any active writer
 * may call this, same plain `verify()` gate `writers.ts` uses — view counts
 * are aggregate published-content performance data, not admin-only
 * information. Returns every article with at least one view; an article
 * absent from the list simply has zero.
 */

import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';

export type ArticleViewsDeps = {
  auth: {
    verifyBearer(token: string | null): Promise<{ valid: boolean; writer_id?: string }>;
  };
  repo: {
    getAllArticleViewCounts(): Promise<{ article_id: string; views: number }[]>;
  };
};

export async function handleGetArticleViews(
  req: { authorization: string | null },
  deps: ArticleViewsDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  const views = await deps.repo.getAllArticleViewCounts();
  return { status: 200, body: { views } };
}
