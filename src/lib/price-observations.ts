import type {
  PriceDatePrecision,
  PriceObservation,
  PriceReportInput,
  PriceReportResult,
  PriceWarning,
  Restaurant,
  RestaurantMatch,
} from './types';
import { latestCalendarDay } from './bet-workflow';

/**
 * A report that counts in the price history: not replaced by a correction and not withdrawn.
 * Every figure (the latest price, the change, the chart, the counts) uses only these.
 */
export const isLiveReport = (observation: PriceObservation) =>
  !observation.correctedAt && !observation.withdrawnAt;

/**
 * Oldest first by visit date; same-day reports fall back to when they were reported, then id,
 * so every view agrees on which report is the latest.
 */
export function compareByVisit(a: PriceObservation, b: PriceObservation): number {
  return (
    a.visitDate.localeCompare(b.visitDate) ||
    a.reportedAt.localeCompare(b.reportedAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The days a visit date covers, as YYYY-MM-DD: the day itself, the whole month or the whole year.
 * A coarse date is a span, not its first day.
 */
export function visitPeriod({
  visitDate,
  visitDatePrecision,
}: Pick<PriceObservation, 'visitDate' | 'visitDatePrecision'>): { start: string; end: string } {
  if (visitDatePrecision === 'year')
    return { start: `${visitDate}-01-01`, end: `${visitDate}-12-31` };
  if (visitDatePrecision === 'month') {
    const [year, month] = visitDate.split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${visitDate}-01`, end: `${visitDate}-${String(last).padStart(2, '0')}` };
  }
  return { start: visitDate, end: visitDate };
}

const overlaps = (a: PriceObservation, b: PriceObservation) => {
  const [first, second] = [visitPeriod(a), visitPeriod(b)];
  return first.start <= second.end && second.start <= first.end;
};

/**
 * The report a price change is measured against: the latest one from a visit that cannot be the
 * newest report's own. Two reports of the same day, or a day and the month or year around it, are
 * one price point as far as anyone can tell, not a change.
 */
export function previousVisitReport(ordered: PriceObservation[]): PriceObservation | undefined {
  const newest = ordered.at(-1);
  if (!newest) return undefined;
  for (let index = ordered.length - 2; index >= 0; index -= 1)
    if (!overlaps(ordered[index], newest)) return ordered[index];
  return undefined;
}

/** The latest report by visit, then by when it was reported: the one price every view shows. */
export const latestObservation = (observations: readonly PriceObservation[]) =>
  [...observations].sort(compareByVisit).at(-1);

/**
 * One report per visit, oldest first. Reports whose periods overlap are one visit as far as anyone
 * can tell: the same day reported twice is its later report, and a month or year report gives way
 * to any finer report inside it, so "2026-07" and "2026-07-20" are the 20th, not a price change.
 * Days, months and years never partly overlap, so the visits left never overlap at all.
 */
function reportsPerVisit(ordered: readonly PriceObservation[]): PriceObservation[] {
  const periods = ordered.map(visitPeriod);
  return ordered.filter((_, index) => {
    const own = periods[index];
    return !periods.some(
      (other, at) =>
        at !== index &&
        own.start <= other.start &&
        other.end <= own.end &&
        // Strictly inside this one, or the same period reported later.
        (other.start !== own.start || other.end !== own.end || at > index),
    );
  });
}

/** One item's reports at one restaurant: the only prices that can be compared with each other. */
export interface PriceSeries {
  /** `itemKey` of the item. */
  key: string;
  /** The item as most of its reports spell it (the earliest spelling wins a tie). */
  label: string;
  /** Oldest first. */
  reports: PriceObservation[];
  /** One report per visit, oldest first (see `reportsPerVisit`): the points of the chart. */
  visitReports: PriceObservation[];
  /** How many visits there are. A trend needs two. */
  visits: number;
  latest: PriceObservation;
}

/**
 * How a series is named: the spelling most of its reports use, so one member's "classic  Lobster
 * Roll" never renames an item everyone else spells "Classic lobster roll". `reports` run oldest
 * first and a tie keeps the spelling reported first.
 */
function commonSpelling(reports: readonly PriceObservation[]): string {
  const counts = new Map<string, number>();
  for (const { itemName } of reports) {
    const spelling = itemName.trim();
    counts.set(spelling, (counts.get(spelling) ?? 0) + 1);
  }
  let common = reports[0].itemName.trim();
  for (const [spelling, count] of counts) if (count > counts.get(common)!) common = spelling;
  return common;
}

/**
 * A restaurant's live reports, one series per item, the primary series first: the item reported
 * on the most visits, then a Classic, then the one reported most recently. The headline, the
 * change, the list row and the chart all come from the primary series, so a pricier roll reported
 * once never reads as a price rise.
 */
export function priceSeries(observations: readonly PriceObservation[]): PriceSeries[] {
  const groups = new Map<string, PriceObservation[]>();
  for (const observation of observations) {
    // A corrected or withdrawn report stays on record but in no figure, so it never forms a series.
    if (!isLiveReport(observation)) continue;
    const key = itemKey(observation.itemName);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const series = [...groups].map(([key, reports]): PriceSeries => {
    const ordered = reports.sort(compareByVisit);
    const latest = ordered.at(-1)!;
    const visitReports = reportsPerVisit(ordered);
    return {
      key,
      label: commonSpelling(ordered),
      reports: ordered,
      visitReports,
      visits: visitReports.length,
      latest,
    };
  });
  const classic = (item: PriceSeries) => (item.key.includes('classic') ? 1 : 0);
  return series.sort(
    (a, b) =>
      b.visits - a.visits ||
      classic(b) - classic(a) ||
      compareByVisit(b.latest, a.latest) ||
      a.label.localeCompare(b.label),
  );
}

/** How the latest price compares with an earlier visit, or nothing when there is no earlier one. */
export function seriesChange(
  series: Pick<PriceSeries, 'reports' | 'visits' | 'latest'>,
): { cents: number; previous: PriceObservation } | undefined {
  if (series.visits < 2) return undefined;
  const previous = previousVisitReport(series.reports);
  return previous && { cents: series.latest.priceCents - previous.priceCents, previous };
}

/** A report whose visit ended more than twelve months ago: worth a look before relying on it. */
export function isOldReport(
  observation: Pick<PriceObservation, 'visitDate' | 'visitDatePrecision'>,
  now: number = Date.now(),
): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return visitPeriod(observation).end < cutoff.toISOString().slice(0, 10);
}

/** Member-entered text compared the way people read it: Unicode-folded, any case, any spacing. */
const textKey = (value: string) =>
  value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Which roll a report is for. "Classic lobster roll" and "classic  Lobster Roll" are one item; no
 * synonyms, because folding "roll" into "classic" would merge prices that are not comparable.
 */
export const itemKey = (name: string) => textKey(name);

/** A restaurant's identity: its name and address, ignoring case and spacing. */
export const restaurantKey = ({ name, address }: { name: string; address?: string }) =>
  JSON.stringify([textKey(name), textKey(address ?? '')]);

/** The restaurant on the record with this name and address, ignoring case and spacing. */
export function findRestaurant<T extends Pick<Restaurant, 'name' | 'address'>>(
  restaurants: readonly T[],
  input: { name: string; address?: string },
): T | undefined {
  const key = restaurantKey(input);
  return restaurants.find((restaurant) => restaurantKey(restaurant) === key);
}

/** Every restaurant with this name, whatever its address, so a new one can be checked first. */
export function restaurantsNamed<T extends Pick<Restaurant, 'name'>>(
  restaurants: readonly T[],
  name: string,
): T[] {
  const key = textKey(name);
  return key ? restaurants.filter((restaurant) => textKey(restaurant.name) === key) : [];
}

export interface PriceVisit {
  reporterId: string;
  restaurantId: string;
  itemName: string;
  visitDate: string;
  visitDatePrecision: PriceDatePrecision;
}

/**
 * The reports this member already made of the same visit, oldest first: same restaurant, item,
 * date and precision, and not since corrected or withdrawn. More than one means separate purchases
 * confirmed.
 */
export function findVisitReports(
  observations: readonly PriceObservation[],
  visit: PriceVisit,
): PriceObservation[] {
  const item = itemKey(visit.itemName);
  return observations
    .filter(
      (observation) =>
        isLiveReport(observation) &&
        observation.reporterId === visit.reporterId &&
        observation.restaurantId === visit.restaurantId &&
        observation.visitDate === visit.visitDate &&
        observation.visitDatePrecision === visit.visitDatePrecision &&
        itemKey(observation.itemName) === item,
    )
    .sort(compareByVisit);
}

/** The latest report of the same visit: a second one would count the same purchase twice. */
export const findDuplicateReport = (observations: readonly PriceObservation[], visit: PriceVisit) =>
  findVisitReports(observations, visit).at(-1);

/**
 * The duplicate rule, applied to the visit a correction lands on, decided the same way by the
 * ledger and by the demo. The member's other live report of that visit at the same price makes the
 * correction a copy of it (`copy`), which is refused. One at another price is a `conflict` when the
 * correction moves the report onto that visit, unless `confirmSeparateReport` says it was a
 * separate purchase; a report already on that visit was confirmed as one when it was made.
 */
export function correctionDuplicate(
  observations: readonly PriceObservation[],
  original: PriceObservation,
  input: Omit<PriceVisit, 'reporterId'> & { priceCents: number; confirmSeparateReport?: boolean },
): { kind: 'copy' | 'conflict'; existing: PriceObservation } | undefined {
  const reported = findVisitReports(
    observations.filter((item) => item.id !== original.id),
    { ...input, reporterId: original.reporterId },
  );
  const copy = reported.filter((item) => item.priceCents === input.priceCents).at(-1);
  if (copy) return { kind: 'copy', existing: copy };
  const moved =
    original.restaurantId !== input.restaurantId ||
    itemKey(original.itemName) !== itemKey(input.itemName) ||
    original.visitDate !== input.visitDate ||
    original.visitDatePrecision !== input.visitDatePrecision;
  const latest = reported.at(-1);
  if (latest && moved && !input.confirmSeparateReport)
    return { kind: 'conflict', existing: latest };
  return undefined;
}

export type PriceReportPlan =
  | { kind: 'unknown-restaurant' }
  /** The same visit at the same price is already on record: a retry, so nothing is written. */
  | { kind: 'repeat'; result: PriceReportResult }
  /** The same visit is on record at another price; a second report needs the member's word. */
  | { kind: 'conflict'; existing: PriceObservation }
  /** A price unusual enough to ask about first; `confirmUnusualPrice` keeps it. */
  | { kind: 'unusual'; warnings: PriceWarning[] }
  | { kind: 'record'; result: PriceReportResult; newRestaurant: boolean };

/**
 * What one price report does, decided the same way by the ledger and by the demo. `restaurants`
 * holds every restaurant a named one could match (or the chosen one), and `observations` at least
 * the reporter's live reports of this visit date and the live reports at the restaurant, which an
 * unusual price is measured against.
 */
export function planPriceReport({
  input,
  reporterId,
  restaurants,
  observations,
  newId,
  now,
}: {
  input: PriceReportInput;
  reporterId: string;
  restaurants: readonly Restaurant[];
  observations: readonly PriceObservation[];
  newId: () => string;
  now: string;
}): PriceReportPlan {
  const {
    restaurant: named,
    restaurantId,
    confirmSeparateReport,
    confirmUnusualPrice,
    ...fields
  } = input;
  let restaurant: Restaurant | undefined;
  let matched: RestaurantMatch | undefined;
  if (named) {
    restaurant = findRestaurant(restaurants, named);
    matched = !restaurant
      ? 'created'
      : restaurant.name === named.name && restaurant.address === named.address
        ? 'exact'
        : 'normalised';
    restaurant ??= { id: newId(), ...named };
  } else {
    restaurant = restaurants.find((item) => item.id === restaurantId);
    if (!restaurant) return { kind: 'unknown-restaurant' };
  }
  if (matched !== 'created') {
    const reported = findVisitReports(observations, {
      ...fields,
      reporterId,
      restaurantId: restaurant.id,
    });
    // Any report of the visit at this price makes this a resend, even after a separate purchase
    // was confirmed; a new price is asked about against the latest report.
    const same = reported.filter((item) => item.priceCents === fields.priceCents).at(-1);
    if (same)
      return {
        kind: 'repeat',
        result: { observation: same, restaurant, matched, duplicateOf: same.id },
      };
    const latest = reported.at(-1);
    if (latest && !confirmSeparateReport) return { kind: 'conflict', existing: latest };
  }
  if (!confirmUnusualPrice) {
    const warnings = plausibility(
      fields.priceCents,
      sameSeries(observations, restaurant.id, fields.itemName),
    );
    if (warnings.length) return { kind: 'unusual', warnings };
  }
  const observation: PriceObservation = {
    id: newId(),
    restaurantId: restaurant.id,
    ...fields,
    currency: 'USD',
    reporterId,
    reportedAt: now,
  };
  return {
    kind: 'record',
    newRestaurant: matched === 'created',
    result: { observation, restaurant, ...(matched && { matched }) },
  };
}

/** The live reports of one roll at one restaurant: the series a new price is compared with. */
export const sameSeries = (
  observations: readonly PriceObservation[],
  restaurantId: string,
  itemName: string,
) =>
  observations.filter(
    (observation) =>
      isLiveReport(observation) &&
      observation.restaurantId === restaurantId &&
      itemKey(observation.itemName) === itemKey(itemName),
  );

/** The menu prices a lobster roll usually costs, in cents; outside them a price is asked about. */
export const USUAL_PRICE_CENTS = { min: 800, max: 9000 } as const;
const usual = (cents: number) => cents >= USUAL_PRICE_CENTS.min && cents <= USUAL_PRICE_CENTS.max;
/** Within about 5% of `target`. */
const near = (value: number, target: number) => Math.abs(value / target - 1) <= 0.05;

/**
 * What looks wrong with a price that is still possible: outside the $8 to $90 a roll usually
 * costs, or about ten times, or a tenth of, the latest live report in `priorSameSeries` (the same
 * roll at the same restaurant) that is itself inside that range: a kept $2.50 is a slip, not a
 * yardstick, and would send a right $25.00 back toward it. With no such report only the range is
 * checked. A likely slipped decimal point comes with the price it probably meant, which is never
 * outside the range. Nothing here refuses a price; the member decides.
 */
export function plausibility(
  priceCents: number,
  priorSameSeries: readonly PriceObservation[],
): PriceWarning[] {
  const entered = `You entered ${priceLabel(priceCents)}`;
  const last = priorSameSeries
    .filter((observation) => isLiveReport(observation) && usual(observation.priceCents))
    .sort(compareByVisit)
    .at(-1);
  if (last) {
    const ratio = priceCents / last.priceCents;
    const previous = priceLabel(last.priceCents);
    const tenTimes = near(ratio, 10);
    if (tenTimes || near(ratio, 0.1)) {
      const suggestedCents = tenTimes ? Math.round(priceCents / 10) : priceCents * 10;
      if (usual(suggestedCents))
        return [
          {
            code: tenTimes ? 'ten-times-last' : 'tenth-of-last',
            message: `${entered}, ${tenTimes ? 'ten times' : 'a tenth of'} the last report of ${previous}. Did you mean ${priceLabel(suggestedCents)}?`,
            suggestedCents,
          },
        ];
    }
  }
  if (usual(priceCents)) return [];
  const code = priceCents < USUAL_PRICE_CENTS.min ? 'below-usual' : 'above-usual';
  const suggestedCents = code === 'below-usual' ? priceCents * 10 : Math.round(priceCents / 10);
  if (usual(suggestedCents))
    return [
      { code, message: `${entered}. Did you mean ${priceLabel(suggestedCents)}?`, suggestedCents },
    ];
  return [
    {
      code,
      message: `${entered}. A lobster roll usually costs ${priceLabel(USUAL_PRICE_CENTS.min)} to ${priceLabel(USUAL_PRICE_CENTS.max)}.`,
    },
  ];
}

/** A price the ledger asks about before saving; send it again with `confirmUnusualPrice` to keep it. */
export class UnusualPriceError extends Error {
  readonly warnings: PriceWarning[];
  constructor(warnings: PriceWarning[]) {
    super(warnings.map((warning) => warning.message).join(' '));
    this.name = 'UnusualPriceError';
    this.warnings = warnings;
  }
}

/** A correction that would supersede a report with the same report: nothing to correct. */
export const correctionChangesNothing = (
  original: PriceObservation,
  input: Pick<
    PriceObservation,
    'restaurantId' | 'itemName' | 'priceCents' | 'visitDate' | 'visitDatePrecision' | 'note'
  >,
) =>
  original.restaurantId === input.restaurantId &&
  original.itemName.trim() === input.itemName.trim() &&
  original.priceCents === input.priceCents &&
  original.visitDate === input.visitDate &&
  original.visitDatePrecision === input.visitDatePrecision &&
  (original.note ?? '').trim() === (input.note ?? '').trim();

/** A report of a visit the member already reported at another price. */
export class DuplicatePriceError extends Error {
  readonly existing: PriceObservation;
  constructor(existing: PriceObservation) {
    super(`You already reported ${priceLabel(existing.priceCents)} for this visit.`);
    this.name = 'DuplicatePriceError';
    this.existing = existing;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 11, 2026", "Aug 2026" or "2024": a visit as precisely as it was reported. */
export function priceDateLabel({
  visitDate,
  visitDatePrecision,
}: Pick<PriceObservation, 'visitDate' | 'visitDatePrecision'>): string {
  const [year, month, day] = visitDate.split('-');
  const monthName = MONTHS[Number(month) - 1];
  if (visitDatePrecision === 'year' || !monthName) return year;
  if (visitDatePrecision === 'month' || !day) return `${monthName} ${year}`;
  return `${monthName} ${Number(day)}, ${year}`;
}

/** A YYYY-MM-DD that names a real day: no Feb 31. */
export function isCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const visitDateShape = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-(?:0[1-9]|1[0-2])$/,
  year: /^\d{4}$/,
} as const;

/**
 * What is wrong with a visit date, or nothing. The date says exactly as much as its precision (a
 * day is a real calendar day), it is not before 1900, and it has already started somewhere on
 * Earth: the ceiling is the latest calendar day in UTC+14, so no member's local today is refused.
 * The ledger's schemas, the demo and the price dialog all use this one rule.
 */
export function visitDateProblem(
  { visitDate, visitDatePrecision }: Pick<PriceObservation, 'visitDate' | 'visitDatePrecision'>,
  now: number = Date.now(),
): string | undefined {
  if (!visitDateShape[visitDatePrecision]?.test(visitDate))
    return 'Date does not match its precision.';
  if (visitDatePrecision === 'day' && !isCalendarDay(visitDate))
    return 'Choose a valid calendar date.';
  if (visitDate.slice(0, 4) < '1900') return 'Use a visit date from 1900 or later.';
  if (visitDate > latestCalendarDay(now).slice(0, visitDate.length))
    return 'Use a visit date that has already happened.';
  return undefined;
}

/** Today's date on the member's own clock, as YYYY-MM-DD. A US evening is still today here. */
export function localDay(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "$28.00" */
export const priceLabel = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The lowest and highest menu price for one roll the ledger takes, in cents. */
export const PRICE_CENTS = { min: 1, max: 100_000 } as const;

/**
 * A typed price in whole cents: "28", "28.", "28.5", "$28.50" or "1,000". Nothing for anything
 * else, including a third decimal or a lone point. Read as text, so it never goes through a float.
 */
export function parsePriceCents(typed: string): number | undefined {
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{0,2}))?$/.exec(typed.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const dollars = Number(match[1].replaceAll(',', '') || '0');
  return dollars * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** What is wrong with a typed price, or nothing. */
export function priceProblem(typed: string): string | undefined {
  const cents = parsePriceCents(typed);
  if (cents === undefined) return 'Use dollars and cents, such as 28.50.';
  if (cents < PRICE_CENTS.min || cents > PRICE_CENTS.max)
    return 'Use a price from $0.01 to $1,000.00.';
  return undefined;
}
