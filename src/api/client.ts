/**
 * The editor SPA's typed client for Arsène's own five Edge Function
 * endpoints. Errors are surfaced as a branchable `code`
 * (contracts/openapi.yaml, "Error envelope"): the editor renders
 * COVER_IMAGE_REQUIRED, DRAFT_LOCKED and IMAGE_NOT_READY very differently,
 * and must never branch on wording.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export class ArseneApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** The error envelope's own `details` — e.g. `DRAFT_LOCKED`'s
   *  `locked_by_writer_id`/`locked_by_display_name` — shape varies by `code`
   *  (contracts/openapi.yaml, per-operation `409`/`400` examples). */
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details: unknown = null) {
    super(message);
    this.name = 'ArseneApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type ArseneClient = {
  createDraft(args?: { title?: string; league_name?: string; type_name?: string }): Promise<unknown>;
  openDraft(args: { articleId: string }): Promise<unknown>;
  publishArticle(args: {
    articleId: string;
    meta_title?: string;
    meta_description?: string;
    idempotencyKey?: string;
  }): Promise<unknown>;
  uploadArticleImage(args: {
    articleId: string;
    idempotencyKey: string;
    role: 'cover' | 'body';
    file: { filename: string; content_type: string; bytes: Uint8Array };
  }): Promise<unknown>;
  discardImage(args: { articleId: string; imageId: string }): Promise<unknown>;
  /** Admin-only (`router.ts`'s `verifyAdmin`) — the settings page's writer
   *  allow-list. A non-admin caller gets the same `401 UNAUTHORIZED` shape
   *  every other refusal in this client already throws as `ArseneApiError`. */
  listWriters(): Promise<unknown>;
  inviteWriter(args: { email: string; display_name: string }): Promise<unknown>;
  setWriterRevoked(args: { writerId: string; action: 'revoke' | 'reinstate' }): Promise<unknown>;
  /** Admin-only, drafts only — the home page's "unneeded drafts and tests"
   *  cleanup action. A published article is refused `409 CONFLICT`. */
  deleteArticle(args: { articleId: string }): Promise<unknown>;
};

function errorFrom(status: number, payload: unknown): ArseneApiError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const message = typeof error?.message === 'string' ? error.message : `HTTP ${status}`;
  return new ArseneApiError(code, message, status, error?.details ?? null);
}

async function parse(response: Response): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw errorFrom(response.status, payload);
  return payload;
}

export function createArseneClient(opts: {
  baseUrl: string;
  bearerToken?: string;
  headers?: Record<string, string>;
}): ArseneClient {
  const headers = (extra: Record<string, string>): Record<string, string> => ({
    ...(opts.bearerToken === undefined ? {} : { authorization: `Bearer ${opts.bearerToken}` }),
    ...opts.headers,
    ...extra,
  });

  return {
    async createDraft(args = {}) {
      const response = await fetch(`${opts.baseUrl}/v1/articles`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },

    async openDraft(args) {
      const response = await fetch(`${opts.baseUrl}/v1/articles/${args.articleId}/open`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },

    async publishArticle(args) {
      const response = await fetch(`${opts.baseUrl}/v1/articles/${args.articleId}/publish`, {
        method: 'POST',
        headers: headers({
          'content-type': 'application/json',
          ...(args.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': args.idempotencyKey }),
        }),
        body: JSON.stringify({
          ...(args.meta_title === undefined ? {} : { meta_title: args.meta_title }),
          ...(args.meta_description === undefined
            ? {}
            : { meta_description: args.meta_description }),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },

    async uploadArticleImage(args) {
      const form = new FormData();
      form.set('role', args.role);
      form.set(
        'file',
        new Blob([args.file.bytes as unknown as BlobPart], { type: args.file.content_type }),
        args.file.filename,
      );
      const response = await fetch(`${opts.baseUrl}/v1/articles/${args.articleId}/images`, {
        method: 'POST',
        headers: headers({ 'idempotency-key': args.idempotencyKey }),
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },

    async discardImage(args) {
      const response = await fetch(
        `${opts.baseUrl}/v1/articles/${args.articleId}/images/${args.imageId}`,
        { method: 'DELETE', headers: headers({}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      return parse(response);
    },

    async listWriters() {
      const response = await fetch(`${opts.baseUrl}/v1/admin/writers`, {
        headers: headers({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },

    async inviteWriter(args) {
      const response = await fetch(`${opts.baseUrl}/v1/admin/writers/invite`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ email: args.email, display_name: args.display_name }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },

    async setWriterRevoked(args) {
      const response = await fetch(
        `${opts.baseUrl}/v1/admin/writers/${args.writerId}/${args.action}`,
        {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: '{}',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      return parse(response);
    },

    async deleteArticle(args) {
      const response = await fetch(`${opts.baseUrl}/v1/admin/articles/${args.articleId}`, {
        method: 'DELETE',
        headers: headers({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parse(response);
    },
  };
}
