import { describe, expect, it } from 'vitest';
import { applyAction, createBet, getDirectDebts, getMemberStats, needsAction } from './ledger';
import {
  agreedTiming,
  betReadiness,
  boundedText,
  betStatusLabel,
  betStatusVariant,
  closureOf,
  decisionTimingLabel,
  HistoryFieldError,
  historyChanges,
  historyDateLabel,
  historyRevisionAfter,
  historyRevisionOf,
  historySummary,
  latestCalendarDay,
  likelyDuplicates,
  pendingNames,
  primaryActionLabel,
  promptMissesEvidence,
  promptQuotesRemovedEvidence,
  reviewStatus,
  textKey,
  validateHistory,
  watcherStatus,
  zonedDateTimeLabel,
} from './bet-workflow';
import { NO_EVIDENCE_YET } from './adjudication';
import { JUDGE_COPY } from '../components/JudgeCopy';
import type {
  BetAction,
  HistoricalInput,
  HistoryAcknowledgements,
  HistoryRevision,
  Member,
  NewBet,
} from './types';

const members: Member[] = ['a', 'b', 'c'].map((id) => ({
  id,
  name: id,
  initials: id,
  color: '#000',
}));
const now = '2026-09-12T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const after = '2026-09-14T12:00:00.000Z';
const input: NewBet = {
  title: 'Friday release',
  terms: 'Ships by the agreed cutoff',
  category: 'Work',
  opponentId: 'b',
  creatorSide: 'Ships',
  opponentSide: 'Delayed',
  stake: 2,
  deadline: '2026-09-13',
};
const acknowledgements: HistoryAcknowledgements = { terms: true, result: true, delivery: true };
const history: HistoricalInput = {
  stage: 'settled',
  originalDate: { precision: 'month', value: '2024-02' },
  result: {
    winnerId: 'a',
    date: { precision: 'day', value: '2024-03-01' },
    note: 'The release shipped.',
  },
  delivery: { date: { precision: 'unknown' }, note: 'Two actual lobster rolls delivered.' },
};
const imported = (overrides: Partial<NewBet> = {}) =>
  createBet({ ...input, history, acknowledgements, ...overrides }, 'a', members, now);
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(
    createBet(
      {
        ...input,
        timing: { kind: 'date', at: due, timezone: 'America/Los_Angeles' },
        ...overrides,
      },
      'a',
      members,
      now,
    ),
    { type: 'accept' },
    'b',
    now,
  );
const result: BetAction = { type: 'propose_result', winnerId: 'a', note: 'Release log evidence' };
const revision = (): HistoryRevision => ({
  ...input,
  history: { ...history, result: { ...history.result!, winnerId: 'b' } },
  stake: 3,
});

