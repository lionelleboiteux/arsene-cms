import { describe, expect, it } from 'vitest';
import { convertRicosToHtml, type RicosDecoration } from '../../scripts/wix-import/convertRicos.ts';

/**
 * The Wix Ricos -> Arsène HTML converter, against document shapes pulled
 * directly from real published posts ("Round 20 – Allsvenskan 2026",
 * "Player Picks, Premier League, J3", "Player Picks, Ligue 1, J3"/"J2") via
 * the Wix REST API during the import's discovery phase — not invented
 * fixtures, the actual node shapes Wix's Blog API returns. The first batch
 * only surfaced the bold+font-size fake-heading pattern; later posts turned
 * out to use real `HEADING` nodes, `LINK` decorations and
 * `BULLETED_LIST`/`LIST_ITEM` — all covered below.
 */

const paragraph = (text: string, decorations: RicosDecoration[] = []) => ({
  type: 'PARAGRAPH',
  nodes: [{ type: 'TEXT', textData: { text, decorations } }],
});

describe('convertRicosToHtml', () => {
  it('converts a plain paragraph', () => {
    const result = convertRicosToHtml({ nodes: [paragraph('Hello world')] });
    expect(result).toEqual({ html: '<p>Hello world</p>', images: [] });
  });

  it('skips empty spacer paragraphs (Wix\'s own blank-line pattern)', () => {
    const result = convertRicosToHtml({
      nodes: [paragraph('Before'), { type: 'PARAGRAPH', nodes: [] }, paragraph('After')],
    });
    expect(result.html).toBe('<p>Before</p><p>After</p>');
  });

  it('converts bold, italic and underline decorations', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('gras', [{ type: 'BOLD', fontWeightValue: 700 }]),
        paragraph('italique', [{ type: 'ITALIC', italicData: true }]),
        paragraph('souligné', [{ type: 'UNDERLINE' }]),
      ],
    });
    expect(result.html).toBe('<p><strong>gras</strong></p><p><em>italique</em></p><p><u>souligné</u></p>');
  });

  it('converts a COLOR decoration\'s foreground to a span, ignoring background', () => {
    const result = convertRicosToHtml({
      nodes: [paragraph('rouge', [{ type: 'COLOR', colorData: { background: 'transparent', foreground: '#2DB4DF' } }])],
    });
    expect(result.html).toBe('<p><span style="color:#2DB4DF">rouge</span></p>');
  });

  it('a COLOR decoration with no foreground produces no span', () => {
    const result = convertRicosToHtml({
      nodes: [paragraph('normal', [{ type: 'COLOR', colorData: { background: 'transparent' } }])],
    });
    expect(result.html).toBe('<p>normal</p>');
  });

  it('a single bold run at >=24px becomes a heading, not a bold paragraph', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('Flops', [
          { type: 'BOLD', fontWeightValue: 700 },
          { type: 'COLOR', colorData: { background: 'transparent', foreground: '#2DB4DF' } },
          { type: 'FONT_SIZE', fontSizeData: { unit: 'PX', value: 30 } },
        ]),
      ],
    });
    // The colour is dropped along with the bold wrapper — h2 carries no attributes.
    expect(result.html).toBe('<h2>Flops</h2>');
  });

  it('bold text under the heading font-size threshold stays a normal bold paragraph', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('Castegren (Sirius, 4,9)', [
          { type: 'BOLD', fontWeightValue: 700 },
          { type: 'FONT_SIZE', fontSizeData: { unit: 'PX', value: 16 } },
        ]),
      ],
    });
    expect(result.html).toBe('<p><strong>Castegren (Sirius, 4,9)</strong></p>');
  });

  it('a bold run mixed with plain text in the same paragraph is not treated as a heading', () => {
    const result = convertRicosToHtml({
      nodes: [
        {
          type: 'PARAGRAPH',
          nodes: [
            { type: 'TEXT', textData: { text: 'On conserve ', decorations: [] } },
            {
              type: 'TEXT',
              textData: {
                text: 'Castegren',
                decorations: [
                  { type: 'BOLD', fontWeightValue: 700 },
                  { type: 'FONT_SIZE', fontSizeData: { unit: 'PX', value: 30 } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(result.html).toBe('<p>On conserve <strong>Castegren</strong></p>');
  });

  it('an IMAGE node becomes a placeholder token and an image entry with the real static.wixstatic.com URL', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('Before'),
        {
          type: 'IMAGE',
          imageData: {
            image: { src: { id: '3448f3_290149ecf4dc4087b2c128e70fc0c977~mv2.jpg' } },
            altText: 'La joie du derby',
          },
        },
        paragraph('After'),
      ],
    });
    expect(result.html).toBe('<p>Before</p>{{WIX_IMAGE_0}}<p>After</p>');
    expect(result.images).toEqual([
      {
        placeholder: '{{WIX_IMAGE_0}}',
        wixUrl: 'https://static.wixstatic.com/media/3448f3_290149ecf4dc4087b2c128e70fc0c977~mv2.jpg',
        altText: 'La joie du derby',
      },
    ]);
  });

  it('multiple decorations on one run nest correctly', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('important', [
          { type: 'BOLD', fontWeightValue: 700 },
          { type: 'ITALIC', italicData: true },
        ]),
      ],
    });
    expect(result.html).toBe('<p><strong><em>important</em></strong></p>');
  });

  it('escapes HTML-significant characters in the source text', () => {
    const result = convertRicosToHtml({ nodes: [paragraph('Bjerkebo > Lind & "the rest" <3')] });
    expect(result.html).toBe('<p>Bjerkebo &gt; Lind &amp; &quot;the rest&quot; &lt;3</p>');
  });

  it('a real HEADING node becomes h2 at level 2 and h3 at any other level, ignoring its own decorations', () => {
    const result = convertRicosToHtml({
      nodes: [
        { type: 'HEADING', headingData: { level: 2 }, nodes: [{ type: 'TEXT', textData: { text: 'Les matchs de la journée', decorations: [] } }] },
        {
          type: 'HEADING',
          headingData: { level: 3 },
          nodes: [{ type: 'TEXT', textData: { text: 'Toulouse – Lille', decorations: [{ type: 'BOLD', fontWeightValue: 700 }] } }],
        },
        { type: 'HEADING', headingData: { level: 4 }, nodes: [{ type: 'TEXT', textData: { text: 'Lyon', decorations: [] } }] },
      ],
    });
    expect(result.html).toBe('<h2>Les matchs de la journée</h2><h3>Toulouse – Lille</h3><h3>Lyon</h3>');
  });

  it('an empty HEADING node (a spacer, seen in real posts) is skipped', () => {
    const result = convertRicosToHtml({
      nodes: [paragraph('Before'), { type: 'HEADING', headingData: { level: 3 }, nodes: [] }, paragraph('After')],
    });
    expect(result.html).toBe('<p>Before</p><p>After</p>');
  });

  it('a LINK decoration becomes an <a href>, nested inside any other decorations on the same run', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('le jeu des pronos', [
          { type: 'LINK', linkData: { link: { url: 'https://pronos.fantasy-coach.fr/' } } },
          { type: 'UNDERLINE' },
        ]),
      ],
    });
    expect(result.html).toBe('<p><a href="https://pronos.fantasy-coach.fr/"><u>le jeu des pronos</u></a></p>');
  });

  it('a non-hex COLOR foreground (rgb() or a named colour, both real Wix output) produces no span', () => {
    const result = convertRicosToHtml({
      nodes: [
        paragraph('noir', [{ type: 'COLOR', colorData: { foreground: 'rgb(0, 0, 0)' } }]),
        paragraph('bleu', [{ type: 'COLOR', colorData: { foreground: 'blue' } }]),
      ],
    });
    expect(result.html).toBe('<p>noir</p><p>bleu</p>');
  });

  it('a BULLETED_LIST of plain-paragraph items becomes <ul><li>', () => {
    const result = convertRicosToHtml({
      nodes: [
        {
          type: 'BULLETED_LIST',
          nodes: [
            { type: 'LIST_ITEM', nodes: [paragraph('Premier point')] },
            { type: 'LIST_ITEM', nodes: [paragraph('Deuxième point')] },
          ],
        },
      ],
    });
    expect(result.html).toBe('<ul><li><p>Premier point</p></li><li><p>Deuxième point</p></li></ul>');
  });

  it('a LIST_ITEM whose content is a HEADING (the real "team name as bullet label" pattern) nests the heading inside the li', () => {
    const result = convertRicosToHtml({
      nodes: [
        {
          type: 'BULLETED_LIST',
          nodes: [
            {
              type: 'LIST_ITEM',
              nodes: [{ type: 'HEADING', headingData: { level: 3 }, nodes: [{ type: 'TEXT', textData: { text: 'Lyon', decorations: [] } }] }],
            },
          ],
        },
        paragraph('=> Taulier : Openda (15)'),
      ],
    });
    expect(result.html).toBe('<ul><li><h3>Lyon</h3></li></ul><p>=&gt; Taulier : Openda (15)</p>');
  });

  it('an ORDERED_LIST becomes <ol><li>', () => {
    const result = convertRicosToHtml({
      nodes: [{ type: 'ORDERED_LIST', nodes: [{ type: 'LIST_ITEM', nodes: [paragraph('Un')] }] }],
    });
    expect(result.html).toBe('<ol><li><p>Un</p></li></ol>');
  });
});
