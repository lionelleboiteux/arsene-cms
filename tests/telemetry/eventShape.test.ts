import { describe, expect, it } from 'vitest';
import { loadTelemetry } from '../support/seams.js';
import { ARTICLE_ID, WRITER_B } from '../support/fixtures.js';

/**
 * Shape of the two events spec §4 requires. Without them "the benefit of this
 * build cannot be proven afterwards at any price" — so the fields are as
 * binding as any acceptance criterion, and a row missing one is rejected at
 * construction rather than stored half-useless.
 */

describe('telemetry event shape', () => {
  it('TELEMETRY-draft_started: builds a row carrying the writer, the article and the moment the draft started', async () => {
    const { buildTelemetryEvent } = await loadTelemetry();

    expect(
      buildTelemetryEvent('draft_started', {
        writer_id: WRITER_B,
        article_id: ARTICLE_ID,
        started_at: '2026-08-11T10:00:00Z',
      }),
    ).toEqual({
      event_type: 'draft_started',
      writer_id: WRITER_B,
      article_id: ARTICLE_ID,
      occurred_at: '2026-08-11T10:00:00Z',
      payload: { started_at: '2026-08-11T10:00:00Z' },
    });
  });

  it('TELEMETRY-article_published: builds a row carrying the writer, the article, the publish time and whether it was a republish', async () => {
    const { buildTelemetryEvent } = await loadTelemetry();

    expect(
      buildTelemetryEvent('article_published', {
        writer_id: WRITER_B,
        article_id: ARTICLE_ID,
        published_at: '2026-08-11T10:47:12Z',
        is_republish: false,
      }),
    ).toEqual({
      event_type: 'article_published',
      writer_id: WRITER_B,
      article_id: ARTICLE_ID,
      occurred_at: '2026-08-11T10:47:12Z',
      payload: { published_at: '2026-08-11T10:47:12Z', is_republish: false },
    });
  });

  // One case per field whose absence would make the metric unanswerable.
  const MISSING_FIELD = [
    {
      id: 'TELEMETRY-draft_started',
      event_type: 'draft_started',
      omitted: 'started_at',
      why: 'the numerator of time-to-publish has no start without it',
      fields: { writer_id: WRITER_B, article_id: ARTICLE_ID },
    },
    {
      id: 'TELEMETRY-article_published',
      event_type: 'article_published',
      omitted: 'is_republish',
      why: 'first publishes and republishes cannot be told apart without it',
      fields: {
        writer_id: WRITER_B,
        article_id: ARTICLE_ID,
        published_at: '2026-08-11T10:47:12Z',
      },
    },
    {
      id: 'TELEMETRY-article_published',
      event_type: 'article_published',
      omitted: 'article_id',
      why: 'the two events are joined on article_id to compute the duration',
      fields: {
        writer_id: WRITER_B,
        published_at: '2026-08-11T10:47:12Z',
        is_republish: false,
      },
    },
  ] as const;

  it.each(
    MISSING_FIELD.map(
      (c) => [`${c.id}: a payload missing ${c.omitted} is rejected, because ${c.why}`, c] as const,
    ),
  )('%s', async (_title, { event_type, fields }) => {
    const { buildTelemetryEvent } = await loadTelemetry();

    expect(() => buildTelemetryEvent(event_type, fields as Record<string, unknown>)).toThrow();
  });

  it('TELEMETRY-REGISTRY: the shipped registry lists exactly the two required event types and no others', async () => {
    const { REQUIRED_EVENT_TYPES } = await loadTelemetry();

    expect([...REQUIRED_EVENT_TYPES].sort()).toEqual(['article_published', 'draft_started']);
  });

  it('TELEMETRY-REGISTRY: an event type outside the agreed two is rejected rather than silently stored', async () => {
    const { buildTelemetryEvent } = await loadTelemetry();

    expect(() =>
      buildTelemetryEvent('article_previewed', {
        writer_id: WRITER_B,
        article_id: ARTICLE_ID,
        occurred_at: '2026-08-11T10:47:12Z',
      }),
    ).toThrow();
  });
});
