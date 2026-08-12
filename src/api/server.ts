/**
 * Boots the Edge Function router on a real port, in its own process.
 *
 * Out of process on purpose: the contract suite drives the provider with a
 * blocking `spawnSync` call to Schemathesis (tests/support/schemathesis.ts),
 * which freezes the calling process's event loop for the whole fuzzing run. A
 * server sharing that event loop could not answer a single request. The router
 * itself (`router.ts`) is ordinary in-process code — this module only owns the
 * process boundary.
 */

import { spawn } from 'node:child_process';
import type { ServerOptions } from './router.ts';

const READY_TIMEOUT_MS = 30_000;

const ENTRY = new URL('./serverMain.ts', import.meta.url).pathname;

export type RunningServer = { url: string; stop(): Promise<void> };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const child = spawn(
    process.execPath,
    [ENTRY, String(opts.port), opts.databaseUrl, opts.writerToken, opts.writerId],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Edge Function did not start in ${READY_TIMEOUT_MS}ms:\n${output}`)),
      READY_TIMEOUT_MS,
    );
    const check = setInterval(() => {
      const match = /listening (\S+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(match[1]);
      }
    }, 50);
    child.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`Edge Function exited with code ${code}:\n${output}`));
    });
  });

  return {
    url,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
