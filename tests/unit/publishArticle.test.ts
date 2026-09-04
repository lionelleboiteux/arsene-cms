import { describe, expect, it } from 'vitest';
import { loadPublishArticle, loadRateLimit } from '../support/seams.js';
import type { ArticleRecord, ImageRecord, PublishHttpRequest } from '../support/seams.js';
import { buildPublishDeps, eventsOfType } from '../support/fakes.js';
import { validateAgainstSchema } from '../support/openapi.js';
import {
  ARTICLE_ID,
  BODY_IMAGE_ID,
  NOW,
  READY_COVER,
  WRITER_A,
  WRITER_A_NAME,
  WRITER_B,
  articleRecord,
  imageRecord,
  t,
} from '../support/fixtures.js';

/**
 * The `publish` Edge Function handler — everything the contract says happens
 * "in the same request that publishes". Collaborators (DB, auth, telemetry,
 * revalidation, rate limiter) are fakes from tests/support/fakes.ts, so each
 * test below fails for exactly one reason: the handler does not exist.
 *
 * ASSUMPTION (traceability.md §6): NFR-RATE-01's threshold is **10 requests
 * per minute per IP**, which is what 02-architecture.v1.md §7 points at
 * ("mirroring pronos' existing 10 req/min per IP precedent"). Not restated
 * anywhere as an agreed Arsène number.
 */

const ASSUMED_PUBLISH_RATE_LIMIT = 10;

const publishReq = (overrides: Partial<PublishHttpRequest> = {}): PublishHttpRequest => ({
  article_id: ARTICLE_ID,
  authorization: 'Bearer writer.supabase.jwt',
  idempotency_key: null,
  client_ip: '203.0.113.7',
  body: {},
  ...overrides,
});

const iso = (v: unknown): string => new Date(String(v)).toISOString();

// ---------------------------------------------------------------------------
// Refusals — one case per distinct `error.code` the contract documents.
// ---------------------------------------------------------------------------

type RefusalCase = {
  id: string;
  klass: string;
  article?: ArticleRecord | null;
  images?: ImageRecord[];
  authValid?: boolean;
  req?: Partial<PublishHttpRequest>;
  status: number;
  code: string;
};

const REFUSALS: RefusalCase[] = [
  {
    id: 'DEC-01',
    klass: 'an article with no cover image at all (01-decisions.md #1: cover is mandatory)',
    article: articleRecord(),
    images: [imageRecord({ id: BODY_IMAGE_ID, role: 'body' })],
    status: 400,
    code: 'COVER_IMAGE_REQUIRED',
  },
  {
    id: 'AC-04',
    klass: 'a Pronos article whose structured match fields are invalid',
    article: articleRecord({
      pronos_entries: [
        {
          home_team: 'PSG',
          away_team: 'Marseille',
          predicted_home_score: 2,
          predicted_away_score: 1,
          confidence_tier: 'Chaud',
        },
      ],
    }),
    images: READY_COVER,
    status: 400,
    code: 'VALIDATION_FAILED',
  },
  {
    id: 'AC-08a',
    klass: 'a cover image still being optimised',
    article: articleRecord(),
    images: [imageRecord({ status: 'processing', alt_text: null })],
    status: 409,
    code: 'IMAGE_NOT_READY',
  },
  {
    id: 'AC-08b',
    klass: 'a body image that failed optimisation and was never replaced',
    article: articleRecord(),
    images: [imageRecord(), imageRecord({ id: BODY_IMAGE_ID, role: 'body', status: 'failed' })],
    status: 409,
    code: 'IMAGE_NOT_READY',
  },
  {
    id: 'AC-05',
    klass: 'a draft another writer currently holds the edit lock on',
    article: articleRecord({ locked_by: WRITER_A, locked_at: t('2026-08-11T10:47:00Z') }),
    images: READY_COVER,
    status: 409,
    code: 'DRAFT_LOCKED',
  },
  {
    id: 'NFR-AUTH-01',
    klass: 'a request carrying no writer bearer token',
    article: articleRecord(),
    images: READY_COVER,
    authValid: false,
    req: { authorization: null },
    status: 401,
    code: 'UNAUTHORIZED',
  },
  {
    id: 'CONTRACT-publish-404',
    klass: 'an article id that does not exist',
    article: null,
    images: [],
    status: 404,
    code: 'NOT_FOUND',
  },
];

