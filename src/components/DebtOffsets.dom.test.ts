// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { applyAction, applyDebtOffset, createBet, previewDebtOffset } from '../lib/ledger';
import type { LedgerState } from '../lib/types';
import { DebtOffsets } from './DebtOffsets';
let root: Root;
let container: HTMLDivElement;
let state: LedgerState;
const onApply = vi.fn();
const onOpenBet = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onApply.mockReset();
  onApply.mockResolvedValue(undefined);
  onOpenBet.mockReset();
  const demo = createDemoState();
  const members = demo.members.slice(0, 2);
  const [actor, other] = members.map((member) => member.id);
  const bets = [2, 5].map((stake, index) => {
    let bet = createBet(
      {
        title: `Mutual debt ${index + 1}`,
        terms: 'The official result determines who won.',
        category: 'Life',
        creatorSide: 'Yes',
        opponentSide: 'No',
        opponentId: other,
        stake,
        deadline: '2026-10-01',
      },
      actor,
      members,
      '2026-10-01T12:00:00Z',
    );
    bet = applyAction(bet, { type: 'accept' }, other);
    bet = applyAction(
      bet,
      { type: 'propose_result', winnerId: index ? actor : other, note: 'Official result.' },
      actor,
    );
    return applyAction(bet, { type: 'confirm_result' }, other);
  });
  state = { ...demo, members, bets };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      createElement(DebtOffsets, { state, memberId: state.members[0].id, onApply, onOpenBet }),
    ),
  );
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(text))!;
async function click(text: string) {
  await act(async () => button(text).click());
}
/** Applies the first review's offset to the state so the history has an entry. */
async function applyReviewed() {
  await render();
  await click('Review offset');
  await click('Offset 2 rolls');
  const result = applyDebtOffset(state.bets, onApply.mock.calls[0][0], state.members[0].id);
  state = { ...state, bets: result.bets };
  await render();
  return result;
}

