import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The annual table's fit and scroll cue live in CSS jsdom cannot lay out, so these read the rules. */
const css = readFileSync(new URL('./lobster-prices.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

type Block = { prelude: string; body: string };
function blocks(source: string): Block[] {
  const found: Block[] = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  let bodyStart = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '{') {
      if (depth === 0) {
        prelude = source.slice(start, index).trim();
        bodyStart = index + 1;
      }
      depth++;
    } else if (source[index] === '}') {
      depth--;
      if (depth === 0) {
        found.push({ prelude, body: source.slice(bodyStart, index) });
        start = index + 1;
      }
    }
  }
  return found;
}
/** Declarations of every rule in `source` whose selector list names `selector` exactly. */
const declarations = (source: string, selector: string) =>
  blocks(source)
    .filter((block) => block.prelude.split(',').some((part) => part.trim() === selector))
    .map((block) => block.body)
    .join(';');
const media = (query: string) =>
  blocks(css)
    .filter((block) => block.prelude === `@media ${query}`)
    .map((block) => block.body)
    .join('\n');

describe('the annual lobster prices table', () => {
  it('fits its four columns in the card on the narrowest phones', () => {
    // At 380px and below 12px cells overflow the card (346px of table in 286px at 320).
    const narrow = media('(max-width: 380px)');
    for (const selector of ['.market-table-panel th', '.market-table-panel td'])
      expect(declarations(narrow, selector), selector).toMatch(/padding-inline:\s*8px/);
    // "Landed value" and "Price / lb" may take two lines rather than push a column off the card.
    expect(declarations(narrow, '.market-table-panel thead th')).toMatch(/white-space:\s*normal/);
    // It comes after the phone rules it narrows, so it wins over their 12px padding.
    expect(css.lastIndexOf('@media (max-width: 380px)')).toBeGreaterThan(
      css.lastIndexOf('@media (max-width: 760px)'),
    );
  });

  it('draws the edge cue in an ink each theme can see', () => {
    const scroller = declarations(css, '.market-table-scroll');
    expect(scroller).toMatch(/--market-scroll-cue:\s*rgb\(0 0 0/);
    expect(scroller).toMatch(/radial-gradient\([^)]*var\(--market-scroll-cue\)/);
    // A dark shade vanishes on the dark card, so the dark theme draws a light one.
    expect(declarations(css, "html[data-theme='dark'] .market-table-scroll")).toMatch(
      /--market-scroll-cue:\s*rgb\(229 238 235 \/ 0\.\d+\)/,
    );
  });
});
