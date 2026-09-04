/**
 * The public site's render pass (AC-06, AC-11, AC-12, AC-14).
 *
 * Reads published content straight from Postgres and returns the HTML/JSON-LD
 * an ISR page would serve, so the whole surface is assertable without a
 * deploy (02-architecture.v1.md §1). Only `optimized_url` is ever emitted:
 * pointing a visitor at Supabase Storage would blow the 5 GB/month egress
 * free tier (§4).
 */

import pg from 'pg';
import { sanitizePastedHtml } from '../domain/paste.ts';
import {
  articlePath,
  buildStructuredData,
  seasonSlug,
  toSlug,
  type PublishedArticleView,
} from '../domain/seo.ts';

export type RenderedPage = {
  html: string;
  json_ld: Array<Record<string, unknown>>;
};

type ArticleRow = {
  id: string;
  title: string;
  slug: string;
  body_html: string;
  league_name: string;
  type_name: string;
  writer_display_name: string;
  cover_image_url: string | null;
  published_at: Date;
  first_published_at: Date;
};

/**
 * M-V7-02 (`05-verification.v7.md` §5): the cover is resolved live, but the
 * cover *slot* is vacated the moment a replacement upload is accepted —
 * `uploadImage.ts` demotes before ADR-0004 has converted anything, by design.
 * Between those two facts the live query returned nothing for a page that was
 * already published and already correct: `og:image ""`, `image: [""]` in the
 * schema.org block and no `<img>` at all on the listing card, transiently
 * during every ordinary replacement and permanently when the replacement's
 * conversion failed — H-V6-01's exact public symptom, through a path
 * `usableCover()` does not govern.
 *
 * So the live row wins when there is one, and otherwise the page falls back to
 * `structured_data.image`, which `markPublished` persisted at this article's
 * last successful publish: the cover it was genuinely published with, and the
 * one visitors were already being served. `nullif` keeps a legacy row whose
 * persisted image is `''` rendering as "no cover" rather than as an empty
 * `<img src="">`.
 */
const PUBLISHED_ARTICLES_SQL = `
  select a.id, a.title, a.slug, a.body_html,
         l.name as league_name, c.name as type_name,
         w.display_name as writer_display_name,
         coalesce(
           (select i.optimized_url
              from article_images i
             where i.article_id = a.id and i.role = 'cover' and i.status = 'ready'
             limit 1),
           nullif(a.structured_data -> 'image' ->> 0, '')
         ) as cover_image_url,
         a.published_at,
         coalesce(a.first_published_at, a.published_at) as first_published_at
    from articles a
    join arsene_leagues l on l.id = a.league_id
    join categories c on c.id = a.category_id
    join writers w on w.id = a.writer_id
   where a.status = 'published' and a.slug is not null
   order by a.published_at desc
`;

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const formatDateTime = (iso: string): string => dateFormatter.format(new Date(iso));

/**
 * Inlined rather than a separate stylesheet route: everything this site
 * serves goes through the JSON-wrapping detour `renderPublicPage`'s own
 * comment (`src/api/router.ts`) documents for `text/html` — adding a second
 * asset route would mean solving that problem twice for one page's worth of
 * CSS.
 */
const SITE_CSS = `
:root{--bg:#fff;--fg:#16181c;--muted:#6b7280;--card-bg:#f4f4f5}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#f2f2f3;--muted:#9a9aa2;--card-bg:#1c1c1f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.55;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:inherit}
main{max-width:680px;margin:0 auto}
.hero{position:relative;margin:0;background:#000}
.hero img{display:block;width:100%;max-height:70vh;object-fit:cover}
.hero .scrim{position:absolute;inset:0;
  background:linear-gradient(to top,rgba(0,0,0,.88),rgba(0,0,0,.1) 60%,transparent)}
.hero h1{position:absolute;left:0;right:0;bottom:0;margin:0;padding:1.5rem 1.25rem;color:#fff;
  font-size:clamp(1.5rem,4vw,2.25rem);font-weight:800;line-height:1.2}
h1.title-only{padding:2rem 1.25rem 0;font-size:clamp(1.5rem,4vw,2.25rem);font-weight:800;line-height:1.2}
.meta{padding:1rem 1.25rem 0;margin:0;color:var(--muted);font-size:.95rem}
.meta .author{color:var(--fg);font-weight:600}
.meta .sep{margin:0 .4em}
.body{padding:1.25rem 1.25rem 3rem;font-size:1.08rem}
.body img{max-width:100%;height:auto;border-radius:8px;margin:.5rem 0}
ul.articles{list-style:none;margin:0;padding:1rem;display:grid;gap:1rem;max-width:900px;margin-inline:auto}
.article-card{background:var(--card-bg);border-radius:12px;overflow:hidden}
.article-card img{display:block;width:100%;height:200px;object-fit:cover}
.article-card a{display:block;padding:.9rem 1rem;font-weight:700;text-decoration:none}
p.empty{padding:2rem;color:var(--muted)}
`;

function viewOf(row: ArticleRow): PublishedArticleView {
  return {
    article_id: row.id,
    title: row.title,
    slug: row.slug,
    league_name: row.league_name,
    type_name: row.type_name,
    writer_display_name: row.writer_display_name,
    cover_image_url: row.cover_image_url ?? '',
    published_at: row.published_at.toISOString(),
    first_published_at: row.first_published_at.toISOString(),
  };
}

