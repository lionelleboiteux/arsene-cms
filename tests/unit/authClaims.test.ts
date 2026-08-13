import { describe, expect, it } from 'vitest';
import { loadAuth } from '../support/seams.js';
import { WRITER_A } from '../support/fixtures.js';
import { SUPABASE_ISSUER, TEST_JWT_SECRET, mintSupabaseJwt } from '../support/jwt.js';

/**
 * L-V3-02 (`05-verification.v3.md` §6) — `verifySupabaseJwt` requires neither
 * `exp` nor `iss`/`aud`/`role`.
 *
 * `src/api/auth.ts` calls `jwtVerify` with `{ algorithms: ['HS256'],
 * currentDate }` and then checks `sub`. `jose` enforces `exp` only when the
 * claim is present, and enforces `issuer`/`audience` only when it is told what
 * to expect — so today a signature-valid token with **no `exp` at all** is
 * accepted and never expires, and any `iss`/`aud`/`role` passes. The verify
 * report groups this with H-V3-01 and asks for it in the same change: "require
 * `exp`, pin `issuer` to the project's `/auth/v1` URL, require
 * `role === 'authenticated'`".
 *
 * This is the fastest layer that can prove any of it: claim validation is a
 * pure function of (token, secret, now, expected issuer). Tokens are minted for
 * real by `tests/support/jwt.ts` — same algorithm, same claim set Supabase
 * issues — so the production verifier meets the real token shape. Nothing here
 * is a mock, and no server or database is involved, because none is needed.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PASS CHOSE, stated so the implementer is not guessing.
 * ---------------------------------------------------------------------------
 *
 *   - `exp` is **required**, unconditionally. A Supabase access token always
 *     carries one; a token that does not is not one, whatever it is.
 *   - `iss` is pinned to a **configured** expected issuer, passed as
 *     `opts.issuer`, because the value contains the project ref and cannot be
 *     a constant in the source. Optional in the signature so the six existing
 *     `NFR-JWT-*` cases keep calling this seam exactly as they do today —
 *     their assertions are untouched by this pass.
 *   - `aud` must be `'authenticated'` and `role` must be `'authenticated'`.
 *     These are **fixed** expectations rather than configuration: Supabase
 *     issues those two literal values for every user access token, and the
 *     value that matters to refuse — `role: 'anon'`, carried by the project's
 *     public anon key that every editor SPA ships to the browser — is fixed
 *     too. `NFR-JWT-10` is that case.
 *
 * `NFR-JWT-11` is the both-sides half: a fully correct token, verified with the
 * expected issuer configured, must still be accepted with `writer_id` from its
 * `sub`. It passes today (the extra option is inert), and it is here so that
 * "refuse everything" cannot satisfy this family.
 */

const NOW = new Date('2026-08-13T09:00:00Z');

/** Another project's tokens are signed by another key — but a leaked or shared
 *  secret, or a project clone, makes `iss` the only thing left to check. */
const OTHER_PROJECT_ISSUER = 'https://someotherref.supabase.co/auth/v1';

type ClaimCase = {
  id: string;
  klass: string;
  token(): Promise<string>;
  valid: boolean;
  writer_id: string | undefined;
};

const CASES: ClaimCase[] = [
  {
    id: 'NFR-JWT-07',
    klass:
      'a correctly signed token carrying no exp claim at all, which therefore never expires and can never be aged out',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW, noExpiry: true }),
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-08',
    klass: 'a token whose iss names a different Supabase project than the one this deployment trusts',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW, issuer: OTHER_PROJECT_ISSUER }),
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-09',
    klass: 'a token whose aud is not this API at all',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW, audience: 'apikey' }),
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-10',
    klass:
      'a token whose role is anon rather than authenticated — the claim the project’s public anon key carries, which every editor SPA ships to the browser',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW, role: 'anon' }),
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-11',
    klass:
      'a fully Supabase-shaped token — signed, unexpired, this project’s issuer, aud and role both authenticated',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW }),
    valid: true,
    writer_id: WRITER_A,
  },
];

describe('Supabase Auth JWT claim validation (verify v3, L-V3-02)', () => {
  it.each(
    CASES.map(
      (c) =>
        [
          `${c.id}: ${c.klass} is ${c.valid ? 'accepted, with writer_id taken from its sub claim' : 'refused, with no writer attributed'}`,
          c,
        ] as const,
    ),
  )('%s', async (_title, c) => {
    const { verifySupabaseJwt } = await loadAuth();

    const result = await verifySupabaseJwt(await c.token(), {
      secret: TEST_JWT_SECRET,
      now: NOW,
      issuer: SUPABASE_ISSUER,
    });

    expect({ valid: result.valid, writer_id: result.writer_id }).toEqual({
      valid: c.valid,
      writer_id: c.writer_id,
    });
  });
});
