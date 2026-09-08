/**
 * SEAMS — the single place that names every production module this test suite
 * expects to exist, at the paths implied by 02-architecture.v1.md §1
 * "Testability assessment".
 *
 * NONE of these modules exist yet. That is the point of the red gate: each
 * loader below is called lazily from inside a test body, so a missing module
 * fails exactly one test with exactly one reason
 * ("Failed to load url ../../src/domain/paste ... Does the file exist?")
 * rather than collapsing a whole file at collection time.
 *
 * Rules for this file:
 *   - every import specifier is a static string literal (so Vite resolves it
 *     lazily and reports the real path in the failure message);
 *   - every import happens inside a function, never at module top level;
 *   - the interfaces below are the test suite's *expectation* of each seam's
 *     signature. They are test-side type declarations, not implementations.
 *
 * Module map (documented in pdlc/arsene-cms/traceability.md):
 *   src/domain/paste.ts          pure paste sanitizer (raw HTML in, safe HTML out)
 *   src/domain/seo.ts            slug / meta / JSON-LD / sitemap / alt text / advisory
 *   src/domain/lock.ts           staleness-based draft locking, injectable `now`
 *   src/domain/autosave.ts       autosave tick + crash recovery, injectable `now`
 *   src/domain/taxonomy.ts       league > type resolution and creation
 *   src/domain/pronosEntry.ts    structured pronos/picks entry validation
 *   src/images/optimize.ts       real WebP/AVIF codec + size guard
 *   src/api/createDraft.ts       draft creation/open handler (draft_started)
 *   src/api/publishArticle.ts    POST /v1/articles/{id}/publish handler
 *   src/api/uploadImage.ts       POST /v1/articles/{id}/images handler
 *   src/api/rateLimit.ts         mutating-endpoint rate limiter
 *   src/api/client.ts            typed editor-SPA client (contract consumer side)
 *   src/api/server.ts            Edge Function entrypoint (contract provider side)
 *   src/client/fixturePicker.ts  pronos fixture picker (consumer of pronos' API)
 *   src/site/render.ts           public-site render pass (ISR page/JSON-LD/sitemap)
 *   src/telemetry/events.ts      telemetry event construction + sink
 *   db/migrations/*.sql          production migrations (expand-only, ADR-0001 §6)
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type WriterId = string;

/**
 * One `arsene_telemetry_events` row. Spec §4 fixes the two event types and their
 * fields; `writer_id`/`article_id` are promoted to columns because the
 * time-to-publish metric joins on `article_id`.
 */
export type TelemetryEvent = {
  event_type: 'draft_started' | 'article_published' | string;
  writer_id: WriterId;
  article_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type TelemetrySink = {
  emit(event: TelemetryEvent): void;
  events: TelemetryEvent[];
};

export type ImageRole = 'cover' | 'body';
export type ImageStatus = 'processing' | 'ready' | 'failed';

export type ImageRecord = {
  id: string;
  article_id: string;
  role: ImageRole;
  status: ImageStatus;
  alt_text: string | null;
  /**
   * The CDN URL of the converted asset. Added by the remediation pass:
   * 05-verification.v1.md §6.4 found the publish response fabricating this
   * value from `article.id` instead of reading the real stored one.
   */
  optimized_url?: string | null;
};

export type ConfidenceTier = 'Indispensable' | 'Prudent' | 'Risqué';

export type PronosEntryInput = {
  home_team: string;
  away_team: string;
  predicted_home_score: number;
  predicted_away_score: number;
  confidence_tier: string;
  /** ADR-0002: optional, nullable snapshot of a pronos fixture. Never a FK. */
  pronos_league_id?: string | null;
  pronos_game_id?: string | null;
  match_kickoff_at?: string | null;
};

export type PronosEntry = {
  home_team: string;
  away_team: string;
  predicted_home_score: number;
  predicted_away_score: number;
  confidence_tier: ConfidenceTier;
  pronos_league_id: string | null;
  pronos_game_id: string | null;
  match_kickoff_at: string | null;
};

export type FieldError = { field: string; message: string };

export type ArticleRecord = {
  id: string;
  writer_id: WriterId;
  title: string;
  body_html: string;
  league_name: string;
  type_name: string;
  slug: string | null;
  meta_title: string | null;
  meta_description: string | null;
  first_published_at: Date | null;
  /** ADR-0003 locking columns. */
  locked_by: WriterId | null;
  locked_at: Date | null;
  pronos_entries: PronosEntryInput[];
};

// ---------------------------------------------------------------------------
// src/domain/paste.ts  — AC-03
// ---------------------------------------------------------------------------

export interface PasteModule {
  /**
   * Raw clipboard HTML from Word/Google Docs in, article HTML out. Pure:
   * no DOM globals, no network, no DB (02-architecture.v1.md §1).
   */
  sanitizePastedHtml(rawHtml: string, opts: { allowedImageOrigin: string }): string;
}

export async function loadPaste(): Promise<PasteModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/paste')) as unknown as PasteModule;
}

