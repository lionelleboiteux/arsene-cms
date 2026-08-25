/**
 * Test-only Supabase Auth token minting.
 *
 * 05-verification.v1.md H3: `router.ts`'s `verify()` compares the bearer token
 * to one hardcoded string, so every request in the whole process is attributed
 * to one fabricated `writerId`. 02-architecture.v1.md §10 says the fix is
 * implementation catching up with a decision already made: verify a real
 * Supabase-issued JWT and take `writer_id` from its `sub` claim.
 *
 * CORS-01's redeploy found `arsene-api` refusing to boot in production:
 * `SUPABASE_JWT_SECRET` (the legacy shared HS256 secret this file used to
 * mint tokens against) is not configured on the real project, which instead
 * only ever receives the newer **Signing Keys** secrets (`SUPABASE_JWKS` and
 * friends) — Supabase's current, asymmetric, JWKS-based token system
 * (https://supabase.com/docs/guides/auth/signing-keys), not the deprecated
 * shared-secret one. `verifySupabaseJwt` was migrated to verify against a
 * JWKS instead, so tokens here are now signed with a real ES256 key pair
 * (Supabase's own recommended default under Signing Keys) and exposed as a
 * JWKS, exactly the shape `jose`'s `createLocalJWKSet`/`createRemoteJWKSet`
 * consume — the production verifier is exercised against the real token and
 * key shape, same as before.
 *
 * The two key pairs below are fixed and invented for this suite. They are
 * not, and must never be, real project keys.
 */

import { SignJWT, importJWK, createLocalJWKSet, type JWK, type JWTVerifyGetKey } from 'jose';

/** A test-only ES256 key pair of realistic shape. Never a real project key. */
const TEST_PRIVATE_JWK: JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'nN5Hng5EkaTq1pw3VKYvlXmD7RwDLKLKWiOlF6YH9ZI',
  y: 'Or0ZUvt-gfGxDY9AMk6RHndcZxcM_fx8tLQ-GdWVdLo',
  d: '62_52oKIrEWX7GheYYO8OAx1QH-wYsilqYehUbqdS-o',
  kid: 'arsene-test-key-1',
  alg: 'ES256',
};

const TEST_PUBLIC_JWK: JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: TEST_PRIVATE_JWK.x,
  y: TEST_PRIVATE_JWK.y,
  kid: 'arsene-test-key-1',
  alg: 'ES256',
  use: 'sig',
};

/** A different key pair, for the "signed by someone else" case. */
const WRONG_PRIVATE_JWK: JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'oXM-nkOWSXX9DSPoV47A2iIkS-N5kOuu3drFNfTj8OQ',
  y: 'on4NuMIMsdDB4aZrAUpaqge6bACdaOn3ZQpld_UlrKU',
  d: 'hNTlHvZj4L74S2XEycuEdnD0_aPnbbhqcIYmBzPdqms',
  kid: 'arsene-test-wrong-key',
  alg: 'ES256',
};

/** The JWKS a deployment's `SUPABASE_JWKS`/well-known endpoint would publish —
 *  only the public half. Serializable as a plain string, unlike a `jose`
 *  `JWTVerifyGetKey`, so it can cross `server.ts`'s spawned-process boundary
 *  (env vars carry strings, never functions). */
export const TEST_JWKS_JSON = JSON.stringify({ keys: [TEST_PUBLIC_JWK] });

/** The same JWKS, already built into a `jose` `JWTVerifyGetKey` — for tests
 *  that call `verifySupabaseJwt` directly rather than through a server. */
export const TEST_JWKS: JWTVerifyGetKey = createLocalJWKSet({ keys: [TEST_PUBLIC_JWK] });

const privateKeyPromise = importJWK(TEST_PRIVATE_JWK, 'ES256');
const wrongPrivateKeyPromise = importJWK(WRONG_PRIVATE_JWK, 'ES256');

export const SUPABASE_ISSUER = 'https://projectref.supabase.co/auth/v1';

