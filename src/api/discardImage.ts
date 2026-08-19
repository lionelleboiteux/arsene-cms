/**
 * `DELETE /v1/articles/{articleId}/images/{imageId}` — the writer's way out of
 * an image row their article can never be published with.
 *
 * `05-verification.v7.md` §4: an image the product *adopted* (its original
 * really stored, so `original_url` is set) and then failed to convert blocks
 * `POST .../publish` with `409 IMAGE_NOT_READY` forever, because
 * `publishArticle.ts`'s `articleDependsOn()` correctly goes on treating it as
 * in use. Migration `0004` closed the only recovery a writer had — re-tagging
 * `role` through PostgREST — because that same grant was the M-V6-02 bypass.
 * The two were one mechanism seen from two directions, so the recovery has to
 * come back as a server-side seam instead of a column grant.
 *
 * **The one restriction, and why it is the whole safety argument.** Only a row
 * that is not `ready` may be discarded. A not-`ready` row is by definition not
 * something the article can currently be published with, so discarding it can
 * never be a way around `IMAGE_NOT_READY`: the article's live cover and any
 * `ready` body image its `body_html` embeds are exactly the rows this refuses
 * (`AC-08-recovery-11`). That is `05-verification.v7.md` §4.3's own
 * recommendation, and it is strictly stronger than "not the usable cover, and
 * not embedded in body_html" — it needs no second definition of "still needed"
 * beside `articleDependsOn()`'s, which is what let M-V5-03 and M-V6-02 through.
 *
 * The route runs as `service_role` like every other write seam here
 * (`markPublished`, `insertDraft`, `takeLock`); no new PostgREST grant is
 * added, so a writer cannot reach `article_images` around this check.
 */

import { evaluateLock } from '../domain/lock.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import type { ArticleRecord, ImageRecord } from './publishArticle.ts';

export type DiscardImageRequest = {
  article_id: string;
  image_id: string;
  authorization: string | null;
};

export type DiscardImageDeps = {
  now(): Date;
  auth: {
    verifyBearer(token: string | null): Promise<{ valid: boolean; writer_id?: string }>;
  };
  repo: {
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    getArticleImages(article_id: string): Promise<ImageRecord[]>;
    /** Compare-and-swap on `status`: a row that became `ready` meanwhile stays. */
    deleteImage(input: { image_id: string; article_id: string }): Promise<boolean>;
    getWriterDisplayName(writer_id: string): Promise<string>;
  };
};

const stillNeeded = (image: ImageRecord): boolean => image.status === 'ready';

export async function handleDiscardImage(
  req: DiscardImageRequest,
  deps: DiscardImageDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid || auth.writer_id === undefined) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  const article = await deps.repo.getArticle(req.article_id);
  if (article === null) {
    return errorResponse(404, 'NOT_FOUND', 'No article was found matching the given id.', {
      article_id: req.article_id,
    });
  }

  // M-V4-02: the draft lock is a property of the draft, not of one route — a
  // writer refused `409 DRAFT_LOCKED` on publish and on upload must not be able
  // to delete a colleague's in-flight image through here either.
  const lock = evaluateLock({
    now: deps.now(),
    lock: {
      locked_by: article.locked_by,
      locked_at: article.locked_at,
      locked_by_display_name: null,
    },
    requesting_writer_id: auth.writer_id,
  });
  if (!lock.editable) {
    return errorResponse(409, 'DRAFT_LOCKED', 'This draft is currently locked by another writer.', {
      locked_by_writer_id: lock.locked_by_writer_id,
      locked_by_display_name: await deps.repo.getWriterDisplayName(lock.locked_by_writer_id),
    });
  }

  const image = (await deps.repo.getArticleImages(article.id)).find(
    (candidate) => candidate.id === req.image_id,
  );
  if (image === undefined) {
    return errorResponse(404, 'NOT_FOUND', 'No image of this article was found matching that id.', {
      article_id: article.id,
      image_id: req.image_id,
    });
  }
  if (stillNeeded(image)) {
    return errorResponse(
      409,
      'CONFLICT',
      'A ready image cannot be discarded: the article may still be published with it.',
      { image_id: image.id, role: image.role, status: image.status },
    );
  }

  const discarded = await deps.repo.deleteImage({
    image_id: image.id,
    article_id: article.id,
  });
  if (!discarded) {
    return errorResponse(
      409,
      'CONFLICT',
      'This image became ready before it could be discarded.',
      { image_id: image.id },
    );
  }

  return {
    status: 200,
    body: { article_id: article.id, image_id: image.id, discarded: true },
  };
}
