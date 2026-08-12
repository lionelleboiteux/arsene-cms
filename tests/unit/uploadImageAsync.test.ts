import { describe, expect, it } from 'vitest';
import { loadPublishArticle, loadUploadImage } from '../support/seams.js';
import type { ImageRecord, PublishHttpRequest, UploadImageRequest } from '../support/seams.js';
import { buildPublishDeps, buildUploadDeps } from '../support/fakes.js';
import { validateAgainstSchema } from '../support/openapi.js';
import { ARTICLE_ID, NOW, articleRecord } from '../support/fixtures.js';
import { validJpeg } from '../support/imageFixtures.js';

/**
 * ADR-0004 — the upload endpoint stops doing the work.
 *
 * `05-verification.v1.md` §5 timed the WASM codec at 1.4-4.0s against real
 * photos, at or over Supabase Edge Functions' 2s CPU ceiling, for an ordinary
 * upload. ADR-0004's decision: the request stores the original and returns
 * `201 processing` immediately; a Lambda running real `sharp` does the
 * conversion (tests/unit/lambdaImage.test.ts) and calls back to flip the row
 * (tests/unit/imageStatusCallback.test.ts).
 *
 * Also here: the upload endpoint's missing rate limiter (§9 item 8), which is
 * the same handler and the same fakes, so it belongs at the same layer.
 *
 * NOTE FOR THE GREEN GATE: two assertions in the *existing*
 * tests/unit/uploadImage.test.ts encode the old synchronous behaviour — AC-07
 * expects `urls.optimized` on the upload response, AC-15 expects
 * `status: 'ready'` with alt text. Those cannot both hold with ADR-0004. They
 * were left untouched by this pass, deliberately; see
 * `03-red-evidence.v2.md` §5.
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

describe('asynchronous image pipeline (ADR-0004)', () => {
  it('VERIFY-05a / AC-07: an upload stores the original and returns 201 processing without ever handing the bytes to a codec, so the request cannot exceed the runtime’s CPU budget', async () => {
    const api = await loadUploadImage();
    // Not destructured: `optimizeCalls` is a live getter read after the call.
    const built = buildUploadDeps({ article: articleRecord() });

    const res = await api.handleUploadImage(uploadReq(), built.deps);
    const body = res.body as any;

    expect({
      status: res.status,
      contract_errors: validateAgainstSchema('ArticleImage', body),
      image_status: body.status,
      urls_while_processing: body.urls,
      codec_invocations: built.optimizeCalls,
      objects_stored: built.stored.length,
      stored_the_original: built.stored.every((s) => /original/.test(s.key)),
    }).toEqual({
      status: 201,
      contract_errors: [],
      image_status: 'processing',
      urls_while_processing: null,
      codec_invocations: 0,
      objects_stored: 1,
      stored_the_original: true,
    });
  });

  it('AC-08: an article whose cover is still processing after the asynchronous upload is refused at publish with IMAGE_NOT_READY, exactly as it was under the synchronous pipeline', async () => {
    const upload = await loadUploadImage();
    const publish = await loadPublishArticle();
    const uploaded = buildUploadDeps({ article: articleRecord() });

    const created = (await upload.handleUploadImage(uploadReq(), uploaded.deps)).body as any;
    // The row the upload actually created, fed to publish unchanged — the
    // point is that the state machine, not a hand-written status, blocks it.
    const image: ImageRecord = {
      id: String(created.id),
      article_id: ARTICLE_ID,
      role: 'cover',
      status: created.status,
      alt_text: created.alt_text ?? null,
    };
    const { deps } = buildPublishDeps({ now: NOW, article: articleRecord(), images: [image] });

    const res = await publish.handlePublishArticle(
      {
        article_id: ARTICLE_ID,
        authorization: 'Bearer writer.supabase.jwt',
        idempotency_key: null,
        client_ip: '203.0.113.7',
        body: {},
      } satisfies PublishHttpRequest,
      deps,
    );

    expect({ status: res.status, code: (res.body as any)?.error?.code }).toEqual({
      status: 409,
      code: 'IMAGE_NOT_READY',
    });
  });
});

// ---------------------------------------------------------------------------
// Upload rate limiting — 05-verification.v1.md §9 item 8 / H2b.
// The publish endpoint has NFR-RATE-01; the upload endpoint, which is the one
// that accepts 20 MB bodies, has no limiter wired in at all.
// ---------------------------------------------------------------------------

const ASSUMED_UPLOAD_RATE_LIMIT = 10;

type RateCase = { id: string; klass: string; attempts: number; from: string; status: number };

const RATE_CASES: RateCase[] = [
  {
    id: 'NFR-RATE-02a',
    klass: `the ${ASSUMED_UPLOAD_RATE_LIMIT}th upload in a minute from one IP is still served`,
    attempts: ASSUMED_UPLOAD_RATE_LIMIT,
    from: '203.0.113.7',
    status: 201,
  },
  {
    id: 'NFR-RATE-02b',
    klass: `the ${ASSUMED_UPLOAD_RATE_LIMIT + 1}th upload in a minute from the same IP is rejected with 429`,
    attempts: ASSUMED_UPLOAD_RATE_LIMIT + 1,
    from: '203.0.113.7',
    status: 429,
  },
  {
    id: 'NFR-RATE-02c',
    klass: 'a second writer on a different IP is unaffected by the first IP exhausting its budget',
    attempts: 1,
    from: '198.51.100.4',
    status: 201,
  },
];

describe('upload rate limiting', () => {
  it.each(RATE_CASES.map((c) => [`${c.id}: ${c.klass}`, c] as const))('%s', async (_title, c) => {
    const api = await loadUploadImage();
    const { deps } = buildUploadDeps({
      article: articleRecord(),
      rateLimit: ASSUMED_UPLOAD_RATE_LIMIT,
    });

    // A distinct Idempotency-Key per attempt, so the limiter is what stops
    // the flood and never the idempotency replay cache.
    const spam = async (times: number, ip: string) => {
      let last: { status: number; body: Record<string, unknown> } | null = null;
      for (let i = 0; i < times; i += 1) {
        last = await api.handleUploadImage(
          uploadReq({ idempotency_key: `key-${ip}-${i}`, client_ip: ip }),
          deps,
        );
      }
      return last!;
    };

    if (c.from !== '203.0.113.7') await spam(ASSUMED_UPLOAD_RATE_LIMIT + 1, '203.0.113.7');
    const res = await spam(c.attempts, c.from);

    expect(res.status).toBe(c.status);
  });
});
