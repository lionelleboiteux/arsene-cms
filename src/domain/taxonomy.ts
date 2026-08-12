/**
 * AC-10 — league > type taxonomy. Whichever level is missing is created, with
 * no approval step.
 *
 * 01-decisions.md #2: names are matched exactly. "ligue1" next to "Ligue 1"
 * becomes its own league; v1 never merges near-duplicates automatically.
 */

export type TaxonomyNode = { id: string | null; name: string; parent_id: string | null };

export type TaxonomyResolution = {
  league: { name: string; created: boolean };
  type: { name: string; created: boolean; parent_name: string };
  path: string[];
};

export function resolveCategoryPath(input: {
  league_name: string;
  type_name: string;
  existing: TaxonomyNode[];
}): TaxonomyResolution {
  const league = input.existing.find(
    (node) => node.parent_id === null && node.name === input.league_name,
  );
  const type = league
    ? input.existing.find(
        (node) => node.parent_id === league.id && node.name === input.type_name,
      )
    : undefined;

  return {
    league: { name: input.league_name, created: league === undefined },
    type: {
      name: input.type_name,
      created: type === undefined,
      parent_name: input.league_name,
    },
    path: [input.league_name, input.type_name],
  };
}
