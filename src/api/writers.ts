/**
 * `/v1/writers` — the co-author picker's own writer list. Any active writer
 * may call this (`deps.auth.verifyBearer`, the same plain writer gate
 * `createDraft.ts` uses — not `adminWriters.ts`'s `verifyAdmin`), and gets
 * back only `{id, display_name}[]`, never the admin-only `WriterRow`
 * (`adminWriters.ts`'s `handleListWriters`) with its email/is_admin/
 * revoked_at fields. This is a deliberately separate route rather than a
 * trimmed view of the admin one, so a non-admin writer's access to it never
 * has to be reasoned about alongside admin-only actions.
 */

import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';

export type WritersDeps = {
  auth: {
    verifyBearer(token: string | null): Promise<{ valid: boolean; writer_id?: string }>;
  };
  repo: {
    listActiveWriters(): Promise<{ id: string; display_name: string }[]>;
  };
};

export async function handleListActiveWriters(
  req: { authorization: string | null },
  deps: WritersDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  const writers = await deps.repo.listActiveWriters();
  return { status: 200, body: { writers } };
}
