import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** The signed-out welcome page: its buttons fit a 320px phone and its two guide links never touch. */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const rules: { file: string; selector: string; atRules: string[]; decls: Map<string, string> }[] =
  [];
for (const file of (readdirSync(srcDir, { recursive: true }) as string[]).filter((name) =>
  name.endsWith('.css'),
)) {
  postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkRules((rule) => {
    const atRules: string[] = [];
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule') atRules.unshift(`${parent.name} ${parent.params}`);
    }
    const decls = new Map<string, string>();
    rule.each((node) => {
      if (node.type === 'decl') decls.set(node.prop, node.value);
    });
    for (const selector of rule.selectors)
      rules.push({ file, selector: selector.replace(/\s+/g, ' ').trim(), atRules, decls });
  });
}
const declared = (selector: string, prop: string) =>
  rules
    .filter((rule) => rule.selector === selector && rule.decls.has(prop))
    .map((rule) => rule.decls.get(prop));

const declaredIn = (selector: string, prop: string, atRule: string) =>
  rules
    .filter(
      (rule) => rule.selector === selector && rule.decls.has(prop) && rule.atRules.includes(atRule),
    )
    .map((rule) => rule.decls.get(prop));

describe('welcome layout', () => {
  it('spaces the two guide links with a gap in both directions, so they cannot touch', () => {
    expect(declared('.welcome-links', 'display')).toEqual(['flex']);
    expect(declared('.welcome-links', 'flex-wrap')).toEqual(['wrap']);
    const [gap] = declared('.welcome-links', 'gap') as string[];
    // "row column": a stacked pair and a side-by-side pair are both separated.
    const [row, column] = gap.split(/\s+/).map((value) => Number.parseInt(value, 10));
    expect(row).toBeGreaterThanOrEqual(8);
    expect(column).toBeGreaterThanOrEqual(16);
  });

  it('leaves the spacing around the links to their wrapper', () => {
    expect(declared('.welcome-cli-link', 'margin-top')).toEqual([]);
    expect(declared('.welcome-links', 'margin-top')).toEqual(['22px']);
  });

  it('lets the welcome buttons shrink to the content box instead of overflowing a 320px phone', () => {
    expect(declared('.welcome-screen .button', 'width')).toEqual(['min(290px, 100%)']);
  });

  it('keeps the notice’s own buttons out of the welcome button sizing', () => {
    expect(declared('.welcome-screen .connection-notice .button', 'width')).toEqual(['auto']);
    expect(declared('.welcome-screen .connection-notice .button', 'margin')).toEqual(['0']);
  });

  it('balances the subtitle on a measure wide enough that "for." is never left on a line alone', () => {
    expect(declared('.welcome-screen main > p', 'text-wrap')).toEqual(['balance']);
    expect(declared('.welcome-screen main > p', 'max-width')).toEqual(['440px']);
  });

  it('flows the trust line’s shield with its words, so wrapping cannot strand the icon', () => {
    // A flex row would centre the wrapped text in the space beside a shield stuck at the edge.
    expect(declared('.welcome-trust', 'display')).toEqual([]);
    expect(declared('.welcome-trust', 'text-align')).toEqual(['center']);
    expect(declared('.welcome-trust svg', 'display')).toEqual(['inline-block']);
  });

  it('leaves room under the content on a phone for the roll in the corner', () => {
    const [room] = declaredIn(
      '.welcome-screen > main',
      'margin-bottom',
      'media (max-width: 760px)',
    ) as string[];
    expect(Number.parseInt(room, 10)).toBeGreaterThanOrEqual(100);
  });

  it('tightens the top of the page at 360px and below so the buttons fit a 320x640 phone', () => {
    const at = 'media (max-width: 360px)';
    expect(declaredIn('.welcome-emblem', 'width', at)).toEqual(['64px']);
    expect(declaredIn('.welcome-screen h1', 'font-size', at)).toEqual(['38px']);
  });

  it('draws the Google mark on a white disc and keeps no rule for the old bold letter', () => {
    expect(declared('.google-mark', 'background')).toEqual(['#fff']);
    expect(declared('.google-mark', 'border-radius')).toEqual(['50%']);
    expect(rules.filter((rule) => /google-letter/.test(rule.selector))).toEqual([]);
  });

  it('sets the waiting-page line as plain text with an icon, so it does not read as a button', () => {
    for (const selector of [
      '.welcome-pending-bet',
      "html[data-theme='dark'] .welcome-pending-bet",
    ]) {
      for (const prop of ['border', 'background', 'box-shadow'])
        expect(declared(selector, prop), `${selector} ${prop}`).toEqual([]);
    }
  });

  it('has no rules left for the retired setup notice', () => {
    expect(rules.filter((rule) => /setup-notice/.test(rule.selector))).toEqual([]);
  });
});

describe('the opening screen', () => {
  it('does not outline the status words when focus lands on them from script', () => {
    expect(declared(".loading-status[tabindex='-1']:focus", 'outline')).toEqual(['none']);
  });

  it('uses the page’s ink, not the muted green, for words that are read', () => {
    expect(declared('.loading-screen', 'color')).toEqual(['inherit']);
  });

  it('sets its words at 14px', () => {
    expect(declared('.loading-status', 'font-size')).toEqual(['14px']);
  });
});
