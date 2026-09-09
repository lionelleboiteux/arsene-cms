import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MIGRATIONS_DIR,
  captureSqlError,
  insertTelemetry,
  readMigrationFiles,
  seedArticle,
  seedAvatar,
  seedCategory,
  seedImage,
  seedWriter,
  startTestDatabase,
  type TestDatabase,
} from '../support/pg.js';

/**
 * Datastore behaviour against a real Postgres 16 (Testcontainers), applying the
 * PRODUCTION migrations — 02-architecture.v1.md §1 names this seam directly
 * ("Testcontainers-backed real Postgres, directly reusing pronos' existing
 * pattern"). Postgres's own behaviour — RLS, constraints, timing — is never
 * mocked.
 *
 * Setup failures are captured rather than thrown from beforeAll, so a missing
 * migration set fails each test individually (visible to the red gate) rather
 * than silently skipping the whole file.
 *
 * ASSUMPTION (traceability.md §6): the roles are Supabase's own `anon` and
 * `authenticated`, created by the first migration exactly as pronos does.
 */

let started: TestDatabase | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  try {
    started = await startTestDatabase();
  } catch (err) {
    startupError = err as Error;
  }
}, 240_000);

afterAll(async () => {
  await started?.stop().catch(() => undefined);
});

/** Throws inside the test body, so the failure is attributed to that test. */
function db(): TestDatabase {
  if (startupError) throw startupError;
  return started as TestDatabase;
}

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  const { client } = db();
  await client.query(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await client.query('reset role');
  }
}

/**
 * `asRole('authenticated', ...)` alone no longer suffices for tables 0008
 * gated behind `is_active_writer()` — that function reads `auth.uid()`,
 * which resolves from the `request.jwt.claim.sub` GUC, never set by `asRole`
 * alone (nothing before 0008 needed it; every policy was `using (true)`).
 * This sets that GUC to a real writer's id before switching role, so RLS
 * evaluates the same way it would for that writer's actual PostgREST call.
 * A plain (session-scoped) `SET`, not `SET LOCAL`: each `client.query()` call
 * here runs in its own auto-committed transaction, so a transaction-scoped
 * `LOCAL` setting would revert before `fn()`'s own query ever ran — mirrors
 * `asRole`'s own `SET ROLE`/`RESET ROLE` pattern for exactly that reason.
 */
async function asWriter<T>(writerId: string, fn: () => Promise<T>): Promise<T> {
  const { client } = db();
  await client.query(`set request.jwt.claim.sub = '${writerId}'`);
  await client.query(`set role authenticated`);
  try {
    return await fn();
  } finally {
    await client.query('reset role');
    await client.query('reset request.jwt.claim.sub');
  }
}

describe('shared asset library', () => {
  it('AC-09: a logo uploaded by one writer is listed for every other writer, with no re-upload', async () => {
    const { client } = db();
    const marie = await seedWriter(client, 'Marie D.');
    await client.query(
      `insert into site_assets (uploaded_by, name, url) values ($1, $2, $3)`,
      [marie, 'Fantasy Coach logo', 'https://cdn.example/site/logo.webp'],
    );

    const visible = await asWriter(marie, () =>
      client.query(`select name from site_assets where name = 'Fantasy Coach logo'`),
    );

    expect(visible.rows.map((r) => r.name)).toEqual(['Fantasy Coach logo']);
  });
});

describe('draft locking under real timing', () => {
  const takeLock = (article_id: string, writer_id: string, stalenessSeconds = 90) =>
    db().client.query(
      `update articles
          set locked_by = $2, locked_at = now()
        where id = $1
          and (locked_by is null
               or locked_by = $2
               or locked_at < now() - ($3 || ' seconds')::interval)
        returning id`,
      [article_id, writer_id, String(stalenessSeconds)],
    );

  it('AC-05: while writer A’s heartbeat is current, writer B’s attempt to take the lock updates no row', async () => {
    const { client } = db();
    const a = await seedWriter(client, 'Marie D. (fresh)');
    const b = await seedWriter(client, 'Lionel (fresh)');
    const article = await seedArticle(client, {
      writer_id: a,
      title: 'Mercato Bundesliga - Août',
      league_name: 'Bundesliga',
      type_name: 'Mercato',
    });
    await client.query(`update articles set locked_by = $2, locked_at = now() where id = $1`, [article, a]);

    const res = await takeLock(article, b);

    expect(res.rowCount).toBe(0);
  });

  it('AC-05: once writer A’s lock is 91 seconds stale, writer B takes it without any admin unlock', async () => {
    const { client } = db();
    const a = await seedWriter(client, 'Marie D. (stale)');
    const b = await seedWriter(client, 'Lionel (stale)');
    const article = await seedArticle(client, {
      writer_id: a,
      title: 'Mercato Bundesliga - Septembre',
      league_name: 'Bundesliga',
      type_name: 'Mercato',
    });
    await client.query(
      `update articles set locked_by = $2, locked_at = now() - interval '91 seconds' where id = $1`,
      [article, a],
    );

    const res = await takeLock(article, b);

    expect(res.rowCount).toBe(1);
  });
});

