/**
 * Wix category id -> Arsène (league_name, type_name) — built from the real
 * category list (`GET /blog/v3/categories` against the live "Fantasy Coach"
 * Wix site, 33 categories as of 2026-09-08), not invented.
 *
 * A Wix post can carry several categories at once (e.g. "Premier League" +
 * "Fantasy Prem" + "Player Picks" all together) where Arsène's model only
 * has room for one league and one type per article. `PRIORITY` breaks the
 * tie: the entries earlier in each list win when a post matches more than
 * one on the same axis. "Player Picks"/"Guides" are listed first because
 * they're the umbrella content-format categories every league-specific
 * variant (Fantasy Prem, LCDE, MPG...) turned out to duplicate on every
 * sample post pulled during discovery — the league-specific ones carry no
 * information "Player Picks" + the league category don't already give.
 *
 * Extend this table (not the import script) when a later batch turns up a
 * Wix category not covered here yet — `useTaxonomy`'s "create on demand"
 * behaviour means an unmapped league/type just becomes a new Arsène
 * category rather than failing, so this table only needs to be *correct*
 * for what it does cover, not exhaustive up front.
 */

export type CategoryMapping = { categoryId: string; value: string };

/** Order matters — first match wins when a post has more than one. */
export const LEAGUE_PRIORITY: CategoryMapping[] = [
  { categoryId: '268ff3e6-71d1-4afd-b760-111655b6b561', value: 'Ligue 1' },
  { categoryId: '01f01901-f829-434e-84a6-7cbcfc63df21', value: 'Premier League' },
  { categoryId: '9897b9f6-3273-4edc-b2ed-78f3775d3333', value: 'Bundesliga' },
  { categoryId: '9e438635-ed25-41c5-83a7-681b2974b741', value: 'Bundesliga' }, // "1.Bundesliga" — same top flight
  { categoryId: 'e8dac362-46d7-4951-9b9c-31f08a6760a8', value: '2. Bundesliga' }, // genuinely a different division
  { categoryId: '703bdb8c-ae64-4c79-b2d1-d820c0617798', value: 'Eliteserien' },
  { categoryId: 'bd460302-9c91-454f-9c85-29c78817d773', value: 'Allsvenskan' },
  { categoryId: '8ba79d5a-f17b-49bd-88fd-2186bf79ff6e', value: 'Ligue 2' },
  { categoryId: '459b58a0-77d6-405e-9cab-80ef40a8536a', value: 'MLS' },
];

/** Order matters — "Player Picks"/"Guides" win over the league-specific
 *  categories that duplicate them (Fantasy Prem/Ligue1/Bundesliga, LCDE,
 *  MPG) when a post carries both. */
export const TYPE_PRIORITY: CategoryMapping[] = [
  { categoryId: '467d5c80-9e00-4aa4-9711-6c7a6a5038ee', value: 'Player Picks' },
  { categoryId: '6dff31c1-cfda-4a5a-a64d-eff8d87d5990', value: 'Guides' },
  { categoryId: '3f85da81-6e8b-4640-9536-9176e9793889', value: 'Guides' }, // "Guides L1 Clubs"
  { categoryId: '1b0a03e2-5f14-4e81-a98f-aec61d14c913', value: 'Guides' }, // "Guides CdM"
  { categoryId: '213305ec-7b08-4cc1-a0ba-0bfbc0494684', value: 'Suspensions et blessures' },
  { categoryId: '3086b27b-431f-40ee-a0d3-d4f804ef009a', value: 'Mercato' },
  { categoryId: '5fb29163-11ff-45e5-8067-5d924a43140f', value: 'Sorare' },
];

function firstMatch(categoryIds: string[], priority: CategoryMapping[]): string | null {
  for (const entry of priority) {
    if (categoryIds.includes(entry.categoryId)) return entry.value;
  }
  return null;
}

/**
 * Resolves a post's Arsène (league_name, type_name), or `null` for either
 * axis the category list didn't cover — the caller decides what to do
 * with an unresolved axis (Wix posts with no categories at all happen,
 * confirmed during discovery: one real post had `categoryIds: []`).
 */
export function resolveTaxonomy(categoryIds: string[]): { league_name: string | null; type_name: string | null } {
  return {
    league_name: firstMatch(categoryIds, LEAGUE_PRIORITY),
    type_name: firstMatch(categoryIds, TYPE_PRIORITY),
  };
}
