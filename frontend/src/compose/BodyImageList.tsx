import { useImageSlot } from './useImageSlot.ts';

/**
 * AC-07/08: a body image that fails conversion or is unsupported never
 * permanently blocks publish — discard clears it, upload again to retry.
 *
 * Uploads and lists body images (with editable alt text); a ready image can
 * be inserted into the body at the cursor via `onInsert` (wired by
 * `ComposePage.tsx` to `BodyEditor`'s imperative `insertImage`). Reuses this
 * list's own upload/poll/alt-text/discard machinery rather than building a
 * second, editor-internal upload flow — `sanitizePastedHtml` (`src/domain/
 * paste.ts`) only ever keeps an `<img>` on the deployment's configured CDN
 * origin, which `optimized_url` always already is.
 */
export function BodyImageList({
  articleId,
  onInsert,
}: {
  articleId: string;
  onInsert: (src: string, alt: string) => void;
}) {
  const { images, uploading, uploadError, upload, discard, setAltText } = useImageSlot(articleId, 'body');

  return (
    <div className="image-slot">
      <label>
        Ajouter une image dans le corps
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

      {images.map((image) => (
        <div key={image.id} className="image-slot">
          {image.status === 'processing' && <p>Traitement en cours…</p>}
          {image.status === 'failed' && (
            <div>
              <p role="alert" className="error-text">
                Échec : {image.failure_message ?? 'raison inconnue'}
              </p>
              <button type="button" onClick={() => void discard(image.id)}>
                Retirer
              </button>
            </div>
          )}
          {image.status === 'ready' && (
            <div>
              {image.optimized_url !== null && <img src={image.optimized_url} alt={image.alt_text ?? ''} />}
              <label>
                Texte alternatif
                <input
                  type="text"
                  value={image.alt_text ?? ''}
                  onChange={(event) => void setAltText(image.id, event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={image.optimized_url === null}
                onClick={() => image.optimized_url !== null && onInsert(image.optimized_url, image.alt_text ?? '')}
              >
                Insérer dans le texte
              </button>
              <button type="button" onClick={() => void discard(image.id)}>
                Retirer
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
