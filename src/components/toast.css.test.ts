import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

/** The toast's layout lives in CSS jsdom cannot lay out, so these read the shipped rules. */
const srcDir = fileURLToPath(new URL('..', import.meta.url));
const cssFiles = (readdirSync(srcDir, { recursive: true }) as string[]).filter((file) =>
  file.endsWith('.css'),
);
const read = (file: string) =>
  readFileSync(join(srcDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const toastCss = read('components/toast.css');

/** Declarations of the first rule whose selector list is exactly `selector`, outside any @media. */
function declarations(css: string, selector: string, { inMedia = '' } = {}) {
  const source = inMedia
    ? css.slice(css.indexOf(inMedia) + inMedia.length)
    : css.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.trim() !== selector) continue;
    return Object.fromEntries(
      body
        .split(';')
        .map((declaration) => declaration.split(/:(.*)/s).map((part) => part?.trim()))
        .filter(([property, value]) => property && value),
    ) as Record<string, string>;
  }
  return undefined;
}

/** Declarations of the rule for `selector` inside exactly the at-rule `@media <params>`. */
function mediaRule(file: string, selector: string, params: string) {
  const found: Record<string, string> = {};
  postcss.parse(readFileSync(join(srcDir, file), 'utf8')).walkRules((rule) => {
    const parent = rule.parent as AtRule;
    if (parent.type !== 'atrule' || parent.name !== 'media' || parent.params !== params) return;
    if (rule.selectors.includes(selector))
      rule.walkDecls((decl) => void (found[decl.prop] = decl.value));
  });
  return Object.keys(found).length ? found : undefined;
}

