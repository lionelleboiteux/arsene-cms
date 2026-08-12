/**
 * AC-05 / ADR-0003 — whole-article draft locking via `locked_by`/`locked_at`
 * plus a heartbeat, with an injected clock (02-architecture.v1.md §1).
 *
 * ADR-0003 gives a 60–90 s staleness range and "roughly every 20 seconds" for
 * the heartbeat; traceability.md §6 pins the top of that range so the number
 * lives in exactly one place and can be retuned after launch.
 */

export type WriterId = string;

export type LockState = {
  locked_by: WriterId | null;
  locked_at: Date | null;
  locked_by_display_name: string | null;
};

export type LockDecision =
  | { editable: true }
  | { editable: false; locked_by_writer_id: WriterId; locked_by_display_name: string };

export const HEARTBEAT_INTERVAL_MS = 20_000;
export const LOCK_STALENESS_MS = 90_000;

/** A lock is released only once `locked_at` is *older than* the window. */
export function isLockStale(now: Date, lockedAt: Date): boolean {
  return now.getTime() - lockedAt.getTime() > LOCK_STALENESS_MS;
}

export function evaluateLock(input: {
  now: Date;
  lock: LockState;
  requesting_writer_id: WriterId;
}): LockDecision {
  const { locked_by, locked_at } = input.lock;
  if (locked_by === null || locked_at === null) return { editable: true };
  if (locked_by === input.requesting_writer_id) return { editable: true };
  if (isLockStale(input.now, locked_at)) return { editable: true };

  return {
    editable: false,
    locked_by_writer_id: locked_by,
    locked_by_display_name: input.lock.locked_by_display_name ?? '',
  };
}