describe('taxonomy storage', () => {
  it('DEC-02: "ligue1" is stored alongside "Ligue 1" instead of being merged into it, because v1 leaves near-duplicates to manual cleanup', async () => {
    const { client } = db();
    await seedCategory(client, 'Ligue 1', 'Pronos');
    await seedCategory(client, 'ligue1', 'Pronos');

    const res = await client.query(
      `select name from arsene_leagues where lower(replace(name, ' ', '')) = 'ligue1' order by name`,
    );

    expect(res.rows.map((r) => r.name)).toEqual(['Ligue 1', 'ligue1']);
  });
});

describe('alt text', () => {
  it('AC-15: a writer can overwrite generated alt text with a direct row update, no endpoint involved', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (alt)');
    const article = await seedArticle(client, {
      writer_id: writer,
      title: 'PSG vs Marseille',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });
    const image = await seedImage(client, {
      article_id: article,
      role: 'cover',
      alt_text: 'PSG face à l’OM au Parc des Princes',
    });

    const updated = await asWriter(writer, () =>
      client.query(`update article_images set alt_text = $2 where id = $1 returning alt_text`, [
        image,
        'Ousmane Dembélé célèbre son but au Parc des Princes',
      ]),
    );

    expect(updated.rows.map((r) => r.alt_text)).toEqual([
      'Ousmane Dembélé célèbre son but au Parc des Princes',
    ]);
  });
});

