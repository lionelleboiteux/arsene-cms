import { useState } from 'react';
import { useDraft } from '../compose/useDraft.ts';
import { useTaxonomy } from '../compose/useTaxonomy.ts';
import { LockBanner } from '../compose/LockBanner.tsx';
import { SaveIndicator } from '../compose/SaveIndicator.tsx';
import { BodyEditor } from '../compose/BodyEditor.tsx';
import { CoverImageSlot } from '../compose/CoverImageSlot.tsx';
import { BodyImageList } from '../compose/BodyImageList.tsx';
import { PublishPanel } from '../compose/PublishPanel.tsx';
import { supabase } from '../lib/supabaseClient.ts';

function currentArticleId(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}

export function ComposePage({ writerId: _writerId }: { writerId: string }) {
  const { state, setField, saveNow } = useDraft(currentArticleId());
  const taxonomy = useTaxonomy();
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);

  if (state.status === 'loading') {
    return (
      <main className="compose-page">
        <p>Chargement…</p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="compose-page">
        <div className="error-banner" role="alert">
          {state.message}
        </div>
      </main>
    );
  }

  if (state.status === 'locked') {
    return (
      <main className="compose-page">
        <LockBanner lockedByDisplayName={state.locked_by_display_name} />
      </main>
    );
  }

  const { articleId, fields } = state;

  async function confirmTaxonomy() {
    setTaxonomyError(null);
    try {
      const { league_id, category_id } = await taxonomy.resolve(fields.league_name, fields.type_name);
      await saveNow({ league_id, category_id });
    } catch (err) {
      setTaxonomyError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="compose-page">
      <header className="compose-header">
        <SaveIndicator indicator={state.savedIndicator} />
        <button type="button" onClick={() => void supabase.auth.signOut()}>
          Se déconnecter
        </button>
      </header>

      <div className="field-row">
        <label htmlFor="title">Titre</label>
        <input
          id="title"
          type="text"
          value={fields.title}
          onChange={(event) => setField('title', event.target.value)}
          placeholder="Sans titre"
        />
      </div>

      <div className="field-row">
        <label htmlFor="league">Ligue</label>
        <input
          id="league"
          type="text"
          list="league-options"
          value={fields.league_name}
          onChange={(event) => setField('league_name', event.target.value)}
        />
        <datalist id="league-options">
          {taxonomy.leagues.map((l) => (
            <option key={l.id} value={l.name} />
          ))}
        </datalist>

        <label htmlFor="type">Type</label>
        <input
          id="type"
          type="text"
          list="type-options"
          value={fields.type_name}
          onChange={(event) => setField('type_name', event.target.value)}
        />
        <datalist id="type-options">
          {taxonomy.categories.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>

        <button
          type="button"
          onClick={() => void confirmTaxonomy()}
          disabled={fields.league_name === '' || fields.type_name === ''}
        >
          Valider la catégorie
        </button>
        {taxonomyError !== null && (
          <p role="alert" className="error-text">
            {taxonomyError}
          </p>
        )}
      </div>

      <div className="field-row">
        <label htmlFor="body">Contenu</label>
        <BodyEditor value={fields.body_html} onChange={(html) => setField('body_html', html)} />
      </div>

      <CoverImageSlot articleId={articleId} />

      <BodyImageList articleId={articleId} />

      <PublishPanel
        articleId={articleId}
        fields={fields}
        onMetaChange={(meta_title, meta_description) => {
          setField('meta_title', meta_title);
          setField('meta_description', meta_description);
        }}
      />
    </main>
  );
}
