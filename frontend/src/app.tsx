import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient.ts';
import { arseneClient } from './lib/arseneApi.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { ComposePage } from './pages/ComposePage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { AvatarPage } from './pages/AvatarPage.tsx';

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };
type View = 'settings' | 'avatar' | null;

/** Asked at most once per browser session — a writer who skips onboarding
 *  isn't re-prompted on every reload, but a genuinely new session with no
 *  avatar set still is. */
const AVATAR_ONBOARDING_ASKED_KEY = 'arsene-avatar-onboarding-asked';

function articleIdFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}

function viewFromLocation(): View {
  const view = new URLSearchParams(window.location.search).get('view');
  return view === 'settings' || view === 'avatar' ? view : null;
}

/**
 * Four routes, handled by query params — a router library is not worth a
 * dependency for this. `?view=settings`/`?view=avatar` win over everything
 * else; otherwise no `?id=` means the home page (the article list, grouped
 * by league), and `?id={articleId}` means the editor. `detectSessionInUrl:
 * true` (supabase-js default) already resolved the magic-link fragment into
 * a real session by the time `getSession()` resolves here, so no dedicated
 * callback route is needed.
 *
 * On top of those, a **first-login gate**: once signed in, `GET
 * /v1/writers/me` is checked once per browser session (the sessionStorage
 * flag above); a `null` `avatar_url` shows `AvatarPage` with `allowSkip`
 * before anything else, regardless of which `?view=`/`?id=` the URL named.
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
  const [view, setView] = useState<View>(viewFromLocation);
  const [onboardingNeeded, setOnboardingNeeded] = useState(false);

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
  // this is the one other place articleId/view can change.
  useEffect(() => {
    const onPopState = () => {
      setArticleId(articleIdFromLocation());
      setView(viewFromLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    if (sessionStorage.getItem(AVATAR_ONBOARDING_ASKED_KEY) !== null) return;
    sessionStorage.setItem(AVATAR_ONBOARDING_ASKED_KEY, '1');
    (async () => {
      try {
        const client = await arseneClient();
        const me = (await client.getOwnWriter()) as { avatar_url: string | null };
        if (me.avatar_url === null) setOnboardingNeeded(true);
      } catch {
        // Not worth blocking sign-in over — the writer can still set a
        // photo later from "Ma photo".
      }
    })();
  }, [auth.status]);

  const navigate = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete('id');
    else url.searchParams.set('id', id);
    url.searchParams.delete('view');
    window.history.pushState(null, '', url.toString());
    setArticleId(id);
    setView(null);
  }, []);

  const navigateToView = useCallback((v: 'settings' | 'avatar') => {
    const url = new URL(window.location.href);
    url.searchParams.delete('id');
    url.searchParams.set('view', v);
    window.history.pushState(null, '', url.toString());
    setView(v);
  }, []);

  const dismissOnboarding = useCallback(() => setOnboardingNeeded(false), []);

  if (auth.status === 'loading') return null;
  if (auth.status === 'signed-out') return <LoginPage />;
  if (onboardingNeeded) return <AvatarPage done={dismissOnboarding} allowSkip />;
  if (view === 'settings') return <SettingsPage onBack={() => navigate(null)} />;
  if (view === 'avatar') return <AvatarPage done={() => navigate(null)} allowSkip={false} />;
  if (articleId === null) {
    return (
      <HomePage
        onOpenArticle={(id) => navigate(id)}
        onOpenSettings={() => navigateToView('settings')}
        onOpenAvatar={() => navigateToView('avatar')}
      />
    );
  }
  return (
    <ComposePage
      articleId={articleId}
      onBack={() => navigate(null)}
      onOpenAvatar={() => navigateToView('avatar')}
    />
  );
}
