/**
 * Test-only Supabase Auth token minting.
 *
 * 05-verification.v1.md H3: `router.ts`'s `verify()` compares the bearer token
 * to one hardcoded string, so every request in the whole process is attributed
 * to one fabricated `writerId`. 02-architecture.v1.md §10 says the fix is
 * implementation catching up with a decision already made: verify a real
 * Supabase-issued JWT and take `writer_id` from its `sub` claim.
 *
 * Supabase Auth signs access tokens with **HS256**, using the project's JWT
 * secret (a symmetric string from the project settings) — not RS256/JWKS. The
 * tokens minted here have the same header, algorithm and claim set as a real
 * one, so the production verifier is exercised against the real token shape.
 *
 * `TEST_JWT_SECRET` below is a value invented for this suite. It is not, and
 * must never be, a real project secret: production reads its secret from the
 * environment and passes it in through `deps`/`ServerOptions`, which is
 * exactly the seam these tests configure.
 */

import { SignJWT } from 'jose';

/** A test-only symmetric key of realistic length. Never a real project key. */
export const TEST_JWT_SECRET =
  'arsene-test-only-jwt-secret-0123456789abcdefghijklmnopqrstuvwxyz';

/** A different key of the same shape, for the "signed by someone else" case. */
export const WRONG_JWT_SECRET =
  'arsene-test-only-WRONG-secret-0123456789abcdefghijklmnopqrstuvwxyz';

export const SUPABASE_ISSUER = 'https://projectref.supabase.co/auth/v1';

export type MintOptions = {
  /**
   * Becomes `writer_id`. A Supabase user id, i.e. the `writers.id` UUID.
   * `null` mints a genuinely signed token with no `sub` claim at all — a valid
   * signature that still cannot be attributed to a writer.
   */
  sub: string | null;
  secret?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  email?: string;
  /** Only for the "not really signed" negative case. */
  alg?: 'HS256' | 'HS512';
};

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/** One Supabase-shaped access token, signed for real. */
export async function mintSupabaseJwt(opts: MintOptions): Promise<string> {
  const issuedAt = opts.issuedAt ?? new Date();
  const expiresAt = opts.expiresAt ?? new Date(issuedAt.getTime() + 3_600_000);
  const key = new TextEncoder().encode(opts.secret ?? TEST_JWT_SECRET);

  const jwt = new SignJWT({
    email: opts.email ?? 'writer@fantasycoach.example',
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: seconds(issuedAt) }],
    session_id: 'e0f8a1d2-3b4c-4d5e-8f90-a1b2c3d4e5f6',
  })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256', typ: 'JWT' })
    .setIssuer(SUPABASE_ISSUER)
    .setAudience('authenticated')
    .setIssuedAt(seconds(issuedAt))
    .setExpirationTime(seconds(expiresAt));

  if (opts.sub !== null) jwt.setSubject(opts.sub);

  return jwt.sign(key);
}

export const bearer = (token: string): string => `Bearer ${token}`;
