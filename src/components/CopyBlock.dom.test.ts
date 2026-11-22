// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandText, CopyBlock } from './CopyBlock';

let root: Root;
let container: HTMLDivElement;
const writeText = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (value: string, label = 'install command') =>
  act(async () => root.render(createElement(CopyBlock, { value, label })));
const status = () => container.querySelector<HTMLElement>('.cli-copy-status')!;
const copy = (label = 'install command') =>
  act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${label}"]`)!.click(),
  );

describe('shared copy block', () => {
  it('reserves its status line before anything is copied', async () => {
    await render('lobster auth login');
    expect(status()).toBeTruthy();
    expect(status().getAttribute('role')).toBe('status');
    expect(status().textContent).toBe('');
  });

  it('confirms a copy with "Copied" and resets two seconds after the latest copy', async () => {
    vi.useFakeTimers();
    await render('lobster auth login');
    await copy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('lobster auth login');
    expect(status().textContent).toBe('Copied');
    expect(status().classList.contains('is-error')).toBe(false);
    await act(async () => vi.advanceTimersByTime(1500));
    await copy();
    await act(async () => vi.advanceTimersByTime(1500));
    expect(status().textContent).toBe('Copied');
    await act(async () => vi.advanceTimersByTime(500));
    expect(status().textContent).toBe('');
  });

  it('shows a failed copy in the error tone with a manual fallback', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    await render('lobster auth login');
    await copy();
    expect(status().classList.contains('is-error')).toBe(true);
    expect(status().textContent).toContain('Select and copy the text above');
  });

  it('clears an earlier result when the command changes', async () => {
    await render('codex mcp login lobster-ledger --scopes ledger:read', 'Codex login command');
    await copy('Codex login command');
    await render(
      'codex mcp login lobster-ledger --scopes ledger:read,ledger:write',
      'Codex login command',
    );
    expect(status().textContent).toBe('');
  });
});

describe('command text', () => {
  const tokens = () => [...container.querySelectorAll<HTMLElement>('.cli-token')];

  it('keeps the exact command text and every flag whole', async () => {
    const command = 'lobster bets create --file bet.json --dry-run';
    await render(command);
    expect(container.querySelector('pre code')!.textContent).toBe(command);
    expect(tokens().map((token) => token.textContent)).toEqual([
      'lobster',
      'bets',
      'create',
      '--file',
      'bet.json',
      '--dry-run',
    ]);
    expect(container.querySelector('wbr')).toBeNull();
  });

  it('lets long addresses wrap only between path segments and host labels', async () => {
    const url = 'https://lobster-ledger.example.org/downloads/cli-0.1.0.tgz';
    await act(async () =>
      root.render(createElement(CommandText, { value: `npm install -g ${url}` })),
    );
    expect(container.textContent).toBe(`npm install -g ${url}`);
    const parts = [...container.querySelectorAll('.cli-token-part')].map(
      (part) => part.textContent,
    );
    expect(parts).toEqual([
      'https://',
      'lobster-ledger',
      '.example',
      '.org/',
      'downloads/',
      'cli-0.1.0',
      '.tgz',
    ]);
    expect(container.querySelectorAll('wbr')).toHaveLength(parts.length - 1);
    expect(tokens().find((token) => token.textContent === '-g')).toBeTruthy();
  });

  it('gives inline JSON configuration break points after commas and braces', async () => {
    const json = `'{"type":"http","url":"https://ledger.example/mcp","oauth":{"scopes":"ledger:read"}}'`;
    await act(async () => root.render(createElement(CommandText, { value: json })));
    const parts = [...container.querySelectorAll('.cli-token-part')].map(
      (part) => part.textContent,
    );
    expect(parts.join('')).toBe(json);
    expect(Math.max(...parts.map((part) => part!.length))).toBeLessThanOrEqual(26);
  });
});
