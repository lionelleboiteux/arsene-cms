/**
 * Spawns the real Supabase Edge Function entry point
 * (`supabase/functions/arsene-api/index.ts`) as a genuine `deno run` child
 * process, over a real HTTP port — the Deno counterpart to `src/api/server.ts`'s
 * Node child-process boundary.
 *
 * Why this exists: eight red/green/verify remediation cycles proved
 * `src/api/router.ts`'s business logic against a real *Node* child process,
 * which is what `server.ts`/`serverMain.ts` boot. Nothing ever proved the
 * same logic runs under the runtime ADR-0001 actually named (Deno, Fetch-API
 * handler model) until the pipeline gate found the mismatch. This is that
 * proof, run the same way the Node boundary is: a real spawned process, real
 * HTTP, real Postgres — never an in-process shortcut.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { REPO_ROOT } from './pg.ts';

export type DenoServerOptions = {
  port: number;
  databaseUrl: string;
  writerToken: string;
  writerId: string;
  /** The local, no-network JWKS this suite always uses (no real project URL
   *  to reach from a `deno run` rehearsal process). */
  jwksJson?: string;
  jwtIssuer?: string;
  imageCallbackSecret?: string;
  cdnOrigin?: string;
  readTimeoutMs?: number;
  dashboardReadSecret?: string;
  /** Mirrors `server.ts`'s `SpawnedServerOptions.allowLegacyAuth`. */
  allowLegacyAuth?: boolean;
};

export type RunningDenoServer = { url: string; stop(): Promise<void> };

const ENTRY = new URL('../../supabase/functions/arsene-api/index.ts', import.meta.url).pathname;
const CONFIG = new URL('../../supabase/functions/arsene-api/deno.json', import.meta.url).pathname;
const READY_TIMEOUT_MS = 30_000;

export async function startDenoServer(opts: DenoServerOptions): Promise<RunningDenoServer> {
  const child: ChildProcess = spawn(
    'deno',
    ['run', '--allow-net', '--allow-env', '--config', CONFIG, ENTRY],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(opts.port),
        DATABASE_URL: opts.databaseUrl,
        WRITER_TOKEN: opts.writerToken,
        WRITER_ID: opts.writerId,
        ...(opts.jwksJson !== undefined ? { ARSENE_TEST_JWKS_JSON: opts.jwksJson } : {}),
        ...(opts.jwtIssuer !== undefined ? { SUPABASE_JWT_ISSUER: opts.jwtIssuer } : {}),
        ...(opts.imageCallbackSecret !== undefined
          ? { IMAGE_CALLBACK_SECRET: opts.imageCallbackSecret }
          : {}),
        ...(opts.cdnOrigin !== undefined ? { CDN_ORIGIN: opts.cdnOrigin } : {}),
        ...(opts.readTimeoutMs !== undefined ? { READ_TIMEOUT_MS: String(opts.readTimeoutMs) } : {}),
        ...(opts.dashboardReadSecret !== undefined
          ? { DASHBOARD_READ_SECRET: opts.dashboardReadSecret }
          : {}),
        ...(opts.allowLegacyAuth === true ? { ALLOW_LEGACY_STATIC_AUTH: 'true' } : {}),
      },
    },
  );

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Deno Edge Function did not start in ${READY_TIMEOUT_MS}ms:\n${output}`)),
      READY_TIMEOUT_MS,
    );
    const check = setInterval(() => {
      // Deno.serve's own default readiness log — "Listening on http://...".
      if (/Listening on/.test(output)) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${opts.port}`);
      }
    }, 50);
    child.on('close', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`Deno Edge Function exited with code ${code}:\n${output}`));
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
