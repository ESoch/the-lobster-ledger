// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, useToast } from './Toast';
import { Modal } from './ui';

// An open dialog or bet sheet keeps Tab inside itself, so the keyboard cannot reach the toast's
// Dismiss button or pause it by focusing it. Escape dismisses the toast before it closes the dialog,
// and moving through the dialog with Tab holds the toast the way focusing it would.

let root: Root;
let container: HTMLDivElement;
let show: (text: string) => void;

function Harness() {
  const toasts = useToast();
  const [open, setOpen] = useState(false);
  show = toasts.show;
  return createElement(
    'div',
    null,
    createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open the sheet'),
    createElement(Modal, {
      open,
      onClose: () => setOpen(false),
      title: 'Bet details',
      sheet: true,
      children: createElement(
        'div',
        null,
        createElement('button', { id: 'first' }, 'Agree to bet'),
        createElement('button', { id: 'second' }, 'Decline'),
      ),
    }),
    createElement(ToastRegion, { toast: toasts.toast, onDismiss: toasts.dismiss }),
  );
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

const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const toast = () => document.querySelector('.toast');
const dialog = () => document.querySelector('[role="dialog"]');
const byId = (id: string) => document.getElementById(id)!;
async function openSheet() {
  await act(async () => root.render(createElement(Harness)));
  byId('opener').focus();
  await act(async () => byId('opener').click());
  await tick(20);
  expect(dialog()).not.toBeNull();
}
const say = (text: string) => act(async () => show(text));
async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
  await tick(20);
}

describe('a toast over an open dialog', () => {
  it('goes with the first Escape, and the dialog stays open until the next', async () => {
    await openSheet();
    await say('You declined Sarah’s proposal.');
    expect(toast()).not.toBeNull();
    await press(document.activeElement!, 'Escape');
    expect(toast()).toBeNull();
    expect(dialog()).not.toBeNull();
    await press(document.activeElement!, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(byId('opener'));
  });

  it('leaves Escape to the dialog when no toast is showing', async () => {
    await openSheet();
    await press(document.activeElement!, 'Escape');
    expect(dialog()).toBeNull();
  });

  it('holds while the keyboard moves through the dialog, as focusing it would', async () => {
    await openSheet();
    await say('Saved.');
    await tick(1000);
    await press(byId('first'), 'Tab');
    await tick(60_000);
    expect(toast()).not.toBeNull();
    // Escape still dismisses it at once.
    await press(byId('first'), 'Escape');
    expect(toast()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it('lets go when the pointer is used, with the time it had left', async () => {
    await openSheet();
    await say('Saved.');
    await tick(5000);
    await press(byId('first'), 'Tab');
    await tick(60_000);
    await act(async () => {
      byId('second').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await tick(900);
    expect(toast()).not.toBeNull();
    await tick(200);
    expect(toast()).toBeNull();
  });

  it('lets go once focus is back out of the dialog', async () => {
    await openSheet();
    await say('Saved.');
    await press(byId('first'), 'Tab');
    await tick(60_000);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click(),
    );
    await tick(20);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(byId('opener'));
    expect(toast()).not.toBeNull();
    await tick(6100);
    expect(toast()).toBeNull();
  });

  it('keeps its time when it lies over the dialog, so it never hides the dialog for long', async () => {
    // jsdom has no layout: the sheet and the toast report where a phone would put them.
    const boxes = new Map<string, DOMRect>([
      ['dialog', DOMRect.fromRect({ x: 0, y: 0, width: 390, height: 844 })],
      ['toast', DOMRect.fromRect({ x: 12, y: 760, width: 366, height: 72 })],
    ]);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('[role="dialog"]')) return boxes.get('dialog')!;
      if (this.matches('.toast')) return boxes.get('toast')!;
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    await openSheet();
    await say('Saved.');
    await press(byId('first'), 'Tab');
    await tick(6100);
    expect(toast()).toBeNull();
    spy.mockRestore();
  });

  describe('when the dialog has shrunk to make room for it', () => {
    // jsdom has no layout: the dialog and the toast report where a short window would put them.
    const lay = (dialogHeight: number) =>
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        if (this.matches('[role="dialog"]'))
          return DOMRect.fromRect({ x: 100, y: 12, width: 600, height: dialogHeight });
        if (this.matches('.toast'))
          return DOMRect.fromRect({ x: 100, y: 12 + dialogHeight + 12, width: 420, height: 64 });
        return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
      });

    it('is held while Tab moves through it, when the form still has room', async () => {
      const spy = lay(300);
      await openSheet();
      await say('Saved.');
      await press(byId('first'), 'Tab');
      await tick(60_000);
      expect(toast()).not.toBeNull();
      spy.mockRestore();
    });

    it('is not held when the dialog is too short to type in, so it gives the room back', async () => {
      // A form seen through 58px, as at 1280x1024 zoomed to 400%, is no place to keep tabbing.
      const spy = lay(136);
      await openSheet();
      await say('Saved.');
      await press(byId('first'), 'Tab');
      await tick(6100);
      expect(toast()).toBeNull();
      spy.mockRestore();
    });
  });

  it('runs out as usual when Tab is used outside any dialog, where it can reach the toast', async () => {
    await act(async () => root.render(createElement(Harness)));
    await say('Saved.');
    await press(byId('opener'), 'Tab');
    await tick(6100);
    expect(toast()).toBeNull();
  });
});
