import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionSchema,
  demoPriceObservationSchema,
  demoPriceReportSchema,
  inviteSchema,
  newBetSchema,
  priceObservationSchema,
  priceReportSchema,
  restaurantSchema,
  visitDateSchema,
} from './api-schemas';
import { LIMITS } from './limits';
import { MEMBER_NAME_BLANK, MEMBER_NAME_TOO_LONG } from './member-name';

describe('bet action schema', () => {
  it.each(['withdraw', 'withdraw_proposal', 'decline_judging', 'dispute_readiness'] as const)(
    'parses %s with a reason and nothing else',
    (type) => {
      expect(actionSchema.parse({ type, note: ' Changed my mind. ' })).toEqual({
        type,
        note: 'Changed my mind.',
      });
      expect(actionSchema.safeParse({ type }).success).toBe(false);
      expect(actionSchema.safeParse({ type, note: '  ' }).success).toBe(false);
      expect(actionSchema.safeParse({ type, note: 'x'.repeat(LIMITS.note.max + 1) }).success).toBe(
        false,
      );
      expect(actionSchema.safeParse({ type, note: 'Reason', extra: true }).success).toBe(false);
    },
  );
  it('lets an amendment name a new judge or decision method', () => {
    const base = {
      type: 'propose_amendment',
      terms: 'Use the final audited numbers.',
      timing: { kind: 'event', description: 'The audit is published' },
      note: 'Our judge stepped down.',
    };
    expect(actionSchema.parse(base)).toMatchObject({ type: 'propose_amendment' });
    expect(
      actionSchema.parse({ ...base, decisionMethod: 'judge', judgeId: 'casey' }),
    ).toMatchObject({ decisionMethod: 'judge', judgeId: 'casey' });
    expect(actionSchema.parse({ ...base, decisionMethod: 'mutual' })).toMatchObject({
      decisionMethod: 'mutual',
    });
    expect(actionSchema.safeParse({ ...base, decisionMethod: 'oracle' }).success).toBe(false);
    expect(actionSchema.safeParse({ ...base, judgeId: '' }).success).toBe(false);
    expect(
      actionSchema.safeParse({ ...base, terms: 'x'.repeat(LIMITS.terms.max + 1) }).success,
    ).toBe(false);
  });
  it('allows a long ChatGPT response as the recorded reasoning', () => {
    expect(
      actionSchema.safeParse({
        type: 'adjudicate',
        winnerId: null,
        note: 'x'.repeat(LIMITS.response.max),
      }).success,
    ).toBe(true);
    expect(
      actionSchema.safeParse({
        type: 'adjudicate',
        winnerId: null,
        note: 'x'.repeat(LIMITS.response.max + 1),
      }).success,
    ).toBe(false);
  });
});

describe('new bet schema', () => {
  const bet = {
    title: 'The launch ships on Friday',
    terms: 'Production deployment before 5 pm Boston time.',
    category: 'Work',
    opponentId: 'b',
    creatorSide: 'It ships on time',
    opponentSide: 'It slips',
    stake: 2,
    deadline: '2026-09-05',
  };
  it('shares the engine limits for trimmed text', () => {
    expect(newBetSchema.safeParse(bet).success).toBe(true);
    expect(newBetSchema.safeParse({ ...bet, title: 'ab   ' }).success).toBe(false);
    expect(
      newBetSchema.safeParse({ ...bet, title: 'x'.repeat(LIMITS.title.max + 1) }).success,
    ).toBe(false);
    expect(newBetSchema.safeParse({ ...bet, terms: 'a         ' }).success).toBe(false);
    expect(
      newBetSchema.safeParse({ ...bet, terms: 'x'.repeat(LIMITS.terms.max + 1) }).success,
    ).toBe(false);
    expect(
      newBetSchema.safeParse({ ...bet, creatorSide: 'x'.repeat(LIMITS.side.max + 1) }).success,
    ).toBe(false);
    expect(
      newBetSchema.safeParse({ ...bet, creatorSide: 'x'.repeat(LIMITS.side.max) }).success,
    ).toBe(true);
  });
});

