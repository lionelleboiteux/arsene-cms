/**
 * `POST /internal/images/{imageId}/status` — ADR-0004's Lambda-to-Arsène
 * callback (contracts/internal-openapi.yaml).
 *
 * Lambda is not a writer, so this endpoint takes its own shared secret rather
 * than a writer bearer token, and it can do exactly one thing: move the one
 * `article_images` row it names out of `processing`. A replayed or forged
 * callback for a settled row changes nothing — the compare-and-swap lives in
 * the database, this handler only refuses early and reports why.
 */

import { verifySharedSecret } from './auth.ts';
import { errorResponse, type HandlerResponse } from './http.ts';

/** Either owner shares this one callback route (`/internal/images/{id}/
 *  status`) and the same globally-unique `id` space — an article image or
 *  a writer avatar, never both, told apart by which field is present. */
export type ImageStatusRow =
  | { id: string; owner: 'article'; article_id: string; status: 'processing' | 'ready' | 'failed' }
  | { id: string; owner: 'avatar'; writer_id: string; status: 'processing' | 'ready' | 'failed' };

export type ImageFailure = { code: string; message: string };

export type ImageStatusCallbackRequest = {
  image_id: string;
  /** The `x-arsene-image-callback-secret` header, never an Authorization one. */
  callback_secret: string | null;
  body: {
    status: 'ready' | 'failed';
    optimized_url?: string | null;
    failure?: ImageFailure | null;
  };
};

export type ImageStatusDeps = {
  callbackSecret: string;
  repo: {
    getImage(image_id: string): Promise<ImageStatusRow | null>;
    setImageStatus(input: {
      image_id: string;
      status: 'ready' | 'failed';
      optimized_url: string | null;
      failure: ImageFailure | null;
    }): Promise<boolean>;
  };
  observability: {
    record(entry: {
      event: string;
      outcome: 'success' | 'failure';
      details?: Record<string, unknown>;
    }): void;
  };
};

export async function handleImageStatusCallback(
  req: ImageStatusCallbackRequest,
  deps: ImageStatusDeps,
): Promise<HandlerResponse> {
  if (!verifySharedSecret(req.callback_secret, deps.callbackSecret)) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid image-callback secret is required.');
  }

  const row = await deps.repo.getImage(req.image_id);
  if (row === null) {
    return errorResponse(404, 'NOT_FOUND', 'No image was found matching the given id.', {
      image_id: req.image_id,
    });
  }
  if (row.status !== 'processing') {
    return settled(req.image_id, row.status);
  }

  const optimized_url = req.body.optimized_url ?? null;
  const failure = req.body.failure ?? null;
  const applied = await deps.repo.setImageStatus({
    image_id: req.image_id,
    status: req.body.status,
    optimized_url,
    failure,
  });
  // Lost a race with a duplicate delivery: the database, not this read, decides.
  if (!applied) return settled(req.image_id, row.status);

  deps.observability.record({
    event: 'image_optimization',
    outcome: req.body.status === 'ready' ? 'success' : 'failure',
    details:
      row.owner === 'article'
        ? { image_id: req.image_id, article_id: row.article_id }
        : { image_id: req.image_id, writer_id: row.writer_id },
  });
  return {
    status: 200,
    body: {
      image_id: req.image_id,
      status: req.body.status,
      optimized_url,
      failure,
      updated_at: new Date().toISOString(),
    },
  };
}

const settled = (image_id: string, current_status: string): HandlerResponse =>
  errorResponse(409, 'CONFLICT', 'This image has already left "processing".', {
    image_id,
    current_status,
  });
