import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The sheet's record layout lives in CSS jsdom cannot lay out, so these read the shipped rules. */
const srcDir = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) =>
  readFileSync(join(srcDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const adjudicationCss = read('adjudication.css');
const workflowCss = read('components/workflow.css');
const themeCss = read('theme.css');
const stylesCss = read('styles.css');

/** Declarations of the first rule whose selector list is `selector`, outside any @media or inside `inMedia`. */
function declarations(css: string, selector: string, { inMedia = '' } = {}) {
  const source = inMedia
    ? css.slice(css.indexOf(inMedia) + inMedia.length)
    : css.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
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

describe('bet sheet record styles', () => {
  it('gives the next step’s buttons one full width on a phone', () => {
    const phone = '@media (max-width: 520px) {';
    expect(
      declarations(adjudicationCss, '.next-action > .action-buttons', { inMedia: phone })?.[
        'flex-direction'
      ],
    ).toBe('column');
    for (const selector of ['.next-action > .action-buttons > .button, .next-action > .button'])
      expect(declarations(adjudicationCss, selector, { inMedia: phone })?.width).toBe('100%');
  });

  it('sets the position cards’ initials at the 12px floor on a phone', () => {
    // The phone rule overrides the avatar's own size; it once squeezed the initials to 11px.
    const rule = declarations(stylesCss, '.position-card .avatar', {
      inMedia: '@media (max-width: 520px) {',
    });
    expect(rule?.['font-size']).toBe('12px !important');
    expect(Number.parseFloat(rule?.width ?? '0')).toBeGreaterThanOrEqual(28);
  });

  it('keeps the prompt record’s heading the same size on a phone as on a desk', () => {
    // It once shrank to 12px on phones, smaller than the 12px text beside it.
    expect(declarations(adjudicationCss, '.prompt-record h3')?.['font-size']).toBe('13px');
    expect(
      declarations(adjudicationCss, '.prompt-record h3', {
        inMedia: '@media (max-width: 520px) {',
      }),
    ).toBeUndefined();
  });

  it('sets the records’ headings at the sheet’s section size, apart from the form’s', () => {
    expect(
      declarations(workflowCss, '.workflow-record h3, .workflow-review h3')?.['font-size'],
    ).toBe('13px');
    expect(declarations(workflowCss, '.workflow-fields h3')?.['font-size']).toBe('15px');
  });

  it('gives every disclosure on the sheet the same weight', () => {
    expect(
      declarations(workflowCss, '.workflow-tools summary, .workflow-prior summary')?.[
        'font-weight'
      ],
    ).toBe('600');
    expect(declarations(adjudicationCss, '.prompt-record summary')?.['font-weight']).toBe('600');
  });

  it('draws the approvals chip as a pill on the dark record surface', () => {
    const chip = declarations(
      themeCss,
      "html[data-theme='dark'] .prompt-record > div:first-child > span",
    )!;
    expect(chip.background).toBe('var(--surface-inset)');
    expect(chip.border).toBe('1px solid var(--border)');
  });

  it('tints added and removed prompt lines in both themes, never by colour alone', () => {
    for (const [css, prefix] of [
      [adjudicationCss, ''],
      [themeCss, "html[data-theme='dark'] "],
    ] as const) {
      expect(declarations(css, `${prefix}.prompt-changes .diff-added`)?.background).toBeTruthy();
      expect(declarations(css, `${prefix}.prompt-changes .diff-removed`)?.background).toBeTruthy();
    }
    // The + and − marks are real characters in the markup, so the tint is only a second cue.
    expect(
      declarations(adjudicationCss, ".prompt-changes li > [aria-hidden='true']"),
    ).toBeDefined();
  });

  it('marks a waiting result or delivery with a dashed edge and keeps each block’s own dark fill', () => {
    expect(declarations(workflowCss, '.result-block.result-pending')?.['border-style']).toBe(
      'dashed',
    );
    const dark = declarations(themeCss, "html[data-theme='dark'] .result-block.result-pending");
    expect(dark?.['border-color']).toBe('var(--border)');
    expect(dark?.background).toBeUndefined();
  });

  it('lands the sheet’s script-focused targets below its pinned heading, counting it once', () => {
    // "Your move" scrolls to the next step, and a refused copy focuses the agreed prompt. The sheet's
    // scroll padding already clears its pinned heading, with room for the ring (Modal measures it),
    // so a scroll margin on either target would count the heading twice and land it far lower.
    expect(declarations(read('styles.css'), '.modal-content')?.['scroll-padding-top']).toBe(
      'var(--pinned-top, 12px)',
    );
    expect(declarations(workflowCss, '.next-action h3')?.['scroll-margin-top']).toBeUndefined();
    expect(
      declarations(adjudicationCss, '.prompt-record pre')?.['scroll-margin-top'],
    ).toBeUndefined();
  });

  it('keeps the dark "Your move" label dark on its green bar, not the page’s light strong text', () => {
    expect(declarations(themeCss, "html[data-theme='dark'] .your-move")?.color).toBe('#10201f');
    expect(declarations(themeCss, "html[data-theme='dark'] .your-move strong")?.color).toBe(
      'inherit',
    );
  });
});
