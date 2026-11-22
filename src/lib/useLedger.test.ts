// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLedger } from './useLedger';
import { createDemoState } from './demo';
import { DuplicatePriceError, UnusualPriceError } from './price-observations';
import { LIMITS } from './limits';

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useLedger>;

function Probe() {
  latest = useLedger();
  return null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const ledger = createDemoState();
const sarah = ledger.members[1];

/** Answers each endpoint from a table; a function entry is called for every request. */
function routes(table: Record<string, () => Response | Promise<Response>>) {
  const fetchStub = vi.fn(async (path: string) => {
    const answer = table[path];
    if (!answer) throw new Error(`Unexpected request: ${path}`);
    return answer();
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}
const configured = () => json(200, { configured: true, groupName: 'The Lobster Ledger' });
const unconfigured = () => json(200, { configured: false, groupName: 'The Lobster Ledger' });
const signedIn = () => json(200, { member: sarah });
const signedOut = () => json(401, { error: 'Sign in to your private ledger.' });

async function mount() {
  await act(async () => root.render(createElement(Probe)));
  // Let the load chain (config, session, ledger) run to its end.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('opening the shared ledger', () => {
  it('reports a config request that fails as unreachable, not as sign-in being unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await mount();
    expect(latest.configStatus).toBe('unreachable');
    // Sign-in may well be set up; a failed request says nothing about it.
    expect(latest.configured).not.toBe(false);
    expect(latest.loading).toBe(false);
    expect(latest.loadFailed).toBe(true);
    expect(latest.error).toBe('');
  });

  it('treats a 401 session as the normal signed-out state, with no error string', async () => {
    routes({ '/api/config': configured, '/api/session': signedOut });
    await mount();
    expect(latest.configStatus).toBe('ready');
    expect(latest.member).toBeUndefined();
    expect(latest.state).toBeNull();
    expect(latest.error).toBe('');
    expect(latest.loadFailed).toBe(false);
    expect(latest.loading).toBe(false);
  });

  it('keeps a signed-in member and flags the failure when the ledger returns a 500', async () => {
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => json(500, { error: 'Unable to complete the request (500).' }),
    });
    await mount();
    expect(latest.member).toMatchObject({ id: sarah.id, name: sarah.name });
    expect(latest.memberId).toBe(sarah.id);
    expect(latest.state).toBeNull();
    expect(latest.loadFailed).toBe(true);
    // The raw server text never reaches the screen through this field.
    expect(latest.error).toBe('');
  });

  it('does not treat a session member the opened ledger has never heard of as signed in', async () => {
    routes({
      '/api/config': configured,
      '/api/session': () => json(200, { member: { ...sarah, id: 'not-on-the-roster' } }),
      '/api/ledger': () => json(200, ledger),
    });
    await mount();
    expect(latest.state?.members.length).toBeGreaterThan(0);
    // The session's word counts only until the roster can be checked against it.
    expect(latest.member).toBeUndefined();
  });

  it('treats a session request that fails to arrive as a failure to retry, not as signed out', async () => {
    routes({
      '/api/config': configured,
      '/api/session': () => json(502, {}),
    });
    await mount();
    expect(latest.loadFailed).toBe(true);
    expect(latest.configStatus).toBe('ready');
    expect(latest.member).toBeUndefined();
  });

  it('treats an answer that is not a config at all as unreachable, not as unconfigured', async () => {
    routes({ '/api/config': () => new Response('<!doctype html>', { status: 200 }) });
    await mount();
    expect(latest.configStatus).toBe('unreachable');
    expect(latest.configured).not.toBe(false);
    expect(latest.loadFailed).toBe(true);
  });

  it('says sign-in is unconfigured only when the server says so, and then asks for no session', async () => {
    const fetchStub = routes({ '/api/config': unconfigured });
    await mount();
    expect(latest.configStatus).toBe('unconfigured');
    expect(latest.configured).toBe(false);
    expect(latest.loadFailed).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('does not call sign-in unconfigured while the answer is still on its way', async () => {
    routes({ '/api/config': () => new Promise<Response>(() => {}) });
    await act(async () => root.render(createElement(Probe)));
    expect(latest.loading).toBe(true);
    expect(latest.configStatus).toBe('loading');
    expect(latest.configured).not.toBe(false);
  });

  it('opens the ledger for a signed-in member', async () => {
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => json(200, ledger),
    });
    await mount();
    expect(latest.state?.bets).toHaveLength(ledger.bets.length);
    expect(latest.member?.id).toBe(sarah.id);
    expect(latest.loadFailed).toBe(false);
  });
});

