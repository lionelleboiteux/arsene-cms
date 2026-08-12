/**
 * `POST /v1/articles/{articleId}/publish` — the one request that validates
 * publishability, generates slug/JSON-LD/sitemap entry, flips the article
 * live, records `article_published` synchronously, and revalidates the pages
 * the change touches.
 */

import { evaluateLock } from '../domain/lock.ts';
import { sanitizePastedHtml } from '../domain/paste.ts';
import { buildPronosEntry, type PronosEntryInput } from '../domain/pronosEntry.ts';
import {
  articlePath,
  buildSitemapEntry,
  buildStructuredData,
  canonicalUrl,
  categoryPath,
  generateSlug,
  htmlToText,
  suggestMeta,
  type PublishedArticleView,
} from '../domain/seo.ts';
import { buildTelemetryEvent, type TelemetrySink } from '../telemetry/events.ts';
import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';
import type { RateLimiter } from './rateLimit.ts';

export type ImageRecord = {
  id: string;
  article_id: string;
  role: 'cover' | 'body';
  status: 'processing' | 'ready' | 'failed';
  alt_text: string | null;
  /** The converted asset's real CDN URL, written by ADR-0004's callback. */
  optimized_url?: string | null;
};

export type ArticleRecord = {
  id: string;
  writer_id: string;
  title: string;
  body_html: string;
  league_name: string;
  type_name: string;
  slug: string | null;
  meta_title: string | null;
  meta_description: string | null;
  first_published_at: Date | null;
  locked_by: string | null;
  locked_at: Date | null;
  pronos_entries: PronosEntryInput[];
};

export type PublishHttpRequest = {
  article_id: string;
  authorization: string | null;
  idempotency_key: string | null;
  client_ip: string;
  body: { meta_title?: string; meta_description?: string };
};

export type PublishDeps = {
  now(): Date;
  auth: {
    verifyBearer(
      token: string | null,
    ): Promise<{ valid: boolean; writer_id?: string; display_name?: string }>;
  };
  repo: {
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    getArticleImages(article_id: string): Promise<ImageRecord[]>;
    markPublished(input: {
      article_id: string;
      writer_id: string;
      published_at: Date;
      slug: string;
      body_html: string;
      meta_title: string;
      meta_description: string;
      structured_data: Record<string, unknown>;
    }): Promise<{ first_published_at: Date }>;
    getWriterDisplayName(writer_id: string): Promise<string>;
  };
  telemetry: TelemetrySink;
  rateLimiter: RateLimiter;
  idempotency: {
    lookup(key: string, article_id: string): HandlerResponse | null;
    store(key: string, article_id: string, response: HandlerResponse): void;
  };
  revalidation: { revalidate(paths: string[]): Promise<{ ok: boolean; error?: string }> };
  observability: {
    record(entry: {
      event: string;
      outcome: 'success' | 'failure';
      details?: Record<string, unknown>;
    }): void;
  };
};

export async function handlePublishArticle(
  req: PublishHttpRequest,
  deps: PublishDeps,
): Promise<HandlerResponse> {
  const now = deps.now();
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

  const replay = req.idempotency_key
    ? deps.idempotency.lookup(req.idempotency_key, req.article_id)
    : null;
  if (replay !== null) return replay;

  // Checked once the article is known to exist, so the budget protects the
  // publish path itself rather than 404 lookups.
  const rate = deps.rateLimiter.check(`publish:${req.client_ip}`, now);
  if (!rate.allowed) {
    return errorResponse(429, 'CONFLICT', `More than ${rate.limit} publishes per minute.`);
  }

  const images = await deps.repo.getArticleImages(article.id);
  const refusal = await refusePublish(article, images, auth.writer_id, now, deps);
  if (refusal !== null) return refusal;

  const response = await publishNow(req, article, images, auth.writer_id, now, deps);
  if (req.idempotency_key) deps.idempotency.store(req.idempotency_key, req.article_id, response);
  return response;
}

