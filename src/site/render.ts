/**
 * The public site's render pass (AC-06, AC-11, AC-14). AC-12 ("homepage:
 * reverse chronological across leagues") is superseded by `homePage()` —
 * the home page is now a curated portal with one hero article, a
 * deliberate, user-confirmed redesign (see `pdlc/arsene-cms/traceability.md`
 * for AC-12's original text; that matrix wasn't amended as part of this
 * change, since it's a separately gated PDLC artifact).
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
  /** Ordinal order from `article_authors` — always at least one entry
   *  (`insertDraft` credits the creator, and migration 0009 backfilled
   *  every pre-existing article; `src/api/repo.ts`'s own comment has the
   *  full story). `avatar_url` is each author's most recent *ready*
   *  `writer_avatars` row (0010), or `null` if they never set one. */
  authors: { name: string; avatar_url: string | null }[];
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
         coalesce(
           (select json_agg(json_build_object(
                     'name', w.display_name,
                     'avatar_url', (select wa.optimized_url
                                      from writer_avatars wa
                                     where wa.writer_id = w.id and wa.status = 'ready'
                                     order by wa.created_at desc
                                     limit 1)
                   ) order by aa.ordinal)
              from article_authors aa
              join writers w on w.id = aa.writer_id
             where aa.article_id = a.id),
           '[]'::json
         ) as authors,
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

/** "il y a 2 heures" / "hier" / "la semaine dernière" — for listing cards'
 *  byline row, where the full timestamp (`formatDateTime`, still used on the
 *  article page itself) would be too long to sit next to a title. Computed
 *  at render time against `now`, same as everything else on this page —
 *  there's no static caching layer in front of it (`no-store` end to end,
 *  `public-site/functions/[[path]].ts`'s own doc comment has the history of
 *  why that's load-bearing, not incidental). */
const relativeTimeFormatter = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];
function relativeTime(iso: string, now: Date = new Date()): string {
  const diffSeconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  for (const [unit, secondsPerUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= secondsPerUnit) {
      return relativeTimeFormatter.format(-Math.round(diffSeconds / secondsPerUnit), unit);
    }
  }
  return relativeTimeFormatter.format(-diffSeconds, 'second');
}

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
/* Homepage/league/category listings match pronos's own pages — always
   light, regardless of device preference. Only the article page itself
   (page()'s own forceLight=false) still follows prefers-color-scheme. */
