// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureBetLinkAttempt,
  consumeBetLink,
  findLinkedBet,
  restoreBetLink,
} from './cli-bet-link';

const captureBetLink = (demo = false) => captureBetLinkAttempt(demo).betId;

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('CLI bet links', () => {
  it('preserves a valid bet link through login with bounded expiry', () => {
    const saved = storage();
    expect(restoreBetLink('LL-1234', saved, 1000)).toBe('LL-1234');
    expect(restoreBetLink(null, saved, 2000)).toBe('LL-1234');
    expect(restoreBetLink(null, saved, 1000 + 30 * 60 * 1000)).toBeUndefined();
  });
  it('does not let malformed incoming links restore an older bet', () => {
    const saved = storage();
    restoreBetLink('LL-1234', saved, 1000);
    expect(restoreBetLink('https://elsewhere.example', saved, 2000)).toBeUndefined();
    expect(restoreBetLink(null, saved, 2000)).toBeUndefined();
  });
  it('accepts a reference such as LL-1042 as a link, and finds the bet it names', () => {
    const saved = storage();
    expect(restoreBetLink('LL-1042', saved, 1000)).toBe('LL-1042');
    const bets = [
      { id: '6f1d6c0e-1c1e-4a39-8f0d-0a8f6d8f4b11', reference: 'LL-1033' },
      { id: '0b7d3b1e-7d9c-4c06-9a3c-2f8b1c7a52e0', reference: 'LL-1042' },
    ];
    expect(findLinkedBet(bets, 'LL-1042')).toBe(bets[1]);
    expect(findLinkedBet(bets, 'll-1042')).toBe(bets[1]);
    expect(findLinkedBet(bets, bets[0].id)).toBe(bets[0]);
    expect(findLinkedBet(bets, 'LL-9999')).toBeUndefined();
  });
});

describe('capturing a bet link from the address bar', () => {
  const STORAGE_KEY = 'lobster-ledger-bet-link';
  const at = (url: string) => window.history.replaceState(null, '', url);

  beforeEach(() => {
    window.sessionStorage.clear();
    at('/');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes ?bet= out of the address bar at once but keeps it for after sign-in', () => {
    at('/?bet=abc123_DEF-456#ledger');
    expect(captureBetLink()).toBe('abc123_DEF-456');
    // A reload now lands on the ordinary page instead of reopening the sheet every time.
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#ledger');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain('abc123_DEF-456');
    // After the sign-in redirect the address bar has no link, but the saved one is still there.
    expect(captureBetLink()).toBe('abc123_DEF-456');
  });

  it('keeps the other query parameters when it removes the link', () => {
    at('/?bet=LL-1042&demoSession=other#ledger');
    captureBetLink();
    expect(window.location.search).toBe('?demoSession=other');
  });

  it('reads a demo link for the demo alone: the link saved for the real ledger stays saved', () => {
    // A real link was captured before this visitor opened the demo in the same tab.
    at('/?bet=real-bet-id');
    expect(captureBetLink()).toBe('real-bet-id');
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    // A link built by the demo itself (a new tab on a bet reference) names a bet in the demo.
    at('/?demo=1&demoSession=abc&bet=sample#ledger');
    expect(captureBetLinkAttempt(true)).toEqual({ betId: 'sample', invalid: false });
    // The parameter leaves the address bar so a reload does not reopen the sheet, and the demo
    // stays in its own session; nothing was saved and nothing saved was taken.
    expect(window.location.search).toBe('?demo=1&demoSession=abc');
    expect(window.location.hash).toBe('#ledger');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(saved);
    // The demo does not take the saved real link as its own either.
    at('/?demo=1');
    expect(captureBetLinkAttempt(true)).toEqual({ invalid: false });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(saved);
    // Back on the real welcome page the waiting link is found again.
    at('/');
    expect(captureBetLink()).toBe('real-bet-id');
  });

  it('leaves the link in the address bar when it cannot be saved, so a reload still finds it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    at('/?bet=abc123#ledger');
    expect(captureBetLink()).toBe('abc123');
    expect(window.location.search).toBe('?bet=abc123');
  });

  it('ignores a malformed link and drops an older saved one', () => {
    at('/?bet=abc123');
    captureBetLink();
    at('/?bet=bad%20id');
    expect(captureBetLink()).toBeUndefined();
    at('/');
    expect(captureBetLink()).toBeUndefined();
  });

  it('says a malformed link is invalid, so the page can tell the visitor, and still drops it', () => {
    at('/?bet=bad%20id#overview');
    expect(captureBetLinkAttempt()).toEqual({ betId: undefined, invalid: true });
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#overview');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    // An empty ?bet= names nothing either.
    at('/?bet=');
    expect(captureBetLinkAttempt()).toEqual({ betId: undefined, invalid: true });
  });

  it('is not invalid for a good link, a saved link or no link at all', () => {
    at('/?bet=LL-1042');
    expect(captureBetLinkAttempt()).toEqual({ betId: 'LL-1042', invalid: false });
    at('/');
    expect(captureBetLinkAttempt()).toEqual({ betId: 'LL-1042', invalid: false });
    consumeBetLink();
    at('/');
    expect(captureBetLinkAttempt()).toEqual({ betId: undefined, invalid: false });
  });

  it('says a malformed demo link is invalid and drops it, saving nothing', () => {
    at('/?demo=1&bet=bad%20id');
    expect(captureBetLinkAttempt(true)).toEqual({ betId: undefined, invalid: true });
    expect(window.location.search).toBe('?demo=1');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('forgets the saved link and the address-bar link once the bet has been opened', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    at('/?bet=abc123#overview');
    captureBetLink();
    expect(window.location.search).toBe('?bet=abc123');
    consumeBetLink();
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#ledger');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    at('/');
    expect(captureBetLink()).toBeUndefined();
  });

  it('consumes a demo link without touching the link saved for the real ledger', () => {
    at('/?bet=real-bet-id');
    captureBetLink();
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    at('/?demo=1&bet=sample#overview');
    captureBetLinkAttempt(true);
    consumeBetLink(true);
    expect(window.location.search).toBe('?demo=1');
    expect(window.location.hash).toBe('#ledger');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(saved);
  });
});
