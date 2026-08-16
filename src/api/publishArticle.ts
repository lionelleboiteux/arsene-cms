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
  /**
   * The as-uploaded original in Supabase Storage. `null` on a row `uploadImage`
   * created while refusing the file, so nothing was ever stored for it.
   */
  original_url?: string | null;
  /** Written by a later cover upload onto the row whose slot it took over. */
  replaced_cover_image_id?: string | null;
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
    /** The slugs already taken that `base_slug` would have to avoid (AC-14). */
    takenSlugs(base_slug: string): Promise<string[]>;
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

  const unready = images.find(
    (image) => image.status !== 'ready' && articleDependsOn(image, images),
  );
  if (unready !== undefined) {
    return errorResponse(409, 'IMAGE_NOT_READY', 'An image of this article is not ready yet.', {
      image_id: unready.id,
      role: unready.role,
      status: unready.status,
    });
  }
  return null;
}

/**
 * Whether the article actually depends on this image row — and therefore
 * whether the row gets to decide the publish. No writer can delete a row
 * (`authenticated` has no `delete` grant on `article_images`, and no route
 * removes one), so a row the article does not depend on would otherwise block
 * republication permanently: M-V4-01, and M-V5-01 for the same trap on the
 * `body` slot.
 *
 * Neither exclusion below reads `role`. `role` is the one `article_images`
 * column `authenticated` may write directly (`db/migrations/0001_initial_schema.sql`,
 * `grant update (role, alt_text)`), so a gate keyed on it was a gate a writer
 * could open by renaming a broken, genuinely-embedded image to `cover`
 * (M-V5-03).
 *
 * - **Never adopted** — `original_url is null`. `uploadImage.ts` stores the
 *   original *before* it hands anything to the pipeline, and writes
 *   `original_url: null` on every path where it refuses the file instead. A row
 *   with no stored original was never embeddable in the body and was never
 *   usable as a cover, whatever its `role`. A row read from the repository
 *   always carries this column, so `null` is the database's own answer and not
 *   an unmodelled field.
 * - **Superseded in the cover slot** — a later cover upload took the slot and
 *   recorded, on itself, which row it took it from
 *   (`replaced_cover_image_id`, written by the server; `authenticated` cannot
 *   write it). Whether the superseded upload converts or fails is settled
 *   afterwards by ADR-0004's asynchronous callback, which is why that decision
 *   cannot be taken at demote time (M-V5-02).
 */
function articleDependsOn(image: ImageRecord, images: ImageRecord[]): boolean {
  return (
    image.original_url !== null &&
    !images.some((other) => other.replaced_cover_image_id === image.id)
  );
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

/**
 * AC-14 promises "a collision-free slug, with no writer action", and
 * `articles.slug` is `unique` — so `generateSlug`'s own dedup has to be given
 * the slugs actually taken. Called with none, it returned the bare slug and the
 * second article sharing a title died on an unmapped `23505`, permanently
 * (M-V5-05); `createDraft`'s default title makes two untitled drafts collide
 * immediately.
 */
async function uniqueSlug(title: string, deps: PublishDeps): Promise<string> {
  const existingSlugs = await deps.repo.takenSlugs(generateSlug(title));
  return generateSlug(title, { existingSlugs });
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
    slug: article.slug ?? (await uniqueSlug(article.title, deps)),
    league_name: article.league_name,
    type_name: article.type_name,
    writer_display_name: await deps.repo.getWriterDisplayName(article.writer_id),
    // §6.4: the URL the cover was actually stored under, never one built from
    // the article id — this value is persisted into `structured_data`.
    // M-V4-01: `role === 'cover'` alone is no longer enough to identify the
    // cover — a rejected upload can leave a second, `failed` cover row beside
    // it — so this reads the one the public render pass reads (`src/site/render.ts`).
    cover_image_url:
      images.find((image) => image.role === 'cover' && image.status === 'ready')?.optimized_url ??
      '',
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
