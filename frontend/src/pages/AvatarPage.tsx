import { useAvatarUpload } from '../compose/useAvatarUpload.ts';

/**
 * One reusable component for both call sites: the first-login onboarding
 * gate (`app.tsx`, `allowSkip`) and "Ma photo" from the home/compose
 * headers (not skippable — it's already just a settings screen). Mirrors
 * `CoverImageSlot.tsx`'s upload-slot structure.
 */
export function AvatarPage({ done, allowSkip }: { done: () => void; allowSkip: boolean }) {
  const { current, uploading, uploadError, upload } = useAvatarUpload();

  const primaryLabel = !allowSkip
    ? '← Accueil'
    : current?.status === 'ready'
      ? 'Continuer'
      : 'Passer pour l’instant';

  return (
    <main className="avatar-page">
      <header className="avatar-header">
        <h1>Photo de profil</h1>
      </header>

      <p>Cette photo apparaît à côté de votre nom dans les articles publiés.</p>

      <div className="image-slot">
        {current !== null && current.status === 'ready' && current.optimized_url !== null && (
          <img className="avatar-preview" src={current.optimized_url} alt="" />
        )}

        <label>
          {current?.status === 'ready' ? 'Changer de photo' : 'Choisir une photo'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif,image/heic"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
              event.target.value = '';
            }}
          />
        </label>

        {uploading && <p>Envoi en cours…</p>}
        {uploadError !== null && (
          <p role="alert" className="error-text">
            {uploadError}
          </p>
        )}

        {current !== null && current.status === 'processing' && <p>Traitement en cours…</p>}

        {current !== null && current.status === 'failed' && (
          <p role="alert" className="error-text">
            Échec : {current.failure_message ?? 'raison inconnue'}
          </p>
        )}
      </div>

      <button type="button" onClick={done}>
        {primaryLabel}
      </button>
    </main>
  );
}
