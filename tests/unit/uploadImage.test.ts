import { describe, expect, it } from 'vitest';
import { loadUploadImage } from '../support/seams.js';
import type { UploadImageRequest } from '../support/seams.js';
import { buildUploadDeps } from '../support/fakes.js';
import { validateAgainstSchema } from '../support/openapi.js';
import { ARTICLE_ID, COVER_IMAGE_ID, articleRecord, imageRecord } from '../support/fixtures.js';
import { corruptedJpeg, oversizedJpeg, unsupportedFile, validJpeg } from '../support/imageFixtures.js';

/**
 * The `images` Edge Function handler. The codec itself is exercised for real
 * in tests/unit/imageOptimize.test.ts; here it is a fake, so these tests fail
 * only because the handler is missing — not because the codec is too.
 *
 * The *files* are real either way: every `bytes` below is genuine file content
 * from tests/support/imageFixtures.ts, never a placeholder string.
 */

const uploadReq = (overrides: Partial<UploadImageRequest> = {}): UploadImageRequest => ({
  article_id: ARTICLE_ID,
  authorization: 'Bearer writer.supabase.jwt',
  idempotency_key: '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
  client_ip: '203.0.113.7',
  role: 'cover',
  file: { filename: 'psg-om-cover.jpg', content_type: 'image/jpeg', bytes: validJpeg() },
  ...overrides,
});

describe('image upload', () => {
  it('AC-07: a 4 MB JPEG comes back as a compressed WebP/AVIF resource, and the bytes actually stored for visitors are far smaller than the upload', async () => {
    const api = await loadUploadImage();
    const { deps, stored } = buildUploadDeps({ article: articleRecord() });
    const req = uploadReq();

    const res = await api.handleUploadImage(req, deps);
    const body = res.body as any;

    expect({
      status: res.status,
      contract_errors: validateAgainstSchema('ArticleImage', body),
      optimized_is_modern_format: /\.(webp|avif)$/.test(String(body.urls?.optimized ?? '')),
      served_bytes_smaller_than_upload:
        (stored.find((s) => /optimi/.test(s.key))?.byte_size ?? Infinity) < req.file.bytes.byteLength,
    }).toEqual({
      status: 201,
      contract_errors: [],
      optimized_is_modern_format: true,
      served_bytes_smaller_than_upload: true,
    });
  });

  it('AC-15: a processed image carries auto-generated alt text, ready for the writer to override', async () => {
    const api = await loadUploadImage();
    const { deps } = buildUploadDeps({ article: articleRecord({ title: 'PSG vs Marseille' }) });

    const res = await api.handleUploadImage(uploadReq(), deps);
    const body = res.body as any;

    expect({
      status: body.status,
      alt_text_generated: typeof body.alt_text === 'string' && body.alt_text.length > 0,
    }).toEqual({ status: 'ready', alt_text_generated: true });
  });

  it('AC-06: uploading a new cover demotes the article’s previous cover to a body image and names the image it replaced', async () => {
    const api = await loadUploadImage();
    const { deps } = buildUploadDeps({
      article: articleRecord(),
      images: [imageRecord()],
      previousCoverId: COVER_IMAGE_ID,
    });

    const res = await api.handleUploadImage(
      uploadReq({ file: { filename: 'new-cover.jpg', content_type: 'image/jpeg', bytes: validJpeg() } }),
      deps,
    );

    expect({
      role: (res.body as any).role,
      replaced_cover_image_id: (res.body as any).replaced_cover_image_id,
    }).toEqual({ role: 'cover', replaced_cover_image_id: COVER_IMAGE_ID });
  });

  it('AC-06: a body-image upload never claims to have replaced a cover', async () => {
    const api = await loadUploadImage();
    const { deps } = buildUploadDeps({ article: articleRecord(), images: [imageRecord()] });

    const res = await api.handleUploadImage(uploadReq({ role: 'body' }), deps);

    expect({
      role: (res.body as any).role,
      replaced_cover_image_id: (res.body as any).replaced_cover_image_id,
    }).toEqual({ role: 'body', replaced_cover_image_id: null });
  });

  it('AC-08: a file whose format cannot be recognised is refused with a clear error and creates no image row at all', async () => {
    const api = await loadUploadImage();
    const { deps, inserted } = buildUploadDeps({
      article: articleRecord(),
      optimizeResult: { ok: false, code: 'UNSUPPORTED_FORMAT', message: 'unrecognised container' },
    });

    const res = await api.handleUploadImage(
      uploadReq({
        file: { filename: 'notes.pdf', content_type: 'application/pdf', bytes: unsupportedFile() },
      }),
      deps,
    );

    expect({
      status: res.status,
      code: (res.body as any)?.error?.code,
      rows_created: inserted.length,
    }).toEqual({ status: 422, code: 'UNSUPPORTED_FORMAT', rows_created: 0 });
  });

  it('AC-08: a file that passes format detection but fails to decode becomes a failed image the writer is told to replace, never a silently broken one', async () => {
    const api = await loadUploadImage();
    const { deps } = buildUploadDeps({
      article: articleRecord(),
      optimizeResult: { ok: false, code: 'CORRUPTED_FILE', message: 'could not be decoded' },
    });

    const res = await api.handleUploadImage(
      uploadReq({
        file: { filename: 'broken.jpg', content_type: 'image/jpeg', bytes: corruptedJpeg() },
      }),
      deps,
    );
    const body = res.body as any;

    expect({
      status: res.status,
      image_status: body.status,
      failure_code: body.failure?.code,
      urls: body.urls,
    }).toEqual({
      status: 201,
      image_status: 'failed',
      failure_code: 'CORRUPTED_FILE',
      urls: null,
    });
  });

  it('NFR-UPLOAD-01: a file over the contract’s 20 MB limit is rejected with 413 before the codec is ever handed the bytes', async () => {
    const api = await loadUploadImage();
    // Not destructured: `optimizeCalls` is a live getter, read after the call.
    const built = buildUploadDeps({ article: articleRecord() });

    const res = await api.handleUploadImage(
      uploadReq({
        file: { filename: 'huge.jpg', content_type: 'image/jpeg', bytes: oversizedJpeg() },
      }),
      built.deps,
    );

    expect({
      status: res.status,
      code: (res.body as any)?.error?.code,
      codec_invocations: built.optimizeCalls,
    }).toEqual({ status: 413, code: 'FILE_TOO_LARGE', codec_invocations: 0 });
  });

  it('NFR-AUTH-01: an image upload with no writer bearer token is rejected 401 before anything is stored', async () => {
    const api = await loadUploadImage();
    const { deps, stored } = buildUploadDeps({ article: articleRecord(), authValid: false });

    const res = await api.handleUploadImage(uploadReq({ authorization: null }), deps);

    expect({
      status: res.status,
      code: (res.body as any)?.error?.code,
      objects_stored: stored.length,
    }).toEqual({ status: 401, code: 'UNAUTHORIZED', objects_stored: 0 });
  });

  it('NFR-IDEM-02: replaying an upload with the same Idempotency-Key returns the original resource and uploads nothing a second time', async () => {
    const api = await loadUploadImage();
    const { deps, inserted } = buildUploadDeps({ article: articleRecord() });
    const req = uploadReq();

    const first = await api.handleUploadImage(req, deps);
    const replay = await api.handleUploadImage(req, deps);

    expect({
      same_resource: (replay.body as any).id === (first.body as any).id,
      rows_created: inserted.length,
    }).toEqual({ same_resource: true, rows_created: 1 });
  });
});
