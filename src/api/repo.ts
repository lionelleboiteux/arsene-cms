/**
 * Postgres-backed repository for the two Edge Function handlers.
 *
 * Ids that are not UUIDs are answered with "no such article" rather than
 * handed to Postgres, so a malformed path parameter is a 404 and never a 500.
 */

import pg from 'pg';
import type { TelemetryEvent } from '../telemetry/events.ts';
import type { ImageStatusRow } from './imageStatus.ts';
import type { ArticleRecord, ImageRecord } from './publishArticle.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ARTICLE_SQL = `
  select a.id, a.writer_id, a.title, a.body_html, a.slug, a.meta_title, a.meta_description,
         a.first_published_at, a.locked_by, a.locked_at,
         coalesce(l.name, '') as league_name,
         coalesce(c.name, '') as type_name,
         coalesce((select json_agg(json_build_object(
                     'home_team', p.home_team,
                     'away_team', p.away_team,
                     'predicted_home_score', p.predicted_home_score,
                     'predicted_away_score', p.predicted_away_score,
                     'confidence_tier', p.confidence_tier,
                     'pronos_league_id', p.pronos_league_id,
                     'pronos_game_id', p.pronos_game_id,
                     'match_kickoff_at', p.match_kickoff_at))
                    from pronos_entries p where p.article_id = a.id), '[]'::json) as pronos_entries
    from articles a
    left join leagues l on l.id = a.league_id
    left join categories c on c.id = a.category_id
   where a.id = $1
`;

/**
 * Spec §4's start timestamp for a draft the SPA inserted through PostgREST.
 * `to_jsonb` writes a plain ISO string; `to_json(...)::text` used to wrap it in
 * a second set of quotes (verify finding #7).
 */
const ENSURE_DRAFT_STARTED_SQL = `
  insert into telemetry_events (event_type, writer_id, article_id, occurred_at, payload)
  select 'draft_started', a.writer_id, a.id, a.created_at,
         jsonb_build_object('started_at', to_jsonb(a.created_at))
    from articles a
   where a.id = $1
  on conflict do nothing
`;

/** ADR-0003: 60-90s staleness window, resolved against the database's clock. */
const LOCK_STALENESS_SECONDS = 90;

const TAKE_LOCK_SQL = `
  update articles
     set locked_by = $2, locked_at = now()
   where id = $1
     and (locked_by is null
          or locked_by = $2
          or locked_at < now() - ($3 || ' seconds')::interval)
  returning id
`;

/** ADR-0004: only a `processing` row moves, and only once. */
const SET_IMAGE_STATUS_SQL = `
  update article_images
     set status = $2,
         optimized_url = $3,
         failure_code = $4,
         failure_message = $5
   where id = $1 and status = 'processing'
  returning id
