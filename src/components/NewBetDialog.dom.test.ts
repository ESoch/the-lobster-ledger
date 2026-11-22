// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { NewBetDialog } from './NewBetDialog';

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
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('likely-duplicate warning on a history import', () => {
  it('announces through a live region that is mounted before the warning appears', async () => {
    const state = createDemoState();
    const ellis = state.members.find((member) => member.name === 'Ellis')!;
    const olivia = state.members.find((member) => member.name === 'Olivia')!;
    const existing = state.bets.find((bet) => bet.title === 'The ferry beats the rideshare')!;
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: ellis.id,
          onCreate: vi.fn(),
          mode: 'history',
        }),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    const region = dialog.querySelector('[role="status"].duplicate-status')!;
    expect(region).not.toBeNull();
    expect(region.textContent).toBe('');
    expect(dialog.querySelector('.duplicate-warning')).toBeNull();
    await type(dialog.querySelector('input[name="title"]')!, 'the ferry beats the rideshare');
    const opponent = [...dialog.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === olivia.id),
    )!;
    await choose(opponent, olivia.id);
    // Same element, new text: that is what assistive tech announces reliably.
    expect(dialog.querySelector('[role="status"].duplicate-status')).toBe(region);
    expect(region.textContent).toContain(existing.reference);
    expect(region.querySelector('.duplicate-warning')).not.toBeNull();
  });
});

describe('what counts as the same bet when adding an old one', () => {
  const state = createDemoState();
  const ellis = state.members.find((member) => member.name === 'Ellis')!;
  const olivia = state.members.find((member) => member.name === 'Olivia')!;
  const existing = state.bets.find((bet) => bet.title === 'The ferry beats the rideshare')!;
  async function open() {
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: ellis.id,
          onCreate: vi.fn(),
          mode: 'history',
        }),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    const select = (name: string) =>
      dialog.querySelector(`select[name="${name}"]`) as unknown as HTMLSelectElement;
    await choose(
      [...dialog.querySelectorAll('select')].find((candidate) =>
        [...candidate.options].some((option) => option.value === olivia.id),
      )!,
      olivia.id,
    );
    return { dialog, select };
  }

  it('warns when the title differs only by punctuation or a leading article', async () => {
    const { dialog } = await open();
    const warning = () => dialog.querySelector('.duplicate-status .duplicate-warning');
    await type(dialog.querySelector('input[name="title"]')!, 'Ferry beats the rideshare!');
    expect(warning()?.textContent).toContain(existing.reference);
    expect(dialog.querySelector('input[name="differentBet"]')).not.toBeNull();
    await type(dialog.querySelector('input[name="title"]')!, 'The ferry beats the bridge');
    expect(warning()).toBeNull();
    expect(dialog.querySelector('input[name="differentBet"]')).toBeNull();
  });

  it('warns about the same title at other stakes when the date it was made is close', async () => {
    const { dialog, select } = await open();
    await type(dialog.querySelector('input[name="title"]')!, 'The ferry beats the rideshare');
    await type(dialog.querySelector('input[name="stake"]')!, '4');
    expect(dialog.querySelector('.duplicate-warning')).toBeNull();
    await choose(select('history.originalDate.precision'), 'day');
    const day = dialog.querySelector<HTMLInputElement>('input[name="history.originalDate.value"]')!;
    await type(day, '2024-05-01');
    expect(dialog.querySelector('.duplicate-warning')).toBeNull();
    await type(day, existing.createdAt.slice(0, 10));
    expect(dialog.querySelector('.duplicate-warning')?.textContent).toContain(existing.reference);
    await choose(select('history.originalDate.precision'), 'unknown');
    expect(dialog.querySelector('.duplicate-warning')).toBeNull();
  });
});

