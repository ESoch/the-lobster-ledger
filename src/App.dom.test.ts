// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import App from './App';
import { useLedger } from './lib/useLedger';
import { createDemoState } from './lib/demo';
import type { PriceReportInput } from './lib/types';
import { cliApi } from './components/cli-api';
import { api, ApiError } from './lib/client';

vi.mock('./lib/useLedger', () => ({ useLedger: vi.fn() }));
vi.mock('./components/cli-api', () => ({ cliApi: vi.fn() }));
// Leaflet needs layout APIs that jsdom lacks; these tests are about focus and routing, not maps.
vi.mock('./components/MapView', () => ({ MapView: () => null }));

let root: Root;
let container: HTMLDivElement;
const signedOut = {
  state: null,
  member: undefined,
  memberId: '',
  demo: false,
  loading: false,
  configStatus: 'ready',
  configured: true,
  loadFailed: false,
  sessionEnded: false,
  retry: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  error: '',
  storageWarning: '',
  dismissStorageWarning: vi.fn(),
} as unknown as ReturnType<typeof useLedger>;

function signedIn() {
  const state = createDemoState();
  return { ...signedOut, state, memberId: state.members[0].id, member: state.members[0] };
}

// A controllable (max-width:760px) query so tests can start on a phone and then widen the window.
function stubViewport(mobile: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: mobile,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(query));
  return {
    widen: () => {
      query.matches = false;
      listeners.forEach((listener) => listener());
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubViewport(false);
  window.scrollTo = vi.fn();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/#overview');
  document.title = 'The Lobster Ledger — Friendly wagers. Properly kept.';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(useLedger).mockReturnValue(signedIn());
  vi.mocked(cliApi).mockResolvedValue({ sessions: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
async function render() {
  await act(async () => root.render(createElement(App)));
}
// What the browser does when a raw #hash link is followed or the Back button is pressed.
async function followHash(hash: string) {
  window.history.replaceState(null, '', hash);
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
const navLink = (hash: string) =>
  container.querySelector<HTMLAnchorElement>(`nav a[href="${hash}"]`)!;
const heading = () => document.querySelector('main h1');
const button = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const dialog = () => document.querySelector('[role="dialog"][data-state="open"]');
async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

describe('route changes', () => {
  it('names the page in the title and marks the current link, without moving focus on first load', async () => {
    await render();
    expect(document.title).toBe('Overview · The Lobster Ledger');
    expect(navLink('#overview').getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(document.body);
  });

  it('announces Members: aria-current, document title and focus on the page heading', async () => {
    await render();
    await act(async () => navLink('#members').click());
    expect(navLink('#members').getAttribute('aria-current')).toBe('page');
    expect(navLink('#overview').getAttribute('aria-current')).toBeNull();
    expect(document.title).toBe('Members · The Lobster Ledger');
    expect(heading()?.textContent).toBe('The people at the table.');
    expect(document.activeElement).toBe(heading());
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('marks the Activity inbox link as the current page', async () => {
    await render();
    await act(async () => navLink('#inbox').click());
    expect(navLink('#inbox').getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Activity inbox · The Lobster Ledger');
  });

  it('treats a raw hash link like navigation: title, focus and scroll reset', async () => {
    await render();
    vi.mocked(window.scrollTo).mockClear();
    await followHash('#leaderboard');
    expect(document.title).toBe('Leaderboard · The Lobster Ledger');
    expect(navLink('#leaderboard').getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(heading());
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('keeps focus in the search box, and the reader on the page, while typing there', async () => {
    await render();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Find a bet"]')!;
    search.focus();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(search, 'lob');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.title).toBe('Overview · The Lobster Ledger');
    expect(document.activeElement).toBe(search);
  });

  it('announces the ledger, with focus on its heading, when Enter sends the search there', async () => {
    await render();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Find a bet"]')!;
    search.focus();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(search, 'lob');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(document.title).toBe('The ledger · The Lobster Ledger');
    expect(document.activeElement).toBe(heading());
  });

  it('titles the public pages and moves focus to their heading', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.title).toBe('Welcome · The Lobster Ledger');
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="#cli"]')!.click());
    expect(document.title).toBe('Command line · The Lobster Ledger');
    expect(document.activeElement).toBe(heading());
    await followHash('#mcp');
    expect(document.title).toBe('AI connections · The Lobster Ledger');
  });
});

describe('Roll prices and Lobster prices', () => {
  const pressed = (label: string) =>
    [...document.querySelectorAll('[aria-label="Places views"] button')]
      .find((tab) => tab.textContent?.includes(label))
      ?.getAttribute('aria-pressed');

  it('opens Places on its Roll prices tab from #places/prices', async () => {
    window.history.replaceState(null, '', '/#places/prices');
    await render();
    expect(document.title).toBe('Places · The Lobster Ledger');
    expect(navLink('#places').getAttribute('aria-current')).toBe('page');
    expect(pressed('Roll prices')).toBe('true');
  });

  it('takes the Restaurant roll prices link to the Roll prices tab, at the top of the page', async () => {
    window.history.replaceState(null, '', '/#lobster-prices');
    await render();
    vi.mocked(window.scrollTo).mockClear();
    const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
      (anchor) => anchor.textContent?.trim() === 'Restaurant roll prices',
    )!;
    expect(link.getAttribute('href')).toBe('#places/prices');
    await act(async () => link.click());
    expect(window.location.hash).toBe('#places/prices');
    expect(document.title).toBe('Places · The Lobster Ledger');
    expect(pressed('Roll prices')).toBe('true');
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(document.activeElement).toBe(heading());
  });

  it('confirms a Lobster prices CSV export with a toast, as the ledger exports do', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
    );
    window.history.replaceState(null, '', '/#lobster-prices');
    await render();
    await act(async () => button('Export CSV')!.click());
    expect(document.querySelector('.toast')?.textContent).toMatch(
      /^Downloaded lobster-prices-\d{4}-\d{4}\.csv with 25 years of prices\./,
    );
  });

  it('counts the workspace members in the singular when there is one', async () => {
    const ledger = signedIn();
    vi.mocked(useLedger).mockReturnValue({
      ...ledger,
      state: { ...ledger.state, members: ledger.state.members.slice(0, 1) },
    });
    await render();
    expect(container.querySelector('.workspace-switch small')?.textContent).toMatch(/^1 member ·/);
  });
});

describe('bet sheet and route changes', () => {
  it('closes the open bet sheet when the history entry changes', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open bet:"]')!;
    await act(async () => row.click());
    expect(dialog()).not.toBeNull();
    await followHash('#balances');
    await settle();
    expect(dialog()).toBeNull();
    expect(document.title).toBe('Balances · The Lobster Ledger');
  });

  it('keeps a bet opened from a CLI link open when its own hash change arrives', async () => {
    const ledger = signedIn();
    const bet = ledger.state.bets[0];
    vi.mocked(useLedger).mockReturnValue(ledger);
    window.history.replaceState(null, '', `/?bet=${encodeURIComponent(bet.id)}`);
    await render();
    expect(dialog()?.textContent).toContain(bet.title);
    // The browser queues this event after the link handler sets location.hash to #ledger.
    await followHash('#ledger');
    await settle();
    expect(dialog()?.textContent).toContain(bet.title);
  });

  it('returns focus to the bet row that opened the sheet', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open bet:"]')!;
    row.focus();
    await act(async () => row.click());
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('returns focus to the row’s button when the sheet was opened from another cell of the row', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open bet:"]')!;
    // A click on the Status cell, which holds no control of its own: the row opens the sheet.
    const status = row.closest('tr')!.querySelector<HTMLElement>('.status-badge')!;
    await act(async () => status.click());
    await settle();
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(row));
  });
});

describe('dialogs opened from the page', () => {
  it('returns focus to the New bet button after Escape and after Close', async () => {
    await render();
    const opener = button('New bet')!;
    opener.focus();
    await act(async () => opener.click());
    await settle();
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    await act(async () => opener.click());
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click(),
    );
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to Export on the ledger page', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    const opener = button('Export')!;
    opener.focus();
    await act(async () => opener.click());
    await settle();
    expect(dialog()?.textContent).toContain('Your ledger, to keep.');
    await pressEscape();
    expect(document.activeElement).toBe(opener);
  });

  it('says what each export file holds and downloads the prices as their own CSV', async () => {
    window.history.replaceState(null, '', '/#ledger');
    const created = vi.fn(() => 'blob:prices');
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    onTestFinished(() => click.mockRestore());
    await render();
    await act(async () => button('Export')!.click());
    await settle();
    const text = dialog()?.textContent ?? '';
    expect(text).not.toContain('Download every bet, or preserve');
    expect(text).toContain('Bets (.csv)');
    expect(text).toContain('Price reports (.csv)');
    expect(text).toContain('Complete audit archive (.json)');
    expect(text).toMatch(/every bet and price report/i);
    const prices = [...document.querySelectorAll('.export-options button')].find((item) =>
      item.textContent?.includes('Price reports (.csv)'),
    ) as HTMLButtonElement;
    await act(async () => prices.click());
    await settle();
    expect(created).toHaveBeenCalledTimes(1);
    const blob = (created.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toContain('text/csv');
    expect(await blob.text()).toContain('"Restaurant"');
    expect(document.body.textContent).toMatch(
      /Downloaded lobster-ledger-prices-.*\.csv with \d+ price reports?\./,
    );
  });

  it('says the JSON archive toast holds the bets and the price reports', async () => {
    window.history.replaceState(null, '', '/#ledger');
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:archive');
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    onTestFinished(() => click.mockRestore());
    await render();
    await act(async () => button('Export')!.click());
    await settle();
    const archive = [...document.querySelectorAll('.export-options button')].find((item) =>
      item.textContent?.includes('Complete audit archive (.json)'),
    ) as HTMLButtonElement;
    await act(async () => archive.click());
    await settle();
    expect(document.body.textContent).toMatch(
      /Downloaded lobster-ledger-audit-.*\.json with \d+ bets? and \d+ price reports?\./,
    );
  });
});

describe('dialogs that navigate away', () => {
  it('puts focus on the new page heading, not How it works, after Get the command-line app', async () => {
    await render();
    const opener = button('How it works')!;
    opener.focus();
    await act(async () => opener.click());
    await settle();
    expect(dialog()?.textContent).toContain('A proper record of a friendly bet.');
    await act(async () => button('Get the command-line app')!.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#cli');
    expect(document.title).toBe('Command line · The Lobster Ledger');
    expect(heading()?.textContent).toContain('command line');
    expect(document.activeElement).toBe(heading());
  });
});

describe('skip link', () => {
  it('is the first thing Tab reaches and moves focus to the main content', async () => {
    await render();
    const first = document.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(first?.classList.contains('skip-link')).toBe(true);
    expect(first?.textContent).toBe('Skip to content');
    await act(async () => first!.click());
    const main = document.querySelector('main')!;
    expect(main.id).toBe('main');
    expect(document.activeElement).toBe(main);
  });
});

describe('mobile navigation drawer', () => {
  const drawer = () => container.querySelector('.sidebar')!;
  const open = () => drawer().classList.contains('sidebar-open');

  it('closes when Invite a member opens its dialog', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    expect(open()).toBe(true);
    await act(async () => button('Invite a member')!.click());
    await settle();
    expect(open()).toBe(false);
    expect(dialog()?.textContent).toContain('Create a single-use invitation');
  });

  it('closes when How it works opens its dialog', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    await act(async () => button('How it works')!.click());
    await settle();
    expect(open()).toBe(false);
    expect(dialog()?.textContent).toContain('A proper record of a friendly bet.');
  });

  it('closes when the window is widened past the phone breakpoint', async () => {
    const viewport = stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    expect(open()).toBe(true);
    await act(async () => viewport.widen());
    expect(open()).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('puts focus on the page heading when the window is widened with the drawer open', async () => {
    const viewport = stubViewport(true);
    await render();
    const menu = byLabel('Open navigation');
    menu.focus();
    await act(async () => menu.click());
    expect(open()).toBe(true);
    await act(async () => viewport.widen());
    // The menu button is hidden on a wide window, so it is no place to leave the reader.
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ['Invite a member', 'Create a single-use invitation'],
    ['How it works', 'A proper record of a friendly bet.'],
  ])('returns focus to Open navigation when %s closes', async (label, text) => {
    stubViewport(true);
    await render();
    const menu = byLabel('Open navigation');
    menu.focus();
    await act(async () => menu.click());
    const launcher = button(label)!;
    launcher.focus();
    await act(async () => launcher.click());
    await settle();
    expect(open()).toBe(false);
    expect(dialog()?.textContent).toContain(text);
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('closes on Escape, but leaves Escape to a dialog that is open over it', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('data-state', 'open');
    document.body.appendChild(other);
    await pressEscape();
    expect(open()).toBe(true);
    other.remove();
    await pressEscape();
    expect(open()).toBe(false);
  });

  it('puts focus on the new page heading, not the menu button, after choosing a link', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    await act(async () => navLink('#balances').click());
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(heading());
  });
});

describe('landmarks', () => {
  const asides = () => [...document.querySelectorAll('aside')];
  const asideNames = () => asides().map((aside) => aside.getAttribute('aria-label'));

  it('names the sidebar and the Over to you panel so the two complementary landmarks differ', async () => {
    await render();
    expect(asideNames()).toEqual(['Workspace', 'Over to you']);
  });

  it('names the Places panel on both tabs', async () => {
    window.history.replaceState(null, '', '/#places');
    await render();
    expect(asideNames()).toEqual(['Workspace', 'Places on the record']);
    await act(async () => button('Roll prices')!.click());
    expect(asideNames()).toEqual(['Workspace', 'Restaurant prices']);
  });

  it('keeps every complementary landmark named and unique on the other pages', async () => {
    await render();
    for (const hash of ['#ledger', '#balances', '#leaderboard', '#members', '#inbox']) {
      await followHash(hash);
      const names = asideNames();
      expect(names.every(Boolean), hash).toBe(true);
      expect(new Set(names).size, hash).toBe(names.length);
    }
  });

  it('puts the demo bar in a named region', async () => {
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    await render();
    const bar = document.querySelector('.demo-bar')!;
    expect(bar.tagName).toBe('SECTION');
    expect(bar.getAttribute('aria-label')).toBe('Demo mode');
  });

  it('has no demo bar outside demo mode', async () => {
    await render();
    expect(document.querySelector('.demo-bar')).toBeNull();
  });
});

describe('navigation drawer semantics', () => {
  const sidebar = () => container.querySelector('.sidebar')!;
  const scrim = () => container.querySelector<HTMLElement>('.mobile-nav-backdrop');

  it('is a complementary landmark on a desktop window, not a dialog', async () => {
    await render();
    expect(sidebar().tagName).toBe('ASIDE');
    expect(sidebar().getAttribute('role')).toBeNull();
    expect(sidebar().getAttribute('aria-modal')).toBeNull();
    expect(scrim()).toBeNull();
  });

  it('is a modal dialog, not a complementary landmark, on a phone', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    expect(sidebar().tagName).toBe('DIV');
    expect(sidebar().getAttribute('role')).toBe('dialog');
    expect(sidebar().getAttribute('aria-modal')).toBe('true');
    expect(sidebar().getAttribute('aria-label')).toBe('Workspace navigation');
    expect(container.querySelector('aside.sidebar')).toBeNull();
  });

  it('offers one Close navigation control; the scrim is not a second one', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    const closers = container.querySelectorAll('[aria-label="Close navigation"]');
    expect(closers).toHaveLength(1);
    expect(closers[0]).toBe(sidebar().querySelector('.mobile-close'));
  });

  it('keeps the scrim out of the tab order and the accessibility tree, but it still dismisses', async () => {
    stubViewport(true);
    await render();
    await act(async () => byLabel('Open navigation').click());
    const backdrop = scrim()!;
    expect(backdrop.matches('button, a[href], [tabindex]')).toBe(false);
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar().classList.contains('sidebar-open')).toBe(true);
    await act(async () => backdrop.click());
    expect(sidebar().classList.contains('sidebar-open')).toBe(false);
    expect(scrim()).toBeNull();
  });

  it('turns back into a landmark when the window is widened', async () => {
    const viewport = stubViewport(true);
    await render();
    expect(sidebar().tagName).toBe('DIV');
    await act(async () => viewport.widen());
    expect(sidebar().tagName).toBe('ASIDE');
    expect(sidebar().getAttribute('role')).toBeNull();
    expect(sidebar().getAttribute('aria-label')).toBe('Workspace');
  });
});

describe('toasts', () => {
  // What a screen reader can reach: not inside an aria-hidden or inert ancestor.
  const hiddenFromAT = (element: Element) => !!element.closest('[aria-hidden="true"], [inert]');
  const liveRegion = (role: 'status' | 'alert', text: string) =>
    [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
      (region) => !hiddenFromAT(region) && region.textContent?.includes(text),
    );
  const dismissButton = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]');
  const openBet = async (title: string) => {
    const row = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Open bet: ${title}"]`,
    )!;
    await act(async () => row.click());
    await settle();
  };
  const agreeToBet = async () => {
    await act(async () => button('Agree to bet')!.click());
    await settle();
  };
  const ledgerWithAct = () => {
    const ledger = { ...signedIn(), act: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(useLedger).mockReturnValue(ledger as unknown as ReturnType<typeof useLedger>);
    return ledger;
  };

  it('announces an action toast and keeps its Dismiss button reachable while the bet sheet is open', async () => {
    ledgerWithAct();
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await openBet('The next offsite will be by the ocean');
    await agreeToBet();
    const status = liveRegion('status', 'Terms agreed with Sarah. The bet is on.');
    expect(status, 'the toast text is in an accessible status region').toBeDefined();
    expect(status!.getAttribute('aria-live')).toBe('polite');
    const dismiss = dismissButton()!;
    expect(status!.contains(dismiss)).toBe(true);
    expect(hiddenFromAT(dismiss)).toBe(false);
    // The sheet stays open under it, and using the toast does not close the sheet.
    expect(dialog()).not.toBeNull();
    await act(async () => dismiss.click());
    expect(dismissButton()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it('renders the toast outside the app root so no dialog can hide it', async () => {
    ledgerWithAct();
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await openBet('The next offsite will be by the ocean');
    await agreeToBet();
    const region = document.querySelector('.toast-region')!;
    // The open sheet hides the app root from assistive technology; the toast must not live in it.
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(region.parentElement).toBe(document.body);
    expect(region.closest('[aria-hidden="true"]')).toBeNull();
    expect(container.contains(region)).toBe(false);
    expect(region.querySelector('.toast')?.getAttribute('data-tone')).toBe('success');
  });

  it('says what declining did instead of the generic confirmation line', async () => {
    const ledger = ledgerWithAct();
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await openBet('The next offsite will be by the ocean');
    await act(async () => button('Decline')!.click());
    const note = document.querySelector<HTMLTextAreaElement>('.inline-action-form textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(note, 'Not for me.');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Decline proposal')!.click());
    await settle();
    expect(ledger.act).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The next offsite will be by the ocean' }),
      expect.objectContaining({ type: 'decline' }),
    );
    const status = liveRegion('status', 'You declined Sarah’s proposal.');
    expect(status).toBeDefined();
    expect(status!.textContent).not.toContain('confirmation');
  });

  it('shows a not-found bet link as an error: data-tone=error inside a role=alert region', async () => {
    window.history.replaceState(null, '', '/?bet=no-such-bet');
    await render();
    const alert = liveRegion('alert', 'That bet could not be found in your ledger.');
    expect(alert, 'an accessible alert region holds the message').toBeDefined();
    expect(alert!.querySelector('.toast')?.getAttribute('data-tone')).toBe('error');
    expect(alert!.querySelector('.toast svg')).not.toBeNull();
    // Nothing success-shaped is announced alongside it.
    expect(liveRegion('status', 'could not be found')).toBeUndefined();
  });

  describe('after a bet is created or a price is saved', () => {
    type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    // Fills a field the way typing or choosing would, so controlled selects see the change.
    const fill = (field: Field, value: string) =>
      act(async () => {
        const proto =
          field instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : field instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
        field.dispatchEvent(
          new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
        );
      });
    const named = (name: string) => document.querySelector(`form [name="${name}"]`) as Field;
    // tsc 7's DOM typings reject a select as a querySelector<T> argument or a direct assertion.
    const requiredSelect = () =>
      document.querySelector('[role="dialog"] select[required]') as unknown as HTMLSelectElement;
    const submitForm = async () => {
      const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle();
    };
    const ledgerWithWrites = () => {
      const ledger = {
        ...signedIn(),
        addBet: vi.fn().mockResolvedValue({ id: 'created-bet' }),
        // Answers as the ledger does: the report, and the restaurant it went to (new or chosen).
        addPriceObservation: vi.fn(async (input: PriceReportInput) => {
          const restaurant = input.restaurant
            ? { id: 'new-restaurant', ...input.restaurant }
            : ledger.state.restaurants!.find((item) => item.id === input.restaurantId)!;
          return { observation: { ...input, restaurantId: restaurant.id }, restaurant };
        }),
      };
      vi.mocked(useLedger).mockReturnValue(ledger as unknown as ReturnType<typeof useLedger>);
      return ledger;
    };
    const fillBet = async (opponentId: string) => {
      await fill(named('title'), 'The lobster roll at North Pier is under $30');
      await fill(requiredSelect(), opponentId);
      await fill(named('creatorSide'), 'It is');
      await fill(named('opponentSide'), 'It is not');
      await fill(named('terms'), 'Check the menu on the day we go.');
      // Ready "when evidence is available" needs only a sentence, not a date and time.
      await fill(named('timing.kind'), 'evidence');
      await fill(named('timing.description'), 'The posted menu price.');
    };
    const openPriceDialog = async () => {
      window.history.replaceState(null, '', '/#places');
      await render();
      // The Places views are toggle buttons in a named group, not a tablist.
      const pricesTab = [
        ...document.querySelectorAll<HTMLElement>('[aria-label="Places views"] [aria-pressed]'),
      ].find((tab) => /prices/i.test(tab.textContent ?? ''))!;
      await act(async () => pricesTab.click());
      const logVisit = [
        ...document.querySelectorAll<HTMLButtonElement>('.places-toolbar .button'),
      ].find((button) => /Log a visit/.test(button.textContent ?? ''))!;
      await act(async () => logVisit.click());
      await settle();
    };

    it('names the person a new bet was proposed to and says it is not on yet', async () => {
      const ledger = ledgerWithWrites();
      const sarah = ledger.state.members.find((member) => member.name === 'Sarah')!;
      window.history.replaceState(null, '', '/#ledger');
      await render();
      await act(async () => button('New bet')!.click());
      await fillBet(sarah.id);
      await submitForm();
      expect(ledger.addBet).toHaveBeenCalledWith(expect.objectContaining({ opponentId: sarah.id }));
      const status = liveRegion('status', 'Proposed to Sarah.');
      expect(status, 'the toast names the other bettor').toBeDefined();
      expect(status!.textContent).toContain('The bet is on once they agree.');
      expect(status!.textContent).not.toMatch(/recorded/i);
    });

    it('opens the new bet at its next step, so the wait for the other bettor is in view', async () => {
      const ledger = ledgerWithWrites();
      const sarah = ledger.state.members.find((member) => member.name === 'Sarah')!;
      // The sheet opens on the record the ledger returns: a bet this member proposed.
      const proposed = ledger.state.bets.find(
        (bet) => bet.status === 'pending' && bet.creatorId === ledger.memberId && !bet.history,
      )!;
      ledger.addBet.mockResolvedValue({ id: proposed.id });
      const scrolled = vi.fn();
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled(this);
      };
      try {
        window.history.replaceState(null, '', '/#ledger');
        await render();
        await act(async () => button('New bet')!.click());
        await fillBet(sarah.id);
        await submitForm();
        await settle();
        const step = document.getElementById('bet-next-step')!;
        expect(step.closest('.detail-sheet')).not.toBeNull();
        expect(document.activeElement).toBe(step);
        expect(scrolled).toHaveBeenCalledWith(step);
      } finally {
        Element.prototype.scrollIntoView = scrollIntoView;
      }
    });

    it('opens a bet picked from the ledger at its top, not at the next step', async () => {
      const ledger = ledgerWithWrites();
      const proposed = ledger.state.bets.find(
        (bet) => bet.status === 'pending' && bet.creatorId === ledger.memberId && !bet.history,
      )!;
      window.history.replaceState(null, '', `/?bet=${proposed.id}`);
      await render();
      await settle();
      expect(document.getElementById('bet-next-step')).not.toBeNull();
      expect(document.activeElement).not.toBe(document.getElementById('bet-next-step'));
    });

    it('names the person asked to confirm a past bet and says it has not joined the ledger yet', async () => {
      const ledger = ledgerWithWrites();
      const sarah = ledger.state.members.find((member) => member.name === 'Sarah')!;
      window.history.replaceState(null, '', '/#ledger');
      await render();
      await act(async () => button('Add existing bet')!.click());
      await fillBet(sarah.id);
      // The form checks its own fields now, so the required confirmation must be ticked.
      await act(async () => (named('acknowledgements.terms') as HTMLInputElement).click());
      await submitForm();
      expect(ledger.addBet).toHaveBeenCalledWith(
        expect.objectContaining({ opponentId: sarah.id, history: expect.anything() }),
      );
      const status = liveRegion('status', 'Sarah has been asked to confirm this past bet.');
      expect(status, 'the toast names the other bettor').toBeDefined();
      expect(status!.textContent).toContain('It joins your ledger once they do.');
      expect(status!.textContent).not.toMatch(/recorded/i);
    });

    it('names the restaurant and the amount of a saved price', async () => {
      const ledger = ledgerWithWrites();
      const restaurant = ledger.state.restaurants![0];
      await openPriceDialog();
      await fill(requiredSelect(), restaurant.id);
      await fill(named('price'), '32');
      await submitForm();
      expect(ledger.addPriceObservation).toHaveBeenCalledWith(
        expect.objectContaining({ restaurantId: restaurant.id, priceCents: 3200 }),
      );
      expect(liveRegion('status', `Saved $32.00 at ${restaurant.name}.`)).toBeDefined();
    });

    it('names a restaurant that was added in the same step', async () => {
      const ledger = ledgerWithWrites();
      await openPriceDialog();
      await act(async () => button('Add a restaurant')!.click());
      await fill(named('restaurantName'), 'North Pier Café');
      await fill(named('price'), '32');
      await submitForm();
      // One write for the restaurant and its first price.
      expect(ledger.addPriceObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurant: expect.objectContaining({ name: 'North Pier Café' }),
          priceCents: 3200,
        }),
      );
      expect(liveRegion('status', 'Saved $32.00 at North Pier Café.')).toBeDefined();
    });
  });

  describe('timing', () => {
    beforeEach(() => {
      // Dates move with the clock so a paused toast keeps the time it has left.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
    const flush = () => act(async () => void (await Promise.resolve()));
    const visible = () => document.querySelector('.toast') !== null;

    it('restarts the timer when the same message is shown again', async () => {
      ledgerWithAct();
      window.history.replaceState(null, '', '/#ledger');
      await render();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Open bet: The next offsite will be by the ocean"]',
          )!
          .click(),
      );
      await flush();
      await act(async () => button('Agree to bet')!.click());
      await flush();
      expect(visible()).toBe(true);
      await tick(3000);
      await act(async () => button('Agree to bet')!.click());
      await flush();
      // 7s after the first call, 4s after the second: the first call's timer is long gone.
      await tick(4000);
      expect(visible()).toBe(true);
      await tick(2100);
      expect(visible()).toBe(false);
    });

    it('stays up while the pointer is over it, then gets its remaining time back', async () => {
      window.history.replaceState(null, '', '/?bet=no-such-bet');
      await render();
      const toast = () => document.querySelector<HTMLElement>('.toast')!;
      await tick(4000);
      await act(async () => {
        toast().dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
        );
      });
      await tick(30_000);
      expect(visible()).toBe(true);
      await act(async () => {
        toast().dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
        );
      });
      await tick(1900);
      expect(visible()).toBe(true);
      await tick(300);
      expect(visible()).toBe(false);
    });

    it('stays up while keyboard focus is inside it', async () => {
      window.history.replaceState(null, '', '/?bet=no-such-bet');
      await render();
      await act(async () => dismissButton()!.focus());
      await tick(30_000);
      expect(visible()).toBe(true);
      await act(async () => dismissButton()!.blur());
      await tick(6100);
      expect(visible()).toBe(false);
    });

    it('keeps even a short message up for at least six seconds', async () => {
      window.history.replaceState(null, '', '/?bet=no-such-bet');
      await render();
      // The not-found line is short, so the six-second minimum applies.
      await tick(5900);
      expect(visible()).toBe(true);
      await tick(200);
      expect(visible()).toBe(false);
    });
  });
});

