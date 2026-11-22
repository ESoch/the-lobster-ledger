// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toastDuration, useToast, type ToastTone } from './Toast';

let root: Root;
let container: HTMLDivElement;
let show: (text: string, tone?: ToastTone) => void;

function Harness() {
  const toasts = useToast();
  show = toasts.show;
  return createElement(ToastRegion, { toast: toasts.toast, onDismiss: toasts.dismiss });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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

const render = () => act(async () => root.render(createElement(Harness)));
const say = (text: string, tone?: ToastTone) => act(async () => show(text, tone));
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const region = (role: 'status' | 'alert') =>
  document.querySelector<HTMLElement>(`.toast-region [role="${role}"]`)!;

describe('toastDuration', () => {
  it('is six seconds for a short line and scales with length for a long one', () => {
    expect(toastDuration('Saved $32.00 at North Pier Café.')).toBe(6000);
    expect(toastDuration('x'.repeat(100))).toBe(6000);
    expect(toastDuration('x'.repeat(200))).toBe(12_000);
  });
});

describe('ToastRegion', () => {
  it('mounts both live regions before anything is said, outside the app root', async () => {
    await render();
    expect(region('status').getAttribute('aria-live')).toBe('polite');
    expect(region('status').getAttribute('aria-atomic')).toBe('true');
    expect(region('alert').getAttribute('aria-live')).toBe('assertive');
    expect(document.querySelector('.toast-region')!.parentElement).toBe(document.body);
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('puts a success toast in the polite region and an error in the alert region', async () => {
    await render();
    await say('Saved $32.00 at North Pier Café.');
    expect(region('status').textContent).toContain('Saved $32.00');
    expect(region('alert').textContent).toBe('');
    expect(document.querySelector('.toast')!.getAttribute('data-tone')).toBe('success');
    await say('Unable to sign out. Please try again.', 'error');
    expect(region('alert').textContent).toContain('Unable to sign out');
    expect(region('status').textContent).toBe('');
    expect(document.querySelector('.toast')!.getAttribute('data-tone')).toBe('error');
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
  });

  it('shows one toast at a time: a new one replaces the old', async () => {
    await render();
    await say('First.');
    await say('Second.');
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
    expect(region('status').textContent).toContain('Second.');
  });

  it('re-mounts the toast for a repeated message, so it is announced again', async () => {
    await render();
    await say('Terms agreed with Sarah. The bet is on.');
    const first = document.querySelector('.toast');
    await say('Terms agreed with Sarah. The bet is on.');
    expect(document.querySelector('.toast')).not.toBe(first);
  });

  it('dismisses from its close button', async () => {
    await render();
    await say('Saved.');
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')!
        .click(),
    );
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('keeps a long message up for 60ms a character', async () => {
    await render();
    await say('x'.repeat(200));
    await tick(11_900);
    expect(document.querySelector('.toast')).not.toBeNull();
    await tick(200);
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('lets a paused toast keep the time it had left, not start over', async () => {
    await render();
    await say('Saved.');
    await tick(5000);
    const toast = document.querySelector<HTMLElement>('.toast')!;
    await act(async () => {
      toast.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
      );
    });
    await tick(60_000);
    expect(document.querySelector('.toast')).not.toBeNull();
    await act(async () => {
      toast.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    await tick(900);
    expect(document.querySelector('.toast')).not.toBeNull();
    await tick(200);
    expect(document.querySelector('.toast')).toBeNull();
  });
});
