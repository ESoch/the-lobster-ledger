// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, applyDebtOffset, createBet, previewDebtOffset } from '../lib/ledger';
import type { Bet, BetAction, Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';
import { JUDGE_COPY } from './JudgeCopy';
import { NO_EVIDENCE_YET } from '../lib/adjudication';

// Dates sit in the past relative to the real clock the sheet reads, so "ready" states are ready.
const now = '2026-09-01T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const later = '2026-09-14T12:00:00.000Z';
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
const step = (bet: Bet, action: BetAction, actorId: string, at = due) =>
  applyAction(bet, action, actorId, at);
const result: BetAction = { type: 'propose_result', winnerId: 'a', note: 'Shipped on Thursday.' };
const owed = () => step(step(active(), result, 'a'), { type: 'confirm_result' }, 'b');
const prompt =
  'Act as a neutral reviewer of this friendly lobster-roll bet. Decide from the release log whether it shipped.';
const chatgptAgreed = (overrides: Partial<NewBet> = {}) =>
  step(
    step(
      active({ decisionMethod: 'chatgpt', ...overrides }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    ),
    { type: 'approve_prompt' },
    'b',
    now,
  );

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
  return document.querySelector('[role="dialog"]')!;
}
/** The text assistive technology reads: aria-hidden decoration (icons, initials) left out. */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
  return copy.textContent ?? '';
}
const nextStep = (dialog: Element) => dialog.querySelector('.next-action')!.textContent ?? '';
const button = (dialog: Element, label: string) =>
  [...dialog.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
async function click(target: HTMLElement | undefined) {
  expect(target).toBeDefined();
  await act(async () => target!.click());
}

describe('waiting lines name who still has to act', () => {
  it('tells the proposer and the judge whom a pending bet is waiting for', async () => {
    const bet = pending({ decisionMethod: 'judge', judgeId: 'c' });
    expect(nextStep(await render(bet, 'a'))).toContain('Waiting for Blair to agree.');
    const judge = nextStep(await render(bet, 'c'));
    expect(judge).toContain('Waiting for Blair to agree to these terms');
    expect(judge).not.toContain('both bettors');
  });
  it('addresses an amendment wait to the proposer and to the judge correctly', async () => {
    const proposed = step(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      {
        type: 'propose_amendment',
        terms: 'Ships by the agreed cutoff, per the release log.',
        timing: { kind: 'date', at: due, timezone: 'UTC' },
        note: 'Name the source.',
      },
      'a',
      now,
    );
    expect(nextStep(await render(proposed, 'a'))).toContain(
      'Waiting for Blair to review your proposal above.',
    );
    const judge = nextStep(await render(proposed, 'c'));
    expect(judge).toContain('Waiting for Blair to review Avery’s proposal above.');
    expect(judge).not.toContain('the other bettor');
  });
  it('words a not-ready bet as one sentence, without a doubled stop', async () => {
    const bet = active({
      timing: { kind: 'event', description: 'The release log is published…' },
    });
    const text = nextStep(await render(bet, 'a'));
    expect(text).toContain('Not ready for review yet. Waiting for the agreed event.');
    expect(text).not.toMatch(/…\.|\.\./);
  });
  it('gives the judge one vocabulary: a recommendation', async () => {
    const judged = active({ decisionMethod: 'judge', judgeId: 'c' });
    const dialog = await render(judged, 'c');
    expect(button(dialog, JUDGE_COPY.recordAction)).toBeDefined();
    expect(nextStep(dialog)).not.toMatch(/decision|ruling|adjudicate/i);
    expect(nextStep(await render(judged, 'a'))).toContain(JUDGE_COPY.waiting('Casey'));
    const recorded = step(
      judged,
      { type: 'adjudicate', winnerId: 'b', note: 'Release slipped.' },
      'c',
    );
    const sheet = await render(recorded, 'c');
    expect(sheet.querySelector('.adjudication-record h3')?.textContent).toBe(
      JUDGE_COPY.recordHeading,
    );
    expect(nextStep(sheet)).toContain(JUDGE_COPY.awaitingConfirmation('Avery and Blair'));
    const half = step(recorded, { type: 'confirm_result' }, 'a');
    expect(nextStep(await render(half, 'c'))).toContain(JUDGE_COPY.awaitingConfirmation('Blair'));
  });
});

describe('result and delivery blocks say who did what and when', () => {
  it('shows a proposed result as pending, with the proposer and both signatures', async () => {
    const dialog = await render(step(active(), result, 'a'), 'b');
    const block = dialog.querySelector('.result-block')!;
    expect(block.classList.contains('result-pending')).toBe(true);
    expect(block.querySelector('h3')?.textContent).toBe('Proposed result: Avery wins');
    expect(block.textContent).toContain('Proposed by Avery Stone');
    const signatures = [...block.querySelectorAll('.result-signatures li')].map(
      (row) => row.textContent,
    );
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toMatch(/^Avery Stone — Proposed /);
    expect(signatures[1]).toBe('Blair Reed — Waiting to confirm');
    expect(block.textContent).toContain(
      'Once both bettors confirm, Blair owes Avery 3 lobster rolls.',
    );
  });
  it('reads a no-winner proposal as calling the bet off', async () => {
    const dialog = await render(
      step(active(), { type: 'propose_result', winnerId: null, note: 'Release cancelled.' }, 'a'),
      'b',
    );
    expect(dialog.querySelector('.result-block h3')?.textContent).toBe(
      'Avery proposes calling the bet off',
    );
    expect(nextStep(dialog)).toContain('the bet is called off and no rolls are owed');
  });
  it('marks a confirmed result as done with both confirmations', async () => {
    const dialog = await render(owed(), 'a');
    const block = dialog.querySelector('.result-block')!;
    expect(block.classList.contains('result-pending')).toBe(false);
    expect(block.querySelector('h3')?.textContent).toContain('Avery won');
    expect(block.textContent).toMatch(/Blair Reed — Confirmed /);
  });
  it('states the rolls, the reporter and the signatures on a reported delivery', async () => {
    const settling = step(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Lunch at the pier.' },
      'b',
      later,
    );
    const dialog = await render(settling, 'a');
    const block = dialog.querySelector('.settlement-block')!;
    expect(block.classList.contains('result-pending')).toBe(true);
    expect(block.textContent).toContain('3 lobster rolls · reported by Blair Reed');
    const signatures = [...block.querySelectorAll('.result-signatures li')].map(
      (row) => row.textContent,
    );
    expect(signatures[0]).toBe('Avery Stone — Waiting to confirm');
    expect(signatures[1]).toMatch(/^Blair Reed — Reported /);
    expect(block.querySelector('.result-meta')?.textContent).toMatch(/^Settles 3 lobster rolls/);
    const settled = step(settling, { type: 'confirm_settlement' }, 'a', later);
    const done = (await render(settled, 'a')).querySelector('.settlement-block')!;
    expect(done.querySelector('h3')?.textContent).toBe('Lobster rolls delivered');
    expect(done.querySelector('.result-meta')?.textContent).toMatch(
      /^Settled 3 lobster rolls · reported by Blair Reed/,
    );
  });
});

describe('a reported past bet that carries on in the app', () => {
  const unknown = { precision: 'unknown' } as const;
  const reported = (history: NonNullable<NewBet['history']>, acks: [boolean, boolean]) => {
    const acknowledgements = { terms: true, result: acks[0], delivery: acks[1] };
    return step(
      pending({ history, acknowledgements }),
      { type: 'confirm_history', acknowledgements },
      'b',
      now,
    );
  };
  const signatures = (block: Element) =>
    [...block.querySelectorAll('.result-signatures li')].map((row) => row.textContent);

  it('signs a result proposed after the history from its own events, not the history', async () => {
    const inPlay = reported({ stage: 'active', originalDate: unknown }, [false, false]);
    const proposed = step(inPlay, result, 'a', later);
    const block = (await render(proposed, 'b')).querySelector('.result-block')!;
    expect(block.classList.contains('result-pending')).toBe(true);
    expect(block.querySelector('.result-meta')?.textContent).toMatch(/^Proposed by Avery Stone · /);
    expect(signatures(block)[0]).toMatch(/^Avery Stone — Proposed /);
    expect(signatures(block)[1]).toBe('Blair Reed — Waiting to confirm');
  });

  it('signs a delivery reported after the history from its own events, not the history', async () => {
    const owedBefore = reported(
      {
        stage: 'owed',
        originalDate: unknown,
        result: { winnerId: 'a', date: unknown, note: 'Shipped before the import.' },
      },
      [true, false],
    );
    const settling = step(
      owedBefore,
      { type: 'propose_settlement', method: 'roll', note: 'Lunch at the pier.' },
      'b',
      later,
    );
    const dialog = await render(settling, 'a');
    // The result itself did come from the confirmed history.
    const resultBlock = dialog.querySelector('.result-block:not(.settlement-block)')!;
    expect(resultBlock.querySelector('.result-meta')?.textContent).toBe('Reported by Avery Stone');
    expect(signatures(resultBlock)).toEqual([
      expect.stringMatching(/^Avery Stone — Confirmed /),
      expect.stringMatching(/^Blair Reed — Confirmed /),
    ]);
    const delivery = dialog.querySelector('.settlement-block')!;
    expect(delivery.querySelector('.result-meta')?.textContent).toMatch(
      /reported by Blair Reed · /,
    );
    expect(signatures(delivery)[0]).toBe('Avery Stone — Waiting to confirm');
    expect(signatures(delivery)[1]).toMatch(/^Blair Reed — Reported /);
  });
});

describe('owed and delivery steps speak to the person reading', () => {
  it('tells the bettor confirming a result their own side of what it settles', async () => {
    const loserReads = nextStep(await render(step(active(), result, 'a'), 'b'));
    expect(loserReads).toContain('Once confirmed, you owe Avery 3 lobster rolls.');
    const judged = step(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'adjudicate', winnerId: 'a', note: 'Shipped.' },
      'c',
    );
    expect(nextStep(await render(judged, 'a'))).toContain(
      'Once confirmed, Blair owes you 3 lobster rolls.',
    );
  });
  it('tells the debtor and the winner their own side of the debt', async () => {
    expect(nextStep(await render(owed(), 'b'))).toContain('You owe Avery 3 lobster rolls.');
    expect(nextStep(await render(owed(), 'a'))).toContain('Blair owes you 3 lobster rolls.');
  });
  it('tells the judge exactly who still has to confirm a delivery', async () => {
    const judged = active({ decisionMethod: 'judge', judgeId: 'c' });
    const confirmed = step(
      step(
        step(judged, { type: 'adjudicate', winnerId: 'a', note: 'Shipped.' }, 'c'),
        { type: 'confirm_result' },
        'a',
      ),
      { type: 'confirm_result' },
      'b',
    );
    expect(nextStep(await render(confirmed, 'c'))).toContain(
      `${JUDGE_COPY.confirmed} Blair owes Avery 3 lobster rolls.`,
    );
    const settling = step(
      confirmed,
      { type: 'propose_settlement', method: 'roll', note: 'Lunch at the pier.' },
      'b',
    );
    const text = nextStep(await render(settling, 'c'));
    expect(text).toContain('Waiting for Avery to confirm the delivery Blair reported.');
    expect(text).not.toContain('both bettors');
    expect(nextStep(await render(settling, 'a'))).toContain(
      'Blair reported delivering 3 lobster rolls to you.',
    );
  });
  it('explains the second handshake on the delivery form', async () => {
    const dialog = await render(owed(), 'b');
    await click(button(dialog, 'Record delivery'));
    const form = dialog.querySelector('form')!;
    expect(form.textContent).toContain('Avery confirms this report before the debt is settled.');
    expect(form.querySelector('button[type="submit"]')?.textContent).toBe('Record delivery');
  });
  it('says what disagreeing with a delivery report does', async () => {
    const settling = step(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Lunch at the pier.' },
      'b',
      later,
    );
    const dialog = await render(settling, 'a');
    await click(button(dialog, 'Disagree'));
    expect(dialog.querySelector('form')?.textContent).toContain(
      'Disagreeing keeps 3 lobster rolls owed until one of you records a delivery and the other confirms it.',
    );
  });
  it('says at the top of the sheet when the next move is yours', async () => {
    const settling = step(
      owed(),
      { type: 'propose_settlement', method: 'roll', note: 'Lunch at the pier.' },
      'b',
      later,
    );
    const dialog = await render(settling, 'a');
    const move = dialog.querySelector<HTMLAnchorElement>('.your-move')!;
    expect(move.textContent).toBe('Your move: Confirm a delivery');
    expect(
      move.compareDocumentPosition(dialog.querySelector('.detail-positions')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await click(move);
    expect(document.activeElement?.textContent).toBe('The next step');
    // The reporter is waiting on the winner, so the move is not theirs.
    expect((await render(settling, 'b')).querySelector('.your-move')).toBeNull();
  });
  it('puts no move bar over owed rolls for either bettor (owner decision 4)', async () => {
    expect((await render(owed(), 'b')).querySelector('.your-move')).toBeNull();
    expect((await render(owed(), 'a')).querySelector('.your-move')).toBeNull();
  });
});

describe('the sheet header', () => {
  it('shows the year on a legacy decision date', async () => {
    const dialog = await render(active({ timing: undefined, deadline: '2026-09-13' }), 'a');
    expect(dialog.querySelector('.detail-facts')?.textContent).toContain('Sep 13, 2026 UTC');
  });
  it('states the stepper and approval marks in words, and hides avatar initials', async () => {
    const dialog = await render(step(active(), result, 'a'), 'a');
    const steps = [...dialog.querySelectorAll('.lifecycle-step')].map(spoken);
    expect(steps).toEqual([
      'Proposed (done)',
      'Agreed (done)',
      'Decided (current step)',
      'Settled (not yet)',
    ]);
    expect(dialog.querySelector('.lifecycle-step[aria-current="step"]')?.textContent).toContain(
      'Decided',
    );
    expect(dialog.querySelector('.position-card .avatar')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
  it('names no current step on a closed bet', async () => {
    const declined = step(pending(), { type: 'decline', note: 'Not this week.' }, 'b', now);
    const voided = step(
      step(active(), { type: 'propose_void', note: 'The release was cancelled.' }, 'a', now),
      { type: 'confirm_void' },
      'b',
      now,
    );
    expect(declined.status).toBe('declined');
    expect(voided.status).toBe('voided');
    const stepsOf = async (bet: Bet) => {
      const dialog = await render(bet, 'a');
      expect(dialog.querySelector('.lifecycle-step[aria-current]')).toBeNull();
      return [...dialog.querySelectorAll('.lifecycle-step')].map(spoken);
    };
    // The stepper ends on the step that closed the bet, and says so in words.
    expect(await stepsOf(declined)).toEqual(['Proposed (done)', 'Declined (closed)']);
    expect(await stepsOf(voided)).toEqual([
      'Proposed (done)',
      'Agreed (done)',
      'Called off · nothing owed (closed)',
    ]);
  });
  it('marks who has agreed to the terms only while the terms are being agreed', async () => {
    const waiting = await render(pending(), 'b');
    const cards = [...waiting.querySelectorAll('.position-card')];
    expect(cards[0].textContent).toContain('Agreed to the terms');
    expect(cards[1].textContent).not.toContain('Agreed to the terms');
    // Once both have agreed the marks would stay lit through the result and delivery handshakes.
    for (const later of [active(), step(active(), result, 'a'), owed()])
      expect((await render(later, 'a')).querySelector('.position-agreed')).toBeNull();
  });
  it('says the location link leaves the app and shows a pin as a pin', async () => {
    const place = {
      id: 'p',
      name: 'Neptune Oyster',
      address: '63 Salem St, Boston',
      lat: 42.3637,
      lng: -71.0555,
    };
    const named = (await render(active({ location: place }), 'a')).querySelector<HTMLAnchorElement>(
      'a.detail-location',
    )!;
    expect(named.target).toBe('_blank');
    expect(spoken(named)).toContain('Opens OpenStreetMap in a new tab');
    expect(named.querySelector('.lucide-external-link')).not.toBeNull();
    expect(named.querySelector('.lucide-arrow-right')).toBeNull();
    expect(named.textContent).toContain('63 Salem St, Boston');
    const pin = (
      await render(
        active({ location: { ...place, name: 'Row 34 patio', address: 'Pinned location' } }),
        'a',
      )
    ).querySelector('a.detail-location')!;
    expect(pin.textContent).toContain('Row 34 patio');
    expect(pin.textContent).not.toContain('Pinned location');
    expect(pin.textContent).toContain('Pinned on the map · 42.3637, -71.0555');
  });
});

describe('ChatGPT prompt and response', () => {
  it('shows the whole prompt while it awaits approval, with approvals in words', async () => {
    const proposed = step(
      active({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
    const dialog = await render(proposed, 'b');
    const pre = dialog.querySelector('.prompt-record pre')!;
    expect(pre.classList.contains('prompt-text-capped')).toBe(false);
    expect(pre.closest('details')?.open ?? true).toBe(true);
    const approvals = [...dialog.querySelectorAll('.prompt-signatures li')].map(spoken);
    expect(approvals[0]).toMatch(/^Avery Stone — Approved/);
    expect(approvals[1]).toBe('Blair Reed — Waiting');
  });
  it('says a prompt on a bet nobody has agreed to yet is approved after the bet is', async () => {
    // Waiting, but the only step is to agree to the bet: the record says why the prompt cannot be
    // approved yet, to whoever reads it.
    const proposed = step(
      pending({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
    const line = (dialog: Element) =>
      dialog.querySelector('.prompt-record > .prompt-superseded')?.textContent;
    expect(line(await render(proposed, 'b'))).toBe(
      'You approve this exact prompt after you agree to the bet.',
    );
    expect(line(await render(proposed, 'a'))).toBe(
      'Blair approves this exact prompt after agreeing to the bet.',
    );
    expect(line(await render(proposed, 'c'))).toBe(
      'Both bettors approve this exact prompt once the bet is agreed.',
    );
    // Once the bet is on, the approval button is the step and the line is gone.
    const agreed = step(proposed, { type: 'accept' }, 'b', now);
    expect(line(await render(agreed, 'b'))).toBeUndefined();
  });
  it('sets the approvers’ initials at the 12px floor', async () => {
    const dialog = await render(chatgptAgreed(), 'a');
    const avatars = [...dialog.querySelectorAll<HTMLElement>('.prompt-signatures .avatar')];
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars)
      expect(Number.parseFloat(avatar.style.fontSize)).toBeGreaterThanOrEqual(12);
  });
  it('keeps an agreed prompt in a named, focusable region', async () => {
    const dialog = await render(chatgptAgreed(), 'a');
    const pre = dialog.querySelector('.prompt-record pre')!;
    expect(pre.classList.contains('prompt-text-capped')).toBe(true);
    expect(pre.getAttribute('tabindex')).toBe('0');
    expect(pre.getAttribute('aria-label')).toBe('Agreed prompt v1');
    expect(dialog.querySelector('.prompt-record h3')?.textContent).toContain('v1');
  });
  it('says that approvals of earlier prompt versions do not carry over', async () => {
    const first = chatgptAgreed();
    expect((await render(first, 'a')).querySelector('.prompt-record')?.textContent).not.toContain(
      'do not carry over',
    );
    const revised = step(first, { type: 'propose_prompt', text: `${prompt} Revised.` }, 'a', now);
    const record = (await render(revised, 'b')).querySelector('.prompt-record')!;
    expect(record.querySelector('.prompt-superseded')?.textContent).toBe(
      'Approvals of earlier versions do not carry over to v2.',
    );
    expect([...record.querySelectorAll('.prompt-signatures li')].map(spoken)[1]).toBe(
      'Blair Reed — Waiting',
    );
  });
  it('shows what a prompt revision changed from the version before it', async () => {
    const first = chatgptAgreed();
    expect((await render(first, 'a')).querySelector('.prompt-changes')).toBeNull();
    const revised = step(
      first,
      { type: 'propose_prompt', text: `${prompt}\n\nEvidence: The release log shows Thursday.` },
      'a',
      now,
    );
    const changes = (await render(revised, 'b')).querySelector('.prompt-record .prompt-changes')!;
    expect(changes.querySelector('summary')?.textContent).toBe('What changed since v1');
    expect([...changes.querySelectorAll('li')].map(spoken)).toEqual([
      '1 unchanged line',
      'Added: (blank line)',
      'Added: Evidence: The release log shows Thursday.',
    ]);
    // The marks are drawn, not read twice.
    expect(changes.querySelector('li[class~="diff-added"] [aria-hidden="true"]')?.textContent).toBe(
      '+',
    );
  });
  it('flags evidence added after the prompt and offers to add it', async () => {
    const stale = step(
      chatgptAgreed(),
      { type: 'mark_ready', evidence: 'The release log shows Thursday 14:02.' },
      'b',
    );
    const dialog = await render(stale, 'a');
    expect(dialog.querySelector('.prompt-stale')?.textContent).toContain(
      'The evidence added for review is not in prompt v1, so ChatGPT will not see it.',
    );
    await click(button(dialog, 'Add evidence to the prompt'));
    const editor = dialog.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
    expect(editor.value).toContain(prompt);
    expect(editor.value).toContain('The release log shows Thursday 14:02.');
    expect(nextStep(dialog)).toContain('replaces agreed prompt v1');
  });
  it('does not flag evidence that the prompt already includes', async () => {
    const ready = step(
      step(
        active({ decisionMethod: 'chatgpt' }),
        { type: 'mark_ready', evidence: 'The log.' },
        'b',
        now,
      ),
      { type: 'propose_prompt', text: `${prompt}\nEvidence: The log.` },
      'a',
      now,
    );
    expect((await render(ready, 'a')).querySelector('.prompt-stale')).toBeNull();
  });
  it('words the no-winner option for an insufficient-evidence answer and counts the response', async () => {
    const ready = step(chatgptAgreed(), { type: 'mark_ready', evidence: 'The release log.' }, 'b');
    const dialog = await render(ready, 'a');
    await click(button(dialog, 'Record ChatGPT response'));
    const form = dialog.querySelector('form')!;
    const options = [...form.querySelectorAll('option')].map((option) => option.textContent);
    expect(options).toContain('No winner / insufficient evidence');
    expect(form.textContent).toContain('add the missing evidence and revise the prompt');
    const textarea = form.querySelector('textarea')!;
    expect(textarea.hasAttribute('maxlength')).toBe(false);
    expect(form.querySelector('.character-count')?.textContent).toBe('0 of 8,000 characters');
    // The live region is mounted before anything is typed, so it can announce the change.
    const live = form.querySelector('[role="status"].response-limit')!;
    expect(live.textContent).toBe('');
    const type = async (length: number) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!;
        setter.call(textarea, 'x'.repeat(length));
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await type(8_010);
    expect(form.querySelector('.character-count')?.textContent).toBe(
      '8,010 of 8,000 characters · 10 over the limit',
    );
    const over = live.textContent;
    expect(over).toBe('The response is over the 8,000-character limit. Trim it before recording.');
    expect(form.querySelector('[role="alert"].response-over')).toBeNull();
    // Each further keystroke changes the counter, not the announced sentence.
    await type(8_020);
    expect(live.textContent).toBe(over);
    // Held but still focusable, so the reader can reach it and hear why it does nothing.
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(submit.disabled).toBe(false);
    expect(form.querySelector('.prompt-version-note')?.textContent).not.toContain('shown');
  });
  it('says plainly when a recorded response has no shared conversation', async () => {
    const ready = step(chatgptAgreed(), { type: 'mark_ready', evidence: 'The release log.' }, 'b');
    const bare = step(
      ready,
      { type: 'adjudicate', winnerId: 'a', note: 'ChatGPT: Avery wins.' },
      'b',
    );
    const note = (await render(bare, 'a')).querySelector('.provenance-note')!.textContent;
    expect(note).toContain('without a shared conversation link');
    expect(note).not.toContain('linked conversation');
    const linked = step(
      ready,
      {
        type: 'adjudicate',
        winnerId: 'a',
        note: 'ChatGPT: Avery wins.',
        sourceUrl: 'https://chatgpt.com/share/abc123',
      },
      'b',
    );
    expect((await render(linked, 'a')).querySelector('.provenance-note')!.textContent).toContain(
      'Open the shared conversation',
    );
  });
});

describe('judge and ChatGPT cards state their part plainly', () => {
  const judged = (winnerId: string | null) =>
    step(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'adjudicate', winnerId, note: 'Applied the criteria to the release log.' },
      'c',
    );
  it('states the verdict on the judge’s card, and that no winner means no rolls owed', async () => {
    const winner = (await render(judged('b'), 'a')).querySelector('.adjudication-record')!;
    expect(winner.querySelector('.adjudication-verdict')?.textContent).toBe(
      'Recommended: Blair wins',
    );
    const none = (await render(judged(null), 'a')).querySelector('.adjudication-record')!;
    expect(none.querySelector('.adjudication-verdict')?.textContent).toBe(
      'Recommended: no winner. If both bettors confirm, the bet is called off and no rolls are owed.',
    );
    const confirmed = step(
      step(judged(null), { type: 'confirm_result' }, 'a'),
      {
        type: 'confirm_result',
      },
      'b',
    );
    expect((await render(confirmed, 'a')).querySelector('.adjudication-verdict')?.textContent).toBe(
      'Recommended: no winner',
    );
  });
  it('speaks to the judge as you on the method card', async () => {
    const bet = active({ decisionMethod: 'judge', judgeId: 'c' });
    const mine = (await render(bet, 'c')).querySelector('.adjudication-method')!.textContent;
    expect(mine).toContain('You are the judge');
    expect(mine).not.toContain('Judge: Casey');
    expect(mine).toContain('You record a recommendation. Both bettors still confirm the result.');
    const theirs = (await render(bet, 'a')).querySelector('.adjudication-method')!.textContent;
    expect(theirs).toContain('Judge: Casey Hale');
    expect(theirs).toContain(JUDGE_COPY.newBetHint);
  });
  it('explains that the ChatGPT prompt is a separate step after the bet is agreed', async () => {
    const card = (await render(pending({ decisionMethod: 'chatgpt' }), 'b')).querySelector(
      '.adjudication-method',
    )!.textContent;
    expect(card).toContain('ChatGPT, with a mutually agreed prompt');
    expect(card).toContain('approve the exact prompt as a separate step');
    expect(card).toContain('Debts stay between the original two people.');
  });
});

describe('the delivery form after a partial offset', () => {
  it('says how many rolls the report settles', async () => {
    const stakes = [3, 1].map((stake, index) => {
      const [creator, opponent] = index ? ['b', 'a'] : ['a', 'b'];
      const placed = createBet({ ...input, stake, opponentId: opponent }, creator, members, now);
      const agreed = applyAction(placed, { type: 'accept' }, opponent, now);
      const proposed = applyAction(
        agreed,
        { type: 'propose_result', winnerId: creator, note: 'Shipped.' },
        creator,
        due,
      );
      return applyAction(proposed, { type: 'confirm_result' }, opponent, due);
    });
    const offset = previewDebtOffset(stakes, 'a', 'b')!;
    expect(offset.rolls).toBe(1);
    const [partial] = applyDebtOffset(stakes, offset, 'a', later).bets;
    expect(partial.status).toBe('owed');
    // Blair owes Avery 3 rolls, minus the one offset.
    expect(nextStep(await render(partial, 'a'))).toContain('Blair owes you 2 lobster rolls.');
    const dialog = await render(partial, 'b');
    await click(button(dialog, 'Record delivery'));
    expect(
      [...dialog.querySelectorAll('form .hint')].map((hint) => hint.textContent).join(' '),
    ).toContain('This report settles all 2 rolls you still owe Avery.');
  });
});

describe('copying the agreed prompt when the clipboard is refused', () => {
  it('opens the prompt, selects it and moves focus there', async () => {
    const dialog = await render(chatgptAgreed(), 'a');
    const details = dialog.querySelector<HTMLDetailsElement>('.prompt-record details')!;
    expect(details.open).toBe(false);
    await click(button(dialog, 'Copy agreed prompt'));
    expect(details.open).toBe(true);
    const pre = dialog.querySelector('.prompt-record pre')!;
    expect(document.activeElement).toBe(pre);
    expect(window.getSelection()?.toString()).toBe(prompt);
    expect(dialog.querySelector('.next-action .form-error')?.textContent).toContain(
      'Clipboard access is unavailable',
    );
  });
});

describe('an agreed ChatGPT prompt that leaves out the evidence', () => {
  const evidence = 'The release log shows Thursday 14:02.';
  // Evidence first, then a prompt written without it: the order does not hide the gap.
  const evidenceFirst = () =>
    step(
      step(
        step(active({ decisionMethod: 'chatgpt' }), { type: 'mark_ready', evidence }, 'b', now),
        { type: 'propose_prompt', text: prompt },
        'a',
        now,
      ),
      { type: 'approve_prompt' },
      'b',
      now,
    );
  it('is flagged whenever the evidence was added, and the next step does not say copy it as agreed', async () => {
    const dialog = await render(evidenceFirst(), 'a');
    expect(dialog.querySelector('.prompt-stale')).not.toBeNull();
    expect(nextStep(dialog)).toContain('the evidence added for review is not in it');
    expect(nextStep(dialog)).not.toContain('Copy it into ChatGPT exactly as agreed');
    expect(dialog.querySelector('.your-move')?.textContent).toBe(
      'Your move: Add evidence to the prompt',
    );
  });
  it('leads the next step with the button the Your move strip names', async () => {
    const dialog = await render(evidenceFirst(), 'a');
    const step = dialog.querySelector('.next-action')!;
    const primary = step.querySelector('.button-primary');
    expect(primary?.textContent?.trim()).toBe('Add evidence to the prompt');
    // Recording against the agreed version stays possible, as the warning says.
    expect(
      [...step.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes('Record ChatGPT response'),
      )?.className,
    ).toContain('button-secondary');
    // One way to revise, not two buttons that open the same editor.
    expect(step.textContent).not.toContain('Revise prompt and request fresh approval');
  });
  it('carries the evidence into a revision from the next step', async () => {
    const dialog = await render(evidenceFirst(), 'a');
    const step = dialog.querySelector<HTMLElement>('.next-action')!;
    await click(button(step, 'Add evidence to the prompt'));
    const editor = dialog.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
    expect(editor.value).toContain(prompt);
    expect(editor.value).toContain(evidence);
  });
  it('warns the bettor asked to approve a prompt that leaves it out', async () => {
    const proposed = step(
      step(active({ decisionMethod: 'chatgpt' }), { type: 'mark_ready', evidence }, 'b', now),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
    const dialog = await render(proposed, 'b');
    expect(dialog.querySelector('.prompt-stale')).not.toBeNull();
    expect(nextStep(dialog)).toContain(
      'It leaves out the evidence added for review, so ChatGPT would not see it. Revise the prompt to add it.',
    );
  });
});

describe('the facts row', () => {
  it('names how a bet was entered only when that was recorded', async () => {
    expect((await render(active(), 'a')).querySelector('.detail-facts')?.textContent).not.toContain(
      'Entered via',
    );
    const recorded = { ...active(), entrySource: 'cli' as const };
    expect((await render(recorded, 'a')).querySelector('.detail-facts')?.textContent).toContain(
      'Entered via: CLI',
    );
  });
});

describe('the method card on a bet that was turned down', () => {
  const reported = () =>
    createBet(
      {
        ...input,
        timing: { kind: 'event', description: 'The release notes are published' },
        history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      now,
    );
  const method = (dialog: Element) => dialog.querySelector('.adjudication-method');

  it('is left off a declined or withdrawn record of a past bet, where no result is being decided', async () => {
    const declined = step(reported(), { type: 'decline', note: 'That was two rolls.' }, 'b', now);
    const withdrawn = step(reported(), { type: 'withdraw', note: 'Wrong year.' }, 'a', now);
    for (const closed of [declined, withdrawn]) {
      const dialog = await render(closed, 'a');
      expect(method(dialog)).toBeNull();
      expect(dialog.textContent).not.toContain('Both bettors agree on the outcome');
      expect(dialog.textContent).not.toContain('Debts stay between the original two people');
    }
  });

  it('is left off an ordinary declined bet, however it would have been decided', async () => {
    for (const overrides of [
      {},
      { decisionMethod: 'judge' as const, judgeId: 'c' },
      { decisionMethod: 'chatgpt' as const },
    ]) {
      const declined = step(
        pending(overrides),
        { type: 'decline', note: 'Not this one.' },
        'b',
        now,
      );
      expect(method(await render(declined, 'a'))).toBeNull();
    }
  });

  it('stays while the record is waiting to be answered, and on a bet that was called off', async () => {
    expect(method(await render(reported(), 'b'))).not.toBeNull();
    expect(method(await render(pending(), 'b'))).not.toBeNull();
    const calledOff = step(
      step(active(), { type: 'propose_void', note: 'It rained.' }, 'a', now),
      { type: 'confirm_void' },
      'b',
      now,
    );
    expect(method(await render(calledOff, 'a'))).not.toBeNull();
  });
});

describe('an agreed ChatGPT prompt that still quotes evidence that came off the bet', () => {
  const evidence = 'Final standings posted 22:41: Blair’s team 2nd, Avery’s 5th.';
  const withEvidence = `${prompt}\n\nEvidence to assess:\n${evidence}\n\nReturn a recommended winner.`;
  const quoting = (overrides: Partial<NewBet> = {}) =>
    step(
      step(
        step(
          active({ decisionMethod: 'chatgpt', ...overrides }),
          { type: 'mark_ready', evidence },
          'b',
          now,
        ),
        { type: 'propose_prompt', text: withEvidence },
        'a',
        now,
      ),
      { type: 'approve_prompt' },
      'b',
      now,
    );
  const disagreed = (overrides: Partial<NewBet> = {}) =>
    step(
      quoting(overrides),
      { type: 'dispute_readiness', note: 'That table is last season’s.' },
      'a',
    );
  const stale = (dialog: Element) => dialog.querySelector('.prompt-record .prompt-stale');

  it('warns in the prompt record, worded for whoever reads it, and says a revision needs both approvals', async () => {
    expect(stale(await render(disagreed(), 'a'))?.textContent).toContain(
      'Prompt v1 still quotes evidence you disagreed with. Revise it to take it out, which needs both approvals again.',
    );
    expect(stale(await render(disagreed(), 'b'))?.textContent).toContain(
      'Prompt v1 still quotes evidence Avery disagreed with. Revise it to take it out, which needs both approvals again.',
    );
  });

  it('says it for evidence its author took back or replaced, too', async () => {
    const withdrawn = step(quoting(), { type: 'withdraw_proposal', note: 'Wrong table.' }, 'b');
    expect(stale(await render(withdrawn, 'a'))?.textContent).toContain(
      'still quotes evidence Blair took back.',
    );
    const replaced = step(quoting(), { type: 'mark_ready', evidence: 'The corrected table.' }, 'b');
    expect(stale(await render(replaced, 'a'))?.textContent).toContain(
      'still quotes evidence Blair replaced.',
    );
  });

  it('leads the next step with taking it out, and keeps copying as agreed a secondary choice', async () => {
    const dialog = await render(disagreed(), 'b');
    expect(dialog.querySelector('.your-move')?.textContent).toBe(
      'Your move: Remove evidence from the prompt',
    );
    const next = dialog.querySelector('.next-action')!;
    expect(next.textContent).toContain('it still quotes evidence Avery disagreed with');
    expect(next.textContent).not.toContain('Copy it into ChatGPT exactly as agreed');
    expect(next.querySelector('.button-primary')?.textContent?.trim()).toBe(
      'Remove evidence from the prompt',
    );
    expect(button(next, 'Record ChatGPT response')?.className).toContain('button-secondary');
  });

  it('opens the revision with the disagreed evidence out and the draft’s placeholder in its place', async () => {
    const dialog = await render(disagreed(), 'b');
    await click(button(dialog.querySelector('.next-action')!, 'Remove evidence from the prompt'));
    const editor = dialog.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
    expect(editor.value).not.toContain(evidence);
    expect(editor.value).toContain(`Evidence to assess:\n${NO_EVIDENCE_YET}\n\nReturn`);
    expect(nextStep(dialog)).toContain('replaces agreed prompt v1');
    // The button in the prompt record opens the same revision.
    await click(button(dialog, 'Cancel'));
    await click(button(dialog.querySelector('.prompt-record')!, 'Remove evidence from the prompt'));
    expect(
      dialog.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!.value,
    ).not.toContain(evidence);
  });

  it('puts new evidence where the old stood, not beside it, and asks for both changes at once', async () => {
    const again = step(disagreed(), { type: 'mark_ready', evidence: 'The corrected table.' }, 'a');
    const dialog = await render(again, 'b');
    expect(stale(dialog)?.textContent).toContain('is not in prompt v1');
    expect(stale(dialog)?.textContent).toContain('still quotes evidence Avery disagreed with');
    await click(button(dialog.querySelector('.prompt-record')!, 'Add evidence to the prompt'));
    const editor = dialog.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
    expect(editor.value).toContain('Evidence to assess:\nThe corrected table.\n\nReturn');
    expect(editor.value).not.toContain(evidence);
  });

  it('does not flag a prompt that quotes the longer version the evidence was replaced with', async () => {
    const extended = `${evidence} Confirmed on the league site.`;
    const reagreed = step(
      step(
        step(
          step(active({ decisionMethod: 'chatgpt' }), { type: 'mark_ready', evidence }, 'b', now),
          { type: 'mark_ready', evidence: extended },
          'b',
          now,
        ),
        {
          type: 'propose_prompt',
          text: `${prompt}\n\nEvidence to assess:\n${extended}\n\nReturn a recommended winner.`,
        },
        'a',
        now,
      ),
      { type: 'approve_prompt' },
      'b',
      now,
    );
    const dialog = await render(reagreed, 'a');
    expect(stale(dialog)).toBeNull();
    expect(dialog.querySelector('.your-move')?.textContent).toBe(
      'Your move: Record ChatGPT response',
    );
    expect(button(dialog, 'Remove evidence from the prompt')).toBeUndefined();
  });

  it('is said while the bet is not ready too, and to a prompt still awaiting approval', async () => {
    const waiting = disagreed({
      timing: { kind: 'event', description: 'The league posts standings' },
    });
    const dialog = await render(waiting, 'b');
    expect(dialog.querySelector('.next-action')?.textContent).toContain(
      'Prompt v1 still quotes evidence Avery disagreed with.',
    );
    const proposed = step(
      step(
        step(active({ decisionMethod: 'chatgpt' }), { type: 'mark_ready', evidence }, 'b', now),
        { type: 'propose_prompt', text: withEvidence },
        'a',
        now,
      ),
      { type: 'dispute_readiness', note: 'Last season’s.' },
      'a',
    );
    const asked = await render(proposed, 'b');
    expect(stale(asked)?.textContent).toContain('still quotes evidence Avery disagreed with');
    expect(nextStep(asked)).toContain('It quotes evidence Avery disagreed with');
  });

  it('is only a note for someone outside the bet, and gone once the prompt is rewritten without it', async () => {
    const outsider = await render(disagreed(), 'c');
    expect(stale(outsider)).not.toBeNull();
    expect(
      button(outsider.querySelector('.prompt-record')!, 'Remove evidence from the prompt'),
    ).toBeUndefined();
    const cleaned = step(
      step(disagreed(), { type: 'propose_prompt', text: prompt }, 'a'),
      { type: 'approve_prompt' },
      'b',
    );
    const dialog = await render(cleaned, 'a');
    expect(stale(dialog)).toBeNull();
    expect(dialog.querySelector('.your-move')?.textContent).toBe(
      'Your move: Record ChatGPT response',
    );
  });
});
