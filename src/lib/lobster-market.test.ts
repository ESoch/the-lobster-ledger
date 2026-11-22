import { describe, expect, it } from 'vitest';
import {
  lobsterMarketHistory,
  marketCsv,
  marketDataStatus,
  marketHistory,
  type LobsterMarketHistory,
} from './lobster-market';

describe('official lobster market history', () => {
  it('preserves annual dates, nominal per-pound units, and the published preliminary flag', () => {
    const data = lobsterMarketHistory;
    expect(data.observations[0].year).toBe(1950);
    expect(data.frequency).toBe('annual');
    expect(data.priceBasis).toBe('ex_vessel');
    expect(data.unit).toBe('lb');
    expect(data.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    const latest = data.observations.at(-1)!;
    expect(data.observations.map((row) => row.year)).toEqual(
      Array.from({ length: latest.year - 1949 }, (_, index) => 1950 + index),
    );
    for (const row of data.observations) {
      expect(
        Math.abs(row.landedValueUsd / row.pounds - row.priceCentsPerLb / 100),
      ).toBeLessThanOrEqual(0.0051);
      expect(typeof row.preliminary).toBe('boolean');
    }
  });

  it('filters years without fabricating or filling future observations', () => {
    expect(marketHistory(2020, 2023).observations.map((row) => row.year)).toEqual([
      2020, 2021, 2022, 2023,
    ]);
    expect(marketHistory(2098, 2099).observations).toEqual([]);
    expect(marketHistory(2020, 2023).sourceUpdatedOn).toBe(lobsterMarketHistory.sourceUpdatedOn);
  });

  it('exports values with units, preliminary status, and provenance', () => {
    const row = lobsterMarketHistory.observations.at(-1)!;
    const csv = marketCsv([row]);
    expect(csv).toContain('"USD per lb"');
    expect(csv).toContain(`"${(row.priceCentsPerLb / 100).toFixed(2)}"`);
    expect(csv).toContain(lobsterMarketHistory.sourceUrl);
    expect(csv).toContain('Annual ex-vessel average; nominal USD');
    expect(csv.split('\r\n')).toHaveLength(2);
  });
});

describe('marketDataStatus', () => {
  const at = (iso: string) => Date.parse(iso);
  const series = (changes: Partial<LobsterMarketHistory> = {}): LobsterMarketHistory => ({
    ...lobsterMarketHistory,
    sourceUpdatedOn: '2026-02-06',
    observations: [
      { year: 2024, priceCentsPerLb: 540, pounds: 100, landedValueUsd: 540, preliminary: false },
      { year: 2025, priceCentsPerLb: 585, pounds: 100, landedValueUsd: 585, preliminary: true },
    ],
    ...changes,
  });

  it('stays current from one annual release until the next one is expected', () => {
    expect(marketDataStatus(series(), at('2026-10-24T12:00:00Z'))).toEqual({
      state: 'current',
      latestYear: 2025,
      preliminary: true,
      releasedOn: '2026-02-06',
      label: 'Data through 2025 (preliminary) · DMR release Feb 6, 2026',
    });
    expect(marketDataStatus(series(), at('2027-01-31T23:59:59Z')).state).toBe('current');
  });

  it('judges the data age rather than the time of the last source check', () => {
    const neverChecked = series({ checkedAt: 'not a date' });
    const checkedLongAgo = series({ checkedAt: '2000-01-01T00:00:00Z' });
    expect(marketDataStatus(neverChecked, at('2026-10-24T12:00:00Z')).state).toBe('current');
    expect(marketDataStatus(checkedLongAgo, at('2026-10-24T12:00:00Z')).state).toBe('current');
    expect(marketDataStatus(lobsterMarketHistory, at('2026-10-24T12:00:00Z')).state).toBe(
      'current',
    );
  });

  it('awaits the annual update from the release month a year later, through a 90-day grace', () => {
    expect(marketDataStatus(series(), at('2027-02-01T00:00:00Z')).state).toBe(
      'awaiting-annual-update',
    );
    expect(marketDataStatus(series(), at('2027-02-15T12:00:00Z')).state).toBe(
      'awaiting-annual-update',
    );
    expect(marketDataStatus(series(), at('2027-05-01T23:59:59Z')).state).toBe(
      'awaiting-annual-update',
    );
  });

  it('is late once the grace period has passed', () => {
    expect(marketDataStatus(series(), at('2027-05-02T00:00:00Z')).state).toBe('late');
    expect(marketDataStatus(series(), at('2027-09-01T12:00:00Z')).state).toBe('late');
  });

  it('is not postponed by a mid-year revision of the same data year', () => {
    const revised = series({ sourceUpdatedOn: '2026-09-15' });
    expect(marketDataStatus(revised, at('2027-01-31T23:59:59Z')).state).toBe('current');
    expect(marketDataStatus(revised, at('2027-03-01T12:00:00Z')).state).toBe(
      'awaiting-annual-update',
    );
    expect(marketDataStatus(revised, at('2027-08-15T12:00:00Z')).state).toBe('late');
  });

  it('is not reset by a republish that adds no new year', () => {
    const republished = series({ sourceUpdatedOn: '2027-06-10' });
    expect(marketDataStatus(republished, at('2027-03-01T12:00:00Z')).state).toBe(
      'awaiting-annual-update',
    );
    expect(marketDataStatus(republished, at('2028-03-01T12:00:00Z')).state).toBe('late');
  });

  it('expects the next release in the release month when that is before February of the year after next', () => {
    const early = series({ sourceUpdatedOn: '2026-01-20' });
    expect(marketDataStatus(early, at('2026-12-31T23:59:59Z')).state).toBe('current');
    expect(marketDataStatus(early, at('2027-01-01T00:00:00Z')).state).toBe(
      'awaiting-annual-update',
    );
    expect(marketDataStatus(early, at('2027-04-01T00:00:00Z')).state).toBe('late');
  });

  it('takes the preliminary flag from the latest year only', () => {
    const finalLatest = series({
      observations: [
        { year: 2024, priceCentsPerLb: 540, pounds: 100, landedValueUsd: 540, preliminary: true },
        { year: 2025, priceCentsPerLb: 585, pounds: 100, landedValueUsd: 585, preliminary: false },
      ],
    });
    expect(marketDataStatus(finalLatest, at('2026-10-24T12:00:00Z'))).toMatchObject({
      latestYear: 2025,
      preliminary: false,
      label: 'Data through 2025 · DMR release Feb 6, 2026',
    });
  });

  it.each(['invalid', '', '2026-02-30', '2026-2-6', '2026-02-06T00:00:00Z'])(
    'falls back to the data year when the release date %j is malformed',
    (sourceUpdatedOn) => {
      const malformed = series({ sourceUpdatedOn });
      expect(marketDataStatus(malformed, at('2026-10-24T12:00:00Z'))).toEqual({
        state: 'current',
        latestYear: 2025,
        preliminary: true,
        releasedOn: null,
        label: 'Data through 2025 (preliminary) · DMR release date unavailable',
      });
      expect(marketDataStatus(malformed, at('2027-03-01T12:00:00Z')).state).toBe(
        'awaiting-annual-update',
      );
      expect(marketDataStatus(malformed, at('2027-05-02T00:00:00Z')).state).toBe('late');
    },
  );

  it('cannot vouch for a series with neither a release date nor a data year', () => {
    expect(
      marketDataStatus(series({ sourceUpdatedOn: 'invalid', observations: [] }), at('2026-10-24')),
    ).toMatchObject({ state: 'late', latestYear: null, releasedOn: null });
  });

  it('does not invent a year for an empty series', () => {
    expect(
      marketDataStatus(series({ observations: [] }), at('2026-10-24T12:00:00Z')),
    ).toMatchObject({
      latestYear: null,
      preliminary: false,
      label: 'Data year unavailable · DMR release Feb 6, 2026',
    });
  });
});