export type MintOptions = {
  /**
   * Becomes `writer_id`. A Supabase user id, i.e. the `writers.id` UUID.
   * `null` mints a genuinely signed token with no `sub` claim at all — a valid
   * signature that still cannot be attributed to a writer.
   */
  sub: string | null;
  /** Signs with the "wrong" key pair instead of the one `TEST_JWKS_JSON`
   *  publishes — the "signed by someone else" case. */
  wrongKey?: boolean;
  issuedAt?: Date;
  expiresAt?: Date;
  email?: string;
  /** `'HS256'` mints the algorithm-confusion attack case (see `mintSupabaseJwt`) —
   *  resigns with the public key's own material as a fake HMAC secret. */
  alg?: 'ES256' | 'HS256';

  // -------------------------------------------------------------------------
  // Claim overrides added by the fourth remediation pass, for L-V3-02
  // (`05-verification.v3.md` §6): `verifySupabaseJwt` requires neither `exp`
  // nor `iss`/`aud`/`role`, so a token missing or misdeclaring any of them is
  // accepted today. Every field below is additive and defaults to exactly what
  // the pre-existing signature produced, so no already-minted token changes
  // shape.
  // -------------------------------------------------------------------------

  /**
   * Mint with **no `exp` claim at all** — a signed token that never expires.
   * Supabase never issues one, but nothing in the verifier refuses one.
   */
  noExpiry?: boolean;
  /** `iss`; `null` omits the claim entirely. Defaults to `SUPABASE_ISSUER`. */
  issuer?: string | null;
  /** `aud`; `null` omits the claim entirely. Defaults to `'authenticated'`. */
  audience?: string | null;
  /**
   * The `role` claim Supabase stamps on an access token. `'anon'` is the value
   * carried by the project's **public** anon key, which every editor SPA
   * ships to the browser — the reason this claim has to be checked.
   */
  role?: string | null;
};

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/** One Supabase-shaped access token, signed for real. */
export async function mintSupabaseJwt(opts: MintOptions): Promise<string> {
  const issuedAt = opts.issuedAt ?? new Date();
  const expiresAt = opts.expiresAt ?? new Date(issuedAt.getTime() + 3_600_000);
  // NFR-JWT-ALG: the classic RS/ES256->HS256 "algorithm confusion" attack —
  // resign with the *public* key's own coordinate as if it were an HMAC
  // secret. `verifySupabaseJwt` must reject this on `alg` alone, since a
  // JWKS-based verifier has no HMAC secret to compare against in the first
  // place; the key material here exists only to prove the rejection isn't
  // coincidentally a signature failure.
  const key: Uint8Array | Awaited<typeof privateKeyPromise> =
    opts.alg === 'HS256'
      ? new TextEncoder().encode(String(TEST_PUBLIC_JWK.x))
      : await (opts.wrongKey === true ? wrongPrivateKeyPromise : privateKeyPromise);
  const kid = opts.wrongKey === true ? WRONG_PRIVATE_JWK.kid : TEST_PRIVATE_JWK.kid;

  const role = opts.role === undefined ? 'authenticated' : opts.role;
  const issuer = opts.issuer === undefined ? SUPABASE_ISSUER : opts.issuer;
  const audience = opts.audience === undefined ? 'authenticated' : opts.audience;

  const jwt = new SignJWT({
    email: opts.email ?? 'writer@fantasycoach.example',
    ...(role === null ? {} : { role }),
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: seconds(issuedAt) }],
    session_id: 'e0f8a1d2-3b4c-4d5e-8f90-a1b2c3d4e5f6',
  })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', typ: 'JWT', kid })
    .setIssuedAt(seconds(issuedAt));

  if (issuer !== null) jwt.setIssuer(issuer);
  if (audience !== null) jwt.setAudience(audience);
  if (opts.noExpiry !== true) jwt.setExpirationTime(seconds(expiresAt));
  if (opts.sub !== null) jwt.setSubject(opts.sub);

  return jwt.sign(key);
}

export const bearer = (token: string): string => `Bearer ${token}`;
