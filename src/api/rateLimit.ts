/**
 * NFR-RATE-01 — rate limiting on the mutating endpoints.
 *
 * 02-architecture.v1.md §7 points at "pronos' existing 10 req/min per IP
 * precedent"; traceability.md §6 records that as an assumption to confirm.
 * Sliding window, keyed by whatever the caller passes (the handlers key on
 * client IP).
 */

export const PUBLISH_RATE_LIMIT_PER_MINUTE = 10;

export type RateLimiter = {
  check(key: string, now: Date): { allowed: boolean; limit: number };
};

export function createRateLimiter(opts: {
  max_requests: number;
  window_ms: number;
}): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, now: Date) {
      const cutoff = now.getTime() - opts.window_ms;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
      recent.push(now.getTime());
      hits.set(key, recent);
      return { allowed: recent.length <= opts.max_requests, limit: opts.max_requests };
    },
  };
}
