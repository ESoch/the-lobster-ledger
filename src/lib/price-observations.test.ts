import { describe, expect, it } from 'vitest';
import {
  compareByVisit,
  findDuplicateReport,
  findRestaurant,
  isLiveReport,
  isOldReport,
  itemKey,
  latestObservation,
  localDay,
  parsePriceCents,
  planPriceReport,
  plausibility,
  previousVisitReport,
  priceDateLabel,
  priceProblem,
  priceSeries,
  restaurantKey,
  restaurantsNamed,
  seriesChange,
  visitPeriod,
} from './price-observations';
import type { PriceObservation, PriceReportInput } from './types';

const report = (overrides: Partial<PriceObservation>): PriceObservation => ({
  id: 'x',
  restaurantId: 'r',
  itemName: 'Classic lobster roll',
  priceCents: 2500,
  currency: 'USD',
  visitDate: '2026-10-01',
  visitDatePrecision: 'day',
  reporterId: 'ellis',
  reportedAt: '2026-10-01T12:00:00.000Z',
  ...overrides,
});

it('orders same-day reports by when they were reported so every view picks the same latest price', () => {
  const earlier = report({ id: 'b', priceCents: 2800, reportedAt: '2026-10-01T12:00:00.000Z' });
  const later = report({ id: 'a', priceCents: 3000, reportedAt: '2026-10-01T18:00:00.000Z' });
  const older = report({ id: 'c', priceCents: 2600, visitDate: '2026-09-11' });
  const ordered = [later, older, earlier].sort(compareByVisit);
  expect(ordered.map((item) => item.priceCents)).toEqual([2600, 2800, 3000]);
  expect(ordered.at(-1)).toBe(later);
  expect([earlier, later].sort(compareByVisit).at(-1)).toBe(later);
  expect([later, earlier].sort(compareByVisit).at(-1)).toBe(later);
});

it('compares the latest price with the last report from an earlier visit day, never a same-day one', () => {
  const morning = report({ id: 'a', priceCents: 2800, reportedAt: '2026-10-01T12:00:00.000Z' });
  const evening = report({ id: 'b', priceCents: 3000, reportedAt: '2026-10-01T18:00:00.000Z' });
  const lastMonth = report({ id: 'c', priceCents: 2600, visitDate: '2026-09-11' });
  const older = report({ id: 'd', priceCents: 2400, visitDate: '2026-08-01' });
  const ordered = [evening, older, morning, lastMonth].sort(compareByVisit);
  expect(previousVisitReport(ordered)).toBe(lastMonth);
  expect(previousVisitReport([morning, evening].sort(compareByVisit))).toBeUndefined();
  expect(previousVisitReport([evening])).toBeUndefined();
});

describe('itemKey', () => {
  it('gives every spelling of the same label one key', () => {
    const key = itemKey('Classic lobster roll');
    for (const spelling of [
      'classic lobster roll',
      '  Classic   Lobster\tRoll ',
      'CLASSIC LOBSTER ROLL',
      // Full-width letters and a no-break space fold to the same text under NFKC.
      'Ｃｌａｓｓｉｃ lobster roll',
    ])
      expect(itemKey(spelling)).toBe(key);
    expect(key).toBe('classic lobster roll');
  });

  it('keeps different items apart, with no synonyms', () => {
    expect(itemKey('Classic roll')).not.toBe(itemKey('Classic lobster roll'));
    expect(itemKey('Connecticut roll')).not.toBe(itemKey('Classic lobster roll'));
  });
});

describe('restaurant matching', () => {
  const restaurants = [
    { id: 'harbor-shack', name: 'Harbor Shack', address: 'Seaport, Boston, MA' },
    { id: 'north-pier', name: 'North Pier Café', address: 'Waterfront, Boston, MA' },
  ];

  it('finds a restaurant whose name and address differ only in case and spacing', () => {
    expect(
      findRestaurant(restaurants, { name: ' harbor  shack', address: 'seaport, boston, ma ' }),
    ).toBe(restaurants[0]);
    expect(findRestaurant(restaurants, { name: 'Harbor Shack', address: '' })).toBeUndefined();
    expect(restaurantKey({ name: 'A', address: 'B' })).not.toBe(
      restaurantKey({ name: 'AB', address: '' }),
    );
  });

  it('lists every restaurant with the same name, whatever its address', () => {
    expect(restaurantsNamed(restaurants, 'HARBOR SHACK ')).toEqual([restaurants[0]]);
    expect(restaurantsNamed(restaurants, 'Harbor')).toEqual([]);
    expect(restaurantsNamed(restaurants, '  ')).toEqual([]);
  });
});

