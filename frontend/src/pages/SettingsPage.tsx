import { useEffect, useState, type FormEvent } from 'react';
import { arseneClient } from '../lib/arseneApi.ts';
import { ArseneApiError } from '../../../src/api/client.ts';

type Writer = {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  created_at: string;
  revoked_at: string | null;
};

/** Same shape as `PublishPanel.tsx`'s `messageFor()` — a known `code` gets a
 *  French message written for a writer to read, anything else falls back to
 *  the backend's own (English, developer-facing) message. */
function actionErrorMessage(err: unknown): string {
  if (err instanceof ArseneApiError && err.code === 'LAST_ADMIN_CANNOT_BE_REVOKED') {
    return 'Ce rédacteur est le dernier administrateur actif — le révoquer bloquerait tout le monde.';
  }
  return err instanceof Error ? err.message : String(err);
}

type LoadState =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }
  | { status: 'ready'; writers: Writer[] };

/**
 * Admin-only (`router.ts`'s `verifyAdmin`) — reachable by anyone signed in
 * (see `app.tsx`'s own comment on why the nav link isn't hidden), but every
 * request here goes through the real gate, so a non-admin just gets
 * "forbidden" from the first fetch's 401, exactly like any other refused
 * caller of `/v1/admin/*`.
 */
export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ email: string; sign_in_link: string | null } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  async function refresh() {
    setState({ status: 'loading' });
    try {
      const client = await arseneClient();
      const res = (await client.listWriters()) as { writers: Writer[] };
      setState({ status: 'ready', writers: res.writers });
    } catch (err) {
      if (err instanceof ArseneApiError && err.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteError(null);
    setInviteResult(null);
    setInviting(true);
    try {
      const client = await arseneClient();
      const res = (await client.inviteWriter({ email: inviteEmail, display_name: inviteName })) as {
        writer: Writer;
        sign_in_link: string | null;
      };
      setInviteResult({ email: res.writer.email, sign_in_link: res.sign_in_link });
      setInviteEmail('');
      setInviteName('');
      await refresh();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviting(false);
    }
  }

  async function handleAction(writerId: string, action: 'revoke' | 'reinstate') {
    setActionError(null);
    setActingOn(writerId);
    try {
      const client = await arseneClient();
      await client.setWriterRevoked({ writerId, action });
      await refresh();
    } catch (err) {
      setActionError(actionErrorMessage(err));
    } finally {
      setActingOn(null);
    }
  }

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button type="button" onClick={onBack}>
          ← Accueil
        </button>
        <h1>Réglages</h1>
      </header>

      <section className="settings-section">
        <h2>Rédacteurs</h2>

        {state.status === 'loading' && <p>Chargement…</p>}
        {state.status === 'forbidden' && (
          <p role="alert" className="error-text">
            Accès réservé à l'administrateur.
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="error-text">
            {state.message}
          </p>
        )}

        {state.status === 'ready' && (
          <>
            <ul className="writer-list">
              {state.writers.map((writer) => (
                <li key={writer.id}>
                  <span className="writer-email">{writer.email}</span>
                  <span className="writer-name">{writer.display_name}</span>
                  {writer.is_admin && <span className="status-badge status-admin">Admin</span>}
                  <span className={`status-badge ${writer.revoked_at === null ? 'status-published' : 'status-draft'}`}>
                    {writer.revoked_at === null ? 'Actif' : 'Révoqué'}
                  </span>
                  <button
                    type="button"
                    disabled={actingOn === writer.id}
                    onClick={() =>
                      void handleAction(writer.id, writer.revoked_at === null ? 'revoke' : 'reinstate')
                    }
                  >
                    {writer.revoked_at === null ? 'Révoquer' : 'Réactiver'}
                  </button>
                </li>
              ))}
            </ul>
            {actionError !== null && (
              <p role="alert" className="error-text">
                {actionError}
              </p>
            )}

            <form onSubmit={(event) => void handleInvite(event)} className="invite-form">
              <label htmlFor="invite-email">E-mail</label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <label htmlFor="invite-name">Nom affiché</label>
              <input
                id="invite-name"
                type="text"
                required
                value={inviteName}
                onChange={(event) => setInviteName(event.target.value)}
              />
              <button type="submit" disabled={inviting}>
                {inviting ? 'Invitation…' : 'Inviter'}
              </button>
            </form>
            {inviteError !== null && (
              <p role="alert" className="error-text">
                {inviteError}
              </p>
            )}
            {inviteResult !== null && (
              <p role="status">
                {inviteResult.email} ajouté.
                {inviteResult.sign_in_link !== null && (
                  <>
                    {' '}
                    Lien de connexion : <code>{inviteResult.sign_in_link}</code>
                  </>
                )}
              </p>
            )}
          </>
        )}
      </section>

      <section className="settings-section">
        <h2>SEO</h2>
        <p className="empty">À venir.</p>
      </section>
    </main>
  );
}