describe('the signed-out welcome', () => {
  const googleLink = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      /Continue with Google/.test(link.textContent ?? ''),
    )!;
  const noticeText = () =>
    [...document.querySelectorAll('.connection-notice')].map((notice) => notice.textContent);

  it('says nothing about the connection on an ordinary signed-out visit', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.connection-notice')).toBeNull();
    // The 401 that says "not signed in yet" is the normal state, not something to print.
    expect(document.querySelector('.welcome-screen')?.textContent).not.toMatch(
      /Sign in to your private ledger|Unable to complete/,
    );
    expect(googleLink().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('shows one notice with Try again when the config request failed, and keeps Google enabled', async () => {
    const retry = vi.fn();
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configStatus: 'unreachable',
      loadFailed: true,
      retry,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    expect(noticeText()).toHaveLength(1);
    expect(noticeText()[0]).toMatch(/can.t reach the ledger/i);
    expect(document.querySelector('.connection-notice')?.getAttribute('data-tone')).toBe('warning');
    // It does not blame the sign-in setup for a request that never got an answer.
    expect(document.body.textContent).not.toMatch(/not connected|needs its Google sign-in/i);
    expect(googleLink().getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => button('Try again')!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows the same single notice when only the session request failed', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      loadFailed: true,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    expect(noticeText()).toHaveLength(1);
    expect(button('Try again')).toBeDefined();
    expect(googleLink().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('tells an administrator that sign-in is not connected, and disables Google, only when it is not', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configStatus: 'unconfigured',
      configured: false,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    expect(noticeText()).toHaveLength(1);
    expect(noticeText()[0]).toContain('needs its Google sign-in connected');
    expect(document.querySelector('.connection-notice')?.getAttribute('data-tone')).toBe('info');
    expect(button('Try again')).toBeUndefined();
    expect(googleLink().getAttribute('aria-disabled')).toBe('true');
  });

  it('names the Google button exactly "Continue with Google"', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    // What a screen reader reads: the text, less anything hidden from it and the icons.
    const clone = googleLink().cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"], svg').forEach((node) => node.remove());
    expect(clone.textContent?.replace(/\s+/g, ' ').trim()).toBe('Continue with Google');
  });

  it('puts the two guide links in one wrapper so the layout can space them', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    const links = document.querySelector('.welcome-links')!;
    expect(links).not.toBeNull();
    expect([...links.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '#cli',
      '#mcp',
    ]);
  });

  it('tells a visitor with a waiting bet link that signing in opens it', async () => {
    window.history.replaceState(null, '', '/?bet=LL-1042');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.welcome-screen')?.textContent).toContain(
      'Sign in to open the bet you were sent',
    );
    // The link left the address bar but is still waiting for after sign-in.
    expect(window.location.search).toBe('');
    expect(window.sessionStorage.getItem('lobster-ledger-bet-link')).toContain('LL-1042');
  });

  it('shows no such line when there is no link waiting', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.body.textContent).not.toContain('Sign in to open the bet you were sent');
  });
});