describe('findDuplicateReport', () => {
  const mine = report({ id: 'mine', reporterId: 'ellis', priceCents: 2800 });
  const visit = {
    reporterId: 'ellis',
    restaurantId: 'r',
    itemName: ' classic LOBSTER roll',
    visitDate: '2026-10-01',
    visitDatePrecision: 'day' as const,
  };

  it('finds a live report of the same visit by the same member', () => {
    expect(findDuplicateReport([mine], visit)).toBe(mine);
  });

  it('ignores another member, another restaurant, item, day or precision, and superseded reports', () => {
    expect(findDuplicateReport([mine], { ...visit, reporterId: 'alex' })).toBeUndefined();
    expect(findDuplicateReport([mine], { ...visit, restaurantId: 'other' })).toBeUndefined();
    expect(findDuplicateReport([mine], { ...visit, itemName: 'Connecticut roll' })).toBeUndefined();
    expect(findDuplicateReport([mine], { ...visit, visitDate: '2026-10-02' })).toBeUndefined();
    const monthly = report({ ...mine, visitDate: '2026-10', visitDatePrecision: 'month' });
    expect(
      findDuplicateReport([monthly], {
        ...visit,
        visitDate: '2026-10',
        visitDatePrecision: 'month',
      }),
    ).toBe(monthly);
    expect(findDuplicateReport([monthly], { ...visit, visitDate: '2026-10' })).toBeUndefined();
    expect(
      findDuplicateReport([{ ...mine, correctedAt: '2026-10-02T00:00:00.000Z' }], visit),
    ).toBeUndefined();
  });
});

describe('priceDateLabel', () => {
  it('names a visit as precisely as it was reported, always with its year', () => {
    expect(priceDateLabel({ visitDate: '2026-09-11', visitDatePrecision: 'day' })).toBe(
      'Sep 11, 2026',
    );
    expect(priceDateLabel({ visitDate: '2026-08', visitDatePrecision: 'month' })).toBe('Aug 2026');
    expect(priceDateLabel({ visitDate: '2024', visitDatePrecision: 'year' })).toBe('2024');
  });
});