describe('pronos fixture reference (ADR-0002)', () => {
  it('ADR-0002: the pronos match reference is nullable and carries no cross-project foreign key, so manual entry is never blocked', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (pronos)');
    const article = await seedArticle(client, {
      writer_id: writer,
      title: 'Pronos Ligue 1 - Journée 13',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const inserted = await client.query(
      `insert into pronos_entries
         (article_id, home_team, away_team, predicted_home_score, predicted_away_score, confidence_tier)
       values ($1, 'PSG', 'Marseille', 2, 1, 'Indispensable')
       returning pronos_league_id, pronos_game_id, match_kickoff_at`,
      [article],
    );

    const nullability = await client.query(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = 'pronos_entries'
          and column_name in ('pronos_league_id', 'pronos_game_id', 'match_kickoff_at')
        order by column_name`,
    );

    expect({
      row: inserted.rows[0],
      nullable: nullability.rows.map((r) => [r.column_name, r.is_nullable]),
    }).toEqual({
      row: { pronos_league_id: null, pronos_game_id: null, match_kickoff_at: null },
      nullable: [
        ['match_kickoff_at', 'YES'],
        ['pronos_game_id', 'YES'],
        ['pronos_league_id', 'YES'],
      ],
    });
  });
});

describe('arsene_telemetry_events store', () => {
  const REQUIRED_EVENT_TYPES = ['draft_started', 'article_published'];

  it.each(
    REQUIRED_EVENT_TYPES.map(
      (t) => [`TELEMETRY-${t}: the arsene_telemetry_events store accepts this required event type`, t] as const,
    ),
  )('%s', async (_title, event_type) => {
    const { client } = db();
    const writer = await seedWriter(client, `Lionel (${event_type})`);
    const article = await seedArticle(client, {
      writer_id: writer,
      title: `Article ${event_type}`,
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const res = await client.query(
      `insert into arsene_telemetry_events (event_type, writer_id, article_id, occurred_at, payload)
       values ($1, $2, $3, now(), '{}'::jsonb) returning event_type`,
      [event_type, writer, article],
    );

    expect(res.rows[0].event_type).toBe(event_type);
  });

  it('TELEMETRY-REGISTRY: the store rejects an event type outside the agreed two, so the metric cannot be polluted', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (registry)');
    const article = await seedArticle(client, {
      writer_id: writer,
      title: 'Article registry',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const sqlstate = await captureSqlError(() =>
      client.query(
        `insert into arsene_telemetry_events (event_type, writer_id, article_id, occurred_at, payload)
         values ('article_previewed', $1, $2, now(), '{}'::jsonb)`,
        [writer, article],
      ),
    );

    expect(sqlstate).toBe('23514'); // check_violation
  });

  it('AC-18: a draft started at 10:00 and published at 10:47 yields a 47-minute time-to-publish from the stored events alone', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (ttp)');
    const article = await seedArticle(client, {
      writer_id: writer,
      title: 'Pronos Ligue 1 - Journée 14',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });
    await insertTelemetry(client, {
      event_type: 'draft_started',
      writer_id: writer,
      article_id: article,
      occurred_at: '2026-08-11T10:00:00Z',
      payload: { started_at: '2026-08-11T10:00:00Z' },
    });
    await insertTelemetry(client, {
      event_type: 'article_published',
      writer_id: writer,
      article_id: article,
      occurred_at: '2026-08-11T10:47:00Z',
      payload: { published_at: '2026-08-11T10:47:00Z', is_republish: false },
    });

    const res = await client.query(
      `select p.writer_id,
              extract(epoch from (p.occurred_at - d.occurred_at)) / 60 as minutes
         from arsene_telemetry_events d
         join arsene_telemetry_events p on p.article_id = d.article_id
        where d.article_id = $1
          and d.event_type = 'draft_started'
          and p.event_type = 'article_published'`,
      [article],
    );

    expect(res.rows.map((r) => [r.writer_id, Number(r.minutes)])).toEqual([[writer, 47]]);
  });
});

describe('write protection and disclosure', () => {
  it('NFR-RLS-01: row level security is enabled on every table the editor reaches through PostgREST', async () => {
    const res = await db().client.query(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('articles', 'article_images', 'article_authors', 'categories', 'arsene_leagues',
                            'pronos_entries', 'site_assets', 'arsene_telemetry_events', 'writers')
        order by c.relname`,
    );

    expect(res.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('NFR-RLS-02: the anon role can read a published article but never an unpublished one', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (rls)');
    await seedArticle(client, {
      writer_id: writer,
      title: 'Brouillon secret',
      league_name: 'Premier League',
      type_name: 'Pronos',
      status: 'draft',
    });
    await seedArticle(client, {
      writer_id: writer,
      title: 'Article publié',
      league_name: 'Premier League',
      type_name: 'Pronos',
      status: 'published',
      slug: 'article-publie',
      published_at: '2026-08-10T09:00:00Z',
    });

    const visible = await asRole('anon', () =>
      client.query(`select title from articles where title in ('Brouillon secret', 'Article publié')`),
    );

    expect(visible.rows.map((r) => r.title)).toEqual(['Article publié']);
  });

  it('NFR-RLS-03: the anon role cannot read images belonging to an unpublished article', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (rls-img)');
    const draft = await seedArticle(client, {
      writer_id: writer,
      title: 'Brouillon avec image',
      league_name: 'Premier League',
      type_name: 'Mercato',
      status: 'draft',
    });
    await seedImage(client, { article_id: draft, role: 'cover', optimized_url: 'https://cdn.example/secret.webp' });

    const visible = await asRole('anon', () =>
      client.query(`select id from article_images where article_id = $1`, [draft]),
    );

    expect(visible.rowCount).toBe(0);
  });

  it('NFR-TAMPER-01: a writer cannot set published_at directly — publish-controlled columns are not writable through PostgREST', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (tamper)');
    const article = await seedArticle(client, {
      writer_id: writer,
      title: 'Auto-publication',
      league_name: 'Ligue 1',
      type_name: 'Mercato',
      status: 'draft',
    });

    const sqlstate = await asRole('authenticated', () =>
      captureSqlError(() =>
        client.query(`update articles set published_at = now() where id = $1`, [article]),
      ),
    );

    expect(sqlstate).toBe('42501'); // insufficient_privilege
  });

  /**
   * M1 (05-verification.v2.md §4, third remediation pass) — AC-05's lock is
   * stealable straight through PostgREST.
   *
   * `db/migrations/0001_initial_schema.sql`'s column grant hands
   * `authenticated` direct UPDATE on `locked_by`/`locked_at`, and
   * `writers_manage_articles` is `using (true) with check (true)`. So while
   * `repo.takeLock()` implements the compare-and-swap ADR-0003 designed, any
   * writer can skip it entirely with `PATCH /rest/v1/articles?id=eq.<id>` and
   * take a colleague's live lock mid-sentence — with no recovery path for the
   * writer who lost it. The application-level CAS proven in
   * `tests/db/remediation.test.ts` (AC-05-free/held/stale) is only a lock if
   * the data layer agrees it is.
   *
   * The lock columns therefore belong on the same side of the grant line as
   * the publish-controlled ones NFR-TAMPER-01 (directly above) already pins:
   * written only by the server seam running as `service_role`, i.e. reachable
   * only through `POST /v1/articles/{id}/open`, which is where the CAS lives.
   *
   * Two cases, because they are two different attacks and one grant change
   * could close only one of them:
   *   a  writing `locked_by` steals the lock outright;
   *   b  writing `locked_at` alone never changes the holder, but refreshes
   *      somebody else's heartbeat forever, so the 90-second staleness window
   *      that AC-05 relies on to recover an abandoned draft never opens.
   */
  type LockGrantCase = { id: string; attack: string; sql: string; params: (article: string, writer: string) => string[] };

  const LOCK_GRANT_CASES: LockGrantCase[] = [
    {
      id: 'NFR-LOCK-GRANT-01a',
      attack: 'stealing a colleague’s live lock by writing locked_by directly',
      sql: `update articles set locked_by = $2, locked_at = now() where id = $1`,
      params: (article, writer) => [article, writer],
    },
    {
      id: 'NFR-LOCK-GRANT-01b',
      attack: 'keeping a colleague’s abandoned lock alive forever by refreshing locked_at directly',
      sql: `update articles set locked_at = now() where id = $1`,
      params: (article) => [article],
    },
  ];

  it.each(
    LOCK_GRANT_CASES.map(
      (c) =>
        [
          `${c.id}: a writer cannot take the draft lock through PostgREST — ${c.attack} is refused, so the only way to hold a lock is the server seam's compare-and-swap`,
          c,
        ] as const,
    ),
  )('%s', async (_title, c) => {
    const { client } = db();
    const marie = await seedWriter(client, `Marie D. (lock grant ${c.id})`);
    const thief = await seedWriter(client, `Lionel (lock grant ${c.id})`);
    const article = await seedArticle(client, {
      writer_id: marie,
      title: `Verrou volé ${c.id}`,
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });
    // Marie is holding it right now: her heartbeat is one second old.
    await client.query(
      `update articles set locked_by = $2, locked_at = now() - interval '1 second' where id = $1`,
      [article, marie],
    );

    const sqlstate = await asRole('authenticated', () =>
      captureSqlError(() => client.query(c.sql, c.params(article, thief))),
    );

    expect(sqlstate).toBe('42501'); // insufficient_privilege
  });

  it('NFR-AUDIT-01: every article and every telemetry row is stamped with a writer id that cannot be null', async () => {
    const res = await db().client.query(
      `select table_name, column_name, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in
              (('articles', 'writer_id'), ('articles', 'updated_at'), ('arsene_telemetry_events', 'writer_id'))
        order by table_name, column_name`,
    );

    expect(res.rows.map((r) => [r.table_name, r.column_name, r.is_nullable])).toEqual([
      ['arsene_telemetry_events', 'writer_id', 'NO'],
      ['articles', 'updated_at', 'NO'],
      ['articles', 'writer_id', 'NO'],
    ]);
  });
});

/**
 * 0008 — `authenticated` alone used to be sufficient for every table below
 * (every `writers_manage_*` policy from 0001 was `using (true) with check
 * (true))`, so any Supabase Auth session, provisioned or not, could read
 * every draft and write any of these tables through direct PostgREST. An
 * active `writers` row (`is_active_writer()`) is now the actual
 * authorization decision — this is the change that makes the admin
 * allow-list (0007's columns, the settings-page invite/revoke routes) mean
 * anything at all, not just a UI in front of an unchanged database.
 */
describe('active-writer RLS (0008)', () => {
  const GATED_TABLES = [
    'arsene_leagues',
    'categories',
    'articles',
    'article_images',
    'pronos_entries',
    'site_assets',
  ] as const;

  it('NFR-RLS-WRITER-01: an authenticated session with no writers row at all cannot read any of the six gated tables', async () => {
    const { client } = db();
    const stranger = crypto.randomUUID(); // a syntactically valid id, no writers row

    const rows = await asWriter(stranger, async () => {
      const results: Record<string, number> = {};
      for (const table of GATED_TABLES) {
        const res = await client.query(`select 1 from ${table}`);
        results[table] = res.rowCount ?? 0;
      }
      return results;
    });

    expect(Object.values(rows).every((count) => count === 0)).toBe(true);
  });

  it('NFR-RLS-WRITER-02: a stranger with no writers row cannot update an existing article either — reading NFR-RLS-WRITER-01 as "empty" is not the same claim as "refused to write"', async () => {
    const { client } = db();
    const owner = await seedWriter(client, 'Lionel (rls-writer owner)');
    const article = await seedArticle(client, {
      writer_id: owner,
      title: 'Original',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });
    const stranger = crypto.randomUUID();

    const updated = await asWriter(stranger, () =>
      client.query(`update articles set title = 'Defaced' where id = $1 returning id`, [article]),
    );

    expect(updated.rowCount).toBe(0);
  });

  it('NFR-RLS-WRITER-03: a revoked writer is refused exactly like a stranger, even though their writers row genuinely exists', async () => {
    const { client } = db();
    const revoked = await seedWriter(client, 'Lionel (rls-writer revoked)', {
      revoked_at: new Date().toISOString(),
    });
    const owner = await seedWriter(client, 'Lionel (rls-writer revoked-owner)');
    const article = await seedArticle(client, {
      writer_id: owner,
      title: 'Original',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const [read, write] = await asWriter(revoked, () =>
      Promise.all([
        client.query(`select 1 from articles where id = $1`, [article]),
        client.query(`update articles set title = 'Defaced' where id = $1 returning id`, [article]),
      ]),
    );

    expect({ read_rows: read.rowCount, write_rows: write.rowCount }).toEqual({
      read_rows: 0,
      write_rows: 0,
    });
  });

  it('NFR-RLS-WRITER-04: an active writer still reads and writes normally — the fix is a refusal for strangers, not a lockout for everyone', async () => {
    const { client } = db();
    const active = await seedWriter(client, 'Lionel (rls-writer active)');
    const article = await seedArticle(client, {
      writer_id: active,
      title: 'Original',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const updated = await asWriter(active, () =>
      client.query(`update articles set title = 'Modifié' where id = $1 returning title`, [article]),
    );

    expect(updated.rows).toEqual([{ title: 'Modifié' }]);
  });

  it('NFR-RLS-WRITER-05: writers itself is unreadable by anon and by any authenticated session post-0008, since it now carries email', async () => {
    const { client } = db();
    await seedWriter(client, 'Lionel (rls-writer readback)');

    // A grant-level revoke (0008), not just an RLS filter: the right outcome
    // here is a loud 42501, the same "refused, not silently empty" shape
    // NFR-TAMPER-01 already established for publish-controlled columns.
    const anonSqlstate = await asRole('anon', () =>
      captureSqlError(() => client.query(`select 1 from writers`)),
    );
    const strangerSqlstate = await asWriter(crypto.randomUUID(), () =>
      captureSqlError(() => client.query(`select 1 from writers`)),
    );

    expect({ anon: anonSqlstate, stranger: strangerSqlstate }).toEqual({
      anon: '42501',
      stranger: '42501',
    });
  });

  it('NFR-RLS-WRITER-06: migration 0008 is idempotent — re-applying it to an already-migrated database is a no-op, not an error', async () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '0008_require_active_writer_rls.sql'), 'utf8');

    const sqlstate = await captureSqlError(() => db().client.query(sql));

    expect(sqlstate).toBeNull();
  });
});

/**
 * `article_authors` (0009) — the co-authored byline. RLS mirrors `articles`'
 * own `is_active_writer()` policy exactly (same "no role hierarchy" model),
 * so this reuses `active-writer RLS (0008)`'s own `asWriter`/`asRole`
 * pattern rather than inventing a new one.
 */
describe('article_authors — co-authored bylines (0009)', () => {
  it('NFR-AUTHORS-01: an active writer can credit a second writer as a co-author, and read the credit back', async () => {
    const { client } = db();
    const active = await seedWriter(client, 'Lionel (authors-active)');
    const coAuthor = await seedWriter(client, 'Marie (authors-co)');
    const article = await seedArticle(client, {
      writer_id: active,
      title: 'Co-écrit',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });

    const inserted = await asWriter(active, () =>
      client.query(
        `insert into article_authors (article_id, writer_id, ordinal) values ($1, $2, 2) returning writer_id`,
        [article, coAuthor],
      ),
    );
    const read = await asWriter(active, () =>
      client.query(`select writer_id from article_authors where article_id = $1 order by ordinal`, [article]),
    );

    expect({
      inserted_writer: inserted.rows[0]?.writer_id,
      credited_in_order: read.rows.map((r) => r.writer_id),
    }).toEqual({ inserted_writer: coAuthor, credited_in_order: [active, coAuthor] });
  });

  it('NFR-AUTHORS-02: an active writer can remove a co-author credit', async () => {
    const { client } = db();
    const active = await seedWriter(client, 'Lionel (authors-remove)');
    const coAuthor = await seedWriter(client, 'Marie (authors-remove-co)');
    const article = await seedArticle(client, {
      writer_id: active,
      title: 'Retrait de co-auteur',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      author_writer_ids: [active, coAuthor],
    });

    const deleted = await asWriter(active, () =>
      client.query(`delete from article_authors where article_id = $1 and writer_id = $2 returning writer_id`, [
        article,
        coAuthor,
      ]),
    );

    expect(deleted.rowCount).toBe(1);
  });

  it('NFR-AUTHORS-03: a stranger with no writers row cannot read or write article_authors, same as every other gated table', async () => {
    const { client } = db();
    const active = await seedWriter(client, 'Lionel (authors-stranger-owner)');
    const article = await seedArticle(client, {
      writer_id: active,
      title: 'Protégé',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
    });
    const stranger = crypto.randomUUID();

    const [read, write] = await asWriter(stranger, () =>
      Promise.all([
        client.query(`select 1 from article_authors where article_id = $1`, [article]),
        client.query(
          `insert into article_authors (article_id, writer_id, ordinal) values ($1, $2, 2) returning writer_id`,
          [article, stranger],
        ).catch(() => ({ rowCount: 0 })),
      ]),
    );

    expect({ read_rows: read.rowCount, write_rows: write.rowCount }).toEqual({ read_rows: 0, write_rows: 0 });
  });

  it('NFR-AUTHORS-04: service_role can write article_authors directly — the same grant insertDraft (src/api/repo.ts) relies on to credit a new draft\'s creator', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (authors-service-role)');
    const article = await seedArticle(client, {
      writer_id: writer,
      title: 'Service role',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      author_writer_ids: [],
    });

    const written = await asRole('service_role', () =>
      client.query(
        `insert into article_authors (article_id, writer_id, ordinal) values ($1, $2, 1) returning writer_id`,
        [article, writer],
      ),
    );

    expect(written.rows).toEqual([{ writer_id: writer }]);
  });

  it('NFR-AUTHORS-05: migration 0009 is idempotent — re-applying it to an already-migrated database is a no-op, not an error', async () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '0009_article_authors.sql'), 'utf8');

    const sqlstate = await captureSqlError(() => db().client.query(sql));

    expect(sqlstate).toBeNull();
  });
});

