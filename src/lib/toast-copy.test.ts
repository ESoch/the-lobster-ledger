import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyAction, createBet } from './ledger';
import {
  actionCopy,
  actionToast,
  archiveExportToast,
  betCreatedToast,
  exportToast,
  pricesExportToast,
  marketExportToast,
  FALLBACK_TOAST,
  memberSwitchedToast,
  offsetToast,
  priceAlreadyRecordedToast,
  priceCorrectedToast,
  priceSavedToast,
  priceWithdrawnToast,
} from './toast-copy';
import type { Bet, BetAction, Member, NewBet } from './types';

const members: Member[] = [
  { id: 'a', name: 'Alex', initials: 'AL', color: '#153b3e' },
  { id: 'b', name: 'Blair', initials: 'BL', color: '#bd4938' },
  { id: 'c', name: 'Casey', initials: 'CA', color: '#7e9188' },
];
const now = '2026-09-01T12:00:00.000Z';
const input: NewBet = {
  title: 'The launch ships on Friday',
  terms: 'Production deployment before 5 pm Boston time.',
  category: 'Work',
  opponentId: 'b',
  creatorSide: 'It ships on time',
  opponentSide: 'It slips',
  stake: 2,
  deadline: '2026-09-05',
};
const pending = (overrides: Partial<NewBet> = {}) =>
  createBet({ ...input, ...overrides }, 'a', members, now);
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(pending(overrides), { type: 'accept' }, 'b', now);
// Alex proposes that Alex won; Blair has not answered yet.
const confirming = (stake = 2) =>
  applyAction(
    active({ stake }),
    { type: 'propose_result', winnerId: 'a', note: 'The release is live.' },
    'a',
    now,
  );
const owed = (stake = 2) => applyAction(confirming(stake), { type: 'confirm_result' }, 'b', now);
const settling = (stake = 2) =>
  applyAction(
    owed(stake),
    { type: 'propose_settlement', method: 'roll', note: 'Delivered at lunch.' },
    'b',
    now,
  );
const judged = () => {
  const bet = active({ decisionMethod: 'judge', judgeId: 'c' });
  return applyAction(bet, { type: 'adjudicate', winnerId: 'a', note: 'Alex was right.' }, 'c', now);
};

const toast = (bet: Bet, action: BetAction, actorId: string) =>
  actionToast({ bet, action, members, actorId });

