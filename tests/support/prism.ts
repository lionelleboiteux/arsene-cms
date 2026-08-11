/**
 * Prism mock server lifecycle — the consumer side of both contracts, exactly
 * as named in 02-architecture.v1.md §5 ("Consumer test: Prism mock") and in
 * contracts/pronos-fixtures.consumer.md §6.
 *
 * Prism is generated from the OpenAPI document at run time. Nothing about the
 * mock's responses is hand-written here, so a consumer test can only pass
 * against responses a contract actually permits.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { OPENAPI_PATH, REPO_ROOT } from './openapi.js';

export type PrismMock = { baseUrl: string; stop(): Promise<void> };

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number, child: ChildProcess, log: () => string) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Prism exited with code ${child.exitCode}. Output:\n${log()}`);
    }
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`Prism did not become ready within ${timeoutMs}ms. Output:\n${log()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * @param specPath  OpenAPI document to mock (Arsène's own by default).
 * @param readyPath a path Prism answers once it is listening — any status is
 *                  proof of life, including a contract-shaped 404/405.
 */
export async function startPrismMock(
  specPath: string = OPENAPI_PATH,
  readyPath = '/v1/articles/a1a1a1a1-0000-4a2b-9c3d-000000000001/publish',
): Promise<PrismMock> {
  const port = await freePort();
  let output = '';

  const child = spawn(
    process.execPath,
    [
      // resolve the locally installed Prism CLI without going through npx
      resolvePrismCli(),
      'mock',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      specPath,
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout?.on('data', (d) => (output += d.toString()));
  child.stderr?.on('data', (d) => (output += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}${readyPath}`, 60_000, child, () => output);

  return {
    baseUrl,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

function resolvePrismCli(): string {
  // node_modules/.bin/prism is a shell shim; the CLI entry point is the real JS.
  return new URL('../../node_modules/@stoplight/prism-cli/dist/index.js', import.meta.url).pathname;
}
