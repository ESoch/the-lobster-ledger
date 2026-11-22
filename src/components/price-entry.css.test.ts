import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** How the price dialog's questions look is CSS jsdom cannot paint, so these read the rules. */
const css = readFileSync(new URL('./price-entry.css', import.meta.url), 'utf8').replace(
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

describe('the price dialog’s questions', () => {
  it('wear the gold notice tint of the app, in both themes, not the error red', () => {
    const notice = declarations(css, '.price-entry-notice');
    // The tokens switch with the theme (the dark block redefines them), so one rule serves both.
    expect(notice).toMatch(/background:\s*var\(--status-gold-bg,/);
    expect(notice).toMatch(/border:\s*1px solid var\(--status-gold-border,/);
    expect(notice).toMatch(/color:\s*var\(--text,/);
    expect(notice).not.toMatch(/--red|#a34f34|#faf0ea|status-red/);
  });

  it('read in the notice ink, since the dark theme would otherwise mute their paragraphs', () => {
    // `html[data-theme='dark'] p` is more specific than a bare class, so the rule names the form too.
    expect(declarations(css, '.price-entry-form .price-entry-notice > p')).toMatch(
      /color:\s*inherit/,
    );
  });
});

describe('the earlier reports under a restaurant’s prices', () => {
  it('break a long unbroken note instead of running past the panel', () => {
    expect(declarations(css, '.price-earlier li')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
