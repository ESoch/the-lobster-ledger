// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { historyRevisionOf } from '../lib/bet-workflow';
import { applyAction, applyDebtOffset, createBet } from '../lib/ledger';
import type { Bet } from '../lib/types';
import { BetDetail } from './BetDetail';

// Render the real detail contents without the Radix dialog portal.
vi.mock('./ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ui')>()),
  Modal: ({ children }: { children: React.ReactNode }) => children,
}));

const state = createDemoState();
const longToken = `https://www.espn.com/nfl/game/_/gameId/${'0123456789'.repeat(16)}`;
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

async function renderDetail(bet: Bet, memberId = bet.creatorId) {
  await act(async () =>
    root.render(
      createElement(BetDetail, {
        bet,
        members: state.members,
        memberId,
        onClose: () => {},
        onAction: async () => {},
      }),
    ),
  );
}

describe('bet sheet with unbroken text', () => {
  const bet: Bet = {
    ...state.bets[0],
    title: longToken,
    creatorSide: longToken,
    opponentSide: 'Short and sweet',
    terms: longToken,
  };

  it('renders both positions and the title in full', async () => {
    await renderDetail(bet);
    const cards = [...container.querySelectorAll('.position-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('p')!.textContent).toBe(`“${longToken}”`);
    expect(cards[1].querySelector('p')!.textContent).toBe('“Short and sweet”');
    expect(container.querySelector('.detail-title')!.textContent).toBe(longToken);
  });

  it('keeps both position tracks shrinkable so the second card cannot be pushed off-screen', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
    const rule = css.match(/\.detail-positions\s*\{[^}]*\}/)![0];
    expect(rule).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });
});

describe('entry source notes', () => {
  it('give the inference and report notes their own spaced class', async () => {
    await renderDetail({
      ...state.bets[0],
      entrySource: 'mcp',
      entrySourceInference: {
        basis: 'before_cli_release',
        cutoffAt: '2025-01-15T12:00:00.000Z',
        evidenceUrl: 'https://example.org/runs/12345',
        inferredAt: '2026-10-15T17:00:00.000Z',
      },
      entrySourceReport: {
        basis: 'user_report',
        note: 'Entered via MCP.',
        reportedAt: '2026-10-15T17:00:00.000Z',
      },
    });
    const notes = [...container.querySelectorAll('p.entry-source-note')];
    expect(notes.map((note) => note.textContent)).toEqual([
      'Browser entry inferred because this record predates CLI and MCP support. The original wager history is unchanged.',
      'Entry source reported afterward. Entered via MCP.',
    ]);
  });
});

describe('read-only notice', () => {
  it('sits directly in the bet sheet so the sheet can space it from the record above', async () => {
    await renderDetail(state.bets[0], 'james');
    const note = container.querySelector('.form-note')!;
    expect(note.textContent).toContain('can act on this bet');
    expect(note.parentElement!.classList.contains('bet-detail')).toBe(true);
  });
});

describe('offset record in the sheet', () => {
  const [actor, other] = state.members.slice(0, 2);
  const owed = (stake: number, winnerId: string, title: string) => {
    let bet = createBet(
      {
        title,
        terms: 'The official result determines who won.',
        category: 'Life',
        creatorSide: 'Yes',
        opponentSide: 'No',
        opponentId: other.id,
        stake,
        deadline: '2026-10-01',
      },
      actor.id,
      state.members,
      '2026-10-01T12:00:00Z',
    );
    bet = applyAction(bet, { type: 'accept' }, other.id);
    bet = applyAction(
      bet,
      { type: 'propose_result', winnerId, note: 'Official result.' },
      actor.id,
    );
    return applyAction(bet, { type: 'confirm_result' }, other.id);
  };
  const lost = owed(2, other.id, 'Lost bet');
  const won = owed(5, actor.id, 'Won bet');
  const preview = {
    counterpartyId: other.id,
    rolls: 2,
    allocations: [
      { betId: won.id, version: won.version, rolls: 2 },
      { betId: lost.id, version: lost.version, rolls: 2 },
    ],
  };
  const applied = applyDebtOffset([lost, won], preview, actor.id).bets;
  const offsetLost = applied.find((bet) => bet.id === lost.id)!;
  const onOpenBet = vi.fn();
  async function renderRecord(extra: { bets?: Bet[]; onOpenBet?: (id: string) => void } = {}) {
    await act(async () =>
      root.render(
        createElement(BetDetail, {
          bet: offsetLost,
          members: state.members,
          memberId: actor.id,
          onClose: () => {},
          onAction: async () => {},
          ...extra,
        }),
      ),
    );
    return container.querySelector<HTMLElement>('.offset-record')!;
  }
  beforeEach(() => {
    onOpenBet.mockReset();
    window.history.replaceState({}, '', '/?demo=1#ledger');
  });
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('leads with an icon and a text column that fills the block', async () => {
    const record = await renderRecord({ bets: applied, onOpenBet });
    expect(record.querySelector(':scope > svg')).not.toBeNull();
    expect(record.querySelector(':scope > div')!.querySelector('h3')!.textContent).toBe(
      'Settled by offset',
    );
  });

  it('lists each linked bet with who won it and how much of it was offset', async () => {
    const record = await renderRecord({ bets: applied, onOpenBet });
    const rows = [...record.querySelectorAll('li')].map((row) => row.textContent);
    const wonRef = applied.find((bet) => bet.id === won.id)!.reference;
    expect(rows).toEqual([`Offset against ${wonRef} · ${actor.name} won · 2 offset`]);
  });

  it('leaves out who won when the other bets are not at hand', async () => {
    const record = await renderRecord({ onOpenBet });
    const wonRef = applied.find((bet) => bet.id === won.id)!.reference;
    expect([...record.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
      `Offset against ${wonRef} · 2 offset`,
    ]);
  });

  it('opens a linked bet in the app instead of reloading, and keeps the demo in a new tab', async () => {
    const record = await renderRecord({ bets: applied, onOpenBet });
    const link = record.querySelector<HTMLAnchorElement>('li a')!;
    expect(link.classList.contains('link-button')).toBe(true);
    expect(new URL(link.href).searchParams.get('demo')).toBe('1');
    expect(new URL(link.href).searchParams.get('bet')).toBe(won.id);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => void link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenBet).toHaveBeenCalledWith(won.id);
  });

  it('shows a short reference to the offset and keeps the full id in its title', async () => {
    const record = await renderRecord({ bets: applied, onOpenBet });
    const offset = offsetLost.offsets![0];
    expect(record.textContent).toContain(`Offset ${offset.id.slice(0, 8)}.`);
    expect(record.textContent).not.toContain(offset.id);
    expect(record.querySelector(`[title="${offset.id}"]`)).not.toBeNull();
  });
});

