// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createBet } from '../lib/ledger';
import type { Bet, Member } from '../lib/types';
import {
  AgreementProposalRecord,
  HistoryRecord,
  PriorAmendmentRecord,
  PriorHistoryRecord,
  TimingRecord,
} from './WorkflowRecords';

const now = '2026-10-01T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
  { id: 'c', name: 'Casey Hale', initials: 'CH', color: '#2b4a1e' },
  {
    id: '7d4c2a90-1b3e-4f5a-9c8d-2e6f0a1b3c4d',
    name: 'Priya Shah',
    initials: 'PS',
    color: '#7a5cff',
  },
];
const timing = { kind: 'date' as const, at: '2026-10-25T16:00:00.000Z', timezone: 'UTC' };
function judgedBet(): Bet {
  const bet = createBet(
    {
      title: 'The release ships before Friday',
      terms: 'Decided by the published release notes.',
      category: 'Work',
      creatorSide: 'It ships',
      opponentSide: 'It slips',
      opponentId: 'b',
      stake: 2,
      deadline: undefined,
      timing,
      decisionMethod: 'judge',
      judgeId: 'c',
    },
    'a',
    members,
    now,
  );
  return applyAction(bet, { type: 'accept' }, 'b', now);
}
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
/** Rendered for Casey unless told otherwise: the judge, or a member outside the bet. */
async function render(bet: Bet, memberId = 'c') {
  await act(async () =>
    root.render(createElement(AgreementProposalRecord, { bet, members, memberId })),
  );
}
const facts = () =>
  Object.fromEntries(
    [...container.querySelectorAll('.workflow-facts > div')].map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ]),
  );
/** Each compare row by field: its change state and the now / proposed (or unchanged) values. */
const compare = () =>
  Object.fromEntries(
    [...container.querySelectorAll('.compare-row')].map((row) => [
      row.querySelector('.compare-field')?.textContent,
      {
        state: row.querySelector('.compare-state')?.textContent,
        now: row.querySelector('.compare-now .compare-value')?.textContent,
        proposed: row.querySelector('.compare-proposed .compare-value')?.textContent,
        same: row.querySelector('.compare-same')?.textContent,
        columns: [...row.querySelectorAll('.compare-label')].map((label) => label.textContent),
      },
    ]),
  );

describe('proposed changes to the agreement', () => {
  it('asks the bettor who must answer for an answer instead of telling them to wait', async () => {
    const amended = applyAction(
      judgedBet(),
      {
        type: 'propose_amendment',
        terms: 'Decided by the published release notes and the changelog.',
        timing,
        note: 'Add the changelog.',
      },
      'a',
      now,
    );
    const calledOff = applyAction(
      judgedBet(),
      { type: 'propose_void', note: 'The release was cancelled.' },
      'a',
      now,
    );
    for (const proposed of [amended, calledOff]) {
      await render(proposed, 'b');
      const line = container.querySelector('.workflow-review > p')!.textContent;
      expect(line).toContain('Your answer is needed: agree or decline in the next step.');
      expect(line).not.toContain('Waiting for');
      // The proposer and the judge are the ones waiting.
      for (const memberId of ['a', 'c']) {
        await render(proposed, memberId);
        expect(container.querySelector('.workflow-review > p')!.textContent).toContain(
          'Waiting for Blair Reed to agree or decline.',
        );
      }
    }
  });
  it('shows the current and proposed judge by name when an amendment re-appoints one', async () => {
    const declined = applyAction(
      judgedBet(),
      { type: 'decline_judging', note: 'I am conflicted on this one.' },
      'c',
      now,
    );
    const proposed = applyAction(
      declined,
      {
        type: 'propose_amendment',
        terms: declined.terms,
        timing,
        decisionMethod: 'judge',
        judgeId: '7d4c2a90-1b3e-4f5a-9c8d-2e6f0a1b3c4d',
        note: 'Priya can judge it instead.',
      },
      'a',
      now,
    );
    await render(proposed);
    const row = compare()['Decided by'];
    expect(row.now).toContain('Casey Hale');
    expect(row.now).toContain('stepped down');
    expect(row.proposed).toBe('Judge: Priya Shah');
    expect(container.textContent).not.toContain('7d4c2a90');
  });
  it('says when the judge would be removed in favour of another method', async () => {
    const proposed = applyAction(
      judgedBet(),
      {
        type: 'propose_amendment',
        terms: 'Decided by the published release notes.',
        timing,
        decisionMethod: 'mutual',
        note: 'We can decide it ourselves.',
      },
      'b',
      now,
    );
    await render(proposed);
    const row = compare()['Decided by'];
    expect(row.now).toBe('Judge: Casey Hale');
    expect(row.proposed).toContain('Mutual agreement');
    expect(row.proposed).toContain('Casey Hale is removed as judge');
  });
  it('leaves the decision rows out when the amendment keeps the agreed method', async () => {
    const proposed = applyAction(
      judgedBet(),
      {
        type: 'propose_amendment',
        terms: 'Decided by the published release notes and the changelog.',
        timing,
        note: 'Name the changelog too.',
      },
      'a',
      now,
    );
    await render(proposed);
    expect(compare()['Decided by']).toBeUndefined();
    expect(compare()['Decision criteria'].proposed).toContain('changelog');
    expect(compare()['Decision timing']).toMatchObject({ state: 'Unchanged' });
  });
});