describe('a signed-in member whose ledger will not load', () => {
  const unavailable = (retry = vi.fn()) => {
    const member = createDemoState().members[0];
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      member,
      memberId: member.id,
      loadFailed: true,
      retry,
    } as unknown as ReturnType<typeof useLedger>);
    return { member, retry };
  };

  it('is told the ledger cannot be reached, with Try again, and is not sent to sign in', async () => {
    const { member, retry } = unavailable();
    await render();
    const main = document.querySelector('main')!;
    expect(main.querySelector('h1')?.textContent).toMatch(/can.t reach the ledger/i);
    expect(main.textContent).toContain(member.name);
    expect(document.body.textContent).not.toContain('Continue with Google');
    expect(document.body.textContent).not.toMatch(/Unable to complete the request|Failed to fetch/);
    await act(async () => button('Try again')!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('puts focus on the heading again once Try again has finished, because the opening screen took it', async () => {
    const member = createDemoState().members[0];
    let loading = false;
    const retry = vi.fn(() => {
      loading = true;
    });
    const current = () =>
      ({
        ...signedOut,
        member,
        memberId: member.id,
        loadFailed: true,
        loading,
        retry,
      }) as unknown as ReturnType<typeof useLedger>;
    vi.mocked(useLedger).mockImplementation(current);
    await render();
    const again = button('Try again')!;
    again.focus();
    await act(async () => again.click());
    await render();
    expect(document.querySelector('.loading-screen')).not.toBeNull();
    loading = false;
    await render();
    expect(document.querySelector('main h1')?.textContent).toMatch(/can.t reach the ledger/i);
    expect(document.activeElement).toBe(document.querySelector('main h1'));
  });

  it('does not move focus when the first load fails', async () => {
    const member = createDemoState().members[0];
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      member,
      memberId: member.id,
      loadFailed: true,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    expect(document.activeElement).toBe(document.body);
  });

  it('titles the page for what it is, not "Welcome"', async () => {
    unavailable();
    await render();
    expect(document.title).toMatch(/reach the ledger/i);
  });

  it('keeps the public guides reachable and still offers Try again there', async () => {
    unavailable();
    window.history.replaceState(null, '', '/#cli');
    await render();
    expect(document.querySelector('h1')?.textContent).toContain('command line');
    expect(button('Try again')).toBeDefined();
  });
});

describe('public guides while the sign-in check runs', () => {
  it.each(['#mcp', '#cli'])(
    'shows no "checking" or "not configured" notice on %s, so nothing flashes or jumps',
    async (hash) => {
      vi.mocked(useLedger).mockReturnValue({
        ...signedOut,
        loading: true,
        configStatus: 'loading',
      } as unknown as ReturnType<typeof useLedger>);
      window.history.replaceState(null, '', `/${hash}`);
      await render();
      // The MCP guide's own local-preview line is a different notice and may stay.
      expect(document.body.textContent).not.toMatch(
        /not configured|not connected|turn on Google sign-in|Checking your sign-in/,
      );
      expect(document.querySelector('.connection-notice[data-tone]')).toBeNull();
    },
  );

  it('leaves the sign-in buttons usable while the check runs', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      loading: true,
      configStatus: 'loading',
    } as unknown as ReturnType<typeof useLedger>);
    window.history.replaceState(null, '', '/#cli');
    await render();
    const signIn = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
      /Sign in/.test(item.textContent ?? ''),
    );
    expect(signIn.length).toBeGreaterThan(0);
    expect(signIn.every((item) => !item.disabled)).toBe(true);
  });

  it('shows the not-connected notice only once the server has said so', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configStatus: 'unconfigured',
      configured: false,
    } as unknown as ReturnType<typeof useLedger>);
    window.history.replaceState(null, '', '/#cli');
    await render();
    expect(document.body.textContent).toMatch(/turn on Google sign-in/);
  });

  it.each(['#mcp', '#cli'])(
    'says once, not twice, that sign-in is not connected on %s',
    async (hash) => {
      vi.mocked(useLedger).mockReturnValue({
        ...signedOut,
        configStatus: 'unconfigured',
        configured: false,
      } as unknown as ReturnType<typeof useLedger>);
      window.history.replaceState(null, '', `/${hash}`);
      await render();
      const saying = [...document.querySelectorAll('.connection-notice')].filter((notice) =>
        /turn on Google sign-in|sign-in is not (connected|configured)/i.test(
          notice.textContent ?? '',
        ),
      );
      expect(saying).toHaveLength(1);
    },
  );

  it('puts one Try again notice on a guide when the config request failed', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configStatus: 'unreachable',
      loadFailed: true,
    } as unknown as ReturnType<typeof useLedger>);
    window.history.replaceState(null, '', '/#mcp');
    await render();
    expect(button('Try again')).toBeDefined();
    expect(document.body.textContent).not.toMatch(
      /not configured|not connected|turn on Google sign-in/,
    );
  });
});