// ---------------------------------------------------------------------------
// src/domain/seo.ts  — AC-13, AC-14, AC-15, AC-16
// ---------------------------------------------------------------------------

export type MetaSuggestion = { meta_title: string; meta_description: string };

export type ArticleSeoContext = {
  title: string;
  body_text: string;
  league_name: string;
  type_name: string;
};

export type PublishedArticleView = {
  article_id: string;
  title: string;
  slug: string;
  league_name: string;
  type_name: string;
  writer_display_name: string;
  cover_image_url: string;
  published_at: string;
  first_published_at: string;
};

export type Advisory = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** Always false — spec §9: advisory checks never block publishing. */
  blocks_publish: boolean;
};

export interface SeoModule {
  /** AC-14: URL-safe, collision-free slug, generated with no writer action. */
  generateSlug(title: string, opts?: { existingSlugs?: readonly string[] }): string;
  /** AC-13: pre-filled suggestion the writer may edit before confirming. */
  suggestMeta(article: ArticleSeoContext): MetaSuggestion;
  /** Aug–Jul football-season slug (e.g. "26-27") a date falls in, UTC. */
  seasonSlug(date: Date): string;
  /** The public path a league/season/type listing is served at. */
  categoryPath(category: { league_name: string; type_name: string; first_published_at: string }): string;
  /** The public path an article is served at, under its listing's path. */
  articlePath(article: {
    league_name: string;
    type_name: string;
    first_published_at: string;
    slug: string;
  }): string;
  /** AC-14: schema.org JSON-LD embedded in the published page. */
  buildStructuredData(article: PublishedArticleView, origin?: string): Record<string, unknown>;
  /** AC-14: the article's sitemap entry. */
  buildSitemapEntry(article: PublishedArticleView): { loc: string; lastmod: string };
  /** AC-15: alt text derived from the article's own context. */
  generateAltText(ctx: {
    article_title: string;
    body_text: string;
    original_filename: string;
  }): string;
  /** AC-16: SEO/AEO/GEO advisory check — informational only. */
  runContentCheck(article: ArticleSeoContext): Advisory[];
}

export async function loadSeo(): Promise<SeoModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/seo')) as unknown as SeoModule;
}

// ---------------------------------------------------------------------------
// src/domain/lock.ts  — AC-05, ADR-0003
// ---------------------------------------------------------------------------

export type LockState = {
  locked_by: WriterId | null;
  locked_at: Date | null;
  locked_by_display_name: string | null;
};

export type LockDecision =
  | { editable: true }
  | {
      editable: false;
      locked_by_writer_id: WriterId;
      locked_by_display_name: string;
    };

export interface LockModule {
  /** ADR-0003: heartbeat write cadence, ~20s. */
  HEARTBEAT_INTERVAL_MS: number;
  /** ADR-0003: 60–90s staleness window; this suite assumes 90_000 (see traceability §6). */
  LOCK_STALENESS_MS: number;
  /** True when `now - locked_at` exceeds the staleness threshold. */
  isLockStale(now: Date, lockedAt: Date): boolean;
  /** Whole-article lock decision for one writer opening one draft. */
  evaluateLock(input: {
    now: Date;
    lock: LockState;
    requesting_writer_id: WriterId;
  }): LockDecision;
}

export async function loadLock(): Promise<LockModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/lock')) as unknown as LockModule;
}