describe('toast stylesheet', () => {
  it('lets clicks through the empty region but not through the toast itself', () => {
    // Radix switches pointer events off on <body> while a dialog is open; the toast must switch them back on.
    expect(declarations(toastCss, '.toast-region')?.['pointer-events']).toBe('none');
    expect(declarations(toastCss, '.toast')?.['pointer-events']).toBe('auto');
  });

  it('stacks above the dialog overlay and content', () => {
    const modal = Math.max(
      ...cssFiles
        .flatMap((file) => [
          ...read(file).matchAll(/\.modal-(?:overlay|content)\s*\{[^}]*z-index:\s*(\d+)/g),
        ])
        .map((match) => Number(match[1])),
    );
    expect(modal).toBeGreaterThanOrEqual(1001);
    expect(Number(declarations(toastCss, '.toast-region')?.['z-index'])).toBeGreaterThan(modal);
  });

  it('is fixed beside the 232px sidebar, not centred over the page', () => {
    const region = declarations(toastCss, '.toast-region')!;
    expect(region.position).toBe('fixed');
    expect(parseInt(region.left, 10)).toBeGreaterThanOrEqual(232);
    expect(region.transform).toBeUndefined();
  });

  it('reads at 14px at every width', () => {
    expect(declarations(toastCss, '.toast')?.['font-size']).toBe('14px');
    expect(toastCss).not.toMatch(/font-size:\s*(?:9|10|11|12|13)px/);
  });

  it('gives the dismiss button a 44px target', () => {
    const button = declarations(toastCss, '.toast button')!;
    expect(button.width).toBe('44px');
    expect(button.height).toBe('44px');
  });

  it('turns an error toast red', () => {
    const error = declarations(toastCss, ".toast[data-tone='error']")!;
    expect(error['border-color']).toBe('var(--toast-error-border)');
    expect(toastCss).toMatch(/--toast-error-border:\s*#ef8a78/);
  });

  it('stays left of an open sheet where there is room, and at the foot of it where there is not', () => {
    expect(toastCss).toMatch(
      /@media \(min-width: 1154px\)\s*\{\s*body:has\(\.detail-sheet\) \.toast-region\s*\{\s*width:\s*min\(420px, calc\(100vw - 854px\)\)/,
    );
    const docked = declarations(toastCss, 'body:has(.detail-sheet) .toast-region', {
      inMedia: '@media (min-width: 761px) and (max-width: 1153px) {',
    })!;
    expect(docked.left).toBe('auto');
    expect(docked.right).toBe('16px');
  });

  it('keeps the sheet’s last entry clear of a docked toast, however tall the copy wraps', () => {
    const padded = declarations(toastCss, '.detail-sheet > .bet-detail', {
      inMedia: '@media (max-width: 1153px) {',
    })!;
    // At least the room a short toast needs; more by the height Toast.tsx publishes, plus the
    // toast's own offset from the window's foot and some air, so a four line toast at 320px clears.
    expect(padded['padding-bottom']).toMatch(
      /^max\(96px, calc\(var\(--toast-height, 0px\) \+ (\d+)px \+ env\(safe-area-inset-bottom\)\)\)$/,
    );
    const room = Number(padded['padding-bottom'].match(/\+ (\d+)px/)![1]);
    expect(room).toBeGreaterThanOrEqual(12 + 16);
  });

  it('eases the sheet’s end padding back when the toast goes, so the content glides rather than snaps', () => {
    // Scrolled to the end, the room the toast held goes with it and the content drops by that much;
    // the global reduced-motion rule (styles.css) turns the transition off for those who ask.
    const padded = declarations(toastCss, '.detail-sheet > .bet-detail', {
      inMedia: '@media (max-width: 1153px) {',
    })!;
    expect(padded.transition).toMatch(/^padding-bottom \d*\.?\d+s/);
  });

  it('sits above the safe area on a phone', () => {
    const phone = declarations(toastCss, '.toast-region', {
      inMedia: '@media (max-width: 760px) {',
    })!;
    expect(phone.bottom).toContain('env(safe-area-inset-bottom)');
    expect(phone.left).toBe('12px');
    expect(phone.right).toBe('12px');
  });

  it('stays at the foot of the window below an open dialog, which gives up the room', () => {
    // A toast over a dialog would lie over its heading, or over Cancel and Propose bet at its foot,
    // so up to 1153px (no room beside it) the dialog moves up and shrinks to leave it the foot.
    const selector = 'body:has(.modal-content:not(.detail-sheet)) .toast-region';
    for (const params of ['(max-width: 760px)', '(min-width: 761px) and (max-width: 1153px)'])
      expect(mediaRule('components/toast.css', selector, params)?.top, params).toBeUndefined();
    const phone = mediaRule('components/toast.css', '.toast-region', '(max-width: 760px)')!;
    expect(phone.bottom).toContain('env(safe-area-inset-bottom)');
    expect(declarations(toastCss, '.toast-region')!.bottom).toBe('16px');
  });

  it('leaves exactly the toast and 12px of air below a dialog, at every width up to 1153px', () => {
    // The dialog fills the window less --toast-room at its foot and its own margin at its top; the
    // margin is half of the 56px, 30px and 22px (in all) that styles.css leaves around it.
    const all = (params: string) =>
      Number(
        mediaRule('styles.css', '.modal-content', params)?.['max-height'].match(
          /^calc\(100dvh - (\d+)px\)$/,
        )?.[1],
      );
    const widths = [
      // Where the rule applies, the margin in all, and the toast's offset from the window's foot.
      { media: '(max-width: 1153px)', all: 56, offset: 16 },
      { media: '(max-width: 760px)', all: all('(max-width: 760px)'), offset: 12 },
      { media: '(max-width: 520px)', all: all('(max-width: 520px)'), offset: 12 },
    ];
    expect(declarations(read('styles.css'), '.modal-content')?.['max-height']).toBe(
      'calc(100dvh - 56px)',
    );
    expect(widths.map((width) => width.all)).toEqual([56, 30, 22]);
    expect(declarations(toastCss, ':root:has(.toast-region .toast)')!['--toast-room']).toBe(
      'calc(var(--toast-height, 0px) + 16px + 12px)',
    );
    expect(
      mediaRule('components/toast.css', ':root:has(.toast-region .toast)', '(max-width: 760px)')![
        '--toast-room'
      ],
    ).toBe('calc(var(--toast-height, 0px) + 12px + env(safe-area-inset-bottom) + 12px)');
    for (const { media, all: margin, offset } of widths) {
      const rule = mediaRule(
        'components/toast.css',
        ':root:has(.toast-region .toast) .modal-content:not(.detail-sheet)',
        media,
      )!;
      const shift = /^calc\(\(100dvh - var\(--toast-room\) \+ (\d+)px\) \/ 2\)$/.exec(rule.top);
      const shrink = /^calc\(100dvh - var\(--toast-room\) - (\d+)px\)$/.exec(rule['max-height']);
      // One number serves both: the dialog's top margin, half of what is left around it.
      expect(Number(shift?.[1]), media).toBe(margin / 2);
      expect(Number(shrink?.[1]), media).toBe(margin / 2);
      for (const height of [500, 568, 640, 700, 1180])
        for (const toast of [64, 106]) {
          const room = toast + offset + 12;
          const maxHeight = height - room - margin / 2;
          const centre = (height - room + margin / 2) / 2;
          expect(centre - maxHeight / 2, `${media} ${height} top`).toBe(margin / 2);
          // The dialog's foot is 12px above the toast's top.
          expect(height - offset - toast - (centre + maxHeight / 2), `${media} ${height}`).toBe(12);
        }
    }
  });

  it('eases the dialog back to its size when the toast goes, so a form being typed in does not jump', () => {
    const eased = mediaRule(
      'components/toast.css',
      '.modal-content:not(.detail-sheet)',
      '(max-width: 1153px)',
    )!;
    expect(eased.transition).toMatch(/top 0?\.\d+s/);
    expect(eased.transition).toMatch(/max-height 0?\.\d+s/);
  });

  it('centres under a dialog between 761px and 1153px, and sits top left of it only from 1154px', () => {
    const selector = 'body:has(.modal-content:not(.detail-sheet)) .toast-region';
    const centred = mediaRule(
      'components/toast.css',
      selector,
      '(min-width: 761px) and (max-width: 1153px)',
    )!;
    expect(centred.left).toBe('50%');
    expect(centred.transform).toBe('translateX(-50%)');
    expect(centred.top).toBeUndefined();
    const beside = mediaRule('components/toast.css', selector, '(min-width: 1154px)')!;
    expect(beside.top).toBe('12px');
    expect(beside.bottom).toBe('auto');
    expect(beside.left).toBe('16px');
  });

  it('keeps beside a dialog centred on a wide window, never over it', () => {
    // From 1154px there is room left of the widest dialog, so the toast keeps to it and Tab through
    // the dialog holds it (Toast.tsx). Narrower, it sits below the dialog, which makes room for it.
    const selector = 'body:has(.modal-content:not(.detail-sheet)) .toast-region';
    const rules: { media: string; width?: string }[] = [];
    postcss.parse(readFileSync(join(srcDir, 'components/toast.css'), 'utf8')).walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      const parent = rule.parent as AtRule;
      const found: { media: string; width?: string } = {
        media: parent.type === 'atrule' ? parent.params : '',
      };
      rule.walkDecls('width', (decl) => void (found.width = decl.value));
      rules.push(found);
    });
    const wide = rules.find((rule) => rule.media === '(min-width: 1154px)');
    const [, dialog, gap] = /^min\(420px, calc\(\(100vw - (\d+)px\) \/ 2 - (\d+)px\)\)$/.exec(
      wide?.width ?? '',
    ) ?? ['', 'NaN', 'NaN'];
    const widest = declarations(read('styles.css'), '.modal-wide')?.width;
    expect(widest).toBe(`min(${dialog}px, calc(100% - 32px))`);
    for (const viewport of [1154, 1280, 1440, 1920]) {
      const width = Math.min(420, (viewport - Number(dialog)) / 2 - Number(gap));
      // The toast starts 16px from the window's left edge and stops short of the dialog's.
      expect(16 + width, `${viewport}px`).toBeLessThanOrEqual((viewport - Number(dialog)) / 2 - 8);
      expect(width, `${viewport}px`).toBeGreaterThanOrEqual(220);
    }
  });

  it('is the only stylesheet that styles the toast', () => {
    const others = cssFiles
      .filter((file) => !file.endsWith('toast.css'))
      .filter((file) => /\.toast(?![\w-])/.test(read(file)));
    expect(others).toEqual([]);
  });
});
