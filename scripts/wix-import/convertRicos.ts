/**
 * Wix's Ricos rich-content document -> the plain HTML string Arsène's body
 * editor stores and `sanitizePastedHtml` (`src/domain/paste.ts`) accepts.
 * Pure: JSON in, `{ html, images }` out — no network, no DOM, matching this
 * repo's usual seam shape for anything content-transforming.
 *
 * Two ways Wix expresses a heading, both handled: some posts use a real
 * `HEADING` node (`headingData.level`); older ones fake it by bolding a line
 * and bumping its font size (observed: 30px, alongside an optional colour) —
 * a paragraph consisting of exactly one bold text run at >=24px is treated
 * as a heading too. Arsène's sanitizer only keeps `h2`/`h3` (`ALLOWED_TAGS`
 * in `paste.ts`), so every Wix level collapses onto those two: level 2 stays
 * `h2`, anything else (3, 4, ...) becomes `h3`. Heading text itself is
 * plain — Arsène's H2/H3 carry no attributes or nested markup at all, so
 * per-run decorations (bold, colour, links) are dropped inside a heading,
 * matching what the sanitizer would strip anyway.
 *
 * `BULLETED_LIST`/`ORDERED_LIST` map to `ul`/`ol`; each `LIST_ITEM`'s own
 * block children (usually a paragraph, sometimes a nested heading — Wix
 * writers use a `LIST_ITEM > HEADING` as a bolded label line) are rendered
 * the same way top-level blocks are, then wrapped in `<li>`.
 *
 * A `COLOR` decoration survives as a `<span style="color:...">`, normalized
 * to the literal hex form `sanitizePastedHtml`'s `allowedStyles` actually
 * keeps (`^#[0-9a-f]{3,8}$`) — Wix's own `foreground` value is `rgb(r,g,b)`
 * in every real document seen so far, never hex (confirmed against a real
 * 442KB post carrying 2,034 COLOR decorations, all `rgb(...)`): an earlier
 * version of this function only accepted literal hex on the theory that
 * `rgb(...)` would reach the sanitizer and get stripped anyway, which
 * silently dropped every colour on import rather than converting the
 * format — `normalizeColor` closes that gap. A named colour (`"blue"`)
 * still has no conversion and is dropped, same as before. A `LINK`
 * decoration becomes `<a href="...">`, the one other inline tag
 * `sanitizePastedHtml` allows.
 *
 * Images aren't inlined as real URLs here — a Wix media id only resolves to
 * a real file at `https://static.wixstatic.com/media/{id}`, which itself
 * still has to be downloaded and re-uploaded through Arsène's own pipeline
 * before `sanitizePastedHtml`'s origin check will ever keep it (same
 * constraint documented on `BodyImageList.tsx` this session). So each IMAGE
 * node becomes a numbered placeholder token in the HTML plus an entry in
 * `images`; `importPosts.ts` uploads each one and substitutes the real
 * `<img>` tag back in afterwards.
 */

const HEADING_MIN_FONT_SIZE = 24;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** `sanitizePastedHtml` only ever keeps a literal hex colour value — Wix's
 *  `colorData.foreground` is `rgb(r,g,b)`, not hex, in every real document
 *  seen so far. Returns `null` for anything neither form matches (a named
 *  colour, an unexpected shape) rather than guessing. */
function normalizeColor(value: string): string | null {
  if (HEX_COLOR.test(value)) return value;
  const rgb = RGB_COLOR.exec(value);
  if (rgb === null) return null;
  const toHex = (channel: string): string => Math.min(255, Math.max(0, Number(channel))).toString(16).padStart(2, '0');
  return `#${toHex(rgb[1] ?? '0')}${toHex(rgb[2] ?? '0')}${toHex(rgb[3] ?? '0')}`;
}

// Extra fields real Wix documents carry (fontWeightValue, italicData, ...)
// are allowed through but never read — only what each decoration type
// actually needs to render is declared here.
export type RicosDecoration = {
  type: string;
  colorData?: { foreground?: string; background?: string };
  fontSizeData?: { value?: number; [key: string]: unknown };
  linkData?: { link?: { url?: string } };
  [key: string]: unknown;
};

/** Deliberately flat rather than a discriminated union keyed on `type` —
 *  every field beyond `type` itself is optional and read defensively, so
 *  there's nothing for a real Wix document's occasional surprise node shape
 *  to violate. */
type RicosNode = {
  type: string;
  nodes?: RicosNode[];
  textData?: { text?: string; decorations?: RicosDecoration[] };
  imageData?: { image?: { src?: { id?: string } }; altText?: string };
  headingData?: { level?: number };
};

