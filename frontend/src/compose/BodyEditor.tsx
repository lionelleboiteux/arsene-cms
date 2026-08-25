import { useEffect, useRef, type ClipboardEvent } from 'react';
import { sanitizePastedHtml } from '../../../src/domain/paste.ts';

/**
 * AC-03: pasting from Word/Docs keeps H2/H3, strips fonts/styling/scripts —
 * `sanitizePastedHtml` is the real, already-tested function, not a
 * simplified stand-in. Deliberately no formatting toolbar for v1: the
 * writer's primary authoring path is pasting already-structured content
 * (spec's own framing), not composing rich text from a blank editor.
 */
export function BodyEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Uncontrolled contentEditable: syncing on every keystroke would reset the
  // caret. Only push `value` into the DOM when it didn't originate here
  // (e.g. hydrating an opened draft).
  useEffect(() => {
    if (ref.current !== null && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
  }, [value]);

  function handleInput() {
    if (ref.current !== null) onChange(ref.current.innerHTML);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    if (html.length > 0) {
      document.execCommand('insertHTML', false, sanitizePastedHtml(html));
    } else {
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    }
    handleInput();
  }

  return (
    <div
      ref={ref}
      className="body-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Corps de l'article"
      onInput={handleInput}
      onPaste={handlePaste}
    />
  );
}
