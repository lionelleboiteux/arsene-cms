/**
 * Container sniffing, shared by the upload endpoint and the Lambda optimiser
 * (ADR-0004). Format is decided from the bytes, never from what the upload
 * claims to be, and never by decoding — the decode happens in Lambda, off the
 * request path.
 */

/** The source formats contracts/openapi.yaml advertises as accepted. */
export type SourceFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heic';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** ISO base media file format: `....ftyp<brand>`. */
const ftypBrand = (bytes: Uint8Array): string =>
  ascii(bytes, 4, 4) === 'ftyp' ? ascii(bytes, 8, 4) : '';

const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'];

/** `null` means "not a container this pipeline accepts at all". */
export function sniffImageFormat(bytes: Uint8Array): SourceFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP') return 'webp';

  const brand = ftypBrand(bytes);
  if (brand === 'avif' || brand === 'avis') return 'avif';
  if (HEIC_BRANDS.includes(brand)) return 'heic';
  return null;
}

/**
 * Cheap completeness check for the two containers that end in an explicit
 * terminator: a JPEG must end with EOI, a PNG with IEND. A file that sniffs as
 * one of them but stops short was truncated or damaged, and there is no point
 * sending it round the S3/Lambda loop to find that out.
 *
 * The ISO-BMFF/RIFF containers declare their own lengths inside the file, so
 * their integrity is the decoder's job, in Lambda — where a failure becomes a
 * `failed` status through the callback like any other undecodable file.
 */
export function isDamagedContainer(bytes: Uint8Array, format: SourceFormat): boolean {
  const end = bytes.byteLength;
  if (format === 'jpeg') return !(bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9);
  if (format === 'png') return ascii(bytes, end - 8, 4) !== 'IEND';
  return false;
}
