/**
 * `POST /v1/articles/{articleId}/images` — the place cover uniqueness is
 * decided (AC-06), and the place an upload is admitted to the asynchronous
 * conversion pipeline.
 *
 * ADR-0004: this request stores the original and returns `201` with
 * `status: processing` immediately. It never decodes anything — the conversion
 * runs in Lambda (`src/images/lambdaHandler.ts`) and reports back through
 * `POST /internal/images/{imageId}/status`, so no writer upload can exceed the
 * Edge Function's CPU budget (verify finding #5). What stays here is what is
 * cheap and must be answered now: the size limit, the container sniff, cover
 * uniqueness, and the alt text the article's own text already determines.
 */

import { generateAltText, htmlToText } from '../domain/seo.ts';
import { sniffImageFormat, isDamagedContainer } from '../images/format.ts';
import { MAX_UPLOAD_BYTES } from '../images/optimize.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import type { RateLimiter } from './rateLimit.ts';
import type { ArticleRecord, ImageRecord } from './publishArticle.ts';

export type UploadImageRequest = {
  article_id: string;
  authorization: string | null;
  idempotency_key: string | null;
  client_ip: string;
  role: 'cover' | 'body';
  file: { filename: string; content_type: string; bytes: Uint8Array };
};

export type UploadDeps = {
  now(): Date;
  auth: {
    verifyBearer(
      token: string | null,
    ): Promise<{ valid: boolean; writer_id?: string; display_name?: string }>;
  };
  repo: {
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    getArticleImages(article_id: string): Promise<ImageRecord[]>;
    insertImage(input: {
      id: string;
      article_id: string;
      role: 'cover' | 'body';
      status: 'processing' | 'failed';
      original_filename: string;
      alt_text: string | null;
      original_url: string | null;
      optimized_url: string | null;
      failure: { code: string; message: string } | null;
      replaced_cover_image_id: string | null;
    }): Promise<{ id: string; created_at: Date }>;
    demoteCurrentCover(article_id: string): Promise<string | null>;
  };
  storage: { put(key: string, bytes: Uint8Array): Promise<{ url: string }> };
  rateLimiter: RateLimiter;
  idempotency: {
    lookup(key: string, article_id: string): HandlerResponse | null;
    store(key: string, article_id: string, response: HandlerResponse): void;
  };
  observability: {
    record(entry: {
      event: string;
      outcome: 'success' | 'failure';
      details?: Record<string, unknown>;
    }): void;
  };
};

export async function handleUploadImage(
  req: UploadImageRequest,
  deps: UploadDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }
  if (req.idempotency_key === null) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: [{ field: 'Idempotency-Key', message: 'is required on this operation' }],
    });
  }

  const article = await deps.repo.getArticle(req.article_id);
  if (article === null) {
    return errorResponse(404, 'NOT_FOUND', 'No article was found matching the given id.', {
      article_id: req.article_id,
    });
  }

  const replay = deps.idempotency.lookup(req.idempotency_key, req.article_id);
  if (replay !== null) return replay;

  // Checked once the article is known to exist, so the budget protects the
  // upload path itself rather than 404 lookups (as on publish).
  const rate = deps.rateLimiter.check(`upload:${req.client_ip}`, deps.now());
  if (!rate.allowed) {
    return errorResponse(429, 'CONFLICT', `More than ${rate.limit} uploads per minute.`);
  }

  if (req.file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    return errorResponse(413, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.', {
      max_bytes: MAX_UPLOAD_BYTES,
      received_bytes: req.file.bytes.byteLength,
    });
  }

  const response = await createImage(req, article, deps);
  deps.idempotency.store(req.idempotency_key, req.article_id, response);
  return response;
}

async function createImage(
  req: UploadImageRequest,
  article: ArticleRecord,
  deps: UploadDeps,
): Promise<HandlerResponse> {
  const format = sniffImageFormat(req.file.bytes);
  if (format === null) {
    // AC-08: an unrecognisable container creates no image row at all, and is
    // never handed to the pipeline.
    deps.observability.record({
      event: 'image_optimization',
      outcome: 'failure',
      details: { article_id: article.id, code: 'UNSUPPORTED_FORMAT' },
    });
    return errorResponse(
      422,
      'UNSUPPORTED_FORMAT',
      `${req.file.filename} could not be recognised as a supported image format.`,
      { detected_content_type: 'application/octet-stream' },
    );
  }

  const id = crypto.randomUUID();
  const replaced_cover_image_id =
    req.role === 'cover' ? await deps.repo.demoteCurrentCover(article.id) : null;

  if (isDamagedContainer(req.file.bytes, format)) {
    // AC-08: the row exists and says why, so the writer is told to replace it
    // and the publish endpoint refuses the article until they do. Nothing is
    // stored: a truncated file has nothing worth converting.
    return insert(id, req, deps, {
      status: 'failed',
      alt_text: null,
      original_url: null,
      failure: {
        code: 'CORRUPTED_FILE',
        message: `${req.file.filename} passed format detection but could not be decoded.`,
      },
      replaced_cover_image_id,
    });
  }

  // AC-15: alt text comes from the article's own words, not from the pixels, so
  // it is ready the moment conversion completes rather than computed later.
  const original = await deps.storage.put(`${id}-original-${req.file.filename}`, req.file.bytes);
  return insert(id, req, deps, {
    status: 'processing',
    alt_text: generateAltText({
      article_title: article.title,
      body_text: htmlToText(article.body_html),
      original_filename: req.file.filename,
    }),
    original_url: original.url,
    failure: null,
    replaced_cover_image_id,
  });
}

type ImageState = {
  status: 'processing' | 'failed';
  alt_text: string | null;
  original_url: string | null;
  failure: { code: string; message: string } | null;
  replaced_cover_image_id: string | null;
};

/** Always 201: `status` carries the real state (contract, "Always `201`"). */
async function insert(
  id: string,
  req: UploadImageRequest,
  deps: UploadDeps,
  state: ImageState,
): Promise<HandlerResponse> {
  const row = await deps.repo.insertImage({
    id,
    article_id: req.article_id,
    role: req.role,
    original_filename: req.file.filename,
    optimized_url: null,
    ...state,
  });
  return {
    status: 201,
    body: {
      id,
      article_id: req.article_id,
      role: req.role,
      status: state.status,
      original_filename: req.file.filename,
      // Both withheld until the row is `ready` (contract: "`null` until then"),
      // whatever is already stored on the row.
      alt_text: null,
      urls: null,
      failure: state.failure,
      replaced_cover_image_id: state.replaced_cover_image_id,
      created_at: row.created_at.toISOString(),
    },
  };
}