describe('the next step on a reported past bet', () => {
  const [ellis, marcus] = ['Ellis', 'Marcus'].map((name) =>
    state.members.find((member) => member.name === name)!,
  );
  const reported = () =>
    createBet(
      {
        title: 'The kettle lasts until spring',
        terms: 'It must still boil water on the first day of spring.',
        category: 'Life',
        opponentId: marcus.id,
        creatorSide: 'It lasts',
        opponentSide: 'It breaks',
        stake: 1,
        timing: { kind: 'event', description: 'The first day of spring' },
        history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      ellis.id,
      state.members,
      '2026-10-01T12:00:00.000Z',
    );
  const corrected = () =>
    applyAction(
      reported(),
      { type: 'request_history_correction', note: 'It was two rolls, not one.' },
      marcus.id,
      '2026-10-01T13:00:00.000Z',
    );
  const step = () => container.querySelector('.next-action')!;
  const buttons = () =>
    [...step().querySelectorAll('.action-buttons button')].map((button) => [
      button.textContent?.trim(),
      button.classList.contains('button-primary'),
    ]);

  it('tells the bettor who asked for a correction what happens next, with Revise history first', async () => {
    await renderDetail(corrected(), marcus.id);
    expect(step().querySelector('p')?.textContent).toMatch(/^You asked for a correction/);
    expect(step().textContent).not.toContain('Review the requested correction above');
    expect(buttons()[0]).toEqual(['Revise history', true]);
  });

  it('asks the proposer to revise their report to answer the correction', async () => {
    await renderDetail(corrected(), ellis.id);
    expect(step().querySelector('p')?.textContent).toMatch(/^Marcus asked for a correction/);
    expect(buttons()[0]).toEqual(['Revise history', true]);
    expect(buttons().map(([label]) => label)).not.toContain('Request a correction');
  });

  it('explains the choices in front of the other bettor, in words about the history in front of them', async () => {
    await renderDetail(reported(), marcus.id);
    const options = step().querySelector('.step-options')!;
    expect(options.textContent).toContain('Confirm if the history above is right.');
    expect(options.textContent).toContain(
      'Request a correction to ask Ellis for a change: nothing can be confirmed until it is revised.',
    );
    expect(options.textContent).toContain(
      'Revise history makes the change yourself, and you both confirm the new version.',
    );
    // The explanation follows the buttons it is about, and the buttons point at it.
    expect(
      step().querySelector('.action-buttons')!.compareDocumentPosition(options) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const revise = [...step().querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Revise history',
    )!;
    expect(revise.getAttribute('aria-describedby')).toBe(options.id);
  });

  it('tells the proposer that revising replaces their report and leaves the earlier one on record', async () => {
    await renderDetail(reported(), ellis.id);
    const options = step().querySelector('.step-options')!;
    expect(options.textContent).toContain('Revise history replaces your report');
    expect(options.textContent).toContain('stays in the paper trail');
    expect(options.textContent).not.toContain('Request a correction');
  });

  it('adds no explanation once a correction is open, where the sentence above already says it', async () => {
    await renderDetail(corrected(), marcus.id);
    expect(step().querySelector('.step-options')).toBeNull();
  });

  it('keeps who made a revision and when above the replaced version it opens, not below it', async () => {
    const first = reported();
    const revised = applyAction(
      first,
      {
        type: 'revise_history',
        revision: { ...historyRevisionOf(first), stake: 2 },
        acknowledgements: { terms: true, result: false, delivery: false },
      },
      ellis.id,
      '2026-10-01T14:00:00.000Z',
    );
    await renderDetail(revised, marcus.id);
    const entry = [...container.querySelectorAll('.timeline > li')].find((item) =>
      item.querySelector('details.workflow-prior'),
    )!;
    const parts = [...entry.querySelector(':scope > div')!.children];
    const actor = parts.findIndex((part) => part.tagName === 'SMALL');
    const prior = parts.findIndex((part) => part.matches('details.workflow-prior'));
    expect(actor).toBeGreaterThanOrEqual(0);
    expect(actor).toBeLessThan(prior);
    expect(entry.querySelector('small')!.textContent).toContain('Ellis');
  });

  it('never offers the proposer a correction of their own report', async () => {
    await renderDetail(reported(), ellis.id);
    expect(buttons().map(([label]) => label)).not.toContain('Request a correction');
    await renderDetail(reported(), marcus.id);
    expect(buttons().map(([label]) => label)).toContain('Request a correction');
  });
});