describe('bet links', () => {
  const STORAGE_KEY = 'lobster-ledger-bet-link';

  it('opens the sheet once, then takes ?bet= out of the address bar and forgets the link', async () => {
    const ledger = signedIn();
    const bet = ledger.state.bets[0];
    vi.mocked(useLedger).mockReturnValue(ledger);
    window.history.replaceState(null, '', `/?bet=${encodeURIComponent(bet.id)}`);
    await render();
    expect(dialog()?.textContent).toContain(bet.title);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#ledger');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    // A reload now lands on the ledger without the sheet.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(dialog()).toBeNull();
  });

  it('opens the bet named by its LL-#### reference', async () => {
    const ledger = signedIn();
    const bet = ledger.state.bets.find((item) => item.reference === 'LL-1042')!;
    vi.mocked(useLedger).mockReturnValue(ledger);
    window.history.replaceState(null, '', '/?bet=LL-1042');
    await render();
    expect(dialog()?.textContent).toContain(bet.title);
  });

  it('opens the sheet for a link the demo built, drops ?bet= and leaves a waiting real link alone', async () => {
    // "Linked bets" and "Offset history" give the demo's own links, so a middle-click or a new tab
    // lands on the same bet in the same demo.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ betId: 'real-bet-id', createdAt: Date.now() }),
    );
    const ledger = { ...signedIn(), demo: true };
    const bet = ledger.state.bets[0];
    vi.mocked(useLedger).mockReturnValue(ledger);
    window.history.replaceState(
      null,
      '',
      `/?demo=1&demoSession=abc&bet=${encodeURIComponent(bet.id)}#ledger`,
    );
    await render();
    await settle();
    expect(dialog()?.textContent).toContain(bet.title);
    expect(window.location.search).toBe('?demo=1&demoSession=abc');
    expect(window.location.hash).toBe('#ledger');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain('real-bet-id');
    // A reload lands on the ledger without the sheet.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await settle();
    expect(dialog()).toBeNull();
  });

  it('says so when a demo link names a bet that this demo does not hold', async () => {
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    window.history.replaceState(null, '', '/?demo=1&bet=no-such-bet#ledger');
    await render();
    await settle();
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain('could not be found');
    expect(window.location.search).toBe('?demo=1');
  });

  it('leaves a waiting link alone while the visitor looks around the demo', async () => {
    window.history.replaceState(null, '', '/?bet=real-bet-id');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain('real-bet-id');
    await act(async () => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, '', '/?demo=1');
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    await render();
    await settle();
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain('could not be found');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain('real-bet-id');
    // Back on the real welcome page the link is still waiting.
    await act(async () => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.welcome-screen')?.textContent).toContain(
      'Sign in to open the bet you were sent',
    );
  });
});

