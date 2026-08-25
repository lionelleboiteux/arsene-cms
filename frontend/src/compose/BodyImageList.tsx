import { useImageSlot } from './useImageSlot.ts';

/**
 * AC-07/08: a body image that fails conversion or is unsupported never
 * permanently blocks publish — discard clears it, upload again to retry.
 *
 * Uploads and lists body images (with editable alt text) but does not embed
 * them into `body_html`: `src/domain/paste.ts`'s `ALLOWED_TAGS` excludes
 * `img`, and the same sanitizer runs again server-side at publish
 * (`publishArticle.ts`), so an inserted `<img>` tag would be silently
 * stripped on publish. Extending the shared, already-tested sanitizer to
 * allow `img` (with a real `src`-origin restriction, not just an
 * allowlisted tag) is a deliberate follow-up, not a rushed one.
 */
export function BodyImageList({ articleId }: { articleId: string }) {
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
