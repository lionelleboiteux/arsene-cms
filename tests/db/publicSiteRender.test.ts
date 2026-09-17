import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSiteRender } from '../support/seams.js';
import { seedArticle, seedCategory, seedImage, seedWriter, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * Public-site render pass against a seeded real database — 02-architecture.v1.md
 * §1: "seed a test DB, run the render pass against it, assert on output
 * HTML/JSON-LD/sitemap — no live deploy needed". No browser, no Cloudflare, no
 * network: the renderer is the unit, the database is real.
 *
 * The renderer module is loaded BEFORE a container is paid for, so at red the
 * reported reason is the most direct one available (the renderer is missing),
 * not a database detail.
 */

const SITE_ORIGIN = 'https://fantasycoach.example';
const CDN_ORIGIN = 'https://cdn.fantasycoach.example';

type Renderer = Awaited<ReturnType<Awaited<ReturnType<typeof loadSiteRender>>['createSiteRenderer']>>;

type Ctx = { db: TestDatabase; renderer: Renderer; coverUrl: string };

let started: Ctx | null = null;
let startupError: Error | null = null;

function ctx(): Ctx {
  if (startupError) throw startupError;
  return started as Ctx;
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { createSiteRenderer } = await loadSiteRender();
    db = await startTestDatabase();

    const writer = await seedWriter(db.client, 'Lionel Le Boiteux');

    // Three leagues, published at different times — originally AC-12's exact
    // setup; now also exercises the league-shortcut/pill links below.
    const ligue1 = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Pronos Ligue 1 - Journée 12',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'pronos-ligue-1-journee-12',
      published_at: '2026-08-11T10:47:12Z',
    });
    // The home page portal's hero is always Ligue 1's most recent Player
    // Picks (LCDE) article specifically, not just whatever published most
    // recently overall — this is the only Ligue 1 / Player Picks article
    // until `renderLeaguePage`'s own "groups by type" test adds a second,
    // later one below, so it's the hero for every test that runs before that.
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Player Picks, Ligue 1, J5',
      league_name: 'Ligue 1',
      type_name: 'Player Picks',
      status: 'published',
      slug: 'player-picks-ligue-1-j5',
      published_at: '2026-08-12T09:00:00Z',
    });
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Premier League : les paris du week-end',
      league_name: 'Premier League',
      type_name: 'Pronos',
      status: 'published',
      slug: 'premier-league-paris-du-week-end',
      published_at: '2026-08-10T08:00:00Z',
    });
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Mercato Bundesliga - Août',
      league_name: 'Bundesliga',
      type_name: 'Mercato',
      status: 'published',
      slug: 'mercato-bundesliga-aout',
      published_at: '2026-08-09T18:30:00Z',
    });

    // A draft, which must never surface anywhere on the public site.
    await seedArticle(db.client, {
      writer_id: writer,
      title: 'Brouillon Serie A',
      league_name: 'Serie A',
      type_name: 'Mercato',
      status: 'draft',
    });
    // An empty category — AC-11.
    await seedCategory(db.client, 'Serie A', 'Mercato');

    const coverUrl = 'https://cdn.fantasycoach.example/a1a1a1a1/cover-optimized.webp';
    await seedImage(db.client, { article_id: ligue1, role: 'cover', optimized_url: coverUrl });
    await seedImage(db.client, {
      article_id: ligue1,
      role: 'body',
      optimized_url: 'https://cdn.fantasycoach.example/a1a1a1a1/body-1-optimized.webp',
    });

    const renderer = await createSiteRenderer({
      databaseUrl: db.connectionUri,
      siteOrigin: SITE_ORIGIN,
      cdnOrigin: CDN_ORIGIN,
    });
    started = { db, renderer, coverUrl };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.renderer.close().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