const past = '2020-01-01T00:00:00.000Z';
const longAgo = '2019-06-01T00:00:00.000Z';
function activeBet(overrides: Partial<Parameters<typeof createBet>[0]> = {}): Bet {
  return applyAction(
    createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 2,
        deadline: undefined,
        timing: { kind: 'date', at: '2099-10-25T16:00:00.000Z', timezone: 'UTC' },
        ...overrides,
      },
      'a',
      members,
      longAgo,
    ),
    { type: 'accept' },
    'b',
    longAgo,
  );
}
async function renderTiming(bet: Bet, memberId: string) {
  await act(async () => root.render(createElement(TimingRecord, { bet, members, memberId })));
}

describe('decision timing record', () => {
  it('answers whether the bet can be reviewed yet', async () => {
    await renderTiming(activeBet(), 'a');
    expect(facts()['Review status']).toContain('Not yet');
    await renderTiming(activeBet({ timing: { kind: 'date', at: past, timezone: 'UTC' } }), 'a');
    expect(facts()['Review status']).toContain('Ready for review');
    const reminder = applyAction(
      activeBet({ timing: { kind: 'event', description: 'The final whistle' } }),
      { type: 'set_check_in', checkIn: { at: past, timezone: 'UTC' } },
      'a',
      longAgo,
    );
    await renderTiming(reminder, 'a');
    expect(facts()['Review status']).toContain('Check-in due');
    expect(container.querySelector('.review-status-due')).not.toBeNull();
  });
  it('tells a member outside the bet that the cutoff passed, not to go and add evidence', async () => {
    const cutoff = activeBet({
      timing: { kind: 'event', description: 'The final whistle' },
      cutoff: { at: past, timezone: 'UTC' },
    });
    await renderTiming(cutoff, 'a');
    expect(facts()['Review status']).toContain('then add it.');
    await renderTiming(cutoff, 'c');
    expect(facts()['Review status']).toContain('Cutoff passed');
    expect(facts()['Review status']).toContain('The claim cutoff has passed.');
    expect(facts()['Review status']).not.toContain('then add it');
  });
  it('shows a personal check-in only to that bettor while the bet is in play', async () => {
    const bet = applyAction(
      activeBet({
        timing: {
          kind: 'event',
          description: 'The final whistle',
          checkIn: { at: '2099-01-01T12:00:00.000Z', timezone: 'UTC' },
        },
      }),
      { type: 'set_check_in', checkIn: { at: '2099-02-01T12:00:00.000Z', timezone: 'UTC' } },
      'a',
      longAgo,
    );
    await renderTiming(bet, 'a');
    expect(facts()['Your check-in']).toContain('Feb 1, 2099');
    expect(facts()['Initial check-in']).toContain('Jan 1, 2099');
    await renderTiming(bet, 'c');
    expect(facts()['Your check-in']).toBeUndefined();
    expect(facts()['Initial check-in']).toContain('Jan 1, 2099');
    await renderTiming(bet, 'b');
    expect(facts()['Your check-in']).toBeUndefined();
    const done = applyAction(
      applyAction(
        applyAction(bet, { type: 'mark_ready', evidence: 'Full time.' }, 'a', longAgo),
        { type: 'propose_result', winnerId: 'a', note: 'Shipped.' },
        'a',
        longAgo,
      ),
      { type: 'confirm_result' },
      'b',
      longAgo,
    );
    expect(done.status).toBe('owed');
    await renderTiming(done, 'a');
    expect(facts()['Your check-in']).toBeUndefined();
    expect(facts()['Review status']).toBeUndefined();
  });
  it('marks a claim cutoff that has passed', async () => {
    await renderTiming(
      activeBet({
        timing: { kind: 'event', description: 'The final whistle' },
        cutoff: { at: past, timezone: 'UTC' },
      }),
      'a',
    );
    expect(facts()['Claim cutoff']).toContain('Passed');
    await renderTiming(
      activeBet({
        timing: { kind: 'event', description: 'The final whistle' },
        cutoff: { at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
      }),
      'a',
    );
    expect(facts()['Claim cutoff']).not.toContain('Passed');
  });
  it('keeps the evidence apart from who added it, line breaks intact', async () => {
    const bet = applyAction(
      activeBet(),
      { type: 'mark_ready', evidence: 'Release notes are out.\nhttps://example.com/notes' },
      'b',
      longAgo,
    );
    await renderTiming(bet, 'a');
    const evidence = container.querySelector('.readiness-evidence')!;
    expect(evidence.textContent).toContain('Release notes are out.\nhttps://example.com/notes');
    expect(evidence.textContent).not.toContain('Added by');
    expect(evidence.nextElementSibling?.textContent).toMatch(/^Added by Blair Reed on /);
  });
});

describe('reviewing proposed changes', () => {
  it('shows what each part of the agreement is now and would become', async () => {
    const bet = activeBet({
      timing: {
        kind: 'date',
        at: '2099-10-25T16:00:00.000Z',
        timezone: 'UTC',
        source: 'The release notes',
        checkIn: { at: '2099-10-20T16:00:00.000Z', timezone: 'UTC' },
      },
      cutoff: { at: '2099-10-24T16:00:00.000Z', timezone: 'UTC' },
    });
    const proposed = applyAction(
      bet,
      {
        type: 'propose_amendment',
        terms: 'Decided by the published changelog.',
        timing: { kind: 'event', description: 'The changelog is published' },
        note: 'The release notes were retired.',
      },
      'b',
      longAgo,
    );
    await render(proposed);
    const rows = compare();
    for (const field of [
      'Decision criteria',
      'Decision timing',
      'Claim cutoff',
      'Evidence source',
      'Initial check-in',
    ])
      expect(rows[field].columns).toEqual(['Now', 'Proposed']);
    expect(rows['Decision criteria']).toMatchObject({
      state: 'Changed',
      now: 'Decided by the published release notes.',
      proposed: 'Decided by the published changelog.',
    });
    expect(rows['Decision timing'].proposed).toBe(
      'When an event happens: The changelog is published',
    );
    for (const field of ['Claim cutoff', 'Evidence source', 'Initial check-in'])
      expect(rows[field]).toMatchObject({ state: 'Removed', proposed: 'None' });
    expect(rows['Evidence source'].now).toBe('The release notes');
    expect(facts()['Reason']).toBe('The release notes were retired.');
    expect(container.textContent).toContain('Waiting for Avery Stone to agree or decline.');
  });
  it('compares the agreement at the time in the paper trail, with the reason labelled', async () => {
    const proposed = applyAction(
      activeBet(),
      {
        type: 'propose_amendment',
        terms: 'Decided by the published changelog.',
        timing: { kind: 'date', at: '2099-11-25T16:00:00.000Z', timezone: 'UTC' },
        cutoff: { at: '2099-11-20T16:00:00.000Z', timezone: 'UTC' },
        note: 'A later release.',
      },
      'a',
      longAgo,
    );
    await act(async () =>
      root.render(createElement(PriorAmendmentRecord, { event: proposed.events.at(-1)! })),
    );
    const rows = compare();
    expect(rows['Decision criteria'].columns).toEqual(['Agreed then', 'Proposed']);
    expect(rows['Claim cutoff']).toMatchObject({ state: 'Added', now: 'None' });
    expect(rows['Evidence source']).toBeUndefined();
    expect(facts()['Reason']).toBe('A later release.');
  });
});

describe('a legacy decision date in a review', () => {
  it('counts the same day restated as timing as unchanged, now and in the paper trail', async () => {
    const legacy = activeBet({ timing: undefined, deadline: '2099-09-30' });
    const proposed = applyAction(
      legacy,
      {
        type: 'propose_amendment',
        terms: legacy.terms,
        timing: { kind: 'date', at: '2099-09-30T00:00:00.000Z', timezone: 'UTC' },
        decisionMethod: 'judge',
        judgeId: 'c',
        note: 'Casey can call it.',
      },
      'b',
      longAgo,
    );
    await render(proposed, 'a');
    expect(compare()['Decision timing']).toMatchObject({
      state: 'Unchanged',
      same: 'On or after Sep 30, 2099, 12:00 AM UTC',
    });
    expect(compare()['Decided by']).toMatchObject({ state: 'Changed' });
    await act(async () =>
      root.render(createElement(PriorAmendmentRecord, { event: proposed.events.at(-1)!, members })),
    );
    expect(compare()['Decision timing']).toMatchObject({ state: 'Unchanged' });
  });
});

describe('reported history in the paper trail', () => {
  it('names the revision, attributes each position and keeps a legacy decision date', async () => {
    const reportedAt = '2025-01-01T00:00:00.000Z';
    const reported = createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 2,
        deadline: '2024-02-10',
        history: { stage: 'active', originalDate: { precision: 'month', value: '2024-02' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      reportedAt,
    );
    const revised = applyAction(
      reported,
      {
        type: 'revise_history',
        revision: {
          title: reported.title,
          terms: 'Decided by the published release notes and the changelog.',
          category: reported.category,
          creatorSide: reported.creatorSide,
          opponentSide: reported.opponentSide,
          stake: reported.stake,
          deadline: reported.deadline,
          history: reported.history!,
        },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'b',
      reportedAt,
    );
    await act(async () =>
      root.render(
        createElement(PriorHistoryRecord, {
          event: revised.events.at(-1)!,
          members,
          bet: revised,
        }),
      ),
    );
    expect(container.querySelector('summary')?.textContent).toBe('Revision 1 (replaced here)');
    expect(facts()['Avery Stone’s position']).toBe('It ships');
    expect(facts()['Blair Reed’s position']).toBe('It slips');
    expect(facts()['Decision date']).toBe('Feb 10, 2024 (UTC)');
    expect(facts()['Reported by']).toContain('Avery Stone');
    // What replaced it is said in the trail itself, without opening the disclosure.
    const changes = container.querySelector('.workflow-changes')!;
    expect(changes.closest('details')).toBeNull();
    expect(changes.textContent).toContain('Changed from revision 1');
    expect([...changes.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Criteria: edited',
    ]);
  });
  it('keeps the exact pin of a revised location and the correction the revision answered', async () => {
    const pinned = {
      id: 'kitchen',
      name: 'The office kitchen',
      address: 'Pinned location',
      lat: 41.30836,
      lng: -72.92816,
    };
    const reported = createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 1,
        timing: { kind: 'event', description: 'The release notes are published' },
        location: pinned,
        history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      now,
    );
    const corrected = applyAction(
      reported,
      { type: 'request_history_correction', note: 'It was two rolls, not one.' },
      'b',
      now,
    );
    const revised = applyAction(
      corrected,
      {
        type: 'revise_history',
        revision: {
          title: reported.title,
          terms: reported.terms,
          category: reported.category,
          creatorSide: reported.creatorSide,
          opponentSide: reported.opponentSide,
          stake: 2,
          timing: reported.timing,
          location: { ...pinned, lat: 41.31 },
          history: reported.history!,
        },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      now,
    );
    await act(async () =>
      root.render(
        createElement(PriorHistoryRecord, { event: revised.events.at(-1)!, members, bet: revised }),
      ),
    );
    expect(facts()['Location']).toBe('The office kitchen (41.3084, -72.9282)');
    expect(facts()['Correction asked for']).toContain('Blair Reed');
    expect(facts()['Correction asked for']).toContain('It was two rolls, not one.');
    expect(
      [...container.querySelectorAll('.workflow-changes li')].map((item) => item.textContent),
    ).toEqual([
      'Stake: 1 → 2',
      'Location: The office kitchen (41.3084, -72.9282) → The office kitchen (41.3100, -72.9282)',
    ]);
  });
});

describe('a requested correction on the history record', () => {
  const reported = () =>
    createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 1,
        timing: { kind: 'event', description: 'The release notes are published' },
        history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      now,
    );
  const corrected = () =>
    applyAction(
      reported(),
      { type: 'request_history_correction', note: 'It was two rolls, not one.' },
      'b',
      now,
    );
  it('is an informational notice naming who asked and when, not a form error', async () => {
    await act(async () =>
      root.render(createElement(HistoryRecord, { bet: corrected(), members, memberId: 'a' })),
    );
    expect(container.querySelector('.form-error')).toBeNull();
    const notice = container.querySelector('.workflow-notice')!;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('Blair Reed asked for a correction');
    expect(notice.textContent).toContain('It was two rolls, not one.');
    expect(notice.querySelector('time')?.getAttribute('dateTime')).toBe(now);
    // Blair's line says what Blair did rather than "Awaiting confirmation".
    const signatures = container.querySelector('.workflow-signatures')!.textContent;
    expect(signatures).toContain('Asked for a correction');
  });
  it('speaks to the bettor who asked for it', async () => {
    await act(async () =>
      root.render(createElement(HistoryRecord, { bet: corrected(), members, memberId: 'b' })),
    );
    expect(container.querySelector('.workflow-notice')!.textContent).toContain(
      'You asked for a correction',
    );
  });
  it('says which revision is shown and what it changed from the one before', async () => {
    const bet = corrected();
    const revised = applyAction(
      bet,
      {
        type: 'revise_history',
        revision: {
          title: bet.title,
          terms: bet.terms,
          category: bet.category,
          creatorSide: bet.creatorSide,
          opponentSide: bet.opponentSide,
          stake: 2,
          timing: bet.timing,
          history: bet.history!,
        },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      now,
    );
    await act(async () =>
      root.render(createElement(HistoryRecord, { bet: revised, members, memberId: 'b' })),
    );
    expect(container.querySelector('.workflow-notice')).toBeNull();
    const changes = container.querySelector('.workflow-changes')!;
    expect(changes.textContent).toContain('Revision 2');
    expect(changes.textContent).toContain('your correction');
    expect([...changes.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Stake: 1 → 2',
    ]);
  });
});

describe('the history record of a reported bet that was closed', () => {
  const reported = () =>
    createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 1,
        timing: { kind: 'event', description: 'The release notes are published' },
        history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      now,
    );
  const declined = () =>
    applyAction(reported(), { type: 'decline', note: 'That was two rolls.' }, 'b', now);
  const withdrawn = () =>
    applyAction(reported(), { type: 'withdraw', note: 'I got the year wrong.' }, 'a', now);
  const shown = async (bet: Bet, memberId?: string) => {
    await act(async () => root.render(createElement(HistoryRecord, { bet, members, memberId })));
    return {
      heading: container.querySelector('h3')!.textContent,
      provenance: container.querySelector('.workflow-provenance')!.textContent,
      rows: [...container.querySelectorAll('.workflow-signatures > div')].map(
        (row) => row.querySelector('span')!.textContent,
      ),
      text: container.textContent!,
    };
  };

  it('says it was declined, and who declined it, instead of awaiting confirmation', async () => {
    const record = await shown(declined(), 'a');
    expect(record.heading).toBe('History declined');
    expect(record.text).not.toContain('awaiting confirmation');
    expect(record.text).not.toContain('Awaiting confirmation');
    expect(record.provenance).toContain('never changed');
    expect(record.provenance).not.toMatch(/until both original bettors confirm/);
    // Avery reported it, so Avery's own confirmation stands; Blair's answer was no.
    expect(record.rows[0]).toMatch(/^Avery StoneConfirmed /);
    expect(record.rows[1]).toMatch(/^Blair ReedDeclined /);
  });

  it('says it was withdrawn, and that the other bettor never answered', async () => {
    const record = await shown(withdrawn(), 'b');
    expect(record.heading).toBe('History withdrawn');
    expect(record.text).not.toContain('Awaiting confirmation');
    expect(record.rows[0]).toMatch(/^Avery StoneWithdrew /);
    expect(record.rows[1]).toBe('Blair ReedDid not answer');
  });

  it('puts a clock icon only on a record that is still waiting', async () => {
    await shown(declined(), 'a');
    expect(container.querySelector('.workflow-signatures .lucide-clock-3')).toBeNull();
    await shown(reported(), 'a');
    expect(container.querySelector('.workflow-signatures .lucide-clock-3')).not.toBeNull();
    expect((await shown(reported(), 'a')).heading).toBe('History awaiting confirmation');
  });

  it('keeps a correction that was asked for on a closed record, without saying it blocks anything', async () => {
    const asked = applyAction(
      reported(),
      { type: 'request_history_correction', note: 'It was two rolls, not one.' },
      'b',
      now,
    );
    const closed = applyAction(asked, { type: 'withdraw', note: 'Let me start over.' }, 'a', now);
    const record = await shown(closed, 'a');
    expect(record.heading).toBe('History withdrawn');
    expect(record.text).toContain('It was two rolls, not one.');
    expect(record.text).not.toContain('can confirm this version');
    expect(record.rows[1]).toMatch(/^Blair ReedAsked for a correction /);
  });
});

describe('who a correction notice speaks to', () => {
  const asked = () =>
    applyAction(
      createBet(
        {
          title: 'The release ships before Friday',
          terms: 'Decided by the published release notes.',
          category: 'Work',
          creatorSide: 'It ships',
          opponentSide: 'It slips',
          opponentId: 'b',
          stake: 1,
          timing: { kind: 'event', description: 'The release notes are published' },
          history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
          acknowledgements: { terms: true, result: false, delivery: false },
        },
        'a',
        members,
        now,
      ),
      { type: 'request_history_correction', note: 'It was two rolls, not one.' },
      'b',
      now,
    );
  const sentence = async (memberId?: string) => {
    await act(async () =>
      root.render(createElement(HistoryRecord, { bet: asked(), members, memberId })),
    );
    const paragraphs = [...container.querySelectorAll('.workflow-notice > p')];
    return paragraphs.at(-1)!.textContent;
  };

  it('tells each bettor that neither of them can confirm it yet', async () => {
    expect(await sentence('a')).toBe(
      'Neither of you can confirm this version until the history is revised.',
    );
    expect(await sentence('b')).toBe(
      'Neither of you can confirm this version until the history is revised.',
    );
  });

  it('says it of the version, not of "you", to someone who is not a bettor on it', async () => {
    const expected = 'This version cannot be confirmed until the history is revised.';
    expect(await sentence('c')).toBe(expected);
    expect(await sentence(undefined)).toBe(expected);
  });
});

describe('reported evidence link', () => {
  it('says that the earlier conversation opens in a new tab', async () => {
    const reported = createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 2,
        deadline: '2024-02-10',
        history: {
          stage: 'owed',
          originalDate: { precision: 'month', value: '2024-02' },
          result: { winnerId: 'a', date: { precision: 'unknown' }, note: 'Avery called it.' },
          previousAdjudication: {
            method: 'chatgpt',
            note: 'A previous conversation favored Avery.',
            sourceUrl: 'https://example.com/archive',
          },
        },
        acknowledgements: { terms: true, result: true, delivery: false },
      },
      'a',
      members,
      now,
    );
    await act(async () => root.render(createElement(HistoryRecord, { bet: reported, members })));
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/archive"]',
    )!;
    expect(link.textContent).toContain('View reported evidence');
    expect(link.target).toBe('_blank');
    expect(link.querySelector('.sr-only')?.textContent).toBe(' (opens in a new tab)');
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('what the timing record says a pending bet commits to', () => {
  it('tells the bettor that agreeing to the bet agrees to the timing too', async () => {
    const pending = createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 2,
        deadline: undefined,
        timing: {
          kind: 'event',
          description: 'The release notes are published',
          checkIn: { at: '2099-01-01T12:00:00.000Z', timezone: 'UTC' },
        },
        cutoff: { at: '2099-01-02T12:00:00.000Z', timezone: 'UTC' },
      },
      'a',
      members,
      longAgo,
    );
    await renderTiming(pending, 'b');
    const note = container.querySelector('.timing-record > .workflow-provenance')!.textContent;
    expect(note).toContain('part of what you agree to');
    expect(note).toContain('claim cutoff');
    expect(note).toContain('initial check-in');
    await renderTiming(activeBet(), 'a');
    expect(container.querySelector('.timing-record > .workflow-provenance')?.textContent).toContain(
      'Timing brings the bet up for review.',
    );
  });
  it('names only the timing parts the proposal has', async () => {
    const pending = createBet(
      {
        title: 'The release ships before Friday',
        terms: 'Decided by the published release notes.',
        category: 'Work',
        creatorSide: 'It ships',
        opponentSide: 'It slips',
        opponentId: 'b',
        stake: 2,
        deadline: undefined,
        timing: { kind: 'date', at: '2099-10-25T16:00:00.000Z', timezone: 'UTC' },
      },
      'a',
      members,
      longAgo,
    );
    await renderTiming(pending, 'b');
    const note = container.querySelector('.timing-record > .workflow-provenance')!.textContent;
    expect(note).toContain('part of what you agree to');
    expect(note).not.toContain('cutoff');
    expect(note).not.toContain('check-in');
  });
});