describe('offset review', () => {
  it('shows remaining amounts and sends only the reviewed allocation on explicit apply', async () => {
    await render();
    expect(onApply).not.toHaveBeenCalled();
    await click('Review offset');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('5 → 3 remaining');
    expect(dialog.textContent).toContain('2 → 0 remaining');
    expect(dialog.textContent).toContain('Settled by offset');
    expect(container.textContent).toContain('No second approval needed');
  });
  it('requires an explicit apply and does not request counterparty confirmation', async () => {
    await render();
    await click('Review offset');
    await click('Offset 2 rolls');
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0][0]).toMatchObject({
      rolls: 2,
      counterpartyId: state.members[1].id,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('swaps a captured preview for a plain explanation when the underlying debts change', async () => {
    await render();
    await click('Review offset');
    state = {
      ...state,
      bets: [{ ...state.bets[0], version: state.bets[0].version + 1 }, state.bets[1]],
    };
    await render();
    const dialog = document.querySelector('[role="dialog"]')!;
    const review = dialog.querySelector('.offset-review')!;
    // The explanation leads, and the outdated numbers are gone rather than left to be misread.
    expect(review.firstElementChild!.getAttribute('role')).toBe('alert');
    expect(review.firstElementChild!.textContent).toContain('changed');
    expect(dialog.textContent).not.toContain('remaining');
    expect(dialog.textContent).not.toContain('Settled by offset');
    expect(dialog.textContent).not.toContain('cannot be undone');
    // Nothing is left to apply: the only way out is Close.
    expect(dialog.querySelector('.offset-review-group')).toBeNull();
    expect(
      [...dialog.querySelectorAll('.modal-footer button')].map((el) => el.textContent),
    ).toEqual(['Close']);
    expect(onApply).not.toHaveBeenCalled();
    // Focus follows the swap, so keyboard and screen reader users land on the way out.
    expect(document.activeElement).toBe(button('Close'));
    await click('Close');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('does not promise a fresh offset when none is available any more', async () => {
    await render();
    await click('Review offset');
    // Ellis reports delivering the 2 he owes, so this pair cannot be offset until it is confirmed.
    state = {
      ...state,
      bets: [
        applyAction(
          state.bets[0],
          { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
          state.members[0].id,
        ),
        state.bets[1],
      ],
    };
    await render();
    const alert = document.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toMatch(/no offset is available/i);
    expect(alert).not.toMatch(/fresh offset/i);
  });
  it('lands on the card heading when Close leaves no control to return to', async () => {
    await render();
    await click('Review offset');
    state = {
      ...state,
      bets: [
        applyAction(
          state.bets[0],
          { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
          state.members[0].id,
        ),
        state.bets[1],
      ],
    };
    await render();
    await click('Close');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    // "Review offset" no longer exists, so keyboard users land on the card rather than the page top.
    const heading = container.querySelector<HTMLElement>('.debt-offsets h2')!;
    expect(heading.textContent).toBe('Offset mutual debts');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });
  it('points to the card when a current offset is still available', async () => {
    await render();
    await click('Review offset');
    state = {
      ...state,
      bets: [{ ...state.bets[0], version: state.bets[0].version + 1 }, state.bets[1]],
    };
    await render();
    const alert = document.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toMatch(/open it again from the card/i);
    expect(alert).not.toMatch(/fresh offset/i);
  });
  it('keeps errors visible and requires a new preview after an uncertain request', async () => {
    onApply.mockRejectedValueOnce(new Error('Connection lost. Review current records.'));
    await render();
    await click('Review offset');
    await click('Offset 2 rolls');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Connection lost');
    expect(button('Offset 2 rolls').disabled).toBe(true);
  });
  it('leads with the error instead of burying it under the numbers, and closes with Close', async () => {
    onApply.mockRejectedValueOnce(new Error('Connection lost. Review current records.'));
    await render();
    await click('Review offset');
    await click('Offset 2 rolls');
    const review = document.querySelector('.offset-review')!;
    expect(review.firstElementChild!.getAttribute('role')).toBe('alert');
    // "Not now" asks to decide later; once the request has failed the plain word is Close.
    const footer = [...review.querySelectorAll('.modal-footer button')].map((el) => el.textContent);
    expect(footer).toEqual(['Close', 'Offset 2 rolls']);
  });
  it('shows a single shared history entry to either bettor after applying', async () => {
    const result = await applyReviewed();
    expect(container.querySelectorAll('.offset-history .offset-entry')).toHaveLength(1);
    expect(container.querySelectorAll('.offset-history a')).toHaveLength(2);
    expect(container.textContent).toContain('No physical delivery recorded');
    // The record keeps the full id, but the page shows a short reference to it.
    expect(container.textContent).not.toContain(result.offset.id);
    expect(container.querySelector(`[title="${result.offset.id}"]`)).not.toBeNull();
  });
});

describe('offset card anatomy', () => {
  it('lays each suggestion out like a balance row: avatar, name and a caption with the numbers', async () => {
    await render();
    const row = container.querySelector('.offset-suggestion')!;
    expect(row.classList.contains('person-balance')).toBe(true);
    expect(row.querySelector('.avatar')).not.toBeNull();
    expect(row.querySelector('strong')!.textContent).toBe('Alex');
    expect(row.querySelector(':scope > div > span')!.textContent).toBe(
      'Alex owes you 5 rolls · you owe 2 rolls · 2 bets',
    );
    // Every row says which person its button is about, and still contains its visible words.
    const action = row.querySelector('button')!;
    expect(action.textContent).toBe('Review offset');
    expect(action.getAttribute('aria-label')).toBe('Review offset with Alex');
  });
  it('replaces the unstyled hint paragraph with the shared disclaimer', async () => {
    await render();
    expect(container.querySelector('.form-hint')).toBeNull();
    const disclaimer = container.querySelector('.balance-disclaimer')!;
    expect(disclaimer.textContent).toContain('Only confirmed debts between the same two people');
  });
  it('says on the card that an offset is permanent', async () => {
    await render();
    expect(container.querySelector('.debt-offsets')!.textContent).toContain('permanent');
  });
  it('says in the review that the offset cannot be undone and offers Not now, never Cancel', async () => {
    await render();
    await click('Review offset');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('permanent');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).not.toContain('Cancel');
    expect(dialog.querySelector('.modal-footer')).not.toBeNull();
    expect(dialog.querySelector('.form-actions')).toBeNull();
    const footer = [...dialog.querySelectorAll('.modal-footer button')].map((el) => el.textContent);
    expect(footer).toEqual(['Not now', 'Offset 2 rolls']);
    await click('Not now');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });
  it('groups the reviewed bets by who owes whom', async () => {
    await render();
    await click('Review offset');
    const groups = [...document.querySelectorAll('.offset-review-group')];
    expect(groups.map((group) => group.querySelector('h3')!.textContent)).toEqual([
      'Alex owes you: 5 → 3 remaining',
      'You owe Alex: 2 → 0 remaining',
    ]);
    expect(groups[0].textContent).toContain('Mutual debt 2');
    expect(groups[1].textContent).toContain('Mutual debt 1');
    expect(groups[1].querySelector('.status-badge')!.textContent).toBe('Settled by offset');
  });
});

describe('offset history links', () => {
  it('opens a referenced bet in the app and leaves the page where it is', async () => {
    window.history.replaceState({}, '', '/?demo=1#balances');
    const result = await applyReviewed();
    const link = container.querySelector<HTMLAnchorElement>('.offset-history a')!;
    const betId = result.offset.allocations[0].betId;
    expect(link.classList.contains('link-button')).toBe(true);
    // Followed in a new tab, the link still lands in the demo instead of the signed-out welcome.
    const href = new URL(link.href);
    expect(href.searchParams.get('demo')).toBe('1');
    expect(href.searchParams.get('bet')).toBe(betId);
    const before = window.location.href;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => void link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenBet).toHaveBeenCalledWith(betId);
    expect(window.location.href).toBe(before);
  });
  it('leaves modified clicks to the browser so a link can still open in a new tab', async () => {
    await applyReviewed();
    const link = container.querySelector<HTMLAnchorElement>('.offset-history a')!;
    // Record whether the app took the click, then stop jsdom from trying to navigate.
    let handled: boolean | undefined;
    document.addEventListener(
      'click',
      (event) => {
        handled = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    await act(
      async () =>
        void link.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
        ),
    );
    expect(handled).toBe(false);
    expect(onOpenBet).not.toHaveBeenCalled();
  });
  it('says who won each referenced bet and how much of it was offset', async () => {
    await applyReviewed();
    const lines = [...container.querySelectorAll('.offset-history .offset-entry li')].map(
      (el) => el.textContent,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^LL-\S+ · Ellis won · 2 offset$/);
    expect(lines[1]).toMatch(/^LL-\S+ · Alex won · 2 offset$/);
  });
});

describe('after an offset is applied', () => {
  const reviewFor = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="Review offset with ${name}"]`)!;
  it('leaves a confirmation on the card and opens the history to the new entry', async () => {
    const result = await applyReviewed();
    const confirmation = container.querySelector('.offset-applied')!;
    expect(confirmation.textContent).toContain('Offset recorded with Alex');
    expect(confirmation.textContent).toContain('2 rolls in each direction');
    expect(confirmation.textContent).toContain('history');
    // The toast is gone after a few seconds; the entry it announced is already on show.
    expect(container.querySelector<HTMLDetailsElement>('.offset-history')!.open).toBe(true);
    expect(container.querySelector('.offset-history')!.textContent).toContain(
      `Offset ${result.offset.id.slice(0, 8)}`,
    );
    // The toast already speaks for assistive technology, so the lasting note is not a live region.
    expect(confirmation.closest('[role="status"], [aria-live]')).toBeNull();
  });
  it('hands focus to the lasting confirmation once the dialog closes', async () => {
    await applyReviewed();
    // The control that opened the review is gone, so the confirmation is where to land.
    const confirmation = container.querySelector<HTMLElement>('.offset-applied')!;
    expect(confirmation.getAttribute('tabindex')).toBe('-1');
    // Radix hands focus back on its own timers after the close, so wait for it rather than a fixed delay.
    await vi.waitFor(() => expect(document.activeElement).toBe(confirmation));
  });
  it('lands on the confirmation when the ledger catches up after focus went back to the opener', async () => {
    await render();
    const opener = button('Review offset');
    opener.focus();
    await click('Review offset');
    await click('Offset 2 rolls');
    // The review has closed and handed focus back to its opener, which stays until the ledger updates.
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    state = {
      ...state,
      bets: applyDebtOffset(state.bets, onApply.mock.calls[0][0], state.members[0].id).bets,
    };
    await render();
    expect(opener.isConnected).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('.offset-applied'));
  });
  it('says nothing about a success that did not happen', async () => {
    onApply.mockRejectedValueOnce(new Error('Connection lost. Review current records.'));
    await render();
    await click('Review offset');
    await click('Offset 2 rolls');
    await click('Close');
    expect(container.querySelector('.offset-applied')).toBeNull();
  });
  it('keeps the history folded until there is something new to show', async () => {
    await render();
    expect(container.querySelector('.offset-history')).toBeNull();
    const [actor, other] = state.members.map((member) => member.id);
    state = {
      ...state,
      bets: applyDebtOffset(state.bets, previewDebtOffset(state.bets, actor, other)!, actor).bets,
    };
    await render();
    // An offset made earlier, or by the other bettor, is history rather than news.
    expect(container.querySelector<HTMLDetailsElement>('.offset-history')!.open).toBe(false);
    expect(container.querySelector('.offset-applied')).toBeNull();
  });
  it('clears the confirmation when the next review starts', async () => {
    const demo = createDemoState();
    const members = demo.members.slice(0, 3);
    const [actor, first, second] = members.map((member) => member.id);
    const debt = (other: string, title: string, winnerId: string, loserId: string) => {
      let bet = createBet(
        {
          title,
          terms: 'The official result determines who won.',
          category: 'Life',
          creatorSide: 'Yes',
          opponentSide: 'No',
          opponentId: other,
          stake: 2,
          deadline: '2026-10-01',
        },
        actor,
        members,
        '2026-10-01T12:00:00Z',
      );
      bet = applyAction(bet, { type: 'accept' }, other);
      bet = applyAction(bet, { type: 'propose_result', winnerId, note: 'Official result.' }, actor);
      return applyAction(bet, { type: 'confirm_result' }, other);
    };
    state = {
      ...demo,
      members,
      bets: [
        debt(first, 'First mine', actor, first),
        debt(first, 'First theirs', first, actor),
        debt(second, 'Second mine', actor, second),
        debt(second, 'Second theirs', second, actor),
      ],
    };
    await render();
    await act(async () => reviewFor('Alex').click());
    await click('Offset 2 rolls');
    expect(container.querySelector('.offset-applied')).not.toBeNull();
    await act(async () => reviewFor('Sarah').click());
    expect(container.querySelector('.offset-applied')).toBeNull();
  });
});

describe('offsets that are not available yet', () => {
  it('explains why a pair with a delivery under confirmation cannot be offset yet', async () => {
    // Ellis owes Alex 2 and Alex owes Ellis 5, but Ellis has reported delivering the 2.
    state = {
      ...state,
      bets: [
        applyAction(
          state.bets[0],
          { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
          state.members[0].id,
        ),
        state.bets[1],
      ],
    };
    await render();
    expect(container.querySelector('.debt-offsets')).not.toBeNull();
    const row = container.querySelector('.offset-unavailable')!;
    expect(row.textContent).toContain('Alex owes you 5 rolls · you owe 2 rolls');
    // A condition, not a promise: a confirmed delivery settles the debt and no offset ever exists.
    expect(row.textContent).toContain(
      'Not available while a delivery on one of these bets is waiting for confirmation.',
    );
    expect(row.textContent).not.toMatch(/not available yet/i);
    expect(row.textContent).not.toContain('yours to confirm');
    expect(row.querySelector('button')).toBeNull();
  });
  it('says when the delivery waiting for confirmation is the viewer to confirm', async () => {
    // Alex reports delivering the 5 that Alex owes Ellis, so Ellis holds the confirmation.
    state = {
      ...state,
      bets: [
        state.bets[0],
        applyAction(
          state.bets[1],
          { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
          state.members[1].id,
        ),
      ],
    };
    await render();
    const row = container.querySelector('.offset-unavailable')!;
    expect(row.textContent).toContain('waiting for confirmation. It is yours to confirm.');
  });
  it('stays out of the way when nobody owes anything', async () => {
    state = { ...state, bets: [] };
    await render();
    expect(container.querySelector('.debt-offsets')).toBeNull();
  });
});
