/**
 * The five leagues Arsène covers today. Shared between the home page (which
 * groups every article by these, plus a catch-all for anything else) and
 * the compose page's fixed category dropdown (which offers a Player Picks
 * shortcut for each) — one list, so the two never drift apart.
 */
export const HOME_LEAGUES = [
  { key: 'ligue-1', league_name: 'Ligue 1', dropdown_label: 'L1 PP' },
  { key: 'premier-league', league_name: 'Premier League', dropdown_label: 'PremPP' },
  { key: 'bundesliga', league_name: 'Bundesliga', dropdown_label: 'Bundesliga PP' },
  { key: 'eliteserien', league_name: 'Eliteserien', dropdown_label: 'Eliteserien PP' },
  { key: 'allsvenskan', league_name: 'Allsvenskan', dropdown_label: 'Allsvenskan PP' },
] as const;

export const TYPE_NAME_PLAYER_PICKS = 'Player Picks';
export const TYPE_NAME_GUIDES = 'Guides';

/**
 * Per-league quick-create shortcuts beyond the default Player Picks every
 * league in `HOME_LEAGUES` already gets. Bundesliga is the only league with
 * one today (a "Nouveau Guide" button on the home page); a future league
 * that wants its own extra type adds one entry here, nothing else changes.
 */
export const EXTRA_LEAGUE_CATEGORIES = [
  {
    key: 'bundesliga-guides',
    league_name: 'Bundesliga',
    type_name: TYPE_NAME_GUIDES,
    dropdown_label: 'Bundesliga Guides',
    button_label: 'Nouveau Guide',
  },
] as const;