type RicosDocument = { nodes?: RicosNode[] };

export type ConvertedImage = { placeholder: string; wixUrl: string; altText: string };
export type ConvertResult = { html: string; images: ConvertedImage[] };

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeAttr = (text: string): string => escapeHtml(text).replace(/'/g, '&#39;');

function isHeadingRun(decorations: RicosDecoration[]): boolean {
  const bold = decorations.some((d) => d.type === 'BOLD');
  const big = decorations.some((d) => d.type === 'FONT_SIZE' && (d.fontSizeData?.value ?? 0) >= HEADING_MIN_FONT_SIZE);
  return bold && big;
}

function headingTag(level: number | undefined): 'h2' | 'h3' {
  return level === 2 ? 'h2' : 'h3';
}

/** Plain text only — used inside heading tags, which carry no nested markup. */
function plainInlineText(nodes: RicosNode[]): string {
  return nodes
    .filter((n) => n.type === 'TEXT')
    .map((n) => escapeHtml(n.textData?.text ?? ''))
    .join('');
}

function textRunHtml(node: RicosNode): string {
  const text = escapeHtml(node.textData?.text ?? '');
  if (text === '') return '';
  const decorations = node.textData?.decorations ?? [];

  let html = text;
  const rawColor = decorations.find((d) => d.type === 'COLOR')?.colorData?.foreground;
  const color = rawColor === undefined ? null : normalizeColor(rawColor);
  if (color !== null) html = `<span style="color:${color}">${html}</span>`;
  if (decorations.some((d) => d.type === 'UNDERLINE')) html = `<u>${html}</u>`;
  if (decorations.some((d) => d.type === 'ITALIC')) html = `<em>${html}</em>`;
  if (decorations.some((d) => d.type === 'BOLD')) html = `<strong>${html}</strong>`;
  const linkUrl = decorations.find((d) => d.type === 'LINK')?.linkData?.link?.url;
  if (linkUrl !== undefined) html = `<a href="${escapeAttr(linkUrl)}">${html}</a>`;
  return html;
}

function inlineHtml(nodes: RicosNode[]): string {
  return nodes
    .filter((n) => n.type === 'TEXT')
    .map(textRunHtml)
    .join('');
}

function blockNodeHtml(node: RicosNode, images: ConvertedImage[]): string {
  if (node.type === 'PARAGRAPH') {
    const children = (node.nodes ?? []).filter((n) => n.type === 'TEXT');
    const text = children.map((c) => c.textData?.text ?? '').join('');
    if (text.trim() === '') return ''; // Wix's own blank-line spacer paragraphs — skip, <p> margins already space things out

    const allDecorations = children.flatMap((c) => c.textData?.decorations ?? []);
    if (children.length === 1 && isHeadingRun(allDecorations)) {
      return `<h2>${plainInlineText(children)}</h2>`;
    }
    return `<p>${inlineHtml(children)}</p>`;
  }

  if (node.type === 'HEADING') {
    const text = plainInlineText(node.nodes ?? []);
    if (text.trim() === '') return ''; // occasional empty spacer headings
    return `<${headingTag(node.headingData?.level)}>${text}</${headingTag(node.headingData?.level)}>`;
  }

  if (node.type === 'IMAGE') {
    const id = node.imageData?.image?.src?.id;
    if (id === undefined) return '';
    const placeholder = `{{WIX_IMAGE_${images.length}}}`;
    images.push({
      placeholder,
      wixUrl: `https://static.wixstatic.com/media/${id}`,
      altText: node.imageData?.altText ?? '',
    });
    return placeholder;
  }

  if (node.type === 'BULLETED_LIST' || node.type === 'ORDERED_LIST') {
    const tag = node.type === 'BULLETED_LIST' ? 'ul' : 'ol';
    const items = (node.nodes ?? [])
      .filter((n) => n.type === 'LIST_ITEM')
      .map((item) => `<li>${(item.nodes ?? []).map((child) => blockNodeHtml(child, images)).join('')}</li>`)
      .join('');
    return items === '' ? '' : `<${tag}>${items}</${tag}>`;
  }

  // Anything else Wix's editor can produce (embeds, dividers, tables...) has
  // no equivalent in this project's allow-list — dropped rather than
  // guessed at, the same as paste already drops anything
  // sanitizePastedHtml doesn't recognise.
  return '';
}

export function convertRicosToHtml(doc: RicosDocument): ConvertResult {
  const images: ConvertedImage[] = [];
  const parts: string[] = [];

  for (const node of doc.nodes ?? []) {
    const html = blockNodeHtml(node, images);
    if (html !== '') parts.push(html);
  }

  return { html: parts.join(''), images };
}
