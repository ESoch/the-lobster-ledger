// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import L from 'leaflet';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import type { Place } from '../lib/types';
import { PlacesMap, fitPlaces } from './PlacesMap';
import { Modal } from './ui';

const demo = createDemoState();
const MAP_SIZE = { width: 800, height: 480 };
let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  // jsdom has no layout: give map canvases a real size so Leaflet can fit views.
  const sized = (element: Element) =>
    element.classList.contains('places-map-canvas') || element.hasAttribute('data-test-map');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return sized(this) ? MAP_SIZE.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return sized(this) ? MAP_SIZE.height : 0;
    },
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
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Props = Parameters<typeof PlacesMap>[0];
async function render(props: Partial<Props> = {}) {
  await act(async () =>
    root.render(createElement(PlacesMap, { places: demo.places, bets: demo.bets, ...props })),
  );
}
const markerFor = (name: string) =>
  document.querySelector<HTMLElement>(`.leaflet-marker-icon[title^="${name}"]`)!;
const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
const press = (target: Element, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
const click = (target: Element, init: MouseEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
const popupTitle = () =>
  document.querySelector('.leaflet-popup .places-map-popup strong')?.textContent ?? null;

describe('fitting places', () => {
  it('chooses a zoom at which the four demo places are at least 44px apart', () => {
    const node = document.createElement('div');
    node.setAttribute('data-test-map', '');
    document.body.appendChild(node);
    const map = L.map(node, { center: [39, -98], zoom: 3 });
    const zoom = fitPlaces(map, demo.places);
    const points = demo.places.map((place) => map.project([place.lat, place.lng], zoom));
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        expect(points[i].distanceTo(points[j])).toBeGreaterThanOrEqual(44);
    expect(zoom).toBeLessThanOrEqual(16);
    for (const place of demo.places)
      expect(map.getBounds().contains([place.lat, place.lng])).toBe(true);
    map.remove();
  });

  it('groups places that would still overlap into one cluster pin', async () => {
    const twin: Place = { ...demo.places[0], id: 'twin', name: 'Long Wharf Dock B' };
    await render({ places: [...demo.places, twin] });
    const cluster = document.querySelector<HTMLElement>('.leaflet-marker-icon.is-cluster');
    expect(cluster?.getAttribute('aria-label')).toMatch(/2 places/);
    expect(markerFor('Long Wharf Dock B')).toBeNull();
  });

  it('marks a group count as places, so it never reads as a bet count', async () => {
    const twin: Place = { ...demo.places[0], id: 'twin', name: 'Long Wharf Dock B' };
    await render({ places: [...demo.places, twin] });
    const group = document.querySelector('.leaflet-marker-icon.is-cluster .places-map-pin')!;
    expect(group.querySelector('svg.places-map-pin-glyph')).not.toBeNull();
    expect(group.textContent).toBe('2');
    const single = markerFor('Fan Pier Park').querySelector('.places-map-pin')!;
    expect(single.querySelector('svg')).toBeNull();
    expect(Number(single.textContent)).toBeGreaterThan(0);
  });

  it('lists places that share a spot and selects the one chosen', async () => {
    const onSelectPlace = vi.fn();
    const twin: Place = { ...demo.places[0], id: 'twin', name: 'Long Wharf Dock B' };
    await render({ places: [...demo.places, twin], onSelectPlace });
    await click(document.querySelector('.leaflet-marker-icon.is-cluster')!);
    expect(document.querySelector('.leaflet-popup strong')?.textContent).toBe(
      '2 places at this spot',
    );
    const choice = [...document.querySelectorAll<HTMLButtonElement>('.leaflet-popup li button')];
    await click(choice.find((button) => button.textContent?.includes('Dock B'))!);
    expect(onSelectPlace).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'twin' }));
    expect(popupTitle()).toBe('Long Wharf Dock B');
  });
});