describe('a date error on a history import', () => {
  it('sits directly in the date group, where the stylesheet gives it the gap a field has', async () => {
    const state = createDemoState();
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: state.members[0].id,
          onCreate: vi.fn(),
          mode: 'history',
        }),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    await choose(
      dialog.querySelector(
        'select[name="history.originalDate.precision"]',
      ) as unknown as HTMLSelectElement,
      'day',
    );
    await act(async () => dialog.querySelector('form')!.requestSubmit());
    const group = dialog.querySelector('fieldset.historical-date-field')!;
    const message = group.querySelector(':scope > .field-error');
    expect(message?.textContent).toMatch(/date/);
    expect(group.querySelector('input')!.getAttribute('aria-describedby')).toContain(message!.id);
  });
});

describe('validating a new bet in the form', () => {
  const state = createDemoState();
  const ellis = state.members.find((member) => member.name === 'Ellis')!;
  const sarah = state.members.find((member) => member.name === 'Sarah')!;
  async function open(onCreate = vi.fn(async () => {}), onClose: () => void = () => {}) {
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose,
          state,
          memberId: ellis.id,
          onCreate,
        }),
      ),
    );
    return onCreate;
  }
  const buttonNamed = (name: string) =>
    [...dialog().querySelectorAll('button')].find((candidate) => candidate.textContent === name);
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const form = () => dialog().querySelector('form')!;
  // tsc 7's DOM typings reject a select as an Element type argument, so this stays unconstrained.
  const field = <T = HTMLInputElement>(name: string) =>
    dialog().querySelector(`[name="${name}"]`) as unknown as T;
  const submitButton = () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const errorFor = (control: { getAttribute(name: string): string | null }) => {
    const ids = control.getAttribute('aria-describedby')?.split(' ') ?? [];
    return ids
      .map((id) => document.getElementById(id))
      .find((element) => element?.classList.contains('field-error'));
  };
  async function submit() {
    await act(async () => form().requestSubmit());
  }
  async function typeArea(area: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('keeps Propose bet enabled and puts a missing opponent on the opponent field', async () => {
    const onCreate = await open();
    expect(form().noValidate).toBe(true);
    expect(submitButton().disabled).toBe(false);
    await type(field('title'), 'The ferry beats the bridge traffic');
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    const opponent = field<HTMLSelectElement>('opponentId');
    expect(document.activeElement).toBe(opponent);
    expect(opponent.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(opponent)?.textContent).toBe('Choose who is on the other side.');
    // The error sits with its field, inside the form, not in a banner by the buttons.
    expect(errorFor(opponent)!.closest('form')).toBe(form());
    expect(submitButton().disabled).toBe(false);
    // Choosing someone clears the message.
    await choose(opponent, sarah.id);
    expect(opponent.hasAttribute('aria-invalid')).toBe(false);
    expect(errorFor(opponent)).toBeUndefined();
  });

  it('lets Enter in the title field run the same checks', async () => {
    const onCreate = await open();
    const title = field('title');
    title.focus();
    // Implicit submission uses the form's default button, which must not be disabled.
    expect(form().querySelector('button[type="submit"]')).toBe(submitButton());
    expect(submitButton().disabled).toBe(false);
    await act(async () => form().requestSubmit(submitButton()));
    expect(onCreate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(title);
    expect(errorFor(title)?.textContent).toBe('Say what the bet is in a few words.');
  });

  it('counts trimmed characters, checks the timezone on blur and wants two different positions', async () => {
    await open();
    await type(field('title'), 'ab   ');
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    await type(field('creatorSide'), 'It ships');
    await type(field('opponentSide'), ' it ships ');
    await typeArea(field<HTMLTextAreaElement>('terms'), 'The production deploy log.');
    const zone = field('timing.timezone');
    await type(zone, 'Mars/Base');
    await act(async () => {
      zone.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(zone.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(zone)?.textContent).toContain('Mars/Base');
    await submit();
    expect(errorFor(field('title'))?.textContent).toBe('Use at least 5 characters.');
    expect(errorFor(field('opponentSide'))?.textContent).toBe(
      'The two positions must be different.',
    );
    expect(document.activeElement).toBe(field('title'));
  });

  it('does not count zero-width characters toward a minimum or as a difference between positions', async () => {
    await open();
    const zero = '\u200b\u200c\u200d\u2060\ufeff';
    await type(field('title'), `ab${zero}`);
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    await type(field('creatorSide'), 'It ships Friday');
    await type(field('opponentSide'), ' it\u200b SHIPS\u2060 friday ');
    await typeArea(field<HTMLTextAreaElement>('terms'), `${zero}${zero} short`);
    await type(field('timing.local'), '2030-01-01T10:00');
    await submit();
    expect(errorFor(field('title'))?.textContent).toBe('Use at least 5 characters.');
    expect(errorFor(field('opponentSide'))?.textContent).toBe(
      'The two positions must be different.',
    );
    expect(errorFor(field('terms'))?.textContent).toBe('Use at least 10 characters.');
    // Nothing but zero-width characters is the same as nothing typed.
    await type(field('title'), zero);
    await submit();
    expect(errorFor(field('title'))?.textContent).toBe('Say what the bet is in a few words.');
  });

  it('keeps a typed date and timezone when review switches to an event and back', async () => {
    await open();
    const kind = field<HTMLSelectElement>('timing.kind');
    expect(kind.labels?.[0]?.textContent).toContain('What opens review?');
    await type(field('timing.local'), '2026-11-02T17:00');
    await type(field('timing.timezone'), 'Europe/London');
    await choose(kind, 'event');
    // Hidden, and left out of the form, while another kind is chosen.
    expect(field('timing.local').matches(':disabled')).toBe(true);
    expect(field('timing.local').willValidate).toBe(false);
    await typeArea(field<HTMLTextAreaElement>('timing.description'), 'The final whistle.');
    await choose(kind, 'date');
    expect(field('timing.local').value).toBe('2026-11-02T17:00');
    expect(field('timing.timezone').value).toBe('Europe/London');
    await choose(kind, 'evidence');
    expect(field<HTMLTextAreaElement>('timing.description').value).toBe('The final whistle.');
  });

  it('asks before Escape discards what was typed', async () => {
    await open();
    await type(field('title'), 'The ferry beats the bridge traffic');
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect([...dialog().querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'Discard',
    );
  });

  it('asks before Cancel throws away what was typed, and closes at once when nothing was', async () => {
    const onClose = vi.fn();
    await open(undefined, onClose);
    await act(async () => buttonNamed('Cancel')!.click());
    expect(onClose).toHaveBeenCalledOnce();
    onClose.mockClear();
    await type(field('title'), 'The ferry beats the bridge traffic');
    await act(async () => buttonNamed('Cancel')!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(buttonNamed('Keep editing')).toBeDefined();
    await act(async () => buttonNamed('Keep editing')!.click());
    expect(field<HTMLInputElement>('title').value).toBe('The ferry beats the bridge traffic');
    await act(async () => buttonNamed('Cancel')!.click());
    await act(async () => buttonNamed('Discard')!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says the judge went when the opponent becomes the judge, and clears that note on a new choice', async () => {
    await open();
    await choose(field<HTMLSelectElement>('decisionMethod'), 'judge');
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    const judge = field<HTMLSelectElement>('judgeId');
    const alex = state.members.find((member) => member.name === 'Alex')!;
    await choose(judge, alex.id);
    expect(judge.value).toBe(alex.id);
    // The opponent changes to the person already chosen to judge.
    await choose(field<HTMLSelectElement>('opponentId'), alex.id);
    expect(field<HTMLSelectElement>('judgeId').value).toBe('');
    const note = dialog().querySelector('.judge-status')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe(
      'Alex is now on the other side, so they can’t judge this bet. Choose another judge.',
    );
    await choose(field<HTMLSelectElement>('judgeId'), sarah.id);
    expect(dialog().querySelector('.judge-status')!.textContent).toBe('');
  });

  it('gives each decision a plain name that matches its heading and no two questions say “decide”', async () => {
    await open();
    const labels = [...dialog().querySelectorAll('label')].map((label) =>
      (label.textContent ?? '').trim(),
    );
    expect(labels.some((text) => text.startsWith('Who makes the call?'))).toBe(true);
    expect(labels.some((text) => text.startsWith('What opens review?'))).toBe(true);
    expect(dialog().querySelector('.workflow-fields h3')?.textContent).toBe('When review opens');
    expect(dialog().textContent).not.toMatch(
      /How will you decide|Who adjudicates|can this be decided/,
    );
  });

  it('writes the stake’s unit in the singular for one roll', async () => {
    await open();
    const unit = () => dialog().querySelector('.input-affix > span')!.textContent;
    expect(unit()).toBe('lobster roll');
    await type(field('stake'), '12');
    expect(unit()).toBe('lobster rolls');
    await type(field('stake'), '1');
    expect(unit()).toBe('lobster roll');
  });

  it('shows a refused bet by the buttons and drops it as soon as anything is changed', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('That member is no longer in the ledger.');
    });
    await open(onCreate);
    await type(field('title'), 'The ferry beats the bridge traffic');
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    await type(field('creatorSide'), 'It is quicker');
    await type(field('opponentSide'), 'It is slower');
    await typeArea(
      field<HTMLTextAreaElement>('terms'),
      'The ferry schedule against the traffic report.',
    );
    await type(field('timing.local'), '2030-11-02T17:00');
    await submit();
    expect(onCreate).toHaveBeenCalledOnce();
    const message = dialog().querySelector('.modal-footer .form-error');
    expect(message?.textContent).toBe('That member is no longer in the ledger.');
    // The pressed button is never disabled, so focus is not lost with it.
    expect(submitButton().disabled).toBe(false);
    await type(field('creatorSide'), 'It is a lot quicker');
    expect(dialog().querySelector('.modal-footer .form-error')).toBeNull();
  });

  it('turns away a first check-in that has already passed', async () => {
    await open();
    await act(async () => field('timing.hasCheckIn').click());
    const when = field('timing.checkIn.local');
    await type(when, '2020-01-01T09:00');
    await submit();
    expect(when.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(when)?.textContent).toBe('Choose a time that hasn’t passed yet.');
  });

  it('names the opponent in their position and keeps avatars and hints out of field names', async () => {
    await open();
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    const theirs = field('opponentSide');
    expect(theirs.labels?.[0]?.textContent?.trim()).toBe('Sarah’s position');
    const mine = field('creatorSide');
    expect(mine.labels?.[0]?.textContent?.trim()).toBe('Your position');
    const zone = field('timing.timezone');
    expect(zone.labels?.[0]?.textContent?.trim()).toBe('Timezone');
  });
});

describe('bringing an old bet in', () => {
  it('points at a future date on its field instead of a banner by the buttons', async () => {
    const state = createDemoState();
    const ellis = state.members.find((member) => member.name === 'Ellis')!;
    const onCreate = vi.fn(async () => {});
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: ellis.id,
          onCreate,
          mode: 'history',
        }),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    await choose(
      dialog.querySelector(
        'select[name="history.originalDate.precision"]',
      ) as unknown as HTMLSelectElement,
      'day',
    );
    const day = dialog.querySelector<HTMLInputElement>('input[name="history.originalDate.value"]')!;
    await type(day, '2099-01-01');
    await act(async () => dialog.querySelector('form')!.requestSubmit());
    expect(onCreate).not.toHaveBeenCalled();
    // Earlier fields are empty too, so check this field's own message rather than the focus.
    expect(day.getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(day.getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toContain('The bet can’t have been made in the future.');
  });
});

describe('the dates and duplicates of an old bet', () => {
  const state = createDemoState();
  const ellis = state.members.find((member) => member.name === 'Ellis')!;
  const olivia = state.members.find((member) => member.name === 'Olivia')!;
  const sarah = state.members.find((member) => member.name === 'Sarah')!;
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const field = <T = HTMLInputElement>(name: string) =>
    dialog().querySelector(`[name="${name}"]`) as unknown as T;
  async function typeArea(area: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function open() {
    const onCreate = vi.fn(async () => {});
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: ellis.id,
          onCreate,
          mode: 'history',
        }),
      ),
    );
    return onCreate;
  }
  /** A decided bet with rolls owed, every field but its dates filled in. */
  async function fill(title: string, opponent: string) {
    await choose(field<HTMLSelectElement>('history.stage'), 'owed');
    await type(field('title'), title);
    await choose(field<HTMLSelectElement>('opponentId'), opponent);
    await type(field('creatorSide'), 'The ferry arrives first');
    await type(field('opponentSide'), 'The rideshare arrives first');
    await typeArea(
      field<HTMLTextAreaElement>('terms'),
      'The first timestamped arrival decides it.',
    );
    await choose(field<HTMLSelectElement>('history.winnerId'), ellis.id);
    await typeArea(field<HTMLTextAreaElement>('history.resultNote'), 'The ferry won by a mile.');
    for (const box of dialog().querySelectorAll<HTMLInputElement>(
      'input[name^="acknowledgements."]',
    ))
      await act(async () => box.click());
  }
  const submit = () => act(async () => dialog().querySelector('form')!.requestSubmit());
  const messageOf = (control: Element) =>
    document.getElementById(
      (control.getAttribute('aria-describedby') ?? '').split(' ').find((id) => id) ?? '',
    );

  it('names a future original date under its own group, focused, and clears it on a change', async () => {
    const onCreate = await open();
    await fill('The ferry beats the bridge traffic', sarah.id);
    const precision = field<HTMLSelectElement>('history.originalDate.precision');
    await choose(precision, 'day');
    const day = field('history.originalDate.value');
    await type(day, '2099-01-01');
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    const group = day.closest('fieldset')!;
    expect(group.querySelector('legend')?.textContent).toBe('When was the bet made?');
    expect(day.getAttribute('aria-invalid')).toBe('true');
    const message = messageOf(day)!;
    expect(message.classList.contains('field-error')).toBe(true);
    expect(group.contains(message)).toBe(true);
    expect(message.textContent).toBe(
      'The bet can’t have been made in the future. Choose a date up to today.',
    );
    expect(document.activeElement).toBe(day);
    expect(dialog().querySelector('.modal-footer .form-error')).toBeNull();
    await type(day, '2024-01-10');
    expect(day.getAttribute('aria-invalid')).toBeNull();
    expect(group.querySelector('.field-error')).toBeNull();
  });

  it('puts an outcome decided before the bet on the outcome date', async () => {
    const onCreate = await open();
    await fill('The ferry beats the bridge traffic', sarah.id);
    await choose(field<HTMLSelectElement>('history.originalDate.precision'), 'day');
    await type(field('history.originalDate.value'), '2024-05-01');
    await choose(field<HTMLSelectElement>('history.resultDate.precision'), 'month');
    const decided = field('history.resultDate.value');
    await type(decided, '2024-03');
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    expect(decided.getAttribute('aria-invalid')).toBe('true');
    expect(messageOf(decided)?.textContent).toBe(
      'The outcome can’t be decided before the bet was made.',
    );
    expect(document.activeElement).toBe(decided);
  });

  it('keeps the terms tick and the outcome typed when the stage changes and changes back', async () => {
    await open();
    await fill('The ferry beats the bridge traffic', sarah.id);
    const stage = field<HTMLSelectElement>('history.stage');
    await choose(stage, 'active');
    expect(field('acknowledgements.terms').checked).toBe(true);
    expect(field('acknowledgements.result')).toBeNull();
    await choose(stage, 'owed');
    expect(field('acknowledgements.terms').checked).toBe(true);
    // The tick for the outcome is for the outcome as it was worded then.
    expect(field('acknowledgements.result').checked).toBe(false);
    expect(field<HTMLSelectElement>('history.winnerId').value).toBe(ellis.id);
    expect(field<HTMLTextAreaElement>('history.resultNote').value).toBe('The ferry won by a mile.');
  });

  it('keeps the review timing typed for a bet still going through a stage that has none', async () => {
    await open();
    const stage = field<HTMLSelectElement>('history.stage');
    await type(field('timing.source'), 'The official match report');
    await choose(stage, 'owed');
    // Set aside while the bet is decided: not shown, not checked, not sent.
    expect(field('timing.source').closest('[hidden]')).not.toBeNull();
    expect(field('timing.source').closest('fieldset')!.disabled).toBe(true);
    await choose(stage, 'active');
    expect(field('timing.source').closest('[hidden]')).toBeNull();
    expect(field('timing.source').value).toBe('The official match report');
  });

  it('asks for a tick that a likely duplicate is a different bet before sending it', async () => {
    const onCreate = await open();
    await fill('The ferry beats the rideshare', olivia.id);
    expect(dialog().querySelector('.duplicate-warning')?.textContent).toContain(
      'The ferry beats the rideshare',
    );
    const different = field('differentBet');
    expect(different.type).toBe('checkbox');
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    expect(different.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(different);
    await act(async () => different.click());
    await submit();
    expect(onCreate).toHaveBeenCalledOnce();
  });
});

