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
    left join arsene_leagues l on l.id = a.league_id
    left join categories c on c.id = a.category_id
   where a.id = $1
`;

/**
 * Spec §4's start timestamp for a draft the SPA inserted through PostgREST.
 * `to_jsonb` writes a plain ISO string; `to_json(...)::text` used to wrap it in
 * a second set of quotes (verify finding #7).
 */
const ENSURE_DRAFT_STARTED_SQL = `
  insert into arsene_telemetry_events (event_type, writer_id, article_id, occurred_at, payload)
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

/**
 * The same compare-and-swap, settling the row as a body image instead. Used
 * only when the statement above is refused by `0005`'s one-ready-cover index:
 * two cover uploads raced, and this one reached `ready` second. Demoting the
 * late arrival is what `demoteCurrentCover` would have done had the two
 * uploads not overlapped — and it is the alternative to failing an ADR-0004
 * callback that has nothing wrong with it.
 */
const SET_IMAGE_STATUS_AS_BODY_SQL = `
  update article_images
     set role = 'body',
         status = $2,
         optimized_url = $3,
         failure_code = $4,
         failure_message = $5
   where id = $1 and status = 'processing'
  returning id
`;

/** Postgres unique-violation: `0005`'s one-ready-cover-per-article index. */
const UNIQUE_VIOLATION = '23505';

