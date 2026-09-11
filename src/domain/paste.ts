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
 *  unconditionally, so a class-based marker would never survive a save. */
const ALLOWED_TAGS = ['h2', 'h3', 'p', 'small', 'ul', 'ol', 'li', 'br', 'a', 'strong', 'em', 'u', 'span', 'img'] as const;

/** `class="MsoHeading2"` (Word) or `style="mso-style-name:'Heading 2'"`. */
function wordHeadingTag(attribs: Record<string, string>): 'h2' | 'h3' | null {
  const marker = `${attribs.class ?? ''} ${attribs.style ?? ''}`;
  if (/MsoHeading\s*2|Heading\s*2/i.test(marker)) return 'h2';
  if (/MsoHeading\s*3|Heading\s*3/i.test(marker)) return 'h3';
  return null;
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

/** The two literal forms `sanitizeHtml`'s own `allowedStyles` filtering
 *  (below) can leave a `<span>` in — never anything else, since `style` is
 *  the only attribute `span` is allowed at all. */
const SPAN_TOKEN = /<span>|<span style="color:#[0-9a-f]{3,8}">|<\/span>/gi;

/** Drops exactly the bare `<span>...</span>` pairs `allowedStyles` leaves
 *  behind for a colour-less span (Google Docs' structural spans, or real
 *  Word HTML — which wraps nearly every run in one), keeping every
 *  `<span style="color:...">`. A second pass over already-sanitized,
 *  guaranteed-well-formed output — not a `transformTags` unwrap during the
 *  main pass, which was tried first: mapping `span` to a tag name outside
 *  `allowedTags` corrupts the *next* sibling element's closing tag in this
 *  sanitize-html version (a known class of upstream bug, e.g.
 *  apostrophecms/sanitize-html#219 and #549 — confirmed directly against
 *  this version, independent of this project's own code). A small
 *  stack-based scan rather than a plain regex, because spans can nest (a
 *  colour span inside a bare one, or vice versa). */
function unwrapEmptySpans(html: string): string {
  const stack: boolean[] = []; // true = bare span (drop), false = colour span (keep)
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
    // The only CSS this project ever accepts: a plain hex colour on
    // `color`, nothing else — no `url()`, no `expression()`, no
    // font/background tricks.
    allowedStyles: { span: { color: [/^#[0-9a-f]{3,8}$/i] } },
    transformTags: {
      p: (_tagName: string, attribs: Record<string, string>) => ({
        tagName: wordHeadingTag(attribs) ?? 'p',
        attribs: {},
      }),
    },
    exclusiveFilter: (frame) =>
      frame.tag === 'img' && !isAllowedImageSrc(frame.attribs.src, opts.allowedImageOrigin),
  });
  return unwrapEmptySpans(sanitized);
}
