import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

type Block = { prelude: string; body: string };
function blocks(source: string): Block[] {
  const found: Block[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = '';
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '{') {
      if (depth === 0) {
        prelude = source.slice(preludeStart, index).trim();
        bodyStart = index + 1;
      }
      depth++;
    } else if (source[index] === '}') {
      depth--;
      if (depth === 0) {
        found.push({ prelude, body: source.slice(bodyStart, index) });
        preludeStart = index + 1;
      }
    }
  }
  return found;
}
/** Declarations of every rule in `source` whose selector list names `selector` exactly. */
function declarations(source: string, selector: string) {
  return blocks(source)
    .filter((block) => block.prelude.split(',').some((part) => part.trim() === selector))
    .map((block) => block.body)
    .join(';');
}
const media = (query: string) =>
  blocks(css)
    .filter((block) => block.prelude === `@media ${query}`)
    .map((block) => block.body)
    .join('\n');

describe('places layout', () => {
  it('keeps the desktop map a stable, sticky height that does not follow the list', () => {
    const panel = declarations(css, '.full-map-panel');
    expect(panel).toMatch(/position:\s*sticky/);
    expect(panel).toMatch(/align-self:\s*start/);
    expect(panel).toMatch(/height:\s*clamp\(420px,\s*calc\(100vh - 48px\),\s*680px\)/);
    expect(declarations(css, '.full-map-panel .places-map')).toMatch(/height:\s*100%/);
  });

  it('caps the place list and scrolls it instead of stretching the page', () => {
    expect(declarations(css, '.places-layout .place-list')).toMatch(/max-height:\s*clamp\(/);
    expect(declarations(css, '.place-list-items')).toMatch(/overflow-y:\s*auto/);
  });

  it('seats the map beside the list on wide screens and above it below 1001px', () => {
    // The wide grid places the map on the right of the list, whichever the markup puts first.
    expect(declarations(css, '.places-layout > .place-list')).toMatch(/grid-column:\s*1;/);
    expect(declarations(css, '.places-layout > .place-list')).toMatch(/grid-row:\s*1;/);
    expect(declarations(css, '.places-layout > .full-map-panel')).toMatch(/grid-column:\s*2;/);
    expect(declarations(css, '.places-layout > .full-map-panel')).toMatch(/grid-row:\s*1;/);
    // One column shows them in page order: no CSS order separates what is read from what is tabbed.
    const narrow = media('(max-width: 1000px)');
    expect(declarations(narrow, '.full-map-panel')).not.toMatch(/(^|[;\s])order:/);
    for (const selector of ['.places-layout > .place-list', '.places-layout > .full-map-panel'])
      expect(declarations(narrow, selector), selector).toMatch(/grid-(column|area):\s*auto/);
  });

  it('caps the place list below 1001px too, so many places never push the wagers table away', () => {
    const narrow = media('(max-width: 1000px)');
    expect(declarations(narrow, '.places-layout .place-list')).toMatch(/max-height:\s*none/);
    const items = declarations(narrow, '.place-list-items');
    expect(items).toMatch(/max-height:\s*min\(420px,\s*60vh\)/);
    expect(items).toMatch(/overflow-y:\s*auto/);
    expect(items).not.toMatch(/overflow:\s*visible/);
  });

  it('gives place rows a hover state and a visible selected marker', () => {
    expect(declarations(css, '.place-list .place-item:hover')).toMatch(/background/);
    expect(declarations(css, '.place-list .place-item.selected')).toMatch(/box-shadow:\s*inset/);
  });

  it('lines the list title, rows and help text up on one inset at every width', () => {
    expect(declarations(css, '.place-list')).toMatch(/--place-inset:\s*18px/);
    const inset = /var\(--place-inset\)/;
    expect(declarations(css, '.place-list .section-title')).toMatch(
      /padding-inline:\s*var\(--place-inset\)/,
    );
    expect(declarations(css, '.place-item')).toMatch(inset);
    expect(declarations(css, '.place-help')).toMatch(inset);
    const small = media('(max-width: 520px)');
    expect(declarations(small, '.place-item')).toMatch(inset);
    expect(declarations(small, '.place-help')).toMatch(inset);
    // The tablet grid keeps its own row padding but never re-declares a different side inset.
    expect(declarations(media('(max-width: 1000px)'), '.place-item')).not.toMatch(/padding/);
  });

  it('keeps the two-column tablet list free of empty cells and doubled borders', () => {
    const tablet = media('(max-width: 1000px)');
    // "All locations" and a lone last row span both columns, so no cell is left empty.
    for (const selector of [
      '.place-list-items .all-places',
      '.place-list-items .place-item:last-child:nth-child(even)',
    ])
      expect(declarations(tablet, selector)).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    // One divider between the columns, never two.
    expect(declarations(tablet, '.place-list-items .place-item')).toMatch(/border-right:\s*0/);
    expect(
      declarations(tablet, '.place-list-items .place-item:nth-child(even):not(:last-child)'),
    ).toMatch(/border-right:\s*1px solid/);
  });

  it('keeps the tablet grid on the stories list, so the Roll prices list never splits into columns', () => {
    const tablet = blocks(media('(max-width: 1000px)'));
    // A bare .place-list rule also reaches the restaurant list beside the price panel.
    const bare = tablet.filter((block) =>
      block.prelude.split(',').some((part) => /^\.place-(list|item)(?![\w-])/.test(part.trim())),
    );
    expect(bare.map((block) => block.prelude)).toEqual([]);
    // The price panel stacks under the restaurant list at the same width the map stacks.
    expect(declarations(media('(max-width: 1000px)'), '.price-summary')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it('lines the price panel title, figures, chart and rows up on one inset', () => {
    expect(declarations(css, '.price-history-panel')).toMatch(/--price-inset:\s*22px/);
    expect(declarations(media('(max-width: 1200px)'), '.price-history-panel')).toMatch(
      /--price-inset:\s*17px/,
    );
    for (const selector of [
      '.price-history-panel .section-title',
      '.price-history-list',
      '.price-headline',
      '.price-chart-frame',
    ])
      expect(declarations(css, selector), selector).toMatch(/var\(--price-inset\)/);
  });

  it('moves Correct under the price on a phone, so the item and its date keep the row', () => {
    // Wider screens keep a fixed slot after the price, so prices line up whether or not a row
    // can be corrected.
    expect(declarations(css, '.has-actions > .price-observation')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\) auto 64px/,
    );
    // A 64px slot at 320px leaves the item about 100px and every name wraps.
    const small = media('(max-width: 520px)');
    expect(declarations(small, '.has-actions > .price-observation')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/,
    );
    // Only a row with a Correct button takes a second line on the right; the rest stay centred.
    expect(
      declarations(small, '.has-actions > .price-observation:has(.price-correct-button) > div'),
    ).toMatch(/grid-row:\s*span 2/);
    expect(declarations(small, '.has-actions .price-observation-action')).toMatch(
      /grid-column:\s*2/,
    );
  });

  it('widens the slot for Correct and Withdraw together, and gives them a line of their own on a phone', () => {
    expect(declarations(css, '.has-actions.has-withdraw > .price-observation')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\) auto 128px/,
    );
    const small = media('(max-width: 520px)');
    // The wider slot outranks the phone rule unless the phone rule names it too.
    expect(declarations(small, '.has-actions.has-withdraw > .price-observation')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/,
    );
    // Two links under the price would take the item's width; they span the row's line instead.
    expect(declarations(small, '.has-actions.has-withdraw .price-observation-action')).toMatch(
      /grid-column:\s*1 \/ -1/,
    );
    expect(
      declarations(
        small,
        '.has-actions.has-withdraw > .price-observation:has(.price-withdraw-button) > div',
      ),
    ).toMatch(/grid-row:\s*auto/);
  });

  it('no longer floats a selected-place footer over the map', () => {
    expect(css).not.toContain('.selected-place-footer');
  });
});
