import { describe, expect, it } from 'vitest';
import { createDemoState } from './demo';
import { closedBetNote } from './place-stats';
import type { Bet } from './types';

const demo = createDemoState();
const bet = (status: Bet['status'], lastEvent?: string): Bet => ({
  ...demo.bets[0],
  status,
  events: lastEvent
    ? [...demo.bets[0].events, { ...demo.bets[0].events[0], type: lastEvent as never }]
    : demo.bets[0].events,
});

describe('closedBetNote', () => {
  it('says nothing when every wager listed was placed or is waiting', () => {
    expect(closedBetNote([bet('active'), bet('pending'), bet('settled')])).toBe('');
    expect(closedBetNote([])).toBe('');
  });

  it('counts the wagers their proposer took back, and the ones turned down', () => {
    expect(closedBetNote([bet('declined', 'withdraw')])).toBe('1 withdrawn');
    expect(closedBetNote([bet('declined', 'decline'), bet('declined', 'decline')])).toBe(
      '2 declined',
    );
    expect(
      closedBetNote([
        bet('active'),
        bet('declined', 'decline'),
        bet('declined', 'withdraw'),
        bet('declined', 'withdraw'),
      ]),
    ).toBe('2 withdrawn, 1 declined');
  });
});
