// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createBet, needsAction } from '../lib/ledger';
import { primaryActionLabel } from '../lib/bet-workflow';
import type { Bet, HistoricalInput, Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';

// Dates sit in the past relative to the real clock the sheet reads, so "ready" states are ready.
const now = '2026-09-01T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
  { id: 'c', name: 'Casey Hale', initials: 'CH', color: '#2b4a1e' },
];
const name = (id: string) => members.find((member) => member.id === id)?.name.split(' ')[0] ?? id;
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
const history: HistoricalInput = {
  stage: 'active',
  originalDate: { precision: 'month', value: '2024-02' },
};
const acknowledgements = { terms: true, result: true, delivery: true };
const pending = (overrides: Partial<NewBet> = {}) =>
  createBet({ ...input, ...overrides }, 'a', members, now);
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(pending(overrides), { type: 'accept' }, 'b', now);
const result = { type: 'propose_result' as const, winnerId: 'a', note: 'Shipped on Thursday.' };
const owed = () =>
  applyAction(applyAction(active(), result, 'a', due), { type: 'confirm_result' }, 'b', due);
/** An amendment proposed before the judge it keeps stepped down. */
const keepsDeclinedJudge = () =>
  applyAction(
    applyAction(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      {
        type: 'propose_amendment',
        terms: 'Ships by the agreed cutoff, per the release log.',
        timing: { kind: 'date', at: due, timezone: 'UTC' },
        note: 'Name the source.',
        decisionMethod: 'judge',
        judgeId: 'c',
      },
      'a',
      now,
    ),
    { type: 'decline_judging', note: 'I am out.' },
    'c',
    now,
  );
const prompt = 'Decide, using the release log, whether the release shipped before the cutoff.';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(bet: Bet, memberId: string) {
  await act(async () =>
    root.render(
      createElement(BetDetail, { bet, members, memberId, onClose: () => {}, onAction: vi.fn() }),
    ),
  );
}
const dialog = () => document.querySelector('[role="dialog"]')!;
/** Buttons a person can see without opening a collapsed tools section. */
const visibleButtons = () =>
  [...dialog().querySelectorAll('button')]
    .filter((button) => !button.closest('details:not([open])'))
    .map((button) => button.textContent?.trim() ?? '');

