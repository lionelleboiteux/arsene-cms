import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';
import { sanitizePastedHtml } from '../../../src/domain/paste.ts';
import { CDN_ORIGIN } from '../lib/supabaseClient.ts';

export type BodyEditorHandle = {
  /** Called by `ComposePage.tsx` when a writer clicks "Insérer dans le
   *  texte" on an already-uploaded, ready `BodyImageList` row. */
  insertImage(src: string, alt: string): void;
};

/**
 * Bold/italic/underline/paragraph-style/colour, plus inline images inserted
 * from `BodyImageList`'s upload flow (not built here — see `ComposePage.tsx`'s
 * `insertImage` wiring). Every extension here maps to something
 * `sanitizePastedHtml` (`src/domain/paste.ts`) actually keeps; anything
 * StarterKit offers that the sanitizer would strip (blockquote, code,
 * codeBlock, horizontalRule, strike) is turned off so the toolbar never lets
 * a writer create formatting that silently vanishes on publish.
 */
export const BodyEditor = forwardRef<BodyEditorHandle, { value: string; onChange: (html: string) => void }>(
  function BodyEditor({ value, onChange }, ref) {
    // The last HTML string *this editor itself* emitted via onUpdate — not
    // re-derived from `editor.getHTML()` at effect time, which raced: a
    // burst of fast keystrokes (e.g. typing continuously) could fire several
    // `onUpdate`s before React re-rendered with the latest `value`, so the
    // effect below would see a stale `value` prop, decide it "differed" from
    // the (already-newer) live doc, and reset the caret to the document
    // start mid-typing — dropping every character typed after the reset.
    // Comparing against what we ourselves last emitted is race-free: it's
    // set synchronously inside onUpdate, so it always matches by the time
    // the corresponding `value` prop arrives back, however many keystrokes
    // batched before that render happened.
    const lastEmittedRef = useRef<string | null>(value);

    const editor = useEditor({
      immediatelyRender: true,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3] },
          blockquote: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          strike: false,
        }),
        TextStyle,
        Color.configure({ types: ['textStyle'] }),
        Image.configure({ inline: false, allowBase64: false }),
      ],
      content: value,
      onUpdate: ({ editor: e }) => {
        const html = e.getHTML();
        lastEmittedRef.current = html;
        onChange(html);
      },
      editorProps: {
        attributes: {
          class: 'body-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': "Corps de l'article",
        },
        transformPastedHTML: (html) => sanitizePastedHtml(html, { allowedImageOrigin: CDN_ORIGIN }),
      },
    });

    // Only re-hydrates when `value` changes for a reason other than this
    // editor's own `onUpdate` echoing it straight back (e.g. opening a
    // different draft) — see `lastEmittedRef`'s comment above for why this
    // isn't a comparison against `editor.getHTML()` directly.
    useEffect(() => {
      if (editor === null || value === lastEmittedRef.current) return;
      lastEmittedRef.current = value;
      editor.commands.setContent(value, { emitUpdate: false });
    }, [value, editor]);

    useImperativeHandle(
      ref,
      () => ({
        insertImage(src: string, alt: string) {
          editor?.chain().focus().setImage({ src, alt }).run();
        },
      }),
      [editor],
    );

    if (editor === null) return null;

    const headingChoice = editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : 'p';
    const color = (editor.getAttributes('textStyle').color as string | undefined) ?? '#000000';

    return (
      <div>
        {/* `onMouseDown` preventDefault on the toggle buttons below: a plain
            <button> click's default browser behavior moves DOM focus onto
            the button itself, which fires *after* our own onClick's
            `.focus()` call — so without this, clicking Gras/Italique/
            Souligné correctly toggles the mark but leaves the button
            focused, and the next character typed goes nowhere (confirmed:
            the mark toggled correctly, but the following keystrokes never
            reached the editor at all). Preventing the mousedown's default
            stops focus from ever leaving the editor in the first place. */}
        <div className="body-toolbar" role="toolbar" aria-label="Mise en forme">
          <select
            aria-label="Style de paragraphe"
            value={headingChoice}
            onChange={(event) => {
              const choice = event.target.value;
              if (choice === 'p') editor.chain().focus().setParagraph().run();
              else if (choice === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run();
              else editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
          >
            <option value="p">Normal</option>
            <option value="h2">Titre 2</option>
            <option value="h3">Titre 3</option>
          </select>
          <button
            type="button"
            aria-pressed={editor.isActive('bold')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            Gras
          </button>
          <button
            type="button"
            aria-pressed={editor.isActive('italic')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            Italique
          </button>
          <button
            type="button"
            aria-pressed={editor.isActive('underline')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            Souligné
          </button>
          <label>
            Couleur
            <input
              type="color"
              value={color}
              onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}
            />
          </label>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().unsetColor().run()}
          >
            Effacer la couleur
          </button>
        </div>
        <EditorContent editor={editor} />
      </div>
    );
  },
);