describe('localDay', () => {
  it('is the calendar day on the member’s own clock, not in UTC', () => {
    const evening = new Date(2026, 9, 18, 21, 30);
    expect(localDay(evening)).toBe('2026-10-18');
    expect(localDay(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });
});

describe('planPriceReport', () => {
  const harbor = { id: 'harbor-shack', name: 'Harbor Shack', address: 'Seaport, Boston, MA' };
  let ids = 0;
  const plan = (
    input: Partial<PriceReportInput>,
    observations: PriceObservation[] = [],
    restaurants = [harbor],
  ) =>
    planPriceReport({
      input: {
        itemName: 'Classic lobster roll',
        priceCents: 2800,
        visitDate: '2026-10-01',
        visitDatePrecision: 'day',
        ...input,
      },
      reporterId: 'ellis',
      restaurants,
      observations,
      newId: () => `new-${++ids}`,
      now: '2026-10-02T00:00:00.000Z',
    });

  it('adds a restaurant only when no name and address on the record match it', () => {
    const added = plan({ restaurant: { name: 'Dockside', address: '' } });
    expect(added).toMatchObject({
      kind: 'record',
      newRestaurant: true,
      result: { matched: 'created', restaurant: { name: 'Dockside' } },
    });
    if (added.kind === 'record')
      expect(added.result.observation.restaurantId).toBe(added.result.restaurant.id);
    expect(
      plan({ restaurant: { name: 'harbor shack', address: 'SEAPORT, Boston, MA' } }),
    ).toMatchObject({
      kind: 'record',
      newRestaurant: false,
      result: { matched: 'normalised', restaurant: harbor },
    });
    expect(plan({ restaurantId: 'gone' })).toEqual({ kind: 'unknown-restaurant' });
  });

  it('treats a repeat of a visit at the same price as a retry, and another price as a question', () => {
    const mine = report({
      id: 'mine',
      restaurantId: 'harbor-shack',
      reporterId: 'ellis',
      priceCents: 2800,
    });
    expect(plan({ restaurantId: 'harbor-shack' }, [mine])).toMatchObject({
      kind: 'repeat',
      result: { observation: mine, duplicateOf: 'mine' },
    });
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 3000 }, [mine])).toEqual({
      kind: 'conflict',
      existing: mine,
    });
    expect(
      plan({ restaurantId: 'harbor-shack', priceCents: 3000, confirmSeparateReport: true }, [mine]),
    ).toMatchObject({ kind: 'record', result: { observation: { priceCents: 3000 } } });
  });

  it('treats a resend of either of two separate purchases as a retry', () => {
    const first = report({ id: 'first', restaurantId: 'harbor-shack', priceCents: 2500 });
    const separate = report({
      id: 'separate',
      restaurantId: 'harbor-shack',
      priceCents: 3000,
      reportedAt: '2026-10-01T18:00:00.000Z',
    });
    for (const [priceCents, existing] of [
      [2500, first],
      [3000, separate],
    ] as const) {
      expect(
        plan({ restaurantId: 'harbor-shack', priceCents }, [first, separate]),
        String(priceCents),
      ).toMatchObject({ kind: 'repeat', result: { duplicateOf: existing.id } });
      expect(
        plan({ restaurantId: 'harbor-shack', priceCents, confirmSeparateReport: true }, [
          first,
          separate,
        ]),
      ).toMatchObject({ kind: 'repeat', result: { duplicateOf: existing.id } });
    }
    // A third price is asked about against the latest of them.
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 3500 }, [first, separate])).toEqual({
      kind: 'conflict',
      existing: separate,
    });
  });

  it('does not count a withdrawn report as a visit already reported', () => {
    const withdrawn = report({
      id: 'withdrawn',
      restaurantId: 'harbor-shack',
      priceCents: 2500,
      withdrawnAt: '2026-10-01T20:00:00.000Z',
      withdrawnReason: 'Wrong restaurant',
    });
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 2500 }, [withdrawn])).toMatchObject({
      kind: 'record',
    });
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 3000 }, [withdrawn])).toMatchObject({
      kind: 'record',
    });
  });

  it('does not ask about a correct price that follows a kept slip', () => {
    const keptSlip = report({
      id: 'kept-slip',
      restaurantId: 'harbor-shack',
      reporterId: 'sarah',
      priceCents: 250,
      visitDate: '2026-09-01',
    });
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 2500 }, [keptSlip])).toMatchObject({
      kind: 'record',
    });
  });

  it('asks about an unusual price unless the member confirmed it', () => {
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 250 })).toMatchObject({
      kind: 'unusual',
      warnings: [{ suggestedCents: 2500 }],
    });
    expect(
      plan({ restaurantId: 'harbor-shack', priceCents: 250, confirmUnusualPrice: true }),
    ).toMatchObject({ kind: 'record' });
    // Against the last report of the same roll at the restaurant, even from another member.
    const theirs = report({
      id: 'theirs',
      restaurantId: 'harbor-shack',
      reporterId: 'sarah',
      priceCents: 2800,
      visitDate: '2026-09-01',
    });
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 28000 }, [theirs])).toMatchObject({
      kind: 'unusual',
    });
    // A retry of a report already on record is not asked about again.
    const mine = report({ id: 'mine', restaurantId: 'harbor-shack', priceCents: 250 });
    expect(plan({ restaurantId: 'harbor-shack', priceCents: 250 }, [mine])).toMatchObject({
      kind: 'repeat',
    });
  });
});

describe('isLiveReport', () => {
  it('leaves out reports that were corrected or withdrawn', () => {
    expect(isLiveReport(report({}))).toBe(true);
    expect(isLiveReport(report({ correctedAt: '2026-10-02T00:00:00.000Z' }))).toBe(false);
    expect(
      isLiveReport(report({ withdrawnAt: '2026-10-02T00:00:00.000Z', withdrawnReason: 'Typo' })),
    ).toBe(false);
  });
});

