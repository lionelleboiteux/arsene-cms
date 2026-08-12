/**
 * `libheif-js` ships no type declarations. Only the three members `heic.ts`
 * uses are declared here — the rest of its surface is not this build's concern.
 */
declare module 'libheif-js/wasm-bundle' {
  export type HeifImage = {
    get_width(): number;
    get_height(): number;
    /** Fills `target.data` with RGBA pixels; calls back with `null` on failure. */
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      done: (result: unknown) => void,
    ): void;
  };

  const libheif: {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
  };

  export default libheif;
}
