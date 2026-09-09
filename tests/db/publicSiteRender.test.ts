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

    // Three leagues, published at different times — AC-12's exact setup.
    const ligue1 = await seedArticle(db.client, {
      writer_id: writer,
      title: 'Pronos Ligue 1 - Journée 12',
      league_name: 'Ligue 1',
      type_name: 'Pronos',
      status: 'published',
      slug: 'pronos-ligue-1-journee-12',
      published_at: '2026-08-11T10:47:12Z',
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
  it('AC-12: the homepage lists every league’s articles newest first, regardless of league', async () => {
    const { renderer } = ctx();

    const page = await renderer.renderHomepage();
    const titles = [...page.html.matchAll(/data-article-title="([^"]+)"/g)].map((m) => m[1]);

    expect(titles).toEqual([
      'Pronos Ligue 1 - Journée 12',
      'Premier League : les paris du week-end',
      'Mercato Bundesliga - Août',
    ]);
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

      const home = await renderer.renderHomepage();
      const page = await renderer.renderArticlePage({
        league_slug: 'ligue-1',
        season_slug: '26-27',
        type_slug: 'pronos',
        slug: 'co-ecrit-a-deux',
      });

      expect({
        card_byline: stripTags(
          home.html.match(/Co-écrit à deux[\s\S]*?article-card-byline">([^·]+)·/)?.[1] ?? '',
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

    it('returns null for a Wix post that was never migrated to Arsène, rather than guessing', async () => {
      const { renderer } = ctx();

      const path = await renderer.resolveWixPostPath({ slug: 'round-14-allsvenskan-2026' });

      expect(path).toBeNull();
    });
  });
});