// ---------------------------------------------------------------------------
// src/domain/autosave.ts  — AC-01, AC-02
// ---------------------------------------------------------------------------

export type AutosaveDecision = {
  save: boolean;
  /**
   * AC-01's "Last saved at [time]" indicator, formatted `Last saved at HH:MM`
   * in UTC (see tests/unit/draft.test.ts); null when nothing has been saved yet.
   */
  indicator: string | null;
};

export type DraftSnapshot = {
  article_id: string;
  body_html: string;
  saved_at: Date;
};

export interface AutosaveModule {
  AUTOSAVE_INTERVAL_MS: number;
  /** Injected clock — no wall-clock reads (02-architecture.v1.md §1). */
  evaluateAutosave(input: {
    now: Date;
    dirty: boolean;
    last_edit_at: Date;
    last_saved_at: Date | null;
  }): AutosaveDecision;
  /** AC-02: what the editor shows when a crashed draft is reopened. */
  restoreDraft(snapshots: DraftSnapshot[]): DraftSnapshot | null;
}

export async function loadAutosave(): Promise<AutosaveModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/autosave')) as unknown as AutosaveModule;
}

// ---------------------------------------------------------------------------
// src/domain/taxonomy.ts  — AC-10, 01-decisions.md #2
// ---------------------------------------------------------------------------

export type TaxonomyNode = { id: string | null; name: string; parent_id: string | null };

export type TaxonomyResolution = {
  league: { name: string; created: boolean };
  type: { name: string; created: boolean; parent_name: string };
  path: string[];
};

export interface TaxonomyModule {
  /**
   * AC-10: resolve "Serie A > Team Presentations", creating whichever level is
   * missing, nested league-then-type, with no approval step.
   * 01-decisions.md #2: no automatic de-duplication or merging of
   * near-duplicate names.
   */
  resolveCategoryPath(input: {
    league_name: string;
    type_name: string;
    existing: TaxonomyNode[];
  }): TaxonomyResolution;
}

export async function loadTaxonomy(): Promise<TaxonomyModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/taxonomy')) as unknown as TaxonomyModule;
}

// ---------------------------------------------------------------------------
// src/domain/pronosEntry.ts  — AC-04, ADR-0002
// ---------------------------------------------------------------------------

export type PronosEntryResult =
  | { ok: true; entry: PronosEntry }
  | { ok: false; errors: FieldError[] };

export interface PronosEntryModule {
  CONFIDENCE_TIERS: readonly ConfidenceTier[];
  /** Structured storage, never free text (AC-04). */
  buildPronosEntry(input: PronosEntryInput): PronosEntryResult;
}

export async function loadPronosEntry(): Promise<PronosEntryModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/pronosEntry')) as unknown as PronosEntryModule;
}

// ---------------------------------------------------------------------------
// src/images/optimize.ts  — AC-07, AC-08, NFR-UPLOAD-01
// ---------------------------------------------------------------------------

export type OptimizeSuccess = {
  ok: true;
  format: 'webp' | 'avif';
  bytes: Uint8Array;
  byte_size: number;
  original_byte_size: number;
};

export type OptimizeFailure = {
  ok: false;
  code: 'UNSUPPORTED_FORMAT' | 'CORRUPTED_FILE' | 'FILE_TOO_LARGE' | 'PROCESSING_TIMEOUT';
  message: string;
};

export type OptimizeResult = OptimizeSuccess | OptimizeFailure;

export interface ImageOptimizeModule {
  /** contracts/openapi.yaml `413 FILE_TOO_LARGE`: 20 MB. */
  MAX_UPLOAD_BYTES: number;
  /**
   * Runs the real codec (02-architecture.v1.md §1: "run the actual WASM codec
   * against fixture files — no mocking").
   */
  optimizeImage(
    bytes: Uint8Array,
    meta: { filename: string; declared_content_type: string },
  ): Promise<OptimizeResult>;
}

export async function loadImageOptimize(): Promise<ImageOptimizeModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/images/optimize')) as unknown as ImageOptimizeModule;
}

