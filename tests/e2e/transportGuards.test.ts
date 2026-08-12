import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { ARTICLE_ID, COVER_IMAGE_ID } from '../support/fixtures.js';

/**
 * VERIFY-02 — `05-verification.v1.md` H2: `router.ts`'s `readBody()` buffers
 * the entire request into memory before `verify()` or the 20 MB
 * `MAX_UPLOAD_BYTES` guard runs, so `curl -X POST .../images -d @/dev/zero`
 * with no token at all is fully buffered before the server ever checks who is
 * asking or how big the request is. The guard exists; it is in the wrong place.
 *
 * These tests are therefore about *order*, which is only observable over a
 * real socket — a handler-level test cannot see it. They run the real router
 * on a real port, against a database URL that is never reached: both rejections
 * must happen at the transport layer, before any query, so the server needs no
 * Postgres to answer them. If a test here ever needs a database to pass, the
 * rejection is happening too late by definition.
 *
 * The two guards are deliberately independent, so each test fails for exactly
 * one reason:
 *
 *   NFR-DOS-01  a *chunked* request (no Content-Length to inspect) with no
 *               credentials must be refused on the headers alone, before the
 *               body is drained.
 *   NFR-DOS-02  a request *declaring* more than 20 MB is refused on its
 *               Content-Length, before credentials, before the body, and
 *               before any codec — the cheapest check first.
 */

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** How much may have been handed to the socket before the answer comes back. */
const BOUNDED_MEMORY_BYTES = 1024 * 1024;

type StreamResult = {
  status: number;
  code: string | undefined;
  /** Bytes written to the socket at the moment the response headers arrived. */
  sent_when_answered: number;
};

/**
 * Streams a body in chunks and records how far it got before the server
 * answered. Not a request library: `fetch` gives no way to observe how much of
 * the body was actually pushed before the response arrived, which is the whole
 * measurement.
 */
async function streamPost(opts: {
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  totalBytes: number;
}): Promise<StreamResult> {
  const url = new URL(opts.baseUrl);
  const chunk = Buffer.alloc(CHUNK_BYTES, 0x41);

  return new Promise<StreamResult>((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: opts.path,
      method: 'POST',
      headers: opts.headers,
    });

    let sent = 0;
    let answered = false;
    let settled = false;
    const guard = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(new Error(`no response after streaming ${sent} bytes`));
      }
    }, 30_000);

    const finish = (result: StreamResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      req.destroy();
      resolve(result);
    };

    req.on('response', (res) => {
      const sent_when_answered = sent;
      answered = true;
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (piece: string) => (raw += piece));
      const done = () => {
        let code: string | undefined;
        try {
          code = (JSON.parse(raw) as { error?: { code?: string } }).error?.code;
        } catch {
          code = undefined;
        }
        finish({ status: res.statusCode ?? 0, code, sent_when_answered });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });

    // A socket the server tore down after answering is an expected outcome
    // here, not a test failure — only a total absence of an answer is.
    req.on('error', () => {
      if (!answered && !settled) {
        settled = true;
        clearTimeout(guard);
        reject(new Error(`connection failed after ${sent} bytes with no response`));
      }
    });

    const pump = (): void => {
      if (answered || settled) return;
      if (sent >= opts.totalBytes) {
        req.end();
        return;
      }
      sent += CHUNK_BYTES;
      // A millisecond between chunks so the event loop can deliver a response
      // the instant the server sends one, rather than after the whole flood.
      if (req.write(chunk)) setTimeout(pump, 1);
      else req.once('drain', () => setTimeout(pump, 1));
    };
    pump();
  });
}

type Ctx = { server: { url: string; stop(): Promise<void> } };

