/**
 * Test-owned fakes for the *collaborators* of the unit under test.
 *
 * These exist so that, at red, a handler test fails for exactly one reason —
 * "the handler module does not exist" — and never because some other
 * production module it depends on is also missing. Nothing here is a mock of
 * behaviour under test: the codec runs for real in tests/unit/imageOptimize,
 * Postgres runs for real in tests/db, Prism/Schemathesis run for real in
 * tests/contract.
 */

import type {
  ArticleRecord,
  CreateDraftDeps,
  ImageRecord,
  ImageStatusDeps,
  ImageStatusRow,
  ObservabilityRecord,
  OptimizeResult,
  PublishDeps,
  RevalidationOutcome,
  TelemetryEvent,
  TelemetrySink,
  UploadDeps,
  WriterId,
} from './seams.js';
import { ARTICLE_ID, WRITER_A_NAME, WRITER_B, WRITER_B_NAME } from './fixtures.js';

export function fakeSink(): TelemetrySink {
  const events: TelemetryEvent[] = [];
  return {
    events,
    emit(event: TelemetryEvent) {
      events.push(event);
    },
  };
}

export const eventTypes = (sink: TelemetrySink): string[] => sink.events.map((e) => e.event_type);

export const eventsOfType = (events: TelemetryEvent[], type: string): TelemetryEvent[] =>
  events.filter((e) => e.event_type === type);

/** Counting rate limiter with an explicit, test-supplied threshold. */
export function fakeRateLimiter(max_requests: number) {
  const hits = new Map<string, number>();
  return {
    check(key: string) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { allowed: n <= max_requests, limit: max_requests };
    },
  };
}

export function fakeIdempotencyStore() {
  const store = new Map<string, { status: number; body: Record<string, unknown> }>();
  return {
    lookup: (key: string, article_id: string) => store.get(`${key}::${article_id}`) ?? null,
    store: (key: string, article_id: string, response: { status: number; body: Record<string, unknown> }) =>
      void store.set(`${key}::${article_id}`, response),
  };
}

export function fakeAuth(opts: { valid: boolean; writer_id?: WriterId; display_name?: string }) {
  return {
    verifyBearer: async (token: string | null) =>
      opts.valid && token
        ? {
            valid: true,
            writer_id: opts.writer_id ?? WRITER_B,
            display_name: opts.display_name ?? WRITER_B_NAME,
          }
        : { valid: false },
  };
}

export function fakeObservability() {
  const records: ObservabilityRecord[] = [];
  return {
    records,
    sink: { record: (entry: ObservabilityRecord) => void records.push(entry) },
  };
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export type PublishDepsOverrides = {
  now?: Date;
  article?: ArticleRecord | null;
  images?: ImageRecord[];
  authValid?: boolean;
  writer_id?: WriterId;
  display_name?: string;
  rateLimit?: number;
  revalidation?: RevalidationOutcome;
  sink?: TelemetrySink;
  firstPublishedAt?: Date;
};

export type BuiltPublishDeps = {
  deps: PublishDeps;
  sink: TelemetrySink;
  observed: ObservabilityRecord[];
  published: Array<Record<string, unknown>>;
  revalidatedPaths: string[][];
};

export function buildPublishDeps(o: PublishDepsOverrides = {}): BuiltPublishDeps {
  const sink = o.sink ?? fakeSink();
  const obs = fakeObservability();
  const published: Array<Record<string, unknown>> = [];
  const revalidatedPaths: string[][] = [];
  const now = o.now ?? new Date('2026-08-11T10:47:12Z');
  const article = o.article === undefined ? null : o.article;

  const deps: PublishDeps = {
    now: () => now,
    auth: fakeAuth({
      valid: o.authValid ?? true,
      writer_id: o.writer_id,
      display_name: o.display_name,
    }),
    repo: {
      getArticle: async (article_id: string) =>
        article && article.id === article_id ? article : null,
      getArticleImages: async () => o.images ?? [],
      markPublished: async (input) => {
        published.push({ ...input });
        return {
          first_published_at:
            o.firstPublishedAt ?? article?.first_published_at ?? input.published_at,
        };
      },
      getWriterDisplayName: async () => o.display_name ?? WRITER_B_NAME,
      // Additive, for M-V5-05: publishing has to know which slugs are already
      // taken before it can honour AC-14's "collision-free, with no writer
      // action". Nothing is taken in these fakes, so every pre-existing
      // expectation about the slug a publish produces is unchanged; the real
      // collision is proved end-to-end, against the real `unique` index
      // (AC-14-collision-01).
      takenSlugs: async () => [],
    },
    telemetry: sink,
    rateLimiter: fakeRateLimiter(o.rateLimit ?? 1_000_000),
    idempotency: fakeIdempotencyStore(),
    revalidation: {
      revalidate: async (paths: string[]) => {
        revalidatedPaths.push(paths);
        return o.revalidation ?? { ok: true };
      },
    },
    observability: obs.sink,
  };

  return { deps, sink, observed: obs.records, published, revalidatedPaths };
}

// ---------------------------------------------------------------------------
// image upload
// ---------------------------------------------------------------------------

export type UploadDepsOverrides = {
  now?: Date;
  article?: ArticleRecord | null;
  images?: ImageRecord[];
  authValid?: boolean;
  optimizeResult?: OptimizeResult;
  previousCoverId?: string | null;
  rateLimit?: number;
  /** M-V4-02: whose name a `409 DRAFT_LOCKED` from upload would carry. */
  display_name?: string;
};

export type BuiltUploadDeps = {
  deps: UploadDeps;
  observed: ObservabilityRecord[];
  inserted: Array<Record<string, unknown>>;
  stored: Array<{ key: string; byte_size: number }>;
  demoteCalls: number;
  /** How many times the codec was invoked — NFR-UPLOAD-01 asserts it stays 0. */
  optimizeCalls: number;
};

export function buildUploadDeps(o: UploadDepsOverrides = {}): BuiltUploadDeps {
  const obs = fakeObservability();
  const inserted: Array<Record<string, unknown>> = [];
  const stored: Array<{ key: string; byte_size: number }> = [];
  const state = { demoteCalls: 0, optimizeCalls: 0 };
  const now = o.now ?? new Date('2026-08-11T10:20:00Z');
  const article = o.article === undefined ? null : o.article;

  const deps: UploadDeps = {
    now: () => now,
    auth: fakeAuth({ valid: o.authValid ?? true }),
    repo: {
      getArticle: async (article_id: string) =>
        article && article.id === article_id ? article : null,
      getArticleImages: async () => o.images ?? [],
      insertImage: async (input) => {
        inserted.push({ ...input });
        return { id: `img-${inserted.length}`, created_at: now };
      },
      demoteCurrentCover: async () => {
        state.demoteCalls += 1;
        return o.previousCoverId ?? null;
      },
      // Additive, for M-V4-02: publish's `409 DRAFT_LOCKED` envelope names the
      // writer holding the lock, and upload is required to answer with the same
      // shape. Present so a fix that mirrors `publishArticle.ts` exactly runs
      // against this fake instead of tripping over a missing collaborator; no
      // pre-existing test calls it.
      getWriterDisplayName: async () => o.display_name ?? WRITER_A_NAME,
    },
    storage: {
      put: async (key: string, bytes: Uint8Array) => {
        stored.push({ key, byte_size: bytes.byteLength });
        return { url: `https://cdn.fantasycoach.example/articles/${ARTICLE_ID}/${key}` };
      },
    },
    optimizer: {
      optimize: async (bytes: Uint8Array) => {
        state.optimizeCalls += 1;
        return (
          o.optimizeResult ?? {
          ok: true,
            format: 'webp',
            bytes: bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 40))),
            byte_size: Math.max(1, Math.floor(bytes.byteLength / 40)),
            original_byte_size: bytes.byteLength,
          }
        );
      },
    },
    rateLimiter: fakeRateLimiter(o.rateLimit ?? 1_000_000),
    idempotency: fakeIdempotencyStore(),
    observability: obs.sink,
  };

  return {
    deps,
    observed: obs.records,
    inserted,
    stored,
    get demoteCalls() {
      return state.demoteCalls;
    },
    get optimizeCalls() {
      return state.optimizeCalls;
    },
  } as BuiltUploadDeps;
}

