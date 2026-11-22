// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createBet } from '../lib/ledger';
import type { Bet, BetAction, HistoricalInput, Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';
import { JUDGE_COPY } from './JudgeCopy';
import type { LeaveRequest } from './ui';

// Dates sit in the past relative to the real clock the sheet reads, so "ready" states are ready.
const now = '2026-09-01T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const later = '2099-01-01T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
  { id: 'c', name: 'Casey Hale', initials: 'CH', color: '#2b4a1e' },
  { id: 'd', name: 'Dana Fox', initials: 'DF', color: '#3b1e4a' },
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
const history: HistoricalInput = {
  stage: 'active',
  originalDate: { precision: 'month', value: '2024-02' },
};
const acknowledgements = { terms: true, result: true, delivery: true };
const pending = (overrides: Partial<NewBet> = {}) =>
  createBet({ ...input, ...overrides }, 'a', members, now);
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(pending(overrides), { type: 'accept' }, 'b', now);
const judged = () => active({ decisionMethod: 'judge', judgeId: 'c' });
const proposed = () =>
  applyAction(
    active(),
    { type: 'propose_result', winnerId: 'a', note: 'Shipped on Thursday.' },
    'a',
    due,
  );
const owed = () => applyAction(proposed(), { type: 'confirm_result' }, 'b', due);
const prompt = 'Decide, using the release log, whether the release shipped before the cutoff.';

let root: Root;
let container: HTMLDivElement;
let onAction: ReturnType<typeof vi.fn<(bet: Bet, action: BetAction) => Promise<void>>>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onAction = vi.fn(async () => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
// Keyed by bet id like App, so a newer version of the same bet keeps the sheet's state.
async function render(bet: Bet, memberId: string) {
  await act(async () =>
    root.render(
      createElement(BetDetail, {
        key: bet.id,
        bet,
        members,
        memberId,
        onClose: () => {},
        onAction,
      }),
    ),
  );
}
const dialog = () => document.querySelector('[role="dialog"]')!;
const buttons = () => [...dialog().querySelectorAll('button')];
const labels = () => buttons().map((button) => button.textContent?.trim() ?? '');
const button = (text: string | RegExp) =>
  buttons().find((candidate) => {
    const label = candidate.textContent?.trim() ?? '';
    return typeof text === 'string' ? label === text : text.test(label);
  });
async function click(text: string | RegExp) {
  const target = button(text);
  if (!target) throw new Error(`No button ${text}; saw ${labels().join(' | ')}`);
  await act(async () => target.click());
}
async function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const form = () => dialog().querySelector<HTMLFormElement>('.next-action form')!;
const submitButton = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!;
const reason = () => form().querySelector<HTMLTextAreaElement>('textarea')!;
const steps = () =>
  [...dialog().querySelectorAll('.lifecycle-step small')].map((step) => step.textContent);

describe('exits from a pending proposal', () => {
  it('offers the creator a withdrawal, the opponent agree or decline, and an observer neither', async () => {
    await render(pending(), 'a');
    expect(labels()).toContain('Withdraw proposal');
    expect(labels()).not.toContain('Agree to bet');
    expect(dialog().querySelector('.next-action')?.textContent).toContain(
      'Waiting for Blair to agree. You can withdraw this proposal until they answer.',
    );
    await render(pending(), 'b');
    expect(labels()).toEqual(expect.arrayContaining(['Agree to bet', 'Decline']));
    expect(labels()).not.toContain('Withdraw proposal');
    await render(pending(), 'c');
    expect(labels()).not.toContain('Withdraw proposal');
    expect(labels()).not.toContain('Agree to bet');
    expect(labels()).not.toContain('Decline');
  });
  it('asks for a reason of at least ten characters and states the consequence in a danger-styled form', async () => {
    await render(pending(), 'a');
    await click('Withdraw proposal');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Withdraw this proposal');
    expect(submitButton().classList.contains('button-danger')).toBe(true);
    expect(submitButton().classList.contains('button-primary')).toBe(false);
    expect(reason().minLength).toBe(10);
    expect(form().textContent).toContain('This stays on the ledger with your name and the time.');
    // Cancel comes first so the destructive button is never the default reach.
    const order = [...form().querySelectorAll('.modal-footer button')].map((b) => b.textContent);
    expect(order).toEqual(['Cancel', 'Withdraw proposal']);
    await type(reason(), 'I had the week wrong.');
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), {
      type: 'withdraw',
      note: 'I had the week wrong.',
    });
  });
  it('styles Decline as a danger action with one name and refuses a blank reason before sending', async () => {
    await render(pending(), 'b');
    await click('Decline');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Decline this proposal');
    expect(submitButton().textContent).toBe('Decline proposal');
    expect(submitButton().classList.contains('button-danger')).toBe(true);
    expect(reason().minLength).toBe(10);
    expect(form().textContent).toContain('No rolls are owed');
    await type(reason(), '            ');
    await act(async () => form().requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    // The reason is named under its own field, which is marked invalid.
    expect(reason().getAttribute('aria-invalid')).toBe('true');
    expect(form().querySelector('.field-error')?.textContent).toMatch(/at least 10 characters/);
  });
});

describe('exits from a reported past bet', () => {
  const reportedPast = () =>
    pending({ history, acknowledgements, timing: undefined, deadline: '2024-02-10' });
  it('lets the other bettor decline the record beside asking for a correction', async () => {
    await render(reportedPast(), 'b');
    expect(labels()).toEqual(
      expect.arrayContaining(['Request a correction', 'Decline this record']),
    );
    await click('Decline this record');
    expect(submitButton().classList.contains('button-danger')).toBe(true);
    await type(reason(), 'This bet never happened.');
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(expect.anything(), {
      type: 'decline',
      note: 'This bet never happened.',
    });
  });
  it('lets the proposer withdraw their record but not ask themselves for a correction', async () => {
    await render(reportedPast(), 'a');
    expect(labels().some((label) => /^Withdraw/.test(label))).toBe(true);
    expect(labels()).not.toContain('Request a correction');
    expect(labels()).not.toContain('Decline this record');
  });
});

describe('the named judge', () => {
  it('can step down while the bet is pending or in play, and not after a result', async () => {
    await render(pending({ decisionMethod: 'judge', judgeId: 'c' }), 'c');
    expect(dialog().querySelector('.next-action')?.textContent).toContain('You were named judge');
    expect(labels()).toContain('Step down as judge');
    await render(judged(), 'c');
    expect(labels()).toEqual(
      expect.arrayContaining([JUDGE_COPY.recordAction, 'Step down as judge']),
    );
    await click('Step down as judge');
    // One name for the exit: the button, the form and its submit all say the same thing.
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Step down as judge');
    expect(submitButton().textContent).toBe('Step down as judge');
    expect(submitButton().classList.contains('button-danger')).toBe(true);
    await type(reason(), 'I helped set the forecast.');
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(expect.anything(), {
      type: 'decline_judging',
      note: 'I helped set the forecast.',
    });
    const ruled = applyAction(
      judged(),
      { type: 'adjudicate', winnerId: 'a', note: 'The release log shows Thursday.' },
      'c',
      due,
    );
    await render(ruled, 'c');
    expect(labels()).not.toContain('Step down as judge');
  });
  it('tells the bettors the judge stepped down and opens a change of judge or method', async () => {
    const declined = applyAction(
      judged(),
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
      now,
    );
    await render(declined, 'a');
    const step = dialog().querySelector('.next-action')!;
    expect(step.textContent).toContain('Casey stepped down as judge');
    expect(step.textContent).toContain('I helped set the forecast.');
    expect(step.textContent).not.toContain('Waiting for Casey');
    await click('Choose a new judge or method');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe(
      'Propose changes to the agreement',
    );
    const select = (name: string) =>
      [...form().querySelectorAll('select')].find((field) => field.name === name);
    const method = select('decisionMethod');
    expect(method).toBeDefined();
    const judge = select('judgeId')!;
    expect(judge).toBeDefined();
    const judges = [...judge.options].map((option) => option.value).filter(Boolean);
    // Neither bettor, nor the judge who stepped down, can be named.
    expect(judges).toEqual(['d']);
    await choose(judge, 'd');
    await type(
      form().querySelector<HTMLTextAreaElement>('textarea[name="note"]')!,
      'Dana can judge it instead.',
    );
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'propose_amendment',
        decisionMethod: 'judge',
        judgeId: 'd',
        note: 'Dana can judge it instead.',
      }),
    );
  });
  it('opens the change of judge on the question it is about, ahead of the criteria and timing', async () => {
    const declined = applyAction(
      judged(),
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
      now,
    );
    await render(declined, 'a');
    await click('Choose a new judge or method');
    const nameOf = (element: Element | null) =>
      (element as HTMLSelectElement | HTMLTextAreaElement | null)?.name;
    const names = [...form().querySelectorAll('select, textarea')].map(nameOf);
    // Focus starts at "Who makes the call?", not at the decision criteria.
    expect(nameOf(document.activeElement)).toBe('decisionMethod');
    expect(names.indexOf('decisionMethod')).toBeLessThan(names.indexOf('amendmentTerms'));
    expect(names.indexOf('judgeId')).toBeLessThan(names.indexOf('amendmentTerms'));
    // Proposing other changes keeps the criteria first.
    await act(async () => root.render(null));
    await render(active(), 'a');
    await click('Propose changes');
    expect(nameOf(document.activeElement)).toBe('amendmentTerms');
  });
  it('shows the judge their earlier ruling when a bettor disagrees', async () => {
    let bet = applyAction(
      judged(),
      { type: 'adjudicate', winnerId: 'a', note: 'The release log shows Thursday.' },
      'c',
      due,
    );
    bet = applyAction(bet, { type: 'dispute_result', note: 'Wrong time zone.' }, 'b', due);
    await render(bet, 'c');
    const step = dialog().querySelector('.next-action')!.textContent;
    expect(step).toContain('Blair disagreed with your recommendation');
    expect(step).toContain('Wrong time zone.');
    expect(dialog().querySelector('.closure-block')?.textContent).toContain(
      'The release log shows Thursday.',
    );
  });
  it('speaks to the judge, the bettor who disagreed and the other bettor about the same recommendation', async () => {
    let bet = applyAction(
      judged(),
      { type: 'adjudicate', winnerId: 'a', note: 'The release log shows Thursday.' },
      'c',
      due,
    );
    bet = applyAction(bet, { type: 'dispute_result', note: 'Wrong time zone.' }, 'b', due);
    const closure = () => dialog().querySelector('.closure-block')!;
    // The judge reads their own recommendation as theirs.
    await render(bet, 'c');
    expect(closure().querySelector('h3')?.textContent).toBe(
      'Blair disagreed with your recommendation',
    );
    expect(closure().querySelector('.closure-disputed')?.textContent).toBe(
      'Earlier recommendation · You: Avery Stone wins: The release log shows Thursday.',
    );
    // The bettor who disagreed is "You", whoever the judge was.
    await act(async () => root.render(null));
    await render(bet, 'b');
    expect(closure().querySelector('h3')?.textContent).toBe(
      'You disagreed with Casey’s recommendation',
    );
    expect(closure().querySelector('.closure-disputed')?.textContent).toBe(
      'Earlier recommendation · Casey: Avery Stone wins: The release log shows Thursday.',
    );
    await act(async () => root.render(null));
    await render(bet, 'a');
    expect(closure().querySelector('h3')?.textContent).toBe(
      'Blair disagreed with Casey’s recommendation',
    );
    // What was cleared is quoted for what it said; the instruction it ended with no longer holds.
    expect(closure().textContent).not.toContain('must separately confirm');
    expect(closure().textContent).not.toContain('Recorded the assigned judge');
  });
  it('speaks to the bettor who declined or withdrew in the same way', async () => {
    const declined = applyAction(
      pending(),
      { type: 'decline', note: 'Out of office that week.' },
      'b',
      now,
    );
    await render(declined, 'b');
    expect(dialog().querySelector('.closure-block h3')?.textContent).toBe(
      'You declined this proposal',
    );
  });
});

