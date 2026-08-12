/**
 * `POST /v1/articles/{articleId}/images` — the one place that guarantees no
 * image reaches a writer-visible state without going through format
 * conversion and compression (AC-07), and the place cover uniqueness is
 * decided (AC-06).
 */

import { generateAltText, htmlToText } from '../domain/seo.ts';
import { MAX_UPLOAD_BYTES, type OptimizeResult } from '../images/optimize.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
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
      status: 'processing' | 'ready' | 'failed';
      original_filename: string;
      alt_text: string | null;
      urls: { original: string; optimized: string } | null;
      failure: { code: string; message: string } | null;
      replaced_cover_image_id: string | null;
    }): Promise<{ id: string; created_at: Date }>;
    demoteCurrentCover(article_id: string): Promise<string | null>;
  };
  storage: { put(key: string, bytes: Uint8Array): Promise<{ url: string }> };
  optimizer: {
    optimize(
      bytes: Uint8Array,
      meta: { filename: string; declared_content_type: string },
    ): Promise<OptimizeResult>;
  };
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

  if (req.file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    return errorResponse(413, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.', {
      max_bytes: MAX_UPLOAD_BYTES,
      received_bytes: req.file.bytes.byteLength,
    });
  }

  const optimized = await deps.optimizer.optimize(req.file.bytes, {
    filename: req.file.filename,
    declared_content_type: req.file.content_type,
  });
  const response = await storeImage(req, article, optimized, deps);
  deps.idempotency.store(req.idempotency_key, req.article_id, response);
  return response;
}

async function storeImage(
  req: UploadImageRequest,
  article: ArticleRecord,
  optimized: OptimizeResult,
  deps: UploadDeps,
): Promise<HandlerResponse> {
  if (!optimized.ok && optimized.code === 'UNSUPPORTED_FORMAT') {
    // AC-08: an unrecognisable container creates no image row at all.
    deps.observability.record({
      event: 'image_optimization',
      outcome: 'failure',
      details: { article_id: article.id, code: optimized.code },
    });
    return errorResponse(422, 'UNSUPPORTED_FORMAT', optimized.message, {
      detected_content_type: 'application/octet-stream',
    });
  }

  const id = crypto.randomUUID();
  const replaced_cover_image_id =
    req.role === 'cover' ? await deps.repo.demoteCurrentCover(article.id) : null;

  if (!optimized.ok) {
    // AC-08: the row exists and says why, so the writer is told to replace it
    // and the publish endpoint refuses the article until they do.
    return insert(id, req, deps, {
      status: 'failed',
      alt_text: null,
      urls: null,
      failure: { code: optimized.code, message: optimized.message },
      replaced_cover_image_id,
    });
  }

  const urls = await storeBytes(id, req, optimized, deps);
  const alt_text = generateAltText({
    article_title: article.title,
    body_text: htmlToText(article.body_html),
    original_filename: req.file.filename,
  });
  return insert(id, req, deps, {
    status: 'ready',
    alt_text,
    urls,
    failure: null,
    replaced_cover_image_id,
  });
}

async function storeBytes(
  id: string,
  req: UploadImageRequest,
  optimized: Extract<OptimizeResult, { ok: true }>,
  deps: UploadDeps,
): Promise<{ original: string; optimized: string }> {
  const [original, converted] = await Promise.all([
    deps.storage.put(`${id}-original-${req.file.filename}`, req.file.bytes),
    deps.storage.put(`${id}-optimized.${optimized.format}`, optimized.bytes),
  ]);
  return { original: original.url, optimized: converted.url };
}

type ImageState = {
  status: 'ready' | 'failed';
  alt_text: string | null;
  urls: { original: string; optimized: string } | null;
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
      alt_text: state.alt_text,
      urls: state.urls,
      failure: state.failure,
      replaced_cover_image_id: state.replaced_cover_image_id,
      created_at: row.created_at.toISOString(),
    },
  };
}
