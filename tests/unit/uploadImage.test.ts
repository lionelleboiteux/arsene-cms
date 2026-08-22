import { describe, expect, it } from 'vitest';
import { loadUploadImage } from '../support/seams.js';
import type { UploadImageRequest } from '../support/seams.js';
import { buildUploadDeps } from '../support/fakes.js';
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
  // AC-07 (synchronous "comes back optimized" version) was deleted here,
  // deliberately, by Bob at the close of the ADR-0004 remediation red gate —
  // not by the green-gate implementer. ADR-0004 moves optimization off this
  // handler entirely (see adr/0004-s3-lambda-image-pipeline.md); the upload
  // response no longer contains `urls.optimized` at all, so this assertion
  // describes a contract the handler must no longer satisfy. It is superseded
  // by two tests that together prove the same thing about the new shape:
  // tests/unit/uploadImageAsync.test.ts's "VERIFY-05a / AC-07" (the handler
  // returns 201/processing/urls:null and never invokes the codec) and
  // tests/unit/lambdaImage.test.ts's "AC-07/D7-*" table (the codec itself,
  // exercised for real against real photographic bytes, still produces a
  // smaller modern-format file — just in the Lambda handler, not here).

  it('AC-15: an upload response keeps alt_text null while processing, exactly as the contract documents', async () => {
    const api = await loadUploadImage();
    const { deps } = buildUploadDeps({ article: articleRecord({ title: 'PSG vs Marseille' }) });

    const res = await api.handleUploadImage(uploadReq(), deps);
    const body = res.body as any;

    // contracts/openapi.yaml's "Alt text (AC-15)" note is explicit: alt_text
    // is included on the resource once ready, and "null until then" — so the
    // *response* withholds it regardless of when it was computed internally.
    expect({ status: body.status, alt_text: body.alt_text }).toEqual({
      status: 'processing',
      alt_text: null,
    });
  });

  it('AC-15: alt text is nonetheless generated from the article’s own context and persisted at upload time, so it is ready the moment processing completes rather than computed later', async () => {
    const api = await loadUploadImage();
    const { deps, inserted } = buildUploadDeps({
      article: articleRecord({ title: 'PSG vs Marseille' }),
    });

    await api.handleUploadImage(uploadReq(), deps);

    // Alt text is derived from the article's own title/content, not from the
    // processed pixels — there is no reason to wait for the Lambda callback
    // to compute it, only to *expose* it (see the test above). This asserts
    // the persisted row the callback will later flip to `ready`, not the
    // withheld API response.
    const insertedAltText = inserted[0]?.alt_text;
    expect(typeof insertedAltText === 'string' && insertedAltText.length > 0).toBe(true);
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