describe('reported history and explicit consent', () => {
  it('preserves the original entry source when historical terms are revised and confirmed', () => {
    const bet = createBet({ ...input, history, acknowledgements }, 'a', members, now, 'mcp');
    const revised = applyAction(
      bet,
      { type: 'revise_history', revision: revision(), acknowledgements },
      'a',
      now,
    );
    const confirmed = applyAction(revised, { type: 'confirm_history', acknowledgements }, 'b', now);
    expect(confirmed.entrySource).toBe('mcp');
    expect(confirmed.events[0]).toEqual(bet.events[0]);
  });

  it('keeps imported delivery pending with current audit times and no statistics', () => {
    const bet = imported({ deadline: undefined });
    expect(bet).toMatchObject({
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      deadline: '',
      history: {
        revision: 1,
        proposedBy: 'a',
        approvals: [{ actorId: 'a', at: now, acknowledgements }],
      },
    });
    expect(bet.resolution).toBeUndefined();
    expect(bet.settlement).toBeUndefined();
    expect(getMemberStats([bet], 'a')).toMatchObject({ won: 0, active: 0, owedToYou: 0 });
    expect(getDirectDebts([bet])).toEqual([]);
    expect(bet.events).toHaveLength(bet.version);
  });
  it('requires decision timing for ongoing history when the legacy deadline is absent', () => {
    expect(() =>
      imported({
        deadline: undefined,
        history: { stage: 'active', originalDate: { precision: 'unknown' } },
      }),
    ).toThrow(/decision|timing/i);
  });
  it.each(['terms', 'result', 'delivery'] as const)(
    'rejects omitted %s acknowledgement at import and confirmation',
    (key) => {
      const incomplete = { ...acknowledgements, [key]: false };
      expect(() => imported({ acknowledgements: incomplete })).toThrow(/acknowledge/i);
      expect(() =>
        applyAction(
          imported(),
          { type: 'confirm_history', acknowledgements: incomplete },
          'b',
          now,
        ),
      ).toThrow(/acknowledge/i);
    },
  );
  it.each(['active', 'owed', 'settled', 'voided'] as const)(
    'materializes %s only after the second confirmation',
    (stage) => {
      const proposed: HistoricalInput = {
        ...history,
        stage,
        ...(stage === 'voided' ? { result: { ...history.result!, winnerId: null } } : {}),
      };
      if (stage === 'active') delete proposed.result;
      if (stage !== 'settled') delete proposed.delivery;
      const bet = imported({ history: proposed });
      const confirmed = applyAction(bet, { type: 'confirm_history', acknowledgements }, 'b', after);
      expect(confirmed.status).toBe(stage);
      expect(confirmed.history?.confirmedAt).toBe(after);
      expect(confirmed.agreementApprovals).toEqual(['a', 'b']);
      expect(confirmed.events).toHaveLength(confirmed.version);
      expect(getMemberStats([confirmed], 'a').won).toBe(
        stage === 'owed' || stage === 'settled' ? 1 : 0,
      );
      expect(getDirectDebts([confirmed])).toEqual(
        stage === 'owed' ? [{ fromId: 'b', toId: 'a', rolls: 2 }] : [],
      );
      if (stage === 'settled')
        expect(confirmed.settlement).toMatchObject({ method: 'roll', approvals: ['a', 'b'] });
    },
  );
  it('blocks generic acceptance, self confirmation, outsider confirmation and replay', () => {
    const bet = imported();
    expect(() => applyAction(bet, { type: 'accept' }, 'b', now)).toThrow(/histor/i);
    for (const actor of ['a', 'c'])
      expect(() =>
        applyAction(bet, { type: 'confirm_history', acknowledgements }, actor, now),
      ).toThrow();
    const confirmed = applyAction(bet, { type: 'confirm_history', acknowledgements }, 'b', now);
    expect(() =>
      applyAction(confirmed, { type: 'confirm_history', acknowledgements }, 'b', after),
    ).toThrow();
  });
  it('correction suspends confirmation; revision renews consent and retains the prior immutable snapshot', () => {
    const original = imported();
    const originalCopy = structuredClone(original);
    const correction = applyAction(
      original,
      { type: 'request_history_correction', note: 'Wrong winner and stake.' },
      'b',
      now,
    );
    expect(correction.status).toBe('pending');
    expect(needsAction(correction, 'a', now)).toBe(true);
    expect(needsAction(correction, 'b', now)).toBe(false);
    expect(() =>
      applyAction(correction, { type: 'confirm_history', acknowledgements }, 'b', now),
    ).toThrow(/correction|revis/i);
    const revised = applyAction(
      correction,
      { type: 'revise_history', revision: revision(), acknowledgements },
      'b',
      now,
    );
    expect(revised).toMatchObject({
      stake: 3,
      creatorId: 'a',
      opponentId: 'b',
      status: 'pending',
      agreementApprovals: ['b'],
      history: { proposedBy: 'b', revision: 2, approvals: [{ actorId: 'b' }] },
    });
    expect(revised.history?.correction).toBeUndefined();
    expect(revised.events.at(-1)?.historySnapshot).toMatchObject({
      stake: 2,
      proposal: { result: { winnerId: 'a' }, correction: { note: 'Wrong winner and stake.' } },
    });
    expect(revised.events.slice(0, -1)).toEqual(correction.events);
    const confirmed = applyAction(revised, { type: 'confirm_history', acknowledgements }, 'a', now);
    expect(getMemberStats([confirmed], 'b')).toMatchObject({ won: 1, rollsWon: 3, settled: 3 });
    expect(original).toEqual(originalCopy);
  });
  it('ignores injected revision actors/status and retains original adjudication arrangement', () => {
    const judged = imported({ decisionMethod: 'judge', judgeId: 'c' });
    const amended = applyAction(
      judged,
      {
        type: 'revise_history',
        revision: {
          ...revision(),
          creatorId: 'c',
          opponentId: 'c',
          decisionMethod: 'mutual',
          status: 'settled',
          version: 999,
        } as HistoryRevision,
        acknowledgements,
      },
      'b',
      now,
    );
    expect(amended).toMatchObject({
      creatorId: 'a',
      opponentId: 'b',
      decisionMethod: 'judge',
      judgeId: 'c',
      status: 'pending',
      version: 2,
    });
  });
  it('preserves reported prior adjudication without impersonating a judge or prompt approvals', () => {
    const bet = imported({
      decisionMethod: 'chatgpt',
      history: {
        ...history,
        previousAdjudication: {
          method: 'chatgpt',
          note: 'A previous conversation favored Alex.',
          sourceUrl: 'https://example.com/archive',
        },
      },
    });
    const confirmed = applyAction(bet, { type: 'confirm_history', acknowledgements }, 'b', now);
    expect(confirmed.adjudication).toBeUndefined();
    expect(confirmed.promptAgreement).toBeUndefined();
    expect(getMemberStats([confirmed], 'a').won).toBe(1);
  });
  it.each([
    { ...history, originalDate: { precision: 'day', value: '2024-02-30' } },
    { ...history, originalDate: { precision: 'month', value: '2024-13' } },
    { ...history, originalDate: { precision: 'year', value: '24' } },
    { ...history, result: { ...history.result!, winnerId: 'c' } },
    { ...history, stage: 'voided' },
    { ...history, delivery: undefined },
    { ...history, stage: 'active' },
  ])('rejects inconsistent reported history %j', (value) =>
    expect(() => imported({ history: value as HistoricalInput })).toThrow(),
  );
  it('lets the current history proposer withdraw and the other bettor decline a reported past bet', () => {
    const original = imported();
    expect(() =>
      applyAction(original, { type: 'withdraw', note: 'Wrong bet entirely.' }, 'b', now),
    ).toThrow();
    const withdrawn = applyAction(
      original,
      { type: 'withdraw', note: 'Wrong bet entirely.' },
      'a',
      now,
    );
    expect(withdrawn.status).toBe('declined');
    expect(closureOf(withdrawn)).toBe('withdrawn');
    expect(betStatusLabel(withdrawn)).toBe('Withdrawn');
    expect(getMemberStats([withdrawn], 'a').won).toBe(0);
    const declined = applyAction(
      original,
      { type: 'decline', note: 'I never agreed to this.' },
      'b',
      now,
    );
    expect(declined.status).toBe('declined');
    expect(closureOf(declined)).toBe('declined');
    expect(betStatusLabel(declined)).toBe('Declined');
    expect(betStatusLabel(original)).toBe('Confirming history');
    expect(betStatusVariant(original)).toBe('history');
    expect(betStatusVariant(withdrawn)).toBe('withdrawn');
    expect(betStatusVariant(declined)).toBeUndefined();
    // A requested correction is named, so the ledger and inbox agree with the sheet.
    const corrected = applyAction(
      original,
      { type: 'request_history_correction', note: 'The month is wrong.' },
      'b',
      now,
    );
    expect(betStatusLabel(corrected)).toBe('History needs correction');
    expect(betStatusVariant(corrected)).toBe('correction');
    const revised = applyAction(
      original,
      { type: 'revise_history', revision: revision(), acknowledgements },
      'b',
      now,
    );
    expect(() =>
      applyAction(revised, { type: 'withdraw', note: 'Not my revision.' }, 'a', now),
    ).toThrow();
    expect(applyAction(revised, { type: 'withdraw', note: 'My mistake.' }, 'b', now).status).toBe(
      'declined',
    );
    expect(() =>
      applyAction(revised, { type: 'decline', note: 'Not for me to decline.' }, 'b', now),
    ).toThrow();
    expect(applyAction(revised, { type: 'decline', note: 'Still wrong.' }, 'a', now).status).toBe(
      'declined',
    );
  });
  it('asks the proposer to revise their own report rather than request a correction of it', () => {
    expect(() =>
      applyAction(imported(), { type: 'request_history_correction', note: 'Oops.' }, 'a', now),
    ).toThrow(/revise/i);
    const revised = applyAction(
      imported(),
      { type: 'revise_history', revision: revision(), acknowledgements },
      'b',
      now,
    );
    expect(() =>
      applyAction(revised, { type: 'request_history_correction', note: 'Oops.' }, 'b', now),
    ).toThrow(/revise/i);
    expect(
      applyAction(revised, { type: 'request_history_correction', note: 'Stake is 2.' }, 'a', now)
        .history?.correction,
    ).toMatchObject({ requestedBy: 'a' });
  });
  it('rejects a revision that changes nothing, keeping any correction request open', () => {
    const bet = imported();
    const identical: HistoryRevision = {
      title: ` ${input.title} `,
      terms: input.terms,
      category: input.category,
      creatorSide: input.creatorSide,
      opponentSide: input.opponentSide,
      stake: input.stake,
      deadline: input.deadline,
      history,
    };
    expect(() =>
      applyAction(bet, { type: 'revise_history', revision: identical, acknowledgements }, 'a', now),
    ).toThrow(/changes nothing/i);
    const correction = applyAction(
      bet,
      { type: 'request_history_correction', note: 'The stake was three.' },
      'b',
      now,
    );
    expect(() =>
      applyAction(
        correction,
        { type: 'revise_history', revision: identical, acknowledgements },
        'a',
        now,
      ),
    ).toThrow(/changes nothing/i);
    expect(
      applyAction(
        correction,
        { type: 'revise_history', revision: { ...identical, stake: 3 }, acknowledgements },
        'a',
        now,
      ).history?.correction,
    ).toBeUndefined();
  });
  it('accepts a historical date that is already today somewhere on Earth', () => {
    expect(latestCalendarDay('2026-09-12T12:00:00.000Z')).toBe('2026-09-13');
    expect(latestCalendarDay('2026-09-12T09:59:59.000Z')).toBe('2026-09-12');
    const today = (value: string) =>
      imported({
        deadline: undefined,
        timing: { kind: 'event', description: 'Still running' },
        history: { stage: 'active', originalDate: { precision: 'day', value } },
      }).status;
    expect(today('2026-09-12')).toBe('pending');
    expect(today('2026-09-13')).toBe('pending');
    expect(() => today('2026-09-14')).toThrow(/future/i);
  });
  it('keeps zero-width characters out of every length and comparison', () => {
    const zero = '\u200b\u200c\u200d\u2060\ufeff';
    const limit = { min: 5, max: 20 };
    expect(() => boundedText(`ab${zero}`, 'Title', limit)).toThrow(/between 5 and 20/);
    expect(() => boundedText(`${zero}${zero}`, 'Title', limit)).toThrow(/between 5 and 20/);
    expect(boundedText(`${zero}  abc\u200bde ${zero}`, 'Title', limit)).toBe('abc\u200bde');
    // The most that may be stored still counts what is stored, so padding cannot swell a record.
    expect(() => boundedText(`abc${'\u200b'.repeat(40)}de`, 'Title', limit)).toThrow();
    expect(textKey(' It\u200b  SHIPS\ufeff Friday ')).toBe(textKey('it ships friday'));
    expect(textKey('Ｉt ships')).toBe(textKey('it ships'));
    expect(textKey('It\u200dships')).toBe(textKey('itships'));
  });
  it('flags likely duplicates of a reported past bet between the same two people', () => {
    const existing = applyAction(
      imported(),
      { type: 'confirm_history', acknowledgements },
      'b',
      now,
    );
    const other = createBet({ ...input, opponentId: 'c' }, 'a', members, now);
    const matches = likelyDuplicates(
      [existing, other],
      { ...input, title: 'friday RELEASE', opponentId: 'b' },
      'a',
    );
    expect(matches.map((bet) => bet.id)).toEqual([existing.id]);
    expect(likelyDuplicates([existing], { ...input, title: 'A different wager' }, 'a')).toEqual([]);
    expect(likelyDuplicates([existing], { ...input, opponentId: 'c' }, 'a')).toEqual([]);
    expect(likelyDuplicates([existing], { ...input, stake: 5 }, 'a')).toEqual([]);
    expect(likelyDuplicates([existing], { ...input, opponentId: 'a' }, 'b')).toHaveLength(1);
    const declined = applyAction(
      imported(),
      { type: 'decline', note: 'Never happened.' },
      'b',
      now,
    );
    expect(likelyDuplicates([declined], input, 'a')).toEqual([]);
  });
  it('matches a title written with other punctuation, a different article, accents or width', () => {
    const existing = applyAction(
      imported({ title: 'The Migration finishes before lunch' }),
      { type: 'confirm_history', acknowledgements },
      'b',
      now,
    );
    const match = (title: string, bets = [existing]) =>
      likelyDuplicates(bets, { ...input, title }, 'a').length;
    for (const title of [
      'the migration finishes before lunch',
      'The migration finishes before lunch.',
      'The Migration finishes before lunch!!',
      '“Migration finishes before lunch”',
      'A migration finishes before lunch',
      'Migration finishes before lunch',
      'The migration, finishes before lunch?',
      'The-migration finishes  before lunch',
      'The migrátion finishes before lunch',
      'The migration finishes\u200b before lunch',
      'Ｔhe migration finishes before lunch',
    ])
      expect(match(title), title).toBe(1);
    // A title with its own words or numbers stays a different bet.
    for (const title of [
      'The migration finishes before dinner',
      'Migration finishes before lunch 2',
      'The migration',
      'Another migration finishes before lunch',
      'the',
      '!!!',
      '',
    ])
      expect(match(title), title).toBe(0);
    // An apostrophe is not a word break.
    const dont = applyAction(
      imported({ title: 'Don’t miss the Friday release' }),
      { type: 'confirm_history', acknowledgements },
      'b',
      now,
    );
    expect(match('Dont miss the friday release', [dont])).toBe(1);
  });
  it('flags the same pair and title at another number of rolls when the dates are close', () => {
    const existing = applyAction(
      imported({ stake: 2 }),
      { type: 'confirm_history', acknowledgements },
      'b',
      now,
    );
    const at = (stake: number, originalDate?: HistoricalInput['originalDate']) =>
      likelyDuplicates(
        [existing],
        { ...input, stake, ...(originalDate ? { history: { originalDate } } : {}) },
        'a',
      ).length;
    // The reported Feb 2024 bet at 2 rolls; the same title at 5 rolls made that month, or the
    // next month's first days, reads as the same bet remembered differently.
    expect(at(5, { precision: 'day', value: '2024-02-20' })).toBe(1);
    expect(at(5, { precision: 'month', value: '2024-03' })).toBe(1);
    expect(at(5, { precision: 'day', value: '2024-03-05' })).toBe(1);
    // Far apart, undated or unknown: a repeat of the wager, so only the same number of rolls counts.
    expect(at(5, { precision: 'day', value: '2024-04-01' })).toBe(0);
    expect(at(5, { precision: 'year', value: '2019' })).toBe(0);
    expect(at(5, { precision: 'unknown' })).toBe(0);
    expect(at(5)).toBe(0);
    expect(at(2, { precision: 'day', value: '2019-01-01' })).toBe(1);
    // A bet made on the ledger itself is dated by when it was proposed.
    const proposed = createBet(input, 'a', members, now);
    const near = likelyDuplicates(
      [proposed],
      { ...input, stake: 9, history: { originalDate: { precision: 'day', value: '2026-09-08' } } },
      'a',
    );
    expect(near.map((bet) => bet.id)).toEqual([proposed.id]);
    expect(
      likelyDuplicates(
        [proposed],
        {
          ...input,
          stake: 9,
          history: { originalDate: { precision: 'day', value: '2025-09-08' } },
        },
        'a',
      ),
    ).toEqual([]);
  });
  it('rejects historical dates certainly in the future without guessing unknown dates', () => {
    for (const date of [
      { precision: 'day', value: '2099-01-01' },
      { precision: 'month', value: '2099-01' },
      { precision: 'year', value: '2099' },
    ] as const) {
      expect(() => imported({ history: { ...history, originalDate: date } })).toThrow(/future/i);
      expect(() =>
        imported({ history: { ...history, result: { ...history.result!, date } } }),
      ).toThrow(/future/i);
      expect(() =>
        imported({ history: { ...history, delivery: { ...history.delivery!, date } } }),
      ).toThrow(/future/i);
    }
    expect(
      imported({
        history: {
          ...history,
          originalDate: { precision: 'year', value: '2026' },
          result: { ...history.result!, date: { precision: 'month', value: '2026-09' } },
        },
      }).status,
    ).toBe('pending');
  });
  it('rejects only certain historical chronology contradictions across date precision', () => {
    expect(() =>
      imported({
        history: {
          ...history,
          result: { ...history.result!, date: { precision: 'day', value: '2024-01-31' } },
        },
      }),
    ).toThrow(/before/i);
    expect(() =>
      imported({
        history: {
          ...history,
          delivery: { ...history.delivery!, date: { precision: 'month', value: '2024-02' } },
        },
      }),
    ).toThrow(/before/i);
    expect(
      imported({
        history: {
          ...history,
          delivery: { ...history.delivery!, date: { precision: 'year', value: '2024' } },
        },
      }).status,
    ).toBe('pending');
  });
});

