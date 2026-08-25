import { useState } from 'react';
import { suggestMeta, htmlToText } from '../../../src/domain/seo.ts';
import { ArseneApiError } from '../../../src/api/client.ts';
import { arseneClient } from '../lib/arseneApi.ts';
import type { DraftFields } from './useDraft.ts';

/** AC-13/17: meta title/description are suggested, writer-editable, and
 *  republish (calling publish again on an already-published article) is the
 *  same button — `is_republish` only changes the confirmation copy. */
export function PublishPanel({
  articleId,
  fields,
  onMetaChange,
}: {
  articleId: string;
  fields: DraftFields;
  onMetaChange: (meta_title: string, meta_description: string) => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<
    | { status: 'idle' }
    | { status: 'error'; code: string; message: string }
    | { status: 'success'; slug: string; is_republish: boolean }
  >({ status: 'idle' });

  function suggest() {
    const suggestion = suggestMeta({
      title: fields.title,
      body_text: htmlToText(fields.body_html),
      league_name: fields.league_name,
      type_name: fields.type_name,
    });
    onMetaChange(suggestion.meta_title, suggestion.meta_description);
  }

  async function handlePublish() {
    setPublishing(true);
    setResult({ status: 'idle' });
    try {
      const client = await arseneClient();
      const response = (await client.publishArticle({
        articleId,
        ...(fields.meta_title === '' ? {} : { meta_title: fields.meta_title }),
        ...(fields.meta_description === '' ? {} : { meta_description: fields.meta_description }),
        idempotencyKey: crypto.randomUUID(),
      })) as { slug: string; is_republish: boolean };
      setResult({ status: 'success', slug: response.slug, is_republish: response.is_republish });
    } catch (err) {
      if (err instanceof ArseneApiError) {
        setResult({ status: 'error', code: err.code, message: messageFor(err) });
      } else {
        setResult({ status: 'error', code: 'INTERNAL_ERROR', message: String(err) });
      }
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="field-row">
      <h2>Publication</h2>
      <label>
        Méta-titre
        <input
          type="text"
          value={fields.meta_title}
          onChange={(event) => onMetaChange(event.target.value, fields.meta_description)}
        />
      </label>
      <label>
        Méta-description
        <input
          type="text"
          value={fields.meta_description}
          onChange={(event) => onMetaChange(fields.meta_title, event.target.value)}
        />
      </label>
      <button type="button" onClick={suggest}>
        Suggérer
      </button>

      <button type="button" onClick={() => void handlePublish()} disabled={publishing}>
        {publishing ? 'Publication…' : 'Publier'}
      </button>

      {result.status === 'error' && (
        <p role="alert" className="error-text">
          {result.message}
        </p>
      )}
      {result.status === 'success' && (
        <p role="status">
          {result.is_republish ? 'Republié' : 'Publié'} : /{result.slug}
        </p>
      )}
    </div>
  );
}

function messageFor(err: ArseneApiError): string {
  switch (err.code) {
    case 'COVER_IMAGE_REQUIRED':
      return "Il manque une image de couverture — ajoutez-en une avant de publier.";
    case 'IMAGE_NOT_READY':
      return 'Une image est encore en cours de traitement — réessayez dans quelques secondes.';
    case 'DRAFT_LOCKED':
      return 'Ce brouillon est verrouillé par un autre rédacteur.';
    case 'VALIDATION_FAILED':
      return `Requête invalide : ${err.message}`;
    default:
      return err.message;
  }
}
