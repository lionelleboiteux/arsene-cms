import { describe, expect, it } from 'vitest';
import { loadPaste } from '../support/seams.js';
import { WORD_PASTE_HTML } from '../support/fixtures.js';

/**
 * Paste-from-Word/Docs sanitization — 02-architecture.v1.md §1 names this as a
 * pure function seam: "raw HTML in, sanitized HTML out ... no browser needed
 * for the logic itself". So it is tested here with fixture HTML strings and
 * nothing else: no DOM, no editor, no DB.
 *
 * Whitespace between tags is collapsed before comparing, because the amount of
 * it is not a product requirement and a test must fail for exactly one reason.
 */

const collapse = (html: string): string =>
  html
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

describe('paste sanitization', () => {
  it('AC-03: pasting a Word document keeps its "Heading 2" paragraph as an H2 and discards the custom font and styling', async () => {
    const { sanitizePastedHtml } = await loadPaste();

    expect(collapse(sanitizePastedHtml(WORD_PASTE_HTML))).toBe(
      '<h2>Les affiches de la journée</h2><p>PSG reçoit Marseille dimanche soir.</p>',
    );
  });

  // One case per class of thing the "when things go wrong" table promises is
  // handled with no manual cleanup — not six variations of the same class.
  const CASES = [
    {
      id: 'AC-03a',
      klass: 'an inline style attribute (colour, background, font-size)',
      raw: '<p style="font-family:\'Comic Sans MS\';color:red;background:yellow">Texte</p>',
      expected: '<p>Texte</p>',
    },
    {
      id: 'AC-03b',
      klass: 'a presentational element (<font>) wrapping real text',
      raw: '<p><font face="Comic Sans MS" size="5" color="#ff0000">Texte</font></p>',
      expected: '<p>Texte</p>',
    },
    {
      id: 'AC-03c',
      klass: 'a Google Docs heading, whose structure lives in classes not tags',
      raw: '<b id="docs-internal-guid-9f1"><h2 class="c3"><span class="c1">Titre</span></h2></b>',
      expected: '<h2>Titre</h2>',
    },
    {
      id: 'AC-03d',
      klass: 'a deeper heading level, which must survive as H3 rather than flatten',
      raw: '<h3 style="mso-style-name:&quot;Heading 3&quot;;font-size:12.0pt">Sous-titre</h3>',
      expected: '<h3>Sous-titre</h3>',
    },
    {
      id: 'AC-03e',
      klass: 'an executable/unsafe node smuggled in by the clipboard',
      raw: '<p>Texte</p><script>alert(1)</script><p onclick="steal()">Suite</p>',
      expected: '<p>Texte</p><p>Suite</p>',
    },
  ] as const;

  it.each(
    CASES.map((c) => [`${c.id}: ${c.klass} is cleaned up automatically`, c] as const),
  )('%s', async (_title, { raw, expected }) => {
    const { sanitizePastedHtml } = await loadPaste();

    expect(collapse(sanitizePastedHtml(raw))).toBe(expected);
  });
});
