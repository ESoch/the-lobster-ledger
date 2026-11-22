// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createBet } from '../lib/ledger';
import type { Bet, BetAction, Member, NewBet } from '../lib/types';
import { BetDetail } from './BetDetail';
import { JUDGE_COPY } from './JudgeCopy';

// Leaflet needs layout APIs that jsdom lacks; the pin itself is not under test here.
vi.mock('./MapView', () => ({ MapView: () => null }));

// The sheet's inline forms with the real dialog around them: focus, Escape, busy state, errors.
const now = '2026-09-01T12:00:00.000Z';
const due = '2026-09-13T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
  { id: 'c', name: 'Casey Hale', initials: 'CH', color: '#2b4a1e' },
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
  timing: { kind: 'date', at: due, timezone: 'UTC' },
};
const pending = (overrides: Partial<NewBet> = {}) =>
  createBet({ ...input, ...overrides }, 'a', members, now);
const active = (overrides: Partial<NewBet> = {}) =>
  applyAction(pending(overrides), { type: 'accept' }, 'b', now);
const owed = () =>
  applyAction(
    applyAction(
      active(),
      { type: 'propose_result', winnerId: 'a', note: 'Shipped on Thursday.' },
      'a',
      due,
    ),
    { type: 'confirm_result' },
    'b',
    due,
  );
const prompt = 'Decide, using the release log, whether the release shipped before the cutoff.';
const agreedPrompt = () => {
  let bet = active({ decisionMethod: 'chatgpt' });
  bet = applyAction(bet, { type: 'propose_prompt', text: prompt }, 'a', now);
  return applyAction(bet, { type: 'approve_prompt' }, 'b', now);
};

let root: Root;
let container: HTMLDivElement;
let onAction: ReturnType<typeof vi.fn<(bet: Bet, action: BetAction) => Promise<void>>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onAction = vi.fn(async () => {});
  onClose = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(bet: Bet, memberId: string) {
  await act(async () =>
    root.render(
      createElement(BetDetail, { key: bet.id, bet, members, memberId, onClose, onAction }),
    ),
  );
}
const dialog = () => document.querySelector('[role="dialog"]')!;
const button = (text: string | RegExp) =>
  [...dialog().querySelectorAll('button')].find((candidate) => {
    const label = candidate.textContent?.trim() ?? '';
    return typeof text === 'string' ? label === text : text.test(label);
  });
async function click(text: string | RegExp) {
  const target = button(text);
  if (!target) throw new Error(`No button ${text}`);
  target.focus();
  await act(async () => target.click());
}
const form = () => dialog().querySelector<HTMLFormElement>('.next-action form');
const submitButton = () => form()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const cancelButton = () =>
  [...form()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
const reason = () => form()!.querySelector<HTMLTextAreaElement>('textarea')!;
async function type(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const errorFor = (control: { getAttribute(name: string): string | null }) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id))
    .find((element) => element?.classList.contains('field-error'));
async function pressEscape() {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
}

