import { describe, expect, it } from 'vitest';
import { applyAction, createBet } from './ledger';
import type { Member, NewBet } from './types';

const members: Member[] = ['a', 'b', 'c'].map((id) => ({
  id,
  name: id,
  initials: id,
  color: '#123456',
}));
const now = '2026-09-20T12:00:00.000Z';
const input: NewBet = {
  title: 'The launch will ship this month',
  terms: 'The public release announcement decides.',
  category: 'Work',
  creatorSide: 'It ships',
  opponentSide: 'It slips',
  opponentId: 'b',
  stake: 1,
  timing: { kind: 'event', description: 'The release announcement is published' },
  decisionMethod: 'chatgpt',
};
const prompt = {
  type: 'propose_prompt' as const,
  text: 'Judge this agreement using only the supplied terms and evidence.',
};

describe('initial ChatGPT prompt', () => {
  it('keeps the bet pending and requires separate opponent approvals for terms and prompt', () => {
    const bet = applyAction(createBet(input, 'a', members, now), prompt, 'a', now);
    expect(bet.status).toBe('pending');
    expect(bet.agreementApprovals).toEqual(['a']);
    expect(bet.promptAgreement?.approvals).toEqual(['a']);
    expect(() => applyAction(bet, { type: 'approve_prompt' }, 'b', now)).toThrow();
    const accepted = applyAction(bet, { type: 'accept' }, 'b', now);
    expect(accepted.promptAgreement?.approvals).toEqual(['a']);
    const approved = applyAction(accepted, { type: 'approve_prompt' }, 'b', now);
    expect(approved.promptAgreement?.approvals).toEqual(['a', 'b']);
    expect(approved.events.map((event) => event.type)).toEqual([
      'created',
      'propose_prompt',
      'accept',
      'approve_prompt',
    ]);
  });

  it('rejects third parties and non-ChatGPT agreements', () => {
    expect(() => applyAction(createBet(input, 'a', members, now), prompt, 'c', now)).toThrow();
    expect(() =>
      applyAction(
        createBet({ ...input, decisionMethod: 'mutual' }, 'a', members, now),
        prompt,
        'a',
        now,
      ),
    ).toThrow();
  });

  it('does not mix new prompt consent into unconfirmed historical reports', () => {
    const bet = createBet(
      {
        ...input,
        history: { stage: 'active', originalDate: { precision: 'unknown' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      now,
    );
    expect(() => applyAction(bet, prompt, 'a', now)).toThrow();
  });
});
