/**
 * Loads the two OpenAPI documents this suite tests against and turns their
 * component schemas into runtime validators, so contract tests assert against
 * the contract documents themselves rather than a hand-copied expectation.
 *
 *   - Arsène's own contract   pdlc/arsene-cms/contracts/openapi.yaml  (provided)
 *   - pronos' contract        pdlc/arsene-cms/contracts/vendor/pronos-openapi.yaml
 *                             (consumed; vendored copy pinned per PRONOS_SOURCE.md)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

export const OPENAPI_PATH = path.join(
  REPO_ROOT,
  'pdlc',
  'arsene-cms',
  'contracts',
  'openapi.yaml',
);

export const PRONOS_OPENAPI_PATH = path.join(
  REPO_ROOT,
  'pdlc',
  'arsene-cms',
  'contracts',
  'vendor',
  'pronos-openapi.yaml',
);

export type OpenApiDoc = {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, unknown> };
};

const cache = new Map<string, OpenApiDoc>();

export function openapi(file: string = OPENAPI_PATH): OpenApiDoc {
  const hit = cache.get(file);
  if (hit) return hit;
  const doc = parse(readFileSync(file, 'utf8')) as OpenApiDoc;
  cache.set(file, doc);
  return doc;
}

/** Every (method, path, operationId) declared in a contract. */
export function contractOperations(
  file: string = OPENAPI_PATH,
): Array<{ operationId: string; method: string; path: string }> {
  const ops: Array<{ operationId: string; method: string; path: string }> = [];
  for (const [p, methods] of Object.entries(openapi(file).paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op && typeof op === 'object' && op.operationId) {
        ops.push({ operationId: op.operationId, method: method.toUpperCase(), path: p });
      }
    }
  }
  return ops;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'arsene', components: { schemas: openapi(OPENAPI_PATH).components.schemas } });
ajv.addSchema({
  $id: 'pronos',
  components: { schemas: openapi(PRONOS_OPENAPI_PATH).components.schemas },
});

function validate(docId: 'arsene' | 'pronos', schemaName: string, value: unknown): string[] {
  const fn = ajv.compile({ $ref: `${docId}#/components/schemas/${schemaName}` });
  return fn(value) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** Validate against a schema in Arsène's own contract. */
export const validateAgainstSchema = (schemaName: string, value: unknown): string[] =>
  validate('arsene', schemaName, value);

/** Validate against a schema in the vendored pronos contract. */
export const validateAgainstPronosSchema = (schemaName: string, value: unknown): string[] =>
  validate('pronos', schemaName, value);
