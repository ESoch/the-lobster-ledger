import type { Bet } from './types';
import { closureOf } from './bet-workflow';
import { plural } from './plural';

// One shared helper; kept exported here for the places components that already import it.
export { plural };

/** A wager counts as placed once both bettors agreed to it. Unanswered and
 * declined proposals stay on record but were never placed. */
export function placeBetCounts(bets: Bet[], placeId: string) {
  let placed = 0;
  let awaiting = 0;
  for (const bet of bets) {
    if (bet.location?.id !== placeId) continue;
    if (bet.status === 'pending') awaiting++;
    else if (bet.status !== 'declined') placed++;
  }
  return { placed, awaiting };
}

export function placeCountLabel({ placed, awaiting }: { placed: number; awaiting: number }) {
  const label = `${plural(placed, 'bet')} placed here`;
  return awaiting ? `${label} · ${awaiting} awaiting agreement` : label;
}

/**
 * What a table of a place's wagers lists that `placeBetCounts` does not count: proposals closed
 * without being placed, as "1 withdrawn, 2 declined". Empty when there are none.
 */
export function closedBetNote(bets: Bet[]) {
  let withdrawn = 0;
  let declined = 0;
  for (const bet of bets) {
    const closure = closureOf(bet);
    if (closure === 'withdrawn') withdrawn++;
    else if (closure === 'declined') declined++;
  }
  return [withdrawn && `${withdrawn} withdrawn`, declined && `${declined} declined`]
    .filter(Boolean)
    .join(', ');
}
