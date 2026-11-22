// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priceSeries } from '../lib/price-observations';
import type { PriceObservation } from '../lib/types';
import { PriceHistoryChart } from './PriceHistoryChart';

let root: Root;
let container: HTMLDivElement;
/** The width the chart's box reports, as a browser would through ResizeObserver. */
let measured = 600;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: measured } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  measured = 600;
});

const report = (id: string, visitDate: string, priceCents: number): PriceObservation => ({
  id,
  restaurantId: 'harbor-shack',
  itemName: 'Classic lobster roll',
  priceCents,
  currency: 'USD',
  visitDate,
  visitDatePrecision: 'day',
  reporterId: 'ellis',
  reportedAt: `${visitDate}T20:00:00.000Z`,
});
async function draw(reports: PriceObservation[]) {
  const [series] = priceSeries(reports);
  await act(async () =>
    root.render(createElement(PriceHistoryChart, { series, restaurantName: 'Harbor Shack' })),
  );
  return container.querySelector('svg')!;
}
const xs = () =>
  [...container.querySelectorAll('.price-point circle.price-dot')].map((dot) =>
    Number(dot.getAttribute('cx')),
  );

describe('PriceHistoryChart', () => {
  const summer = [
    report('jun', '2026-06-14', 2500),
    report('jul', '2026-07-18', 2600),
    report('sep', '2026-09-11', 2800),
  ];

  it('spaces the visits by the days between them, not by their order', async () => {
    await draw(summer);
    const [june, july, september] = xs();
    // Jun 14 to Jul 18 is 34 days; Jul 18 to Sep 11 is 55.
    expect((july - june) / (september - july)).toBeCloseTo(34 / 55, 2);
  });

  it('draws in the box it is given, so its 12px labels stay 12px at any width', async () => {
    for (const width of [600, 300]) {
      measured = width;
      const svg = await draw(summer);
      expect(svg.getAttribute('viewBox')).toBe(`0 0 ${width} ${svg.getAttribute('height')}`);
      expect(svg.getAttribute('width')).toBe(String(width));
      const labels = [...svg.querySelectorAll('text')];
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels)
        expect(Number(label.getAttribute('font-size'))).toBeGreaterThanOrEqual(12);
      expect(Math.max(...xs())).toBeLessThanOrEqual(width);
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it('draws one point per visit, so a month report never sits beside a day inside it', async () => {
    const june = { ...report('june', '2026-06', 2400), visitDatePrecision: 'month' as const };
    await draw([june, ...summer]);
    expect(xs()).toHaveLength(3);
    expect(
      [...container.querySelectorAll('.price-point > title')].map((item) => item.textContent),
    ).toEqual(['$25.00 · Jun 14, 2026', '$26.00 · Jul 18, 2026', '$28.00 · Sep 11, 2026']);
  });

  it('puts the first and last visit dates under their points and a value scale beside them', async () => {
    const svg = await draw(summer);
    const dates = [...svg.querySelectorAll('.price-chart-date')];
    expect(dates.map((label) => label.textContent)).toEqual(['Jun 14, 2026', 'Sep 11, 2026']);
    const [first, , last] = xs();
    expect(Number(dates[0].getAttribute('x'))).toBe(first);
    expect(Number(dates[1].getAttribute('x'))).toBe(last);
    expect([...svg.querySelectorAll('.price-chart-tick')].map((tick) => tick.textContent)).toEqual([
      '$25',
      '$26',
      '$27',
      '$28',
    ]);
  });

  it('names each value for hover and for assistive technology', async () => {
    const svg = await draw(summer);
    // A group, not one picture: its points are named and reachable one by one.
    expect(svg.getAttribute('role')).toBe('group');
    const [title, desc] = [
      svg.getAttribute('aria-labelledby'),
      svg.getAttribute('aria-describedby'),
    ].map((id) => document.getElementById(id ?? '')?.textContent);
    expect(title).toBe('Classic lobster roll at Harbor Shack');
    expect(desc).toBe('Jun 14, 2026: $25.00. Jul 18, 2026: $26.00. Sep 11, 2026: $28.00.');
    expect(
      [...svg.querySelectorAll('.price-point')].map((point) => [
        point.getAttribute('role'),
        point.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['img', 'Jun 14, 2026: $25.00'],
      ['img', 'Jul 18, 2026: $26.00'],
      ['img', 'Sep 11, 2026: $28.00'],
    ]);
    expect(
      [...svg.querySelectorAll('.price-point > title')].map((item) => item.textContent),
    ).toEqual(['$25.00 · Jun 14, 2026', '$26.00 · Jul 18, 2026', '$28.00 · Sep 11, 2026']);
  });

  describe('reading a value without a mouse', () => {
    const points = () => [...container.querySelectorAll<SVGGElement>('.price-point')];
    const stops = () => points().map((point) => point.getAttribute('tabindex'));
    const press = (target: Element, key: string) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    const shown = () => points().map((point) => point.hasAttribute('data-shown'));
    const pointerDown = (target: Element) =>
      act(async () => {
        target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });

    it('is one tab stop, on the latest visit, that the arrow keys move along', async () => {
      await draw(summer);
      expect(stops()).toEqual(['-1', '-1', '0']);
      const [first, second, last] = points();
      await act(async () => last.focus());
      await press(last, 'ArrowLeft');
      expect(document.activeElement).toBe(second);
      // The tab stop follows focus, so leaving and coming back lands where the member was.
      expect(stops()).toEqual(['-1', '0', '-1']);
      await press(second, 'ArrowLeft');
      expect(document.activeElement).toBe(first);
      // The ends stop the walk instead of wrapping.
      await press(first, 'ArrowLeft');
      expect(document.activeElement).toBe(first);
      await press(first, 'End');
      expect(document.activeElement).toBe(last);
      await press(last, 'ArrowRight');
      expect(document.activeElement).toBe(last);
      await press(last, 'Home');
      expect(document.activeElement).toBe(first);
    });

    it('shows the value of the focused point, and only that one', async () => {
      await draw(summer);
      expect(shown()).toEqual([false, false, false]);
      const [first, second] = points();
      await act(async () => first.focus());
      expect(shown()).toEqual([true, false, false]);
      await press(first, 'ArrowRight');
      expect(document.activeElement).toBe(second);
      expect(shown()).toEqual([false, true, false]);
      await act(async () => second.blur());
      expect(shown()).toEqual([false, false, false]);
    });

    it('shows the value of a point that is tapped, until the next tap elsewhere', async () => {
      await draw(summer);
      const [first, second] = points();
      // A touch screen may never focus a tapped point, so the tap itself shows the value.
      await pointerDown(first.querySelector('.price-hit')!);
      expect(shown()).toEqual([true, false, false]);
      await pointerDown(second.querySelector('.price-dot')!);
      expect(shown()).toEqual([false, true, false]);
      await pointerDown(document.body);
      expect(shown()).toEqual([false, false, false]);
    });
  });

  it('says so when the price has not moved, instead of drawing a flat line on the floor', async () => {
    await draw([
      report('may', '2026-05-01', 2900),
      report('jul', '2026-07-01', 2900),
      report('sep', '2026-09-01', 2900),
    ]);
    expect(container.querySelector('.price-chart-caption')?.textContent).toBe(
      'No change across 3 reports',
    );
    const ys = [...container.querySelectorAll('.price-point circle.price-dot')].map((dot) =>
      Number(dot.getAttribute('cy')),
    );
    const height = Number(container.querySelector('svg')!.getAttribute('height'));
    // Level, and in the middle of the plot rather than on its bottom edge.
    expect(new Set(ys).size).toBe(1);
    expect(
      [...container.querySelectorAll('.price-chart-tick')].map((tick) => tick.textContent),
    ).toEqual(['$28', '$29', '$30']);
    expect(ys[0]).toBeGreaterThan(height * 0.25);
    expect(ys[0]).toBeLessThan(height * 0.75);
  });
});
