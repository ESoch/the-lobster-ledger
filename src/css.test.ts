import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

/** Structural checks on the shipped stylesheets: theme tinting, focus rings, overflow, forced colors. */
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const cssFiles = (readdirSync(srcDir, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.css'))
  .sort();

interface Entry {
  file: string;
  selector: string;
  atRules: string[];
  decls: Map<string, string>;
}

const entries: Entry[] = [];
for (const file of cssFiles) {
  postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkRules((rule) => {
    const atRules: string[] = [];
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule')
        atRules.unshift(`@${(parent as AtRule).name} ${(parent as AtRule).params}`);
    }
    if (atRules.some((at) => at.startsWith('@keyframes'))) return;
    const decls = new Map<string, string>();
    rule.each((node) => {
      if (node.type === 'decl') decls.set(node.prop, node.value);
    });
    for (const selector of rule.selectors) {
      entries.push({ file, selector: selector.replace(/\s+/g, ' ').trim(), atRules, decls });
    }
  });
}

const topLevelCommas = (list: string): string[] => {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    if (list[index] === '(') depth++;
    else if (list[index] === ')') depth--;
    else if (list[index] === ',' && depth === 0) {
      items.push(list.slice(start, index));
      start = index + 1;
    }
  }
  return [...items, list.slice(start)].map((item) => item.trim());
};
/** The element each selector styles: the last compound, looking inside a trailing :is(...) list. */
const subjects = (selector: string): string[] => {
  const group = selector.match(/:is\((.*)\)$/);
  return (group ? topLevelCommas(group[1]) : [selector]).map(
    (item) => item.split(/\s+|>/).filter(Boolean).pop() ?? '',
  );
};
/** True when the selector styles the element carrying `cls` itself, not one of its descendants. */
const names = (cls: string) => ({
  test: (selector: string) =>
    subjects(selector).some((subject) => new RegExp(`\\.${cls}(?![\\w-])`).test(subject)),
});
const withRule = (predicate: (entry: Entry) => boolean) => entries.filter(predicate);
const declared = (selector: string, prop: string) =>
  withRule((entry) => entry.selector === selector && entry.decls.has(prop)).map((entry) =>
    entry.decls.get(prop),
  );

const luminance = (shorthand: string) => {
  const hex = shorthand.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3');
  const [red, green, blue] = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const contrast = (first: string, second: string) => {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

describe('theme tinting', () => {
  const dark = (entry: Entry) => entry.selector.startsWith("html[data-theme='dark']");
  const paintsBackground = (entry: Entry) =>
    [...entry.decls.keys()].some((prop) => prop === 'background' || prop === 'background-color');

  it.each(['terms-block', 'audit-note', 'adjudication-record'])(
    'leaves the unboxed .%s without a dark background',
    (cls) => {
      const offenders = withRule(
        (entry) => dark(entry) && names(cls).test(entry.selector) && paintsBackground(entry),
      ).map((entry) => `${entry.file}: ${entry.selector}`);
      expect(offenders).toEqual([]);
    },
  );

  it.each(['prompt-record', 'result-block', 'next-action'])(
    'paints the card-style .%s from the raised surface token',
    (cls) => {
      const rules = withRule(
        (entry) => dark(entry) && names(cls).test(entry.selector) && paintsBackground(entry),
      );
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.decls.get('background') ?? rule.decls.get('background-color')).toBe(
          'var(--surface-raised)',
        );
      }
    },
  );

  it('keeps the delivery block warm so it never reads as the result block above it', () => {
    const rules = withRule(
      (entry) =>
        dark(entry) && names('settlement-block').test(entry.selector) && paintsBackground(entry),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.decls.get('background')).toBe('var(--status-gold-bg)');
      expect(rule.decls.get('border-color')).toBe('var(--status-gold-border)');
    }
    // The delivery block carries the result-block class too, so its rule has to come later to win.
    const result = withRule(
      (entry) =>
        dark(entry) && names('result-block').test(entry.selector) && paintsBackground(entry),
    );
    for (const earlier of result) {
      expect(entries.indexOf(earlier)).toBeLessThan(entries.indexOf(rules[0]));
    }
  });

  it('keeps the Overview hero card a deeper teal than the plain stat cards', () => {
    const background = (selector: string) =>
      withRule((entry) => entry.selector === selector && entry.decls.has('background')).map(
        (entry) => entry.decls.get('background'),
      );
    const hero = background("html[data-theme='dark'] .balance-feature");
    const plain = background("html[data-theme='dark'] .stat-card");
    expect(hero).toHaveLength(1);
    expect(plain).toHaveLength(1);
    expect(hero[0]).not.toBe(plain[0]);
  });

  it('keeps embedded empty states flat and the icon circle filled', () => {
    const slab = withRule(
      (entry) =>
        dark(entry) && names('empty-state').test(entry.selector) && paintsBackground(entry),
    );
    expect(slab.map((entry) => `${entry.file}: ${entry.selector}`)).toEqual([]);
    const icon = withRule(
      (entry) => dark(entry) && names('empty-icon').test(entry.selector) && paintsBackground(entry),
    );
    expect(icon.length).toBeGreaterThan(0);
    for (const rule of icon) {
      expect(rule.decls.get('background')).not.toMatch(/^(transparent|none)$/);
    }
  });

  it('fills the search wrapper, not the input inside it', () => {
    const wrapper = withRule(
      (entry) =>
        dark(entry) && names('search-field').test(entry.selector) && paintsBackground(entry),
    );
    expect(wrapper.length).toBeGreaterThan(0);
    const inner = withRule(
      (entry) =>
        dark(entry) &&
        /\.search-field/.test(entry.selector) &&
        /\binput$/.test(entry.selector) &&
        entry.decls.get('background') === 'transparent',
    );
    expect(inner.length).toBeGreaterThan(0);
  });

  it('gives the dark connection notice a warning tone', () => {
    const rules = withRule(
      (entry) =>
        dark(entry) &&
        names('connection-notice').test(entry.selector) &&
        paintsBackground(entry) &&
        // The component's info tone overrides it on purpose.
        !/\[data-tone='info'\]/.test(entry.selector),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.decls.get('background')).toBe('var(--status-gold-bg)');
    }
  });

  it('gives the info connection notice a neutral dark surface', () => {
    expect(
      declared("html[data-theme='dark'] .connection-notice[data-tone='info']", 'background'),
    ).toEqual(['var(--surface-raised)']);
  });

  it('styles the next-step form error with one selector, so the dark theme can recolour it', () => {
    const redundant = withRule((entry) => entry.selector === '.next-action > form + p.form-error');
    expect(redundant).toEqual([]);
  });
});

