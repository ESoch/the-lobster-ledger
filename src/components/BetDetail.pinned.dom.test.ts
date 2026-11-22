// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createBet } from '../lib/ledger';
import type { Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';

// An inline form opens with its footer pinned to the foot of the sheet. The browser scrolls a
// focused field before the sheet has measured that new footer (and only far enough to show a
// textarea's caret), so the field and the line that says what submitting does, which sits just above
// the buttons, could open half behind them.

const now = '2026-09-01T12:00:00.000Z';
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
  timing: { kind: 'date', at: '2026-09-13T12:00:00.000Z', timezone: 'UTC' },
};
const pending = () => createBet(input, 'a', members, now);
const active = () => applyAction(pending(), { type: 'accept' }, 'b', now);

let root: Root;
let container: HTMLDivElement;
let scrolled: { element: Element; options: unknown; focused: Element | null }[];
const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const nativeFocus = HTMLElement.prototype.focus;
let focusCalls: { element: Element; options?: FocusOptions }[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scrolled = [];
  focusCalls = [];
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrolled.push({ element: this, options, focused: document.activeElement });
  };
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    focusCalls.push({ element: this, options });
    return nativeFocus.call(this, options);
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (native) Object.defineProperty(Element.prototype, 'scrollIntoView', native);
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  HTMLElement.prototype.focus = nativeFocus;
  vi.unstubAllGlobals();
});

async function render(bet: ReturnType<typeof pending>, memberId: string) {
  await act(async () =>
    root.render(
      createElement(BetDetail, {
        key: bet.id,
        bet,
        members,
        memberId,
        onClose: () => {},
        onAction: async () => {},
      }),
    ),
  );
  return document.querySelector('[role="dialog"]')!;
}

async function open(bet: ReturnType<typeof pending>, memberId: string, label: string) {
  const dialog = await render(bet, memberId);
  const opener = [...dialog.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!opener) throw new Error(`No ${label} button`);
  scrolled = [];
  focusCalls = [];
  await act(async () => opener.click());
  return dialog.querySelector<HTMLFormElement>('form.inline-action-form')!;
}

describe.each([
  ['Decline', pending, 'b'],
  ['Call off this bet', active, 'a'],
])('opening the %s form', (label, bet, memberId) => {
  it('focuses its first field without letting the browser scroll before the footer is measured', async () => {
    const form = await open(bet(), memberId, label);
    const field = form.querySelector('textarea')!;
    expect(document.activeElement).toBe(field);
    const focused = focusCalls.filter((call) => call.element === field);
    expect(focused.length).toBeGreaterThan(0);
    expect(focused.every((call) => call.options?.preventScroll)).toBe(true);
  });

  it('then brings its fields in whole, so the consequence above the buttons shows, and keeps the field in view', async () => {
    const form = await open(bet(), memberId, label);
    const fields = form.querySelector('.form-fields')!;
    const field = form.querySelector('textarea')!;
    // The consequence line, not the note's character count, which is also a hint.
    expect(fields.querySelector('.hint:not(.field-count)')?.textContent).toMatch(/owed|agree/);
    const targets = scrolled.map((entry) => entry.element);
    expect(targets).toEqual([fields, field]);
    expect(scrolled.every((entry) => entry.focused === field)).toBe(true);
    expect(
      scrolled.every((entry) => (entry.options as ScrollIntoViewOptions).block === 'nearest'),
    ).toBe(true);
  });
});

describe('the "Your move" jump', () => {
  // The sheet's scroll padding clears its pinned heading as Modal measured it when focus last moved,
  // and a sheet that opens at the next step has had no focus yet. Focus moves to the heading first,
  // without scrolling, so the scroll that follows clears the pinned heading as it is now.
  it('moves focus to the next step before scrolling it into view', async () => {
    const dialog = await render(pending(), 'b');
    const move = dialog.querySelector<HTMLAnchorElement>('.your-move')!;
    expect(move).not.toBeNull();
    scrolled = [];
    await act(async () => move.click());
    const heading = document.getElementById('bet-next-step')!;
    expect(document.activeElement).toBe(heading);
    const scroll = scrolled.find((entry) => entry.element === heading);
    expect(scroll, 'the next step is scrolled into view').toBeDefined();
    expect(scroll!.focused).toBe(heading);
    expect((scroll!.options as ScrollIntoViewOptions).block).toBe('start');
  });
});
