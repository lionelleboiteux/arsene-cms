/**
 * Schemathesis runner — the provider side of Arsène's own OpenAPI contract,
 * exactly as named in 02-architecture.v1.md §5 ("Provider test: Schemathesis").
 *
 * Setup (once): npm run setup:contract
 *   python3 -m venv .venv-contract && .venv-contract/bin/pip install schemathesis
 *
 * At the red gate there is no Edge Function to fuzz. Schemathesis is still
 * invoked for real, so the harness itself (venv, CLI, schema parsing,
 * operation filtering) is proven by the same run that proves the provider is
 * absent — the alternative, skipping it, would silently no-op and only be
 * discovered at green.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { OPENAPI_PATH, REPO_ROOT } from './openapi.js';

export const SCHEMATHESIS_BIN = path.join(REPO_ROOT, '.venv-contract', 'bin', 'schemathesis');

export type SchemathesisResult = { exitCode: number; output: string };

export function runSchemathesis(opts: {
  baseUrl: string;
  operationId: string;
  headers?: Record<string, string>;
  maxExamples?: number;
}): SchemathesisResult {
  if (!existsSync(SCHEMATHESIS_BIN)) {
    throw new Error(
      `Schemathesis is not installed at ${SCHEMATHESIS_BIN}. Run: npm run setup:contract`,
    );
  }

  const args = [
    'run',
    OPENAPI_PATH,
    '--url',
    opts.baseUrl,
    '--include-operation-id',
    opts.operationId,
    '--max-examples',
    String(opts.maxExamples ?? 5),
    '--checks',
    'all',
  ];

  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    args.push('--header', `${name}:${value}`);
  }

  const res = spawnSync(SCHEMATHESIS_BIN, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  });

  return {
    exitCode: res.status ?? -1,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}
