// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://ledger.example.com"}
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useLedger } from './lib/useLedger';
import { createDemoState } from './lib/demo';
import { cliApi } from './components/cli-api';
import { CLI_REQUEST_STORAGE } from './components/cli-request';

vi.mock('./lib/useLedger', () => ({ useLedger: vi.fn() }));
vi.mock('./components/cli-api', () => ({ cliApi: vi.fn() }));

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

function signedIn() {
  const state = createDemoState();
  return { ...signedOut, state, memberId: state.members[0].id, member: state.members[0] };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The lazy map loads once, then mounts in whichever later test shows the ledger.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  window.scrollTo = vi.fn();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/#overview');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(useLedger).mockReturnValue(signedOut);
  vi.mocked(cliApi).mockResolvedValue({ sessions: [] });
});

describe('MCP setup app routes', () => {
  it('opens the automatic lobster price tracker from workspace navigation', async () => {
    window.history.replaceState(null, '', '/#lobster-prices');
    vi.mocked(useLedger).mockReturnValue(signedIn());
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector('h1')?.textContent).toBe('Lobster, by the pound.');
    expect(
      container.querySelector('nav a[href="#lobster-prices"]')?.getAttribute('aria-current'),
    ).toBe('page');
    expect(container.querySelector('.market-page')).toBeTruthy();
  });

  it('opens the setup guide from the welcome screen without a login', async () => {
    await act(async () => root.render(createElement(App)));
    const link = container.querySelector<HTMLAnchorElement>('a[href="#mcp"]');
    expect(link?.textContent).toContain('Connect Claude or Codex');
    await act(async () => link!.click());
    expect(container.querySelector('h1')?.textContent).toBe('Your ledger, connected to AI.');
    expect(cliApi).not.toHaveBeenCalled();
  });

  it('makes the guide discoverable in workspace navigation and preserves it after Google sign-in', async () => {
    window.sessionStorage.setItem('lobster-ledger-return-page', 'mcp');
    vi.mocked(useLedger).mockReturnValue(signedIn());
    await act(async () => root.render(createElement(App)));
    expect(window.location.hash).toBe('#mcp');
    expect(container.querySelector('nav a[href="#mcp"]')?.getAttribute('aria-current')).toBe(
      'page',
    );
    expect(container.querySelector('h1')?.textContent).toBe('Your ledger, connected to AI.');
    expect(window.sessionStorage.getItem('lobster-ledger-return-page')).toBeNull();
    expect(cliApi).not.toHaveBeenCalled();
  });

  it('keeps a pending CLI authorization ahead of a saved MCP guide return', async () => {
    const request = {
      codeChallenge: 'a'.repeat(43),
      state: 'b'.repeat(43),
      deviceName: 'Personal laptop',
      redirectUri: 'http://127.0.0.1:49123/callback',
    };
    window.sessionStorage.setItem('lobster-ledger-return-page', 'mcp');
    window.history.replaceState(
      null,
      '',
      `/?cli_authorize=${Buffer.from(JSON.stringify(request)).toString('base64url')}#cli`,
    );
    await act(async () => root.render(createElement(App)));
    expect(window.location.hash).toBe('#cli');
    expect(container.textContent).toContain('Connect your command line');
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('CLI app routes', () => {
  it('gives the public guide the welcome page brand and a clear way back to sign in', async () => {
    window.history.replaceState(null, '', '/#cli');
    await act(async () => root.render(createElement(App)));
    const brand = container.querySelector('.cli-public-brand')!;
    expect(brand.querySelector('svg')).toBeTruthy();
    expect(brand.querySelector('strong')?.textContent).toBe('the lobster ledger');
    const back = container.querySelector<HTMLAnchorElement>('.cli-public-link')!;
    expect(back.textContent).toBe('← Back to sign in');
    expect(back.querySelector('[aria-hidden="true"]')?.textContent).toBe('←');
    await act(async () => back.click());
    expect(container.querySelector('.welcome-screen')).toBeTruthy();
  });

  it('opens the public installation guide from the welcome page without a login', async () => {
    await act(async () => root.render(createElement(App)));
    const link = container.querySelector<HTMLAnchorElement>('.welcome-cli-link');
    expect(link?.textContent).toContain('Install the command-line app');
    await act(async () => link!.click());
    expect(container.querySelector('h1')?.textContent).toContain(
      'Your ledger, from the command line.',
    );
    expect(container.textContent).toContain(
      'npm install -g https://ledger.example.com/downloads/lobster-ledger-cli-0.1.0.tgz',
    );
    expect(container.textContent).toContain(
      'lobster --origin https://ledger.example.com auth login',
    );
    expect(cliApi).not.toHaveBeenCalled();
  });

  it('keeps a pending request through the Google callback and requires fresh explicit consent', async () => {
    const request = {
      codeChallenge: 'a'.repeat(43),
      state: 'b'.repeat(43),
      deviceName: 'CLI laptop',
      redirectUri: 'http://127.0.0.1:49123/callback',
    };
    window.history.replaceState(
      null,
      '',
      `/?cli_authorize=${Buffer.from(JSON.stringify(request)).toString('base64url')}#cli`,
    );
    await act(async () => root.render(createElement(App)));
    expect(container.textContent).toContain('Sign in with Google to continue');
    expect(window.location.search).not.toContain('cli_authorize');
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
    vi.mocked(useLedger).mockReturnValue(signedIn());
    await act(async () => root.render(createElement(App)));
    expect(window.location.hash).toBe('#cli');
    expect(container.textContent).toContain('Allow CLI access');
    expect(container.textContent).toContain('CLI laptop');
    expect(vi.mocked(cliApi).mock.calls.every(([path]) => path === '/api/cli/sessions')).toBe(true);
  });

  it('leaves a real pending request alone when the same tab opens the demo', async () => {
    const pending = {
      request: {
        codeChallenge: 'a'.repeat(43),
        state: 'b'.repeat(43),
        deviceName: 'CLI laptop',
        redirectUri: 'http://127.0.0.1:49123/callback',
      },
      createdAt: Date.now(),
    };
    window.sessionStorage.setItem(CLI_REQUEST_STORAGE, JSON.stringify(pending));
    window.history.replaceState(null, '', '/?demo=1#overview');
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    await act(async () => root.render(createElement(App)));
    expect(window.location.hash).toBe('#overview');
    expect(container.querySelector('.cli-authorization')).toBeNull();
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).toBe(JSON.stringify(pending));
    await act(async () => {
      // replaceState sets the hash without jsdom's asynchronous hashchange leaking into the next test.
      window.history.replaceState(null, '', '/?demo=1#cli');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('.cli-authorization')).toBeNull();
    expect(container.textContent).toContain('This demo cannot connect a CLI');
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).toBe(JSON.stringify(pending));
  });

  it('shows malformed requests as an error without an authorization action', async () => {
    window.history.replaceState(null, '', '/?cli_authorize=invalid!#cli');
    vi.mocked(useLedger).mockReturnValue(signedIn());
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('invalid');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Allow CLI access',
      ),
    ).toBe(false);
  });

  it('restores the fixed CLI settings route after an ordinary Google sign-in', async () => {
    window.sessionStorage.setItem('lobster-ledger-return-page', 'cli');
    window.history.replaceState(null, '', '/');
    vi.mocked(useLedger).mockReturnValue(signedIn());
    await act(async () => root.render(createElement(App)));
    expect(window.location.hash).toBe('#cli');
    expect(container.textContent).toContain('Connected command lines');
    expect(window.sessionStorage.getItem('lobster-ledger-return-page')).toBeNull();
  });

  it('opens a CLI-created bet link after sign-in', async () => {
    const ledger = signedIn();
    const bet = ledger.state.bets[0];
    window.history.replaceState(null, '', `/?bet=${encodeURIComponent(bet.id)}#ledger`);
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
    vi.mocked(useLedger).mockReturnValue(ledger);
    await act(async () => root.render(createElement(App)));
    expect(window.location.hash).toBe('#ledger');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(bet.title);
  });
});