/**
 * `writer_avatars` (0010) — the writer's own onboarding photo. RLS is
 * self-scoped (`writer_id = auth.uid()`), unlike `article_authors`' "any
 * active writer" model, so a stranger AND another active writer are both
 * refused read/write here — only the owning writer and `service_role` can
 * touch a row.
 */
describe('writer_avatars — onboarding photo (0010)', () => {
  it('NFR-AVATAR-01: an active writer can read back their own avatar row', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (avatar-self)');
    const avatar = await seedAvatar(client, { writer_id: writer, status: 'ready' });

    const read = await asWriter(writer, () =>
      client.query(`select id, status from writer_avatars where id = $1`, [avatar]),
    );

    expect(read.rows).toEqual([{ id: avatar, status: 'ready' }]);
  });

  it('NFR-AVATAR-02: another active writer cannot read a writer_avatars row that is not their own — self-scoped, unlike article_authors', async () => {
    const { client } = db();
    const owner = await seedWriter(client, 'Lionel (avatar-owner)');
    const other = await seedWriter(client, 'Marie (avatar-other)');
    const avatar = await seedAvatar(client, { writer_id: owner, status: 'ready' });

    const read = await asWriter(other, () =>
      client.query(`select 1 from writer_avatars where id = $1`, [avatar]),
    );

    expect(read.rowCount).toBe(0);
  });

  it('NFR-AVATAR-03: a stranger with no writers row cannot read or write writer_avatars, same as every other gated table', async () => {
    const { client } = db();
    const owner = await seedWriter(client, 'Lionel (avatar-stranger-owner)');
    const avatar = await seedAvatar(client, { writer_id: owner, status: 'ready' });
    const stranger = crypto.randomUUID();

    const [read, write] = await asWriter(stranger, () =>
      Promise.all([
        client.query(`select 1 from writer_avatars where id = $1`, [avatar]),
        client
          .query(
            `insert into writer_avatars (writer_id, status, original_filename) values ($1, 'processing', 'x.jpg') returning id`,
            [stranger],
          )
          .catch(() => ({ rowCount: 0 })),
      ]),
    );

    expect({ read_rows: read.rowCount, write_rows: write.rowCount }).toEqual({ read_rows: 0, write_rows: 0 });
  });

  it('NFR-AVATAR-04: a revoked writer cannot read their own former avatar row', async () => {
    const { client } = db();
    const revoked = await seedWriter(client, 'Lionel (avatar-revoked)', {
      revoked_at: '2026-01-01T00:00:00Z',
    });
    const avatar = await seedAvatar(client, { writer_id: revoked, status: 'ready' });

    const read = await asWriter(revoked, () =>
      client.query(`select 1 from writer_avatars where id = $1`, [avatar]),
    );

    expect(read.rowCount).toBe(0);
  });

  it('NFR-AVATAR-05: service_role can write writer_avatars directly — the same grant uploadAvatar.ts (src/api/repo.ts) relies on to record a new upload', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (avatar-service-role)');

    const written = await asRole('service_role', () =>
      client.query(
        `insert into writer_avatars (writer_id, status, original_filename) values ($1, 'processing', 'photo.jpg') returning writer_id`,
        [writer],
      ),
    );

    expect(written.rows).toEqual([{ writer_id: writer }]);
  });

  it('NFR-AVATAR-06: migration 0010 is idempotent — re-applying it to an already-migrated database is a no-op, not an error', async () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '0010_writer_avatars.sql'), 'utf8');

    const sqlstate = await captureSqlError(() => db().client.query(sql));

    expect(sqlstate).toBeNull();
  });
});

