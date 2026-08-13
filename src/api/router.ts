/**
 * The Edge Function router, over a real HTTP port.
 *
 * This is the entry point the provider (Schemathesis) and end-to-end tests
 * drive. It owns transport concerns only — routing, body parsing, auth token
 * comparison, persistence wiring — while every decision stays in the handlers
 * (`publishArticle`, `uploadImage`), which is where the acceptance criteria
 * are asserted.
 */

import http from 'node:http';
import pg from 'pg';
import { z } from 'zod';
import { optimizeImageBuffer } from '../images/lambdaHandler.ts';
import { MAX_UPLOAD_BYTES } from '../images/optimize.ts';
import { createTelemetrySink } from '../telemetry/events.ts';
import { verifySupabaseJwt, verifySharedSecret } from './auth.ts';
import { handleCreateDraft, handleOpenDraft, type CreateDraftDeps } from './createDraft.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import { handleImageStatusCallback } from './imageStatus.ts';
import { handlePublishArticle, type PublishDeps } from './publishArticle.ts';
import { createRateLimiter, PUBLISH_RATE_LIMIT_PER_MINUTE } from './rateLimit.ts';
import { createRepo, type Repo } from './repo.ts';
import { handleUploadImage, type UploadDeps } from './uploadImage.ts';

const ARTICLE_ROUTE = /^\/v1\/articles\/([^/]+)\/(publish|images|open)$/;
const CREATE_DRAFT_ROUTE = '/v1/articles';
const IMAGE_STATUS_ROUTE = /^\/internal\/images\/([^/]+)\/status$/;

/** Assets are served through the CDN, never from Supabase Storage (§4). */
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';

/** A Postgres foreign-key violation: this token's `sub` is not a writer here. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * How long a request gets to finish delivering its body before the server
 * answers `408` and lets the socket go (05-verification.v2.md §5: a body that
 * is declared and then never arrives used to hang on Node's 300-second
 * default). Deliberately short: an anonymous caller must not be able to park
 * connections cheaply. The cost is that a 20 MB upload has to arrive inside
 * this window, so a very slow uplink is refused rather than waited for.
 */
export const DEFAULT_READ_TIMEOUT_MS = 8_000;

const PublishBody = z.object({
  meta_title: z.string().min(1).max(70).optional(),
  meta_description: z.string().min(1).max(160).optional(),
});

/** Every field optional, and no minimum length: the contract defaults an empty
 * title rather than refusing it. */
const CreateDraftBody = z.object({
  title: z.string().optional(),
  league_name: z.string().optional(),
  type_name: z.string().optional(),
});

/**
 * 05-verification.v2.md L2: the callback may only publish assets from the
 * trusted CDN. A real origin comparison, not a prefix test — `startsWith`
 * would accept `https://cdn.fantasycoach.example.attacker.test/…`.
 */
const isCdnUrl = (value: string): boolean => {
  try {
    return new URL(value).origin === CDN_ORIGIN;
  } catch {
    return false;
  }
};

/** contracts/internal-openapi.yaml: `ready` needs a URL, `failed` a reason. */
const ImageStatusBody = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    optimized_url: z.string().min(1).refine(isCdnUrl, `must be a URL on ${CDN_ORIGIN}`),
    failure: z.null().optional(),
  }),
  z.object({
    status: z.literal('failed'),
    optimized_url: z.null().optional(),
    failure: z.object({ code: z.string(), message: z.string() }),
  }),
]);

type RunningServer = { url: string; stop(): Promise<void> };

function send(res: http.ServerResponse, response: HandlerResponse): void {
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response.body));
}

/**
 * `null` once the stream goes past the cap — a chunked body carries no
 * Content-Length to inspect, so the only defence is to stop reading (H2).
 */
async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_UPLOAD_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const tooLarge = (): HandlerResponse =>
  errorResponse(413, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.', {
    max_bytes: MAX_UPLOAD_BYTES,
  });

/** `undefined` for a body that is not JSON — a 400, never a 500. */
function parseJson(raw: Buffer): unknown {
  if (raw.byteLength === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function createIdempotencyStore() {
  const store = new Map<string, HandlerResponse>();
  return {
    lookup: (key: string, article_id: string) => store.get(`${key}::${article_id}`) ?? null,
    store: (key: string, article_id: string, response: HandlerResponse) =>
      void store.set(`${key}::${article_id}`, response),
  };
}

/** Stands in for Supabase Storage: the URL shape is what the site consumes. */
function createObjectStore() {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
      return { url: `${CDN_ORIGIN}/articles/${key}` };
    },
  };
}