describe('calling off a bet in play', () => {
  it('shows Call off this bet beside the next step, outside the tools disclosure', async () => {
    await render(active(), 'a');
    const callOff = button('Call off this bet')!;
    expect(callOff).toBeDefined();
    expect(callOff.classList.contains('call-off')).toBe(true);
    expect(callOff.closest('details')).toBeNull();
    const tools = dialog().querySelector('details.workflow-tools');
    expect(tools?.textContent).not.toContain('Propose no winner');
    await click('Call off this bet');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Call off this bet');
    expect(form().textContent).toContain('no rolls are owed');
  });
  it('puts the evidence and check-in tools in the next step while the bet waits on its timing', async () => {
    await render(active({ timing: { kind: 'date', at: later, timezone: 'UTC' } }), 'a');
    const step = dialog().querySelector('.next-action')!;
    const evidence = button('Add readiness evidence')!;
    expect(evidence.closest('details')).toBeNull();
    expect(evidence.classList.contains('button-primary')).toBe(true);
    expect(button('Set my check-in')?.closest('details')).toBeNull();
    expect(step.textContent).not.toMatch(/below/);
    expect(button('Call off this bet')).toBeDefined();
  });
  it('lets whoever added readiness evidence take it back, and no one else', async () => {
    const early = applyAction(
      active({ timing: { kind: 'date', at: later, timezone: 'UTC' } }),
      { type: 'mark_ready', evidence: 'The release notes went out a week early.' },
      'a',
      now,
    );
    await render(early, 'b');
    expect(button('Take back my evidence')).toBeUndefined();
    await act(async () => root.render(null));
    await render(early, 'a');
    expect(button('Take back my evidence')?.closest('details')).toBeNull();
    await click('Take back my evidence');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Take back your evidence');
    expect(submitButton().textContent).toBe('Take back my evidence');
    expect(submitButton().classList.contains('button-danger')).toBe(true);
    // The agreed timing is still ahead, so the bet goes back to waiting on it.
    expect(form().textContent).toContain(
      'No result can be recorded until the agreed timing arrives or someone adds new evidence.',
    );
    await type(reason(), 'Those notes were for the beta.');
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ version: early.version }), {
      type: 'withdraw_proposal',
      note: 'Those notes were for the beta.',
    });
  });
});