describe('public site', () => {
  it('the home page portal features Ligue 1\'s most recent Player Picks article as its hero, not just whatever published most recently — supersedes AC-12\'s old "full reverse-chronological listing" requirement (pdlc/arsene-cms/traceability.md); a deliberate, confirmed redesign, not a regression', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderHomepage();

    expect({
      hero_title: page.html.match(/<h1 class="home-headline">([^<]+)<\/h1>/)?.[1],
      mentions_other_articles:
        page.html.includes('Pronos Ligue 1 - Journée 12') ||
        page.html.includes('Premier League : les paris du week-end') ||
        page.html.includes('Mercato Bundesliga - Août'),
    }).toEqual({
      hero_title: 'Player Picks, Ligue 1, J5',
      mentions_other_articles: false,
    });
  });

  it('the "derniers Player Picks" block is omitted entirely when the hero is the only Ligue 1 Player Picks article published so far — no empty card, no placeholder', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderHomepage();

    expect(page.html).not.toContain('home-picks-card');
  });

  it('the hero subtitle falls back to the old static line when the hero article has no teaser', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderHomepage();

    expect(page.html).toContain('<p class="home-subtitle">Article hebdo — mis à jour chaque semaine</p>');
  });

  it('AC-11: a category with no published article shows "No articles yet" rather than an error or a blank page', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderCategoryPage({
      league_slug: 'serie-a',
      season_slug: '26-27',
      type_slug: 'mercato',
    });

    expect({
      says_no_articles_yet: page.html.includes('No articles yet'),
      lists_nothing: [...page.html.matchAll(/data-article-title="([^"]+)"/g)].length,
    }).toEqual({ says_no_articles_yet: true, lists_nothing: 0 });
  });

  it('AC-06: the category listing and the social preview both use the cover image, and never a body image', async () => {
    const { renderer, coverUrl } = ctx();

    const page = await renderer.renderCategoryPage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
    });
    const images = [...page.html.matchAll(/https:\/\/cdn\.fantasycoach\.example\/[^"'\s]+/g)].map((m) => m[0]);
    const ogImage = page.html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];

    expect({ images: [...new Set(images)], ogImage }).toEqual({
      images: [coverUrl],
      ogImage: coverUrl,
    });
  });

  it('SEO: a category listing renders a description meta tag built from its real league/type, plus robots index/follow', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderCategoryPage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
    });

    expect({
      has_description: page.html.includes(
        '<meta name="description" content="Pronos Ligue 1 — 26-27 : les derniers articles Fantasy Coach."/>',
      ),
      has_robots: page.html.includes('<meta name="robots" content="index, follow"/>'),
    }).toEqual({ has_description: true, has_robots: true });
  });

  it('a listing card shows its teaser when the writer set one, and shows nothing extra when they didn\'t', async () => {
    const { renderer, db } = ctx();
    // Premier League / Pronos deliberately — Ligue 1 / Pronos / 26-27 is the
    // exact bucket the season-scoping test below asserts an exact article
    // list for, and this fixture must not leak into it.
    await seedArticle(db.client, {
      writer_id: await seedWriter(db.client, 'Autrice Teaser'),
      title: 'Avec teaser',
      league_name: 'Premier League',
      type_name: 'Pronos',
      status: 'published',
      slug: 'avec-teaser',
      published_at: '2026-08-13T09:00:00Z',
      teaser: '« Une petite phrase qui donne envie de lire la suite » — dixit personne',
    });

    const page = await renderer.renderCategoryPage({
      league_slug: 'premier-league',
      season_slug: '26-27',
      type_slug: 'pronos',
    });

    expect({
      teaser_shown: page.html.includes(
        '<p class="article-card-teaser">« Une petite phrase qui donne envie de lire la suite » — dixit personne</p>',
      ),
      // The beforeAll fixture's own Premier League article never set a
      // teaser — the element still renders, empty, so every card's cover
      // thumbnail lands at the same horizontal position on desktop
      // regardless of which cards have a teaser and which don't. Omitting
      // the element entirely for a teaser-less card was the first version
      // of this, and visibly misaligned covers on a real mixed listing.
      empty_teaser_still_renders_for_others: page.html.includes('article-card-teaser"></p>'),
    }).toEqual({ teaser_shown: true, empty_teaser_still_renders_for_others: true });
  });

  it('AC-14: the published article page embeds its schema.org markup and the sitemap carries its canonical URL, with no writer action', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'pronos-ligue-1-journee-12',
    });
    const sitemap = await renderer.renderSitemap();
    const canonical = `${SITE_ORIGIN}/articles/ligue-1/26-27/pronos/pronos-ligue-1-journee-12`;

    expect({
      json_ld_types: page.json_ld.map((b) => b['@type']),
      json_ld_headline: page.json_ld[0]?.headline,
      sitemap_has_article: sitemap.includes(`<loc>${canonical}</loc>`),
    }).toEqual({
      json_ld_types: ['NewsArticle'],
      json_ld_headline: 'Pronos Ligue 1 - Journée 12',
      sitemap_has_article: true,
    });
  });

  it('renderArticlePage records a first-party view on every real (non-404) request — no cookie, no client JS (0012_article_views.sql)', async () => {
    const { renderer, db } = ctx();
    const writer = await seedWriter(db.client, 'Views Writer Fixture');
    // A league/type combo unused elsewhere in this file — this session's
    // established fixture-collision-avoidance discipline: seeding another
    // Ligue 1/Pronos/26-27 article here landed it inside the exact-list
    // assertion the "scoped to its season" test above makes for that
    // precise bucket, confirmed live.
    const articleId = await seedArticle(db.client, {
      writer_id: writer,
      title: 'View Counter Fixture Article',
      league_name: 'Eliteserien',
      type_name: 'Guides',
      status: 'published',
      slug: 'view-counter-fixture-article',
      published_at: '2026-08-15T10:00:00Z',
    });

    await renderer.renderArticlePage({
      league_slug: 'eliteserien',
      season_slug: '26-27',
      type_slug: 'guides',
      slug: 'view-counter-fixture-article',
    });
    await renderer.renderArticlePage({
      league_slug: 'eliteserien',
      season_slug: '26-27',
      type_slug: 'guides',
      slug: 'view-counter-fixture-article',
    });

    const rows = await db.client.query<{ count: number }>(
      'select count(*)::int as count from arsene_article_views where article_id = $1',
      [articleId],
    );
    expect(rows.rows[0]?.count).toBe(2);
  });

  it('a 404 for a slug that matches no real article records no view', async () => {
    const { renderer, db } = ctx();

    const before = await db.client.query<{ count: number }>('select count(*)::int as count from arsene_article_views');

    await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'this-slug-does-not-exist-at-all',
    });

    const after = await db.client.query<{ count: number }>('select count(*)::int as count from arsene_article_views');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('AC-13 follow-through: the article page renders its own meta_description as both <meta name="description"> and og:description, and uses meta_title for <title>', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'pronos-ligue-1-journee-12',
    });

    expect({
      has_description: page.html.includes(
        '<meta name="description" content="Nos pronostics, confiance, scores et analyses match par match."/>',
      ),
      has_og_description: page.html.includes(
        '<meta property="og:description" content="Nos pronostics, confiance, scores et analyses match par match."/>',
      ),
      has_title: page.html.includes('<title>Pronos Ligue 1 - Journée 12</title>'),
    }).toEqual({ has_description: true, has_og_description: true, has_title: true });
  });

  it('NFR-EGRESS-01: no rendered page points a visitor at Supabase Storage, because hotlinking blows the 5 GB/month egress free tier', async () => {
    const { renderer } = ctx();

    const pages = [
      (await renderer.renderHomepage()).html,
      (await renderer.renderCategoryPage({ league_slug: 'ligue-1', season_slug: '26-27', type_slug: 'pronos' })).html,
      (await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'pronos-ligue-1-journee-12',
      })).html,
    ];

    expect(pages.filter((html) => html.includes('supabase.co'))).toEqual([]);
  });

  it('NFR-RLS-02: no draft ever reaches the rendered public site, on the homepage or in the sitemap', async () => {
    const { renderer } = ctx();

    const home = await renderer.renderHomepage();
    const sitemap = await renderer.renderSitemap();

    expect({
      homepage_mentions_draft: home.html.includes('Brouillon Serie A'),
      sitemap_mentions_draft: /brouillon/i.test(sitemap),
    }).toEqual({ homepage_mentions_draft: false, sitemap_mentions_draft: false });
  });

  it('a listing page is scoped to its season: the same league and category from an earlier season is excluded', async () => {
    const { renderer, db } = ctx();
    // Same league/category as the "26-27" fixture above, but published a
    // season earlier — the URL bucket (league/season/category) must not
    // blend articles across seasons just because they share a league+type.
    await seedArticle(db.client, {
      writer_id: await seedWriter(db.client, 'Ancien Rédacteur'),
      title: 'Pronos Ligue 1 - Journée 3 (saison passée)',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'pronos-ligue-1-journee-3-saison-passee',
      published_at: '2025-09-01T10:00:00Z',
    });

    const currentSeason = await renderer.renderCategoryPage({
      league_slug: 'ligue-1',
      season_slug: '26-27',
      type_slug: 'pronos',
    });
    const priorSeason = await renderer.renderCategoryPage({
      league_slug: 'ligue-1',
      season_slug: '25-26',
      type_slug: 'pronos',
    });

    expect({
      current_season_titles: [...currentSeason.html.matchAll(/data-article-title="([^"]+)"/g)].map((m) => m[1]),
      prior_season_titles: [...priorSeason.html.matchAll(/data-article-title="([^"]+)"/g)].map((m) => m[1]),
    }).toEqual({
      current_season_titles: ['Pronos Ligue 1 - Journée 12'],
      prior_season_titles: ['Pronos Ligue 1 - Journée 3 (saison passée)'],
    });
  });

  it('an article URL whose league/season/category prefix does not match the article it actually names is not found', async () => {
    const { renderer } = ctx();

    const wrongLeague = await renderer.renderArticlePage({
      league_slug: 'premier-league',
      season_slug: '26-27',
      type_slug: 'pronos',
      slug: 'pronos-ligue-1-journee-12',
    });
    const wrongSeason = await renderer.renderArticlePage({
      league_slug: 'ligue-1',
      season_slug: '19-20',
      type_slug: 'pronos',
      slug: 'pronos-ligue-1-journee-12',
    });

    expect({
      wrong_league_found: wrongLeague.json_ld.length > 0,
      wrong_season_found: wrongSeason.json_ld.length > 0,
    }).toEqual({ wrong_league_found: false, wrong_season_found: false });
  });

  describe('renderLeaguePage — every published article in a league, across seasons and types', () => {
    it('groups by type, sorted alphabetically, only once a league has more than one type', async () => {
      const { renderer, db } = ctx();
      // The beforeAll fixture already published one Ligue 1 / Pronos article;
      // a second type turns the listing from flat into grouped.
      await seedArticle(db.client, {
        writer_id: await seedWriter(db.client, 'Nouvelle Recrue'),
        title: 'Player Picks, Ligue 1, J1',
        league_name: 'Ligue 1',
        type_name: 'Player Picks',
        status: 'published',
        slug: 'player-picks-ligue-1-j1',
        published_at: '2026-08-20T09:00:00Z',
      });

      const page = await renderer.renderLeaguePage({ league_slug: 'ligue-1' });
      const sections = [...(page?.html.matchAll(/<h2 class="section-title">([^<]+)<\/h2>/g) ?? [])].map(
        (m) => m[1],
      );
      const titlesUnderPlayerPicks = page?.html
        .split('<h2 class="section-title">Pronos</h2>')[0]
        ?.match(/data-article-title="([^"]+)"/g);

      expect({
        found: page !== null,
        sections,
        player_picks_listed_first: titlesUnderPlayerPicks?.some((t) => t.includes('Player Picks, Ligue 1, J1')),
      }).toEqual({
        found: true,
        sections: ['Player Picks', 'Pronos'],
        player_picks_listed_first: true,
      });
    });

    it('a league with only one type renders a flat list, no section heading', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'bundesliga' });

      expect({
        found: page !== null,
        // Not a substring check on "section-title" alone: that class name is
        // always present in the page's own inlined CSS, whether or not any
        // <h2> actually uses it.
        has_section_heading: page?.html.includes('<h2 class="section-title">') ?? null,
        lists_the_article: page?.html.includes('data-article-title="Mercato Bundesliga - Août"'),
      }).toEqual({ found: true, has_section_heading: false, lists_the_article: true });
    });

    it('a real league with no published articles says "No articles yet", not null', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'serie-a' });

      expect({
        found: page !== null,
        says_no_articles_yet: page?.html.includes('No articles yet'),
      }).toEqual({ found: true, says_no_articles_yet: true });
    });

    it('a slug that names no league at all returns null, so the router can fall back to the legacy-slug lookup', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'not-a-real-league' });

      expect(page).toBeNull();
    });

    it('SEO: renders a description meta tag naming the league and article count, robots index/follow, and a one-line intro above the list', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'bundesliga' });

      expect({
        has_description: page?.html.includes(
          '<meta name="description" content="Bundesliga : toutes les analyses Fantasy Coach — 1 article publié."/>',
        ),
        has_robots: page?.html.includes('<meta name="robots" content="index, follow"/>'),
        has_intro: page?.html.includes(
          '<p class="listing-intro">1 article publié pour Bundesliga.</p>',
        ),
      }).toEqual({ has_description: true, has_robots: true, has_intro: true });
    });
  });

  describe('force-light — listing pages match pronos\'s always-light background, the article page follows device preference', () => {
    const isForcedLight = (html: string): boolean => /<body[^>]*\bclass="force-light"/.test(html);

    it('the homepage is forced light', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect(isForcedLight(page.html)).toBe(true);
    });

    it('a league page is forced light', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'ligue-1' });

      expect(isForcedLight(page?.html ?? '')).toBe(true);
    });

    it('a league/season/category listing is forced light', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderCategoryPage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
      });

      expect(isForcedLight(page.html)).toBe(true);
    });

    it('the article page is NOT forced light — it follows the visitor\'s own device preference', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'pronos-ligue-1-journee-12',
      });

      expect(isForcedLight(page.html)).toBe(false);
    });

    it('a not-found page is forced light', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderNotFound();

      expect(isForcedLight(page.html)).toBe(true);
    });
  });

  describe('home page portal (Claude Design rebuild — the two-tier header stands in for site nav there)', () => {
    it('has no shared <fc-nav> banner — its own header replaces it, so the two don\'t stack', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect(page.html).not.toContain('<fc-nav');
    });

    it('league pills link to the real per-league listing route', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect(page.html).toContain('href="/articles/ligue-1">Ligue 1</a>');
    });

    it('the Ligue 1 league pill and the LCDE format pill are both highlighted active, since the hero is always a Ligue 1 Player Picks (LCDE) article', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect({
        ligue1_active: page.html.includes('<a class="home-pill active" href="/articles/ligue-1">Ligue 1</a>'),
        premier_league_not_active: page.html.includes(
          '<a class="home-pill" href="/articles/premier-league">Premier League</a>',
        ),
        lcde_active: page.html.includes('<a class="home-pill-sm active" href="/articles/ligue-1/26-27/lcde">LCDE</a>'),
        mpg_not_active: page.html.includes('<a class="home-pill-sm" href="/articles/ligue-1/26-27/mpg">MPG</a>'),
      }).toEqual({
        ligue1_active: true,
        premier_league_not_active: true,
        lcde_active: true,
        mpg_not_active: true,
      });
    });

    it('LCDE and MPG format pills link into Ligue 1\'s current season for that format', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect({
        lcde: page.html.includes('href="/articles/ligue-1/26-27/lcde"'),
        mpg: page.html.includes('href="/articles/ligue-1/26-27/mpg"'),
      }).toEqual({ lcde: true, mpg: true });
    });

    it('the Pronos format pill links to the separate pronos.fantasy-coach.fr site, not an Arsène route — Pronos isn\'t Arsène content', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect(page.html).toContain('<a class="home-pill-sm" href="https://pronos.fantasy-coach.fr">Pronos</a>');
    });

    it('league pills follow the fixed business-priority order, not alphabetical: Ligue 1, Premier League, Bundesliga', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      const order = ['Ligue 1', 'Premier League', 'Bundesliga']
        .map((name) => page.html.indexOf(`>${name}</a>`))
        .filter((index) => index !== -1);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order).toHaveLength(3);
    });

    it('the sidebar has no low-value filler cards (MPG/Premier League/Bundesliga shortcut cards were removed, judged not to add anything)', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect({
        has_pronos_cta: page.html.includes('<div class="home-card-title home-cta-title">🎯 Pronos</div>'),
        has_mpg_filler: page.html.includes('dernier bilan'),
        has_shortcut_cards: page.html.includes('home-shortcut'),
      }).toEqual({ has_pronos_cta: true, has_mpg_filler: false, has_shortcut_cards: false });
    });

    it('the "Outil pour la Ligue 1" card sits in the sidebar under the Pronos CTA, not in the main column', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      const sideColumn = page.html.match(/<div class="home-col-side">(.*?)<\/div>\s*<footer/s)?.[1] ?? '';
      const mainColumn = page.html.match(/<div class="home-col-main">(.*?)<\/div>\s*<div class="home-col-side">/s)?.[1] ?? '';

      expect({
        tool_card_in_side_column: sideColumn.includes('🛠 Outil pour la Ligue 1'),
        pronos_cta_before_tool_card: sideColumn.indexOf('🎯 Pronos') < sideColumn.indexOf('🛠 Outil pour la Ligue 1'),
        tool_card_not_in_main_column: !mainColumn.includes('🛠 Outil pour la Ligue 1'),
      }).toEqual({ tool_card_in_side_column: true, pronos_cta_before_tool_card: true, tool_card_not_in_main_column: true });
    });

    it('has a footer with the current-year copyright line', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      const currentYear = new Date().getFullYear();
      expect(page.html).toContain(`<footer class="home-footer">© Fantasy Coach ${currentYear}</footer>`);
    });

    it('the Ligue 1 tools card has a third Groupes pill, alongside DNP and Compos, linking to the live l1.groupes.fantasy-coach.fr site', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect({
        dnp: page.html.includes('<a class="home-tool-link" href="https://l1.dnp.fantasy-coach.fr/">Indisponibles / DNP</a>'),
        compos: page.html.includes(
          '<a class="home-tool-link" href="https://l1.compos.fantasy-coach.fr/">Compos probables</a>',
        ),
        groupes: page.html.includes(
          '<a class="home-tool-link" href="https://l1.groupes.fantasy-coach.fr/">Groupes</a>',
        ),
      }).toEqual({ dnp: true, compos: true, groupes: true });
    });

    it('the Ligue 1 pill has a mega-menu dropdown (4 items, incl. "Suspendus au prochain jaune" pointing at the DNP static page); Premier League and Bundesliga get none', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      const navItem = page.html.match(/<span class="home-nav-item">(.*?)<\/span>/s)?.[1] ?? '';
      const dropdownLinks = [...navItem.matchAll(/<div class="home-nav-dropdown"[^>]*>(.*?)<\/div>/gs)]
        .flatMap((m) => [...(m[1] ?? '').matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)])
        .map((m) => ({ href: m[1] ?? '', label: m[2] ?? '' }));

      expect({
        ligue1_has_dropdown: navItem.includes('Ligue 1'),
        dropdown_items: dropdownLinks,
        premier_league_has_no_dropdown: dropdownLinks.every((d) => !d.label.includes('Premier League')),
        bundesliga_has_no_caret_near_its_link: !page.html.includes(
          '<span class="home-nav-item"><a class="home-pill" href="/articles/bundesliga"',
        ),
      }).toEqual({
        ligue1_has_dropdown: true,
        dropdown_items: [
          { href: 'https://l1.dnp.fantasy-coach.fr/', label: 'Indisponibles / DNP' },
          {
            href: 'https://l1.dnp.fantasy-coach.fr/suspensionsProchainJaune.html',
            label: 'Suspendus au prochain jaune',
          },
          { href: 'https://l1.compos.fantasy-coach.fr/', label: 'Compos' },
          { href: 'https://l1.groupes.fantasy-coach.fr/', label: 'Groupes' },
        ],
        premier_league_has_no_dropdown: true,
        bundesliga_has_no_caret_near_its_link: true,
      });
    });

    it('SEO: has a keyword-bearing <title>, a description/og:description, and robots index/follow', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect({
        has_title: page.html.includes(
          '<title>Fantasy Coach — Ligue 1, Premier League, Bundesliga : actus, pronos, compos</title>',
        ),
        has_description: page.html.includes('<meta name="description" content="Toute l’actualité Fantasy Foot'),
        has_og_description: page.html.includes('<meta property="og:description" content="Toute l’actualité Fantasy Foot'),
        has_robots: page.html.includes('<meta name="robots" content="index, follow"/>'),
      }).toEqual({ has_title: true, has_description: true, has_og_description: true, has_robots: true });
    });

    it('lists the 3 most recent other Ligue 1 Player Picks articles under the hero, excluding the hero itself, most recent first', async () => {
      const { renderer, db } = ctx();
      const writer = await seedWriter(db.client, 'Recrue Picks');
      // All published after the current hero ('Player Picks, Ligue 1, J1',
      // 2026-08-20, seeded by the `renderLeaguePage` "groups by type" test
      // above) so J8 becomes the new hero and J7/J6/J1 — not J5, the oldest —
      // are the 3 most recent picks left over.
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Player Picks, Ligue 1, J6',
        league_name: 'Ligue 1',
        type_name: 'Player Picks',
        status: 'published',
        slug: 'player-picks-ligue-1-j6',
        published_at: '2026-08-23T09:00:00Z',
      });
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Player Picks, Ligue 1, J7',
        league_name: 'Ligue 1',
        type_name: 'Player Picks',
        status: 'published',
        slug: 'player-picks-ligue-1-j7',
        published_at: '2026-08-24T09:00:00Z',
      });
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Player Picks, Ligue 1, J8',
        league_name: 'Ligue 1',
        type_name: 'Player Picks',
        status: 'published',
        slug: 'player-picks-ligue-1-j8',
        published_at: '2026-08-25T09:00:00Z',
      });

      const page = await renderer.renderHomepage();
      const picksTitles = [...page.html.matchAll(/<p class="home-pick-title">([^<]+)<\/p>/g)].map((m) => m[1]);

      expect({
        hero_title: page.html.match(/<h1 class="home-headline">([^<]+)<\/h1>/)?.[1],
        picks_titles: picksTitles,
        links_to_article: page.html.includes(
          '<a class="home-pick" href="/articles/ligue-1/26-27/player-picks/player-picks-ligue-1-j7">',
        ),
      }).toEqual({
        hero_title: 'Player Picks, Ligue 1, J8',
        picks_titles: ['Player Picks, Ligue 1, J7', 'Player Picks, Ligue 1, J6', 'Player Picks, Ligue 1, J1'],
        links_to_article: true,
      });
    });

    it('the hero subtitle shows the article\'s own teaser when the writer set one, instead of the old static line', async () => {
      const { renderer, db } = ctx();
      const writer = await seedWriter(db.client, 'Teaser Writer');
      // Published after J8 (the current hero, seeded above) so this becomes
      // the new hero.
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Player Picks, Ligue 1, J9',
        league_name: 'Ligue 1',
        type_name: 'Player Picks',
        status: 'published',
        slug: 'player-picks-ligue-1-j9',
        published_at: '2026-08-26T09:00:00Z',
        teaser: 'Mbappé et Doué en feu, notre sélection pour la J9.',
      });

      const page = await renderer.renderHomepage();

      expect(page.html).toContain(
        '<p class="home-subtitle">Mbappé et Doué en feu, notre sélection pour la J9.</p>',
      );
    });

    it('the Pronos CTA shows the 5 pronos.fantasy-coach.fr league crests instead of the old "5 ligues couvertes" text', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      const crestsBlock = page.html.match(/<div class="home-cta-leagues">(.*?)<\/div>/s)?.[1] ?? '';
      const crestAlts = [...crestsBlock.matchAll(/alt="([^"]+)"/g)].map((m) => m[1]);
      const crestSrcs = [...crestsBlock.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);

      expect({
        crestAlts,
        allWikimediaHosted: crestSrcs.length > 0 && crestSrcs.every((src) => src?.startsWith('https://upload.wikimedia.org/')),
        has_old_text: page.html.includes('ligues couvertes'),
      }).toEqual({
        crestAlts: ['Ligue 1', 'Premier League', 'Bundesliga', 'Serie A', 'La Liga'],
        allWikimediaHosted: true,
        has_old_text: false,
      });
    });
  });

  describe('data-current-league — what the client-side nav-highlight script reads', () => {
    const currentLeagueOf = (html: string | undefined): string | null =>
      html?.match(/<body data-current-league="([^"]*)"/)?.[1] ?? null;

    it('a league page carries its own name, exactly as arsene_leagues stores it', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'bundesliga' });

      expect(currentLeagueOf(page?.html)).toBe('Bundesliga');
    });

    it('Premier League carries "FPL" instead of its own name — fc-shared\'s nav.js renders that league\'s dropdown entry with label "FPL", not "Premier League", so the client-side match has to target the nav\'s actual visible text', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderLeaguePage({ league_slug: 'premier-league' });

      expect(currentLeagueOf(page?.html)).toBe('FPL');
    });

    it('a league/season/category listing carries its league’s name too', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderCategoryPage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
      });

      expect(currentLeagueOf(page.html)).toBe('Ligue 1');
    });

    it('an article page carries the league it was published under', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'pronos-ligue-1-journee-12',
      });

      expect(currentLeagueOf(page.html)).toBe('Ligue 1');
    });

    it('the homepage carries no current league at all — nothing to highlight there', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderHomepage();

      expect(currentLeagueOf(page.html)).toBeNull();
    });
  });

  describe('co-authored bylines (article_authors, 0009)', () => {
    // The byline now nests an avatar (an <img>, or an initial-letter
    // placeholder span — src/site/render.ts's authorsHtml/authorAvatarHtml)
    // inside each author's own <span class="author-name">, so the outer
    // <span class="author">...</span> no longer has plain-text content
    // alone. Captured up to the sep span that always immediately follows
    // it (renderArticlePage's own meta array has no whitespace between
    // elements), then stripped of any inner tags to get back to just the
    // readable name(s) — this file's assertions are about *whose names
    // appear, in what order*, not about the avatar markup itself (that's
    // tests/db/writerAvatars.test.ts's job).
    // The no-avatar-yet placeholder renders its own initial letter as real
    // text content (authorAvatarHtml), not just a tag — stripped as one
    // unit before the remaining tags, or a stray "A" from "Alban"'s own
    // placeholder would leak into the extracted name text.
    const stripTags = (html: string): string =>
      html
        .replace(/<span class="author-avatar author-avatar-placeholder">[^<]*<\/span>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
    const articleByline = (html: string): string | undefined => {
      const match = /<span class="author">([\s\S]*?)<\/span><span class="sep">/.exec(html);
      return match?.[1] === undefined ? undefined : stripTags(match[1]);
    };

    it('a single-author article shows just that name, and its JSON-LD author is a single object, not an array', async () => {
      const { renderer } = ctx();
      const page = await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'pronos-ligue-1-journee-12',
      });

      expect({
        byline: articleByline(page.html),
        json_ld_author: page.json_ld[0]?.author,
      }).toEqual({
        byline: 'Lionel Le Boiteux',
        json_ld_author: { '@type': 'Person', name: 'Lionel Le Boiteux' },
      });
    });

    it('a two-author article joins the names with "et", in ordinal order, both on the card byline and the article page, and its JSON-LD author is an array of both', async () => {
      const { renderer, db } = ctx();
      const secondWriter = await seedWriter(db.client, 'Marie Dupont');
      const firstWriter = await seedWriter(db.client, 'Alban Petit');
      await seedArticle(db.client, {
        writer_id: firstWriter,
        title: 'Co-écrit à deux',
        league_name: 'Ligue 1',
        type_name: 'Pronos',
        status: 'published',
        slug: 'co-ecrit-a-deux',
        published_at: '2026-08-12T09:00:00Z',
        author_writer_ids: [firstWriter, secondWriter],
      });

      // The home page portal shows only its single hero article, not a
      // listing (see the redesign note above), so the "does a co-authored
      // byline render correctly on an `article-card`" half of this check
      // now reads a league listing instead — same `articleCard()` markup,
      // still real listing behaviour, just no longer reachable from the
      // homepage itself.
      const leaguePage = await renderer.renderLeaguePage({ league_slug: 'ligue-1' });
      const page = await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'co-ecrit-a-deux',
      });

      expect({
        card_byline: stripTags(
          (leaguePage?.html ?? '').match(/Co-écrit à deux[\s\S]*?article-card-byline">([^·]+)·/)?.[1] ?? '',
        ),
        article_byline: articleByline(page.html),
        json_ld_author: page.json_ld[0]?.author,
      }).toEqual({
        card_byline: 'Alban Petit et Marie Dupont',
        article_byline: 'Alban Petit et Marie Dupont',
        json_ld_author: [
          { '@type': 'Person', name: 'Alban Petit' },
          { '@type': 'Person', name: 'Marie Dupont' },
        ],
      });
    });

    it('a three-author article uses commas before the final "et"', async () => {
      const { renderer, db } = ctx();
      const a = await seedWriter(db.client, 'Auteur Un');
      const b = await seedWriter(db.client, 'Auteur Deux');
      const c = await seedWriter(db.client, 'Auteur Trois');
      await seedArticle(db.client, {
        writer_id: a,
        title: 'Co-écrit à trois',
        league_name: 'Ligue 1',
        type_name: 'Pronos',
        status: 'published',
        slug: 'co-ecrit-a-trois',
        published_at: '2026-08-13T09:00:00Z',
        author_writer_ids: [a, b, c],
      });

      const page = await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'co-ecrit-a-trois',
      });

      expect(articleByline(page.html)).toBe('Auteur Un, Auteur Deux et Auteur Trois');
    });
  });

  describe('resolveWixPostPath — old Wix bookmarks (leaving Wix)', () => {
    it('resolves an exact slug match with no normalization needed', async () => {
      const { renderer } = ctx();

      const path = await renderer.resolveWixPostPath({ slug: 'pronos-ligue-1-journee-12' });

      expect(path).toBe('/articles/ligue-1/26-27/pronos/pronos-ligue-1-journee-12');
    });

    it("strips Wix's own trailing dedup suffix (e.g. \"-4\") when the bare slug has no match", async () => {
      const { renderer } = ctx();

      const path = await renderer.resolveWixPostPath({ slug: 'pronos-ligue-1-journee-12-4' });

      expect(path).toBe('/articles/ligue-1/26-27/pronos/pronos-ligue-1-journee-12');
    });

    it('collapses Wix\'s embedded season infix (e.g. "-26-27-") when the bare slug has no match', async () => {
      const { renderer, db } = ctx();
      const writer = await seedWriter(db.client, 'Wix Infix Fixture');
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Player Picks Premier League J1',
        league_name: 'Premier League',
        type_name: 'Pronos',
        status: 'published',
        slug: 'player-picks-premier-league-j1-wix-infix',
        published_at: '2026-08-20T21:37:47Z',
      });

      const path = await renderer.resolveWixPostPath({
        slug: 'player-picks-26-27-premier-league-j1-wix-infix',
      });

      expect(path).toBe('/articles/premier-league/26-27/pronos/player-picks-premier-league-j1-wix-infix');
    });

    it('resolves a slug carrying both the season infix and the dedup suffix at once', async () => {
      const { renderer, db } = ctx();
      const writer = await seedWriter(db.client, 'Wix Both Fixture');
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Player Picks Ligue 1 J1 Both',
        league_name: 'Ligue 1',
        type_name: 'Pronos',
        status: 'published',
        slug: 'player-picks-ligue-1-j1-both',
        published_at: '2026-08-20T17:13:28Z',
      });

      const path = await renderer.resolveWixPostPath({ slug: 'player-picks-26-27-ligue-1-j1-both-4' });

      expect(path).toBe('/articles/ligue-1/26-27/pronos/player-picks-ligue-1-j1-both');
    });

    it("strips accents Wix's own raw slug carries but a real Arsène slug never does, on the bare slug", async () => {
      const { renderer, db } = ctx();
      const writer = await seedWriter(db.client, 'Wix Accent Fixture');
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Guide Eliteserien Mi-saison',
        league_name: 'Eliteserien',
        type_name: 'Guides',
        status: 'published',
        slug: 'eliteserien-2026-bilan-a-mi-saison',
        published_at: '2026-08-20T17:13:28Z',
      });

      const path = await renderer.resolveWixPostPath({ slug: 'eliteserien-2026-bilan-à-mi-saison' });

      expect(path).toBe('/articles/eliteserien/26-27/guides/eliteserien-2026-bilan-a-mi-saison');
    });

    it('strips accents together with the dedup suffix, when a slug needs both at once', async () => {
      const { renderer, db } = ctx();
      const writer = await seedWriter(db.client, 'Wix Accent Dedup Fixture');
      await seedArticle(db.client, {
        writer_id: writer,
        title: 'Comment Jouer a la Fantasy Eliteserien',
        league_name: 'Eliteserien',
        type_name: 'Guides',
        status: 'published',
        slug: 'comment-jouer-a-la-fantasy-eliteserien-2026',
        published_at: '2026-08-20T17:13:28Z',
      });

      const path = await renderer.resolveWixPostPath({ slug: 'comment-jouer-à-la-fantasy-eliteserien-2026-4' });

      expect(path).toBe('/articles/eliteserien/26-27/guides/comment-jouer-a-la-fantasy-eliteserien-2026');
    });

    it('returns null for a Wix post that was never migrated to Arsène, rather than guessing', async () => {
      const { renderer } = ctx();

      const path = await renderer.resolveWixPostPath({ slug: 'round-14-allsvenskan-2026' });

      expect(path).toBeNull();
    });
  });
});
