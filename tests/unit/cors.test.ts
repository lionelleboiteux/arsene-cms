import { describe, expect, it } from 'vitest';
import { loadApiRouter } from '../support/seams.js';

/**
 * CORS-01 — the editor SPA (arsene.fantasy-coach.fr) is a different origin
 * from `arsene-api`, and nothing in `router.ts` has ever set a single
 * `Access-Control-*` header. `parseCorsOrigins` turns the deployment's
 * `CORS_ALLOWED_ORIGINS` env var (a comma-separated string, since that is the
 * only shape an env var can take) into the allow-list `route()` checks
 * requests against — pure, so it is tested in isolation from the server.
 */
describe('parseCorsOrigins', () => {
  it('returns an empty list for undefined, empty, or whitespace-only input', async () => {
    const { parseCorsOrigins } = await loadApiRouter();

    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
  });

  it('splits a comma-separated list and trims whitespace around each origin', async () => {
    const { parseCorsOrigins } = await loadApiRouter();

    expect(
      parseCorsOrigins('https://arsene.fantasy-coach.fr, http://localhost:5173 '),
    ).toEqual(['https://arsene.fantasy-coach.fr', 'http://localhost:5173']);
  });

  it('drops empty entries left by stray commas without dropping real ones', async () => {
    const { parseCorsOrigins } = await loadApiRouter();

    expect(parseCorsOrigins('https://a.example,,https://b.example,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
