/**
 * HEVC-in-HEIF decoding, for the one source format `sharp` cannot open.
 *
 * ADR-0004 expected `sharp` alone to decode every advertised source format.
 * That holds for JPEG/PNG/WebP/AVIF, but `sharp`'s prebuilt libvips ships a
 * libheif with the AV1 decoder only: a real iPhone HEIC (HEVC) fails with
 * "Support for this compression format has not been built in". This module is
 * the smallest thing that closes that gap — a WASM libheif that decodes HEVC to
 * RGBA, which `sharp` then encodes as usual. Loaded lazily: nothing pays for
 * 6 MB of WASM unless a HEIC actually arrives.
 */

export type RgbaImage = { data: Uint8Array; width: number; height: number };

const CHANNELS = 4;

export async function decodeHeic(bytes: Uint8Array): Promise<RgbaImage> {
  const { default: libheif } = await import('libheif-js/wasm-bundle');
  const [image] = new libheif.HeifDecoder().decode(bytes);
  if (image === undefined) throw new Error('the HEIF container holds no image');

  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * CHANNELS);
  await new Promise<void>((resolve, reject) => {
    image.display({ data, width, height }, (result) =>
      result === null ? reject(new Error('the HEIF image could not be decoded')) : resolve(),
    );
  });

  return { data: new Uint8Array(data.buffer), width, height };
}
