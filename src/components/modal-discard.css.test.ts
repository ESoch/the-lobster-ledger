import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The discard question's tone lives in CSS jsdom cannot paint, so these read the shipped rules. */
const srcDir = fileURLToPath(new URL('..', import.meta.url));
const stylesCss = readFileSync(join(srcDir, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const themeCss = readFileSync(join(srcDir, 'theme.css'), 'utf8');

function declarations(css: string, selector: string) {
  const source = css.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.replace(/\s+/g, ' ').trim() !== selector) continue;
    return Object.fromEntries(
      body
        .split(';')
        .map((declaration) => declaration.split(/:(.*)/s).map((part) => part?.trim()))
        .filter(([property, value]) => property && value),
    ) as Record<string, string>;
  }
  return undefined;
}

describe('the question before discarding unsaved input', () => {
  const rule = declarations(stylesCss, '.modal-discard') ?? {};
  it('is a gold caution in both themes, not the red of an error', () => {
    // The dark theme defines the status gold tokens; the light theme falls back to the gold tint
    // the duplicate-bet warning uses.
    expect(rule.background).toBe('var(--status-gold-bg, #fbf5e6)');
    expect(rule.border).toBe('1px solid var(--status-gold-border, #e6d6ad)');
    expect(rule.color).toBe('var(--gold-text)');
    expect(themeCss).toMatch(/html\[data-theme='dark'\] \{[^}]*--status-gold-bg:/);
    expect(themeCss).toMatch(/html\[data-theme='dark'\] \{[^}]*--status-gold-border:/);
    expect(themeCss).toMatch(/:root \{[^}]*--gold-text:/);
  });
  it('keeps the question’s own words gold over the dark theme’s grey for every paragraph', () => {
    // `html[data-theme='dark'] p` is (0,1,2); this selector has to outrank it.
    expect(declarations(stylesCss, '.modal-content .modal-discard > p')?.color).toBe('inherit');
  });
  it('keeps the light theme free of a status gold token the fallback would hide', () => {
    expect(themeCss).not.toMatch(/:root \{[^}]*--status-gold-bg:/);
    expect(stylesCss).not.toMatch(/:root \{[^}]*--status-gold-bg:/);
  });
});