const observability = {
  record: (entry: {
    event: string;
    outcome: 'success' | 'failure';
    details?: Record<string, unknown>;
  }) =>
    void process.stderr.write(`${JSON.stringify({ level: 'info', ...entry })}\n`),
};

function publishDeps(ctx: Ctx): PublishDeps {
  const sink = createTelemetrySink();
  return {
    now: () => new Date(),
    auth: { verifyBearer: async (token) => verify(token, ctx) },
    repo: ctx.repo,
    telemetry: sink,
    rateLimiter: ctx.shared.rateLimiter,
    idempotency: ctx.shared.idempotency,
    // traceability.md §7: the Cloudflare purge itself is a deploy concern, so
    // this entry point records the call rather than performing it.
    revalidation: { revalidate: async () => ({ ok: true }) },
    observability,
  };
}

function uploadDeps(ctx: Ctx): UploadDeps {
  return {
    now: () => new Date(),
    auth: { verifyBearer: async (token) => verify(token, ctx) },
    repo: ctx.repo,
    storage: ctx.shared.storage,
    rateLimiter: ctx.shared.rateLimiter,
    idempotency: ctx.shared.idempotency,
    observability,
  };
}

function draftDeps(ctx: Ctx): CreateDraftDeps {
  return {
    now: () => new Date(),
    auth: { verifyBearer: async (token) => verify(token, ctx) },
    repo: ctx.repo,
    telemetry: createTelemetrySink(),
  };
}

/**
 * Verify finding #3: the credential is the caller's own Supabase Auth JWT, so
 * `writer_id` comes from the token rather than from one process-wide constant.
 * The static `writerToken` is a fallback **only** for deployments configured
 * without a JWT secret at all (and the pre-JWT end-to-end suite). Once
 * `jwtSecret` is configured, it is the only accepted credential — a request
 * whose JWT fails to verify is rejected outright, never re-tried against the
 * static secret. A shared secret that still worked in parallel with real
 * per-writer verification would leave finding #3 open in substance while
 * closed in appearance.
 *
 * H-V3-01 (05-verification.v3.md §2): a signature-valid token says who is
 * calling, not that they may write. `service_role` (db/migrations/0002) bypasses
 * the RLS 02-architecture.v1.md §7 named as the only authorization mechanism, so
 * the `sub` is resolved against `writers` here — the one seam every writer-facing
 * route already passes through, before `route()` reads a body or dispatches
 * anything, so no mutation can precede the decision. The legacy static-token
 * branch needs no such lookup: its `writer_id` is deployment configuration, not
 * a claim the caller supplied.
 */
async function verify(
  token: string | null,
  ctx: Ctx,
): Promise<{ valid: boolean; writer_id?: string }> {
  const { opts } = ctx;
  if (opts.jwtSecret !== undefined) {
    const jwt = await verifySupabaseJwt(token, {
      secret: opts.jwtSecret,
      now: new Date(),
      ...(opts.jwtIssuer === undefined ? {} : { issuer: opts.jwtIssuer }),
    });
    if (jwt.writer_id === undefined || !jwt.valid) return { valid: false };
    return (await ctx.repo.isWriter(jwt.writer_id))
      ? { valid: true, writer_id: jwt.writer_id }
      : { valid: false };
  }
  return verifySharedSecret(token, opts.writerToken)
    ? { valid: true, writer_id: opts.writerId }
    : { valid: false };
}

async function publish(
  req: http.IncomingMessage,
  article_id: string,
  raw: Buffer,
  ctx: Ctx,
): Promise<HandlerResponse> {
  const json = parseJson(raw);
  if (json === undefined) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request body is not valid JSON.');
  }
  const parsed = PublishBody.safeParse(json);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const deps = publishDeps(ctx);
  const response = await handlePublishArticle(
    {
      article_id,
      authorization: req.headers.authorization ?? null,
      idempotency_key: header(req, 'idempotency-key'),
      client_ip: req.socket.remoteAddress ?? 'unknown',
      body: parsed.data,
    },
    deps,
  );
  await ctx.repo.recordTelemetry(article_id, deps.telemetry.events);
  return response;
}

