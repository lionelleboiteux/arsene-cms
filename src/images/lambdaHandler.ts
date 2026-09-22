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

/** The exact dimensions every social platform's "large image" card wants
 *  (Facebook/WhatsApp/X's own docs all cite 1200x630, a 1.91:1 ratio) — not
 *  a suggestion `og:image:width`/`og:image:height` merely hint at, but what
 *  decides whether a platform renders a large card at all. Confirmed live:
 *  the raw, arbitrary-aspect-ratio cover photo alone made Facebook/WhatsApp
 *  fall back to a small-square card. */
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const OG_JPEG_QUALITY = 82;

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

export type OgCropResult =
  | { ok: true; bytes: Uint8Array; byte_size: number }
  | { ok: false; code: 'UNSUPPORTED_FORMAT' | 'CORRUPTED_FILE'; message: string };

/**
 * A 1200x630 JPEG crop of a cover photo, for the social-card og:image
 * `render.ts` serves (0013_article_images_og_url.sql). `fit: 'cover'`
 * center-crops to the exact target ratio rather than letterboxing — the
 * same choice every "og-image" service (Vercel's, Cloudinary's social-card
 * presets, etc.) makes, since a card with visible bars either side reads as
 * a mistake, not a design choice, in a social feed.
 *
 * Called only for `role: 'cover'` uploads (`lambda/imageConvert/handler.ts`
 * reads that back out of the S3 key itself, 0013) — a body image never
 * needs one. JPEG, not this file's usual WebP: og:image support for WebP is
 * inconsistent across WhatsApp/Facebook/X's crawlers as of this writing,
 * while JPEG is universally accepted — the one place in this codebase
 * where the older, more compatible format is deliberately still the right
 * choice.
 */
export async function buildOgImageCrop(
  bytes: Uint8Array,
  meta: { filename: string; declared_content_type: string },
): Promise<OgCropResult> {
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
    const jpeg = await image
      .resize(OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: OG_JPEG_QUALITY })
      .toBuffer();
    return { ok: true, bytes: new Uint8Array(jpeg), byte_size: jpeg.byteLength };
  } catch {
    return {
      ok: false,
      code: 'CORRUPTED_FILE',
      message: `${meta.filename} passed format detection but could not be decoded.`,
    };
  }
}
