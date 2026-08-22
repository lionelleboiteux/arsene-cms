/**
 * The Edge Function router, over the Fetch API (`Request` in, `Response`
 * out) — the model Supabase Edge Functions actually run
 * (`Deno.serve((req: Request) => Response)`), and the one this module now
 * targets directly rather than Node's `http.createServer` callback shape.
 *
 * `route()` and everything it calls is transport-agnostic: it never touches
 * `node:http` or Deno's `Deno.serve`. Two adapters sit on top of it in this
 * same file and in `supabase/functions/arsene-api/index.ts` — `startHttpServer`
 * (below) is the Node one, kept here because the test suite's seam
 * (`tests/support/seams.ts`'s `loadApiRouter`) resolves this exact file path
 * and has always booted the router this way for the provider/e2e suite. The
 * Deno one is `supabase/functions/arsene-api/index.ts`, the real deploy target.
 *
 * This is the entry point the provider (Schemathesis) and end-to-end tests
 * drive. It owns transport concerns only — routing, body parsing, auth token
 * comparison, persistence wiring — while every decision stays in the handlers
 * (`publishArticle`, `uploadImage`), which is where the acceptance criteria
 * are asserted.
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import pg from 'pg';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../images/optimize.ts';
import { createTelemetrySink } from '../telemetry/events.ts';
import { verifySupabaseJwt, verifySharedSecret } from './auth.ts';
import { handleCreateDraft, handleOpenDraft, type CreateDraftDeps } from './createDraft.ts';
import { handleDiscardImage, type DiscardImageDeps } from './discardImage.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import { handleImageStatusCallback } from './imageStatus.ts';
import { handleMetricsSummary } from './metricsSummary.ts';
import { handlePublishArticle, type PublishDeps } from './publishArticle.ts';
import { createRateLimiter, PUBLISH_RATE_LIMIT_PER_MINUTE } from './rateLimit.ts';
import { createRepo, type Repo } from './repo.ts';
import { handleUploadImage, type UploadDeps } from './uploadImage.ts';

const ARTICLE_ROUTE = /^\/v1\/articles\/([^/]+)\/(publish|images|open)$/;
const ARTICLE_IMAGE_ROUTE = /^\/v1\/articles\/([^/]+)\/images\/([^/]+)$/;
const CREATE_DRAFT_ROUTE = '/v1/articles';
const IMAGE_STATUS_ROUTE = /^\/internal\/images\/([^/]+)\/status$/;
const METRICS_SUMMARY_ROUTE = '/internal/metrics/time-to-publish';

/**
 * Assets are served through the CDN, never from Supabase Storage (§4). The
 * origin itself is deployment configuration (`ServerOptions.cdnOrigin`,
 * `CDN_ORIGIN`): `.example` is IANA-reserved, so a compile-time constant meant
 * every genuine Lambda callback was refused `400`, every image stayed
 * `processing` and every publish answered `409 IMAGE_NOT_READY`, silently
 * (M-V3-04). This placeholder is only the value an unconfigured deployment
 * falls back to.
 */
const DEFAULT_CDN_ORIGIN = 'https://cdn.fantasycoach.example';

/** A Postgres foreign-key violation: this token's `sub` is not a writer here. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * How long a request gets to finish delivering its body before the server
 * answers `408` and lets the connection go (05-verification.v2.md §5: a body
 * that is declared and then never arrives used to hang on Node's 300-second
 * default). Deliberately short: an anonymous caller must not be able to park
 * connections cheaply. The cost is that a 20 MB upload has to arrive inside
 * this window, so a very slow uplink is refused rather than waited for.
 *
 * Enforced differently per adapter, because the two runtimes offer no common
 * primitive: Node's `startHttpServer` (below) uses `http.createServer`'s own
 * `requestTimeout`/`connectionsCheckingInterval`; the Deno adapter
 * (`supabase/functions/arsene-api/index.ts`) races `route()` against this
 * value itself, since `Deno.serve` has no equivalent server-level option.
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
 * trusted CDN — this deployment's, which is why the origin is a parameter. A
 * real origin comparison, not a prefix test: `startsWith` would accept
 * `https://cdn.fantasycoach.example.attacker.test/…`.
 */
