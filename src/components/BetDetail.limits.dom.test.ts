// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createBet } from '../lib/ledger';
import type { Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';

// Evidence and other notes share a 2,000-character limit today. Give evidence its own here, so the
// counter is shown to follow the limit the rules engine applies to that field, not the note's.
vi.mock('../lib/limits', async (original) => {
  const actual = await original<typeof import('../lib/limits')>();
  return { ...actual, LIMITS: { ...actual.LIMITS, evidence: { min: 1, max: 40 } } };
});

const now = '2026-09-01T12:00:00.000Z';
const later = '2099-01-01T12:00:00.000Z';
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
  stake: 3,
  deadline: undefined,
  timing: { kind: 'date', at: later, timezone: 'UTC' },
};
const active = () => applyAction(createBet(input, 'a', members, now), { type: 'accept' }, 'b', now);

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
const dialog = () => document.querySelector('[role="dialog"]')!;
const form = () => dialog().querySelector<HTMLFormElement>('.next-action form')!;
async function click(label: string) {
  const target = [...dialog().querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`No button ${label}`);
  await act(async () => target.click());
}

describe('the counter under a note', () => {
  it('counts readiness evidence against the evidence limit', async () => {
    await act(async () =>
      root.render(
        createElement(BetDetail, {
          bet: active(),
          members,
          memberId: 'a',
          onClose: () => {},
          onAction: async () => {},
        }),
      ),
    );
    await click('Add readiness evidence');
    expect(form().querySelector('.field-count')?.textContent).toBe('0 of 40 characters');
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        createElement(BetDetail, {
          bet: active(),
          members,
          memberId: 'a',
          onClose: () => {},
          onAction: async () => {},
        }),
      ),
    );
    await click('Call off this bet');
    expect(form().querySelector('.field-count')?.textContent).toBe('0 of 2,000 characters');
  });
});
