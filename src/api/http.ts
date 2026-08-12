/**
 * The one response envelope contracts/openapi.yaml documents ("Error
 * envelope"): consumers branch on `error.code`, never on wording or status
 * alone, so the codes are a closed set here too.
 */

export type HandlerResponse = { status: number; body: Record<string, unknown> };

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'COVER_IMAGE_REQUIRED'
  | 'IMAGE_NOT_READY'
  | 'DRAFT_LOCKED'
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
): HandlerResponse {
  return {
    status,
    body: { error: { code, message, details, request_id: crypto.randomUUID() } },
  };
}

/** `Authorization: Bearer <jwt>` — null when absent or not a bearer scheme. */
export function bearerToken(authorization: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1] ?? null;
}
