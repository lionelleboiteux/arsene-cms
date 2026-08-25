import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { ComposePage } from './pages/ComposePage.tsx';

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

/**
 * Two routes, handled by `location.pathname` — a router library is not worth
 * a dependency for this. `detectSessionInUrl: true` (supabase-js default)
 * already resolved the magic-link fragment into a real session by the time
 * `getSession()` resolves here, so no dedicated callback route is needed.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuth(data.session === null ? { status: 'signed-out' } : { status: 'signed-in', session: data.session });
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuth(session === null ? { status: 'signed-out' } : { status: 'signed-in', session });
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  if (auth.status === 'loading') return null;
  if (auth.status === 'signed-out') return <LoginPage />;
  return <ComposePage writerId={auth.session.user.id} />;
}
