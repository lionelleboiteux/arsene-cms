import { describe, expect, it } from 'vitest';
import { loadLock } from '../support/seams.js';
import { WRITER_A, WRITER_A_NAME, WRITER_B, t } from '../support/fixtures.js';

/**
 * Draft locking — ADR-0003: `locked_by`/`locked_at` columns, ~20s heartbeat,
 * a 60–90s staleness window. 02-architecture.v1.md §1 names the seam:
 * "inject a clock/now() function; fake timers in tests". Every `now` below is
 * passed in explicitly; nothing reads the wall clock.
 *
 * ASSUMPTION (traceability.md §6): ADR-0003 gives a *range* (60–90s). This
 * suite pins the concrete value at **90 000 ms**, the top of that range, and
 * asserts it as a named constant so the number lives in one place and can be
 * retuned after launch as ADR-0003 anticipates.
 */

const ASSUMED_STALENESS_MS = 90_000;
const ASSUMED_HEARTBEAT_MS = 20_000;

const LOCKED_AT = t('2026-08-11T10:00:00Z');
const HELD_BY_A = {
  locked_by: WRITER_A,
  locked_at: LOCKED_AT,
  locked_by_display_name: WRITER_A_NAME,
};

describe('draft locking', () => {
  it('AC-05: writer B opening a draft writer A is actively editing is refused, and told who holds it', async () => {
    const lock = await loadLock();

    const decision = lock.evaluateLock({
      now: new Date(LOCKED_AT.getTime() + ASSUMED_HEARTBEAT_MS), // A's heartbeat is current
      lock: HELD_BY_A,
      requesting_writer_id: WRITER_B,
    });

    expect(decision).toEqual({
      editable: false,
      locked_by_writer_id: WRITER_A,
      locked_by_display_name: WRITER_A_NAME,
    });
  });

  it('AC-05: writer A is never locked out of the draft they themselves hold', async () => {
    const lock = await loadLock();

    const decision = lock.evaluateLock({
      now: new Date(LOCKED_AT.getTime() + ASSUMED_HEARTBEAT_MS),
      lock: HELD_BY_A,
      requesting_writer_id: WRITER_A,
    });

    expect(decision).toEqual({ editable: true });
  });

  it('AC-05: a lock left behind by a crashed browser expires on its own, so writer B can edit without an admin unlock', async () => {
    const lock = await loadLock();

    const decision = lock.evaluateLock({
      now: new Date(LOCKED_AT.getTime() + ASSUMED_STALENESS_MS + 1),
      lock: HELD_BY_A,
      requesting_writer_id: WRITER_B,
    });

    expect(decision).toEqual({ editable: true });
  });

  it('AC-05: a draft nobody holds is editable', async () => {
    const lock = await loadLock();

    const decision = lock.evaluateLock({
      now: t('2026-08-11T10:00:30Z'),
      lock: { locked_by: null, locked_at: null, locked_by_display_name: null },
      requesting_writer_id: WRITER_B,
    });

    expect(decision).toEqual({ editable: true });
  });

  // Boundary partition around the staleness threshold: a lock is released once
  // `locked_at` is *older than* the window, so the instant itself still holds.
  const BOUNDARY = [
    { id: 'NFR-LOCK-01a', klass: 'one heartbeat old', ageMs: ASSUMED_HEARTBEAT_MS, expected: false },
    { id: 'NFR-LOCK-01b', klass: 'exactly at the staleness threshold', ageMs: ASSUMED_STALENESS_MS, expected: false },
    { id: 'NFR-LOCK-01c', klass: 'one millisecond past the threshold', ageMs: ASSUMED_STALENESS_MS + 1, expected: true },
  ] as const;

  it.each(BOUNDARY.map((c) => [`${c.id}: a lock ${c.klass} gives isLockStale=${c.expected}`, c] as const))(
    '%s',
    async (_title, { ageMs, expected }) => {
      const lock = await loadLock();

      expect(lock.isLockStale(new Date(LOCKED_AT.getTime() + ageMs), LOCKED_AT)).toBe(expected);
    },
  );

  it('NFR-LOCK-02: the shipped heartbeat and staleness constants are ADR-0003’s, and the window spans several heartbeats so a slow network cannot steal a live lock', async () => {
    const lock = await loadLock();

    expect({
      heartbeat_ms: lock.HEARTBEAT_INTERVAL_MS,
      staleness_ms: lock.LOCK_STALENESS_MS,
      missed_heartbeats_tolerated: lock.LOCK_STALENESS_MS / lock.HEARTBEAT_INTERVAL_MS >= 3,
    }).toEqual({
      heartbeat_ms: ASSUMED_HEARTBEAT_MS,
      staleness_ms: ASSUMED_STALENESS_MS,
      missed_heartbeats_tolerated: true,
    });
  });
});
