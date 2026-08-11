import { describe, expect, it } from 'vitest';
import { loadTaxonomy } from '../support/seams.js';
import type { TaxonomyNode } from '../support/seams.js';

/**
 * League > type taxonomy. Creating a category is open to every writer with no
 * approval step (spec §2, §8), and 01-decisions.md #2 rules out any automatic
 * de-duplication of near-duplicate names.
 */

const LIGUE_1: TaxonomyNode = { id: 'lg-1', name: 'Ligue 1', parent_id: null };
const SERIE_A: TaxonomyNode = { id: 'lg-2', name: 'Serie A', parent_id: null };

describe('category creation', () => {
  it('AC-10: assigning an article to a league and type that do not exist creates both, nested league-then-type, with no approval step', async () => {
    const { resolveCategoryPath } = await loadTaxonomy();

    const resolution = resolveCategoryPath({
      league_name: 'Serie A',
      type_name: 'Team Presentations',
      existing: [LIGUE_1],
    });

    expect(resolution).toEqual({
      league: { name: 'Serie A', created: true },
      type: { name: 'Team Presentations', created: true, parent_name: 'Serie A' },
      path: ['Serie A', 'Team Presentations'],
    });
  });

  it('AC-10: an existing league is reused rather than duplicated when only the type is new', async () => {
    const { resolveCategoryPath } = await loadTaxonomy();

    const resolution = resolveCategoryPath({
      league_name: 'Serie A',
      type_name: 'Mercato',
      existing: [SERIE_A, { id: 'ct-1', name: 'Team Presentations', parent_id: 'lg-2' }],
    });

    expect(resolution).toEqual({
      league: { name: 'Serie A', created: false },
      type: { name: 'Mercato', created: true, parent_name: 'Serie A' },
      path: ['Serie A', 'Mercato'],
    });
  });

  it('DEC-02: a near-duplicate league name ("ligue1" next to "Ligue 1") is created as its own category, because v1 does no automatic merging', async () => {
    const { resolveCategoryPath } = await loadTaxonomy();

    const resolution = resolveCategoryPath({
      league_name: 'ligue1',
      type_name: 'Pronos',
      existing: [LIGUE_1, { id: 'ct-2', name: 'Pronos', parent_id: 'lg-1' }],
    });

    expect(resolution).toEqual({
      league: { name: 'ligue1', created: true },
      type: { name: 'Pronos', created: true, parent_name: 'ligue1' },
      path: ['ligue1', 'Pronos'],
    });
  });
});
