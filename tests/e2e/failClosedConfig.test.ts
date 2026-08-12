import { afterEach, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';

/**
 * M3 (05-verification.v2.md §4) — nothing asserts `SUPABASE_JWT_SECRET` is
 * actually set at runtime.
 *
 * `serverMain.ts` reads it with `process.env.SUPABASE_JWT_SECRET` and passes
 * whatever it finds, including `undefined`, straight into `startHttpServer`.
 * `router.ts`'s `verify()` then takes the branch it takes when no JWT secret
 * is configured: the legacy static `writerToken` becomes a sufficient
 * credential again, process-wide, with `writer_id` back to one fabricated
 * constant. A failed secret rotation, or an environment cloned without full
 * parity, silently reopens finding H3 in full — no error, no warning, no
 * failing request until somebody audits the logs and finds every article
 * attributed to the same writer.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PASS CHOSE, stated in full so the implementer is not
 * guessing at intent.
 * ---------------------------------------------------------------------------
 *
 * "Always require a JWT secret" is the wrong fix, and would break this suite:
 * `router.ts`'s own `verify()` comment names running without one as
 * legitimate — "deployments configured without a JWT secret at all (and the
 * pre-JWT end-to-end suite)" — and `tests/e2e/publishJourney.test.ts` and
 * `tests/contract/provider.schemathesis.test.ts` are that suite, both booting
 * the real spawned server on the static token by design.
 *
 * So the distinction to enforce is not "with or without a JWT secret". It is
 * **chosen versus arrived at**:
 *
 *   1. `serverMain.ts` — the deployable entry point, the file M3 names —
 *      refuses to start when `SUPABASE_JWT_SECRET` is absent *or empty*,
 *      unless `ALLOW_LEGACY_STATIC_AUTH=true` is explicitly present in its
 *      environment. It exits non-zero and says which variable is missing;
 *      it never starts in a degraded mode quietly.
 *   2. `server.ts`'s `startServer()` forwards a new
 *      `ServerOptions.allowLegacyAuth === true` to the child as
 *      `ALLOW_LEGACY_STATIC_AUTH=true`, exactly as it already forwards
 *      `jwtSecret`/`imageCallbackSecret` via `env` rather than argv. The two
 *      legacy-mode test files above have been given that flag — a setup
 *      change only, no assertion touched — so the legitimate mode stays
 *      legitimate and stays visible in the call site.
 *   3. The check is scoped to `serverMain.ts`, not to `startHttpServer()`:
 *      the in-process starter is a library entry point that takes its
 *      configuration as arguments, where "no secret passed" is a caller's
 *      explicit choice already. The silent-downgrade risk is environment
 *      variables going missing, which only the deployable entry point reads.
 *
 * The empty-string case is deliberately its own row: a rotation that writes an
 * empty value is a distinct code path from an absent one (`!== undefined`
 * accepts it), and it is the more dangerous of the two — an empty HS256 key is
 * a key an attacker can also sign with.
 *
 * No database is involved: a server that refuses to start never reaches one,
 * and one that starts wrongly must be caught before it is asked anything.
 */

const DUMMY_DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
const WRITER_ID = '00000000-0000-4000-8000-000000000000';

type EnvCase = { id: string; klass: string; jwtSecret: string | undefined };

const ENV_CASES: EnvCase[] = [
  {
    id: 'NFR-FAILCLOSED-01a',
    klass: 'SUPABASE_JWT_SECRET missing from the environment entirely',
    jwtSecret: undefined,
  },
  {
    id: 'NFR-FAILCLOSED-01b',
    klass: 'SUPABASE_JWT_SECRET present but empty, as a half-completed rotation leaves it',
    jwtSecret: '',
  },
];

const originalEnv = {
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
  ALLOW_LEGACY_STATIC_AUTH: process.env.ALLOW_LEGACY_STATIC_AUTH,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the deployable entry point fails closed on a missing JWT secret (verify v2, M3)', () => {
  it.each(
    ENV_CASES.map(
      (c) =>
        [
          `${c.id}: with ${c.klass} and no explicit legacy opt-in, the real spawned server refuses to start and says why, rather than silently downgrading every request to the shared static token`,
          c,
        ] as const,
    ),
  )('%s', async (_title, c) => {
    const { startServer } = await loadApiServer();

    // The child inherits this process's environment, so the misconfiguration
    // is expressed here rather than through `startServer`'s options — which is
    // exactly how a real deployment would experience it.
    if (c.jwtSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = c.jwtSecret;
    delete process.env.ALLOW_LEGACY_STATIC_AUTH;

    const outcome = await startServer({
      port: await freePort(),
      databaseUrl: DUMMY_DATABASE_URL,
      writerToken: 'legacy-static-token',
      writerId: WRITER_ID,
    }).then(
      (server) => ({ started: true, server, reason: '' }),
      (err: Error) => ({ started: false, server: null, reason: err.message }),
    );
    // A server that wrongly started is still a live child process.
    await outcome.server?.stop().catch(() => undefined);

    expect({
      refused_to_start: !outcome.started,
      reason_names_the_missing_secret: /SUPABASE_JWT_SECRET/.test(outcome.reason),
    }).toEqual({ refused_to_start: true, reason_names_the_missing_secret: true });
  });
});