describe('trying again', () => {
  it('runs the whole load again and opens the ledger once the server answers', async () => {
    let healthy = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetchStub = routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': async () => {
        if (!healthy) return json(500, {});
        await held;
        return json(200, ledger);
      },
    });
    await mount();
    expect(latest.loadFailed).toBe(true);
    healthy = true;
    await act(async () => latest.retry());
    // The failure is cleared at once and the opening screen returns while the request is out.
    expect(latest.loading).toBe(true);
    expect(latest.loadFailed).toBe(false);
    release();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(latest.loadFailed).toBe(false);
    expect(latest.loading).toBe(false);
    expect(latest.state?.bets.length).toBeGreaterThan(0);
    expect(fetchStub.mock.calls.filter(([path]) => path === '/api/config')).toHaveLength(2);
  });

  it('recovers from an unreachable config the same way', async () => {
    let reachable = false;
    routes({
      '/api/config': () => {
        if (!reachable) throw new TypeError('Failed to fetch');
        return configured();
      },
      '/api/session': signedOut,
    });
    await mount();
    expect(latest.configStatus).toBe('unreachable');
    reachable = true;
    await act(async () => latest.retry());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(latest.configStatus).toBe('ready');
    expect(latest.loadFailed).toBe(false);
  });
});

describe('editing a profile name', () => {
  const renamed = { ...sarah, name: 'Sarah Chen', initials: 'SC' };
  const updated = {
    ...ledger,
    members: ledger.members.map((member) => (member.id === sarah.id ? renamed : member)),
  };

  it('shows the saved name immediately and keeps it when the follow-up refresh fails', async () => {
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    let reads = 0;
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => (++reads === 1 ? json(200, ledger) : held),
      '/api/profile': () => json(200, { member: renamed }),
    });
    await mount();
    let pending: Promise<typeof renamed>;
    await act(async () => {
      pending = latest.updateProfile('Sarah Chen');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(latest.member).toEqual(renamed);
    expect(latest.state?.members).toEqual(updated.members);
    expect(latest.state?.bets).toEqual(ledger.bets);
    await act(async () => {
      release(json(503, {}));
      await expect(pending!).resolves.toEqual(renamed);
    });
    expect(latest.member).toEqual(renamed);
    expect(latest.error).toMatch(/Your change was saved/);
  });

  it('does not let a refresh started before saving restore the old name', async () => {
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    let reads = 0;
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => {
        reads += 1;
        return reads === 1 ? json(200, ledger) : reads === 2 ? held : json(200, updated);
      },
      '/api/profile': () => json(200, { member: renamed }),
    });
    await mount();
    const earlier = latest.refresh();
    await act(async () => {
      await latest.updateProfile('Sarah Chen');
      release(json(200, ledger));
      await earlier;
    });
    expect(latest.member).toEqual(renamed);
    expect(latest.state?.members).toEqual(updated.members);
  });

  it('keeps the current profile when the server refuses a name', async () => {
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => json(200, ledger),
      '/api/profile': () => json(400, { error: 'Someone named Alex is already at the table.' }),
    });
    await mount();
    await act(async () => {
      await expect(latest.updateProfile('Alex')).rejects.toThrow(/already at the table/);
    });
    expect(latest.member).toEqual(sarah);
    expect(latest.state?.members).toEqual(ledger.members);
  });

  describe('in the demo', () => {
    const KEY = 'lobster-ledger-demo-v1';
    beforeEach(() => {
      window.localStorage.clear();
      window.history.replaceState(null, '', '/?demo=1');
    });

    it('saves the cleaned name and initials for only the selected member', async () => {
      await mount();
      await act(async () => latest.setMemberId(sarah.id));
      const before = latest.state!;
      await act(async () => {
        await expect(latest.updateProfile('  Sarah \t Chen  ')).resolves.toEqual(renamed);
      });
      expect(latest.member).toEqual(renamed);
      const saved = JSON.parse(window.localStorage.getItem(KEY)!);
      expect(saved.members).toEqual(
        before.members.map((member) => (member.id === sarah.id ? renamed : member)),
      );
      expect(saved.bets).toEqual(before.bets);
    });

    it('allows keeping one’s own name and refuses blank, long, or another member’s name', async () => {
      await mount();
      await act(async () => {
        await expect(latest.updateProfile('Ellis')).resolves.toMatchObject({
          id: 'ellis',
          name: 'Ellis',
          initials: 'E',
        });
      });
      const before = latest.state!;
      await act(async () => {
        for (const name of ['   ', 'N'.repeat(LIMITS.memberName.max + 1), sarah.name.toUpperCase()])
          await expect(latest.updateProfile(name)).rejects.toThrow();
      });
      expect(latest.state?.members).toEqual(before.members);
      expect(JSON.parse(window.localStorage.getItem(KEY)!).members).toEqual(before.members);
    });
  });
});

