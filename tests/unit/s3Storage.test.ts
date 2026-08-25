import { afterEach, describe, expect, it, vi } from 'vitest';
import { createS3ObjectStore } from '../../src/api/s3Storage.ts';

/**
 * ADR-0004 — the real originals landing zone. `aws4fetch`'s own SigV4
 * signing is its tested responsibility, not re-proven here; this asserts the
 * glue code around it: the object key this store actually writes to, and how
 * a non-OK response is surfaced. Real behavior against real AWS is verified
 * manually once credentials exist (no Testcontainers-equivalent for S3).
 */

const TEST_OPTS = {
  accessKeyId: 'AKIATESTONLYNOTREAL',
  secretAccessKey: 'test-only-secret-not-a-real-aws-key',
  region: 'eu-west-3',
  bucket: 'arsene-cms-test-bucket',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createS3ObjectStore', () => {
  it('PUTs under an originals/ prefix, to the bucket\'s virtual-hosted-style URL, and returns that URL unchanged', async () => {
    const seen: { url: string; method: string; body: Uint8Array } = {
      url: '',
      method: '',
      body: new Uint8Array(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        // aws4fetch signs onto a `Request` and calls `fetch(request)` with a
        // single argument, not `fetch(url, init)`.
        const request = input as Request;
        seen.url = request.url;
        seen.method = request.method;
        seen.body = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 200 });
      }),
    );

    const store = createS3ObjectStore(TEST_OPTS);
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await store.put('abc-original-cover.jpg', bytes);

    expect({
      url: seen.url,
      method: seen.method,
      body: seen.body,
      returned_url: result.url,
    }).toEqual({
      url: 'https://arsene-cms-test-bucket.s3.eu-west-3.amazonaws.com/originals/abc-original-cover.jpg',
      method: 'PUT',
      body: bytes,
      returned_url: 'https://arsene-cms-test-bucket.s3.eu-west-3.amazonaws.com/originals/abc-original-cover.jpg',
    });
  });

  it('throws with the status and body when S3 refuses the PUT, rather than returning a URL nothing was stored at', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('AccessDenied', { status: 403 })),
    );

    const store = createS3ObjectStore(TEST_OPTS);

    await expect(store.put('abc-original-cover.jpg', new Uint8Array([1]))).rejects.toThrow(/403/);
  });
});
