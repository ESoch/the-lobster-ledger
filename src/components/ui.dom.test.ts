// @vitest-environment jsdom
import {
  act,
  createElement,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_INK, contrastRatio } from '../lib/avatar-colors';
import { Avatar, Modal, ModalCancel, dateLabel, type LeaveRequest } from './ui';

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

type HarnessProps = {
  mountWhenOpen?: boolean;
  dirty?: boolean;
  sheet?: boolean;
  description?: string;
  onClosed?: () => void;
  onEscapeKeyDown?: ComponentProps<typeof Modal>['onEscapeKeyDown'];
  fallbackFocus?: () => HTMLElement | null;
  leaveRef?: ComponentProps<typeof Modal>['leaveRef'];
  children?: ReactNode;
};

// A page with a heading, an opener button and a Modal driven the way App drives its dialogs.
function Harness({
  mountWhenOpen,
  dirty,
  sheet,
  description,
  onClosed,
  onEscapeKeyDown,
  fallbackFocus,
  leaveRef,
  children,
}: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  const close = () => {
    onClosed?.();
    setOpen(false);
  };
  const modal = createElement(Modal, {
    open,
    onClose: close,
    title: 'Test dialog',
    dirty,
    sheet,
    description,
    onEscapeKeyDown,
    fallbackFocus,
    leaveRef,
    children: children ?? createElement('input', { 'aria-label': 'Name', autoFocus: true }),
  });
  return createElement(
    'div',
    null,
    createElement(
      'main',
      null,
      createElement('h1', null, 'Page heading'),
      showOpener &&
        createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open it'),
      createElement('button', { id: 'other', onClick: () => setOpen(true) }, 'Open from other'),
      createElement('button', { id: 'remove', onClick: () => setShowOpener(false) }, 'Remove'),
    ),
    mountWhenOpen ? open && modal : modal,
  );
}

async function render(props: HarnessProps = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
const byId = (id: string) => document.getElementById(id) as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"]');
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
async function openFrom(id: string) {
  byId(id).focus();
  await act(async () => byId(id).click());
  await settle();
}
async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}
async function clickClose() {
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click(),
  );
  await settle();
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

describe.each([
  ['always mounted', false],
  ['mounted only while open', true],
])('Modal focus return (%s)', (_label, mountWhenOpen) => {
  it('returns focus to the opener when closed with Escape', async () => {
    await render({ mountWhenOpen });
    await openFrom('opener');
    expect(dialog()).not.toBeNull();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(byId('opener'));
  });

  it('returns focus to the opener when closed with the Close button', async () => {
    await render({ mountWhenOpen });
    await openFrom('opener');
    await clickClose();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(byId('opener'));
  });

  it('follows the opener that was used for this opening', async () => {
    await render({ mountWhenOpen });
    await openFrom('opener');
    await pressEscape();
    await openFrom('other');
    await pressEscape();
    expect(document.activeElement).toBe(byId('other'));
  });

  it('falls back to the page heading when the opener is gone', async () => {
    await render({ mountWhenOpen });
    await openFrom('opener');
    await act(async () => byId('remove').click());
    expect(document.getElementById('opener')).toBeNull();
    await pressEscape();
    const heading = document.querySelector('main h1');
    expect(document.activeElement).toBe(heading);
    expect(heading!.getAttribute('tabindex')).toBe('-1');
  });

  it('lands where the page asks when the opener is gone, and still prefers a live opener', async () => {
    const landing = () => document.getElementById('landing');
    const fallbackFocus = () => landing();
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(Harness, { mountWhenOpen, fallbackFocus }),
          createElement('p', { id: 'landing', tabIndex: -1 }, 'Where it landed'),
        ),
      );
    });
    await openFrom('opener');
    await pressEscape();
    expect(document.activeElement).toBe(byId('opener'));
    await openFrom('opener');
    await act(async () => byId('remove').click());
    await pressEscape();
    expect(document.activeElement).toBe(landing());
  });

  it('lands on the page heading, not the opener, when the route changed while it was open', async () => {
    window.history.replaceState(null, '', '/#overview');
    await render({ mountWhenOpen });
    await openFrom('opener');
    // A link inside the dialog took the reader to another page; the opener belongs to the old one.
    window.history.replaceState(null, '', '/#cli');
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('main h1'));
    window.history.replaceState(null, '', '/#overview');
  });
});