describe('Back with a bet sheet open', () => {
  // jsdom traverses history on a later task, so wait for the popstate itself, not a fixed delay.
  const back = () =>
    act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true }),
      );
      window.history.back();
      await popped;
    });
  const openFirstBet = async () => {
    const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open bet:"]')!;
    await act(async () => row.click());
    await settle();
  };

  it('closes the sheet, stays on the same page and returns focus to the bet row', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open bet:"]')!;
    row.focus();
    await openFirstBet();
    expect(dialog()).not.toBeNull();
    await back();
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#ledger');
    expect(document.title).toBe('The ledger · The Lobster Ledger');
    // Radix hands focus back on a later task once the sheet has unmounted.
    await vi.waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('takes the sheet\u2019s own history entry off again when it is closed with Escape', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await openFirstBet();
    expect(window.history.state?.lobsterLedgerSheet).toBe(true);
    await pressEscape();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(window.history.state?.lobsterLedgerSheet).toBeFalsy());
    expect(window.location.hash).toBe('#ledger');
  });

  it('does not walk back out of the page when a typed #hash had already left the sheet\u2019s entry', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await openFirstBet();
    // A typed address pushes a new entry on top of the sheet's.
    window.history.pushState(null, '', '#balances');
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#balances');
    expect(document.title).toBe('Balances \u00b7 The Lobster Ledger');
  });

  it('goes straight back to where the sheet was opened after a typed #hash left its entry behind', async () => {
    // Two entries below the sheet's: one to tell a Back that goes too far, and the page itself.
    window.history.pushState({ before: true }, '', '/#overview');
    window.history.pushState(null, '', '/#ledger');
    await render();
    await openFirstBet();
    window.history.pushState(null, '', '#balances');
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#balances');
    // One Back press: it lands on the dead sheet entry, which shows nothing new, and steps past it.
    await back();
    await vi.waitFor(() => expect(window.history.state?.lobsterLedgerSheet).toBeFalsy());
    await settle();
    expect(window.history.state?.before).toBeUndefined();
    expect(window.location.hash).toBe('#ledger');
    expect(document.title).toBe('The ledger \u00b7 The Lobster Ledger');
  });

  it('does not skip a sheet entry it has no reason to think is dead', async () => {
    window.history.pushState({ before: true }, '', '/#overview');
    window.history.pushState(null, '', '/#ledger');
    await render();
    await openFirstBet();
    await back();
    expect(dialog()).toBeNull();
    await settle();
    // Back from an open sheet closes it and goes no further.
    expect(window.history.state?.before).toBeUndefined();
    expect(window.location.hash).toBe('#ledger');
  });

  it('opens the sheet again after Back closed it', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await openFirstBet();
    await back();
    await openFirstBet();
    expect(dialog()).not.toBeNull();
    await back();
    expect(dialog()).toBeNull();
  });
});

describe('leaving a bet sheet that holds unsaved input', () => {
  const back = () =>
    act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true }),
      );
      window.history.back();
      await popped;
    });
  const reason = () => document.querySelector<HTMLTextAreaElement>('.inline-action-form textarea')!;
  const question = () => document.querySelector('.modal-discard');
  // A declining reason typed into the open sheet, as a judge's reasoning or a drafted prompt would be.
  async function typeReason(text: string) {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open bet: The next offsite will be by the ocean"]',
        )!
        .click(),
    );
    await settle();
    await act(async () => button('Decline')!.click());
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(reason(), text);
      reason().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  // What Chromium does when an address is typed or a link is followed: a new entry, popstate at
  // once, then hashchange on a later task.
  const typeAddress = (hash: string) =>
    act(async () => {
      window.history.pushState(null, '', hash);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      await Promise.resolve();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

  it('asks before Back discards it, and Keep editing keeps the sheet, the text and its entry', async () => {
    await typeReason('The ocean is too cold in October.');
    await back();
    expect(dialog()).not.toBeNull();
    expect(question()?.textContent).toContain('Discard what you have entered?');
    expect(reason().value).toBe('The ocean is too cold in October.');
    // The sheet keeps its own history entry, so the next Back still closes the sheet, not the page.
    expect(window.history.state?.lobsterLedgerSheet).toBe(true);
    expect(window.location.hash).toBe('#ledger');
    await act(async () => button('Keep editing')!.click());
    expect(question()).toBeNull();
    expect(reason().value).toBe('The ocean is too cold in October.');
    expect(document.activeElement).toBe(reason());
  });

  it('closes the sheet on Discard after Back, leaving no extra history entry behind', async () => {
    await typeReason('The ocean is too cold in October.');
    await back();
    await act(async () => button('Discard')!.click());
    await settle();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(window.history.state?.lobsterLedgerSheet).toBeFalsy());
    expect(window.location.hash).toBe('#ledger');
    expect(document.title).toBe('The ledger · The Lobster Ledger');
  });

  it('still closes a sheet whose form is untouched on the first Back', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Open bet:"]')!.click(),
    );
    await settle();
    await back();
    expect(dialog()).toBeNull();
    expect(question()).toBeNull();
  });

  it('asks before a typed #hash leaves it, and stays on the page the sheet belongs to', async () => {
    await typeReason('The ocean is too cold in October.');
    await typeAddress('#balances');
    expect(dialog()).not.toBeNull();
    expect(question()?.textContent).toContain('Discard what you have entered?');
    expect(reason().value).toBe('The ocean is too cold in October.');
    expect(document.title).toBe('The ledger · The Lobster Ledger');
    // The typed address is taken back, so the bar matches the page behind the sheet.
    expect(window.location.hash).toBe('#ledger');
    expect(window.history.state?.lobsterLedgerSheet).toBe(true);
    await act(async () => button('Keep editing')!.click());
    await settle();
    expect(dialog()).not.toBeNull();
    expect(reason().value).toBe('The ocean is too cold in October.');
    expect(document.title).toBe('The ledger · The Lobster Ledger');
    // Closing the sheet later, by its own Close, stays on its page rather than going on to the
    // address that was taken back.
    await act(async () => byLabel('Close dialog').click());
    await act(async () => button('Discard')!.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#ledger');
    expect(window.history.state?.lobsterLedgerSheet).toBeFalsy();
    expect(document.title).toBe('The ledger · The Lobster Ledger');
  });

  it('leaves no history entry for a typed page the member turned down', async () => {
    // The page before the ledger, so a Back that goes one step too far or too short shows.
    window.history.replaceState({ before: true }, '', '/#overview');
    window.history.pushState(null, '', '/#ledger');
    await typeReason('The ocean is too cold in October.');
    await typeAddress('#balances');
    expect(question()).not.toBeNull();
    await act(async () => button('Keep editing')!.click());
    await act(async () => byLabel('Close dialog').click());
    await act(async () => button('Discard')!.click());
    await settle();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(window.history.state?.lobsterLedgerSheet).toBeFalsy());
    expect(window.location.hash).toBe('#ledger');
    // One Back goes to the page before the ledger, not to the Balances page that was refused.
    await back();
    await vi.waitFor(() => expect(window.location.hash).toBe('#overview'));
    await settle();
    expect(window.history.state?.before).toBe(true);
    expect(heading()?.textContent).not.toContain('lunch');
  });

  it('still reaches the typed page on Discard after the member first refused it', async () => {
    window.history.replaceState({ before: true }, '', '/#overview');
    window.history.pushState(null, '', '/#ledger');
    await typeReason('The ocean is too cold in October.');
    await typeAddress('#balances');
    await act(async () => button('Keep editing')!.click());
    // Asking again: the same address, typed a second time, and this time let go.
    await typeAddress('#balances');
    expect(question()).not.toBeNull();
    await act(async () => button('Discard')!.click());
    await settle();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(window.location.hash).toBe('#balances'));
    await vi.waitFor(() => expect(document.title).toBe('Balances · The Lobster Ledger'));
    // Back returns to the ledger, then the page before it: the refused attempts left nothing behind.
    await back();
    await vi.waitFor(() => expect(window.history.state?.lobsterLedgerSheet).toBeFalsy());
    await settle();
    expect(window.location.hash).toBe('#ledger');
    await back();
    await vi.waitFor(() => expect(window.location.hash).toBe('#overview'));
  });

  it('does not write over an older page when Back jumps past a refused address', async () => {
    window.history.replaceState({ before: true }, '', '/#overview');
    window.history.pushState(null, '', '/#ledger');
    await typeReason('The ocean is too cold in October.');
    await typeAddress('#balances');
    await act(async () => button('Keep editing')!.click());
    // A long-press on Back jumps three entries at once, past the ledger to the page before it.
    await act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true }),
      );
      window.history.go(-3);
      await popped;
    });
    expect(question()).not.toBeNull();
    await act(async () => button('Discard')!.click());
    await vi.waitFor(() => expect(window.location.hash).toBe('#overview'));
    await settle();
    expect(window.history.state?.before).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('stays on the ledger after a refused jump back and then a refused typed address', async () => {
    window.history.replaceState({ before: true }, '', '/#overview');
    window.history.pushState(null, '', '/#ledger');
    await typeReason('The ocean is too cold in October.');
    // A long-press on Back jumps two entries at once, past the ledger to the page before it.
    await act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true }),
      );
      window.history.go(-2);
      await popped;
    });
    expect(question()).not.toBeNull();
    await act(async () => button('Keep editing')!.click());
    // The sheet's entry went back on above that older page. A typed address, turned down too,
    // must not make the sheet forget it: closing still leaves the member where they are.
    await typeAddress('#balances');
    expect(question()).not.toBeNull();
    await act(async () => button('Keep editing')!.click());
    await act(async () => byLabel('Close dialog').click());
    await act(async () => button('Discard')!.click());
    for (let i = 0; i < 5; i++) await settle();
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#ledger');
  });

  it('goes on to the typed page on Discard, and one Back returns to the page after that', async () => {
    await typeReason('The ocean is too cold in October.');
    await typeAddress('#balances');
    await act(async () => button('Discard')!.click());
    await settle();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(window.location.hash).toBe('#balances'));
    await vi.waitFor(() => expect(document.title).toBe('Balances · The Lobster Ledger'));
    // The sheet's old entry under the typed address is stepped past, so one Back reaches the ledger.
    await back();
    await vi.waitFor(() => expect(window.history.state?.lobsterLedgerSheet).toBeFalsy());
    await settle();
    expect(window.location.hash).toBe('#ledger');
    expect(document.title).toBe('The ledger · The Lobster Ledger');
    expect(dialog()).toBeNull();
  });
});