describe('selecting places on the map', () => {
  it('keeps the selected pin on top and reopens its popup when clicked again', async () => {
    await render({ selectedPlaceId: 'long-wharf' });
    expect(popupTitle()).toBe('Long Wharf');
    const selected = markerFor('Long Wharf');
    for (const other of document.querySelectorAll<HTMLElement>('.leaflet-marker-icon'))
      if (other !== selected)
        expect(Number(selected.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
    await click(document.querySelector('.leaflet-popup-close-button')!);
    expect(popupTitle()).toBeNull();
    await click(markerFor('Long Wharf'));
    expect(popupTitle()).toBe('Long Wharf');
  });

  it('keeps the map credits in a strip under the map, so no pin ever sits beneath them', async () => {
    await render({ selectedPlaceId: 'long-wharf' });
    const map = document.querySelector('.places-map')!;
    const canvas = map.querySelector('.places-map-canvas')!;
    const strip = map.querySelector('.places-map-credit')!;
    expect(strip.parentElement).toBe(map);
    expect(canvas.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The chip and Leaflet's own attribution live in the strip, and nothing but pins and the zoom
    // control is left on the map.
    expect(strip.querySelector('.places-map-external')).not.toBeNull();
    const credit = strip.querySelector('.leaflet-control-attribution')!;
    expect(credit.textContent).toContain('OpenStreetMap');
    expect(credit.querySelector('a[href*="openstreetmap.org/copyright"]')).not.toBeNull();
    expect(canvas.contains(strip)).toBe(false);
    expect(canvas.querySelector('.places-map-external, .leaflet-control-attribution')).toBeNull();
  });

  it('credits the map in the strip even when there are no places to link to', async () => {
    await render({ places: [], bets: [] });
    const strip = document.querySelector('.places-map-credit')!;
    expect(strip.querySelector('.leaflet-control-attribution')).not.toBeNull();
    expect(strip.querySelector('.places-map-external')).toBeNull();
  });

  it.each([
    ['the preview', { compact: true }],
    ['the picker', { bets: [], onPickLocation: vi.fn() }],
  ])('leaves %s with its credit on the map, as before', async (_name, props) => {
    await render(props);
    expect(document.querySelector('.places-map-credit')).toBeNull();
    expect(
      document.querySelector('.places-map-canvas .leaflet-control-attribution'),
    ).not.toBeNull();
  });

  it('selects a place with Enter or Space on a focused marker and moves focus into its popup', async () => {
    const onSelectPlace = vi.fn();
    await render({ onSelectPlace });
    const marker = markerFor('Fan Pier Park');
    marker.focus();
    await press(marker, 'Enter');
    expect(onSelectPlace).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'fan-pier' }));
    expect(popupTitle()).toBe('Fan Pier Park');
    expect(document.activeElement?.closest('.leaflet-popup')).not.toBeNull();
    await press(markerFor('Rowes Wharf'), ' ');
    expect(onSelectPlace).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'rowes-wharf' }));
  });

  it('keeps markers, view and popup state when the ledger refreshes with equal data', async () => {
    const markerSpy = vi.spyOn(L, 'marker');
    await render({ selectedPlaceId: 'long-wharf' });
    const calls = markerSpy.mock.calls.length;
    const before = markerFor('Long Wharf');
    await click(document.querySelector('.leaflet-popup-close-button')!);
    const href = document.querySelector('.places-map-external')?.getAttribute('href');
    await render({
      selectedPlaceId: 'long-wharf',
      places: demo.places.map((place) => ({ ...place })),
      bets: demo.bets.map((bet) => ({ ...bet })),
    });
    expect(markerSpy.mock.calls.length).toBe(calls);
    expect(markerFor('Long Wharf')).toBe(before);
    expect(popupTitle()).toBeNull();
    expect(document.querySelector('.places-map-external')?.getAttribute('href')).toBe(href);
  });

  it('updates a changed count in place, even for a pin hidden in a group', async () => {
    const fanPier = demo.places.find((place) => place.id === 'fan-pier')!;
    const placed = { ...demo.bets[0], status: 'active' as const };
    await render();
    const before = markerFor('Fan Pier Park');
    const count = Number(before.textContent);
    await render({ bets: [...demo.bets, { ...placed, id: 'extra', location: fanPier }] });
    expect(markerFor('Fan Pier Park')).toBe(before);
    expect(before.textContent).toBe(String(count + 1));
    expect(before.getAttribute('title')).toContain(`${count + 1} bets placed here`);

    const twin: Place = { ...demo.places[0], id: 'twin', name: 'Long Wharf Dock B' };
    const twinBet = { ...placed, id: 'twin-bet', location: twin };
    await render({ places: [...demo.places, twin] });
    await render({ places: [...demo.places, twin], bets: [...demo.bets, twinBet] });
    expect(markerFor('Long Wharf Dock B')).toBeNull(); // still grouped with Long Wharf
    const apart = { ...twin, lat: twin.lat + 0.01 };
    await render({ places: [...demo.places, apart], bets: [...demo.bets, twinBet] });
    expect(markerFor('Long Wharf Dock B').textContent).toBe('1');
  });

  it('leaves an open popup, the focus in it and the view alone when the ledger really changes', async () => {
    const placed = { ...demo.bets[0], status: 'active' as const };
    const at = (id: string) => demo.places.find((place) => place.id === id)!;
    await render();
    const marker = markerFor('Fan Pier Park');
    const count = Number(marker.textContent);
    marker.focus();
    await press(marker, 'Enter');
    const content = document.querySelector('.leaflet-popup .places-map-popup')!;
    const focused = document.activeElement;
    expect(content.contains(focused)).toBe(true);
    // Popup.update (and setContent, which calls it) re-adds the content and pans to the popup.
    const update = vi.spyOn(L.DivOverlay.prototype, 'update');
    const setContent = vi.spyOn(L.DivOverlay.prototype, 'setContent');
    // Another member's bet lands at another place: this popup has nothing new to say.
    const elsewhere = { ...placed, id: 'elsewhere', location: at('rowes-wharf') };
    await render({ bets: [...demo.bets, elsewhere] });
    expect(document.querySelector('.leaflet-popup .places-map-popup')).toBe(content);
    expect(document.activeElement).toBe(focused);
    // A bet at this place: the count changes where it is, with no new content and no pan.
    const here = { ...placed, id: 'here', location: at('fan-pier') };
    await render({ bets: [...demo.bets, elsewhere, here] });
    expect(document.querySelector('.leaflet-popup .places-map-popup')).toBe(content);
    expect(content.textContent).toContain(`${count + 1} bets placed here`);
    expect(document.activeElement).toBe(focused);
    expect(update).not.toHaveBeenCalled();
    expect(setContent).not.toHaveBeenCalled();
    // A renamed place keeps its popup too, named anew.
    const renamed = demo.places.map((place) =>
      place.id === 'fan-pier' ? { ...place, name: 'Fan Pier Lawn', address: '' } : place,
    );
    await render({ places: renamed, bets: [...demo.bets, elsewhere, here] });
    expect(popupTitle()).toBe('Fan Pier Lawn');
    expect(content.getAttribute('aria-label')).toBe('Fan Pier Lawn');
    expect(content.querySelector('p')?.hidden ?? true).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(update).not.toHaveBeenCalled();
  });

  it('closes an open popup with Escape without closing the surrounding dialog', async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        createElement(Modal, {
          open: true,
          onClose,
          title: 'Map',
          children: createElement(PlacesMap, { places: demo.places, bets: demo.bets }),
        }),
      ),
    );
    const marker = markerFor('Rowes Wharf');
    marker.focus();
    await press(marker, 'Enter');
    expect(popupTitle()).toBe('Rowes Wharf');
    await press(document.activeElement!, 'Escape');
    expect(popupTitle()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(markerFor('Rowes Wharf'));
  });
});