const isCdnUrl = (value: string, cdnOrigin: string): boolean => {
  try {
    return new URL(value).origin === cdnOrigin;
  } catch {
    return false;
  }
};

/** contracts/internal-openapi.yaml: `ready` needs a URL, `failed` a reason. */
const imageStatusBody = (cdnOrigin: string) =>
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ready'),
      optimized_url: z
        .string()
        .min(1)
        .refine((value) => isCdnUrl(value, cdnOrigin), `must be a URL on ${cdnOrigin}`),
      failure: z.null().optional(),
    }),
    z.object({
      status: z.literal('failed'),
      optimized_url: z.null().optional(),
      failure: z.object({ code: z.string(), message: z.string() }),
    }),
  ]);

type RunningServer = { url: string; stop(): Promise<void> };

function send(response: HandlerResponse, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/**
 * `null` once the stream goes past the cap — a chunked body carries no
 * Content-Length to inspect, so the only defence is to stop reading (H2).
 * Reads from the Fetch API `Request.body` stream directly, so no adapter
 * (Node or Deno) ever has to buffer past the cap on our behalf.
 */
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

const tooLarge = (): HandlerResponse =>
  errorResponse(413, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.', {
    max_bytes: MAX_UPLOAD_BYTES,
  });

/** `undefined` for a body that is not JSON — a 400, never a 500. */
function parseJson(raw: Uint8Array): unknown {
  if (raw.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One map, but one namespace per operation: the contract declares
 * `Idempotency-Key` as an arbitrary opaque string, so a client (or a retry
 * helper) reusing one key across an editing session used to get `publish`'s
 * cached answer for an `upload` and vice versa — a "Publish" click answered
 * `2xx` while the article stayed a draft, and a 20 MB file silently discarded
 * (M-V5-04).
 */
function createIdempotencyStore() {
  const store = new Map<string, HandlerResponse>();
  return (operation: 'publish' | 'upload') => ({
    lookup: (key: string, article_id: string) =>
      store.get(`${operation}::${key}::${article_id}`) ?? null,
    store: (key: string, article_id: string, response: HandlerResponse) =>
      void store.set(`${operation}::${key}::${article_id}`, response),
  });
}

/** Stands in for Supabase Storage: the URL shape is what the site consumes. */
function createObjectStore(cdnOrigin: string) {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
      return { url: `${cdnOrigin}/articles/${key}` };
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
    idempotency: ctx.shared.idempotency('publish'),
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
    idempotency: ctx.shared.idempotency('upload'),
    observability,
  };
}

function discardDeps(ctx: Ctx): DiscardImageDeps {
  return {
    now: () => new Date(),
    auth: { verifyBearer: async (token) => verify(token, ctx) },
    repo: ctx.repo,
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
  request: Request,
  clientIp: string,
  article_id: string,
  raw: Uint8Array,
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
      authorization: request.headers.get('authorization'),
      idempotency_key: request.headers.get('idempotency-key'),
      client_ip: clientIp,
      body: parsed.data,
    },
    deps,
  );
  await ctx.repo.recordTelemetry(article_id, deps.telemetry.events);
  return response;
}

async function upload(
  request: Request,
  clientIp: string,
  article_id: string,
  raw: Uint8Array,
  ctx: Ctx,
): Promise<HandlerResponse> {
  // The Fetch API's own multipart parser, rather than a hand-rolled one.
  const form = await new Response(raw as BodyInit, {
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
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
      authorization: request.headers.get('authorization'),
      idempotency_key: request.headers.get('idempotency-key'),
      client_ip: clientIp,
      role,
      file: { filename: file.name, content_type: file.type, bytes },
    },
    uploadDeps(ctx),
  );

  if (response.body.status === 'processing') {
    ctx.shared.processUpload?.(String(response.body.id), {
      filename: file.name,
      content_type: file.type,
      bytes,
    });
  }
  return response;
}