describe('closed and disputed records', () => {
  it('shows who declined and why, and ends the stepper at Declined', async () => {
    const bet = applyAction(
      pending(),
      { type: 'decline', note: 'Out of office that week.' },
      'b',
      now,
    );
    await render(bet, 'a');
    const block = dialog().querySelector('.closure-block')!;
    expect(block.textContent).toContain('Blair declined this proposal');
    expect(block.textContent).toContain('Out of office that week.');
    expect(block.textContent).toContain('No rolls are owed');
    expect(steps().at(-1)).toBe('Declined');
    expect(dialog().querySelector('.lifecycle-step:last-child')?.classList).toContain('closed');
    await render(bet, 'c');
    expect(dialog().textContent).not.toContain('Only the bettors');
  });
  it('labels a withdrawal as withdrawn', async () => {
    const bet = applyAction(
      pending(),
      { type: 'withdraw', note: 'I had the week wrong.' },
      'a',
      now,
    );
    await render(bet, 'b');
    expect(dialog().querySelector('.closure-block')?.textContent).toContain(
      'Avery withdrew this proposal',
    );
    expect(steps().at(-1)).toBe('Withdrawn');
  });
  it('ends a called-off bet with nothing owed rather than an unfinished Settled step', async () => {
    let bet = applyAction(
      active(),
      { type: 'propose_void', note: 'The release was cancelled.' },
      'a',
      now,
    );
    bet = applyAction(bet, { type: 'confirm_void' }, 'b', now);
    await render(bet, 'c');
    expect(steps()).toEqual(['Proposed', 'Agreed', 'Called off · nothing owed']);
    expect(steps()).not.toContain('Settled');
    expect(dialog().textContent).not.toContain('Only the bettors');
    // Who called it off and when, beside why.
    const block = dialog().querySelector('.result-block')!;
    expect(block.querySelector('h3')?.textContent).toBe('Called off · no winner');
    expect(block.textContent).toContain('The release was cancelled.');
    expect(block.querySelector('small')?.textContent).toContain(
      'No rolls are owed · Avery proposed it and Blair agreed',
    );
    expect(block.querySelector('small time')?.getAttribute('dateTime')).toBe(now);
  });
  it('says a confirmed no-winner result ended with no winner, not that it was called off', async () => {
    let bet = applyAction(
      active(),
      { type: 'propose_result', winnerId: null, note: 'The release was cancelled outright.' },
      'a',
      due,
    );
    bet = applyAction(bet, { type: 'confirm_result' }, 'b', due);
    await render(bet, 'c');
    expect(steps()).toEqual(['Proposed', 'Agreed', 'No winner · nothing owed']);
    const block = dialog().querySelector('.result-block')!;
    expect(block.querySelector('h3')?.textContent).toBe('No winner');
    expect(block.querySelector('small')?.textContent).toContain(
      'No rolls are owed · both bettors confirmed',
    );
    expect(block.querySelector('small time')?.getAttribute('dateTime')).toBe(due);
  });
  it('labels the header badge by how the bet closed or was disputed', async () => {
    const badge = () => dialog().querySelector('.detail-meta .status-badge')?.textContent;
    await render(
      applyAction(pending(), { type: 'withdraw', note: 'I had the week wrong.' }, 'a', now),
      'b',
    );
    expect(badge()).toBe('Withdrawn');
    await act(async () => root.render(null));
    await render(
      applyAction(pending(), { type: 'decline', note: 'Out of office that week.' }, 'b', now),
      'a',
    );
    expect(badge()).toBe('Declined');
    await act(async () => root.render(null));
    const reported = applyAction(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Three rolls at lunch.' },
      'b',
      due,
    );
    await render(
      applyAction(reported, { type: 'dispute_settlement', note: 'It was a crab roll.' }, 'a', due),
      'b',
    );
    expect(badge()).toBe('Delivery disagreement');
  });
  it('names the people who can act on an open bet for everyone else, after whose move it is', async () => {
    await render(active(), 'c');
    expect(dialog().querySelector('.permission-note')?.textContent).toBe(
      'Waiting for Avery or Blair to propose a result. Only Avery and Blair can act on this bet.',
    );
  });
  it('remembers a disputed result for both bettors and says what disagreeing does', async () => {
    await render(proposed(), 'b');
    await click('Disagree');
    expect(form().textContent).toContain('puts the bet back in play');
    const bet = applyAction(
      proposed(),
      { type: 'dispute_result', note: 'It slipped to Monday.' },
      'b',
      due,
    );
    await render(bet, 'a');
    expect(dialog().querySelector('.next-action')?.textContent).toContain(
      'Blair disagreed with your proposed result',
    );
    expect(dialog().querySelector('.closure-block')?.textContent).toContain(
      'It slipped to Monday.',
    );
    await render(bet, 'b');
    expect(dialog().querySelector('.next-action')?.textContent).toContain(
      'You disagreed with Avery’s proposed result',
    );
  });
  it('remembers a disputed delivery while the rolls are owed again', async () => {
    let bet = applyAction(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Three rolls at lunch.' },
      'b',
      due,
    );
    await render(bet, 'a');
    await click('Disagree');
    expect(form().textContent).toContain('owed until one of you records a delivery');
    bet = applyAction(bet, { type: 'dispute_settlement', note: 'It was a crab roll.' }, 'a', due);
    // Blair opens the sheet afresh.
    await act(async () => root.render(null));
    await render(bet, 'b');
    expect(dialog().querySelector('.next-action')?.textContent).toContain(
      'Avery disagreed with your delivery report',
    );
    const closure = dialog().querySelector('.closure-block')!;
    expect(closure.textContent).toContain('It was a crab roll.');
    // One verb from the button to the record, and nothing "disputed" about it.
    expect(closure.querySelector('h3')?.textContent).toBe(
      'Avery disagreed with the delivery report',
    );
    expect(closure.querySelector('.closure-disputed')?.textContent).toBe(
      'Earlier delivery report · You: Reported delivery of 3 actual lobster rolls: Three rolls at lunch.',
    );
    expect(dialog().textContent).not.toMatch(/dispute/i);
    // The bettor who disagreed reads it as "You".
    await act(async () => root.render(null));
    await render(bet, 'a');
    expect(dialog().querySelector('.closure-block h3')?.textContent).toBe(
      'You disagreed with the delivery report',
    );
  });
  it('lets the proposer take back their own open proposal', async () => {
    const voiding = applyAction(
      active(),
      { type: 'propose_void', note: 'The release was cancelled.' },
      'a',
      now,
    );
    await render(voiding, 'a');
    await click('Take back my call-off');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Take back your call-off');
    expect(submitButton().textContent).toBe('Take back my call-off');
    expect(submitButton().classList.contains('button-danger')).toBe(true);
    await render(proposed(), 'a');
    expect(labels()).toContain('Take back my result');
  });
});

