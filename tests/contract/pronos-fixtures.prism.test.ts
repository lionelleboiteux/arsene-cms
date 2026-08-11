import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixturePicker } from '../support/seams.js';
import { PRONOS_OPENAPI_PATH, validateAgainstPronosSchema } from '../support/openapi.js';
import { freePort, startPrismMock, type PrismMock } from '../support/prism.js';
import { PRONOS_LEAGUE_LIGUE_1 } from '../support/fixtures.js';

/**
 * CONSUMER side of someone else's contract: Arsène's fixture picker against
 * pronos' `GET /v1/leagues/{leagueId}/current`
 * (contracts/pronos-fixtures.consumer.md §6).
 *
 * Prism mocks the VENDORED copy of pronos' contract
 * (contracts/vendor/pronos-openapi.yaml, pinned per PRONOS_SOURCE.md). Arsène's
 * CI never points this at a real pronos deployment — §2 of that doc: fixture
 * ingestion has not shipped there, so there may be nothing real to point at.
 *
 * There is deliberately NO provider test here: verifying that pronos actually
 * satisfies its own contract is pronos' responsibility, not Arsène's.
 */

let prism: PrismMock;

beforeAll(async () => {
  prism = await startPrismMock(PRONOS_OPENAPI_PATH, `/v1/leagues/${PRONOS_LEAGUE_LIGUE_1}/current`);
}, 120_000);

afterAll(async () => {
  await prism?.stop();
});

describe('pronos fixture picker (consumer contract)', () => {
  it('CONTRACT-CONSUMER-fixturePicker-populated: the picker renders one row per fixture, read out of the contract’s own response shape', async () => {
    const { createFixturePicker } = await loadFixturePicker();
    const picker = createFixturePicker({
      baseUrl: prism.baseUrl,
      headers: { Prefer: 'example=withOwnPredictionAndAnUnlockedAndLockedMatch' },
    });

    const state = await picker.listFixtures({ leagueId: PRONOS_LEAGUE_LIGUE_1 });

    expect({
      mode: state.mode,
      contract_errors:
        state.mode === 'picker' ? validateAgainstPronosSchema('CurrentGameweekResponse', state.raw) : ['not a picker'],
      rows:
        state.mode === 'picker'
          ? state.rows.map((r) => [r.homeTeamName, r.awayTeamName, r.kickoffAt])
          : [],
    }).toEqual({
      mode: 'picker',
      contract_errors: [],
      rows: [
        ['Olympique de Marseille', 'Paris Saint-Germain', '2026-08-09T18:45:00Z'],
        ['AS Monaco', 'LOSC Lille', '2026-08-10T19:00:00Z'],
      ],
    });
  });

  it('CONTRACT-CONSUMER-fixturePicker-emptyGameweek: a league with no open gameweek falls through to manual entry, and is not treated as an error', async () => {
    const { createFixturePicker } = await loadFixturePicker();
    const picker = createFixturePicker({
      baseUrl: prism.baseUrl,
      headers: { Prefer: 'example=noOpenGameweek' },
    });

    const state = await picker.listFixtures({ leagueId: PRONOS_LEAGUE_LIGUE_1 });

    expect(state.mode).toBe('manual-entry');
  });

  it('CONTRACT-CONSUMER-fixturePicker-notFound: an unrecognised league id falls through to manual entry rather than blocking the writer', async () => {
    const { createFixturePicker } = await loadFixturePicker();
    const picker = createFixturePicker({ baseUrl: prism.baseUrl, headers: { Prefer: 'code=404' } });

    const state = await picker.listFixtures({ leagueId: '00000000-0000-0000-0000-000000000000' });

    expect(state.mode).toBe('manual-entry');
  });

  it('CONTRACT-CONSUMER-fixturePicker-unreachable: pronos being undeployed, down or CORS-blocked also falls through to manual entry, never an unhandled failure', async () => {
    const { createFixturePicker } = await loadFixturePicker();
    const deadPort = await freePort(); // nothing is listening here
    const picker = createFixturePicker({ baseUrl: `http://127.0.0.1:${deadPort}` });

    const state = await picker.listFixtures({ leagueId: PRONOS_LEAGUE_LIGUE_1 });

    expect(state.mode).toBe('manual-entry');
  });
});
