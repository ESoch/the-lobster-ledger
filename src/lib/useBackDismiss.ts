import { useEffect, useRef } from 'react';

const MARK = 'lobsterLedgerSheet';

/**
 * Gives an open sheet its own browser history entry, so the Back button (the only way out on many
 * phones) closes the sheet instead of leaving the page behind it. Closing the sheet any other way
 * takes its entry off again, so the history never fills with entries that do nothing.
 *
 * A sheet holding unsaved input is not closed by Back, or by a typed #hash or link (the browser
 * reports those the same way, before their hashchange). `guard` (the Modal's LeaveRequest) runs
 * `leave` and returns true, or keeps the sheet open, asks first and returns false. The sheet's entry
 * then goes back on at the address it was opened at, so the bar matches the page behind it and the
 * next Back asks again; Discard runs `leave` and goes on to where Back or the address was going.
 *
 * Leaving the sheet by a typed #hash or a link strands its entry in the history, where it shows the
 * page the sheet was opened on and nothing new. Back that lands on such an entry steps past it, so
 * one press still goes where the member expects.
 *
 * An address that was asked about and turned down leaves nothing behind: the sheet's entry goes
 * back on in the place of the entry the address made, so Back never lands on a page the member
 * declined to visit. Discard, which does go on to that address, takes it from there.
 */
export function useBackDismiss(
  open: boolean,
  dismiss: () => void,
  guard?: { readonly current: ((leave: () => void) => boolean) | null },
) {
  const pushed = useRef(false);
  const latest = useRef(dismiss);
  latest.current = dismiss;
  // The address the sheet's entry was pushed at: Back returns to it, a typed #hash or link does not.
  const pushedAt = useRef('');
  // Sheet entries left behind in history, which Back may land on without being asked to.
  const stranded = useRef(0);
  // The sheet's entry went back on above a typed address (or a page Back jumped to): closing the
  // sheet stays on its page then, rather than stepping back onto that address.
  const over = useRef(false);
  // Discard answered a held Back or address, so closing the sheet goes on to it.
  const proceed = useRef(false);
  // The typed address or link the sheet's entry replaced, which Discard goes on to ('' for a held Back).
  const heldTo = useRef('');
  // The history length once the sheet's entry was last put on: a typed address or link makes it grow,
  // a Back to an older entry does not.
  const lengthAtPush = useRef(0);

  useEffect(() => {
    if (open && !pushed.current) {
      window.history.pushState({ [MARK]: true }, '');
      pushed.current = true;
      pushedAt.current = window.location.href;
      lengthAtPush.current = window.history.length;
      over.current = false;
      proceed.current = false;
      heldTo.current = '';
    } else if (!open && pushed.current) {
      pushed.current = false;
      // Only step back if the sheet's entry is still the current one. After a typed #hash or a link,
      // the user is already somewhere else and going back would undo that.
      if (!window.history.state?.[MARK]) stranded.current += 1;
      else if (proceed.current && heldTo.current) window.location.replace(heldTo.current);
      else if (over.current && !proceed.current) window.history.replaceState(null, '');
      else window.history.back();
    }
  }, [open]);

  useEffect(() => {
    const onPop = () => {
      if (pushed.current) {
        pushed.current = false;
        const to = window.location.href;
        // Back returns to the address the sheet was opened at; anywhere else, the entry stays behind.
        const away = to !== pushedAt.current;
        let held = false;
        const leave = () => {
          if (held) proceed.current = true;
          latest.current();
        };
        const request = guard?.current;
        if (request && !request(leave)) {
          held = true;
          pushed.current = true;
          // The sheet stays open, so its entry goes back on, at the address it was opened at. The
          // page's hashchange, which follows, then finds the page unchanged.
          if (away && window.history.length > lengthAtPush.current) {
            // A typed address or link made a new entry above the sheet's old one. The sheet's entry
            // takes its place, so Back never lands on a page the member turned down. `over` keeps
            // what an earlier refused jump set: the entry below is still that older page. (The
            // length stops growing once the browser's session history is full, about 50 entries;
            // a refused address then falls through to the push below and leaves its entry behind.)
            window.history.replaceState({ [MARK]: true }, '', pushedAt.current);
            lengthAtPush.current = window.history.length;
            heldTo.current = to;
            stranded.current += 1;
          } else {
            window.history.pushState({ [MARK]: true }, '', pushedAt.current);
            heldTo.current = '';
            lengthAtPush.current = window.history.length;
            if (away) {
              over.current = true;
              stranded.current += 1;
            }
          }
          return;
        }
        if (!request) latest.current();
        if (away) stranded.current += 1;
      } else if (stranded.current > 0 && window.history.state?.[MARK]) {
        stranded.current -= 1;
        window.history.back();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [guard]);
}
