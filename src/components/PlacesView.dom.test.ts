// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { withPriceCorrection, withPriceWithdrawal } from '../lib/client-state';
import type { LedgerState, PriceInput } from '../lib/types';
import { PlacesView } from './LedgerViews';

const demo = createDemoState();
let root: Root;
let container: HTMLDivElement;
const onNewBet = vi.fn();

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
  onNewBet.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const undo of cleanups.splice(0)) undo();
  vi.unstubAllGlobals();
});
const cleanups: (() => void)[] = [];

async function render(state: LedgerState) {
  await act(async () =>
    root.render(
      createElement(PlacesView, {
        state,
        memberId: 'ellis',
        onBet: vi.fn(),
        onPriceSaved: vi.fn(async () => {}),
        onPriceCorrected: vi.fn(async () => {}),
        onNewBet,
      }),
    ),
  );
}
const item = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.place-list .place-item')].find((button) =>
    button.textContent?.includes(name),
  )!;
const click = (element: HTMLElement) => act(async () => element.click());
const emptyState = () => document.querySelector('.places-layout + .panel .empty-state');
const status = () => document.querySelector('.places-layout + .panel [role="status"]')?.textContent;
const layoutOrder = () =>
  [...document.querySelector('.places-layout')!.children].map((child) =>
    child.getAttribute('aria-label'),
  );
/** A click with no pointer (detail 0) is Enter or Space on the row; detail 1 is a tap or a click. */
const choose = (row: HTMLElement, detail: number) =>
  act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
  });
/** The map loads lazily: waits for a place's pin. */
async function mapPin(name: string) {
  const find = () => document.querySelector<HTMLElement>(`.leaflet-marker-icon[title^="${name}"]`);
  for (let tries = 0; tries < 50 && !find(); tries++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return find()!;
}
/** The demo places and four more, far enough apart never to share a pin. */
const manyPlaces: LedgerState = {
  ...demo,
  places: [
    ...demo.places,
    ...[1, 2, 3, 4].map((n) => ({
      ...demo.places[0],
      id: `harbor-${n}`,
      name: `Harbor Spot ${n}`,
      address: `${n} Harbor Way`,
      lat: 41 + n,
      lng: -72 - n,
    })),
  ],
};
/**
 * A screen in the one column (below 1001px) or a wide one. Motion is reduced, so the map moves at
 * once. `change` turns the screen across 1000px, as rotating a tablet does.
 */
function stubScreen(stacked: boolean) {
  const listeners = new Set<() => void>();
  let narrow = stacked;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('max-width: 1000px') ? narrow : query.includes('reduced-motion');
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    change: (next: boolean) =>
      act(async () => {
        narrow = next;
        for (const listener of listeners) listener();
      }),
  };
}
/**
 * jsdom has no layout, so this lays the one-column page out as a phone does: a pinned bar kept
 * clear by a 72px scroll padding, the 360px map 407px down the page, and the 420px place list box
 * 867px down, holding rows of one height. A page scroll moves them all; the list box's own scroll
 * moves the rows inside it. scrollIntoView moves the page as a browser does.
 */
