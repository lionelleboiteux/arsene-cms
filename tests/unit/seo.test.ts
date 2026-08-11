import { describe, expect, it } from 'vitest';
import { loadSeo } from '../support/seams.js';
import type { ArticleSeoContext, PublishedArticleView } from '../support/seams.js';
import { validateAgainstSchema } from '../support/openapi.js';
import { ARTICLE_ID } from '../support/fixtures.js';

/**
 * Slug / meta / JSON-LD / sitemap / alt-text generation. All pure — no DB, no
 * browser, no network (02-architecture.v1.md §1). Everything the spec calls
 * "generated automatically in the background" is proved here at its cheapest
 * layer; that it actually reaches the published page is proved once, in
 * tests/db/publicSiteRender.test.ts.
 */

const ARTICLE: ArticleSeoContext = {
  title: 'Pronos Ligue 1 - Journée 12',
  body_text:
    'Notre analyse match par match de la journée 12 de Ligue 1, avec les compositions ' +
    'probables, les joueurs en forme et nos pronostics pour chaque affiche du week-end.',
  league_name: 'Ligue 1',
  type_name: 'Pronos',
};

const PUBLISHED: PublishedArticleView = {
  article_id: ARTICLE_ID,
  title: 'Pronos Ligue 1 - Journée 12',
  slug: 'pronos-ligue-1-journee-12',
  league_name: 'Ligue 1',
  type_name: 'Pronos',
  writer_display_name: 'Lionel Le Boiteux',
  cover_image_url: 'https://cdn.fantasycoach.example/articles/a1a1a1a1/cover-optimized.webp',
  published_at: '2026-08-11T10:47:12Z',
  first_published_at: '2026-08-11T10:47:12Z',
};

describe('meta suggestion', () => {
  it('AC-13: reaching the publish step yields a meta title and description pre-filled from the article and short enough for the contract to accept', async () => {
    const { suggestMeta } = await loadSeo();

    const suggestion = suggestMeta(ARTICLE);

    expect({
      title_mentions_the_article: suggestion.meta_title.includes('Ligue 1'),
      title_within_contract_max: suggestion.meta_title.length <= 70 && suggestion.meta_title.length > 0,
      description_drawn_from_the_body: suggestion.meta_description.includes('journée 12'),
      description_within_contract_max:
        suggestion.meta_description.length <= 160 && suggestion.meta_description.length > 0,
    }).toEqual({
      title_mentions_the_article: true,
      title_within_contract_max: true,
      description_drawn_from_the_body: true,
      description_within_contract_max: true,
    });
  });
});

describe('technical SEO fields', () => {
  it('AC-14: the URL slug is derived from the title with no writer action, matching the slug the contract documents', async () => {
    const { generateSlug } = await loadSeo();

    expect(generateSlug('Pronos Ligue 1 - Journée 12')).toBe('pronos-ligue-1-journee-12');
  });

  it('AC-14: the generated schema.org markup is a valid NewsArticle carrying the cover image and both publish timestamps', async () => {
    const { buildStructuredData } = await loadSeo();

    const jsonLd = buildStructuredData(PUBLISHED);

    expect({
      contract_errors: validateAgainstSchema('StructuredData', jsonLd),
      type: jsonLd['@type'],
      headline: jsonLd.headline,
      image: jsonLd.image,
      datePublished: jsonLd.datePublished,
      dateModified: jsonLd.dateModified,
    }).toEqual({
      contract_errors: [],
      type: 'NewsArticle',
      headline: 'Pronos Ligue 1 - Journée 12',
      image: [PUBLISHED.cover_image_url],
      datePublished: '2026-08-11T10:47:12Z',
      dateModified: '2026-08-11T10:47:12Z',
    });
  });

  it('AC-14: the sitemap entry points at the article’s canonical URL and is dated by this publish', async () => {
    const { buildSitemapEntry } = await loadSeo();

    const entry = buildSitemapEntry(PUBLISHED);

    expect({ entry, contract_errors: validateAgainstSchema('SitemapEntry', entry) }).toEqual({
      entry: {
        loc: 'https://fantasycoach.example/ligue-1/pronos/pronos-ligue-1-journee-12',
        lastmod: '2026-08-11',
      },
      contract_errors: [],
    });
  });
});

describe('image alt text', () => {
  it('AC-15: alt text is generated from the article’s own context rather than the file name', async () => {
    const { generateAltText } = await loadSeo();

    const alt = generateAltText({
      article_title: 'PSG vs Marseille : notre analyse',
      body_text: 'Le Classique revient au Parc des Princes dimanche soir.',
      original_filename: 'IMG_4821.jpg',
    });

    expect({
      mentions_home_team: alt.includes('PSG'),
      mentions_away_team: alt.includes('Marseille'),
      does_not_echo_the_filename: !alt.includes('IMG_4821'),
    }).toEqual({
      mentions_home_team: true,
      mentions_away_team: true,
      does_not_echo_the_filename: true,
    });
  });
});

describe('SEO/AEO/GEO advisory check', () => {
  it('AC-16: an article with a too-short introduction is flagged, and no advisory ever claims to block publishing', async () => {
    const { runContentCheck } = await loadSeo();

    const advisories = runContentCheck({ ...ARTICLE, body_text: 'Court.' });

    expect({
      flagged_something: advisories.length > 0,
      advisories_claiming_to_block: advisories.filter((a) => a.blocks_publish).length,
    }).toEqual({ flagged_something: true, advisories_claiming_to_block: 0 });
  });
});
