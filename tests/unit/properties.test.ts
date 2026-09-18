import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadLock, loadPaste, loadSeo } from '../support/seams.js';

/**
 * Property-based invariants. Each property replaces a family of examples and
 * probes cases nobody enumerated; each still fails for exactly one reason.
 */

const URL_SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const title = fc.string({ minLength: 1, maxLength: 80 });

describe('slug invariants (AC-14)', () => {
  it('PROP-01: every generated slug is URL-safe and non-empty, whatever punctuation, accents or emoji the title contains', async () => {
    const { generateSlug } = await loadSeo();

    fc.assert(
      fc.property(title, (raw) => {
        fc.pre(/[\p{L}\p{N}]/u.test(raw)); // a title with nothing sluggable is not a slug question
        expect(generateSlug(raw)).toMatch(URL_SAFE_SLUG);
      }),
    );
  });

  it('PROP-02: a slug never collides with one already taken, and stays URL-safe while avoiding it', async () => {
    const { generateSlug } = await loadSeo();

    fc.assert(
      fc.property(title, fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 6 }), (raw, taken) => {
        fc.pre(/[\p{L}\p{N}]/u.test(raw));
        const base = generateSlug(raw);
        const existingSlugs = [base, ...taken.map((t2) => generateSlug(`${base} ${t2}`))];

        const slug = generateSlug(raw, { existingSlugs });

        expect({ collides: existingSlugs.includes(slug), url_safe: URL_SAFE_SLUG.test(slug) }).toEqual({
          collides: false,
          url_safe: true,
        });
      }),
    );
  });
});

describe('lock invariants (AC-05, ADR-0003)', () => {
  it('PROP-03: any two timestamps further apart than the staleness threshold mean the lock has expired — for every pair, not just the ones we thought of', async () => {
    const lock = await loadLock();

    fc.assert(
      fc.property(
        fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2030-01-01T00:00:00Z') }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (lockedAt, extraMs) => {
          const now = new Date(lockedAt.getTime() + lock.LOCK_STALENESS_MS + extraMs);
          expect(lock.isLockStale(now, lockedAt)).toBe(true);
        },
      ),
    );
  });
});

describe('paste sanitization invariants (AC-03)', () => {
  const htmlish = fc
    .array(
      fc.oneof(
        fc.constant('<p style="color:red;font-family:Calibri">texte</p>'),
        fc.constant('<font face="Comic Sans MS">texte</font>'),
        fc.constant('<h2 class="c3"><span class="c1">titre</span></h2>'),
        fc.constant('<h3>sous-titre</h3>'),
        fc.constant('<script>alert(1)</script>'),
        fc.constant('<div onclick="x()"><b>gras</b></div>'),
        fc.constant('<!--[if !supportLists]--><span lang=FR>1.</span>'),
        fc.constant('<o:p></o:p>'),
        // Google Docs' own paste shape (font-weight/font-style/text-decoration
        // on a span, both "on" and explicitly "off" values) and its whole-
        // clipboard <b id="docs-internal-guid-...">  wrapper — without these,
        // the property below never actually exercises `allowedStyles`' new
        // properties or `isGoogleDocsWrapper`, and would pass by omission
        // rather than by checking anything.
        fc.constant('<span style="font-weight:700">gras</span>'),
        fc.constant('<span style="font-style:italic">italique</span>'),
        fc.constant('<span style="text-decoration:underline">souligné</span>'),
        fc.constant('<span style="font-weight:400;font-style:normal;text-decoration:none">normal</span>'),
        fc.constant('<span style="font-weight:expression(alert(1))">texte</span>'),
        fc.constant('<b id="docs-internal-guid-1"><p>texte</p></b>'),
        fc.string({ maxLength: 20 }),
      ),
      { maxLength: 10 },
    )
    .map((parts) => parts.join(''));

  const CDN_ORIGIN = 'https://assets.fantasycoach.fr';

  /** Each of the 4 CSS properties `allowedStyles` (`src/domain/paste.ts`)
   *  accepts on a span, and the only values of each that actually mean
   *  "this formatting is on" — the same patterns `sanitizePastedHtml`
   *  itself uses, checked independently per `property:value` pair rather
   *  than as one monolithic regex on the whole `style="..."` string, since
   *  sanitize-html doesn't guarantee which order multiple surviving
   *  properties serialize in. */
  const ALLOWED_STYLE_VALUE: Record<string, RegExp> = {
    color: /^#[0-9a-f]{3,8}$/i,
    'font-weight': /^(bold|bolder|[5-9]\d{2})$/i,
    'font-style': /^italic$/i,
    'text-decoration': /^underline$/i,
  };

  it('PROP-04: no styling beyond bold/italic/underline/a plain hex colour, class or executable node ever survives sanitization, for any clipboard payload', async () => {
    const { sanitizePastedHtml } = await loadPaste();

    fc.assert(
      fc.property(htmlish, (raw) => {
        const out = sanitizePastedHtml(raw, { allowedImageOrigin: CDN_ORIGIN });
        const styleAttrs = out.match(/\sstyle="[^"]*"/gi) ?? [];
        const stylesAreAllAllowed = styleAttrs.every((attr) => {
          const value = attr.match(/^\sstyle="([^"]*)"$/)?.[1] ?? '';
          const declarations = value.split(';').filter((d) => d !== '');
          return (
            declarations.length > 0 &&
            declarations.every((decl) => {
              const [prop, val] = decl.split(':');
              const allowed = prop === undefined ? undefined : ALLOWED_STYLE_VALUE[prop];
              return allowed !== undefined && val !== undefined && allowed.test(val);
            })
          );
        });
        expect(stylesAreAllAllowed).toBe(true);
        expect(/\sclass=|<font|<script|\son[a-z]+=|docs-internal-guid/i.test(out)).toBe(false);
      }),
    );
  });

  it('PROP-05: sanitization is idempotent — re-pasting already-clean content changes nothing', async () => {
    const { sanitizePastedHtml } = await loadPaste();

    fc.assert(
      fc.property(htmlish, (raw) => {
        const once = sanitizePastedHtml(raw, { allowedImageOrigin: CDN_ORIGIN });
        expect(sanitizePastedHtml(once, { allowedImageOrigin: CDN_ORIGIN })).toBe(once);
      }),
    );
  });
});
