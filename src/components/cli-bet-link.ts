const BET_LINK_STORAGE = 'lobster-ledger-bet-link';
const BET_LINK_LIFETIME = 30 * 60 * 1000;
const BET_LINK_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
/** What a visitor is told when the link they followed names no bet at all (a broken or cut-off copy). */
export const BET_LINK_INVALID_MESSAGE =
  'That bet link isn’t valid, so there is nothing to open. Ask whoever sent it for a new one.';
type LinkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function restoreBetLink(
  supplied: string | null,
  storage: LinkStorage,
  now = Date.now(),
): string | undefined {
  try {
    if (supplied !== null) {
      storage.removeItem(BET_LINK_STORAGE);
      if (!BET_LINK_PATTERN.test(supplied)) return;
      storage.setItem(BET_LINK_STORAGE, JSON.stringify({ betId: supplied, createdAt: now }));
      return supplied;
    }
    const saved = storage.getItem(BET_LINK_STORAGE);
    if (!saved || saved.length > 200) return;
    const { betId, createdAt } = JSON.parse(saved) as { betId: unknown; createdAt: unknown };
    if (
      typeof betId === 'string' &&
      BET_LINK_PATTERN.test(betId) &&
      typeof createdAt === 'number' &&
      Number.isFinite(createdAt) &&
      now >= createdAt &&
      now - createdAt < BET_LINK_LIFETIME
    )
      return betId;
    storage.removeItem(BET_LINK_STORAGE);
  } catch {
    // A valid direct link still opens when session storage is unavailable.
    if (supplied && BET_LINK_PATTERN.test(supplied)) return supplied;
  }
}

/** The bet a link names: it carries either the record id or the LL-#### reference, in any case. */
export function findLinkedBet<T extends { id: string; reference: string }>(
  bets: T[],
  linked: string,
): T | undefined {
  const reference = linked.toUpperCase();
  return (
    bets.find((bet) => bet.id === linked) ??
    bets.find((bet) => bet.reference.toUpperCase() === reference)
  );
}

function withoutBetParam(hash?: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete('bet');
  if (hash) url.hash = hash;
  window.history.replaceState(null, '', url);
}

export interface BetLinkCapture {
  /** The bet the link names, from the address bar or saved before sign-in. */
  betId?: string;
  /** The address bar carried a ?bet= that names nothing, so the page can say so instead of nothing. */
  invalid: boolean;
}

/**
 * Reads ?bet= from the address bar and saves it for the sign-in round trip. Once it is saved the
 * parameter leaves the address bar, so a reload does not reopen the sheet each time. If the link
 * cannot be saved it stays in the address bar, the only place a reload could still find it.
 * The demo reads only a link it built itself (a new tab on a bet reference keeps ?demo=1), and
 * never saves one or takes one that was saved: a link waiting for the real ledger must survive a
 * detour through the demo untouched. A ?bet= that was thrown away because it was malformed is
 * reported too, so the page can say so instead of saying nothing.
 */
export function captureBetLinkAttempt(demo = false): BetLinkCapture {
  const supplied = new URL(window.location.href).searchParams.get('bet');
  if (demo) {
    if (supplied === null) return { invalid: false };
    withoutBetParam();
    const valid = BET_LINK_PATTERN.test(supplied);
    return { betId: valid ? supplied : undefined, invalid: !valid };
  }
  let betId: string | undefined;
  try {
    betId = restoreBetLink(supplied, window.sessionStorage);
  } catch {
    betId = supplied && BET_LINK_PATTERN.test(supplied) ? supplied : undefined;
  }
  // A malformed value is dropped too; one that could not be saved stays where a reload finds it.
  if (supplied !== null && (!betId || isSaved())) withoutBetParam();
  return { betId, invalid: supplied !== null && !BET_LINK_PATTERN.test(supplied) };
}

function isSaved() {
  try {
    return window.sessionStorage.getItem(BET_LINK_STORAGE) !== null;
  } catch {
    return false;
  }
}

/**
 * The link has done its job: forget it and leave the address bar on the ledger. The demo never saved
 * one, so it leaves the saved copy, which belongs to the real ledger, alone.
 */
export function consumeBetLink(demo = false) {
  if (!demo) clearBetLink();
  withoutBetParam('ledger');
}

function clearBetLink() {
  try {
    window.sessionStorage.removeItem(BET_LINK_STORAGE);
  } catch {
    // The link is also consumed in memory.
  }
}
