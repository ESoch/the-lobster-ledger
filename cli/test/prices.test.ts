import { describe, expect, it } from 'vitest';
import { runCli } from '../src/runner';
import { priceRows, renderPriceTable } from '../src/prices';
import { ApiClient, type Credentials, type SessionStore } from '../src/auth';
import type { LedgerState, PriceObservation } from '../../src/lib/types';

const restaurants = [
  { id: 'r1', name: 'Harbor Shack', address: '1 Pier Rd' },
  { id: 'r2', name: 'Dock & Roll', address: '2 Wharf St' },
];
const report = (over: Partial<PriceObservation>): PriceObservation => ({
  id: 'p',
  restaurantId: 'r1',
  itemName: 'Classic roll',
  priceCents: 2800,
  currency: 'USD',
  visitDate: '2026-08-01',
  visitDatePrecision: 'day',
  reporterId: 'a',
  reportedAt: '2026-08-02T00:00:00.000Z',
  ...over,
});
const observations = [
  report({ id: 'old', priceCents: 2600, visitDate: '2026-06-01' }),
  report({ id: 'mid', priceCents: 2800, correctedAt: '2026-08-03T00:00:00.000Z' }),
  report({
    id: 'fix',
    priceCents: 2850,
    correctedFromId: 'mid',
    reportedAt: '2026-08-03T00:00:00.000Z',
  }),
  report({ id: 'case', itemName: 'Classic  Roll', priceCents: 3000, visitDate: '2026-09-10' }),
  report({
    id: 'lite',
    itemName: 'Lite roll',
    priceCents: 1900,
    visitDate: '2025',
    visitDatePrecision: 'year',
  }),
  report({ id: 'dock', restaurantId: 'r2', priceCents: 3200 }),
];
// A later, higher report that its reporter withdrew, and an item that only has a withdrawn report.
const withdrawn = [
  report({
    id: 'oops',
    priceCents: 9900,
    visitDate: '2026-10-01',
    withdrawnAt: '2026-10-02T00:00:00.000Z',
    withdrawnReason: 'Wrong restaurant',
  }),
  report({
    id: 'ghost',
    itemName: 'Ghost roll',
    priceCents: 100,
    withdrawnAt: '2026-10-02T00:00:00.000Z',
    withdrawnReason: 'Typed it twice',
  }),
];
const state = (extra: PriceObservation[] = []): LedgerState => ({
  members: [{ id: 'a', name: 'Alex', initials: 'A', color: '#000' }],
  bets: [],
  places: [],
  restaurants,
  priceObservations: [...observations, ...extra],
  groupName: 'Friends',
});

