import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** Structural checks on the Balances page and offset card styles that jsdom cannot paint. */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const rules: { file: string; selector: string; media: boolean; decls: Map<string, string> }[] = [];
for (const file of (readdirSync(srcDir, { recursive: true }) as string[]).filter((name) =>
  name.endsWith('.css'),
)) {
  postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkRules((rule) => {
    const decls = new Map<string, string>();
    rule.each((node) => {
      if (node.type === 'decl') decls.set(node.prop, node.value);
    });
    for (const selector of rule.selectors) {
      rules.push({
        file,
        selector: selector.replace(/\s+/g, ' ').trim(),
        media: rule.parent?.type === 'atrule',
        decls,
      });
    }
  });
}
/** The declarations every top-level rule for `selector` contributes, later rules winning. */
const base = (selector: string) =>
  new Map(
    rules
      .filter((rule) => rule.selector === selector && !rule.media)
      .flatMap((rule) => [...rule.decls]),
  );

const luminance = (hex: string) => {
  const [red, green, blue] = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const contrast = (first: string, second: string) => {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

describe('Balances styles', () => {
  it('draws the debt-direction arrow in the muted ink, which is 4.5:1 on the white row', () => {
    expect(base('.group-balance > svg').get('color')).toBe('var(--muted)');
    // readability.css loads after styles.css, so its :root token is the one that applies.
    const muted = rules.find(
      (rule) =>
        rule.file === 'readability.css' && rule.selector === ':root' && rule.decls.has('--muted'),
    )!;
    // --muted is now an alias of --muted-strong, which theme.css defines for the light theme.
    const alias = muted.decls.get('--muted')!.match(/^var\((--[\w-]+)\)$/)?.[1];
    const ink = alias
      ? rules
          .find(
            (rule) =>
              rule.file === 'theme.css' && rule.selector === ':root' && rule.decls.has(alias),
          )!
          .decls.get(alias)!
      : muted.decls.get('--muted')!;
    expect(contrast(ink, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('lays the summary tiles out as columns so the figures share a bottom edge', () => {
    const tile = base('.balance-summary > div');
    expect(tile.get('display')).toBe('flex');
    expect(tile.get('flex-direction')).toBe('column');
    expect(tile.get('justify-content')).toBe('space-between');
  });

  it('sets the reported-delivery note in the muted ink at 12px, under the row it belongs to', () => {
    const note = base('.balance-pending');
    expect(note.get('color')).toBe('var(--muted)');
    expect(Number.parseInt(note.get('font-size')!)).toBeGreaterThanOrEqual(12);
    // Around the table rows wrap so the note takes a line of its own instead of squeezing the names.
    expect(base('.group-balance-reported').get('flex-wrap')).toBe('wrap');
    expect(base('.group-balance-reported > .balance-pending').get('flex')).toBe('0 0 100%');
  });

  it('keeps each panel as tall as its own content', () => {
    expect(base('.balance-columns').get('align-items')).toBe('start');
  });

  it('leaves the gap between a figure and its unit to the space in the markup', () => {
    expect(base('.balance-summary small').has('margin-left')).toBe(false);
    expect(base('.person-balance small').has('margin-left')).toBe(false);
  });
});

describe('offset card styles', () => {
  it('borrows the balance row for suggestions instead of restyling the padding and type', () => {
    const own = base('.offset-suggestion');
    for (const prop of ['padding', 'font-size', 'border-bottom']) expect(own.has(prop)).toBe(false);
    expect(base('.offset-suggestion > button').get('min-width')).toBe('132px');
  });

  it('underlines in-app bet links', () => {
    expect(base('.link-button').get('text-decoration')).toBe('underline');
  });

  it('lets the offset record text column fill its block', () => {
    const column = base('.offset-record > div');
    expect(column.get('flex')).toBe('1');
    expect(column.get('min-width')).toBe('0');
  });

  it('gives the review dialog no padding of its own beyond the modal', () => {
    expect(base('.offset-review').has('padding')).toBe(false);
    expect(rules.some((rule) => /\.offset-review \.form-actions/.test(rule.selector))).toBe(false);
  });

  it('sets the lasting "offset recorded" note in the green ink, in the card gutters, above the 12px floor', () => {
    const note = base('.debt-offsets .offset-applied');
    expect(note.get('color')).toBe('var(--green)');
    expect(note.get('padding')).toBe('16px 24px');
    expect(Number.parseInt(note.get('font-size')!)).toBeGreaterThanOrEqual(12);
  });

  it('inks a history entry headline at full text colour in the dark theme, as strong as its lines', () => {
    // The dark theme inks every paragraph muted; the headline is a paragraph, its lines are not.
    const dark = rules.filter(
      (rule) =>
        rule.selector.startsWith("html[data-theme='dark']") &&
        /\.offset-entry p\b/.test(rule.selector),
    );
    expect(dark.length).toBeGreaterThan(0);
    for (const rule of dark) expect(rule.decls.get('color')).toBe('var(--text)');
  });

  it('draws no control ring on what script focus lands on after a review closes', () => {
    // Like the page heading, the note and the card heading are not controls; a browser default
    // ring around them would look like a button that is not there.
    for (const selector of [
      ".debt-offsets .offset-applied[tabindex='-1']:focus",
      ".debt-offsets h2[tabindex='-1']:focus",
    ]) {
      expect(base(selector).get('outline'), selector).toBe('none');
    }
  });

  it('keeps the settle-row chips on one line and bordered in forced colours', () => {
    expect(base('.bet-meta > .bet-chip').get('white-space')).toBe('nowrap');
    expect(
      rules.some(
        (rule) =>
          rule.selector === '.bet-chip' &&
          rule.media &&
          rule.decls.get('border')?.includes('ButtonText'),
      ),
    ).toBe(true);
  });
});
