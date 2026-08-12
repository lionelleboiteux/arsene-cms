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
import {
  articlePath,
  buildStructuredData,
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

const PUBLISHED_ARTICLES_SQL = `
  select a.id, a.title, a.slug, a.body_html,
         l.name as league_name, c.name as type_name,
         w.display_name as writer_display_name,
         (select i.optimized_url
            from article_images i
           where i.article_id = a.id and i.role = 'cover' and i.status = 'ready'
           limit 1) as cover_image_url,
         a.published_at,
         coalesce(a.first_published_at, a.published_at) as first_published_at
    from articles a
    join leagues l on l.id = a.league_id
    join categories c on c.id = a.category_id
    join writers w on w.id = a.writer_id
   where a.status = 'published' and a.slug is not null
   order by a.published_at desc
`;

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    `<a href="${articlePath(viewOf(row))}">${escape(row.title)}</a>`,
    cover,
    '</li>',
  ].join('');
}

function page(title: string, head: string, body: string): string {
  return [
    '<!doctype html><html lang="fr"><head>',
    `<title>${escape(title)}</title>`,
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

  return {
    async renderHomepage(): Promise<RenderedPage> {
      return listing('Fantasy Coach', await published());
    },

    async renderCategoryPage(args: {
      league_slug: string;
      type_slug: string;
    }): Promise<RenderedPage> {
      const rows = (await published()).filter(
        (row) =>
          toSlug(row.league_name) === args.league_slug && toSlug(row.type_name) === args.type_slug,
      );
      return listing(`${args.league_slug} / ${args.type_slug}`, rows);
    },

    async renderArticlePage(args: { slug: string }): Promise<RenderedPage> {
      const row = (await published()).find((candidate) => candidate.slug === args.slug);
      if (row === undefined) {
        return { html: page('Introuvable', '', '<p class="empty">No articles yet</p>'), json_ld: [] };
      }
      const view = viewOf(row);
      const jsonLd = buildStructuredData(view);
      const head = [
        `<link rel="canonical" href="${opts.siteOrigin}${articlePath(view)}"/>`,
        `<meta property="og:image" content="${escape(view.cover_image_url)}"/>`,
        `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
      ].join('');
      const body = `<article data-article-title="${escape(row.title)}">${row.body_html}</article>`;
      return { html: page(row.title, head, body), json_ld: [jsonLd] };
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
