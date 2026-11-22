// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useLedger } from './lib/useLedger';
import { createDemoState } from './lib/demo';
import { RULES } from './lib/rules-copy';

vi.mock('./lib/useLedger', () => ({ useLedger: vi.fn() }));
vi.mock('./components/cli-api', () => ({ cliApi: vi.fn().mockResolvedValue({ sessions: [] }) }));
// Leaflet needs layout APIs that jsdom lacks; these tests are about copy, not maps.
vi.mock('./components/MapView', () => ({ MapView: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
  window.scrollTo = vi.fn();
  window.history.replaceState(null, '', '/#overview');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const state = createDemoState();
  vi.mocked(useLedger).mockReturnValue({
    state,
    member: state.members[0],
    memberId: state.members[0].id,
    demo: false,
    loading: false,
    configured: true,
    error: '',
    storageWarning: '',
  } as unknown as ReturnType<typeof useLedger>);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const button = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );

describe('house rules copy', () => {
  it('explains declining and withdrawing, and never contradicts the offset rule', async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => button('How it works')!.click());
    await settle();
    const help = document.querySelector('[role="dialog"][data-state="open"]')!;
    expect(help.textContent).not.toContain('offset against another debt');
    expect(help.textContent).toContain('declines with a note');
    expect(help.textContent).toContain('withdraw');
    // Amending is the third way out of terms that no longer fit, short of calling the bet off.
    expect(help.textContent).toContain(
      'While the bet is in play, either bettor can propose changes to the terms, timing or who decides; nothing changes until the other agrees.',
    );
    expect(help.textContent).toContain(RULES.offsets);
    // The steps are a real ordered list, and stay one in Safari, which drops the role of an
    // unstyled list.
    expect(help.querySelectorAll('ol > li')).toHaveLength(RULES.steps.length);
    expect(help.querySelector('ol')?.getAttribute('role')).toBe('list');
    for (const step of RULES.steps) expect(help.textContent).toContain(step.title);
  });

  it('uses the same offset rule on Balances', async () => {
    window.history.replaceState(null, '', '/#balances');
    await act(async () => root.render(createElement(App)));
    await settle();
    expect(document.querySelector('.balance-disclaimer')?.textContent?.trim()).toBe(RULES.offsets);
  });
});
