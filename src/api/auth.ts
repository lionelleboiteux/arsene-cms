/**
 * Who is calling — verify finding #3.
 *
 * Supabase Auth signs access tokens with HS256 using the project's JWT secret,
 * so verification is a pure function of (token, secret, now, expected issuer):
 * signature, then the claims Supabase always issues (`exp`, `iss`, `aud`,
 * `role`), then the `sub` claim, which *is* the writer's id
 * (02-architecture.v1.md §7/§10). Nothing here trusts a process-wide constant,
 * so two writers' requests can never be attributed to the same identity.
 */

import { timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';

export type JwtVerification = {
  valid: boolean;
  /** From the token's `sub` claim, never from configuration. */
  writer_id?: string;
  /** Why a token was refused — for logs, never for the client. */
  reason?: string;
};

/**
 * The `aud` and the `role` Supabase stamps on every user access token. Fixed
 * rather than configured: the value that matters to refuse — `role: 'anon'`,
 * carried by the public anon key every editor SPA ships to the browser — is
 * fixed too (05-verification.v3.md L-V3-02).
 */
const AUTHENTICATED = 'authenticated';

export async function verifySupabaseJwt(
  token: string | null,
  /** `issuer` is the project's `https://<ref>.supabase.co/auth/v1`, so it is
   *  configuration rather than a constant; `iss` is pinned only when given. */
  opts: { secret: string; now: Date; issuer?: string },
): Promise<JwtVerification> {
  if (token === null) return { valid: false, reason: 'no bearer token' };

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.secret), {
      algorithms: ['HS256'],
      currentDate: opts.now,
      // `jose` honours `exp` only when the claim is present, so a token minted
      // without one would never expire unless it is required outright.
      requiredClaims: ['exp'],
      audience: AUTHENTICATED,
      ...(opts.issuer === undefined ? {} : { issuer: opts.issuer }),
    });
    if (payload.role !== AUTHENTICATED) {
      return { valid: false, reason: 'not an authenticated user access token' };
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return { valid: false, reason: 'no sub claim to attribute the call to' };
    }
    return { valid: true, writer_id: payload.sub };
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}

/**
 * Constant-time comparison for the shared secrets that are not JWTs — ADR-0004's
 * Lambda status-callback secret, and the legacy static writer token. `===` on a
 * secret is a byte-by-byte guessing oracle (verify finding #9); an unset
 * (empty) expected value authenticates nobody.
 */
export function verifySharedSecret(provided: string | null, expected: string): boolean {
  if (provided === null || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
