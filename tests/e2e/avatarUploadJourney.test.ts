import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, bearer, mintSupabaseJwt } from '../support/jwt.js';
import { corruptedJpeg, validJpeg } from '../support/imageFixtures.js';

/**
 * `POST /v1/writers/me/avatar` — the same async upload -> S3 -> Lambda ->
 * callback loop (ADR-0004) article images already prove end-to-end
 * (`tests/e2e/heicDeployedRuntime.test.ts`'s `VERIFY-HEIC-02`), driven here
 * against the real spawned server (`startServer`, not the in-process
 * shortcut) so the dev/test Lambda shim (`router.ts`'s `avatarUpload()` ->
 * `ctx.shared.processUpload` -> `convert()`) is exercised the same way a
 * real deployment's S3 event would be, just for the writer-owned table
 * (`writer_avatars`, 0010) instead of `article_images`.
 */

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> }; writerId: string; token: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Lionel (avatar e2e)');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-legacy-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
    });
    started = { db, server, writerId, token: await mintSupabaseJwt({ sub: writerId }) };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

async function uploadAvatar(
  baseUrl: string,
  token: string,
  o: { filename: string; bytes: Uint8Array },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.set('file', new Blob([o.bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }), o.filename);
  const res = await fetch(`${baseUrl}/v1/writers/me/avatar`, {
    method: 'POST',
    headers: { authorization: bearer(token) },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** ADR-0004's pipeline is asynchronous: the row settles after the response. */
async function waitForAvatar(db: TestDatabase, writerId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.client.query<{ status: string; optimized_url: string | null }>(
      `select status, optimized_url from writer_avatars where writer_id = $1 order by created_at desc limit 1`,
      [writerId],
    );
    const row = res.rows[0];
    if (row?.status === 'ready' || row?.status === 'failed') return row;
    if (Date.now() > deadline) {
      return { status: `timed out while ${row?.status ?? 'no row existed'}`, optimized_url: null };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function getOwnWriter(baseUrl: string, token: string): Promise<{ status: number; avatar_url: unknown }> {
  const res = await fetch(`${baseUrl}/v1/writers/me`, { headers: { authorization: bearer(token) } });
  const body = (await res.json()) as { avatar_url?: unknown };
  return { status: res.status, avatar_url: body.avatar_url };
}

describe('a writer uploads their own avatar (0010, ADR-0004)', () => {
  it('AVATAR-E2E-01: a real image uploaded through the real spawned server converts to ready, and GET /v1/writers/me then reports it', async () => {
    const { db, server, writerId, token } = ctx();

    const before = await getOwnWriter(server.url, token);

    const upload = await uploadAvatar(server.url, token, { filename: 'moi.jpg', bytes: validJpeg() });
    const settled = await waitForAvatar(db, writerId);
    const after = await getOwnWriter(server.url, token);

    expect({
      avatar_url_before_any_upload: before.avatar_url,
      upload_status: upload.status,
      upload_says: upload.body.status,
      row_status: settled.status,
      row_optimized_url_is_set: typeof settled.optimized_url === 'string' && settled.optimized_url.length > 0,
      me_status_after: after.status,
      me_avatar_url_after: after.avatar_url,
    }).toEqual({
      avatar_url_before_any_upload: null,
      upload_status: 201,
      upload_says: 'processing',
      row_status: 'ready',
      row_optimized_url_is_set: true,
      me_status_after: 200,
      me_avatar_url_after: settled.optimized_url,
    });
  }, 120_000);

  it('AVATAR-E2E-02: a corrupted file is refused synchronously as a failed row, and GET /v1/writers/me still reports no avatar', async () => {
    const { db, server } = ctx();
    const otherWriterId = await seedWriter(db.client, 'Lionel (avatar e2e corrupted)');
    const scopedToken = await mintSupabaseJwt({ sub: otherWriterId });

    const upload = await uploadAvatar(server.url, scopedToken, {
      filename: 'casse.jpg',
      bytes: corruptedJpeg(),
    });
    const after = await getOwnWriter(server.url, scopedToken);

    expect({
      upload_status: upload.status,
      upload_says: upload.body.status,
      me_avatar_url_after: after.avatar_url,
    }).toEqual({ upload_status: 201, upload_says: 'failed', me_avatar_url_after: null });
  });
});
