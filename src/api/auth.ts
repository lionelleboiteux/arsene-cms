/**
 * Who is calling — verify finding #3.
 *
 * CORS-01's production redeploy found `arsene-api` refusing to boot: the real
 * project has no `SUPABASE_JWT_SECRET` configured, because it was created
 * under Supabase's newer **Signing Keys** system (asymmetric, JWKS-based —
 * https://supabase.com/docs/guides/auth/signing-keys), which does not hand
 * out a legacy shared HS256 secret at all. Verification here now checks the
 * token's signature against the project's JWKS instead of a shared secret,
 * using `jose`'s recommended pattern (`createRemoteJWKSet`/
 * `createLocalJWKSet` + `jwtVerify(token, jwks)`); everything else is
 * unchanged — a pure function of (token, jwks, now, expected issuer):
 * signature, then the claims Supabase always issues (`exp`, `iss`, `aud`,
 * `role`), then the `sub` claim, which *is* the writer's id
 * (02-architecture.v1.md §7/§10). Nothing here trusts a process-wide constant,
 * so two writers' requests can never be attributed to the same identity.
 *
 * `algorithms` is pinned explicitly to the two Signing Keys actually issues
 * (ES256, RS256) rather than left to infer from the JWKS: without it, a
 * token whose header claims `HS256` and is "signed" with, say, the public
 * key's own coordinate bytes as a fake HMAC secret is a well-known key-
 * confusion attack against JWKS-based verifiers, and must be refused on the
 * algorithm alone, before any key lookup.
 */

import { timingSafeEqual } from 'node:crypto';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

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
  opts: { jwks: JWTVerifyGetKey; now: Date; issuer?: string },
): Promise<JwtVerification> {
  if (token === null) return { valid: false, reason: 'no bearer token' };

  try {
    const { payload } = await jwtVerify(token, opts.jwks, {
      algorithms: ['ES256', 'RS256'],
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
  // `TextEncoder`, not `Buffer.from`: `Buffer` is a Node global that Deno's
  // edge runtime does not provide, and this function runs on every callback
  // that supplies a secret — every such call threw `ReferenceError: Buffer
  // is not defined`, turning a correct callback into a silent `500` (the
  // catch-all in `index.ts` swallowed it with no logging).
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
