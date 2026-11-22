import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** Structural checks on the CLI and AI-connection guides and the welcome links that jsdom cannot paint. */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
interface Rule {
  file: string;
  selector: string;
  atRules: string[];
  decls: Map<string, string>;
}
const rules: Rule[] = [];
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
const declared = (selector: string, prop: string, atRule?: string) =>
  rules
    .filter(
      (rule) =>
        rule.selector === selector &&
        rule.decls.has(prop) &&
        (atRule === undefined ? rule.atRules.length === 0 : rule.atRules.includes(atRule)),
    )
    .map((rule) => rule.decls.get(prop));

describe('guide layout', () => {
  it('lets the guides’ intro run the width of the panel column on a phone', () => {
    // The app-wide phone rule caps a subtitle at 240px for headings that share a row with buttons;
    // the guides' headings have none, and a capped intro leaves a third of the column empty.
    expect(declared('.cli-guide .page-heading p', 'max-width')).toEqual(['none']);
    expect(declared('.page-heading p', 'max-width', 'media (max-width: 520px)')).toContain('240px');
  });

  it('stacks the aside under the steps until the two columns each have room for their commands', () => {
    const stacked = declared(
      '.cli-guide-layout',
      'grid-template-columns',
      'media (max-width: 1100px)',
    );
    expect(stacked).toEqual(['1fr']);
    expect(
      declared('.cli-guide-layout', 'grid-template-columns', 'media (max-width: 900px)'),
    ).toEqual([]);
    const [columns] = declared('.cli-guide-layout', 'grid-template-columns') as string[];
    const aside = columns
      .match(/minmax\((\d+)px/g)!
      .map((value) => Number.parseInt(value.slice(7)));
    // The commands in the aside card ("lobster auth logout --origin ...") need about 250px to stay whole.
    expect(aside.at(-1)).toBeGreaterThanOrEqual(300);
  });
});

describe('guide links as tap targets', () => {
  it('gives the welcome page’s two guide links a 44px target, like the public header link', () => {
    expect(declared('.welcome-cli-link', 'min-height')).toEqual(['44px']);
    expect(declared('.cli-public-link', 'min-height')).toEqual(['44px']);
  });

  it('gives a link that sits alone in its paragraph a 44px target, centred on its text', () => {
    expect(declared('.cli-guide a.cli-standalone-link', 'min-height')).toEqual(['44px']);
    expect(declared('.cli-guide a.cli-standalone-link', 'display')).toEqual(['inline-flex']);
    expect(declared('.cli-guide a.cli-standalone-link', 'align-items')).toEqual(['center']);
  });
});