let started: Ctx | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  try {
    const { startHttpServer } = await loadApiRouter();
    started = {
      server: await startHttpServer({
        port: await freePort(),
        // Never reached: both guards must fire before any query.
        databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
        writerToken: 'unused-static-token',
        writerId: '00000000-0000-4000-8000-000000000000',
        jwtSecret: 'arsene-test-only-jwt-secret-0123456789abcdefghijklmnopqrstuvwxyz',
        imageCallbackSecret: 'lambda-callback-shared-secret-not-the-writer-token',
      }),
    };
  } catch (err) {
    startupError = err as Error;
  }
}, 120_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
});

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

describe('transport-layer request guards (verify finding #2)', () => {
  it('NFR-DOS-01: an unauthenticated chunked request is refused 401 on its headers, with only a fraction of its body ever pushed — an anonymous caller cannot make the server buffer megabytes', async () => {
    const { server } = ctx();

    const result = await streamPost({
      baseUrl: server.url,
      path: `/v1/articles/${ARTICLE_ID}/publish`,
      // No Authorization header, and no Content-Length: chunked, so nothing but
      // the credentials can justify an early refusal.
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      totalBytes: 8 * 1024 * 1024,
    });

    expect({
      status: result.status,
      code: result.code,
      body_bytes_pushed_before_the_answer_stayed_bounded:
        result.sent_when_answered <= BOUNDED_MEMORY_BYTES,
    }).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
      body_bytes_pushed_before_the_answer_stayed_bounded: true,
    });
  });

  it('NFR-DOS-02: an upload declaring more than 20 MB is refused 413 from its Content-Length alone, before the body is buffered and before any codec could run', async () => {
    const { server } = ctx();
    const declared = MAX_UPLOAD_BYTES + 1_000_000;

    const result = await streamPost({
      baseUrl: server.url,
      path: `/v1/articles/${ARTICLE_ID}/images`,
      headers: {
        'content-type': 'multipart/form-data; boundary=----arsene',
        'content-length': String(declared),
        'idempotency-key': 'a6a6a6a6-0000-4a2b-9c3d-aaaaaaaaaaaa',
      },
      totalBytes: declared,
    });

    expect({
      status: result.status,
      code: result.code,
      body_bytes_pushed_before_the_answer_stayed_bounded:
        result.sent_when_answered <= BOUNDED_MEMORY_BYTES,
    }).toEqual({
      status: 413,
      code: 'FILE_TOO_LARGE',
      body_bytes_pushed_before_the_answer_stayed_bounded: true,
    });
  });
});

// ===========================================================================
// Third remediation pass — 05-verification.v2.md's M2, its §5 timeout finding
// and its L2. All three live at this layer for the same reason the two guards
// above do: they are statements about *what the router does before it does
// anything else*, and only a real socket can see that ordering. The database
// URL configured in `beforeAll` is unreachable on purpose — any test below
// that would need Postgres to answer is, by construction, answering too late.
// ===========================================================================

/** Matches the `imageCallbackSecret` configured in `beforeAll` above. */
const CALLBACK_SECRET = 'lambda-callback-shared-secret-not-the-writer-token';

