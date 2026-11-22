import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import type { Bet, DecisionTiming, Place } from '../lib/types';
import { BetDetail } from './BetDetail';
import { readHistoryRevision } from './HistoryRevisionFields';
import { TimingFields } from './WorkflowFields';

// Render the real detail contents without a browser-only dialog portal.
vi.mock('./ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ui')>()),
  Modal: ({ children }: { children: React.ReactNode }) => children,
}));

const state = createDemoState();
const agreedChatGptBet = (): Bet => {
  const bet = structuredClone(
    state.bets.find((candidate) => candidate.decisionMethod === 'chatgpt')!,
  );
  bet.status = 'active';
  bet.promptAgreement!.approvals = [bet.creatorId, bet.opponentId];
  return bet;
};
const detailMarkup = (bet: Bet) =>
  renderToStaticMarkup(
    createElement(BetDetail, {
      bet,
      members: state.members,
      memberId: bet.creatorId,
      onClose: () => {},
      onAction: async () => {},
    }),
  );

describe('automatically recorded entry source', () => {
  it('identifies a source reported after creation without implying automatic capture', () => {
    const markup = detailMarkup({
      ...state.bets[0],
      entrySource: 'mcp',
      entrySourceReport: {
        basis: 'user_report',
        note: 'Entered via MCP.',
        reportedAt: '2026-10-15T17:00:00.000Z',
      },
    });
    expect(markup).toContain('Entered via: MCP (reported)');
    expect(markup).toContain('Entry source reported afterward.');
  });

  it('distinguishes inferred Browser entries from directly recorded sources', () => {
    const markup = detailMarkup({
      ...state.bets[0],
      entrySource: 'browser',
      entrySourceInference: {
        basis: 'before_cli_release',
        cutoffAt: '2025-01-15T12:00:00.000Z',
        evidenceUrl: 'https://example.org/runs/12345',
        inferredAt: '2026-10-15T17:00:00.000Z',
      },
    });
    expect(markup).toContain('Entered via: Browser (inferred)');
    expect(markup).toContain('predates CLI and MCP support');
  });

  it.each([
    ['browser', 'Browser'],
    ['cli', 'CLI'],
    ['mcp', 'MCP'],
  ] as const)('shows %s as read-only information', (entrySource, label) => {
    const markup = detailMarkup({ ...state.bets[0], entrySource });
    expect(markup).toContain(`Entered via: ${label}`);
    expect(markup).not.toMatch(/<(?:input|select)[^>]*name="entrySource"/);
  });
  it('leaves the entry source out when it was never recorded', () => {
    const markup = detailMarkup({ ...state.bets[0], entrySource: undefined });
    expect(markup).not.toContain('Entered via');
    expect(markup).not.toContain('Not recorded');
  });
});

describe('agreed ChatGPT prompts while waiting for an outcome', () => {
  it.each<DecisionTiming>([
    { kind: 'date', at: '2099-09-12T09:00:00.000Z', timezone: 'UTC' },
    { kind: 'event', description: 'The tournament finishes' },
    { kind: 'evidence', description: 'Official results are published' },
  ])(
    'keeps revision available with $kind timing while response recording stays gated',
    (timing) => {
      const markup = detailMarkup({ ...agreedChatGptBet(), timing });
      expect(markup).toContain('Revise prompt and request fresh approval');
      expect(markup).not.toContain('Record ChatGPT response');
    },
  );

  it('allows response recording once the evidence is ready', () => {
    const bet = agreedChatGptBet();
    bet.timing = { kind: 'event', description: 'The tournament finishes' };
    bet.readiness = {
      markedBy: bet.creatorId,
      at: '2026-09-12T09:00:00.000Z',
      evidence: 'The published final result.',
    };
    expect(detailMarkup(bet)).toContain('Record ChatGPT response');
  });

  it('keeps prompt actions paused during an agreement change', () => {
    const bet = agreedChatGptBet();
    bet.voidProposal = {
      proposedBy: bet.creatorId,
      approvals: [bet.creatorId],
      at: '2026-09-12T09:00:00.000Z',
      note: 'The event was cancelled.',
    };
    const markup = detailMarkup(bet);
    expect(markup).not.toContain('Revise prompt and request fresh approval');
    expect(markup).not.toContain('Record ChatGPT response');
  });
});

const originalPlace: Place = {
  id: 'shared-place',
  name: 'The original restaurant',
  address: '12 Harbor Street',
  lat: 42.35,
  lng: -71.05,
};
/** A revised history that keeps a saved place by its id, or pins a new one by name and point. */
function revisionData(place: { id: string } | Pick<Place, 'name' | 'lat' | 'lng'>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    title: 'A historical wager',
    terms: 'We agreed neither person won.',
    category: 'Life',
    creatorSide: 'The original position',
    opponentSide: 'The opposing position',
    stake: '2',
    'history.stage': 'voided',
    'history.originalDate.precision': 'unknown',
    'history.resultDate.precision': 'unknown',
    'history.resultNote': 'The event was cancelled.',
    ...('id' in place
      ? { 'location.placeId': place.id }
      : {
          'location.placeId': 'custom',
          'location.name': place.name,
          'location.lat': String(place.lat),
          'location.lng': String(place.lng),
        }),
  }))
    data.set(key, value);
  return data;
}

describe('historical place corrections', () => {
  it('keeps an unchanged shared place intact', () => {
    const bet = { ...state.bets[0], location: originalPlace };
    expect(readHistoryRevision(revisionData(originalPlace), bet).location).toEqual(originalPlace);
  });

  it('reuses another saved place by its own id', () => {
    const bet = { ...state.bets[0], location: originalPlace };
    const saved = { ...originalPlace, id: 'saved-place', name: 'The harbor café' };
    expect(readHistoryRevision(revisionData(saved), bet, [saved]).location).toEqual(saved);
  });

  it.each([
    { ...originalPlace, name: 'A different restaurant' },
    { ...originalPlace, lat: 42.4 },
    { ...originalPlace, lng: -71.2 },
  ])(
    'separates a newly pinned place from other bets sharing its original identity',
    (correctedPlace) => {
      const bet = { ...state.bets[0], location: originalPlace };
      const { id: _id, ...pinned } = correctedPlace;
      const location = readHistoryRevision(revisionData(pinned), bet).location!;
      expect(location.id).not.toBe(originalPlace.id);
      expect(location).toMatchObject({
        name: correctedPlace.name,
        lat: correctedPlace.lat,
        lng: correctedPlace.lng,
        address: 'Pinned location',
      });
      expect(bet.location).toEqual(originalPlace);
    },
  );
});

describe('timing explanations', () => {
  it.each<DecisionTiming>([
    { kind: 'event', description: 'The tournament finishes' },
    { kind: 'evidence', description: 'Official results are published' },
  ])('explains that $kind review needs evidence and check-ins only prompt a check', (timing) => {
    const checkIn = { at: '2026-12-01T12:00:00.000Z', timezone: 'UTC' };
    const markup = renderToStaticMarkup(
      createElement(TimingFields, { timing: { ...timing, checkIn } }),
    );
    expect(markup).toContain('Review opens when either of you adds');
    expect(markup).toContain('A check-in reminds you to look for evidence');
    expect(markup).not.toContain('Review opens at this time');
  });
});