// A launcher on the page, a first dialog whose Submit button closes it and opens a second one, and a
// keyboard shortcut that opens the first dialog without any click.
function Chain() {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'n') setFirst(true);
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
  return createElement(
    'div',
    null,
    createElement(
      'main',
      null,
      createElement('h1', null, 'Page heading'),
      createElement('button', { id: 'launch', onClick: () => setFirst(true) }, 'Launch'),
    ),
    createElement(Modal, {
      open: first,
      onClose: () => setFirst(false),
      title: 'First dialog',
      children: createElement(
        'button',
        {
          id: 'submit',
          onClick: () => {
            setFirst(false);
            setSecond(true);
          },
        },
        'Submit',
      ),
    }),
    createElement(Modal, {
      open: second,
      onClose: () => setSecond(false),
      title: 'Second dialog',
      children: createElement('p', null, 'Second body'),
    }),
  );
}

describe('Modal opener fallbacks', () => {
  it('returns a dialog opened from inside another dialog to the outer dialog opener', async () => {
    await act(async () => root.render(createElement(Chain)));
    await openFrom('launch');
    await openFrom('submit');
    expect(dialog()?.textContent).toContain('Second body');
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.getElementById('submit')).toBeNull();
    expect(document.activeElement).toBe(byId('launch'));
  });

  it('uses the control that was clicked when the browser does not focus buttons on click', async () => {
    await render();
    expect(document.activeElement).toBe(document.body);
    await act(async () => byId('opener').click());
    await settle();
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(document.activeElement).toBe(byId('opener'));
  });

  it('does not trust an old click when a dialog opens without one', async () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    await act(async () => root.render(createElement(Chain)));
    await act(async () => byId('launch').click());
    await settle();
    await pressEscape();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    now.mockReturnValue(realNow + 60_000);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    });
    await settle();
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(document.activeElement).toBe(document.querySelector('main h1'));
    now.mockRestore();
  });
});

describe('Modal hooks', () => {
  it('runs onEscapeKeyDown and lets it veto the close', async () => {
    const onClosed = vi.fn();
    const onEscapeKeyDown = vi.fn((event: KeyboardEvent) => event.preventDefault());
    await render({ onClosed, onEscapeKeyDown });
    await openFrom('opener');
    await pressEscape();
    expect(onEscapeKeyDown).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });
});

describe('Modal outside interaction', () => {
  const pointerDownOn = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    });

  it('stays open when a notification outside the dialog is used', async () => {
    const toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
    const onClosed = vi.fn();
    await render({ onClosed });
    await openFrom('opener');
    await pointerDownOn(toast);
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    toast.remove();
  });

  it('stays open when the click lands inside the notification region, on any part of it', async () => {
    const region = document.createElement('div');
    region.className = 'toast-region';
    const dismiss = document.createElement('button');
    region.appendChild(dismiss);
    document.body.appendChild(region);
    const onClosed = vi.fn();
    await render({ onClosed });
    await openFrom('opener');
    await pointerDownOn(dismiss);
    await pointerDownOn(region);
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    region.remove();
  });

  it('closes for any other outside click, and dirty asks first', async () => {
    const onClosed = vi.fn();
    await render({ onClosed });
    await openFrom('opener');
    await pointerDownOn(document.body);
    await settle();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
  });

  it('asks before an outside click discards unsaved input', async () => {
    const onClosed = vi.fn();
    await render({ dirty: true, onClosed });
    await openFrom('opener');
    await pointerDownOn(document.body);
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    expect(button('Discard')).toBeDefined();
  });
});

