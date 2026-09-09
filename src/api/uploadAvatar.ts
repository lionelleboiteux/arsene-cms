/**
 * `POST /v1/writers/me/avatar` — a writer's own profile photo.
 *
 * Deliberately much simpler than `uploadImage.ts`, which this otherwise
 * mirrors (same `sniffImageFormat`/`isDamagedContainer`/`MAX_UPLOAD_BYTES`
 * checks, same "store the original, return `201 processing` immediately,
 * ADR-0004's Lambda converts asynchronously" shape): there is no draft
 * lock to check, no cover/body role, no alt text to derive from an
 * article's own content, and no `Idempotency-Key` requirement — this
 * isn't part of the locked-draft editing session, and an accidental
 * double-submit here just creates one extra `writer_avatars` row rather
 * than risking a lost edit.
 */

import { sniffImageFormat, isDamagedContainer } from '../images/format.ts';
import { MAX_UPLOAD_BYTES } from '../images/optimize.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';

export type UploadAvatarRequest = {
  authorization: string | null;
  file: { filename: string; content_type: string; bytes: Uint8Array };
};

export type UploadAvatarDeps = {
  auth: {
    verifyBearer(token: string | null): Promise<{ valid: boolean; writer_id?: string }>;
  };
  repo: {
    insertAvatar(input: {
      id: string;
      writer_id: string;
      status: 'processing' | 'failed';
      original_filename: string;
      original_url: string | null;
      failure: { code: string; message: string } | null;
    }): Promise<{ id: string; created_at: Date }>;
  };
  storage: { put(key: string, bytes: Uint8Array): Promise<{ url: string }> };
  observability: {
    record(entry: {
      event: string;
      outcome: 'success' | 'failure';
      details?: Record<string, unknown>;
    }): void;
  };
};

export async function handleUploadAvatar(
  req: UploadAvatarRequest,
  deps: UploadAvatarDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid || auth.writer_id === undefined) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  if (req.file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    return errorResponse(413, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.', {
      max_bytes: MAX_UPLOAD_BYTES,
      received_bytes: req.file.bytes.byteLength,
    });
  }

  const format = sniffImageFormat(req.file.bytes);
  if (format === null) {
    deps.observability.record({
      event: 'image_optimization',
      outcome: 'failure',
      details: { writer_id: auth.writer_id, code: 'UNSUPPORTED_FORMAT' },
    });
    return errorResponse(
      422,
      'UNSUPPORTED_FORMAT',
      `${req.file.filename} could not be recognised as a supported image format.`,
      { detected_content_type: 'application/octet-stream' },
    );
  }

  const id = crypto.randomUUID();

  if (isDamagedContainer(req.file.bytes, format)) {
    const row = await deps.repo.insertAvatar({
      id,
      writer_id: auth.writer_id,
      status: 'failed',
      original_filename: req.file.filename,
      original_url: null,
      failure: {
        code: 'CORRUPTED_FILE',
        message: `${req.file.filename} passed format detection but could not be decoded.`,
      },
    });
    return {
      status: 201,
      body: {
        id,
        status: 'failed',
        avatar_url: null,
        failure: {
          code: 'CORRUPTED_FILE',
          message: `${req.file.filename} passed format detection but could not be decoded.`,
        },
        created_at: row.created_at.toISOString(),
      },
    };
  }

  const original = await deps.storage.put(`${id}-original-${req.file.filename}`, req.file.bytes);
  const row = await deps.repo.insertAvatar({
    id,
    writer_id: auth.writer_id,
    status: 'processing',
    original_filename: req.file.filename,
    original_url: original.url,
    failure: null,
  });

  return {
    status: 201,
    body: {
      id,
      status: 'processing',
      avatar_url: null,
      failure: null,
      created_at: row.created_at.toISOString(),
    },
  };
}
