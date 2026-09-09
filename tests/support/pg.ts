/**
 * Real Postgres for the tests where Postgres itself is the thing under test
 * (constraints, RLS, the locking columns, the telemetry store) and for the
 * seeded-DB render pass. Nothing here mocks the database — 02-architecture.v1.md
 * §1 names "Testcontainers-backed real Postgres, directly reusing pronos'
 * existing pattern" as the seam, so these tests apply the PRODUCTION
 * migrations, never a frozen copy of the DDL.
 *
 * The container is started first, deliberately: that exercises the whole
 * Testcontainers harness on every run, so the only thing that can be missing
 * at the red gate is production code.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

/** Where production migrations are expected to live (documented in traceability.md). */
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');

export type TestDatabase = {
  client: pg.Client;
  connectionUri: string;
  stop(): Promise<void>;
};

export function readMigrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `No production migrations found: ${MIGRATIONS_DIR} does not exist. ` +
        `Arsène's Postgres schema (articles, article_images, categories, arsene_leagues, ` +
        `pronos_entries, site_assets, arsene_telemetry_events + their RLS policies) must be ` +
        `delivered as expand-only migrations in db/migrations/*.sql ` +
        `(02-architecture.v1.md §6 "Migration safety: expand-only").`,
    );
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No production migrations found: ${MIGRATIONS_DIR} contains no .sql files.`);
  }
  return files;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();

  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();

  let migrations: string[];
  try {
    migrations = readMigrationFiles();
  } catch (err) {
    await client.end();
    await container.stop();
    throw err;
  }

  for (const file of migrations) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
  }

  return {
    client,
    connectionUri: container.getConnectionUri(),
    async stop() {
      await client.end();
      await container.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding — the same tables the editor SPA writes through PostgREST.
// ---------------------------------------------------------------------------

export async function seedWriter(
  client: pg.Client,
  display_name: string,
  opts?: { email?: string; is_admin?: boolean; revoked_at?: string | null },
): Promise<string> {
  // `email` is required (0007) and unique — auto-generated per call so the
  // dozens of existing callers (display_name only) don't all need updating.
  const email = opts?.email ?? `${crypto.randomUUID()}@writers.test`;
  const res = await client.query(
    `insert into writers (display_name, email, is_admin, revoked_at) values ($1, $2, $3, $4) returning id`,
    [display_name, email, opts?.is_admin ?? false, opts?.revoked_at ?? null],
  );
  return res.rows[0].id;
}

export type CategoryIds = { league_id: string; category_id: string };

/** AC-10's nesting: league first, then type under it. */
export async function seedCategory(
  client: pg.Client,
  league_name: string,
  type_name: string,
): Promise<CategoryIds> {
  const league = await client.query(
    `insert into arsene_leagues (name) values ($1)
       on conflict (name) do update set name = excluded.name
     returning id`,
    [league_name],
  );
  const league_id: string = league.rows[0].id;

  const category = await client.query(
    `insert into categories (league_id, name) values ($1, $2)
       on conflict (league_id, name) do update set name = excluded.name
     returning id`,
    [league_id, type_name],
  );

  return { league_id, category_id: category.rows[0].id };
}

export type SeedArticleOpts = {
  writer_id: string;
  title: string;
  league_name: string;
  type_name: string;
  status?: 'draft' | 'published';
  slug?: string | null;
  published_at?: string | null;
  first_published_at?: string | null;
  body_html?: string;
  /** Credited authors, ordinal order (`article_authors`). Defaults to just
   *  `writer_id` — the single-author case every existing caller wants;
   *  pass more to seed a co-authored fixture directly. */
  author_writer_ids?: string[];
};

export async function seedArticle(client: pg.Client, o: SeedArticleOpts): Promise<string> {
  const { league_id, category_id } = await seedCategory(client, o.league_name, o.type_name);
  const res = await client.query(
    `insert into articles
       (writer_id, title, body_html, league_id, category_id, status, slug,
        meta_title, meta_description, published_at, first_published_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      o.writer_id,
      o.title,
      o.body_html ?? '<h2>Les affiches</h2><p>Analyse match par match.</p>',
      league_id,
      category_id,
      o.status ?? 'draft',
      o.slug ?? null,
      o.title,
      'Nos pronostics, confiance, scores et analyses match par match.',
      o.published_at ?? null,
      o.first_published_at ?? o.published_at ?? null,
    ],
  );
  const article_id: string = res.rows[0].id;

  // Mirrors what `insertDraft` (src/api/repo.ts) does for real — a seeded
  // article is never left without a credited author, the same invariant the
  // production insert path guarantees.
  const authors = o.author_writer_ids ?? [o.writer_id];
  for (const [index, author_writer_id] of authors.entries()) {
    await client.query(
      `insert into article_authors (article_id, writer_id, ordinal) values ($1, $2, $3)`,
      [article_id, author_writer_id, index + 1],
    );
  }

  return article_id;
}

export async function seedImage(
  client: pg.Client,
  o: {
    article_id: string;
    role: 'cover' | 'body';
    status?: 'processing' | 'ready' | 'failed';
    alt_text?: string | null;
    optimized_url?: string;
  },
): Promise<string> {
  const res = await client.query(
    `insert into article_images
       (article_id, role, status, original_filename, alt_text, original_url, optimized_url)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      o.article_id,
      o.role,
      o.status ?? 'ready',
      `${o.role}.jpg`,
      o.alt_text ?? null,
      // The as-uploaded original lives in Supabase Storage and is never served
      // to visitors — see NFR-EGRESS-01 in tests/db/publicSiteRender.test.ts.
      `https://projectref.supabase.co/storage/v1/object/articles/${o.article_id}/${o.role}-original.jpg`,
      o.optimized_url ?? `https://cdn.example/${o.article_id}/${o.role}-optimized.webp`,
    ],
  );
  return res.rows[0].id;
}

export async function seedAvatar(
  client: pg.Client,
  o: {
    writer_id: string;
    status?: 'processing' | 'ready' | 'failed';
    optimized_url?: string;
  },
): Promise<string> {
  const res = await client.query(
    `insert into writer_avatars
       (writer_id, status, original_filename, original_url, optimized_url)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      o.writer_id,
      o.status ?? 'ready',
      'avatar.jpg',
      `https://projectref.supabase.co/storage/v1/object/avatars/${o.writer_id}-original.jpg`,
      o.optimized_url ?? `https://cdn.example/${o.writer_id}/avatar-optimized.webp`,
    ],
  );
  return res.rows[0].id;
}

export async function insertTelemetry(
  client: pg.Client,
  o: {
    event_type: string;
    writer_id: string;
    article_id: string;
    occurred_at: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `insert into arsene_telemetry_events (event_type, writer_id, article_id, occurred_at, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [o.event_type, o.writer_id, o.article_id, o.occurred_at, JSON.stringify(o.payload ?? {})],
  );
}

export type PgError = Error & { code?: string };

export async function captureSqlError(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as PgError).code ?? null;
  }
}
