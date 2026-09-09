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
    getWriterDisplayName(writer_id: string): Promise<string>;
    getWriterAvatarUrl(writer_id: string): Promise<string | null>;
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

/**
 * `GET /v1/writers/me` — the caller's own `{id, display_name, avatar_url}`,
 * resolved from their own token's `writer_id`. The frontend's first-login
 * onboarding gate (`app.tsx`) is the reason this exists: `writers` itself
 * has no self-read RLS policy at all (0008, deliberate), so there is no
 * direct-PostgREST way for a writer to learn whether they have an avatar
 * yet — this is that read, server-mediated like every other `writers`
 * access since 0008.
 */
export async function handleGetOwnWriter(
  req: { authorization: string | null },
  deps: WritersDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid || auth.writer_id === undefined) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  const [display_name, avatar_url] = await Promise.all([
    deps.repo.getWriterDisplayName(auth.writer_id),
    deps.repo.getWriterAvatarUrl(auth.writer_id),
  ]);
  return { status: 200, body: { id: auth.writer_id, display_name, avatar_url } };
}
