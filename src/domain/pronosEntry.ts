/**
 * AC-04 — a prediction is data, not prose: teams, score and confidence tier
 * are validated and stored as typed fields.
 *
 * ADR-0002: the reference to a pronos fixture is an optional, nullable
 * snapshot taken at pick time — never a required (or foreign-key) reference,
 * because pronos has not shipped fixture ingestion.
 */

import { z } from 'zod';

export const CONFIDENCE_TIERS = ['Indispensable', 'Prudent', 'Risqué'] as const;

export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

const teamName = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'must not be empty');

const optionalReference = z.string().nullish();

const PronosEntrySchema = z.object({
  home_team: teamName,
  away_team: teamName,
  predicted_home_score: z.int().min(0),
  predicted_away_score: z.int().min(0),
  confidence_tier: z.enum(CONFIDENCE_TIERS),
  pronos_league_id: optionalReference,
  pronos_game_id: optionalReference,
  match_kickoff_at: optionalReference,
});

export type PronosEntryInput = z.input<typeof PronosEntrySchema>;

export type PronosEntry = {
  home_team: string;
  away_team: string;
  predicted_home_score: number;
  predicted_away_score: number;
  confidence_tier: ConfidenceTier;
  pronos_league_id: string | null;
  pronos_game_id: string | null;
  match_kickoff_at: string | null;
};

export type FieldError = { field: string; message: string };

export type PronosEntryResult =
  | { ok: true; entry: PronosEntry }
  | { ok: false; errors: FieldError[] };

export function buildPronosEntry(input: PronosEntryInput): PronosEntryResult {
  const parsed = PronosEntrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const entry = parsed.data;
  return {
    ok: true,
    entry: {
      home_team: entry.home_team,
      away_team: entry.away_team,
      predicted_home_score: entry.predicted_home_score,
      predicted_away_score: entry.predicted_away_score,
      confidence_tier: entry.confidence_tier,
      pronos_league_id: entry.pronos_league_id ?? null,
      pronos_game_id: entry.pronos_game_id ?? null,
      match_kickoff_at: entry.match_kickoff_at ?? null,
    },
  };
}