function phoneLayout({
  height,
  scrollY,
  rowHeight,
}: {
  height: number;
  scrollY: number;
  rowHeight: number;
}) {
  const PAD = 72;
  const MAP_TOP = 407;
  const MAP_HEIGHT = 360;
  const LIST_TOP = 867;
  const LIST_HEIGHT = 420;
  const style = document.createElement('style');
  style.textContent = `html { scroll-padding-top: ${PAD}px }`;
  document.head.appendChild(style);
  vi.stubGlobal('innerHeight', height);
  let pageY = scrollY;
  let listY = 0;
  const map = document.querySelector<HTMLElement>('.full-map-panel')!;
  const list = document.querySelector<HTMLElement>('.place-list-items')!;
  const rows = [...list.children] as HTMLElement[];
  const maxListY = rows.length * rowHeight - LIST_HEIGHT;
  const rect = (top: number, size: number) =>
    ({
      top,
      bottom: top + size,
      left: 0,
      right: 390,
      width: 390,
      height: size,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const rowRect = (row: HTMLElement) =>
    rect(LIST_TOP - pageY + rows.indexOf(row) * rowHeight - listY, rowHeight);
  map.getBoundingClientRect = () => rect(MAP_TOP - pageY, MAP_HEIGHT);
  list.getBoundingClientRect = () => rect(LIST_TOP - pageY, LIST_HEIGHT);
  for (const row of rows) row.getBoundingClientRect = () => rowRect(row);
  Object.defineProperties(list, {
    scrollTop: {
      configurable: true,
      get: () => listY,
      set: (value: number) => {
        listY = Math.max(0, Math.min(value, maxListY));
      },
    },
    scrollHeight: { configurable: true, get: () => rows.length * rowHeight },
    clientHeight: { configurable: true, get: () => LIST_HEIGHT },
  });
  const scrolled = vi.fn(function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    const { top, bottom } = this.getBoundingClientRect();
    const block = typeof options === 'object' ? options.block : 'start';
    if (block === 'start' || top < PAD) pageY += top - PAD;
    else if (bottom > height) pageY += bottom - height;
  });
  const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Element.prototype.scrollIntoView = scrolled;
  cleanups.push(() => {
    style.remove();
    if (native) Object.defineProperty(Element.prototype, 'scrollIntoView', native);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  return {
    scrolled,
    mapTop: () => map.getBoundingClientRect().top,
    listRect: () => list.getBoundingClientRect(),
    rowRect,
    scrollList: (y: number) => {
      list.scrollTop = y;
    },
  };
}

describe('places stories list', () => {
  it('exposes which place is selected and announces the filtered table', async () => {
    await render(demo);
    expect(item('All locations').getAttribute('aria-pressed')).toBe('true');
    expect(item('Long Wharf').getAttribute('aria-pressed')).toBe('false');
    await click(item('Long Wharf'));
    expect(item('Long Wharf').getAttribute('aria-pressed')).toBe('true');
    expect(item('All locations').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.places-layout + .panel [role="status"]')?.textContent).toMatch(
      /^Showing \d+ wagers? at Long Wharf\.$/,
    );
  });

  it('announces the filtered table when the first choice is a map pin', async () => {
    await render(demo);
    const status = () =>
      document.querySelector('.places-layout + .panel [role="status"]')?.textContent;
    expect(status()).toBe('');
    const pin = () =>
      document.querySelector<HTMLElement>('.leaflet-marker-icon[title^="Fan Pier Park"]');
    // The map loads lazily.
    for (let tries = 0; tries < 50 && !pin(); tries++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await click(pin()!);
    expect(item('Fan Pier Park').getAttribute('aria-pressed')).toBe('true');
    expect(status()).toMatch(/^Showing \d+ wagers? at Fan Pier Park\.$/);
  });

  it('puts the place list before the map on wide screens, where the list is drawn on the left', async () => {
    await render(demo);
    expect(layoutOrder()).toEqual(['Places on the record', 'Places map']);
  });

  it('puts the map before the place list below 1001px, where the map shows above the list', async () => {
    const screen = stubScreen(true);
    await render(demo);
    expect(layoutOrder()).toEqual(['Places map', 'Places on the record']);
    // A screen that turns wide (a tablet rotated) reorders without rebuilding the map or
    // dropping focus from the control that had it, in whichever panel moves.
    const pin = await mapPin('Long Wharf');
    const canvas = document.querySelector('.places-map-canvas');
    pin.focus();
    await screen.change(false);
    expect(layoutOrder()).toEqual(['Places on the record', 'Places map']);
    expect(document.querySelector('.places-map-canvas')).toBe(canvas);
    expect(document.activeElement).toBe(pin);
    const row = item('Fan Pier Park');
    row.focus();
    await screen.change(true);
    expect(layoutOrder()).toEqual(['Places map', 'Places on the record']);
    expect(document.activeElement).toBe(row);
  });

  it('brings the map above into view for a tap or a click', async () => {
    stubScreen(true);
    await render(demo);
    const page = phoneLayout({ height: 844, scrollY: 450, rowHeight: 100 });
    await choose(item('Long Wharf'), 1);
    expect(page.scrolled.mock.contexts).toEqual([document.querySelector('.full-map-panel')]);
    expect(page.scrolled.mock.calls[0][0]).toMatchObject({ block: 'nearest' });
  });

  it('shows the map clear of the top bar for a key, and keeps the chosen row on screen', async () => {
    stubScreen(true);
    await render(manyPlaces);
    const page = phoneLayout({ height: 844, scrollY: 450, rowHeight: 100 });
    page.scrollList(100);
    const row = item('Rowes Wharf');
    row.focus();
    await choose(row, 0);
    // The map's top edge sits on the scroll padding line, just under the pinned bar, so the popup
    // that opens near it is never under the bar.
    expect(page.mapTop()).toBe(72);
    // Only the place list scrolls to keep the row on screen; the page stays with the map.
    expect(page.rowRect(row).bottom).toBeLessThanOrEqual(844);
    expect(page.rowRect(row).top).toBeGreaterThanOrEqual(page.listRect().top);
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(status()).toMatch(/^Showing \d+ wagers? at Rowes Wharf\.$/);
  });

  it('hands focus to the chosen pin when the row cannot stay on screen beside the map', async () => {
    stubScreen(true);
    await render(manyPlaces);
    await mapPin('Long Wharf');
    // A 320 by 640 phone: under the map there is room for the list title and part of one row.
    const page = phoneLayout({ height: 640, scrollY: 450, rowHeight: 120 });
    const row = item('Fan Pier Park');
    row.focus();
    await choose(row, 0);
    expect(page.mapTop()).toBe(72);
    expect(document.activeElement).toBe(await mapPin('Fan Pier Park'));
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(status()).toMatch(/^Showing \d+ wagers? at Fan Pier Park\.$/);
  });

  it('hands focus to the chosen pin for a row too near the end of a long list to sit beside the map', async () => {
    stubScreen(true);
    await render(manyPlaces);
    await mapPin('Long Wharf');
    const page = phoneLayout({ height: 844, scrollY: 900, rowHeight: 100 });
    page.scrollList(480);
    const row = item('Harbor Spot 4');
    row.focus();
    await choose(row, 0);
    expect(page.mapTop()).toBe(72);
    expect(document.activeElement).toBe(await mapPin('Harbor Spot 4'));
  });

  it('keeps All locations on screen for a key when the map cannot fit beside it', async () => {
    stubScreen(true);
    await render(demo);
    const page = phoneLayout({ height: 560, scrollY: 450, rowHeight: 120 });
    await choose(item('Long Wharf'), 1);
    const row = item('All locations');
    row.focus();
    await choose(row, 0);
    // No popup to show: the row comes back into view and keeps focus.
    expect(page.scrolled.mock.contexts.at(-1)).toBe(row);
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-pressed')).toBe('true');
  });

  it('says how many wagers the chosen place keeps and offers to show every location again', async () => {
    await render(demo);
    const header = () => document.querySelector('.places-layout + .panel .section-title')!;
    const showAll = () =>
      [...header().querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Show all locations'),
      );
    expect(showAll()).toBeUndefined();
    expect(header().textContent).not.toMatch(/Showing/);
    await click(item('Long Wharf'));
    const located = demo.bets.filter((bet) => bet.location).length;
    const here = demo.bets.filter((bet) => bet.location?.id === 'long-wharf').length;
    // The demo's Long Wharf also lists a wager its proposer withdrew, which its count leaves out.
    expect(header().querySelector('p')?.textContent).toBe(
      `Showing ${here} of ${located} wagers · 1 withdrawn`,
    );
    await click(showAll()!);
    expect(item('All locations').getAttribute('aria-pressed')).toBe('true');
    expect(showAll()).toBeUndefined();
    // The button that had focus is gone, so focus moves to the control that now shows the state.
    expect(document.activeElement).toBe(item('All locations'));
  });

  it('counts placed bets with correct plurals', async () => {
    const [longWharf] = demo.places;
    const bet = { ...demo.bets[0], location: longWharf };
    await render({
      ...demo,
      bets: [
        { ...bet, id: 'placed', status: 'active' },
        { ...bet, id: 'waiting', status: 'pending' },
        { ...bet, id: 'turned-down', status: 'declined' },
      ],
    });
    expect(item('Long Wharf').querySelector('.place-bet-count')?.textContent).toBe(
      '1 bet placed here · 1 awaiting agreement',
    );
    expect(item('Fan Pier Park').querySelector('.place-bet-count')?.textContent).toBe(
      '0 bets placed here',
    );
    expect(document.querySelector('.place-list .section-title p')?.textContent).toBe(
      '3 wagers with a location',
    );
  });

  it('says in the table heading which listed wagers the place counts leave out', async () => {
    const [longWharf] = demo.places;
    const bet = { ...demo.bets[0], location: longWharf };
    const closed = (id: string, type: string) =>
      ({
        ...bet,
        id,
        status: 'declined',
        events: [...bet.events, { ...bet.events[0], type }],
      }) as typeof bet;
    await render({
      ...demo,
      bets: [
        { ...bet, id: 'placed', status: 'active' },
        { ...bet, id: 'waiting', status: 'pending' },
        closed('taken-back', 'withdraw'),
        closed('turned-down', 'decline'),
        closed('turned-down-too', 'decline'),
      ],
    });
    const subtitle = () => document.querySelector('.places-layout + .panel .section-title p');
    await click(item('Long Wharf'));
    // The row says "1 bet placed here · 1 awaiting agreement"; the table lists all five.
    expect(item('Long Wharf').querySelector('.place-bet-count')?.textContent).toBe(
      '1 bet placed here · 1 awaiting agreement',
    );
    expect(subtitle()?.textContent).toBe('Showing 5 of 5 wagers · 1 withdrawn, 2 declined');
    // Nothing is said of a place with nothing closed.
    await click(item('Fan Pier Park'));
    expect(subtitle()?.textContent).toBe('Showing 0 of 5 wagers');
  });

  it('explains an empty map of stories and offers a way forward', async () => {
    await render({ ...demo, bets: demo.bets.map((bet) => ({ ...bet, location: undefined })) });
    expect(emptyState()?.textContent).toContain('No located wagers yet');
    expect(emptyState()?.textContent).not.toContain('this spot');
    await click(item('Fan Pier Park'));
    expect(emptyState()?.textContent).toContain('No bets at Fan Pier Park yet');
    const action = [...emptyState()!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('New bet here'),
    )!;
    await click(action);
    expect(onNewBet).toHaveBeenCalledWith('fan-pier');
  });

  it('names the one way to start on an empty Places page the same everywhere', async () => {
    await render({
      ...demo,
      places: [],
      bets: demo.bets.map((bet) => ({ ...bet, location: undefined })),
    });
    const overlay = () => document.querySelector<HTMLButtonElement>('.places-map-empty button');
    for (let tries = 0; tries < 50 && !overlay(); tries++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const fromTable = emptyState()!.querySelector('button')!;
    expect(overlay()!.textContent?.trim()).toBe('Start a bet with a place');
    expect(fromTable.textContent?.trim()).toBe('Start a bet with a place');
    await click(fromTable);
    await click(overlay()!);
    expect(onNewBet.mock.calls).toEqual([['custom'], ['custom']]);
  });
});

describe('Roll prices history', () => {
  const showPrices = async () => {
    await render(demo);
    const toggle = [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find(
      (button) => button.textContent?.includes('Roll prices'),
    )!;
    await click(toggle);
  };

  it('draws the chart in a measured box whose labels stay at 12px', async () => {
    await showPrices();
    const chart = document.querySelector('.price-history-panel svg.price-chart')!;
    // One unit is one CSS pixel: the viewBox is as wide as the drawing.
    expect(chart.getAttribute('viewBox')).toBe(
      `0 0 ${chart.getAttribute('width')} ${chart.getAttribute('height')}`,
    );
    const labels = [...chart.querySelectorAll('text')];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(Number(label.getAttribute('font-size'))).toBe(12);
  });

  it('names what each Correct button corrects, so the buttons are not all called Correct', async () => {
    await showPrices();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.price-correct-button')];
    expect(buttons.length).toBeGreaterThan(0);
    const names = buttons.map((button) => button.getAttribute('aria-label'));
    for (const name of names) expect(name).toMatch(/^Correct the \$\d+\.\d{2} .+ report from .+$/);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('logging a visit from Roll prices', () => {
  const showPrices = async (
    state: LedgerState,
    onPriceSaved = vi.fn(async (): Promise<string | void> => {}),
  ) => {
    await act(async () =>
      root.render(
        createElement(PlacesView, {
          state,
          memberId: 'ellis',
          onBet: vi.fn(),
          onPriceSaved,
          onPriceCorrected: vi.fn(async () => {}),
          onNewBet,
        }),
      ),
    );
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find((button) =>
        button.textContent?.includes('Roll prices'),
      )!,
    );
    return onPriceSaved;
  };
  const restaurantRow = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.restaurant-price-list .place-item')].find(
      (button) => button.textContent?.includes(name),
    )!;
  const panelTitle = () => document.querySelector('.price-history-panel h2')?.textContent;
  const logVisit = () =>
    click(
      [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find((button) =>
        button.textContent?.includes('Log a visit'),
      )!,
    );

  it('opens on the restaurant being viewed', async () => {
    await showPrices(demo);
    await click(restaurantRow('North Pier'));
    await logVisit();
    const select = document.querySelector(
      '[role="dialog"] [name="restaurantId"]',
    ) as unknown as HTMLSelectElement | null;
    expect(select?.value).toBe('north-pier');
  });

  it('shows the restaurant a saved report went to', async () => {
    const onPriceSaved = vi.fn(async (): Promise<string | void> => 'north-pier');
    await showPrices(demo, onPriceSaved);
    expect(panelTitle()).toBe('Harbor Shack');
    await logVisit();
    const dialog = document.querySelector('[role="dialog"]')!;
    // tsc 7's DOM typings reject a select as a querySelector<T> argument.
    const select = dialog.querySelector('[name="restaurantId"]') as unknown as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        select,
        'north-pier',
      );
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const price = dialog.querySelector<HTMLInputElement>('[name="price"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(price, '32');
      price.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      dialog.querySelector('form')!.requestSubmit(dialog.querySelector('button[type="submit"]')),
    );
    expect(onPriceSaved).toHaveBeenCalledOnce();
    expect(panelTitle()).toBe('North Pier Café');
  });

  it('keeps a corrected report on record, marks its correction and lists the earlier one', async () => {
    const original = demo.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    const state: LedgerState = {
      ...demo,
      priceObservations: [
        ...demo.priceObservations!.filter((item) => item.id !== original.id),
        { ...original, correctedAt: '2026-10-18T12:00:00.000Z' },
        {
          ...original,
          id: 'price-harbor-june-corrected',
          priceCents: 2650,
          correctedFromId: original.id,
          reportedAt: '2026-10-18T12:00:00.000Z',
        },
      ],
    };
    await showPrices(state);
    const rows = [...document.querySelectorAll('.price-history-list .price-observation')];
    const corrected = rows.find((row) => row.textContent?.includes('$26.50'))!;
    expect(corrected.querySelector('.price-corrected-tag')?.textContent).toBe('Corrected');
    expect(rows.some((row) => row.textContent?.includes('$25.00'))).toBe(false);
    const earlier = document.querySelector<HTMLDetailsElement>('.price-earlier')!;
    expect(earlier.querySelector('summary')?.textContent).toBe('Earlier reports (1)');
    expect(earlier.querySelector('li')?.textContent).toBe(
      '$25.00 · Classic lobster roll · Jun 14, 2026 · Ellis · replaced by a correction on Oct 18, 2026',
    );
  });

  it('hands focus to the corrected report once a correction is saved', async () => {
    // The ledger answers a correction the way it does on the website: the original is stamped and
    // its successor joins the history, so the row whose Correct button was pressed is gone.
    function Ledger() {
      const [state, setState] = useState(demo);
      return createElement(PlacesView, {
        state,
        memberId: 'ellis',
        onBet: vi.fn(),
        onPriceSaved: vi.fn(async () => {}),
        onPriceCorrected: async (id: string, input: PriceInput) =>
          setState((current) => {
            const original = current.priceObservations!.find((item) => item.id === id)!;
            const correctedAt = '2026-10-18T12:00:00.000Z';
            return withPriceCorrection(current, {
              observation: {
                ...input,
                id: `${id}-corrected`,
                currency: 'USD',
                reporterId: 'ellis',
                reportedAt: correctedAt,
                correctedFromId: id,
              },
              corrected: { ...original, correctedAt },
            });
          }),
        onNewBet,
      });
    }
    await act(async () => root.render(createElement(Ledger)));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find((button) =>
        button.textContent?.includes('Roll prices'),
      )!,
    );
    const correct = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Correct the $25.00 Classic lobster roll report from Jun 14, 2026"]',
    )!;
    correct.focus();
    await click(correct);
    const dialog = document.querySelector('[role="dialog"]')!;
    const price = dialog.querySelector<HTMLInputElement>('[name="price"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        price,
        '26.50',
      );
      price.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      dialog.querySelector('form')!.requestSubmit(dialog.querySelector('button[type="submit"]')),
    );
    // The dialog hands focus back once it has gone, a moment after the save.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(correct.isConnected).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Correct the $26.50 Classic lobster roll report from Jun 14, 2026',
    );
  });
});

describe('the Roll prices list and panel', () => {
  const NOW = '2026-10-18T12:00:00.000Z';
  const scrolled = vi.fn();
  let narrow = false;
  beforeEach(() => {
    narrow = false;
    scrolled.mockReset();
    Element.prototype.scrollIntoView = scrolled;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: narrow && query.includes('max-width'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => {
    window.history.replaceState(null, '', '#');
  });
  const open = async (state: LedgerState = demo, props: Record<string, unknown> = {}) => {
    await act(async () =>
      root.render(
        createElement(PlacesView, {
          state,
          memberId: 'ellis',
          onBet: vi.fn(),
          onPriceSaved: vi.fn(async () => {}),
          onPriceCorrected: vi.fn(async () => {}),
          onNewBet,
          now: NOW,
          ...props,
        }),
      ),
    );
    const tab = [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find(
      (button) => button.textContent?.includes('Roll prices'),
    )!;
    if (tab.getAttribute('aria-pressed') !== 'true') await click(tab);
  };
  const rows = () => [
    ...document.querySelectorAll<HTMLButtonElement>('.restaurant-price-list .place-item'),
  ];
  const row = (name: string) => rows().find((button) => button.textContent?.includes(name))!;
  const panel = () => document.querySelector('.price-history-panel')!;
  const words = (element: Element | null | undefined) =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const at = (id: string) => demo.priceObservations!.find((item) => item.id === id)!;

  it('exposes which restaurant is selected', async () => {
    await open();
    expect(rows().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    await click(row('North Pier'));
    expect(row('North Pier').getAttribute('aria-pressed')).toBe('true');
    expect(row('Harbor Shack').getAttribute('aria-pressed')).toBe('false');
  });

  it('leads with the Classic series, so a Connecticut roll moves neither the headline nor the change', async () => {
    await open();
    expect(words(panel().querySelector('.price-stat'))).toBe(
      '$28.00 Most recent reported · Classic lobster roll · Sep 11, 2026',
    );
    expect(words(panel().querySelector('.price-delta'))).toBe('Up $2.00 since Jul 18, 2026');
    expect(panel().querySelector('.price-delta')?.className).toContain('up');
    expect(words(panel().querySelector('.price-also'))).toBe(
      'Also reported: Connecticut lobster roll $30.00',
    );
    expect(panel().querySelector('svg.price-chart desc')?.textContent).not.toContain('$30.00');
    // The Connecticut report stays in the list of reports, with its own name.
    expect(words(panel().querySelector('.price-history-list'))).toContain(
      'Connecticut lobster roll',
    );
  });

  it('dates and names the price on each restaurant row', async () => {
    await open();
    expect(words(row('Harbor Shack').querySelector('.restaurant-latest'))).toBe(
      '$28.00 · Classic lobster roll',
    );
    expect(words(row('Harbor Shack').querySelector('.place-bet-count'))).toBe(
      'Sep 11, 2026 · 5 reports',
    );
    expect(words(row('North Pier').querySelector('.place-bet-count'))).toBe(
      'Sep 20, 2026 · 3 reports',
    );
  });

  it('shows the same latest price on the row and in the panel when two reports share a day', async () => {
    const later = {
      ...at('price-harbor-september'),
      id: 'price-harbor-september-late',
      priceCents: 2900,
      reporterId: 'olivia',
      reportedAt: '2026-09-12T08:00:00.000Z',
    };
    await open({ ...demo, priceObservations: [later, ...demo.priceObservations!] });
    expect(words(row('Harbor Shack').querySelector('.restaurant-latest'))).toMatch(/^\$29\.00/);
    expect(words(panel().querySelector('.price-stat'))).toMatch(/^\$29\.00/);
  });

  it('says No change when the price held, and how many reports the level line covers', async () => {
    const flat = ['2026-05-01', '2026-07-01', '2026-09-01'].map((visitDate, index) => ({
      ...at('price-harbor-june'),
      id: `flat-${index}`,
      visitDate,
      reportedAt: `${visitDate}T20:00:00.000Z`,
      priceCents: 2900,
    }));
    await open({ ...demo, restaurants: [demo.restaurants![0]], priceObservations: flat });
    expect(words(panel().querySelector('.price-delta'))).toBe('No change since Jul 1, 2026');
    expect(words(panel().querySelector('.price-chart-caption'))).toBe('No change across 3 reports');
  });

  it('takes a month report and a day in that month as one visit, not a trend', async () => {
    const june = at('price-harbor-june');
    const month = {
      ...june,
      id: 'coarse-month',
      visitDate: '2026-07',
      visitDatePrecision: 'month' as const,
      priceCents: 3000,
      reportedAt: '2026-08-02T12:00:00.000Z',
    };
    const day = {
      ...june,
      id: 'coarse-day',
      visitDate: '2026-07-20',
      priceCents: 3400,
      reportedAt: '2026-07-20T20:00:00.000Z',
    };
    await open({
      ...demo,
      restaurants: [demo.restaurants![0]],
      priceObservations: [month, day],
    });
    expect(panel().querySelector('svg.price-chart')).toBeNull();
    expect(panel().querySelector('.price-delta')).toBeNull();
    expect(words(panel().querySelector('.price-chart-note'))).toBe(
      'One visit on record so far. The chart starts with a second visit.',
    );
    // Both reports stay on record.
    expect(panel().querySelectorAll('.price-observation')).toHaveLength(2);
  });

  it('waits for a second visit before drawing a trend', async () => {
    await open({
      ...demo,
      restaurants: [demo.restaurants![0]],
      priceObservations: [at('price-harbor-june')],
    });
    expect(panel().querySelector('svg.price-chart')).toBeNull();
    expect(panel().querySelector('.price-delta')).toBeNull();
    expect(words(panel().querySelector('.price-chart-note'))).toBe(
      'One visit on record so far. The chart starts with a second visit.',
    );
  });

  it('counts in the singular and names a missing address the same way in the list and the panel', async () => {
    await open({
      ...demo,
      restaurants: [{ id: 'quiet', name: 'Quiet Café', address: '' }],
      priceObservations: [{ ...at('price-harbor-june'), restaurantId: 'quiet' }],
    });
    expect(words(document.querySelector('.restaurant-price-list .section-title p'))).toBe(
      '1 restaurant · 1 report',
    );
    expect(words(row('Quiet Café').querySelector('small'))).toBe('Address not added');
    expect(words(panel().querySelector('.section-title p'))).toBe('Member-reported menu prices');
  });

  it('offers to add the first price for a restaurant that has none', async () => {
    await open({
      ...demo,
      restaurants: [...demo.restaurants!, { id: 'quiet', name: 'Quiet Café', address: '' }],
    });
    await click(row('Quiet Café'));
    const action = [...panel().querySelectorAll<HTMLButtonElement>('.empty-state button')].find(
      (button) => words(button) === 'Add a price for Quiet Café',
    )!;
    await click(action);
    const select = document.querySelector(
      '[role="dialog"] [name="restaurantId"]',
    ) as unknown as HTMLSelectElement | null;
    expect(select?.value).toBe('quiet');
  });

  it('offers Log a visit on an empty price book', async () => {
    await open({ ...demo, restaurants: [], priceObservations: [] });
    const action = [
      ...document.querySelectorAll<HTMLButtonElement>('.price-summary .empty-state button'),
    ].find((button) => words(button) === 'Log a visit')!;
    await click(action);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps each price in one column, whether or not the row can be corrected', async () => {
    await open();
    const observations = [...panel().querySelectorAll('.price-observation')];
    expect(observations.length).toBeGreaterThan(1);
    for (const observation of observations) {
      expect(observation.querySelector(':scope > strong.price-observation-price')).not.toBeNull();
      // The Correct button sits in a slot of its own after the price, never inside it.
      expect(observation.querySelector('.price-observation-price button')).toBeNull();
    }
    expect(panel().querySelector('.price-observation-action .price-correct-button')).not.toBeNull();
  });

  it('holds the action column at a restaurant where the viewer has no report, so prices stay put', async () => {
    await open(demo, { onPriceWithdrawn: vi.fn(async () => {}) });
    const list = () => document.querySelector('.price-history-list')!;
    // Ellis's own June report is at Harbor Shack: that list has the column.
    expect(list().classList.contains('has-actions')).toBe(true);
    expect(list().classList.contains('has-withdraw')).toBe(true);
    await click(row('North Pier'));
    // He has none at North Pier, yet the column is still reserved there, so the price column does
    // not move when the restaurant changes.
    expect(panel().textContent).toContain('$33.00');
    expect(panel().querySelector('.price-correct-button')).toBeNull();
    expect(list().classList.contains('has-actions')).toBe(true);
    expect(list().classList.contains('has-withdraw')).toBe(true);
    expect(list().querySelectorAll('.price-observation-action')).toHaveLength(
      list().querySelectorAll('.price-observation').length,
    );
  });

  it('reserves no action column for a member with no live report anywhere', async () => {
    const others = {
      ...demo,
      priceObservations: demo.priceObservations!.filter((item) => item.reporterId !== 'ellis'),
    };
    await open(others, { onPriceWithdrawn: vi.fn(async () => {}) });
    for (const name of ['Harbor Shack', 'North Pier']) {
      await click(row(name));
      expect(document.querySelector('.price-history-list')!.className).not.toMatch(/has-/);
    }
  });

  it('mutes a restaurant whose latest report is more than a year old and says why', async () => {
    const old = {
      ...at('price-harbor-june'),
      id: 'old',
      restaurantId: 'north-pier',
      visitDate: '2024-06-14',
    };
    await open({
      ...demo,
      priceObservations: [
        ...demo.priceObservations!.filter((item) => item.restaurantId === 'harbor-shack'),
        old,
      ],
    });
    expect(row('North Pier').className).toContain('old-report');
    expect(words(row('North Pier').querySelector('.price-old-tag'))).toBe('Old report');
    expect(row('Harbor Shack').querySelector('.price-old-tag')).toBeNull();
  });

  it('offers Lowest price first once four restaurants are listed', async () => {
    const toggle = () => document.querySelector<HTMLButtonElement>('.price-sort-toggle');
    await open();
    expect(toggle()).toBeNull();
    const more = [
      { id: 'cheap', name: 'Cheap Eats', address: 'Dock St' },
      { id: 'dear', name: 'Dear Place', address: 'Pier 4' },
    ];
    const priced = more.map((restaurant, index) => ({
      ...at('price-harbor-june'),
      id: `price-${restaurant.id}`,
      restaurantId: restaurant.id,
      priceCents: [2000, 4500][index],
    }));
    await open({
      ...demo,
      restaurants: [...demo.restaurants!, ...more],
      priceObservations: [...demo.priceObservations!, ...priced],
    });
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    await click(toggle()!);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(rows().map((button) => words(button.querySelector('strong')))).toEqual([
      'Cheap Eats',
      'Harbor Shack',
      'North Pier Café',
      'Dear Place',
    ]);
  });

  it('sorts by live prices only, so a withdrawn report never moves a restaurant up', async () => {
    const more = [
      { id: 'cheap', name: 'Cheap Eats', address: 'Dock St' },
      { id: 'dear', name: 'Dear Place', address: 'Pier 4' },
    ];
    const priced = more.map((restaurant, index) => ({
      ...at('price-harbor-june'),
      id: `price-${restaurant.id}`,
      restaurantId: restaurant.id,
      priceCents: [2000, 4500][index],
    }));
    // Dear Place's newest report, at $10.00, was withdrawn: its live price is still $45.00.
    const withdrawn = {
      ...at('price-harbor-june'),
      id: 'price-dear-withdrawn',
      restaurantId: 'dear',
      visitDate: '2026-10-01',
      reportedAt: '2026-10-01T20:00:00.000Z',
      priceCents: 1000,
      withdrawnAt: '2026-10-02T09:00:00.000Z',
      withdrawnReason: 'Wrong restaurant',
    };
    await open({
      ...demo,
      restaurants: [...demo.restaurants!, ...more],
      priceObservations: [...demo.priceObservations!, ...priced, withdrawn],
    });
    await click(document.querySelector<HTMLButtonElement>('.price-sort-toggle')!);
    expect(rows().map((button) => words(button.querySelector('strong')))).toEqual([
      'Cheap Eats',
      'Harbor Shack',
      'North Pier Café',
      'Dear Place',
    ]);
    expect(words(row('Dear Place').querySelector('.restaurant-latest'))).toBe(
      '$45.00 · Classic lobster roll',
    );
    expect(words(row('Dear Place').querySelector('.place-bet-count'))).toBe(
      'Jun 14, 2026 · 1 report',
    );
  });

  it('brings the panel into view when a restaurant is chosen on a narrow screen', async () => {
    narrow = true;
    await open();
    scrolled.mockClear();
    await click(row('North Pier'));
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts.at(-1)).toBe(panel());
  });

  it('opens on Roll prices from #places/prices and keeps the chosen tab in the address', async () => {
    window.history.replaceState(null, '', '#places/prices');
    await act(async () =>
      root.render(
        createElement(PlacesView, {
          state: demo,
          memberId: 'ellis',
          onBet: vi.fn(),
          onPriceSaved: vi.fn(async () => {}),
          onPriceCorrected: vi.fn(async () => {}),
          onNewBet,
        }),
      ),
    );
    expect(panel()).not.toBeNull();
    const tab = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find((button) =>
        button.textContent?.includes(label),
      )!;
    await click(tab('Wager stories'));
    expect(window.location.hash).toBe('#places');
    await click(tab('Roll prices'));
    expect(window.location.hash).toBe('#places/prices');
  });

  it('makes Log a visit a secondary button beside New bet', async () => {
    await open();
    const log = [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find(
      (button) => button.textContent?.includes('Log a visit'),
    )!;
    expect(log.className).toContain('button-secondary');
  });
});

describe('withdrawn reports and where a report came from', () => {
  function Ledger({ onWithdraw }: { onWithdraw?: (id: string, reason: string) => void }) {
    const [state, setState] = useState(demo);
    return createElement(PlacesView, {
      state,
      memberId: 'ellis',
      onBet: vi.fn(),
      onPriceSaved: vi.fn(async () => {}),
      onPriceCorrected: vi.fn(async () => {}),
      onPriceWithdrawn: async (id: string, reason: string) => {
        onWithdraw?.(id, reason);
        setState((current) => {
          const report = current.priceObservations!.find((item) => item.id === id)!;
          return withPriceWithdrawal(current, {
            observation: {
              ...report,
              withdrawnAt: '2026-10-18T12:00:00.000Z',
              withdrawnReason: reason,
            },
          });
        });
      },
      onNewBet,
    });
  }
  const showPrices = async (onWithdraw?: (id: string, reason: string) => void) => {
    await act(async () => root.render(createElement(Ledger, { onWithdraw })));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.places-toolbar button')].find((button) =>
        button.textContent?.includes('Roll prices'),
      )!,
    );
  };
  const restaurantRow = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.restaurant-price-list .place-item')].find(
      (button) => button.textContent?.includes(name),
    )!;
  const rows = () => [...document.querySelectorAll('.price-history-list .price-observation')];
  const dialog = () => document.querySelector('[role="dialog"]');
  const withdrawJune = () =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Withdraw the $25.00 Classic lobster roll report from Jun 14, 2026"]',
    );
  const typeReason = async (value: string) => {
    const reason = dialog()!.querySelector<HTMLTextAreaElement>('[name="reason"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        reason,
        value,
      );
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return reason;
  };
  const submitWithdraw = () =>
    act(async () =>
      dialog()!
        .querySelector('form')!
        .requestSubmit(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')),
    );
  const words = (element: Element | null | undefined) =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const panel = () => document.querySelector('.price-history-panel')!;

  it('leaves a withdrawn report out of every figure and lists it under Earlier reports', async () => {
    await showPrices();
    // North Pier keeps three live reports; Olivia withdrew a fourth.
    expect(words(restaurantRow('North Pier').querySelector('.restaurant-latest'))).toBe(
      '$33.00 · Classic lobster roll',
    );
    expect(words(restaurantRow('North Pier').querySelector('.place-bet-count'))).toBe(
      'Sep 20, 2026 · 3 reports',
    );
    await click(restaurantRow('North Pier'));
    expect(rows()).toHaveLength(3);
    expect(rows().some((row) => row.textContent?.includes('$27.00'))).toBe(false);
    const earlier = document.querySelector<HTMLDetailsElement>('.price-earlier')!;
    expect(earlier.querySelector('summary')?.textContent).toBe('Earlier reports (2)');
    expect([...earlier.querySelectorAll('li')].map((item) => item.textContent)).toContain(
      '$27.00 · Classic lobster roll · Aug 15, 2026 · Olivia · withdrawn on Aug 16, 2026: Logged at the wrong restaurant: that visit was Harbor Shack.',
    );
  });

  it('notes a report entered through an AI connection, and a correction’s reason', async () => {
    await showPrices();
    await click(restaurantRow('North Pier'));
    const marcus = rows().find((row) => row.textContent?.includes('$31.00'))!;
    expect(marcus.querySelector('.price-entry-source')?.textContent).toBe('via AI connection');
    expect(rows().filter((row) => row.querySelector('.price-entry-source'))).toHaveLength(1);
    const corrected = rows().find((row) => row.textContent?.includes('$33.00'))!;
    expect(corrected.textContent).toContain('Correction: Typed $35 by mistake.');
  });

  it('offers Withdraw only on the member’s own live reports', async () => {
    await showPrices();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.price-withdraw-button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Withdraw the $25.00 Classic lobster roll report from Jun 14, 2026',
    ]);
  });

  it('asks for a reason, says the report stays on record, and hands focus back on Cancel', async () => {
    const onWithdraw = vi.fn();
    await showPrices(onWithdraw);
    const opener = withdrawJune()!;
    opener.focus();
    await click(opener);
    expect(dialog()?.textContent).toContain('stays on record under Earlier reports');
    const submit = dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.className).toContain('button-danger');
    expect(submit.textContent).toBe('Withdraw report');
    await submitWithdraw();
    expect(onWithdraw).not.toHaveBeenCalled();
    const reason = dialog()!.querySelector<HTMLTextAreaElement>('[name="reason"]')!;
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(reason.maxLength).toBe(500);
    const cancel = [...dialog()!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    await click(cancel);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('withdraws with the reason and moves focus to Earlier reports once the row has gone', async () => {
    const onWithdraw = vi.fn();
    await showPrices(onWithdraw);
    const opener = withdrawJune()!;
    opener.focus();
    await click(opener);
    await typeReason('Wrong restaurant');
    await submitWithdraw();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(onWithdraw).toHaveBeenCalledWith('price-harbor-june', 'Wrong restaurant');
    expect(dialog()).toBeNull();
    expect(opener.isConnected).toBe(false);
    expect(rows().some((row) => row.textContent?.includes('$25.00'))).toBe(false);
    const summary = document.querySelector('.price-earlier summary')!;
    expect(summary.textContent).toBe('Earlier reports (1)');
    expect(document.activeElement).toBe(summary);
    expect(document.querySelector('.price-earlier li')?.textContent).toBe(
      '$25.00 · Classic lobster roll · Jun 14, 2026 · Ellis · withdrawn on Oct 18, 2026: Wrong restaurant',
    );
  });

  it('keeps a withdrawn report out of the headline, the change, the chart and the counts', async () => {
    await showPrices();
    expect(words(document.querySelector('.restaurant-price-list .section-title p'))).toBe(
      '2 restaurants · 8 reports',
    );
    await click(restaurantRow('North Pier'));
    expect(words(panel().querySelector('.price-stat'))).toBe(
      '$33.00 Most recent reported · Classic lobster roll · Sep 20, 2026',
    );
    // Olivia's withdrawn $27.00 of Aug 15 sits inside Marcus's August report: the change is still
    // read from August, and the chart keeps August's own price.
    expect(words(panel().querySelector('.price-delta'))).toBe('Up $2.00 since Aug 2026');
    expect(panel().querySelector('svg.price-chart desc')?.textContent).toBe(
      '2025: $29.00. Aug 2026: $31.00. Sep 20, 2026: $33.00.',
    );
  });

  it('puts Withdraw beside Correct in the slot after the price', async () => {
    await showPrices();
    const row = withdrawJune()!.closest('.price-observation')!;
    expect(
      [...row.querySelectorAll('.price-observation-action button')].map((button) => words(button)),
    ).toEqual(['Correct', 'Withdraw']);
    expect(words(row.querySelector(':scope > strong.price-observation-price'))).toBe('$25.00');
    expect(row.querySelector('.price-observation-price button')).toBeNull();
    expect(document.querySelector('.price-history-list')?.className).toContain('has-withdraw');
  });

  it('takes a withdrawn report off the primary series at once: row, count and chart', async () => {
    await showPrices();
    const desc = () => panel().querySelector('svg.price-chart desc')?.textContent;
    expect(desc()).toContain('Jun 14, 2026: $25.00.');
    expect(words(restaurantRow('Harbor Shack').querySelector('.place-bet-count'))).toBe(
      'Sep 11, 2026 · 5 reports',
    );
    await click(withdrawJune()!);
    await typeReason('Wrong restaurant');
    await submitWithdraw();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(words(restaurantRow('Harbor Shack').querySelector('.place-bet-count'))).toBe(
      'Sep 11, 2026 · 4 reports',
    );
    expect(words(document.querySelector('.restaurant-price-list .section-title p'))).toBe(
      '2 restaurants · 7 reports',
    );
    expect(desc()).toBe('Jul 18, 2026: $26.00. Sep 11, 2026: $28.00.');
    expect(words(panel().querySelector('.price-stat'))).toBe(
      '$28.00 Most recent reported · Classic lobster roll · Sep 11, 2026',
    );
    expect(words(panel().querySelector('.price-delta'))).toBe('Up $2.00 since Jul 18, 2026');
    // Ellis has no live report left here, so no row offers Correct or Withdraw.
    expect(document.querySelector('.price-withdraw-button')).toBeNull();
    expect(document.querySelector('.price-history-list')?.className).not.toContain('has-actions');
  });
});