describe('notices about the connection or the browser', () => {
  const FULL = 'Browser storage is full or unavailable. Export your ledger to keep a copy.';
  const notices = () => [...document.querySelectorAll('.workspace .connection-notice')];
  const withLedger = (extra: Record<string, unknown>) =>
    vi.mocked(useLedger).mockReturnValue({
      ...signedIn(),
      ...extra,
    } as unknown as ReturnType<typeof useLedger>);

  it('shows a storage warning with a Dismiss button, and Dismiss hands it back to the ledger', async () => {
    const dismissStorageWarning = vi.fn();
    withLedger({ storageWarning: 'Browser storage is unavailable.', dismissStorageWarning });
    await render();
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toContain('Browser storage is unavailable.');
    expect(notices()[0].getAttribute('role')).toBe('status');
    await act(async () => button('Dismiss')!.click());
    expect(dismissStorageWarning).toHaveBeenCalledTimes(1);
  });

  it('offers Export beside the warning that asks for it, on every page, and opens the export dialog', async () => {
    withLedger({ storageWarning: FULL });
    window.history.replaceState(null, '', '/#overview');
    await render();
    // The Overview has no Export button of its own; the notice carries it.
    expect(notices()[0].textContent).toContain('Export your ledger');
    const opener = [...notices()[0].querySelectorAll('button')].find(
      (item) => item.textContent === 'Export',
    )!;
    expect(opener).toBeDefined();
    opener.focus();
    await act(async () => opener.click());
    await settle();
    expect(dialog()?.textContent).toContain('Your ledger, to keep.');
    await pressEscape();
    expect(document.activeElement).toBe(opener);
  });

  it('offers no Export beside a warning that does not ask for one', async () => {
    withLedger({ storageWarning: 'Browser storage is unavailable.' });
    await render();
    expect([...notices()[0].querySelectorAll('button')].map((item) => item.textContent)).toEqual([
      'Dismiss',
    ]);
  });

  it('offers Reconnect beside the paused-updates line, and Reconnect asks the ledger to refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    withLedger({ error: 'Updates are paused. Your saved changes remain on record.', refresh });
    await render();
    expect(notices()[0].textContent).toContain('Updates are paused');
    await act(async () => button('Reconnect')!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('survives a Reconnect that fails again, and keeps the notice for another try', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    withLedger({ error: 'Updates are paused. Your saved changes remain on record.', refresh });
    await render();
    await act(async () => button('Reconnect')!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(button('Reconnect')).toBeDefined();
  });

  it('shows the two notices separately, each with its own buttons, when both apply', async () => {
    withLedger({ storageWarning: FULL, error: 'Updates are paused.' });
    await render();
    expect(notices()).toHaveLength(2);
    expect(notices()[0].textContent).toContain('Export your ledger');
    expect(notices()[1].textContent).toContain('Updates are paused');
  });

  it('shows nothing when there is nothing to say', async () => {
    await render();
    expect(notices()).toHaveLength(0);
  });
});

describe('a session that ends while the ledger is open', () => {
  const RETURN_KEY = 'lobster-ledger-return-page';
  const notices = () => [...document.querySelectorAll('.workspace .connection-notice')];
  const expired = (extra: Record<string, unknown> = {}) =>
    vi.mocked(useLedger).mockReturnValue({
      ...signedIn(),
      sessionExpired: true,
      ...extra,
    } as unknown as ReturnType<typeof useLedger>);
  const signInAgain = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('.workspace .connection-notice a')].find(
      (link) => link.textContent === 'Sign in again',
    )!;
  // Following the real link would navigate the whole test window away.
  const clickSignInAgain = () =>
    act(async () => {
      document.addEventListener('click', (event) => event.preventDefault(), { once: true });
      signInAgain().click();
    });

  it('says the session ended and offers the way back in, instead of a Reconnect that cannot work', async () => {
    expired();
    await render();
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toMatch(/your session ended/i);
    expect(notices()[0].textContent).toMatch(/sign in again to keep the ledger up to date/i);
    expect(notices()[0].getAttribute('data-tone')).toBe('info');
    expect(signInAgain().getAttribute('href')).toBe('/auth/google');
    expect(button('Reconnect')).toBeUndefined();
    expect(notices()[0].textContent).not.toMatch(/updates are paused/i);
  });

  it('is the only notice, even when the paused-updates line is still set', async () => {
    expired({ error: 'Updates are paused. Your saved changes remain on record.' });
    await render();
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).not.toMatch(/updates are paused/i);
    expect(button('Reconnect')).toBeUndefined();
  });

  it('keeps the ledger on screen while it waits', async () => {
    expired();
    await render();
    expect(heading()?.textContent).toMatch(/good (morning|afternoon|evening)/i);
  });

  it('brings the member back to the page they were on', async () => {
    expired();
    window.history.replaceState(null, '', '/#balances');
    await render();
    await clickSignInAgain();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBe('balances');
  });

  it('brings the member back to the tab they were on, too', async () => {
    expired();
    window.history.replaceState(null, '', '/#places/prices');
    await render();
    await clickSignInAgain();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBe('places/prices');
  });

  it('keeps nothing when the member was only at the Overview', async () => {
    expired();
    await render();
    await clickSignInAgain();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('shows nothing about a session while the session is fine', async () => {
    await render();
    expect(document.body.textContent).not.toMatch(/session ended/i);
    expect(document.body.textContent).not.toMatch(/sign in again/i);
  });
});

describe('a returning visitor', () => {
  const googleLink = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      /Continue with Google/.test(link.textContent ?? ''),
    )!;

  it('tells a returning visitor the session ended, with the way back in, and nothing alarming', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      sessionEnded: true,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    const notice = document.querySelector('.connection-notice')!;
    expect(notice.textContent).toMatch(/your session ended/i);
    expect(notice.getAttribute('data-tone')).toBe('info');
    expect(notice.textContent).not.toMatch(/can.t reach|unable|failed/i);
    expect(button('Try again')).toBeUndefined();
    expect(googleLink().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('does not say the session ended on an ordinary first visit', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.body.textContent).not.toMatch(/session ended/i);
  });
});
describe('signing out', () => {
  it('forgets that this browser was signed in, so the next visit is not told a session ended', async () => {
    window.localStorage.setItem('lobster-ledger-had-session', '1');
    const { api } = await import('./lib/client');
    const logout = vi.spyOn(api, 'logout').mockResolvedValue(undefined as never);
    await render();
    await act(async () => byLabel('Sign out').click());
    await settle();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('lobster-ledger-had-session')).toBeNull();
    logout.mockRestore();
  });

  it('keeps the note when signing out did not work, because the member is still signed in', async () => {
    window.localStorage.setItem('lobster-ledger-had-session', '1');
    const { api } = await import('./lib/client');
    vi.spyOn(api, 'logout').mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => byLabel('Sign out').click());
    await settle();
    expect(window.localStorage.getItem('lobster-ledger-had-session')).toBe('1');
    vi.mocked(api.logout).mockRestore();
  });
});

