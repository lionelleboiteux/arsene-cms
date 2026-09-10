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
.home-socials{display:flex;gap:.6rem;align-items:center}
.home-socials img{width:22px;height:22px;display:block}
/* Desktop only (per the request this was scoped to): three true columns so
   the league pills sit centered on the row as a whole, not just centered in
   whatever space is left after the brand — a plain flex row can't do that,
   since "space left after a left-aligned block" isn't the same as "the row's
   own center" unless the trailing block (socials) happens to match the
   brand's width exactly. Below this width, stays the original single-row
   flex-wrap (brand, pills, socials stack/wrap in DOM order). */
@media (min-width:860px){
  .home-header-top{display:grid;grid-template-columns:1fr auto 1fr}
  .home-header-top .home-brand{justify-self:start}
  .home-header-top .home-pills{justify-self:center}
  .home-header-top .home-socials{justify-self:end}
}
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
.home-tool-slots{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.home-tool-link{flex:1;min-width:140px;height:44px;border-radius:var(--h-radius-pill);
  display:flex;align-items:center;justify-content:center;text-align:center;text-decoration:none;
  font-family:var(--h-font-display);font-weight:700;font-size:13px;color:var(--h-blue-700);
  box-shadow:inset 0 0 0 1.5px var(--h-blue-700)}
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
 * The home page's own header carries these directly (`homePage()`) rather
 * than waiting on `<fc-nav>` to render them client-side — the home page
 * doesn't mount `<fc-nav>` at all (`showFcNav`, `page()`'s own doc comment).
 * Copied verbatim from `fc-shared/nav.js`'s own `SOCIALS` array — same
 * labels, urls and inlined-data-URI icons — so this stays visually
 * identical to what every sibling site's shared nav already shows.
 */
const HOME_SOCIALS: { label: string; url: string; icon: string }[] = [
  {
    label: 'Bluesky',
    url: 'https://bsky.app/profile/fantasycoachfr.bsky.social',
    icon: 'data:image/png;base64,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',
  },
  {
    label: 'Mastodon',
    url: 'https://mastodon.social/@FantasyCoachFR',
    icon: 'data:image/png;base64,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',
  },
  {
    label: 'X',
    url: 'https://x.com/FantasyCoach_FR',
    icon: 'data:image/png;base64,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',
  },
];

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
    // A dedicated square asset, not the header logo directly: the shield
    // mark is portrait (taller than wide), and browsers force favicons into
    // a square slot — reusing the header logo there squished it.
    '<link rel="icon" type="image/png" href="/assets/favicon.png"/>',
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
    const socials = HOME_SOCIALS.map(
      (s) =>
        `<a href="${escape(s.url)}" aria-label="${escape(s.label)}" target="_blank" rel="noopener"><img src="${s.icon}" alt="${escape(s.label)}"/></a>`,
    ).join('');

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
      `<div class="home-socials">${socials}</div>`,
      '</div>',
      `<div class="home-header-sub"><nav class="home-pills">${formatPills}</nav></div>`,
      '</header>',
      '<div class="home-body">',
      '<div class="home-col-main">',
      heroCard,
      '<div class="home-card home-tool">',
      '<div class="home-card-title">🛠 Outil pour la Ligue 1</div>',
      '<div class="home-tool-slots">',
      '<a class="home-tool-link" href="https://l1.dnp.fantasy-coach.fr/">Indisponibles / DNP</a>',
      '<a class="home-tool-link" href="https://l1.compos.fantasy-coach.fr/">Compos probables</a>',
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
