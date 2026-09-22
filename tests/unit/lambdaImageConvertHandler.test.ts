import { describe, expect, it } from 'vitest';
import { parseKey } from '../../lambda/imageConvert/handler.ts';

/**
 * ADR-0004 — the S3 object key is the only place `article_images.id` lives
 * once the request that created the row has finished; the Lambda has
 * nothing else to report status against. `src/api/s3Storage.ts` writes
 * `originals/{key}` where `key` is exactly what `uploadImage.ts` passes:
 * `${id}-${role}-original-${filename}` — `role` rides along here (0013)
 * since this Lambda has no DB of its own to look it up from, and needs to
 * know whether to also build a 1200x630 og-image crop (cover only).
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

  it('throws on a key that does not match the expected shape, rather than silently misreporting some other image', () => {
    expect(() => parseKey('optimized/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc.webp')).toThrow(/does not match/);
    expect(() => parseKey('originals/not-a-uuid-cover-original-cover.jpg')).toThrow(/does not match/);
    // The pre-0013 key shape (no role segment) must not silently parse.
    expect(() => parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-original-cover.jpg')).toThrow(
      /does not match/,
    );
  });
});
