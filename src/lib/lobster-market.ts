import snapshot from '../data/lobster-market.json';
import { csvCell } from './export';

export interface LobsterMarketObservation {
  year: number;
  priceCentsPerLb: number;
  pounds: number;
  landedValueUsd: number;
  preliminary: boolean;
}
export interface LobsterMarketHistory {
  schemaVersion: number;
  seriesId: string;
  sourceName: string;
  sourceUrl: string;
  sourcePageUrl: string;
  sourceUpdatedOn: string;
  sourceSha256: string;
  checkedAt: string;
  /** Absent when the importer downloaded sourceUrl itself; 'manual-file' when it validated a copy downloaded by hand. */
  checkMethod?: 'manual-file';
  species: string;
  region: string;
  currency: 'USD';
  unit: 'lb';
  priceBasis: 'ex_vessel';
  frequency: 'annual';
  refreshCadence: 'weekly';
  notes: string[];
  observations: LobsterMarketObservation[];
}

export const lobsterMarketHistory = snapshot as LobsterMarketHistory;
export const marketPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const marketDate = (value: string) =>
  new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function marketHistory(fromYear = 1950, toYear = 2100): LobsterMarketHistory {
  return {
    ...lobsterMarketHistory,
    observations: lobsterMarketHistory.observations.filter(
      (row) => row.year >= fromYear && row.year <= toYear,
    ),
  };
}

export function marketCsv(
  rows: LobsterMarketObservation[],
  history = lobsterMarketHistory,
): string {
  const values = [
    [
      'Year',
      'USD per lb',
      'Preliminary',
      'Live-weight pounds',
      'Landed value USD',
      'Species',
      'Region',
      'Price basis',
      'Source',
      'Source updated on',
      'Last checked at',
    ],
    ...rows.map((row) => [
      row.year,
      (row.priceCentsPerLb / 100).toFixed(2),
      row.preliminary ? 'Yes' : 'No',
      row.pounds,
      row.landedValueUsd,
      history.species,
      history.region,
      'Annual ex-vessel average; nominal USD',
      history.sourceUrl,
      history.sourceUpdatedOn,
      history.checkedAt,
    ]),
  ];
  return '\uFEFF' + values.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export type MarketDataState = 'current' | 'awaiting-annual-update' | 'late';
export interface MarketDataStatus {
  state: MarketDataState;
  latestYear: number | null;
  preliminary: boolean;
  releasedOn: string | null;
  label: string;
}

/** Days after the expected release month begins before the data is called late. */
export const MARKET_RELEASE_GRACE_DAYS = 90;

/**
 * Judges the series by the age of its data, not by when the importer last ran. DMR
 * publishes year Y in early year Y+1, so the next annual release is expected by February
 * of the latest data year + 2, or in the release month a year after the source date if that
 * is earlier. Capping by the data year keeps a mid-year revision, or a republish that adds
 * no new year, from postponing the expected release. The data is current until then,
 * awaiting the update for the grace period, and late after that. A malformed release date
 * falls back to the data-year anchor; with neither it cannot be vouched for and is late.
 */
export function marketDataStatus(
  series: Pick<LobsterMarketHistory, 'sourceUpdatedOn' | 'observations'>,
  now = Date.now(),
): MarketDataStatus {
  const latest = series.observations.at(-1);
  const released = parseReleaseDate(series.sourceUpdatedOn);
  const anchors = [
    released && Date.UTC(released.getUTCFullYear() + 1, released.getUTCMonth()),
    latest && Date.UTC(latest.year + 2, 1),
  ].filter((anchor): anchor is number => typeof anchor === 'number');
  const expectedFrom = anchors.length ? Math.min(...anchors) : null;
  const state: MarketDataState =
    expectedFrom === null
      ? 'late'
      : now < expectedFrom
        ? 'current'
        : now < expectedFrom + MARKET_RELEASE_GRACE_DAYS * 86_400_000
          ? 'awaiting-annual-update'
          : 'late';
  const through = latest
    ? `Data through ${latest.year}${latest.preliminary ? ' (preliminary)' : ''}`
    : 'Data year unavailable';
  return {
    state,
    latestYear: latest?.year ?? null,
    preliminary: latest?.preliminary ?? false,
    releasedOn: released ? series.sourceUpdatedOn : null,
    label: `${through} · DMR release ${released ? marketDate(series.sourceUpdatedOn) : 'date unavailable'}`,
  };
}

function parseReleaseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
