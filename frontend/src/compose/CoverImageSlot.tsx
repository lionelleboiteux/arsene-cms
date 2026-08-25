import { useImageSlot } from './useImageSlot.ts';

/** AC-06: the cover is a distinct slot from body images — required before
 *  publish. Uploading again while a `ready` cover exists demotes it to a
 *  body image server-side; refetching this slot's rows reflects that
 *  automatically (the demoted row just stops matching `role: cover`). */
export function CoverImageSlot({ articleId }: { articleId: string }) {
  const { images, uploading, uploadError, upload, discard, setAltText } = useImageSlot(articleId, 'cover');
  const current = images.at(-1) ?? null;

  return (
    <div className="image-slot">
      <label>
        Image de couverture
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
        <div>
          <p role="alert" className="error-text">
            Échec : {current.failure_message ?? 'raison inconnue'}
          </p>
          <button type="button" onClick={() => void discard(current.id)}>
            Retirer et réessayer
          </button>
        </div>
      )}

      {current !== null && current.status === 'ready' && (
        <div>
          {current.optimized_url !== null && <img src={current.optimized_url} alt={current.alt_text ?? ''} />}
          <label>
            Texte alternatif
            <input
              type="text"
              value={current.alt_text ?? ''}
              onChange={(event) => void setAltText(current.id, event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}