// ---------------------------------------------------------------------------
// draft creation
// ---------------------------------------------------------------------------

export type BuiltDraftDeps = {
  deps: CreateDraftDeps;
  sink: TelemetrySink;
  insertedDrafts: number;
};

export function buildCreateDraftDeps(
  o: {
    now?: Date;
    authValid?: boolean;
    writer_id?: WriterId;
    article?: ArticleRecord | null;
    lockTaken?: boolean;
  } = {},
): BuiltDraftDeps {
  const sink = fakeSink();
  const state = { insertedDrafts: 0 };
  const now = o.now ?? new Date('2026-08-11T10:00:00Z');
  const article = o.article === undefined ? null : o.article;

  const deps: CreateDraftDeps = {
    now: () => now,
    auth: fakeAuth({ valid: o.authValid ?? true, writer_id: o.writer_id }),
    repo: {
      insertDraft: async () => {
        state.insertedDrafts += 1;
        return { id: ARTICLE_ID };
      },
      getArticle: async (article_id: string) =>
        article && article.id === article_id ? article : null,
      takeLock: async () => o.lockTaken ?? true,
    },
    telemetry: sink,
  };

  return {
    deps,
    sink,
    get insertedDrafts() {
      return state.insertedDrafts;
    },
  } as BuiltDraftDeps;
}

// ---------------------------------------------------------------------------
// image status callback (ADR-0004) — Lambda -> Arsène
// ---------------------------------------------------------------------------

export type BuiltImageStatusDeps = {
  deps: ImageStatusDeps;
  observed: ObservabilityRecord[];
  /** Every accepted write, so a rejected callback can be shown to write nothing. */
  updates: Array<{
    image_id: string;
    status: 'ready' | 'failed';
    optimized_url: string | null;
    failure: { code: string; message: string } | null;
  }>;
};

export const IMAGE_CALLBACK_SECRET = 'lambda-callback-shared-secret-not-the-writer-token';

export function buildImageStatusDeps(
  o: { row?: ImageStatusRow | null; callbackSecret?: string } = {},
): BuiltImageStatusDeps {
  const obs = fakeObservability();
  const updates: BuiltImageStatusDeps['updates'] = [];
  const row = o.row === undefined ? null : o.row;

  const deps: ImageStatusDeps = {
    callbackSecret: o.callbackSecret ?? IMAGE_CALLBACK_SECRET,
    repo: {
      getImage: async (image_id: string) => (row && row.id === image_id ? row : null),
      setImageStatus: async (input) => {
        // The compare-and-swap the real repo performs: only a `processing`
        // row moves. A fake that always succeeds would hide the bug.
        if (row === null || row.id !== input.image_id || row.status !== 'processing') return false;
        updates.push({ ...input });
        return true;
      },
    },
    observability: obs.sink,
  };

  return { deps, observed: obs.records, updates };
}
