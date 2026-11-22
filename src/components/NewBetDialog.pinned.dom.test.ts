// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { NewBetDialog } from './NewBetDialog';

// A refused history import lists the boxes still to tick in the pinned footer, which on a 320x640
// phone makes it 296px tall. The refused field is scrolled into view only after the dialog has
// reserved that height, so the field and the message under it land above the footer, not behind it.

const FOOTER = 296;
let root: Root;
let container: HTMLDivElement;
let scrolls: { element: Element; reserved: string }[];
const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height = this.classList.contains('modal-footer') ? FOOTER : 0;
    return DOMRect.fromRect({ x: 0, y: 0, width: 300, height });
  });
  scrolls = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    const dialog = this.closest<HTMLElement>('[role="dialog"]');
    scrolls.push({
      element: this,
      reserved: dialog?.style.getPropertyValue('--pinned-bottom') ?? '',
    });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const state = createDemoState();
const ellis = state.members.find((member) => member.name === 'Ellis')!;
const sarah = state.members.find((member) => member.name === 'Sarah')!;
const dialog = () => document.querySelector('[role="dialog"]')!;
const field = <T = HTMLInputElement>(name: string) =>
  dialog().querySelector(`[name="${name}"]`) as unknown as T;
function setValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
}
const put = (name: string, value: string) =>
  act(async () => setValue(field<HTMLInputElement>(name), value));

describe('a refused history import on a short phone', () => {
  it('reserves the tall footer before scrolling the refused field into view', async () => {
    await act(async () =>
      root.render(
        createElement(NewBetDialog, {
          open: true,
          onClose: () => {},
          state,
          memberId: ellis.id,
          onCreate: vi.fn(async () => {}),
          mode: 'history',
        }),
      ),
    );
    await put('history.stage', 'owed');
    await put('title', 'The kitchen kettle lasts until spring');
    await put('opponentId', sarah.id);
    await put('creatorSide', 'It lasts past March');
    await put('opponentSide', 'It breaks before March');
    await put('terms', 'The kettle must still boil water on the first day of spring.');
    await put('history.winnerId', ellis.id);
    await put('history.resultNote', 'It boiled water on March 20.');
    await put('history.originalDate.precision', 'day');
    await put('history.originalDate.value', '2099-01-01');
    // The confirmation boxes stay unticked, so the footer lists them under the buttons' row.
    scrolls = [];
    await act(async () => dialog().querySelector('form')!.requestSubmit());
    const refused = field('history.originalDate.value');
    expect(document.activeElement).toBe(refused);
    expect(dialog().querySelector('.modal-footer .field-error-list')).not.toBeNull();
    const scroll = scrolls.find((entry) => entry.element === refused);
    expect(scroll, 'the refused field is scrolled into view').toBeDefined();
    // The footer and room for the focus ring below the field.
    expect(scroll!.reserved).toBe(`${FOOTER + 12}px`);
  });
});