async function upload(
  req: http.IncomingMessage,
  article_id: string,
  raw: Buffer,
  ctx: Ctx,
): Promise<HandlerResponse> {
  // Undici's own multipart parser, rather than a hand-rolled one.
  const form = await new Response(new Uint8Array(raw), {
    headers: { 'content-type': req.headers['content-type'] ?? '' },
  })
    .formData()
    .catch(() => null);

  const file = form?.get('file');
  const role = form?.get('role');
  if (!(file instanceof File) || (role !== 'cover' && role !== 'body')) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: [{ field: 'file', message: 'a multipart file and a cover/body role are required' }],
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const response = await handleUploadImage(
    {
      article_id,
      authorization: req.headers.authorization ?? null,
      idempotency_key: header(req, 'idempotency-key'),
      client_ip: req.socket.remoteAddress ?? 'unknown',
      role,
      file: { filename: file.name, content_type: file.type, bytes },
    },
    uploadDeps(ctx),
  );

  if (response.body.status === 'processing') {
    convert(String(response.body.id), { filename: file.name, content_type: file.type, bytes }, ctx);
  }
  return response;
}

/**
 * ADR-0004's S3-event → Lambda → status-callback loop, in one process.
 *
 * The deployed system triggers `optimizeImageBuffer` from an S3 notification
 * and reports the outcome back over `POST /internal/images/{id}/status`; this
 * entry point runs the same conversion and the same compare-and-swap directly,
 * after answering the writer, because it owns both ends. What matters either
 * way is that no conversion happens inside the request.
 */
function convert(
  image_id: string,
  file: { filename: string; content_type: string; bytes: Uint8Array },
  ctx: Ctx,
): void {
  void (async () => {
    const result = await optimizeImageBuffer(file.bytes, {
      filename: file.filename,
      declared_content_type: file.content_type,
    });
    if (!result.ok) {
      await ctx.repo.setImageStatus({
        image_id,
        status: 'failed',
        optimized_url: null,
        failure: { code: result.code, message: result.message },
      });
      return;
    }
    const stored = await ctx.shared.storage.put(
      `${image_id}-optimized.${result.format}`,
      result.bytes,
    );
    await ctx.repo.setImageStatus({
      image_id,
      status: 'ready',
      optimized_url: stored.url,
      failure: null,
    });
  })().catch((err: Error) =>
    observability.record({ event: 'image_optimization', outcome: 'failure', details: { image_id, error: err.message } }),
  );
}

async function createDraft(req: http.IncomingMessage, raw: Buffer, ctx: Ctx): Promise<HandlerResponse> {
  const parsed = CreateDraftBody.safeParse(parseJson(raw));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const deps = draftDeps(ctx);
  const response = await handleCreateDraft(
    {
      authorization: req.headers.authorization ?? null,
      client_ip: req.socket.remoteAddress ?? 'unknown',
      body: parsed.data,
    },
    deps,
  ).catch(unknownWriter);

  const article_id = response.body.article_id;
  if (typeof article_id === 'string') await ctx.repo.recordTelemetry(article_id, deps.telemetry.events);
  return response;
}

/**
 * No longer the authorization mechanism — `verify()` resolves the caller
 * against `writers` before this is ever reached (H-V3-01). What is left is the
 * legacy static-token mode, where `writer_id` is the configured `writerId` and
 * no lookup applies: a deployment (or the contract-fuzzing harness) pointed at
 * an id with no row still has to be answered, and 401 is that answer.
 */
function unknownWriter(err: unknown): HandlerResponse {
  if ((err as { code?: string }).code !== FOREIGN_KEY_VIOLATION) throw err;
  return errorResponse(401, 'UNAUTHORIZED', 'This account is not a registered writer.');
}

const openDraft = (req: http.IncomingMessage, article_id: string, ctx: Ctx) =>
  handleOpenDraft(
    {
      article_id,
      authorization: req.headers.authorization ?? null,
      client_ip: req.socket.remoteAddress ?? 'unknown',
    },
    draftDeps(ctx),
  );

async function imageStatus(
  req: http.IncomingMessage,
  image_id: string,
  raw: Buffer,
  ctx: Ctx,
): Promise<HandlerResponse> {
  const parsed = ImageStatusBody.safeParse(parseJson(raw));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return handleImageStatusCallback(
    {
      image_id,
      callback_secret: header(req, 'x-arsene-image-callback-secret'),
      body: parsed.data,
    },
    {
      callbackSecret: ctx.opts.imageCallbackSecret ?? '',
      repo: ctx.repo,
      observability,
    },
  );
}

