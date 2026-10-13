import { describe, expect, it, vi } from 'vitest';
import { handleNotifyArticle, type NotifyArticleDeps, type Notifier } from '../../src/api/notifyArticle.js';

/**
 * The home page's "Notification" button. The claim-then-send-then-release
 * ordering is what this file pins; the compare-and-set itself is proven
 * against real Postgres in `tests/db/articleNotification.test.ts`.
 */

const TOKEN = 'writer-bearer-not-a-real-jwt';
const ARTICLE_ID = '22222222-2222-2222-2222-222222222222';
const REQ = { authorization: `Bearer ${TOKEN}`, article_id: ARTICLE_ID };

const CLAIMED = {
  result: 'claimed' as const,
  article: { title: 'Player Picks, Ligue 1, J7', teaser: '  Nos choix.  ', slug: 'pp-l1-j7', image_url: 'https://cdn.example/og.jpg' },
};

function build(overrides: {
  claim?: Awaited<ReturnType<NotifyArticleDeps['repo']['claimArticleNotification']>>;
  notifier?: Notifier | undefined | 'none';
  valid?: boolean;
} = {}) {
  const release = vi.fn(async () => undefined);
  const send = vi.fn<Notifier['send']>(async () => ({ ok: true, devices: 3, sent: 3, failed: 0 }));
  const deps: NotifyArticleDeps = {
    auth: { verifyBearer: async (t) => ({ valid: (overrides.valid ?? true) && t === TOKEN, writer_id: 'w1' }) },
    repo: {
      claimArticleNotification: async () => overrides.claim ?? CLAIMED,
      releaseArticleNotification: release,
    },
    notifier: overrides.notifier === 'none' ? undefined : (overrides.notifier ?? { send }),
  };
  return { deps, release, send };
}

describe('authentication', () => {
  it('NOTIFY-AUTH-01: no bearer token is refused 401 and nothing is claimed or sent', async () => {
    const { deps, send } = build();
    const res = await handleNotifyArticle({ authorization: null, article_id: ARTICLE_ID }, deps);
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('NOTIFY-AUTH-02: a token verifyBearer refuses is refused 401', async () => {
    const { deps } = build({ valid: false });
    expect((await handleNotifyArticle(REQ, deps)).status).toBe(401);
  });
});

describe('notify article', () => {
  it('NOTIFY-01: sends title, trimmed teaser, slug and image, and reports the delivery counts', async () => {
    const { deps, send } = build();

    const res = await handleNotifyArticle(REQ, deps);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ article_id: ARTICLE_ID, notified: true, devices: 3, sent: 3, failed: 0 });
    expect(send).toHaveBeenCalledWith({
      title: 'Player Picks, Ligue 1, J7',
      body: 'Nos choix.',
      slug: 'pp-l1-j7',
      imageUrl: 'https://cdn.example/og.jpg',
    });
  });

  it('NOTIFY-02: an article with no teaser sends an empty body (the Worker supplies the fallback)', async () => {
    const { deps, send } = build({
      claim: { result: 'claimed', article: { ...CLAIMED.article, teaser: null, image_url: null } },
    });

    await handleNotifyArticle(REQ, deps);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ body: '', imageUrl: null }));
  });

  it.each([
    ['not_found', 404],
    ['not_published', 409],
    ['already_notified', 409],
  ] as const)('NOTIFY-03: a claim result of %s is %i and nothing is sent', async (result, status) => {
    const { deps, send, release } = build({ claim: { result } });

    const res = await handleNotifyArticle(REQ, deps);

    expect(res.status).toBe(status);
    expect(send).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('NOTIFY-04: a deployment with no notifier configured is 503 and claims nothing', async () => {
    const claim = vi.fn();
    const { deps } = build({ notifier: 'none' });
    deps.repo.claimArticleNotification = claim;

    const res = await handleNotifyArticle(REQ, deps);

    expect(res.status).toBe(503);
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('delivery failure', () => {
  it('NOTIFY-05: a Worker failure releases the claim and is 502, so the writer can retry', async () => {
    const { deps, release } = build({
      notifier: { send: async () => ({ ok: false, reason: 'notifications service answered 502' }) },
    });

    const res = await handleNotifyArticle(REQ, deps);

    expect(res.status).toBe(502);
    expect(release).toHaveBeenCalledWith(ARTICLE_ID);
  });

  it('NOTIFY-06: a thrown network error is treated the same: released, 502', async () => {
    const { deps, release } = build({
      notifier: {
        send: async () => {
          throw new Error('timeout');
        },
      },
    });

    expect((await handleNotifyArticle(REQ, deps)).status).toBe(502);
    expect(release).toHaveBeenCalledWith(ARTICLE_ID);
  });

  it('NOTIFY-07: nothing delivered to any of several devices releases the claim', async () => {
    const { deps, release } = build({
      notifier: { send: async () => ({ ok: true, devices: 5, sent: 0, failed: 5 }) },
    });

    expect((await handleNotifyArticle(REQ, deps)).status).toBe(502);
    expect(release).toHaveBeenCalled();
  });

  it('NOTIFY-08: a partial delivery keeps the claim (retrying would re-notify the devices that got it)', async () => {
    const { deps, release } = build({
      notifier: { send: async () => ({ ok: true, devices: 5, sent: 3, failed: 2 }) },
    });

    const res = await handleNotifyArticle(REQ, deps);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: 3, failed: 2 });
    expect(release).not.toHaveBeenCalled();
  });

  it('NOTIFY-09: zero subscribed devices is a successful no-op that keeps the claim', async () => {
    const { deps, release } = build({
      notifier: { send: async () => ({ ok: true, devices: 0, sent: 0, failed: 0 }) },
    });

    expect((await handleNotifyArticle(REQ, deps)).status).toBe(200);
    expect(release).not.toHaveBeenCalled();
  });
});
