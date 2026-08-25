import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient.ts';

/**
 * Passwordless — writers have no password (`scripts/create-writer.ts` only
 * ever mints a magic link, and Supabase's own signInWithOtp is the same
 * mechanism self-served). `emailRedirectTo` is this page's own origin, so
 * clicking the link lands back on `/compose`, session already established
 * (supabase-js's default `detectSessionInUrl: true` handles the token in the
 * URL fragment before this component ever mounts).
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
      options: { emailRedirectTo: `${window.location.origin}/compose` },
    });

    if (error) {
      setStatus('error');
      setErrorMessage(error.message);
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
