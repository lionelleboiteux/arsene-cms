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
