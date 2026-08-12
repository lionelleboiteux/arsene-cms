/**
 * Draft creation and reopening — the server-side seam 02-architecture.v1.md §9
 * requires. `draft_started` is the numerator of the whole success metric, so
 * it is emitted here, exactly once, by the same server call that creates the
 * row — never by the SPA after an insert it controls. Every other draft edit
 * stays a direct PostgREST write.
 */

import { buildTelemetryEvent, type TelemetrySink } from '../telemetry/events.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import type { ArticleRecord } from './publishArticle.ts';

export type CreateDraftRequest = {
  authorization: string | null;
  client_ip: string;
  body: { title?: string; league_name?: string; type_name?: string };
};

export type OpenDraftRequest = {
  article_id: string;
  authorization: string | null;
  client_ip: string;
};

export type CreateDraftDeps = {
  now(): Date;
  auth: {
    verifyBearer(
      token: string | null,
    ): Promise<{ valid: boolean; writer_id?: string; display_name?: string }>;
  };
  repo: {
    insertDraft(input: { writer_id: string; title: string }): Promise<{ id: string }>;
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    /** Staleness-checked compare-and-swap; the database's clock decides. */
    takeLock(input: { article_id: string; writer_id: string }): Promise<boolean>;
    getWriterDisplayName(writer_id: string): Promise<string>;
  };
  telemetry: TelemetrySink;
};

const UNTITLED = 'Sans titre';

export async function handleCreateDraft(
  req: CreateDraftRequest,
  deps: CreateDraftDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid || auth.writer_id === undefined) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  const now = deps.now();
  const draft = await deps.repo.insertDraft({
    writer_id: auth.writer_id,
    // A draft's title is never blank: it has to be displayable in the writer's
    // draft list before they have typed anything (contract, `createDraft`).
    title: req.body.title === undefined || req.body.title === '' ? UNTITLED : req.body.title,
  });
  deps.telemetry.emit(
    buildTelemetryEvent('draft_started', {
      writer_id: auth.writer_id,
      article_id: draft.id,
      started_at: now.toISOString(),
    }),
  );
  await deps.repo.takeLock({ article_id: draft.id, writer_id: auth.writer_id });

  return { status: 201, body: { article_id: draft.id, locked_by: auth.writer_id } };
}

/** Reopening an existing draft: a lock attempt, and never a second event. */
export async function handleOpenDraft(
  req: OpenDraftRequest,
  deps: CreateDraftDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid || auth.writer_id === undefined) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }

  const article = await deps.repo.getArticle(req.article_id);
  if (article === null) {
    return errorResponse(404, 'NOT_FOUND', 'No article was found matching the given id.', {
      article_id: req.article_id,
    });
  }

  const held = await deps.repo.takeLock({ article_id: article.id, writer_id: auth.writer_id });
  if (!held) {
    // AC-05: the editor names who to ask, exactly as publish's own 409 does.
    const locked_by = article.locked_by;
    return errorResponse(409, 'DRAFT_LOCKED', 'This draft is currently locked by another writer.', {
      locked_by_writer_id: locked_by,
      locked_by_display_name:
        locked_by === null ? null : await deps.repo.getWriterDisplayName(locked_by),
    });
  }

  return {
    status: 200,
    body: { article_id: article.id, title: article.title, body_html: article.body_html },
  };
}
