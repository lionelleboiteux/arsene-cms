/**
 * AC-01 / AC-02 — autosave decision and crash recovery, over an injected
 * clock. The scheduler that calls `evaluateAutosave` on a timer is plumbing;
 * the decision is the behaviour.
 *
 * The indicator is formatted in UTC (traceability.md §6): rendering it in the
 * writer's own timezone is a presentation concern, not this seam's.
 */

export type AutosaveDecision = {
  save: boolean;
  /** AC-01's "Last saved at [time]"; null when nothing has been saved yet. */
  indicator: string | null;
};

export type DraftSnapshot = {
  article_id: string;
  body_html: string;
  saved_at: Date;
};

export const AUTOSAVE_INTERVAL_MS = 30_000;

function indicatorFor(savedAt: Date): string {
  return `Last saved at ${savedAt.toISOString().slice(11, 16)}`;
}

export function evaluateAutosave(input: {
  now: Date;
  dirty: boolean;
  last_edit_at: Date;
  last_saved_at: Date | null;
}): AutosaveDecision {
  const { now, last_saved_at } = input;
  const idle = last_saved_at === null
    ? now.getTime() - input.last_edit_at.getTime()
    : now.getTime() - last_saved_at.getTime();

  if (!input.dirty || idle < AUTOSAVE_INTERVAL_MS) {
    return { save: false, indicator: last_saved_at === null ? null : indicatorFor(last_saved_at) };
  }
  return { save: true, indicator: indicatorFor(now) };
}

/** AC-02: reopening a crashed draft restores its most recent autosave. */
export function restoreDraft(snapshots: DraftSnapshot[]): DraftSnapshot | null {
  let latest: DraftSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (latest === null || snapshot.saved_at.getTime() > latest.saved_at.getTime()) {
      latest = snapshot;
    }
  }
  return latest;
}
