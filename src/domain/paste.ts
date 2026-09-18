/**
 * AC-03 — paste from Word/Google Docs, and the one sanitizer publish/render
 * also run body_html through.
 *
 * Pure: raw clipboard HTML in, article HTML out. No DOM globals, no network,
 * no DB (02-architecture.v1.md §1). Word/Docs express heading structure in
 * class names and inline styles rather than tags, so those two carriers are
 * translated back into real H2/H3 elements before everything presentational
 * is dropped.
 */

import sanitizeHtml from 'sanitize-html';

/** Tags an article keeps. Everything else is unwrapped (its text survives).
 *  `small` is the caption style (`BodyEditor.tsx`'s "Légende" option) — a
 *  block-level paragraph style, same "bare semantic tag, no attributes"
 *  pattern as `h2`/`h3`, picked over `figcaption` because this editor never
 *  groups an image and its caption into a `<figure>`; picked over a `class`
 *  on `<p>` because `transformTags` below strips every `p` attribute
 *  unconditionally, so a class-based marker would never survive a save.
 *  `b`/`i` sit alongside `strong`/`em`: Tiptap's own Bold/Italic marks
 *  (`@tiptap/extension-bold`/`-italic`) already parse `<b>`/`<i>` directly
 *  (confirmed in the installed package source), so there's no need to
 *  convert them — just stop discarding them. */
const ALLOWED_TAGS = [
  'h2',
  'h3',
  'p',
  'small',
  'ul',
  'ol',
  'li',
  'br',
  'a',
  'strong',
  'em',
  'u',
  'b',
  'i',
  'span',
  'img',
] as const;

/** `class="MsoHeading2"` (Word) or `style="mso-style-name:'Heading 2'"`. */
function wordHeadingTag(attribs: Record<string, string>): 'h2' | 'h3' | null {
  const marker = `${attribs.class ?? ''} ${attribs.style ?? ''}`;
  if (/MsoHeading\s*2|Heading\s*2/i.test(marker)) return 'h2';
  if (/MsoHeading\s*3|Heading\s*3/i.test(marker)) return 'h3';
  return null;
}

/** Google Docs wraps its *entire* clipboard payload in one outer
 *  `<b id="docs-internal-guid-...">` — an internal version-tracking
 *  artifact, not a writer's real bold formatting (AC-03c). Left alone, now
 *  that `b` is a kept tag (below), this would wrap a whole paste — headings
 *  included — in a stray bold mark. Mapped to a bare `<span>` instead of
 *  just dropping it from `allowedTags`, so it's unwrapped by the same
 *  `unwrapEmptySpans` pass that already handles every other "structural,
 *  not meaningful" span Docs produces, rather than a second code path. */
function isGoogleDocsWrapper(attribs: Record<string, string>): boolean {
  return /^docs-internal-guid-/.test(attribs.id ?? '');
}

/** `new URL(src).origin === allowedImageOrigin`, refusing anything that
 *  doesn't parse as an absolute URL (relative paths, `data:`, `javascript:`,
 *  malformed values) rather than trying to special-case each of those. */
function isAllowedImageSrc(src: string | undefined, allowedImageOrigin: string): boolean {
  if (src === undefined) return false;
  try {
    return new URL(src).origin === allowedImageOrigin;
  } catch {
    return false;
  }
}

/** `sanitizeHtml`'s own `allowedStyles` filtering (below) leaves a `<span>`
 *  in one of two shapes: bare `<span>` (every style value on it got
 *  filtered out — Google Docs' structural spans, or real Word HTML, which
 *  wraps nearly every run in one, carry no *allowed* style at all) or
 *  `<span style="...">` with whatever combination of color/font-weight/
 *  font-style/text-decoration survived. Matched generically — not against
 *  each property's own value pattern, which `allowedStyles` has already
 *  validated — since `style` is the only attribute `span` is allowed at
 *  all, any non-empty `style="..."` here already means "this span carries
 *  real, validated formatting signal." */
const SPAN_TOKEN = /<span>|<span style="[^"]*">|<\/span>/gi;

/** Drops exactly the bare `<span>...</span>` pairs `allowedStyles` leaves
 *  behind for a style-less span (Google Docs' structural spans, or real
 *  Word HTML — which wraps nearly every run in one), keeping every
 *  `<span style="...">`. A second pass over already-sanitized,
 *  guaranteed-well-formed output — not a `transformTags` unwrap during the
 *  main pass, which was tried first: mapping `span` to a tag name outside
 *  `allowedTags` corrupts the *next* sibling element's closing tag in this
 *  sanitize-html version (a known class of upstream bug, e.g.
 *  apostrophecms/sanitize-html#219 and #549 — confirmed directly against
 *  this version, independent of this project's own code). A small
 *  stack-based scan rather than a plain regex, because spans can nest (a
 *  styled span inside a bare one, or vice versa). */
function unwrapEmptySpans(html: string): string {
  const stack: boolean[] = []; // true = bare span (drop), false = styled span (keep)
  let result = '';
  let cursor = 0;
  for (const match of html.matchAll(SPAN_TOKEN)) {
    const token = match[0];
    const start = match.index;
    result += html.slice(cursor, start);
    cursor = start + token.length;
    if (token.toLowerCase() === '</span>') {
      const bare = stack.pop() ?? false;
      if (!bare) result += token;
    } else {
      const bare = token.toLowerCase() === '<span>';
      stack.push(bare);
      if (!bare) result += token;
    }
  }
  return result + html.slice(cursor);
}

export function sanitizePastedHtml(rawHtml: string, opts: { allowedImageOrigin: string }): string {
  const sanitized = sanitizeHtml(rawHtml, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: { a: ['href'], span: ['style'], img: ['src', 'alt'] },
    // The only CSS this project ever accepts on a pasted span — a plain hex
    // colour, and the three formatting signals BodyEditor.tsx's toolbar
    // already exposes (bold/italic/underline). Nothing else — no `url()`,
    // no `expression()`, no font/background tricks. Each regex only
    // matches the specific value that actually means "this formatting is
    // on" (e.g. font-weight 500-900/bold, never "400"/"normal"): a
    // non-matching value is simply dropped, the same as today's colour
    // handling, so Google Docs' habit of stamping every span with an
    // explicit (often "off") value for all four properties doesn't turn
    // plain text bold/italic/underlined by accident.
    //
    // No tag-level conversion needed for any of these — Tiptap's own Bold/
    // Italic/Underline marks (`@tiptap/extension-bold`/`-italic`/
    // `-underline`) already parse a `style="font-weight:700"` (etc.) on
    // *any* element via their own `parseHTML()` rules, confirmed directly
    // in the installed package source; this sanitizer's only job is to
    // stop discarding that signal before it ever reaches the editor.
    allowedStyles: {
      span: {
        color: [/^#[0-9a-f]{3,8}$/i],
        'font-weight': [/^(bold|bolder|[5-9]\d{2})$/i],
        'font-style': [/^italic$/i],
        'text-decoration': [/underline/i],
      },
    },
    transformTags: {
      p: (_tagName: string, attribs: Record<string, string>) => ({
        tagName: wordHeadingTag(attribs) ?? 'p',
        attribs: {},
      }),
      b: (_tagName: string, attribs: Record<string, string>) => ({
        tagName: isGoogleDocsWrapper(attribs) ? 'span' : 'b',
        attribs: {},
      }),
    },
    exclusiveFilter: (frame) =>
      frame.tag === 'img' && !isAllowedImageSrc(frame.attribs.src, opts.allowedImageOrigin),
  });
  return unwrapEmptySpans(sanitized);
}
