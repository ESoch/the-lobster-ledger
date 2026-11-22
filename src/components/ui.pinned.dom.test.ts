// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './ui';

// A dialog pins parts of itself over its own scroll area: the sheet's heading (and the discard
// question) at the top, a form's footer at the bottom. The browser scrolls a focused control into
// view using the scroller's scroll padding, so the dialog keeps that padding as tall as the pinned
// parts plus room for the focus ring; otherwise a field reached with Tab lands behind the footer
// (WCAG 2.4.11 Focus Not Obscured). While focus is inside a pinned part, that side has no padding:
// the browser would otherwise scroll the dialog to bring the pinned control into a padded area it
// can never reach, and the form the reader was in jumps out of sight. The browser scrolls before
// the focus event, so that rule is the stylesheet's (`:has(… :focus)`), not Modal's.

let root: Root;
let container: HTMLDivElement;

// jsdom has no layout: an element reports the box written on it as data-box="left top width height".
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [x, y, width, height] = (this.getAttribute('data-box') ?? '0 0 0 0')
      .split(' ')
      .map(Number);
    return DOMRect.fromRect({ x, y, width, height });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('.toast-region').forEach((node) => node.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ sheet = false, dirty = false }: { sheet?: boolean; dirty?: boolean }) {
  const [open, setOpen] = useState(false);
  const form: ReactNode = createElement(
    'form',
    { className: 'bet-form' },
    createElement('input', { 'aria-label': 'Title', autoFocus: true }),
    createElement('input', { 'aria-label': 'Last field' }),
    createElement(
      'div',
      { className: 'modal-footer', 'data-box': '0 700 520 120' },
      createElement('button', { type: 'button' }, 'Cancel'),
      createElement('button', { type: 'submit' }, 'Propose bet'),
    ),
  );
  return createElement(
    'div',
    null,
    createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open it'),
    createElement(Modal, {
      open,
      onClose: () => setOpen(false),
      title: 'Put it on the record.',
      sheet,
      dirty,
      children: form,
    }),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const field = (label: string) =>
  dialog().querySelector<HTMLElement>(`input[aria-label="${label}"]`)!;
const button = (text: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;
const measured = () => ({
  top: dialog().style.getPropertyValue('--pinned-top'),
  bottom: dialog().style.getPropertyValue('--pinned-bottom'),
});
// The rules in styles.css that take a side's scroll padding away, by the selector they match.
const zeroRules = (side: 'top' | 'bottom') => {
  const selectors: string[] = [];
  postcss.parse(readFileSync('src/styles.css', 'utf8')).walkRules((rule) => {
    if (rule.parent?.type !== 'root') return;
    rule.walkDecls(`scroll-padding-${side}`, (decl) => {
      if (/^0(px)?$/.test(decl.value)) selectors.push(...rule.selectors);
    });
  });
  return selectors;
};
/** The dialog's scroll padding as the browser resolves it: the stylesheet's zero, or Modal's measure. */
const pinned = () => {
  const zeroed = (side: 'top' | 'bottom') =>
    zeroRules(side).some((selector) => dialog().matches(selector));
  return {
    top: zeroed('top') ? '0px' : measured().top,
    bottom: zeroed('bottom') ? '0px' : measured().bottom,
  };
};
async function open(props: { sheet?: boolean; dirty?: boolean } = {}) {
  await act(async () => root.render(createElement(Harness, props)));
  const opener = document.getElementById('opener')!;
  opener.focus();
  await act(async () => opener.click());
  await settle();
}
const focus = (element: HTMLElement) => act(async () => element.focus());
/** A toast in its region outside the dialog, at the given box. */
function notification(box: string) {
  const region = document.createElement('div');
  region.className = 'toast-region';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('data-box', box);
  region.appendChild(toast);
  document.body.appendChild(region);
  return toast;
}

describe('Modal keeps the focused control clear of what it pins', () => {
  // The focus ring is a 3px outline offset by 3px; the padding leaves 12px past a pinned part.
  it('pads the bottom by the footer’s height and room for the ring when a field takes focus', async () => {
    await open();
    await focus(field('Last field'));
    expect(pinned().bottom).toBe('132px');
    expect(pinned().top).toBe('12px');
  });

  it('measures the footer again as focus moves, since an error or question makes it taller', async () => {
    await open();
    await focus(field('Last field'));
    dialog().querySelector('.modal-footer')!.setAttribute('data-box', '0 600 520 296');
    await focus(field('Title'));
    expect(pinned().bottom).toBe('308px');
  });

  it('pads nothing at the bottom while focus is on the footer’s own buttons, so the dialog does not jump', async () => {
    await open();
    await focus(field('Last field'));
    await focus(button('Propose bet'));
    expect(pinned().bottom).toBe('0px');
    expect(pinned().top).toBe('12px');
    expect(measured().bottom).toBe('132px');
  });

  it('pads the top by the bet sheet’s pinned heading, and not at all while Close has focus', async () => {
    await open({ sheet: true });
    dialog().querySelector('.modal-heading')!.setAttribute('data-box', '0 0 590 96');
    await focus(field('Last field'));
    expect(pinned()).toEqual({ top: '108px', bottom: '132px' });
    // Close is pinned in view already. Any top padding would send the sheet towards its top as
    // Close takes focus, taking the open form, and its pinned footer, out of sight.
    await focus(dialog().querySelector<HTMLElement>('button[aria-label="Close dialog"]')!);
    expect(pinned()).toEqual({ top: '0px', bottom: '132px' });
    // Modal still measures the heading then: the browser scrolls the next field into view before
    // Modal hears of it, using the padding last measured.
    expect(measured().top).toBe('108px');
    await focus(field('Title'));
    expect(pinned().top).toBe('108px');
  });

  it('does not reserve a dialog’s heading, which scrolls away with the form', async () => {
    await open();
    dialog().querySelector('.modal-heading')!.setAttribute('data-box', '0 0 520 96');
    await focus(field('Last field'));
    expect(pinned().top).toBe('12px');
  });

  it('reserves the discard question where it is pinned: below the dialog’s own padding', async () => {
    await open({ dirty: true });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await settle();
    // A pinned element stops at the scroller's padding (26px here), not at its edge.
    dialog().style.paddingTop = '26px';
    const question = dialog().querySelector<HTMLElement>('.modal-discard')!;
    question.setAttribute('data-box', '26 120 468 110');
    question.style.top = '0px';
    await focus(field('Title'));
    expect(pinned().top).toBe('148px');
    // Its own buttons are in view where it is pinned.
    await focus(button('Discard'));
    expect(pinned().top).toBe('0px');
  });

  it('counts a notification lying over the foot of the dialog as pinned there too', async () => {
    await open();
    dialog().setAttribute('data-box', '0 0 520 900');
    const toast = notification('12 700 366 150');
    await focus(field('Last field'));
    expect(pinned().bottom).toBe('212px');
    // Moved to the top of a phone screen, it is room at the top instead.
    toast.setAttribute('data-box', '12 12 366 80');
    await focus(field('Title'));
    expect(pinned()).toEqual({ top: '104px', bottom: '132px' });
  });

  it('ignores a notification beside the dialog', async () => {
    await open();
    dialog().setAttribute('data-box', '850 0 590 900');
    notification('248 820 420 64');
    await focus(field('Last field'));
    expect(pinned().bottom).toBe('132px');
  });
});

describe('Modal shows a control reached with Tab', () => {
  // The focus trap wraps from the last control to Close without scrolling, and the browser shows
  // only the caret line of a text box, so a control reached with Tab can still be out of sight.
  let scrolled: Element[];
  const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    if (native) Object.defineProperty(Element.prototype, 'scrollIntoView', native);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  async function tabFrom(element: HTMLElement, shiftKey = false) {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
      );
    });
  }
  const close = () => dialog().querySelector<HTMLElement>('button[aria-label="Close dialog"]')!;

  it('brings Close into view when Tab wraps round to it from the last button', async () => {
    await open();
    dialog().setAttribute('data-box', '0 0 520 900');
    close().setAttribute('data-box', '470 -400 44 44');
    const last = button('Propose bet');
    await focus(last);
    scrolled = [];
    await tabFrom(last);
    expect(document.activeElement).toBe(close());
    expect(scrolled).toEqual([close()]);
  });

  it('brings a text box in whole when Tab reaches it half behind the footer', async () => {
    await open();
    dialog().setAttribute('data-box', '0 0 520 900');
    const box = field('Last field');
    box.setAttribute('data-box', '26 740 468 120');
    scrolled = [];
    await act(async () => {
      field('Title').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      box.focus();
    });
    expect(scrolled).toEqual([box]);
  });

  it('brings a footer button into view when Shift+Tab wraps round to it and the footer is out of sight', async () => {
    // Once its form has scrolled away a footer is no longer pinned in view, and the wrap from Close
    // to the last button does not scroll.
    await open({ sheet: true });
    dialog().setAttribute('data-box', '0 0 590 844');
    dialog().querySelector('.modal-footer')!.setAttribute('data-box', '0 1000 590 120');
    const last = button('Propose bet');
    last.setAttribute('data-box', '400 1040 120 44');
    await focus(close());
    scrolled = [];
    await tabFrom(close(), true);
    expect(document.activeElement).toBe(last);
    expect(scrolled).toEqual([last]);
  });

  it('brings in a footer button cut off at the dialog’s edge', async () => {
    await open();
    dialog().setAttribute('data-box', '0 0 520 640');
    const last = button('Propose bet');
    last.setAttribute('data-box', '400 620 120 44');
    await focus(close());
    scrolled = [];
    await tabFrom(close(), true);
    expect(document.activeElement).toBe(last);
    expect(scrolled).toEqual([last]);
  });

  it('leaves a control already in view, one in the pinned footer, and focus that did not come from Tab', async () => {
    await open();
    dialog().setAttribute('data-box', '0 0 520 900');
    field('Last field').setAttribute('data-box', '26 300 468 46');
    scrolled = [];
    await act(async () => {
      field('Title').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      field('Last field').focus();
    });
    await act(async () => {
      field('Last field').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      button('Cancel').focus();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    field('Title').setAttribute('data-box', '26 -400 468 46');
    await focus(field('Title'));
    expect(scrolled).toEqual([]);
  });
});

describe('dialog scroll padding (styles.css)', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  const declarations = (selector: string) => {
    const found = new Map<string, string>();
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
      rule.walkDecls((decl) => void found.set(decl.prop, decl.value));
    });
    return found;
  };

  it('takes the dialog scroller’s padding from Modal’s measure, with room for the ring until then', () => {
    // Modal writes the whole padding on each side (the pinned parts plus room for the ring, or none
    // while focus is inside a pinned part on that side), so CSS adds nothing to it.
    const content = declarations('.modal-content');
    const top = /^var\(--pinned-top, (\d+)px\)$/.exec(content.get('scroll-padding-top') ?? '');
    const bottom = /^var\(--pinned-bottom, (\d+)px\)$/.exec(
      content.get('scroll-padding-bottom') ?? '',
    );
    expect(top, '.modal-content scroll-padding-top').not.toBeNull();
    expect(bottom, '.modal-content scroll-padding-bottom').not.toBeNull();
    // The ring is a 3px outline offset by 3px, so the focused control needs 6px clear of the edge.
    expect(Number(top![1])).toBeGreaterThanOrEqual(6);
    expect(Number(bottom![1])).toBeGreaterThanOrEqual(6);
  });

  it('drops the padding on a side whose pinned part has focus, outranking the measure', () => {
    // The browser scrolls a newly focused control before the focus event reaches Modal, so only a
    // selector can take the padding away in time.
    for (const side of ['top', 'bottom'] as const) {
      const selectors = zeroRules(side);
      expect(selectors.length, side).toBeGreaterThan(0);
      for (const selector of selectors)
        expect(selector).toMatch(/^\.(modal-content|detail-sheet):has\(.+ :focus\)$/);
    }
  });

  it('applies to the bet sheet, which is the same scroller', () => {
    const sheet = declarations('.detail-sheet');
    expect(sheet.has('scroll-padding-top')).toBe(false);
    expect(sheet.has('scroll-padding-bottom')).toBe(false);
    expect(sheet.has('scroll-padding')).toBe(false);
  });
});