describe('a bet link that names nothing', () => {
  it('tells a signed-out visitor so, with a way to dismiss it', async () => {
    window.history.replaceState(null, '', '/?bet=bad%20id');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    const notice = document.querySelector('.welcome-screen .connection-notice')!;
    expect(notice.textContent).toMatch(/bet link isn.t valid/i);
    expect(document.body.textContent).not.toContain('Sign in to open the bet you were sent');
    await act(async () => button('Dismiss')!.click());
    expect(document.querySelector('.connection-notice')).toBeNull();
  });

  it('hands focus to the page heading when Dismiss takes the notice away', async () => {
    window.history.replaceState(null, '', '/?bet=bad%20id');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    const dismiss = button('Dismiss')!;
    dismiss.focus();
    await act(async () => dismiss.click());
    expect(document.activeElement).toBe(heading());
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('tells a signed-in member through an error toast and leaves them where they were', async () => {
    window.history.replaceState(null, '', '/?bet=bad%20id#balances');
    await render();
    const alert = [...document.querySelectorAll('[role="alert"]')].find((region) =>
      /bet link isn.t valid/i.test(region.textContent ?? ''),
    );
    expect(alert, 'an alert region holds the message').toBeDefined();
    expect(window.location.hash).toBe('#balances');
    expect(window.location.search).toBe('');
  });

  it('says nothing for an ordinary visit', async () => {
    await render();
    expect(document.body.textContent).not.toMatch(/bet link isn.t valid/i);
  });
});

describe('the opening screen', () => {
  const opening = (retry = vi.fn()) =>
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      loading: true,
      configStatus: 'loading',
      retry,
    } as unknown as ReturnType<typeof useLedger>);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

  it('is a status the screen reader announces, inside a main landmark, with a hidden spinner', async () => {
    opening();
    await render();
    const status = document.querySelector('.loading-screen [role="status"]')!;
    expect(status.textContent).toBe('Opening the ledger…');
    expect(document.querySelector('main.loading-screen')).not.toBeNull();
    expect(document.querySelector('.loading-screen .spinner')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(button('Try again')).toBeUndefined();
  });

  it('says it is still opening after eight seconds and offers Try again', async () => {
    const retry = vi.fn();
    opening(retry);
    await render();
    await tick(7_900);
    expect(button('Try again')).toBeUndefined();
    await tick(200);
    // The same live region changes its words, so the change is announced.
    expect(document.querySelector('.loading-screen [role="status"]')?.textContent).toMatch(
      /still opening/i,
    );
    await act(async () => button('Try again')!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('starts counting again after Try again, instead of showing the notice at once', async () => {
    opening();
    await render();
    await tick(8_000);
    await act(async () => button('Try again')!.click());
    expect(button('Try again')).toBeUndefined();
    expect(document.querySelector('.loading-screen [role="status"]')?.textContent).toBe(
      'Opening the ledger…',
    );
    await tick(8_000);
    expect(button('Try again')).toBeDefined();
  });

  it('keeps focus on the screen when Try again takes its own button away', async () => {
    opening();
    await render();
    await tick(8_000);
    const retry = button('Try again')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => retry.click());
    expect(button('Try again')).toBeUndefined();
    // Not <body>: a keyboard user would have to tab in from the top of the page again.
    expect(document.activeElement).toBe(document.querySelector('.loading-screen [role="status"]'));
  });

  it('stops counting once the ledger has opened', async () => {
    opening();
    await render();
    vi.mocked(useLedger).mockReturnValue(signedIn());
    await render();
    await tick(20_000);
    expect(document.querySelector('.loading-screen')).toBeNull();
    expect(button('Try again')).toBeUndefined();
  });
});

describe('the welcome page details', () => {
  const googleLink = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      /Continue with Google/.test(link.textContent ?? ''),
    )!;
  const demoLink = () => document.querySelector<HTMLAnchorElement>('a[href="/?demo=1"]')!;

  it('draws the Google mark as a four-colour graphic hidden from assistive technology', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    const mark = googleLink().querySelector('svg.google-mark')!;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(
      new Set([...mark.querySelectorAll('path')].map((path) => path.getAttribute('fill'))),
    ).toEqual(new Set(['#4285F4', '#34A853', '#FBBC05', '#EA4335']));
    // The plain bold letter that stood in for it is gone.
    expect(document.querySelector('.google-letter')).toBeNull();
  });

  it('keeps the trust line’s words in one element beside its icon, so they wrap together', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    const trust = document.querySelector('.welcome-trust')!;
    expect(trust.querySelector('svg')).not.toBeNull();
    expect(trust.querySelector('span')?.textContent).toBe(
      'Private membership. Mutual approvals. A complete history.',
    );
  });

  it('keeps the demo secondary while Google works, and makes it the main button when it cannot', async () => {
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(demoLink().className).toContain('button-secondary');
    expect(demoLink().className).not.toContain('button-primary');
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configStatus: 'unconfigured',
      configured: false,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    expect(googleLink().getAttribute('aria-disabled')).toBe('true');
    expect(demoLink().className).toContain('button-primary');
    expect(demoLink().className).not.toContain('button-secondary');
  });
});
describe('a page link followed while signed out', () => {
  const RETURN_KEY = 'lobster-ledger-return-page';
  const googleLink = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      /Continue with Google/.test(link.textContent ?? ''),
    )!;
  // Following the real link would navigate the whole test window away.
  const clickGoogle = () =>
    act(async () => {
      document.addEventListener('click', (event) => event.preventDefault(), { once: true });
      googleLink().click();
    });

  it('names the page the visitor is waiting for on the welcome page', async () => {
    window.history.replaceState(null, '', '/#balances');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    const note = document.querySelector('.welcome-pending-bet');
    expect(note?.textContent).toBe('Sign in to open Balances');
  });

  it('says "the ledger" for the ledger page, not "The ledger"', async () => {
    window.history.replaceState(null, '', '/#ledger');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.welcome-pending-bet')?.textContent).toBe(
      'Sign in to open the ledger',
    );
  });

  it('says nothing about a destination on the plain welcome page', async () => {
    window.history.replaceState(null, '', '/#overview');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.welcome-pending-bet')).toBeNull();
  });

  it('lets a waiting bet link speak for the visit instead of the page', async () => {
    window.history.replaceState(null, '', '/?bet=LL-1042#balances');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.welcome-pending-bet')?.textContent).toBe(
      'Sign in to open the bet you were sent',
    );
    await clickGoogle();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('keeps the page across the sign-in round trip', async () => {
    window.history.replaceState(null, '', '/#balances');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    await clickGoogle();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBe('balances');
  });

  it('keeps the whole address across the round trip, so #places/prices comes back to Roll prices', async () => {
    window.history.replaceState(null, '', '/#places/prices');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    expect(document.querySelector('.welcome-pending-bet')?.textContent).toBe(
      'Sign in to open Places',
    );
    await clickGoogle();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBe('places/prices');
  });

  it('opens Places on its Roll prices tab when that address comes back from sign-in', async () => {
    window.sessionStorage.setItem(RETURN_KEY, 'places/prices');
    window.history.replaceState(null, '', '/');
    await render();
    // The address lands after the first paint, as the browser's hashchange does.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(window.location.hash).toBe('#places/prices');
    expect(navLink('#places').getAttribute('aria-current')).toBe('page');
    expect(
      [...document.querySelectorAll('[aria-label="Places views"] button')]
        .find((tab) => tab.textContent?.includes('Roll prices'))
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('keeps nothing when the visitor is only at the front page', async () => {
    window.history.replaceState(null, '', '/#overview');
    vi.mocked(useLedger).mockReturnValue(signedOut);
    await render();
    await clickGoogle();
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('opens that page when the member comes back from signing in to a bare address', async () => {
    window.sessionStorage.setItem(RETURN_KEY, 'balances');
    window.history.replaceState(null, '', '/');
    await render();
    expect(window.location.hash).toBe('#balances');
    expect(navLink('#balances').getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Balances · The Lobster Ledger');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('does not override an address that already names a page', async () => {
    window.sessionStorage.setItem(RETURN_KEY, 'balances');
    window.history.replaceState(null, '', '/#members');
    await render();
    expect(navLink('#members').getAttribute('aria-current')).toBe('page');
    expect(window.location.hash).toBe('#members');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('leaves a saved page alone while the visitor looks around the demo, as it does a bet link', async () => {
    window.sessionStorage.setItem(RETURN_KEY, 'balances');
    window.history.replaceState(null, '', '/?demo=1');
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    await render();
    expect(navLink('#overview').getAttribute('aria-current')).toBe('page');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBe('balances');
  });

  it('still takes a guide page back in the demo, since the guides are public', async () => {
    window.sessionStorage.setItem(RETURN_KEY, 'mcp');
    window.history.replaceState(null, '', '/?demo=1');
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    await render();
    expect(window.location.hash).toBe('#mcp');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('ignores a saved value that is not a page', async () => {
    window.sessionStorage.setItem(RETURN_KEY, 'https://elsewhere.example');
    window.history.replaceState(null, '', '/');
    await render();
    expect(navLink('#overview').getAttribute('aria-current')).toBe('page');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });
});

describe('the invitation form', () => {
  const nameField = () => dialog()!.querySelector<HTMLInputElement>('input')!;
  async function typeName(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        nameField(),
        value,
      );
      nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  it('names a blank name under the field, marks it invalid and keeps focus there', async () => {
    const ledger = { ...signedIn(), addDemoMember: vi.fn() };
    vi.mocked(useLedger).mockReturnValue(ledger as unknown as ReturnType<typeof useLedger>);
    await render();
    await act(async () => button('Invite a member')!.click());
    await settle();
    const form = dialog()!.querySelector('form')!;
    expect(form.noValidate).toBe(true);
    await typeName('   ');
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.focus();
    await act(async () => form.requestSubmit());
    expect(ledger.addDemoMember).not.toHaveBeenCalled();
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(nameField().getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toBe('Enter a name.');
    expect(document.activeElement).toBe(nameField());
    expect(submit.disabled).toBe(false);
    // Typing again clears the message.
    await typeName('Jamie Chen');
    expect(nameField().hasAttribute('aria-invalid')).toBe(false);
    expect(nameField().maxLength).toBe(100);
  });

  it('keeps focus on the pressed button when the invitation is refused', async () => {
    const addDemoMember = vi.fn(async () => {
      throw new Error('That name is already at the table.');
    });
    const ledger = { ...signedIn(), demo: true, addDemoMember };
    vi.mocked(useLedger).mockReturnValue(ledger as unknown as ReturnType<typeof useLedger>);
    await render();
    await act(async () => button('Invite a member')!.click());
    await settle();
    await typeName('Jamie Chen');
    const form = dialog()!.querySelector('form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.focus();
    await act(async () => form.requestSubmit(submit));
    await settle();
    expect(addDemoMember).toHaveBeenCalledOnce();
    expect(form.querySelector('.modal-footer .form-error')?.textContent).toBe(
      'That name is already at the table.',
    );
    // It was held (aria-busy) rather than disabled while it was sent, so focus never left it.
    expect(submit.disabled).toBe(false);
    expect(submit.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(submit);
  });
});

describe('invite dialog', () => {
  const addDemoMember = vi.fn();
  const demoLedger = () =>
    ({ ...signedIn(), demo: true, addDemoMember }) as unknown as ReturnType<typeof useLedger>;
  const nameField = () => dialog()!.querySelector<HTMLInputElement>('input[name="name"]')!;
  const nameError = () =>
    document.getElementById(nameField().getAttribute('aria-describedby') ?? '')?.textContent ?? '';
  async function openInvite() {
    await act(async () => button('Invite a member')!.click());
    await settle();
  }
  async function typeName(value: string) {
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(nameField(), value);
      nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function submit(label = 'Add demo member') {
    await act(async () => button(label)!.click());
    await settle();
  }

  beforeEach(() => {
    addDemoMember.mockReset().mockImplementation(async (name: string) => ({
      id: 'new-member',
      name,
      initials: 'N',
      color: '#315b54',
    }));
    vi.mocked(useLedger).mockReturnValue(demoLedger());
  });

  it('turns away a name already at the table, whatever its case, and says so on the field', async () => {
    await render();
    await openInvite();
    await typeName('alex');
    await submit();
    expect(nameError()).toBe('Someone named Alex is already at the table.');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nameField());
    expect(addDemoMember).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('announces the problem as it appears, since focus is already on the field after Enter', async () => {
    await render();
    await openInvite();
    await typeName('alex');
    await submit();
    const message = document.getElementById(nameField().getAttribute('aria-describedby')!)!;
    expect(message.getAttribute('role')).toBe('alert');
  });

  it('names the rule when the name is only whitespace, which the browser would let through', async () => {
    await render();
    await openInvite();
    await typeName('   ');
    await submit();
    expect(nameError()).toBe('Enter a name.');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(addDemoMember).not.toHaveBeenCalled();
  });

  it('clears the problem as soon as the name is edited', async () => {
    await render();
    await openInvite();
    await typeName('alex');
    await submit();
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    await typeName('alexa');
    expect(nameField().getAttribute('aria-invalid')).toBeNull();
    expect(nameField().getAttribute('aria-describedby')).toBeNull();
    expect(dialog()!.textContent).not.toContain('already at the table');
  });

  it('adds the name trimmed with its inner spaces collapsed, and closes', async () => {
    await render();
    await openInvite();
    await typeName('  jamie   chen  ');
    await submit();
    expect(addDemoMember).toHaveBeenCalledExactlyOnceWith('jamie chen');
    expect(dialog()).toBeNull();
    expect(document.querySelector('.toast')?.textContent).toContain('jamie chen added to the demo');
  });

  it('asks for a name that fits the shared limit and keeps the browser from guessing at it', async () => {
    await render();
    await openInvite();
    const field = nameField();
    expect(field.maxLength).toBe(100);
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.closest('form')!.noValidate).toBe(true);
  });

  it('keeps Add demo member focusable while it works, and adds the person once', async () => {
    let finish!: (member: object) => void;
    addDemoMember.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await render();
    await openInvite();
    await typeName('Jamie Chen');
    await submit();
    const working = button('Creating…')!;
    expect(working.getAttribute('aria-disabled')).toBe('true');
    expect(working.disabled).toBe(false);
    await act(async () => working.click());
    expect(addDemoMember).toHaveBeenCalledTimes(1);
    await act(async () => finish({ id: 'new-member', name: 'Jamie Chen' }));
  });

  describe('for a real ledger', () => {
    beforeEach(() => {
      vi.mocked(useLedger).mockReturnValue(signedIn());
    });

    it('sends the cleaned name, and the ready message uses it', async () => {
      const invite = vi
        .spyOn(api, 'invite')
        .mockResolvedValue({ url: 'https://ledger.example/auth/google?invite=t', expiresAt: '' });
      await render();
      await openInvite();
      await typeName('  jamie   chen  ');
      await submit('Create invitation');
      expect(invite).toHaveBeenCalledExactlyOnceWith('jamie chen');
      expect(dialog()!.querySelector('h3')?.textContent).toBe('jamie chen’s invitation is ready.');
    });

    it('says the invitation is ready in the dialog description and moves focus to that message', async () => {
      vi.spyOn(api, 'invite').mockResolvedValue({
        url: 'https://ledger.example/auth/google?invite=t',
        expiresAt: '',
      });
      await render();
      await openInvite();
      await typeName('Jamie Chen');
      await submit('Create invitation');
      const open = dialog()!;
      // The form and its prompt are gone, so the dialog no longer asks anyone to create anything.
      expect(open.textContent).not.toContain('Create a single-use invitation');
      const description = document.getElementById(open.getAttribute('aria-describedby') ?? '');
      expect(description?.textContent).toMatch(/single-use invitation is ready/i);
      expect(description?.textContent).toContain('3 days');
      // The button that was pressed is gone with the form: focus goes to the new message, which a
      // screen reader then reads, instead of dropping to the dialog itself.
      const heading = open.querySelector('h3')!;
      expect(document.activeElement).toBe(heading);
      expect(heading.getAttribute('tabindex')).toBe('-1');
      // The next Tab reaches the link, then the actions.
      expect(heading.nextElementSibling?.tagName).toBe('P');
    });

    it('checks the name against the members at the table before sending anything', async () => {
      const invite = vi.spyOn(api, 'invite');
      await render();
      await openInvite();
      await typeName('ALEX');
      await submit('Create invitation');
      expect(nameError()).toBe('Someone named Alex is already at the table.');
      expect(nameField().getAttribute('aria-invalid')).toBe('true');
      expect(invite).not.toHaveBeenCalled();
    });

    it('puts a name the server turns away on the field, as the form would have', async () => {
      // The form only knows the members it has loaded, so the server can still find a duplicate.
      vi.spyOn(api, 'invite').mockRejectedValue(
        new ApiError('Someone named Pat Smith is already at the table.', 400),
      );
      await render();
      await openInvite();
      await typeName('pat smith');
      await submit('Create invitation');
      expect(nameError()).toBe('Someone named Pat Smith is already at the table.');
      expect(nameField().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(nameField());
      // It is the field's message, not a second general alert about the same thing.
      expect(dialog()!.querySelectorAll('[role="alert"]')).toHaveLength(1);
    });

    it('keeps the general alert for a failure that is not about the name', async () => {
      vi.spyOn(api, 'invite').mockRejectedValue(new ApiError('Unable to reach the ledger.', 0));
      await render();
      await openInvite();
      await typeName('Pat Smith');
      await submit('Create invitation');
      expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(
        'Unable to reach the ledger.',
      );
      expect(nameField().getAttribute('aria-invalid')).toBeNull();
    });

    it('says the name is the one they will appear under in the ledger', async () => {
      await render();
      await openInvite();
      expect(dialog()!.textContent).toContain('They’ll appear in the ledger under this name');
    });

    it('asks for the pending invitations again once a new one has been made', async () => {
      const open = {
        id: 'abc',
        name: 'Pat Smith',
        createdAt: '2026-10-18T15:00:00.000Z',
        expiresAt: '2026-10-21T15:00:00.000Z',
      };
      const invites = vi
        .spyOn(api, 'invites')
        .mockResolvedValueOnce({ invites: [] })
        .mockResolvedValue({ invites: [open] });
      vi.spyOn(api, 'invite').mockResolvedValue({
        url: 'https://ledger.example/auth/google?invite=t',
        expiresAt: open.expiresAt,
      });
      await render();
      await followHash('#members');
      await settle();
      expect(document.querySelector('.pending-invites')).toBeNull();
      await openInvite();
      await typeName('Pat Smith');
      await submit('Create invitation');
      expect(invites).toHaveBeenCalledTimes(2);
      expect(document.querySelector('.pending-invites strong')?.textContent).toBe('Pat Smith');
    });
  });
});

describe('the invite action on the Members page', () => {
  it('is called Invite a member by the sidebar, the intro and the dashed card alike', async () => {
    await render();
    await followHash('#members');
    await settle();
    const triggers = [...document.querySelectorAll('button')].filter(
      (candidate) =>
        (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) ===
        'Invite a member',
    );
    expect(
      triggers.map(
        (trigger) =>
          trigger.closest('.sidebar, .members-intro, .members-grid')?.className.split(' ')[0],
      ),
    ).toEqual(['sidebar', 'members-intro', 'members-grid']);
    expect(document.body.textContent).not.toMatch(/Invite a friend|Invite someone/);
  });

  it('keeps its name as a tooltip in the sidebar, where a short window shows only its icons', async () => {
    await render();
    const invite = document.querySelector<HTMLButtonElement>('.sidebar .invite-sidebar')!;
    expect(invite.textContent?.trim()).toBe('Invite a member');
    expect(invite.title).toBe('Invite a member');
  });

  it('opens a dialog named for the action, in a demo too', async () => {
    vi.mocked(useLedger).mockReturnValue({
      ...signedIn(),
      demo: true,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    await act(async () => button('Invite a member')!.click());
    await settle();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Invite a member');
    expect(dialog()?.textContent).toContain('Add a sample member');
  });
});

describe('member cards on the Members page', () => {
  // tsc 7's DOM typings reject a select as a querySelector<T> argument or a direct assertion.
  const opponentSelect = () =>
    document.querySelector('[role="dialog"] select[required]') as unknown as HTMLSelectElement;
  const search = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Search ledger"]');

  it('start a new bet with the person on the card, and forget them once the dialog closes', async () => {
    await render();
    await followHash('#members');
    await settle();
    await act(async () => button('Bet with Alex')!.click());
    await settle();
    expect(opponentSelect().value).toBe('alex');
    await pressEscape();
    expect(dialog()).toBeNull();
    await act(async () => button('New bet')!.click());
    await settle();
    expect(opponentSelect().value).toBe('');
  });

  it('open the ledger already narrowed to the person on the card', async () => {
    await render();
    await followHash('#members');
    await settle();
    await act(async () => byLabel('View bets involving Sarah').click());
    await settle();
    expect(window.location.hash).toBe('#ledger');
    expect(heading()?.textContent).toMatch(/ledger/i);
    expect(search()?.value).toBe('Sarah');
    expect(
      [...document.querySelectorAll('.bet-title-cell')].every((cell) =>
        cell.closest('tr, li, article')?.textContent?.includes('Sarah'),
      ),
    ).toBe(true);
  });

  it('open the ledger narrowed to a member from their name on the Leaderboard', async () => {
    await render();
    await followHash('#leaderboard');
    await settle();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[title="View bets involving Sarah"]')!.click(),
    );
    await settle();
    expect(window.location.hash).toBe('#ledger');
    expect(search()?.value).toBe('Sarah');
  });

  it('do not leave the name in the ledger search once the reader moves to another page', async () => {
    await render();
    await followHash('#members');
    await settle();
    await act(async () => byLabel('View bets involving Sarah').click());
    await settle();
    await followHash('#overview');
    await followHash('#ledger');
    await settle();
    expect(search()?.value).toBe('');
  });
});

describe('pending invitations on the Members page', () => {
  const open = {
    id: 'abc',
    name: 'Pat Smith',
    createdAt: '2026-10-18T15:00:00.000Z',
    expiresAt: '2026-10-21T15:00:00.000Z',
  };

  it('are listed under the member cards, with a way to revoke each', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({ invites: [open] });
    await render();
    await followHash('#members');
    await settle();
    const list = document.querySelector('.pending-invites')!;
    expect(list.querySelector('h2')?.textContent).toBe('Pending invitations');
    expect(list.querySelector('strong')?.textContent).toBe('Pat Smith');
    expect(byLabel('Revoke the invitation for Pat Smith')).not.toBeNull();
    const grid = document.querySelector('.members-grid')!;
    expect(grid.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('are not asked for in a demo, which has no invitations to keep', async () => {
    const invites = vi.spyOn(api, 'invites');
    vi.mocked(useLedger).mockReturnValue({
      ...signedIn(),
      demo: true,
    } as unknown as ReturnType<typeof useLedger>);
    await render();
    await followHash('#members');
    await settle();
    expect(invites).not.toHaveBeenCalled();
    expect(document.querySelector('.pending-invites')).toBeNull();
  });
});
