import { describe, expect, it } from 'vitest';
import { validateCreateInput, collectBet, type WizardIO } from '../src/create';
import type { Member, LedgerState } from '../../src/lib/types';
const members: Member[] = [
  { id: 'a', name: 'Alex', initials: 'A', color: '#000' },
  { id: 'b', name: 'Blair', initials: 'B', color: '#000' },
  { id: 'c', name: 'Casey', initials: 'C', color: '#000' },
];
const ledger: LedgerState = { members, bets: [], places: [], groupName: 'Friends' };
const base = () => ({
  bet: {
    title: 'Release before Friday',
    terms: 'The published release timestamp decides the outcome.',
    category: 'Work',
    opponentId: 'b',
    creatorSide: 'Before Friday',
    opponentSide: 'Friday or later',
    stake: 2,
    decisionMethod: 'mutual',
    timing: {
      kind: 'event',
      description: 'The release is published',
      source: 'Official release page',
    },
  },
});
describe('complete wager input', () => {
  it('collects historical result, adjudication, delivery, and three distinct acknowledgements', async () => {
    const answers: Record<string, string> = {
      stage: 'settled',
      opponentId: 'b',
      title: 'Old release wager',
      category: 'Work',
      creatorSide: 'Before Friday',
      opponentSide: 'Friday or later',
      stake: '1',
      terms: 'The published release timestamp decides who wins.',
      decisionMethod: 'mutual',
      'timing.enabled': 'no',
      'cutoff.enabled': 'no',
      'location.mode': 'none',
      'history.originalDate.precision': 'month',
      'history.originalDate.value': '2025-01',
      'history.result.winnerId': 'b',
      'history.result.date.precision': 'day',
      'history.result.date.value': '2025-02-01',
      'history.result.note': 'Released Friday',
      'history.previousAdjudication.method': 'judge',
      'history.previousAdjudication.note': 'Casey compared the release timestamp',
      'history.previousAdjudication.sourceUrl': 'https://example.com/release',
      'history.delivery.date.precision': 'unknown',
      'history.delivery.note': 'Bought and delivered one actual lobster roll',
      'acknowledgements.terms': 'yes',
      'acknowledgements.result': 'yes',
      'acknowledgements.delivery': 'yes',
    };
    const asked: string[] = [];
    const io: WizardIO = {
      ask: async (key) => {
        asked.push(key);
        if (!(key in answers)) throw new Error(`Missing test answer: ${key}`);
        return answers[key];
      },
      print: () => {},
    };
    const input = validateCreateInput(await collectBet(io, ledger, 'a'), 'a', members);
    expect(input.bet.history).toMatchObject({
      stage: 'settled',
      result: { winnerId: 'b' },
      delivery: { date: { precision: 'unknown' } },
      previousAdjudication: { method: 'judge' },
    });
    expect(input.bet.acknowledgements).toEqual({ terms: true, result: true, delivery: true });
    expect(asked.filter((key) => key.startsWith('acknowledgements.'))).toHaveLength(3);
    expect(asked).not.toContain('prompt');
  });
  it('validates every server field with the canonical agreement rules', () => {
    const input = {
      bet: {
        ...base().bet,
        decisionMethod: 'judge',
        judgeId: 'c',
        timing: {
          kind: 'date',
          at: '2030-01-15T18:00:00-08:00',
          timezone: 'America/Los_Angeles',
          source: 'Official release page',
          checkIn: { at: '2030-01-14T18:00:00-08:00', timezone: 'America/Los_Angeles' },
        },
        cutoff: { at: '2030-01-14T18:00:00-08:00', timezone: 'America/Los_Angeles' },
        location: { id: 'place-1', name: 'Office', address: '1 Main St', lat: 35, lng: -118 },
      },
    };
    expect(validateCreateInput(input, 'a', members).bet).toEqual(input.bet);
  });
  it('reports missing and unknown fields instead of silently filling or dropping them', () => {
    expect(() =>
      validateCreateInput(
        { bet: { ...base().bet, creatorSide: undefined, stkae: 3 } },
        'a',
        members,
      ),
    ).toThrow(/creatorSide|stkae/);
    expect(() => validateCreateInput({ ...base(), approvals: ['a', 'b'] }, 'a', members)).toThrow(
      /approvals|Unrecognized/,
    );
    expect(() =>
      validateCreateInput(
        {
          bet: {
            ...base().bet,
            timing: { kind: 'event', description: 'Release', at: '2030-01-01T00:00:00Z' },
          },
        },
        'a',
        members,
      ),
    ).toThrow(/at|Unrecognized/);
  });
  it('rejects contradictory judging, timing, history, and acknowledgements', () => {
    expect(() =>
      validateCreateInput({ bet: { ...base().bet, judgeId: 'c' } }, 'a', members),
    ).toThrow(/judge/);
    expect(() =>
      validateCreateInput({ bet: { ...base().bet, deadline: '2030-01-01' } }, 'a', members),
    ).toThrow(/deadline|timing/);
    expect(() =>
      validateCreateInput(
        {
          bet: {
            ...base().bet,
            history: { stage: 'active', originalDate: { precision: 'unknown' } },
            acknowledgements: { terms: true, result: true, delivery: false },
          },
        },
        'a',
        members,
      ),
    ).toThrow(/acknowledgements|result/);
  });
  it('requires explicit physical delivery acknowledgement for completed historical wagers', () => {
    const input = {
      bet: {
        ...base().bet,
        history: {
          stage: 'settled',
          originalDate: { precision: 'month', value: '2025-01' },
          result: {
            winnerId: 'b',
            date: { precision: 'day', value: '2025-02-01' },
            note: 'Release was on Friday',
          },
          delivery: {
            date: { precision: 'day', value: '2025-02-05' },
            note: 'Bought and delivered two actual lobster rolls',
          },
          previousAdjudication: {
            method: 'chatgpt',
            note: 'Recorded our agreed prompt and response',
            sourceUrl: 'https://chatgpt.com/share/example',
          },
        },
        acknowledgements: { terms: true, result: true, delivery: true },
      },
    };
    expect(validateCreateInput(input, 'a', members).bet.history?.stage).toBe('settled');
    expect(() =>
      validateCreateInput(
        { bet: { ...input.bet, acknowledgements: { terms: true, result: true, delivery: false } } },
        'a',
        members,
      ),
    ).toThrow(/acknowledge|delivery/);
  });
  it('accepts an initial fair prompt only for a new ChatGPT wager', () => {
    const prompt = 'Determine which position is correct using the agreed evidence.';
    expect(
      validateCreateInput(
        { bet: { ...base().bet, decisionMethod: 'chatgpt' }, prompt },
        'a',
        members,
      ).prompt,
    ).toBe(prompt);
    expect(() => validateCreateInput({ ...base(), prompt }, 'a', members)).toThrow(/ChatGPT/);
  });
  it('guides all conditional event, cutoff, judge, and custom map fields', async () => {
    const answers: Record<string, string> = {
      stage: 'new',
      opponentId: 'b',
      title: 'Release before Friday',
      category: 'Work',
      creatorSide: 'Before Friday',
      opponentSide: 'Friday or later',
      stake: '2',
      terms: 'The published timestamp decides who wins.',
      decisionMethod: 'judge',
      judgeId: 'c',
      'timing.kind': 'event',
      'timing.description': 'The release is published',
      'timing.source': 'Release page',
      'timing.checkIn.enabled': 'yes',
      'timing.checkIn.at': '2030-01-01T18:00:00-08:00',
      'timing.checkIn.timezone': 'America/Los_Angeles',
      'cutoff.enabled': 'yes',
      'cutoff.at': '2029-12-31T18:00:00-08:00',
      'cutoff.timezone': 'America/Los_Angeles',
      'location.mode': 'custom',
      'location.name': 'Office',
      'location.address': '1 Main St',
      'location.lat': '35',
      'location.lng': '-118',
    };
    const asked: string[] = [];
    const io: WizardIO = {
      ask: async (key) => {
        asked.push(key);
        if (!(key in answers)) throw new Error(`Missing test answer: ${key}`);
        return answers[key];
      },
      print: () => {},
    };
    const input = await collectBet(io, ledger, 'a');
    expect(await collectBet(io, ledger, 'a')).toEqual(input);
    expect(input.bet).toMatchObject({
      judgeId: 'c',
      cutoff: { timezone: 'America/Los_Angeles' },
      timing: { kind: 'event', checkIn: { at: '2030-01-01T18:00:00-08:00' } },
      location: { name: 'Office', lat: 35, lng: -118 },
    });
    expect(asked).toContain('timing.source');
    expect(() => validateCreateInput(input, 'a', members)).not.toThrow();
  });
});
