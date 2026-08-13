import { describe, expect, it } from 'vitest';
import { loadUploadImage } from '../support/seams.js';
import type { UploadImageRequest } from '../support/seams.js';
import { buildUploadDeps } from '../support/fakes.js';
import { ARTICLE_ID, NOW, WRITER_A, WRITER_A_NAME, articleRecord, t } from '../support/fixtures.js';
import { validJpeg } from '../support/imageFixtures.js';

/**
 * M-V4-02 (`05-verification.v4.md` §6, Medium) — **upload does not check the
 * draft lock; publish does.** Proven live by the verify pass:
 *
 *   writer B opens the draft (takes the lock)   -> 200
 *   writer A publishes it                       -> 409 DRAFT_LOCKED  (refused)
 *   writer A uploads a cover to the SAME draft  -> 201               (accepted)
 *
 * `publishArticle.ts` calls `evaluateLock` and refuses; `uploadImage.ts` never
 * calls it at all. So a writer explicitly told "someone else is editing this"
 * on one route walks in through another and replaces the cover of a draft a
 * colleague is mid-session on — the concurrent-edit conflict AC-05 exists to
 * prevent, inside the server seam rather than through a PostgREST bypass.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS ARE SHAPED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 *
 * 1. **At the handler, not end to end.** The whole mechanism is one call to
 *    `evaluateLock` on `article.locked_by`/`locked_at`, and `repo.getArticle`
 *    already selects both columns for every route (`ARTICLE_SQL`), so this is
 *    the fastest layer that can prove it — the same layer, and the same
 *    fixture shape, as the `AC-05` refusal case publish is already held to in
 *    tests/unit/publishArticle.test.ts.
 *
 * 2. **The world, not only the answer.** A `409` returned after `insertImage`
 *    has already run would still have replaced the colleague's cover, so the
 *    refusal case asserts that no image row was created.
 *
 * 3. **Two lock states, because a hand-rolled `locked_by !== me` check passes
 *    the first and breaks AC-05.** `NFR-UPLOAD-LOCK-02` is the both-sides
 *    control: a lock a colleague abandoned 102 seconds ago is stale, and the
 *    takeover AC-05 promises with no admin unlock must keep working for
 *    uploads too. It passes today and must still pass afterwards. (The other
 *    half of the control — that a writer holding the lock themselves can still
 *    upload — is already carried by every existing test in
 *    tests/unit/uploadImage.test.ts: `articleRecord()` is locked by `WRITER_B`,
 *    which is exactly who those uploads authenticate as.)
 */

const uploadReq = (overrides: Partial<UploadImageRequest> = {}): UploadImageRequest => ({
  article_id: ARTICLE_ID,
  authorization: 'Bearer writer.supabase.jwt',
  idempotency_key: 'b7c6d5e4-3f2a-4b1c-8d9e-0f1a2b3c4d5e',
  client_ip: '203.0.113.7',
  role: 'cover',
  file: { filename: 'psg-om-cover.jpg', content_type: 'image/jpeg', bytes: validJpeg() },
  ...overrides,
});

type LockCase = {
  id: string;
  klass: string;
  /** `NOW` is 2026-08-11T10:47:12Z. */
  locked_at: Date;
  status: number;
  code: string | undefined;
  rows_created: number;
};

const LOCK_CASES: LockCase[] = [
  {
    id: 'NFR-UPLOAD-LOCK-01',
    klass:
      'a draft another writer is actively holding the edit lock on (12 s old, well inside the staleness window) is refused 409 DRAFT_LOCKED with nothing written — the same refusal publish already gives, so a writer turned away there cannot replace the same colleague’s cover through here',
    locked_at: t('2026-08-11T10:47:00Z'),
    status: 409,
    code: 'DRAFT_LOCKED',
    rows_created: 0,
  },
  {
    id: 'NFR-UPLOAD-LOCK-02',
    klass:
      'a draft another writer left locked 102 seconds ago is uploaded to normally — AC-05’s stale-lock takeover, with no admin unlock, must survive the new check',
    locked_at: t('2026-08-11T10:45:30Z'),
    status: 201,
    code: undefined,
    rows_created: 1,
  },
];

describe('image upload and the draft lock (verify v4, M-V4-02)', () => {
  it.each(LOCK_CASES.map((c) => [`${c.id}: uploading a cover to ${c.klass}`, c] as const))(
    '%s',
    async (_title, c) => {
      const api = await loadUploadImage();
      const { deps, inserted } = buildUploadDeps({
        now: NOW,
        // Locked by WRITER_A; the upload authenticates as WRITER_B, which is
        // what `buildUploadDeps`' auth fake answers — the same pairing as
        // publish's own AC-05 case.
        article: articleRecord({ locked_by: WRITER_A, locked_at: c.locked_at }),
        display_name: WRITER_A_NAME,
      });

      const res = await api.handleUploadImage(uploadReq(), deps);

      expect({
        status: res.status,
        code: (res.body as any)?.error?.code,
        locked_by_writer_id: (res.body as any)?.error?.details?.locked_by_writer_id,
        rows_created: inserted.length,
      }).toEqual({
        status: c.status,
        code: c.code,
        locked_by_writer_id: c.status === 409 ? WRITER_A : undefined,
        rows_created: c.rows_created,
      });
    },
  );
});
