/**
 * Spec §4 — the two events the time-to-publish metric is computed from.
 * "Without them, the benefit of this build cannot be proven afterwards at any
 * price", so a row missing a required field is rejected at construction rather
 * than stored half-useless, and an unregistered event type never gets stored
 * at all (the same guard the `telemetry_events` check constraint applies).
 */

import { z } from 'zod';

export const REQUIRED_EVENT_TYPES = ['draft_started', 'article_published'] as const;

export type TelemetryEventType = (typeof REQUIRED_EVENT_TYPES)[number];

export type TelemetryEvent = {
  event_type: TelemetryEventType;
  writer_id: string;
  article_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type TelemetrySink = {
  emit(event: TelemetryEvent): void;
  events: TelemetryEvent[];
};

const DraftStartedFields = z.object({
  writer_id: z.string().min(1),
  article_id: z.string().min(1),
  started_at: z.string().min(1),
});

const ArticlePublishedFields = z.object({
  writer_id: z.string().min(1),
  article_id: z.string().min(1),
  published_at: z.string().min(1),
  is_republish: z.boolean(),
});

export class UnknownTelemetryEventError extends Error {
  readonly event_type: string;

  constructor(event_type: string) {
    super(
      `Unknown telemetry event type "${event_type}". Only ${REQUIRED_EVENT_TYPES.join(', ')} are recorded.`,
    );
    this.name = 'UnknownTelemetryEventError';
    this.event_type = event_type;
  }
}

/** Builds one `telemetry_events` row, or throws. */
export function buildTelemetryEvent(
  event_type: string,
  fields: Record<string, unknown>,
): TelemetryEvent {
  if (event_type === 'draft_started') {
    const { writer_id, article_id, started_at } = DraftStartedFields.parse(fields);
    return {
      event_type,
      writer_id,
      article_id,
      occurred_at: started_at,
      payload: { started_at },
    };
  }
  if (event_type === 'article_published') {
    const { writer_id, article_id, published_at, is_republish } =
      ArticlePublishedFields.parse(fields);
    return {
      event_type,
      writer_id,
      article_id,
      occurred_at: published_at,
      payload: { published_at, is_republish },
    };
  }
  throw new UnknownTelemetryEventError(event_type);
}

export function createTelemetrySink(): TelemetrySink {
  const events: TelemetryEvent[] = [];
  return {
    events,
    emit(event: TelemetryEvent) {
      events.push(event);
    },
  };
}