describe('Modal with unsaved changes', () => {
  it('asks before closing on Escape, and Keep editing leaves the dialog open', async () => {
    const onClosed = vi.fn();
    await render({ dirty: true, onClosed });
    await openFrom('opener');
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    field.focus();
    await pressEscape();
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(button('Discard')).toBeDefined();
    expect(button('Keep editing')).toBeDefined();
    expect(document.activeElement).toBe(button('Keep editing'));
    await act(async () => button('Keep editing')!.click());
    expect(button('Discard')).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it('returns to the field being edited when an outside click had already taken focus off it', async () => {
    const onClosed = vi.fn();
    await render({
      dirty: true,
      onClosed,
      children: [
        createElement('input', { key: 'a', 'aria-label': 'Name', autoFocus: true }),
        createElement('input', { key: 'b', 'aria-label': 'Other' }),
      ],
    });
    await openFrom('opener');
    const other = document.querySelector<HTMLInputElement>('input[aria-label="Other"]')!;
    other.focus();
    // A mouse press moves focus to the page before the dialog hears about the click, so the
    // question opens with nothing focused.
    other.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(button('Keep editing')).toBeDefined();
    await act(async () => button('Keep editing')!.click());
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(dialog());
  });

  it('asks before closing from the Close button and Discard closes and returns focus', async () => {
    const onClosed = vi.fn();
    await render({ dirty: true, onClosed });
    await openFrom('opener');
    await clickClose();
    expect(onClosed).not.toHaveBeenCalled();
    expect(button('Discard')).toBeDefined();
    await act(async () => button('Discard')!.click());
    await settle();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(byId('opener'));
  });

  it('does not ask when nothing has changed', async () => {
    const onClosed = vi.fn();
    await render({ dirty: false, onClosed });
    await openFrom('opener');
    await pressEscape();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(button('Discard')).toBeUndefined();
  });

  it('forgets a pending question when the dialog is reopened', async () => {
    await render({ dirty: true });
    await openFrom('opener');
    await pressEscape();
    expect(button('Discard')).toBeDefined();
    await act(async () => button('Discard')!.click());
    await settle();
    await openFrom('opener');
    expect(dialog()).not.toBeNull();
    expect(button('Discard')).toBeUndefined();
  });
});

describe('Modal left from outside it (Back, a typed address)', () => {
  const leaveRef = { current: null as LeaveRequest | null };
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('leaves at once when nothing has changed', async () => {
    const onClosed = vi.fn();
    await render({ dirty: false, onClosed, leaveRef });
    expect(leaveRef.current).toBeNull();
    await openFrom('opener');
    const leave = vi.fn();
    let left = false;
    await act(async () => void (left = leaveRef.current!(leave)));
    expect(left).toBe(true);
    expect(leave).toHaveBeenCalledOnce();
    expect(button('Discard')).toBeUndefined();
    // Leaving is the caller's to do; the dialog itself was not closed by the request.
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('asks first when the dialog holds unsaved input, and only Discard leaves', async () => {
    const onClosed = vi.fn();
    await render({ dirty: true, onClosed, leaveRef });
    await openFrom('opener');
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    field.focus();
    const leave = vi.fn();
    let left = true;
    await act(async () => void (left = leaveRef.current!(leave)));
    expect(left).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Keep editing'));
    await act(async () => button('Keep editing')!.click());
    expect(leave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
    await act(async () => void leaveRef.current!(leave));
    await act(async () => button('Discard')!.click());
    expect(leave).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('is empty again once the dialog closes', async () => {
    await render({ dirty: false, leaveRef });
    await openFrom('opener');
    expect(leaveRef.current).not.toBeNull();
    await pressEscape();
    expect(leaveRef.current).toBeNull();
  });

  it('asks the browser to hold a reload or a closed tab only while input is unsaved', async () => {
    await render({ dirty: true });
    expect(unload()).toBe(false);
    await openFrom('opener');
    expect(unload()).toBe(true);
    await render({ dirty: false });
    expect(unload()).toBe(false);
  });
});

describe('Modal discard prompt for one part of a dialog', () => {
  it('lets Escape hand the question a different discard, and Keep editing leaves everything as it was', async () => {
    const onClosed = vi.fn();
    const discard = vi.fn();
    await render({
      onClosed,
      onEscapeKeyDown: (event, guard) => {
        if (guard.asking) return;
        event.preventDefault();
        guard.ask(discard);
      },
    });
    await openFrom('opener');
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    field.focus();
    await pressEscape();
    expect(button('Keep editing')).toBeDefined();
    expect(document.activeElement).toBe(button('Keep editing'));
    // A second Escape answers the question with Keep editing, as it does for a closing dialog.
    await pressEscape();
    expect(button('Discard')).toBeUndefined();
    expect(document.activeElement).toBe(field);
    expect(discard).not.toHaveBeenCalled();
    await pressEscape();
    await act(async () => button('Discard')!.click());
    await settle();
    expect(discard).toHaveBeenCalledOnce();
    // Discarding the part leaves the dialog itself open.
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(button('Discard')).toBeUndefined();
  });

  it('tells the handler whether the question is already showing', async () => {
    const seen: boolean[] = [];
    await render({
      dirty: true,
      onEscapeKeyDown: (_event, guard) => void seen.push(guard.asking),
    });
    await openFrom('opener');
    await pressEscape();
    await pressEscape();
    expect(seen).toEqual([false, true]);
  });

  it('drops the question when the unsaved input is gone', async () => {
    await render({ dirty: true });
    await openFrom('opener');
    await pressEscape();
    expect(button('Discard')).toBeDefined();
    await render({ dirty: false });
    expect(button('Discard')).toBeUndefined();
    expect(dialog()).not.toBeNull();
  });

  it('puts a sheet’s question inside its pinned heading, after Close, so Close is never covered', async () => {
    const question = () => button('Keep editing')!.closest('.modal-discard')!;
    const close = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!;
    await render({ dirty: true, sheet: true });
    await openFrom('opener');
    await pressEscape();
    const heading = dialog()!.querySelector('.modal-heading')!;
    expect(heading.contains(question())).toBe(true);
    // A question about unsaved input is a caution, not an error: it never wears the error style.
    expect(question().classList.contains('form-error')).toBe(false);
    // Shift+Tab from Keep editing reaches Close, which sits above the question, not under it.
    expect(close().compareDocumentPosition(question()) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await act(async () => button('Discard')!.click());
    await settle();
    expect(dialog()).toBeNull();
    // A dialog's heading scrolls with it, so there the question follows the heading instead.
    await render({ dirty: true });
    await openFrom('opener');
    await pressEscape();
    expect(dialog()!.querySelector('.modal-heading')!.contains(question())).toBe(false);
  });
});

describe('ModalCancel for one part of a dialog', () => {
  const partCancel = (onCancel: () => void, dirty: boolean) =>
    createElement(ModalCancel, { onCancel, dirty });
  it('cancels only that part, at once, when nothing was typed into it', async () => {
    const onClosed = vi.fn();
    const onCancel = vi.fn();
    await render({ onClosed, children: partCancel(onCancel, false) });
    await openFrom('opener');
    await act(async () => button('Cancel')!.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(button('Discard')).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('asks first when that part holds input, and Discard cancels only that part', async () => {
    const onClosed = vi.fn();
    const onCancel = vi.fn();
    await render({ dirty: true, onClosed, children: partCancel(onCancel, true) });
    await openFrom('opener');
    await act(async () => button('Cancel')!.click());
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Keep editing'));
    await act(async () => button('Discard')!.click());
    await settle();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });
});

describe('ModalCancel', () => {
  const cancel = () => createElement(ModalCancel);
  it('closes at once when nothing was typed', async () => {
    const onClosed = vi.fn();
    await render({ onClosed, children: cancel() });
    await openFrom('opener');
    await act(async () => button('Cancel')!.click());
    await settle();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
  });

  it('asks first when there is unsaved input, and Discard closes', async () => {
    const onClosed = vi.fn();
    await render({ dirty: true, onClosed, children: cancel() });
    await openFrom('opener');
    await act(async () => button('Cancel')!.click());
    expect(onClosed).not.toHaveBeenCalled();
    expect(button('Keep editing')).toBeDefined();
    await act(async () => button('Discard')!.click());
    await settle();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('puts focus back on Cancel after Keep editing', async () => {
    await render({ dirty: true, children: cancel() });
    await openFrom('opener');
    button('Cancel')!.focus();
    await act(async () => button('Cancel')!.click());
    await act(async () => button('Keep editing')!.click());
    expect(document.activeElement).toBe(button('Cancel'));
  });
});

describe('Modal announcement', () => {
  it('shows a dialog description and keeps a sheet’s description for assistive technology only', async () => {
    await render({ description: 'Set the terms.' });
    await openFrom('opener');
    const shown = [...document.querySelectorAll('[role="dialog"] p, [role="dialog"] div')].find(
      (element) => element.textContent === 'Set the terms.',
    )!;
    expect(shown.classList.contains('modal-description')).toBe(true);
    await pressEscape();
    await render({
      sheet: true,
      description: 'BET-12: Friday release. Pending, 3 rolls at stake.',
    });
    await openFrom('opener');
    const named = [...document.querySelectorAll('[role="dialog"] *')].find(
      (element) => element.textContent === 'BET-12: Friday release. Pending, 3 rolls at stake.',
    )!;
    expect(named.classList.contains('sr-only')).toBe(true);
    expect(named.classList.contains('modal-description')).toBe(false);
    expect(dialog()!.getAttribute('aria-describedby')).toBe(named.id);
  });
});

describe('dateLabel', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  it('keeps a date-only value on its own calendar day in every timezone', () => {
    // A legacy decision date has no time; reading it as local noon keeps its day from drifting.
    for (const timezone of [
      'Pacific/Kiritimati',
      'Pacific/Pago_Pago',
      'America/Los_Angeles',
      'UTC',
    ]) {
      process.env.TZ = timezone;
      expect(dateLabel('2026-10-10', { year: true })).toBe('Oct 10, 2026');
      expect(dateLabel('2026-01-01')).toBe('Jan 1');
    }
  });
  it('adds the year always when asked, or only for another year when given now', () => {
    const now = '2026-10-18T12:00:00.000Z';
    expect(dateLabel('2026-03-03', { year: true })).toBe('Mar 3, 2026');
    expect(dateLabel('2026-03-03', now)).toBe('Mar 3');
    expect(dateLabel('2025-06-15T12:00:00.000Z', now)).toBe('Jun 15, 2025');
    expect(dateLabel('2025-06-15T12:00:00.000Z', new Date(now))).toBe('Jun 15, 2025');
  });
});

describe('Avatar', () => {
  const alex = { id: 'alex', name: 'Alex', initials: 'AC', color: '#9a5f40' };
  const draw = async (props: Record<string, unknown>) => {
    await act(async () => root.render(createElement(Avatar, props)));
    return container.querySelector<HTMLElement>('.avatar')!;
  };
  /** jsdom reports inline colours as rgb(r, g, b). */
  const hex = (css: string) =>
    `#${(css.match(/\d+/g) ?? []).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

  it('is hidden from assistive technology when a name sits beside it', async () => {
    const avatar = await draw({ member: alex, decorative: true });
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.getAttribute('role')).toBeNull();
    expect(avatar.getAttribute('aria-label')).toBeNull();
    expect(avatar.getAttribute('title')).toBeNull();
  });

  it('is an image named for the member when it stands alone', async () => {
    const avatar = await draw({ member: alex });
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('Alex');
    expect(avatar.getAttribute('aria-hidden')).toBeNull();
  });

  it('is decorative when there is no member to name', async () => {
    const avatar = await draw({});
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.getAttribute('role')).toBeNull();
    expect(avatar.textContent).toBe('?');
  });

  it('draws white initials on a background that carries them at 4.5:1', async () => {
    const avatar = await draw({ member: alex });
    expect(hex(avatar.style.backgroundColor)).toBe('#9a5f40');
    expect(
      contrastRatio(hex(avatar.style.color), hex(avatar.style.backgroundColor)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens a stored mid-tone colour and picks the dark ink on a pale one', async () => {
    const mid = await draw({ member: { ...alex, color: '#a56848' } });
    expect(hex(mid.style.backgroundColor)).not.toBe('#a56848');
    expect(
      contrastRatio(hex(mid.style.color), hex(mid.style.backgroundColor)),
    ).toBeGreaterThanOrEqual(4.5);
    const pale = await draw({ member: { ...alex, color: '#e1e8db' } });
    expect(hex(pale.style.backgroundColor)).toBe('#e1e8db');
    expect(hex(pale.style.color)).toBe(DARK_INK);
  });

  it('never sets initials below 11px, however small the avatar', async () => {
    for (const size of [18, 22, 24, 26, 28, 32, 42, 52]) {
      const avatar = await draw({ member: alex, size });
      expect(Number.parseFloat(avatar.style.fontSize)).toBeGreaterThanOrEqual(11);
    }
  });
});
