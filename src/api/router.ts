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
import { optimizeImage } from '../images/optimize.ts';
import { createTelemetrySink } from '../telemetry/events.ts';
import { errorResponse, type HandlerResponse } from './http.ts';
import { handlePublishArticle, type PublishDeps } from './publishArticle.ts';
import { createRateLimiter, PUBLISH_RATE_LIMIT_PER_MINUTE } from './rateLimit.ts';
import { createRepo, type Repo } from './repo.ts';
import { handleUploadImage, type UploadDeps } from './uploadImage.ts';

const ROUTE = /^\/v1\/articles\/([^/]+)\/(publish|images)$/;

/** Assets are served through the CDN, never from Supabase Storage (§4). */
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';

const PublishBody = z.object({
  meta_title: z.string().min(1).max(70).optional(),
  meta_description: z.string().min(1).max(160).optional(),
});

type RunningServer = { url: string; stop(): Promise<void> };

function send(res: http.ServerResponse, response: HandlerResponse): void {
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response.body));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

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
  record: (entry: { event: string; outcome: 'success' | 'failure' }) =>
    void process.stderr.write(`${JSON.stringify({ level: 'info', ...entry })}\n`),
};

function publishDeps(opts: ServerOptions, repo: Repo, shared: Shared): PublishDeps {
  const sink = createTelemetrySink();
  return {
    now: () => new Date(),
    auth: { verifyBearer: async (token) => verify(token, opts) },
    repo,
    telemetry: sink,
    rateLimiter: shared.rateLimiter,
    idempotency: shared.idempotency,
    // traceability.md §7: the Cloudflare purge itself is a deploy concern, so
    // this entry point records the call rather than performing it.
    revalidation: { revalidate: async () => ({ ok: true }) },
    observability,
  };
}

function uploadDeps(opts: ServerOptions, repo: Repo, shared: Shared): UploadDeps {
  return {
    auth: { verifyBearer: async (token) => verify(token, opts) },
    repo,
    storage: shared.storage,
    optimizer: { optimize: optimizeImage },
    idempotency: shared.idempotency,
    observability,
  };
}

function verify(
  token: string | null,
  opts: ServerOptions,
): { valid: boolean; writer_id?: string } {
  return token === opts.writerToken ? { valid: true, writer_id: opts.writerId } : { valid: false };
}

async function publish(
  req: http.IncomingMessage,
  article_id: string,
  ctx: { opts: ServerOptions; repo: Repo; shared: Shared },
): Promise<HandlerResponse> {
  const raw = await readBody(req);
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

  const deps = publishDeps(ctx.opts, ctx.repo, ctx.shared);
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
  ctx: { opts: ServerOptions; repo: Repo; shared: Shared },
): Promise<HandlerResponse> {
  const raw = await readBody(req);
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

  return handleUploadImage(
    {
      article_id,
      authorization: req.headers.authorization ?? null,
      idempotency_key: header(req, 'idempotency-key'),
      client_ip: req.socket.remoteAddress ?? 'unknown',
      role,
      file: {
        filename: file.name,
        content_type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
    },
    uploadDeps(ctx.opts, ctx.repo, ctx.shared),
  );
}

function header(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

export type ServerOptions = {
  port: number;
  databaseUrl: string;
  writerToken: string;
  writerId: string;
};

type Shared = {
  rateLimiter: ReturnType<typeof createRateLimiter>;
  idempotency: ReturnType<typeof createIdempotencyStore>;
  storage: ReturnType<typeof createObjectStore>;
};

/** Boots the router in this process. `server.ts` boots it in its own. */
export async function startHttpServer(opts: ServerOptions): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  const ctx = {
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

  const server = http.createServer((req, res) => {
    void route(req, res, ctx).catch(() =>
      send(res, errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.')),
    );
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${opts.port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { opts: ServerOptions; repo: Repo; shared: Shared },
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const match = ROUTE.exec(path);
  const article_id = match?.[1];
  if (article_id === undefined || match === null) {
    send(res, errorResponse(404, 'NOT_FOUND', 'No operation matches this path.'));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    send(res, errorResponse(405, 'CONFLICT', 'Only POST is supported on this path.'));
    return;
  }

  const response =
    match[2] === 'publish' ? await publish(req, article_id, ctx) : await upload(req, article_id, ctx);
  send(res, response);
}
