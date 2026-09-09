import { describe, expect, it } from 'vitest';
import { loadImageStatus } from '../support/seams.js';
import type { ImageStatusCallbackRequest, ImageStatusRow } from '../support/seams.js';
import { IMAGE_CALLBACK_SECRET, buildImageStatusDeps } from '../support/fakes.js';
import { ARTICLE_ID, COVER_IMAGE_ID, COVER_OPTIMIZED_URL } from '../support/fixtures.js';

/**
 * ADR-0004's new trust boundary: Lambda is not a writer, so it cannot carry a
 * writer bearer token, and the callback that flips
 * `article_images.status` therefore needs its own shared secret, rotatable
 * independently of writer credentials. ADR-0004, "Negative": "otherwise
 * anything that can reach that endpoint could mark an unprocessed or malicious
 * image as `ready`", and "the callback can only move `processing` ->
 * `ready`/`failed` for the one `article_images.id` it names".
 *
 * The DB half — that an accepted callback really writes `optimized_url` — is
 * in tests/db/remediation.test.ts against real Postgres. Everything here is
 * the handler's own decision-making, so it needs neither.
 */

const processingRow = (
  overrides: Partial<Extract<ImageStatusRow, { owner: 'article' }>> = {},
): ImageStatusRow => ({
  id: COVER_IMAGE_ID,
  owner: 'article',
  article_id: ARTICLE_ID,
  status: 'processing',
  ...overrides,
});

const callback = (
  overrides: Partial<ImageStatusCallbackRequest> = {},
): ImageStatusCallbackRequest => ({
  image_id: COVER_IMAGE_ID,
  callback_secret: IMAGE_CALLBACK_SECRET,
  body: { status: 'ready', optimized_url: COVER_OPTIMIZED_URL, failure: null },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Authentication — its own secret, not the writer's
// ---------------------------------------------------------------------------

type AuthCase = { id: string; klass: string; secret: string | null };

const AUTH_CASES: AuthCase[] = [
  { id: 'NFR-CALLBACK-01a', klass: 'carrying no callback secret at all', secret: null },
  {
    id: 'NFR-CALLBACK-01b',
    klass: 'carrying a writer’s bearer token instead of the callback secret',
    secret: 'red-gate-writer-token',
  },
];

describe('image status callback authentication', () => {
  it.each(AUTH_CASES.map((c) => [`${c.id}: a status callback ${c.klass} is refused 401 and flips nothing`, c] as const))(
    '%s',
    async (_title, c) => {
      const api = await loadImageStatus();
      const { deps, updates } = buildImageStatusDeps({ row: processingRow() });

      const res = await api.handleImageStatusCallback(callback({ callback_secret: c.secret }), deps);

      expect({
        status: res.status,
        code: (res.body as any)?.error?.code,
        rows_updated: updates.length,
      }).toEqual({ status: 401, code: 'UNAUTHORIZED', rows_updated: 0 });
    },
  );
});

// ---------------------------------------------------------------------------
// The state machine — only processing -> ready/failed
// ---------------------------------------------------------------------------

type TransitionCase = {
  id: string;
  klass: string;
  row: ImageStatusRow | null;
  req: Partial<ImageStatusCallbackRequest>;
  status: number;
  updates: number;
};

const TRANSITIONS: TransitionCase[] = [
  {
    id: 'NFR-CALLBACK-02a',
    klass: 'a processing row told the conversion succeeded becomes ready',
    row: processingRow(),
    req: {},
    status: 200,
    updates: 1,
  },
  {
    id: 'NFR-CALLBACK-02b',
    klass: 'a processing row told the conversion failed becomes failed, carrying the reason',
    row: processingRow(),
    req: {
      body: {
        status: 'failed',
        optimized_url: null,
        failure: { code: 'CORRUPTED_FILE', message: 'could not be decoded' },
      },
    },
    status: 200,
    updates: 1,
  },
  {
    id: 'NFR-CALLBACK-02c',
    klass: 'a row that already left processing is not flipped a second time, so a replayed or forged callback cannot overwrite a settled image',
    row: processingRow({ status: 'ready' }),
    req: {},
    status: 409,
    updates: 0,
  },
  {
    id: 'NFR-CALLBACK-02d',
    klass: 'a callback naming an image id that does not exist is a 404 rather than a crash or a silent success',
    row: null,
    req: { image_id: 'f0f0f0f0-0000-4a2b-9c3d-000000000009' },
    status: 404,
    updates: 0,
  },
];

describe('image status callback state machine', () => {
  it.each(TRANSITIONS.map((c) => [`${c.id}: ${c.klass}`, c] as const))('%s', async (_title, c) => {
    const api = await loadImageStatus();
    const { deps, updates } = buildImageStatusDeps({ row: c.row });

    const res = await api.handleImageStatusCallback(callback(c.req), deps);

    expect({ status: res.status, rows_updated: updates.length }).toEqual({
      status: c.status,
      rows_updated: c.updates,
    });
  });
});