/**
 * ADR-0004's S3-event → Lambda → status-callback loop, in one process — dev/test
 * convenience only, never wired into a real deployment.
 *
 * The deployed system triggers `optimizeImageBuffer` (real `sharp`, in AWS
 * Lambda's Node — `../images/lambdaHandler.ts`) from an S3 notification and
 * reports the outcome back over `POST /internal/images/{id}/status`; the Node
 * test/dev harness (`startHttpServer`, below) runs the same conversion and the
 * same compare-and-swap directly, after answering the writer, because it owns
 * both ends. The Deno production adapter never sets `shared.processUpload`, so
 * this function is never called there — it relies solely on the real, external
 * Lambda and the real callback, exactly as production must.
 *
 * `lambdaHandler.ts` is loaded through a lazy, non-literal dynamic import
 * (not a static one) specifically so that merely importing this module — as
 * the Deno production entry point does, for `route()` — never pulls `sharp`
 * (a native addon; Lambda/Node-only, unusable under Deno) into the Edge
 * Function's module graph. A static import here would make the whole
 * deployment fail at cold start even though this code path is never reached.
 * Confirmed empirically: with this import kept dynamic and non-literal,
 * neither `deno check` nor `deno run` attempt to resolve `sharp` at all.
 */
function convert(
  image_id: string,
  file: { filename: string; content_type: string; bytes: Uint8Array },
  ctx: Ctx,
): void {
  void (async () => {
    const lambdaHandlerPath = '../images/lambdaHandler.ts';
    const { optimizeImageBuffer } = (await import(lambdaHandlerPath)) as {
      optimizeImageBuffer: (
        bytes: Uint8Array,
        meta: { filename: string; declared_content_type: string },
      ) => Promise<
        | { ok: true; format: string; bytes: Uint8Array }
        | { ok: false; code: string; message: string }
      >;
    };
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

async function createDraft(
  request: Request,
  clientIp: string,
  raw: Uint8Array,
  ctx: Ctx,
): Promise<HandlerResponse> {
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
      authorization: request.headers.get('authorization'),
      client_ip: clientIp,
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

const openDraft = (request: Request, clientIp: string, article_id: string, ctx: Ctx) =>
  handleOpenDraft(
    {
      article_id,
      authorization: request.headers.get('authorization'),
      client_ip: clientIp,
    },
    draftDeps(ctx),
  );

async function imageStatus(
  request: Request,
  image_id: string,
  raw: Uint8Array,
  ctx: Ctx,
): Promise<HandlerResponse> {
  const parsed = ctx.shared.imageStatusBody.safeParse(parseJson(raw));
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
      callback_secret: request.headers.get('x-arsene-image-callback-secret'),
      body: parsed.data,
    },
    {
      callbackSecret: ctx.opts.imageCallbackSecret ?? '',
      repo: ctx.repo,
      observability,
    },
  );
}

const metricsSummary = (request: Request, ctx: Ctx): Promise<HandlerResponse> =>
  handleMetricsSummary(
    { dashboard_secret: request.headers.get('x-arsene-dashboard-secret') },
    { dashboardSecret: ctx.opts.dashboardReadSecret ?? '', repo: ctx.repo },
  );

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
  /**
   * `GET /internal/metrics/time-to-publish`'s shared secret — John's
   * dashboard gate (`pdlc/arsene-cms/11-dashboard.v1.md`), never a writer
   * bearer token: a writer's JWT proves who is drafting, not that they may
   * read team-wide timing aggregates.
   */
  dashboardReadSecret?: string;
  /**
   * The origin converted assets are served from — the one an inbound status
   * callback's `optimized_url` must be on, and the one this process's object
   * store writes. `DEFAULT_CDN_ORIGIN` when unset (M-V3-04).
   */
  cdnOrigin?: string;
  /** How long a request may take to deliver its body; `DEFAULT_READ_TIMEOUT_MS`
   * when unset. */
  readTimeoutMs?: number;
};

type Shared = {
  rateLimiter: ReturnType<typeof createRateLimiter>;
  idempotency: ReturnType<typeof createIdempotencyStore>;
  storage: ReturnType<typeof createObjectStore>;
  /** Built once, because the origin it validates against is per-deployment. */
  imageStatusBody: ReturnType<typeof imageStatusBody>;
  /** See `convert()`'s comment. Set only by `startHttpServer` (Node dev/test);
   * left unset by the Deno production adapter. */
  processUpload?: (
    image_id: string,
    file: { filename: string; content_type: string; bytes: Uint8Array },
  ) => void;
};

export type Ctx = { opts: ServerOptions; repo: Repo; shared: Shared };

/**
 * Builds the platform-neutral request context: the Postgres pool, the repo,
 * and every in-memory collaborator (rate limiter, idempotency store, object
 * store). Shared by both adapters — `startHttpServer` below, and the Deno
 * entry point (`supabase/functions/arsene-api/index.ts`) — so the two never
 * drift on how a deployment's options become the dependencies `route()` uses.
 */
export function buildCtx(opts: ServerOptions, pool: pg.Pool): Ctx {
  // db/migrations/0002: the server-side seams write rows `authenticated` is
  // deliberately not granted (draft creation, publish-controlled columns).
  pool.on('connect', (client: pg.PoolClient) => void client.query('set role service_role'));
  const cdnOrigin = opts.cdnOrigin ?? DEFAULT_CDN_ORIGIN;
  return {
    opts,
    repo: createRepo(pool),
    shared: {
      rateLimiter: createRateLimiter({
        max_requests: PUBLISH_RATE_LIMIT_PER_MINUTE,
        window_ms: 60_000,
      }),
      idempotency: createIdempotencyStore(),
      storage: createObjectStore(cdnOrigin),
      imageStatusBody: imageStatusBody(cdnOrigin),
    },
  };
}

type Operation =
  | { kind: 'publish' | 'images' | 'open'; article_id: string }
  | { kind: 'discard-image'; article_id: string; image_id: string }
  | { kind: 'create-draft' }
  | { kind: 'image-status'; image_id: string }
  | { kind: 'metrics-summary' };

function matchRoute(path: string): Operation | null {
  if (path === CREATE_DRAFT_ROUTE) return { kind: 'create-draft' };
  if (path === METRICS_SUMMARY_ROUTE) return { kind: 'metrics-summary' };

  const article = ARTICLE_ROUTE.exec(path);
  if (article?.[1] !== undefined) {
    return { kind: article[2] as 'publish' | 'images' | 'open', article_id: article[1] };
  }

  const articleImage = ARTICLE_IMAGE_ROUTE.exec(path);
  if (articleImage?.[1] !== undefined && articleImage[2] !== undefined) {
    return { kind: 'discard-image', article_id: articleImage[1], image_id: articleImage[2] };
  }

  const image = IMAGE_STATUS_ROUTE.exec(path);
  return image?.[1] === undefined ? null : { kind: 'image-status', image_id: image[1] };
}

/** Every operation is a `POST`, bar the one that removes a resource (`DELETE`)
 * and the read-only dashboard adapter (`GET`). */
const methodOf = (op: Operation): string => {
  if (op.kind === 'discard-image') return 'DELETE';
  if (op.kind === 'metrics-summary') return 'GET';
  return 'POST';
};

function dispatch(
  request: Request,
  clientIp: string,
  op: Operation,
  raw: Uint8Array,
  ctx: Ctx,
): Promise<HandlerResponse> {
  switch (op.kind) {
    case 'create-draft':
      return createDraft(request, clientIp, raw, ctx);
    case 'open':
      return openDraft(request, clientIp, op.article_id, ctx);
    case 'publish':
      return publish(request, clientIp, op.article_id, raw, ctx);
    case 'images':
      return upload(request, clientIp, op.article_id, raw, ctx);
    case 'discard-image':
      return handleDiscardImage(
        {
          article_id: op.article_id,
          image_id: op.image_id,
          authorization: request.headers.get('authorization'),
        },
        discardDeps(ctx),
      );
    case 'image-status':
      return imageStatus(request, op.image_id, raw, ctx);
    case 'metrics-summary':
      return metricsSummary(request, ctx);
  }
}

/**
 * H2: the order of the guards below *is* the fix. Anything an anonymous caller
 * can trigger is answered from the request headers alone — a declared size over
 * the cap, then credentials — so no request can make this process buffer
 * megabytes before it is known to be allowed at all.
 *
 * Transport-agnostic: takes a Fetch API `Request`, the real wire method, and
 * the caller's IP (each adapter extracts the IP its own way —
 * `req.socket.remoteAddress` under Node, `info.remoteAddr` under Deno) and
 * returns a `Response`. Neither adapter's transport type appears anywhere
 * below this line.
 *
 * `method` is taken separately from `request.method` rather than read off the
 * `Request` object: the WHATWG Fetch spec forbids constructing a `Request`
 * with method `TRACE`/`TRACK`/`CONNECT` at all, but a real caller can still
 * send one over the wire, and the 405 branch below must still answer it
 * cleanly rather than the adapter throwing before `route()` is ever reached
 * (contract fuzzing exercises exactly this). Every adapter's `Request` is
 * therefore built with a spec-safe placeholder method when the real one is
 * forbidden, and passes the genuine wire method here instead.
 */
export async function route(
  request: Request,
  method: string,
  clientIp: string,
  ctx: Ctx,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const op = matchRoute(path);
  if (op === null) {
    return send(errorResponse(404, 'NOT_FOUND', 'No operation matches this path.'));
  }
  const expectedMethod = methodOf(op);
  if (method !== expectedMethod) {
    return send(errorResponse(405, 'CONFLICT', `Only ${expectedMethod} is supported on this path.`), {
      allow: expectedMethod,
    });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
    return send(tooLarge());
  }
  // The callback carries a shared secret rather than a writer token (ADR-0004),
  // but it is checked here, from the headers alone, for the same reason the
  // writer token is: 05-verification.v2.md M2 found the one credential-free
  // route was also the one route an anonymous caller could make buffer
  // megabytes. `handleImageStatusCallback` still checks it too — that is its
  // own contract, and its unit tests are the ones that pin it.
  if (op.kind === 'image-status') {
    if (
      !verifySharedSecret(
        request.headers.get('x-arsene-image-callback-secret'),
        ctx.opts.imageCallbackSecret ?? '',
      )
    ) {
      return send(errorResponse(401, 'UNAUTHORIZED', 'A valid image-callback secret is required.'));
    }
  } else if (op.kind === 'metrics-summary') {
    if (
      !verifySharedSecret(request.headers.get('x-arsene-dashboard-secret'), ctx.opts.dashboardReadSecret ?? '')
    ) {
      return send(errorResponse(401, 'UNAUTHORIZED', 'A valid dashboard secret is required.'));
    }
  } else if (!(await verify(bearerToken(request.headers.get('authorization')), ctx)).valid) {
    return send(errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.'));
  }

  const raw = await readBody(request);
  return send(raw === null ? tooLarge() : await dispatch(request, clientIp, op, raw, ctx));
}

/**
 * Converts a live Node request into the `Request` object `route()` consumes,
 * plus the real wire method (see `route()`'s comment on why the two travel
 * separately). `Readable.toWeb` streams the body straight through —
 * `readBody()` still enforces the size cap while reading, so nothing here
 * buffers ahead of that check.
 */
function nodeRequestToWebRequest(req: http.IncomingMessage): { request: Request; method: string } {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? 'GET';
  // A `Request` may not carry a body for GET/HEAD — every route this server
  // exposes is POST or DELETE, so this only ever excludes methods that would
  // fail routing anyway (`route()`'s own 405).
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init = {
    method,
    headers,
    ...(hasBody
      ? { body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, duplex: 'half' }
      : {}),
  } as RequestInit;
  try {
    return { request: new Request(url, init), method };
  } catch {
    // TRACE/TRACK/CONNECT: forbidden by the Fetch spec's `Request`
    // constructor. Fall back to a spec-safe placeholder so construction never
    // throws; `route()` gets the real method above regardless.
    return { request: new Request(url, { method: 'GET', headers }), method };
  }
}

async function sendWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Boots the router in this process, over a real Node HTTP server —
 * `server.ts`/`serverMain.ts` boot it in its own, for the reason documented
 * there. This is the Node dev/test adapter; `supabase/functions/arsene-api/index.ts`
 * is the real Deno deploy target. Both call the same `route()`/`buildCtx()`.
 */
export async function startHttpServer(opts: ServerOptions): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  const ctx = buildCtx(opts, pool);
  // Dev/test-only: simulates ADR-0004's S3->Lambda->callback loop in-process.
  // See `convert()`'s comment for why this is never wired in the Deno adapter.
  ctx.shared.processUpload = (image_id, file) => convert(image_id, file, ctx);

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
      void (async () => {
        try {
          const { request, method } = nodeRequestToWebRequest(req);
          const clientIp = req.socket.remoteAddress ?? 'unknown';
          const response = await route(request, method, clientIp, ctx);
          await sendWebResponse(res, response);
        } catch {
          await sendWebResponse(
            res,
            send(errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.')),
          );
        }
      })();
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
