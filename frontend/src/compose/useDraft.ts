import { useCallback, useEffect, useRef, useState } from 'react';
import { evaluateAutosave, AUTOSAVE_INTERVAL_MS } from '../../../src/domain/autosave.ts';
import { HEARTBEAT_INTERVAL_MS } from '../../../src/domain/lock.ts';
import { ArseneApiError } from '../../../src/api/client.ts';
import { supabase } from '../lib/supabaseClient.ts';
import { arseneClient } from '../lib/arseneApi.ts';

/** Retry cadence while waiting to acquire a lock someone else holds —
 *  deliberately different from the 20s heartbeat cadence, so "trying to
 *  acquire" is never confused with "holding". */
const LOCK_RETRY_INTERVAL_MS = 15_000;

export type DraftFields = {
  title: string;
  body_html: string;
  league_id: string | null;
  category_id: string | null;
  league_name: string;
  type_name: string;
  meta_title: string;
  meta_description: string;
};

export type DraftState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'locked';
      locked_by_display_name: string;
    }
  | {
      status: 'editable';
      articleId: string;
      fields: DraftFields;
      lastSavedAt: Date | null;
      savedIndicator: string | null;
    };

function lockedByDisplayName(details: unknown): string {
  const name = (details as { locked_by_display_name?: unknown } | null)?.locked_by_display_name;
  return typeof name === 'string' && name.length > 0 ? name : 'quelqu’un';
}

function emptyFields(): DraftFields {
  return {
    title: '',
    body_html: '',
    league_id: null,
    category_id: null,
    league_name: '',
    type_name: '',
    meta_title: '',
    meta_description: '',
  };
}

/** No generated Supabase `Database` types are wired up for this small app, so
 *  an embedded relation's inferred shape isn't reliable — PostgREST returns
 *  it as a single object for a to-one foreign key either way. */
function embeddedName(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  const name = (row as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
}

async function hydrateExtraFields(articleId: string): Promise<Partial<DraftFields>> {
  const { data } = await supabase
    .from('articles')
    .select('league_id, category_id, meta_title, meta_description, arsene_leagues(name), categories(name)')
    .eq('id', articleId)
    .single();
  if (data === null) return {};
  const row = data as unknown as {
    league_id: string | null;
    category_id: string | null;
    meta_title: string | null;
    meta_description: string | null;
    arsene_leagues: unknown;
    categories: unknown;
  };
  return {
    league_id: row.league_id,
    category_id: row.category_id,
    league_name: embeddedName(row.arsene_leagues),
    type_name: embeddedName(row.categories),
    meta_title: row.meta_title ?? '',
    meta_description: row.meta_description ?? '',
  };
}

export function useDraft(articleIdFromUrl: string | null) {
  const [state, setState] = useState<DraftState>({ status: 'loading' });
  const dirtyRef = useRef(false);
  const lastEditAtRef = useRef(new Date());
  const lastSavedAtRef = useRef<Date | null>(null);

  const setField = useCallback(<K extends keyof DraftFields>(key: K, value: DraftFields[K]) => {
    dirtyRef.current = true;
    lastEditAtRef.current = new Date();
    setState((prev) => (prev.status === 'editable' ? { ...prev, fields: { ...prev.fields, [key]: value } } : prev));
  }, []);

  /** Exposed for `useTaxonomy`: an immediate write, not waiting on the next
   *  autosave tick, since it also gates the image/publish flow. */
  const saveNow = useCallback(async (patch: Partial<DraftFields>) => {
    setState((prev) => {
      if (prev.status !== 'editable') return prev;
      const fields = { ...prev.fields, ...patch };
      void supabase
        .from('articles')
        .update({
          title: fields.title,
          body_html: fields.body_html,
          league_id: fields.league_id,
          category_id: fields.category_id,
          meta_title: fields.meta_title,
          meta_description: fields.meta_description,
          updated_at: new Date().toISOString(),
        })
        .eq('id', prev.articleId);
      return { ...prev, fields };
    });
  }, []);

  // ---- mount: create or open -------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function tryOpen(articleId: string) {
      try {
        const client = await arseneClient();
        const opened = (await client.openDraft({ articleId })) as { title: string; body_html: string };
        if (cancelled) return;
        const extra = await hydrateExtraFields(articleId);
        lastSavedAtRef.current = new Date();
        setState({
          status: 'editable',
          articleId,
          fields: { ...emptyFields(), title: opened.title, body_html: opened.body_html, ...extra },
          lastSavedAt: lastSavedAtRef.current,
          savedIndicator: null,
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ArseneApiError && err.code === 'DRAFT_LOCKED') {
          setState({ status: 'locked', locked_by_display_name: lockedByDisplayName(err.details) });
          retryTimer = setTimeout(() => void tryOpen(articleId), LOCK_RETRY_INTERVAL_MS);
          return;
        }
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    async function createNew() {
      try {
        const client = await arseneClient();
        const created = (await client.createDraft()) as { article_id: string };
        if (cancelled) return;
        const url = new URL(window.location.href);
        url.searchParams.set('id', created.article_id);
        window.history.replaceState(null, '', url.toString());
        lastSavedAtRef.current = new Date();
        setState({
          status: 'editable',
          articleId: created.article_id,
          fields: emptyFields(),
          lastSavedAt: lastSavedAtRef.current,
          savedIndicator: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    if (articleIdFromUrl === null) void createNew();
    else void tryOpen(articleIdFromUrl);

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleIdFromUrl]);

  // ---- heartbeat: only while holding the lock ---------------------------
  useEffect(() => {
    if (state.status !== 'editable') return;
    const articleId = state.articleId;

    const interval = setInterval(() => {
      void (async () => {
        try {
          const client = await arseneClient();
          await client.openDraft({ articleId });
        } catch (err) {
          if (err instanceof ArseneApiError && err.code === 'DRAFT_LOCKED') {
            setState({ status: 'locked', locked_by_display_name: lockedByDisplayName(err.details) });
          }
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [state.status, state.status === 'editable' ? state.articleId : null]);

  // ---- autosave: a 1s local tick feeding the pure decision ---------------
  useEffect(() => {
    if (state.status !== 'editable') return;
    const articleId = state.articleId;

    const tick = setInterval(() => {
      const decision = evaluateAutosave({
        now: new Date(),
        dirty: dirtyRef.current,
        last_edit_at: lastEditAtRef.current,
        last_saved_at: lastSavedAtRef.current,
      });
      if (decision.save) {
        dirtyRef.current = false;
        lastSavedAtRef.current = new Date();
        setState((prev) => {
          if (prev.status !== 'editable') return prev;
          const { fields } = prev;
          void supabase
            .from('articles')
            .update({
              title: fields.title,
              body_html: fields.body_html,
              league_id: fields.league_id,
              category_id: fields.category_id,
              meta_title: fields.meta_title,
              meta_description: fields.meta_description,
              updated_at: new Date().toISOString(),
            })
            .eq('id', articleId);
          return { ...prev, savedIndicator: decision.indicator, lastSavedAt: lastSavedAtRef.current };
        });
      } else {
        setState((prev) => (prev.status === 'editable' ? { ...prev, savedIndicator: decision.indicator } : prev));
      }
    }, 1_000);

    return () => clearInterval(tick);
  }, [state.status, state.status === 'editable' ? state.articleId : null]);

  return { state, setField, saveNow };
}

export { AUTOSAVE_INTERVAL_MS };