describe('what the dialog for an old bet says', () => {
  const state = createDemoState();
  const ellis = state.members.find((member) => member.name === 'Ellis')!;
  const sarah = state.members.find((member) => member.name === 'Sarah')!;
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const field = <T = HTMLInputElement>(name: string) =>
    dialog().querySelector(`[name="${name}"]`) as unknown as T;
  async function open(mode: 'new' | 'history') {
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: ellis.id,
          onCreate: vi.fn(async () => {}),
          mode,
        }),
      ),
    );
  }
  const describedBy = (control: { getAttribute(name: string): string | null }) =>
    document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent ?? '';

  it('starts on the question about where the bet stands, and a new bet on its title', async () => {
    await open('new');
    expect(document.activeElement).toBe(field('title'));
    await act(async () => root.unmount());
    root = createRoot(container);
    await open('history');
    expect(document.activeElement).toBe(field('history.stage'));
  });

  it('says what each answer records and who confirms it, naming the other bettor once chosen', async () => {
    await open('history');
    const stage = field<HTMLSelectElement>('history.stage');
    expect(describedBy(stage)).toContain('ongoing');
    expect(describedBy(stage)).toContain('The other bettor confirms the same history');
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    await choose(stage, 'owed');
    expect(describedBy(stage)).toContain('owes the winner the rolls');
    expect(describedBy(stage)).toContain('Sarah confirms the same history before it counts');
    await choose(stage, 'voided');
    expect(describedBy(stage)).toContain('no winner');
  });

  it('says that sending is the first confirmation and who confirms next', async () => {
    await open('history');
    await choose(field<HTMLSelectElement>('opponentId'), sarah.id);
    const confirmation = dialog().querySelector('.workflow-acknowledgements')!;
    expect(confirmation.textContent).toContain(
      'Sending this records your confirmation. Sarah confirms next',
    );
  });

  it('gives examples and a prompt written for a bet that already happened', async () => {
    await open('history');
    const old = {
      title: field('title').placeholder,
      mine: field('creatorSide').placeholder,
      theirs: field('opponentSide').placeholder,
      terms: field<HTMLTextAreaElement>('terms').placeholder,
    };
    await open('new');
    expect(old.title).not.toBe(field('title').placeholder);
    expect(old.mine).not.toBe(field('creatorSide').placeholder);
    expect(old.theirs).not.toBe(field('opponentSide').placeholder);
    expect(old.terms).toMatch(/agreed/);
    // Nothing of an upcoming deadline in what is asked about the past.
    expect(Object.values(old).join(' ')).not.toMatch(/Friday|ships/);
  });
});
