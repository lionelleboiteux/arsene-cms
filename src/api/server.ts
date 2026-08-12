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

// `readTimeoutMs` is omitted rather than inherited-and-ignored: this boundary
// passes configuration to a child process, and the last time it advertised an
// option it silently dropped (`jwtSecret`), the bug survived a whole verify
// pass. The child gets `router.ts`'s shipped default.
export type SpawnedServerOptions = Omit<ServerOptions, 'readTimeoutMs'> & {
  /**
   * M3 (05-verification.v2.md): running on the legacy static token, with no
   * JWT secret at all, stays a legitimate mode — but it has to be *chosen*.
   * This flag is that choice, forwarded to the child as
   * `ALLOW_LEGACY_STATIC_AUTH=true`; without it, `serverMain.ts` refuses to
   * start when `SUPABASE_JWT_SECRET` is missing or empty.
   */
  allowLegacyAuth?: boolean;
};

export async function startServer(opts: SpawnedServerOptions): Promise<RunningServer> {
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
        ...(opts.allowLegacyAuth === true ? { ALLOW_LEGACY_STATIC_AUTH: 'true' } : {}),
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
    // `close` rather than `exit`: it fires once the child's stdio pipes have
    // been drained, so a child that refuses to start (serverMain.ts's
    // fail-closed check) has its reason in `output` by the time it is reported.
    child.on('close', (code) => {
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
