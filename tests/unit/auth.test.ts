import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_MODULE_PATH, loadAuth } from '../support/seams.js';
import { REPO_ROOT } from '../support/pg.js';
import { WRITER_A, WRITER_B } from '../support/fixtures.js';
import { TEST_JWT_SECRET, WRONG_JWT_SECRET, mintSupabaseJwt } from '../support/jwt.js';

/**
 * VERIFY-03 — `05-verification.v1.md` H3: auth is one static shared secret
 * compared with `===`, so every request in the process is attributed to one
 * hardcoded `writerId` and a single leaked token can never be revoked per
 * account. `02-architecture.v1.md` §7/§10 and `contracts/openapi.yaml`
 * (`bearerFormat: JWT`) all already said Supabase Auth JWTs.
 *
 * This is the fastest layer that can prove it: signature, expiry and claim
 * extraction are a pure function of (token, secret, now). The two things that
 * genuinely need a server and a database — a valid token being accepted
 * end-to-end, and two different `sub`s producing two different writers in the
 * audit trail — live in tests/e2e/draftJourney.test.ts instead.
 *
 * Tokens are minted for real (HS256, Supabase's own algorithm and claim set)
 * by tests/support/jwt.ts. Nothing here is a mock.
 */

const NOW = new Date('2026-08-12T09:00:00Z');

type TokenCase = {
  id: string;
  klass: string;
  token(): Promise<string | null>;
  valid: boolean;
  writer_id: string | undefined;
};

const CASES: TokenCase[] = [
  {
    id: 'NFR-JWT-01',
    klass: 'a token Supabase signed with this project’s JWT secret, still within its expiry',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW }),
    valid: true,
    // The whole point: the identity comes from the token, not from a constant
    // the process was started with.
    writer_id: WRITER_A,
  },
  {
    id: 'NFR-JWT-02',
    klass: 'a well-formed token signed with somebody else’s secret',
    token: () => mintSupabaseJwt({ sub: WRITER_A, issuedAt: NOW, secret: WRONG_JWT_SECRET }),
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-03',
    klass: 'a correctly signed token whose exp has already passed',
    token: () =>
      mintSupabaseJwt({
        sub: WRITER_B,
        issuedAt: new Date(NOW.getTime() - 7_200_000),
        expiresAt: new Date(NOW.getTime() - 60_000),
      }),
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-04',
    klass: 'a string that is not a JWT at all (the old static shared secret, in fact)',
    token: async () => 'red-gate-writer-token',
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-05',
    klass: 'no Authorization header at all',
    token: async () => null,
    valid: false,
    writer_id: undefined,
  },
  {
    id: 'NFR-JWT-06',
    klass: 'a correctly signed, unexpired token carrying no sub claim, so no writer can be attributed',
    token: () => mintSupabaseJwt({ sub: null, issuedAt: NOW }),
    valid: false,
    writer_id: undefined,
  },
];

describe('Supabase Auth JWT verification', () => {
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
    });

    expect({ valid: result.valid, writer_id: result.writer_id }).toEqual({
      valid: c.valid,
      writer_id: c.writer_id,
    });
  });
});

describe('shared-secret comparison', () => {
  it('NFR-TIMING-01: the auth module compares secrets with a constant-time comparator, not ===, so a byte-by-byte guessing oracle never exists', () => {
    // A code-presence check on purpose: a timing side channel of this size is
    // not observable from a unit test's own timings, so asserting on timings
    // would be a flaky test that proves nothing. 05-verification.v1.md §9
    // item 9 asks only that the cheap defense be in place.
    const source = readFileSync(path.join(REPO_ROOT, AUTH_MODULE_PATH), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect({
      uses_constant_time_comparator: /timingSafeEqual/.test(code),
      compares_a_secret_with_a_plain_equality_operator: /secret\w*\s*[=!]==/i.test(code),
    }).toEqual({
      uses_constant_time_comparator: true,
      compares_a_secret_with_a_plain_equality_operator: false,
    });
  });
});