describe('publish refusals', () => {
  it.each(
    REFUSALS.map((c) => [`${c.id}: publishing ${c.klass} is refused with ${c.status} ${c.code}`, c] as const),
  )('%s', async (_title, c) => {
    const api = await loadPublishArticle();
    const { deps } = buildPublishDeps({
      now: NOW,
      article: c.article,
      images: c.images,
      authValid: c.authValid,
      writer_id: WRITER_B,
      display_name: WRITER_A_NAME,
    });

    const res = await api.handlePublishArticle(publishReq(c.req), deps);

    expect({ status: res.status, code: (res.body as any)?.error?.code }).toEqual({
      status: c.status,
      code: c.code,
    });
  });
});

// ---------------------------------------------------------------------------
// Successful publish
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('AC-14: a successful first publish returns the automatically generated slug, JSON-LD and sitemap entry in the shape the contract declares', async () => {
    const api = await loadPublishArticle();
    const { deps } = buildPublishDeps({ now: NOW, article: articleRecord(), images: READY_COVER });

    const res = await api.handlePublishArticle(publishReq(), deps);
    const body = res.body as Record<string, unknown>;

    expect({
      status: res.status,
      contract_errors: validateAgainstSchema('PublishResponse', body),
      slug: body.slug,
      has_structured_data: Boolean(body.structured_data),
      has_sitemap: Boolean(body.sitemap),
    }).toEqual({
      status: 200,
      contract_errors: [],
      slug: 'pronos-ligue-1-journee-12',
      has_structured_data: true,
      has_sitemap: true,
    });
  });

  it('AC-13: meta title and description edited by the writer at the publish step are used verbatim instead of the suggestion', async () => {
    const api = await loadPublishArticle();
    const { deps, published } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: READY_COVER,
    });

    const res = await api.handlePublishArticle(
      publishReq({
        body: {
          meta_title: 'Pronos Ligue 1 – Journée 12 : nos pronostics',
          meta_description: 'Nos pronostics pour la journée 12 de Ligue 1, match par match.',
        },
      }),
      deps,
    );

    expect({
      returned: {
        meta_title: (res.body as any).meta_title,
        meta_description: (res.body as any).meta_description,
      },
      persisted: {
        meta_title: published[0]?.meta_title,
        meta_description: published[0]?.meta_description,
      },
    }).toEqual({
      returned: {
        meta_title: 'Pronos Ligue 1 – Journée 12 : nos pronostics',
        meta_description: 'Nos pronostics pour la journée 12 de Ligue 1, match par match.',
      },
      persisted: {
        meta_title: 'Pronos Ligue 1 – Journée 12 : nos pronostics',
        meta_description: 'Nos pronostics pour la journée 12 de Ligue 1, match par match.',
      },
    });
  });

  it('AC-16: an article the content check flagged still publishes when the writer chooses to publish anyway', async () => {
    const api = await loadPublishArticle();
    const { deps } = buildPublishDeps({
      now: NOW,
      // Too short an introduction — exactly what AC-16's advisory flags.
      article: articleRecord({ body_html: '<p>Court.</p>' }),
      images: READY_COVER,
    });

    const res = await api.handlePublishArticle(publishReq(), deps);

    expect({ status: res.status, status_field: (res.body as any).status }).toEqual({
      status: 200,
      status_field: 'published',
    });
  });

  it('AC-17: republishing an article that went live 3 days ago refreshes published_at, keeps first_published_at, and is flagged as a republish', async () => {
    const api = await loadPublishArticle();
    const firstPublishedAt = t('2026-08-08T09:03:00Z');
    const { deps } = buildPublishDeps({
      now: NOW,
      article: articleRecord({ first_published_at: firstPublishedAt, slug: 'pronos-ligue-1-journee-12' }),
      images: READY_COVER,
      firstPublishedAt,
    });

    const res = await api.handlePublishArticle(publishReq(), deps);
    const body = res.body as Record<string, unknown>;

    expect({
      is_republish: body.is_republish,
      first_published_at: iso(body.first_published_at),
      published_at: iso(body.published_at),
      slug_unchanged: body.slug,
    }).toEqual({
      is_republish: true,
      first_published_at: '2026-08-08T09:03:00.000Z',
      published_at: '2026-08-11T10:47:12.000Z',
      slug_unchanged: 'pronos-ligue-1-journee-12',
    });
  });

  it('AC-17: publishing triggers on-demand revalidation of the article, its category page and the homepage, so the update is live immediately', async () => {
    const api = await loadPublishArticle();
    const { deps, revalidatedPaths } = buildPublishDeps({
      now: NOW,
      article: articleRecord({ first_published_at: t('2026-08-08T09:03:00Z') }),
      images: READY_COVER,
    });

    await api.handlePublishArticle(publishReq(), deps);

    expect(revalidatedPaths[0]?.slice().sort()).toEqual([
      '/',
      '/articles/ligue-1/26-27/pronos',
      '/articles/ligue-1/26-27/pronos/pronos-ligue-1-journee-12',
    ]);
  });

  it('NFR-OBS-01: a failed revalidation is recorded as a failure rather than passing silently, because a writer seeing no change is otherwise invisible', async () => {
    const api = await loadPublishArticle();
    const { deps, observed } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: READY_COVER,
      revalidation: { ok: false, error: 'cloudflare 502' },
    });

    await api.handlePublishArticle(publishReq(), deps);

    expect(observed.map((r) => [r.event, r.outcome])).toEqual([['revalidation', 'failure']]);
  });

  it('NFR-IDEM-01: replaying the same Idempotency-Key does not record a second article_published event, so time-to-publish is not skewed by a retry', async () => {
    const api = await loadPublishArticle();
    const { deps, sink } = buildPublishDeps({ now: NOW, article: articleRecord(), images: READY_COVER });
    const req = publishReq({ idempotency_key: '6c1a9e2b-4b1a-4e2b-9c3a-abcdefabcdef' });

    await api.handlePublishArticle(req, deps);
    await api.handlePublishArticle(req, deps);

    expect(eventsOfType(sink.events, 'article_published')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (02-architecture.v1.md §7, Denial of service)
// ---------------------------------------------------------------------------

describe('publish rate limiting', () => {
  const spam = async (
    api: { handlePublishArticle: Function },
    deps: unknown,
    times: number,
    ip: string,
  ) => {
    let last: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < times; i += 1) {
      last = await (api.handlePublishArticle as any)(publishReq({ client_ip: ip }), deps);
    }
    return last!;
  };

  it('NFR-RATE-01a: the 10th publish attempt in a minute from one IP is still served', async () => {
    const api = await loadPublishArticle();
    const { deps } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: READY_COVER,
      rateLimit: ASSUMED_PUBLISH_RATE_LIMIT,
    });

    const res = await spam(api, deps, ASSUMED_PUBLISH_RATE_LIMIT, '203.0.113.7');

    expect(res.status).toBe(200);
  });

  it('NFR-RATE-01b: the 11th publish attempt in a minute from the same IP is rejected with 429', async () => {
    const api = await loadPublishArticle();
    const { deps } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: READY_COVER,
      rateLimit: ASSUMED_PUBLISH_RATE_LIMIT,
    });

    const res = await spam(api, deps, ASSUMED_PUBLISH_RATE_LIMIT + 1, '203.0.113.7');

    expect(res.status).toBe(429);
  });

  it('NFR-RATE-01c: a second writer on a different IP is unaffected by the first IP exhausting its budget', async () => {
    const api = await loadPublishArticle();
    const { deps } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: READY_COVER,
      rateLimit: ASSUMED_PUBLISH_RATE_LIMIT,
    });

    await spam(api, deps, ASSUMED_PUBLISH_RATE_LIMIT + 1, '203.0.113.7');
    const other = await spam(api, deps, 1, '198.51.100.4');

    expect(other.status).toBe(200);
  });

  it('NFR-RATE-01d: the shipped limiter exposes the assumed 10-per-minute-per-IP threshold', async () => {
    const { PUBLISH_RATE_LIMIT_PER_MINUTE } = await loadRateLimit();

    expect(PUBLISH_RATE_LIMIT_PER_MINUTE).toBe(ASSUMED_PUBLISH_RATE_LIMIT);
  });
});
