import { describe, expect, it } from 'vitest';
import { loadImageOptimize } from '../support/seams.js';
import type { OptimizeResult } from '../support/seams.js';
import {
  BASE_JPEG,
  BASE_PNG,
  MB,
  corruptedJpeg,
  oversizedJpeg,
  pngChunksAreIntact,
  unsupportedFile,
  validJpeg,
  validPng,
} from '../support/imageFixtures.js';

/**
 * Image optimisation against REAL files and the REAL codec.
 *
 * 02-architecture.v1.md §1: "run the actual WASM codec against fixture files
 * (corrupt, oversized, valid) — no mocking, matches pronos' 'real Postgres via
 * Testcontainers' philosophy applied to a real codec instead." So nothing is
 * stubbed here: the only missing piece at red is `src/images/optimize.ts`.
 */

const CONTRACT_MAX_BYTES = 20 * MB; // openapi.yaml: 413 FILE_TOO_LARGE, max_bytes 20971520

type CodecCase = {
  id: string;
  klass: string;
  file: () => Uint8Array;
  filename: string;
  declared_content_type: string;
  expect: (r: OptimizeResult, input: Uint8Array) => unknown;
  expected: unknown;
};

const CASES: CodecCase[] = [
  {
    id: 'AC-07',
    klass: 'a valid 4 MB JPEG',
    file: validJpeg,
    filename: 'psg-om-cover.jpg',
    declared_content_type: 'image/jpeg',
    expect: (r, input) => ({
      ok: r.ok,
      modern_format: r.ok ? r.format === 'webp' || r.format === 'avif' : null,
      compressed: r.ok ? r.byte_size < input.byteLength : null,
      reports_original_size: r.ok ? r.original_byte_size === input.byteLength : null,
    }),
    expected: { ok: true, modern_format: true, compressed: true, reports_original_size: true },
  },
  {
    // Same acceptance criterion, second source format: openapi.yaml lists PNG
    // alongside JPEG as an accepted upload, so AC-07's promise ("becomes a
    // compressed WebP/AVIF") is owed to a PNG on exactly the same terms.
    id: 'AC-07',
    klass: 'a valid 4 MB PNG, the contract’s other common source format,',
    file: validPng,
    filename: 'psg-om-cover.png',
    declared_content_type: 'image/png',
    expect: (r, input) => ({
      ok: r.ok,
      modern_format: r.ok ? r.format === 'webp' || r.format === 'avif' : null,
      compressed: r.ok ? r.byte_size < input.byteLength : null,
      reports_original_size: r.ok ? r.original_byte_size === input.byteLength : null,
    }),
    expected: { ok: true, modern_format: true, compressed: true, reports_original_size: true },
  },
  {
    id: 'AC-08a',
    klass: 'a corrupted file that still sniffs as a JPEG',
    file: corruptedJpeg,
    filename: 'broken.jpg',
    declared_content_type: 'image/jpeg',
    expect: (r) => ({ ok: r.ok, code: r.ok ? null : r.code }),
    expected: { ok: false, code: 'CORRUPTED_FILE' },
  },
  {
    id: 'AC-08b',
    klass: 'a container this pipeline does not support at all',
    file: unsupportedFile,
    filename: 'notes.pdf',
    // Deliberately lies about its type: the decision must come from the bytes.
    declared_content_type: 'image/jpeg',
    expect: (r) => ({ ok: r.ok, code: r.ok ? null : r.code }),
    expected: { ok: false, code: 'UNSUPPORTED_FORMAT' },
  },
  {
    id: 'NFR-UPLOAD-01',
    klass: 'a decodable JPEG over the 20 MB limit',
    file: oversizedJpeg,
    filename: 'huge.jpg',
    declared_content_type: 'image/jpeg',
    expect: (r) => ({ ok: r.ok, code: r.ok ? null : r.code }),
    expected: { ok: false, code: 'FILE_TOO_LARGE' },
  },
];

describe('image optimisation (real codec, real files)', () => {
  it.each(CASES.map((c) => [`${c.id}: ${c.klass} is handled distinguishably`, c] as const))(
    '%s',
    async (_title, c) => {
      const { optimizeImage } = await loadImageOptimize();
      const bytes = c.file();

      const result = await optimizeImage(bytes, {
        filename: c.filename,
        declared_content_type: c.declared_content_type,
      });

      expect(c.expect(result, bytes)).toEqual(c.expected);
    },
  );

  it('NFR-UPLOAD-01: the shipped maximum upload size is the 20 MB the contract promises callers', async () => {
    const { MAX_UPLOAD_BYTES } = await loadImageOptimize();

    expect(MAX_UPLOAD_BYTES).toBe(CONTRACT_MAX_BYTES);
  });

  /**
   * Harness guard, not a product assertion: proves the fixtures above are
   * genuine files of the size and shape each case claims, so a green run can
   * never be green because a fixture quietly turned into an empty buffer.
   * This one passes at red — it depends on no production code.
   */
  it('FIXTURE-GUARD-01: the image fixtures are real files of the right kind and size', () => {
    const jpegMagic = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

    expect({
      base_is_jpeg: jpegMagic(BASE_JPEG),
      valid_is_jpeg: jpegMagic(validJpeg()),
      valid_is_about_4mb: validJpeg().byteLength >= 4 * MB && validJpeg().byteLength < 5 * MB,
      corrupted_sniffs_as_jpeg: jpegMagic(corruptedJpeg()),
      oversized_exceeds_contract_limit: oversizedJpeg().byteLength > CONTRACT_MAX_BYTES,
      unsupported_is_a_pdf: Buffer.from(unsupportedFile()).subarray(0, 5).toString() === '%PDF-',
      // Chunk-walked and CRC-checked, not magic-byte sniffed: `corruptedJpeg()`
      // is proof that a correct header says nothing about the bytes behind it.
      base_png_is_an_intact_png: pngChunksAreIntact(BASE_PNG),
      valid_png_is_an_intact_png: pngChunksAreIntact(validPng()),
      valid_png_is_about_4mb: validPng().byteLength >= 4 * MB && validPng().byteLength < 5 * MB,
    }).toEqual({
      base_is_jpeg: true,
      valid_is_jpeg: true,
      valid_is_about_4mb: true,
      corrupted_sniffs_as_jpeg: true,
      oversized_exceeds_contract_limit: true,
      unsupported_is_a_pdf: true,
      base_png_is_an_intact_png: true,
      valid_png_is_an_intact_png: true,
      valid_png_is_about_4mb: true,
    });
  });
});
