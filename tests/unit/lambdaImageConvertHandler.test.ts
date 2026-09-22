import { describe, expect, it } from 'vitest';
import { parseKey } from '../../lambda/imageConvert/handler.ts';

/**
 * ADR-0004 — the S3 object key is the only place `article_images.id`/
 * `writer_avatars.id` lives once the request that created the row has
 * finished; the Lambda has nothing else to report status against.
 * `src/api/s3Storage.ts` writes `originals/{key}` where `key` is exactly
 * what the two upload routes pass:
 *
 *   uploadImage.ts:  `${id}-${role}-original-${filename}` (article images)
 *   uploadAvatar.ts: `${id}-original-${filename}` (writer avatars)
 *
 * `role` rides along for an article image (0013) since this Lambda has no
 * DB of its own to look it up from, and needs to know whether to also
 * build a 1200x630 og-image crop (cover only) — but avatars share this
 * same callback route and this same Lambda (`imageStatus.ts`'s own doc
 * comment: "an article image or a writer avatar") and were never given a
 * role segment, since a profile photo has no cover/body distinction.
 * Requiring the role group broke every avatar upload outright (parseKey
 * throwing, uncaught, stuck `processing` forever) — confirmed live
 * 2026-09-22 within minutes of deploying that mistake — so it has to stay
 * optional, with `role: null` the correct, successful result for that
 * shape, not a thrown error.
 */
describe('parseKey', () => {
  it('extracts the image id, role and filename from a real cover object key', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-cover-original-psg-om-cover.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      role: 'cover',
      filename: 'psg-om-cover.jpg',
    });
  });

  it('extracts a body-role key the same way, just with a different role', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-body-original-in-article-photo.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      role: 'body',
      filename: 'in-article-photo.jpg',
    });
  });

  it('extracts a real avatar object key (no role segment at all) with role: null, not a thrown error', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-original-profile-photo.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      role: null,
      filename: 'profile-photo.jpg',
    });
  });

  it('URL-decodes a key S3 events deliver percent-encoded, including spaces as +', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-cover-original-photo+de+match.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      role: 'cover',
      filename: 'photo de match.jpg',
    });
  });

  it('handles a filename that itself contains hyphens without truncating it', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-cover-original-my-cover-photo-final.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      role: 'cover',
      filename: 'my-cover-photo-final.jpg',
    });
  });

  it('a filename that itself starts with "cover-" or "body-" is not mistaken for a role segment on an avatar key', () => {
    // "original-" only ever appears once in a real key (uploadImage.ts/
    // uploadAvatar.ts never emit it inside a filename) — but worth pinning
    // down explicitly, since (?:(cover|body)-)? is optional and greedy
    // matching order could plausibly misparse this differently.
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-original-cover-photo-of-me.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      role: null,
      filename: 'cover-photo-of-me.jpg',
    });
  });

  it('throws on a key that does not match the expected shape at all, rather than silently misreporting some other image', () => {
    expect(() => parseKey('optimized/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc.webp')).toThrow(/does not match/);
    expect(() => parseKey('originals/not-a-uuid-cover-original-cover.jpg')).toThrow(/does not match/);
    expect(() => parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-nooriginal-cover.jpg')).toThrow(
      /does not match/,
    );
  });
});
