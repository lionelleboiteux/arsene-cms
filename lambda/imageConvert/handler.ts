/**
 * ADR-0004's Lambda — the S3-event-triggered half of the async image
 * pipeline. Everything about the actual conversion (format sniffing, HEIC
 * decode, WebP encode) is already written and tested at
 * `src/images/lambdaHandler.ts`'s `optimizeImageBuffer`; this file is only
 * the AWS-specific wrapper around it: read the event, fetch the original
 * from S3, call that function, write the result back, and report status to
 * Arsène's own callback endpoint. No conversion logic is duplicated here.
 *
 * Triggered by an S3 `ObjectCreated` event on the `originals/` prefix that
 * `src/api/s3Storage.ts` writes to. The object key is
 * `originals/{imageId}-original-{filename}` (the exact string
 * `uploadImage.ts` passes to `storage.put()`, prefixed by that store) — the
 * leading UUID is the `article_images.id` this Lambda reports back to.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { optimizeImageBuffer } from '../../src/images/lambdaHandler.ts';

const s3 = new S3Client({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`refusing to run: ${name} is missing or empty`);
  }
  return value;
}

/** `originals/{uuid}-original-{filename}` -> `{uuid, filename}`. The UUID is
 *  matched structurally (36 chars, RFC 4122 shape) rather than split on the
 *  first `-`, since a UUID itself contains hyphens. */
const KEY_PATTERN = /^originals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-original-(.+)$/i;

/** S3 event notifications URL-encode the object key (spaces as `+`, per an
 *  AWS-specific quirk, plus ordinary percent-encoding for everything else),
 *  so any filename with spaces or other special characters needs decoding
 *  before it's a real S3 key again — a filename with none of those (most of
 *  this project's own test fixtures) happens to be identical either way,
 *  which is why this was never caught until a real "WhatsApp Image ....jpeg"
 *  upload hit it in production. */
function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

export function parseKey(key: string): { imageId: string; filename: string } {
  const decoded = decodeS3Key(key);
  const match = KEY_PATTERN.exec(decoded);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`object key "${decoded}" does not match the expected originals/{uuid}-original-{filename} shape`);
  }
  return { imageId: match[1], filename: match[2] };
}

async function streamToUint8Array(stream: {
  transformToByteArray(): Promise<Uint8Array>;
}): Promise<Uint8Array> {
  return stream.transformToByteArray();
}

async function reportStatus(input: {
  imageId: string;
  body: { status: 'ready'; optimized_url: string } | { status: 'failed'; failure: { code: string; message: string } };
}): Promise<void> {
  const base = requireEnv('ARSENE_API_BASE'); // e.g. https://<ref>.supabase.co/functions/v1/arsene-api
  const secret = requireEnv('IMAGE_CALLBACK_SECRET');
  const response = await fetch(`${base}/internal/images/${input.imageId}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-arsene-image-callback-secret': secret,
    },
    body: JSON.stringify(input.body),
  });
  if (!response.ok) {
    // Logged, not thrown: the row will sit in `processing` and be visible to
    // the writer as such, which is honest — retrying the callback blind
    // could double-report a settled row, and the compare-and-swap on the
    // Arsène side already refuses that safely (409 CONFLICT) if attempted.
    console.error(
      `status callback for ${input.imageId} was refused: ${response.status} ${await response.text().catch(() => '')}`,
    );
  }
}

type S3Event = { Records: Array<{ s3: { bucket: { name: string }; object: { key: string } } }> };

export const handler = async (event: S3Event): Promise<void> => {
  const bucket = requireEnv('S3_BUCKET');
  const cdnOrigin = requireEnv('CDN_ORIGIN');

  for (const record of event.Records) {
    const { imageId, filename } = parseKey(record.s3.object.key);
    // The real, decoded key — GetObject needs the actual S3 key (real spaces
    // etc.), not the URL-encoded form the event itself carries in `object.key`.
    const decodedKey = decodeS3Key(record.s3.object.key);

    try {
      const original = await s3.send(new GetObjectCommand({ Bucket: record.s3.bucket.name, Key: decodedKey }));
      if (original.Body === undefined) throw new Error('S3 GetObject returned no body');
      const bytes = await streamToUint8Array(
        original.Body as unknown as { transformToByteArray(): Promise<Uint8Array> },
      );

      const result = await optimizeImageBuffer(bytes, {
        filename,
        declared_content_type: original.ContentType ?? 'application/octet-stream',
      });

      if (!result.ok) {
        await reportStatus({ imageId, body: { status: 'failed', failure: { code: result.code, message: result.message } } });
        continue;
      }

      const optimizedKey = `optimized/${imageId}.${result.format}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: optimizedKey,
          Body: result.bytes,
          ContentType: `image/${result.format}`,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );

      await reportStatus({
        imageId,
        body: { status: 'ready', optimized_url: `${cdnOrigin}/${optimizedKey}` },
      });
    } catch (err) {
      // Anything unexpected (S3 read failure, a bug) is reported as a failed
      // conversion rather than left silently in `processing` forever — a
      // writer can discard and retry either way (AC-07/08).
      console.error(`image ${imageId} failed unexpectedly:`, err);
      await reportStatus({
        imageId,
        body: {
          status: 'failed',
          failure: { code: 'PROCESSING_TIMEOUT', message: err instanceof Error ? err.message : String(err) },
        },
      }).catch(() => {});
    }
  }
};
