import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** Structural checks on the Overview panels that jsdom cannot paint. */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const rules: { selector: string; media: boolean; decls: Map<string, string> }[] = [];

/** `:is(a, b) c` as `a c` and `b c`, so a shared rule can be looked up by either of its subjects. */
const expand = (selector: string): string[] => {
  const at = selector.indexOf(':is(');
  if (at < 0) return [selector.replace(/\s+/g, ' ').trim()];
  let depth = 0;
  let end = at + 3;
  for (; end < selector.length; end++) {
    if (selector[end] === '(') depth++;
    if (selector[end] === ')' && --depth === 0) break;
  }
  const alternatives = selector.slice(at + 4, end).split(/,(?![^(]*\))/);
  return alternatives.flatMap((alternative) =>
    expand(`${selector.slice(0, at)}${alternative.trim()}${selector.slice(end + 1)}`),
  );
};

for (const file of (readdirSync(srcDir, { recursive: true }) as string[]).filter((name) =>
  name.endsWith('.css'),
)) {
  postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkRules((rule) => {
    const decls = new Map<string, string>();
    rule.each((node) => {
      if (node.type === 'decl') decls.set(node.prop, node.value);
    });
    for (const selector of rule.selectors.flatMap(expand))
      rules.push({ selector, media: rule.parent?.type === 'atrule', decls });
  });
}
/** What every top-level rule for `selector` declares together, later rules winning. */
const base = (selector: string) =>
  new Map(
    rules
      .filter((rule) => rule.selector === selector && !rule.media)
      .flatMap((rule) => [...rule.decls]),
  );

describe('Bragging rights medals', () => {
  it('draws the rank as the numbered disc the Leaderboard draws, so the places differ by more than a tint', () => {
    const disc = base('.mini-leader .rank-medal');
    expect(disc.get('display')).toBe('inline-grid');
    expect(disc.get('border-radius')).toBe('50%');
    expect(disc.get('background')).toBe('var(--medal-fill)');
    expect(disc.get('box-shadow')).toContain('var(--medal-ring)');
    expect(disc.get('width')).toBe(disc.get('height'));
    // The same disc as the Leaderboard's, not a second one to keep in step.
    expect(disc.get('width')).toBe(base('.leaderboard-row .rank-medal').get('width'));
  });

  it('gives first, second and third a fill and a ring of their own, in both themes', () => {
    for (const place of [1, 2, 3]) {
      for (const prefix of ['', "html[data-theme='dark'] "]) {
        const tint = base(`${prefix}.mini-leader .rank-${place}`);
        expect(tint.get('--medal-fill'), `${prefix}rank ${place} fill`).toBeTruthy();
        expect(tint.get('--medal-ring'), `${prefix}rank ${place} ring`).toBeTruthy();
      }
    }
    const fills = [1, 2, 3].map((place) => base(`.mini-leader .rank-${place}`).get('--medal-fill'));
    expect(new Set(fills).size).toBe(3);
  });

  it('gives the disc its own column in the row, so the name does not sit under it', () => {
    expect(Number.parseInt(base('.mini-leader .rank').get('width')!)).toBeGreaterThanOrEqual(
      Number.parseInt(base('.mini-leader .rank-medal').get('width')!),
    );
  });
});

describe('short captions', () => {
  // "A few lunches to look forward / to.", "Good debts. Better / company.", "...will appear / here."
  // and the title "You’re all caught / up" each left one word alone on the last line. They run to a
  // few short lines, so they are balanced; pretty only avoids the very shortest last lines and left
  // "company." and "reservation." alone. A browser without text-wrap wraps as it did.
  it.each(['.stat-card p', '.empty-state p', '.empty-state h3'])(
    'balances %s so its last line is never a single word',
    (selector) => {
      expect(base(selector).get('text-wrap')).toBe('balance');
    },
  );
});
