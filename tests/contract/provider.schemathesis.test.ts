import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { contractOperations } from '../support/openapi.js';
import { runSchemathesis } from '../support/schemathesis.js';
import { freePort } from '../support/prism.js';
import { startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * PROVIDER side of Arsène's own OpenAPI contract. Schemathesis fuzzes the real
 * running Edge Function against contracts/openapi.yaml, one operation per
 * test, so a failure names the operation that broke its own contract.
 *
 * At the red gate the provider does not exist. Schemathesis is still invoked
 * for real (not stubbed, not skipped) so the whole tool chain — venv, CLI,
 * schema parsing, operation filtering — is proven by the same run that proves
 * the provider is missing. The single reason every test below fails is: there
 * is no provider.
 */

const WRITER_TOKEN = 'red-gate-writer-token';
const WRITER_ID = 'b2b2b2b2-0000-4a2b-9c3d-bbbbbbbbbbbb';

let db: TestDatabase | null = null;
let server: { url: string; stop(): Promise<void> } | null = null;
let providerStartFailure = 'provider was started successfully';
let baseUrl = '';

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  try {
    // Load the provider entry point before paying for a database container,
    // so the reported reason is the most direct one available.
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    server = await startServer({
      port,
      databaseUrl: db.connectionUri,
      writerToken: WRITER_TOKEN,
      writerId: WRITER_ID,
      // Fuzzed on the static token by design (the pre-JWT suite). From the
      // third remediation pass, running without `SUPABASE_JWT_SECRET` has to
      // be an explicit choice rather than a silent downgrade — see
      // tests/e2e/failClosedConfig.test.ts (NFR-FAILCLOSED-01). Setup only:
      // no assertion in this file changes.
      allowLegacyAuth: true,
    });
    baseUrl = server.url;
  } catch (err) {
    providerStartFailure = (err as Error).message;
    await db?.stop().catch(() => undefined);
    db = null;
  }
}, 240_000);

afterAll(async () => {
  await server?.stop().catch(() => undefined);
  await db?.stop().catch(() => undefined);
});

describe('OpenAPI provider contract (Schemathesis)', () => {
  it.each(
    contractOperations().map(
      (o) =>
        [
          `CONTRACT-PROVIDER-${o.operationId}: the running Edge Function satisfies the contract for ${o.method} ${o.path}`,
          o,
        ] as const,
    ),
  )('%s', (_title, { operationId }) => {
    const result = runSchemathesis({
      baseUrl,
      operationId,
      headers: { Authorization: `Bearer ${WRITER_TOKEN}` },
    });

    expect(
      result.exitCode,
      `provider status: ${providerStartFailure}\n\nschemathesis output:\n${result.output}`,
    ).toBe(0);
  });
});