// Actions still joining the union (see toast-copy.ts) are sampled too, but not required by the type.
type ComingSoon = 'withdraw' | 'withdraw_proposal' | 'decline_judging';
const later = (type: ComingSoon) => ({ type, note: 'Changed my mind.' }) as unknown as BetAction;
// A sample action for every member of BetAction. Typed as a Record, so adding a member to the union
// without a sample here is a compile error, which keeps this suite honest too.
const samples: Record<Exclude<BetAction['type'], ComingSoon>, BetAction> &
  Partial<Record<ComingSoon, BetAction>> = {
  withdraw: later('withdraw'),
  withdraw_proposal: later('withdraw_proposal'),
  decline_judging: later('decline_judging'),
  confirm_history: {
    type: 'confirm_history',
    acknowledgements: { terms: true, result: true, delivery: true },
  },
  request_history_correction: { type: 'request_history_correction', note: 'Wrong date.' },
  revise_history: {
    type: 'revise_history',
    revision: {} as never,
    acknowledgements: { terms: true, result: true, delivery: true },
  },
  mark_ready: { type: 'mark_ready', evidence: 'The page is live.' },
  dispute_readiness: { type: 'dispute_readiness', note: 'That page is a draft.' },
  set_check_in: { type: 'set_check_in', checkIn: null },
  propose_amendment: {
    type: 'propose_amendment',
    terms: 'New terms.',
    timing: { kind: 'date', at: now, timezone: 'UTC' },
    note: 'Dates moved.',
  },
  confirm_amendment: { type: 'confirm_amendment' },
  reject_amendment: { type: 'reject_amendment', note: 'No.' },
  propose_void: { type: 'propose_void', note: 'Cancelled.' },
  confirm_void: { type: 'confirm_void' },
  reject_void: { type: 'reject_void', note: 'No.' },
  accept: { type: 'accept' },
  decline: { type: 'decline', note: 'Not for me.' },
  propose_result: { type: 'propose_result', winnerId: 'a', note: 'It shipped.' },
  adjudicate: { type: 'adjudicate', winnerId: 'a', note: 'Alex was right.' },
  propose_prompt: { type: 'propose_prompt', text: 'Decide this fairly, citing sources.' },
  approve_prompt: { type: 'approve_prompt' },
  confirm_result: { type: 'confirm_result' },
  dispute_result: { type: 'dispute_result', note: 'It slipped.' },
  propose_settlement: { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
  confirm_settlement: { type: 'confirm_settlement' },
  dispute_settlement: { type: 'dispute_settlement', note: 'Nothing arrived.' },
};

/** Every `type: '...'` literal inside the BetAction union, read from the source of truth. */
function betActionTypes(): string[] {
  const source = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
  const union = source.slice(
    source.indexOf('export type BetAction'),
    source.indexOf('export interface LedgerState'),
  );
  return [...union.matchAll(/type: '([a-z_]+)'/g)].map((match) => match[1]);
}

describe('action toast coverage', () => {
  it('reads the BetAction union from types.ts', () => {
    expect(betActionTypes().length).toBeGreaterThanOrEqual(22);
    expect(betActionTypes()).toContain('decline');
  });

  it('has a specific message for every BetAction member', () => {
    for (const type of betActionTypes()) {
      expect(actionCopy, `no toast copy for ${type}`).toHaveProperty(type);
      expect(typeof (actionCopy as Record<string, unknown>)[type]).toBe('function');
    }
  });

  it.each(Object.keys(samples) as (keyof typeof samples)[])(
    'says something specific for %s, never the fallback',
    (type) => {
      const message = toast(active(), samples[type]!, 'b');
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toBe(FALLBACK_TOAST);
      expect(message).not.toMatch(/undefined|null|\[object/);
    },
  );

  it('falls back to a neutral line only for an unknown type', () => {
    expect(toast(active(), { type: 'brand_new' } as unknown as BetAction, 'b')).toBe(
      'Recorded on the ledger.',
    );
  });

  it('never repeats the generic confirmation line', () => {
    for (const sample of Object.values(samples)) {
      expect(toast(active(), sample, 'b')).not.toContain('Your confirmation has been recorded');
    }
  });
});

describe('decline and the two disputes', () => {
  it('never say "confirmation"', () => {
    const cases: [Bet, BetAction, string][] = [
      [pending(), samples.decline, 'b'],
      [confirming(), samples.dispute_result, 'b'],
      [judged(), samples.dispute_result, 'a'],
      [settling(), samples.dispute_settlement, 'a'],
    ];
    for (const [bet, action, actor] of cases) {
      expect(toast(bet, action, actor).toLowerCase()).not.toContain('confirmation');
    }
  });

  it('declining names the proposer and says the bet stays on the ledger as declined', () => {
    const message = toast(pending(), samples.decline, 'b');
    expect(message).toContain('Alex');
    expect(message).toMatch(/declined/i);
  });

  it('disagreeing says the bet is back in play and nothing is owed', () => {
    const message = toast(confirming(), samples.dispute_result, 'b');
    expect(message).toMatch(/disagreed/i);
    expect(message).toMatch(/back in play/i);
    expect(message).toMatch(/nothing is owed/i);
  });

  it('disagreeing with a judge recommendation names the recommendation', () => {
    expect(toast(judged(), samples.dispute_result, 'a')).toMatch(/recommendation/i);
  });

  it('disputing a delivery says who still owes whom, and how many rolls, to the reader', () => {
    const message = toast(settling(3), samples.dispute_settlement, 'a');
    // The button says Disagree, so the confirmation does too.
    expect(message).toMatch(/^You disagreed with the delivery report\. /);
    expect(message).not.toMatch(/dispute/i);
    expect(message).toContain('Blair still owes you 3 lobster rolls');
    expect(message).not.toContain('Alex');
    expect(message).toContain('until one of you records a delivery and the other confirms it');
    // The winner reported it and the loser disagrees: the loser reads "you", never their own name.
    const winnerReported = applyAction(
      owed(3),
      { type: 'propose_settlement', method: 'roll', note: 'Got them at lunch.' },
      'a',
      now,
    );
    const loser = toast(winnerReported, samples.dispute_settlement, 'b');
    expect(loser).toContain('You still owe Alex 3 lobster rolls');
    expect(loser).not.toContain('Blair');
  });
});

describe('results', () => {
  it('proposing a result names the winner, the loser, the rolls and who must answer', () => {
    const message = toast(active(), { ...samples.propose_result, winnerId: 'a' } as BetAction, 'a');
    expect(message).toContain('Alex wins');
    expect(message).toContain('Blair owes 2 lobster rolls');
    expect(message).toContain('Blair must confirm');
  });

  it('proposing no winner says nobody wins', () => {
    const message = toast(active(), { type: 'propose_result', winnerId: null, note: 'Void.' }, 'a');
    expect(message).toMatch(/nobody wins|no winner/i);
    expect(message).toContain('Blair must confirm');
  });

  it('confirming with one prior approval is final and says who owes what', () => {
    const message = toast(confirming(1), samples.confirm_result, 'b');
    expect(message).toContain('owes');
    expect(message).toContain('Blair owes Alex 1 lobster roll.');
  });

  it('confirming a no-winner result says no rolls are owed', () => {
    const bet = applyAction(
      active(),
      { type: 'propose_result', winnerId: null, note: 'Void.' },
      'a',
      now,
    );
    const message = toast(bet, samples.confirm_result, 'b');
    expect(message).toMatch(/no winner/i);
    expect(message).toMatch(/no rolls are owed/i);
    expect(message).not.toContain('owes');
  });

  it('the first confirmation of a judge recommendation waits for the other bettor', () => {
    const message = toast(judged(), samples.confirm_result, 'a');
    expect(message).toContain('Blair must still confirm');
    expect(message).not.toContain('owes');
  });

  it('the judge recommendation names the winner and both bettors', () => {
    const message = toast(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      samples.adjudicate,
      'c',
    );
    expect(message).toContain('Alex wins');
    expect(message).toContain('Alex and Blair must each confirm');
  });
});

describe('delivery', () => {
  it('reporting a delivery counts the rolls and names who must answer', () => {
    const message = toast(owed(2), samples.propose_settlement, 'b');
    expect(message).toContain('2 lobster rolls');
    expect(message).toContain('Alex must confirm');
  });

  it('uses the singular for one roll', () => {
    expect(toast(owed(1), samples.propose_settlement, 'b')).toContain('1 lobster roll ');
  });

  it('confirming a delivery says who delivered to whom', () => {
    const message = toast(settling(2), samples.confirm_settlement, 'a');
    expect(message).toContain('Blair delivered 2 lobster rolls to Alex');
    expect(message).toMatch(/settled/i);
  });
});

describe('prompts and amendments', () => {
  it('proposing a prompt names the next version and who must approve it', () => {
    const chatgpt = active({ decisionMethod: 'chatgpt' });
    expect(toast(chatgpt, samples.propose_prompt, 'a')).toContain('Prompt version 1 proposed');
    const proposed = applyAction(chatgpt, samples.propose_prompt, 'a', now);
    const message = toast(
      proposed,
      { type: 'propose_prompt', text: 'A rewritten prompt, please.' },
      'b',
    );
    expect(message).toContain('Prompt version 2 proposed');
    expect(message).toContain('Alex must approve');
  });

  it('approving a prompt says both bettors agreed on that version', () => {
    const chatgpt = applyAction(
      active({ decisionMethod: 'chatgpt' }),
      samples.propose_prompt,
      'a',
      now,
    );
    const message = toast(chatgpt, samples.approve_prompt, 'b');
    expect(message).toContain('version 1');
    expect(message).toMatch(/you and Alex/i);
  });

  it('proposing an amendment says who must respond, and does not promise an evidence review', () => {
    const message = toast(active(), samples.propose_amendment, 'a');
    expect(message).toContain('Blair must agree');
    const agreed = toast(active(), samples.confirm_amendment, 'b');
    expect(agreed).not.toMatch(/evidence/i);
  });
});

describe('confirming a reported history', () => {
  const acknowledgements = { terms: true, result: true, delivery: true };
  const reported = (history: NewBet['history'], stake = 2): Bet =>
    createBet({ ...input, stake, history, acknowledgements }, 'a', members, now);
  const unknown = { precision: 'unknown' } as const;
  const confirm = (bet: Bet) => toast(bet, { type: 'confirm_history', acknowledgements }, 'b');

  it('names the debt when the reported bet is already decided', () => {
    const owed = reported({
      stage: 'owed',
      originalDate: unknown,
      result: { winnerId: 'a', date: unknown, note: 'The release shipped.' },
    });
    const message = confirm(owed);
    expect(message).toContain('Alex');
    expect(message).toContain('Blair owes Alex 2 lobster rolls');
  });

  it('says the debt was paid when the reported bet is already settled', () => {
    const settled = reported({
      stage: 'settled',
      originalDate: unknown,
      result: { winnerId: 'b', date: unknown, note: 'The release slipped.' },
      delivery: { date: unknown, note: 'Two rolls were delivered.' },
    });
    const message = confirm(settled);
    expect(message).toContain('Alex delivered 2 lobster rolls to Blair');
    expect(message).toMatch(/settled/i);
  });

  it('says no rolls are owed when the reported bet was called off', () => {
    const voided = reported({
      stage: 'voided',
      originalDate: unknown,
      result: { winnerId: null, date: unknown, note: 'Called off.' },
    });
    expect(confirm(voided)).toMatch(/no winner.*no rolls are owed/i);
  });

  it('says the bet is in play when the reported bet is still ongoing', () => {
    const ongoing = reported({ stage: 'active', originalDate: unknown });
    const message = confirm(ongoing);
    expect(message).toMatch(/in play/i);
    expect(message).not.toContain('owes');
  });

  it('differs for every stage', () => {
    const stages = [
      reported({ stage: 'active', originalDate: unknown }),
      reported({
        stage: 'owed',
        originalDate: unknown,
        result: { winnerId: 'a', date: unknown, note: 'x' },
      }),
      reported({
        stage: 'voided',
        originalDate: unknown,
        result: { winnerId: null, date: unknown, note: 'x' },
      }),
    ];
    expect(new Set(stages.map(confirm)).size).toBe(stages.length);
  });
});

describe('forward-looking actions', () => {
  const forward = (type: string, extra: Record<string, unknown> = {}) =>
    toast(active(), { type, note: 'Changed my mind.', ...extra } as unknown as BetAction, 'a');

  it('words a withdrawn proposal, a withdrawn open proposal and a judge stepping down', () => {
    expect(forward('withdraw')).toContain('withdrew your proposal to Blair');
    expect(forward('withdraw_proposal')).not.toBe(FALLBACK_TOAST);
    expect(forward('decline_judging')).toContain('stepped down as judge');
  });

  it('says a recommendation, never a ruling, when the judge steps down', () => {
    const message = toast(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
    );
    expect(message).toBe(
      'You stepped down as judge. Alex and Blair must agree on a new judge or method before a recommendation can be recorded.',
    );
    expect(message).not.toMatch(/ruling/i);
  });

  const evidenceBet = (timing: boolean) =>
    applyAction(
      timing
        ? active({
            deadline: undefined,
            timing: { kind: 'event', description: 'The release is announced' },
          })
        : active(),
      { type: 'mark_ready', evidence: 'Announced on the blog.' },
      'a',
      now,
    );

  it('says what is left once readiness evidence comes off the bet, by its timing', () => {
    // A legacy bet is always open for review, so a result can still be recorded without evidence.
    expect(toast(evidenceBet(false), { type: 'withdraw_proposal', note: 'x' }, 'a')).toBe(
      'Readiness evidence withdrawn. Its agreed timing has arrived, so a result can still be recorded.',
    );
    expect(toast(evidenceBet(true), { type: 'withdraw_proposal', note: 'x' }, 'a')).toBe(
      'Readiness evidence withdrawn. The bet waits on its agreed timing or new evidence again.',
    );
  });

  it('tells the other bettor what disagreeing with the evidence did', () => {
    expect(toast(evidenceBet(true), samples.dispute_readiness, 'b')).toBe(
      'You disagreed with Alex’s evidence and it is off the bet. The bet waits on its agreed timing or new evidence again.',
    );
    expect(toast(evidenceBet(false), samples.dispute_readiness, 'b')).toBe(
      'You disagreed with Alex’s evidence and it is off the bet. Its agreed timing has arrived, so a result can still be recorded.',
    );
  });

  it('says what a withdrawn proposal leaves in place', () => {
    const withAmendment = applyAction(active(), samples.propose_amendment, 'a', now);
    expect(toast(withAmendment, { type: 'withdraw_proposal', note: 'x' } as never, 'a')).toMatch(
      /terms withdrawn/i,
    );
    expect(toast(confirming(), { type: 'withdraw_proposal', note: 'x' } as never, 'a')).toMatch(
      /back in play/i,
    );
    expect(toast(settling(2), { type: 'withdraw_proposal', note: 'x' } as never, 'b')).toContain(
      '2 lobster rolls',
    );
  });
});

describe('creation, prices, offsets, exports and member switching', () => {
  it('names the person a new bet was proposed to', () => {
    expect(betCreatedToast('Sarah', false)).toBe(
      'Proposed to Sarah. The bet is on once they agree.',
    );
  });

  it('names the person asked to confirm a past bet', () => {
    expect(betCreatedToast('Sarah', true)).toContain('Sarah has been asked to confirm');
  });

  it('names the restaurant and the amount of a saved price', () => {
    expect(priceSavedToast(3200, 'North Pier Café')).toBe('Saved $32.00 at North Pier Café.');
  });

  it('names the restaurant and the amount of a corrected price', () => {
    expect(priceCorrectedToast(3450, 'North Pier Café')).toBe(
      'Corrected to $34.50 at North Pier Café. The earlier report stays on record under Earlier reports.',
    );
  });

  it('says a repeated price report was already on record', () => {
    expect(priceAlreadyRecordedToast(2800, 'Harbor Shack')).toBe(
      'Your $28.00 at Harbor Shack for that visit was already on record, so nothing new was saved.',
    );
  });

  it('names the withdrawn report and says it stays on record', () => {
    expect(priceWithdrawnToast(2800, 'Harbor Shack')).toBe(
      'Withdrew your $28.00 report at Harbor Shack. It stays on record under Earlier reports and no longer counts in any price.',
    );
  });

  it('counts the rolls and bets of an offset', () => {
    expect(offsetToast('Sarah', 2, 3)).toBe(
      'Offset 2 lobster rolls each way with Sarah. Recorded on 3 bets.',
    );
    expect(offsetToast('Sarah', 1, 1)).toBe(
      'Offset 1 lobster roll each way with Sarah. Recorded on 1 bet.',
    );
  });

  it('names the exported file and counts the bets in it', () => {
    expect(exportToast('lobster-ledger.csv', 14)).toBe(
      'Downloaded lobster-ledger.csv with 14 bets.',
    );
    expect(exportToast('lobster-ledger.csv', 1)).toBe('Downloaded lobster-ledger.csv with 1 bet.');
  });

  it('says the JSON archive holds the bets and the price reports', () => {
    expect(archiveExportToast('lobster-ledger-audit.json', 14, 12)).toBe(
      'Downloaded lobster-ledger-audit.json with 14 bets and 12 price reports.',
    );
    expect(archiveExportToast('lobster-ledger-audit.json', 1, 1)).toBe(
      'Downloaded lobster-ledger-audit.json with 1 bet and 1 price report.',
    );
    expect(archiveExportToast('lobster-ledger-audit.json', 0, 0)).toBe(
      'Downloaded lobster-ledger-audit.json with 0 bets and 0 price reports.',
    );
  });

  it('names the exported price file and counts the reports in it', () => {
    expect(pricesExportToast('lobster-ledger-prices.csv', 12)).toBe(
      'Downloaded lobster-ledger-prices.csv with 12 price reports.',
    );
    expect(pricesExportToast('lobster-ledger-prices.csv', 1)).toBe(
      'Downloaded lobster-ledger-prices.csv with 1 price report.',
    );
  });

  it('names the Lobster prices file and counts the years in it', () => {
    expect(marketExportToast('lobster-prices-2001-2025.csv', 25)).toBe(
      'Downloaded lobster-prices-2001-2025.csv with 25 years of prices.',
    );
    expect(marketExportToast('lobster-prices-2025-2025.csv', 1)).toBe(
      'Downloaded lobster-prices-2025-2025.csv with 1 year of prices.',
    );
  });

  it('names the member the demo now shows', () => {
    expect(memberSwitchedToast('Sarah')).toContain('Sarah');
  });
});