describe('review timing, evidence and mutual changes', () => {
  it('formats reported precision truthfully and includes the agreed named timezone', () => {
    expect(historyDateLabel({ precision: 'unknown' })).toBe('Date unknown');
    expect(historyDateLabel({ precision: 'year', value: '2024' })).toBe('2024');
    expect(historyDateLabel({ precision: 'month', value: '2024-02' })).toBe('February 2024');
    expect(historyDateLabel({ precision: 'day', value: '2024-02-29' })).toBe('February 29, 2024');
    expect(
      decisionTimingLabel({
        kind: 'date',
        at: '2026-09-13T01:00:00Z',
        timezone: 'America/Los_Angeles',
      }),
    ).toContain('Sep 12, 2026');
    expect(
      decisionTimingLabel({ kind: 'date', at: due, timezone: 'America/Los_Angeles' }),
    ).toContain('America/Los_Angeles');
  });
  it('blocks early results, permits the exact boundary, and never automatically creates debt', () => {
    const bet = active();
    expect(() => applyAction(bet, result, 'a', '2026-09-13T11:59:59.999Z')).toThrow(
      /ready|review|timing/i,
    );
    expect(needsAction(bet, 'a', now)).toBe(false);
    expect(needsAction(bet, 'a', due)).toBe(true);
    const proposal = applyAction(bet, result, 'a', due);
    expect(proposal.status).toBe('confirming');
    expect(bet.status).toBe('active');
    expect(getDirectDebts([bet, proposal])).toEqual([]);
  });
  it.each(['event', 'evidence'] as const)(
    'requires evidence readiness for %s without a date and retains normal outcome consent',
    (kind) => {
      const bet = active({
        deadline: undefined,
        timing: {
          kind,
          description: 'The audit report is published',
          source: 'Official audit report',
        },
      });
      expect(() => applyAction(bet, result, 'a', after)).toThrow(/ready|review|timing/i);
      expect(() => applyAction(bet, { type: 'mark_ready', evidence: ' ' }, 'a', after)).toThrow();
      const ready = applyAction(
        bet,
        { type: 'mark_ready', evidence: 'Report published at example.org/report' },
        'a',
        after,
      );
      expect(ready).toMatchObject({
        status: 'active',
        readiness: { markedBy: 'a', at: after, evidence: 'Report published at example.org/report' },
      });
      expect(getDirectDebts([ready])).toEqual([]);
      expect(applyAction(ready, result, 'a', after).status).toBe('confirming');
    },
  );
  it('allows early evidence review but the cutoff itself cannot select a winner or readiness', () => {
    const bet = active({ cutoff: { at: now, timezone: 'UTC' } });
    expect(() => applyAction(bet, result, 'a', now)).toThrow();
    const ready = applyAction(
      bet,
      { type: 'mark_ready', evidence: 'The event has already concluded.' },
      'b',
      now,
    );
    expect(applyAction(ready, result, 'a', now).status).toBe('confirming');
  });
  it('personal check-ins affect only their owner inbox and never change terms or shared decision eligibility', () => {
    const bet = active({ timing: { kind: 'event', description: 'Event completion' } });
    const scheduled = applyAction(
      bet,
      { type: 'set_check_in', checkIn: { at: due, timezone: 'UTC' } },
      'a',
      now,
    );
    expect(scheduled.terms).toBe(bet.terms);
    expect(scheduled.timing).toEqual(bet.timing);
    expect(needsAction(scheduled, 'a', now)).toBe(false);
    expect(needsAction(scheduled, 'a', due)).toBe(true);
    expect(needsAction(scheduled, 'b', due)).toBe(false);
    expect(() => applyAction(scheduled, result, 'a', due)).toThrow();
    const moved = applyAction(
      scheduled,
      { type: 'set_check_in', checkIn: { at: after, timezone: 'UTC' } },
      'a',
      now,
    );
    expect(needsAction(moved, 'a', due)).toBe(false);
    expect(applyAction(moved, { type: 'set_check_in', checkIn: null }, 'a', now).checkIns).toEqual({
      a: null,
    });
  });
  it('shared initial check-in surfaces review but still requires event evidence for an outcome', () => {
    const bet = active({
      timing: {
        kind: 'event',
        description: 'Event completion',
        checkIn: { at: due, timezone: 'UTC' },
      },
    });
    expect(needsAction(bet, 'a', due)).toBe(true);
    expect(needsAction(bet, 'b', due)).toBe(true);
    expect(betReadiness(bet, due, 'a')).toMatchObject({
      ready: false,
      reviewDue: true,
      state: 'waiting',
    });
    expect(() => applyAction(bet, result, 'a', due)).toThrow();
    const dismissed = applyAction(bet, { type: 'set_check_in', checkIn: null }, 'a', now);
    expect(needsAction(dismissed, 'a', due)).toBe(false);
    expect(needsAction(dismissed, 'b', due)).toBe(true);
  });
  it('keeps the bettors’ shared check-in out of the judge’s readiness, which waits on the decision time', () => {
    const judged = active({
      decisionMethod: 'judge',
      judgeId: 'c',
      timing: {
        kind: 'date',
        at: after,
        timezone: 'UTC',
        checkIn: { at: due, timezone: 'UTC' },
      },
    });
    // The check-in has passed; the decision time has not.
    const between = '2026-09-13T18:00:00.000Z';
    expect(betReadiness(judged, between, 'a')).toMatchObject({
      reason: 'check-in',
      reviewDue: true,
      at: due,
    });
    const forJudge = betReadiness(judged, between, 'c');
    expect(forJudge).toMatchObject({ ready: false, reason: 'timing', at: after });
    expect(forJudge.reviewDue).toBeUndefined();
    expect(reviewStatus(judged, between, 'c')).toMatchObject({ tone: 'waiting', title: 'Not yet' });
    // Without a viewer the shared check-in still applies, as it does to the server's checks.
    expect(betReadiness(judged, between)).toMatchObject({ reason: 'check-in', at: due });
  });
  it('still lets a passed claim cutoff bring a judged event bet up for the judge', () => {
    const judged = active({
      decisionMethod: 'judge',
      judgeId: 'c',
      timing: {
        kind: 'event',
        description: 'The merger closes',
        checkIn: { at: due, timezone: 'UTC' },
      },
      cutoff: { at: after, timezone: 'UTC' },
    });
    const later = '2026-09-15T12:00:00.000Z';
    expect(betReadiness(judged, later, 'c')).toMatchObject({ reason: 'cutoff', at: after });
  });
  it('mutual amendment suspends outcomes, needs the other bettor, and clears evidence and prompt consent', () => {
    let bet = active({ decisionMethod: 'chatgpt', cutoff: { at: now, timezone: 'UTC' } });
    bet = applyAction(bet, { type: 'mark_ready', evidence: 'Original evidence' }, 'a', now);
    bet = applyAction(
      bet,
      {
        type: 'propose_prompt',
        text: 'Evaluate both positions fairly using the original criteria.',
      },
      'a',
      now,
    );
    bet = applyAction(bet, { type: 'approve_prompt' }, 'b', now);
    const proposed = applyAction(
      bet,
      {
        type: 'propose_amendment',
        terms: 'Use the final audited result.',
        timing: { kind: 'evidence', description: 'Audited report' },
        note: 'The first report was preliminary.',
      },
      'a',
      now,
    );
    expect(proposed.terms).toBe(input.terms);
    expect(needsAction(proposed, 'b', now)).toBe(true);
    expect(needsAction(proposed, 'a', now)).toBe(false);
    expect(() =>
      applyAction(
        proposed,
        { type: 'adjudicate', winnerId: 'a', note: 'Old recommendation' },
        'a',
        now,
      ),
    ).toThrow(/proposal|amendment/i);
    expect(() => applyAction(proposed, { type: 'confirm_amendment' }, 'a', now)).toThrow();
    const agreed = applyAction(proposed, { type: 'confirm_amendment' }, 'b', now);
    expect(agreed.terms).toBe('Use the final audited result.');
    expect(agreed.readiness).toBeUndefined();
    expect(agreed.promptAgreement).toBeUndefined();
    expect(agreed.cutoff).toBeUndefined();
    expect(agreed.amendment).toBeUndefined();
    expect(agreed.events).toHaveLength(agreed.version);
    expect(
      applyAction(
        agreed,
        {
          type: 'propose_prompt',
          text: 'Evaluate both positions fairly using the revised audited criteria.',
        },
        'a',
        now,
      ).promptAgreement?.version,
    ).toBe(2);
  });
  it('declining an amendment keeps the current agreement and evidence', () => {
    const bet = applyAction(active(), { type: 'mark_ready', evidence: 'Early evidence' }, 'a', now);
    const proposal = applyAction(
      bet,
      {
        type: 'propose_amendment',
        terms: 'Changed criteria',
        timing: { kind: 'date', at: after, timezone: 'UTC' },
        note: 'Review later.',
      },
      'b',
      now,
    );
    const rejected = applyAction(
      proposal,
      { type: 'reject_amendment', note: 'Keep our original agreement.' },
      'a',
      now,
    );
    expect(rejected.terms).toBe(bet.terms);
    expect(rejected.timing).toEqual(bet.timing);
    expect(rejected.readiness).toEqual(bet.readiness);
    expect(rejected.amendment).toBeUndefined();
  });
  it('preserves the exact old agreement and amendment proposal in the immutable audit event', () => {
    const bet = active({ cutoff: { at: now, timezone: 'UTC' } });
    const proposed = applyAction(
      bet,
      {
        type: 'propose_amendment',
        terms: 'Different criteria',
        timing: { kind: 'event', description: 'Final event' },
        cutoff: { at: after, timezone: 'UTC' },
        note: 'Clarify our agreement.',
      },
      'a',
      now,
    );
    expect(proposed.events.at(-1)?.amendmentSnapshot).toMatchObject({
      terms: 'Ships by the agreed cutoff',
      deadline: '2026-09-13',
      timing: { kind: 'date', at: due },
      cutoff: { at: now },
      proposal: {
        terms: 'Different criteria',
        timing: { kind: 'event', description: 'Final event' },
        cutoff: { at: after },
        proposedBy: 'a',
        approvals: ['a'],
      },
    });
    const agreed = applyAction(proposed, { type: 'confirm_amendment' }, 'b', now);
    expect(agreed.deadline).toBe('');
    expect(agreed.events.slice(0, -1)).toEqual(proposed.events);
    expect(bet.terms).toBe('Ships by the agreed cutoff');
  });
  it('no winner proposals require both bettors even on judged bets and suspend the judge', () => {
    const bet = active({ decisionMethod: 'judge', judgeId: 'c' });
    const proposal = applyAction(
      bet,
      { type: 'propose_void', note: 'The event was canceled.' },
      'a',
      now,
    );
    expect(proposal.status).toBe('active');
    expect(needsAction(proposal, 'c', due)).toBe(false);
    expect(() =>
      applyAction(
        proposal,
        { type: 'adjudicate', winnerId: 'a', note: 'Judge recommendation' },
        'c',
        due,
      ),
    ).toThrow();
    expect(() => applyAction(proposal, { type: 'confirm_void' }, 'a', now)).toThrow();
    expect(() => applyAction(proposal, { type: 'confirm_void' }, 'c', now)).toThrow();
    const voided = applyAction(proposal, { type: 'confirm_void' }, 'b', now);
    expect(voided.status).toBe('voided');
    expect(voided.resolution).toMatchObject({ winnerId: null, approvals: ['a', 'b'] });
    expect(getMemberStats([voided], 'a').won).toBe(0);
  });
  it.each([
    { kind: 'date', at: '2026-09-13T12:00:00', timezone: 'UTC' },
    { kind: 'date', at: due, timezone: 'Made/Up' },
    { kind: 'date', at: '2026-02-30T12:00:00Z', timezone: 'UTC' },
    { kind: 'event', description: ' ' },
  ])('rejects invalid structured timing %j', (timing) =>
    expect(() => active({ timing } as Partial<NewBet>)).toThrow(),
  );
  it('preserves legacy immediate outcomes and existing legacy inbox behavior', () => {
    const bet = active({ timing: undefined });
    expect(needsAction(bet, 'a', now)).toBe(false);
    expect(applyAction(bet, result, 'a', now).status).toBe('confirming');
  });
  it('names the one move each person can make from the inbox', () => {
    const name = (id: string) => ({ a: 'Avery', b: 'Blair', c: 'Casey' })[id] ?? id;
    expect(primaryActionLabel(createBet(input, 'a', members, now), 'b', now, name)).toBe(
      'Answer a proposal',
    );
    expect(primaryActionLabel(imported(), 'b', now, name)).toBe('Review and confirm history');
    let bet = applyAction(active(), result, 'a', due);
    expect(primaryActionLabel(bet, 'b', due, name)).toBe('Confirm a result');
    bet = applyAction(bet, { type: 'confirm_result' }, 'b', due);
    expect(primaryActionLabel(bet, 'b', due, name)).toBe('Record delivery · 2 rolls to Avery');
    expect(primaryActionLabel(bet, 'a', due, name)).toBe('Waiting on Blair · 2 rolls');
    bet = applyAction(
      bet,
      { type: 'propose_settlement', method: 'roll', note: 'Delivered at lunch.' },
      'b',
      due,
    );
    expect(primaryActionLabel(bet, 'a', due, name)).toBe('Confirm a delivery');
    const judged = active({ decisionMethod: 'judge', judgeId: 'c' });
    expect(primaryActionLabel(judged, 'c', due, name)).toBe('Record your recommendation');
    expect(primaryActionLabel(judged, 'a', due, name)).toBe('Waiting on the judge');
    const stepped = applyAction(
      judged,
      { type: 'decline_judging', note: 'I cannot be impartial here.' },
      'c',
      due,
    );
    expect(primaryActionLabel(stepped, 'a', due, name)).toBe('Choose a new judge or method');
    const reminder = applyAction(
      active({ timing: { kind: 'event', description: 'Event completion' } }),
      { type: 'set_check_in', checkIn: { at: due, timezone: 'UTC' } },
      'a',
      now,
    );
    expect(primaryActionLabel(reminder, 'a', due, name)).toBe('Add readiness evidence');
    const prompted = applyAction(
      active({ decisionMethod: 'chatgpt' }),
      {
        type: 'propose_prompt',
        text: 'Decide this fairly using only the agreed terms and evidence.',
      },
      'a',
      now,
    );
    expect(primaryActionLabel(prompted, 'b', after, name)).toBe('Approve a prompt');
    expect(primaryActionLabel(prompted, 'a', after, name)).toBe(
      'Waiting on Blair to approve the prompt',
    );
  });
});