`;

export type ImageInsert = {
  id: string;
  article_id: string;
  role: 'cover' | 'body';
  status: 'processing' | 'ready' | 'failed';
  original_filename: string;
  alt_text: string | null;
  original_url: string | null;
  optimized_url: string | null;
  failure: { code: string; message: string } | null;
  replaced_cover_image_id: string | null;
};

export function createRepo(pool: pg.Pool) {
  return {
    /** AC-01: the one insert that also carries the `draft_started` metric. */
    async insertDraft(input: { writer_id: string; title: string }): Promise<{ id: string }> {
      const res = await pool.query<{ id: string }>(
        `insert into articles (writer_id, title) values ($1, $2) returning id`,
        [input.writer_id, input.title],
      );
      return { id: res.rows[0]?.id ?? '' };
    },

    /** AC-05: free, mine, or stale-by-more-than-90s all take it; nothing else. */
    async takeLock(input: { article_id: string; writer_id: string }): Promise<boolean> {
      if (!UUID.test(input.article_id)) return false;
      const res = await pool.query(TAKE_LOCK_SQL, [
        input.article_id,
        input.writer_id,
        String(LOCK_STALENESS_SECONDS),
      ]);
      return res.rowCount === 1;
    },

    async getImage(image_id: string): Promise<ImageStatusRow | null> {
      if (!UUID.test(image_id)) return null;
      const res = await pool.query<ImageStatusRow>(
        `select id, article_id, role, status from article_images where id = $1`,
        [image_id],
      );
      return res.rows[0] ?? null;
    },

    async setImageStatus(input: {
      image_id: string;
      status: 'ready' | 'failed';
      optimized_url: string | null;
      failure: { code: string; message: string } | null;
    }): Promise<boolean> {
      if (!UUID.test(input.image_id)) return false;
      const res = await pool.query(SET_IMAGE_STATUS_SQL, [
        input.image_id,
        input.status,
        input.optimized_url,
        input.failure?.code ?? null,
        input.failure?.message ?? null,
      ]);
      return res.rowCount === 1;
    },

    async getArticle(article_id: string): Promise<ArticleRecord | null> {
      if (!UUID.test(article_id)) return null;
      const res = await pool.query<ArticleRecord>(ARTICLE_SQL, [article_id]);
      return res.rows[0] ?? null;
    },

    async getArticleImages(article_id: string): Promise<ImageRecord[]> {
      if (!UUID.test(article_id)) return [];
      const res = await pool.query<ImageRecord>(
        `select id, article_id, role, status, alt_text, optimized_url
           from article_images where article_id = $1`,
        [article_id],
      );
      return res.rows;
    },

    async getWriterDisplayName(writer_id: string): Promise<string> {
      const res = await pool.query<{ display_name: string }>(
        `select display_name from writers where id = $1`,
        [writer_id],
      );
      return res.rows[0]?.display_name ?? 'Un rédacteur';
    },

    async markPublished(input: {
      article_id: string;
      published_at: Date;
      slug: string;
      body_html: string;
      meta_title: string;
      meta_description: string;
      structured_data: Record<string, unknown>;
    }): Promise<{ first_published_at: Date }> {
      const res = await pool.query<{ first_published_at: Date }>(
        `update articles
            set status = 'published',
                published_at = $2,
                first_published_at = coalesce(first_published_at, $2),
                slug = coalesce(slug, $3),
                body_html = $4,
                meta_title = $5,
                meta_description = $6,
                structured_data = $7::jsonb,
                updated_at = now()
          where id = $1
        returning first_published_at`,
        [
          input.article_id,
          input.published_at,
          input.slug,
          input.body_html,
          input.meta_title,
          input.meta_description,
          JSON.stringify(input.structured_data),
        ],
      );
      return { first_published_at: res.rows[0]?.first_published_at ?? input.published_at };
    },

    /** AC-06: at most one cover per article, decided in this transaction. */
    async demoteCurrentCover(article_id: string): Promise<string | null> {
      const res = await pool.query<{ id: string }>(
        `update article_images set role = 'body'
          where article_id = $1 and role = 'cover' returning id`,
        [article_id],
      );
      return res.rows[0]?.id ?? null;
    },

    async insertImage(input: ImageInsert): Promise<{ id: string; created_at: Date }> {
      const res = await pool.query<{ id: string; created_at: Date }>(
        `insert into article_images
           (id, article_id, role, status, original_filename, alt_text,
            original_url, optimized_url, failure_code, failure_message,
            replaced_cover_image_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id, created_at`,
        [
          input.id,
          input.article_id,
          input.role,
          input.status,
          input.original_filename,
          input.alt_text,
          input.original_url,
          input.optimized_url,
          input.failure?.code ?? null,
          input.failure?.message ?? null,
          input.replaced_cover_image_id,
        ],
      );
      return { id: res.rows[0]?.id ?? input.id, created_at: res.rows[0]?.created_at ?? new Date() };
    },

    /**
     * Persists what a handler emitted, in the same request that published.
     * The `draft_started` row is backfilled from `articles.created_at` when the
     * draft was created by a direct PostgREST insert rather than through
     * `createDraft` — without it the metric would have a publish with no start.
     * The partial unique index makes both paths converge on exactly one row.
     */
    async recordTelemetry(article_id: string, events: TelemetryEvent[]): Promise<void> {
      if (events.length === 0) return;
      if (!events.some((event) => event.event_type === 'draft_started')) {
        await pool.query(ENSURE_DRAFT_STARTED_SQL, [article_id]);
      }
      for (const event of events) {
        const id = event.payload.telemetry_event_id;
        await pool.query(
          `insert into telemetry_events (id, event_type, writer_id, article_id, occurred_at, payload)
           values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::jsonb)
           on conflict do nothing`,
          [
            typeof id === 'string' ? id : null,
            event.event_type,
            event.writer_id,
            event.article_id,
            event.occurred_at,
            JSON.stringify(event.payload),
          ],
        );
      }
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