describe('the credential-free internal route (verify v2, M2 and §5)', () => {
  /**
   * M2 — `route()` deliberately skips the writer-bearer guard for
   * `image-status` operations (correctly: Lambda is not a writer), but the
   * callback's own `x-arsene-image-callback-secret` is then only checked
   * inside `handleImageStatusCallback`, which runs *after* `readBody()`. So
   * the one route that needs no writer token is also the one route where an
   * anonymous caller can still make the server buffer megabytes before being
   * told no — the exact pattern NFR-DOS-01 fixed for the other four. The fix
   * is the same fix: check the callback secret in `route()`, from the headers
   * alone, before the body is drained.
   *
   * Measured identically to NFR-DOS-01 (bytes pushed before the answer came
   * back), so the two failures are directly comparable.
   */
  it('NFR-DOS-04: an image-status callback carrying no callback secret is refused 401 on its headers, with only a fraction of its body ever pushed — the route that needs no writer token must still cost an anonymous caller nothing', async () => {
    const { server } = ctx();

    const result = await streamPost({
      baseUrl: server.url,
      path: `/internal/images/${COVER_IMAGE_ID}/status`,
      // No callback secret, and chunked, so nothing but the missing credential
      // can justify an early refusal.
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      totalBytes: 8 * 1024 * 1024,
    });

    expect({
      status: result.status,
      code: result.code,
      body_bytes_pushed_before_the_answer_stayed_bounded:
        result.sent_when_answered <= BOUNDED_MEMORY_BYTES,
    }).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
      body_bytes_pushed_before_the_answer_stayed_bounded: true,
    });
  });

  /**
   * L2 — the callback's `optimized_url` is validated as "a non-empty string"
   * and nothing more, so a caller that reaches this route can point a
   * published article's cover at any host on the internet. Every render path
   * escapes it (so this is hardening, not a demonstrated XSS), but the URL is
   * still the one an editor and a visitor will be shown, and ADR-0004's whole
   * point is that the callback may do exactly one thing.
   *
   * The check belongs in `router.ts`'s `ImageStatusBody` schema, where the
   * `CDN_ORIGIN` constant already lives — i.e. at validation time, before any
   * repository call. That placement is what these two cases assert: against a
   * server whose database is unreachable, only a rejection decided from the
   * body alone can produce a `400`; a check made after `getImage()` produces
   * a `500` instead. It also leaves `handleImageStatusCallback`'s own contract
   * (and its unit tests) untouched.
   *
   * Two cases, two classes — the second is the reason `startsWith(CDN_ORIGIN)`
   * is not a sufficient implementation:
   *   a  a plainly foreign host;
   *   b  a host that *begins with* the CDN origin as a string but is a
   *      different origin entirely (`cdn.fantasycoach.example.attacker.test`),
   *      which a prefix test accepts and an origin comparison rejects.
   */
  type CallbackOriginCase = { id: string; klass: string; optimized_url: string };

  const CALLBACK_ORIGIN_CASES: CallbackOriginCase[] = [
    {
      id: 'NFR-CALLBACK-04a',
      klass: 'an arbitrary external host',
      optimized_url: 'https://images.attacker.test/pwned.webp',
    },
    {
      id: 'NFR-CALLBACK-04b',
      klass: 'a look-alike host that merely begins with the CDN origin string',
      optimized_url: 'https://cdn.fantasycoach.example.attacker.test/pwned.webp',
    },
  ];

  it.each(
    CALLBACK_ORIGIN_CASES.map(
      (c) =>
        [
          `${c.id}: a status callback claiming ready with an optimized_url on ${c.klass} is refused 400 on the body alone, before any row is read or written — the callback may only publish assets from the trusted CDN`,
          c,
        ] as const,
    ),
  )('%s', async (_title, c) => {
    const { server } = ctx();

    const res = await fetch(`${server.url}/internal/images/${COVER_IMAGE_ID}/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A genuine callback secret: the rejection under test is about the
        // URL, never about the credential.
        'x-arsene-image-callback-secret': CALLBACK_SECRET,
      },
      body: JSON.stringify({ status: 'ready', optimized_url: c.optimized_url, failure: null }),
    });
    const body = (await res.json()) as { error?: { code?: string } };

    expect({ status: res.status, code: body.error?.code }).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// §5 — `readBody()` has no timeout
// ---------------------------------------------------------------------------

/**
 * A request that declares a body under the 20 MB cap, sends a little of it and
 * then simply stops — no more bytes, no FIN, no reset. `readBody()`'s
 * `for await (const chunk of req)` waits for the rest of it forever, and
 * nothing in `startHttpServer()` sets `requestTimeout`/`headersTimeout`, so
 * the only bound is Node's 300-second default. `/internal/images/{id}/status`
 * is the worst case, because M2 above means no credential is needed to get
 * there — reproduced by hand and by Schemathesis in
 * `verify/integration-e2e-v2.md` §5.
 *
 * Held open deliberately rather than by a slow network: this is the abuse
 * case, not a flaky client.
 */
type StallResult = { settled_after_ms: number; outcome: 'response' | 'closed' | 'hung' };

function stallPost(opts: {
  baseUrl: string;
  path: string;
  declaredBytes: number;
  prefixBytes: number;
  guardMs: number;
}): Promise<StallResult> {
  const url = new URL(opts.baseUrl);
  const startedAt = Date.now();

  return new Promise<StallResult>((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: opts.path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(opts.declaredBytes),
      },
    });

    let settled = false;
    let connected = false;
    const settle = (outcome: StallResult['outcome']) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      req.destroy();
      resolve({ settled_after_ms: Date.now() - startedAt, outcome });
    };
    const guard = setTimeout(() => settle('hung'), opts.guardMs);

    // A connection that never opened would otherwise look like an instant,
    // passing "the server let go quickly" — it is a broken test, not a result.
    req.on('socket', (socket) => socket.on('connect', () => (connected = true)));

    // Any of the three is an acceptable way to stop waiting: an explicit
    // response (`readBody()`'s own timeout, or Node's 408), or the server
    // tearing the socket down. Only silence is the failure.
    req.on('response', (res) => {
      res.resume();
      settle('response');
    });
    req.on('close', () => settle('closed'));
    req.on('error', (err: Error) => {
      if (connected || settled) {
        settle('closed');
        return;
      }
      settled = true;
      clearTimeout(guard);
      reject(new Error(`the stalled request never reached the server: ${err.message}`));
    });

    // Part of the declared body, then nothing — and never `req.end()`.
    req.write(Buffer.alloc(opts.prefixBytes, 0x41));
  });
}

/** The override this test configures, well under any realistic product value. */
const TEST_READ_TIMEOUT_MS = 1_500;
/** Generous room for the timeout to fire and the answer to come back. */
const ANSWER_DEADLINE_MS = 5_000;

describe('stalled request bodies (verify v2 §5)', () => {
  it('NFR-DOS-03: a request whose declared body stalls partway through and never completes is answered, and the socket released, within the configured read timeout — an open connection cannot be held indefinitely for free', async () => {
    const { startHttpServer } = await loadApiRouter();
    const server = await startHttpServer({
      port: await freePort(),
      // Never reached: the request never delivers a body to act on.
      databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
      writerToken: 'unused-static-token',
      writerId: '00000000-0000-4000-8000-000000000000',
      jwtSecret: 'arsene-test-only-jwt-secret-0123456789abcdefghijklmnopqrstuvwxyz',
      imageCallbackSecret: CALLBACK_SECRET,
      // Test-only override: the mechanism is what is under test here, not the
      // product's chosen number (NFR-DOS-03b pins that).
      readTimeoutMs: TEST_READ_TIMEOUT_MS,
    });

    try {
      const result = await stallPost({
        baseUrl: server.url,
        path: `/internal/images/${COVER_IMAGE_ID}/status`,
        declaredBytes: 1_000_000, // under the 20 MB cap, so NFR-DOS-02 does not fire
        prefixBytes: 1_024, // a plausible start, then silence
        guardMs: ANSWER_DEADLINE_MS + 2_000,
      });

      expect(result.settled_after_ms).toBeLessThanOrEqual(ANSWER_DEADLINE_MS);
    } finally {
      await server.stop().catch(() => undefined);
    }
  });

  it('NFR-DOS-03b: the read timeout the router ships with, for a deployment that configures none, is bounded to single-digit seconds rather than Node’s 300-second default', async () => {
    const router = await loadApiRouter();
    const shipped: unknown = router.DEFAULT_READ_TIMEOUT_MS;

    expect({
      is_a_number: typeof shipped === 'number',
      bounded_to_ten_seconds: typeof shipped === 'number' && shipped > 0 && shipped <= 10_000,
    }).toEqual({ is_a_number: true, bounded_to_ten_seconds: true });
  });
});
