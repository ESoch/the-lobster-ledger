import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The Roll prices rows and chart are laid out by CSS jsdom cannot paint, so these read the rules. */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(
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

describe('price report rows', () => {
  it('break a long unbroken note or item name instead of running past the panel', () => {
    // A pasted address is one "word" a 320px row cannot fit; it wraps wherever it must.
    const text = declarations(css, '.price-observation > div');
    expect(text).toMatch(/min-width:\s*0/);
    expect(text).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the price chart', () => {
  it('shows a point’s value on hover, on keyboard focus and when it is tapped', () => {
    for (const selector of [
      '.price-point:hover .price-point-value',
      '.price-point:focus-visible .price-point-value',
      '.price-point[data-shown] .price-point-value',
    ])
      expect(declarations(css, selector), selector).toMatch(/opacity:\s*1/);
    // Hidden until then, so the dots do not crowd each other's labels.
    expect(declarations(css, '.price-chart .price-point-value')).toMatch(/opacity:\s*0/);
  });

  it('draws its own focus ring round the focused point, in the focus colour', () => {
    expect(declarations(css, '.price-focus')).toMatch(/stroke:\s*var\(--focus-ring\)/);
    expect(declarations(css, '.price-focus')).toMatch(/opacity:\s*0/);
    expect(declarations(css, '.price-point:focus-visible .price-focus')).toMatch(/opacity:\s*1/);
    // The browser's own box round the whole group would be a second, square ring.
    expect(declarations(css, '.price-point:focus')).toMatch(/outline:\s*none/);
  });
});
