import { describe, expect, it } from 'vitest';
import { createDemoState } from './demo';
import { applyAction, createBet } from './ledger';
import { leaderboardLines, ordinal, standings, WIN_RATE_MIN_DECIDED } from './standings';
import type { Bet } from './types';

const demo = createDemoState();
const AT = '2026-09-01T12:00:00.000Z';
/** A confirmed result: `winner` beat `loser` for `stake` rolls. */
function won(winner: string, loser: string, stake = 1): Bet {
  let bet = createBet(
    {
      title: `${winner} beats ${loser}`,
      terms: 'Settled on the night.',
      category: 'Sports',
      opponentId: loser,
      creatorSide: 'Yes',
      opponentSide: 'No',
      stake,
      timing: { kind: 'date', at: AT, timezone: 'UTC' },
    },
    winner,
    demo.members,
    AT,
  );
  bet = applyAction(bet, { type: 'accept' }, loser, AT);
  bet = applyAction(
    bet,
    { type: 'propose_result', winnerId: winner, note: 'Called it.' },
    winner,
    AT,
  );
  return applyAction(bet, { type: 'confirm_result' }, loser, AT);
}
const board = (bets: Bet[], sort: 'net' | 'wins' | 'rate' = 'net') =>
  standings({ members: demo.members, bets }, sort);
const ids = (list: { member: { id: string } }[]) => list.map((item) => item.member.id);

describe('standings', () => {
  it('ranks nobody without a confirmed result', () => {
    const { ranked, unranked, waiting } = board([]);
    expect(ranked).toEqual([]);
    expect(unranked).toEqual([]);
    expect(waiting).toHaveLength(demo.members.length);
  });

  it('gives tied members one competition rank, and the next member skips', () => {
    const { ranked } = board([
      won('ellis', 'sarah'),
      won('olivia', 'marcus'),
      won('alex', 'james', 3),
    ]);
    expect(ranked.map((item) => [item.member.id, item.rank, item.tied])).toEqual([
      ['alex', 1, false],
      ['ellis', 2, true],
      ['olivia', 2, true],
      ['marcus', 4, true],
      ['sarah', 4, true],
      ['james', 6, false],
    ]);
  });

  it('breaks a tie on the first figure with the second', () => {
    const { ranked } = board([
      won('ellis', 'sarah'),
      won('ellis', 'sarah'),
      won('alex', 'james', 2),
    ]);
    // Ellis and Alex are both 2 net rolls up; Ellis has two wins to Alex's one.
    expect(ranked.slice(0, 2).map((item) => [item.member.id, item.rank, item.tied])).toEqual([
      ['ellis', 1, false],
      ['alex', 2, false],
    ]);
  });

  it(`ranks win rate from ${WIN_RATE_MIN_DECIDED} decided bets and lists the rest unranked`, () => {
    const bets = [
      won('ellis', 'sarah'),
      won('ellis', 'sarah'),
      won('sarah', 'ellis'),
      won('marcus', 'olivia'),
    ];
    const { ranked, unranked } = board(bets, 'rate');
    expect(ids(ranked)).toEqual(['ellis', 'sarah']);
    expect(ids(unranked)).toEqual(['marcus', 'olivia']);
    expect(unranked.every((item) => item.rank === undefined)).toBe(true);
  });
});

describe('leaderboardLines', () => {
  const lines = (bets: Bet[]) => leaderboardLines({ members: demo.members, bets });
  const brief = (list: ReturnType<typeof lines>) =>
    list.map((line) => [line.member.id, line.rank, line.tied, line.decided]);

  it('puts nobody on a rank before a result is confirmed, and lists everyone by name', () => {
    const all = lines([]);
    expect(all).toHaveLength(demo.members.length);
    expect(all.every((line) => line.rank === null && !line.tied && line.decided === 0)).toBe(true);
    expect(all.map((line) => line.member.name)).toEqual(
      demo.members.map((member) => member.name).sort((a, b) => a.localeCompare(b)),
    );
  });

  it('ranks as the website does, with ties sharing a rank, then lists the members still waiting', () => {
    const all = lines([won('ellis', 'sarah'), won('olivia', 'marcus'), won('alex', 'james', 3)]);
    expect(brief(all)).toEqual([
      ['alex', 1, false, 1],
      ['ellis', 2, true, 1],
      ['olivia', 2, true, 1],
      ['marcus', 4, true, 1],
      ['sarah', 4, true, 1],
      ['james', 6, false, 1],
    ]);
  });

  it('keeps a member with no result off the ranks even while others are ranked', () => {
    const all = lines([won('ellis', 'sarah')]);
    expect(brief(all)).toEqual([
      ['ellis', 1, false, 1],
      ['sarah', 2, false, 1],
      ['alex', null, false, 0],
      ['james', null, false, 0],
      ['marcus', null, false, 0],
      ['olivia', null, false, 0],
    ]);
  });

  it('carries each member’s own figures, the same ones the CLI and the website show', () => {
    const [first, second] = lines([won('ellis', 'sarah', 2)]);
    expect(first).toMatchObject({ net: 2, won: 1, lost: 0, winRate: 100 });
    expect(second).toMatchObject({ net: -2, won: 0, lost: 1, winRate: 0 });
  });
});

it('writes ordinals', () => {
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
    '1st',
    '2nd',
    '3rd',
    '4th',
    '11th',
    '12th',
    '13th',
    '21st',
    '22nd',
    '101st',
  ]);
});
