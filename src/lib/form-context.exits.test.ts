import { describe, expect, it } from 'vitest';
import { applyAction, createBet } from './ledger';
import {
  answerInstead,
  approvalChanges,
  changesSince,
  describeChange,
  formApplies,
  replacementForm,
} from './form-context';
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

describe('changes made by someone else since a version was read', () => {
  it('lists only the other people’s events', () => {
    const seen = active();
    const mine = applyAction(
      seen,
      { type: 'set_check_in', checkIn: { at: due, timezone: 'UTC' } },
      'a',
      now,
    );
    expect(changesSince(seen, mine, 'a')).toEqual([]);
    const theirs = applyAction(
      mine,
      { type: 'propose_void', note: 'The release was cancelled.' },
      'b',
      now,
    );
    expect(changesSince(seen, theirs, 'a').map((event) => event.type)).toEqual(['propose_void']);
  });
  it('leaves personal check-ins out of the changes that hold an approval', () => {
    const seen = active();
    const checked = applyAction(
      seen,
      { type: 'set_check_in', checkIn: { at: due, timezone: 'UTC' } },
      'b',
      now,
    );
    expect(changesSince(seen, checked, 'a')).toHaveLength(1);
    expect(approvalChanges(seen, checked, 'a')).toEqual([]);
    const voiding = applyAction(checked, { type: 'propose_void', note: 'Cancelled.' }, 'b', now);
    expect(approvalChanges(seen, voiding, 'a').map((event) => event.type)).toEqual([
      'propose_void',
    ]);
  });
  it('describes each change in a few plain words', () => {
    const bet = applyAction(active(), { type: 'propose_void', note: 'Cancelled.' }, 'b', now);
    expect(describeChange(bet.events.at(-1)!)).toBe('proposed calling off the bet');
    expect(describeChange({ ...bet.events.at(-1)!, type: 'something_new' })).toBe(
      'updated this bet',
    );
  });
  it('words every disagreement with the one verb the buttons use', () => {
    const at = (type: string) => describeChange({ ...active().events.at(-1)!, type });
    expect(at('dispute_result')).toBe('disagreed with the result');
    expect(at('dispute_settlement')).toBe('disagreed with the delivery report');
    expect(at('dispute_readiness')).toBe('disagreed with the readiness evidence');
  });
});

