// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, applyDebtOffset, createBet, previewDebtOffset } from '../lib/ledger';
import type { Bet, LedgerState, Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';
import { InboxView } from './LedgerViews';

const now = '2026-09-01T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
];
const input: NewBet = {
  title: 'Friday release',
  terms: 'Ships by the agreed cutoff.',
  category: 'Work',
  opponentId: 'b',
  creatorSide: 'Ships',
  opponentSide: 'Delayed',
  stake: 2,
  deadline: undefined,
  timing: { kind: 'date', at: due, timezone: 'UTC' },
};
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(
    createBet({ ...input, ...overrides }, 'a', members, now),
    { type: 'accept' },
    'b',
    now,
  );
const prompt =
  'Act as a neutral reviewer of this friendly lobster-roll bet. Decide from the release log whether it shipped.';
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

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
async function renderSheet(bet: Bet, memberId = 'a') {
  await act(async () =>
    root.render(
      createElement(BetDetail, { bet, members, memberId, onClose: () => {}, onAction: vi.fn() }),
    ),
  );
  return document.querySelector('[role="dialog"]')!;
}
const entries = (dialog: Element) => [...dialog.querySelectorAll('.timeline > li')];

describe('the paper trail on the sheet', () => {
  it('keeps the proposed prompt behind a disclosure, after the attribution line', async () => {
    const bet = applyAction(
      active({ decisionMethod: 'chatgpt' }),
      { type: 'propose_prompt', text: prompt },
      'a',
      now,
    );
    const dialog = await renderSheet(bet);
    const entry = entries(dialog)[0];
    expect(entry.querySelector('p')?.textContent).toBe(
      'Proposed and approved ChatGPT prompt version 1.',
    );
    const disclosure = entry.querySelector('details')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('summary')?.textContent).toBe('Read prompt v1 as proposed');
    expect(disclosure.textContent).toContain(prompt);
    // The actor and time come before any disclosure.
    const children = [...entry.querySelector('div')!.children].map((child) => child.tagName);
    expect(children.indexOf('SMALL')).toBeLessThan(children.indexOf('DETAILS'));
  });
  it('turns https links into links that say they open a new tab', async () => {
    const bet = applyAction(
      active(),
      { type: 'mark_ready', evidence: 'Release notes: https://example.com/releases/42' },
      'a',
      now,
    );
    const dialog = await renderSheet(bet);
    const link = entries(dialog)[0].querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/releases/42');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.textContent).toContain('opens in a new tab');
  });
  it('calls the concurrency counter a record revision, not a version', async () => {
    const dialog = await renderSheet(active());
    const note = dialog.querySelector('.audit-note')!.textContent;
    expect(note).toContain('Record revision 2');
    expect(note).not.toMatch(/Version \d/);
  });
});

describe('the activity feed', () => {
  it('names the other bettor of an offset instead of showing its id', async () => {
    const owed = (winnerId: string) =>
      applyAction(
        applyAction(active(), { type: 'propose_result', winnerId, note: 'Shipped.' }, 'a', due),
        { type: 'confirm_result' },
        'b',
        due,
      );
    const bets = [owed('a'), owed('b')];
    const preview = previewDebtOffset(bets, 'a', 'b')!;
    const { bets: updated } = applyDebtOffset(bets, preview, 'a', due);
    const state: LedgerState = { members, bets: updated, places: [], groupName: 'Test' };
    await act(async () =>
      root.render(createElement(InboxView, { state, memberId: 'a', onBet: () => {}, now: due })),
    );
    const feed = container.querySelector('.inbox-activity')!.textContent ?? '';
    expect(feed).toContain('against mutual debts with Blair Reed');
    expect(feed).not.toMatch(uuid);
  });
});
