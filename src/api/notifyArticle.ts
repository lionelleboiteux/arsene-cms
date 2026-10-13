/**
 * `POST /v1/articles/{articleId}/notify` — the home page's "Notification"
 * button: tells the mobile apps (via the fantasy-coach-notifications Worker)
 * that a published article is out. Any active writer may press it, once per
 * article: `repo.claimArticleNotification` is the compare-and-set that makes
 * a second press — or two simultaneous ones — a `409`, not a second push.
 *
 * Order matters: claim first, send second, release only on total failure.
 * Sending first would let two concurrent presses both notify; releasing on a
 * *partial* failure would re-notify devices that already got it.
 */

import { bearerToken, errorResponse, type HandlerResponse } from './http.ts';

export type NotificationPayload = {
  title: string;
  body: string;
  slug: string;
  imageUrl: string | null;
};

export type NotifierResult =
  | { ok: true; devices: number; sent: number; failed: number }
  | { ok: false; reason: string };

export type Notifier = { send(payload: NotificationPayload): Promise<NotifierResult> };

export type NotifyArticleDeps = {
  auth: { verifyBearer(token: string | null): Promise<{ valid: boolean; writer_id?: string }> };
  repo: {
    claimArticleNotification(article_id: string): Promise<
      | {
          result: 'claimed';
          article: { title: string; teaser: string | null; slug: string; image_url: string | null };
        }
      | { result: 'not_found' | 'not_published' | 'already_notified' }
    >;
    releaseArticleNotification(article_id: string): Promise<void>;
  };
  /** `undefined` when the deployment has no notifications Worker configured. */
  notifier: Notifier | undefined;
};

export type NotifyArticleRequest = {
  authorization: string | null;
  article_id: string;
};

export async function handleNotifyArticle(
  req: NotifyArticleRequest,
  deps: NotifyArticleDeps,
): Promise<HandlerResponse> {
  const auth = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!auth.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required.');
  }
  if (deps.notifier === undefined) {
    return errorResponse(503, 'INTERNAL_ERROR', 'Notifications are not configured on this deployment.');
  }

  const claim = await deps.repo.claimArticleNotification(req.article_id);
  if (claim.result !== 'claimed') {
    if (claim.result === 'not_found') {
      return errorResponse(404, 'NOT_FOUND', 'No article was found matching the given id.', {
        article_id: req.article_id,
      });
    }
    const message =
      claim.result === 'not_published'
        ? 'Only a published article can be announced.'
        : 'This article has already been announced to the apps.';
    return errorResponse(409, 'CONFLICT', message, { article_id: req.article_id });
  }

  const { article } = claim;
  let outcome: NotifierResult;
  try {
    outcome = await deps.notifier.send({
      title: article.title,
      body: article.teaser?.trim() ?? '',
      slug: article.slug,
      imageUrl: article.image_url,
    });
  } catch (err) {
    outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // Nothing went out → give the claim back so the writer can retry.
  if (!outcome.ok || (outcome.devices > 0 && outcome.sent === 0)) {
    await deps.repo.releaseArticleNotification(req.article_id);
    return errorResponse(502, 'INTERNAL_ERROR', 'The notification service could not deliver the notification.', {
      article_id: req.article_id,
    });
  }

  return {
    status: 200,
    body: {
      article_id: req.article_id,
      notified: true,
      devices: outcome.devices,
      sent: outcome.sent,
      failed: outcome.failed,
    },
  };
}
