import { describe, expect, it } from 'vitest';
import { loadPronosEntry } from '../support/seams.js';
import type { PronosEntryInput } from '../support/seams.js';
import {
  PRONOS_GAME_ASM_LOSC,
  PRONOS_LEAGUE_LIGUE_1,
  VALID_PRONOS_ENTRY,
} from '../support/fixtures.js';

/**
 * Structured pronos/player-picks entry (AC-04). The point of the AC is that
 * the prediction is *data*, not prose, so this seam is a validator/normaliser
 * over typed fields; how it renders is proved once against the real render
 * pass in tests/db/publicSiteRender.test.ts.
 *
 * ADR-0002: the reference to a pronos fixture is optional and nullable — never
 * a required foreign key — because pronos has not shipped fixture ingestion.
 */

describe('structured pronos entry', () => {
  it('AC-04: PSG 2-1 Marseille with tier "Indispensable" is stored as typed fields, with no pronos fixture reference required', async () => {
    const { buildPronosEntry } = await loadPronosEntry();

    expect(buildPronosEntry(VALID_PRONOS_ENTRY)).toEqual({
      ok: true,
      entry: {
        home_team: 'PSG',
        away_team: 'Marseille',
        predicted_home_score: 2,
        predicted_away_score: 1,
        confidence_tier: 'Indispensable',
        pronos_league_id: null,
        pronos_game_id: null,
        match_kickoff_at: null,
      },
    });
  });

  it('ADR-0002: picking a fixture from pronos stores a denormalised snapshot of it alongside the writer-editable team names', async () => {
    const { buildPronosEntry } = await loadPronosEntry();

    const picked: PronosEntryInput = {
      ...VALID_PRONOS_ENTRY,
      home_team: 'AS Monaco',
      away_team: 'LOSC Lille',
      pronos_league_id: PRONOS_LEAGUE_LIGUE_1,
      pronos_game_id: PRONOS_GAME_ASM_LOSC,
      match_kickoff_at: '2026-08-10T19:00:00Z',
    };

    expect(buildPronosEntry(picked)).toEqual({
      ok: true,
      entry: {
        home_team: 'AS Monaco',
        away_team: 'LOSC Lille',
        predicted_home_score: 2,
        predicted_away_score: 1,
        confidence_tier: 'Indispensable',
        pronos_league_id: PRONOS_LEAGUE_LIGUE_1,
        pronos_game_id: PRONOS_GAME_ASM_LOSC,
        match_kickoff_at: '2026-08-10T19:00:00Z',
      },
    });
  });

  // One case per class of invalid entry the contract's VALIDATION_FAILED
  // example describes — not six variations of a bad tier.
  const INVALID = [
    {
      id: 'AC-04a',
      klass: 'a confidence tier outside the agreed three',
      input: { ...VALID_PRONOS_ENTRY, confidence_tier: 'Chaud' },
      field: 'confidence_tier',
    },
    {
      id: 'AC-04b',
      klass: 'a missing team name',
      input: { ...VALID_PRONOS_ENTRY, away_team: '   ' },
      field: 'away_team',
    },
    {
      id: 'AC-04c',
      klass: 'a non-integer predicted score',
      input: { ...VALID_PRONOS_ENTRY, predicted_home_score: 1.5 },
      field: 'predicted_home_score',
    },
  ] as const;

  it.each(
    INVALID.map((c) => [`${c.id}: ${c.klass} is rejected as a field error, not stored as free text`, c] as const),
  )('%s', async (_title, { input, field }) => {
    const { buildPronosEntry } = await loadPronosEntry();

    const result = buildPronosEntry(input as PronosEntryInput);

    expect({
      ok: result.ok,
      fields: result.ok ? [] : result.errors.map((e) => e.field),
    }).toEqual({ ok: false, fields: [field] });
  });

  it('AC-04: the shipped confidence tiers are exactly the three the contract documents', async () => {
    const { CONFIDENCE_TIERS } = await loadPronosEntry();

    expect([...CONFIDENCE_TIERS]).toEqual(['Indispensable', 'Prudent', 'Risqué']);
  });
});
