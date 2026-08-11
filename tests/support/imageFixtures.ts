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
