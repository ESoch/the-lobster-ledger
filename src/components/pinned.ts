// What a dialog pins over its own scroll area: the bet sheet's heading (which holds the discard
// question there) or a dialog's discard question at the top, and a form's footer at the bottom.
const PINNED_TOP = '.detail-sheet > .modal-heading, .modal-content > .modal-discard';
const PINNED_BOTTOM = '.modal-footer';
// Whether the focus now arriving came with Tab: set as the key goes down, cleared once the browser
// (or the focus trap) has moved focus for it.
let tabbing = false;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Tab') return;
      tabbing = true;
      setTimeout(() => (tabbing = false));
    },
    true,
  );
}

/** Room past a pinned part for the focus ring (a 3px outline offset by 3px) and a little air. */
const RING = 12;

/**
 * Keeps a focused control clear of what is pinned over a dialog's scroll area (WCAG 2.4.11 Focus Not
 * Obscured). Run as focus arrives: the room the pinned parts take, and a notification lying over
 * either end, plus room for the ring, become `--pinned-top` and `--pinned-bottom` on the scroller,
 * its scroll padding (styles.css). They are measured every time because a footer grows when it
 * holds an error or the discard question. The browser scrolls a control into view before the focus
 * event, so its own scroll uses what was measured for the control before; whatever moves focus and
 * then scrolls (a refused submit, a form opening in the sheet) gets this control's measure.
 *
 * A side whose pinned part holds the focus has no padding (the stylesheet's `:has(… :focus)`, which
 * applies in time for the browser's scroll). That control is in view already, and a padded edge it
 * can never leave makes the browser scroll the dialog towards it: Shift+Tab to the sheet's Close
 * would send an open form, and its pinned footer, out of sight.
 *
 * Focus that arrives with Tab can still be out of sight: the focus trap's wrap-around moves it
 * without scrolling (to Close, or to a footer whose form has scrolled away and so is not pinned in
 * view), and the browser shows only the caret line of a text box. Such a control is brought into
 * the clear part whole, when it fits there.
 */
export function clearPinnedParts(scroller: HTMLElement, focused: EventTarget | null) {
  const target = focused instanceof Element ? focused : null;
  const style = getComputedStyle(scroller);
  const px = (value: string) => parseFloat(value) || 0;
  // A pinned part stops at the scroller's padding, moved by its own inset, so this much of that end
  // of the scroll area is under it once it is pinned, wherever it sits now.
  const pinned = (selector: string, side: 'top' | 'bottom') => {
    let room = 0;
    let holdsFocus = false;
    for (const part of scroller.querySelectorAll(selector)) {
      if (target && part.contains(target)) holdsFocus = true;
      const height = part.getBoundingClientRect().height;
      if (!height) continue;
      const inset = px(getComputedStyle(part).getPropertyValue(side));
      room = Math.max(room, px(style.getPropertyValue(`padding-${side}`)) + inset + height);
    }
    return { room, holdsFocus };
  };
  const top = pinned(PINNED_TOP, 'top');
  const bottom = pinned(PINNED_BOTTOM, 'bottom');
  // The notification is fixed to the window, outside the dialog: only the part over it counts.
  const box = scroller.getBoundingClientRect();
  const toast = document.querySelector('.toast-region .toast')?.getBoundingClientRect();
  if (
    toast &&
    toast.height > 0 &&
    toast.left < box.right &&
    toast.right > box.left &&
    toast.top < box.bottom &&
    toast.bottom > box.top
  ) {
    if (toast.top + toast.height / 2 > box.top + box.height / 2)
      bottom.room = Math.max(bottom.room, box.bottom - toast.top);
    else top.room = Math.max(top.room, toast.bottom - box.top);
  }
  const padTop = Math.ceil(top.room) + RING;
  const padBottom = Math.ceil(bottom.room) + RING;
  scroller.style.setProperty('--pinned-top', `${padTop}px`);
  scroller.style.setProperty('--pinned-bottom', `${padBottom}px`);

  if (!tabbing || !target || target === scroller) return;
  // A control in a pinned part only has to be inside the dialog; any other, inside the padding.
  const inPinned = top.holdsFocus || bottom.holdsFocus;
  const from = box.top + (inPinned ? 0 : padTop);
  const to = box.bottom - (inPinned ? 0 : padBottom);
  const rect = target.getBoundingClientRect();
  if ((rect.top < from || rect.bottom > to) && rect.height <= to - from)
    target.scrollIntoView?.({ block: 'nearest' });
}