describe('plausibility', () => {
  const last = (priceCents: number, overrides: Partial<PriceObservation> = {}) =>
    report({ id: `last-${priceCents}`, priceCents, ...overrides });

  it('says nothing about a usual price', () => {
    for (const cents of [800, 2800, 9000])
      expect(plausibility(cents, []), String(cents)).toEqual([]);
    expect(plausibility(2900, [last(2800)])).toEqual([]);
  });

  it('suggests the price a slipped decimal point most likely meant', () => {
    expect(plausibility(250, [])).toEqual([
      {
        code: 'below-usual',
        message: 'You entered $2.50. Did you mean $25.00?',
        suggestedCents: 2500,
      },
    ]);
    expect(plausibility(28000, [])).toEqual([
      {
        code: 'above-usual',
        message: 'You entered $280.00. Did you mean $28.00?',
        suggestedCents: 2800,
      },
    ]);
  });

  it('warns outside $8 to $90 without a guess when ten times off would still be unusual', () => {
    expect(plausibility(50, [])).toEqual([
      {
        code: 'below-usual',
        message: 'You entered $0.50. A lobster roll usually costs $8.00 to $90.00.',
      },
    ]);
    expect(plausibility(100000, [])).toEqual([
      {
        code: 'above-usual',
        message: 'You entered $1000.00. A lobster roll usually costs $8.00 to $90.00.',
      },
    ]);
  });

  it('catches ten times, or a tenth of, the last report in the series, within about 5%', () => {
    expect(plausibility(8500, [last(850)])).toEqual([
      {
        code: 'ten-times-last',
        message: 'You entered $85.00, ten times the last report of $8.50. Did you mean $8.50?',
        suggestedCents: 850,
      },
    ]);
    expect(plausibility(860, [last(8500)])).toEqual([
      {
        code: 'tenth-of-last',
        message: 'You entered $8.60, a tenth of the last report of $85.00. Did you mean $86.00?',
        suggestedCents: 8600,
      },
    ]);
    // About 5% either side counts; further off is a real change in price.
    expect(plausibility(8900, [last(850)])).toHaveLength(1);
    expect(plausibility(9000, [last(850)])).toEqual([]);
  });

  it('measures against the latest live report only', () => {
    const series = [
      last(850, { visitDate: '2026-08-01' }),
      last(8600, { id: 'newer', visitDate: '2026-09-01' }),
      last(9000, {
        id: 'withdrawn',
        visitDate: '2026-09-15',
        withdrawnAt: '2026-09-16T00:00:00.000Z',
        withdrawnReason: 'Typo',
      }),
    ];
    expect(plausibility(8500, series)).toEqual([]);
    expect(plausibility(860, series)).toMatchObject([{ code: 'tenth-of-last' }]);
  });

  it('does not measure against a kept slip: a $25.00 after a kept $2.50 is not a ten times slip', () => {
    expect(plausibility(2500, [last(250, { visitDate: '2026-09-01' })])).toEqual([]);
    // The same for a kept slip that is too high: $28.00 is not "a tenth of" a kept $280.00.
    expect(plausibility(2800, [last(28000, { visitDate: '2026-09-01' })])).toEqual([]);
  });

  it('measures against the latest live report inside the usual band, never a slip kept after it', () => {
    const series = [
      last(2500, { id: 'real', visitDate: '2026-08-01' }),
      last(250, { id: 'kept-slip', visitDate: '2026-09-01' }),
    ];
    // $26.00 is no change from $25.00, whatever the kept $2.50 says.
    expect(plausibility(2600, series)).toEqual([]);
    // The same slip again is asked about, and the suggestion points to the real price.
    expect(plausibility(250, series)).toEqual([
      {
        code: 'tenth-of-last',
        message: 'You entered $2.50, a tenth of the last report of $25.00. Did you mean $25.00?',
        suggestedCents: 2500,
      },
    ]);
    // A slip the other way is caught against the same report.
    expect(plausibility(25000, series)).toMatchObject([
      { code: 'ten-times-last', suggestedCents: 2500 },
    ]);
  });

  it('keeps only the band warning when no live report is inside the band', () => {
    const slips = [last(250, { id: 'low' }), last(28000, { id: 'high', visitDate: '2026-09-01' })];
    expect(plausibility(2500, slips)).toEqual([]);
    expect(plausibility(100, slips)).toMatchObject([{ code: 'below-usual', suggestedCents: 1000 }]);
    expect(plausibility(100000, slips)).toMatchObject([{ code: 'above-usual' }]);
  });

  it('never suggests a price outside the usual band', () => {
    // About ten times $8.00 would suggest $7.68, itself a likely slip, so it is not asked about.
    expect(plausibility(7680, [last(800)])).toEqual([]);
    expect(plausibility(8300, [last(800)])).toMatchObject([
      { code: 'ten-times-last', suggestedCents: 830 },
    ]);
  });

  it('gives one warning for a slip that is also outside the usual range', () => {
    expect(plausibility(280, [last(2800)])).toEqual([
      {
        code: 'tenth-of-last',
        message: 'You entered $2.80, a tenth of the last report of $28.00. Did you mean $28.00?',
        suggestedCents: 2800,
      },
    ]);
  });
});