// ---------------------------------------------------------------------------
// src/api/createDraft.ts  — AC-01, AC-05, draft_started
// ---------------------------------------------------------------------------

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
    ): Promise<{ valid: boolean; writer_id?: WriterId; display_name?: string }>;
  };
  repo: {
    insertDraft(input: { writer_id: WriterId; title: string }): Promise<{ id: string }>;
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    takeLock(input: { article_id: string; writer_id: WriterId; now: Date }): Promise<boolean>;
  };
  telemetry: TelemetrySink;
};

export interface CreateDraftModule {
  handleCreateDraft(
    req: CreateDraftRequest,
    deps: CreateDraftDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Reopening an existing draft — never a second `draft_started`. */
  handleOpenDraft(
    req: OpenDraftRequest,
    deps: CreateDraftDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function loadCreateDraft(): Promise<CreateDraftModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/createDraft')) as unknown as CreateDraftModule;
}

// ---------------------------------------------------------------------------
// src/api/publishArticle.ts  — POST /v1/articles/{articleId}/publish
// ---------------------------------------------------------------------------

export type PublishHttpRequest = {
  article_id: string;
  authorization: string | null;
  idempotency_key: string | null;
  client_ip: string;
  body: { meta_title?: string; meta_description?: string };
};

export type RevalidationOutcome = { ok: boolean; error?: string };

export type ObservabilityRecord = {
  event: string;
  outcome: 'success' | 'failure';
  details?: Record<string, unknown>;
};

export type PublishDeps = {
  now(): Date;
  cdnOrigin: string;
  auth: {
    verifyBearer(
      token: string | null,
    ): Promise<{ valid: boolean; writer_id?: WriterId; display_name?: string }>;
  };
  repo: {
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    getArticleImages(article_id: string): Promise<ImageRecord[]>;
    markPublished(input: {
      article_id: string;
      writer_id: WriterId;
      published_at: Date;
      slug: string;
      meta_title: string;
      meta_description: string;
      structured_data: Record<string, unknown>;
    }): Promise<{ first_published_at: Date }>;
    getWriterDisplayName(writer_id: WriterId): Promise<string>;
    /**
     * M-V5-05 (`05-verification.v5.md` §5), sixth remediation pass: AC-14's
     * collision-free slug needs the slugs already taken, which only the
     * database knows. Optional, so every pre-existing caller of this seam is
     * unchanged, and so a fix that resolves the collision another way (mapping
     * the `23505` and retrying, say) is equally admissible.
     */
    takenSlugs?(base_slug: string): Promise<string[]>;
  };
  telemetry: TelemetrySink;
  rateLimiter: { check(key: string, now: Date): { allowed: boolean; limit: number } };
  idempotency: {
    lookup(key: string, article_id: string): { status: number; body: Record<string, unknown> } | null;
    store(key: string, article_id: string, response: { status: number; body: Record<string, unknown> }): void;
  };
  /** On-demand ISR revalidation of the article, its category and the homepage. */
  revalidation: { revalidate(paths: string[]): Promise<RevalidationOutcome> };
  /** 02-architecture.v1.md §8: revalidation outcome must be recorded, not just fired. */
  observability: { record(entry: ObservabilityRecord): void };
};

export interface PublishArticleModule {
  handlePublishArticle(
    req: PublishHttpRequest,
    deps: PublishDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function loadPublishArticle(): Promise<PublishArticleModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/publishArticle')) as unknown as PublishArticleModule;
}

// ---------------------------------------------------------------------------
// src/api/uploadImage.ts  — POST /v1/articles/{articleId}/images
// ---------------------------------------------------------------------------

export type UploadImageRequest = {
  article_id: string;
  authorization: string | null;
  idempotency_key: string | null;
  client_ip: string;
  role: ImageRole;
  file: { filename: string; content_type: string; bytes: Uint8Array };
};

export type UploadDeps = {
  now(): Date;
  auth: {
    verifyBearer(
      token: string | null,
    ): Promise<{ valid: boolean; writer_id?: WriterId; display_name?: string }>;
  };
  repo: {
    getArticle(article_id: string): Promise<ArticleRecord | null>;
    getArticleImages(article_id: string): Promise<ImageRecord[]>;
    insertImage(input: {
      article_id: string;
      role: ImageRole;
      status: ImageStatus;
      original_filename: string;
      alt_text: string | null;
      urls: { original: string; optimized: string } | null;
      replaced_cover_image_id: string | null;
    }): Promise<{ id: string; created_at: Date }>;
    demoteCurrentCover(article_id: string): Promise<string | null>;
    /**
     * M-V4-02 (`05-verification.v4.md` §6), fifth remediation pass: upload has
     * to answer the draft lock the way publish already does, and publish's
     * `409 DRAFT_LOCKED` envelope names the writer holding it. Optional, so
     * every pre-existing caller of this seam is unchanged, and so a fix that
     * builds the envelope from `article.locked_by` alone is equally admissible.
     */
    getWriterDisplayName?(writer_id: WriterId): Promise<string>;
  };
  storage: { put(key: string, bytes: Uint8Array): Promise<{ url: string }> };
  optimizer: {
    optimize(
      bytes: Uint8Array,
      meta: { filename: string; declared_content_type: string },
    ): Promise<OptimizeResult>;
  };
  rateLimiter: { check(key: string, now: Date): { allowed: boolean; limit: number } };
  idempotency: {
    lookup(key: string, article_id: string): { status: number; body: Record<string, unknown> } | null;
    store(key: string, article_id: string, response: { status: number; body: Record<string, unknown> }): void;
  };
  observability: { record(entry: ObservabilityRecord): void };
};

export interface UploadImageModule {
  handleUploadImage(
    req: UploadImageRequest,
    deps: UploadDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function loadUploadImage(): Promise<UploadImageModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/uploadImage')) as unknown as UploadImageModule;
}

// ---------------------------------------------------------------------------
// src/api/rateLimit.ts  — NFR-RATE-01
// ---------------------------------------------------------------------------

export interface RateLimitModule {
  /**
   * NFR-RATE-01. 02-architecture.v1.md §7 says "rate limiting on `publish`,
   * mirroring pronos' existing 10 req/min per IP precedent" — 10 is therefore
   * the assumed value here (see traceability.md §6).
   */
  PUBLISH_RATE_LIMIT_PER_MINUTE: number;
  createRateLimiter(opts: { max_requests: number; window_ms: number }): {
    check(key: string, now: Date): { allowed: boolean; limit: number };
  };
}

export async function loadRateLimit(): Promise<RateLimitModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/rateLimit')) as unknown as RateLimitModule;
}

// ---------------------------------------------------------------------------
// src/telemetry/events.ts  — spec §4
// ---------------------------------------------------------------------------

export interface TelemetryModule {
  REQUIRED_EVENT_TYPES: readonly string[];
  /**
   * Builds one arsene_telemetry_events row. Must reject an unknown event_type and
   * must reject a payload missing any field spec §4 requires.
   */
  buildTelemetryEvent(event_type: string, fields: Record<string, unknown>): TelemetryEvent;
  createTelemetrySink(): TelemetrySink;
}

export async function loadTelemetry(): Promise<TelemetryModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/telemetry/events')) as unknown as TelemetryModule;
}

// ---------------------------------------------------------------------------
// src/api/client.ts  (consumer side of Arsène's own OpenAPI contract)
// ---------------------------------------------------------------------------

export type ArseneClient = {
  publishArticle(args: {
    articleId: string;
    meta_title?: string;
    meta_description?: string;
    idempotencyKey?: string;
  }): Promise<unknown>;
  uploadArticleImage(args: {
    articleId: string;
    idempotencyKey: string;
    role: ImageRole;
    file: { filename: string; content_type: string; bytes: Uint8Array };
  }): Promise<unknown>;
  createDraft(args?: { title?: string; league_name?: string; type_name?: string }): Promise<unknown>;
  openDraft(args: { articleId: string }): Promise<unknown>;
};

export type ArseneApiError = Error & { code: string; status: number };

export interface ApiClientModule {
  createArseneClient(opts: {
    baseUrl: string;
    bearerToken?: string;
    headers?: Record<string, string>;
  }): ArseneClient;
}

export async function loadApiClient(): Promise<ApiClientModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/client')) as unknown as ApiClientModule;
}

// ---------------------------------------------------------------------------
// src/api/server.ts  (provider side of Arsène's own OpenAPI contract)
// ---------------------------------------------------------------------------

export interface ApiServerModule {
  /** Boots the Edge Function router over a real HTTP port for provider/e2e tests. */
  startServer(opts: {
    port: number;
    databaseUrl: string;
    writerToken: string;
    writerId: string;
    /** Verify finding #3, second pass: must genuinely reach the spawned child. */
    jwksUrl?: string;
    /** The test-only, no-network JWKS path — see `RouterOptions.jwksJson`. */
    jwksJson?: string;
    imageCallbackSecret?: string;
    /**
     * M-V3-04 (`05-verification.v3.md` §6), sixth remediation pass: the CDN
     * origin inbound `optimized_url` values are validated against is a
     * compile-time `.example` placeholder in `router.ts`, not configuration, so
     * no real deployment's Lambda callback can ever be accepted. Declared here
     * the same way `jwtSecret`/`imageCallbackSecret` are, and **optional**, so
     * every existing caller of this seam is unchanged and a fix that reads
     * `process.env.CDN_ORIGIN` instead of taking an option is equally
     * admissible (tests/e2e/cdnOriginConfig.test.ts supplies both).
     */
    cdnOrigin?: string;
    /**
     * M3 (05-verification.v2.md, third pass): running with no JWT secret at
     * all is a legitimate, documented mode (`router.ts`'s `verify()` comment,
     * and the pre-JWT end-to-end suite below), but it must be *chosen*, never
     * arrived at by a secret quietly going missing. This flag is that explicit
     * choice; `server.ts` forwards it to the child as
     * `ALLOW_LEGACY_STATIC_AUTH=true`. See tests/e2e/failClosedConfig.test.ts
     * for the full statement of the mechanism.
     */
    allowLegacyAuth?: boolean;
  }): Promise<{ url: string; stop(): Promise<void> }>;
}

export async function loadApiServer(): Promise<ApiServerModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/server')) as unknown as ApiServerModule;
}

