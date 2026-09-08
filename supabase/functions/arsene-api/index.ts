/**
 * The real Supabase Edge Function entry point — Deno's Fetch-API handler
 * model (`Deno.serve((req: Request) => Response)`), the target ADR-0001
 * actually named. Calls the exact same `route()`/`buildCtx()` that
 * `src/api/router.ts`'s Node adapter (`startHttpServer`, used by this
 * project's test suite) calls, so the two runtimes never diverge on business
 * logic — only on how a request comes in and how a slow one is timed out.
 *
 * Deliberately does NOT set `ctx.shared.processUpload` (see `router.ts`'s
 * `convert()` comment): that dev/test convenience simulates ADR-0004's
 * S3->Lambda->callback loop in-process using real `sharp`, a native addon
 * that cannot run here. Production relies solely on the real external Lambda
 * and its `POST /internal/images/{id}/status` callback — exactly the gap this
 * entry point is not supposed to paper over.
 */

import pg from 'pg';
import {
  buildCtx,
  route,
  parseCorsOrigins,
  DEFAULT_READ_TIMEOUT_MS,
  type ServerOptions,
} from '../../../src/api/router.ts';
import { createS3ObjectStore } from '../../../src/api/s3Storage.ts';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === '') {
    throw new Error(`refusing to start: ${name} is missing or empty`);
  }
  return value;
}

/**
 * M3 (05-verification.v2.md): mirrors `serverMain.ts`'s fail-closed check —
 * this is the only other place `ServerOptions` is built from environment, so
 * it is the place that must refuse to start silently in legacy mode rather
 * than quietly attribute every request to one static writer.
 *
 * CORS-01: `SUPABASE_URL` (always auto-injected for every Edge Function),
 * not a manually-set secret, is what real deployments verify JWTs against
 * now — its well-known JWKS endpoint, under Supabase's Signing Keys system.
 * `ARSENE_TEST_JWKS_JSON` is the local-rehearsal-only escape hatch
 * (`tests/support/denoServer.ts`), for a `deno run` process with no real
 * project URL to reach.
 */
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const testJwksJson = Deno.env.get('ARSENE_TEST_JWKS_JSON');
const hasJwksConfig =
  (supabaseUrl !== undefined && supabaseUrl !== '') || (testJwksJson !== undefined && testJwksJson !== '');
if (!hasJwksConfig && Deno.env.get('ALLOW_LEGACY_STATIC_AUTH') !== 'true') {
  throw new Error(
    'refusing to start: SUPABASE_URL is missing or empty, so every request would be ' +
      "authenticated by the shared static writer token instead of the caller's own Supabase Auth " +
      'JWT verified against the project JWKS. Set SUPABASE_URL (normally automatic), or set ' +
      'ALLOW_LEGACY_STATIC_AUTH=true to choose the legacy static-token mode deliberately.',
  );
}

/**
 * `SUPABASE_DB_URL` is provided automatically to every Edge Function
 * (docs: "Environment Variables" / default secrets) — no manual secret to
 * set for the common case. `DATABASE_URL` remains a deliberate override (and
 * is what local rehearsal and `tests/support/denoServer.ts` set), e.g. to
 * point at Supavisor's transaction-mode pooler explicitly rather than
 * whatever connection string the platform default carries.
 */
function resolveDatabaseUrl(): string {
  const explicit = Deno.env.get('DATABASE_URL');
  if (explicit !== undefined && explicit !== '') return explicit;
  return requireEnv('SUPABASE_DB_URL');
}

