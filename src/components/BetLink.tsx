import type { MouseEvent, ReactNode } from 'react';

/**
 * Where a bet opens when its link is followed in a new tab. It keeps this page's query, so a demo
 * link (?demo=1) stays in the demo instead of landing on the signed-out welcome.
 */
export function betHref(betId: string, current: string = window.location.href) {
  const url = new URL(current);
  url.searchParams.set('bet', betId);
  url.hash = 'ledger';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A reference to another bet. A plain click opens its sheet in place; new-tab clicks keep working. */
export function BetLink({
  betId,
  onOpen,
  children,
}: {
  betId: string;
  onOpen?: (betId: string) => void;
  children: ReactNode;
}) {
  return (
    <a
      className="link-button"
      href={betHref(betId)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        // Anything but a plain left click (new tab, new window, download) stays with the browser.
        const plain =
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey;
        if (!onOpen || !plain) return;
        event.preventDefault();
        onOpen(betId);
      }}
    >
      {children}
    </a>
  );
}
