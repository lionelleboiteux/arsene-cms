import { describe, expect, it } from 'vitest';
import { loadCreateDraft, loadPublishArticle } from '../support/seams.js';
import type { ImageRecord } from '../support/seams.js';
import { buildCreateDraftDeps, buildPublishDeps, eventsOfType } from '../support/fakes.js';
import {
  ARTICLE_ID,
  BODY_IMAGE_ID,
  NOW,
  READY_COVER,
  WRITER_A,
  WRITER_B,
  articleRecord,
  imageRecord,
  t,
} from '../support/fixtures.js';

/**
 * Emission of the two required events, positive AND negative path.
 *
 * The negative paths are not optional politeness. Time-to-publish is
 * `article_published.published_at − draft_started.started_at`, so:
 *   - an `article_published` emitted on a *rejected* publish would invent a
 *     publish that never happened and shorten the measured duration;
 *   - a second `draft_started` on reopening a draft would restart the clock
 *     and hide the real 50-minute-baseline problem this project exists to fix.
 * Both directions are asserted below.
 */

const publishReq = (overrides: Record<string, unknown> = {}) => ({
  article_id: ARTICLE_ID,
  authorization: 'Bearer writer.supabase.jwt',
  idempotency_key: null,
  client_ip: '203.0.113.7',
  body: {},
  ...overrides,
});

describe('telemetry: draft_started', () => {
  it('TELEMETRY-draft_started: creating a new draft emits exactly one draft_started carrying the writer, the article and the start time', async () => {
    const api = await loadCreateDraft();
    const { deps, sink } = buildCreateDraftDeps({ now: t('2026-08-11T10:00:00Z'), writer_id: WRITER_B });

    await api.handleCreateDraft(
      { authorization: 'Bearer writer.supabase.jwt', client_ip: '203.0.113.7', body: { title: 'Pronos Ligue 1 - Journée 12' } },
      deps,
    );

    expect(
      eventsOfType(sink.events, 'draft_started').map((e) => ({
        writer_id: e.writer_id,
        article_id: e.article_id,
        started_at: e.payload.started_at,
      })),
    ).toEqual([
      { writer_id: WRITER_B, article_id: ARTICLE_ID, started_at: '2026-08-11T10:00:00.000Z' },
    ]);
  });

  it('TELEMETRY-draft_started (negative): reopening an existing draft emits no second draft_started, so a crash-and-resume cannot reset the clock', async () => {
    const api = await loadCreateDraft();
    const { deps, sink } = buildCreateDraftDeps({
      now: t('2026-08-11T10:05:00Z'),
      writer_id: WRITER_B,
      article: articleRecord(),
    });

    await api.handleOpenDraft(
      { article_id: ARTICLE_ID, authorization: 'Bearer writer.supabase.jwt', client_ip: '203.0.113.7' },
      deps,
    );

    expect(eventsOfType(sink.events, 'draft_started')).toEqual([]);
  });
});

describe('telemetry: article_published', () => {
  it('TELEMETRY-article_published: a successful first publish emits exactly one event, flagged as not a republish', async () => {
    const api = await loadPublishArticle();
    const { deps, sink } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: READY_COVER,
      writer_id: WRITER_B,
    });

    await api.handlePublishArticle(publishReq() as any, deps);

    expect(
      eventsOfType(sink.events, 'article_published').map((e) => ({
        writer_id: e.writer_id,
        article_id: e.article_id,
        published_at: e.payload.published_at,
        is_republish: e.payload.is_republish,
      })),
    ).toEqual([
      {
        writer_id: WRITER_B,
        article_id: ARTICLE_ID,
        published_at: '2026-08-11T10:47:12.000Z',
        is_republish: false,
      },
    ]);
  });

  it('TELEMETRY-article_published: republishing emits an event flagged is_republish, so republishes cannot be counted as first publishes', async () => {
    const api = await loadPublishArticle();
    const firstPublishedAt = t('2026-08-08T09:03:00Z');
    const { deps, sink } = buildPublishDeps({
      now: NOW,
      article: articleRecord({ first_published_at: firstPublishedAt, slug: 'pronos-ligue-1-journee-12' }),
      images: READY_COVER,
      firstPublishedAt,
    });

    await api.handlePublishArticle(publishReq() as any, deps);

    expect(eventsOfType(sink.events, 'article_published').map((e) => e.payload.is_republish)).toEqual([
      true,
    ]);
  });

  // Every way a publish can be refused, and none of them may emit the event —
  // otherwise the denominator of "publishes that actually went live" is wrong.
  const REFUSED: Array<{
    id: string;
    klass: string;
    images: ImageRecord[];
    authValid?: boolean;
    article?: ReturnType<typeof articleRecord> | null;
  }> = [
    {
      id: 'DEC-01',
      klass: 'refused for a missing cover image',
      images: [imageRecord({ id: BODY_IMAGE_ID, role: 'body' })],
    },
    {
      id: 'AC-08',
      klass: 'refused because an image is still processing',
      images: [imageRecord({ status: 'processing', alt_text: null })],
    },
    {
      id: 'AC-05',
      klass: 'refused because another writer holds the draft lock',
      images: READY_COVER,
      article: articleRecord({ locked_by: WRITER_A, locked_at: t('2026-08-11T10:47:00Z') }),
    },
    {
      id: 'NFR-AUTH-01',
      klass: 'refused for a missing bearer token',
      images: READY_COVER,
      authValid: false,
    },
  ];

  it.each(
    REFUSED.map(
      (c) =>
        [
          `TELEMETRY-article_published (negative) / ${c.id}: a publish ${c.klass} emits no article_published event`,
          c,
        ] as const,
    ),
  )('%s', async (_title, c) => {
    const api = await loadPublishArticle();
    const { deps, sink } = buildPublishDeps({
      now: NOW,
      article: c.article ?? articleRecord(),
      images: c.images,
      authValid: c.authValid,
    });

    await api.handlePublishArticle(
      publishReq({ authorization: c.authValid === false ? null : 'Bearer writer.supabase.jwt' }) as any,
      deps,
    );

    expect(eventsOfType(sink.events, 'article_published')).toEqual([]);
  });
});