describe('timing and waiting copy reads as sentences and names who still has to act', () => {
  const people: Record<string, string> = { a: 'Avery', b: 'Blair', c: 'Casey' };
  const first = (id: string) => people[id] ?? id;
  it('leads event and evidence timing with what the bet is waiting for', () => {
    expect(
      decisionTimingLabel({
        kind: 'event',
        description: 'The final whistle in the championship game',
      }),
    ).toBe('When an event happens: The final whistle in the championship game');
    expect(
      decisionTimingLabel({ kind: 'evidence', description: 'The official results are published' }),
    ).toBe('When evidence is available: The official results are published');
  });
  it('lists only the bettors who have not approved yet', () => {
    const bet = active();
    expect(pendingNames(bet, ['a'], first)).toBe('Blair');
    expect(pendingNames(bet, ['b'], first)).toBe('Avery');
    expect(pendingNames(bet, [], first)).toBe('Avery and Blair');
    expect(pendingNames(bet, ['a', 'b'], first)).toBe('');
  });
  it('gives each review state its own title and a single-punctuated sentence', () => {
    const waiting = active({ timing: { kind: 'event', description: 'The final whistle…' } });
    expect(reviewStatus(waiting, now, 'a')).toMatchObject({ tone: 'waiting', title: 'Not yet' });
    expect(reviewStatus(waiting, now, 'a').detail).toBe(
      'Not ready for review yet. Waiting for the agreed event.',
    );
    const dated = active();
    expect(reviewStatus(dated, now, 'a')).toMatchObject({ tone: 'waiting', title: 'Not yet' });
    expect(reviewStatus(dated, now, 'a').detail).toMatch(
      /^Not ready for review yet\. Review opens/,
    );
    expect(reviewStatus(dated, now, 'a').detail).not.toMatch(/\.\.|…\./);
    expect(reviewStatus(dated, due, 'a')).toMatchObject({
      tone: 'ready',
      title: 'Ready for review',
    });
    const reminder = applyAction(
      active({ timing: { kind: 'event', description: 'Event completion.' } }),
      { type: 'set_check_in', checkIn: { at: due, timezone: 'UTC' } },
      'a',
      now,
    );
    expect(reviewStatus(reminder, due, 'a')).toMatchObject({ tone: 'due', title: 'Check-in due' });
    expect(reviewStatus(reminder, due, 'b')).toMatchObject({ tone: 'waiting' });
    const cutoff = active({
      timing: { kind: 'event', description: 'Event completion' },
      cutoff: { at: due, timezone: 'UTC' },
    });
    expect(reviewStatus(cutoff, after, 'a')).toMatchObject({ tone: 'due', title: 'Cutoff passed' });
    const ready = applyAction(
      waiting,
      { type: 'mark_ready', evidence: 'The match report is out.' },
      'b',
      now,
    );
    expect(reviewStatus(ready, now, 'a')).toMatchObject({ tone: 'ready' });
    const paused = applyAction(
      dated,
      { type: 'propose_void', note: 'The release was cancelled.' },
      'a',
      now,
    );
    expect(reviewStatus(paused, now, 'b')).toMatchObject({ tone: 'paused', title: 'Paused' });
    expect(betReadiness(paused, now, 'b').label).not.toMatch(/other bettor/);
  });
  it('tells someone outside the bet that a cutoff passed, without telling them to add evidence', () => {
    const cutoff = active({
      timing: { kind: 'event', description: 'Event completion' },
      cutoff: { at: due, timezone: 'UTC' },
    });
    // A bettor can act on it; a member who is not one has nothing to add.
    expect(reviewStatus(cutoff, after, 'a').hint).toBe(
      'The claim cutoff has passed. Check whether the evidence is in, then add it.',
    );
    expect(reviewStatus(cutoff, after, 'c')).toMatchObject({
      tone: 'due',
      title: 'Cutoff passed',
      hint: 'The claim cutoff has passed.',
      detail: 'The claim cutoff has passed.',
    });
    // Without a viewer the sentence stays the bettors' own, as the inbox and ledger read it.
    expect(reviewStatus(cutoff, after).hint).toMatch(/then add it\.$/);
  });
  it('labels the judge’s inbox step with the sheet’s recommendation button', () => {
    const judged = active({ decisionMethod: 'judge', judgeId: 'c' });
    expect(primaryActionLabel(judged, 'c', due, first)).toBe(JUDGE_COPY.recordAction);
  });
});

