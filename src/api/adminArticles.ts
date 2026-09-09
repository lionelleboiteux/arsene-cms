/**
 * `/v1/admin/articles/{articleId}/delete` — the home page's admin-only
 * cleanup of an unneeded draft. Admin-only (`router.ts`'s `verifyAdmin`,
 * checked both there before dispatch and again here via
 * `deps.auth.verifyAdmin`, the same double-check shape `adminWriters.ts`
 * already uses — handlers stay independently testable/callable without
 * relying on `route()`'s own gating).
 *
 * Drafts only, deliberately: a published article has a live public URL,
 * JSON-LD and a sitemap entry, so deleting one is a materially bigger,
 * more consequential action than clearing test clutter — out of scope here.
 */

import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';

export type AdminArticlesDeps = {
  auth: {
    verifyAdmin(token: string | null): Promise<{ valid: boolean; writer_id?: string }>;
  };
  repo: {
    deleteDraftArticle(article_id: string): Promise<'deleted' | 'not_found' | 'not_draft'>;
    unpublishArticle(article_id: string): Promise<'unpublished' | 'not_found' | 'not_published'>;
  };
};

export type DeleteArticleRequest = {
  authorization: string | null;
  article_id: string;
};

export async function handleDeleteArticle(
  req: DeleteArticleRequest,
  deps: AdminArticlesDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyAdmin(bearerToken(req.authorization));
  if (!auth.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid admin bearer token is required.');
  }

  const result = await deps.repo.deleteDraftArticle(req.article_id);

  if (result === 'not_found') {
    return errorResponse(404, 'NOT_FOUND', 'No article was found matching the given id.', {
      article_id: req.article_id,
    });
  }
  if (result === 'not_draft') {
    return errorResponse(409, 'CONFLICT', 'Only a draft (never published) article can be deleted.', {
      article_id: req.article_id,
    });
  }

  return { status: 200, body: { article_id: req.article_id, deleted: true } };
}

export type UnpublishArticleRequest = {
  authorization: string | null;
  article_id: string;
};

/** Reverses an accidental publish — see `repo.unpublishArticle`'s own doc
 *  comment for why this reuses the plain draft/published state machine
 *  instead of adding a third status. */
export async function handleUnpublishArticle(
  req: UnpublishArticleRequest,
  deps: AdminArticlesDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyAdmin(bearerToken(req.authorization));
  if (!auth.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid admin bearer token is required.');
  }

  const result = await deps.repo.unpublishArticle(req.article_id);

  if (result === 'not_found') {
    return errorResponse(404, 'NOT_FOUND', 'No article was found matching the given id.', {
      article_id: req.article_id,
    });
  }
  if (result === 'not_published') {
    return errorResponse(409, 'CONFLICT', 'Only a published article can be unpublished.', {
      article_id: req.article_id,
    });
  }

  return { status: 200, body: { article_id: req.article_id, unpublished: true } };
}
