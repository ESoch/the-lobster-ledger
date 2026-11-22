import type { Bet, HistoricalDate, LedgerState, Member } from './types';
import { compareByVisit, itemKey } from './price-observations';
import { getOffsetRolls, getRemainingRolls, getDeliveredRolls } from './ledger';
import { betStatusLabel } from './bet-workflow';
import { entrySourceLabel } from './entry-source';

const decisionMethodLabels = {
  mutual: 'Mutual agreement',
  judge: 'Judge',
  chatgpt: 'ChatGPT',
} as const;
/** Date-stamped download names (the member's local calendar day) so exports do not overwrite each other. */
export function exportFilename(
  kind: 'csv' | 'json' | 'prices',
  now: Date | string | number = new Date(),
): string {
  const at = new Date(now);
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  if (kind === 'prices') return `lobster-ledger-prices-${day}.csv`;
  return kind === 'csv' ? `lobster-ledger-${day}.csv` : `lobster-ledger-audit-${day}.json`;
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text) || /^\s+[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportCsv(bets: Bet[], members: Member[]): string {
  const name = (id?: string | null) => members.find((member) => member.id === id)?.name ?? '';
  const historicalDate = (date?: HistoricalDate) =>
    date?.precision === 'unknown' ? 'Unknown' : (date?.value ?? '');
  const rows = [
    [
      'ID',
      'Reference',
      'Bet',
      'Decision criteria',
      'Category',
      'Proposer',
      'Opponent',
      'Proposer side',
      'Opponent side',
      'Rolls',
      'Status',
      'Status code',
      'Winner',
      'Decided by',
      'Judge',
      'Decision date',
      'Location',
      'Created at',
      'Updated at',
      'Version',
      'Timing method',
      'Decision timing',
      'Decision timezone',
      'Expected evidence',
      'Wager cutoff',
      'Cutoff timezone',
      'Record source',
      'Original bet date',
      'Original date precision',
      'Reported historical stage',
      'Reported historical winner',
      'Historical outcome date',
      'Historical outcome note',
      'Historical delivery date',
      'Historical delivery note',
      'History confirmed at',
      'Readiness evidence',
      'Previous adjudication method',
      'Previous adjudication note',
      'Previous adjudication source',
      'Entry source',
      'Rolls offset',
      'Rolls delivered',
      'Rolls remaining',
      'Offset history',
    ],
    ...bets.map((bet) => [
      bet.id,
      bet.reference,
      bet.title,
      bet.terms,
      bet.category,
      name(bet.creatorId),
      name(bet.opponentId),
      bet.creatorSide,
      bet.opponentSide,
      bet.stake,
      betStatusLabel(bet),
      bet.status,
      name(bet.resolution?.winnerId),
      decisionMethodLabels[bet.decisionMethod ?? 'mutual'],
      bet.decisionMethod === 'judge'
        ? `${name(bet.judgeId)}${bet.judgeDeclined && name(bet.judgeId) ? ' (stepped down)' : ''}`
        : '',
      bet.deadline,
      bet.location?.name,
      bet.createdAt,
      bet.updatedAt,
      bet.version,
      bet.timing?.kind ?? '',
      bet.timing?.kind === 'date' ? bet.timing.at : (bet.timing?.description ?? ''),
      bet.timing?.kind === 'date' ? bet.timing.timezone : '',
      bet.timing?.source ?? '',
      bet.cutoff?.at ?? '',
      bet.cutoff?.timezone ?? '',
      bet.history ? 'Historical record' : 'New bet',
      historicalDate(bet.history?.originalDate),
      bet.history?.originalDate.precision ?? '',
      bet.history?.stage ?? '',
      name(bet.history?.result?.winnerId),
      historicalDate(bet.history?.result?.date),
      bet.history?.result?.note ?? '',
      historicalDate(bet.history?.delivery?.date),
      bet.history?.delivery?.note ?? '',
      bet.history?.confirmedAt ?? '',
      bet.readiness?.evidence ?? '',
      bet.history?.previousAdjudication?.method ?? '',
      bet.history?.previousAdjudication?.note ?? '',
      bet.history?.previousAdjudication?.sourceUrl ?? '',
      entrySourceLabel(bet.entrySource, !!bet.entrySourceInference, !!bet.entrySourceReport),
      getOffsetRolls(bet),
      getDeliveredRolls(bet),
      getRemainingRolls(bet),
      bet.offsets?.length ? JSON.stringify(bet.offsets) : '',
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
/**
 * One row per price report, superseded and withdrawn ones included so the correction and
 * withdrawal trail survives. Oldest visit first within each restaurant and item. A correction
 * or a withdrawal is what takes a report out of the live prices.
 */
export function exportPricesCsv(
  state: Pick<LedgerState, 'members' | 'restaurants' | 'priceObservations'>,
): string {
  const restaurants = state.restaurants ?? [];
  const restaurant = (id: string) => restaurants.find((item) => item.id === id);
  const reporter = (id: string) => state.members.find((member) => member.id === id)?.name ?? '';
  const ordered = [...(state.priceObservations ?? [])].sort(
    (a, b) =>
      (restaurant(a.restaurantId)?.name ?? '').localeCompare(
        restaurant(b.restaurantId)?.name ?? '',
      ) ||
      a.restaurantId.localeCompare(b.restaurantId) ||
      itemKey(a.itemName).localeCompare(itemKey(b.itemName)) ||
      compareByVisit(a, b),
  );
  const rows = [
    [
      'ID',
      'Restaurant',
      'Address',
      'Item',
      'Price',
      'Currency',
      'Visit date',
      'Precision',
      'Reporter',
      'Reported at',
      'Corrected from',
      'Corrected at',
      'Correction reason',
      'Withdrawn at',
      'Withdrawn reason',
      'Entry source',
      'Note',
    ],
    ...ordered.map((item) => [
      item.id,
      restaurant(item.restaurantId)?.name ?? '',
      restaurant(item.restaurantId)?.address ?? '',
      item.itemName,
      (item.priceCents / 100).toFixed(2),
      item.currency,
      item.visitDate,
      item.visitDatePrecision,
      reporter(item.reporterId),
      item.reportedAt,
      item.correctedFromId ?? '',
      item.correctedAt ?? '',
      item.correctionReason ?? '',
      item.withdrawnAt ?? '',
      item.withdrawnReason ?? '',
      entrySourceLabel(item.entrySource === 'web' ? 'browser' : item.entrySource),
      item.note ?? '',
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
export function exportJson(
  state: LedgerState,
  options?: { mode?: 'demo' | 'shared'; now?: () => string },
): string {
  return JSON.stringify(
    {
      exportedAt: (options?.now ?? (() => new Date().toISOString()))(),
      mode: options?.mode ?? 'shared',
      ...state,
    },
    null,
    2,
  );
}
export function downloadFile(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