/** Every documented reason a publish is refused, in the contract's order. */
async function refusePublish(
  article: ArticleRecord,
  images: ImageRecord[],
  writer_id: string,
  now: Date,
  deps: PublishDeps,
): Promise<HandlerResponse | null> {
  const lock = evaluateLock({
    now,
    lock: {
      locked_by: article.locked_by,
      locked_at: article.locked_at,
      locked_by_display_name: null,
    },
    requesting_writer_id: writer_id,
  });
  if (!lock.editable) {
    return errorResponse(409, 'DRAFT_LOCKED', 'This draft is currently locked by another writer.', {
      locked_by_writer_id: lock.locked_by_writer_id,
      locked_by_display_name: await deps.repo.getWriterDisplayName(lock.locked_by_writer_id),
    });
  }

  if (!images.some((image) => image.role === 'cover')) {
    return errorResponse(400, 'COVER_IMAGE_REQUIRED', 'This article has no cover image.', {
      article_id: article.id,
    });
  }

  const fields = invalidPronosFields(article.pronos_entries);
  if (fields.length > 0) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', { fields });
  }

  const unready = images.find((image) => image.status !== 'ready');
  if (unready !== undefined) {
    return errorResponse(409, 'IMAGE_NOT_READY', 'An image of this article is not ready yet.', {
      image_id: unready.id,
      role: unready.role,
      status: unready.status,
    });
  }
  return null;
}

function invalidPronosFields(
  entries: PronosEntryInput[],
): Array<{ field: string; message: string }> {
  return entries.flatMap((entry, index) => {
    const result = buildPronosEntry(entry);
    return result.ok
      ? []
      : result.errors.map((error) => ({
          field: `pronos[${index}].${error.field}`,
          message: error.message,
        }));
  });
}

async function publishNow(
  req: PublishHttpRequest,
  article: ArticleRecord,
  images: ImageRecord[],
  writer_id: string,
  now: Date,
  deps: PublishDeps,
): Promise<HandlerResponse> {
  // H1: `body_html` is directly PostgREST-writable by any writer, so the one
  // request that makes it public is the one that must sanitise it.
  const body_html = sanitizePastedHtml(article.body_html);
  const body_text = htmlToText(article.body_html);
  const suggestion = suggestMeta({ ...article, body_text });
  const meta_title = req.body.meta_title ?? article.meta_title ?? suggestion.meta_title;
  const meta_description =
    req.body.meta_description ?? article.meta_description ?? suggestion.meta_description;
  const is_republish = article.first_published_at !== null;

  const view: PublishedArticleView = {
    article_id: article.id,
    title: article.title,
    slug: article.slug ?? generateSlug(article.title),
    league_name: article.league_name,
    type_name: article.type_name,
    writer_display_name: await deps.repo.getWriterDisplayName(article.writer_id),
    // §6.4: the URL the cover was actually stored under, never one built from
    // the article id — this value is persisted into `structured_data`.
    cover_image_url: images.find((image) => image.role === 'cover')?.optimized_url ?? '',
    published_at: now.toISOString(),
    first_published_at: (article.first_published_at ?? now).toISOString(),
  };
  const structured_data = buildStructuredData(view);

  const stored = await deps.repo.markPublished({
    article_id: article.id,
    writer_id,
    published_at: now,
    slug: view.slug,
    body_html,
    meta_title,
    meta_description,
    structured_data,
  });

  const telemetry_event_id = emitPublished(view, writer_id, is_republish, deps);
  await revalidate(view, deps);

  return {
    status: 200,
    body: {
      article_id: article.id,
      slug: view.slug,
      status: 'published',
      published_at: view.published_at,
      first_published_at: stored.first_published_at.toISOString(),
      is_republish,
      meta_title,
      meta_description,
      canonical_url: canonicalUrl(view),
      structured_data,
      sitemap: buildSitemapEntry(view),
      telemetry_event_id,
    },
  };
}

/** Returns the id the caller is told the telemetry row was written under. */
function emitPublished(
  view: PublishedArticleView,
  writer_id: string,
  is_republish: boolean,
  deps: PublishDeps,
): string {
  const telemetry_event_id = crypto.randomUUID();
  const event = buildTelemetryEvent('article_published', {
    writer_id,
    article_id: view.article_id,
    published_at: view.published_at,
    is_republish,
  });
  deps.telemetry.emit({ ...event, payload: { ...event.payload, telemetry_event_id } });
  return telemetry_event_id;
}

/** AC-17: only the article, its category and the homepage are regenerated. */
async function revalidate(view: PublishedArticleView, deps: PublishDeps): Promise<void> {
  const paths = ['/', categoryPath(view), articlePath(view)];
  const outcome = await deps.revalidation.revalidate(paths);
  deps.observability.record({
    event: 'revalidation',
    outcome: outcome.ok ? 'success' : 'failure',
    details: { paths, error: outcome.error ?? null },
  });
}