describe('the demo’s storage notices', () => {
  const KEY = 'lobster-ledger-demo-v1';
  const withLocks = () =>
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, run: () => unknown) => Promise.resolve().then(run) },
    });
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/?demo=1');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'locks');
  });
  /** The first save of the opening ledger fails; every save after it goes through. */
  const storageFailsOnce = () =>
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('Full');
    });

  it('says the sample ledger replaced records that could not be read', async () => {
    withLocks();
    window.localStorage.setItem(KEY, '{broken');
    await mount();
    expect(latest.state?.members.length).toBeGreaterThan(0);
    expect(latest.storageWarning).toMatch(/sample ledger/i);
    expect(latest.storageWarning).not.toMatch(/still available/i);
  });

  it('clears a storage warning once a change has been saved properly', async () => {
    withLocks();
    storageFailsOnce();
    await mount();
    expect(latest.storageWarning).toMatch(/storage is unavailable/i);
    await act(async () => {
      await latest.addDemoMember('Jamie');
    });
    expect(latest.storageWarning).toBe('');
  });

  it('keeps the warning while saving keeps failing', async () => {
    withLocks();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Full');
    });
    await mount();
    await act(async () => {
      await latest.addDemoMember('Jamie');
    });
    expect(latest.storageWarning).toMatch(/export your ledger/i);
  });

  it('lets the member dismiss a warning', async () => {
    withLocks();
    storageFailsOnce();
    await mount();
    expect(latest.storageWarning).not.toBe('');
    await act(async () => latest.dismissStorageWarning());
    expect(latest.storageWarning).toBe('');
  });

  it('keeps the standing tab-coordination notice after a save, until it is dismissed', async () => {
    // jsdom has no Web Locks, which is exactly the browser this notice is about.
    await mount();
    const standing = latest.storageWarning;
    expect(standing).toMatch(/cannot coordinate demo tabs/i);
    await act(async () => {
      await latest.addDemoMember('Jamie');
    });
    expect(latest.storageWarning).toBe(standing);
    await act(async () => latest.dismissStorageWarning());
    await act(async () => {
      await latest.addDemoMember('Riley');
    });
    expect(latest.storageWarning).toBe('');
  });
});
describe('a session that has ended', () => {
  const HINT = 'lobster-ledger-had-session';
  beforeEach(() => window.localStorage.clear());

  it('says nothing special to a visitor who never signed in on this browser', async () => {
    routes({ '/api/config': configured, '/api/session': signedOut });
    await mount();
    expect(latest.member).toBeUndefined();
    expect(latest.sessionEnded).toBe(false);
  });

  it('tells a returning visitor the session ended when the session request says 401', async () => {
    window.localStorage.setItem(HINT, '1');
    routes({ '/api/config': configured, '/api/session': signedOut });
    await mount();
    expect(latest.sessionEnded).toBe(true);
    // It is still the ordinary signed-out state: nothing failed, so nothing is retried.
    expect(latest.loadFailed).toBe(false);
    expect(latest.error).toBe('');
  });

  it('tells the same visitor when the session ended between the session and the ledger request', async () => {
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': signedOut,
    });
    await mount();
    expect(latest.member).toBeUndefined();
    expect(latest.sessionEnded).toBe(true);
    expect(latest.loadFailed).toBe(false);
  });

  it('remembers a successful sign-in for the next visit, and says nothing while signed in', async () => {
    routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => json(200, ledger),
    });
    await mount();
    expect(latest.sessionEnded).toBe(false);
    expect(window.localStorage.getItem(HINT)).toBe('1');
  });

  it('does not call a failed request an ended session', async () => {
    window.localStorage.setItem(HINT, '1');
    routes({ '/api/config': configured, '/api/session': () => json(502, {}) });
    await mount();
    expect(latest.loadFailed).toBe(true);
    expect(latest.sessionEnded).toBe(false);
  });
});

