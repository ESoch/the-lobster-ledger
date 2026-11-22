// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { NewBetDialog } from './NewBetDialog';

const demo = createDemoState();
let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  // jsdom has no layout: give the picker map the size it has in the dialog.
  const mapSize = (pixels: number) =>
    function (this: HTMLElement) {
      return this.classList.contains('places-map-canvas') ? pixels : 0;
    };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: mapSize(560),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: mapSize(240),
  });
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: { initialPlaceId?: string } = {}) {
  await act(async () =>
    root.render(
      createElement(NewBetDialog, {
        open: true,
        onClose: vi.fn(),
        state: demo,
        memberId: 'ellis',
        onCreate: vi.fn(async () => {}),
        ...props,
      }),
    ),
  );
}
const locationSelect = () =>
  [...document.querySelectorAll('select')].find((select) =>
    [...select.options].some((option) => option.value === 'custom'),
  )!;
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element);
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
async function openPicker() {
  await change(locationSelect(), 'custom');
  for (let tries = 0; tries < 50 && !document.querySelector('.places-map-canvas'); tries++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(document.querySelector('.places-map-canvas')).not.toBeNull();
}
const nameInput = () =>
  document.querySelector<HTMLInputElement>('input[placeholder="e.g. The office kitchen"]')!;
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
// What is announced, and what is shown: the first waits for the name field to be left.
const status = () =>
  document.querySelector('.custom-place .pin-status [role="status"]')?.textContent;
const shown = () => document.querySelector('.custom-place .pin-status-text')?.textContent;

describe('pinning a new location', () => {
  it('confirms the pin by name in a status line and can clear it', async () => {
    await render();
    await openPicker();
    expect(status()).toContain('No pin yet');
    await change(nameInput(), 'The office kitchen');
    await act(async () => button('Use map center')!.click());
    expect(status()).toContain('The office kitchen is pinned');
    expect(status()).not.toMatch(/-?\d+\.\d{4}/);
    const clear = button('Clear pin')!;
    clear.focus();
    await act(async () => clear.click());
    expect(status()).toContain('No pin yet');
    expect(document.querySelector('.places-map-picked-pin')).toBeNull();
    // The button is gone; focus stays in the picker instead of jumping to the top of the form.
    expect(button('Clear pin')).toBeUndefined();
    expect(document.activeElement).toBe(button('Use map center'));
  });

  it('shows the name as it is typed after the map was tapped first, and announces it on leaving the field', async () => {
    await render();
    await openPicker();
    await act(async () => button('Use map center')!.click());
    expect(shown()).toBe('Your pin is placed. Name the location above.');
    nameInput().focus();
    await change(nameInput(), 'The office kitchen');
    // The words on screen follow the field, so they never contradict what it holds.
    expect(shown()).toBe('The office kitchen is pinned.');
    // The announcement is not repeated with every key; it comes when the field is left.
    expect(status()).toBe('Your pin is placed. Name the location above.');
    await act(async () => nameInput().blur());
    expect(status()).toBe('The office kitchen is pinned.');
    // What the status line shows is not read out a second time as plain text.
    expect(
      document.querySelector('.custom-place .pin-status-text')!.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('keeps a placed pin as the new pin, never as a saved place, when the picker reopens', async () => {
    await render();
    await openPicker();
    await change(nameInput(), 'The office kitchen');
    await act(async () => button('Use map center')!.click());
    expect(document.querySelectorAll('.places-map-picked-pin')).toHaveLength(1);
    await change(locationSelect(), 'fan-pier');
    expect(document.querySelector('.custom-place')).toBeNull();
    await openPicker();
    expect(document.querySelectorAll('.places-map-picked-pin')).toHaveLength(1);
    // Everything else on the map is a quiet reference pin for a saved place.
    const others = document.querySelectorAll('.leaflet-marker-icon:not(.places-map-picked-pin)');
    expect(others.length).toBeGreaterThan(0);
    for (const marker of others) {
      expect(marker.classList.contains('leaflet-interactive')).toBe(false);
      expect(marker.getAttribute('title') ?? '').not.toContain('office kitchen');
    }
    expect(status()).toContain('The office kitchen is pinned');
    await act(async () => button('Clear pin')!.click());
    expect(document.querySelector('.places-map-picked-pin')).toBeNull();
    expect(status()).toContain('No pin yet');
  });

  it('gives one device-neutral instruction and keeps saved places out of the tab order', async () => {
    await render();
    await openPicker();
    const picker = document.querySelector('.custom-place')!;
    expect(picker.textContent).not.toMatch(/(Tap|Click) the map/);
    const markers = picker.querySelectorAll('.leaflet-marker-icon');
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) expect(marker.hasAttribute('tabindex')).toBe(false);
    const focusable = [...picker.querySelectorAll<HTMLElement>('input, button, [tabindex="0"]')];
    expect(focusable[0]).toBe(nameInput());
    expect(focusable[1].textContent).toContain('Use map center');
  });

  it('names a missing name or pin under the name field, and drops it when the Location choice changes', async () => {
    await render();
    await openPicker();
    const submit = async () => act(async () => document.querySelector('form')!.requestSubmit());
    const slot = () => document.querySelector('.custom-place .field > .field-error');
    await submit();
    expect(slot()?.textContent).toBe('Name the location you are pinning.');
    // With the field that holds focus, above the map, so it is in view when the name is.
    expect(nameInput().closest('label')!.nextElementSibling).toBe(slot());
    expect(nameInput().getAttribute('aria-describedby')).toContain(slot()!.id);
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    // Typing the name answers it; a pin still missing is named in the same place.
    await change(nameInput(), 'The office kitchen');
    expect(slot()).toBeNull();
    await submit();
    expect(slot()?.textContent).toBe('Choose a point on the map for this location.');
    expect(document.querySelector('.field-error-list')).toBeNull();
    // Another Location choice answers it, and it does not wait when the picker comes back.
    await change(locationSelect(), 'fan-pier');
    expect(document.querySelector('.field-error-list')).toBeNull();
    await openPicker();
    expect(slot()).toBeNull();
    expect(nameInput().hasAttribute('aria-invalid')).toBe(false);
  });

  it('starts with a saved place chosen when opened from that place', async () => {
    await render({ initialPlaceId: 'fan-pier' });
    expect(locationSelect().value).toBe('fan-pier');
  });
});
