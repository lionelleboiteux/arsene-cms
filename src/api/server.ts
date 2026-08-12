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
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Secrets travel via env, never argv (serverMain.ts's own rule — they
      // must not show up in a process listing), but they still have to reach
      // the child: `opts.jwtSecret`/`opts.imageCallbackSecret`, when the
      // caller sets them, override whatever the parent process's own
      // environment already has under these two names. Previously this
      // spawn call forwarded neither, so `ServerOptions.jwtSecret` was
      // silently a no-op through this entry point (found and fixed at the
      // second verify pass — see tests/e2e/deployedAuthBoundary.test.ts).
      env: {
        ...process.env,
        ...(opts.jwtSecret !== undefined ? { SUPABASE_JWT_SECRET: opts.jwtSecret } : {}),
        ...(opts.imageCallbackSecret !== undefined
          ? { IMAGE_CALLBACK_SECRET: opts.imageCallbackSecret }
          : {}),
      },
    },
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
