// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createDemoState } from './lib/demo';
import type { LedgerState } from './lib/types';

vi.mock('./components/MapView', () => ({ MapView: () => null }));

let root: Root;
let container: HTMLDivElement;
let ledger: LedgerState;
let saves: string[];
let saveReply: () => Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/#members');
  ledger = createDemoState();
  saves = [];
  saveReply = async () => {
    const member = { ...ledger.members[0], name: saves.at(-1)!, initials: 'CE' };
    ledger = { ...ledger, members: [member, ...ledger.members.slice(1)] };
    return json({ member });
  };
  vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
    if (path === '/api/config') return json({ configured: true, groupName: 'Test ledger' });
    if (path === '/api/session') return json({ member: ledger.members[0] });
    if (path === '/api/ledger') return json(ledger);
    if (path === '/api/profile' && options?.method === 'PATCH') {
      saves.push((JSON.parse(String(options.body)) as { name: string }).name);
      return saveReply();
    }
    if (path === '/api/invites') return json({ invites: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
const nameField = () => dialog()!.querySelector<HTMLInputElement>('input[name="name"]')!;
const accountButton = () => document.querySelector<HTMLButtonElement>('.profile-button')!;
const namedButton = (name: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === name,
  )!;
const click = (element: HTMLElement) => act(async () => element.click());
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
async function openProfile() {
  await click(accountButton());
  const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === 'Edit profile',
  );
  expect(edit, 'the account menu offers Edit profile').toBeDefined();
  await click(edit!);
  expect(dialog()?.textContent).toContain('Edit profile');
}
async function mount() {
  await act(async () => root.render(createElement(App)));
  await settle();
  await openProfile();
}
async function type(value: string) {
  await act(async () => {
    const input = nameField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () =>
  act(async () => dialog()!.querySelector('form')!.requestSubmit(namedButton('Save changes')));

describe('editing the signed-in profile', () => {
  it('prefills the current display name and saves it across the account menu and member roster', async () => {
    await mount();
    expect(nameField().value).toBe('Ellis');
    expect(nameField().labels?.[0].textContent).toContain('Display name');
    await type('  Captain   Ellis  ');
    await submit();
    expect(saves).toEqual(['Captain Ellis']);
    expect(dialog()).toBeNull();
    expect(accountButton().getAttribute('aria-label')).toBe('Account menu, Captain Ellis');
    expect(accountButton().textContent).toBe('CE');
    expect(document.querySelector('main')?.textContent).toContain('Captain Ellis');
    expect(document.body.textContent).toContain('Display name updated.');
    await openProfile();
    expect(nameField().value).toBe('Captain Ellis');
  });

  it.each(['   ', 'x'.repeat(101)])(
    'keeps an invalid name in the form with a focused field error',
    async (name) => {
      await mount();
      await type(name);
      await submit();
      expect(saves).toEqual([]);
      expect(nameField().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(nameField());
      expect(nameField().value).toBe(name);
      await type('Captain Ellis');
      expect(nameField().hasAttribute('aria-invalid')).toBe(false);
    },
  );

  it('rejects another member’s name but allows the current member to change their own capitalization', async () => {
    await mount();
    await type(ledger.members[1].name.toUpperCase());
    await submit();
    expect(saves).toEqual([]);
    expect(dialog()?.textContent).toContain('already at the table');
    await type('ELLIS');
    await submit();
    expect(saves).toEqual(['ELLIS']);
    expect(dialog()).toBeNull();
  });

  it.each([400, 500])('retains the draft and reports a server refusal (%s)', async (status) => {
    saveReply = async () => json({ error: 'This name could not be saved.' }, status);
    await mount();
    await type('Captain Ellis');
    await submit();
    expect(nameField().value).toBe('Captain Ellis');
    expect(dialog()?.textContent).toContain('This name could not be saved.');
    expect(accountButton().getAttribute('aria-label')).toBe('Account menu, Ellis');
    expect(namedButton('Save changes').getAttribute('aria-busy')).not.toBe('true');
  });

  it('prevents duplicate submissions and keeps the form open while saving', async () => {
    let release!: (response: Response) => void;
    saveReply = () => new Promise((resolve) => (release = resolve));
    await mount();
    await type('Captain Ellis');
    await submit();
    const saving = namedButton('Saving…');
    expect(saving.getAttribute('aria-busy')).toBe('true');
    expect(nameField().readOnly).toBe(true);
    await act(async () => dialog()!.querySelector('form')!.requestSubmit(saving));
    expect(saves).toEqual(['Captain Ellis']);
    await click(namedButton('Cancel'));
    expect(dialog()).not.toBeNull();
    await act(async () => release(json({ error: 'Try again later.' }, 503)));
    expect(nameField().readOnly).toBe(false);
    expect(nameField().value).toBe('Captain Ellis');
  });

  it('confirms discarding an unsaved name and restores focus to the account button', async () => {
    await mount();
    await type('Captain Ellis');
    await click(namedButton('Cancel'));
    expect(dialog()?.textContent).toContain('Keep editing');
    await click(namedButton('Keep editing'));
    expect(nameField().value).toBe('Captain Ellis');
    await click(namedButton('Cancel'));
    const discard = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Discard'),
    )!;
    await click(discard);
    await settle();
    expect(dialog()).toBeNull();
    expect(saves).toEqual([]);
    expect(document.activeElement).toBe(accountButton());
  });
});
