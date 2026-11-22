import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * The ledger table's status column. Every row is its own grid, so the column is a fixed pixel track
 * (a content-sized one would not line up with the header or with the other rows). A chip is centered,
 * so a label wider than its track spills over both edges equally and scrollWidth does not notice it:
 * the text crowds the border and runs up to the stake. LedgerViews.dom.test.ts holds the labels to
 * 19 characters ("Confirming delivery"); "Pending agreement" and "Confirming delivery" are the widest
 * and need a 142px chip (icon, 4px gap, 112px of text, 6px padding and a 1px border either side) at
 * every width. The floor adds 4px for a font that loads late. Measure again before lowering it.
 */
const srcDir = fileURLToPath(new URL('.', import.meta.url));

interface Track {
  file: string;
  media: string;
  columns: string[];
}

/** Every five-column grid for the ledger table's own rows (the compact tables and phones differ). */
const tracks: Track[] = [];
for (const file of ['styles.css', 'readability.css', 'theme.css']) {
  postcss.parse(readFileSync(join(srcDir, file), 'utf8'), { from: file }).walkRules((rule) => {
    const grid = rule.nodes?.find(
      (node) => node.type === 'decl' && node.prop === 'grid-template-columns',
    );
    if (grid?.type !== 'decl') return;
    if (!rule.selectors.includes('.bet-row') || rule.selectors.some((s) => s.includes('compact')))
      return;
    const media: string[] = [];
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent)
      if (parent.type === 'atrule') media.unshift((parent as AtRule).params);
    // Splitting on spaces would cut minmax(180px, 1.8fr) apart, so split outside parentheses.
    const columns = grid.value.split(/\s+(?![^(]*\))/);
    if (columns.length === 5) tracks.push({ file, media: media.join(' and '), columns });
  });
}

/** The track floor at each breakpoint that restyles the ledger table's columns. */
const floors: Record<string, number> = {
  '': 146,
  '(max-width: 1200px)': 146,
  '(max-width: 1000px)': 146,
};

describe('the ledger table status column', () => {
  it('has a status track for each breakpoint this test knows the label width at', () => {
    expect(tracks.map((track) => track.media).sort()).toEqual(Object.keys(floors).sort());
  });

  it.each(Object.entries(floors))(
    'is wide enough for "Confirming delivery" at %s',
    (media, floor) => {
      const track = tracks.find((item) => item.media === media)!;
      const status = track.columns[2];
      expect(status).toMatch(/^\d+px$/);
      expect(Number.parseInt(status)).toBeGreaterThanOrEqual(floor);
    },
  );
});
