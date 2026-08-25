import { useCallback, useEffect, useState } from 'react';
import { resolveCategoryPath, type TaxonomyNode } from '../../../src/domain/taxonomy.ts';
import { supabase } from '../lib/supabaseClient.ts';

type LeagueRow = { id: string; name: string };
type CategoryRow = { id: string; name: string; league_id: string };

/** AC-10: league/type creation is open, on demand, no approval — resolves
 *  against whatever already exists and creates only what's missing. */
export function useTaxonomy() {
  const [leagues, setLeagues] = useState<LeagueRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  const refresh = useCallback(async () => {
    const [leagueRes, categoryRes] = await Promise.all([
      supabase.from('arsene_leagues').select('id, name'),
      supabase.from('categories').select('id, name, league_id'),
    ]);
    setLeagues((leagueRes.data ?? []) as LeagueRow[]);
    setCategories((categoryRes.data ?? []) as CategoryRow[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = useCallback(
    async (league_name: string, type_name: string): Promise<{ league_id: string; category_id: string }> => {
      const existing: TaxonomyNode[] = [
        ...leagues.map((l) => ({ id: l.id, name: l.name, parent_id: null })),
        ...categories.map((c) => ({ id: c.id, name: c.name, parent_id: c.league_id })),
      ];
      const resolution = resolveCategoryPath({ league_name, type_name, existing });

      let league_id: string;
      if (resolution.league.created) {
        const { data, error } = await supabase
          .from('arsene_leagues')
          .insert({ name: league_name })
          .select('id')
          .single();
        if (error !== null || data === null) throw new Error(error?.message ?? 'league creation failed');
        league_id = data.id as string;
        setLeagues((prev) => [...prev, { id: league_id, name: league_name }]);
      } else {
        const found = leagues.find((l) => l.name === league_name);
        if (found === undefined) throw new Error('league resolution inconsistent');
        league_id = found.id;
      }

      let category_id: string;
      if (resolution.type.created) {
        const { data, error } = await supabase
          .from('categories')
          .insert({ name: type_name, league_id })
          .select('id')
          .single();
        if (error !== null || data === null) throw new Error(error?.message ?? 'category creation failed');
        category_id = data.id as string;
        setCategories((prev) => [...prev, { id: category_id, name: type_name, league_id }]);
      } else {
        const found = categories.find((c) => c.name === type_name && c.league_id === league_id);
        if (found === undefined) throw new Error('category resolution inconsistent');
        category_id = found.id;
      }

      return { league_id, category_id };
    },
    [leagues, categories],
  );

  return { leagues, categories, resolve };
}