describe('picking a new location', () => {
  it('shows saved places as reference pins only and pins wherever the map is clicked', async () => {
    const onPickLocation = vi.fn();
    await render({ bets: [], onPickLocation });
    const saved = markerFor('Long Wharf');
    expect(saved.classList.contains('leaflet-interactive')).toBe(false);
    expect(saved.hasAttribute('tabindex')).toBe(false);
    await click(document.querySelector('.places-map-canvas')!, { clientX: 400, clientY: 240 });
    expect(onPickLocation).toHaveBeenCalledTimes(1);
    expect(onPickLocation.mock.calls[0][0]).toEqual({
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
  });

  it('zooms toward a spot clicked while the map is too far out, instead of pinning a guess', async () => {
    const onPickLocation = vi.fn();
    await render({ places: [], bets: [], onPickLocation });
    const center = buttonNamed('Use map center')!;
    expect(center.disabled).toBe(true);
    await click(document.querySelector('.places-map-canvas')!, { clientX: 600, clientY: 120 });
    // A pin at world scale could be hundreds of kilometres from the place meant.
    expect(onPickLocation).not.toHaveBeenCalled();
    expect(center.disabled).toBe(false);
    expect(document.querySelector('.places-map-pick-note')).toBeNull();
    expect(document.querySelector('.places-map-picker [role="status"]')?.textContent).toBe(
      'Zoomed in on that area. Select the exact spot.',
    );
    // Close enough now: the next click pins, as the keyboard and the map center do.
    await click(document.querySelector('.places-map-canvas')!, { clientX: 400, clientY: 240 });
    expect(onPickLocation).toHaveBeenCalledTimes(1);
  });

  describe('the zoom-in announcement', () => {
    const announcement = () =>
      document.querySelector('.places-map-picker [role="status"]')?.textContent ?? '';
    const ZOOMED = 'Zoomed in on that area. Select the exact spot.';

    it('is still there once an animated zoom has finished, and goes when the view moves on', async () => {
      await render({ places: [], bets: [], onPickLocation: vi.fn() });
      // An animated zoom ends after the click has been answered: the move arrives later.
      const setView = L.Map.prototype.setView;
      vi.spyOn(L.Map.prototype, 'setView').mockImplementation(function (
        this: L.Map,
        ...args: Parameters<typeof setView>
      ) {
        window.setTimeout(() => setView.apply(this, args), 30);
        return this;
      });
      await click(document.querySelector('.places-map-canvas')!, { clientX: 600, clientY: 120 });
      expect(announcement()).toBe(ZOOMED);
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 60));
      });
      expect(buttonNamed('Use map center')!.disabled).toBe(false);
      expect(announcement()).toBe(ZOOMED);
      // A view the member moves themselves is a new question, with a fresh answer.
      vi.mocked(L.Map.prototype.setView).mockRestore();
      await click(document.querySelector('.leaflet-control-zoom-in')!);
      expect(announcement()).toBe('');
    });

    it('does not outlive the pin it led to', async () => {
      const onPickLocation = vi.fn();
      await render({ places: [], bets: [], onPickLocation });
      const canvas = document.querySelector<HTMLElement>('.places-map-canvas')!;
      await click(canvas, { clientX: 600, clientY: 120 });
      expect(announcement()).toBe(ZOOMED);
      await click(canvas, { clientX: 400, clientY: 240 });
      expect(onPickLocation).toHaveBeenCalledTimes(1);
      // The pin is placed; saying "select the exact spot" beside it would be stale.
      expect(announcement()).toBe('');
    });

    it.each([
      ['the map center', () => click(buttonNamed('Use map center')!)],
      [
        'Enter on the map',
        async () => {
          const canvas = document.querySelector<HTMLElement>('.places-map-canvas')!;
          canvas.focus();
          await press(canvas, 'Enter');
        },
      ],
    ])('goes once %s has pinned the spot', async (_how, pin) => {
      const onPickLocation = vi.fn();
      await render({ places: [], bets: [], onPickLocation });
      await click(document.querySelector('.places-map-canvas')!, { clientX: 600, clientY: 120 });
      expect(announcement()).toBe(ZOOMED);
      await pin();
      expect(onPickLocation).toHaveBeenCalledTimes(1);
      expect(announcement()).toBe('');
    });
  });

  it('asks people to zoom in before using the map center', async () => {
    await render({ places: [], bets: [], onPickLocation: vi.fn() });
    const center = buttonNamed('Use map center')!;
    expect(center.disabled).toBe(true);
    expect(document.querySelector('.places-map-pick')?.textContent).toContain(
      'Zoom in to the place first',
    );
  });

  it('pins the map center from the keyboard and offers Clear pin', async () => {
    const onPickLocation = vi.fn();
    const onClearPin = vi.fn();
    await render({ bets: [], onPickLocation, onClearPin });
    const canvas = document.querySelector<HTMLElement>('.places-map-canvas')!;
    canvas.focus();
    await press(canvas, 'Enter');
    expect(onPickLocation).toHaveBeenCalledTimes(1);
    expect(buttonNamed('Clear pin')).toBeUndefined();
    await render({
      bets: [],
      onPickLocation,
      onClearPin,
      pickedLocation: onPickLocation.mock.calls[0][0],
    });
    expect(document.querySelectorAll('.places-map-picked-pin')).toHaveLength(1);
    const clear = buttonNamed('Clear pin')!;
    clear.focus();
    await click(clear);
    expect(onClearPin).toHaveBeenCalledTimes(1);
    // Clear pin leaves with the pin, so focus moves to the control just before it.
    await render({ bets: [], onPickLocation, onClearPin });
    expect(buttonNamed('Clear pin')).toBeUndefined();
    expect(document.activeElement).toBe(buttonNamed('Use map center'));
  });

  it('keeps focus on the map after Clear pin when the map is too far out to use its center', async () => {
    const onClearPin = vi.fn();
    const props = { bets: [], onPickLocation: vi.fn(), onClearPin };
    await render({ ...props, pickedLocation: { lat: 42.3601, lng: -71.0505 } });
    for (let step = 0; step < 6; step++)
      await click(document.querySelector('.leaflet-control-zoom-out')!);
    expect(buttonNamed('Use map center')!.disabled).toBe(true);
    const clear = buttonNamed('Clear pin')!;
    clear.focus();
    await click(clear);
    await render(props);
    expect(document.activeElement).toBe(document.querySelector('.places-map-canvas'));
  });

  it('says why Enter did not pin while the map is too far out', async () => {
    const onPickLocation = vi.fn();
    await render({ places: [], bets: [], onPickLocation });
    const canvas = document.querySelector<HTMLElement>('.places-map-canvas')!;
    expect(canvas.getAttribute('aria-label')).toMatch(/Enter pins the map center once zoomed in/);
    const announcement = () =>
      document.querySelector('.places-map-picker [role="status"]')?.textContent ?? '';
    expect(announcement()).toBe('');
    canvas.focus();
    await press(canvas, 'Enter');
    expect(onPickLocation).not.toHaveBeenCalled();
    expect(announcement()).toBe('Zoom in to the place first, then press Enter.');
  });
});