describe('reported history errors and revisions', () => {
  const ongoing = (value: string): HistoricalInput => ({
    stage: 'active',
    originalDate: { precision: 'day', value },
  });
  it('names the original date field when it is after the supplied today', () => {
    let thrown: unknown;
    try {
      validateHistory(ongoing('2026-10-20'), ['a', 'b'], undefined, '2026-10-19');
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(HistoryFieldError);
    expect((thrown as HistoryFieldError).field).toBe('originalDate');
    expect((thrown as HistoryFieldError).message).toMatch(/bet.*made.*future/i);
    expect(() =>
      validateHistory(ongoing('2026-10-19'), ['a', 'b'], undefined, '2026-10-19'),
    ).not.toThrow();
  });
  it('accepts today in Pacific/Auckland, a day ahead of UTC', () => {
    const at = '2026-10-18T12:00:00.000Z';
    const auckland = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(
      new Date(at),
    );
    expect(auckland).toBe('2026-10-19');
    expect(validateHistory(ongoing(auckland), ['a', 'b'], at).originalDate).toEqual({
      precision: 'day',
      value: auckland,
    });
  });
  it('names the later date when the stages are out of order, and an unreadable month', () => {
    const field = (value: HistoricalInput) => {
      try {
        validateHistory(value, ['a', 'b'], now);
      } catch (reason) {
        return reason instanceof HistoryFieldError ? [reason.field, reason.message] : reason;
      }
    };
    expect(
      field({
        ...history,
        result: { ...history.result!, date: { precision: 'day', value: '2024-01-31' } },
      }),
    ).toEqual(['result.date', expect.stringMatching(/before the bet was made/)]);
    expect(
      field({
        ...history,
        delivery: { ...history.delivery!, date: { precision: 'month', value: '2024-02' } },
      }),
    ).toEqual(['delivery.date', expect.stringMatching(/before the outcome was decided/)]);
    expect(
      field({ ...history, originalDate: { precision: 'month', value: 'March 2024' } }),
    ).toEqual(['originalDate', expect.stringMatching(/2024-03/)]);
  });
  it('lists what a revision changed, including a legacy decision date', () => {
    const before: HistoryRevision = { ...input, stake: 1, history };
    expect(historyChanges(before, { ...before, stake: 2 })).toEqual([
      { label: 'Stake', from: '1', to: '2' },
    ]);
    expect(historyChanges(before, { ...before, deadline: '2026-09-20' })).toEqual([
      { label: 'Decision date', from: 'September 13, 2026', to: 'September 20, 2026' },
    ]);
    const retimed = historyChanges(before, {
      ...before,
      deadline: undefined,
      timing: { kind: 'event', description: 'The release ships' },
    });
    expect(retimed.map((change) => change.label)).toEqual(['Decision date', 'Timing']);
    expect(retimed[0]).toEqual({ label: 'Decision date', from: 'September 13, 2026', to: 'None' });
    const named = historyChanges(
      before,
      {
        ...before,
        opponentSide: 'Slips',
        history: { ...history, result: { ...history.result!, winnerId: 'b' } },
      },
      { creator: 'Avery', opponent: 'Blair', name: (id) => (id === 'a' ? 'Avery' : 'Blair') },
    );
    expect(named).toEqual([
      { label: 'Blair’s position', from: 'Delayed', to: 'Slips' },
      { label: 'Winner', from: 'Avery', to: 'Blair' },
    ]);
    expect(historyChanges(before, structuredClone(before))).toEqual([]);
  });
  it('reads what each revision replaced and what replaced it from the paper trail', () => {
    const first = imported();
    const second = applyAction(
      first,
      {
        type: 'revise_history',
        revision: { ...historyRevisionOf(first), stake: 3 },
        acknowledgements,
      },
      'b',
      now,
    );
    const third = applyAction(
      second,
      {
        type: 'revise_history',
        revision: { ...historyRevisionOf(second), title: 'Friday release, again' },
        acknowledgements,
      },
      'a',
      now,
    );
    const [one, two] = third.events.filter((event) => event.historySnapshot);
    expect(historyChanges(one.historySnapshot!, historyRevisionAfter(third, one.id)!)).toEqual([
      { label: 'Stake', from: '2', to: '3' },
    ]);
    expect(historyChanges(two.historySnapshot!, historyRevisionAfter(third, two.id)!)).toEqual([
      { label: 'Bet', from: 'Friday release', to: 'Friday release, again' },
    ]);
  });
  it('names a timezone once: UTC is not repeated, a place name follows its abbreviation', () => {
    expect(zonedDateTimeLabel({ at: '2024-02-10T15:30:00Z', timezone: 'UTC' })).toBe(
      'Feb 10, 2024, 3:30 PM UTC',
    );
    expect(zonedDateTimeLabel({ at: '2024-02-10T15:30:00Z', timezone: 'America/New_York' })).toBe(
      'Feb 10, 2024, 10:30 AM EST (America/New_York)',
    );
  });
  it('sums up a reported past bet in a sentence, with the grammar of one roll', () => {
    const name = (id: string) => (id === 'a' ? 'Avery' : 'Blair');
    const one = { stake: 1, creatorId: 'a', opponentId: 'b' };
    const date = { precision: 'unknown' } as const;
    const result = (winnerId: string | null) => ({ winnerId, date, note: 'Decided.' });
    expect(historySummary(one, { stage: 'owed', result: result('b') }, name)).toBe(
      'Blair won. Avery owes Blair 1 lobster roll.',
    );
    expect(historySummary(one, { stage: 'settled', result: result('a') }, name)).toBe(
      'Avery won, and the lobster roll was delivered. Nothing is owed.',
    );
    expect(historySummary({ ...one, stake: 4 }, { stage: 'active' }, name)).toBe(
      'Still ongoing, with 4 lobster rolls at stake.',
    );
  });
});

describe('what everyone else sees about a bet they are not part of', () => {
  const people: Record<string, string> = { a: 'Avery', b: 'Blair', c: 'Casey' };
  const first = (id: string) => people[id] ?? id;
  const evidence = { type: 'mark_ready', evidence: 'The release log shows Thursday.' } as const;
  it('names whose move it is at each step', () => {
    const proposed = createBet(input, 'a', members, now);
    expect(watcherStatus(proposed, first, now)).toBe('Waiting for Blair to agree.');
    expect(watcherStatus(active(), first, now)).toBe(
      'Not ready for review yet. Review opens at the agreed decision time.',
    );
    expect(watcherStatus(active(), first, after)).toBe(
      'Waiting for Avery or Blair to propose a result.',
    );
    const confirming = applyAction(active(), result, 'a', after);
    expect(watcherStatus(confirming, first, after)).toBe(
      'Waiting for Blair to confirm the result.',
    );
    const owed = applyAction(confirming, { type: 'confirm_result' }, 'b', after);
    expect(watcherStatus(owed, first, after)).toBe(
      'Waiting for Blair to deliver 2 lobster rolls to Avery.',
    );
    const settling = applyAction(
      owed,
      { type: 'propose_settlement', method: 'roll', note: 'Two rolls at lunch.' },
      'b',
      after,
    );
    expect(watcherStatus(settling, first, after)).toBe(
      'Waiting for Avery to confirm the delivery.',
    );
    const settled = applyAction(settling, { type: 'confirm_settlement' }, 'a', after);
    expect(watcherStatus(settled, first, after)).toBe('');
  });
  it('names the judge while a judged bet waits on their recommendation', () => {
    const judged = active({ decisionMethod: 'judge', judgeId: 'c' });
    expect(watcherStatus(judged, first, after)).toBe(JUDGE_COPY.waiting('Casey'));
    const stepped = applyAction(
      judged,
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
      now,
    );
    expect(watcherStatus(stepped, first, after)).toBe(
      'Casey stepped down as judge. Waiting for Avery and Blair to choose a new judge or another way to decide.',
    );
    const recorded = applyAction(
      judged,
      { type: 'adjudicate', winnerId: 'a', note: 'Shipped Thursday.' },
      'c',
      after,
    );
    expect(watcherStatus(recorded, first, after)).toBe(
      'Waiting for Avery and Blair to confirm the result.',
    );
  });
  it('follows a ChatGPT prompt, an open proposal and a reported past bet', () => {
    const chatgpt = active({ decisionMethod: 'chatgpt' });
    expect(watcherStatus(chatgpt, first, now)).toBe(
      'Waiting for Avery and Blair to agree on a ChatGPT prompt.',
    );
    const prompted = applyAction(
      chatgpt,
      { type: 'propose_prompt', text: 'Decide this fairly using only the agreed terms.' },
      'a',
      now,
    );
    expect(watcherStatus(prompted, first, now)).toBe('Waiting for Blair to approve prompt v1.');
    const agreed = applyAction(prompted, { type: 'approve_prompt' }, 'b', now);
    expect(watcherStatus(agreed, first, after)).toBe(
      'Waiting for Avery or Blair to record ChatGPT’s response.',
    );
    const changes = applyAction(
      active(),
      {
        type: 'propose_amendment',
        terms: 'Ships by the agreed cutoff, per the release log.',
        timing: { kind: 'date', at: due, timezone: 'UTC' },
        note: 'Name the source.',
      },
      'a',
      now,
    );
    expect(watcherStatus(changes, first, now)).toBe(
      'Waiting for Blair to answer Avery’s proposed changes.',
    );
    const callOff = applyAction(active(), { type: 'propose_void', note: 'Cancelled.' }, 'b', now);
    expect(watcherStatus(callOff, first, now)).toBe(
      'Waiting for Avery to answer Blair’s proposal to call the bet off.',
    );
    expect(watcherStatus(imported(), first, now)).toBe(
      'Waiting for Blair to confirm the reported history.',
    );
    const corrected = applyAction(
      imported(),
      { type: 'request_history_correction', note: 'The month is wrong.' },
      'b',
      now,
    );
    expect(watcherStatus(corrected, first, now)).toBe(
      'Waiting for Avery or Blair to revise the reported history.',
    );
  });
  it('says when the evidence is due rather than asking the watcher to add it', () => {
    const cutoff = active({
      timing: { kind: 'event', description: 'Event completion' },
      cutoff: { at: due, timezone: 'UTC' },
    });
    expect(watcherStatus(cutoff, first, after)).toBe(
      'Waiting for Avery or Blair to check whether the evidence is in.',
    );
    const ready = applyAction(cutoff, evidence, 'b', after);
    expect(watcherStatus(ready, first, after)).toBe(
      'Waiting for Avery or Blair to propose a result.',
    );
  });
});

describe('an agreed ChatGPT prompt that misses the evidence', () => {
  const name = (id: string) => ({ a: 'Avery', b: 'Blair' })[id] ?? id;
  const text = 'Decide this fairly using only the agreed terms and evidence.';
  const chatgpt = () =>
    active({
      decisionMethod: 'chatgpt',
      timing: { kind: 'evidence', description: 'The league posts final standings' },
    });
  const agree = (bet: ReturnType<typeof active>, prompt = text) =>
    applyAction(
      applyAction(bet, { type: 'propose_prompt', text: prompt }, 'a', now),
      { type: 'approve_prompt' },
      'b',
      now,
    );
  const evidence = {
    type: 'mark_ready',
    evidence: 'Final standings: Avery 2nd, Blair 5th.',
  } as const;
  it('is judged by the prompt’s text, whenever the evidence was added', () => {
    expect(promptMissesEvidence(agree(chatgpt()))).toBe(false);
    // Evidence added first and a prompt written afterwards without it still misses it.
    const evidenceFirst = agree(applyAction(chatgpt(), evidence, 'b', now));
    expect(promptMissesEvidence(evidenceFirst)).toBe(true);
    const included = agree(
      applyAction(chatgpt(), evidence, 'b', now),
      `${text}\n\nEvidence to assess:\n${evidence.evidence}`,
    );
    expect(promptMissesEvidence(included)).toBe(false);
    const afterwards = applyAction(agree(chatgpt()), evidence, 'b', after);
    expect(promptMissesEvidence(afterwards)).toBe(true);
  });
  it('makes adding the evidence the inbox move, not recording a response', () => {
    const stale = applyAction(agree(chatgpt()), evidence, 'b', after);
    expect(primaryActionLabel(stale, 'a', after, name)).toBe('Add evidence to the prompt');
    const included = agree(
      applyAction(chatgpt(), evidence, 'b', now),
      `${text}\n\nEvidence to assess:\n${evidence.evidence}`,
    );
    expect(primaryActionLabel(included, 'a', after, name)).toBe('Record ChatGPT response');
  });
});

describe('an agreed ChatGPT prompt that still quotes evidence that came off the bet', () => {
  const name = (id: string) => ({ a: 'Avery', b: 'Blair' })[id] ?? id;
  const text = 'Decide this fairly using only the agreed terms and evidence.';
  const quoted = 'Final standings posted 22:41: Blair’s team 2nd, Avery’s 5th.';
  const chatgpt = () =>
    active({
      decisionMethod: 'chatgpt',
      timing: { kind: 'evidence', description: 'The league posts final standings' },
    });
  const marked = (by = 'b', evidence = quoted) =>
    applyAction(chatgpt(), { type: 'mark_ready', evidence }, by, now);
  // Evidence first, then a prompt that was written with it in, which both approve.
  const agreedWith = (bet: ReturnType<typeof chatgpt>, ...evidence: string[]) =>
    applyAction(
      applyAction(
        bet,
        { type: 'propose_prompt', text: `${text}\n\nEvidence to assess:\n${evidence.join('\n')}` },
        'a',
        now,
      ),
      { type: 'approve_prompt' },
      'b',
      now,
    );
  const disagreed = () =>
    applyAction(
      agreedWith(marked(), quoted),
      { type: 'dispute_readiness', note: 'That table is last season’s.' },
      'a',
      after,
    );

  it('names the evidence the other bettor disagreed with, who did, and that the prompt quotes it', () => {
    expect(promptQuotesRemovedEvidence(disagreed())).toEqual([
      { evidence: quoted, by: 'a', how: 'disagreed' },
    ]);
  });

  it('names evidence its author took back', () => {
    const withdrawn = applyAction(
      agreedWith(marked(), quoted),
      { type: 'withdraw_proposal', note: 'Wrong table.' },
      'b',
      after,
    );
    expect(promptQuotesRemovedEvidence(withdrawn)).toEqual([
      { evidence: quoted, by: 'b', how: 'withdrawn' },
    ]);
  });

  it('names evidence its author replaced with a newer version', () => {
    const replaced = applyAction(
      agreedWith(marked(), quoted),
      { type: 'mark_ready', evidence: 'The corrected table.' },
      'b',
      after,
    );
    expect(promptQuotesRemovedEvidence(replaced)).toEqual([
      { evidence: quoted, by: 'b', how: 'replaced' },
    ]);
  });

  it('does not take a longer version of the evidence for the evidence it replaced', () => {
    // The old text is part of the new, so a prompt that quotes the new one quotes the old as well.
    const extended = `${quoted} Confirmed on the league site.`;
    const replaced = applyAction(marked(), { type: 'mark_ready', evidence: extended }, 'b', now);
    const reagreed = agreedWith(replaced, extended);
    expect(promptQuotesRemovedEvidence(reagreed)).toEqual([]);
    expect(primaryActionLabel(reagreed, 'a', after, name)).toBe('Record ChatGPT response');
    // A prompt that really does hold the shorter text beside it still quotes it.
    expect(
      promptQuotesRemovedEvidence(agreedWith(replaced, extended, quoted)).map((item) => item.how),
    ).toEqual(['replaced']);
  });

  it('still names the longer version when a shorter one has replaced it', () => {
    const extended = `${quoted} Confirmed on the league site.`;
    const replaced = applyAction(
      agreedWith(marked('b', extended), extended),
      { type: 'mark_ready', evidence: quoted },
      'b',
      after,
    );
    expect(promptQuotesRemovedEvidence(replaced)).toEqual([
      { evidence: extended, by: 'b', how: 'replaced' },
    ]);
  });

  describe('when the evidence is the address the bet expects it at', () => {
    const url = 'https://league.example/standings';
    const sourced = () =>
      active({
        decisionMethod: 'chatgpt',
        timing: { kind: 'evidence', description: 'The league posts standings', source: url },
      });
    const agreedText = (bet: ReturnType<typeof sourced>, prompt: string) =>
      applyAction(
        applyAction(bet, { type: 'propose_prompt', text: prompt }, 'a', now),
        { type: 'approve_prompt' },
        'b',
        now,
      );
    const dispute = (bet: ReturnType<typeof sourced>) =>
      applyAction(bet, { type: 'dispute_readiness', note: 'Wrong page.' }, 'a', after);
    const source = `${text}\nExpected evidence source: ${url}\n\n`;

    it('does not call the source line the evidence', () => {
      // A prompt drafted before any evidence names the address once, as where to look.
      const drafted = agreedText(
        applyAction(sourced(), { type: 'mark_ready', evidence: url }, 'b', now),
        `${source}Evidence to assess:\n${NO_EVIDENCE_YET}`,
      );
      expect(promptQuotesRemovedEvidence(dispute(drafted))).toEqual([]);
    });

    it('still names the address when the evidence section quotes it', () => {
      const quotedBoth = agreedText(
        applyAction(sourced(), { type: 'mark_ready', evidence: url }, 'b', now),
        `${source}Evidence to assess:\n${url}`,
      );
      expect(promptQuotesRemovedEvidence(dispute(quotedBoth))).toEqual([
        { evidence: url, by: 'a', how: 'disagreed' },
      ]);
    });
  });

  it('says nothing while the evidence is still on the bet, or once the prompt no longer quotes it', () => {
    expect(promptQuotesRemovedEvidence(agreedWith(marked(), quoted))).toEqual([]);
    const cleaned = applyAction(
      applyAction(disagreed(), { type: 'propose_prompt', text }, 'a', after),
      { type: 'approve_prompt' },
      'b',
      after,
    );
    expect(promptQuotesRemovedEvidence(cleaned)).toEqual([]);
    // No prompt, nothing quoted.
    expect(
      promptQuotesRemovedEvidence(
        applyAction(marked(), { type: 'dispute_readiness', note: 'No.' }, 'a', after),
      ),
    ).toEqual([]);
  });

  it('still names the old evidence when newer evidence has been added in its place', () => {
    const again = applyAction(
      disagreed(),
      { type: 'mark_ready', evidence: 'The corrected table.' },
      'a',
      after,
    );
    expect(promptQuotesRemovedEvidence(again)).toEqual([
      { evidence: quoted, by: 'a', how: 'disagreed' },
    ]);
    // The prompt also lacks the new evidence, which the other check still reports.
    expect(promptMissesEvidence(again)).toBe(true);
  });

  it('makes taking it out the inbox move, ahead of recording a response', () => {
    const ready = applyAction(
      agreedWith(
        applyAction(
          active({ decisionMethod: 'chatgpt' }),
          { type: 'mark_ready', evidence: quoted },
          'b',
          now,
        ),
        quoted,
      ),
      { type: 'dispute_readiness', note: 'Last season’s.' },
      'a',
      now,
    );
    // The date has passed, so the bet is ready for review without evidence.
    expect(primaryActionLabel(ready, 'a', after, name)).toBe('Remove evidence from the prompt');
    const cleaned = applyAction(
      applyAction(ready, { type: 'propose_prompt', text }, 'a', now),
      { type: 'approve_prompt' },
      'b',
      now,
    );
    expect(primaryActionLabel(cleaned, 'a', after, name)).toBe('Record ChatGPT response');
  });
});

describe('a legacy decision date as timing', () => {
  it('reads as 12:00 AM UTC that day, and leaves real timing alone', () => {
    expect(agreedTiming({ deadline: '2026-09-30' })).toEqual({
      kind: 'date',
      at: '2026-09-30T00:00:00.000Z',
      timezone: 'UTC',
    });
    const timing = { kind: 'event', description: 'The match ends' } as const;
    expect(agreedTiming({ deadline: '2026-09-30', timing })).toBe(timing);
    expect(agreedTiming({ deadline: '' })).toBeUndefined();
  });
});