describe('parsePriceCents', () => {
  it('reads dollars and cents the way people type them', () => {
    expect(parsePriceCents('28')).toBe(2800);
    expect(parsePriceCents('28.00')).toBe(2800);
    expect(parsePriceCents(' $28.5 ')).toBe(2850);
    expect(parsePriceCents('$ 1,000')).toBe(100000);
    expect(parsePriceCents('0.07')).toBe(7);
    expect(parsePriceCents('.99')).toBe(99);
    // A decimal keypad leaves the point when no cents follow.
    expect(parsePriceCents('28.')).toBe(2800);
  });

  it('reads nothing from text that is not a price in cents', () => {
    for (const typed of ['', '.', '$.', 'twenty', '28.005', '2,80', '1,0000', '-5', '1e3'])
      expect(parsePriceCents(typed), typed).toBeUndefined();
  });

  it('names what is wrong with a price', () => {
    expect(priceProblem('28.50')).toBeUndefined();
    expect(priceProblem('0')).toBe('Use a price from $0.01 to $1,000.00.');
    expect(priceProblem('1000.01')).toBe('Use a price from $0.01 to $1,000.00.');
    expect(priceProblem('28.005')).toBe('Use dollars and cents, such as 28.50.');
  });
});

describe('visitPeriod', () => {
  it('spans the days a visit date covers at its precision', () => {
    expect(visitPeriod({ visitDate: '2026-09-11', visitDatePrecision: 'day' })).toEqual({
      start: '2026-09-11',
      end: '2026-09-11',
    });
    expect(visitPeriod({ visitDate: '2026-02', visitDatePrecision: 'month' })).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(visitPeriod({ visitDate: '2024-02', visitDatePrecision: 'month' }).end).toBe(
      '2024-02-29',
    );
    expect(visitPeriod({ visitDate: '2025', visitDatePrecision: 'year' })).toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
    });
  });
});

describe('the change since an earlier visit', () => {
  it('never measures a report against one whose period overlaps it', () => {
    const month = report({
      id: 'm',
      priceCents: 2600,
      visitDate: '2026-09',
      visitDatePrecision: 'month',
    });
    const day = report({ id: 'd', priceCents: 3000, visitDate: '2026-09-20' });
    const year = report({
      id: 'y',
      priceCents: 2400,
      visitDate: '2026',
      visitDatePrecision: 'year',
    });
    // A month report and a day in that month are not two visits a change can be read from.
    expect(previousVisitReport([month, day].sort(compareByVisit))).toBeUndefined();
    expect(previousVisitReport([year, month, day].sort(compareByVisit))).toBeUndefined();
    const august = report({ id: 'a', priceCents: 2500, visitDate: '2026-08-30' });
    expect(previousVisitReport([august, month, day].sort(compareByVisit))).toBe(august);
  });
});

describe('latestObservation', () => {
  it('picks the later report of a same-day tie, whatever order it is given in', () => {
    const morning = report({ id: 'z', priceCents: 2800, reportedAt: '2026-10-01T09:00:00.000Z' });
    const evening = report({ id: 'a', priceCents: 3000, reportedAt: '2026-10-01T20:00:00.000Z' });
    expect(latestObservation([evening, morning])).toBe(evening);
    expect(latestObservation([morning, evening])).toBe(evening);
    expect(latestObservation([])).toBeUndefined();
  });
});

