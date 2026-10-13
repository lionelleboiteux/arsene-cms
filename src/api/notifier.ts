/**
 * HTTP client for the fantasy-coach-notifications Worker's
 * `POST /notify-article` (its own `src/notify.ts`). Server-to-server only:
 * the shared secret never reaches a browser.
 */

import type { Notifier, NotifierResult } from './notifyArticle.ts';

const NOTIFY_TIMEOUT_MS = 20_000;

export function createNotifier(opts: { baseUrl: string; secret: string }): Notifier {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/notify-article`;
  return {
    async send(payload): Promise<NotifierResult> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-notify-secret': opts.secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, reason: `notifications service answered ${response.status}` };
      const body = (await response.json()) as { devices?: unknown; sent?: unknown; failed?: unknown };
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      return { ok: true, devices: n(body.devices), sent: n(body.sent), failed: n(body.failed) };
    },
  };
}
