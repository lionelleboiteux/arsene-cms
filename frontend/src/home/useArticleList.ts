import { useCallback, useEffect, useState } from 'react';
import { supabase, SITE_ORIGIN } from '../lib/supabaseClient.ts';
import { embeddedName } from '../lib/embeddedName.ts';
import { articlePath } from '../../../src/domain/seo.ts';

export type ArticleListItem = {
  id: string;
  title: string;
  status: 'draft' | 'published';
  league_name: string | null;
  updated_at: string;
  /** The live public page, for the home page's "open in a new tab" icon —
   *  null for a draft, which has no public page to open (`articlePath`
   *  needs `first_published_at`/`slug`, neither set until publish). */
  public_url: string | null;
};

type ArticleRow = {
  id: string;
  title: string;
  status: 'draft' | 'published';
  updated_at: string;
  slug: string | null;
  first_published_at: string | null;
  arsene_leagues: unknown;
  categories: unknown;
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
      .select('id, title, status, updated_at, slug, first_published_at, arsene_leagues(name), categories(name)')
      .order('updated_at', { ascending: false });
    setArticles(
      ((data ?? []) as ArticleRow[]).map((row) => {
        const league_name = embeddedName(row.arsene_leagues) || null;
        const type_name = embeddedName(row.categories) || null;
        const public_url =
          row.status === 'published' &&
          league_name !== null &&
          type_name !== null &&
          row.slug !== null &&
          row.first_published_at !== null
            ? `${SITE_ORIGIN}${articlePath({
                league_name,
                type_name,
                first_published_at: row.first_published_at,
                slug: row.slug,
              })}`
            : null;
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          updated_at: row.updated_at,
          league_name,
          public_url,
        };
      }),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { articles, loading, refresh };
}
