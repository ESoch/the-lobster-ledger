import { describe, expect, it } from 'vitest';
import { applyAction, createBet } from './ledger';
import { closureRecord } from './bet-closure';
import type { Member, NewBet } from './types';

const now = '2026-09-01T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
  { id: 'c', name: 'Casey Hale', initials: 'CH', color: '#2b4a1e' },
];
const input: NewBet = {
  title: 'Friday release',
  terms: 'Ships by the agreed cutoff.',
  category: 'Work',
  opponentId: 'b',
  creatorSide: 'Ships',
  opponentSide: 'Delayed',
  stake: 3,
  deadline: undefined,
  timing: { kind: 'date', at: due, timezone: 'UTC' },
};
const pending = (overrides: Partial<NewBet> = {}) =>
  createBet({ ...input, ...overrides }, 'a', members, now);
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(pending(overrides), { type: 'accept' }, 'b', now);
const proposed = () =>
  applyAction(
    active(),
    { type: 'propose_result', winnerId: 'a', note: 'Shipped on Thursday.' },
    'a',
    due,
  );
const owed = () => applyAction(proposed(), { type: 'confirm_result' }, 'b', due);
const reported = () =>
  applyAction(
    owed(),
    { type: 'propose_settlement', method: 'roll', note: 'Three rolls at lunch.' },
    'b',
    due,
  );

describe('closure records', () => {
  it('names who declined and why', () => {
    const bet = applyAction(
      pending(),
      { type: 'decline', note: 'Out of office that week.' },
      'b',
      now,
    );
    const record = closureRecord(bet);
    expect(record?.kind).toBe('declined');
    expect(record?.event.actorId).toBe('b');
    expect(record?.note).toBe('Out of office that week.');
  });
  it('tells a withdrawal from a decline', () => {
    const bet = applyAction(
      pending(),
      { type: 'withdraw', note: 'I had the week wrong.' },
      'a',
      now,
    );
    expect(closureRecord(bet)).toMatchObject({ kind: 'withdrawn', note: 'I had the week wrong.' });
  });
  it('keeps a disputed result on the sheet with the proposal it cleared', () => {
    const bet = applyAction(
      proposed(),
      { type: 'dispute_result', note: 'It slipped to Monday.' },
      'b',
      due,
    );
    const record = closureRecord(bet);
    expect(record?.kind).toBe('disputed_result');
    expect(record?.note).toBe('It slipped to Monday.');
    expect(record?.disputed?.type).toBe('propose_result');
    expect(record?.disputed?.detail).toContain('Shipped on Thursday.');
  });
  it('keeps the judge’s earlier ruling with the dispute', () => {
    let bet = active({ decisionMethod: 'judge', judgeId: 'c' });
    bet = applyAction(
      bet,
      { type: 'adjudicate', winnerId: 'a', note: 'The release log shows Thursday.' },
      'c',
      due,
    );
    bet = applyAction(bet, { type: 'dispute_result', note: 'Wrong time zone.' }, 'b', due);
    const record = closureRecord(bet);
    expect(record?.kind).toBe('disputed_result');
    expect(record?.disputed?.type).toBe('adjudicate');
    expect(record?.disputed?.detail).toContain('The release log shows Thursday.');
  });
  it('drops the dispute once a new result is proposed', () => {
    let bet = applyAction(proposed(), { type: 'dispute_result', note: 'It slipped.' }, 'b', due);
    bet = applyAction(
      bet,
      { type: 'propose_result', winnerId: 'b', note: 'Fine, it slipped.' },
      'a',
      due,
    );
    expect(closureRecord(bet)).toBeUndefined();
  });
  it('keeps a disputed delivery while the rolls are owed again', () => {
    const bet = applyAction(
      reported(),
      { type: 'dispute_settlement', note: 'It was a crab roll.' },
      'a',
      due,
    );
    const record = closureRecord(bet);
    expect(record?.kind).toBe('disputed_delivery');
    expect(record?.note).toBe('It was a crab roll.');
    expect(record?.disputed?.type).toBe('propose_settlement');
  });
  it('has nothing to say about an open bet with no exit', () => {
    expect(closureRecord(pending())).toBeUndefined();
    expect(closureRecord(active())).toBeUndefined();
    expect(closureRecord(owed())).toBeUndefined();
  });
});