// ---------------------------------------------------------------------------
// src/client/fixturePicker.ts  (consumer of pronos' contract — ADR-0002)
// ---------------------------------------------------------------------------

export type FixtureRow = {
  gameId: string;
  homeTeamName: string;
  awayTeamName: string;
  kickoffAt: string;
};

export type FixturePickerState =
  | { mode: 'picker'; rows: FixtureRow[]; raw: unknown }
  | { mode: 'manual-entry'; reason: string };

export interface FixturePickerModule {
  createFixturePicker(opts: {
    baseUrl: string;
    headers?: Record<string, string>;
  }): {
    listFixtures(args: { leagueId: string }): Promise<FixturePickerState>;
  };
}

export async function loadFixturePicker(): Promise<FixturePickerModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/client/fixturePicker')) as unknown as FixturePickerModule;
}

// ---------------------------------------------------------------------------
// src/site/render.ts  (public Next.js/ISR render pass, seeded-DB testable)
// ---------------------------------------------------------------------------

export type RenderedPage = {
  html: string;
  /** Parsed JSON-LD blocks found in the page, in document order. */
  json_ld: Array<Record<string, unknown>>;
};

export interface SiteRenderModule {
  createSiteRenderer(opts: { databaseUrl: string; siteOrigin: string; cdnOrigin: string }): Promise<{
    renderHomepage(): Promise<RenderedPage>;
    renderNotFound(): Promise<RenderedPage>;
    renderCategoryPage(args: { league_slug: string; season_slug: string; type_slug: string }): Promise<RenderedPage>;
    /** `null` when `league_slug` doesn't match a real league at all. */
    renderLeaguePage(args: { league_slug: string }): Promise<RenderedPage | null>;
    renderArticlePage(args: {
      league_slug: string;
      season_slug: string;
      type_slug: string;
      slug: string;
    }): Promise<RenderedPage>;
    /** Bare-slug lookup for the legacy-URL redirect — no prefix to check. */
    resolvePublishedPath(args: { slug: string }): Promise<string | null>;
    renderSitemap(): Promise<string>;
    close(): Promise<void>;
  }>;
}