/** AC-06: listings show the cover image and never a body image. */
function articleCard(row: ArticleRow): string {
  const cover =
    row.cover_image_url === null
      ? ''
      : `<img src="${escape(row.cover_image_url)}" alt="${escape(row.title)}"/>`;
  return [
    `<li class="article-card" data-article-title="${escape(row.title)}">`,
    cover,
    `<a href="${articlePath(viewOf(row))}">${escape(row.title)}</a>`,
    '</li>',
  ].join('');
}

function page(title: string, head: string, body: string): string {
  return [
    '<!doctype html><html lang="fr"><head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<title>${escape(title)}</title>`,
    `<style>${SITE_CSS}</style>`,
    head,
    '</head><body>',
    body,
    '</body></html>',
  ].join('');
}

export async function createSiteRenderer(opts: { databaseUrl: string; siteOrigin: string }) {
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();

  const published = async (): Promise<ArticleRow[]> =>
    (await client.query<ArticleRow>(PUBLISHED_ARTICLES_SQL)).rows;

  const listing = (title: string, rows: ArticleRow[]): RenderedPage => {
    const first = rows[0];
    const head =
      first?.cover_image_url == null
        ? ''
        : `<meta property="og:image" content="${escape(first.cover_image_url)}"/>`;
    const body =
      rows.length === 0
        ? '<p class="empty">No articles yet</p>'
        : `<ul class="articles">${rows.map(articleCard).join('')}</ul>`;
    return { html: page(title, head, body), json_ld: [] };
  };

  const notFound = (): RenderedPage => ({
    html: page('Introuvable', '', '<p class="empty">No articles yet</p>'),
    json_ld: [],
  });

  return {
    async renderHomepage(): Promise<RenderedPage> {
      return listing('Fantasy Coach', await published());
    },

    /** Shared not-found page — used by `renderArticlePage`'s own miss and by
     *  the legacy-URL redirect route (`router.ts`) when a slug never
     *  existed at all. */
    async renderNotFound(): Promise<RenderedPage> {
      return notFound();
    },

    async renderCategoryPage(args: {
      league_slug: string;
      season_slug: string;
      type_slug: string;
    }): Promise<RenderedPage> {
      const rows = (await published()).filter(
        (row) =>
          toSlug(row.league_name) === args.league_slug &&
          seasonSlug(row.first_published_at) === args.season_slug &&
          toSlug(row.type_name) === args.type_slug,
      );
      return listing(`${args.league_slug} / ${args.season_slug} / ${args.type_slug}`, rows);
    },

    async renderArticlePage(args: {
      league_slug: string;
      season_slug: string;
      type_slug: string;
      slug: string;
    }): Promise<RenderedPage> {
      const row = (await published()).find(
        (candidate) =>
          candidate.slug === args.slug &&
          toSlug(candidate.league_name) === args.league_slug &&
          seasonSlug(candidate.first_published_at) === args.season_slug &&
          toSlug(candidate.type_name) === args.type_slug,
      );
      if (row === undefined) {
        return notFound();
      }
      const view = viewOf(row);
      const jsonLd = buildStructuredData(view, opts.siteOrigin);
      const head = [
        `<link rel="canonical" href="${opts.siteOrigin}${articlePath(view)}"/>`,
        `<meta property="og:image" content="${escape(view.cover_image_url)}"/>`,
        `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
      ].join('');
      const hero = view.cover_image_url
        ? `<figure class="hero"><img src="${escape(view.cover_image_url)}" alt="${escape(row.title)}"/><div class="scrim"></div><h1>${escape(row.title)}</h1></figure>`
        : `<h1 class="title-only">${escape(row.title)}</h1>`;

      // AC-14's timestamps double as the update indicator: first_published_at
      // never moves after the first publish, so it and published_at diverging
      // is exactly "this article has been updated since it first went live".
      const updated =
        view.published_at === view.first_published_at
          ? ''
          : ` <span class="sep">·</span> Mis à jour le ${formatDateTime(view.published_at)}`;
      const meta = [
        '<p class="meta">',
        `<span class="author">${escape(row.writer_display_name)}</span>`,
        '<span class="sep">·</span>',
        `Publié le ${formatDateTime(view.first_published_at)}`,
        updated,
        '</p>',
      ].join('');

      // Defence in depth (H1): publish sanitises what it stores, and this pass
      // sanitises again, so a row poisoned another way — a direct PostgREST
      // PATCH, a row written before publish sanitised — still cannot execute in
      // a visitor's browser.
      const articleBody = `<div class="body">${sanitizePastedHtml(row.body_html)}</div>`;
      const body = `<main data-article-title="${escape(row.title)}">${hero}${meta}${articleBody}</main>`;
      return { html: page(row.title, head, body), json_ld: [jsonLd] };
    },

    /**
     * Backs the legacy flat `/articles/{slug}` route's redirect to its real
     * nested path — deliberately looks up by bare slug alone (unlike
     * `renderArticlePage`, which now also checks the league/season/type
     * prefix), since a legacy URL never carried one to check.
     */
    async resolvePublishedPath(args: { slug: string }): Promise<string | null> {
      const row = (await published()).find((candidate) => candidate.slug === args.slug);
      return row === undefined ? null : articlePath(viewOf(row));
    },

    /** AC-14: every published article, and nothing that is still a draft. */
    async renderSitemap(): Promise<string> {
      const entries = (await published()).map((row) => {
        const view = viewOf(row);
        return `<url><loc>${opts.siteOrigin}${articlePath(view)}</loc><lastmod>${view.published_at.slice(0, 10)}</lastmod></url>`;
      });
      return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`;
    },

    async close(): Promise<void> {
      await client.end();
    },
  };
}
