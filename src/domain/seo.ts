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
  /** Ordinal order, always at least one name — see `article_authors`
   *  (`db/migrations/0009_article_authors.sql`). */
  author_names: string[];
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

/**
 * Aug (UTC month index 7) starts a season; Jul ends it — e.g. any date from
 * 2026-08-01T00:00:00Z through 2027-07-31T23:59:59Z is season "26-27".
 * Deliberately UTC (`getUTCMonth`/`getUTCFullYear`, not the local-time
 * equivalents): this runs inside both a Deno Edge Function and Vitest, and
 * `PublishedArticleView` timestamps are always UTC ISO strings, so a
 * host-timezone-dependent boundary would put the same article in a
 * different season depending on where the process happens to run.
 */
export function seasonSlug(date: Date): string {
  const twoDigit = (year: number): string => String(((year % 100) + 100) % 100).padStart(2, '0');
  const startYear = date.getUTCMonth() >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${twoDigit(startYear)}-${twoDigit(startYear + 1)}`;
}

type PathLocation = { league_name: string; type_name: string; first_published_at: string };

/** The public path a category is served at: /articles/{league}/{season}/{type}. */
export function categoryPath(category: PathLocation): string {
  return `/articles/${toSlug(category.league_name)}/${seasonSlug(new Date(category.first_published_at))}/${toSlug(category.type_name)}`;
}

/** The public path an article is served at: /articles/{league}/{season}/{type}/{slug}. */
export function articlePath(article: PathLocation & { slug: string }): string {
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
  article: PathLocation & { slug: string },
  origin: string = SITE_ORIGIN,
): string {
  return `${origin}${articlePath(article)}`;
}

/** AC-14: schema.org JSON-LD embedded verbatim in the published page. */
export function buildStructuredData(
  article: PublishedArticleView,
  origin: string = SITE_ORIGIN,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.title,
    image: [article.cover_image_url],
    datePublished: article.first_published_at,
    dateModified: article.published_at,
    // schema.org's `author` accepts either shape — a single object for one
    // credited writer (every existing published article, and the common
    // case going forward) or an array once there's more than one, rather
    // than always wrapping in an array and changing every existing
    // article's JSON-LD shape for no reason.
    author:
      article.author_names.length <= 1
        ? { '@type': 'Person', name: article.author_names[0] ?? '' }
        : article.author_names.map((name) => ({ '@type': 'Person', name })),
    mainEntityOfPage: canonicalUrl(article, origin),
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