describe('focus indicators', () => {
  const ringRules = entries.filter(
    (entry) =>
      /:focus/.test(entry.selector) &&
      (entry.decls.has('outline') || entry.decls.has('outline-color')),
  );

  it('defines one ring colour per theme', () => {
    expect(declared(':root', '--focus-ring')).toEqual(['#a8691a']);
    expect(declared("html[data-theme='dark']", '--focus-ring')).toEqual(['#c58b42']);
  });

  it('keeps each ring at 3:1 or better on the surfaces it sits on', () => {
    const token = (selector: string, prop: string) => declared(selector, prop)[0] as string;
    const dark = "html[data-theme='dark']";
    for (const surface of ['--surface']) {
      expect(
        contrast(token(':root', '--focus-ring'), token(':root', surface)),
      ).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(token(':root', '--focus-ring'), '#f7f8f5')).toBeGreaterThanOrEqual(3);
    for (const surface of [
      '--surface',
      '--surface-raised',
      '--surface-hover',
      '--surface-selected',
    ]) {
      expect(
        contrast(token(dark, '--focus-ring'), token(dark, surface)),
        surface,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // These surfaces are dark in both themes, so the light-theme ring would sit at 2.3-2.6:1 on them.
  // A surface may name a token (the toast's tones do), so read it from the one rule that defines it.
  const resolve = (value: string) => {
    const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (!token) return value;
    const values = [
      ...new Set(
        withRule((entry) => entry.decls.has(token)).map((entry) => entry.decls.get(token)),
      ),
    ];
    expect(values, token).toHaveLength(1);
    return values[0] as string;
  };
  it.each(['.balance-feature', '.toast'])(
    'keeps the ring at 3:1 on the always-dark %s in both themes',
    (selector) => {
      const dark = "html[data-theme='dark']";
      const rules = withRule(
        (entry) => entry.selector === selector && entry.decls.has('--focus-ring'),
      );
      expect(rules).toHaveLength(1);
      const ring = rules[0].decls.get('--focus-ring') as string;
      const surfaces = [
        declared(selector, 'background')[0],
        declared(`${dark} ${selector}`, 'background')[0],
        // The error toast swaps the surface but keeps the same Dismiss button and ring.
        declared(`${selector}[data-tone='error']`, 'background')[0],
      ]
        .filter((surface): surface is string => !!surface)
        .map(resolve);
      expect(surfaces.length).toBeGreaterThan(0);
      for (const surface of surfaces) {
        expect(contrast(ring, surface), surface).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it('draws every focus outline with var(--focus-ring)', () => {
    expect(ringRules.length).toBeGreaterThan(5);
    const offenders = ringRules
      .filter((entry) => {
        const value = entry.decls.get('outline') ?? entry.decls.get('outline-color') ?? '';
        if (/^(none|0)$/.test(value) || /\btransparent\b/.test(value)) return false;
        if (/\bHighlight\b/.test(value) && entry.atRules.some((at) => /forced-colors/.test(at)))
          return false;
        return !value.includes('var(--focus-ring)');
      })
      // The copy button sits on a dark code block, so its inset ring follows the text colour.
      .filter(
        (entry) =>
          !(
            entry.file === 'components/cli.css' &&
            /currentColor/.test(entry.decls.get('outline') ?? '')
          ),
      )
      .map(
        (entry) => `${entry.file}: ${entry.selector} { outline: ${entry.decls.get('outline')} }`,
      );
    expect(offenders).toEqual([]);
  });

  it('covers disclosure summaries with the shared ring', () => {
    expect(
      withRule((entry) => entry.selector === 'summary:focus-visible').map((entry) =>
        entry.decls.get('outline'),
      ),
    ).toEqual(['3px solid var(--focus-ring)']);
  });

  it('leaves the dialog box itself without the browser ring when focus lands on it', () => {
    // It takes focus only to keep it inside the dialog, never as a control to act on, and the
    // browser would draw its own blue ring on it after a key press.
    expect(declared('.modal-content:focus', 'outline')).toEqual(['none']);
  });

  it.each(['global-search', 'search-field'])(
    'rings the .%s wrapper while its input has focus',
    (cls) => {
      const rule = withRule(
        (entry) => entry.selector === `.${cls}:focus-within` && entry.atRules.length === 0,
      );
      expect(rule).toHaveLength(1);
      expect(rule[0].decls.get('outline')).toBe('3px solid var(--focus-ring)');
    },
  );

  it.each(['global-search', 'search-field'])(
    'keeps the .%s shape when focus arrives instead of rounding it then',
    (cls) => {
      const focused = withRule(
        (entry) => entry.selector === `.${cls}:focus-within` && entry.atRules.length === 0,
      );
      expect(focused[0].decls.has('border-radius')).toBe(false);
      const base = withRule(
        (entry) =>
          entry.selector === `.${cls}` &&
          entry.atRules.length === 0 &&
          entry.decls.has('border-radius'),
      );
      expect(base.length).toBeGreaterThan(0);
    },
  );

  it('never removes the outline from the search inputs without replacing it', () => {
    const removed = withRule(
      (entry) =>
        /(global-search|search-field) input$/.test(entry.selector) &&
        entry.decls.get('outline') === 'none',
    );
    expect(removed.map((entry) => entry.selector)).toEqual([]);
  });

  it('draws the map ring above the Leaflet panes', () => {
    const rule = withRule((entry) =>
      /^\.places-map:has\(.*:focus-visible\)::after$/.test(entry.selector),
    );
    expect(rule).toHaveLength(1);
    expect(rule[0].decls.get('outline')).toContain('var(--focus-ring)');
    const layer = withRule((entry) => entry.selector === '.places-map::after');
    expect(layer).toHaveLength(1);
    expect(Number(layer[0].decls.get('z-index'))).toBeGreaterThanOrEqual(1000);
    expect(layer[0].decls.get('pointer-events')).toBe('none');
  });

  it('insets the ring on full-bleed rows so the panel cannot clip it', () => {
    for (const cls of ['place-item', 'action-item-expanded']) {
      const rule = withRule(
        (entry) => entry.selector === `.${cls}:focus-visible` && entry.decls.has('outline-offset'),
      );
      expect(rule.length, cls).toBeGreaterThan(0);
      expect(rule[0].decls.get('outline-offset')).toMatch(/^-\d+px$/);
    }
  });
});

describe('forced colors', () => {
  const forced = entries.filter((entry) =>
    entry.atRules.some((at) => /forced-colors:\s*active/.test(at)),
  );

  it('keeps chip, tab and row boundaries', () => {
    expect(forced.length).toBeGreaterThan(0);
    const selectors = forced.map((entry) => entry.selector).join('\n');
    for (const cls of ['status-badge', 'filter-tabs button', 'segmented-button', 'place-item']) {
      expect(selectors, cls).toContain(cls);
    }
    expect(forced.some((entry) => /^1px solid/.test(entry.decls.get('border') ?? ''))).toBe(true);
    expect(forced.some((entry) => /Highlight/.test(entry.decls.get('outline') ?? ''))).toBe(true);
  });
});

describe('forced colors, selected and focused', () => {
  const forced = entries.filter((entry) =>
    entry.atRules.some((at) => /forced-colors:\s*active/.test(at)),
  );
  const selected = [
    '.filter-tabs button.selected',
    '.panel-tabs button.selected',
    '.segmented-button.selected',
    '.place-item.selected',
    '.nav-item.active',
  ];

  it.each(selected)('keeps the focus ring apart from the selection outline on %s', (selector) => {
    const outlined = (target: string) =>
      forced.find((entry) => entry.selector === target && entry.decls.has('outline'));
    const marked = outlined(selector);
    const focused = outlined(`${selector}:focus-visible`);
    expect(marked?.decls.get('outline')).toBe('2px solid Highlight');
    expect(focused, `${selector}:focus-visible`).toBeDefined();
    expect(focused?.decls.get('outline')).toMatch(/Highlight/);
    expect(focused?.decls.get('outline')).not.toBe(marked?.decls.get('outline'));
  });

  it('marks the Lobster prices range chip and Preliminary badge', () => {
    const chip = forced.find(
      (entry) => entry.selector === ".market-range-controls button[aria-pressed='true']",
    );
    expect(chip?.decls.get('outline')).toBe('2px solid Highlight');
    const focusedChip = forced.find(
      (entry) =>
        entry.selector === ".market-range-controls button[aria-pressed='true']:focus-visible",
    );
    expect(focusedChip?.decls.get('outline')).toMatch(/Highlight/);
    const badge = forced.find((entry) => entry.selector === '.market-preliminary');
    expect(badge?.decls.get('border')).toMatch(/^1px solid/);
  });
});

describe('Lobster prices layout', () => {
  const base = (selector: string, prop: string) =>
    withRule(
      (entry) => entry.selector === selector && entry.atRules.length === 0 && entry.decls.has(prop),
    ).map((entry) => entry.decls.get(prop));

  it('never breaks a stat figure from its sign, and gives tablets two cards across', () => {
    expect(base('.market-stat > strong', 'white-space')).toEqual(['nowrap']);
    const tablet = withRule(
      (entry) =>
        entry.selector === '.market-summary-grid' &&
        entry.atRules.includes('@media (min-width: 761px) and (max-width: 1000px)'),
    );
    expect(tablet.map((entry) => entry.decls.get('grid-template-columns'))).toEqual([
      'repeat(2, minmax(0, 1fr))',
    ]);
  });

  it('sets the update notice apart from the stat cards, in the warning tone when late', () => {
    expect(base('.market-update-notice', 'margin')).toEqual(['0 0 18px']);
    expect(base('.market-update-notice.warning', 'background')).toEqual([
      'var(--status-gold-bg, #f8f2e6)',
    ]);
  });

  it('tints a range chip under the pointer, so the row of chips answers a hover', () => {
    expect(base('.market-range-controls button:hover', 'background')).toEqual([
      'var(--surface-hover, #f6f9f2)',
    ]);
  });

  it('lets a vertical swipe over the chart scroll the page', () => {
    expect(base('.market-plot-area', 'touch-action')).toEqual(['pan-y']);
  });

  it('keeps the year in view while the annual table scrolls sideways', () => {
    expect(base('.market-table-panel tbody th', 'position')).toEqual(['sticky']);
    expect(base('.market-table-panel tbody th', 'background')).toEqual(['var(--surface, #fff)']);
  });

  it('holds the table heading row in view and scrolls the long table inside its card', () => {
    expect(base('.market-table-scroll', 'overflow')).toEqual(['auto']);
    expect(base('.market-table-scroll', 'max-height')).toEqual(['min(480px, 70vh)']);
    expect(base('.market-table-panel thead th', 'position')).toEqual(['sticky']);
    expect(base('.market-table-panel thead th', 'top')).toEqual(['0']);
    expect(base('.market-table-panel thead th', 'background')).toEqual(['var(--surface, #fff)']);
    // The Year heading is stuck both ways, so it stays above the other headings and the years.
    const z = (selector: string) => Number(base(selector, 'z-index')[0]);
    expect(z('.market-table-panel thead th:first-child')).toBeGreaterThan(
      z('.market-table-panel thead th'),
    );
    expect(z('.market-table-panel thead th')).toBeGreaterThan(z('.market-table-panel tbody th'));
  });

  it('draws a preliminary year dashed, with an open point', () => {
    expect(base('.market-price-line.pending', 'stroke-dasharray')).toEqual(['7 5']);
    // Open: the card colour inside a ring, where the final marker is filled.
    expect(base('.market-point-pending', 'background')).toEqual(['var(--surface, #fff)']);
    expect(base('.market-marker.preliminary', 'background')).toEqual(['var(--surface, #fff)']);
    expect(base('.market-marker', 'background')).toEqual(['var(--green, #315b54)']);
  });

  it('sets the data-age line as plain text at 12px or more: no chip, no icon button, no pointer', () => {
    expect(Number.parseInt(base('.market-data-age', 'font-size')[0]!)).toBeGreaterThanOrEqual(12);
    for (const prop of ['border', 'background', 'cursor', 'padding']) {
      expect(base('.market-data-age', prop), prop).toEqual([]);
    }
  });

  it('stacks the source links as ruled rows on a phone instead of wrapping a loose third one', () => {
    const phone = (selector: string, prop: string) =>
      withRule(
        (entry) =>
          entry.selector === selector &&
          entry.atRules.includes('@media (max-width: 760px)') &&
          entry.decls.has(prop),
      ).map((entry) => entry.decls.get(prop));
    expect(phone('.market-source-links', 'display')).toEqual(['grid']);
    expect(phone('.market-source-links a', 'border-top')).toEqual([
      '1px solid var(--border, #e4e8e1)',
    ]);
    expect(phone('.market-source-links a', 'justify-content')).toEqual(['space-between']);
  });
});

describe('Leaderboard layout', () => {
  const at = (selector: string, prop: string, atRule: string) =>
    withRule(
      (entry) =>
        entry.selector === selector && entry.atRules.includes(atRule) && entry.decls.has(prop),
    ).map((entry) => entry.decls.get(prop));
  const phone = '@media (max-width: 520px)';
  const base = (selector: string, prop: string) =>
    withRule(
      (entry) => entry.selector === selector && entry.atRules.length === 0 && entry.decls.has(prop),
    ).map((entry) => entry.decls.get(prop));

  it('swaps Wins and Losses for one W–L column on phones only', () => {
    expect(base('.leaderboard-row > .col-record', 'display')).toEqual(['none']);
    expect(base('.leaderboard-table-head > .col-record', 'display')).toEqual(['none']);
    expect(at('.leaderboard-row > .col-record', 'display', phone)).toEqual(['block']);
    expect(at('.leaderboard-table-head > .col-record', 'display', phone)).toEqual(['block']);
    // Wins (3rd) and Losses (4th) step aside there, so the five tracks still hold five columns.
    for (const side of ['.leaderboard-table-head', '.leaderboard-row']) {
      expect(at(`${side} > span:nth-child(3)`, 'display', phone)).toEqual(['none']);
      expect(at(`${side} > span:nth-child(4)`, 'display', phone)).toEqual(['none']);
    }
  });

  it('makes the whole row the member name’s hit area, with a hover that shows it is there', () => {
    expect(base('.leaderboard-row.interactive', 'position')).toEqual(['relative']);
    expect(base('.leaderboard-member-link::after', 'position')).toEqual(['absolute']);
    expect(base('.leaderboard-member-link::after', 'inset')).toEqual(['0']);
    // The name itself is no smaller than a 24px target, whatever its text size.
    expect(
      Number.parseInt(base('.leaderboard-member-link', 'min-height')[0]!),
    ).toBeGreaterThanOrEqual(24);
    expect(
      base('.leaderboard-row.interactive:hover .leaderboard-member-link', 'text-decoration-color'),
    ).toEqual(['currentColor']);
    expect(base('.leaderboard-row.interactive:not(.your-row):hover', 'background')).toEqual([
      'var(--surface-hover, #f6f9f2)',
    ]);
  });

  it('draws no All time pill: the scope is said in words under the title', () => {
    expect(withRule((entry) => /all-time-pill/.test(entry.selector))).toEqual([]);
  });

  it('keeps the banner slim on a phone, so the table starts sooner', () => {
    const padding = at('.leaderboard-banner', 'padding', '@media (max-width: 760px)');
    expect(padding).toHaveLength(1);
    expect(Number.parseInt(padding[0]!)).toBeLessThanOrEqual(16);
    expect(
      Number.parseInt(at('.banner-icon', 'width', '@media (max-width: 760px)')[0]!),
    ).toBeLessThanOrEqual(40);
  });

  it('sets the lead sentence in page ink in both themes, not the footnote ink it had', () => {
    expect(declared('.leader-note', 'color')).toEqual([
      'var(--text, #27393b)',
      'var(--text, #27393b)',
    ]);
    expect(declared("html[data-theme='dark'] .leader-note", 'color')).toEqual(['var(--text)']);
  });

  it('reads a negative net on the viewer’s own tinted row at 4.5:1 in the dark theme', () => {
    const root = "html[data-theme='dark']";
    const token = (prop: string) => declared(root, prop)[0] as string;
    // The plain --red clears the cards but not the lighter tint the viewer's own row is given.
    expect(contrast(token('--red'), token('--surface-selected'))).toBeLessThan(4.5);
    const own = declared(`${root} .leaderboard-row.your-row .red`, 'color');
    expect(own).toHaveLength(1);
    expect(contrast(own[0]!, token('--surface-selected'))).toBeGreaterThanOrEqual(4.5);
  });

  it('sets the reason an unranked member is left out as small type under the name', () => {
    const reason = '.leaderboard-member .unranked-reason';
    expect(declared(reason, 'display')).toEqual(['block']);
    expect(declared(reason, 'font-size')).toEqual(['12px']);
    expect(declared(reason, 'color')).toEqual(['var(--muted-strong)']);
    // It sits beside the avatar and may wrap in a narrow column rather than widen the row.
    expect(declared('.leaderboard-member-text', 'min-width')).toEqual(['0']);
  });
});

describe('bet row meta and chips', () => {
  it('trails the separator after every meta item but the last', () => {
    const rule = withRule((entry) => entry.selector === '.bet-meta > span:not(:last-child)::after');
    expect(rule).toHaveLength(1);
    expect(rule[0].decls.get('content')).toBe("'·'");
  });

  it('never opens a wrapped meta line with a separator', () => {
    const leading = withRule(
      (entry) =>
        /\.bet-(meta|title-cell)/.test(entry.selector) &&
        /::before$/.test(entry.selector) &&
        entry.decls.has('content'),
    );
    expect(leading.map((entry) => entry.selector)).toEqual([]);
  });

  it('keeps a status chip on one line, also where the generic chip may wrap', () => {
    const base = withRule(
      (entry) => entry.selector === '.status-badge' && entry.atRules.length === 0,
    );
    expect(base.some((entry) => entry.decls.get('white-space') === 'nowrap')).toBe(true);
    const wrapping = withRule(
      (entry) =>
        names('status-badge').test(entry.selector) &&
        !/\.bet-row/.test(entry.selector) &&
        entry.decls.get('white-space') === 'normal',
    );
    for (const rule of wrapping) {
      const restored = withRule(
        (entry) =>
          entry.selector === '.bet-row .status-badge' &&
          entry.decls.get('white-space') === 'nowrap' &&
          entry.atRules.join() === rule.atRules.join() &&
          entries.indexOf(entry) > entries.indexOf(rule),
      );
      expect(restored.length, rule.atRules.join()).toBeGreaterThan(0);
    }
  });
});

describe('bet table accessibility', () => {
  it('keeps the counterparty names in the accessibility tree when the column is too narrow to show them', () => {
    const hidden = withRule(
      (entry) =>
        entry.selector.endsWith('.bet-people > span:last-child') &&
        entry.decls.get('display') === 'none',
    ).map((entry) => `${entry.file}: ${entry.selector} ${entry.atRules.join()}`);
    expect(hidden).toEqual([]);
    // What replaces display:none has to clip the text, not just move it.
    const clipped = withRule(
      (entry) =>
        entry.selector === '.compact-table .bet-people > span:last-child' &&
        entry.decls.has('clip'),
    );
    expect(clipped.length).toBeGreaterThan(0);
  });

  it('keeps the Status column header for assistive technology on phones', () => {
    const hidden = withRule(
      (entry) =>
        entry.selector === '.bet-table-head > th:nth-child(3)' &&
        entry.decls.get('display') === 'none',
    ).map((entry) => `${entry.file}: ${entry.atRules.join()}`);
    expect(hidden).toEqual([]);
  });
});

describe('map attribution', () => {
  it('stays at 12px or larger at every width', () => {
    const rules = withRule(
      (entry) =>
        entry.selector === '.places-map .leaflet-control-attribution' &&
        entry.decls.has('font-size'),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(
        Number.parseFloat(rule.decls.get('font-size') ?? '0'),
        rule.atRules.join(),
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it('seats the OpenStreetMap link and the attribution in a strip under the full map, not over it', () => {
    // Two rows: the canvas takes what is left, the strip is as tall as its content (it may wrap).
    expect(declared('.places-map--framed', 'display')).toEqual(['grid']);
    expect(declared('.places-map--framed', 'grid-template-rows')).toEqual(['minmax(0, 1fr) auto']);
    // Nothing floats over the pins at the bottom edge: the link is an ordinary item of the strip.
    expect(declared('.places-map-external', 'position')).toEqual([]);
    expect(
      declared('.places-map .places-map-credit .leaflet-control-attribution', 'position'),
    ).toEqual(['static']);
    // Both credit links are at least 24px tall, so none is a small target.
    expect(
      declared('.places-map .places-map-credit .leaflet-control-attribution a', 'min-height'),
    ).toEqual(['24px']);
    expect(declared('.places-map-external', 'min-height')).toEqual(['32px']);
    expect(declared('.places-map-credit', 'flex-wrap')).toEqual(['wrap']);
    expect(declared('.places-map-credit', 'font-size')).toEqual(['12px']);
    // What is drawn over the canvas stays on the canvas's row, not stretched over the strip.
    const overlay = withRule(
      (entry) => entry.selector.startsWith('.places-map--framed') && entry.decls.has('grid-area'),
    );
    expect(overlay.length).toBeGreaterThan(0);
    for (const rule of overlay) expect(rule.decls.get('grid-area')).toBe('1 / 1');
  });
});

describe('overflow', () => {
  it('lets both position cards shrink instead of pushing the sheet wider', () => {
    const tracks = declared('.detail-positions', 'grid-template-columns');
    expect(tracks).toContain('repeat(2, minmax(0, 1fr))');
    expect(tracks.some((value) => /(^|\s)1fr(\s|$)/.test(value ?? ''))).toBe(false);
  });

  it.each(['.detail-title', '.position-card p', '.member-card h3', '.action-item-title'])(
    'breaks unbroken words in %s',
    (selector) => {
      const rules = withRule(
        (entry) => entry.selector === selector && entry.decls.get('overflow-wrap') === 'anywhere',
      );
      expect(rules.length).toBeGreaterThan(0);
    },
  );
});

describe('panel header, chips and Overview order', () => {
  it('aligns every panel header to the top, so a title never sits lower beside an action', () => {
    const base = withRule(
      (entry) => entry.selector === '.section-title' && entry.decls.has('align-items'),
    );
    expect(base.map((entry) => entry.decls.get('align-items'))).toEqual(['flex-start']);
    const anyCentred = withRule(
      (entry) =>
        names('section-title').test(entry.selector) && entry.decls.get('align-items') === 'center',
    );
    expect(anyCentred.map((entry) => `${entry.file}: ${entry.selector}`)).toEqual([]);
  });

  it('keeps the 44px action link on the title line with negative margins, not a taller row', () => {
    const rule = withRule(
      (entry) =>
        entry.selector === '.section-title .text-button' && entry.decls.has('margin-block'),
    );
    expect(rule.map((entry) => entry.decls.get('margin-block'))).toEqual(['-11px']);
  });

  it('never reorders the Overview panels with CSS order: the page order is the focus order', () => {
    const overview = [
      'recent-panel',
      'approvals-panel',
      'waiting-panel',
      'leaderboard-preview',
      'map-preview',
    ];
    const reordered = withRule(
      (entry) =>
        overview.some((cls) => names(cls).test(entry.selector)) && entry.decls.has('order'),
    );
    expect(reordered.map((entry) => `${entry.file}: ${entry.selector}`)).toEqual([]);
  });

  it('places the latest wagers on the left of the first Overview row and Over to you on the right', () => {
    const wide = (selector: string, prop: string) =>
      withRule(
        (entry) =>
          entry.selector === selector && entry.atRules.length === 0 && entry.decls.has(prop),
      ).map((entry) => entry.decls.get(prop));
    expect(wide('.overview-grid > .recent-panel', 'grid-column')).toEqual(['1']);
    expect(wide('.overview-grid > .approvals-panel', 'grid-column')).toEqual(['2']);
    expect(wide('.overview-grid > .recent-panel', 'grid-row')).toEqual(['1']);
    expect(wide('.overview-grid > .approvals-panel', 'grid-row')).toEqual(['1']);
  });

  it('leaves Waiting on… to auto-place across the row under the pinned first row', () => {
    // The markup tabs Over to you, the wagers, then Waiting on…; pinning Waiting on… to a row
    // of its own (or above row 2) would draw it away from where focus reaches it.
    expect(declared('.waiting-panel', 'grid-row')).toEqual([]);
    expect(declared('.waiting-panel', 'grid-column')).toEqual(['1 / -1']);
    expect(declared('.overview-grid > .waiting-panel', 'grid-row')).toEqual([]);
  });

  it('turns the expand chevron over while its list is open', () => {
    expect(
      declared(".approval-footer[aria-expanded='true'] .disclosure-chevron", 'transform'),
    ).toEqual(['rotate(180deg)']);
  });

  it('gives the Leaderboard header the ledger table header treatment', () => {
    const base = (selector: string, prop: string) =>
      withRule(
        (entry) =>
          entry.selector === selector && entry.atRules.length === 0 && entry.decls.has(prop),
      ).map((entry) => entry.decls.get(prop)!);
    // The ledger table's header: 13px above and below, 22px in, and a rule underneath only.
    expect(base('.bet-table-head', 'padding')).toEqual(['13px 22px']);
    expect(base('.bet-table-head', 'border-top')).toEqual([]);
    expect(base('.leaderboard-table-head', 'padding-block')).toEqual(['13px']);
    expect(base('.leaderboard-table-head', 'border-top')).toEqual(['0']);
    // The rows keep the header's inset, so the columns still line up under their labels.
    const inset = (selector: string) =>
      base(selector, 'padding').map((value) => value.split(' ')[1]);
    expect(inset('.leaderboard-table-head')).toEqual(['22px']);
    expect(inset('.leaderboard-row')).toEqual(['22px']);
  });

  it('wraps the ledger status chips instead of scrolling them off-screen', () => {
    const base = withRule(
      (entry) => entry.selector === '.filter-tabs' && entry.atRules.length === 0,
    );
    expect(base.some((entry) => entry.decls.get('flex-wrap') === 'wrap')).toBe(true);
    const scrolling = withRule(
      (entry) =>
        entry.selector === '.filter-tabs' &&
        /^(auto|scroll)$/.test(entry.decls.get('overflow') ?? ''),
    );
    expect(scrolling).toEqual([]);
  });

  it('keeps the "All time" qualifier on the win rate at every width', () => {
    const hidden = withRule(
      (entry) => names('stat-period').test(entry.selector) && entry.decls.get('display') === 'none',
    );
    expect(
      hidden.map((entry) => `${entry.file}: ${entry.selector} ${entry.atRules.join()}`),
    ).toEqual([]);
  });

  it('gives a bet in play, a settled bet and a declined bet different fills', () => {
    const background = (selector: string) => declared(selector, 'background')[0];
    expect(background('.status-active')).not.toBe(background('.status-settled'));
    expect(background('.status-voided')).not.toBe(background('.status-declined'));
    expect(background('.status-pending')).not.toBe(background('.status-confirming'));
    const dark = (cls: string) =>
      withRule((entry) => entry.selector === `html[data-theme='dark'] .${cls}`)[0]?.decls.get(
        'background',
      );
    expect(dark('status-active')).not.toBe(dark('status-settled'));
    expect(dark('status-pending')).not.toBe(dark('status-declined'));
  });

  it('keeps a withdrawn chip grey: it is also a declined chip, so its rules must outrank Declined', () => {
    // A withdrawn bet renders as `status-declined status-withdrawn`; a lone `.status-withdrawn`
    // rule ties with `.status-declined` and loses to whichever is written later.
    const withdrawn = withRule((entry) => /status-withdrawn/.test(entry.selector));
    expect(withdrawn.length).toBeGreaterThanOrEqual(3);
    for (const entry of withdrawn)
      expect(entry.selector, `${entry.file}: ${entry.selector}`).toMatch(
        /\.status-declined\.status-withdrawn/,
      );
  });
});

describe('ledger gutter, Over to you, stat cards and inbox rows', () => {
  const atRule = (entry: Entry) => entry.atRules.join(' ');
  const unconditional = (selector: string, prop: string) =>
    withRule(
      (entry) => entry.selector === selector && entry.atRules.length === 0 && entry.decls.has(prop),
    ).map((entry) => entry.decls.get(prop));

  it('pads the chips, search row, table and footer with one ledger gutter, so their edges line up', () => {
    expect(unconditional('.ledger-page', '--ledger-gutter')).toEqual(['22px']);
    const gutter = [
      '.ledger-page .filter-tabs',
      '.ledger-page .ledger-search-row',
      '.ledger-page .bet-table-head',
      '.ledger-page .bet-row',
      '.ledger-page .table-footer',
    ];
    for (const selector of gutter)
      expect(unconditional(selector, 'padding-inline'), selector).toEqual(['var(--ledger-gutter)']);
    // The gutter narrows with the window, in the same steps as the table's own padding.
    const narrowed = withRule(
      (entry) => entry.selector === '.ledger-page' && entry.decls.has('--ledger-gutter'),
    ).map((entry) => `${atRule(entry)}=${entry.decls.get('--ledger-gutter')}`);
    expect(narrowed).toEqual([
      '=22px',
      '@media (max-width: 1000px)=18px',
      '@media (max-width: 760px)=16px',
    ]);
  });

  it('lets the ledger footer read as one line of text instead of a narrow right-aligned column', () => {
    expect(unconditional('.ledger-page .table-footer > span', 'max-width')).toEqual(['none']);
    expect(unconditional('.ledger-page .table-footer > span', 'text-align')).toEqual(['left']);
  });

  it('pins the Over to you footer to the foot of the panel and aligns the cards with the heading', () => {
    expect(unconditional('.approvals-panel', 'display')).toEqual(['flex']);
    expect(unconditional('.approvals-panel', 'flex-direction')).toEqual(['column']);
    expect(unconditional('.approvals-panel .approval-body', 'flex')).toEqual(['1 1 auto']);
    expect(unconditional('.approvals-panel .approval-list', 'padding-inline')).toEqual(['22px']);
  });

  it('drops the secondary stat captions to the foot of a card that is as tall as the hero card', () => {
    const rules = withRule(
      (entry) =>
        entry.selector === '.stats-grid .stat-card:not(.balance-feature) p' &&
        entry.decls.get('margin-top') === 'auto',
    );
    expect(rules.map(atRule)).toEqual(['@media (min-width: 521px)']);
  });

  it('keeps both stat labels two lines tall on the narrowest phones so their figures stay level', () => {
    const rules = withRule(
      (entry) =>
        entry.selector ===
          '.stats-grid .stat-card:not(.balance-feature):not(:last-child) .stat-label' &&
        entry.decls.has('min-height'),
    );
    expect(rules.map((entry) => `${atRule(entry)}=${entry.decls.get('min-height')}`)).toEqual([
      '@media (max-width: 360px)=36px',
    ]);
  });

  it('moves the hero roll clear of the link in the narrow card of a small laptop', () => {
    const rules = withRule(
      (entry) =>
        entry.selector === '.balance-feature .balance-illustration' &&
        entry.decls.get('bottom') === 'auto',
    );
    expect(rules.map(atRule)).toEqual(['@media (min-width: 1001px) and (max-width: 1230px)']);
    expect(rules[0].decls.get('top')).toBeTruthy();
  });

  it('wraps the map link under its title rather than breaking the title across two lines', () => {
    expect(unconditional('.map-preview .section-title', 'flex-wrap')).toEqual(['wrap']);
  });

  it.each([
    '.action-item-expanded:hover',
    '.action-item-compact:hover',
    '.inbox-activity button:hover',
  ])('washes %s in the light theme visibly more than the 1.03:1 it once did', (selector) => {
    const background = withRule(
      (entry) => entry.selector === selector && entry.decls.has('background'),
    )
      .map((entry) => entry.decls.get('background') ?? '')
      .join(' ');
    const wash = background.match(/#[0-9a-f]{6}/i)?.[0];
    expect(wash, `${selector}: ${background}`).toBeTruthy();
    expect(contrast(wash!, '#ffffff')).toBeGreaterThanOrEqual(1.1);
  });

  it('sets the Overview footer at 12px, the size of the other small print', () => {
    const rules = withRule(
      (entry) =>
        entry.file === 'ledger-workflow.css' &&
        entry.selector === '.workspace-footer' &&
        entry.atRules.length === 0 &&
        entry.decls.has('font-size'),
    );
    expect(rules.map((entry) => entry.decls.get('font-size'))).toEqual(['12px']);
  });

  it('stacks the two Overview footer statements on a phone', () => {
    const rules = withRule(
      (entry) => entry.selector === '.workspace-footer' && entry.decls.has('flex-direction'),
    );
    expect(rules.map((entry) => `${atRule(entry)}=${entry.decls.get('flex-direction')}`)).toEqual([
      '@media (max-width: 520px)=column',
    ]);
  });

  it('keeps a short next-moves list in view only where it cannot hide its own foot', () => {
    const rules = withRule(
      (entry) =>
        entry.selector === '.inbox-columns > .inbox-next-moves.is-short' &&
        entry.decls.get('position') === 'sticky',
    );
    expect(rules.map(atRule)).toEqual(['@media (min-width: 1001px) and (min-height: 760px)']);
  });

  it('draws feed rows edge to edge like next moves, with a hover wash', () => {
    // ledger-workflow.css loads after styles.css and readability.css, so its declarations are the last word.
    const last = (selector: string, prop: string) =>
      withRule(
        (entry) =>
          entry.file === 'ledger-workflow.css' &&
          entry.selector === selector &&
          entry.atRules.length === 0 &&
          entry.decls.has(prop),
      ).map((entry) => entry.decls.get(prop));
    expect(last('.inbox-activity', 'padding')).toEqual(['0']);
    expect(last('.inbox-activity button', 'padding')).toEqual(['18px 22px']);
    expect(last('.inbox-activity button:hover', 'background')).toHaveLength(1);
  });
});

describe('type floor and ink', () => {
  /** px size of a font-size or font shorthand declaration; other units are not used in the sheets. */
  const sizeOf = (entry: Entry) => {
    const sizes: number[] = [];
    const size = entry.decls.get('font-size')?.match(/^(\d*\.?\d+)px$/);
    if (size) sizes.push(Number.parseFloat(size[1]));
    const shorthand = entry.decls.get('font')?.match(/(?:^|\s)(\d*\.?\d+)px/);
    if (shorthand) sizes.push(Number.parseFloat(shorthand[1]));
    return sizes;
  };
  const dark = (entry: Entry) => entry.selector.startsWith("html[data-theme='dark']");
  const token = (selector: string, prop: string) => {
    const values = declared(selector, prop);
    expect(values, `${selector} ${prop}`).toHaveLength(1);
    return values[0] as string;
  };

  it('sets no interface text below 12px, avatar initials aside', () => {
    const offenders = entries
      .filter((entry) => !names('avatar').test(entry.selector))
      .flatMap((entry) =>
        sizeOf(entry)
          .filter((px) => px > 0 && px < 12)
          .map((px) => `${entry.file}: ${entry.selector} ${px}px ${entry.atRules.join(' ')}`),
      );
    expect(offenders).toEqual([]);
  });

  it('keeps paragraphs in a phone-width next step at the size of their siblings', () => {
    const rules = withRule(
      (entry) => entry.selector === '.next-action p' && entry.decls.has('font-size'),
    );
    expect(rules.map((entry) => `${entry.file}: ${entry.atRules.join(' ')}`)).toEqual([]);
  });

  it('draws no text, icon or chart label in one of the muted inks that fall under 4.5:1', () => {
    // Each of these was measured below 4.5:1 on the surface it sits on in the light theme (or the
    // dark one for #63715f's old neighbours). The ink comes from var(--muted-strong) and its kin.
    const banned = [
      '#6d7966',
      '#63715f',
      '#8d9988',
      '#7d9275',
      '#7f8c80',
      '#81976e',
      '#738667',
      '#a3b08e',
      '#a7b497',
      '#8ca175',
      '#7b9367',
      '#a65a43',
    ];
    const offenders: string[] = [];
    for (const file of cssFiles) {
      postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkDecls((decl) => {
        // theme.css is where a token may hold a literal ink.
        if (file === 'theme.css' && decl.prop.startsWith('--')) return;
        const hit = banned.find((ink) => decl.value.toLowerCase().includes(ink));
        if (hit) offenders.push(`${file}:${decl.source?.start?.line} ${decl.prop}: ${decl.value}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('defines the light ink tokens once, each with a dark counterpart', () => {
    for (const prop of ['--muted-strong', '--gold-text']) {
      expect(token(':root', prop)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(token("html[data-theme='dark']", prop)).toMatch(/^(#[0-9a-f]{6}|var\(--gold\))$/i);
    }
  });

  it('keeps --muted-strong at 4.5:1 on every surface text sits on in each theme', () => {
    const light = token(':root', '--muted-strong');
    for (const surface of ['#ffffff', '#f7f8f5', '#fbfcf9', '#e9efe5', '#dfe9dc']) {
      expect(contrast(light, surface), surface).toBeGreaterThanOrEqual(4.5);
    }
    const root = "html[data-theme='dark']";
    for (const surface of [
      '--surface',
      '--surface-inset',
      '--surface-raised',
      '--surface-hover',
      '--surface-selected',
    ]) {
      expect(
        contrast(token(root, '--muted-strong'), token(root, surface)),
        surface,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token(root, '--muted-strong'), '#101b1d')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps --gold-text at 4.5:1 on the page, cards and gold tints', () => {
    const light = token(':root', '--gold-text');
    for (const surface of ['#ffffff', '#f7f8f5', '#f8f2e6']) {
      expect(contrast(light, surface), surface).toBeGreaterThanOrEqual(4.5);
    }
    const root = "html[data-theme='dark']";
    const gold = token(root, '--gold');
    for (const surface of ['--surface', '--surface-raised', '--status-gold-bg']) {
      expect(contrast(gold, token(root, surface)), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws the Roll prices metadata and the late data-age line with the ink tokens', () => {
    const inks = (selector: string, prop = 'color') =>
      withRule((entry) => entry.selector === selector && entry.decls.has(prop) && !dark(entry)).map(
        (entry) => entry.decls.get(prop),
      );
    for (const selector of [
      '.price-observation small',
      '.price-stat small',
      '.price-correct-button',
      '.segmented-button',
    ]) {
      expect(inks(selector), selector).toEqual(['var(--muted-strong)']);
    }
    // The chart's labels are SVG text in a drawing measured to its box, so they fill with the token.
    expect(inks('.price-chart text', 'fill')).toEqual(['var(--muted-strong)']);
    // The change pill says its direction in words; its ink follows the direction.
    expect(inks('.price-delta')).toEqual(['var(--muted-strong)']);
    expect(inks('.price-delta.up')).toEqual(['var(--red)']);
    expect(inks('.price-delta.down')).toEqual(['var(--green)']);
    expect(inks('.market-data-age.late')).toEqual(['var(--gold-text)']);
    expect(inks('.market-preliminary')).toEqual(['var(--gold-text)']);
  });

  it('recolours the Correct link, the chart grid and the provenance note for the dark theme', () => {
    for (const cls of ['price-correct-button', 'provenance-note']) {
      const rules = withRule(
        (entry) => dark(entry) && names(cls).test(entry.selector) && entry.decls.has('color'),
      );
      expect(rules.length, cls).toBeGreaterThan(0);
    }
    // The chart's text takes var(--muted-strong), which the dark theme redefines, so it needs no
    // dark rule of its own; its grid lines do.
    expect(
      withRule((entry) => dark(entry) && entry.selector.includes('.price-chart text')),
    ).toEqual([]);
    expect(declared("html[data-theme='dark'] .price-chart-grid", 'stroke')).toEqual([
      'var(--border)',
    ]);
  });

  it('gives the segmented toggle a 44px target', () => {
    const heights = withRule(
      (entry) => entry.selector === '.segmented-button' && entry.decls.has('min-height'),
    ).map((entry) => entry.decls.get('min-height'));
    expect(heights).toEqual(['44px']);
  });

  /** Every px size a selector sets, whatever the width: a phone rule counts as much as the base one. */
  const sizesAt = (selector: string) =>
    withRule((entry) => entry.selector === selector).flatMap(sizeOf);

  it('keeps avatar initials at 11px or larger at every width', () => {
    // The floor above exempts avatars, so a phone rule could still shrink the initials to 9px.
    const rules = withRule(
      (entry) => names('avatar').test(entry.selector) && sizeOf(entry).length > 0,
    );
    expect(rules.length).toBeGreaterThan(0);
    const offenders = rules.flatMap((entry) =>
      sizeOf(entry)
        .filter((px) => px < 11)
        .map((px) => `${entry.file}: ${entry.selector} ${px}px ${entry.atRules.join(' ')}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    [
      'chrome',
      [
        '.workspace-switch small',
        '.sidebar-profile small',
        '.nav-label',
        '.nav-item small',
        '.demo-bar',
        '.date-eyebrow',
      ],
    ],
    [
      'bet sheet',
      [
        '.status-badge',
        '.lifecycle-step > span',
        '.lifecycle-step small',
        '.record-id',
        '.timeline small',
        '.timeline-heading > span',
        '.audit-note',
      ],
    ],
    [
      'leaderboard table',
      [
        '.leaderboard-table-head',
        '.leaderboard-row',
        '.leaderboard-member strong',
        '.leaderboard-member small',
      ],
    ],
  ])('sets the %s metadata at 12px or larger at every width', (_area, selectors) => {
    for (const selector of selectors) {
      const sizes = sizesAt(selector);
      // Each one names its size, so none depends on inheriting a smaller one from a parent.
      expect(sizes.length, selector).toBeGreaterThan(0);
      expect(Math.min(...sizes), selector).toBeGreaterThanOrEqual(12);
    }
  });

  it('drops the roll of honor’s aside on a phone, so the first rows start higher', () => {
    const phone = withRule(
      (entry) =>
        entry.selector === '.roll-of-honor-aside' &&
        entry.atRules.includes('@media (max-width: 520px)'),
    );
    expect(phone.map((entry) => entry.decls.get('display'))).toEqual(['none']);
    // At 320px the banner's trophy pushes its headline onto a second line; the lead sentence
    // under the title carries the same trophy.
    const narrow = withRule(
      (entry) =>
        entry.selector === '.leaderboard-banner .banner-icon' &&
        entry.atRules.includes('@media (max-width: 360px)'),
    );
    expect(narrow.map((entry) => entry.decls.get('display'))).toEqual(['none']);
  });

  it('keeps every leaderboard rule at 12px or larger at every width, avatar initials aside', () => {
    const offenders = withRule(
      (entry) => /\.leaderboard-/.test(entry.selector) && !names('avatar').test(entry.selector),
    ).flatMap((entry) =>
      sizeOf(entry)
        .filter((px) => px > 0 && px < 12)
        .map((px) => `${entry.selector} ${px}px ${entry.atRules.join(' ')}`),
    );
    expect(offenders).toEqual([]);
  });

  it('draws the stepper numerals in an ink that reads on their circle in both themes', () => {
    const root = "html[data-theme='dark']";
    expect(declared('.lifecycle-step > span', 'color')).toEqual(['var(--muted-strong)']);
    expect(declared('.lifecycle-step > span', 'background')).toEqual(['#fff']);
    expect(contrast(token(':root', '--muted-strong'), '#fff')).toBeGreaterThanOrEqual(4.5);
    const darkCircle = `${root} .lifecycle-step > span`;
    expect(declared(darkCircle, 'color')).toEqual(['var(--muted)']);
    expect(declared(darkCircle, 'background')).toEqual(['var(--surface-inset)']);
    expect(contrast(token(root, '--muted'), token(root, '--surface-inset'))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('sets the Correct link at 12px with a 44px target', () => {
    expect(sizesAt('.price-correct-button')).toEqual([12]);
    expect(declared('.price-correct-button', 'min-height')).toEqual(['44px']);
  });
});

describe('form chrome', () => {
  const dark = "html[data-theme='dark']";
  const token = (selector: string, prop: string) => declared(selector, prop)[0] as string;

  it('has one footer primitive, and it stays in view while a long form scrolls', () => {
    const retired = withRule((entry) =>
      /\.(modal-actions|form-actions)(?![\w-])/.test(entry.selector),
    );
    expect(retired.map((entry) => `${entry.file}: ${entry.selector}`)).toEqual([]);
    const footer = withRule((entry) => entry.selector === '.modal-footer' && !entry.atRules.length);
    expect(footer).toHaveLength(1);
    expect(footer[0].decls.get('position')).toBe('sticky');
    expect(footer[0].decls.get('justify-content')).toBe('flex-end');
    expect(footer[0].decls.get('border-top')).toBe('1px solid var(--border)');
    const markup = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) =>
        /modal-actions|form-actions/.test(readFileSync(join(srcDir, file), 'utf8')),
      );
    expect(markup).toEqual([]);
  });

  it('gives a pinned footer the dialog surface, so nothing scrolls into view behind it', () => {
    // `inherit` copied a transparent wrapper (the offset review's list), so rows showed through.
    const footer = withRule((entry) => entry.selector === '.modal-footer' && !entry.atRules.length);
    expect(footer[0].decls.get('background')).toBe('var(--surface)');
    expect(token(':root', '--surface')).toBe(token('.modal-content', 'background'));
    expect(token(dark, '--surface')).toBe(token(`${dark} .modal-content`, 'background'));
    // In the sheet an inline form sits on the next step's own tint and its footer takes that.
    expect(declared('.inline-action-form > .modal-footer', 'background')).toEqual(['inherit']);
    expect(declared('.inline-action-form', 'background')).toEqual(['inherit']);
    expect(token('.next-action', 'background')).toMatch(/^#/);
  });

  it('stretches a footer to the dialog edges in whatever wrapper ends the dialog', () => {
    // The offset review ends in a footer inside a plain <div>, not a <form>.
    const edge = (selector: string) => declared(selector, 'bottom');
    for (const selector of [
      '.modal-content > .modal-footer:last-child',
      '.modal-content > :last-child > .modal-footer:last-child',
    ])
      expect(edge(selector), selector).toEqual(['calc(-1 * var(--modal-pad))']);
  });

  it('gives form fields a 3:1 boundary against the field and the surface in both themes', () => {
    for (const surface of ['#ffffff', '#f5f8ef'])
      expect(contrast(token(':root', '--field-border'), surface), surface).toBeGreaterThanOrEqual(
        3,
      );
    for (const surface of ['#142326', '#1a292b', token(dark, '--surface-raised')])
      expect(contrast(token(dark, '--field-border'), surface), surface).toBeGreaterThanOrEqual(3);
    const borders = withRule(
      (entry) =>
        /^\.bet-form input$|^\.inline-action-form input$|^\.input-affix$/.test(entry.selector) &&
        entry.decls.has('border'),
    );
    expect(borders.length).toBeGreaterThanOrEqual(3);
    for (const rule of borders) expect(rule.decls.get('border')).toContain('var(--field-border)');
  });

  it('marks an invalid field in the error ink in both themes', () => {
    const invalid = withRule(
      (entry) =>
        entry.selector.includes("[aria-invalid='true']") &&
        entry.decls.get('border-color') === 'var(--red)',
    );
    expect(invalid.length).toBeGreaterThan(0);
  });

  it('shows a not-allowed cursor, never a wait cursor, on a plain disabled button', () => {
    expect(declared('button:disabled', 'cursor')).toEqual(['not-allowed']);
    expect(declared("button[aria-busy='true']", 'cursor')).toEqual(['progress']);
  });

  it('keeps paragraphs inside a phone inline form at 12px or larger', () => {
    const shrunk = withRule(
      (entry) =>
        entry.selector === '.next-action p' &&
        /^(8|9|10|11)px$/.test(entry.decls.get('font-size') ?? ''),
    );
    expect(shrunk.map((entry) => entry.atRules.join(' '))).toEqual([]);
  });

  it('keeps the Optional marker next to its label instead of pushing it to its own row', () => {
    for (const rule of withRule((entry) => names('optional').test(entry.selector)))
      expect(rule.decls.get('margin-left')).not.toBe('auto');
    expect(declared('.field-label', 'display')).toContain('flex');
  });

  it('gives a date group the same gap above its error as a field has', () => {
    // A date's controls sit in a fieldset, not a .field, so its error does not get the field's gap.
    const gap = declared('.field', 'gap')[0];
    expect(gap).toBeDefined();
    expect(declared('.historical-date-field > .field-error', 'margin-top')).toEqual([gap]);
  });

  it('keeps the discard question in view in the sheet, inside its pinned heading', () => {
    // A static row scrolled away behind the pinned heading, so Escape appeared to do nothing; a
    // row pinned over the heading covered Close. Inside the heading it is pinned with it.
    expect(withRule((entry) => entry.selector === '.detail-sheet > .modal-discard')).toEqual([]);
    expect(declared('.detail-sheet > .modal-heading', 'position')).toEqual(['sticky']);
    expect(declared('.detail-sheet > .modal-heading', 'flex-wrap')).toEqual(['wrap']);
    const inside = '.detail-sheet > .modal-heading > .modal-discard';
    expect(declared(inside, 'flex')).toEqual(['1 0 100%']);
    expect(declared(inside, 'position')).toEqual(['static']);
  });

  it('gives inset headings no browser-default margin', () => {
    expect(declared('.workflow-inset h4', 'margin')).toEqual(['0']);
  });

  it('gives every one-line field one height, so a date, a select and a text box sit level', () => {
    expect(declared(':root', '--control-height')).toEqual(['46px']);
    const sized = withRule(
      (entry) => !entry.atRules.length && entry.decls.get('height') === 'var(--control-height)',
    ).map((entry) => entry.selector);
    // Native date inputs and selects are otherwise a few pixels off a text box with the same padding.
    expect(sized.some((selector) => /input:not\(/.test(selector) && /select/.test(selector))).toBe(
      true,
    );
    expect(sized).toContain('.input-affix');
    // The text box inside a unit box fills it rather than adding its own height.
    expect(declared('.bet-form .input-affix input', 'height')).toEqual(['100%']);
  });

  it('keeps the Optional marker at 4.5:1 on the light form surfaces', () => {
    // readability.css loads after styles.css, so its colour is the one people see.
    const ink = withRule(
      (entry) =>
        entry.file === 'readability.css' &&
        entry.selector === '.optional' &&
        entry.decls.has('color'),
    )[0].decls.get('color') as string;
    // The ink may be a light-theme token such as var(--muted-strong); measure the value it holds.
    const light = ink.replace(/^var\((--[\w-]+)\)$/, (_, name: string) => token(':root', name));
    for (const surface of ['#ffffff', '#f6f9f0', '#fbfcf8'])
      expect(contrast(light, surface), surface).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the signatures on a record at 12px or larger, as it is the text that commits people', () => {
    const sizes = (selector: string) =>
      declared(selector, 'font-size').map((value) => Number.parseFloat(value as string));
    expect(Math.min(...sizes('.workflow-signatures > div'))).toBeGreaterThanOrEqual(13);
    expect(Math.min(...sizes('.workflow-signatures small'))).toBeGreaterThanOrEqual(12);
    expect(Math.min(...sizes('.workflow-acknowledgements > legend'))).toBeGreaterThanOrEqual(13);
  });
});

describe('member cards', () => {
  const phone = (entry: Entry) => entry.atRules.some((at) => at.includes('max-width: 520px'));
  const narrow = (entry: Entry) => entry.atRules.some((at) => at.includes('max-width: 360px'));

  it('lays the three stats in one three-column row at every width, never a wrapping one', () => {
    const display = withRule((entry) => names('member-stats').test(entry.selector)).filter(
      (entry) => entry.decls.has('display'),
    );
    expect(display.map((entry) => entry.decls.get('display'))).toEqual(['grid']);
    expect(declared('.member-stats', 'grid-template-columns')).toEqual([
      'repeat(3, minmax(0, 1fr))',
    ]);
    const wrapping = withRule(
      (entry) => names('member-stats').test(entry.selector) && entry.decls.has('flex-wrap'),
    ).map((entry) => `${entry.file}: ${entry.selector}`);
    expect(wrapping).toEqual([]);
    // A stat must not claim a share of the row for itself, which is what pushed the third onto a new line.
    const claims = withRule(
      (entry) => /\.member-stats\s*>\s*div/.test(entry.selector) && entry.decls.has('flex'),
    ).map((entry) => `${entry.file}: ${entry.selector}`);
    expect(claims).toEqual([]);
  });

  it('lets a long name wrap inside its Bet with button, and stacks a card’s two buttons on a phone', () => {
    const wrapping = withRule(
      (entry) =>
        entry.selector === '.member-actions .button' &&
        entry.decls.get('white-space') === 'normal' &&
        entry.decls.get('overflow-wrap') === 'anywhere' &&
        entry.decls.get('max-width') === '100%',
    );
    expect(wrapping).toHaveLength(1);
    const stacked = withRule(
      (entry) =>
        entry.selector === '.member-actions' &&
        phone(entry) &&
        entry.decls.get('flex-direction') === 'column',
    );
    expect(stacked).toHaveLength(1);
  });

  it('trails the dot after every part of a card’s summary but the last, so a wrapped line never starts with one', () => {
    const trailing = withRule(
      (entry) => entry.selector === '.member-role > span:not(:last-child)::after',
    );
    expect(trailing).toHaveLength(1);
    expect(trailing[0].decls.get('content')).toBe("'·'");
    expect(
      withRule((entry) => /\.member-role/.test(entry.selector) && /::before$/.test(entry.selector)),
    ).toEqual([]);
  });

  it('sits the figures on the foot of every card, so cards of different heights keep them level', () => {
    expect(declared('.member-card', 'flex-direction')).toEqual(['column']);
    const margins = withRule(
      (entry) => entry.selector === '.member-stats' && entry.decls.has('margin'),
    ).map((entry) => entry.decls.get('margin'));
    expect(margins.length).toBeGreaterThan(0);
    for (const margin of margins) expect(margin).toMatch(/^auto /);
    expect(declared('.member-stats', 'align-self')).toEqual(['stretch']);
  });

  it('spans the invite card across the whole grid on a phone, so it is never a half-width orphan', () => {
    const spans = withRule(
      (entry) =>
        entry.selector === '.invite-member-card' &&
        phone(entry) &&
        entry.decls.get('grid-column') === '1 / -1',
    );
    expect(spans).toHaveLength(1);
  });

  it('gives each card the room for three stats: two to a row on a phone, one on a narrow one', () => {
    const tracks = (selector: string, test: (entry: Entry) => boolean) =>
      withRule(
        (entry) =>
          entry.selector === selector && test(entry) && entry.decls.has('grid-template-columns'),
      ).map((entry) => entry.decls.get('grid-template-columns'));
    expect(tracks('.members-grid', (entry) => entry.atRules.length === 0)).toEqual([
      'repeat(3, 1fr)',
    ]);
    expect(tracks('.members-grid', narrow)).toEqual(['minmax(0, 1fr)']);
  });

  it('keeps the stat labels and the card text at 12px or larger at every width', () => {
    const offenders = withRule((entry) =>
      /\.(member-|members-|invite-member-card|invite-label)/.test(entry.selector),
    ).flatMap((entry) => {
      const size = entry.decls.get('font-size')?.match(/^(\d*\.?\d+)px$/);
      return size && Number.parseFloat(size[1]) < 12
        ? [`${entry.selector} ${size[1]}px ${entry.atRules.join(' ')}`]
        : [];
    });
    expect(offenders).toEqual([]);
  });
});
