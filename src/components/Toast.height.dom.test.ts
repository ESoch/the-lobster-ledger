// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, useToast } from './Toast';

// A toast lies over the foot of the bet sheet on a phone or tablet, and how tall it is depends on how
// the copy wraps at that width. The sheet pads its end by the toast's own height (toast.css), so the
// card publishes it as --toast-height on the document element for as long as it is on screen.

let root: Root;
let container: HTMLDivElement;
let show: (text: string) => void;
let dismiss: () => void;
let cardHeight = 106;
let observed: ResizeObserverCallback | null = null;

function Harness() {
  const toasts = useToast();
  show = toasts.show;
  dismiss = toasts.dismiss;
  return createElement(ToastRegion, { toast: toasts.toast, onDismiss: toasts.dismiss });
}

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observed = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    observed = null;
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cardHeight = 106;
  observed = null;
  // jsdom lays nothing out: the card reports the height a 320px window would give a four line toast.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height = this.classList.contains('toast') ? cardHeight : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: height, width: 0, height } as DOMRect;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const property = () => document.documentElement.style.getPropertyValue('--toast-height');
const render = () => act(async () => root.render(createElement(Harness)));
const say = (text: string) => act(async () => show(text));

describe('toast height for the sheet', () => {
  it('publishes the toast’s height while it is on screen and takes it back when it goes', async () => {
    await render();
    expect(property()).toBe('');
    await say('You disagreed with the recommendation. The bet is back in play.');
    expect(property()).toBe('106px');
    await act(async () => dismiss());
    expect(property()).toBe('');
  });

  it('rounds a fractional height up, so the sheet never pads a pixel short', async () => {
    cardHeight = 84.2;
    await render();
    await say('Saved.');
    expect(property()).toBe('85px');
  });

  it('follows the card when its copy wraps differently, as the window is resized', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    await render();
    await say('You disagreed with the recommendation. The bet is back in play.');
    expect(property()).toBe('106px');
    cardHeight = 64;
    await act(async () => observed?.([], {} as ResizeObserver));
    expect(property()).toBe('64px');
  });

  it('measures the replacement when one toast follows another, never leaving the old height', async () => {
    await render();
    await say('First, which wraps onto several lines.');
    expect(property()).toBe('106px');
    cardHeight = 43;
    await say('Second.');
    expect(property()).toBe('43px');
  });

  it('is cleared when the region goes, even with a toast still showing', async () => {
    await render();
    await say('Saved.');
    expect(property()).toBe('106px');
    await act(async () => root.render(createElement('div')));
    expect(property()).toBe('');
  });

  it('stops watching the card once it is gone', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    await render();
    await say('Saved.');
    expect(observed).not.toBeNull();
    await act(async () => dismiss());
    expect(observed).toBeNull();
  });
});
