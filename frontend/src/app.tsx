import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { ComposePage } from './pages/ComposePage.tsx';
import { HomePage } from './pages/HomePage.tsx';

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

function articleIdFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}

/**
 * Two routes, handled by a single `?id=` query param — a router library is
 * not worth a dependency for this. No `?id=` means the home page (the
 * article list, grouped by league); `?id={articleId}` means the editor.
 * `detectSessionInUrl: true` (supabase-js default) already resolved the
 * magic-link fragment into a real session by the time `getSession()`
 * resolves here, so no dedicated callback route is needed.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [articleId, setArticleId] = useState<string | null>(articleIdFromLocation);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuth(data.session === null ? { status: 'signed-out' } : { status: 'signed-in', session: data.session });
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuth(session === null ? { status: 'signed-out' } : { status: 'signed-in', session });
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  // Browser back/forward — pushState below doesn't fire popstate itself, so
  // this is the one other place articleId can change.
  useEffect(() => {
    const onPopState = () => setArticleId(articleIdFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete('id');
    else url.searchParams.set('id', id);
    window.history.pushState(null, '', url.toString());
    setArticleId(id);
  }, []);

  if (auth.status === 'loading') return null;
  if (auth.status === 'signed-out') return <LoginPage />;
  if (articleId === null) return <HomePage onOpenArticle={(id) => navigate(id)} />;
  return <ComposePage articleId={articleId} onBack={() => navigate(null)} />;
}
