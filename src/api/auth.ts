/**
 * Who is calling — verify finding #3.
 *
 * Supabase Auth signs access tokens with HS256 using the project's JWT secret,
 * so verification is a pure function of (token, secret, now): signature, then
 * expiry, then the `sub` claim, which *is* the writer's id
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

export async function verifySupabaseJwt(
  token: string | null,
  opts: { secret: string; now: Date },
): Promise<JwtVerification> {
  if (token === null) return { valid: false, reason: 'no bearer token' };

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.secret), {
      algorithms: ['HS256'],
      currentDate: opts.now,
    });
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
