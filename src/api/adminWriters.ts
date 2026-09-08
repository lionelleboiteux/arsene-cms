/**
 * `/v1/admin/writers` — the settings page's writer allow-list: list, invite,
 * revoke, reinstate. Admin-only (`router.ts`'s `verifyAdmin`, checked both
 * there before dispatch and again here via `deps.auth.verifyAdmin`, the same
 * double-check shape every other handler in this file already uses —
 * `discardImage.ts`'s own comment explains why: handlers stay independently
 * testable/callable without relying on `route()`'s own gating).
 *
 * `deps.authAdmin` is `authAdmin.ts`'s two Supabase Auth Admin API calls
 * (the exact logic `scripts/create-writer.ts` already used before this route
 * existed) injected rather than imported directly — matching every other
 * handler in this codebase, which never calls a side-effecting function
 * (storage, the DB pool, another API) except through `deps`, precisely so it
 * can be unit-tested against fakes with no real network/DB reachable.
 * `router.ts`'s `adminWritersDeps()` wires these to the real implementation.
 */

import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import type { WriterRow } from './repo.ts';

export type AdminWritersDeps = {
  auth: {
    verifyAdmin(token: string | null): Promise<{ valid: boolean; writer_id?: string }>;
  };
  repo: {
    listWriters(): Promise<WriterRow[]>;
    upsertWriter(input: { id: string; email: string; display_name: string }): Promise<WriterRow>;
    setWriterRevoked(input: { writer_id: string; revoked: boolean }): Promise<
      | { ok: true; writer: WriterRow }
      | { ok: false; error: 'LAST_ADMIN_CANNOT_BE_REVOKED' | 'WRITER_NOT_FOUND' }
    >;
  };
  authAdmin: {
    createOrFindAuthUser(email: string, displayName: string): Promise<string>;
    generateSignInLink(email: string): Promise<string | null>;
  };
};

async function requireAdmin(
  authorization: string | null,
  deps: Pick<AdminWritersDeps, 'auth'>,
): Promise<{ ok: true } | { ok: false; response: HandlerResponse }> {
  const auth = await deps.auth.verifyAdmin(bearerToken(authorization));
  if (!auth.valid) {
    return { ok: false, response: errorResponse(401, 'UNAUTHORIZED', 'A valid admin bearer token is required.') };
  }
  return { ok: true };
}

export async function handleListWriters(
  req: { authorization: string | null },
  deps: AdminWritersDeps,
): Promise<HandlerResponse> {
  const admin = await requireAdmin(req.authorization, deps);
  if (!admin.ok) return admin.response;

  const writers = await deps.repo.listWriters();
  return { status: 200, body: { writers } };
}

export type InviteWriterRequest = {
  authorization: string | null;
  email: string;
  display_name: string;
};

export async function handleInviteWriter(
  req: InviteWriterRequest,
  deps: AdminWritersDeps,
): Promise<HandlerResponse> {
  const admin = await requireAdmin(req.authorization, deps);
  if (!admin.ok) return admin.response;

  const email = req.email.trim();
  const display_name = req.display_name.trim();
  if (email === '' || display_name === '') {
    return errorResponse(400, 'VALIDATION_FAILED', 'email and display_name are both required.', {
      email: email === '' ? 'required' : undefined,
      display_name: display_name === '' ? 'required' : undefined,
    });
  }

  const writer_id = await deps.authAdmin.createOrFindAuthUser(email, display_name);
  const writer = await deps.repo.upsertWriter({ id: writer_id, email, display_name });
  const sign_in_link = await deps.authAdmin.generateSignInLink(email);

  return { status: 201, body: { writer, sign_in_link } };
}

export type WriterActionRequest = {
  authorization: string | null;
  writer_id: string;
  action: 'revoke' | 'reinstate';
};

export async function handleSetWriterRevoked(
  req: WriterActionRequest,
  deps: AdminWritersDeps,
): Promise<HandlerResponse> {
  const admin = await requireAdmin(req.authorization, deps);
  if (!admin.ok) return admin.response;

  const result = await deps.repo.setWriterRevoked({
    writer_id: req.writer_id,
    revoked: req.action === 'revoke',
  });

  if (!result.ok) {
    if (result.error === 'WRITER_NOT_FOUND') {
      return errorResponse(404, 'NOT_FOUND', 'No writer was found matching the given id.', {
        writer_id: req.writer_id,
      });
    }
    return errorResponse(
      409,
      'LAST_ADMIN_CANNOT_BE_REVOKED',
      'This writer is the last active admin — revoking them would lock everyone out.',
      { writer_id: req.writer_id },
    );
  }

  return { status: 200, body: { writer: result.writer } };
}
