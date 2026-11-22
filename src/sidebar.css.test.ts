import { readFileSync } from 'node:fs';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

// The sidebar (and the phone drawer, the same element) pins its footer, so on a short window the
// navigation scrolls inside its own region. jsdom cannot lay that out, so these read the shipped rules.

const source = (file: string) => readFileSync(`src/${file}`, 'utf8');
/** Declarations of every rule for `selector`, inside the at-rule `inMedia` or at the top level. */
function declarations(file: string, selector: string, inMedia = '') {
  const found = new Map<string, string>();
  postcss.parse(source(file)).walkRules((rule) => {
    const parent = rule.parent;
    const media =
      parent?.type === 'atrule' ? `@${(parent as AtRule).name} ${(parent as AtRule).params}` : '';
    if (media !== inMedia || !rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => void found.set(decl.prop, decl.value));
  });
  return found;
}

describe('the sidebar navigation on a short window', () => {
  it('shows a shadow at an edge with more links beyond it, and none once that end is reached', () => {
    const nav = declarations('adjudication.css', '.sidebar > nav');
    const layers = (nav.get('background') ?? '').split(/,\s*(?=(?:linear|radial)-gradient)/);
    // Two covers that scroll with the links, painted in the sidebar's own colour, over two
    // shadows that stay at the edges: a cover hides its shadow once that end is in view.
    const covers = layers.filter((layer) => / local$/.test(layer.trim()));
    const shadows = layers.filter((layer) => / scroll$/.test(layer.trim()));
    expect(covers).toHaveLength(2);
    expect(shadows).toHaveLength(2);
    for (const cover of covers) expect(cover).toContain('var(--sidebar-surface)');
    for (const shadow of shadows) expect(shadow).toContain('var(--sidebar-scroll-shadow)');
  });

  it('paints the covers in the colour the sidebar actually has, in both themes', () => {
    const light = declarations('styles.css', '.sidebar').get('background');
    const dark = declarations('theme.css', "html[data-theme='dark'] .sidebar").get('background');
    expect(declarations('adjudication.css', '.sidebar').get('--sidebar-surface')).toBe(light);
    expect(
      declarations('adjudication.css', "html[data-theme='dark'] .sidebar").get('--sidebar-surface'),
    ).toBe(dark);
  });

  it('drops the shadows in forced colours, where the covers would not match the system colour', () => {
    const forced = declarations(
      'adjudication.css',
      '.sidebar > nav',
      '@media (forced-colors: active)',
    );
    expect(forced.get('background')).toBe('none');
  });

  it('folds the house-rule card into one row below 800px of height, so the links get the room', () => {
    const media = '@media (max-height: 800px)';
    const card = declarations('adjudication.css', '.sidebar .house-rule', media);
    expect(card.get('display')).toBe('flex');
    expect(card.get('align-items')).toBe('center');
    expect(card.get('padding')).toMatch(/^0 /);
    // The heading is clipped to its 20px shield, beside How it works: its words stay for screen
    // readers and keep their size (chrome text is never under 12px), and it is never removed.
    const heading = declarations('adjudication.css', '.sidebar .house-rule > span', media);
    expect(heading.get('width')).toBe('20px');
    expect(heading.get('overflow')).toBe('hidden');
    expect(heading.has('font-size')).toBe(false);
    expect(heading.get('display')).toBeUndefined();
    // Unbreakable words would otherwise squeeze the shield out of the 20px.
    const shield = declarations('adjudication.css', '.sidebar .house-rule > span > svg', media);
    expect(shield.get('flex-shrink')).toBe('0');
    // How it works keeps its 44px target from readability.css.
    expect(declarations('readability.css', '.house-rule button').get('min-height')).toBe('44px');
  });

  it('folds Invite a member into that row below 720px, still reading "Invite", so all ten links fit down to about 660px', () => {
    const media = '@media (max-height: 720px)';
    // How it works and Invite share one row, the profile under them.
    const footer = declarations('adjudication.css', '.sidebar > .sidebar-bottom', media);
    expect(footer.get('display')).toBe('grid');
    expect(footer.get('grid-template-columns')).toMatch(/ auto$/);
    expect(
      declarations('adjudication.css', '.sidebar > .sidebar-bottom > .sidebar-profile', media).get(
        'grid-column',
      ),
    ).toBe('1 / -1');
    // Touch has no hover to show a tooltip, so the button keeps its first word on screen: it is
    // not squeezed to its icons, and nothing clips what is left of it.
    const invite = declarations('adjudication.css', '.sidebar .invite-sidebar', media);
    expect(invite.get('width')).toBe('auto');
    expect(invite.get('overflow')).toBeUndefined();
    expect(invite.has('font-size')).toBe(false);
    expect(invite.get('display')).toBeUndefined();
    expect(
      declarations('adjudication.css', '.sidebar .invite-sidebar > svg:last-child', media).get(
        'display',
      ),
    ).toBe('none');
    expect(declarations('readability.css', '.invite-sidebar').get('min-height')).toBe('44px');
    // The rest of its name ("a member") and the house rule's heading stay for screen readers, at
    // their usual size, and are never removed.
    for (const selector of [
      '.sidebar .invite-sidebar .invite-rest',
      '.sidebar .house-rule > span',
    ]) {
      const hidden = declarations('adjudication.css', selector, media);
      expect(hidden.get('position'), selector).toBe('absolute');
      expect(hidden.get('width'), selector).toBe('1px');
      expect(hidden.get('clip'), selector).toBe('rect(0, 0, 0, 0)');
      expect(hidden.get('display'), selector).toBeUndefined();
      expect(hidden.has('font-size'), selector).toBe(false);
    }
    // How it works keeps to one line beside it.
    const card = declarations('adjudication.css', '.sidebar .house-rule', media);
    expect(card.get('padding')).toMatch(/^0 /);
    expect(
      declarations('adjudication.css', '.sidebar .house-rule button > svg', media).get('display'),
    ).toBe('none');
  });

  it('keeps the workspace card for screen readers only below 720px, never removed', () => {
    // Below 880px it shows only the group's name, which repeats the brand unless the group has its own.
    const card = declarations(
      'adjudication.css',
      '.sidebar > .workspace-switch',
      '@media (max-height: 720px)',
    );
    expect(card.get('position')).toBe('absolute');
    expect(card.get('width')).toBe('1px');
    expect(card.get('height')).toBe('1px');
    expect(card.get('overflow')).toBe('hidden');
    expect(card.get('clip')).toBe('rect(0, 0, 0, 0)');
    expect(card.get('display')).toBeUndefined();
  });
});
