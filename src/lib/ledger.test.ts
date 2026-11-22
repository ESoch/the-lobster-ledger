import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createBet,
  getBalances,
  getDirectDebts,
  getMemberStats,
  needsAction,
} from './ledger';
import { createDemoState } from './demo';
import { betReadiness, closureOf } from './bet-workflow';
import type { Bet, BetAction, Member, NewBet } from './types';

const members: Member[] = [
  { id: 'a', name: 'Alex', initials: 'AL', color: '#153b3e' },
  { id: 'b', name: 'Blair', initials: 'BL', color: '#bd4938' },
  { id: 'c', name: 'Casey', initials: 'CA', color: '#7e9188' },
];
const now = '2026-09-01T12:00:00.000Z';
const later = '2026-09-02T12:00:00.000Z';
const input: NewBet = {
  title: ' The launch ships on Friday ',
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
const confirming = (winnerId: string | null = 'a', stake = 2) =>
  applyAction(
    active({ stake }),
    { type: 'propose_result', winnerId, note: 'The release is live.' },
    'a',
    now,
  );
const owed = (winnerId = 'a', stake = 2) =>
  applyAction(confirming(winnerId, stake), { type: 'confirm_result' }, 'b', now);
const settling = () =>
  applyAction(
    owed(),
    { type: 'propose_settlement', method: 'roll', note: 'Two lobster rolls delivered at lunch.' },
    'b',
    now,
  );
const settled = () => applyAction(settling(), { type: 'confirm_settlement' }, 'a', now);

describe('agreement creation', () => {
  it.each(['browser', 'cli', 'mcp'] as const)(
    'keeps the trusted %s entry source separate from submitted terms through settlement',
    (entrySource) => {
      let bet = createBet(
        { ...input, entrySource: 'spoofed' } as NewBet,
        'a',
        members,
        now,
        entrySource,
      );
      expect(bet.entrySource).toBe(entrySource);
      const creation = structuredClone(bet.events[0]);
      const actions: [string, BetAction][] = [
        ['b', { type: 'accept' }],
        ['a', { type: 'propose_result', winnerId: 'a', note: 'Release published.' }],
        ['b', { type: 'confirm_result' }],
        ['b', { type: 'propose_settlement', method: 'roll', note: 'Two rolls delivered.' }],
        ['a', { type: 'confirm_settlement' }],
      ];
      for (const [actor, action] of actions) {
        bet = applyAction(bet, action, actor, now);
        expect(bet.entrySource).toBe(entrySource);
        expect(bet.events[0]).toEqual(creation);
      }
      expect(bet.status).toBe('settled');
    },
  );

  it('does not infer an entry source for records created without tracking', () => {
    const bet = pending();
    expect(bet.entrySource).toBeUndefined();
    expect(applyAction(bet, { type: 'accept' }, 'b', now).entrySource).toBeUndefined();
  });

  it('creates unique immutable records with only the creator approval and server audit time', () => {
    const source = structuredClone(input);
    const bet = pending();
    expect(bet).toMatchObject({
      title: 'The launch ships on Friday',
      status: 'pending',
      version: 1,
      agreementApprovals: ['a'],
      createdAt: now,
      updatedAt: now,
    });
    expect(bet.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(bet.reference).toMatch(/^LL-/);
    expect(pending().id).not.toBe(bet.id);
    expect(bet.events).toEqual([
      expect.objectContaining({ actorId: 'a', at: now, type: 'created' }),
    ]);
    expect(input).toEqual(source);
  });
  it.each([0, -1, 0.5, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid stake %s',
    (stake) => {
      expect(() => pending({ stake })).toThrow();
    },
  );
  it.each([
    { title: ' ' },
    { terms: '' },
    { creatorSide: ' ' },
    { opponentSide: '' },
    { title: 'x'.repeat(161) },
    { title: 'ab   ' },
    { terms: 'a         ' },
    { terms: 'x'.repeat(3001) },
    { creatorSide: 'x'.repeat(241) },
    { creatorSide: 'It ships', opponentSide: ' it  SHIPS ' },
    // Characters that take no room on screen count for nothing, and make no position different.
    { title: 'ab\u200b\u200c\u200d\u2060\ufeff' },
    { title: '\u200b\u200b\u200b\u200b\u200b\u200b' },
    { terms: '\u200b\u200b\u200b\u200b\u200b short' },
    { creatorSide: '\u200b' },
    { creatorSide: 'It ships', opponentSide: 'it\u200b SHIPS\u2060' },
    { creatorSide: 'It\u200dships', opponentSide: 'Itships' },
    { opponentId: 'a' },
    { opponentId: 'missing' },
    { deadline: 'yesterday' },
    { deadline: '2026-02-30' },
    { category: 'Money' },
  ])('rejects malformed agreement %j', (override) => {
    expect(() => pending(override as Partial<NewBet>)).toThrow();
  });
  it('requires a known creator and valid clock', () => {
    expect(() => createBet(input, 'outsider', members, now)).toThrow();
    expect(() => createBet(input, 'a', members, 'not a date')).toThrow();
  });
  it('records an existing wager with a past decision date without backdating approvals', () => {
    const bet = pending({ deadline: '2026-08-01' });
    expect(bet).toMatchObject({
      deadline: '2026-08-01',
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      agreementApprovals: ['a'],
    });
    expect(bet.events).toEqual([
      expect.objectContaining({ actorId: 'a', at: now, type: 'created' }),
    ]);
    const agreed = applyAction(bet, { type: 'accept' }, 'b', later);
    expect(agreed.status).toBe('active');
    expect(agreed.events.at(-1)).toMatchObject({ actorId: 'b', at: later });
    expect(getDirectDebts([agreed])).toEqual([]);
  });
  it('stores the canonical spelling of any valid timezone', () => {
    const timing = { kind: 'date' as const, at: later, timezone: 'america/new_york' };
    expect(pending({ deadline: undefined, timing }).timing).toMatchObject({
      timezone: 'America/New_York',
    });
    expect(
      pending({ deadline: undefined, timing: { ...timing, timezone: 'America/New_York' } }).timing,
    ).toMatchObject({ timezone: 'America/New_York' });
    expect(pending({ cutoff: { at: later, timezone: 'utc' } }).cutoff).toEqual({
      at: later,
      timezone: 'UTC',
    });
    expect(() => pending({ cutoff: { at: later, timezone: 'Mars/Olympus' } })).toThrow();
  });
  it('validates map coordinates and copies location data', () => {
    const location = {
      id: 'harbor',
      name: 'Harbor',
      address: 'Boston, MA',
      lat: 42.35,
      lng: -71.04,
    };
    const bet = pending({ location });
    location.name = 'Changed';
    expect(bet.location?.name).toBe('Harbor');
    expect(() => pending({ location: { ...location, lat: 100 } })).toThrow();
    expect(() => pending({ location: { ...location, lng: Number.NaN } })).toThrow();
  });
});

describe('two-party lifecycle', () => {
  it('only the opponent can complete agreement approval, preserving input and audit history', () => {
    const original = pending();
    const snapshot = structuredClone(original);
    const next = applyAction(original, { type: 'accept' }, 'b', later);
    expect(next).toMatchObject({
      status: 'active',
      version: 2,
      updatedAt: later,
      agreementApprovals: ['a', 'b'],
    });
    expect(next.events).toHaveLength(2);
    expect(next.events[0]).toEqual(original.events[0]);
    expect(original).toEqual(snapshot);
    expect(() => applyAction(original, { type: 'accept' }, 'a', later)).toThrow();
    expect(() => applyAction(original, { type: 'accept' }, 'c', later)).toThrow();
    expect(() => applyAction(next, { type: 'accept' }, 'b', later)).toThrow();
  });
  it('the opponent can decline with a retained reason and no debt', () => {
    const bet = applyAction(
      pending(),
      { type: 'decline', note: 'The terms are too broad.' },
      'b',
      later,
    );
    expect(bet.status).toBe('declined');
    expect(bet.events.at(-1)?.detail).toContain('The terms are too broad.');
    expect(getBalances([bet])).toEqual([]);
    expect(() =>
      applyAction(pending(), { type: 'decline', note: 'Changed my mind' }, 'a', later),
    ).toThrow();
  });
  it('does not recognize a result until both participants approve', () => {
    const proposal = confirming();
    expect(proposal.resolution?.approvals).toEqual(['a']);
    expect(getBalances([proposal])).toEqual([]);
    expect(getMemberStats([proposal], 'a').won).toBe(0);
    const confirmed = applyAction(proposal, { type: 'confirm_result' }, 'b', later);
    expect(confirmed.status).toBe('owed');
    expect(confirmed.resolution?.approvals).toEqual(['a', 'b']);
    expect(getBalances([confirmed])).toEqual([{ fromId: 'b', toId: 'a', rolls: 2 }]);
    expect(() => applyAction(proposal, { type: 'confirm_result' }, 'a', later)).toThrow();
    expect(() => applyAction(proposal, { type: 'confirm_result' }, 'c', later)).toThrow();
  });
  it('refuses malformed or duplicated approval sets rather than completing an incomplete agreement', () => {
    const missingAgreement = { ...pending(), agreementApprovals: [] };
    expect(() => applyAction(missingAgreement, { type: 'accept' }, 'b', later)).toThrow();
    const missingResult = confirming();
    missingResult.resolution!.approvals = [];
    expect(() => applyAction(missingResult, { type: 'confirm_result' }, 'b', later)).toThrow();
    const duplicatedResult = confirming();
    duplicatedResult.resolution!.approvals = ['a', 'a'];
    expect(() => applyAction(duplicatedResult, { type: 'confirm_result' }, 'b', later)).toThrow();
    const missingDelivery = settling();
    missingDelivery.settlement!.approvals = [];
    expect(() =>
      applyAction(missingDelivery, { type: 'confirm_settlement' }, 'a', later),
    ).toThrow();
  });
  it('either participant may propose a result, but the winner must belong to the bet', () => {
    const proposal = applyAction(
      active(),
      { type: 'propose_result', winnerId: 'b', note: 'The launch slipped.' },
      'b',
      later,
    );
    expect(proposal.resolution).toMatchObject({ winnerId: 'b', proposedBy: 'b', approvals: ['b'] });
    expect(() =>
      applyAction(
        active(),
        { type: 'propose_result', winnerId: 'c', note: 'Casey won.' },
        'a',
        later,
      ),
    ).toThrow();
  });
  it('a mutually confirmed tie voids the bet without counting a win or loss', () => {
    const bet = applyAction(confirming(null), { type: 'confirm_result' }, 'b', later);
    expect(bet.status).toBe('voided');
    expect(getBalances([bet])).toEqual([]);
    expect(getMemberStats([bet], 'a')).toMatchObject({ won: 0, lost: 0, winRate: 0, net: 0 });
  });
  it('a disputed result returns to active and records the disagreement before a fresh proposal', () => {
    const proposal = confirming();
    const disputed = applyAction(
      proposal,
      { type: 'dispute_result', note: 'The release has not reached all users.' },
      'b',
      later,
    );
    expect(disputed.status).toBe('active');
    expect(disputed.resolution).toBeUndefined();
    expect(disputed.events.at(-1)?.detail).toContain('The release has not reached all users.');
    expect(disputed.events.slice(0, -1)).toEqual(proposal.events);
    const fresh = applyAction(
      disputed,
      { type: 'propose_result', winnerId: 'b', note: 'The deadline passed.' },
      'a',
      later,
    );
    expect(fresh.resolution?.approvals).toEqual(['a']);
  });
  it('keeps the obligation until both parties confirm delivery of physical lobster rolls', () => {
    const proposal = settling();
    expect(proposal.status).toBe('settling');
    expect(proposal.settlement).toMatchObject({
      method: 'roll',
      proposedBy: 'b',
      approvals: ['b'],
    });
    expect(getBalances([proposal])).toEqual([{ fromId: 'b', toId: 'a', rolls: 2 }]);
    expect(getBalances([settled()])).toEqual([]);
    expect(() => applyAction(proposal, { type: 'confirm_settlement' }, 'b', later)).toThrow();
    expect(() =>
      applyAction(
        owed(),
        { type: 'propose_settlement', method: 'cash', note: 'Paid cash' } as unknown as BetAction,
        'b',
        later,
      ),
    ).toThrow();
  });
  it('a disputed delivery restores the debt and retains history', () => {
    const bet = applyAction(
      settling(),
      { type: 'dispute_settlement', note: 'We have only received one roll.' },
      'a',
      later,
    );
    expect(bet.status).toBe('owed');
    expect(bet.settlement).toBeUndefined();
    expect(bet.events.at(-1)?.detail).toContain('We have only received one roll.');
    expect(getBalances([bet])).toEqual([{ fromId: 'b', toId: 'a', rolls: 2 }]);
  });
  it('returns a disputed delivery to owed without prompting anyone', () => {
    const disputed = applyAction(
      settling(),
      { type: 'dispute_settlement', note: 'We have only received one roll.' },
      'a',
      later,
    );
    for (const memberId of ['a', 'b', 'c'])
      expect(needsAction(disputed, memberId, later)).toBe(false);
  });
  it('rejects actions from outsiders, stale stages, empty reasons, and backwards timestamps', () => {
    expect(() =>
      applyAction(active(), { type: 'propose_result', winnerId: 'a', note: ' ' }, 'a', later),
    ).toThrow();
    expect(() =>
      applyAction(confirming(), { type: 'dispute_result', note: '' }, 'b', later),
    ).toThrow();
    expect(() =>
      applyAction(settling(), { type: 'dispute_settlement', note: '' }, 'a', later),
    ).toThrow();
    expect(() =>
      applyAction(owed(), { type: 'propose_settlement', method: 'roll', note: '' }, 'b', later),
    ).toThrow();
    expect(() => applyAction(pending(), { type: 'confirm_result' }, 'b', later)).toThrow();
    expect(() => applyAction(active(), { type: 'confirm_settlement' }, 'a', later)).toThrow();
    expect(() => applyAction(settling(), { type: 'confirm_settlement' }, 'c', later)).toThrow();
    expect(() => applyAction(pending(), { type: 'accept' }, 'b', '2026-08-31T12:00:00Z')).toThrow();
    expect(() =>
      applyAction(active(), { type: 'unknown' } as unknown as BetAction, 'a', later),
    ).toThrow();
    expect(() =>
      applyAction(settled(), { type: 'propose_result', winnerId: 'a', note: 'Retry' }, 'a', later),
    ).toThrow();
  });
});

describe('balances, statistics, and action inbox', () => {
  it('nets opposite obligations only for the same pair without modifying historical status', () => {
    const bets = [owed('a', 3), owed('b', 1), owed('a', 2)];
    expect(getBalances(bets)).toEqual([{ fromId: 'b', toId: 'a', rolls: 4 }]);
    expect(bets.map((bet) => bet.status)).toEqual(['owed', 'owed', 'owed']);
    expect(getBalances([owed('a', 2), owed('b', 2)])).toEqual([]);
  });
  it('keeps separate counterparties separate', () => {
    let thirdParty = createBet({ ...input, opponentId: 'c', stake: 4 }, 'a', members, now);
    thirdParty = applyAction(thirdParty, { type: 'accept' }, 'c', now);
    thirdParty = applyAction(
      thirdParty,
      { type: 'propose_result', winnerId: 'c', note: 'Casey was correct.' },
      'a',
      now,
    );
    thirdParty = applyAction(thirdParty, { type: 'confirm_result' }, 'c', now);
    expect(getBalances([owed('a', 3), thirdParty])).toEqual(
      expect.arrayContaining([
        { fromId: 'b', toId: 'a', rolls: 3 },
        { fromId: 'a', toId: 'c', rolls: 4 },
      ]),
    );
  });
  it('does not derive debt from forged results or incomplete approval sets', () => {
    const foreignWinner = owed();
    foreignWinner.resolution!.winnerId = 'c';
    const duplicateApprovals = owed();
    duplicateApprovals.resolution!.approvals = ['a', 'b', 'a'];
    const incompleteAgreement = owed();
    incompleteAgreement.agreementApprovals = ['a'];
    const bets = [foreignWinner, duplicateApprovals, incompleteAgreement];
    expect(getBalances(bets)).toEqual([]);
    expect(getMemberStats(bets, 'a').won).toBe(0);
    expect(getMemberStats(bets, 'a').lost).toBe(0);
  });
  it('retains settled results in all-time stats while excluding unsettled proposals and ties', () => {
    const tie = applyAction(confirming(null), { type: 'confirm_result' }, 'b', now);
    const bets = [owed('a', 3), owed('b', 1), settled(), pending(), active(), confirming(), tie];
    expect(getMemberStats(bets, 'a')).toEqual({
      memberId: 'a',
      won: 2,
      lost: 1,
      winRate: (2 / 3) * 100,
      rollsWon: 5,
      rollsLost: 1,
      net: 4,
      owedToYou: 3,
      youOwe: 1,
      settled: 2,
      active: 2,
    });
    expect(getMemberStats(bets, 'c')).toEqual({
      memberId: 'c',
      won: 0,
      lost: 0,
      winRate: 0,
      rollsWon: 0,
      rollsLost: 0,
      net: 0,
      owedToYou: 0,
      youOwe: 0,
      settled: 0,
      active: 0,
    });
  });
  it.each([
    [pending, 'a', false],
    [pending, 'b', true],
    [pending, 'c', false],
    [active, 'a', false],
    [confirming, 'a', false],
    [confirming, 'b', true],
    [owed, 'a', false],
    [owed, 'b', false],
    [owed, 'c', false],
    [settling, 'a', true],
    [settling, 'b', false],
    [settled, 'a', false],
  ] as Array<[() => Bet, string, boolean]>)(
    'only asks the unconfirmed participant to act',
    (build, memberId, expected) => {
      expect(needsAction(build(), memberId)).toBe(expected);
    },
  );
  it("keeps owed bets out of both bettors' inboxes; the rolls stay under To settle", () => {
    const offset = { ...owed(), offsets: [] as Bet['offsets'] };
    for (const bet of [owed(), offset])
      for (const memberId of ['a', 'b']) expect(needsAction(bet, memberId)).toBe(false);
  });
  it('brings an event bet up for review for both bettors once its claim cutoff has passed', () => {
    const bet = active({
      deadline: undefined,
      timing: { kind: 'event', description: 'The acquisition officially closes' },
      cutoff: { at: later, timezone: 'UTC' },
    });
    expect(needsAction(bet, 'a', now)).toBe(false);
    expect(betReadiness(bet, now)).toMatchObject({ ready: false, state: 'waiting' });
    expect(betReadiness(bet, later)).toMatchObject({ ready: false, reviewDue: true });
    expect(needsAction(bet, 'a', later)).toBe(true);
    expect(needsAction(bet, 'b', later)).toBe(true);
    expect(() =>
      applyAction(bet, { type: 'propose_result', winnerId: 'a', note: 'Closed.' }, 'a', later),
    ).toThrow();
  });
});

describe('withdrawing and retracting proposals', () => {
  const amendment = (bet: Bet, actor: string, note = 'Clarify the criteria.'): BetAction => ({
    type: 'propose_amendment',
    terms: `${bet.terms} Pipeline timestamps are authoritative.`,
    timing: { kind: 'date', at: '2026-09-10T12:00:00.000Z', timezone: 'UTC' },
    note,
  });
  it('lets the creator withdraw an unanswered proposal, and no one else', () => {
    const bet = applyAction(
      pending(),
      { type: 'withdraw', note: 'I phrased the terms badly.' },
      'a',
      later,
    );
    expect(bet.status).toBe('declined');
    expect(bet.version).toBe(2);
    expect(bet.events.at(-1)).toMatchObject({ type: 'withdraw', actorId: 'a', at: later });
    expect(bet.events.at(-1)?.detail).toContain('I phrased the terms badly.');
    expect(closureOf(bet)).toBe('withdrawn');
    expect(getBalances([bet])).toEqual([]);
    const declined = applyAction(pending(), { type: 'decline', note: 'No thanks.' }, 'b', later);
    expect(closureOf(declined)).toBe('declined');
    expect(closureOf(active())).toBeUndefined();
    for (const actor of ['b', 'c'])
      expect(() =>
        applyAction(pending(), { type: 'withdraw', note: 'Reason' }, actor, later),
      ).toThrow();
    for (const build of [active, confirming, owed])
      expect(() =>
        applyAction(build(), { type: 'withdraw', note: 'Reason' }, 'a', later),
      ).toThrow();
    expect(() => applyAction(declined, { type: 'withdraw', note: 'Reason' }, 'a', later)).toThrow();
    expect(() => applyAction(bet, { type: 'accept' }, 'b', later)).toThrow();
    expect(() => applyAction(pending(), { type: 'withdraw', note: ' ' }, 'a', later)).toThrow();
  });
  it('lets a proposer withdraw their own amendment or call-off without changing the agreement', () => {
    const bet = active();
    const amended = applyAction(bet, amendment(bet, 'a'), 'a', later);
    expect(() =>
      applyAction(
        amended,
        { type: 'withdraw_proposal', note: 'Not mine to withdraw.' },
        'b',
        later,
      ),
    ).toThrow();
    expect(() =>
      applyAction(amended, { type: 'withdraw_proposal', note: 'Outsider.' }, 'c', later),
    ).toThrow();
    const withdrawn = applyAction(
      amended,
      { type: 'withdraw_proposal', note: 'I will rephrase it.' },
      'a',
      later,
    );
    expect(withdrawn.amendment).toBeUndefined();
    expect(withdrawn.terms).toBe(bet.terms);
    expect(withdrawn.timing).toEqual(bet.timing);
    expect(withdrawn.status).toBe('active');
    expect(withdrawn.events.at(-1)).toMatchObject({ type: 'withdraw_proposal', actorId: 'a' });
    expect(withdrawn.events.at(-1)?.detail).toContain('I will rephrase it.');
    expect(withdrawn.events.slice(0, -1)).toEqual(amended.events);
    const voiding = applyAction(bet, { type: 'propose_void', note: 'Rained out.' }, 'b', later);
    const kept = applyAction(
      voiding,
      { type: 'withdraw_proposal', note: 'It cleared up.' },
      'b',
      later,
    );
    expect(kept.voidProposal).toBeUndefined();
    expect(kept.status).toBe('active');
    expect(() =>
      applyAction(bet, { type: 'withdraw_proposal', note: 'Nothing is open.' }, 'a', later),
    ).toThrow();
  });
  it('lets a proposer retract a mutual result or a delivery report before the other bettor answers', () => {
    const retracted = applyAction(
      confirming(),
      { type: 'withdraw_proposal', note: 'I misread the logs.' },
      'a',
      later,
    );
    expect(retracted.status).toBe('active');
    expect(retracted.resolution).toBeUndefined();
    expect(retracted.events.at(-1)?.detail).toContain('I misread the logs.');
    expect(() =>
      applyAction(confirming(), { type: 'withdraw_proposal', note: 'Not mine.' }, 'b', later),
    ).toThrow();
    const delivery = applyAction(
      settling(),
      { type: 'withdraw_proposal', note: 'Wrong bet, sorry.' },
      'b',
      later,
    );
    expect(delivery.status).toBe('owed');
    expect(delivery.settlement).toBeUndefined();
    expect(getBalances([delivery])).toEqual([{ fromId: 'b', toId: 'a', rolls: 2 }]);
    expect(() =>
      applyAction(settling(), { type: 'withdraw_proposal', note: 'Not mine.' }, 'a', later),
    ).toThrow();
    expect(() =>
      applyAction(owed(), { type: 'withdraw_proposal', note: 'Nothing open.' }, 'b', later),
    ).toThrow();
  });
  it('lets a bettor take back their own readiness evidence before anyone acts on it', () => {
    const bet = active({
      deadline: undefined,
      timing: { kind: 'event', description: 'The release is announced' },
    });
    const ready = applyAction(bet, { type: 'mark_ready', evidence: 'Announced.' }, 'a', later);
    expect(() =>
      applyAction(ready, { type: 'withdraw_proposal', note: 'Not mine.' }, 'b', later),
    ).toThrow();
    const taken = applyAction(
      ready,
      { type: 'withdraw_proposal', note: 'That was a rumour.' },
      'a',
      later,
    );
    expect(taken.readiness).toBeUndefined();
    expect(taken.status).toBe('active');
    expect(needsAction(taken, 'b', later)).toBe(false);
  });
  it('rejects proposals that change nothing', () => {
    const bet = active({
      deadline: undefined,
      timing: { kind: 'date', at: later, timezone: 'America/New_York' },
    });
    expect(() =>
      applyAction(
        bet,
        {
          type: 'propose_amendment',
          terms: ` ${bet.terms} `,
          timing: { kind: 'date', at: later, timezone: 'america/new_york' },
          note: 'Same thing.',
        },
        'a',
        later,
      ),
    ).toThrow(/changes nothing/i);
    expect(
      applyAction(
        bet,
        {
          type: 'propose_amendment',
          terms: bet.terms,
          timing: { kind: 'date', at: later, timezone: 'America/New_York' },
          cutoff: { at: now, timezone: 'UTC' },
          note: 'Add a claim cutoff.',
        },
        'a',
        later,
      ).amendment,
    ).toMatchObject({ cutoff: { at: now, timezone: 'UTC' } });
    const legacy = active();
    expect(
      applyAction(
        legacy,
        {
          type: 'propose_amendment',
          terms: legacy.terms,
          timing: { kind: 'date', at: later, timezone: 'UTC' },
          note: 'Give it an exact time.',
        },
        'b',
        later,
      ).amendment,
    ).toBeTruthy();
  });
  it('drops personal check-ins that fall after a newly agreed decision date', () => {
    const far = '2026-09-20T12:00:00.000Z';
    const bet = active({
      deadline: undefined,
      timing: { kind: 'event', description: 'The launch happens' },
    });
    let scheduled = applyAction(
      bet,
      { type: 'set_check_in', checkIn: { at: far, timezone: 'UTC' } },
      'a',
      now,
    );
    scheduled = applyAction(
      scheduled,
      { type: 'set_check_in', checkIn: { at: later, timezone: 'UTC' } },
      'b',
      now,
    );
    const proposed = applyAction(
      scheduled,
      {
        type: 'propose_amendment',
        terms: bet.terms,
        timing: { kind: 'date', at: '2026-09-10T12:00:00.000Z', timezone: 'UTC' },
        note: 'We agreed on an exact date.',
      },
      'a',
      now,
    );
    const agreed = applyAction(proposed, { type: 'confirm_amendment' }, 'b', now);
    expect(agreed.checkIns).toEqual({ b: { at: later, timezone: 'UTC' } });
    expect(needsAction(agreed, 'a', far)).toBe(true);
    // The paper trail says so; an amendment that clears nothing stays quiet about check-ins.
    expect(agreed.events.at(-1)!.detail).toContain(
      'Personal check-ins after the new decision time were cleared.',
    );
    const untouched = applyAction(
      applyAction(
        bet,
        {
          type: 'propose_amendment',
          terms: bet.terms,
          timing: { kind: 'date', at: '2026-09-10T12:00:00.000Z', timezone: 'UTC' },
          note: 'We agreed on an exact date.',
        },
        'a',
        now,
      ),
      { type: 'confirm_amendment' },
      'b',
      now,
    );
    expect(untouched.events.at(-1)!.detail).not.toContain('check-ins');
  });
});

describe('demonstration ledger', () => {
  it('creates coherent records across the entire lifecycle with four moves waiting on Ellis', () => {
    const demo = createDemoState();
    const ellis = demo.members.find((member) => member.name === 'Ellis')!;
    expect(demo.members).toHaveLength(6);
    expect(demo.places).toHaveLength(4);
    expect(demo.bets.length).toBeGreaterThanOrEqual(16);
    expect(demo.bets.filter((bet) => closureOf(bet) === 'withdrawn')).toHaveLength(1);
    expect(demo.bets.filter((bet) => bet.judgeDeclined)).toHaveLength(1);
    expect(new Set(demo.bets.map((bet) => bet.id)).size).toBe(demo.bets.length);
    expect(new Set(demo.bets.map((bet) => bet.status))).toEqual(
      new Set([
        'pending',
        'active',
        'confirming',
        'owed',
        'settling',
        'settled',
        'voided',
        'declined',
      ]),
    );
    // A proposal to answer, a result and a delivery to confirm, and a judge to replace.
    expect(demo.bets.filter((bet) => needsAction(bet, ellis.id))).toHaveLength(4);
    expect(
      demo.bets.some(
        (bet) => bet.status === 'active' && bet.decisionMethod === 'judge' && bet.judgeId,
      ),
    ).toBe(true);
    expect(
      demo.bets.some(
        (bet) =>
          bet.status === 'active' &&
          bet.decisionMethod === 'chatgpt' &&
          bet.promptAgreement?.approvals.length === 1,
      ),
    ).toBe(true);
    expect(getMemberStats(demo.bets, ellis.id).net).toBeGreaterThan(0);
    for (const bet of demo.bets) {
      expect(bet.events).toHaveLength(bet.version);
      expect(bet.events[0].at).toBe(bet.createdAt);
      expect(bet.events.at(-1)?.at).toBe(bet.updatedAt);
      expect(bet.deadline >= bet.createdAt.slice(0, 10)).toBe(true);
      expect(
        bet.events.every((event, index) => index === 0 || event.at >= bet.events[index - 1].at),
      ).toBe(true);
      expect(demo.members.some((member) => member.id === bet.creatorId)).toBe(true);
      expect(demo.members.some((member) => member.id === bet.opponentId)).toBe(true);
    }
    demo.members[0].name = 'Changed';
    expect(createDemoState().members[0].name).toBe('Ellis');
  });
});

describe('nontransferable obligations', () => {
  it('keeps both directions owed even when their mathematical net is zero', () => {
    const bets = [owed('a', 2), owed('b', 2)];
    expect(getDirectDebts(bets)).toEqual(
      expect.arrayContaining([
        { fromId: 'b', toId: 'a', rolls: 2 },
        { fromId: 'a', toId: 'b', rolls: 2 },
      ]),
    );
    expect(getDirectDebts(bets)).toHaveLength(2);
    expect(getBalances(bets)).toEqual([]);
  });
  it('sums only the same direction and excludes unconfirmed or delivered rolls', () => {
    expect(
      getDirectDebts([owed('a', 2), owed('a', 3), owed('b', 1), settled(), confirming()]),
    ).toEqual([
      { fromId: 'b', toId: 'a', rolls: 5 },
      { fromId: 'a', toId: 'b', rolls: 1 },
    ]);
  });
});

describe('judge and ChatGPT adjudication', () => {
  const judgeBet = () => active({ decisionMethod: 'judge', judgeId: 'c' });
  const chatgptBet = () => active({ decisionMethod: 'chatgpt' });
  const prompt =
    'Decide this wager fairly using only the agreed terms and evidence. Explain the reasoning for each side.';
  const proposedPrompt = () =>
    applyAction(chatgptBet(), { type: 'propose_prompt', text: prompt }, 'a', now);
  const approvedPrompt = () => applyAction(proposedPrompt(), { type: 'approve_prompt' }, 'b', now);
  const judgeRecommendation = () =>
    applyAction(
      judgeBet(),
      { type: 'adjudicate', winnerId: 'a', note: 'The deployment logs show an on-time release.' },
      'c',
      now,
    );
  const chatgptRecommendation = () =>
    applyAction(
      approvedPrompt(),
      {
        type: 'adjudicate',
        winnerId: 'a',
        note: 'The supplied timeline satisfies the agreed cutoff.',
        sourceUrl: 'https://chatgpt.com/share/example-result',
      },
      'a',
      now,
    );

  it('records the agreed decision method and requires an independent registered judge', () => {
    expect(judgeBet()).toMatchObject({ decisionMethod: 'judge', judgeId: 'c' });
    expect(chatgptBet().decisionMethod).toBe('chatgpt');
    for (const judgeId of ['a', 'b', 'missing', undefined])
      expect(() => pending({ decisionMethod: 'judge', judgeId })).toThrow();
    expect(() => pending({ decisionMethod: 'mutual', judgeId: 'c' })).toThrow();
    expect(() => pending({ decisionMethod: 'chatgpt', judgeId: 'c' })).toThrow();
    expect(() => pending({ decisionMethod: 'invalid' } as unknown as Partial<NewBet>)).toThrow();
  });
  it('gives only the assigned judge the adjudication action and no bettor approval powers', () => {
    expect(needsAction(judgeBet(), 'c')).toBe(true);
    expect(needsAction(judgeBet(), 'a')).toBe(false);
    const result = judgeRecommendation();
    expect(result).toMatchObject({
      status: 'confirming',
      adjudication: { method: 'judge', winnerId: 'a', recordedBy: 'c', at: now },
      resolution: { proposedBy: 'c', approvals: [] },
    });
    expect(() =>
      applyAction(judgeBet(), { type: 'adjudicate', winnerId: 'a', note: 'I win' }, 'a', now),
    ).toThrow();
    expect(() =>
      applyAction(
        judgeBet(),
        { type: 'adjudicate', winnerId: 'a', note: 'I win' },
        'outsider',
        now,
      ),
    ).toThrow();
    expect(() => applyAction(result, { type: 'confirm_result' }, 'c', now)).toThrow();
    expect(() =>
      applyAction(judgeBet(), { type: 'propose_result', winnerId: 'a', note: 'I win' }, 'a', now),
    ).toThrow();
    expect(() =>
      applyAction(active(), { type: 'adjudicate', winnerId: 'a', note: 'Judge says so' }, 'a', now),
    ).toThrow();
  });
  it('requires both bettors to separately confirm a judge recommendation before creating debt', () => {
    const proposal = judgeRecommendation();
    expect(getDirectDebts([proposal])).toEqual([]);
    expect(needsAction(proposal, 'a')).toBe(true);
    expect(needsAction(proposal, 'b')).toBe(true);
    const first = applyAction(proposal, { type: 'confirm_result' }, 'a', later);
    expect(first.status).toBe('confirming');
    expect(getDirectDebts([first])).toEqual([]);
    expect(() => applyAction(first, { type: 'confirm_result' }, 'a', later)).toThrow();
    const confirmed = applyAction(first, { type: 'confirm_result' }, 'b', later);
    expect(confirmed.status).toBe('owed');
    expect(getMemberStats([confirmed], 'a').won).toBe(1);
    expect(getMemberStats([confirmed], 'c').won).toBe(0);
    expect(getDirectDebts([confirmed])).toEqual([{ fromId: 'b', toId: 'a', rolls: 2 }]);
  });
  it('can mutually void an adjudicated result and retain the independent recommendation', () => {
    let bet = applyAction(
      judgeBet(),
      { type: 'adjudicate', winnerId: null, note: 'Neither agreed condition occurred.' },
      'c',
      now,
    );
    bet = applyAction(bet, { type: 'confirm_result' }, 'b', now);
    bet = applyAction(bet, { type: 'confirm_result' }, 'a', now);
    expect(bet.status).toBe('voided');
    expect(bet.adjudication?.winnerId).toBeNull();
    expect(getDirectDebts([bet])).toEqual([]);
  });
  it('retains the entire recommendation in audit history when a bettor disputes it', () => {
    const proposal = judgeRecommendation();
    const disputed = applyAction(
      proposal,
      { type: 'dispute_result', note: 'The logs use the wrong timezone.' },
      'b',
      later,
    );
    expect(disputed.status).toBe('active');
    expect(disputed.adjudication).toBeUndefined();
    expect(disputed.resolution).toBeUndefined();
    expect(disputed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: 'c',
          detail: expect.stringContaining('The deployment logs show an on-time release.'),
        }),
      ]),
    );
    expect(needsAction(disputed, 'c')).toBe(true);
  });
  it('requires both bettors to approve the exact prompt before a ChatGPT recommendation can be recorded', () => {
    const action: BetAction = {
      type: 'adjudicate',
      winnerId: 'a',
      note: 'The recommendation favors Alex.',
    };
    expect(() => applyAction(chatgptBet(), action, 'a', now)).toThrow();
    const proposed = proposedPrompt();
    expect(proposed.promptAgreement).toMatchObject({
      text: prompt,
      proposedBy: 'a',
      approvals: ['a'],
      version: 1,
      at: now,
    });
    expect(needsAction(proposed, 'b')).toBe(true);
    expect(needsAction(proposed, 'a')).toBe(false);
    expect(() => applyAction(proposed, action, 'a', now)).toThrow();
    const approved = approvedPrompt();
    expect(approved.promptAgreement?.approvals).toEqual(['a', 'b']);
    expect(needsAction(approved, 'b')).toBe(false);
    expect(() => applyAction(approved, { type: 'approve_prompt' }, 'b', now)).toThrow();
  });
  it('editing an agreed prompt starts fresh approvals and retains the previous exact text', () => {
    const approved = approvedPrompt();
    const newText = prompt + ' Treat an exact tie as no winner.';
    const edited = applyAction(approved, { type: 'propose_prompt', text: newText }, 'b', later);
    expect(edited.promptAgreement).toMatchObject({
      text: newText,
      proposedBy: 'b',
      approvals: ['b'],
      version: 2,
    });
    expect(edited.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining(prompt) }),
      ]),
    );
    expect(() =>
      applyAction(
        edited,
        { type: 'adjudicate', winnerId: 'b', note: 'This was the recommendation.' },
        'b',
        later,
      ),
    ).toThrow();
    expect(needsAction(edited, 'a')).toBe(true);
    expect(approved.promptAgreement?.text).toBe(prompt);
  });
  it('records ChatGPT attribution and prompt version without auto-confirming a bettor result', () => {
    const proposal = chatgptRecommendation();
    expect(proposal.adjudication).toMatchObject({
      method: 'chatgpt',
      recordedBy: 'a',
      promptVersion: 1,
      sourceUrl: 'https://chatgpt.com/share/example-result',
    });
    expect(proposal.resolution?.approvals).toEqual([]);
    expect(getDirectDebts([proposal])).toEqual([]);
    expect(proposal.events.at(-1)?.detail).toContain('https://chatgpt.com/share/example-result');
    expect(() =>
      applyAction(proposal, { type: 'propose_prompt', text: prompt + ' Different.' }, 'a', later),
    ).toThrow();
    expect(() =>
      applyAction(
        chatgptBet(),
        { type: 'propose_result', winnerId: 'a', note: 'Bypass' },
        'a',
        later,
      ),
    ).toThrow();
    expect(() =>
      applyAction(
        approvedPrompt(),
        { type: 'adjudicate', winnerId: 'a', note: 'Bypass' },
        'c',
        later,
      ),
    ).toThrow();
  });
  it('rejects re-proposing an unchanged prompt instead of un-agreeing it', () => {
    const approved = approvedPrompt();
    expect(() =>
      applyAction(approved, { type: 'propose_prompt', text: ` ${prompt} ` }, 'b', later),
    ).toThrow(/identical|changes nothing/i);
    expect(() =>
      applyAction(proposedPrompt(), { type: 'propose_prompt', text: prompt }, 'b', later),
    ).toThrow(/identical|changes nothing/i);
    expect(approvedPrompt().promptAgreement?.approvals).toEqual(['a', 'b']);
  });
  it('lets only the named judge step down, and blocks rulings until the bettors re-appoint', () => {
    const bet = judgeBet();
    expect(() =>
      applyAction(bet, { type: 'decline_judging', note: 'Conflict of interest.' }, 'a', now),
    ).toThrow();
    expect(() =>
      applyAction(active(), { type: 'decline_judging', note: 'Not a judge.' }, 'c', now),
    ).toThrow();
    expect(() =>
      applyAction(chatgptBet(), { type: 'decline_judging', note: 'Not a judge.' }, 'c', now),
    ).toThrow();
    const declined = applyAction(
      bet,
      { type: 'decline_judging', note: 'I know too much about this one.' },
      'c',
      now,
    );
    expect(declined.status).toBe('active');
    expect(declined.judgeDeclined).toEqual({ at: now, note: 'I know too much about this one.' });
    expect(declined.events.at(-1)).toMatchObject({ type: 'decline_judging', actorId: 'c' });
    expect(() =>
      applyAction(declined, { type: 'adjudicate', winnerId: 'a', note: 'Ruling.' }, 'c', later),
    ).toThrow(/declined/i);
    expect(() =>
      applyAction(declined, { type: 'decline_judging', note: 'Again.' }, 'c', later),
    ).toThrow();
    expect(needsAction(declined, 'c', later)).toBe(false);
    expect(needsAction(declined, 'a', later)).toBe(true);
    expect(needsAction(declined, 'b', later)).toBe(true);
    const timing = { kind: 'date' as const, at: later, timezone: 'UTC' };
    const proposed = applyAction(
      declined,
      {
        type: 'propose_amendment',
        terms: declined.terms,
        timing,
        note: 'Ask Dana to judge instead.',
        decisionMethod: 'judge',
        judgeId: 'd',
      },
      'a',
      later,
    );
    expect(proposed.amendment).toMatchObject({ decisionMethod: 'judge', judgeId: 'd' });
    expect(needsAction(proposed, 'a', later)).toBe(false);
    expect(needsAction(proposed, 'b', later)).toBe(true);
    expect(proposed.judgeId).toBe('c');
    // The immutable record names the method in plain words and keeps the id in a parseable token.
    expect(proposed.events.at(-1)!.detail).toContain(
      '\nProposed decision method: a named judge (judge d)\nReason: Ask Dana to judge instead.',
    );
    const agreed = applyAction(proposed, { type: 'confirm_amendment' }, 'b', later);
    expect(agreed).toMatchObject({ decisionMethod: 'judge', judgeId: 'd' });
    expect(agreed.judgeDeclined).toBeUndefined();
    expect(agreed.events.at(-1)!.detail).toContain(
      'The bet is now decided by a named judge (judge d).',
    );
    expect(needsAction(agreed, 'a', later)).toBe(false);
    expect(
      applyAction(agreed, { type: 'adjudicate', winnerId: 'a', note: 'Dana rules.' }, 'd', later)
        .status,
    ).toBe('confirming');
    const mutual = applyAction(
      applyAction(
        declined,
        {
          type: 'propose_amendment',
          terms: declined.terms,
          timing,
          note: 'We will decide it ourselves.',
          decisionMethod: 'mutual',
        },
        'b',
        later,
      ),
      { type: 'confirm_amendment' },
      'a',
      later,
    );
    expect(mutual.decisionMethod).toBe('mutual');
    expect(mutual.judgeId).toBeUndefined();
    expect(mutual.judgeDeclined).toBeUndefined();
    expect(mutual.events.at(-2)!.detail).toContain('Proposed decision method: mutual agreement\n');
    expect(mutual.events.at(-1)!.detail).toContain('now decided by mutual agreement.');
    for (const change of [
      { decisionMethod: 'judge' as const, judgeId: 'a' },
      { decisionMethod: 'judge' as const },
      { decisionMethod: 'mutual' as const, judgeId: 'c' },
      { decisionMethod: 'oracle' as never },
    ])
      expect(() =>
        applyAction(
          declined,
          { type: 'propose_amendment', terms: declined.terms, timing, note: 'Change.', ...change },
          'a',
          later,
        ),
      ).toThrow();
    expect(
      applyAction(
        pending({ decisionMethod: 'judge', judgeId: 'c' }),
        { type: 'decline_judging', note: 'Too busy this month.' },
        'c',
        now,
      ).judgeDeclined,
    ).toBeTruthy();
    expect(() =>
      applyAction(judgeRecommendation(), { type: 'decline_judging', note: 'Late.' }, 'c', later),
    ).toThrow();
  });
  it('never reinstates a judge who stepped down through an amendment proposed before the decline', () => {
    const timing = { kind: 'date' as const, at: later, timezone: 'UTC' };
    const proposed = applyAction(
      judgeBet(),
      {
        type: 'propose_amendment',
        terms: 'Production deployment before 6 pm Boston time.',
        timing,
        note: 'Give it one more hour.',
        decisionMethod: 'judge',
        judgeId: 'c',
      },
      'a',
      now,
    );
    const declined = applyAction(
      proposed,
      { type: 'decline_judging', note: 'I am out.' },
      'c',
      now,
    );
    expect(declined.amendment).toMatchObject({ decisionMethod: 'judge', judgeId: 'c' });
    expect(() => applyAction(declined, { type: 'confirm_amendment' }, 'b', later)).toThrow(
      'That judge stepped down; propose a new judge or decision method.',
    );
    // The amendment stays open: the proposer can withdraw it or the other bettor can decline it.
    const withdrawn = applyAction(
      declined,
      { type: 'withdraw_proposal', note: 'Casey stepped down.' },
      'a',
      later,
    );
    expect(withdrawn.amendment).toBeUndefined();
    expect(withdrawn.judgeDeclined).toBeTruthy();
    const rejected = applyAction(
      declined,
      { type: 'reject_amendment', note: 'Casey stepped down.' },
      'b',
      later,
    );
    expect(rejected.amendment).toBeUndefined();
    expect(rejected.judgeDeclined).toBeTruthy();
    // An amendment that leaves the method alone keeps the decline on the bet.
    const termsOnly = applyAction(
      applyAction(
        judgeBet(),
        { type: 'propose_amendment', terms: 'New terms.', timing, note: 'Reword.' },
        'a',
        now,
      ),
      { type: 'decline_judging', note: 'I am out.' },
      'c',
      now,
    );
    const reworded = applyAction(termsOnly, { type: 'confirm_amendment' }, 'b', later);
    expect(reworded.judgeId).toBe('c');
    expect(reworded.judgeDeclined).toBeTruthy();
  });
  it('never prompts the bettors while a judged bet waits on the judge', () => {
    const bet = active({
      decisionMethod: 'judge',
      judgeId: 'c',
      deadline: undefined,
      timing: { kind: 'date', at: later, timezone: 'UTC' },
    });
    expect(needsAction(bet, 'c', later)).toBe(true);
    expect(needsAction(bet, 'a', later)).toBe(false);
    expect(needsAction(bet, 'b', later)).toBe(false);
    const far = '2026-09-30T12:00:00.000Z';
    const reminder = applyAction(
      active({
        decisionMethod: 'judge',
        judgeId: 'c',
        deadline: undefined,
        timing: { kind: 'date', at: far, timezone: 'UTC' },
      }),
      { type: 'set_check_in', checkIn: { at: later, timezone: 'UTC' } },
      'a',
      now,
    );
    expect(needsAction(reminder, 'a', later)).toBe(true);
    expect(needsAction(reminder, 'b', later)).toBe(false);
    expect(needsAction(reminder, 'c', later)).toBe(false);
  });
  it.each(['owed', 'settled', 'voided'] as const)(
    'refuses a step-down on a reported past bet whose result is already decided (%s)',
    (stage) => {
      const bet = createBet(
        {
          ...input,
          deadline: '2024-02-10',
          decisionMethod: 'judge',
          judgeId: 'c',
          history: {
            stage,
            originalDate: { precision: 'month', value: '2024-02' },
            result: {
              winnerId: stage === 'voided' ? null : 'a',
              date: { precision: 'unknown' },
              note: 'The release shipped.',
            },
            ...(stage === 'settled'
              ? { delivery: { date: { precision: 'unknown' as const }, note: 'Lunch.' } }
              : {}),
          },
          acknowledgements: { terms: true, result: true, delivery: stage === 'settled' },
        },
        'a',
        members,
        now,
      );
      expect(() =>
        applyAction(bet, { type: 'decline_judging', note: 'I never judged this.' }, 'c', now),
      ).toThrow('The result is already recorded.');
    },
  );
  it('lets the judge step down from a reported past bet that is still in play', () => {
    const bet = createBet(
      {
        ...input,
        deadline: '2024-02-10',
        decisionMethod: 'judge',
        judgeId: 'c',
        history: { stage: 'active', originalDate: { precision: 'month', value: '2024-02' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      'a',
      members,
      now,
    );
    expect(
      applyAction(bet, { type: 'decline_judging', note: 'Too busy.' }, 'c', now).judgeDeclined,
    ).toBeTruthy();
  });
  it('gives the prompt proposer no duty while the other bettor has yet to approve', () => {
    const timing = { kind: 'date' as const, at: later, timezone: 'UTC' };
    const bet = applyAction(
      active({ decisionMethod: 'chatgpt', deadline: undefined, timing }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
    expect(betReadiness(bet, later, 'a').state).toBe('ready');
    expect(needsAction(bet, 'a', later)).toBe(false);
    expect(needsAction(bet, 'b', later)).toBe(true);
    expect(needsAction(applyAction(bet, { type: 'approve_prompt' }, 'b', now), 'a', later)).toBe(
      true,
    );
  });
  it('bounds prompt text and limits prompt actions to the active ChatGPT bettors', () => {
    for (const text of ['Too short', 'x'.repeat(8001)])
      expect(() => applyAction(chatgptBet(), { type: 'propose_prompt', text }, 'a', now)).toThrow();
    expect(() =>
      applyAction(active(), { type: 'propose_prompt', text: prompt }, 'a', now),
    ).toThrow();
    expect(() =>
      applyAction(chatgptBet(), { type: 'propose_prompt', text: prompt }, 'c', now),
    ).toThrow();
    expect(() => applyAction(chatgptBet(), { type: 'approve_prompt' }, 'b', now)).toThrow();
  });
  it.each([
    'http://chatgpt.com/share/example',
    'https://evil.test/share/example',
    'https://chatgpt.com/chat/example',
    'https://chatgpt.com/share/',
    'https://chatgpt.com/share/example?x=1',
    'https://user:pass@chatgpt.com/share/example',
    'https://chatgpt.com:444/share/example',
    'https://chatgpt.com/share/example#result',
  ])('rejects an invalid ChatGPT source URL %s', (sourceUrl) => {
    expect(() =>
      applyAction(
        approvedPrompt(),
        { type: 'adjudicate', winnerId: 'a', note: 'Reasoning', sourceUrl },
        'a',
        now,
      ),
    ).toThrow();
  });
});

describe('audit text says only what happened', () => {
  const acknowledgements = { terms: true, result: true, delivery: true };
  const report = (stage: 'active' | 'owed' | 'settled' | 'voided') =>
    createBet(
      {
        ...input,
        deadline: '2024-02-10',
        history: {
          stage,
          originalDate: { precision: 'month', value: '2024-02' },
          ...(stage === 'active'
            ? {}
            : {
                result: {
                  winnerId: stage === 'voided' ? null : 'a',
                  date: { precision: 'unknown' as const },
                  note: 'The release shipped.',
                },
              }),
          ...(stage === 'settled'
            ? { delivery: { date: { precision: 'unknown' as const }, note: 'Lunch at the pier.' } }
            : {}),
        },
        acknowledgements:
          stage === 'active'
            ? { terms: true, result: false, delivery: false }
            : stage === 'settled'
              ? acknowledgements
              : { terms: true, result: true, delivery: false },
      },
      'a',
      members,
      now,
    );
  it('names only the stages a reported past bet actually includes', () => {
    expect(report('active').events[0].detail).toBe(
      'Reported a past bet that is still in play and acknowledged its terms. Awaiting the other bettor.',
    );
    expect(report('owed').events[0].detail).toBe(
      'Reported a past bet and acknowledged its terms and result. Awaiting the other bettor.',
    );
    expect(report('settled').events[0].detail).toBe(
      'Reported a past bet and acknowledged its terms, result and actual delivery. Awaiting the other bettor.',
    );
    const confirm = (stage: 'active' | 'owed' | 'settled') =>
      applyAction(
        report(stage),
        {
          type: 'confirm_history',
          acknowledgements:
            stage === 'active'
              ? { terms: true, result: false, delivery: false }
              : stage === 'owed'
                ? { terms: true, result: true, delivery: false }
                : acknowledgements,
        },
        'b',
        later,
      ).events.at(-1)!.detail;
    expect(confirm('active')).toBe(
      'Both original bettors acknowledged the reported terms. Historical record confirmed.',
    );
    expect(confirm('owed')).toBe(
      'Both original bettors acknowledged the reported terms and result. Historical record confirmed.',
    );
    expect(confirm('settled')).toBe(
      'Both original bettors acknowledged the reported terms, result and delivery of actual lobster rolls. Historical record confirmed.',
    );
  });
  it('says what an approved amendment cleared, and nothing it did not', () => {
    const amend = (bet: Bet) =>
      applyAction(
        applyAction(
          bet,
          {
            type: 'propose_amendment',
            terms: 'Production deployment before 6 pm Boston time.',
            timing: { kind: 'date', at: '2026-09-06T21:00:00.000Z', timezone: 'America/New_York' },
            note: 'The window moved.',
          },
          'a',
          now,
        ),
        { type: 'confirm_amendment' },
        'b',
        now,
      ).events.at(-1)!.detail;
    const plain = amend(active());
    expect(plain).toBe('Both bettors approved the revised decision criteria and timing.');
    const withEvidence = amend(
      applyAction(active(), { type: 'mark_ready', evidence: 'The deploy log.' }, 'a', now),
    );
    expect(withEvidence).toContain('Earlier readiness evidence was cleared.');
    expect(withEvidence).not.toContain('ChatGPT');
    let chatgpt = applyAction(
      active({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: 'Decide this release bet fairly from the deploy log.' },
      'a',
      now,
    );
    chatgpt = applyAction(chatgpt, { type: 'mark_ready', evidence: 'The deploy log.' }, 'b', now);
    expect(amend(chatgpt)).toContain(
      'Earlier readiness evidence and ChatGPT prompt consent were cleared.',
    );
  });
});

describe('note errors name the field the person filled in', () => {
  it.each([
    [
      () => owed(),
      { type: 'propose_settlement', method: 'roll', note: '   ' },
      'b',
      /^Delivery details/,
    ],
    [() => settling(), { type: 'dispute_settlement', note: ' ' }, 'a', /^Reason for disagreeing/],
    [() => active(), { type: 'propose_void', note: '' }, 'a', /^Reason/],
    [
      () => applyAction(active(), { type: 'mark_ready', evidence: 'Live.' }, 'a', now),
      { type: 'propose_result', winnerId: 'a', note: ' ' },
      'a',
      /^Evidence or explanation/,
    ],
    // The judge's field and the ChatGPT paste field are labelled differently on the sheet.
    [
      () => active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'adjudicate', winnerId: 'a', note: ' ' },
      'c',
      /^Recommendation and reasoning/,
    ],
    [
      () => active({ decisionMethod: 'chatgpt' }),
      { type: 'adjudicate', winnerId: 'a', note: ' ' },
      'a',
      /^Response and reasoning/,
    ],
  ] as [() => Bet, BetAction, string, RegExp][])('for %#', (build, action, actorId, message) => {
    expect(() => applyAction(build(), action, actorId, now)).toThrow(message);
  });
});

describe('readiness evidence stays with the bettor who added it', () => {
  const eventBet = () =>
    active({
      deadline: undefined,
      timing: { kind: 'event', description: 'The release is announced' },
    });
  const ready = () =>
    applyAction(eventBet(), { type: 'mark_ready', evidence: 'Announced on the blog.' }, 'a', now);
  it('refuses to replace the other bettor’s evidence, but lets its author update their own', () => {
    expect(() =>
      applyAction(ready(), { type: 'mark_ready', evidence: 'It was postponed.' }, 'b', later),
    ).toThrow(/other bettor already added evidence/);
    const updated = applyAction(
      ready(),
      { type: 'mark_ready', evidence: 'Announced on the blog and the changelog.' },
      'a',
      later,
    );
    expect(updated.readiness).toMatchObject({
      markedBy: 'a',
      evidence: 'Announced on the blog and the changelog.',
    });
  });
  it('lets the other bettor disagree with the evidence, which takes it off the bet', () => {
    const disputed = applyAction(
      ready(),
      { type: 'dispute_readiness', note: 'The blog post was about a different release.' },
      'b',
      later,
    );
    expect(disputed.readiness).toBeUndefined();
    expect(disputed.status).toBe('active');
    expect(betReadiness(disputed, later).ready).toBe(false);
    expect(disputed.events.at(-1)).toMatchObject({
      type: 'dispute_readiness',
      actorId: 'b',
      detail: 'Disputed the readiness evidence: The blog post was about a different release.',
    });
    expect(needsAction(disputed, 'a', later)).toBe(false);
  });
  it('lets only the other bettor disagree, and only while the evidence is open', () => {
    const note = 'That is not what the agreement asks for.';
    expect(() => applyAction(ready(), { type: 'dispute_readiness', note }, 'a', later)).toThrow(
      /your own evidence/i,
    );
    expect(() => applyAction(eventBet(), { type: 'dispute_readiness', note }, 'b', later)).toThrow(
      /no readiness evidence/i,
    );
    expect(() =>
      applyAction(
        applyAction(
          active({
            decisionMethod: 'judge',
            judgeId: 'c',
            deadline: undefined,
            timing: { kind: 'event', description: 'The release is announced' },
          }),
          { type: 'mark_ready', evidence: 'Announced.' },
          'a',
          now,
        ),
        { type: 'dispute_readiness', note },
        'c',
        later,
      ),
    ).toThrow(/Only the bettors/);
    expect(() =>
      applyAction(ready(), { type: 'dispute_readiness', note: '  ' }, 'b', later),
    ).toThrow(/^Reason for disagreeing/);
  });
  it('records a withdrawn readiness claim without claiming what the timing does next', () => {
    const taken = applyAction(
      ready(),
      { type: 'withdraw_proposal', note: 'That was a rumour.' },
      'a',
      later,
    );
    expect(taken.events.at(-1)?.detail).toBe(
      'Withdrew their readiness evidence: That was a rumour.',
    );
  });
});

describe('no-op guards see through formatting', () => {
  it('refuses an amendment that restates a legacy decision date as the same timing', () => {
    const legacy = active();
    expect(legacy.deadline).toBe('2026-09-05');
    expect(() =>
      applyAction(
        legacy,
        {
          type: 'propose_amendment',
          terms: legacy.terms,
          timing: { kind: 'date', at: '2026-09-05T00:00:00.000Z', timezone: 'UTC' },
          note: 'Nothing new.',
        },
        'a',
        later,
      ),
    ).toThrow(/changes nothing/i);
    // Changing only the judge is a real change, and the same date is not counted as one.
    expect(
      applyAction(
        legacy,
        {
          type: 'propose_amendment',
          terms: legacy.terms,
          timing: { kind: 'date', at: '2026-09-05T00:00:00.000Z', timezone: 'UTC' },
          decisionMethod: 'judge',
          judgeId: 'c',
          note: 'Casey can call it.',
        },
        'a',
        later,
      ).amendment,
    ).toMatchObject({ decisionMethod: 'judge', judgeId: 'c' });
  });
  it('refuses a prompt revision that only changes spacing', () => {
    const text = 'Decide this wager fairly.\nUse only the agreed terms and evidence.';
    const agreed = applyAction(
      applyAction(
        active({ decisionMethod: 'chatgpt' }),
        { type: 'propose_prompt', text },
        'a',
        now,
      ),
      { type: 'approve_prompt' },
      'b',
      now,
    );
    for (const spaced of [
      'Decide this wager fairly.   \nUse only the agreed terms and evidence.',
      'Decide this  wager fairly.\nUse only the agreed   terms and evidence.',
      'Decide this wager fairly.\r\nUse only the agreed terms and evidence.\t',
    ])
      expect(() =>
        applyAction(agreed, { type: 'propose_prompt', text: spaced }, 'b', later),
      ).toThrow(/identical to version 1/);
    expect(agreed.promptAgreement?.approvals).toEqual(['a', 'b']);
  });
});

describe('judge vocabulary on the stored record', () => {
  it('says a recommendation, not a ruling, when a judge steps down', () => {
    const declined = applyAction(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'decline_judging', note: 'I helped set the forecast.' },
      'c',
      now,
    );
    expect(declined.events.at(-1)?.detail).toBe(
      'Declined to act as judge: I helped set the forecast. Both bettors must agree on a new judge or decision method before a recommendation can be recorded.',
    );
  });
});
