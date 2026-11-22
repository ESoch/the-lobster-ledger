import {
  compareByVisit,
  isLiveReport,
  itemKey,
  priceDateLabel,
  priceLabel,
} from '../../src/lib/price-observations';
import type { LedgerState, PriceDatePrecision } from '../../src/lib/types';

export type PriceRow = {
  id: string;
  restaurantId: string;
  restaurant: string;
  address: string;
  item: string;
  priceCents: number;
  currency: string;
  visitDate: string;
  visitDatePrecision: PriceDatePrecision;
  /** Live reports of this item here; a superseded or withdrawn row counts the same group. */
  reportCount: number;
  live: boolean;
  /** Withdrawn by its reporter; a corrected report is superseded, not withdrawn. */
  withdrawn: boolean;
};

const textKey = (value: string) =>
  value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * What the ledger knows about prices, read from the /api/ledger response. By default one row per
 * restaurant and item: the latest live report, with how many live reports back it. With `all`,
 * every report, superseded and withdrawn ones marked, oldest visit first.
 */
export function priceRows(
  ledger: Pick<LedgerState, 'restaurants' | 'priceObservations'>,
  options: { restaurant?: string; all?: boolean } = {},
): PriceRow[] {
  const known = ledger.restaurants ?? [];
  const wanted = options.restaurant?.trim();
  const chosen = wanted
    ? known.filter((item) => item.id === wanted || textKey(item.name) === textKey(wanted))
    : known;
  if (wanted && !chosen.length)
    throw new Error(
      `No restaurant matches "${wanted}". Use a restaurant name from lobster prices list, or an ID from lobster prices list --json.`,
    );
  const rows: PriceRow[] = [];
  for (const restaurant of chosen) {
    const reports = (ledger.priceObservations ?? [])
      .filter((item) => item.restaurantId === restaurant.id)
      .sort(compareByVisit);
    const groups = new Map<string, typeof reports>();
    for (const report of reports) {
      const key = itemKey(report.itemName);
      groups.set(key, [...(groups.get(key) ?? []), report]);
    }
    for (const group of groups.values()) {
      const live = group.filter(isLiveReport);
      for (const report of options.all ? group : live.slice(-1)) {
        rows.push({
          id: report.id,
          restaurantId: restaurant.id,
          restaurant: restaurant.name,
          address: restaurant.address,
          item: report.itemName,
          priceCents: report.priceCents,
          currency: report.currency,
          visitDate: report.visitDate,
          visitDatePrecision: report.visitDatePrecision,
          reportCount: live.length,
          live: isLiveReport(report),
          withdrawn: !!report.withdrawnAt,
        });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      a.restaurant.localeCompare(b.restaurant) ||
      a.restaurantId.localeCompare(b.restaurantId) ||
      itemKey(a.item).localeCompare(itemKey(b.item)),
  );
}

/** A table a person can read: restaurant, item, price, visit date, report count. */
export function renderPriceTable(rows: PriceRow[]): string {
  if (!rows.length) return 'No prices on record.';
  return rows
    .map((row) => {
      const reports = `${row.reportCount} ${row.reportCount === 1 ? 'report' : 'reports'}`;
      return `${row.restaurant}\t${row.item}\t${priceLabel(row.priceCents)}\t${priceDateLabel(row)}\t${reports}${row.live ? '' : row.withdrawn ? '\twithdrawn' : '\tsuperseded'}\n  ${row.address}`;
    })
    .join('\n');
}
