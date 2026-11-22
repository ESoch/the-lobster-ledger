// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/client';
import { createDemoState } from './lib/demo';
import { needsAction } from './lib/ledger';
import { useLedger } from './lib/useLedger';
import { cliApi } from './components/cli-api';

// The app chrome: topbar, search, account menu, sidebar footer and theme. Routing and focus return
// are covered in App.dom.test.ts.
vi.mock('./lib/useLedger', () => ({ useLedger: vi.fn() }));
vi.mock('./components/cli-api', () => ({ cliApi: vi.fn() }));
vi.mock('./components/MapView', () => ({ MapView: () => null }));

let root: Root;
let container: HTMLDivElement;
const signedOut = {
  state: null,
  member: undefined,
  memberId: '',
  demo: false,
  loading: false,
  configured: true,
  error: '',
  storageWarning: '',
} as unknown as ReturnType<typeof useLedger>;

function signedIn(options: { demo?: boolean } = {}) {
  const state = createDemoState();
  return {
    ...signedOut,
    demo: !!options.demo,
    state,
    memberId: state.members[0].id,
    member: state.members[0],
  };
}

// A window of a given width, answering every (max-width) / (min-width) / prefers-color-scheme query.
function stubMedia({ width = 1280, scheme }: { width?: number; scheme?: 'light' | 'dark' } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  let preferred = scheme;
  const evaluate = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    if (max) return width <= Number(max[1]);
    const min = /min-width:\s*(\d+)px/.exec(query);
    if (min) return width >= Number(min[1]);
    const colour = /prefers-color-scheme:\s*(light|dark)/.exec(query);
    if (colour) return preferred === colour[1];
    return false;
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return evaluate(query);
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener);
      },
    })),
  );
  return {
    setScheme: (next: 'light' | 'dark') => {
      preferred = next;
      listeners.forEach((set, query) => {
        if (query.includes('prefers-color-scheme')) set.forEach((listener) => listener());
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubMedia();
  window.scrollTo = vi.fn();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/#overview');
  delete document.documentElement.dataset.theme;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(useLedger).mockReturnValue(signedIn());
  vi.mocked(cliApi).mockResolvedValue({ sessions: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.head.querySelectorAll('meta[name="theme-color"], style[data-test]').forEach((node) => {
    node.remove();
  });
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
async function render() {
  await act(async () => root.render(createElement(App)));
}
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const searchField = () =>
  document.querySelector<HTMLInputElement>('.topbar input[aria-label="Find a bet"]');
const topbar = () => document.querySelector<HTMLElement>('.topbar')!;
const sidebar = () => document.querySelector<HTMLElement>('.sidebar')!;
const dialog = () => document.querySelector('[role="dialog"][data-state="open"]');
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}
// Stylesheets are read from disk: the component tests do not load CSS.
const source = (file: string) => readFileSync(`src/${file}`, 'utf8');
function stylesheet(file: string) {
  const style = document.createElement('style');
  style.dataset.test = file;
  style.textContent = source(file);
  document.head.appendChild(style);
}

// Every `@media (<query>) { ... }` block in a stylesheet, joined. jsdom ignores media queries, so the
// phone and tablet rules are checked against the stylesheet text instead.
function mediaBlocks(css: string, query: string) {
  const found: string[] = [];
  for (let at = css.indexOf(`@media (${query}) {`); at >= 0;) {
    let depth = 0;
    let index = css.indexOf('{', at);
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}' && --depth === 0) break;
    }
    found.push(css.slice(at, index + 1));
    at = css.indexOf(`@media (${query}) {`, index);
  }
  expect(found, `@media (${query}) is missing`).not.toHaveLength(0);
  return found.join('\n');
}

describe('topbar on a narrow phone', () => {
  it('drops the Workspace crumb at 320px, leaving the page name', async () => {
    stubMedia({ width: 320 });
    await render();
    expect(topbar().textContent).not.toContain('Workspace');
    expect(topbar().querySelector('.breadcrumb strong')?.textContent).toBe('Overview');
    expect(topbar().querySelector('.breadcrumb-chevron')).toBeNull();
  });

  it('has no Workspace crumb on a desktop window either: it led nowhere', async () => {
    stubMedia({ width: 1280 });
    await render();
    expect(topbar().textContent).not.toContain('Workspace');
    expect(topbar().querySelector('.breadcrumb strong')?.textContent).toBe('Overview');
    expect(topbar().querySelector('.breadcrumb-chevron')).toBeNull();
  });

  it('keeps the page name on one line and lets it truncate', async () => {
    stubMedia({ width: 320 });
    await render();
    stylesheet('styles.css');
    const name = topbar().querySelector('.breadcrumb strong')!;
    const style = window.getComputedStyle(name);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.overflow).toBe('hidden');
  });
});

describe('topbar CSS contract', () => {
  const css = source('styles.css');
  const blocks = (query: string) => mediaBlocks(css, query);

  it('lets the breadcrumb shrink instead of pushing the actions off a 320px screen', () => {
    expect(css).toMatch(/\.breadcrumb \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.breadcrumb strong \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.topbar-actions \{[^}]*flex: none/);
  });

  it('tightens the topbar on a 320px screen', () => {
    const narrow = blocks('max-width: 480px');
    expect(narrow).toMatch(/\.topbar \{[^}]*padding: 0 8px 0 11px/);
    expect(narrow).toMatch(/\.topbar \{[^}]*gap: 4px/);
    expect(narrow).toMatch(/\.topbar-actions \{[^}]*gap: 0/);
  });

  it('keeps the topbar pinned to the top of the screen on a phone', () => {
    const phone = blocks('max-width: 760px');
    expect(phone).toMatch(/\.topbar \{[^}]*position: sticky/);
    expect(phone).toMatch(/\.topbar \{[^}]*top: 0/);
  });

  it('scrolls a focused control out from under the pinned topbar (WCAG 2.4.11 Focus Not Obscured)', () => {
    // A sticky bar covers whatever the browser scrolls to the top edge, which is where Shift+Tab puts
    // the previous control. scroll-padding-top keeps that edge below the bar plus room for the ring.
    const phone = blocks('max-width: 760px');
    expect(phone).toMatch(/--topbar-height:\s*\d+px/);
    expect(phone).toMatch(/\.topbar \{[^}]*height: var\(--topbar-height\)/);
    const padding =
      /html \{[^}]*scroll-padding-top:\s*calc\(var\(--topbar-height\) \+ (\d+)px\)/.exec(phone);
    expect(padding, 'html needs scroll-padding-top below the pinned bar').not.toBeNull();
    // The focus ring is a 3px outline offset by 3px, so it needs at least 6px under the bar.
    expect(Number(padding![1])).toBeGreaterThanOrEqual(6);
  });

  it('keeps the search field the same width whether or not the clear button is showing', () => {
    // The clear button joins the row on the first keystroke; without its slot kept while the field is
    // empty, the field grows by the button and its gap and the left edge jumps under the reader.
    const px = (pattern: RegExp) => Number(pattern.exec(css)?.[1]);
    const edge = px(/\.global-search \{[^}]*padding: 0 (\d+)px 0 \d+px/);
    const gap = px(/\.global-search \{[^}]*gap: (\d+)px/);
    const button = px(/\.search-clear \{[^}]*width: (\d+)px/);
    const reserved = px(
      /\.global-search:not\(:has\(\.search-clear\)\) \{[^}]*padding-right: (\d+)px/,
    );
    expect(reserved, 'an empty field reserves the clear button slot').toBe(edge + gap + button);
  });

  it('guards against any other sideways overflow without breaking sticky', () => {
    expect(css).toMatch(/html,\s*body \{[^}]*overflow-x: clip/);
  });
});

describe('the greeting', () => {
  const greeting = () => document.querySelector('main h1')?.textContent;
  it.each([
    [3, 'Good evening, Ellis.'],
    [4, 'Good evening, Ellis.'],
    [5, 'Good morning, Ellis.'],
    [11, 'Good morning, Ellis.'],
    [12, 'Good afternoon, Ellis.'],
    [16, 'Good afternoon, Ellis.'],
    [17, 'Good evening, Ellis.'],
    [23, 'Good evening, Ellis.'],
  ])('at %i:30 says "%s"', async (hour, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 18, hour, 30));
    await render();
    expect(greeting()).toBe(expected);
  });
});