describe('a session that ends while the ledger is open', () => {
  const sarahsBet = ledger.bets[0];
  /** Opens the ledger for a signed-in member; what the ledger endpoint says next is up to the test. */
  async function openLedger() {
    let answer: () => Response = () => json(200, ledger);
    const fetchStub = routes({
      '/api/config': configured,
      '/api/session': signedIn,
      '/api/ledger': () => answer(),
      [`/api/bets/${sarahsBet.id}/actions`]: () => json(200, sarahsBet),
    });
    await mount();
    expect(latest.state?.bets.length).toBe(ledger.bets.length);
    return {
      fetchStub,
      answerWith: (next: () => Response) => {
        answer = next;
      },
    };
  }
  const refreshQuietly = () =>
    act(async () => {
      await latest.refresh().catch(() => {});
    });

  it('says the session ended, not that updates are paused, when a refresh answers 401', async () => {
    const { answerWith } = await openLedger();
    answerWith(signedOut);
    await refreshQuietly();
    expect(latest.sessionExpired).toBe(true);
    // "Updates are paused" tells a member to wait for a connection; here nothing will come back on its own.
    expect(latest.error).toBe('');
    // The records already on screen stay.
    expect(latest.state?.bets).toHaveLength(ledger.bets.length);
  });

  it('keeps the paused-updates line for a server error, and does not call the session ended', async () => {
    const { answerWith } = await openLedger();
    answerWith(() => json(503, {}));
    await refreshQuietly();
    expect(latest.error).toMatch(/updates are paused/i);
    expect(latest.sessionExpired).toBe(false);
  });

  it('keeps the paused-updates line when the connection is lost', async () => {
    const { answerWith } = await openLedger();
    answerWith(() => {
      throw new TypeError('Failed to fetch');
    });
    await refreshQuietly();
    expect(latest.error).toMatch(/updates are paused/i);
    expect(latest.sessionExpired).toBe(false);
  });

  it('lets go of the notice once a refresh works again', async () => {
    const { answerWith } = await openLedger();
    answerWith(signedOut);
    await refreshQuietly();
    expect(latest.sessionExpired).toBe(true);
    answerWith(() => json(200, ledger));
    await refreshQuietly();
    expect(latest.sessionExpired).toBe(false);
    expect(latest.error).toBe('');
  });

  it('is the one notice when the session ends right after a change was saved', async () => {
    const { answerWith } = await openLedger();
    answerWith(signedOut);
    await act(async () => {
      await latest.act(sarahsBet, { type: 'mark_ready', evidence: 'Lobster roll photo' });
    });
    expect(latest.sessionExpired).toBe(true);
    expect(latest.error).toBe('');
  });

  it('is told when the change itself is refused because the session is gone', async () => {
    const { answerWith, fetchStub } = await openLedger();
    answerWith(signedOut);
    fetchStub.mockImplementation(async (path: string) =>
      path === '/api/ledger'
        ? signedOut()
        : json(401, { error: 'Sign in to your private ledger.' }),
    );
    await act(async () => {
      await latest
        .act(sarahsBet, { type: 'mark_ready', evidence: 'Lobster roll photo' })
        .catch(() => {});
    });
    expect(latest.sessionExpired).toBe(true);
    expect(latest.error).toBe('');
  });
});