export type WriterRow = {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  created_at: string;
  revoked_at: string | null;
};

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
    /**
     * AC-01: the one insert that also carries the `draft_started` metric.
     * Also credits the creating writer as the article's first author
     * (`article_authors`, ordinal 1) in the same transaction, so a brand-new
     * article always has at least one credited author from the moment it
     * exists — the public byline (`src/site/render.ts`) never has to
     * special-case an empty author list.
     */
    async insertDraft(input: { writer_id: string; title: string }): Promise<{ id: string }> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const res = await client.query<{ id: string }>(
          `insert into articles (writer_id, title) values ($1, $2) returning id`,
          [input.writer_id, input.title],
        );
        const id = res.rows[0]?.id ?? '';
        await client.query(
          `insert into article_authors (article_id, writer_id, ordinal) values ($1, $2, 1)`,
          [id, input.writer_id],
        );
        await client.query('commit');
        return { id };
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
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
      const params = [
        input.image_id,
        input.status,
        input.optimized_url,
        input.failure?.code ?? null,
        input.failure?.message ?? null,
      ];
      try {
        const res = await pool.query(SET_IMAGE_STATUS_SQL, params);
        return res.rowCount === 1;
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
        // The article already holds a `ready` cover (`0005`): a concurrent
        // cover upload converted first. Settle this one as a body image rather
        // than failing a callback that is not at fault — the alternative is a
        // row stuck `processing` forever, blocking the publish.
        const res = await pool.query(SET_IMAGE_STATUS_AS_BODY_SQL, params);
        return res.rowCount === 1;
      }
    },

    async getArticle(article_id: string): Promise<ArticleRecord | null> {
      if (!UUID.test(article_id)) return null;
      const res = await pool.query<ArticleRecord>(ARTICLE_SQL, [article_id]);
      return res.rows[0] ?? null;
    },

    async getArticleImages(article_id: string): Promise<ImageRecord[]> {
      if (!UUID.test(article_id)) return [];
      const res = await pool.query<ImageRecord>(
        `select id, article_id, role, status, alt_text, optimized_url,
                original_url, replaced_cover_image_id
           from article_images where article_id = $1`,
        [article_id],
      );
      return res.rows;
    },

    /**
     * AC-14: the slugs a new one has to avoid — the base and every variant
     * `generateSlug` could derive from it. `toSlug` emits `[a-z0-9-]` only, so
     * the base carries no `like` metacharacter.
     */
    async takenSlugs(base_slug: string): Promise<string[]> {
      const res = await pool.query<{ slug: string }>(
        `select slug from articles where slug = $1 or slug like $1 || '-%'`,
        [base_slug],
      );
      return res.rows.map((row: { slug: string }) => row.slug);
    },

    /**
     * H-V3-01: a token's `sub` is a claim about who is calling, not permission
     * to write. Non-UUID ids are answered `false` rather than handed to
     * Postgres, so a `sub` shaped like anything at all is a decision here and
     * never a database error somewhere downstream.
     *
     * `revoked_at is null` (0007/0008): the Edge Function half of the same
     * closure RLS enforces for direct PostgREST callers — both paths now
     * agree that a revoked writer's still-valid JWT does not grant access.
     */
    async isWriter(writer_id: string): Promise<boolean> {
      if (!UUID.test(writer_id)) return false;
      const res = await pool.query(
        `select 1 from writers where id = $1 and revoked_at is null`,
        [writer_id],
      );
      return res.rowCount === 1;
    },

    /** Same revoked-excludes-access shape as `isWriter` — a revoked admin is
     *  not an admin, even before their session would otherwise expire. */
    async isAdmin(writer_id: string): Promise<boolean> {
      if (!UUID.test(writer_id)) return false;
      const res = await pool.query<{ is_admin: boolean }>(
        `select is_admin from writers where id = $1 and revoked_at is null`,
        [writer_id],
      );
      return res.rows[0]?.is_admin === true;
    },

    async getWriterDisplayName(writer_id: string): Promise<string> {
      const res = await pool.query<{ display_name: string }>(
        `select display_name from writers where id = $1`,
        [writer_id],
      );
      return res.rows[0]?.display_name ?? 'Un rédacteur';
    },

    /** Ordinal order — the byline `publishArticle.ts` bakes into
     *  `structured_data` at publish time, same source `src/site/render.ts`'s
     *  own `PUBLISHED_ARTICLES_SQL` aggregates from live. */
    async getArticleAuthorNames(article_id: string): Promise<string[]> {
      if (!UUID.test(article_id)) return [];
      const res = await pool.query<{ display_name: string }>(
        `select w.display_name
           from article_authors aa
           join writers w on w.id = aa.writer_id
          where aa.article_id = $1
          order by aa.ordinal`,
        [article_id],
      );
      return res.rows.map((row) => row.display_name);
    },

    /** The settings page's writer list — every writer, active or revoked. */
    async listWriters(): Promise<WriterRow[]> {
      const res = await pool.query<WriterRow>(
        `select id, email, display_name, is_admin, created_at, revoked_at
           from writers
          order by created_at`,
      );
      return res.rows;
    },

    /** The co-author picker's writer list — deliberately trimmed to
     *  `{id, display_name}`, unlike `listWriters()`'s admin-only
     *  `WriterRow` (no email/is_admin/revoked_at), and revoked writers
     *  excluded outright rather than shown greyed-out: a revoked writer
     *  cannot hold a session to accept the credit anyway. */
    async listActiveWriters(): Promise<{ id: string; display_name: string }[]> {
      const res = await pool.query<{ id: string; display_name: string }>(
        `select id, display_name from writers where revoked_at is null order by display_name`,
      );
      return res.rows;
    },

    /**
     * Same on-conflict shape `scripts/create-writer.ts` already used before
     * this file existed — reused via `src/api/authAdmin.ts`, not duplicated.
     * Re-inviting an existing (possibly revoked) email reinstates it
     * (`revoked_at` reset to null) rather than silently no-op'ing, since a
     * re-invite is a deliberate "let them back in" action.
     */
    async upsertWriter(input: { id: string; email: string; display_name: string }): Promise<WriterRow> {
      const res = await pool.query<WriterRow>(
        `insert into writers (id, email, display_name)
           values ($1, $2, $3)
         on conflict (id) do update
           set email = excluded.email, display_name = excluded.display_name, revoked_at = null
         returning id, email, display_name, is_admin, created_at, revoked_at`,
        [input.id, input.email, input.display_name],
      );
      const writer = res.rows[0];
      // `insert ... on conflict do update ... returning` always yields
      // exactly one row for a successful statement — a constraint violation
      // throws instead of getting here. This is a type-narrowing guard, not
      // a real runtime path.
      if (writer === undefined) throw new Error('upsertWriter: insert returned no row');
      return writer;
    },

    /**
     * Revoking is a flag, not a row removal — `articles.writer_id` is
     * `not null references writers (id)` with default RESTRICT delete, so a
     * hard delete of a writer with existing articles would fail outright,
     * and a soft flag preserves authorship history either way.
     *
     * The guard is the confirmed decision from planning this feature: the
     * last active admin can never be revoked, in one transaction with the
     * revoke itself, so there's no window where a second caller could slip
     * a revoke of the second-to-last admin through between the check and
     * the write.
     */
    async setWriterRevoked(
      input: { writer_id: string; revoked: boolean },
    ): Promise<
      | { ok: true; writer: WriterRow }
      | { ok: false; error: 'LAST_ADMIN_CANNOT_BE_REVOKED' | 'WRITER_NOT_FOUND' }
    > {
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (input.revoked) {
          const remaining = await client.query(
            `select count(*)::int as n from writers
              where is_admin and revoked_at is null and id != $1`,
            [input.writer_id],
          );
          const target = await client.query<{ is_admin: boolean }>(
            `select is_admin from writers where id = $1 and revoked_at is null`,
            [input.writer_id],
          );
          if (target.rows[0]?.is_admin === true && remaining.rows[0].n === 0) {
            await client.query('rollback');
            return { ok: false, error: 'LAST_ADMIN_CANNOT_BE_REVOKED' };
          }
        }
        const res = await client.query<WriterRow>(
          `update writers set revoked_at = case when $2 then now() else null end
             where id = $1
           returning id, email, display_name, is_admin, created_at, revoked_at`,
          [input.writer_id, input.revoked],
        );
        const writer = res.rows[0];
        if (writer === undefined) {
          await client.query('rollback');
          return { ok: false, error: 'WRITER_NOT_FOUND' };
        }
        await client.query('commit');
        return { ok: true, writer };
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },

    /** Admin-only cleanup of an article that was never published — publish
     *  is irreversible in a way a plain draft never was (a live public URL,
     *  JSON-LD, a sitemap entry), so this only ever touches `status =
     *  'draft'` rows. The four tables that reference `articles.id`
     *  (`article_images`, `pronos_entries`, and the two telemetry tables —
     *  0001/0006) all cascade-delete, so nothing is left orphaned. */
    async deleteDraftArticle(article_id: string): Promise<'deleted' | 'not_found' | 'not_draft'> {
      if (!UUID.test(article_id)) return 'not_found';
      const res = await pool.query(`delete from articles where id = $1 and status = 'draft'`, [article_id]);
      if (res.rowCount === 1) return 'deleted';
      const existing = await pool.query(`select 1 from articles where id = $1`, [article_id]);
      return existing.rowCount === 1 ? 'not_draft' : 'not_found';
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

    /**
     * AC-06: at most one cover per article, decided in this transaction.
     *
     * Whatever held the slot loses it, `status` notwithstanding. The id
     * returned here is what the new row records as `replaced_cover_image_id`,
     * and that record is the only durable evidence that this row's slot was
     * taken over — `publishArticle.ts` reads it instead of `role`, and the
     * superseded upload's own outcome may arrive long afterwards, from
     * ADR-0004's callback (M-V5-02). Green v5 excluded `failed` rows here to
     * stop a rejected upload being promoted into the body slot; that is no
     * longer what keeps it from blocking a publish — a row nothing was ever
     * stored for is excluded whatever slot it sits in — and excluding them
     * left an asynchronously-failed cover unsuperseded and so blocking
     * forever, which is the very trap this is all about. This route never
     * reaches here for a file it is rejecting, so a cover the article can use
     * is still never displaced by one it cannot (M-V4-01).
     */
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
     * `05-verification.v7.md` §4: the writer's way out of an image row the
     * article can never be published with. `status <> 'ready'` is repeated
     * here, in the statement itself, rather than trusted from
     * `discardImage.ts`'s read: the ADR-0004 callback settles rows
     * asynchronously, so a row that was `processing` when the handler looked
     * can be `ready` by the time this runs, and a delete that is not a
     * compare-and-swap would remove exactly the cover the article had just
     * become publishable with.
     */
    async deleteImage(input: { image_id: string; article_id: string }): Promise<boolean> {
      if (!UUID.test(input.image_id) || !UUID.test(input.article_id)) return false;
      const res = await pool.query(
        `delete from article_images
          where id = $1 and article_id = $2 and status <> 'ready'`,
        [input.image_id, input.article_id],
      );
      return res.rowCount === 1;
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
          `insert into arsene_telemetry_events (id, event_type, writer_id, article_id, occurred_at, payload)
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

    /**
     * The read side of Pam's one success metric (`state.json`'s
     * `success.metrics[0]`, "time from draft start to published"). Returns
     * raw samples, never a writer_id or article_id — the dashboard aggregates
     * client-side, and nothing here identifies who published what or how
     * fast, only that a publish happened and how long it took.
     *
     * The join excludes a `draft_started` row that arrives *after* its
     * `article_published` (impossible in practice — publish requires an
     * existing draft — but excluding it here rather than trusting the write
     * side means a negative duration can never reach the dashboard, whatever
     * produced it).
     */
    async getTimeToPublishSamples(): Promise<{ published_at: string; minutes: number }[]> {
      const res = await pool.query<{ published_at: string; minutes: number }>(
        `select p.occurred_at as published_at,
                extract(epoch from (p.occurred_at - d.occurred_at)) / 60.0 as minutes
           from arsene_telemetry_events d
           join arsene_telemetry_events p
             on p.article_id = d.article_id
            and p.event_type = 'article_published'
          where d.event_type = 'draft_started'
            and p.occurred_at >= d.occurred_at
          order by p.occurred_at`,
      );
      return res.rows.map((row: { published_at: string; minutes: number }) => ({
        published_at: row.published_at,
        minutes: Number(row.minutes),
      }));
    },

    /**
     * The counter-metric (`state.json`'s `success.counter_metric`): "writer
     * adoption must not decline". A count, never a list — how many writers
     * are still drafting, not which ones, so this stays safe to show on the
     * same dashboard as the timing aggregate above.
     */
    async getActiveWriterCount(sinceDaysAgo: number): Promise<number> {
      const res = await pool.query<{ count: string }>(
        `select count(distinct writer_id) as count
           from arsene_telemetry_events
          where event_type = 'draft_started'
            and occurred_at >= now() - ($1 || ' days')::interval`,
        [sinceDaysAgo],
      );
      return Number(res.rows[0]?.count ?? 0);
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