export async function loadSiteRender(): Promise<SiteRenderModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/site/render')) as unknown as SiteRenderModule;
}

// ===========================================================================
// Remediation pass (05-verification.v1.md) — seams added for findings #1-#5.
//
// Same rules as above: lazy, string-literal imports inside functions, so a
// module that does not exist yet fails exactly one test with exactly one
// reason. None of the modules below exist at the time these tests were
// written; that is what makes this a red gate rather than a regression run.
// ===========================================================================

// ---------------------------------------------------------------------------
// src/api/auth.ts — verify finding #3 (real Supabase JWT verification)
// ---------------------------------------------------------------------------

/**
 * Where `src/api/auth.ts` is expected to live. Read as text by
 * NFR-TIMING-01, which is a code-presence check (a constant-time comparison
 * is not observable from a unit test's timings).
 */
export const AUTH_MODULE_PATH = 'src/api/auth.ts';

export type JwtVerification = {
  valid: boolean;
  /** Derived from the token's `sub` claim, never from a process-wide constant. */
  writer_id?: WriterId;
  /** Why a token was refused — for logs, never for the client. */
  reason?: string;
};

export interface AuthModule {
  /**
   * Verifies a Supabase Auth access token: ES256/RS256, signed with a key
   * from the project's JWKS (Signing Keys — CORS-01, superseding the legacy
   * shared HS256 secret), `sub` -> `writer_id`, `exp` honoured against the
   * injected clock (02-architecture.v1.md §10).
   */
  verifySupabaseJwt(
    token: string | null,
    opts: {
      jwks: import('jose').JWTVerifyGetKey;
      now: Date;
      /**
       * L-V3-02 (`05-verification.v3.md` §6), fourth remediation pass: the
       * Supabase project's own token issuer — `https://<ref>.supabase.co/auth/v1`
       * — which the verifier must pin `iss` to. Project-specific, so it is
       * configuration rather than a constant; optional so the six existing
       * `NFR-JWT-*` cases keep calling this seam unchanged. `aud` and `role`
       * need no option: Supabase always issues `authenticated` for both, so
       * those are fixed expectations, not configuration.
       */
      issuer?: string;
    },
  ): Promise<JwtVerification>;
  /** Constant-time comparison for the Lambda status-callback shared secret. */
  verifySharedSecret(provided: string | null, expected: string): boolean;
}

