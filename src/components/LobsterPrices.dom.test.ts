// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LobsterPrices } from './LobsterPrices';
import {
  lobsterMarketHistory,
  marketDate,
  marketPrice,
  type LobsterMarketHistory,
} from '../lib/lobster-market';
import { downloadFile } from '../lib/export';

vi.mock('../lib/export', async (original) => ({
  ...(await original<typeof import('../lib/export')>()),
  downloadFile: vi.fn(),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(LobsterPrices)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

describe('historical lobster price tracker', () => {
  it('labels the market, frequency, units, and actual published year', () => {
    const latest = lobsterMarketHistory.observations.at(-1)!;
    expect(container.textContent).toContain(`Latest published year · ${latest.year}`);
    expect(container.textContent).toContain('Maine · American lobster');
    expect(container.textContent).toContain('Annual average paid to harvesters');
    expect(container.querySelector('.market-readout')?.textContent).toContain(
      `${marketPrice(latest.priceCentsPerLb)}/lb`,
    );
    expect(
      container.querySelector('a[href="' + lobsterMarketHistory.sourceUrl + '"]'),
    ).toBeTruthy();
  });

  it('changes range, supports keyboard year inspection, and exports the selected range', async () => {
    await click('5 years');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    const slider = container.querySelector<HTMLInputElement>('.market-year-control input')!;
    const firstYear = Number(slider.min);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        slider,
        String(firstYear),
      );
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const observation = lobsterMarketHistory.observations.find((row) => row.year === firstYear)!;
    expect(container.querySelector('.market-readout')?.textContent).toContain(
      `${firstYear} ${marketPrice(observation.priceCentsPerLb)}/lb`,
    );
    await click('Export CSV');
    expect(downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('"USD per lb"'),
      expect.stringMatching(/^lobster-prices-\d{4}-\d{4}\.csv$/),
      'text/csv;charset=utf-8',
    );
    expect(vi.mocked(downloadFile).mock.calls[0][0].split('\r\n')).toHaveLength(6);
    await click('All history');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(
      lobsterMarketHistory.observations.length,
    );
    expect(slider.min).toBe('1950');
  });
});

describe('market data freshness', () => {
  afterEach(() => vi.useRealTimers());
  async function renderOn(day: string, history: LobsterMarketHistory = lobsterMarketHistory) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${day}T12:00:00Z`));
    await act(async () => root.render(createElement(LobsterPrices, { history })));
  }
  const notice = () => container.querySelector('.market-update-notice[role="status"]')?.textContent;
  // A pinned fixture, so a refreshed checked-in release cannot flip the dated checks below.
  const through2025: LobsterMarketHistory = {
    ...lobsterMarketHistory,
    sourceUpdatedOn: '2026-02-06',
    observations: lobsterMarketHistory.observations.filter((row) => row.year <= 2025),
  };

  it('leads with the age of the data, derived from the series', async () => {
    const latest = lobsterMarketHistory.observations.at(-1)!;
    await renderOn('2026-10-24');
    const line = `Data through ${latest.year}${latest.preliminary ? ' (preliminary)' : ''} · DMR release ${marketDate(lobsterMarketHistory.sourceUpdatedOn)}`;
    expect(container.querySelector('.market-data-age')?.textContent).toBe(line);
    expect(container.firstElementChild?.firstElementChild?.textContent).toBe(line);

    const observations = [
      ...lobsterMarketHistory.observations.slice(0, -1),
      { ...latest, year: latest.year + 1, preliminary: false },
    ];
    await renderOn('2026-10-24', {
      ...lobsterMarketHistory,
      sourceUpdatedOn: '2031-03-09',
      observations,
    });
    expect(container.querySelector('.market-data-age')?.textContent).toBe(
      `Data through ${latest.year + 1} · DMR release Mar 9, 2031`,
    );
  });

  it('shows no overdue message for current data, however old the last source check is', async () => {
    await renderOn('2026-10-24', { ...lobsterMarketHistory, checkedAt: '2026-10-01T00:00:00Z' });
    expect(notice()).toBeUndefined();
    expect(container.textContent).not.toMatch(/overdue/i);
    expect(container.querySelector('.market-data-age.late')).toBeNull();
    expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
  });

  it('judges data with an unreadable release date by its year, not as late', async () => {
    const malformed = { ...through2025, sourceUpdatedOn: 'invalid' };
    await renderOn('2026-10-24', malformed);
    expect(notice()).toBeUndefined();
    expect(container.querySelector('.market-data-age')?.textContent).toContain(
      'DMR release date unavailable',
    );
    await renderOn('2027-09-01', malformed);
    expect(notice()).toContain('later than expected');
  });

  it('keeps the last source check as a quiet provenance line', async () => {
    await renderOn('2026-10-24', {
      ...lobsterMarketHistory,
      checkedAt: '2026-10-15T17:56:57Z',
      checkMethod: undefined,
    });
    const source = container.querySelector('.market-source-panel')?.textContent;
    expect(source).toContain('Automatic source check last succeeded Oct 15, 2026');
    expect(container.querySelector('.market-intro')?.textContent).not.toContain('Oct 15');
  });

  it('says a snapshot imported from a downloaded file was checked by hand', async () => {
    await renderOn('2026-10-24', {
      ...lobsterMarketHistory,
      checkedAt: '2026-10-19T09:30:00Z',
      checkMethod: 'manual-file',
    });
    const source = container.querySelector('.market-source-panel')?.textContent;
    expect(source).toContain('Source file checked by hand Oct 19, 2026 (UTC).');
    expect(source).not.toContain('Automatic source check');
  });

  it('promises a weekly check only when the automatic check made the last one', async () => {
    await renderOn('2026-10-24', { ...lobsterMarketHistory, checkMethod: undefined });
    const source = () => container.querySelector('.market-source-panel p')?.textContent;
    expect(source()).toContain('New publications and revisions are checked weekly.');
    // A file checked by hand means the weekly automatic check is not getting through.
    await renderOn('2026-10-24', { ...lobsterMarketHistory, checkMethod: 'manual-file' });
    expect(source()).toMatch(/checked by hand [A-Z][a-z]{2} \d{1,2}, \d{4} \(UTC\)\.$/);
    expect(source()).not.toMatch(/weekly/);
  });

  it('shows only a gentle next-update note while the annual update is awaited', async () => {
    await renderOn('2027-02-15', through2025);
    expect(notice()).toContain('next annual update');
    expect(notice()).not.toMatch(/later than expected|overdue/i);
    expect(container.querySelector('.market-data-age.late')).toBeNull();
  });

  it('sets a late notice apart in the warning tone and points to the last successful check', async () => {
    await renderOn('2027-09-01', { ...through2025, checkedAt: '2026-10-15T17:56:57Z' });
    const late = container.querySelector('.market-update-notice')!;
    expect(late.className).toContain('warning');
    expect(late.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.market-source-panel p')?.textContent).toContain(
      'Automatic source check last succeeded Oct 15, 2026',
    );
    await renderOn('2027-02-15', through2025);
    expect(container.querySelector('.market-update-notice')?.className).not.toContain('warning');
  });

  it('shows a late notice only after the grace period, keeping validated history visible', async () => {
    await renderOn('2027-09-01', through2025);
    expect(notice()).toContain('later than expected');
    expect(container.querySelector('.market-data-age.late')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
  });

  it('calls the highest-price card nominal and derives its year from the series', async () => {
    const high = lobsterMarketHistory.observations.reduce((best, row) =>
      row.priceCentsPerLb > best.priceCentsPerLb ? row : best,
    );
    await renderOn('2026-10-24');
    expect(container.textContent).toContain(`Highest nominal price · ${high.year}`);
    expect(container.textContent).not.toContain('Highest annual price');
  });
});

describe('the market chart, table and links', () => {
  const latest = lobsterMarketHistory.observations.at(-1)!;
  const readout = () => container.querySelector('.market-readout strong')?.textContent;
  const area = () => container.querySelector<HTMLElement>('.market-plot-area')!;
  /** Lays the plot out 900px wide from x=100, as a browser would. */
  const layOut = () => {
    area().getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 900, height: 248, right: 1000, bottom: 248 }) as DOMRect;
  };
  const pointer = (type: string, clientX: number, init: PointerEventInit = {}) =>
    act(async () => {
      area().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX,
          pointerId: 1,
          pointerType: 'mouse',
          ...init,
        }),
      );
    });
  const atYear = (year: number, first: number) =>
    100 + (900 * (year - first)) / (latest.year - first);

  it('places each year label at its own data position', async () => {
    await click('10 years');
    const first = latest.year - 9;
    const labels = [...container.querySelectorAll<HTMLElement>('.market-x-axis span')];
    expect(labels.map((label) => label.textContent)).toEqual([
      String(first),
      String(Math.round((first + latest.year) / 2)),
      String(latest.year),
    ]);
    for (const label of labels) {
      const year = Number(label.textContent);
      expect(Number.parseFloat(label.style.left)).toBeCloseTo(
        ((year - first) / (latest.year - first)) * 100,
        3,
      );
    }
  });

  it('sets each price on the scale level with its gridline, at round steps', async () => {
    const ticks = [...container.querySelectorAll<HTMLElement>('.market-y-axis span')];
    const lines = [...container.querySelectorAll('.market-grid-line')];
    expect(ticks.length).toBe(lines.length);
    ticks.forEach((tick, index) => {
      const y = Number(lines[index].getAttribute('y1'));
      // The drawing runs from -12 to 252 units over the plot's height.
      expect(Number.parseFloat(tick.style.top)).toBeCloseTo(((y + 12) / 264) * 100, 3);
    });
    const cents = ticks.map((tick) => Math.round(Number(tick.textContent!.slice(1)) * 100));
    const steps = new Set(cents.slice(1).map((value, index) => cents[index] - value));
    expect(steps.size).toBe(1);
    expect([25, 50, 100, 200, 250, 500]).toContain([...steps][0]);
  });

  it('inspects the year under a mouse press, a hover and a tap, but not a page scroll', async () => {
    await click('10 years');
    layOut();
    const first = latest.year - 9;
    await pointer('pointerdown', atYear(2021, first));
    expect(readout()).toMatch(/^2021 /);
    await pointer('pointerup', atYear(2021, first));
    await pointer('pointermove', atYear(2018, first));
    expect(readout()).toMatch(/^2018 /);
    // A finger that starts a vertical scroll on the chart leaves the year alone.
    const touch = { pointerType: 'touch', pointerId: 2 };
    await pointer('pointerdown', atYear(2023, first), touch);
    await pointer('pointercancel', atYear(2023, first), touch);
    expect(readout()).toMatch(/^2018 /);
    // A tap picks the year under the finger.
    await pointer('pointerdown', atYear(2023, first), touch);
    await pointer('pointerup', atYear(2023, first), touch);
    expect(readout()).toMatch(/^2023 /);
    // A sideways drag scrubs.
    await pointer('pointerdown', atYear(2023, first), touch);
    await pointer('pointermove', atYear(2017, first), touch);
    expect(readout()).toMatch(/^2017 /);
  });

  it('marks the inspected year with a round marker outside the stretched drawing', async () => {
    expect(container.querySelector('.market-plot svg circle')).toBeNull();
    const marker = container.querySelector<HTMLElement>('.market-marker')!;
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(100, 3);
  });

  it('names the year slider by its visible label and says the price it is on', async () => {
    const slider = container.querySelector<HTMLInputElement>('.market-year-control input')!;
    expect(slider.getAttribute('aria-label')).toBeNull();
    expect(slider.labels?.[0]?.textContent).toBe('Inspect year');
    expect(slider.getAttribute('aria-valuetext')).toBe(
      `${latest.year}: ${marketPrice(latest.priceCentsPerLb)} per pound${latest.preliminary ? ', preliminary' : ''}`,
    );
    // The visible year beside the slider is not a second voice either.
    expect(container.querySelectorAll('output')).toHaveLength(0);
  });

  it('says a slider step once, through the slider, and a pointer inspection in its own status', async () => {
    const readoutBox = container.querySelector('.market-readout')!;
    // The readout above the chart is for the eye: a live readout would repeat every slider step.
    expect(readoutBox.closest('[aria-live], [role="status"]')).toBeNull();
    const spoken = () => container.querySelector('.market-chart-panel [role="status"]');
    expect(spoken()?.classList.contains('sr-only')).toBe(true);
    expect(spoken()?.textContent).toBe('');
    const slider = container.querySelector<HTMLInputElement>('.market-year-control input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        slider,
        String(latest.year - 2),
      );
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const year = lobsterMarketHistory.observations.find((row) => row.year === latest.year - 2)!;
    expect(readout()).toMatch(new RegExp(`^${year.year} `));
    expect(slider.getAttribute('aria-valuetext')).toBe(
      `${year.year}: ${marketPrice(year.priceCentsPerLb)} per pound${year.preliminary ? ', preliminary' : ''}`,
    );
    expect(spoken()?.textContent).toBe('');
    // A mouse or a finger on the chart has no value text of its own, so the status says it.
    await click('10 years');
    layOut();
    const first = latest.year - 9;
    await pointer('pointerdown', atYear(2021, first));
    const inspected = lobsterMarketHistory.observations.find((row) => row.year === 2021)!;
    expect(spoken()?.textContent).toBe(
      `2021: ${marketPrice(inspected.priceCentsPerLb)} per pound${inspected.preliminary ? ', preliminary' : ''}`,
    );
    // A new range starts again at the latest year, and an old inspection is not left to be read.
    await click('25 years');
    expect(spoken()?.textContent).toBe('');
  });

  it('clears a pointer inspection from the status when the slider moves to another year', async () => {
    const spoken = () => container.querySelector('.market-chart-panel [role="status"]');
    await click('10 years');
    layOut();
    const first = latest.year - 9;
    await pointer('pointerdown', atYear(2021, first));
    expect(spoken()?.textContent).toMatch(/^2021: /);
    // A slider step speaks through aria-valuetext, so the status must not keep reading the old year.
    const slider = container.querySelector<HTMLInputElement>('.market-year-control input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        slider,
        String(2022),
      );
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(slider.getAttribute('aria-valuetext')).toMatch(/^2022: /);
    expect(spoken()?.textContent).toBe('');
  });

  it('makes the annual table a named region the keyboard can scroll, with the status beside each year on phones', async () => {
    const scroller = container.querySelector('.market-table-scroll')!;
    expect(scroller.getAttribute('role')).toBe('region');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('aria-label')).toBe('Annual lobster prices table');
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows[0].querySelector('th .market-year-status')?.textContent).toBe(
      latest.preliminary ? 'Preliminary' : 'Final',
    );
    expect(rows.at(-1)!.querySelector('td:last-child')?.textContent).toBe('Final');
  });

  it('writes a fall in the same minus sign in the price and the percentage', async () => {
    const card = [...container.querySelectorAll('.market-stat')][1];
    const [price, percent] = [card.querySelector('strong'), card.querySelector('p')].map(
      (element) => element?.textContent ?? '',
    );
    const previous = lobsterMarketHistory.observations.at(-2)!;
    if (latest.priceCentsPerLb < previous.priceCentsPerLb) {
      expect(price.startsWith('−')).toBe(true);
      expect(percent.startsWith('−')).toBe(true);
    }
    expect(percent).not.toMatch(/^-/);
  });

  it('opens Roll prices through the app, and confirms an export', async () => {
    const onNavigate = vi.fn();
    const onNotify = vi.fn();
    await act(async () => root.render(createElement(LobsterPrices, { onNavigate, onNotify })));
    const link = [...container.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Restaurant roll prices',
    )!;
    expect(link.getAttribute('href')).toBe('#places/prices');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith('places/prices');
    await click('Export CSV');
    expect(onNotify).toHaveBeenCalledWith(
      `Downloaded lobster-prices-${latest.year - 24}-${latest.year}.csv with 25 years of prices.`,
    );
  });

  it('draws a preliminary year apart from the final ones: a dashed segment, an open point and a note', async () => {
    expect(latest.preliminary).toBe(true);
    const first = latest.year - 24;
    const x = (year: number) => (900 * (year - first)) / (latest.year - first);
    const points = (selector: string) =>
      [
        ...container
          .querySelector(selector)!
          .getAttribute('d')!
          .matchAll(/[ML]([\d.]+),/g),
      ].map((match) => Number(match[1]));
    // The solid line stops at the last final year; the dashed one carries on to the preliminary one.
    expect(points('.market-price-line:not(.pending)').at(-1)).toBeCloseTo(x(latest.year - 1), 3);
    expect(points('.market-price-line.pending')).toEqual([
      expect.closeTo(x(latest.year - 1), 3),
      expect.closeTo(x(latest.year), 3),
    ]);
    // The open point sits on the preliminary year even when another year is being inspected.
    const open = container.querySelectorAll<HTMLElement>('.market-point-pending');
    expect(open).toHaveLength(1);
    expect(Number.parseFloat(open[0].style.left)).toBeCloseTo(100, 3);
    expect(open[0].getAttribute('aria-hidden')).toBe('true');
    const marker = container.querySelector('.market-marker')!;
    expect(marker.classList.contains('preliminary')).toBe(true);
    expect(container.querySelector('.market-chart-caption')?.textContent).toContain(
      `${latest.year} is preliminary`,
    );
    await click('10 years');
    layOut();
    await pointer('pointerdown', atYear(2021, latest.year - 9));
    expect(container.querySelector('.market-marker')!.classList.contains('preliminary')).toBe(
      false,
    );
    expect(container.querySelectorAll('.market-point-pending')).toHaveLength(1);
  });

  it('draws a series that is all final in one solid line, with nothing said about preliminary', async () => {
    const final: LobsterMarketHistory = {
      ...lobsterMarketHistory,
      observations: lobsterMarketHistory.observations.map((row) => ({
        ...row,
        preliminary: false,
      })),
    };
    await act(async () => root.render(createElement(LobsterPrices, { history: final })));
    expect(container.querySelector('.market-price-line.pending')).toBeNull();
    expect(container.querySelector('.market-point-pending')).toBeNull();
    expect(container.querySelector('.market-marker')!.classList.contains('preliminary')).toBe(
      false,
    );
    expect(container.querySelector('.market-chart-caption')?.textContent).not.toMatch(
      /preliminary/i,
    );
  });

  it('says in words that the two source links open a new tab', () => {
    const external = [
      ...container.querySelectorAll<HTMLAnchorElement>('.market-source-links a[target="_blank"]'),
    ];
    expect(external).toHaveLength(2);
    for (const link of external) {
      expect(link.querySelector('.sr-only')?.textContent).toBe(' (opens in a new tab)');
      expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    // The in-app link stays in the tab, so it says nothing of the kind.
    const inApp = container.querySelector('.market-source-links a[href="#places/prices"]')!;
    expect(inApp.textContent).toBe('Restaurant roll prices');
  });
});
