/**
 * ADR-0002 — the editor's optional fixture picker, a consumer of pronos'
 * `GET /v1/leagues/{leagueId}/current`.
 *
 * pronos has not shipped fixture ingestion, so every way this can come back
 * without fixtures — an empty gameweek (a documented 200), a 404, an
 * unexpected status, or pronos not being deployed/reachable at all — lands the
 * writer in manual entry rather than blocking them
 * (contracts/pronos-fixtures.consumer.md §3).
 */

const REQUEST_TIMEOUT_MS = 10_000;

export type FixtureRow = {
  gameId: string;
  homeTeamName: string;
  awayTeamName: string;
  kickoffAt: string;
};

export type FixturePickerState =
  | { mode: 'picker'; rows: FixtureRow[]; raw: unknown }
  | { mode: 'manual-entry'; reason: string };

type CurrentGameweekResponse = {
  games?: Array<{
    game?: {
      id?: string;
      home_team?: { name?: string };
      away_team?: { name?: string };
      starts_at?: string;
    };
  }>;
};

const manual = (reason: string): FixturePickerState => ({ mode: 'manual-entry', reason });

function toRows(payload: CurrentGameweekResponse): FixtureRow[] {
  return (payload.games ?? []).flatMap((entry) => {
    const game = entry.game;
    if (!game?.id || !game.home_team?.name || !game.away_team?.name || !game.starts_at) return [];
    return [
      {
        gameId: game.id,
        homeTeamName: game.home_team.name,
        awayTeamName: game.away_team.name,
        kickoffAt: game.starts_at,
      },
    ];
  });
}

export function createFixturePicker(opts: {
  baseUrl: string;
  headers?: Record<string, string>;
}): { listFixtures(args: { leagueId: string }): Promise<FixturePickerState> } {
  return {
    async listFixtures(args) {
      let payload: CurrentGameweekResponse;
      try {
        // Never sends `?pseudo=`: that personalises pronos' own player form.
        const response = await fetch(`${opts.baseUrl}/v1/leagues/${args.leagueId}/current`, {
          headers: { accept: 'application/json', ...opts.headers },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return manual(`pronos responded ${response.status}`);
        payload = (await response.json()) as CurrentGameweekResponse;
      } catch (err) {
        return manual(`pronos unreachable: ${(err as Error).message}`);
      }

      const rows = toRows(payload);
      if (rows.length === 0) return manual('no fixtures currently available for this league');
      return { mode: 'picker', rows, raw: payload };
    },
  };
}
