/**
 * ADR-0004's real originals landing zone — S3, signed with SigV4 via
 * `aws4fetch` (a `fetch`-based signer, not the full AWS SDK: works unchanged
 * under Deno, no native deps, matches this repo's existing "one lightweight
 * library over a heavy SDK" pattern for the Edge Function runtime).
 *
 * Deliberately not imported by `router.ts` itself, which only knows the
 * abstract `Shared.storage` interface — this stays a Deno-entrypoint-only
 * concern, exactly the way `lambdaHandler.ts`'s `sharp` usage stays a
 * Node-adapter-only concern, so neither runtime ever pulls in the other's
 * dependency.
 *
 * Originals are written under an `originals/` prefix and kept private (no
 * bucket policy exposes them) — nothing in this codebase serves
 * `original_url` to a visitor; only Lambda ever reads it back, via its own
 * IAM role. The returned `url` is therefore the plain S3 URL, not a CDN one;
 * `NFR-EGRESS-01` (visitors never hit storage directly) is about
 * `optimized_url`, which Lambda constructs separately once conversion
 * finishes.
 */

import { AwsClient } from 'aws4fetch';

export type S3ObjectStore = { put(key: string, bytes: Uint8Array): Promise<{ url: string }> };

export function createS3ObjectStore(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}): S3ObjectStore {
  const client = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    service: 's3',
  });
  const host = `${opts.bucket}.s3.${opts.region}.amazonaws.com`;

  return {
    async put(key, bytes) {
      const objectKey = `originals/${key}`;
      const url = `https://${host}/${objectKey}`;
      const response = await client.fetch(url, {
        method: 'PUT',
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (!response.ok) {
        throw new Error(`S3 PUT ${objectKey} failed (${response.status}): ${await response.text().catch(() => '')}`);
      }
      return { url };
    },
  };
}
