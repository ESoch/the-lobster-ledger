import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTE, contrastRatio, textColorFor } from './avatar-colors';
import { createDemoState } from './demo';
import { getMemberStats } from './ledger';
import type { Bet, BetStatus, LedgerState } from './types';
import { demoPriceObservationSchema, restaurantSchema } from './api-schemas';
import { isLiveReport, itemKey } from './price-observations';

const isParticipant = (bet: Bet, id: string) => id === bet.creatorId || id === bet.opponentId;
const bothApproved = (bet: Bet, approvals: string[] | undefined) =>
  !!approvals && [bet.creatorId, bet.opponentId].every((id) => approvals.includes(id));

describe('demo data invariants', () => {
  const demo = createDemoState();
  const memberIds = new Set(demo.members.map((member) => member.id));

  it('gives every member their own palette colour with initials that reach 4.5:1', () => {
    expect(new Set(demo.members.map((member) => member.color)).size).toBe(demo.members.length);
    for (const member of demo.members) {
      expect(AVATAR_PALETTE).toContain(member.color);
      expect(contrastRatio(textColorFor(member.color), member.color)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('covers every status the ledger can produce', () => {
    const statuses = new Set(demo.bets.map((bet) => bet.status));
    const all: BetStatus[] = [
      'pending',
      'active',
      'confirming',
      'owed',
      'settling',
      'settled',
      'voided',
      'declined',
    ];
    expect([...statuses].sort()).toEqual([...all].sort());
  });

  it('references only registered members everywhere', () => {
    for (const bet of demo.bets) {
      expect(memberIds.has(bet.creatorId)).toBe(true);
      expect(memberIds.has(bet.opponentId)).toBe(true);
      expect(bet.creatorId).not.toBe(bet.opponentId);
      for (const id of bet.agreementApprovals) expect(memberIds.has(id)).toBe(true);
      for (const event of bet.events) expect(memberIds.has(event.actorId)).toBe(true);
      if (bet.resolution?.winnerId) expect(memberIds.has(bet.resolution.winnerId)).toBe(true);
      if (bet.judgeId) {
        expect(memberIds.has(bet.judgeId)).toBe(true);
        expect(isParticipant(bet, bet.judgeId)).toBe(false);
      }
      if (bet.history) {
        expect(memberIds.has(bet.history.proposedBy)).toBe(true);
        for (const approval of bet.history.approvals)
          expect(memberIds.has(approval.actorId)).toBe(true);
      }
      if (bet.promptAgreement) {
        expect(memberIds.has(bet.promptAgreement.proposedBy)).toBe(true);
        for (const id of bet.promptAgreement.approvals) expect(memberIds.has(id)).toBe(true);
      }
      if (bet.adjudication) expect(memberIds.has(bet.adjudication.recordedBy)).toBe(true);
    }
    for (const observation of demo.priceObservations ?? [])
      expect(memberIds.has(observation.reporterId)).toBe(true);
  });

  it('keeps outcome and delivery stakeholders within the two bettors', () => {
    for (const bet of demo.bets) {
      if (bet.resolution?.winnerId) expect(isParticipant(bet, bet.resolution.winnerId)).toBe(true);
      if (bet.history?.result?.winnerId)
        expect(isParticipant(bet, bet.history.result.winnerId)).toBe(true);
      if (bet.settlement) expect(isParticipant(bet, bet.settlement.proposedBy)).toBe(true);
      if (bet.promptAgreement)
        expect(isParticipant(bet, bet.promptAgreement.proposedBy)).toBe(true);
      if (bet.decisionMethod === 'judge') {
        expect(bet.judgeId).toBeTruthy();
        expect(bet.judgeId).not.toBe(bet.opponentId);
      }
      if (bet.decisionMethod === 'chatgpt') {
        expect(bet.promptAgreement).toBeTruthy();
        if (bet.adjudication)
          expect(bet.adjudication.promptVersion).toBe(bet.promptAgreement?.version);
      }
    }
  });

  it('keeps versioning and event logs consistent with the state machine', () => {
    for (const bet of demo.bets) {
      expect(bet.version).toBeGreaterThanOrEqual(1);
      expect(bet.version).toBe(bet.events.length);
      expect(bet.updatedAt).toBe(bet.events[bet.events.length - 1].at);
      for (const event of bet.events)
        expect(Date.parse(event.at)).toBeGreaterThanOrEqual(Date.parse(bet.createdAt));
      const actionEvents = bet.events.slice(1).map((event) => event.type);
      expect(actionEvents).not.toContain('created');
      expect(new Set(actionEvents).size).toBe(actionEvents.length);
    }
  });

  it('keeps lifecycle records coherent with each status', () => {
    for (const bet of demo.bets) {
      if (['owed', 'settling', 'settled'].includes(bet.status)) {
        expect(bet.resolution?.winnerId).toBeTruthy();
        expect(bothApproved(bet, bet.agreementApprovals)).toBe(true);
        expect(bothApproved(bet, bet.resolution?.approvals)).toBe(true);
      }
      if (bet.status === 'confirming') {
        expect(bet.resolution).toBeTruthy();
        if ((bet.decisionMethod ?? 'mutual') === 'mutual')
          expect(bet.resolution?.approvals).toHaveLength(1);
      }
      if (bet.status === 'settling') {
        expect(bet.settlement?.method).toBe('roll');
        expect(bet.settlement?.approvals).toHaveLength(1);
      }
      if (bet.status === 'settled') {
        expect(bet.settlement?.method).toBe('roll');
        expect(bothApproved(bet, bet.settlement?.approvals)).toBe(true);
        expect(bet.settlement?.note.trim().length ?? 0).toBeGreaterThan(0);
      }
      if (bet.status === 'voided') expect(bet.resolution?.winnerId ?? null).toBeNull();
      if (['pending', 'declined'].includes(bet.status)) {
        expect(bet.resolution).toBeUndefined();
        expect(bet.settlement).toBeUndefined();
      }
    }
  });

  it('uses unique identifiers across the ledger', () => {
    const ids = [
      ...demo.members.map((member) => member.id),
      ...demo.places.map((place) => place.id),
      ...(demo.restaurants ?? []).map((restaurant) => restaurant.id),
      ...(demo.priceObservations ?? []).map((observation) => observation.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    const betIds = demo.bets.map((bet) => bet.id);
    expect(new Set(betIds).size).toBe(betIds.length);
    const references = demo.bets.map((bet) => bet.reference);
    expect(new Set(references).size).toBe(references.length);
    for (const bet of demo.bets) {
      const eventIds = bet.events.map((event) => event.id);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    }
  });

  it('anchors price observations to real restaurants and members', () => {
    const restaurantIds = new Set((demo.restaurants ?? []).map((restaurant) => restaurant.id));
    const observations = demo.priceObservations ?? [];
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(restaurantIds.has(observation.restaurantId)).toBe(true);
      expect(observation.priceCents).toBeGreaterThan(0);
      expect(observation.currency).toBe('USD');
      expect(Number.isNaN(Date.parse(observation.reportedAt))).toBe(false);
      const parseableVisitDate =
        observation.visitDatePrecision === 'day' ||
        observation.visitDatePrecision === 'month' ||
        observation.visitDatePrecision === 'year';
      expect(parseableVisitDate).toBe(true);
    }
  });

  it('produces a structurally identical ledger on every call', () => {
    const replayed = createDemoState();
    const normalize = (state: LedgerState) =>
      JSON.stringify({
        ...state,
        bets: state.bets.map(({ id: _id, reference: _reference, events, ...bet }) => ({
          ...bet,
          events: events.map(({ id: _eventId, ...event }) => event),
        })),
      });
    expect(normalize(replayed)).toBe(normalize(demo));
  });

  it('builds coherent member statistics across the ledger', () => {
    let totalWins = 0;
    let totalLosses = 0;
    for (const member of demo.members) {
      const stats = getMemberStats(demo.bets, member.id);
      expect(stats.won + stats.lost).toBeLessThanOrEqual(demo.bets.length);
      expect(stats.winRate).toBe((stats.won / Math.max(1, stats.won + stats.lost)) * 100);
      totalWins += stats.won;
      totalLosses += stats.lost;
    }
    expect(totalWins).toBe(totalLosses);
    expect(totalWins).toBeGreaterThan(0);
  });
});

describe('the sample price reports', () => {
  const demo = createDemoState();
  const observations = demo.priceObservations ?? [];

  it('pass the same schemas the ledger checks a report and a restaurant with', () => {
    for (const restaurant of demo.restaurants ?? []) {
      const { id: _, ...fields } = restaurant;
      expect(restaurantSchema.safeParse(fields).success, restaurant.id).toBe(true);
    }
    for (const observation of observations) {
      const {
        id: _,
        reporterId: __,
        reportedAt: ___,
        currency: ____,
        correctedFromId: _____,
        correctedAt: ______,
        withdrawnAt: _______,
        withdrawnReason: ________,
        entrySource: _________,
        ...input
      } = observation;
      const parsed = demoPriceObservationSchema.safeParse(input);
      expect(parsed.success, `${observation.id}: ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
  });

  it('cover the cases the price views must handle', () => {
    const live = observations.filter(isLiveReport);
    const grouped = (key: (item: (typeof live)[number]) => string) => {
      const groups = new Map<string, typeof live>();
      for (const item of live) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
      return [...groups.values()];
    };
    // A second item at one restaurant.
    expect(
      grouped((item) => item.restaurantId).some(
        (reports) => new Set(reports.map((item) => itemKey(item.itemName))).size > 1,
      ),
    ).toBe(true);
    // A correction chain: one replaced report and its one successor.
    const replaced = observations.filter((item) => item.correctedAt);
    expect(replaced.length).toBeGreaterThan(0);
    for (const original of replaced)
      expect(observations.filter((item) => item.correctedFromId === original.id)).toHaveLength(1);
    // A visit remembered only to the year.
    expect(live.some((item) => item.visitDatePrecision === 'year')).toBe(true);
    // A report its reporter withdrew, kept with its reason, and one entered by an AI connection.
    const withdrawn = observations.filter((item) => item.withdrawnAt);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0].withdrawnReason?.trim()).toBeTruthy();
    expect(withdrawn[0].correctedAt).toBeUndefined();
    expect(live.some((item) => item.entrySource === 'mcp')).toBe(true);
    // Two members reporting the same restaurant on the same day.
    expect(
      grouped((item) => `${item.restaurantId} ${item.visitDate}`).some(
        (reports) => new Set(reports.map((item) => item.reporterId)).size > 1,
      ),
    ).toBe(true);
  });
});