describe('opening and leaving an inline form', () => {
  it('moves focus into the form and back to the button that opened it', async () => {
    await render(pending(), 'b');
    await click('Decline');
    expect(document.activeElement).toBe(reason());
    await act(async () => cancelButton().click());
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(button('Decline'));
  });

  it('names a short reason under the field, inside the form, and Cancel clears it', async () => {
    await render(pending(), 'b');
    await click('Decline');
    expect(form()!.noValidate).toBe(true);
    await type(reason(), 'No.  ');
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    expect(reason().getAttribute('aria-invalid')).toBe('true');
    const message = errorFor(reason());
    expect(message?.textContent).toBe('Use at least 10 characters.');
    expect(form()!.contains(message!)).toBe(true);
    expect(document.activeElement).toBe(reason());
    // Something was typed, so Cancel asks first; Discard leaves the form.
    await act(async () => cancelButton().click());
    await act(async () => button('Discard')!.click());
    await click('Decline');
    expect(reason().value).toBe('');
    expect(reason().hasAttribute('aria-invalid')).toBe(false);
    expect(dialog().querySelector('.field-error, .form-error')).toBeNull();
  });

  it('keeps a refused change’s error inside the form and drops it on Cancel', async () => {
    onAction.mockRejectedValueOnce(new Error('Only the other bettor can do that.'));
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    submitButton().focus();
    await act(async () => form()!.requestSubmit());
    const error = dialog().querySelector('.form-error');
    expect(error?.textContent).toBe('Only the other bettor can do that.');
    expect(form()!.contains(error)).toBe(true);
    // The pressed submit was never disabled, so focus is still on it.
    expect(document.activeElement).toBe(submitButton());
    await act(async () => cancelButton().click());
    await act(async () => button('Discard')!.click());
    expect(dialog().querySelector('.form-error')).toBeNull();
  });

  it('hands focus on to the next step after a successful submit', async () => {
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    submitButton().focus();
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalled();
    expect(form()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('lands on the next step, not a closed disclosure, after a submit from the tools', async () => {
    // The timing has arrived, so the evidence button sits in the collapsed tools; once evidence is
    // recorded the next step is "Record outcome", and that is where focus belongs.
    await render(active(), 'a');
    await click('Add readiness evidence');
    expect(button('Add readiness evidence')).toBeUndefined();
    await type(reason(), 'The release notes went out on Thursday.');
    submitButton().focus();
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalled();
    expect(form()).toBeNull();
    expect(dialog().querySelector('details.workflow-tools')?.hasAttribute('open')).toBe(false);
    expect(document.activeElement?.tagName).not.toBe('SUMMARY');
    expect(document.activeElement).toBe(dialog().querySelector('.next-action h3'));
    expect(document.activeElement?.textContent).toBe('The next step');
  });

  it('goes back to the collapsed tools when a form opened from them is cancelled', async () => {
    await render(active(), 'a');
    await click('Add readiness evidence');
    await act(async () => cancelButton().click());
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(dialog().querySelector('details.workflow-tools summary'));
  });
});

describe('while a submit is in flight', () => {
  it('marks the submit busy without disabling it, and holds Cancel and the fields', async () => {
    let finish: () => void = () => {};
    onAction.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    // Enter in a field can submit too: focus must not fall off a field that becomes disabled.
    reason().focus();
    await act(async () => form()!.requestSubmit());
    expect(submitButton().getAttribute('aria-busy')).toBe('true');
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    expect(submitButton().disabled).toBe(false);
    expect(document.activeElement).toBe(submitButton());
    expect(cancelButton().disabled).toBe(true);
    expect(reason().matches(':disabled')).toBe(true);
    // A second press while busy sends nothing more.
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('keeps the sheet open on Close or an outside click until the change is recorded', async () => {
    let finish: () => void = () => {};
    onAction.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    submitButton().focus();
    await act(async () => form()!.requestSubmit());
    const close = dialog().querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!;
    await act(async () => close.click());
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
    });
    // The record is still being written: closing now would hide whether it was.
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Discard')).toBeUndefined();
    await act(async () => finish());
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says in a live region that a change is being recorded and why Close waits', async () => {
    let finish: () => void = () => {};
    onAction.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    await render(pending(), 'b');
    // The region is there before anything happens, so the change of its text is announced.
    const status = dialog().querySelector('.busy-status')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    submitButton().focus();
    await act(async () => form()!.requestSubmit());
    expect(dialog().querySelector('.busy-status')).toBe(status);
    expect(status.textContent).toBe(
      'Recording this change. The sheet can be closed once it is saved.',
    );
    await act(async () => finish());
    expect(status.textContent).toBe('');
  });
});

describe('Escape and outside clicks with a draft', () => {
  it('leaves an empty form on the first Escape and the sheet on the second', async () => {
    await render(pending(), 'b');
    await click('Decline');
    await pressEscape();
    expect(form()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Decline'));
    await pressEscape();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('asks before Escape throws away a typed draft, and Keep editing keeps it', async () => {
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    await pressEscape();
    expect(form()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Discard')).toBeDefined();
    expect(document.activeElement).toBe(button('Keep editing'));
    // Escape again answers Keep editing; the words and the cursor are where they were.
    await pressEscape();
    expect(button('Discard')).toBeUndefined();
    expect(form()).not.toBeNull();
    expect(reason().value).toBe('The terms leave it to my reading speed.');
    expect(document.activeElement).toBe(reason());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes only the form when the draft is discarded, then hands focus back to its button', async () => {
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    await pressEscape();
    await act(async () => button('Discard')!.click());
    expect(form()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Discard')).toBeUndefined();
    expect(document.activeElement).toBe(button('Decline'));
    await click('Decline');
    expect(reason().value).toBe('');
  });

  it('asks about a long prompt and a pasted response the same way', async () => {
    await render(active({ decisionMethod: 'chatgpt' }), 'a');
    await click('Draft a fair prompt');
    await type(reason(), 'Decide, using the release log, whether the release shipped on time.');
    await pressEscape();
    expect(form()).not.toBeNull();
    expect(button('Keep editing')).toBeDefined();
    await act(async () => button('Keep editing')!.click());
    // Cancel asks too, as New bet's Cancel does: a long prompt is as easy to lose that way.
    await act(async () => cancelButton().click());
    expect(form()).not.toBeNull();
    expect(document.activeElement).toBe(button('Keep editing'));
    await act(async () => button('Discard')!.click());
    expect(form()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Draft a fair prompt'));
    // The response form: pasted text is as hard to get back.
    await render(agreedPrompt(), 'a');
    await click('Record ChatGPT response');
    await type(reason(), 'The release shipped on Thursday, so Avery wins.');
    await pressEscape();
    expect(form()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Discard')).toBeDefined();
  });

  it('asks before Cancel throws away a typed draft, and Keep editing keeps every word', async () => {
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    cancelButton().focus();
    await act(async () => cancelButton().click());
    expect(form()).not.toBeNull();
    expect(button('Discard')).toBeDefined();
    await act(async () => button('Keep editing')!.click());
    expect(button('Discard')).toBeUndefined();
    expect(reason().value).toBe('The terms leave it to my reading speed.');
    expect(document.activeElement).toBe(cancelButton());
  });

  it('asks before Close discards a typed draft', async () => {
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    await act(async () =>
      dialog().querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Discard')).toBeDefined();
  });

  it('closes the sheet when Close is discarded, and Escape does not ask while a change is recorded', async () => {
    let finish: () => void = () => {};
    onAction.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    await render(pending(), 'b');
    await click('Decline');
    await type(reason(), 'The terms leave it to my reading speed.');
    submitButton().focus();
    await act(async () => form()!.requestSubmit());
    await pressEscape();
    // Nothing to throw away once it is being written to the ledger.
    expect(button('Discard')).toBeUndefined();
    expect(form()).not.toBeNull();
    await act(async () => finish());
  });
});

describe('what the sheet announces', () => {
  it('describes this bet, not just “Bet details”', async () => {
    await render(pending(), 'b');
    const named = document.getElementById(dialog().getAttribute('aria-describedby') ?? '')!;
    expect(named.classList.contains('sr-only')).toBe(true);
    expect(named.textContent).toContain('Friday release');
    expect(named.textContent).toContain('3 rolls at stake');
    expect(named.textContent).toContain('Pending agreement');
    expect(named.textContent).not.toContain('Review and manage');
  });
});

describe('form details', () => {
  it('names the delivery submit like its button and states the roll count', async () => {
    await render(owed(), 'b');
    await click('Record delivery');
    expect(submitButton().textContent).toBe('Record delivery');
    expect(form()!.textContent).toContain('settles all 3 rolls');
  });

  it('does not cut a pasted delivery note at 2,000 characters; it counts it and holds the submit', async () => {
    await render(owed(), 'b');
    await click('Record delivery');
    const field = reason();
    expect(field.hasAttribute('maxlength')).toBe(false);
    const counter = () => form()!.querySelector('.field-count')!;
    const live = form()!.querySelector('[role="status"].response-limit')!;
    expect(counter().textContent).toBe('0 of 2,000 characters');
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(counter().id);
    expect(live.textContent).toBe('');
    await type(field, 'x'.repeat(2_010));
    // Everything pasted is still there to trim, not silently cut.
    expect(field.value).toHaveLength(2_010);
    expect(counter().textContent).toBe('2,010 of 2,000 characters · 10 over the limit');
    expect(live.textContent).toBe(
      'The delivery note is over the 2,000-character limit. Trim it before recording.',
    );
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    expect(submitButton().getAttribute('aria-describedby')).toBe(counter().id);
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    await type(field, 'x'.repeat(2_000));
    expect(counter().textContent).toBe('2,000 of 2,000 characters');
    expect(live.textContent).toBe('');
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('counts every other note the same way: evidence, a reason to decline, a reason for changes', async () => {
    const note = () => form()!.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!;
    const counted = async (open: string, message: string) => {
      await click(open);
      expect(note().hasAttribute('maxlength')).toBe(false);
      expect(form()!.querySelector('.field-count')?.textContent).toBe('0 of 2,000 characters');
      await type(note(), 'x'.repeat(2_001));
      expect(form()!.querySelector('[role="status"].response-limit')?.textContent).toBe(message);
      await act(async () => cancelButton().click());
      await act(async () => button('Discard')!.click());
    };
    await render(active(), 'a');
    await counted(
      'Add readiness evidence',
      'The evidence is over the 2,000-character limit. Trim it before recording.',
    );
    await counted(
      'Propose changes',
      'The reason is over the 2,000-character limit. Trim it before proposing.',
    );
    await act(async () => root.render(null));
    await render(pending(), 'b');
    await counted(
      'Decline',
      'The reason is over the 2,000-character limit. Trim it before recording.',
    );
  });

  it('counts prompt characters against the limit', async () => {
    await render(active({ decisionMethod: 'chatgpt' }), 'a');
    await click('Draft a fair prompt');
    const editor = reason();
    const counter = document.getElementById(
      (editor.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .find((id) => document.getElementById(id)?.classList.contains('field-count')) ?? '',
    );
    expect(counter?.textContent).toBe(
      `${editor.value.length.toLocaleString()} of 8,000 characters`,
    );
    await type(editor, 'Short prompt');
    expect(counter?.textContent).toBe('12 of 8,000 characters');
  });

  it('does not cut a pasted prompt at the limit; it says how far over it is and holds the submit', async () => {
    await render(active({ decisionMethod: 'chatgpt' }), 'a');
    await click('Draft a fair prompt');
    const editor = reason();
    expect(editor.hasAttribute('maxlength')).toBe(false);
    const counter = () => form()!.querySelector('.field-count')!;
    const live = form()!.querySelector('[role="status"].response-limit')!;
    expect(live.textContent).toBe('');
    await type(editor, 'x'.repeat(8_010));
    expect(editor.value).toHaveLength(8_010);
    expect(counter().textContent).toBe('8,010 of 8,000 characters · 10 over the limit');
    expect(live.textContent).toBe(
      'The prompt is over the 8,000-character limit. Trim it before proposing.',
    );
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    expect(submitButton().getAttribute('aria-describedby')).toBe(counter().id);
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    await type(editor, 'x'.repeat(8_000));
    expect(counter().textContent).toBe('8,000 of 8,000 characters');
    expect(live.textContent).toBe('');
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('checks a shared link when the field is left, with an example of a good one', async () => {
    await render(agreedPrompt(), 'a');
    await click('Record ChatGPT response');
    const link = form()!.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(link.labels?.[0]?.querySelector('.optional')?.textContent).toBe('Optional');
    await type(link, 'https://chatgpt.com/c/abc123');
    await act(async () => {
      link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(link.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(link)?.textContent).toContain('https://chatgpt.com/share/');
    await type(link, 'https://chatgpt.com/share/abc123');
    expect(link.hasAttribute('aria-invalid')).toBe(false);
  });

  it('waits for a press to end before naming a field that was left, so the press still clicks', async () => {
    // A message shown on the way to a button pushed the button down under the pointer, and the
    // click missed. The message waits for the release; a press on the submit checks it anyway.
    await render(agreedPrompt(), 'a');
    await click('Record ChatGPT response');
    const link = form()!.querySelector<HTMLInputElement>('input[type="url"]')!;
    await type(link, 'https://chatgpt.com/c/abc123');
    await act(async () => {
      submitButton().dispatchEvent(new Event('pointerdown', { bubbles: true }));
      link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(link.hasAttribute('aria-invalid')).toBe(false);
    await act(async () => {
      submitButton().dispatchEvent(new Event('pointerup', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(link.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(link)?.textContent).toContain('https://chatgpt.com/share/');
  });

  it('clears a clipboard error once a copy works', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await render(agreedPrompt(), 'a');
    await click('Copy agreed prompt');
    expect(dialog().textContent).toContain('Clipboard access is unavailable');
    await click('Copy agreed prompt');
    expect(dialog().textContent).not.toContain('Clipboard access is unavailable');
    expect(button('Copied agreed prompt')).toBeDefined();
  });

  it('describes a stale draft’s submit by the note that explains it, and keeps it focusable', async () => {
    const bet = active();
    await render(bet, 'a');
    await click('Record outcome');
    await type(reason(), 'The league posted the final standings this morning.');
    const checkIn = { at: '2026-12-01T12:00:00.000Z', timezone: 'UTC' };
    await render(applyAction(bet, { type: 'set_check_in', checkIn }, 'b', now), 'a');
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    const note = document.getElementById(submitButton().getAttribute('aria-describedby') ?? '');
    expect(note?.classList.contains('stale-note')).toBe(true);
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('required fields in a sheet form', () => {
  it('names a whitespace-only piece of evidence under its field, with the words that field needs', async () => {
    await render(active(), 'a');
    await click('Add readiness evidence');
    await type(reason(), '      ');
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    expect(reason().getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(reason())?.textContent).toBe(
      'Describe the evidence that the answer is available.',
    );
    expect(document.activeElement).toBe(reason());
    expect(form()!.contains(errorFor(reason())!)).toBe(true);
  });

  it('shows every missing field at once, not one native bubble at a time', async () => {
    await render(active({ decisionMethod: 'judge', judgeId: 'c' }), 'c');
    await click(JUDGE_COPY.recordAction);
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    // tsc 7's DOM typings reject a select as an Element type argument, so this stays unconstrained.
    const winner = form()!.querySelector('select[name="winner"]') as unknown as HTMLSelectElement;
    expect(errorFor(winner)?.textContent).toBe('Choose an outcome.');
    expect(errorFor(reason())?.textContent).toBe('Write your decision and reasoning.');
    expect(document.activeElement).toBe(winner);
  });

  it('counts a drafted prompt and names a whitespace-only one as empty, not as too short', async () => {
    await render(active({ decisionMethod: 'chatgpt' }), 'a');
    await click('Draft a fair prompt');
    await type(reason(), '            ');
    await act(async () => form()!.requestSubmit());
    expect(errorFor(reason())?.textContent).toBe('Write the prompt you both will approve.');
    await type(reason(), 'Too short');
    await act(async () => form()!.requestSubmit());
    expect(errorFor(reason())?.textContent).toBe('Use at least 20 characters.');
  });
});

describe('the check-in form', () => {
  const when = () => form()!.querySelector<HTMLInputElement>('input[name="checkIn.local"]')!;
  it('turns away a time that has passed, under the time, and saves one that is ahead', async () => {
    await render(active(), 'a');
    await click('Set my check-in');
    await type(when(), '2020-01-01T09:00');
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    expect(when().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(when());
    expect(errorFor(when())?.textContent).toBe('Choose a time that hasn’t passed yet.');
    expect(form()!.contains(errorFor(when())!)).toBe(true);
    await type(when(), '2099-01-01T09:00');
    expect(when().hasAttribute('aria-invalid')).toBe(false);
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0][1]).toMatchObject({ type: 'set_check_in' });
  });

  it('names a zone that ignores daylight saving when it is left', async () => {
    await render(active(), 'a');
    await click('Set my check-in');
    const zone = form()!.querySelector<HTMLInputElement>('input[name="checkIn.timezone"]')!;
    await type(zone, 'EST');
    await act(async () => {
      zone.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(zone.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(zone)?.textContent).toContain('America/New_York');
  });

  it('holds a zone’s message while a press is under way, so the button below still takes it', async () => {
    await render(active(), 'a');
    await click('Set my check-in');
    const zone = form()!.querySelector<HTMLInputElement>('input[name="checkIn.timezone"]')!;
    await type(zone, 'Mars/Base');
    await act(async () => {
      submitButton().dispatchEvent(new Event('pointerdown', { bubbles: true }));
      zone.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(zone.hasAttribute('aria-invalid')).toBe(false);
    await act(async () => {
      submitButton().dispatchEvent(new Event('pointercancel', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(errorFor(zone)?.textContent).toContain('not a timezone we know');
  });
});

describe('proposing changes to an agreement', () => {
  const named = (name: string) => form()!.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  it('keeps the check-in the agreement already has, even once its time has passed', async () => {
    const bet = active({
      timing: {
        kind: 'date',
        at: due,
        timezone: 'UTC',
        checkIn: { at: '2026-09-02T12:00:00.000Z', timezone: 'UTC' },
      },
    });
    await render(bet, 'a');
    await click('Propose changes');
    expect(named('timing.hasCheckIn').checked).toBe(true);
    await type(
      form()!.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!,
      'The terms need one more sentence.',
    );
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0][1]).toMatchObject({ type: 'propose_amendment' });
  });

  it('says so when the agreement only had a decision date, rather than quietly choosing midnight', async () => {
    await render(active({ timing: undefined, deadline: '2026-09-13' }), 'a');
    await click('Propose changes');
    const note = form()!.querySelector('.date-note');
    expect(note?.textContent).toContain('only named a decision date');
    expect(note?.textContent).toContain('Sep 13, 2026');
    expect(note?.textContent).toContain('12:00 AM UTC');
    expect(named('timing.local').value).toBe('2026-09-13T00:00');
    // The note sits with the time it explains, and the time field points at it.
    expect(named('timing.local').getAttribute('aria-describedby')).toContain(note!.id);
  });

  it('adds no note when the agreement already has a time', async () => {
    await render(active(), 'a');
    await click('Propose changes');
    expect(form()!.querySelector('.date-note')).toBeNull();
  });

  it('asks who makes the call as New bet does, and keeps a stepped-down note out of the judge’s name', async () => {
    const judged = applyAction(
      active({ decisionMethod: 'judge', judgeId: 'c' }),
      { type: 'decline_judging', note: 'I work with both of them every day.' },
      'c',
      now,
    );
    await render(judged, 'a');
    await click('Propose changes');
    const method = form()!.querySelector('select[name="decisionMethod"]')!;
    expect(method.closest('label')?.textContent).toMatch(/^Who makes the call\?/);
    const judge = form()!.querySelector('select[name="judgeId"]')!;
    expect(judge.closest('label')?.textContent).not.toContain('stepped down');
    const hint = document.getElementById(judge.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('Casey Hale stepped down');
    // A judge left unchosen is named under the judge field, like New bet's.
    await type(
      form()!.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!,
      'Casey stepped down, so we need a new judge.',
    );
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    expect(errorFor(judge)?.textContent).toBe('Choose a judge.');
    expect(document.activeElement).toBe(judge);
  });
});

describe('a revised history with a location', () => {
  it('asks for a pin on the map, on the location field, rather than blaming the name', async () => {
    const reported = pending({
      history: { stage: 'active', originalDate: { precision: 'month', value: '2024-02' } },
      acknowledgements: { terms: true, result: true, delivery: true },
    });
    await render(reported, 'b');
    await click('Revise history');
    const choice = form()!.querySelector(
      'select[name="location.placeId"]',
    ) as unknown as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        choice,
        'custom',
      );
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const place = form()!.querySelector<HTMLInputElement>('input[name="location.name"]')!;
    await type(place, 'The office kitchen');
    for (const tick of form()!.querySelectorAll<HTMLInputElement>(
      'input[name^="acknowledgements."]',
    ))
      await act(async () => tick.click());
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    expect(place.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(place);
    const message = document.getElementById(place.getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toContain('Choose a point on the map for this location.');
    expect(form()!.contains(message)).toBe(true);
    expect(message!.textContent).not.toMatch(/Name the location/);
  });

  async function reviseWithCustomLocation() {
    const reported = pending({
      history: { stage: 'active', originalDate: { precision: 'month', value: '2024-02' } },
      acknowledgements: { terms: true, result: true, delivery: true },
    });
    await render(reported, 'b');
    await click('Revise history');
    const choice = () =>
      form()!.querySelector('select[name="location.placeId"]') as unknown as HTMLSelectElement;
    const choose = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
          choice(),
          value,
        );
        choice().dispatchEvent(new Event('change', { bubbles: true }));
      });
    await choose('custom');
    for (const tick of form()!.querySelectorAll<HTMLInputElement>(
      'input[name^="acknowledgements."]',
    ))
      await act(async () => tick.click());
    return { choose };
  }
  const placeName = () => form()!.querySelector<HTMLInputElement>('input[name="location.name"]')!;

  it('puts a missing pin under the name field that holds focus, not in the list by the buttons', async () => {
    await reviseWithCustomLocation();
    await type(placeName(), 'Harbor Bench');
    await act(async () => form()!.requestSubmit());
    const message = form()!.querySelector('.custom-place .field > .field-error')!;
    expect(message.textContent).toBe('Choose a point on the map for this location.');
    // Right under the name, above the map, so it is in view where focus is.
    expect(placeName().closest('label')!.nextElementSibling).toBe(message);
    expect(form()!.querySelector('.field-error-list')).toBeNull();
    // The name field is where focus goes; it is marked and described by that message.
    expect(document.activeElement).toBe(placeName());
    expect(placeName().getAttribute('aria-invalid')).toBe('true');
    expect(placeName().getAttribute('aria-describedby')).toContain(message.id);
  });

  it('drops a location message as soon as the Location choice changes', async () => {
    const { choose } = await reviseWithCustomLocation();
    await type(placeName(), 'Harbor Bench');
    await act(async () => form()!.requestSubmit());
    expect(form()!.querySelector('.custom-place .field-error')).not.toBeNull();
    // Another choice answers it, and it is not waiting when the pin form comes back.
    await choose('');
    expect(form()!.querySelector('.field-error')).toBeNull();
    expect(form()!.querySelector('[aria-invalid="true"]')).toBeNull();
    await choose('custom');
    expect(placeName().hasAttribute('aria-invalid')).toBe(false);
    expect(form()!.querySelector('.field-error')).toBeNull();
    // The same goes for a name that was asked for and never given.
    await type(placeName(), '');
    await act(async () => form()!.requestSubmit());
    expect(errorFor(placeName())?.textContent).toBe('Name the location you are pinning.');
    await choose('');
    await choose('custom');
    expect(placeName().hasAttribute('aria-invalid')).toBe(false);
    expect(form()!.querySelector('.field-error')).toBeNull();
  });
});

describe('a revised history with the agreement left wrong', () => {
  async function revise() {
    const reported = pending({
      history: { stage: 'active', originalDate: { precision: 'month', value: '2024-02' } },
      acknowledgements: { terms: true, result: true, delivery: true },
    });
    await render(reported, 'b');
    await click('Revise history');
  }
  const field = (name: string) =>
    form()!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;

  it('names each wrong field under that field, as New bet does, not in the list by the buttons', async () => {
    await revise();
    await type(field('title'), '');
    await type(field('stake'), '0');
    await type(field('creatorSide'), '');
    await type(field('opponentSide'), '  ');
    await type(field('terms'), '');
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    const expected = {
      title: 'Say what the bet is in a few words.',
      stake: 'Use a whole number of rolls from 1 to 100.',
      creatorSide: 'Write Avery’s side of the bet.',
      opponentSide: 'Write Blair’s side of the bet.',
      terms: 'Say what evidence settles the bet.',
    };
    for (const [name, text] of Object.entries(expected)) {
      const control = field(name);
      expect(control.getAttribute('aria-invalid'), name).toBe('true');
      const message = errorFor(control);
      expect(message?.textContent, name).toBe(text);
      // Under its own field, in the form, and not repeated in the list by the buttons.
      expect(control.closest('.field')!.contains(message!), name).toBe(true);
      expect(message!.closest('.field-error-list'), name).toBeNull();
    }
    expect(document.activeElement).toBe(field('title'));
    const listed = [...form()!.querySelectorAll('.field-error-list li')].map(
      (item) => item.textContent,
    );
    expect(
      listed.filter((text) => /^(Bet title|Rolls at stake|.*’s position|Original)/.test(text!)),
    ).toEqual([]);
  });

  it('drops a message as soon as its field is changed', async () => {
    await revise();
    await type(field('title'), '');
    await act(async () => form()!.requestSubmit());
    expect(errorFor(field('title'))).toBeDefined();
    await type(field('title'), 'The release ships before Friday');
    expect(errorFor(field('title'))).toBeUndefined();
    expect(field('title').hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('a one-click approval', () => {
  it('keeps focus on the pressed button while it is recorded', async () => {
    let finish: () => void = () => {};
    onAction.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    await render(pending(), 'b');
    await click('Agree to bet');
    const agree = button('Agree to bet')!;
    expect(agree.getAttribute('aria-busy')).toBe('true');
    expect(agree.disabled).toBe(false);
    expect(document.activeElement).toBe(agree);
    await act(async () => agree.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});

describe('confirming a reported past bet that looks like one on the ledger', () => {
  it('names the match and asks for a tick that it is a different bet', async () => {
    const history = {
      stage: 'owed' as const,
      originalDate: { precision: 'year' as const, value: '2024' },
      result: { winnerId: 'a', date: { precision: 'unknown' as const }, note: 'Avery won.' },
    };
    const reported = pending({
      history,
      acknowledgements: { terms: true, result: true, delivery: false },
      timing: undefined,
    });
    const existing = { ...owed(), id: 'existing', reference: 'LL-EXISTING' };
    await act(async () =>
      root.render(
        createElement(BetDetail, {
          bet: reported,
          bets: [existing, reported],
          members,
          memberId: 'b',
          onClose,
          onAction,
        }),
      ),
    );
    await click('Review and confirm history');
    const warning = form()!.querySelector('.duplicate-warning');
    expect(warning?.textContent).toContain('LL-EXISTING (Friday release)');
    for (const tick of form()!.querySelectorAll<HTMLInputElement>(
      'input[name^="acknowledgements."]',
    ))
      await act(async () => tick.click());
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    const different = form()!.querySelector<HTMLInputElement>('input[name="differentBet"]')!;
    expect(different.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(different)?.textContent).toMatch(/different bet/);
    await act(async () => different.click());
    await act(async () => form()!.requestSubmit());
    expect(onAction).toHaveBeenCalledOnce();
  });
});

describe('asking for a correction to a reported past bet', () => {
  it('says what it does and does not do before it is sent', async () => {
    const reported = pending({
      history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
      acknowledgements: { terms: true, result: false, delivery: false },
    });
    await render(reported, 'b');
    await click('Request a correction');
    const consequence = [...form()!.querySelectorAll('.hint')].map((hint) => hint.textContent);
    expect(consequence.join(' ')).toContain(
      'Nothing can be confirmed until the history is revised, by Avery or by you',
    );
    expect(consequence.join(' ')).toContain('your name and the time');
  });
});

describe('confirming a reported past bet as the second bettor', () => {
  const reportedAs = (history: NewBet['history'], acknowledgements: NewBet['acknowledgements']) =>
    pending({
      history,
      acknowledgements,
      ...(history?.stage === 'active' ? {} : { timing: undefined }),
    });
  it('sums up who won and what is owed above the boxes, and says this is the second confirmation', async () => {
    const reported = reportedAs(
      {
        stage: 'owed',
        originalDate: { precision: 'year', value: '2024' },
        result: { winnerId: 'a', date: { precision: 'unknown' }, note: 'Avery won.' },
      },
      { terms: true, result: true, delivery: false },
    );
    await render(reported, 'b');
    await click('Review and confirm history');
    const confirmation = form()!.querySelector('.workflow-acknowledgements')!;
    const summary = confirmation.querySelector('.history-summary')!;
    expect(summary.textContent).toBe(
      'Avery Stone won. Blair Reed owes Avery Stone 3 lobster rolls.',
    );
    // Above the boxes it asks about.
    expect(
      summary.compareDocumentPosition(confirmation.querySelector('input')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(confirmation.textContent).toContain('You are the second confirmation');
    expect(confirmation.textContent).not.toContain('Sending this records your confirmation');
  });

  it('sums up a delivered, a called-off and an ongoing bet in their own words', async () => {
    const summaryFor = async (
      history: NewBet['history'],
      acknowledgements: NewBet['acknowledgements'],
    ) => {
      await render(reportedAs(history, acknowledgements), 'b');
      await click('Review and confirm history');
      return form()!.querySelector('.history-summary')!.textContent;
    };
    const date = { precision: 'unknown' as const };
    const original = { precision: 'year' as const, value: '2024' };
    expect(
      await summaryFor(
        {
          stage: 'settled',
          originalDate: original,
          result: { winnerId: 'b', date, note: 'Blair won.' },
          delivery: { date, note: 'At lunch.' },
        },
        { terms: true, result: true, delivery: true },
      ),
    ).toBe('Blair Reed won, and all 3 lobster rolls were delivered. Nothing is owed.');
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(
      await summaryFor(
        {
          stage: 'voided',
          originalDate: original,
          result: { winnerId: null, date, note: 'Rained out.' },
        },
        { terms: true, result: true, delivery: false },
      ),
    ).toBe('Called off with no winner. No rolls are owed.');
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(
      await summaryFor(
        { stage: 'active', originalDate: original },
        { terms: true, result: false, delivery: false },
      ),
    ).toBe('Still ongoing, with 3 lobster rolls at stake.');
  });
});

describe('a revised history with its dates out of order', () => {
  it('names the outcome date under its group and clears it when the bet date changes', async () => {
    const reported = pending({
      history: {
        stage: 'owed',
        originalDate: { precision: 'day', value: '2024-05-01' },
        result: { winnerId: 'a', date: { precision: 'day', value: '2024-06-01' }, note: 'Won.' },
      },
      acknowledgements: { terms: true, result: true, delivery: false },
      timing: undefined,
    });
    await render(reported, 'b');
    await click('Revise history');
    const decided = form()!.querySelector<HTMLInputElement>(
      'input[name="history.resultDate.value"]',
    )!;
    await type(decided, '2024-03-01');
    for (const tick of form()!.querySelectorAll<HTMLInputElement>(
      'input[name^="acknowledgements."]',
    ))
      await act(async () => tick.click());
    await act(async () => form()!.requestSubmit());
    expect(onAction).not.toHaveBeenCalled();
    expect(decided.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(decided)?.textContent).toBe(
      'The outcome can’t be decided before the bet was made.',
    );
    expect(decided.closest('fieldset')!.contains(errorFor(decided)!)).toBe(true);
    expect(document.activeElement).toBe(decided);
    // Moving the bet date answers it too: the two dates were checked against each other.
    await type(
      form()!.querySelector<HTMLInputElement>('input[name="history.originalDate.value"]')!,
      '2024-02-01',
    );
    expect(decided.getAttribute('aria-invalid')).toBeNull();
  });
});
