import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiServer } from '../support/seams.js';
import { freePort } from '../support/prism.js';
import { REPO_ROOT, seedArticle, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';
import { TEST_JWKS_JSON, bearer, mintSupabaseJwt } from '../support/jwt.js';
import { REAL_HEIC } from '../support/imageFixtures.js';

/**
 * `05-verification.v3.md` §3 — **HEIC decode has never worked in the deployed
 * runtime**, while its own test passes.
 *
 * `src/images/heic.ts` does `await import('libheif-js/wasm-bundle')`.
 * `libheif-js@1.19.8` publishes no `exports` map and the specifier carries no
 * extension. Vite's resolver — the one Vitest runs the existing
 * `AC-07/D7-heic` case under — guesses `.js` and finds the file. Plain Node's
 * ESM resolver does not: it throws `ERR_MODULE_NOT_FOUND`, which
 * `optimizeImageBuffer`'s `try`/`catch` swallows and reports as
 * `CORRUPTED_FILE`. So the acceptance criterion is green in CI and dead in the
 * shipped artifact, for every HEIC file, since green v2.
 *
 * ---------------------------------------------------------------------------
 * WHY A SAME-SHAPED UNIT TEST CANNOT COVER THIS
 * ---------------------------------------------------------------------------
 *
 * The defect is not in the decoding logic — it is that **the test runner's
 * module resolver is more forgiving than production's**. Any test that imports
 * `heic.ts` from inside Vitest inherits the forgiving resolver and passes
 * whatever the specifier says. The only way to catch it is to leave the test
 * runner's resolver behind, which these two tests do in the two independent
 * ways available:
 *
 *   `VERIFY-HEIC-01` spawns a real `node` — not `tsx`, not Vitest — and asks it
 *     to perform **the exact specifier `heic.ts` ships**, read out of the
 *     source file rather than copied into this test, so the assertion tracks
 *     production instead of drifting from it. Fast (no database, no server), and
 *     it names the cause directly.
 *
 *   `VERIFY-HEIC-02` drives the whole pipeline over the **real spawned server**
 *     (`startServer`, a child process running plain Node — deliberately not the
 *     in-process `startHttpServer()` shortcut, which is exactly where this bug
 *     is invisible) with the real 128×128 HEVC HEIC fixture, and asserts the
 *     `article_images` row reaches `ready`. That is how the verify pass found
 *     it, and it is the assertion a writer actually cares about.
 *
 * Both are needed: the first fails for one crisp reason and would survive a
 * refactor of the upload path; the second would still catch a break that moved
 * somewhere other than the import specifier.
 */

const HEIC_MODULE = path.join(REPO_ROOT, 'src', 'images', 'heic.ts');

/**
 * The specifier as production ships it. Read from the source, never hardcoded:
 * a test that hardcoded `'libheif-js/wasm-bundle'` would keep asserting the old
 * string after a fix and quietly stop tracking the thing it exists to protect.
 */
function shippedHeicSpecifier(): string {
  const source = readFileSync(HEIC_MODULE, 'utf8');
  const match = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`No dynamic import() specifier found in ${HEIC_MODULE}`);
  }
  return match[1];
}

type ChildResult = { code: number | null; output: string };

/** Plain `node`, from the repo root, with no test-runner resolver in the way. */
function runInPlainNode(script: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ code, output }));
  });
}

type Ctx = { db: TestDatabase; server: { url: string; stop(): Promise<void> }; articleId: string; token: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const writerId = await seedWriter(db.client, 'Marie D.');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      writerToken: 'unused-legacy-token',
      writerId,
      jwksJson: TEST_JWKS_JSON,
    });
    started = {
      db,
      server,
      token: await mintSupabaseJwt({ sub: writerId }),
      articleId: await seedArticle(db.client, {
        writer_id: writerId,
        title: 'Photos du match, prises à l’iPhone',
        league_name: 'Ligue 1',
        type_name: 'Pronos',
      }),
    };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

/** ADR-0004's pipeline is asynchronous: the row settles after the response. */
async function waitForCover(db: TestDatabase, articleId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.client.query<{ status: string; failure_code: string | null }>(
      `select status, failure_code from article_images where article_id = $1 and role = 'cover'`,
      [articleId],
    );
    const row = res.rows[0];
    if (row?.status === 'ready' || row?.status === 'failed') return row;
    if (Date.now() > deadline) {
      return { status: `timed out while ${row?.status ?? 'no row existed'}`, failure_code: null };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('HEIC decode in the runtime that actually ships (verify v3 §3)', () => {
  it('VERIFY-HEIC-01: the libheif specifier src/images/heic.ts ships resolves under plain Node’s ESM resolver, not only under the test runner’s more forgiving one — the whole defect is that those two disagree', async () => {
    const specifier = shippedHeicSpecifier();

    const result = await runInPlainNode(`await import(${JSON.stringify(specifier)});`);

    expect({
      specifier,
      resolved_under_plain_node: result.code === 0,
      module_not_found: /ERR_MODULE_NOT_FOUND/.test(result.output),
    }).toEqual({
      specifier,
      resolved_under_plain_node: true,
      module_not_found: false,
    });
  }, 60_000);

  it('VERIFY-HEIC-02 / AC-07: a real HEVC-compressed HEIC uploaded to the real spawned server is converted and its image row reaches ready — the format the contract advertises works in the process a deployment actually runs, not only inside Vitest', async () => {
    const { db, server, articleId, token } = ctx();

    const form = new FormData();
    form.set('role', 'cover');
    form.set(
      'file',
      new Blob([REAL_HEIC.buffer as ArrayBuffer], { type: 'image/heic' }),
      'IMG_4821.heic',
    );

    const upload = await fetch(`${server.url}/v1/articles/${articleId}/images`, {
      method: 'POST',
      headers: { authorization: bearer(token), 'idempotency-key': `heic-${articleId}` },
      body: form,
    });
    const settled = await waitForCover(db, articleId);

    expect({
      upload_status: upload.status,
      image_status: settled.status,
      failure_code: settled.failure_code,
    }).toEqual({ upload_status: 201, image_status: 'ready', failure_code: null });
  }, 120_000);
});
