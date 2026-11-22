import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyDebtOffset,
  createBet,
  getBalances,
  getDeliveredRolls,
  getDirectDebts,
  getMemberStats,
  getOffsetRolls,
  getRemainingRolls,
  previewDebtOffset,
} from './ledger';
import { exportCsv } from './export';
import { debtOffsetSchema } from './api-schemas';
import type { Bet, Member } from './types';
const members: Member[] = ['tammen', 'ellis', 'peter'].map((id) => ({
  id,
  name: id,
  initials: id[0],
  color: '#153b3e',
}));
function owed(
  winnerId: string,
  stake: number,
  opponentId = 'ellis',
  at = '2026-10-01T12:00:00Z',
): Bet {
  let bet = createBet(
    {
      title: 'A friendly wager',
      terms: 'The published result determines the winner.',
      category: 'Life',
      creatorSide: 'Yes',
      opponentSide: 'No',
      opponentId,
      stake,
      deadline: '2026-10-01',
    },
    'tammen',
    members,
    at,
  );
  bet = applyAction(bet, { type: 'accept' }, opponentId, at);
  bet = applyAction(
    bet,
    { type: 'propose_result', winnerId, note: 'Official result.' },
    'tammen',
    at,
  );
  return applyAction(bet, { type: 'confirm_result' }, opponentId, at);
}
const pair = () => [owed('ellis', 2), owed('tammen', 5)];
const apply = (bets: Bet[], actor = 'tammen', other = 'ellis') =>
  applyDebtOffset(bets, previewDebtOffset(bets, actor, other)!, actor);