export async function loadAuth(): Promise<AuthModule> {
  // @ts-ignore -- production module does not exist yet (red gate, remediation)
  return (await import('../../src/api/auth')) as unknown as AuthModule;
}

// ---------------------------------------------------------------------------
// src/images/lambdaHandler.ts — ADR-0004 (real `sharp`, in AWS Lambda's Node)
// ---------------------------------------------------------------------------

export interface ImageLambdaModule {
  /**
   * The whole optimisation step, moved out of the request path: image bytes
   * in, WebP/AVIF bytes out, or a failure reason. Same `OptimizeResult` shape
   * the Edge Function used to return, so `article_images` and the contract are
   * unchanged (ADR-0004, "Neutral / accepted").
   */
  optimizeImageBuffer(
    bytes: Uint8Array,
    meta: { filename: string; declared_content_type: string },
  ): Promise<OptimizeResult>;
}

export async function loadImageLambda(): Promise<ImageLambdaModule> {
  // @ts-ignore -- production module does not exist yet (red gate, remediation)
  return (await import('../../src/images/lambdaHandler')) as unknown as ImageLambdaModule;
}

// ---------------------------------------------------------------------------
// src/api/imageStatus.ts — ADR-0004's Lambda -> Arsène status callback
// ---------------------------------------------------------------------------

export type ImageStatusRow = {
  id: string;
  article_id: string;
  role: ImageRole;
  status: ImageStatus;
};

export type ImageStatusCallbackRequest = {
  image_id: string;
  /** The `x-arsene-image-callback-secret` header, NOT a writer bearer token. */
  callback_secret: string | null;
  body: {
    status: 'ready' | 'failed';
    optimized_url?: string | null;
    failure?: { code: string; message: string } | null;
  };
};

