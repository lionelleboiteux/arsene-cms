import { describe, expect, it } from 'vitest';
import { loadAutosave } from '../support/seams.js';
import { ARTICLE_ID, t } from '../support/fixtures.js';

/**
 * Autosave and crash recovery. Pure functions over an injected clock — the
 * scheduler that calls them is plumbing, the decision is the behaviour.
 *
 * ASSUMPTIONS (traceability.md §6), both flagged rather than invented quietly:
 *   - AUTOSAVE_INTERVAL_MS is **30 000 ms**. AC-01 says "has been typing for
 *     over 30 seconds without manually saving ... when the autosave interval
 *     elapses" but never fixes the interval itself.
 *   - the indicator reads `Last saved at HH:MM` formatted in **UTC**, so the
 *     string is deterministic in a test and in CI. Rendering it in the
 *     writer's own timezone is a presentation concern, not this seam's.
 */

const ASSUMED_AUTOSAVE_INTERVAL_MS = 30_000;

const LAST_EDIT = t('2026-08-11T10:02:30Z');

describe('draft autosave', () => {
  it('AC-01: after 35 seconds of typing with no manual save, the autosave tick saves the draft and stamps the indicator with the save time', async () => {
    const { evaluateAutosave } = await loadAutosave();

    const decision = evaluateAutosave({
      now: t('2026-08-11T10:03:05Z'), // 35s after the last keystroke
      dirty: true,
      last_edit_at: LAST_EDIT,
      last_saved_at: null,
    });

    expect(decision).toEqual({ save: true, indicator: 'Last saved at 10:03' });
  });

  it('AC-01: a tick with nothing typed since the last save writes nothing and leaves the existing indicator alone', async () => {
    const { evaluateAutosave } = await loadAutosave();

    const decision = evaluateAutosave({
      now: t('2026-08-11T10:05:00Z'),
      dirty: false,
      last_edit_at: LAST_EDIT,
      last_saved_at: t('2026-08-11T10:03:05Z'),
    });

    expect(decision).toEqual({ save: false, indicator: 'Last saved at 10:03' });
  });

  it('AC-01: the shipped autosave interval is the assumed 30 seconds', async () => {
    const { AUTOSAVE_INTERVAL_MS } = await loadAutosave();

    expect(AUTOSAVE_INTERVAL_MS).toBe(ASSUMED_AUTOSAVE_INTERVAL_MS);
  });
});

describe('draft recovery after a crash', () => {
  it('AC-02: reopening a draft whose browser died restores the last autosaved version, not an earlier one', async () => {
    const { restoreDraft } = await loadAutosave();

    const twoMinutesBeforeTheCrash = {
      article_id: ARTICLE_ID,
      body_html: '<h2>Les affiches</h2><p>PSG reçoit Marseille dimanche soir.</p>',
      saved_at: t('2026-08-11T10:03:05Z'),
    };

    const restored = restoreDraft([
      { article_id: ARTICLE_ID, body_html: '<h2>Les affiches</h2>', saved_at: t('2026-08-11T10:02:35Z') },
      twoMinutesBeforeTheCrash,
    ]);

    expect(restored).toEqual(twoMinutesBeforeTheCrash);
  });
});
