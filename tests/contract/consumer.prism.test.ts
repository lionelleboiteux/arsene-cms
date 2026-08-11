import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiClient } from '../support/seams.js';
import { contractOperations, validateAgainstSchema } from '../support/openapi.js';
import { startPrismMock, type PrismMock } from '../support/prism.js';
import { ARTICLE_ID } from '../support/fixtures.js';
import { validJpeg } from '../support/imageFixtures.js';

/**
 * CONSUMER side of Arsène's own OpenAPI contract. The editor SPA's client is
 * exercised against a Prism mock generated from
 * pdlc/arsene-cms/contracts/openapi.yaml, and every response it returns is
 * validated against the contract's own schema — so the client cannot pass by
 * agreeing with a hand-written fixture.
 */

const WRITER_TOKEN = 'test.supabase.writer.jwt';
const IDEMPOTENCY_KEY = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b';

let prism: PrismMock;

beforeAll(async () => {
  prism = await startPrismMock();
}, 120_000);

afterAll(async () => {
  await prism?.stop();
});

type ConsumerCase = {
  operationId: string;
  responseSchema: string;
  call: (client: any) => Promise<unknown>;
};

const CONSUMER_CASES: ConsumerCase[] = [
  {
    operationId: 'publishArticle',
    responseSchema: 'PublishResponse',
    call: (c) =>
      c.publishArticle({
        articleId: ARTICLE_ID,
        meta_title: 'Pronos Ligue 1 – Journée 12 : nos pronostics',
      }),
  },
  {
    operationId: 'uploadArticleImage',
    responseSchema: 'ArticleImage',
    call: (c) =>
      c.uploadArticleImage({
        articleId: ARTICLE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        role: 'cover',
        file: { filename: 'psg-om-cover.jpg', content_type: 'image/jpeg', bytes: validJpeg() },
      }),
  },
];

/** Each documented failure the editor must render differently from the others. */
const ERROR_CASES = [
  {
    id: 'DEC-01',
    operationId: 'publishArticle',
    prefer: 'code=400, example=missingCoverImage',
    expectedCode: 'COVER_IMAGE_REQUIRED',
    why: 'so the editor can point the writer at "add a cover image", not a generic banner',
  },
  {
    id: 'AC-08',
    operationId: 'publishArticle',
    prefer: 'code=409, example=imageStillProcessing',
    expectedCode: 'IMAGE_NOT_READY',
    why: 'so the editor can say "try again in a few seconds" rather than "locked"',
  },
  {
    id: 'AC-05',
    operationId: 'publishArticle',
    prefer: 'code=409, example=draftLocked',
    expectedCode: 'DRAFT_LOCKED',
    why: 'so the editor names the writer holding the lock — the same 409 as IMAGE_NOT_READY',
  },
  {
    id: 'NFR-AUTH-01',
    operationId: 'publishArticle',
    prefer: 'code=401',
    expectedCode: 'UNAUTHORIZED',
    why: 'so an expired session prompts re-login instead of looking like a content error',
  },
  {
    id: 'NFR-UPLOAD-01',
    operationId: 'uploadArticleImage',
    prefer: 'code=413',
    expectedCode: 'FILE_TOO_LARGE',
    why: 'so the writer is told the file is too big, not that it is broken',
  },
  {
    id: 'AC-08',
    operationId: 'uploadArticleImage',
    prefer: 'code=422',
    expectedCode: 'UNSUPPORTED_FORMAT',
    why: 'so the writer is asked to upload a different file (AC-08’s clear error message)',
  },
] as const;

const callOperation = (client: any, operationId: string) =>
  operationId === 'publishArticle'
    ? client.publishArticle({ articleId: ARTICLE_ID })
    : client.uploadArticleImage({
        articleId: ARTICLE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        role: 'cover',
        file: { filename: 'psg-om-cover.jpg', content_type: 'image/jpeg', bytes: validJpeg() },
      });

describe('OpenAPI consumer contract (Prism mock)', () => {
  it.each(
    CONSUMER_CASES.map(
      (c) =>
        [
          `CONTRACT-CONSUMER-${c.operationId}: the client parses a contract-valid response into the shape the contract declares`,
          c,
        ] as const,
    ),
  )('%s', async (_title, { responseSchema, call }) => {
    const { createArseneClient } = await loadApiClient();
    const client = createArseneClient({ baseUrl: prism.baseUrl, bearerToken: WRITER_TOKEN });

    const result = await call(client);

    expect(validateAgainstSchema(responseSchema, result)).toEqual([]);
  });

  it.each(
    ERROR_CASES.map(
      (c) =>
        [
          `CONTRACT-CONSUMER-${c.operationId} / ${c.id}: the client surfaces ${c.expectedCode} as a branchable code, ${c.why}`,
          c,
        ] as const,
    ),
  )('%s', async (_title, { operationId, prefer, expectedCode }) => {
    const { createArseneClient } = await loadApiClient();
    const client = createArseneClient({
      baseUrl: prism.baseUrl,
      bearerToken: WRITER_TOKEN,
      headers: { Prefer: prefer },
    });

    const code = await callOperation(client, operationId)
      .then(() => 'no-error-thrown')
      .catch((err: { code?: string }) => err.code);

    expect(code).toBe(expectedCode);
  });

  it('CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer test in this file', () => {
    const declared = contractOperations().map((o) => o.operationId).sort();

    expect(CONSUMER_CASES.map((c) => c.operationId).sort()).toEqual(declared);
  });
});
