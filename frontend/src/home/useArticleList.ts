import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.ts';
import { embeddedName } from '../lib/embeddedName.ts';

export type ArticleListItem = {
  id: string;
  title: string;
  status: 'draft' | 'published';
  league_name: string | null;
  updated_at: string;
};

type ArticleRow = {
  id: string;
  title: string;
  status: 'draft' | 'published';
  updated_at: string;
  arsene_leagues: unknown;
};

/**
 * Every writer's articles, every status — the home page's whole reason for
 * being. No `writer_id` filter: nothing else in this app treats a draft as
 * one writer's alone (locking exists precisely because they're shared), so
 * narrowing this list to "mine" would be new, unprecedented behaviour.
 */
export function useArticleList() {
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('articles')
      .select('id, title, status, updated_at, arsene_leagues(name)')
      .order('updated_at', { ascending: false });
    setArticles(
      ((data ?? []) as ArticleRow[]).map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        updated_at: row.updated_at,
        league_name: embeddedName(row.arsene_leagues) || null,
      })),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { articles, loading, refresh };
}