describe('price rows', () => {
  it('shows each restaurant item once with its latest live price, date and report count', () => {
    const rows = priceRows(state());
    expect(rows.map((row) => [row.restaurant, row.item, row.priceCents, row.reportCount])).toEqual([
      ['Dock & Roll', 'Classic roll', 3200, 1],
      ['Harbor Shack', 'Classic  Roll', 3000, 3],
      ['Harbor Shack', 'Lite roll', 1900, 1],
    ]);
    expect(rows[1]).toMatchObject({ visitDate: '2026-09-10', visitDatePrecision: 'day' });
  });
  it('leaves superseded reports out unless --all asks for them, and marks them', () => {
    const rows = priceRows(state(), { all: true });
    const harbor = rows.filter((row) => row.restaurantId === 'r1' && row.item !== 'Lite roll');
    expect(harbor).toHaveLength(4);
    expect(harbor.find((row) => row.id === 'mid')).toMatchObject({ live: false });
    expect(harbor.find((row) => row.id === 'case')).toMatchObject({ live: true });
  });
  it('leaves withdrawn reports out of the latest price and the count unless --all asks', () => {
    const rows = priceRows(state(withdrawn));
    expect(rows.map((row) => [row.restaurant, row.item, row.priceCents, row.reportCount])).toEqual([
      ['Dock & Roll', 'Classic roll', 3200, 1],
      ['Harbor Shack', 'Classic  Roll', 3000, 3],
      ['Harbor Shack', 'Lite roll', 1900, 1],
    ]);
    expect(rows.every((row) => row.live && !row.withdrawn)).toBe(true);
    expect(renderPriceTable(rows)).not.toMatch(/Ghost|\$99\.00|withdrawn/);
  });
  it('lists withdrawn reports with --all, marked withdrawn and not counted', () => {
    const rows = priceRows(state(withdrawn), { all: true });
    expect(rows.find((row) => row.id === 'oops')).toMatchObject({
      live: false,
      withdrawn: true,
      reportCount: 3,
    });
    expect(rows.find((row) => row.id === 'ghost')).toMatchObject({
      live: false,
      withdrawn: true,
      reportCount: 0,
    });
    // Superseded, not withdrawn: a correction replaced it.
    expect(rows.find((row) => row.id === 'mid')).toMatchObject({ live: false, withdrawn: false });
    expect(rows.find((row) => row.id === 'case')).toMatchObject({ live: true, withdrawn: false });
    const table = renderPriceTable(rows);
    expect(table).toMatch(/Ghost roll.*\$1\.00.*0 reports.*withdrawn/);
    expect(table).toMatch(/\$28\.00.*superseded/);
  });
  it('filters by restaurant id or name, ignoring case, and rejects an unknown one', () => {
    expect(priceRows(state(), { restaurant: 'r2' })).toHaveLength(1);
    expect(priceRows(state(), { restaurant: ' harbor SHACK ' })).toHaveLength(2);
    expect(() => priceRows(state(), { restaurant: 'nowhere' })).toThrow(/No restaurant/);
  });
  it('points an unknown restaurant at names the table shows and IDs only --json shows', () => {
    const message = (() => {
      try {
        priceRows(state(), { restaurant: 'nowhere' });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toBe(
      'No restaurant matches "nowhere". Use a restaurant name from lobster prices list, or an ID from lobster prices list --json.',
    );
    // The table names restaurants but carries no IDs; the JSON rows do.
    const rows = priceRows(state());
    const table = renderPriceTable(rows);
    expect(table).toContain('Harbor Shack');
    expect(table).not.toContain('r1');
    expect(rows.every((row) => row.restaurantId)).toBe(true);
  });
  it('copes with a ledger that has no prices', () => {
    expect(priceRows({ ...state(), restaurants: undefined, priceObservations: undefined })).toEqual(
      [],
    );
    expect(renderPriceTable([])).toBe('No prices on record.');
  });
  it('renders dollars, the date as precisely as it was reported, and the report count', () => {
    const table = renderPriceTable(priceRows(state()));
    expect(table).toContain('$30.00');
    expect(table).toContain('Sep 10, 2026');
    expect(table).toContain('2025');
    expect(table).toContain('3 reports');
    expect(table).toContain('1 report');
  });
});

describe('lobster prices list', () => {
  const run = async (args: string[], extra: PriceObservation[] = []) => {
    const saved: Credentials = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 999999,
      member: { id: 'a', name: 'Alex' },
      sessionId: 's',
    };
    const store: SessionStore = {
      read: async () => saved,
      write: async () => {},
      clear: async () => {},
      locked: async (fn) => fn(),
    };
    const requests: { url: string; method?: string }[] = [];
    const client = new ApiClient('https://ledger.example', store, async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      return Response.json(state(extra));
    });
    const output: string[] = [];
    await runCli(['prices', 'list', ...args], (value) => output.push(value), { client });
    return { output: output.join('\n'), requests };
  };
  it('reads only the ledger the CLI already downloads', async () => {
    const { output, requests } = await run([]);
    expect(requests.map((request) => request.url)).toEqual(['https://ledger.example/api/ledger']);
    expect(requests.every((request) => !request.method || request.method === 'GET')).toBe(true);
    expect(output).toContain('Harbor Shack');
    expect(output).toContain('$30.00');
  });
  it('prints machine-readable rows with --json and honours --restaurant', async () => {
    const { output } = await run(['--restaurant', 'Dock & Roll', '--json']);
    expect(JSON.parse(output)).toEqual([
      expect.objectContaining({
        restaurantId: 'r2',
        restaurant: 'Dock & Roll',
        priceCents: 3200,
        reportCount: 1,
      }),
    ]);
  });
  it('leaves withdrawn and superseded reports out by default and adds them with --all', async () => {
    const plain = await run(['--json'], withdrawn);
    const ids = (JSON.parse(plain.output) as { id: string }[]).map((row) => row.id);
    expect(ids).not.toContain('oops');
    expect(ids).not.toContain('ghost');
    expect(ids).not.toContain('mid');
    const all = await run(['--all', '--json'], withdrawn);
    const rows = JSON.parse(all.output) as { id: string; withdrawn: boolean }[];
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(['oops', 'ghost', 'mid']));
    expect(rows.find((row) => row.id === 'oops')?.withdrawn).toBe(true);
  });
});
