/**
 * Child-process entry point for the Edge Function router: reads its
 * configuration from argv, starts listening, and prints the URL it bound so
 * the parent knows it is ready. See `server.ts` for why it runs out of
 * process.
 */

import { writeSync } from 'node:fs';
import { startHttpServer } from './router.ts';

const [port, databaseUrl, writerToken, writerId] = process.argv.slice(2);

if (port === undefined || databaseUrl === undefined || writerToken === undefined || writerId === undefined) {
  throw new Error('usage: serverMain.ts <port> <databaseUrl> <writerToken> <writerId>');
}

/**
 * M3 (05-verification.v2.md): without a JWKS, `router.ts`'s `verify()` falls
 * back to the one static writer token and attributes every article to one
 * constant — legitimate for a deployment that chose it, catastrophic and
 * silent when a rotation or a cloned environment merely lost the variable.
 * This entry point is the only place that reads that environment, so it is
 * the place that refuses to start when the mode was not chosen.
 *
 * CORS-01: this process is this test suite's spawned-child boundary, not the
 * real deployment (that's `supabase/functions/arsene-api/index.ts`), so its
 * two JWKS env vars are named for that: `SUPABASE_JWKS_URL` (a real
 * endpoint, if one is ever pointed at) and `ARSENE_TEST_JWKS_JSON` (the
 * local, no-network JWKS this suite actually uses).
 */
const jwksUrl = process.env.SUPABASE_JWKS_URL;
const jwksJson = process.env.ARSENE_TEST_JWKS_JSON;
const hasJwksConfig = (jwksUrl !== undefined && jwksUrl !== '') || (jwksJson !== undefined && jwksJson !== '');
if (!hasJwksConfig && process.env.ALLOW_LEGACY_STATIC_AUTH !== 'true') {
  // `writeSync` rather than `process.stderr.write`: writes to a pipe are
  // asynchronous on macOS, and this process is about to exit.
  writeSync(
    2,
    'refusing to start: SUPABASE_JWKS_URL/ARSENE_TEST_JWKS_JSON are both missing or empty, so ' +
      'every request would be authenticated by the shared static writer token instead of the ' +
      "caller's own Supabase Auth JWT. Set one of them, or set ALLOW_LEGACY_STATIC_AUTH=true to " +
      'choose the legacy static-token mode deliberately.\n',
  );
  process.exit(78); // EX_CONFIG
}

const server = await startHttpServer({
  port: Number(port),
  databaseUrl,
  writerToken,
  writerId,
  // Secrets are environment configuration, never argv: they must not show up
  // in a process listing (verify finding #3, ADR-0004).
  jwksUrl,
  jwksJson,
  jwtIssuer: process.env.SUPABASE_JWT_ISSUER,
  imageCallbackSecret: process.env.IMAGE_CALLBACK_SECRET,
  // M-V3-04: the CDN origin is this deployment's, not a compile-time
  // placeholder on the reserved `.example` TLD. Not a secret, but read from
  // the same place for the same reason: it differs per deployment.
  cdnOrigin: process.env.CDN_ORIGIN,
  dashboardReadSecret: process.env.DASHBOARD_READ_SECRET,
});

process.stdout.write(`listening ${server.url}\n`);

process.on('SIGTERM', () => {
  void server.stop().then(() => process.exit(0));
});