describe('invite schema', () => {
  it('keeps the name the inviter typed, trimmed and with its inner spaces collapsed', () => {
    expect(inviteSchema.parse({ name: '  jamie   chen  ' })).toEqual({ name: 'jamie chen' });
  });
  it('shares the member name limit, measured on the cleaned name', () => {
    expect(inviteSchema.safeParse({ name: 'x'.repeat(LIMITS.memberName.max) }).success).toBe(true);
    expect(
      inviteSchema.safeParse({ name: `  ${'x'.repeat(LIMITS.memberName.max)}  ` }).success,
    ).toBe(true);
    const over = inviteSchema.safeParse({ name: 'x'.repeat(LIMITS.memberName.max + 1) });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]).toMatchObject({ path: ['name'], message: MEMBER_NAME_TOO_LONG });
    const blank = inviteSchema.safeParse({ name: ' \n ' });
    expect(blank.error?.issues[0]).toMatchObject({ path: ['name'], message: MEMBER_NAME_BLANK });
  });
  it('refuses a missing, blank or non-text name and any extra field', () => {
    for (const body of [{}, { name: '' }, { name: ' \n ' }, { name: 7 }, { name: 'Jo', extra: 1 }])
      expect(inviteSchema.safeParse(body).success).toBe(false);
  });
});