describe('priceSeries', () => {
  const classic = (id: string, visitDate: string, priceCents: number, over = {}) =>
    report({ id, visitDate, priceCents, reportedAt: `${visitDate}T20:00:00.000Z`, ...over });
  const harbor = [
    classic('jun', '2026-06-14', 2500),
    classic('jul', '2026-07-18', 2600, { itemName: 'classic  LOBSTER roll' }),
    classic('sep', '2026-09-11', 2800),
    classic('sep-2', '2026-09-11', 2800, { reportedAt: '2026-09-11T18:00:00.000Z' }),
    classic('ct', '2026-09-30', 4200, { itemName: 'Large Connecticut roll' }),
  ];

  it('keeps one series per item, so a pricier roll never moves the Classic headline', () => {
    const [primary, ...others] = priceSeries(harbor);
    expect(primary.key).toBe('classic lobster roll');
    expect(primary.reports.map((item) => item.id)).toEqual(['jun', 'jul', 'sep-2', 'sep']);
    expect(primary.visits).toBe(3);
    expect(primary.latest.id).toBe('sep');
    expect(primary.label).toBe('Classic lobster roll');
    expect(seriesChange(primary)).toEqual({ cents: 200, previous: harbor[1] });
    expect(others.map((series) => [series.label, series.latest.priceCents])).toEqual([
      ['Large Connecticut roll', 4200],
    ]);
  });

  it('names a series by the spelling most of its reports use, not by the latest reporter’s', () => {
    // One member's "classic  Lobster Roll" is the same item (one series), but it is not what the
    // restaurant's headline and list row should start calling it.
    const [series, ...others] = priceSeries([
      classic('a', '2026-06-14', 2500),
      classic('b', '2026-07-18', 2600),
      classic('c', '2026-09-11', 2800, { itemName: ' classic  Lobster Roll ' }),
    ]);
    expect(others).toEqual([]);
    expect(series.latest.id).toBe('c');
    expect(series.label).toBe('Classic lobster roll');
  });

  it('settles a tie between spellings on the one reported first', () => {
    const [series] = priceSeries([
      classic('z', '2026-09-11', 2800, { itemName: 'classic LOBSTER roll' }),
      classic('a', '2026-06-14', 2500, { itemName: 'Classic Lobster Roll' }),
    ]);
    expect(series.label).toBe('Classic Lobster Roll');
  });

  it('leads with the item reported on the most visits, then a Classic, then the most recent', () => {
    const lobster = (id: string, visitDate: string, itemName: string) =>
      classic(id, visitDate, 3000, { itemName });
    expect(
      priceSeries([
        lobster('a', '2026-06-01', 'Warm roll'),
        lobster('b', '2026-07-01', 'Classic roll'),
      ])[0].label,
    ).toBe('Classic roll');
    expect(
      priceSeries([
        lobster('a', '2026-06-01', 'Warm roll'),
        lobster('b', '2026-07-01', 'Cold roll'),
      ])[0].label,
    ).toBe('Cold roll');
    expect(
      priceSeries([
        lobster('a', '2026-06-01', 'Warm roll'),
        lobster('b', '2026-07-01', 'Warm roll'),
        lobster('c', '2026-08-01', 'Classic roll'),
      ])[0].label,
    ).toBe('Warm roll');
  });

  it('draws no change from fewer than two visits, and says when the price held', () => {
    const [single] = priceSeries([harbor[2], harbor[3]]);
    expect(single.visits).toBe(1);
    expect(seriesChange(single)).toBeUndefined();
    const [flat] = priceSeries([
      classic('a', '2026-05-01', 2900),
      classic('b', '2026-07-01', 2900),
    ]);
    expect(seriesChange(flat)?.cents).toBe(0);
  });

  it('takes a month report and a day inside it as one visit, the day, so they draw no trend', () => {
    const month = classic('m', '2026-07', 3000, {
      visitDatePrecision: 'month',
      reportedAt: '2026-08-02T12:00:00.000Z',
    });
    const day = classic('d', '2026-07-20', 3400);
    const [series] = priceSeries([day, month]);
    expect(series.visitReports.map((item) => item.id)).toEqual(['d']);
    expect(series.visits).toBe(1);
    expect(seriesChange(series)).toBeUndefined();
    // Two days in that month are two visits, and the month report adds nothing either lacks.
    const [two] = priceSeries([month, classic('d1', '2026-07-16', 3200), day]);
    expect(two.visitReports.map((item) => item.id)).toEqual(['d1', 'd']);
    expect(two.visits).toBe(2);
    expect(seriesChange(two)?.cents).toBe(200);
    expect(seriesChange(two)?.previous.id).toBe('d1');
    // A year with a month in it is that month; another year stays a visit of its own.
    const year = (id: string, visitDate: string) =>
      classic(id, visitDate, 2800, { visitDatePrecision: 'year' });
    const [nested] = priceSeries([year('y25', '2025'), year('y26', '2026'), month]);
    expect(nested.visitReports.map((item) => item.id)).toEqual(['y25', 'm']);
  });

  it('keeps the later report of the same visit as that visit', () => {
    const [primary] = priceSeries(harbor);
    expect(primary.visitReports.map((item) => item.id)).toEqual(['jun', 'jul', 'sep']);
  });

  it('builds series from live reports only, so a withdrawn or replaced report leads, counts and moves nothing', () => {
    const gone = { withdrawnAt: '2026-10-02T00:00:00.000Z', withdrawnReason: 'Wrong restaurant' };
    const replaced = { correctedAt: '2026-10-02T00:00:00.000Z' };
    const classics = harbor.slice(0, 4);
    // Four Connecticut visits off the record would outnumber the Classic's three live ones.
    const offRecord = ['2026-05-01', '2026-06-01', '2026-08-01', '2026-10-01'].map(
      (visitDate, index) =>
        classic(`ct-${index}`, visitDate, 4200, {
          itemName: 'Large Connecticut roll',
          ...(index % 2 ? gone : replaced),
        }),
    );
    const series = priceSeries([...classics, ...offRecord]);
    expect(series.map((item) => item.label)).toEqual(['Classic lobster roll']);
    expect(series[0].visits).toBe(3);
    // A withdrawn report after the latest live one is neither the headline nor the change's base.
    const [primary] = priceSeries([
      ...classics,
      classic('oct', '2026-10-01', 9900, gone),
      classic('aug', '2026-08-15', 2000, replaced),
    ]);
    expect(primary.latest.id).toBe('sep');
    expect(primary.reports.map((item) => item.id)).toEqual(['jun', 'jul', 'sep-2', 'sep']);
    expect(seriesChange(primary)).toEqual({ cents: 200, previous: harbor[1] });
    // A withdrawn day inside a live month report does not take that month's place as the visit.
    const month = classic('aug-month', '2026-08', 3100, {
      visitDatePrecision: 'month',
      reportedAt: '2026-09-01T12:00:00.000Z',
    });
    const [north] = priceSeries([
      month,
      classic('aug-15', '2026-08-15', 2700, gone),
      classic('sep-20', '2026-09-20', 3300),
    ]);
    expect(north.visitReports.map((item) => item.id)).toEqual(['aug-month', 'sep-20']);
    expect(seriesChange(north)).toEqual({ cents: 200, previous: month });
    expect(priceSeries([classic('only', '2026-09-01', 2800, gone)])).toEqual([]);
  });
});

describe('isOldReport', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  it('calls a report old once the visit it covers ended more than twelve months ago', () => {
    expect(isOldReport(report({ visitDate: '2025-10-19' }), now)).toBe(false);
    expect(isOldReport(report({ visitDate: '2025-10-17' }), now)).toBe(true);
    // A month or a year counts from its last day.
    expect(isOldReport(report({ visitDate: '2025-10', visitDatePrecision: 'month' }), now)).toBe(
      false,
    );
    expect(isOldReport(report({ visitDate: '2024', visitDatePrecision: 'year' }), now)).toBe(true);
    expect(isOldReport(report({ visitDate: '2025', visitDatePrecision: 'year' }), now)).toBe(false);
  });
});
