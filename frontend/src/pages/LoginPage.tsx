import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient.ts';

/**
 * Passwordless — writers have no password (`scripts/create-writer.ts` only
 * ever mints a magic link, and Supabase's own signInWithOtp is the same
 * mechanism self-served). `emailRedirectTo` is this page's own origin, so
 * clicking the link lands back on `/compose`, session already established
 * (supabase-js's default `detectSessionInUrl: true` handles the token in the
 * URL fragment before this component ever mounts).
 *
 * `shouldCreateUser: false` — without it, `signInWithOtp` silently creates
 * a brand-new (writer-less) Supabase Auth account for *any* typed email,
 * including a mistyped one, and still reports success. That real account
 * gets a real session and a real magic link, but `router.ts`'s `verify()`
 * rejects every API call from it (no matching `writers` row) with a flat
 * "Auth bearer token required" — indistinguishable from an expired link,
 * so "just request a new one" never helps. Confirmed live: exactly this
 * happened to a writer who typed a plausible-looking but wrong address.
 * With this flag, Supabase refuses upfront (`otp_disabled`) instead of
 * quietly minting an unusable account.
 */
export function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('sending');
    setErrorMessage(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/compose`, shouldCreateUser: false },
    });

    if (error) {
      setStatus('error');
      setErrorMessage(
        error.code === 'otp_disabled'
          ? "Cette adresse n'est pas reconnue comme celle d'un·e rédacteur·ice. Vérifiez que vous utilisez bien l'adresse à laquelle vous avez été invité(e), ou contactez un administrateur."
          : error.message,
      );
      return;
    }
    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <main className="auth-page">
        <h1>Vérifiez vos e-mails</h1>
        <p>
          Un lien de connexion a été envoyé à <strong>{email}</strong>. Ouvrez-le pour accéder à
          l'éditeur.
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Arsène — Éditeur</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Adresse e-mail</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={status === 'sending'}
        />
        <button type="submit" disabled={status === 'sending' || email === ''}>
          {status === 'sending' ? 'Envoi…' : 'Recevoir un lien de connexion'}
        </button>
        {status === 'error' && errorMessage !== null && (
          <p role="alert" className="error-text">
            {errorMessage}
          </p>
        )}
      </form>
    </main>
  );
}