describe('revealing the current selection', () => {
  it('brings a selected place to the middle of the map at a zoom that shows it clearly', async () => {
    const wharf = demo.places.find((place) => place.id === 'long-wharf')!;
    const view = () => {
      const href = document.querySelector('.places-map-external')!.getAttribute('href')!;
      const [, zoom, lat, lng] = href.match(/#map=(\d+)\/([-\d.]+)\/([-\d.]+)/)!.map(Number);
      return { zoom, lat, lng };
    };
    await render();
    const overview = view();
    expect(Math.abs(overview.lat - wharf.lat) + Math.abs(overview.lng - wharf.lng)).toBeGreaterThan(
      0.001,
    );
    await render({ selectedPlaceId: 'long-wharf', revealRequest: 1 });
    const selected = view();
    expect(selected.zoom).toBeGreaterThanOrEqual(15);
    // The open popup may nudge the map a little; the place stays at the heart of the view.
    expect(selected.lat).toBeCloseTo(wharf.lat, 2);
    expect(selected.lng).toBeCloseTo(wharf.lng, 2);
  });

  it('reopens the popup of the selected place when the same choice is made again', async () => {
    await render({ selectedPlaceId: 'long-wharf', revealRequest: 1 });
    expect(popupTitle()).toBe('Long Wharf');
    await click(document.querySelector('.leaflet-popup-close-button')!);
    expect(popupTitle()).toBeNull();
    await render({ selectedPlaceId: 'long-wharf', revealRequest: 2 });
    expect(popupTitle()).toBe('Long Wharf');
  });

  it('hands focus to the revealed pin only when the reveal asks for it', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await render();
    // A plain reveal leaves focus where it is, on the list row that asked for it.
    await render({ selectedPlaceId: 'long-wharf', revealRequest: 1 });
    expect(document.activeElement).toBe(outside);
    // A reveal that zooms in waits for the zoom, which can regroup the pins, then focuses the pin.
    await render({ selectedPlaceId: undefined, revealRequest: 2 });
    await render({ selectedPlaceId: 'fan-pier', revealRequest: 3, focusOnReveal: true });
    expect(popupTitle()).toBe('Fan Pier Park');
    expect(document.activeElement).toBe(markerFor('Fan Pier Park'));
    // One at the same zoom focuses it straight away.
    await render({ selectedPlaceId: 'rowes-wharf', revealRequest: 4, focusOnReveal: true });
    expect(popupTitle()).toBe('Rowes Wharf');
    expect(document.activeElement).toBe(markerFor('Rowes Wharf'));
    expect(markerFor('Rowes Wharf').getAttribute('aria-pressed')).toBe('true');
  });

  it('refits every place when All locations is chosen after the map was moved away', async () => {
    await render();
    const zoomOf = () =>
      Number(
        document
          .querySelector('.places-map-external')!
          .getAttribute('href')!
          .match(/#map=(\d+)\//)![1],
      );
    const fitted = zoomOf();
    await click(document.querySelector('.leaflet-control-zoom-in')!);
    await click(document.querySelector('.leaflet-control-zoom-in')!);
    expect(zoomOf()).toBe(fitted + 2);
    await render({ selectedPlaceId: undefined, revealRequest: 1 });
    expect(zoomOf()).toBe(fitted);
  });
});

describe('map tiles', () => {
  it('offers Retry when tiles do not load and keeps keyboard focus on the map', async () => {
    await render();
    expect(document.querySelector('.places-map-notice')).toBeNull();
    const tile = document.querySelector<HTMLElement>('.leaflet-tile')!;
    await act(async () => {
      tile.dispatchEvent(new Event('error'));
    });
    expect(document.querySelector('.places-map-notice')?.getAttribute('role')).toBe('status');
    const retry = buttonNamed('Retry')!;
    retry.focus();
    await click(retry);
    expect(document.querySelector('.places-map-notice')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.places-map-canvas'));
  });
});

describe('the picker layout', () => {
  it('leaves the OpenStreetMap link to the attribution, so the picker has one', async () => {
    await render({ bets: [], onPickLocation: vi.fn() });
    expect(document.querySelector('.places-map-external')).toBeNull();
    const links = [...document.querySelectorAll('.places-map-picker a[href*="openstreetmap"]')];
    expect(links.map((link) => link.textContent)).toEqual(['OpenStreetMap']);
    expect(links[0].closest('.leaflet-control-attribution')).not.toBeNull();
  });

  it('keeps the instructions above the map and marks the map center with a crosshair', async () => {
    await render({ bets: [], onPickLocation: vi.fn() });
    const bar = document.querySelector('.places-map-pick')!;
    const map = document.querySelector('.places-map')!;
    expect(bar.contains(map)).toBe(false);
    expect(map.contains(bar)).toBe(false);
    expect(bar.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const reticle = map.querySelector('.places-map-reticle')!;
    expect(reticle.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('touch screens', () => {
  const coarse = (query: string) => ({
    matches: query.includes('pointer: coarse'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  const swipe = (target: Element, fingers: number) =>
    act(async () => {
      const event = new Event('touchmove', { bubbles: true });
      Object.defineProperty(event, 'touches', {
        value: Array.from({ length: fingers }, () => ({})),
      });
      target.dispatchEvent(event);
    });

  it('lets one finger scroll the page and hints that two fingers move the map', async () => {
    vi.stubGlobal('matchMedia', coarse);
    const mapSpy = vi.spyOn(L, 'map');
    await render();
    expect(mapSpy.mock.calls[0][1]).toMatchObject({ dragging: false, touchZoom: true });
    const canvas = document.querySelector('.places-map-canvas')!;
    await swipe(canvas, 2);
    expect(document.querySelector('.places-map-touch-hint')).toBeNull();
    await swipe(canvas, 1);
    expect(document.querySelector('.places-map-touch-hint')?.textContent).toContain('two fingers');
  });

  it('still drags with a mouse', async () => {
    const mapSpy = vi.spyOn(L, 'map');
    await render();
    expect(mapSpy.mock.calls[0][1]).toMatchObject({ dragging: true });
  });

  it('shows a compact preview as a static picture of the pins', async () => {
    await render({ compact: true });
    expect(document.querySelector('.leaflet-control-zoom')).toBeNull();
    expect(document.querySelector('.places-map-external')).toBeNull();
    expect(document.querySelector('.leaflet-interactive')).toBeNull();
    for (const marker of document.querySelectorAll('.leaflet-marker-icon'))
      expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.places-map-canvas')?.hasAttribute('tabindex')).toBe(false);
  });
});

describe('map links and empty state', () => {
  it('links the external chip to the area and zoom currently on screen', async () => {
    await render();
    const chip = () => document.querySelector<HTMLAnchorElement>('.places-map-external')!;
    expect(chip().textContent).toContain('OpenStreetMap');
    const zoom = Number(
      chip()
        .getAttribute('href')!
        .match(/#map=(\d+)\//)![1],
    );
    await click(document.querySelector('.leaflet-control-zoom-out')!);
    expect(chip().getAttribute('href')).toContain(`#map=${zoom - 1}/`);
  });

  it('offers a real action when there are no places, and no external chip', async () => {
    const onAddPlace = vi.fn();
    await render({ places: [], bets: [], onAddPlace });
    expect(document.querySelector('.places-map-external')).toBeNull();
    const action = document.querySelector<HTMLButtonElement>('.places-map-empty button')!;
    await click(action);
    expect(onAddPlace).toHaveBeenCalledTimes(1);
  });
});