describe('page heading CSS contract', () => {
  const css = source('ledger-workflow.css');

  it('moves the title and the buttons as a nowrap group below 1000px, not one button at a time', () => {
    const block = mediaBlocks(css, 'max-width: 1000px');
    expect(block).toMatch(/\.page-heading \{[^}]*flex-wrap: wrap/);
    expect(block).toMatch(/\.heading-actions \{[^}]*flex-wrap: nowrap/);
    expect(block).toMatch(/\.heading-actions \{[^}]*width: auto/);
  });
});

describe('the sidebar', () => {
  it('shows the workspace as a plain heading, not a button that pretends to be a menu', async () => {
    await render();
    const header = sidebar().querySelector('.workspace-switch')!;
    expect(header.tagName).not.toBe('BUTTON');
    expect(header.closest('button')).toBeNull();
    expect(header.querySelector('svg')).toBeNull();
    expect(header.textContent).toContain('6 members');
  });

  it('keeps the footer outside the scrolling navigation', async () => {
    await render();
    const children = [...sidebar().children];
    const nav = children.find((child) => child.tagName === 'NAV')!;
    const footer = children.find((child) => child.classList.contains('sidebar-bottom'))!;
    expect(footer).toBeTruthy();
    expect(nav.contains(footer)).toBe(false);
    expect(footer.textContent).toContain('How it works');
    expect(footer.textContent).toContain('Invite a member');
    expect(children.indexOf(nav)).toBeLessThan(children.indexOf(footer));
  });

  it('splits the Invite button so a short window can keep "Invite" on screen with the name whole', async () => {
    await render();
    const invite = sidebar().querySelector('.invite-sidebar')!;
    // The accessible name is the same whichever part is on screen.
    expect(invite.textContent).toBe('Invite a member');
    expect(invite.querySelector('.invite-rest')?.textContent).toBe(' a member');
    // What is left on screen is the start of the name, so the label is in the name (WCAG 2.5.3).
    const words = invite.querySelector('.invite-words')!;
    const shown = [...words.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('');
    expect(shown).toBe('Invite');
    // The button is a flex row with a gap: "Invite" and " a member" as two flex items would sit a
    // gap apart (their space collapses). Both stay inside one element, so the space is an
    // ordinary word space, and the compact rule that hides ".invite-rest" works inside it.
    expect(words.contains(invite.querySelector('.invite-rest'))).toBe(true);
    expect([...invite.childNodes].some((node) => node.nodeType === Node.TEXT_NODE)).toBe(false);
    expect(
      [...invite.children].filter((child) => child.tagName !== 'svg' && child !== words),
    ).toEqual([]);
  });

  it('is a column whose navigation scrolls between a fixed header and a pinned footer', () => {
    // The phone drawer is the same element, so these rules cover it too.
    const css = source('adjudication.css');
    expect(css).toMatch(/\.sidebar \{[^}]*overflow: hidden/);
    expect(css).toMatch(/\.sidebar > nav \{[^}]*overflow-y: auto/);
    expect(css).toMatch(/\.sidebar > nav \{[^}]*min-height: 0/);
  });

  it('leaves room for the focus ring at both ends of the scrolling navigation', () => {
    const adjudication = source('adjudication.css');
    // A 3px outline offset by 3px needs 6px: at rest (padding) and when the browser scrolls a
    // focused edge link into view (scroll-padding), or the ring is cut off at the scroller edge.
    expect(adjudication).toMatch(/\.sidebar > nav \{[^}]*padding: 6px 8px/);
    expect(adjudication).toMatch(/\.sidebar > nav \{[^}]*scroll-padding-block: 6px/);
    // adjudication.css loads after readability.css, so a padding override there would be dead code
    // that contradicts the comment above; spacing on short windows comes from the items instead.
    expect(source('readability.css')).not.toMatch(/\.sidebar > nav \{/);
  });
});

// jsdom will not navigate; the real Location with assign and reload replaced so a test can watch them.
function locationWith(overrides: { assign?: () => void; reload?: () => void }) {
  const real = window.location;
  // The target is a bare object: a Proxy may not hide jsdom's non-configurable Location members.
  return new Proxy({} as Location, {
    get(_target, property) {
      if (property === 'assign' && overrides.assign) return overrides.assign;
      if (property === 'reload' && overrides.reload) return overrides.reload;
      const value = Reflect.get(real, property);
      return typeof value === 'function' ? value.bind(real) : value;
    },
    set(_target, property, value) {
      return Reflect.set(real, property, value);
    },
  });
}

describe('account menu', () => {
  const trigger = () => topbar().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const items = () =>
    [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
  async function open() {
    await act(async () => trigger().click());
  }

  it('is the avatar button, closed to begin with', async () => {
    await render();
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().classList.contains('profile-button')).toBe(true);
    expect(trigger().getAttribute('aria-label')).toMatch(/^Account menu/);
    expect(menu()).toBeNull();
  });

  it('offers profile editing, Members, Command line, Reset demo and Exit demo in the demo', async () => {
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(menu()!.id);
    expect(items()).toEqual(['Edit profile', 'Members', 'Command line', 'Reset demo', 'Exit demo']);
  });

  it('offers profile editing, Members, Command line and Sign out on the private ledger', async () => {
    await render();
    await open();
    expect(items()).toEqual(['Edit profile', 'Members', 'Command line', 'Sign out']);
  });

  it('names who is signed in at the top of the menu', async () => {
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    const header = document.querySelector('.account-menu-header')!;
    expect(header.textContent).toContain('Ellis');
    expect(header.textContent).toContain('Exploring the demo');
  });

  it('hides the avatars from assistive technology: the button, the header and the sidebar name the member', async () => {
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    const avatars = [
      trigger().querySelector('.avatar'),
      document.querySelector('.account-menu-header .avatar'),
      sidebar().querySelector('.sidebar-profile .avatar'),
    ];
    for (const avatar of avatars) {
      expect(avatar).not.toBeNull();
      expect(avatar!.getAttribute('aria-hidden')).toBe('true');
      expect(avatar!.getAttribute('role')).toBeNull();
    }
  });

  it('moves focus into the menu and walks it with the arrow keys, wrapping at the ends', async () => {
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    expect(document.activeElement).toBe(item('Edit profile'));
    await press(menu()!, 'ArrowDown');
    expect(document.activeElement).toBe(item('Members'));
    await press(menu()!, 'ArrowDown');
    expect(document.activeElement).toBe(item('Command line'));
    await press(menu()!, 'End');
    expect(document.activeElement).toBe(item('Exit demo'));
    await press(menu()!, 'ArrowDown');
    expect(document.activeElement).toBe(item('Edit profile'));
    await press(menu()!, 'ArrowUp');
    expect(document.activeElement).toBe(item('Exit demo'));
    await press(menu()!, 'Home');
    expect(document.activeElement).toBe(item('Edit profile'));
  });

  it('opens on the last item with ArrowUp from the button', async () => {
    await render();
    trigger().focus();
    await press(trigger(), 'ArrowUp');
    expect(document.activeElement).toBe(item('Sign out'));
  });

  it('closes on Escape and gives focus back to the avatar', async () => {
    await render();
    await open();
    await press(menu()!, 'Escape');
    expect(menu()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('closes when a click lands outside it', async () => {
    await render();
    await open();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('goes to Members and leaves the reader on that page', async () => {
    await render();
    await open();
    await act(async () => item('Members').click());
    expect(menu()).toBeNull();
    expect(window.location.hash).toBe('#members');
    expect(document.title).toBe('Members · The Lobster Ledger');
  });

  it('signs out through the API and returns to the welcome page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', locationWith({ assign }));
    const logout = vi.spyOn(api, 'logout').mockResolvedValue({});
    await render();
    await open();
    await act(async () => item('Sign out').click());
    await settle();
    expect(logout).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('says so when signing out fails', async () => {
    vi.spyOn(api, 'logout').mockRejectedValue(new Error('offline'));
    await render();
    await open();
    await act(async () => item('Sign out').click());
    await settle();
    expect(document.querySelector('.toast')?.textContent).toContain('Unable to sign out');
  });

  it('leaves the demo for the welcome page without touching the demo ledger', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', locationWith({ assign }));
    window.localStorage.setItem('lobster-ledger-demo-v1', '{"kept":true}');
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    await act(async () => item('Exit demo').click());
    expect(assign).toHaveBeenCalledWith('/');
    expect(window.localStorage.getItem('lobster-ledger-demo-v1')).toBe('{"kept":true}');
  });

  it('warns that another tab showing the same demo can bring its bets back', async () => {
    // Other tabs ignore the key being removed and merge their own records into the sample ledger on
    // their next change, so the reader is told to close them rather than promised a clean slate.
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    await act(async () => item('Reset demo').click());
    await settle();
    expect(dialog()?.textContent).toContain('Close any other tab showing this demo first');
    expect(dialog()?.textContent).toContain('bring their bets back');
  });

  it('asks before resetting the demo, and keeps everything if the reader backs out', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', locationWith({ reload }));
    window.localStorage.setItem('lobster-ledger-demo-v1', '{"bets":[1]}');
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    await act(async () => item('Reset demo').click());
    await settle();
    expect(dialog()?.textContent).toContain('Reset the demo?');
    expect(window.localStorage.getItem('lobster-ledger-demo-v1')).not.toBeNull();
    await act(async () => {
      [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Keep my changes')!
        .click();
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('lobster-ledger-demo-v1')).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('clears only this demo session and reloads when the reset is confirmed', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', locationWith({ reload }));
    window.history.replaceState(null, '', '/?demo=1&demoSession=probe#overview');
    window.localStorage.setItem('lobster-ledger-demo-v1:probe', '{"bets":[1]}');
    window.localStorage.setItem('lobster-ledger-demo-v1:other', '{"bets":[2]}');
    window.localStorage.setItem('lobster-ledger-theme', 'light');
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    await open();
    await act(async () => item('Reset demo').click());
    await settle();
    await act(async () => {
      [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Reset demo')!
        .click();
    });
    expect(window.localStorage.getItem('lobster-ledger-demo-v1:probe')).toBeNull();
    expect(window.localStorage.getItem('lobster-ledger-demo-v1:other')).toBe('{"bets":[2]}');
    expect(window.localStorage.getItem('lobster-ledger-theme')).toBe('light');
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('the sidebar footer', () => {
  it('keeps Sign out in the pinned footer on the private ledger', async () => {
    await render();
    const footer = sidebar().querySelector('.sidebar-bottom')!;
    expect(footer.querySelector('button[aria-label="Sign out"]')).not.toBeNull();
    expect(footer.querySelector('button[aria-label="Exit demo"]')).toBeNull();
  });

  it('keeps Exit demo in the pinned footer in the demo', async () => {
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    const footer = sidebar().querySelector('.sidebar-bottom')!;
    expect(footer.querySelector('button[aria-label="Exit demo"]')).not.toBeNull();
    expect(footer.querySelector('button[aria-label="Sign out"]')).toBeNull();
  });
});

describe('the topbar search', () => {
  it('does not leave the page while typing, and goes to the ledger on Enter', async () => {
    await render();
    const field = searchField()!;
    field.focus();
    await type(field, 'lob');
    expect(window.location.hash).toBe('#overview');
    expect(document.title).toBe('Overview · The Lobster Ledger');
    expect(field.value).toBe('lob');
    await press(field, 'Enter');
    expect(window.location.hash).toBe('#ledger');
    expect(document.title).toBe('The ledger · The Lobster Ledger');
  });

  it('carries the term to the ledger page search, and leaves no second field on that page', async () => {
    await render();
    await type(searchField()!, 'ocean');
    await press(searchField()!, 'Enter');
    expect(searchField()).toBeNull();
    const ledgerSearch = document.querySelector<HTMLInputElement>(
      'main input[type="search"], main input[placeholder*="Search"]',
    );
    expect(ledgerSearch?.value).toBe('ocean');
  });

  it('ignores Enter on an empty field', async () => {
    await render();
    await press(searchField()!, 'Enter');
    expect(window.location.hash).toBe('#overview');
  });

  it('clears the field on Escape without leaving the page', async () => {
    await render();
    const field = searchField()!;
    field.focus();
    await type(field, 'lob');
    await press(field, 'Escape');
    expect(field.value).toBe('');
    expect(window.location.hash).toBe('#overview');
    expect(document.activeElement).toBe(field);
  });

  it('shows a clear button only when there is something to clear, and it returns focus to the field', async () => {
    await render();
    expect(byLabel('Clear search')).toBeNull();
    const field = searchField()!;
    await type(field, 'lob');
    expect(topbar().querySelector('.global-search > span')).toBeNull();
    await act(async () => byLabel('Clear search').click());
    expect(field.value).toBe('');
    expect(byLabel('Clear search')).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('is a labelled search landmark', async () => {
    await render();
    const landmark = topbar().querySelector('.global-search')!;
    expect(landmark.getAttribute('role')).toBe('search');
  });

  it('is hidden on the ledger page, which has its own search field', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    expect(searchField()).toBeNull();
  });

  it('does not leave a stale term behind after the reader moves to another page', async () => {
    await render();
    await type(searchField()!, 'ocean');
    await press(searchField()!, 'Enter');
    await act(async () => {
      sidebar().querySelector<HTMLAnchorElement>('nav a[href="#balances"]')!.click();
    });
    await act(async () => {
      sidebar().querySelector<HTMLAnchorElement>('nav a[href="#ledger"]')!.click();
    });
    const ledgerSearch = document.querySelector<HTMLInputElement>(
      'main input[placeholder*="Search"]',
    );
    expect(ledgerSearch?.value).toBe('');
  });
});

describe('theme', () => {
  const metaColour = () =>
    document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content;
  beforeEach(() => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#101b1d';
    document.head.appendChild(meta);
  });

  it('follows a light OS setting on the first visit, without storing anything', async () => {
    stubMedia({ scheme: 'light' });
    await render();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('lobster-ledger-theme')).toBeNull();
    expect(metaColour()).toBe('#f7f8f5');
  });

  it('stays dark when the OS expresses no preference', async () => {
    stubMedia({});
    await render();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('lobster-ledger-theme')).toBeNull();
    expect(metaColour()).toBe('#101b1d');
  });

  it('prefers a stored choice to the OS setting', async () => {
    stubMedia({ scheme: 'light' });
    window.localStorage.setItem('lobster-ledger-theme', 'dark');
    await render();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('writes the choice only when the toggle is pressed', async () => {
    stubMedia({ scheme: 'light' });
    await render();
    expect(window.localStorage.getItem('lobster-ledger-theme')).toBeNull();
    await act(async () => byLabel('Switch to dark mode').click());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('lobster-ledger-theme')).toBe('dark');
    expect(metaColour()).toBe('#101b1d');
    await act(async () => byLabel('Switch to light mode').click());
    expect(window.localStorage.getItem('lobster-ledger-theme')).toBe('light');
    expect(metaColour()).toBe('#f7f8f5');
  });

  it('follows the OS when it changes, until the reader chooses', async () => {
    const media = stubMedia({ scheme: 'light' });
    await render();
    expect(document.documentElement.dataset.theme).toBe('light');
    await act(async () => media.setScheme('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await act(async () => byLabel('Switch to light mode').click());
    await act(async () => media.setScheme('dark'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('the bell label', () => {
  function withApprovals(count: number) {
    const ledger = signedIn();
    const now = new Date().toISOString();
    const waiting = ledger.state.bets.filter((bet) => needsAction(bet, ledger.memberId, now));
    const rest = ledger.state.bets.filter((bet) => !needsAction(bet, ledger.memberId, now));
    expect(waiting.length).toBeGreaterThanOrEqual(count);
    ledger.state = { ...ledger.state, bets: [...rest, ...waiting.slice(0, count)] };
    return ledger;
  }
  const bell = () => topbar().querySelector('.notification-button')!;

  it('says 1 action waiting, singular', async () => {
    vi.mocked(useLedger).mockReturnValue(withApprovals(1));
    await render();
    expect(bell().getAttribute('aria-label')).toBe('Activity inbox, 1 action waiting');
  });

  it('says nothing waiting, not 0 actions', async () => {
    vi.mocked(useLedger).mockReturnValue(withApprovals(0));
    await render();
    expect(bell().getAttribute('aria-label')).toBe('Activity inbox, nothing waiting');
  });

  it('says how many actions are waiting, plural', async () => {
    vi.mocked(useLedger).mockReturnValue(withApprovals(2));
    await render();
    expect(bell().getAttribute('aria-label')).toBe('Activity inbox, 2 actions waiting');
  });

  it('gives the inbox count in the sidebar a unit for screen readers', async () => {
    vi.mocked(useLedger).mockReturnValue(withApprovals(2));
    await render();
    const link = sidebar().querySelector<HTMLAnchorElement>('nav a[href="#inbox"]')!;
    expect(link.textContent).toContain('2 waiting');
  });
});

describe('the demo bar on a phone', () => {
  it('keeps "Viewing as" visible next to the member picker', () => {
    const css = source('components/member-switcher.css');
    expect(css).not.toMatch(/\.demo-switcher-label \{[^}]*display: none/);
  });
});

describe('the demo member picker', () => {
  it('has an accessible name that contains its visible "Viewing as" label', async () => {
    vi.mocked(useLedger).mockReturnValue(signedIn({ demo: true }));
    await render();
    const visible = document.querySelector('.demo-switcher-label')!.textContent!;
    const picker = document.querySelector('.member-switcher-trigger')!;
    expect(visible).toBe('Viewing as');
    expect(picker.getAttribute('role')).toBe('combobox');
    expect(picker.getAttribute('aria-label')!.toLowerCase()).toContain(visible.toLowerCase());
    // The shared audit harness finds the picker by the words "demo member".
    expect(picker.getAttribute('aria-label')!.toLowerCase()).toContain('demo member');
  });
});

describe('the Export button', () => {
  const exportButton = () => document.querySelector<HTMLButtonElement>('.export-button')!;

  it('says what it exports when only its icon shows', async () => {
    window.history.replaceState(null, '', '/#ledger');
    await render();
    expect(exportButton().textContent).toContain('Export');
    expect(exportButton().title).toBe('Export the ledger');
  });

  it('stays a 44px square on a phone instead of stretching with the other buttons', () => {
    const css = source('ledger-workflow.css');
    const phone = mediaBlocks(css, 'max-width: 520px');
    expect(/\.heading-actions > \.export-button \{[^}]*flex: 0 0 auto/.test(phone)).toBe(true);
  });
});

describe('the sun and moon button', () => {
  it('is not filled like a pressed toggle in the dark theme', async () => {
    window.localStorage.setItem('lobster-ledger-theme', 'dark');
    await render();
    stylesheet('styles.css');
    stylesheet('theme.css');
    const toggle = byLabel('Switch to light mode');
    const bell = topbar().querySelector('.notification-button')!;
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.getComputedStyle(toggle).backgroundColor).toBe(
      window.getComputedStyle(bell).backgroundColor,
    );
  });
});

describe('the page background', () => {
  it('is painted on the body in both themes, not left transparent', () => {
    expect(/\nbody \{[^}]*background: inherit/.test(source('styles.css'))).toBe(true);
  });
});
