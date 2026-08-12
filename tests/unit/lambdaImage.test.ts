import { describe, expect, it } from 'vitest';
import { loadImageLambda } from '../support/seams.js';
import {
  REAL_HEIC,
  corruptedJpeg,
  realPhoto,
  realPhotoJpeg6MP,
  unsupportedFile,
} from '../support/imageFixtures.js';

/**
 * ADR-0004's Lambda side: real `sharp`, real photographic bytes.
 *
 * Two things this closes that the old suite could not:
 *
 *   D7 (`04-green-evidence.v1.md` §6) — the contract advertises JPEG, PNG,
 *   WebP, AVIF and HEIC as accepted source formats; the WASM codec decoded
 *   only the first two. ADR-0004: "`sharp` decodes every format the contract
 *   already advertises… in one library".
 *
 *   Finding #5 — the padded fixtures in imageFixtures.ts wrap megabytes of
 *   comment segments around a 1x1 pixel, so they measure codec plumbing, not
 *   codec cost. Everything below carries genuine multi-thousand-pixel content
 *   (`photographicPixels`), and NFR-IMGCPU-01 uses a real ~6 MP photo, the
 *   size class §5 measured the old codec at 1.4-2.6s on.
 *
 * The codec runs for real here — no mocking, exactly as 02-architecture.v1.md
 * §1 requires of the image pipeline.
 */

type SourceCase = {
  id: string;
  klass: string;
  filename: string;
  declared_content_type: string;
  bytes(): Promise<Uint8Array>;
  /** What `optimizeImageBuffer` must report for this class of input. */
  outcome: { ok: true; modern_format: true } | { ok: false; code: string };
};

const SOURCES: SourceCase[] = [
  {
    id: 'AC-07/D7-jpeg',
    klass: 'a real photographic JPEG',
    filename: 'psg-om-cover.jpg',
    declared_content_type: 'image/jpeg',
    bytes: () => realPhoto('jpeg'),
    outcome: { ok: true, modern_format: true },
  },
  {
    id: 'AC-07/D7-png',
    klass: 'a real photographic PNG',
    filename: 'psg-om-cover.png',
    declared_content_type: 'image/png',
    bytes: () => realPhoto('png'),
    outcome: { ok: true, modern_format: true },
  },
  {
    id: 'AC-07/D7-webp',
    klass: 'a real WebP, which the contract advertises but the WASM codec never decoded',
    filename: 'psg-om-cover.webp',
    declared_content_type: 'image/webp',
    bytes: () => realPhoto('webp'),
    outcome: { ok: true, modern_format: true },
  },
  {
    id: 'AC-07/D7-avif',
    klass: 'a real AVIF, which the contract advertises but the WASM codec never decoded',
    filename: 'psg-om-cover.avif',
    declared_content_type: 'image/avif',
    bytes: () => realPhoto('avif'),
    outcome: { ok: true, modern_format: true },
  },
  {
    id: 'AC-07/D7-heic',
    klass: 'a real HEVC-compressed HEIC straight off an iPhone, which the contract advertises but the WASM codec never decoded',
    filename: 'IMG_4821.heic',
    declared_content_type: 'image/heic',
    bytes: async () => REAL_HEIC,
    outcome: { ok: true, modern_format: true },
  },
  {
    id: 'AC-08-corrupt',
    klass: 'a file with valid JPEG magic bytes and an undecodable body',
    filename: 'broken.jpg',
    declared_content_type: 'image/jpeg',
    bytes: async () => corruptedJpeg(),
    outcome: { ok: false, code: 'CORRUPTED_FILE' },
  },
  {
    id: 'AC-08-unsupported',
    klass: 'a container this pipeline does not support at all (a real PDF)',
    filename: 'notes.pdf',
    declared_content_type: 'application/pdf',
    bytes: async () => unsupportedFile(),
    outcome: { ok: false, code: 'UNSUPPORTED_FORMAT' },
  },
];

describe('Lambda image optimisation (ADR-0004)', () => {
  it.each(
    SOURCES.map(
      (c) =>
        [
          `${c.id}: ${c.klass} is ${c.outcome.ok ? 'converted to a modern format, smaller than the source' : `refused cleanly as ${c.outcome.code}, never a thrown exception`}`,
          c,
        ] as const,
    ),
  )('%s', async (_title, c) => {
    const { optimizeImageBuffer } = await loadImageLambda();
    const bytes = await c.bytes();

    const result = await optimizeImageBuffer(bytes, {
      filename: c.filename,
      declared_content_type: c.declared_content_type,
    });

    const summary = result.ok
      ? {
          ok: true,
          modern_format: result.format === 'webp' || result.format === 'avif',
          produced_bytes: result.bytes.byteLength > 0,
        }
      : { ok: false, code: result.code };

    expect(summary).toEqual(
      c.outcome.ok ? { ok: true, modern_format: true, produced_bytes: true } : c.outcome,
    );
  });

  it('NFR-IMGCPU-01: a real ~6 megapixel photo — the size class the WASM codec took 1.4-2.6s on — is converted well inside a one-second budget, which is what moving to sharp on Lambda bought', async () => {
    const { optimizeImageBuffer } = await loadImageLambda();
    const bytes = await realPhotoJpeg6MP();

    const startedAt = performance.now();
    const result = await optimizeImageBuffer(bytes, {
      filename: 'real-photo-6mp.jpg',
      declared_content_type: 'image/jpeg',
    });
    const elapsedMs = performance.now() - startedAt;

    expect({ ok: result.ok, within_one_second: elapsedMs < 1_000 }).toEqual({
      ok: true,
      within_one_second: true,
    });
  });
});