function header(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

export type ServerOptions = {
  port: number;
  databaseUrl: string;
  /** Legacy static credential; superseded by `jwtSecret` (verify finding #3). */
  writerToken: string;
  writerId: string;
  /** The Supabase project's HS256 JWT secret. */
  jwtSecret?: string;
  /**
   * The Supabase project's token issuer, `https://<ref>.supabase.co/auth/v1`.
   * Contains the project ref, so it is configuration and not a constant; `iss`
   * is pinned only when a deployment supplies it (L-V3-02).
   */
  jwtIssuer?: string;
  /** ADR-0004's Lambda status-callback shared secret. */
  imageCallbackSecret?: string;
  /** How long a request may take to deliver its body; `DEFAULT_READ_TIMEOUT_MS`
   * when unset. */
  readTimeoutMs?: number;
};

type Shared = {
  rateLimiter: ReturnType<typeof createRateLimiter>;
  idempotency: ReturnType<typeof createIdempotencyStore>;
  storage: ReturnType<typeof createObjectStore>;
};

type Ctx = { opts: ServerOptions; repo: Repo; shared: Shared };

/** Boots the router in this process. `server.ts` boots it in its own. */
export async function startHttpServer(opts: ServerOptions): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  // db/migrations/0002: the server-side seams write rows `authenticated` is
  // deliberately not granted (draft creation, publish-controlled columns).
  pool.on('connect', (client) => void client.query('set role service_role'));
  const ctx: Ctx = {
    opts,
    repo: createRepo(pool),
    shared: {
      rateLimiter: createRateLimiter({
        max_requests: PUBLISH_RATE_LIMIT_PER_MINUTE,
        window_ms: 60_000,
      }),
      idempotency: createIdempotencyStore(),
      storage: createObjectStore(),
    },
  };

  const readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const server = http.createServer(
    {
      requestTimeout: readTimeoutMs,
      // Node only notices an over-running request when it sweeps its
      // connections, every 30 s by default — which would make the timeout
      // above nearly meaningless. Sweeping four times per window keeps the
      // real bound within 1.25x the configured value.
      connectionsCheckingInterval: Math.ceil(readTimeoutMs / 4),
    },
    (req, res) => {
      void route(req, res, ctx).catch(() =>
        send(res, errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.')),
      );
    },
  );

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${opts.port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

type Operation =
  | { kind: 'publish' | 'images' | 'open'; article_id: string }
  | { kind: 'create-draft' }
  | { kind: 'image-status'; image_id: string };

function matchRoute(path: string): Operation | null {
  if (path === CREATE_DRAFT_ROUTE) return { kind: 'create-draft' };

  const article = ARTICLE_ROUTE.exec(path);
  if (article?.[1] !== undefined) {
    return { kind: article[2] as 'publish' | 'images' | 'open', article_id: article[1] };
  }

  const image = IMAGE_STATUS_ROUTE.exec(path);
  return image?.[1] === undefined ? null : { kind: 'image-status', image_id: image[1] };
}

function dispatch(
  req: http.IncomingMessage,
  op: Operation,
  raw: Buffer,
  ctx: Ctx,
): Promise<HandlerResponse> {
  switch (op.kind) {
    case 'create-draft':
      return createDraft(req, raw, ctx);
    case 'open':
      return openDraft(req, op.article_id, ctx);
    case 'publish':
      return publish(req, op.article_id, raw, ctx);
    case 'images':
      return upload(req, op.article_id, raw, ctx);
    case 'image-status':
      return imageStatus(req, op.image_id, raw, ctx);
  }
}

/**
 * H2: the order of the guards below *is* the fix. Anything an anonymous caller
 * can trigger is answered from the request headers alone — a declared size over
 * the cap, then credentials — so no request can make this process buffer
 * megabytes before it is known to be allowed at all.
 */
async function route(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const op = matchRoute(path);
  if (op === null) {
    send(res, errorResponse(404, 'NOT_FOUND', 'No operation matches this path.'));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    send(res, errorResponse(405, 'CONFLICT', 'Only POST is supported on this path.'));
    return;
  }
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
    send(res, tooLarge());
    return;
  }
  // The callback carries a shared secret rather than a writer token (ADR-0004),
  // but it is checked here, from the headers alone, for the same reason the
  // writer token is: 05-verification.v2.md M2 found the one credential-free
  // route was also the one route an anonymous caller could make buffer
  // megabytes. `handleImageStatusCallback` still checks it too — that is its
  // own contract, and its unit tests are the ones that pin it.
  if (op.kind === 'image-status') {
    if (!verifySharedSecret(header(req, 'x-arsene-image-callback-secret'), ctx.opts.imageCallbackSecret ?? '')) {
      send(res, errorResponse(401, 'UNAUTHORIZED', 'A valid image-callback secret is required.'));
      return;
    }
  } else if (!(await verify(bearerToken(req.headers.authorization ?? null), ctx)).valid) {
    send(res, errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.'));
    return;
  }

  const raw = await readBody(req);
  send(res, raw === null ? tooLarge() : await dispatch(req, op, raw, ctx));
}