describe('one-click approvals bind to the version that was read', () => {
  const firstPrompt = () =>
    applyAction(
      active({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
  it('sends the reviewed record with the approval', async () => {
    const bet = firstPrompt();
    await render(bet, 'b');
    await click('Approve this prompt');
    expect(onAction).toHaveBeenCalledWith(bet, { type: 'approve_prompt' });
  });
  it('holds an approval until the newer prompt has been read', async () => {
    const v1 = firstPrompt();
    await render(v1, 'b');
    const v2 = applyAction(
      v1,
      { type: 'propose_prompt', text: `${prompt} Use only the public release log.` },
      'a',
      now,
    );
    await render(v2, 'b');
    expect(button('Approve this prompt')?.getAttribute('aria-disabled')).toBe('true');
    const note = dialog().querySelector('.review-note')!;
    expect(note.textContent).toContain('Avery proposed a new prompt');
    // The newer prompt is opened for reading.
    expect(dialog().querySelector<HTMLDetailsElement>('.prompt-record details')?.open).toBe(true);
    await click('I’ve read prompt v2');
    expect(dialog().querySelector('.review-note')).toBeNull();
    expect(button('Approve this prompt')?.hasAttribute('aria-disabled')).toBe(false);
    // The acknowledgement removes itself; focus lands on the approval it just enabled.
    expect(document.activeElement).toBe(button('Approve this prompt'));
    await click('Approve this prompt');
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0].version).toBe(v2.version);
    expect(onAction.mock.calls[0][0].promptAgreement?.version).toBe(2);
  });
  it('moves focus on to the acknowledgement when a change arrives while the approval has it', async () => {
    const v1 = firstPrompt();
    await render(v1, 'b');
    button('Approve this prompt')!.focus();
    const v2 = applyAction(
      v1,
      { type: 'propose_prompt', text: `${prompt} Use only the public release log.` },
      'a',
      now,
    );
    await render(v2, 'b');
    const approve = button('Approve this prompt')!;
    // Held, not disabled: a disabled button would drop its focus to the page.
    expect(approve.disabled).toBe(false);
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    // The next thing to press is the acknowledgement, which comes before the approval.
    expect(document.activeElement).toBe(button('I’ve read prompt v2'));
    // A press on the held approval records nothing.
    await click('Approve this prompt');
    expect(onAction).not.toHaveBeenCalled();
  });
  it('leaves focus where it was when a change arrives while the reader is elsewhere', async () => {
    const v1 = firstPrompt();
    await render(v1, 'b');
    const close = dialog().querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!;
    close.focus();
    await render(
      applyAction(
        v1,
        { type: 'propose_prompt', text: `${prompt} Use only the public release log.` },
        'a',
        now,
      ),
      'b',
    );
    expect(document.activeElement).toBe(close);
  });
  it('does not hold an approval for the reader’s own change', async () => {
    const bet = applyAction(
      active({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: prompt },
      'b',
      now,
    );
    await render(active({ decisionMethod: 'chatgpt' }), 'b');
    await render(bet, 'b');
    expect(dialog().querySelector('.review-note')).toBeNull();
  });
  it('does not hold an approval for someone else’s personal check-in', async () => {
    const v1 = firstPrompt();
    await render(v1, 'b');
    const checkedIn = applyAction(
      v1,
      { type: 'set_check_in', checkIn: { at: '2026-12-01T12:00:00.000Z', timezone: 'UTC' } },
      'a',
      now,
    );
    await render(checkedIn, 'b');
    expect(dialog().querySelector('.review-note')).toBeNull();
    expect(button('Approve this prompt')?.hasAttribute('aria-disabled')).toBe(false);
    await click('Approve this prompt');
    // Sent against the latest version, so the version check accepts it.
    expect(onAction.mock.calls[0][0].version).toBe(checkedIn.version);
  });
});

describe('leaving the sheet from outside it (Back, a typed address)', () => {
  const leaveRef = { current: null as LeaveRequest | null };
  const renderWithLeave = (bet: Bet, memberId: string) =>
    act(async () =>
      root.render(
        createElement(BetDetail, {
          key: bet.id,
          bet,
          members,
          memberId,
          onClose: () => {},
          onAction,
          leaveRef,
        }),
      ),
    );
  it('asks about a typed reason before leaving, as Close does', async () => {
    await renderWithLeave(pending(), 'b');
    await click('Decline');
    await type(reason(), 'Not this quarter.');
    const leave = vi.fn();
    let left = true;
    await act(async () => void (left = leaveRef.current!(leave)));
    expect(left).toBe(false);
    expect(dialog().querySelector('.modal-discard')?.textContent).toContain(
      'Discard what you have entered?',
    );
    await click('Discard');
    expect(leave).toHaveBeenCalledOnce();
  });
  it('is held while a change is recorded, as Close is', async () => {
    let finish = () => {};
    onAction.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await renderWithLeave(pending(), 'b');
    await click('Agree to bet');
    const leave = vi.fn();
    expect(leaveRef.current!(leave)).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    expect(dialog().querySelector('.modal-discard')).toBeNull();
    await act(async () => finish());
    await act(async () => void leaveRef.current!(leave));
    expect(leave).toHaveBeenCalledOnce();
  });
});

describe('a draft overtaken by the other bettor’s own report', () => {
  it('points to a matching result instead of turning the draft into a disagreement', async () => {
    const bet = active();
    await render(bet, 'a');
    await click('Record outcome');
    await choose(form().querySelector('select')!, 'a');
    await type(reason(), 'The league posted the final standings this morning.');
    const theirs = applyAction(
      bet,
      { type: 'propose_result', winnerId: 'a', note: 'Avery won, fair and square.' },
      'b',
      due,
    );
    await render(theirs, 'a');
    expect(form().textContent).toContain('Blair proposed a result while you were writing');
    expect(form().textContent).toContain('Blair’s result names the same winner');
    expect(button(/disagree/i)).toBeUndefined();
    await click('Review Blair’s result');
    expect(dialog().querySelector('.next-action form')).toBeNull();
    expect(button('Confirm result')).toBeDefined();
    // Their result is new to Avery: the approval waits for a read, and focus goes there.
    expect(document.activeElement).toBe(button(/^I’ve read/));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('still turns a different winner into a disagreement that keeps the text', async () => {
    const bet = active();
    await render(bet, 'a');
    await click('Record outcome');
    await choose(form().querySelector('select')!, 'a');
    await type(reason(), 'The league posted the final standings this morning.');
    await render(
      applyAction(
        bet,
        { type: 'propose_result', winnerId: 'b', note: 'Blair won on goal difference.' },
        'b',
        due,
      ),
      'a',
    );
    // The note says what the button is for, not only that the draft no longer fits.
    expect(form().textContent).toContain(
      'Blair’s result names a different winner. Review it, or use your text to disagree with it.',
    );
    expect(form().textContent).not.toContain('no longer applies');
    await click('Use my text to disagree with this result');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Explain the disagreement');
    expect(reason().value).toBe('The league posted the final standings this morning.');
    expect(document.activeElement).toBe(reason());
  });
  it('points to the other bettor’s delivery report rather than disputing it', async () => {
    const bet = owed();
    await render(bet, 'b');
    await click('Record delivery');
    await type(reason(), 'Three rolls at lunch at Row 34.');
    await render(
      applyAction(
        bet,
        { type: 'propose_settlement', method: 'roll', note: 'Got my three rolls.' },
        'a',
        due,
      ),
      'b',
    );
    expect(form().textContent).toContain('Avery reported a delivery while you were writing');
    expect(button(/dispute/i)).toBeUndefined();
    await click('Review Avery’s delivery report');
    expect(button('Confirm delivery')).toBeDefined();
    expect(document.activeElement).toBe(button(/^I’ve read/));
  });
  it('points to the other bettor’s evidence and the way to disagree with it', async () => {
    const bet = active({ timing: { kind: 'date', at: later, timezone: 'UTC' } });
    await render(bet, 'a');
    await click('Add readiness evidence');
    await type(reason(), 'The release notes went out a week early.');
    await render(
      applyAction(bet, { type: 'mark_ready', evidence: 'The beta notes are out.' }, 'b', now),
      'a',
    );
    expect(form().textContent).toContain('Blair added readiness evidence while you were writing');
    expect(form().textContent).toContain(
      'Review Blair’s evidence, and disagree with it if it does not show the answer.',
    );
    expect(form().textContent).not.toContain('no longer applies');
    await click('Review Blair’s evidence');
    expect(dialog().querySelector('.next-action form')).toBeNull();
    expect(button(/^Disagree with/)).toBeDefined();
    expect(document.activeElement).toBe(dialog().querySelector('.next-action h3'));
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('a draft written against an older version', () => {
  const checkIn = { at: '2026-12-01T12:00:00.000Z', timezone: 'UTC' };
  it('rebases onto the latest record without losing the text', async () => {
    const bet = active();
    await render(bet, 'a');
    await click('Record outcome');
    await choose(form().querySelector('select')!, 'a');
    await type(reason(), 'The league posted the final standings this morning.');
    const changed = applyAction(bet, { type: 'set_check_in', checkIn }, 'b', now);
    await render(changed, 'a');
    // Held, but still focusable and described by the note that says why.
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    expect(form().textContent).toContain('Blair changed their check-in while you were writing');
    await click('Use the latest record');
    expect(reason().value).toBe('The league posted the final standings this morning.');
    expect(submitButton().hasAttribute('aria-disabled')).toBe(false);
    // The button removes itself; focus moves to the top of the rebased draft.
    expect(document.activeElement).toBe(form().querySelector('select'));
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ version: changed.version }), {
      type: 'propose_result',
      winnerId: 'a',
      note: 'The league posted the final standings this morning.',
    });
  });
  it('keeps edited amendment terms when rebasing', async () => {
    const bet = active();
    await render(bet, 'a');
    await click('Propose changes');
    const terms = form().querySelector<HTMLTextAreaElement>('textarea[name="amendmentTerms"]')!;
    await type(terms, 'Ships by the agreed cutoff, per the public release log.');
    await render(applyAction(bet, { type: 'set_check_in', checkIn }, 'b', now), 'a');
    await click('Use the latest record');
    expect(
      form().querySelector<HTMLTextAreaElement>('textarea[name="amendmentTerms"]')!.value,
    ).toBe('Ships by the agreed cutoff, per the public release log.');
  });
  it('carries the text into the replacement action when the old one no longer applies', async () => {
    const bet = pending();
    await render(bet, 'a');
    await click('Withdraw proposal');
    await type(reason(), 'I had the reopening week wrong.');
    await render(applyAction(bet, { type: 'accept' }, 'b', now), 'a');
    expect(form().textContent).toContain('Blair agreed to the bet while you were writing');
    expect(button('Use the latest record')).toBeUndefined();
    expect(form().textContent).toContain(
      'The bet is now agreed, so it can no longer be withdrawn. Use your text to ask Blair to call it off instead.',
    );
    expect(form().textContent).not.toContain('no longer applies');
    await click('Use my text to call off the bet');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe('Call off this bet');
    expect(reason().value).toBe('I had the reopening week wrong.');
    expect(submitButton().hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(reason());
  });
});

describe('a rebased draft never carries attestations', () => {
  const owedHistory: HistoricalInput = {
    stage: 'owed',
    originalDate: { precision: 'month', value: '2024-02' },
    result: {
      winnerId: 'a',
      date: { precision: 'month', value: '2024-03' },
      note: 'Avery won on the league table.',
    },
  };
  const reported = () =>
    pending({
      history: owedHistory,
      acknowledgements: { terms: true, result: true, delivery: false },
      timing: undefined,
      deadline: '2024-02-10',
    });
  // Avery changes the stake while Blair is reading the record.
  const restaked = (bet: Bet) =>
    applyAction(
      bet,
      {
        type: 'revise_history',
        revision: {
          title: bet.title,
          terms: bet.terms,
          category: bet.category,
          creatorSide: bet.creatorSide,
          opponentSide: bet.opponentSide,
          stake: 4,
          deadline: '2024-02-10',
          history: owedHistory,
        },
        acknowledgements: { terms: true, result: true, delivery: false },
      },
      'a',
      now,
    );
  const boxes = () => [
    ...form().querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][name^="acknowledgements."]',
    ),
  ];
  async function tickAll() {
    for (const box of boxes()) await act(async () => box.click());
    expect(boxes().every((box) => box.checked)).toBe(true);
  }
  it('unticks a history confirmation when the record it was ticked against is revised', async () => {
    const bet = reported();
    await render(bet, 'b');
    await click('Review and confirm history');
    await tickAll();
    const revised = restaked(bet);
    await render(revised, 'b');
    expect(form().textContent).toContain('Avery revised the history while you were writing');
    // The note says up front that the ticks will not carry over.
    expect(form().textContent).toContain(
      'Your ticks were for the earlier version, so the boxes clear when you use the latest record.',
    );
    expect(form().textContent).not.toContain('Your draft is kept below');
    await click('Use the latest record');
    expect(boxes().length).toBeGreaterThan(0);
    expect(boxes().map((box) => box.checked)).toEqual(boxes().map(() => false));
    expect(document.activeElement).toBe(boxes()[0]);
    // The required boxes stop a confirmation of the revised record until they are ticked again.
    await act(async () => form().requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    await tickAll();
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ version: revised.version, stake: 4 }),
      expect.objectContaining({ type: 'confirm_history' }),
    );
  });
  it('keeps a revision’s text but unticks its confirmations', async () => {
    const bet = reported();
    await render(bet, 'b');
    await click('Revise history');
    const title = () => form().querySelector<HTMLTextAreaElement>('textarea[name="title"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(title(), 'Friday release, as remembered');
      title().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tickAll();
    await render(restaked(bet), 'b');
    expect(form().textContent).toContain(
      'Your edits are kept below; the confirmation boxes clear when you use the latest record.',
    );
    await click('Use the latest record');
    expect(title().value).toBe('Friday release, as remembered');
    expect(boxes().every((box) => !box.checked)).toBe(true);
  });
});

describe('a change refused because the record moved on', () => {
  const checkIn = { at: '2026-12-01T12:00:00.000Z', timezone: 'UTC' };
  const refusal = new Error(
    'This bet changed since you opened it. Review the refreshed record and try again.',
  );
  const note = () => dialog().querySelector<HTMLElement>('.conflict-note');
  it('names the latest event in a focused note instead of a red error', async () => {
    const bet = pending();
    await render(bet, 'b');
    onAction.mockRejectedValueOnce(refusal);
    await click('Agree to bet');
    // The ledger refreshes to what Avery recorded in another window.
    const withdrawn = applyAction(
      bet,
      { type: 'withdraw', note: 'I had the date wrong.' },
      'a',
      now,
    );
    await render(withdrawn, 'b');
    expect(note()?.textContent).toContain('Avery withdrew the proposal');
    expect(note()?.textContent).toContain('your change was not recorded');
    expect(note()?.getAttribute('role')).toBe('alert');
    // The bet is closed, so there is no next step to hold the note; it still shows and has focus.
    expect(dialog().querySelector('.next-action')).toBeNull();
    expect(document.activeElement).toBe(note());
    expect(dialog().querySelector('.form-error')).toBeNull();
    expect(dialog().textContent).not.toContain('Review the refreshed record');
  });
  it('says so when the same member already did the same thing elsewhere', async () => {
    const bet = pending();
    await render(bet, 'b');
    onAction.mockRejectedValueOnce(refusal);
    await click('Agree to bet');
    await render(applyAction(bet, { type: 'accept' }, 'b', now), 'b');
    expect(note()?.textContent).toContain('You already agreed to the bet');
    expect(note()?.textContent).toContain('nothing more is needed');
    expect(note()?.textContent).not.toMatch(/try again|trying again/);
    expect(document.activeElement).toBe(note());
  });
  it('leaves a stale draft to its own note, which takes the focus', async () => {
    const bet = active();
    await render(bet, 'a');
    await click('Record outcome');
    await choose(form().querySelector('select')!, 'a');
    await type(reason(), 'The league posted the final standings this morning.');
    onAction.mockRejectedValueOnce(refusal);
    await act(async () => form().requestSubmit());
    await render(applyAction(bet, { type: 'set_check_in', checkIn }, 'b', now), 'a');
    expect(note()).toBeNull();
    expect(dialog().querySelector('.form-error')).toBeNull();
    expect(document.activeElement).toBe(dialog().querySelector('.stale-note'));
    expect(reason().value).toBe('The league posted the final standings this morning.');
  });
  it('keeps the plain error for a refusal that is not about a newer record', async () => {
    await render(pending(), 'b');
    onAction.mockRejectedValueOnce(new Error('Only the other bettor can do that.'));
    await click('Agree to bet');
    expect(dialog().querySelector('.form-error')?.textContent).toBe(
      'Only the other bettor can do that.',
    );
    expect(note()).toBeNull();
  });
  it('clears the note once the member moves on', async () => {
    const bet = applyAction(active(), { type: 'set_check_in', checkIn }, 'a', now);
    await render(bet, 'a');
    onAction.mockRejectedValueOnce(refusal);
    await click('Remove my check-in');
    await render(applyAction(bet, { type: 'set_check_in', checkIn }, 'b', now), 'a');
    expect(note()?.textContent).toContain('Blair changed their check-in');
    expect(note()?.textContent).toContain('try again');
    await click('Call off this bet');
    expect(note()).toBeNull();
  });
});

describe('a member outside the bet', () => {
  const note = () => dialog().querySelector('.permission-note');
  it('reads whose move it is first, then who can act', async () => {
    await render(pending(), 'd');
    expect(note()?.querySelector('strong')?.textContent).toBe('Waiting for Blair to agree.');
    expect(note()?.textContent).toBe(
      'Waiting for Blair to agree. Only Avery and Blair can act on this bet.',
    );
  });
  it('names the judge once while the recommendation is still to come, and only then', async () => {
    await render(judged(), 'd');
    // The waiting line already says the judge records it, so the sentence after it does not repeat that.
    expect(note()?.textContent).toBe(
      'Waiting for Casey to record a recommendation. Only Avery and Blair can act on this bet.',
    );
    const recorded = applyAction(
      judged(),
      { type: 'adjudicate', winnerId: 'a', note: 'The release log shows Thursday.' },
      'c',
      due,
    );
    await render(recorded, 'd');
    expect(note()?.textContent).toBe(
      'Waiting for Avery and Blair to confirm the result. Only Avery and Blair can act on this bet.',
    );
    const stepped = applyAction(
      judged(),
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
      now,
    );
    await render(stepped, 'd');
    expect(note()?.textContent).toBe(
      'Casey stepped down as judge. Waiting for Avery and Blair to choose a new judge or another way to decide. Only Avery and Blair can act on this bet.',
    );
  });
});

describe('a member outside a judged bet that is not yet ready for the judge', () => {
  const note = () => dialog().querySelector('.permission-note');
  it('still says what the judge does when the line before it names someone else', async () => {
    await render(pending({ decisionMethod: 'judge', judgeId: 'c' }), 'd');
    expect(note()?.textContent).toBe(
      'Waiting for Blair to agree. Only Avery and Blair can act on this bet; Casey records the judge’s recommendation.',
    );
  });
});

describe('the method card once the judge steps down', () => {
  const stepped = () =>
    applyAction(
      judged(),
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
      now,
    );
  const card = () => dialog().querySelector('.adjudication-method')!;
  it('tells the judge they stepped down, not that they record a recommendation', async () => {
    await render(stepped(), 'c');
    expect(card().querySelector('strong')?.textContent).toBe(JUDGE_COPY.steppedDownSelf);
    expect(card().textContent).not.toContain(JUDGE_COPY.methodHintForJudge);
    expect(card().textContent).toContain(
      'Avery and Blair choose a new judge or another way to decide.',
    );
  });
  it('tells each bettor and everyone else that no judge is set', async () => {
    await render(stepped(), 'a');
    expect(card().querySelector('strong')?.textContent).toBe('Judge stepped down: Casey Hale');
    expect(card().textContent).toContain(
      'No judge is set. You and Blair choose a new judge or another way to decide.',
    );
    expect(card().textContent).not.toContain(JUDGE_COPY.newBetHint);
    await render(stepped(), 'd');
    expect(card().textContent).toContain(
      'No judge is set. Avery and Blair choose a new judge or another way to decide.',
    );
  });
  // A closed bet takes no new judge: the card says what happened, not what to do next.
  const voided = () =>
    applyAction(
      applyAction(stepped(), { type: 'propose_void', note: 'No judge, so we drop it.' }, 'a', now),
      { type: 'confirm_void' },
      'b',
      now,
    );
  const declined = () =>
    applyAction(
      applyAction(
        pending({ decisionMethod: 'judge', judgeId: 'c' }),
        { type: 'decline_judging', note: 'Too close to both of you.' },
        'c',
        now,
      ),
      { type: 'decline', note: 'Not without a judge.' },
      'b',
      now,
    );
  it.each([
    ['called off', voided],
    ['declined', declined],
  ])('tells everyone on a %s bet only that the judge stepped down', async (_, closedBet) => {
    for (const viewer of ['a', 'b', 'd']) {
      await render(closedBet(), viewer);
      expect(card().querySelector('strong')?.textContent).toBe('Judge stepped down: Casey Hale');
      expect(card().textContent).toContain(
        'Casey stepped down before a recommendation was recorded.',
      );
      expect(card().textContent).not.toContain('choose a new judge');
      expect(card().textContent).not.toContain('No judge is set');
      await act(async () => root.render(null));
    }
    await render(closedBet(), 'c');
    expect(card().querySelector('strong')?.textContent).toBe(JUDGE_COPY.steppedDownSelf);
    expect(card().textContent).toContain('You stepped down before a recommendation was recorded.');
    expect(card().textContent).not.toContain('choose a new judge');
  });
});

describe('readiness evidence from the other bettor', () => {
  const early = () =>
    applyAction(
      active({ timing: { kind: 'date', at: later, timezone: 'UTC' } }),
      { type: 'mark_ready', evidence: 'The release notes went out a week early.' },
      'a',
      now,
    );
  it('cannot be replaced, only disagreed with', async () => {
    await render(early(), 'b');
    expect(labels()).not.toContain('Add readiness evidence');
    // The button names whose evidence it answers, and the form quotes it above the reason.
    const disagree = button('Disagree with Avery’s evidence')!;
    expect(disagree).toBeDefined();
    expect(disagree.closest('details')).toBeNull();
    await click('Disagree with Avery’s evidence');
    expect(dialog().querySelector('.next-action h3')?.textContent).toBe(
      'Disagree with the evidence',
    );
    const quote = form().querySelector('.evidence-quote')!;
    expect(quote.textContent).toBe('Avery’s evidence: “The release notes went out a week early.”');
    expect(quote.compareDocumentPosition(reason()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(submitButton().textContent).toBe('Record disagreement');
    expect(form().textContent).toContain(
      'The evidence comes off the bet. No result can be recorded until the agreed timing arrives or someone adds new evidence.',
    );
    await type(reason(), 'Those notes were for the beta.');
    await act(async () => form().requestSubmit());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ version: early().version }), {
      type: 'dispute_readiness',
      note: 'Those notes were for the beta.',
    });
  });
  it('tells both bettors about the disagreement once the evidence is off the bet', async () => {
    const disputed = applyAction(
      early(),
      { type: 'dispute_readiness', note: 'Those notes were for the beta.' },
      'b',
      now,
    );
    await render(disputed, 'a');
    expect(dialog().querySelector('.next-action')?.textContent).toContain(
      'Blair disagreed with your evidence: “Those notes were for the beta.”',
    );
    await act(async () => root.render(null));
    await render(disputed, 'b');
    expect(dialog().querySelector('.next-action')?.textContent).toContain(
      'You disagreed with Avery’s evidence.',
    );
    // New evidence is the latest word again.
    await act(async () => root.render(null));
    await render(
      applyAction(disputed, { type: 'mark_ready', evidence: 'The final notes are out.' }, 'a', now),
      'b',
    );
    expect(dialog().querySelector('.next-action')?.textContent).not.toContain('disagreed');
  });
  it('stays the author’s to update or take back', async () => {
    await render(early(), 'a');
    expect(button(/^Disagree with/)).toBeUndefined();
    expect(labels()).toContain('Take back my evidence');
    expect(labels()).toContain('Add readiness evidence');
  });
});

describe('the delivery handshake, worded for whoever reads it', () => {
  const winnerReported = () =>
    applyAction(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Got all three at lunch.' },
      'a',
      due,
    );
  it('says what a report settles to the winner and to the loser', async () => {
    await render(owed(), 'a');
    await click('Record delivery');
    expect(form().textContent).toContain('This report settles all 3 rolls Blair still owes you.');
    expect(form().textContent).toContain('Blair confirms this report before the debt is settled.');
    expect(form().textContent).not.toContain('Avery');
    await act(async () => root.render(null));
    await render(owed(), 'b');
    await click('Record delivery');
    expect(form().textContent).toContain('This report settles all 3 rolls you still owe Avery.');
  });
  it('says either of you can record the delivery again after disagreeing', async () => {
    await render(winnerReported(), 'b');
    await click('Disagree');
    const text = form().textContent ?? '';
    expect(text).toContain(
      'Disagreeing keeps 3 lobster rolls owed until one of you records a delivery and the other confirms it.',
    );
    expect(text).not.toContain('Blair records');
  });
});
