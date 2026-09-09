import { describe, expect, it } from 'vitest';
import { handleUploadAvatar, type UploadAvatarDeps, type UploadAvatarRequest } from '../../src/api/uploadAvatar.js';
import { corruptedJpeg, oversizedJpeg, unsupportedFile, validJpeg } from '../support/imageFixtures.js';

/**
 * `POST /v1/writers/me/avatar` — deliberately much simpler than
 * `tests/unit/uploadImage.test.ts`: no lock, no cover/body role, no
 * `Idempotency-Key`. The size/format/damage checks it does share with
 * article uploads are exercised here too, against the same real file
 * fixtures (`tests/support/imageFixtures.ts`), not placeholders.
 */

const WRITER_ID = '33333333-3333-3333-3333-333333333333';

function buildDeps(overrides: Partial<UploadAvatarDeps> = {}) {
  const inserted: Record<string, unknown>[] = [];
  const stored: { key: string; byte_size: number }[] = [];
  const deps: UploadAvatarDeps = {
    auth: { verifyBearer: async () => ({ valid: true, writer_id: WRITER_ID }) },
    repo: {
      insertAvatar: async (input) => {
        inserted.push({ ...input });
        return { id: input.id, created_at: new Date('2026-08-11T10:47:12Z') };
      },
    },
    storage: {
      put: async (key: string, bytes: Uint8Array) => {
        stored.push({ key, byte_size: bytes.byteLength });
        return { url: `https://cdn.fantasycoach.example/originals/${key}` };
      },
    },
    observability: { record: () => undefined },
    ...overrides,
  };
  return { deps, inserted, stored };
}

const uploadReq = (overrides: Partial<UploadAvatarRequest> = {}): UploadAvatarRequest => ({
  authorization: 'Bearer writer.supabase.jwt',
  file: { filename: 'photo.jpg', content_type: 'image/jpeg', bytes: validJpeg() },
  ...overrides,
});

describe('avatar upload', () => {
  it('AVATAR-01: a valid image is stored and returns 201 processing, no idempotency key required', async () => {
    const { deps, inserted, stored } = buildDeps();

    const res = await handleUploadAvatar(uploadReq(), deps);

    expect({
      status: res.status,
      body_status: (res.body as { status: string }).status,
      rows_created: inserted.length,
      objects_stored: stored.length,
    }).toEqual({ status: 201, body_status: 'processing', rows_created: 1, objects_stored: 1 });
  });

  it('AVATAR-02: no writer bearer token at all is refused 401 before anything is stored', async () => {
    const { deps, inserted, stored } = buildDeps({ auth: { verifyBearer: async () => ({ valid: false }) } });

    const res = await handleUploadAvatar(uploadReq({ authorization: null }), deps);

    expect({
      status: res.status,
      code: (res.body as { error?: { code?: string } }).error?.code,
      rows_created: inserted.length,
      objects_stored: stored.length,
    }).toEqual({ status: 401, code: 'UNAUTHORIZED', rows_created: 0, objects_stored: 0 });
  });

  it('AVATAR-03: a file whose format cannot be recognised is refused with a clear error and creates no row at all', async () => {
    const { deps, inserted } = buildDeps();

    const res = await handleUploadAvatar(
      uploadReq({ file: { filename: 'notes.pdf', content_type: 'application/pdf', bytes: unsupportedFile() } }),
      deps,
    );

    expect({
      status: res.status,
      code: (res.body as { error?: { code?: string } }).error?.code,
      rows_created: inserted.length,
    }).toEqual({ status: 422, code: 'UNSUPPORTED_FORMAT', rows_created: 0 });
  });

  it('AVATAR-04: a file that passes format detection but fails to decode becomes a failed row the writer is told to replace', async () => {
    const { deps } = buildDeps();

    const res = await handleUploadAvatar(
      uploadReq({ file: { filename: 'broken.jpg', content_type: 'image/jpeg', bytes: corruptedJpeg() } }),
      deps,
    );
    const body = res.body as { status: string; failure?: { code?: string }; avatar_url: string | null };

    expect({
      status: res.status,
      row_status: body.status,
      failure_code: body.failure?.code,
      avatar_url: body.avatar_url,
    }).toEqual({ status: 201, row_status: 'failed', failure_code: 'CORRUPTED_FILE', avatar_url: null });
  });

  it('AVATAR-05: a file over the 20 MB limit is rejected 413 before anything is stored', async () => {
    const { deps, inserted, stored } = buildDeps();

    const res = await handleUploadAvatar(
      uploadReq({ file: { filename: 'huge.jpg', content_type: 'image/jpeg', bytes: oversizedJpeg() } }),
      deps,
    );

    expect({
      status: res.status,
      code: (res.body as { error?: { code?: string } }).error?.code,
      rows_created: inserted.length,
      objects_stored: stored.length,
    }).toEqual({ status: 413, code: 'FILE_TOO_LARGE', rows_created: 0, objects_stored: 0 });
  });
});
