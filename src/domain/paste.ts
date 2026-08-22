/**
 * AC-03 — paste from Word/Google Docs.
 *
 * Pure: raw clipboard HTML in, article HTML out. No DOM globals, no network,
 * no DB (02-architecture.v1.md §1). Word/Docs express heading structure in
 * class names and inline styles rather than tags, so those two carriers are
 * translated back into real H2/H3 elements before everything presentational
 * is dropped.
 */

import sanitizeHtml from 'sanitize-html';

/** Tags an article keeps. Everything else is unwrapped (its text survives). */
const ALLOWED_TAGS = ['h2', 'h3', 'p', 'ul', 'ol', 'li', 'br', 'a'] as const;

/** `class="MsoHeading2"` (Word) or `style="mso-style-name:'Heading 2'"`. */
function wordHeadingTag(attribs: Record<string, string>): 'h2' | 'h3' | null {
  const marker = `${attribs.class ?? ''} ${attribs.style ?? ''}`;
  if (/MsoHeading\s*2|Heading\s*2/i.test(marker)) return 'h2';
  if (/MsoHeading\s*3|Heading\s*3/i.test(marker)) return 'h3';
  return null;
}

export function sanitizePastedHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: { a: ['href'] },
    transformTags: {
      p: (_tagName: string, attribs: Record<string, string>) => ({
        tagName: wordHeadingTag(attribs) ?? 'p',
        attribs: {},
      }),
    },
  });
}
