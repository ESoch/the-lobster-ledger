import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

/** Structural checks on the Ledger's controls and the offset history that jsdom cannot paint. */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
interface Rule {
  selector: string;
  media: string;
  decls: Map<string, string>;
}
const rules: Rule[] = [];
for (const file of (readdirSync(srcDir, { recursive: true }) as string[]).filter((name) =>
  name.endsWith('.css'),
)) {
  postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkRules((rule) => {
    const media: string[] = [];
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent)
      if (parent.type === 'atrule') media.unshift((parent as AtRule).params);
    const decls = new Map<string, string>();
    rule.each((node) => {
      if (node.type === 'decl') decls.set(node.prop, node.value);
    });
    for (const selector of rule.selectors)
      rules.push({
        selector: selector.replace(/\s+/g, ' ').trim(),
        media: media.join(' and '),
        decls,
      });
  });
}
/** What the rules for `selector` in exactly this media query declare together, later ones winning. */
const declared = (selector: string, media = '') =>
  new Map(
    rules
      .filter((rule) => rule.selector === selector && rule.media === media)
      .flatMap((rule) => [...rule.decls]),
  );
const px = (value: string | undefined) => Number.parseFloat(value ?? 'NaN');

describe('the Ledger status chips on the narrowest phones', () => {
  // Six chips wrap to three rows at 320px: the widest row ("To settle", "Settled" and "Other
  // closed") is 279px in a 254px lane, so "Other closed" dropped to a row of its own and the first
  // bet sat 47px lower. Trimming each chip's inner padding and gaps makes that row 244px (measured
  // in the browser), which leaves 10px for a font that loads late. Re-measure before trimming less.
  const narrow = '(max-width: 360px)';
  const chip = '.ledger-page .filter-tabs button';

  it('trims the chip padding and the gap before the count, in the same breakpoint', () => {
    expect(px(declared(chip, narrow).get('padding-inline'))).toBeLessThanOrEqual(5);
    expect(px(declared(chip, narrow).get('gap'))).toBeLessThanOrEqual(4);
    expect(px(declared(`${chip} span`, narrow).get('padding-inline'))).toBeLessThanOrEqual(3);
  });

  it('keeps the chips 44px tall and the count in its pill, so only the width gives', () => {
    const base = declared('.filter-tabs button');
    expect(base.get('padding')).toBeTruthy();
    for (const prop of ['min-height', 'padding-block', 'height'])
      expect(declared(chip, narrow).has(prop), prop).toBe(false);
  });

  it('tightens the space between chips sideways only, so the rows stay as far apart as before', () => {
    const lane = declared('.ledger-page .filter-tabs', narrow).get('gap');
    expect(lane).toMatch(/^\d+px \d+px$/);
    const [row, column] = lane!.split(' ').map(px);
    expect(column).toBeLessThanOrEqual(2);
    expect(row).toBeGreaterThanOrEqual(3);
  });
});

describe('the Ledger controls on a phone', () => {
  // At 320x640 the first bet sat 38px below the fold in the demo build (about level with it in the
  // real app, whose demo bar is 101px shorter). The controls give back space around themselves, in
  // the one breakpoint, and nothing that is a target: the chips, the search field, the select and
  // the checkbox keep their 44px.
  const phone = '(max-width: 520px)';

  it('folds the count away while nothing is filtered, for sighted eyes only', () => {
    const quiet = declared('.ledger-page .ledger-result-summary[data-unfiltered]', phone);
    // The chip "All bets 16" already says it. The text stays for screen readers, in the live
    // region, so "3 of 16 bets" is still announced; it is not display: none.
    expect(quiet.get('position')).toBe('absolute');
    expect(quiet.get('width')).toBe('1px');
    expect(quiet.get('height')).toBe('1px');
    expect(quiet.get('clip')).toBe('rect(0, 0, 0, 0)');
    expect(quiet.get('overflow')).toBe('hidden');
    expect(quiet.has('display')).toBe(false);
    expect(declared('.ledger-page .ledger-result-summary[data-unfiltered]').size).toBe(0);
  });

  it('trims the space above the chips and below the search row, not the targets', () => {
    expect(px(declared('.ledger-page .filter-tabs', phone).get('padding-top'))).toBeLessThan(15);
    expect(px(declared('.ledger-page .filter-tabs', phone).get('padding-bottom'))).toBeLessThan(12);
    expect(
      px(declared('.ledger-page .ledger-search-row', phone).get('padding-bottom')),
    ).toBeLessThan(17);
    // The table's header row is two words, not a target.
    expect(px(declared('.ledger-page .bet-table-head', phone).get('padding-block'))).toBeLessThan(
      13,
    );
    for (const target of [
      '.ledger-page .filter-tabs button',
      '.ledger-page .ledger-search-row',
      '.ledger-page .ledger-secondary-filters',
    ])
      for (const prop of ['min-height', 'height', 'max-height'])
        expect(declared(target, phone).has(prop), `${target} ${prop}`).toBe(false);
    expect(px(declared('.sort-control select').get('min-height'))).toBeGreaterThanOrEqual(44);
    expect(px(declared('.checkbox-label').get('min-height'))).toBeGreaterThanOrEqual(44);
  });
});

describe('small targets in the Ledger controls and the offset history', () => {
  it('draws the "Only my bets" checkbox at the 24px WCAG 2.5.8 minimum', () => {
    const box = declared('.checkbox-label input');
    expect(px(box.get('width'))).toBeGreaterThanOrEqual(24);
    expect(px(box.get('height'))).toBeGreaterThanOrEqual(24);
    // In a nowrap flex row the box would otherwise give up width to its label on a narrow screen.
    expect(box.get('flex')).toMatch(/^(none|0 0 \d+px)$/);
  });

  it('keeps the search input itself at 24px, inside its 44px field', () => {
    expect(px(declared('.search-field input').get('min-height'))).toBeGreaterThanOrEqual(24);
  });

  it('gives the bet links under an offset a 24px line, so stacked references are not 3px apart', () => {
    const link = declared('.offset-entry li .link-button');
    expect(px(link.get('min-height'))).toBeGreaterThanOrEqual(24);
    // min-height does nothing to an inline box.
    expect(link.get('display')).toMatch(/^inline-(flex|block)$/);
  });
});
