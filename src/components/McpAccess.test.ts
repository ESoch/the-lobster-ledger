// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpGuide } from './McpAccess';
import { READ_TOOL_COUNT, WRITE_TOOL_COUNT } from '../../worker/mcp-tool-catalog';

let root: Root;
let container: HTMLDivElement;
const props = {
  origin: 'https://my-ledger.example',
  signedIn: false,
  demo: false,
  onSignIn: vi.fn(),
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn());
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const render = (extra: Partial<typeof props & { signInAvailable: boolean }> = {}) =>
  act(async () => root.render(createElement(McpGuide, { ...props, ...extra })));
async function choose(client: string) {
  await act(async () =>
    container.querySelector<HTMLInputElement>(`input[value="${client}"]`)!.click(),
  );
}
describe('in-app MCP setup guide', () => {
  it('shows usable Claude setup steps without logging in or authorizing anything', async () => {
    await render();
    expect(container.textContent).toContain('https://my-ledger.example/mcp');
    expect(container.textContent).toContain('Register automatically');
    expect(container.textContent).toContain('Customize → Connectors');
    expect(container.textContent).toContain('Leave client secret');
    expect(container.querySelector('a[href="/oauth/connections"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Copy MCP server URL"]')!.click(),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
      'https://my-ledger.example/mcp',
    );
    expect(container.querySelector('.cli-copy-status')?.textContent).toBe('Copied');
  });
  it('generates Codex login scopes from the explicit permission choice and explains reauthorization', async () => {
    await render();
    await choose('codex');
    expect(container.textContent).toContain(
      'codex mcp add lobster-ledger --url https://my-ledger.example/mcp',
    );
    expect(container.textContent).toContain('codex mcp login lobster-ledger --scopes ledger:read');
    expect(container.textContent).not.toContain('--scopes ledger:read,ledger:write');
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(container.textContent).toContain('--scopes ledger:read,ledger:write');
    expect(container.textContent).toContain('A normal token refresh cannot add permissions');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('generates a Claude Code config with OAuth scope pinning and supports clipboard failures', async () => {
    await render();
    await choose('claude-code');
    expect(container.textContent).toContain('claude mcp add-json lobster-ledger');
    expect(container.textContent).toContain('"oauth":{"scopes":"ledger:read"}');
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(container.textContent).toContain('"scopes":"ledger:read ledger:write"');
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy Claude Code setup command"]')!
        .click(),
    );
    expect(container.textContent).toContain('Select and copy the text above');
  });
  it('counts the tools each grant exposes from the server catalog', async () => {
    await render();
    const step = container.querySelector('[aria-labelledby="mcp-review-title"]')!.textContent;
    expect(READ_TOOL_COUNT).toBe(7);
    expect(step).toContain(`Read access includes ${READ_TOOL_COUNT} tools`);
    expect(step).toContain(`write access adds ${WRITE_TOOL_COUNT} more`);
    expect(step).not.toContain('six tools');
  });
  it('tells Claude users their connector is read-only and where to get write access', async () => {
    await render();
    const step = container.querySelector('[aria-labelledby="mcp-client-title"]')!;
    expect(step.querySelector('input[type="checkbox"]')).toBeNull();
    expect(step.textContent).toContain('Claude’s connector is read-only');
    expect(step.textContent).toContain('use Claude Code or Codex with write access');
    const aside = container.querySelector('aside')!.textContent;
    expect(aside).toContain('Write access is available in Claude Code and Codex');
  });
  it('gives each client a working remedy when only read tools appear', async () => {
    await render();
    const answer = [...container.querySelectorAll('details')].find((item) =>
      item.querySelector('summary')?.textContent?.includes('Only read tools appear'),
    )!.textContent;
    expect(answer).toContain('Claude’s connector is read-only');
    expect(answer).toContain('claude mcp remove lobster-ledger --scope user');
    expect(answer).toContain('codex mcp login');
    expect(answer).toContain('A normal token refresh cannot add permissions');
  });
  it('uses the app page heading and titled panels, with an icon on every aside card', async () => {
    await render();
    expect(container.querySelector('.page-heading h1')?.textContent).toBe(
      'Your ledger, connected to AI.',
    );
    expect(container.querySelector('.cli-intro')).toBeNull();
    const panels = [...container.querySelectorAll('section')];
    expect(panels).toHaveLength(6);
    for (const panel of panels) {
      expect(panel.classList.contains('panel')).toBe(true);
      const heading = panel.querySelector(':scope > .section-title h2')!;
      expect(panel.getAttribute('aria-labelledby')).toBe(heading.id);
    }
    const aside = [...container.querySelectorAll('aside .section-title')];
    expect(aside).toHaveLength(2);
    for (const title of aside) expect(title.querySelector('svg + h2')).toBeTruthy();
  });
  it('links real members to app management while keeping demo and local preview guidance separate', async () => {
    await render({ signedIn: true });
    expect(container.querySelector('a[href="/oauth/connections"]')?.textContent).toContain(
      'Manage connected apps',
    );
    await render({ signedIn: true, demo: true });
    expect(container.querySelector('a[href="/oauth/connections"]')).toBeNull();
    expect(container.textContent).toContain('demo cannot connect an AI app');
    await render({ origin: 'http://127.0.0.1:5173', signedIn: true });
    expect(container.textContent).toContain('https://your-ledger.example/mcp');
    expect(container.textContent).toContain('local preview');
    expect(container.querySelector('a[href="/oauth/connections"]')).toBeNull();
  });
  it('summarises the access the checkbox grants next to it, for read-only and for write', async () => {
    await render();
    await choose('claude-code');
    const summary = () => container.querySelector('.mcp-access-state')!;
    expect(summary().getAttribute('role')).toBe('status');
    expect(summary().textContent).toContain('Read only');
    expect(summary().textContent).toContain('not change anything');
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(summary().textContent).toContain('Read and write');
    expect(summary().textContent).toContain(`adds ${WRITE_TOOL_COUNT} tools`);
    await choose('claude');
    expect(container.querySelector('.mcp-access-state')).toBeNull();
  });
  it('links the live ledger from the demo notice', async () => {
    await render({ demo: true });
    const notice = container.querySelector('.connection-notice')!;
    expect(notice.textContent).toContain('This demo cannot connect an AI app');
    expect(notice.querySelector('a[href="/"]')?.textContent).toBe('live ledger');
  });
  it('does not stack a second sign-in notice on an instance without Google sign-in', async () => {
    await render({ signInAvailable: false });
    expect(container.querySelector('.connection-notice')).toBeNull();
    expect(container.textContent).not.toContain('Setup instructions are available');
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Sign in to manage apps'),
    )!;
    expect(button.disabled).toBe(true);
    expect(button.classList.contains('cli-unavailable')).toBe(true);
    expect(
      container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent,
    ).toContain('Google sign-in isn’t set up');
  });
  it('gives the reason it is handed for a sign-in that cannot be reached', async () => {
    await act(async () =>
      root.render(
        createElement(McpGuide, {
          ...props,
          signInAvailable: false,
          signInUnavailableReason: 'Sign-in can’t be reached right now. Try again shortly.',
        }),
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('button.cli-unavailable')!;
    expect(
      container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent,
    ).toBe('Sign-in can’t be reached right now. Try again shortly.');
  });
  it('tells people which links open a new tab and which stay in the app', async () => {
    await render({ signedIn: true });
    const external = [...container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')];
    expect(external.length).toBeGreaterThan(0);
    for (const link of external) {
      expect(link.querySelector('.sr-only')?.textContent?.trim()).toBe('(opens in a new tab)');
      expect(link.querySelector('.lucide-external-link')).toBeTruthy();
    }
    for (const client of ['claude-code', 'codex']) {
      await choose(client);
      for (const link of container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]'))
        expect(link.querySelector('.sr-only')?.textContent?.trim()).toBe('(opens in a new tab)');
    }
    const manage = container.querySelector<HTMLAnchorElement>('a[href="/oauth/connections"]')!;
    expect(manage.hasAttribute('target')).toBe(false);
    expect(manage.querySelector('.lucide-external-link')).toBeNull();
    expect(manage.querySelector('.lucide-arrow-right')).toBeTruthy();
    expect(manage.textContent).not.toContain('new tab');
  });
  it('makes each vendor guide, which sits alone in its paragraph, a tap target of its own', async () => {
    await render();
    for (const client of ['claude', 'claude-code', 'codex']) {
      await choose(client);
      const links = [...container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')];
      expect(links).toHaveLength(1);
      expect(links[0].classList.contains('cli-standalone-link')).toBe(true);
      expect(links[0].parentElement?.tagName).toBe('P');
      expect(links[0].parentElement?.textContent?.trim()).toBe(links[0].textContent?.trim());
    }
  });
  it('tells a member that write access also corrects and withdraws price reports, everywhere it lists the tools', async () => {
    await render();
    const review = container.querySelector('[aria-labelledby="mcp-review-title"]')!.textContent;
    expect(review).toMatch(/correct or withdraw (your own )?price reports/);
    expect(container.querySelector('aside')!.textContent).toMatch(
      /correct,? (and|or) withdraw (your own )?price reports/,
    );
    await choose('claude-code');
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(container.querySelector('.mcp-access-state')!.textContent).toMatch(
      /correct or withdraw (your own )?price reports/,
    );
  });
});
