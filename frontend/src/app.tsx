import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { ComposePage } from './pages/ComposePage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

function articleIdFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}

function isSettingsViewFromLocation(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'settings';
}

/**
 * Three routes, handled by query params — a router library is not worth a
 * dependency for this. `?view=settings` wins over everything else (the
 * settings page doesn't care whether an `?id=` happens to also be present);
 * otherwise no `?id=` means the home page (the article list, grouped by
 * league), and `?id={articleId}` means the editor. `detectSessionInUrl: true`
 * (supabase-js default) already resolved the magic-link fragment into a real
 * session by the time `getSession()` resolves here, so no dedicated callback
 * route is needed.
 *
 * The settings nav link (`HomePage.tsx`) is shown unconditionally, not just
 * to writers who are admins — client-side hiding would be UX polish only,
 * never the real enforcement, since the actual gate is `verifyAdmin()` on
 * `/v1/admin/*` (`router.ts`) and `SettingsPage` itself just shows "not
 * authorized" on the 401 its first fetch gets back for anyone else.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [articleId, setArticleId] = useState<string | null>(articleIdFromLocation);
  const [showSettings, setShowSettings] = useState<boolean>(isSettingsViewFromLocation);

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
  // this is the one other place articleId/showSettings can change.
  useEffect(() => {
    const onPopState = () => {
      setArticleId(articleIdFromLocation());
      setShowSettings(isSettingsViewFromLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete('id');
    else url.searchParams.set('id', id);
    url.searchParams.delete('view');
    window.history.pushState(null, '', url.toString());
    setArticleId(id);
    setShowSettings(false);
  }, []);

  const navigateToSettings = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('id');
    url.searchParams.set('view', 'settings');
    window.history.pushState(null, '', url.toString());
    setShowSettings(true);
  }, []);

  if (auth.status === 'loading') return null;
  if (auth.status === 'signed-out') return <LoginPage />;
  if (showSettings) return <SettingsPage onBack={() => navigate(null)} />;
  if (articleId === null) return <HomePage onOpenArticle={(id) => navigate(id)} onOpenSettings={navigateToSettings} />;
  return <ComposePage articleId={articleId} onBack={() => navigate(null)} />;
}