/**
 * L-V7-01 (`05-verification.v7.md` §6) — **AC-06's "one cover per article" is
 * unenforced at the data layer**, and the verify report recommends closing it
 * alongside §4 because they share one root cause.
 *
 * `04-green-evidence.v7.md` §6.3 claimed that with migration `0004` in place "a
 * writer can no longer put it back, so at most one row can satisfy either
 * predicate". Both verify agents found that false, independently, and the e2e
 * agent produced the strongest reproduction this gate has seen: **six
 * simultaneous `ready` cover rows on one article**, through nothing but
 * concurrent uploads. `uploadImage.ts`'s `demoteCurrentCover()` →
 * `storage.put()` → `insertImage()` sequence is not one transaction, so two
 * uploads each demote (matching nothing, the first having already vacated the
 * slot) and each insert a fresh `role='cover'` row. That is the same
 * non-atomicity as §4.2's permanent-block route.
 *
 * The recommended fix is a partial unique index:
 *
 *     create unique index on article_images (article_id) where role = 'cover'
 *
 * The point of asserting it *here*, at the database, and not only through the
 * upload race in tests/e2e/imageRecoveryRoutes.test.ts, is that
 * application-level ordering is exactly what has already failed: `publishArticle.ts`'s
 * `usableCover()` and `render.ts`'s cover query are two independent, unordered
 * picks over a state that can genuinely have several candidates, and they
 * happened to agree in every trial run rather than by guarantee. A constraint a
 * future code change cannot accidentally bypass is a different kind of promise
 * from a code path that currently behaves — which is the same reason
 * `NFR-MIGRATE-01`, `NFR-TAMPER-01` and `NFR-LOCK-GRANT-01a`/`01b` are asserted
 * at this layer rather than through a handler.
 *
 * Executed on the **owning** connection, with no `set role`: a refusal here
 * cannot be a privilege refusal (`42501`) wearing a constraint's clothes, and
 * `service_role` — which is what the upload route runs as, and therefore the
 * role that actually creates cover rows — bypasses RLS and holds every grant.
 * Only a constraint can refuse this.
 *
 * No SQLSTATE and no index name is asserted: a partial unique index (`23505`),
 * an exclusion constraint, a `check` plus trigger, or anything else that makes
 * the database itself refuse the second cover row is equally admissible.
 */