const opts: ServerOptions = {
  port: 0, // unused — Deno.serve owns the socket, not this process directly
  databaseUrl: resolveDatabaseUrl(),
  writerToken: Deno.env.get('WRITER_TOKEN') ?? '',
  writerId: Deno.env.get('WRITER_ID') ?? '',
  jwksJson: testJwksJson,
  jwksUrl:
    testJwksJson !== undefined || supabaseUrl === undefined
      ? undefined
      : `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
  jwtIssuer: Deno.env.get('SUPABASE_JWT_ISSUER'),
  imageCallbackSecret: Deno.env.get('IMAGE_CALLBACK_SECRET'),
  cdnOrigin: Deno.env.get('CDN_ORIGIN'),
  siteOrigin: Deno.env.get('SITE_ORIGIN'),
  dashboardReadSecret: Deno.env.get('DASHBOARD_READ_SECRET'),
  // Both auto-injected by the platform for every Edge Function (same
  // `SUPABASE_URL` already resolved above for the JWKS URL; the service-role
  // key is what the admin writer-invite route needs to call the Supabase
  // Auth Admin API, same credential `scripts/create-writer.ts` requires).
  supabaseUrl,
  supabaseServiceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  corsOrigins: parseCorsOrigins(Deno.env.get('CORS_ALLOWED_ORIGINS')),
  readTimeoutMs: (() => {
    const raw = Deno.env.get('READ_TIMEOUT_MS');
    return raw === undefined ? undefined : Number(raw);
  })(),
};

// Supabase's own guidance for edge/serverless callers is Supavisor's
// transaction-mode pooler (port 6543 in DATABASE_URL) — this codebase's
// queries are all simple/unnamed (`pool.query(text, params)`, confirmed by
// inspection of src/api/repo.ts, never a named prepared statement), which is
// what transaction pooling requires to be safe.
const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });

/**
 * ADR-0004: the real originals landing zone is S3, not the in-memory
 * stand-in `buildCtx` falls back to. Optional — a deployment with no AWS
 * secrets configured still boots (uploads simply never leave `processing`,
 * exactly today's pre-pipeline behavior), rather than refusing to start over
 * a feature that isn't this project's fail-closed concern (JWKS's is, above).
 */
const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
const awsRegion = Deno.env.get('AWS_REGION');
const s3Bucket = Deno.env.get('S3_BUCKET');
const s3Storage =
  awsAccessKeyId !== undefined &&
  awsSecretAccessKey !== undefined &&
  awsRegion !== undefined &&
  s3Bucket !== undefined
    ? createS3ObjectStore({
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
        region: awsRegion,
        bucket: s3Bucket,
      })
    : undefined;

const ctx = buildCtx(opts, pool, { storage: s3Storage });

const readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

function timeoutResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request took too long.',
        details: null,
        request_id: crypto.randomUUID(),
      },
    }),
    { status: 408, headers: { 'content-type': 'application/json' } },
  );
}

function internalErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        details: null,
        request_id: crypto.randomUUID(),
      },
    }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * `Deno.serve` has no equivalent of Node's `requestTimeout`/
 * `connectionsCheckingInterval` (`startHttpServer`'s mechanism in
 * `router.ts`), so the same bound is enforced here by racing `route()`
 * against a timer instead. Disclosed difference from the Node adapter: this
 * bounds the whole request (body delivery *and* handler execution), not only
 * body delivery — a superset of the Node guarantee, not a narrower one — and
 * it does not cancel `route()`'s in-flight work when the timer wins, so a
 * slow query keeps running in the background after the client has been
 * answered 408. Acceptable for a first working deploy; a follow-up could wire
 * an `AbortSignal` through `readBody()`/the repo calls if that in-flight work
 * needs to stop, not just stop blocking the response.
 */
// The real Edge Runtime supplies its own listening port by convention; local
// rehearsal (and `tests/e2e/deployedDenoRuntime.test.ts`) needs to choose one
// explicitly, since the platform default (8000) is a common local collision.
const port = Deno.env.get('PORT') === undefined ? undefined : Number(Deno.env.get('PORT'));

/**
 * DENO-07: confirmed empirically against the real deployed project — the
 * platform's gateway strips `/functions/v1` but leaves the function's own
 * name in the path this handler sees (Supabase's routing guide: paths
 * "must be prefixed by function name"; its Hono example sets
 * `basePath('/<function-name>')` for exactly this reason). `route()` and
 * every local test harness (`startHttpServer`, local `deno run`) only ever
 * see the bare `/v1/...` shape, so this went uncaught until a request was
 * actually driven through the real gateway. Stripped here, once, at the one
 * adapter that faces the real platform — `route()` itself stays
 * transport-agnostic, same as `nodeRequestToWebRequest`'s job on the Node
 * side.
 */
const FUNCTION_NAME = 'arsene-api';

function stripFunctionNamePrefix(req: Request): Request {
  const url = new URL(req.url);
  const prefix = `/${FUNCTION_NAME}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return req;
  url.pathname = url.pathname.slice(prefix.length) || '/';
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url.href, {
    method: req.method,
    headers: req.headers,
    ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
  });
}

Deno.serve({ ...(port === undefined ? {} : { port }) }, async (rawReq, info) => {
  const req = stripFunctionNamePrefix(rawReq);
  const clientIp = info.remoteAddr.hostname;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timeoutId = setTimeout(() => resolve(timeoutResponse()), readTimeoutMs);
  });
  try {
    return await Promise.race([route(req, req.method, clientIp, ctx), timeout]);
  } catch (err) {
    console.error('unhandled error in route():', err);
    return internalErrorResponse();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
});
