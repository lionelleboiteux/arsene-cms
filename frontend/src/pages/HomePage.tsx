import { useState } from 'react';
import { supabase } from '../lib/supabaseClient.ts';
import { arseneClient } from '../lib/arseneApi.ts';
import { useArticleList, type ArticleListItem } from '../home/useArticleList.ts';
import { useTaxonomy } from '../compose/useTaxonomy.ts';
import { EXTRA_LEAGUE_CATEGORIES, HOME_LEAGUES, TYPE_NAME_PLAYER_PICKS } from '../lib/leagues.ts';

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
export function HomePage({
  onOpenArticle,
  onOpenSettings,
}: {
  onOpenArticle: (articleId: string) => void;
  onOpenSettings: () => void;
}) {
  const { articles, loading, refresh } = useArticleList();
  const taxonomy = useTaxonomy();
  // Keyed by `${league_name}:${type_name}` — a league can now offer more
  // than one quick-create button (e.g. Bundesliga's PP + Guides), so the
  // league name alone no longer uniquely identifies which one is in flight.
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function createArticle(league_name: string, type_name: string) {
    setCreateError(null);
    setCreating(`${league_name}:${type_name}`);
    try {
      const client = await arseneClient();
      const created = (await client.createDraft()) as { article_id: string };
      const { league_id, category_id } = await taxonomy.resolve(league_name, type_name);
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
        <div className="home-header-actions">
          <button type="button" onClick={onOpenSettings}>
            Réglages
          </button>
          <button type="button" onClick={() => void supabase.auth.signOut()}>
            Se déconnecter
          </button>
        </div>
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
          {HOME_LEAGUES.map((league) => {
            const quickCreates = [
              {
                label: 'Nouveau PP',
                onClick: () => void createArticle(league.league_name, TYPE_NAME_PLAYER_PICKS),
                creating: creating === `${league.league_name}:${TYPE_NAME_PLAYER_PICKS}`,
              },
              ...EXTRA_LEAGUE_CATEGORIES.filter((c) => c.league_name === league.league_name).map((c) => ({
                label: c.button_label,
                onClick: () => void createArticle(c.league_name, c.type_name),
                creating: creating === `${c.league_name}:${c.type_name}`,
              })),
            ];
            return (
              <LeagueSection
                key={league.key}
                title={league.league_name}
                articles={articles.filter((a) => a.league_name === league.league_name)}
                onOpenArticle={onOpenArticle}
                quickCreates={quickCreates}
              />
            );
          })}

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
  quickCreates,
}: {
  title: string;
  articles: ArticleListItem[];
  onOpenArticle: (articleId: string) => void;
  quickCreates?: { label: string; onClick: () => void; creating: boolean }[];
}) {
  return (
    <section className="league-section">
      <h2>{title}</h2>
      {quickCreates?.map((qc) => (
        <button key={qc.label} type="button" onClick={qc.onClick} disabled={qc.creating}>
          {qc.creating ? 'Création…' : qc.label}
        </button>
      ))}
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