describe('cover slot uniqueness (verify v7, L-V7-01)', () => {
  it('NFR-COVER-UNIQUE-01: the database itself refuses a second role=cover row for an article that already has one, whether it arrives as a fresh insert or as the promotion of an existing body row — AC-06 is a data-layer invariant, and a non-transactional demote-then-insert in one handler has already been shown to leave six simultaneous cover rows on one article', async () => {
    const { client } = db();
    const writer = await seedWriter(client, 'Lionel (cover uniqueness)');

    /**
     * Two shapes, because one of them alone would not prove the invariant: an
     * `insert` is what the upload race produces, and an `update` is what any
     * future cover-selection route (the other fix `05-verification.v7.md` §4.3
     * offers) would perform. A constraint that catches only one leaves AC-06
     * exactly as unenforced as it is today.
     */
    const attempts: Array<{
      attempt: string;
      run: (article_id: string) => Promise<unknown>;
    }> = [
      {
        attempt: 'inserting a second cover row directly',
        run: (article_id) =>
          client.query(
            `insert into article_images (article_id, role, status, original_filename, original_url)
             values ($1, 'cover', 'ready', 'deuxieme-couverture.jpg', $2)`,
            [
              article_id,
              `https://projectref.supabase.co/storage/v1/object/articles/${article_id}/deuxieme.jpg`,
            ],
          ),
      },
      {
        attempt: 'promoting an existing body row into the cover slot',
        run: async (article_id) => {
          const body = await seedImage(client, { article_id, role: 'body', status: 'ready' });
          return client.query(`update article_images set role = 'cover' where id = $1`, [body]);
        },
      },
    ];

    const results = [];
    for (const [index, attempt] of attempts.entries()) {
      // Each attempt gets its own article, so a refusal is never explained by
      // some other attempt's leftovers.
      const article_id = await seedArticle(client, {
        writer_id: writer,
        title: `Unicité de la couverture ${index}`,
        league_name: 'Ligue 1',
        type_name: 'Pronos',
      });
      await seedImage(client, { article_id, role: 'cover', status: 'ready' });

      const sqlstate = await captureSqlError(() => attempt.run(article_id));
      const covers = await client.query(
        `select id from article_images where article_id = $1 and role = 'cover'`,
        [article_id],
      );

      results.push({
        attempt: attempt.attempt,
        refused_by_the_database: sqlstate !== null,
        cover_rows_after: covers.rowCount ?? 0,
      });
    }

    expect(results).toEqual([
      {
        attempt: 'inserting a second cover row directly',
        refused_by_the_database: true,
        cover_rows_after: 1,
      },
      {
        attempt: 'promoting an existing body row into the cover slot',
        refused_by_the_database: true,
        cover_rows_after: 1,
      },
    ]);
  });
});

describe('migration discipline', () => {
  it('NFR-MIGRATE-01: no shipped migration drops or retypes an existing column or table — rollback safety depends on expand-only', () => {
    const forbidden = /\b(drop\s+(table|column)|alter\s+column\s+\w+\s+type|rename\s+(to|column))\b/i;

    const offenders = readMigrationFiles().filter((file) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
        .replace(/--[^\n]*/g, '')
        .replace(/if exists/gi, '');
      return forbidden.test(sql);
    });

    expect(offenders).toEqual([]);
  });
});
