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

/** Arbitrary but fixed — matches the shape `tests/e2e/cdnOriginConfig.test.ts`
 *  already uses for a "this deployment's real configured origin" stand-in. */
const CDN_ORIGIN = 'https://assets.fantasycoach.fr';
const sanitize = (html: string, allowedImageOrigin = CDN_ORIGIN) =>
  loadPaste().then(({ sanitizePastedHtml }) => sanitizePastedHtml(html, { allowedImageOrigin }));

describe('paste sanitization', () => {
  it('AC-03: pasting a Word document keeps its "Heading 2" paragraph as an H2 and discards the custom font and styling', async () => {
    expect(collapse(await sanitize(WORD_PASTE_HTML))).toBe(
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
    expect(collapse(await sanitize(raw))).toBe(expected);
  });

  // The editor's own formatting/image features (bold, italic, underline,
  // colour, inline images) — everything below is what makes them survive
  // publish/render rather than being silently stripped like today.
  describe('editor formatting and images', () => {
    it('keeps bold, italic and underline with no attributes', async () => {
      // collapse() strips whitespace directly between tags (see file-top
      // comment) — the raw input's inter-word spaces are lost with it, so
      // the expected value is written pre-collapsed rather than reused verbatim.
      const raw = '<p><strong>gras</strong> <em>italique</em> <u>souligné</u></p>';
      expect(collapse(await sanitize(raw))).toBe('<p><strong>gras</strong><em>italique</em><u>souligné</u></p>');
    });

    it('keeps a <small> caption block, with no attributes (BodyEditor.tsx\'s "Légende" style, e.g. under an image)', async () => {
      const raw = '<small class="c1" style="color:red">Photo : Ligue 1</small>';
      expect(collapse(await sanitize(raw))).toBe('<small>Photo : Ligue 1</small>');
    });

    it('keeps a colour span, normalised to just its hex colour', async () => {
      const raw = '<p><span style="color: #FF0000; font-weight: bold">Texte</span></p>';
      expect(collapse(await sanitize(raw))).toBe('<p><span style="color:#FF0000">Texte</span></p>');
    });

    it('unwraps a span with no colour, keeping its text (Google Docs structural spans, AC-03c; also what real Word HTML wraps nearly every run in)', async () => {
      const raw = '<p><span class="c1">Texte</span></p>';
      expect(collapse(await sanitize(raw))).toBe('<p>Texte</p>');
    });

    it('rejects a non-colour style value (no expression/url smuggled through as "color")', async () => {
      const raw = '<p><span style="color: url(javascript:alert(1))">Texte</span></p>';
      expect(collapse(await sanitize(raw))).toBe('<p>Texte</p>');
    });

    it('unwraps a bare span nested inside a colour span, keeping the colour span itself', async () => {
      const raw = '<p><span style="color:#ff0000">Rouge <span class="c1">et plus</span></span></p>';
      expect(collapse(await sanitize(raw))).toBe('<p><span style="color:#ff0000">Rouge et plus</span></p>');
    });

    it('keeps an <img> on the configured CDN origin, with only src/alt', async () => {
      const raw = `<img src="${CDN_ORIGIN}/articles/a1/body.webp" alt="Une photo" onerror="steal()" width="9999">`;
      expect(collapse(await sanitize(raw))).toBe(`<img src="${CDN_ORIGIN}/articles/a1/body.webp" alt="Une photo" />`);
    });

    it('drops an <img> on a foreign origin entirely, not just its src', async () => {
      const raw = '<p>Avant</p><img src="https://evil.example/tracker.png" alt="x"><p>Après</p>';
      expect(collapse(await sanitize(raw))).toBe('<p>Avant</p><p>Après</p>');
    });

    it.each([
      ['a data: URI', 'data:image/png;base64,AAAA'],
      ['a relative path', '/articles/a1/body.webp'],
      ['a malformed value', 'not a url'],
    ])('drops an <img src> that is %s', async (_label, src) => {
      const raw = `<img src="${src}" alt="x">`;
      expect(collapse(await sanitize(raw))).toBe('');
    });
  });
});
