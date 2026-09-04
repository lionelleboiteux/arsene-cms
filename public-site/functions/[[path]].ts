/**
 * Reverse proxy for cms.fantasy-coach.fr — the reader-facing public site.
 *
 * Arsène's actual public content lives on the arsene-api Supabase Edge
 * Function's `/public/*` routes (src/api/router.ts, src/site/render.ts).
 * There is no zone for fantasy-coach.fr on Cloudflare (DNS is still at Wix
 * as of 2026-09-04), so a Workers Custom Domain isn't available — Pages
 * custom domains are, the same external-DNS/CNAME mechanism already proven
 * working for arsene.fantasy-coach.fr (arsene-editor). This project exists
 * only to be that attachment point; it holds no content of its own.
 *
 * Supabase's platform rewrites any Edge Function GET response whose
 * Content-Type is `text/html` to `text/plain` (documented, and confirmed
 * against this exact deployment — a real browser rendered the article as raw
 * source, not a page). So `arsene-api`'s public routes hand back the
 * rendered HTML as a JSON string field instead; this is the one place in the
 * whole system where `Content-Type: text/html` is actually allowed to reach
 * a browser, which is the entire reason this proxy project exists rather
 * than a plain DNS pointer at the Edge Function.
 *
 * The legacy flat article URL signals its redirect as JSON too
 * (`{ redirect: url }`, `router.ts::redirectLegacyArticle`), not a real HTTP
 * 3xx — an earlier version of this file tried a real 301 with
 * `redirect: 'manual'` on the upstream fetch, and it didn't survive intact.
 * Emitting the real 301 to the browser is this proxy's job, from JSON it can
 * actually parse.
 *
 * `cache-control: no-store` is set on every response this function returns,
 * deliberately, not as a default worth trusting: chasing one legacy article
 * URL that kept answering with a response from hours earlier in this
 * project's life — long after both the upstream and this file's own code
 * had changed, and reproducible on the stable pages.dev/custom-domain
 * hostnames but never on a fresh per-deployment preview URL or a
 * never-before-requested path — pointed at Cloudflare's edge caching this
 * function's own output by default. This is dynamic, per-request content;
 * nothing this function returns is ever safe to cache.
 */

const UPSTREAM_ORIGIN = 'https://wpicvtlfjhdofpmfdzrb.supabase.co/functions/v1/arsene-api';
const NO_STORE = { 'cache-control': 'no-store' };

export const onRequest: PagesFunction = async (context) => {
  const incoming = new URL(context.request.url);
  const upstream = new URL(`${UPSTREAM_ORIGIN}/public${incoming.pathname}${incoming.search}`);

  if (context.request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET', ...NO_STORE } });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream.toString(), { method: 'GET', cache: 'no-store' });
  } catch {
    return new Response('Bad Gateway', { status: 502, headers: NO_STORE });
  }

  let page: { html?: string; redirect?: string };
  try {
    page = await upstreamResponse.json();
  } catch {
    return new Response('Bad Gateway', { status: 502, headers: NO_STORE });
  }

  if (typeof page.redirect === 'string') {
    return new Response(null, { status: 301, headers: { location: page.redirect, ...NO_STORE } });
  }
  if (typeof page.html !== 'string') {
    return new Response('Bad Gateway', { status: 502, headers: NO_STORE });
  }

  return new Response(page.html, {
    status: upstreamResponse.status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
  });
};