describe('delivery reports state the rolls they settle', () => {
  it('shows the count on the reported-delivery block', async () => {
    const settling = applyAction(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Two rolls at lunch today.' },
      'b',
      due,
    );
    await render(settling, 'a');
    const block = dialog().querySelector('.settlement-block')!;
    expect(block.textContent).toContain('Settles 3 lobster rolls');
    expect(block.textContent).toContain('Two rolls at lunch today.');
  });
  it('tells the debtor how many rolls the report will settle and keeps the placeholder count-neutral', async () => {
    await render(owed(), 'b');
    await act(async () =>
      [...dialog().querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Record delivery'))!
        .click(),
    );
    const form = dialog().querySelector('form')!;
    expect(form.textContent).toContain('This report settles all 3 rolls you still owe Avery.');
    expect(form.querySelector('textarea')?.getAttribute('placeholder')).not.toMatch(/two/i);
  });
});

describe('inbox labels name a button on the sheet', () => {
  // Labels that stand for an approve/decline pair, with the buttons the sheet must show.
  const pairs: Record<string, string[]> = {
    'Answer a proposal': ['Agree to bet', 'Decline'],
    'Review revised terms': ['Agree to these changes', 'Decline proposal'],
    'Review no-winner proposal': ['Agree to no winner', 'Decline proposal'],
    'Approve a prompt': ['Approve this prompt', 'Revise prompt'],
    'Confirm a result': ['Confirm result', 'Disagree'],
    'Confirm a delivery': ['Confirm delivery', 'Disagree'],
  };
  const cases: [string, () => Bet, string][] = [
    ['a pending proposal', () => pending(), 'b'],
    [
      'a reported past bet',
      () => pending({ history, acknowledgements, timing: undefined, deadline: '2024-02-10' }),
      'b',
    ],
    [
      'a past bet with a correction requested',
      () =>
        applyAction(
          pending({ history, acknowledgements, timing: undefined, deadline: '2024-02-10' }),
          { type: 'request_history_correction', note: 'The month is wrong.' },
          'b',
          now,
        ),
      'a',
    ],
    ['a mutual bet whose decision time has passed', () => active(), 'a'],
    [
      'an event bet whose claim cutoff has passed',
      () =>
        active({
          timing: { kind: 'event', description: 'The acquisition closes' },
          cutoff: { at: '2026-10-01T07:00:00.000Z', timezone: 'UTC' },
        }),
      'a',
    ],
    ['a ChatGPT bet with no prompt yet', () => active({ decisionMethod: 'chatgpt' }), 'a'],
    [
      'a ChatGPT bet with a prompt to approve',
      () =>
        applyAction(
          active({ decisionMethod: 'chatgpt' }),
          { type: 'propose_prompt', text: prompt },
          'a',
          now,
        ),
      'b',
    ],
    [
      'a ChatGPT bet with an agreed prompt',
      () =>
        applyAction(
          applyAction(
            active({ decisionMethod: 'chatgpt' }),
            { type: 'propose_prompt', text: prompt },
            'a',
            now,
          ),
          { type: 'approve_prompt' },
          'b',
          now,
        ),
      'a',
    ],
    [
      'a ChatGPT bet whose agreed prompt leaves out the evidence',
      () =>
        applyAction(
          applyAction(
            applyAction(
              active({ decisionMethod: 'chatgpt' }),
              { type: 'propose_prompt', text: prompt },
              'a',
              now,
            ),
            { type: 'approve_prompt' },
            'b',
            now,
          ),
          { type: 'mark_ready', evidence: 'The release log shows Thursday.' },
          'b',
          now,
        ),
      'a',
    ],
    [
      'a judged bet ready for the judge',
      () => active({ decisionMethod: 'judge', judgeId: 'c' }),
      'c',
    ],
    [
      'an amendment to review',
      () =>
        applyAction(
          active(),
          {
            type: 'propose_amendment',
            terms: 'Ships by the agreed cutoff, per the release log.',
            timing: { kind: 'date', at: due, timezone: 'UTC' },
            note: 'Name the source.',
          },
          'a',
          now,
        ),
      'b',
    ],
    ['an amendment that keeps a judge who stepped down', () => keepsDeclinedJudge(), 'b'],
    [
      'a call-off to review',
      () =>
        applyAction(
          active(),
          { type: 'propose_void', note: 'The release was cancelled.' },
          'a',
          now,
        ),
      'b',
    ],
    ['a result to confirm', () => applyAction(active(), result, 'a', due), 'b'],
    [
      'a delivery to confirm',
      () =>
        applyAction(
          owed(),
          { type: 'propose_settlement', method: 'roll', note: 'Three rolls at lunch.' },
          'b',
          due,
        ),
      'a',
    ],
  ];
  it.each(cases)('for %s', async (_title, build, memberId) => {
    const bet = build();
    expect(needsAction(bet, memberId)).toBe(true);
    const label = primaryActionLabel(bet, memberId, undefined, name).replace(/ · .*$/, '');
    await render(bet, memberId);
    const buttons = visibleButtons();
    if (pairs[label]) for (const button of pairs[label]) expect(buttons).toContain(button);
    else expect(buttons).toContain(label);
  });
  it('offers only a decline for an amendment that keeps a judge who stepped down', async () => {
    const bet = keepsDeclinedJudge();
    expect(primaryActionLabel(bet, 'b', undefined, name)).toBe('Decline proposal');
    await render(bet, 'b');
    expect(dialog().textContent).toContain('Casey stepped down as judge after this was proposed');
    expect(visibleButtons()).not.toContain('Agree to these changes');
    expect(visibleButtons()).toContain('Decline proposal');
  });
  it('gives the prompt proposer a waiting label, not a button they cannot use', async () => {
    const bet = applyAction(
      active({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
    expect(needsAction(bet, 'a')).toBe(false);
    expect(primaryActionLabel(bet, 'a', undefined, name)).toBe(
      'Waiting on Blair to approve the prompt',
    );
    await render(bet, 'a');
    expect(dialog().textContent).toContain('Waiting for Blair to approve prompt v1.');
    expect(visibleButtons()).not.toContain('Approve this prompt');
  });
});