describe('explicit mutual debt offsets', () => {
  it.each(['tammen', 'ellis'])(
    'allows %s to cancel 2 against 5 without counterparty consent',
    (actor) => {
      const bets = pair();
      const before = structuredClone(bets);
      const result = apply(bets, actor, actor === 'tammen' ? 'ellis' : 'tammen');
      const first = result.bets.find((bet) => bet.id === bets[0].id)!;
      const second = result.bets.find((bet) => bet.id === bets[1].id)!;
      expect(first.status).toBe('settled');
      expect(first.settlement).toBeUndefined();
      expect(second.status).toBe('owed');
      expect(second.stake).toBe(5);
      expect(getRemainingRolls(second)).toBe(3);
      expect(getOffsetRolls(second)).toBe(2);
      expect(getDirectDebts(result.bets)).toEqual([{ fromId: 'ellis', toId: 'tammen', rolls: 3 }]);
      expect(getBalances(result.bets)).toEqual(getBalances(bets));
      expect(result.bets.every((bet) => bet.offsets![0].actorId === actor)).toBe(true);
      expect(result.bets.every((bet) => bet.offsets![0].id === result.offset.id)).toBe(true);
      for (const original of before) {
        const updated = result.bets.find((bet) => bet.id === original.id)!;
        expect(updated.events.slice(0, -1)).toEqual(original.events);
        expect(updated.version).toBe(original.version + 1);
        expect(updated.resolution).toEqual(original.resolution);
        expect(updated.events.at(-1)?.detail).toContain('No physical delivery recorded');
      }
      expect(bets).toEqual(before);
    },
  );
  it('fully settles equal debts and retains all-time results', () => {
    const bets = [owed('ellis', 2), owed('tammen', 2)];
    const result = apply(bets);
    expect(result.bets.every((bet) => bet.status === 'settled')).toBe(true);
    expect(getDirectDebts(result.bets)).toEqual([]);
    expect(getMemberStats(result.bets, 'tammen')).toMatchObject({
      won: 1,
      lost: 1,
      rollsWon: 2,
      rollsLost: 2,
      youOwe: 0,
      owedToYou: 0,
    });
    expect(result.bets.map(getDeliveredRolls)).toEqual([0, 0]);
  });
  it('preserves amounts and all-time results across varied reciprocal debts', () => {
    for (let left = 1; left <= 6; left++) {
      for (let right = 1; right <= 6; right++) {
        const original = [owed('ellis', left), owed('tammen', right)];
        const result = apply(original);
        const amount = Math.min(left, right);
        expect(result.offset.rolls).toBe(amount);
        expect(result.bets.reduce((sum, bet) => sum + getRemainingRolls(bet), 0)).toBe(
          Math.abs(left - right),
        );
        for (const member of ['tammen', 'ellis']) {
          const before = getMemberStats(original, member);
          const after = getMemberStats(result.bets, member);
          expect([after.won, after.lost, after.rollsWon, after.rollsLost, after.net]).toEqual([
            before.won,
            before.lost,
            before.rollsWon,
            before.rollsLost,
            before.net,
          ]);
        }
      }
    }
  });
  it('uses oldest bets first with a stable ID tie-breaker', () => {
    const old = owed('tammen', 1, 'ellis', '2026-09-01T12:00:00Z');
    const newer = owed('tammen', 5);
    const result = apply([newer, owed('ellis', 2), old]);
    expect(getRemainingRolls(result.bets.find((bet) => bet.id === old.id)!)).toBe(0);
    expect(getRemainingRolls(result.bets.find((bet) => bet.id === newer.id)!)).toBe(4);
  });
  it('cannot transfer debts through Peter or let a third party apply an offset', () => {
    expect(
      previewDebtOffset([owed('tammen', 5), owed('peter', 2, 'peter')], 'tammen', 'ellis'),
    ).toBeNull();
    const bets = pair();
    expect(() =>
      applyDebtOffset(bets, previewDebtOffset(bets, 'tammen', 'ellis')!, 'peter'),
    ).toThrow();
    const peterDebt = owed('peter', 4, 'peter');
    expect(apply([...bets, peterDebt]).bets.some((bet) => bet.id === peterDebt.id)).toBe(false);
  });
  it('excludes unconfirmed results and delivery proposals', () => {
    const [incoming, outgoing] = pair();
    const delivering = applyAction(
      outgoing,
      { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
      'ellis',
    );
    expect(previewDebtOffset([incoming, delivering], 'tammen', 'ellis')).toBeNull();
    const unconfirmed = {
      ...outgoing,
      resolution: { ...outgoing.resolution!, approvals: ['tammen'] },
    };
    expect(previewDebtOffset([incoming, unconfirmed], 'tammen', 'ellis')).toBeNull();
  });
  it('rejects stale, repeated, duplicated and tampered allocations', () => {
    const bets = pair();
    const preview = previewDebtOffset(bets, 'tammen', 'ellis')!;
    const result = applyDebtOffset(bets, preview, 'tammen');
    expect(() => applyDebtOffset(result.bets, preview, 'tammen')).toThrow(/changed/);
    const edited = structuredClone(bets);
    edited[0].version += 1;
    expect(() => applyDebtOffset(edited, preview, 'tammen')).toThrow(/changed/);
    for (const input of [
      { ...preview, rolls: 1 },
      { ...preview, allocations: [preview.allocations[0], preview.allocations[0]] },
      {
        ...preview,
        allocations: preview.allocations.map((item) => ({ ...item, rolls: item.rolls + 1 })),
      },
    ])
      expect(() => applyDebtOffset(bets, input, 'tammen')).toThrow(/changed/);
    expect(debtOffsetSchema.safeParse({ ...preview, actorId: 'ellis' }).success).toBe(false);
  });
  it('allows repeated offsets with new debts without exceeding an original stake', () => {
    const bets = pair();
    const first = apply(bets).bets;
    const more = owed('ellis', 1);
    const second = apply([...first, more]).bets;
    const remaining = second.find((bet) => bet.id === bets[1].id)!;
    expect(getRemainingRolls(remaining)).toBe(2);
    expect(getOffsetRolls(remaining)).toBe(3);
    expect(remaining.offsets).toHaveLength(2);
  });
  it('delivers and confirms only the remaining rolls after a partial offset', () => {
    const bets = apply(pair()).bets;
    const partial = bets.find((bet) => bet.status === 'owed')!;
    const reported = applyAction(
      partial,
      { type: 'propose_settlement', method: 'roll', note: 'Three rolls at lunch.' },
      'ellis',
    );
    expect(reported.events.at(-1)?.detail).toContain('3 actual lobster rolls');
    const settled = applyAction(reported, { type: 'confirm_settlement' }, 'tammen');
    expect(getDeliveredRolls(settled)).toBe(3);
    expect(getRemainingRolls(settled)).toBe(0);
    expect(getMemberStats([settled], 'tammen')).toMatchObject({ rollsWon: 5, owedToYou: 0 });
    const disputed = applyAction(
      reported,
      { type: 'dispute_settlement', note: 'Not yet delivered.' },
      'tammen',
    );
    expect(getRemainingRolls(disputed)).toBe(3);
    expect(getOffsetRolls(disputed)).toBe(2);
  });
  it('exports partial offsets and the shared audit record separately from delivery', () => {
    const result = apply(pair());
    const csv = exportCsv(result.bets, members);
    expect(csv).toContain('Rolls offset');
    expect(csv).toContain('Rolls remaining');
    expect(csv).toContain(result.offset.id);
    expect(csv).toContain('counterpartyId');
  });
});