export type ImageStatusDeps = {
  /** ADR-0004: distinct from `WRITER_TOKEN`, rotatable independently. */
  callbackSecret: string;
  repo: {
    getImage(image_id: string): Promise<ImageStatusRow | null>;
    setImageStatus(input: {
      image_id: string;
      status: 'ready' | 'failed';
      optimized_url: string | null;
      failure: { code: string; message: string } | null;
    }): Promise<boolean>;
  };
  observability: { record(entry: ObservabilityRecord): void };
};

export interface ImageStatusModule {
  handleImageStatusCallback(
    req: ImageStatusCallbackRequest,
    deps: ImageStatusDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function loadImageStatus(): Promise<ImageStatusModule> {
  // @ts-ignore -- production module does not exist yet (red gate, remediation)
  return (await import('../../src/api/imageStatus')) as unknown as ImageStatusModule;
}

// ---------------------------------------------------------------------------
// src/api/repo.ts — verify finding #4 (`insertDraft`/`takeLock` never existed)
// ---------------------------------------------------------------------------

export interface RepoModule {
  createRepo(pool: unknown): {
    insertDraft(input: { writer_id: WriterId; title: string }): Promise<{ id: string }>;
    takeLock(input: { article_id: string; writer_id: WriterId; now: Date }): Promise<boolean>;
    recordTelemetry(article_id: string, events: TelemetryEvent[]): Promise<void>;
    setImageStatus(input: {
      image_id: string;
      status: 'ready' | 'failed';
      optimized_url: string | null;
      failure: { code: string; message: string } | null;
    }): Promise<boolean>;
    getImage(image_id: string): Promise<ImageStatusRow | null>;
  };
}

export async function loadRepo(): Promise<RepoModule> {
  // @ts-ignore -- the concrete repo exists, but not these methods (finding #4)
  return (await import('../../src/api/repo')) as unknown as RepoModule;
}

// ---------------------------------------------------------------------------
// src/api/router.ts — booted in-process, for the transport-layer guards
// ---------------------------------------------------------------------------

export type RouterOptions = {
  port: number;
  databaseUrl: string;
  writerToken: string;
  writerId: string;
  /** The Supabase project's JWKS well-known URL — verify finding #3. */
  jwksUrl?: string;
  /** A JWKS as raw JSON — the test-only, no-network path. Takes precedence
   *  over `jwksUrl` when both are set. */
  jwksJson?: string;
  /** ADR-0004's Lambda callback shared secret. */
  imageCallbackSecret?: string;
  /**
   * How long a request may take to finish delivering its body before the
   * server answers it and stops waiting (05-verification.v2.md §5: `readBody()`
   * has no timeout, so a declared-but-never-completed body hangs the request
   * indefinitely). Optional so the shipped default applies in production;
   * overridable so NFR-DOS-03 can prove the mechanism in ~2 seconds instead of
   * waiting out a realistic one.
   */
  readTimeoutMs?: number;
  /** `GET /internal/metrics/time-to-publish`'s shared secret (John's dashboard gate). */
  dashboardReadSecret?: string;
  /** CORS-01: origins allowed to call this deployment from a browser (e.g. the
   *  editor SPA's own origin). Never a wildcard — this is a bearer-token API. */
  corsOrigins?: string[];
  /** The origin `GET /public/articles/:slug`'s canonical link is built against. */
  siteOrigin?: string;
  /** Supabase's own REST API base + service-role key — needed only by the
   *  admin writer-invite route to call the Supabase Auth Admin API. */
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
};

export interface ApiRouterModule {
  startHttpServer(opts: RouterOptions): Promise<{ url: string; stop(): Promise<void> }>;
  /**
   * The read timeout a deployment gets when it configures none — the value
   * that actually protects production, as opposed to the test override above.
   * NFR-DOS-03b pins it, so "pass NFR-DOS-03 by honouring the override and
   * leave the default at Node's 300 s" is not a way through the gate.
   */
  DEFAULT_READ_TIMEOUT_MS: number;
  /** CORS-01: turns `CORS_ALLOWED_ORIGINS` (a comma-separated env var) into
   *  the allow-list `route()` checks requests against. */
  parseCorsOrigins(raw: string | undefined): string[];
}

export async function loadApiRouter(): Promise<ApiRouterModule> {
  // @ts-ignore -- the module exists; the options/ordering it needs do not yet
  return (await import('../../src/api/router')) as unknown as ApiRouterModule;
}
