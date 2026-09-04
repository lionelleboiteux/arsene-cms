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
 */

const UPSTREAM_ORIGIN = 'https://wpicvtlfjhdofpmfdzrb.supabase.co/functions/v1/arsene-api';

export const onRequest: PagesFunction = async (context) => {
  const incoming = new URL(context.request.url);
  const upstream = new URL(`${UPSTREAM_ORIGIN}/public${incoming.pathname}${incoming.search}`);

  if (context.request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream.toString(), { method: 'GET' });
  } catch {
    return new Response('Bad Gateway', { status: 502 });
  }

  const headers = new Headers(upstreamResponse.headers);
  headers.delete('content-security-policy');
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
};
