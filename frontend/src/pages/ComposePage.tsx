import { useEffect, useRef, useState } from 'react';
import { useDraft, type DraftFields } from '../compose/useDraft.ts';
import { useTaxonomy } from '../compose/useTaxonomy.ts';
import { LockBanner } from '../compose/LockBanner.tsx';
import { SaveIndicator } from '../compose/SaveIndicator.tsx';
import { BodyEditor } from '../compose/BodyEditor.tsx';
import { CoverImageSlot } from '../compose/CoverImageSlot.tsx';
import { BodyImageList } from '../compose/BodyImageList.tsx';
import { PublishPanel } from '../compose/PublishPanel.tsx';
import { supabase } from '../lib/supabaseClient.ts';
import { HOME_LEAGUES, TYPE_NAME_PLAYER_PICKS } from '../lib/leagues.ts';

/**
 * The home page's five leagues, each offered as a Player Picks shortcut —
 * everything else still goes through "Autre"'s free-text fields below,
 * unchanged. Not a stored taxonomy table: picking one of these just fills
 * `league_name`/`type_name` with the same strings the old free-text fields
 * would have held, so the existing `useTaxonomy.resolve()` → `saveNow()`
 * pipeline needs no change.
 */
const FIXED_CATEGORIES = HOME_LEAGUES.map((l) => ({
  key: l.key,
  label: l.dropdown_label,
  league_name: l.league_name,
  type_name: TYPE_NAME_PLAYER_PICKS,
}));

/** Which dropdown option a draft's current league/type reflects — used only
 *  to restore the right selection when reopening an already-tagged draft,
 *  never to impose a default on a new one (empty fields → the placeholder). */
function categoryChoiceFor(fields: Pick<DraftFields, 'league_name' | 'type_name'>): string {
  const fixed = FIXED_CATEGORIES.find(
    (c) => c.league_name === fields.league_name && c.type_name === fields.type_name,
  );
  if (fixed !== undefined) return fixed.key;
  return fields.league_name !== '' || fields.type_name !== '' ? 'autre' : '';
}

export function ComposePage({ articleId, onBack }: { articleId: string; onBack: () => void }) {
  const { state, setField, saveNow } = useDraft(articleId);
  const taxonomy = useTaxonomy();
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);

  // No pre-selection logic for a brand-new draft (empty fields → the
  // placeholder option) — only reflects what an already-tagged draft
  // actually has, once, when it finishes loading. Runs again if the writer
  // navigates to a different draft (`state.articleId` changes), but never
  // re-derives on every keystroke, or picking "Autre" then typing something
  // that happens to match a fixed pair would fight the writer's own choice.
  const [categoryChoice, setCategoryChoice] = useState('');
  const hydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'editable' || hydratedForRef.current === state.articleId) return;
    hydratedForRef.current = state.articleId;
    setCategoryChoice(categoryChoiceFor(state.fields));
  }, [state]);

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

  const { fields } = state;

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
        <button type="button" onClick={onBack}>
          ← Accueil
        </button>
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
        <label htmlFor="category-choice">Catégorie</label>
        <select
          id="category-choice"
          value={categoryChoice}
          onChange={(event) => {
            const key = event.target.value;
            setCategoryChoice(key);
            const fixed = FIXED_CATEGORIES.find((c) => c.key === key);
            if (fixed !== undefined) {
              setField('league_name', fixed.league_name);
              setField('type_name', fixed.type_name);
            }
          }}
        >
          <option value="" disabled>
            Choisir…
          </option>
          {FIXED_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
          <option value="autre">Autre</option>
        </select>

        {categoryChoice === 'autre' && (
          <>
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
          </>
        )}

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
        onPublished={onBack}
      />
    </main>
  );
}
