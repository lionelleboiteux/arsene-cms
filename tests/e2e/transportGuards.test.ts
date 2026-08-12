import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { ARTICLE_ID } from '../support/fixtures.js';

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
