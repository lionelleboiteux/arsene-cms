/**
 * Deterministic fixtures. UUIDs match the examples in
 * pdlc/arsene-cms/contracts/openapi.yaml so a failure message in a contract
 * test and one in a unit test refer to the same article.
 */

import type { ArticleRecord, ImageRecord, PronosEntryInput } from './seams.js';

export const t = (iso: string): Date => new Date(iso);

// --- ids straight out of contracts/openapi.yaml examples --------------------
export const ARTICLE_ID = 'a1a1a1a1-0000-4a2b-9c3d-000000000001';
export const COVER_IMAGE_ID = 'c3c3c3c3-0000-4a2b-9c3d-cccccccccccc';
export const BODY_IMAGE_ID = 'd4d4d4d4-0000-4a2b-9c3d-dddddddddddd';
export const NEW_COVER_IMAGE_ID = 'f6f6f6f6-0000-4a2b-9c3d-ffffffffffff';
export const WRITER_A = 'e5e5e5e5-0000-4a2b-9c3d-eeeeeeeeeeee';
export const WRITER_B = 'b2b2b2b2-0000-4a2b-9c3d-bbbbbbbbbbbb';
export const WRITER_A_NAME = 'Marie D.';
export const WRITER_B_NAME = 'Lionel Le Boiteux';

// --- pronos (vendored contract) example ids --------------------------------
export const PRONOS_LEAGUE_LIGUE_1 = '3f29b6d2-8b1a-4e2b-9c3a-111111111111';
export const PRONOS_GAME_ASM_LOSC = '3c3c3c3c-0000-4a2b-9c3d-999999999999';

export const NOW = t('2026-08-11T10:47:12Z');

export const VALID_PRONOS_ENTRY: PronosEntryInput = {
  home_team: 'PSG',
  away_team: 'Marseille',
  predicted_home_score: 2,
  predicted_away_score: 1,
  confidence_tier: 'Indispensable',
};

export function articleRecord(overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    id: ARTICLE_ID,
    writer_id: WRITER_B,
    title: 'Pronos Ligue 1 - Journée 12',
    body_html:
      '<h2>Les affiches</h2><p>Notre analyse match par match de la journée 12 de Ligue 1, ' +
      'avec les cotes, les compositions probables et nos pronostics.</p>',
    league_name: 'Ligue 1',
    type_name: 'Pronos',
    slug: null,
    meta_title: null,
    meta_description: null,
    first_published_at: null,
    locked_by: WRITER_B,
    locked_at: t('2026-08-11T10:47:00Z'),
    pronos_entries: [VALID_PRONOS_ENTRY],
    ...overrides,
  };
}

/**
 * The URL the cover image was actually stored under. 05-verification.v1.md
 * §6.4: the publish response must echo this, not a path built from
 * `article.id`. Deliberately shaped like `uploadImage`'s real output
 * (`{id}-optimized.webp`), which is what makes the fabricated
 * `{article_id}/cover-optimized.webp` distinguishable from it.
 */
export const COVER_OPTIMIZED_URL = `https://cdn.fantasycoach.example/articles/${COVER_IMAGE_ID}-optimized.webp`;

export function imageRecord(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: COVER_IMAGE_ID,
    article_id: ARTICLE_ID,
    role: 'cover',
    status: 'ready',
    alt_text: 'PSG face à l’OM au Parc des Princes',
    optimized_url: COVER_OPTIMIZED_URL,
    ...overrides,
  };
}

export const READY_COVER: ImageRecord[] = [imageRecord()];

/** Word/Google Docs clipboard payload: AC-03's exact scenario. */
export const WORD_PASTE_HTML = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office">',
  '<head><style>p.MsoNormal {mso-style-parent:""; font-family:"Calibri",sans-serif;}</style></head>',
  '<body lang=FR>',
  '<p class=MsoHeading2 style=\'mso-style-name:"Heading 2";font-size:14.0pt;color:#2E74B5\'>',
  '<b><span style=\'font-family:"Cambria",serif\'>Les affiches de la journée</span></b></p>',
  '<p class=MsoNormal style=\'font-family:"Comic Sans MS";color:red;background:yellow\'>',
  '<span style=\'font-size:11.0pt\'>PSG re&ccedil;oit Marseille dimanche soir.</span></p>',
  '</body></html>',
].join('');
