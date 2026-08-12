/**
 * AC-13/14/15/16 — everything the spec calls "generated automatically in the
 * background". Pure functions: no DB, no network, no clock.
 */

export type MetaSuggestion = { meta_title: string; meta_description: string };

export type ArticleSeoContext = {
  title: string;
  body_text: string;
  league_name: string;
  type_name: string;
};

export type PublishedArticleView = {
  article_id: string;
  title: string;
  slug: string;
  league_name: string;
  type_name: string;
  writer_display_name: string;
  cover_image_url: string;
  published_at: string;
  first_published_at: string;
};

export type Advisory = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** Spec §9: advisory checks never block publishing, whatever the severity. */
  blocks_publish: boolean;
};

/** Canonical public origin of the site the CMS publishes to. */
export const SITE_ORIGIN = 'https://fantasycoach.example';

/** Contract limits on `PublishRequest.meta_title` / `meta_description`. */
const META_TITLE_MAX = 70;
const META_DESCRIPTION_MAX = 160;

/** Below this, the advisory check calls the article's introduction too short. */
const MIN_INTRO_CHARS = 300;

function fallbackSlug(title: string): string {
  let hash = 2_166_136_261;
  for (const char of title) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619) >>> 0;
  }
  return `article-${hash.toString(36)}`;
}

/** Lowercase, ASCII, hyphenated form of a name — the URL segment for it. */
export function toSlug(text: string): string {
  const ascii = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii.length > 0 ? ascii : fallbackSlug(text);
}

/** AC-14: URL-safe, collision-free, generated with no writer action. */
export function generateSlug(title: string, opts?: { existingSlugs?: readonly string[] }): string {
  const base = toSlug(title);
  const taken = new Set(opts?.existingSlugs ?? []);
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** AC-13: a suggestion the writer may edit before confirming publish. */
export function suggestMeta(article: ArticleSeoContext): MetaSuggestion {
  const titled = article.title.includes(article.league_name)
    ? article.title
    : `${article.title} — ${article.league_name}`;
  return {
    meta_title: truncate(titled, META_TITLE_MAX),
    meta_description: truncate(article.body_text.trim(), META_DESCRIPTION_MAX),
  };
}

/** The public path a category is served at: /{league}/{type}. */
export function categoryPath(category: { league_name: string; type_name: string }): string {
  return `/${toSlug(category.league_name)}/${toSlug(category.type_name)}`;
}

/** The public path an article is served at: /{league}/{type}/{slug}. */
export function articlePath(article: {
  league_name: string;
  type_name: string;
  slug: string;
}): string {
  return `${categoryPath(article)}/${article.slug}`;
}

/** Plain text of an article body, for meta descriptions and advisory checks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalUrl(
  article: { league_name: string; type_name: string; slug: string },
  origin: string = SITE_ORIGIN,
): string {
  return `${origin}${articlePath(article)}`;
}

/** AC-14: schema.org JSON-LD embedded verbatim in the published page. */
export function buildStructuredData(article: PublishedArticleView): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.title,
    image: [article.cover_image_url],
    datePublished: article.first_published_at,
    dateModified: article.published_at,
    author: { '@type': 'Person', name: article.writer_display_name },
    mainEntityOfPage: canonicalUrl(article),
  };
}

/** AC-14: the article's sitemap entry. */
export function buildSitemapEntry(article: PublishedArticleView): {
  loc: string;
  lastmod: string;
} {
  return {
    loc: canonicalUrl(article),
    lastmod: article.published_at.slice(0, 10),
  };
}

/** AC-15: alt text from the article's own context, never from the file name. */
export function generateAltText(ctx: {
  article_title: string;
  body_text: string;
  original_filename: string;
}): string {
  return `Illustration de l’article : ${ctx.article_title}`;
}

/** AC-16: informational only — `blocks_publish` is always false. */
export function runContentCheck(article: ArticleSeoContext): Advisory[] {
  if (article.body_text.trim().length >= MIN_INTRO_CHARS) return [];
  return [
    {
      code: 'INTRO_TOO_SHORT',
      severity: 'warning',
      message: `L’introduction fait moins de ${MIN_INTRO_CHARS} caractères : ajoutez du contexte pour le référencement.`,
      blocks_publish: false,
    },
  ];
}
