/**
 * Real image bytes for the image-pipeline tests.
 *
 * 02-architecture.v1.md §1 requires the *actual* codec to run against real
 * fixture files (corrupt, oversized, valid) — nothing here is a mock or a
 * stand-in string. Every fixture below is genuine, byte-exact file content:
 *
 *   - `validJpeg()`      a real baseline JPEG (verified decodable: 1x1),
 *                        padded to ~4 MB with legal JPEG COM segments so that
 *                        AC-07's "4 MB JPEG" is a genuinely 4 MB genuinely
 *                        decodable file, not a renamed blob.
 *   - `validPng()`       the same construction for the contract's second
 *                        accepted source format: a real 8-bit RGB PNG
 *                        (verified decodable: 1x1), padded to ~4 MB with legal
 *                        `tEXt` chunks carrying correct CRC-32s, so AC-07 is
 *                        asserted for PNG on a genuinely decodable 4 MB file.
 *   - `oversizedJpeg()`  the same construction taken past the contract's
 *                        20 MB limit, so NFR-UPLOAD-01 proves the size guard
 *                        runs *before* the codec, on a file that would
 *                        otherwise decode fine.
 *   - `corruptedJpeg()`  correct JPEG magic bytes (so format sniffing accepts
 *                        it) followed by garbage (so decoding must fail) —
 *                        the "created, then transitions to failed" case.
 *   - `unsupportedFile()` a real PDF header — a container this pipeline does
 *                        not support at all, rejected at sniff time.
 *
 * They are generated rather than committed so a 20 MB binary never enters git;
 * generation is deterministic and needs no network, no codec and no dev tool.
 */

const BASE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** A 160-byte baseline JPEG, 1x1 pixel. Decodability verified with a real decoder. */
export const BASE_JPEG: Uint8Array = Uint8Array.from(Buffer.from(BASE_JPEG_B64, 'base64'));

/** One legal JPEG comment segment: FFFE + length + payload. Decoders skip these. */
function commentSegment(payloadLength: number): Uint8Array {
  const seg = new Uint8Array(payloadLength + 4);
  seg[0] = 0xff;
  seg[1] = 0xfe;
  const len = payloadLength + 2;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.fill(0x41, 4); // 'A'
  return seg;
}

/** A real, decodable JPEG grown to at least `targetBytes` via COM padding. */
export function jpegOfAtLeast(targetBytes: number): Uint8Array {
  const payload = 65_533; // maximum JPEG segment payload
  const seg = commentSegment(payload);
  const needed = Math.max(0, targetBytes - BASE_JPEG.length);
  const count = Math.ceil(needed / seg.length);

  const out = new Uint8Array(BASE_JPEG.length + count * seg.length);
  out.set(BASE_JPEG.subarray(0, 2), 0); // SOI
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    out.set(seg, offset);
    offset += seg.length;
  }
  out.set(BASE_JPEG.subarray(2), offset);
  return out;
}

export const MB = 1024 * 1024;

/** AC-07: "a writer uploads a 4MB JPEG". */
export const validJpeg = (): Uint8Array => jpegOfAtLeast(4 * MB);

/** NFR-UPLOAD-01: past the contract's 20 MB `413 FILE_TOO_LARGE` boundary. */
export const oversizedJpeg = (): Uint8Array => jpegOfAtLeast(20 * MB + 1);

const BASE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOoMpUHAAH7' +
  'AM+NTSfrAAAAAElFTkSuQmCC';

/** A 69-byte PNG, 1x1 pixel, 8-bit RGB. Decodability verified with a real decoder. */
export const BASE_PNG: Uint8Array = Uint8Array.from(Buffer.from(BASE_PNG_B64, 'base64'));

/** 8-byte signature + the 25-byte IHDR chunk: everything that must come first. */
const PNG_HEADER_BYTES = 8 + (4 + 4 + 13 + 4);

/** The PNG CRC-32 (ISO 3309 / ITU-T V.42), so generated chunks are legal, not plausible. */
const PNG_CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = PNG_CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One complete PNG chunk: length + type + payload + CRC-32 over type||payload. */
function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, pngCrc32(out.subarray(4, 8 + payload.length)));
  return out;
}

/** A `tEXt` chunk — ancillary, so every conformant decoder skips it. */
function textChunk(textLength: number): Uint8Array {
  const keyword = 'Comment';
  const payload = new Uint8Array(keyword.length + 1 + textLength);
  for (let i = 0; i < keyword.length; i += 1) payload[i] = keyword.charCodeAt(i);
  payload[keyword.length] = 0x00; // the mandatory null separator
  payload.fill(0x41, keyword.length + 1); // 'A'
  return pngChunk('tEXt', payload);
}

/** A real, decodable PNG grown to at least `targetBytes` via `tEXt` padding. */
export function pngOfAtLeast(targetBytes: number): Uint8Array {
  const seg = textChunk(64 * 1024);
  const needed = Math.max(0, targetBytes - BASE_PNG.length);
  const count = Math.ceil(needed / seg.length);

  const out = new Uint8Array(BASE_PNG.length + count * seg.length);
  out.set(BASE_PNG.subarray(0, PNG_HEADER_BYTES), 0); // signature + IHDR
  let offset = PNG_HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    out.set(seg, offset);
    offset += seg.length;
  }
  out.set(BASE_PNG.subarray(PNG_HEADER_BYTES), offset); // IDAT + IEND
  return out;
}

/** AC-07, second accepted source format: the same 4 MB upload, as a PNG. */
export const validPng = (): Uint8Array => pngOfAtLeast(4 * MB);

/**
 * Walks a PNG's chunk list and re-checks every CRC-32 against the bytes it
 * covers. Used only by FIXTURE-GUARD-01: it is what stops `validPng()` from
 * silently degrading into a signature followed by garbage, which is precisely
 * what `corruptedJpeg()` is, and which magic-byte checking alone cannot tell
 * apart from a real file.
 */
export function pngChunksAreIntact(bytes: Uint8Array): boolean {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (SIGNATURE.some((b, i) => bytes[i] !== b)) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen: string[] = [];
  let offset = SIGNATURE.length;

  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return false;
    if (view.getUint32(end - 4) !== pngCrc32(bytes.subarray(offset + 4, end - 4))) return false;
    seen.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    offset = end;
  }

  return (
    offset === bytes.byteLength &&
    seen[0] === 'IHDR' &&
    seen.includes('IDAT') &&
    seen[seen.length - 1] === 'IEND'
  );
}

/** AC-08: sniffs as JPEG, cannot be decoded. */
export function corruptedJpeg(): Uint8Array {
  const out = new Uint8Array(4096);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0); // valid SOI + APP0 magic
  for (let i = 4; i < out.length; i += 1) out[i] = (i * 37 + 11) % 256;
  return out;
}

/** AC-08: a container the pipeline does not support at all. */
export function unsupportedFile(): Uint8Array {
  return Uint8Array.from(
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n', 'latin1'),
  );
}

export type ImageFixture = {
  id: string;
  filename: string;
  declared_content_type: string;
  bytes: Uint8Array;
};

export const imageFixture = (
  id: string,
  filename: string,
  declared_content_type: string,
  bytes: Uint8Array,
): ImageFixture => ({ id, filename, declared_content_type, bytes });
