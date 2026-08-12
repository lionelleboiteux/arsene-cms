/**
 * ADR-0004 — the optimisation step, moved out of the request path.
 *
 * Runs in AWS Lambda (Node, not Deno), triggered by an S3 event on the
 * originals prefix, so it may use real `sharp`: native libvips, no 2s CPU
 * ceiling, and one library that decodes every source format the contract
 * advertises (JPEG, PNG, WebP, AVIF, HEIC — deviation D7 closed). The result
 * shape is unchanged from the Edge Function codec it replaces, so
 * `article_images` and the contract need no change.
 */

// `Sharp` is a named type export from sharp 0.35 onwards (0.34 exposed it as a
// namespace alongside the default export).
import sharp, { type Sharp } from 'sharp';
import { sniffImageFormat, type SourceFormat } from './format.ts';
import { decodeHeic } from './heic.ts';
import type { OptimizeResult } from './optimize.ts';

/** Fast enough that a 6 MP photo stays far inside Lambda's budget. */
const WEBP_QUALITY = 75;
const WEBP_EFFORT = 2;

/** HEVC-in-HEIF is decoded first; `sharp` opens every other format itself. */
async function open(bytes: Uint8Array, format: SourceFormat): Promise<Sharp> {
  if (format !== 'heic') return sharp(Buffer.from(bytes));
  const { data, width, height } = await decodeHeic(bytes);
  return sharp(data, { raw: { width, height, channels: 4 } });
}

export async function optimizeImageBuffer(
  bytes: Uint8Array,
  meta: { filename: string; declared_content_type: string },
): Promise<OptimizeResult> {
  const format = sniffImageFormat(bytes);
  if (format === null) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: `${meta.filename} could not be recognised as a supported image format.`,
    };
  }

  try {
    const image = await open(bytes, format);
    const webp = await image.webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT }).toBuffer();
    return {
      ok: true,
      format: 'webp',
      bytes: new Uint8Array(webp),
      byte_size: webp.byteLength,
      original_byte_size: bytes.byteLength,
    };
  } catch {
    return {
      ok: false,
      code: 'CORRUPTED_FILE',
      message: `${meta.filename} passed format detection but could not be decoded.`,
    };
  }
}
