import { describe, expect, it } from 'vitest';
import { parseKey } from '../../lambda/imageConvert/handler.ts';

/**
 * ADR-0004 — the S3 object key is the only place `article_images.id` lives
 * once the request that created the row has finished; the Lambda has
 * nothing else to report status against. `src/api/s3Storage.ts` writes
 * `originals/{key}` where `key` is exactly what `uploadImage.ts` passes:
 * `${id}-original-${filename}`.
 */
describe('parseKey', () => {
  it('extracts the image id and filename from a real object key', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-original-psg-om-cover.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      filename: 'psg-om-cover.jpg',
    });
  });

  it('URL-decodes a key S3 events deliver percent-encoded, including spaces as +', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-original-photo+de+match.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      filename: 'photo de match.jpg',
    });
  });

  it('handles a filename that itself contains hyphens without truncating it', () => {
    expect(
      parseKey('originals/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc-original-my-cover-photo-final.jpg'),
    ).toEqual({
      imageId: 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc',
      filename: 'my-cover-photo-final.jpg',
    });
  });

  it('throws on a key that does not match the expected shape, rather than silently misreporting some other image', () => {
    expect(() => parseKey('optimized/c3c3c3c3-0000-4a2b-9c3d-cccccccccccc.webp')).toThrow(/does not match/);
    expect(() => parseKey('originals/not-a-uuid-original-cover.jpg')).toThrow(/does not match/);
  });
});
