/**
 * AC-07 / AC-08 / NFR-UPLOAD-01 — the real image pipeline.
 *
 * The codec is WASM (`@jsquash`, i.e. mozjpeg + libwebp compiled to
 * WebAssembly) rather than Node's `sharp`: contracts/openapi.yaml's
 * "Server-side image processing constraint" notes that Supabase Edge Functions
 * run on Deno, where `sharp` is not usable. One WASM codec runs unchanged in
 * both this Node test process and the Deno runtime this ships to.
 *
 * The size guard runs before the codec is ever handed the bytes, so an
 * oversized upload costs no decode time (02-architecture.v1.md §7, DoS).
 */

import { readFile } from 'node:fs/promises';
import decodeJpeg, { init as initJpegDecoder } from '@jsquash/jpeg/decode.js';
import decodePng, { init as initPngDecoder } from '@jsquash/png/decode.js';
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js';

export type OptimizeSuccess = {
  ok: true;
  format: 'webp' | 'avif';
  bytes: Uint8Array;
  byte_size: number;
  original_byte_size: number;
};

export type OptimizeFailure = {
  ok: false;
  code: 'UNSUPPORTED_FORMAT' | 'CORRUPTED_FILE' | 'FILE_TOO_LARGE' | 'PROCESSING_TIMEOUT';
  message: string;
};

export type OptimizeResult = OptimizeSuccess | OptimizeFailure;

/** contracts/openapi.yaml, `413 FILE_TOO_LARGE`: `max_bytes: 20971520`. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const WEBP_QUALITY = 75;

const wasmPath = (relative: string): URL => new URL(`../../node_modules/${relative}`, import.meta.url);

let codecReady: Promise<void> | null = null;

async function ensureCodec(): Promise<void> {
  codecReady ??= (async () => {
    const [jpegWasm, pngWasm, webpWasm] = await Promise.all([
      readFile(wasmPath('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')),
      readFile(wasmPath('@jsquash/png/codec/pkg/squoosh_png_bg.wasm')),
      readFile(wasmPath('@jsquash/webp/codec/enc/webp_enc_simd.wasm')),
    ]);
    await initJpegDecoder(await WebAssembly.compile(new Uint8Array(jpegWasm)));
    await initPngDecoder(await WebAssembly.compile(new Uint8Array(pngWasm)));
    await initWebpEncoder(await WebAssembly.compile(new Uint8Array(webpWasm)));
  })();
  await codecReady;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Format is decided from the bytes, never from what the upload claims to be.
 * `null` means "no decoder here": the contract also advertises WebP, AVIF and
 * HEIC as accepted source formats, and those remain unsupported for now (see
 * 04-green-evidence.v1.md, D7).
 */
function decoderFor(bytes: Uint8Array): ((data: ArrayBuffer) => Promise<ImageData>) | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return decodeJpeg;
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return decodePng;
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function optimizeImage(
  bytes: Uint8Array,
  meta: { filename: string; declared_content_type: string },
): Promise<OptimizeResult> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: `Files must be 20 MB or smaller; ${meta.filename} is ${bytes.byteLength} bytes.`,
    };
  }
  const decode = decoderFor(bytes);
  if (decode === null) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: `${meta.filename} could not be recognised as a supported image format.`,
    };
  }

  await ensureCodec();
  try {
    const decoded = await decode(toArrayBuffer(bytes));
    const encoded = await encodeWebp(decoded, { quality: WEBP_QUALITY });
    const webp = new Uint8Array(encoded);
    return {
      ok: true,
      format: 'webp',
      bytes: webp,
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