describe('whether an open form still applies to the latest record', () => {
  it('stops offering a withdrawal once the other bettor has agreed', () => {
    expect(formApplies('withdraw', pending(), 'a')).toBe(true);
    expect(formApplies('withdraw', active(), 'a')).toBe(false);
    expect(replacementForm('withdraw', active(), 'a')).toBe('void');
  });
  it('stops offering a decline once the bet is active, and offers a call-off instead', () => {
    expect(formApplies('decline', pending(), 'b')).toBe(true);
    expect(formApplies('decline', pending(), 'a')).toBe(false);
    expect(formApplies('decline', active(), 'b')).toBe(false);
    expect(replacementForm('decline', active(), 'b')).toBe('void');
  });
  it('turns a result written while the other bettor proposed theirs into a disagreement', () => {
    const theirs = applyAction(
      active(),
      { type: 'propose_result', winnerId: 'b', note: 'Blair won.' },
      'b',
      due,
    );
    expect(formApplies('result', theirs, 'a', due)).toBe(false);
    expect(replacementForm('result', theirs, 'a', { winnerId: 'a' })).toBe('dispute_result');
    expect(replacementForm('result', theirs, 'a', { winnerId: null })).toBe('dispute_result');
  });
  it('never turns agreement into a disagreement', () => {
    const theirs = applyAction(
      active(),
      { type: 'propose_result', winnerId: 'b', note: 'Blair won.' },
      'b',
      due,
    );
    // The same winner, or a draft that has not named one yet: answer theirs instead.
    expect(replacementForm('result', theirs, 'a', { winnerId: 'b' })).toBeNull();
    expect(replacementForm('result', theirs, 'a')).toBeNull();
    expect(answerInstead('result', theirs, 'a')).toBe('result');
    // Two people reporting the same delivery agree with each other.
    const owed = applyAction(
      applyAction(
        applyAction(active(), { type: 'propose_result', winnerId: 'a', note: 'Avery.' }, 'a', due),
        { type: 'confirm_result' },
        'b',
        due,
      ),
      { type: 'propose_settlement', method: 'roll', note: 'Three rolls at lunch.' },
      'b',
      due,
    );
    expect(formApplies('settlement', owed, 'a')).toBe(false);
    expect(replacementForm('settlement', owed, 'a')).toBeNull();
    expect(answerInstead('settlement', owed, 'a')).toBe('settlement');
    expect(answerInstead('settlement', owed, 'b')).toBeNull();
    expect(answerInstead('withdraw', active(), 'a')).toBeNull();
  });
  it('points evidence written while the other bettor added theirs at that evidence', () => {
    const theirs = applyAction(
      active(),
      { type: 'mark_ready', evidence: 'The release notes are out.' },
      'b',
      now,
    );
    expect(formApplies('ready', theirs, 'a', now)).toBe(false);
    // Evidence is not a disagreement: the draft may agree with theirs.
    expect(replacementForm('ready', theirs, 'a')).toBeNull();
    expect(answerInstead('ready', theirs, 'a')).toBe('readiness');
    expect(answerInstead('ready', theirs, 'b')).toBeNull();
  });
  it('has no replacement once the bet is closed', () => {
    const declined = applyAction(pending(), { type: 'withdraw', note: 'Wrong week.' }, 'a', now);
    expect(formApplies('decline', declined, 'b')).toBe(false);
    expect(replacementForm('decline', declined, 'b')).toBeNull();
  });
  it('keeps in-play tools available while a check-in changes', () => {
    const changed = applyAction(
      active(),
      { type: 'set_check_in', checkIn: { at: due, timezone: 'UTC' } },
      'b',
      now,
    );
    expect(formApplies('result', changed, 'a')).toBe(true);
    expect(formApplies('ready', changed, 'a')).toBe(true);
    expect(formApplies('void', changed, 'a')).toBe(true);
  });
  it('follows the proposer of an open proposal', () => {
    const bet = applyAction(active(), { type: 'propose_void', note: 'Cancelled.' }, 'a', now);
    expect(formApplies('withdraw_proposal', bet, 'a')).toBe(true);
    expect(formApplies('withdraw_proposal', bet, 'b')).toBe(false);
    expect(formApplies('reject_void', bet, 'b')).toBe(true);
    expect(formApplies('reject_void', bet, 'a')).toBe(false);
    expect(formApplies('void', bet, 'a')).toBe(false);
  });
  it('lets the member who added readiness evidence withdraw it while nothing else is open', () => {
    const early = applyAction(
      active(),
      { type: 'mark_ready', evidence: 'Shipped early.' },
      'a',
      now,
    );
    expect(formApplies('withdraw_proposal', early, 'a')).toBe(true);
    expect(formApplies('withdraw_proposal', early, 'b')).toBe(false);
    // An open call-off is what the proposer would take back first; the engine says the same.
    const voiding = applyAction(early, { type: 'propose_void', note: 'Cancelled.' }, 'b', now);
    expect(formApplies('withdraw_proposal', voiding, 'a')).toBe(false);
  });
  it('offers readiness evidence only to its author once some is on the bet, and lets the other bettor disagree', () => {
    const early = applyAction(
      active(),
      { type: 'mark_ready', evidence: 'Shipped early.' },
      'a',
      now,
    );
    expect(formApplies('ready', active(), 'b')).toBe(true);
    expect(formApplies('ready', early, 'a')).toBe(true);
    expect(formApplies('ready', early, 'b')).toBe(false);
    expect(formApplies('dispute_readiness', early, 'b')).toBe(true);
    expect(formApplies('dispute_readiness', early, 'a')).toBe(false);
    expect(formApplies('dispute_readiness', active(), 'b')).toBe(false);
    const judged = applyAction(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'mark_ready', evidence: 'Shipped early.' },
      'a',
      now,
    );
    expect(formApplies('dispute_readiness', judged, 'c')).toBe(false);
    const voiding = applyAction(early, { type: 'propose_void', note: 'Cancelled.' }, 'a', now);
    expect(formApplies('dispute_readiness', voiding, 'b')).toBe(false);
  });
  it('words a disagreement with the evidence and a judge’s recommendation plainly', () => {
    const early = applyAction(
      active(),
      { type: 'mark_ready', evidence: 'Shipped early.' },
      'a',
      now,
    );
    const disputed = applyAction(
      early,
      { type: 'dispute_readiness', note: 'That was a staging deploy.' },
      'b',
      now,
    );
    expect(describeChange(disputed.events.at(-1)!)).toBe('disagreed with the readiness evidence');
    expect(describeChange({ ...disputed.events.at(-1)!, type: 'adjudicate' })).toBe(
      'recorded a recommendation',
    );
  });
  it('lets the named judge step down only before a result', () => {
    const judged = active({ decisionMethod: 'judge', judgeId: 'c' });
    expect(formApplies('decline_judging', judged, 'c')).toBe(true);
    const ruled = applyAction(
      judged,
      { type: 'adjudicate', winnerId: 'a', note: 'Thursday per the log.' },
      'c',
      due,
    );
    expect(formApplies('decline_judging', ruled, 'c')).toBe(false);
    const reported = pending({
      decisionMethod: 'judge',
      judgeId: 'c',
      timing: undefined,
      deadline: '2024-02-10',
      history: {
        stage: 'owed',
        originalDate: { precision: 'month', value: '2024-02' },
        result: { winnerId: 'a', date: { precision: 'unknown' }, note: 'Shipped.' },
      },
      acknowledgements: { terms: true, result: true, delivery: false },
    });
    expect(formApplies('decline_judging', reported, 'c')).toBe(false);
  });
});