describe('price reports', () => {
  const KEY = 'lobster-ledger-demo-v1';
  const visit = {
    itemName: 'Classic lobster roll',
    priceCents: 2950,
    visitDate: '2026-09-20',
    visitDatePrecision: 'day' as const,
  };

  describe('in the demo', () => {
    beforeEach(() => {
      window.localStorage.clear();
      window.history.replaceState(null, '', '/?demo=1');
    });
    afterEach(() => vi.restoreAllMocks());

    it('adds a new restaurant and its first report in one change', async () => {
      await mount();
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      let result: Awaited<ReturnType<typeof latest.addPriceObservation>> | undefined;
      await act(async () => {
        result = await latest.addPriceObservation({
          ...visit,
          restaurant: { name: 'Pearl Street Clam Bar', address: 'Fort Point' },
        });
      });
      const saves = setItem.mock.calls.filter(([key]) => key === KEY);
      expect(saves).toHaveLength(1);
      const saved = JSON.parse(saves[0][1]);
      const restaurant = saved.restaurants.find(
        (item: { name: string }) => item.name === 'Pearl Street Clam Bar',
      );
      expect(restaurant).toBeDefined();
      expect(saved.priceObservations).toContainEqual(
        expect.objectContaining({ restaurantId: restaurant.id, priceCents: 2950 }),
      );
      expect(result).toMatchObject({ restaurant: { id: restaurant.id }, matched: 'created' });
      expect(latest.state?.restaurants).toContainEqual(restaurant);
    });

    it('writes neither record when the report is refused', async () => {
      await mount();
      const before = latest.state!;
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      for (const [refused, restaurant] of [
        [
          { ...visit, itemName: '   ' },
          { name: 'Ghost Kitchen', address: '' },
        ],
        [
          { ...visit, itemName: 'I'.repeat(161) },
          { name: 'Ghost Kitchen', address: '' },
        ],
        [
          { ...visit, visitDate: '2026-02-31' },
          { name: 'Ghost Kitchen', address: '' },
        ],
        [
          { ...visit, visitDate: '2099-01-01' },
          { name: 'Ghost Kitchen', address: '' },
        ],
        [visit, { name: '   ', address: '' }],
        [visit, { name: 'N'.repeat(161), address: '' }],
        [visit, { name: 'Ghost Kitchen', address: 'A'.repeat(241) }],
      ] as const)
        await act(async () => {
          await expect(latest.addPriceObservation({ ...refused, restaurant })).rejects.toThrow();
        });
      expect(latest.state?.restaurants).toEqual(before.restaurants);
      expect(latest.state?.priceObservations).toEqual(before.priceObservations);
      expect(setItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(0);
    });

    it('reuses a restaurant named in another case, and treats a repeated visit like the ledger does', async () => {
      await mount();
      const harbor = latest.state!.restaurants!.find((item) => item.name === 'Harbor Shack')!;
      let first: Awaited<ReturnType<typeof latest.addPriceObservation>> | undefined;
      await act(async () => {
        first = await latest.addPriceObservation({
          ...visit,
          restaurant: { name: 'harbor  shack', address: harbor.address.toUpperCase() },
        });
      });
      expect(first).toMatchObject({ restaurant: { id: harbor.id }, matched: 'normalised' });
      const count = latest.state!.priceObservations!.length;
      await act(async () => {
        expect(
          await latest.addPriceObservation({ ...visit, restaurantId: harbor.id }),
        ).toMatchObject({ duplicateOf: first!.observation.id });
      });
      expect(latest.state!.priceObservations).toHaveLength(count);
      await act(async () => {
        await expect(
          latest.addPriceObservation({ ...visit, priceCents: 3100, restaurantId: harbor.id }),
        ).rejects.toBeInstanceOf(DuplicatePriceError);
      });
      await act(async () => {
        await latest.addPriceObservation({
          ...visit,
          priceCents: 3100,
          restaurantId: harbor.id,
          confirmSeparateReport: true,
        });
      });
      expect(latest.state!.priceObservations).toHaveLength(count + 1);
    });

    it('applies the duplicate rule to the visit a correction lands on, like the ledger does', async () => {
      await mount();
      const harbor = latest.state!.restaurants!.find((item) => item.name === 'Harbor Shack')!;
      const report = async (visitDate: string) => {
        let saved: Awaited<ReturnType<typeof latest.addPriceObservation>> | undefined;
        await act(async () => {
          saved = await latest.addPriceObservation({
            ...visit,
            visitDate,
            restaurantId: harbor.id,
          });
        });
        return saved!.observation;
      };
      const first = await report('2026-09-20');
      const second = await report('2026-09-21');
      const onto = { ...visit, restaurantId: harbor.id, visitDate: first.visitDate };
      await act(async () => {
        // The same price would count the roll twice; another price needs the member's word.
        for (const input of [onto, { ...onto, priceCents: 3100 }]) {
          const refused = latest.correctPriceObservation(second.id, input);
          await expect(refused).rejects.toBeInstanceOf(DuplicatePriceError);
          await expect(refused).rejects.toMatchObject({ existing: { id: first.id } });
        }
      });
      expect(latest.state!.priceObservations!.find((item) => item.id === second.id)).toEqual(
        second,
      );
      await act(async () => {
        await latest.correctPriceObservation(second.id, {
          ...onto,
          priceCents: 3100,
          confirmSeparateReport: true,
        });
      });
      expect(
        latest.state!.priceObservations!.find((item) => item.id === second.id)?.correctedAt,
      ).toBeTruthy();
    });

    it('refuses a correction that changes nothing or names an impossible date', async () => {
      await mount();
      const mine = latest.state!.priceObservations!.find(
        (item) => item.reporterId === latest.memberId && !item.correctedAt,
      )!;
      const { id, reporterId: _, reportedAt: __, currency: ___, ...same } = mine;
      for (const [input, reason] of [
        [same, /changes nothing\. Change the restaurant, price, item, date or note first\./],
        [{ ...same, visitDate: '2026-02-31' }, /valid calendar date/],
      ] as const)
        await act(async () => {
          await expect(latest.correctPriceObservation(id, input)).rejects.toThrow(reason);
        });
      expect(latest.state!.priceObservations!.find((item) => item.id === id)?.correctedAt).toBe(
        undefined,
      );
    });

    it('asks for a reload when the part that checks a price cannot be loaded', async () => {
      await mount();
      const before = latest.state!.priceObservations;
      const mine = before!.find(
        (item) => item.reporterId === latest.memberId && !item.correctedAt,
      )!;
      const { id, reporterId: _, reportedAt: __, currency: ___, ...same } = mine;
      // A deploy since the page opened removes the file the demo loads its checks from.
      vi.doMock('./api-schemas', () => {
        throw new TypeError('Failed to fetch dynamically imported module: /assets/api-schemas.js');
      });
      try {
        const reload =
          'Part of the demo did not load, which happens when the site has just been updated. Reload the page to keep using it.';
        await act(async () => {
          await expect(
            latest.addPriceObservation({ ...visit, restaurantId: mine.restaurantId }),
          ).rejects.toThrow(reload);
          await expect(
            latest.correctPriceObservation(id, { ...same, priceCents: same.priceCents + 100 }),
          ).rejects.toThrow(reload);
        });
      } finally {
        vi.doUnmock('./api-schemas');
      }
      expect(latest.state!.priceObservations).toEqual(before);
    });

    it('withdraws only the member’s own live report, once, with a reason, and keeps it', async () => {
      await mount();
      const reports = () => latest.state!.priceObservations!;
      const mine = reports().find(
        (item) => item.reporterId === latest.memberId && !item.correctedAt && !item.withdrawnAt,
      )!;
      const theirs = reports().find(
        (item) => item.reporterId !== latest.memberId && !item.correctedAt && !item.withdrawnAt,
      )!;
      for (const [id, reason, refusal] of [
        [mine.id, '   ', /Say why/],
        [mine.id, 'R'.repeat(501), /500/],
        [theirs.id, 'Not mine', /Only the member who reported a price can withdraw it\./],
        ['missing', 'Gone', /could not be found/],
      ] as const)
        await act(async () => {
          await expect(latest.withdrawPriceObservation(id, reason)).rejects.toThrow(refusal);
        });
      expect(reports().find((item) => item.id === mine.id)?.withdrawnAt).toBeUndefined();
      await act(async () => {
        await latest.withdrawPriceObservation(mine.id, '  Wrong restaurant ');
      });
      const withdrawn = reports().find((item) => item.id === mine.id)!;
      expect(withdrawn).toMatchObject({
        priceCents: mine.priceCents,
        withdrawnReason: 'Wrong restaurant',
      });
      expect(Date.parse(withdrawn.withdrawnAt!)).not.toBeNaN();
      expect(JSON.parse(window.localStorage.getItem(KEY)!).priceObservations).toContainEqual(
        withdrawn,
      );
      await act(async () => {
        await expect(latest.withdrawPriceObservation(mine.id, 'Again')).rejects.toThrow(
          /already been withdrawn/,
        );
        const {
          id,
          reporterId: _,
          reportedAt: __,
          currency: ___,
          withdrawnAt: ____,
          withdrawnReason: _____,
          ...same
        } = withdrawn;
        await expect(
          latest.correctPriceObservation(id, { ...same, priceCents: same.priceCents + 100 }),
        ).rejects.toThrow(/has been withdrawn/);
      });
    });

    it('asks about an unusual price like the ledger does, and keeps a correction’s reason', async () => {
      await mount();
      const harbor = latest.state!.restaurants!.find((item) => item.name === 'Harbor Shack')!;
      await act(async () => {
        const refused = latest.addPriceObservation({
          ...visit,
          priceCents: 295,
          restaurantId: harbor.id,
        });
        await expect(refused).rejects.toBeInstanceOf(UnusualPriceError);
        await expect(refused).rejects.toMatchObject({ warnings: [{ suggestedCents: 2950 }] });
      });
      const mine = latest.state!.priceObservations!.find(
        (item) => item.reporterId === latest.memberId && !item.correctedAt && !item.withdrawnAt,
      )!;
      const { id, reporterId: _, reportedAt: __, currency: ___, ...same } = mine;
      await act(async () => {
        await expect(
          latest.correctPriceObservation(id, { ...same, priceCents: same.priceCents * 10 }),
        ).rejects.toBeInstanceOf(UnusualPriceError);
        await latest.correctPriceObservation(id, {
          ...same,
          priceCents: same.priceCents + 100,
          correctionReason: ' Misread the menu ',
        });
      });
      expect(
        latest.state!.priceObservations!.find((item) => item.correctedFromId === id),
      ).toMatchObject({ correctionReason: 'Misread the menu', priceCents: same.priceCents + 100 });
    });

    it('refuses a correction with a blank or over-long item name and leaves the original standing', async () => {
      await mount();
      const mine = latest.state!.priceObservations!.find(
        (item) => item.reporterId === latest.memberId && !item.correctedAt,
      )!;
      const { id, reporterId: _, reportedAt: __, currency: ___, ...same } = mine;
      const before = latest.state!.priceObservations;
      for (const itemName of ['   ', 'I'.repeat(161)])
        await act(async () => {
          await expect(
            latest.correctPriceObservation(id, {
              ...same,
              priceCents: same.priceCents + 100,
              itemName,
            }),
          ).rejects.toThrow();
        });
      expect(latest.state!.priceObservations).toEqual(before);
    });
  });

  describe('on the shared ledger', () => {
    const harbor = ledger.restaurants![0];
    it('keeps the new restaurant and its report from one answer', async () => {
      const created = { id: 'restaurant-new', name: 'Pearl Street Clam Bar', address: '' };
      const observation = {
        ...visit,
        id: 'price-new',
        restaurantId: created.id,
        currency: 'USD',
        reporterId: sarah.id,
        reportedAt: '2026-09-20T18:00:00.000Z',
      };
      const fetchStub = routes({
        '/api/config': configured,
        '/api/session': signedIn,
        '/api/ledger': () => json(200, ledger),
        '/api/price-observations': () =>
          json(201, { observation, restaurant: created, matched: 'created' }),
      });
      await mount();
      await act(async () => {
        await latest.addPriceObservation({
          ...visit,
          restaurant: { name: created.name, address: '' },
        });
      });
      const posted = fetchStub.mock.calls.filter(([path]) => path === '/api/price-observations');
      expect(posted).toHaveLength(1);
      expect(fetchStub.mock.calls.some(([path]) => path === '/api/restaurants')).toBe(false);
      expect(latest.state?.restaurants).toContainEqual(created);
      expect(latest.state?.priceObservations).toContainEqual(observation);
    });

    it('withdraws a report through the ledger and keeps the withdrawn record', async () => {
      const report = ledger.priceObservations!.find((item) => item.id === 'price-harbor-july')!;
      const withdrawn = {
        ...report,
        withdrawnAt: '2026-10-18T12:00:00.000Z',
        withdrawnReason: 'Wrong restaurant',
      };
      const fetchStub = routes({
        '/api/config': configured,
        '/api/session': signedIn,
        '/api/ledger': () => json(200, ledger),
        [`/api/price-observations/${report.id}/withdraw`]: () =>
          json(200, { observation: withdrawn }),
      });
      await mount();
      await act(async () => {
        await latest.withdrawPriceObservation(report.id, 'Wrong restaurant');
      });
      const posted = fetchStub.mock.calls.find(
        ([path]) => path === `/api/price-observations/${report.id}/withdraw`,
      ) as unknown as [string, RequestInit];
      expect(posted[1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ reason: 'Wrong restaurant' }),
      });
      expect(latest.state?.priceObservations).toContainEqual(withdrawn);
    });

    it('turns the ledger’s question about an unusual price into one the dialog can ask', async () => {
      const warnings = [
        {
          code: 'below-usual',
          message: 'You entered $2.95. Did you mean $29.50?',
          suggestedCents: 2950,
        },
      ];
      routes({
        '/api/config': configured,
        '/api/session': signedIn,
        '/api/ledger': () => json(200, ledger),
        '/api/price-observations': () => json(422, { error: warnings[0].message, warnings }),
      });
      await mount();
      await act(async () => {
        const refused = latest.addPriceObservation({
          ...visit,
          priceCents: 295,
          restaurantId: harbor.id,
        });
        await expect(refused).rejects.toBeInstanceOf(UnusualPriceError);
        await expect(refused).rejects.toMatchObject({ warnings });
      });
    });

    it('turns the ledger’s question about a repeated visit into one the dialog can ask', async () => {
      const existing = {
        ...visit,
        id: 'price-earlier',
        restaurantId: harbor.id,
        currency: 'USD',
        reporterId: sarah.id,
        reportedAt: '2026-09-20T12:00:00.000Z',
      };
      routes({
        '/api/config': configured,
        '/api/session': signedIn,
        '/api/ledger': () => json(200, ledger),
        '/api/price-observations': () =>
          json(409, { error: 'You already reported $29.50.', existingId: existing.id, existing }),
      });
      await mount();
      await act(async () => {
        const refused = latest.addPriceObservation({
          ...visit,
          priceCents: 3100,
          restaurantId: harbor.id,
        });
        await expect(refused).rejects.toBeInstanceOf(DuplicatePriceError);
        await expect(refused).rejects.toMatchObject({ existing: { id: existing.id } });
      });
    });

    it('turns a correction refused as a repeated visit into the same question', async () => {
      const existing = {
        ...visit,
        id: 'price-earlier',
        restaurantId: harbor.id,
        currency: 'USD',
        reporterId: sarah.id,
        reportedAt: '2026-09-20T12:00:00.000Z',
      };
      routes({
        '/api/config': configured,
        '/api/session': signedIn,
        '/api/ledger': () => json(200, ledger),
        '/api/price-observations/price-later': () =>
          json(409, { error: 'You already reported $29.50.', existingId: existing.id, existing }),
      });
      await mount();
      await act(async () => {
        const refused = latest.correctPriceObservation('price-later', {
          ...visit,
          priceCents: 3100,
          restaurantId: harbor.id,
        });
        await expect(refused).rejects.toBeInstanceOf(DuplicatePriceError);
        await expect(refused).rejects.toMatchObject({ existing: { id: existing.id } });
      });
    });
  });
});
