import type { Bet } from './types';

// Leaf helpers about who owes what; both ledger.ts and bet-workflow.ts depend on them,
// so they live apart to keep those two modules free of an import cycle.
export const parties = (bet: Bet) => [bet.creatorId, bet.opponentId];
export const approvedByBoth = (bet: Bet, approvals: string[]) =>
  approvals.length === 2 &&
  bet.creatorId !== bet.opponentId &&
  parties(bet).every((id) => approvals.includes(id));
export const hasConfirmedResult = (bet: Bet) =>
  ['owed', 'settling', 'settled'].includes(bet.status) &&
  !!bet.resolution?.winnerId &&
  parties(bet).includes(bet.resolution.winnerId) &&
  approvedByBoth(bet, bet.agreementApprovals) &&
  approvedByBoth(bet, bet.resolution.approvals);
export const hasDebt = (bet: Bet) =>
  ['owed', 'settling'].includes(bet.status) && hasConfirmedResult(bet);
/** Original stakes and results remain immutable when debts are offset. */
export function getOffsetRolls(bet: Bet): number {
  return (bet.offsets ?? []).reduce(
    (total, offset) =>
      total + (offset.allocations.find((item) => item.betId === bet.id)?.rolls ?? 0),
    0,
  );
}
export function getRemainingRolls(bet: Bet): number {
  return hasDebt(bet) ? bet.stake - getOffsetRolls(bet) : 0;
}
export function getDeliveredRolls(bet: Bet): number {
  return bet.status === 'settled' && bet.settlement?.method === 'roll'
    ? bet.stake - getOffsetRolls(bet)
    : 0;
}