describe('public guide sign-in reasons', () => {
  const reasonFor = () => {
    const button = container.querySelector<HTMLButtonElement>('button.cli-unavailable')!;
    expect(button.disabled).toBe(true);
    return container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent;
  };

  // jsdom serves http://localhost, where #mcp has no sign-in button; McpAccess.test.ts covers it.
  it('says sign-in cannot be reached during an outage instead of calling it unset', async () => {
    window.history.replaceState(null, '', '/#cli');
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configured: false,
      error: 'The shared ledger is unavailable. Try again, or explore the separate demo.',
    });
    await act(async () => root.render(createElement(App)));
    expect(reasonFor()).toBe('Sign-in can’t be reached right now. Try again shortly.');
    expect(container.textContent).not.toContain('isn’t set up');
  });

  it('keeps the not-set-up reason for a ledger without Google sign-in', async () => {
    window.history.replaceState(null, '', '/#cli');
    vi.mocked(useLedger).mockReturnValue({ ...signedOut, configured: false });
    await act(async () => root.render(createElement(App)));
    expect(reasonFor()).toBe('Google sign-in isn’t set up on this ledger yet.');
  });

  it('gives the sign-in request card the same outage reason', async () => {
    const request = {
      codeChallenge: 'a'.repeat(43),
      state: 'b'.repeat(43),
      deviceName: 'CLI laptop',
      redirectUri: 'http://127.0.0.1:49123/callback',
    };
    window.history.replaceState(
      null,
      '',
      `/?cli_authorize=${Buffer.from(JSON.stringify(request)).toString('base64url')}#cli`,
    );
    vi.mocked(useLedger).mockReturnValue({
      ...signedOut,
      configured: false,
      error: 'The shared ledger is unavailable. Try again, or explore the separate demo.',
    });
    await act(async () => root.render(createElement(App)));
    const button = container.querySelector<HTMLButtonElement>(
      '.cli-authorization button.cli-unavailable',
    )!;
    expect(button.disabled).toBe(true);
    expect(
      container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent,
    ).toBe('Sign-in can’t be reached right now. Try again shortly.');
  });
});

describe('demo sign-in request notices', () => {
  it('says once that the demo cannot connect a CLI, inside the request card, until it is cancelled', async () => {
    const request = {
      codeChallenge: 'a'.repeat(43),
      state: 'b'.repeat(43),
      deviceName: 'CLI laptop',
      redirectUri: 'http://127.0.0.1:49123/callback',
    };
    window.history.replaceState(
      null,
      '',
      `/?demo=1&cli_authorize=${Buffer.from(JSON.stringify(request)).toString('base64url')}#cli`,
    );
    vi.mocked(useLedger).mockReturnValue({ ...signedIn(), demo: true });
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector('.cli-authorization')).toBeTruthy();
    expect(container.querySelectorAll('.cli-demo-notice')).toHaveLength(1);
    expect(container.querySelector('.cli-guide > .connection-notice')).toBeNull();
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    await act(async () => cancel.click());
    expect(container.querySelector('.cli-authorization')).toBeNull();
    expect(container.querySelector('.cli-guide > .connection-notice')?.textContent).toContain(
      'This demo cannot connect a CLI',
    );
  });
});