body.force-light{--bg:#fff;--fg:#16181c;--muted:#6b7280;--card-bg:#f4f4f5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.55;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:inherit}
/* fc-nav's own injected CSS (fc-shared/nav.js) gives .site-banner a
   margin:0 -1rem bleed, assuming a host page with padding:0 1rem it's
   cancelling out — pronos/DNP/compos all have that. This page's body has
   none (padding lives on the inner content blocks instead, deliberately,
   so it stays untouched), so left as-is the bleed would push the banner
   past the viewport edge and cause horizontal scroll. This selector is
   more specific than nav.js's own .site-banner rule, so it wins regardless
   of which <style> tag the cascade sees second. */
body>fc-nav.site-banner{margin:0 0 1.5rem}
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
.author-name{display:inline-flex;align-items:center}
.author-avatar{width:1.4em;height:1.4em;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:.35em}
.author-avatar-placeholder{display:inline-flex;align-items:center;justify-content:center;
  background:var(--card-bg);color:var(--muted);font-size:.75em;font-weight:700}
.body{padding:1.25rem 1.25rem 3rem;font-size:1.08rem}
.body img{max-width:100%;height:auto;border-radius:8px;margin:.5rem 0}
h2.section-title{max-width:900px;margin:1.5rem auto .25rem;padding:0 1rem;font-size:1.15rem}
ul.articles{list-style:none;margin:0;padding:1rem;display:grid;gap:1rem;max-width:900px;margin-inline:auto}
.article-card{background:var(--card-bg);border-radius:12px;overflow:hidden}
.article-card a{display:flex;align-items:center;gap:.9rem;padding:.85rem 1rem;text-decoration:none}
.article-card-text{flex:1 1 auto;min-width:0}
.article-card-title{margin:0 0 .3rem;font-size:1rem;font-weight:700;line-height:1.35}
.article-card-byline{margin:0;color:var(--muted);font-size:.85rem}
.article-card-cover{flex:none;width:76px;height:76px;object-fit:cover;border-radius:10px}
p.empty{padding:2rem;color:var(--muted)}
/* Same specificity fight as the .site-banner bleed fix above: nav.js's own
   injected stylesheet carries ".site-nav a{text-decoration:none;font-weight:600}",
   equal specificity to a single-class selector here and loaded after this
   page's own <style>, so a tied selector loses on source order. Confirmed
   directly against the live page (2026-09-08): the class was landing
   correctly, but the underline/bold never rendered until this selector
   carried one more element than nav.js's own. */
fc-nav .fc-nav-current-league>a{text-decoration:underline;text-underline-offset:.25em;font-weight:800}
`;

/**
 * The home page's bespoke portal layout (Claude Design project
 * `563f076f-5b3e-4079-a568-20ff812fa41d`, wireframe `3a` / `ui_kits/website/Home.jsx`) —
 * a one-off, deliberately not merged into `SITE_CSS`. Every custom property
 * is scoped under `.home-page` rather than `:root`, and every rule is
 * prefixed `.home-page`, so this can't collide with or leak into the
 * listing/article templates above, which keep their current look untouched.
 * Values are the design tokens (`tokens/{colors,typography,spacing}.css`)
 * copied straight across — `Header`/`Card`/`Button`/`Pill`'s own inline
 * styles translated one-to-one into classes, since this file has no
 * JSX/React runtime to run those components directly.
 */
const HOME_PAGE_CSS = `
.home-page{
  --h-blue-100:#eaf3ff;--h-blue-300:#5da8e8;--h-blue-500:#3d84c9;--h-blue-600:#2f6fb0;
  --h-blue-700:#1f5fa8;--h-blue-900:#173a5e;--h-red-500:#e2362e;--h-gray-100:#f4f7fb;
  --h-gray-300:#e0e6ec;--h-gray-500:#8a97a6;--h-gray-600:#5b6b80;--h-white:#fff;
  --h-font-display:'Baloo 2','Poppins',system-ui,sans-serif;
  --h-font-body:'Inter',system-ui,-apple-system,sans-serif;
  --h-radius-md:6px;--h-radius-pill:20px;--h-shadow-card:0 1px 4px rgba(15,23,32,.1);
  background:var(--h-gray-100);font-family:var(--h-font-body);color:var(--h-blue-900);
}
.home-header-top{background:linear-gradient(180deg,var(--h-blue-300),var(--h-blue-500));
  padding:16px 28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.home-brand{display:flex;align-items:center;gap:14px}
.home-logo{height:52px;display:block}
.home-tagline{color:var(--h-blue-100,#eaf3ff);font-family:var(--h-font-body);font-size:14px}
.home-pills{display:flex;gap:10px;flex-wrap:wrap}
.home-pill{display:inline-flex;align-items:center;font-family:var(--h-font-display);font-weight:700;
  border-radius:var(--h-radius-pill);text-decoration:none;padding:6px 14px;font-size:13px;
  background:transparent;color:var(--h-white)}
.home-pill.active{background:var(--h-white);color:var(--h-blue-700)}
.home-header-sub{background:var(--h-blue-600);padding:8px 28px;display:flex;gap:8px;
  border-bottom:3px solid var(--h-red-500);flex-wrap:wrap}
.home-pill-sm{display:inline-flex;align-items:center;font-family:var(--h-font-display);font-weight:700;
  border-radius:var(--h-radius-pill);text-decoration:none;padding:4px 12px;font-size:12px;
  background:transparent;color:var(--h-white)}
.home-pill-sm.active{background:var(--h-red-500);color:var(--h-white)}
.home-body{display:flex;padding:24px;gap:24px;flex-wrap:wrap;max-width:1100px;margin:0 auto}
.home-col-main{flex:2 1 420px;display:flex;flex-direction:column;gap:16px}
.home-col-side{flex:1 1 260px;display:flex;flex-direction:column;gap:12px}
.home-card{background:var(--h-white);border-radius:var(--h-radius-md);box-shadow:var(--h-shadow-card);
  padding:16px;display:block;text-decoration:none;color:inherit}
.home-hero{display:flex;gap:16px;flex-wrap:wrap}
.home-hero-img{width:180px;height:120px;flex:none;border-radius:4px;object-fit:cover;
  background:repeating-linear-gradient(45deg,#e7eef7,#e7eef7 6px,#d3e0f0 6px,#d3e0f0 12px)}
.home-eyebrow{font-size:12px;color:var(--h-red-500);font-weight:700;text-transform:uppercase}
.home-headline{font-family:var(--h-font-display);font-size:24px;font-weight:700;color:var(--h-blue-900);margin:4px 0}
.home-subtitle{font-size:14px;color:var(--h-gray-600);margin:0}
.home-btn{display:inline-block;margin-top:10px;font-family:var(--h-font-display);font-weight:700;
  border:none;border-radius:var(--h-radius-pill);padding:6px 14px;font-size:13px;
  background:var(--h-red-500);color:var(--h-white)}
.home-btn-ghost{background:var(--h-blue-700)}
.home-card-title{font-family:var(--h-font-display);font-weight:700;color:var(--h-blue-900);font-size:16px}
.home-tool-slots{display:flex;gap:8px;margin-top:10px}
.home-tool-slot{flex:1;height:44px;background:var(--h-gray-100);border-radius:4px;
  display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--h-gray-600)}
.home-cta{background:var(--h-red-500)}
.home-cta-title{color:var(--h-white)}
.home-cta-sub{font-size:13px;margin-top:4px;color:var(--h-white)}
.home-muted-text{font-size:13px;color:var(--h-gray-600)}
.home-shortcut{font-size:13px;color:var(--h-blue-900);font-weight:700}
`;

/** French-locale, so "Étoile" sorts next to "Everton" rather than after "Z" —
 *  every type/league name on this site is French. */
const nameCollator = new Intl.Collator('fr');

/**
 * The two systematic ways a Wix post's own slug differs from the slug it
 * was imported into Arsène under (`.claude/skills/import-wix-articles/`) —
 * not random, so a short ordered list of transforms resolves an old
 * bookmark without a hand-maintained per-post mapping table:
 *  - a dedup suffix Wix appends (`player-picks-ligue-1-j1-4` → Arsène's
 *    `player-picks-ligue-1-j1`)
 *  - a season infix Wix inserts (`player-picks-26-27-premier-league-j1` →
 *    Arsène's `player-picks-premier-league-j1`)
 * `resolveWixPostPath` tries the bare slug first, then each of these in
 * order; a slug still unresolved after all of them is real Wix archive
 * that was never migrated (most of it — see that skill's own numbers), and
 * gets a real 404 rather than a guess.
 */
const WIX_SLUG_NORMALIZATIONS: ((slug: string) => string)[] = [
  (slug) => slug.replace(/-\d+$/, ''),
  (slug) => slug.replace(/-\d\d-\d\d-/, '-'),
  (slug) => slug.replace(/-\d+$/, '').replace(/-\d\d-\d\d-/, '-'),
];

/** A small round avatar next to a name — the writer's most recent *ready*
 *  upload (0010), or a plain initial-letter circle when they never set
 *  one. Never a broken `<img>`: a `null` avatar_url renders no `<img>` at
 *  all. */
function authorAvatarHtml(author: { name: string; avatar_url: string | null }): string {
  if (author.avatar_url === null) {
    const initial = author.name.trim().charAt(0).toUpperCase() || '?';
    return `<span class="author-avatar author-avatar-placeholder">${escape(initial)}</span>`;
  }
  return `<img class="author-avatar" src="${escape(author.avatar_url)}" alt=""/>`;
}

/** "Alice", "Alice et Bob", "Alice, Bob et Charlie" — a French-style list
 *  join for a byline, in `article_authors`' own ordinal order (already the
 *  order `PUBLISHED_ARTICLES_SQL`'s `json_agg` produced it in), each name
 *  preceded by its own avatar. */
function authorsHtml(authors: { name: string; avatar_url: string | null }[]): string {
  const parts = authors.map(
    (author) => `<span class="author-name">${authorAvatarHtml(author)}${escape(author.name)}</span>`,
  );
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} et ${parts[parts.length - 1]}`;
}

function viewOf(row: ArticleRow): PublishedArticleView {
  return {
    article_id: row.id,
    title: row.title,
    slug: row.slug,
    league_name: row.league_name,
    type_name: row.type_name,
    // JSON-LD stays name-only (schema.org's Person.image is explicitly
    // deferred — the user asked for the byline, not structured data).
    author_names: row.authors.map((author) => author.name),
    cover_image_url: row.cover_image_url ?? '',
    published_at: row.published_at.toISOString(),
    first_published_at: row.first_published_at.toISOString(),
  };
}

/** AC-06: listings show the cover image and never a body image. Compact
 *  row layout — title and byline on the left, a small square thumbnail on
 *  the right — rather than a full-width hero per card, so a listing of many
 *  articles (a whole league, across every type) stays scannable. */
function articleCard(row: ArticleRow): string {
  const cover =
    row.cover_image_url === null
      ? ''
      : `<img src="${escape(row.cover_image_url)}" alt="${escape(row.title)}" class="article-card-cover"/>`;
  return [
    `<li class="article-card" data-article-title="${escape(row.title)}">`,
    `<a href="${articlePath(viewOf(row))}">`,
    '<div class="article-card-text">',
    `<h3 class="article-card-title">${escape(row.title)}</h3>`,
    `<p class="article-card-byline">${authorsHtml(row.authors)} · ${relativeTime(row.published_at.toISOString())}</p>`,
    '</div>',
    cover,
    '</a>',
    '</li>',
  ].join('');
}

/**
 * The fantasy-coach.fr sibling sites (pronos, DNP, compos) all share their
 * nav/ads/feedback through `fc-shared` (a separate repo,
 * github.com/lionelleboiteux/fc-shared) — dependency-free Web Components
 * pulled straight from jsDelivr, no build step, matching this file's own
 * "plain HTML string, no framework" shape exactly. `nav.js` defines
 * `<fc-nav>`; `ads.js` is the AdSense + consent loader, same publisher ID
 * across every site. Pinned to `@main` (not a version tag) like every
 * other sibling site, so a `nav.js` edit over there reaches this site too,
 * on jsDelivr's ~12h branch-ref cache.
 */
const FC_SHARED_HEAD = [
  '<script src="https://cdn.jsdelivr.net/gh/lionelleboiteux/fc-shared@main/nav.js" defer></script>',
  '<script src="https://cdn.jsdelivr.net/gh/lionelleboiteux/fc-shared@main/ads.js" async></script>',
].join('');

/**
 * `<fc-nav>`'s own `current` attribute only names which *site* in the
 * fantasy-coach.fr family is active (`current="arsene"`, above) — it has no
 * concept of which league's dropdown item should read as active, and
 * `fc-shared` is a separate repo this project doesn't own, so that can't be
 * added at the source. `nav.js` also builds its dropdown markup
 * asynchronously after the custom element upgrades (confirmed empirically:
 * it's not there on `DOMContentLoaded`), so this can't just run once and
 * give up — it polls briefly for `<fc-nav>` to have populated, then matches
 * a dropdown link by its own visible text against `data-current-league`
 * (set below, in French, exactly as `arsene_leagues.name` stores it —
 * that's also exactly what `nav.js` renders as each link's text), not by
 * `href`: the dropdown's hrefs still point at the pre-Arsène fantasy-coach.fr
 * paths (`/ligue1`, not `/articles/ligue-1`), so matching on those would
 * silently break the moment fc-shared's own URLs change, for a purely
 * cosmetic feature that has no business depending on them at all.
 */
const NAV_CURRENT_LEAGUE_SCRIPT = `<script>(function(){
  var league = document.body.dataset.currentLeague;
  if (!league) return;
  var norm = function(s){ return s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().trim(); };
  var target = norm(league);
  var mark = function(){
    var nav = document.querySelector('fc-nav');
    if (!nav) return false;
    var links = nav.querySelectorAll('.nav-item > a');
    var found = false;
    links.forEach(function(a){
      if (norm(a.textContent) === target) {
        var item = a.closest('.nav-item');
        if (item) item.classList.add('fc-nav-current-league');
        found = true;
      }
    });
    return found;
  };
  if (mark()) return;
  var attempts = 0;
  var poll = setInterval(function(){
    attempts += 1;
    if (mark() || attempts > 30) clearInterval(poll);
  }, 100);
})();</script>`;

/**
 * `NAV_CURRENT_LEAGUE_SCRIPT` matches by nav.js's own *visible* dropdown
 * text, not `href` (its own doc comment above has the full reasoning) —
 * which breaks the moment a league's nav label diverges from
 * `arsene_leagues.name`. Currently only Premier League does: fc-shared's
 * `nav.js` renders its dropdown entry as `{ id: 'fpl', label: 'FPL', ... }`,
 * confirmed live (`cdn.jsdelivr.net/gh/lionelleboiteux/fc-shared@main/nav.js`),
 * so "Premier League" (what this app calls it everywhere else — SEO, URLs,
 * bylines) never matched "FPL" and the nav item silently never highlighted.
 * Translated only here, at the one place `data-current-league` is set, so
 * every other subsystem keeps using the real league name untouched.
 */
const NAV_LABEL_OVERRIDES: Record<string, string> = {
  'Premier League': 'FPL',
};

/** `forceLight` defaults on: every listing page (`listing()`, `leagueListing()`,
 *  `notFound()`) matches pronos's always-light background. Only
 *  `renderArticlePage` opts out, so reading an article still follows the
 *  visitor's own device preference.
 *
 *  `showFcNav` defaults on too. The home page (`homePage()`) is the one
 *  exception: its own two-tier header stands in for site navigation there,
 *  so stacking the shared `fc-shared` banner on top of it would just double
 *  up navigation on the one page that has its own. `NAV_CURRENT_LEAGUE_SCRIPT`
 *  is a safe no-op either way — the home page never sets `data-current-league`. */
function page(
  title: string,
  head: string,
  body: string,
  currentLeague?: string,
  forceLight = true,
  showFcNav = true,
): string {
  const navLabel = currentLeague === undefined ? undefined : (NAV_LABEL_OVERRIDES[currentLeague] ?? currentLeague);
  const bodyAttrs =
    (navLabel === undefined ? '' : ` data-current-league="${escape(navLabel)}"`) +
    (forceLight ? ' class="force-light"' : '');
  return [
    '<!doctype html><html lang="fr"><head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<title>${escape(title)}</title>`,
    '<link rel="icon" type="image/png" href="/assets/logo.png"/>',
    `<style>${SITE_CSS}</style>`,
    FC_SHARED_HEAD,
    head,
    '</head>',
    `<body${bodyAttrs}>`,
    showFcNav ? '<fc-nav current="arsene"></fc-nav>' : '',
    body,
    NAV_CURRENT_LEAGUE_SCRIPT,
    '</body></html>',
  ].join('');
}

export async function createSiteRenderer(opts: { databaseUrl: string; siteOrigin: string; cdnOrigin: string }) {
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();

  const published = async (): Promise<ArticleRow[]> =>
    (await client.query<ArticleRow>(PUBLISHED_ARTICLES_SQL)).rows;

  const listing = (title: string, rows: ArticleRow[], currentLeague?: string): RenderedPage => {
    const first = rows[0];
    const head =
      first?.cover_image_url == null
        ? ''
        : `<meta property="og:image" content="${escape(first.cover_image_url)}"/>`;
    const body =
      rows.length === 0
        ? '<p class="empty">No articles yet</p>'
        : `<ul class="articles">${rows.map(articleCard).join('')}</ul>`;
    return { html: page(title, head, body, currentLeague), json_ld: [] };
  };

  const notFound = (): RenderedPage => ({
    html: page('Introuvable', '', '<p class="empty">No articles yet</p>'),
    json_ld: [],
  });

  /** A whole league's published articles, across every season and type —
   *  `renderCategoryPage`'s listing is scoped to one (league, season, type)
   *  triple, this is the "everything for this league" entry point. Grouped
   *  under a heading per type only once there is more than one distinct
   *  type among the results; a league that only ever runs one content type
   *  gets the same flat list `listing()` already produces elsewhere, rather
   *  than a redundant single-section heading. */
  const leagueListing = (title: string, rows: ArticleRow[]): RenderedPage => {
    const first = rows[0];
    const head =
      first?.cover_image_url == null
        ? ''
        : `<meta property="og:image" content="${escape(first.cover_image_url)}"/>`;
    if (rows.length === 0) {
      return { html: page(title, head, '<p class="empty">No articles yet</p>', title), json_ld: [] };
    }
    const types = [...new Set(rows.map((row) => row.type_name))].sort(nameCollator.compare);
    const body =
      types.length <= 1
        ? `<ul class="articles">${rows.map(articleCard).join('')}</ul>`
        : types
            .map((type) => {
              const group = rows.filter((row) => row.type_name === type);
              return `<h2 class="section-title">${escape(type)}</h2><ul class="articles">${group.map(articleCard).join('')}</ul>`;
            })
            .join('');
    // `title` is always the league's own display name here (`renderLeaguePage`
    // passes `league.name` straight through), so it doubles as the value the
    // nav-highlight script (`NAV_CURRENT_LEAGUE_SCRIPT`) matches against.
    return { html: page(title, head, body, title), json_ld: [] };
  };

  /** The game-format sub-nav row. LCDE/MPG link into Ligue 1's current
   *  season — the home page has no other league/season context to anchor a
   *  format shortcut to, and Ligue 1 is ~70% of this site's traffic (the
   *  design project's own readme). Pronos isn't an Arsène content type at
   *  all — it's the separate pronos.fantasy-coach.fr site — so it links
   *  there directly instead of into a `/articles/...` route. */
  const currentLigue1Season = (): string => `/articles/ligue-1/${seasonSlug(new Date())}`;
  const HOME_FORMAT_PILLS = (): { label: string; href: string }[] => [
    { label: 'LCDE', href: `${currentLigue1Season()}/lcde` },
    { label: 'MPG', href: `${currentLigue1Season()}/mpg` },
    { label: 'Pronos', href: 'https://pronos.fantasy-coach.fr' },
  ];

  /** League pills follow a fixed priority order (business call, not
   *  alphabetical) — the leagues this site actually covers, biggest
   *  audience first, per the design project's own readme. Any league not
   *  in this list (there shouldn't be any today) falls back to the end,
   *  alphabetically among themselves, rather than being dropped. */
  const HOME_LEAGUE_ORDER = ['Ligue 1', 'Premier League', 'Bundesliga', 'Eliteserien', 'Allsvenskan'];
  const homeLeagueSort = (a: { name: string }, b: { name: string }): number => {
    const ai = HOME_LEAGUE_ORDER.indexOf(a.name);
    const bi = HOME_LEAGUE_ORDER.indexOf(b.name);
    if (ai === -1 && bi === -1) return nameCollator.compare(a.name, b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  };

  /** The portal home page (Claude Design project `563f076f-…`, wireframe
   *  `3a` / `ui_kits/website/Home.jsx`) — one hero article, not a listing.
   *  `hero` is `undefined` only when nothing has ever been published yet;
   *  the rest of the portal (header, tool teaser, sidebar) still renders. */
  const homePage = (hero: ArticleRow | undefined, leagues: { name: string }[]): RenderedPage => {
    const head = [
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;700;800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">',
      `<style>${HOME_PAGE_CSS}</style>`,
    ].join('');

    // The header's active pills track the hero, not a hardcoded default:
    // today the hero is always Ligue 1 Player Picks (see `renderHomepage()`),
    // which is the LCDE weekly format under the hood (`readme.md`'s own
    // "LCDE ... weekly articles" description is exactly the Player Picks
    // type), so both read off `hero` rather than being pinned in markup.
    const leaguePills = leagues
      .map((league) => {
        const active = hero !== undefined && league.name === hero.league_name;
        return `<a class="home-pill${active ? ' active' : ''}" href="/articles/${toSlug(league.name)}">${escape(league.name)}</a>`;
      })
      .join('');
    const formatPills = HOME_FORMAT_PILLS()
      .map((format) => {
        const active = format.label === 'LCDE' && hero !== undefined && hero.type_name === 'Player Picks';
        return `<a class="home-pill-sm${active ? ' active' : ''}" href="${format.href}">${escape(format.label)}</a>`;
      })
      .join('');

    const heroCard =
      hero === undefined
        ? ''
        : [
            `<a class="home-card home-hero" href="${articlePath(viewOf(hero))}">`,
            hero.cover_image_url === null
              ? '<div class="home-hero-img"></div>'
              : `<img class="home-hero-img" src="${escape(hero.cover_image_url)}" alt="${escape(hero.title)}"/>`,
            '<div>',
            `<div class="home-eyebrow">${escape(`${hero.league_name} · ${hero.type_name}`)}</div>`,
            `<h1 class="home-headline">${escape(hero.title)}</h1>`,
            '<p class="home-subtitle">Article hebdo — mis à jour chaque semaine</p>',
            '<span class="home-btn">Lire l’article</span>',
            '</div>',
            '</a>',
          ].join('');

    const body = [
      '<div class="home-page">',
      '<header class="home-header">',
      '<div class="home-header-top">',
      '<div class="home-brand">',
      '<img class="home-logo" src="/assets/logo.png" alt="Fantasy Coach"/>',
      '<span class="home-tagline">La référence Fantasy Foot</span>',
      '</div>',
      `<nav class="home-pills">${leaguePills}</nav>`,
      '</div>',
      `<div class="home-header-sub"><nav class="home-pills">${formatPills}</nav></div>`,
      '</header>',
      '<div class="home-body">',
      '<div class="home-col-main">',
      heroCard,
      '<div class="home-card home-tool">',
      '<div class="home-card-title">🛠 Outil — Absents &amp; compos probables L1</div>',
      '<div class="home-tool-slots">',
      '<div class="home-tool-slot">équipe A</div>',
      '<div class="home-tool-slot">équipe B</div>',
      '</div>',
      '</div>',
      '</div>',
      '<div class="home-col-side">',
      '<a class="home-card home-cta" href="https://pronos.fantasy-coach.fr">',
      '<div class="home-card-title home-cta-title">🎯 Pronos</div>',
      '<div class="home-cta-sub">5 ligues couvertes — joue vite</div>',
      '<span class="home-btn home-btn-ghost">Jouer</span>',
      '</a>',
      '<div class="home-card"><div class="home-muted-text">MPG — dernier bilan (peu fréquent)</div></div>',
      `<a class="home-card home-shortcut" href="/articles/${toSlug('Premier League')}">Raccourci Premier League →</a>`,
      `<a class="home-card home-shortcut" href="/articles/${toSlug('Bundesliga')}">Raccourci Bundesliga →</a>`,
      '</div>',
      '</div>',
      '</div>',
    ].join('');

    return { html: page('Fantasy Coach', head, body, undefined, true, false), json_ld: [] };
  };

  return {
    async renderHomepage(): Promise<RenderedPage> {
      const [rows, leaguesResult] = await Promise.all([
        published(),
        client.query<{ name: string }>('select name from arsene_leagues'),
      ]);
      const leagues = [...leaguesResult.rows].sort(homeLeagueSort);
      // The hero is always Ligue 1's most recent Player Picks (LCDE) piece —
      // the site's flagship weekly content, not just whatever published most
      // recently across every league/type. `rows` is already `published_at
      // desc` (`PUBLISHED_ARTICLES_SQL`), so the first match is the newest.
      const hero = rows.find((row) => row.league_name === 'Ligue 1' && row.type_name === 'Player Picks');
      return homePage(hero, leagues);
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
      return listing(
        `${args.league_slug} / ${args.season_slug} / ${args.type_slug}`,
        rows,
        rows[0]?.league_name,
      );
    },

    /**
     * `/articles/{league_slug}` — every published article in the league,
     * grouped by type when there's more than one. Returns `null` rather
     * than an empty listing when `league_slug` doesn't match a real league
     * at all, so the router can fall back to the legacy flat-slug lookup
     * that also lives at a single path segment under `/articles/` — a
     * league that's real but currently has zero published articles still
     * gets its own "No articles yet" page rather than falling through.
     */
    async renderLeaguePage(args: { league_slug: string }): Promise<RenderedPage | null> {
      const leagues = await client.query<{ name: string }>('select name from arsene_leagues');
      const league = leagues.rows.find((row) => toSlug(row.name) === args.league_slug);
      if (league === undefined) return null;

      const rows = (await published()).filter((row) => toSlug(row.league_name) === args.league_slug);
      return leagueListing(league.name, rows);
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
        `<span class="author">${authorsHtml(row.authors)}</span>`,
        '<span class="sep">·</span>',
        `Publié le ${formatDateTime(view.first_published_at)}`,
        updated,
        '</p>',
      ].join('');

      // Defence in depth (H1): publish sanitises what it stores, and this pass
      // sanitises again, so a row poisoned another way — a direct PostgREST
      // PATCH, a row written before publish sanitised — still cannot execute in
      // a visitor's browser.
      const articleBody = `<div class="body">${sanitizePastedHtml(row.body_html, { allowedImageOrigin: opts.cdnOrigin })}</div>`;
      const body = `<main data-article-title="${escape(row.title)}">${hero}${meta}${articleBody}</main>`;
      return { html: page(row.title, head, body, row.league_name, false), json_ld: [jsonLd] };
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

    /** Backs `/public/post/{slug}` — an old Wix bookmark. `WIX_SLUG_NORMALIZATIONS`'
     *  own doc comment has the full reasoning; this just tries the bare slug,
     *  then each normalization in order, against one fetch of the published
     *  rows (not `resolvePublishedPath` per attempt — no reason to re-query
     *  for what's usually going to be a miss anyway). */
    async resolveWixPostPath(args: { slug: string }): Promise<string | null> {
      const rows = await published();
      const candidates = [args.slug, ...WIX_SLUG_NORMALIZATIONS.map((normalize) => normalize(args.slug))];
      for (const candidate of candidates) {
        const row = rows.find((r) => r.slug === candidate);
        if (row !== undefined) return articlePath(viewOf(row));
      }
      return null;
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