describe('price report schemas', () => {
  const restaurantId = '7f9d1d36-8a39-4f43-9d0a-4f1b7f5f2a10';
  const report = {
    restaurantId,
    itemName: 'Classic lobster roll',
    priceCents: 2800,
    visitDate: '2026-09-11',
    visitDatePrecision: 'day',
  };
  const visit = (visitDate: string, visitDatePrecision = 'day') =>
    visitDateSchema.safeParse({ visitDate, visitDatePrecision });
  afterEach(() => vi.useRealTimers());

  it('takes only real calendar days at day precision', () => {
    expect(visit('2026-02-28').success).toBe(true);
    expect(visit('2024-02-29').success).toBe(true);
    for (const impossible of ['2026-02-31', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10'])
      expect(visit(impossible).success, impossible).toBe(false);
    expect(visit('2026-13', 'month').success).toBe(false);
    expect(visit('2026-00', 'month').success).toBe(false);
    expect(visit('2026-09', 'month').success).toBe(true);
    // The date must say exactly as much as its precision.
    expect(visit('2026-09', 'day').success).toBe(false);
    expect(visit('2026-09-11', 'year').success).toBe(false);
  });

  it('refuses a visit that has not happened anywhere yet, or one before 1900', () => {
    // 10:30 on Oct 18 in UTC is already Oct 19 in Kiribati (UTC+14), and nowhere is it Oct 20.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:30:00Z'));
    expect(visit('2026-10-19').success).toBe(true);
    expect(visit('2026-10-20').success).toBe(false);
    expect(visit('2026-10', 'month').success).toBe(true);
    expect(visit('2026-11', 'month').success).toBe(false);
    expect(visit('2026', 'year').success).toBe(true);
    expect(visit('2027', 'year').success).toBe(false);
    expect(visit('2099-01-01').success).toBe(false);
    expect(visit('1900', 'year').success).toBe(true);
    expect(visit('1899', 'year').success).toBe(false);
    expect(visit('1899-12-31').success).toBe(false);
    const future = visit('2099-01-01');
    expect(future.error?.issues[0]).toMatchObject({
      path: ['visitDate'],
      message: 'Use a visit date that has already happened.',
    });
  });

  it('checks the same visit date in a report and in a correction', () => {
    for (const schema of [priceObservationSchema, priceReportSchema]) {
      expect(schema.safeParse(report).success).toBe(true);
      expect(schema.safeParse({ ...report, visitDate: '2026-02-31' }).success).toBe(false);
      expect(schema.safeParse({ ...report, visitDate: '2099-01-01' }).success).toBe(false);
    }
  });

  it('takes a chosen restaurant or a new one named in the same report, never both or neither', () => {
    const { restaurantId: _, ...withoutRestaurant } = report;
    const restaurant = { name: ' Pearl Street Clam Bar ', address: 'Fort Point' };
    expect(priceReportSchema.parse({ ...withoutRestaurant, restaurant })).toMatchObject({
      restaurant: { name: 'Pearl Street Clam Bar', address: 'Fort Point' },
    });
    expect(
      priceReportSchema.parse({ ...withoutRestaurant, restaurant: { name: 'Dockside' } }),
    ).toMatchObject({ restaurant: { name: 'Dockside', address: '' } });
    expect(priceReportSchema.safeParse(withoutRestaurant).success).toBe(false);
    expect(priceReportSchema.safeParse({ ...report, restaurant }).success).toBe(false);
    expect(priceReportSchema.safeParse({ ...report, confirmSeparateReport: true }).success).toBe(
      true,
    );
    // A correction keeps its restaurant id and cannot add a restaurant.
    expect(priceObservationSchema.safeParse({ ...withoutRestaurant, restaurant }).success).toBe(
      false,
    );
  });

  it('wants both coordinates of a restaurant or neither', () => {
    expect(restaurantSchema.safeParse({ name: 'Dockside', lat: 42.35 }).success).toBe(false);
    expect(restaurantSchema.safeParse({ name: 'Dockside', lng: -71.05 }).success).toBe(false);
    expect(restaurantSchema.safeParse({ name: 'Dockside', lat: 42.35, lng: -71.05 }).success).toBe(
      true,
    );
    expect(restaurantSchema.safeParse({ name: 'Dockside' }).success).toBe(true);
  });

  it('keeps a restaurant and an item to the lengths the ledger stores, counted without padding', () => {
    const named = (restaurant: Record<string, unknown>) => ({
      ...report,
      restaurantId: undefined,
      restaurant,
    });
    expect(
      restaurantSchema.safeParse({ name: 'N'.repeat(160), address: 'A'.repeat(240) }).success,
    ).toBe(true);
    expect(restaurantSchema.safeParse({ name: 'N'.repeat(161) }).success).toBe(false);
    expect(restaurantSchema.safeParse({ name: 'Dockside', address: 'A'.repeat(241) }).success).toBe(
      false,
    );
    expect(restaurantSchema.safeParse({ name: `  ${'N'.repeat(160)}  ` }).success).toBe(true);
    expect(restaurantSchema.safeParse({ name: '   ' }).success).toBe(false);
    for (const schema of [priceReportSchema, demoPriceReportSchema]) {
      expect(schema.safeParse(named({ name: 'N'.repeat(161) })).success).toBe(false);
      expect(schema.safeParse(named({ name: 'Dockside', address: 'A'.repeat(241) })).success).toBe(
        false,
      );
      expect(schema.safeParse(named({ name: '   ' })).success).toBe(false);
      expect(schema.safeParse({ ...report, itemName: 'I'.repeat(160) }).success).toBe(true);
      expect(schema.safeParse({ ...report, itemName: 'I'.repeat(161) }).success).toBe(false);
      expect(schema.safeParse({ ...report, itemName: '   ' }).success).toBe(false);
    }
    for (const schema of [priceObservationSchema, demoPriceObservationSchema]) {
      expect(schema.safeParse({ ...report, itemName: '   ' }).success).toBe(false);
      expect(schema.safeParse({ ...report, itemName: 'I'.repeat(161) }).success).toBe(false);
    }
  });

  it('lets the demo use its readable ids under the same rules', () => {
    const demo = { ...report, restaurantId: 'harbor-shack' };
    expect(priceReportSchema.safeParse(demo).success).toBe(false);
    expect(demoPriceReportSchema.safeParse(demo).success).toBe(true);
    expect(demoPriceObservationSchema.safeParse(demo).success).toBe(true);
    expect(demoPriceReportSchema.safeParse({ ...demo, visitDate: '2026-02-31' }).success).toBe(
      false,
    );
    expect(demoPriceReportSchema.safeParse({ ...demo, itemName: '   ' }).success).toBe(false);
  });
});
