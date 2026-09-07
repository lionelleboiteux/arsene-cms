import { useState } from 'react';
import { supabase } from '../lib/supabaseClient.ts';
import { arseneClient } from '../lib/arseneApi.ts';
import { useArticleList, type ArticleListItem } from '../home/useArticleList.ts';
import { useTaxonomy } from '../compose/useTaxonomy.ts';
import { HOME_LEAGUES, TYPE_NAME_PLAYER_PICKS } from '../lib/leagues.ts';

const STATUS_LABEL: Record<ArticleListItem['status'], string> = {
  draft: 'Brouillon',
  published: 'Publié',
};

/**
 * Lands here on sign-in and after every publish (`app.tsx` shows this
 * whenever there's no `?id=` in the URL) — every article, every writer,
 * every status, grouped by league (AC per the product ask: "Nouveau PP"
 * under each of the five leagues, plus whatever's already there).
 */
export function HomePage({ onOpenArticle }: { onOpenArticle: (articleId: string) => void }) {
  const { articles, loading, refresh } = useArticleList();
  const taxonomy = useTaxonomy();
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function createPlayerPicks(league_name: string) {
    setCreateError(null);
    setCreating(league_name);
    try {
      const client = await arseneClient();
      const created = (await client.createDraft()) as { article_id: string };
      const { league_id, category_id } = await taxonomy.resolve(league_name, TYPE_NAME_PLAYER_PICKS);
      const { error } = await supabase
        .from('articles')
        .update({ league_id, category_id })
        .eq('id', created.article_id);
      if (error !== null) throw new Error(error.message);
      onOpenArticle(created.article_id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(null);
    }
  }

  const other = articles.filter(
    (a) => !HOME_LEAGUES.some((l) => l.league_name === a.league_name),
  );

  return (
    <main className="home-page">
      <header className="home-header">
        <h1>Arsène</h1>
        <button type="button" onClick={() => void supabase.auth.signOut()}>
          Se déconnecter
        </button>
      </header>

      {createError !== null && (
        <p role="alert" className="error-text">
          {createError}
        </p>
      )}

      {loading ? (
        <p>Chargement…</p>
      ) : (
        <>
          {HOME_LEAGUES.map((league) => (
            <LeagueSection
              key={league.key}
              title={league.league_name}
              articles={articles.filter((a) => a.league_name === league.league_name)}
              onOpenArticle={onOpenArticle}
              onCreate={() => void createPlayerPicks(league.league_name)}
              creating={creating === league.league_name}
            />
          ))}

          {other.length > 0 && (
            <LeagueSection title="Autres" articles={other} onOpenArticle={onOpenArticle} />
          )}
        </>
      )}

      <button type="button" onClick={() => void refresh()} className="refresh-button">
        Actualiser
      </button>
    </main>
  );
}

function LeagueSection({
  title,
  articles,
  onOpenArticle,
  onCreate,
  creating,
}: {
  title: string;
  articles: ArticleListItem[];
  onOpenArticle: (articleId: string) => void;
  onCreate?: () => void;
  creating?: boolean;
}) {
  return (
    <section className="league-section">
      <h2>{title}</h2>
      {onCreate !== undefined && (
        <button type="button" onClick={onCreate} disabled={creating === true}>
          {creating === true ? 'Création…' : 'Nouveau PP'}
        </button>
      )}
      {articles.length === 0 ? (
        <p className="empty">Aucun article</p>
      ) : (
        <ul className="article-list">
          {articles.map((article) => (
            <li key={article.id}>
              <button type="button" className="article-link" onClick={() => onOpenArticle(article.id)}>
                {article.title === '' ? 'Sans titre' : article.title}
              </button>
              <span className={`status-badge status-${article.status}`}>{STATUS_LABEL[article.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
