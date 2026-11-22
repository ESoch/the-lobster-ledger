import { describe, expect, it } from 'vitest';
import {
  appendDemoMember,
  commitDemoChange,
  commitRemoteChange,
  demoStorageKey,
  mergeLedgerState,
  readDemoState,
  runDemoChange,
  syncStorageEvent,
  updateDemoBet,
  withBet,
  withPriceWithdrawal,
} from './client-state';
import type { DemoStorage } from './client-state';
import { AVATAR_PALETTE } from './avatar-colors';
import { createDemoState } from './demo';
import { LIMITS } from './limits';
import { MEMBER_NAME_BLANK, MEMBER_NAME_TOO_LONG } from './member-name';
import { applyAction } from './ledger';
import type { Bet, LedgerState, PriceObservation } from './types';

function memoryStorage(): DemoStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function track() {
  const committed: LedgerState[] = [];
  const warnings: string[] = [];
  return {
    committed,
    warnings,
    commit: (state: LedgerState) => {
      committed.push(state);
    },
    onWarning: (warning: string) => {
      warnings.push(warning);
    },
  };
}
const now = '2026-09-12T12:00:00.000Z';
const key = 'test-ledger';

describe('ledger snapshots', () => {
  it('preserves committed versions and newly added records when an older poll finishes last', () => {
    const older = createDemoState();
    const pending = older.bets.find(
      (bet) => bet.status === 'pending' && bet.opponentId === 'ellis',
    )!;
    const approved = applyAction(pending, { type: 'accept' }, 'ellis', now);
    const newer = withBet(appendDemoMember(older, 'Jamie').state, approved);
    const merged = mergeLedgerState(newer, older);
    expect(merged.bets.find((bet) => bet.id === pending.id)).toMatchObject({
      status: 'active',
      version: 2,
    });
    expect(merged.members.map((member) => member.name)).toContain('Jamie');
    expect(older.bets.find((bet) => bet.id === pending.id)?.status).toBe('pending');
    expect(older.members).toHaveLength(6);
  });
  it('accepts a higher server version while retaining unrelated local records and their places', () => {
    const state = createDemoState();
    const bet = state.bets.find((item) => item.status === 'pending')!;
    const approved = applyAction(bet, { type: 'accept' }, bet.opponentId, now);
    const place = {
      id: 'new-place',
      name: 'Kitchen',
      address: 'Pinned location',
      lat: 42,
      lng: -71,
    };
    const fresh = { ...approved, id: 'new-record', location: place };
    const current = withBet(state, fresh);
    const result = mergeLedgerState(current, { ...state, bets: [approved] });
    expect(result.bets).toHaveLength(state.bets.length + 1);
    expect(result.bets.find((item) => item.id === bet.id)?.version).toBe(2);
    expect(result.places).toContainEqual(place);
  });
  it('keeps an existing same-version record rather than replacing its history', () => {
    const state = createDemoState();
    const incoming = structuredClone(state);
    incoming.bets[0].events = [];
    expect(mergeLedgerState(state, incoming).bets[0].events).toEqual(state.bets[0].events);
  });
});

describe('demo persistence', () => {
  it('loads saved records without duplicating the newly generated fallback fixtures', () => {
    const storage = memoryStorage();
    const saved = createDemoState();
    storage.setItem(key, JSON.stringify(saved));
    const loaded = readDemoState(storage, key, createDemoState()).state;
    expect(loaded.bets).toHaveLength(saved.bets.length);
    expect(loaded.bets.map((bet) => bet.id)).toEqual(saved.bets.map((bet) => bet.id));
  });
  it('reads the latest saved ledger before a stale tab adds a member', () => {
    const storage = memoryStorage();
    const initial = createDemoState();
    const pending = initial.bets.find(
      (bet) => bet.status === 'pending' && bet.opponentId === 'ellis',
    )!;
    commitDemoChange(storage, key, initial, (state) =>
      updateDemoBet(state, pending.id, pending.version, { type: 'accept' }, 'ellis', now),
    );
    const second = commitDemoChange(storage, key, initial, (state) =>
      appendDemoMember(state, ' Jamie Chen '),
    );
    expect(second.result.name).toBe('Jamie Chen');
    const stored = readDemoState(storage, key, initial).state;
    expect(stored.members).toHaveLength(7);
    expect(stored.bets.find((bet) => bet.id === pending.id)?.status).toBe('active');
  });
  it('preserves members added independently by two stale tabs', () => {
    const storage = memoryStorage();
    const initial = createDemoState();
    commitDemoChange(storage, key, initial, (state) => appendDemoMember(state, 'Jamie'));
    commitDemoChange(storage, key, initial, (state) => appendDemoMember(state, 'Taylor'));
    expect(readDemoState(storage, key, initial).state.members.map((member) => member.name)).toEqual(
      ['Ellis', 'Alex', 'Sarah', 'Marcus', 'Olivia', 'James', 'Jamie', 'Taylor'],
    );
  });
  it('rejects stale approval versions without erasing the latest saved event', () => {
    const storage = memoryStorage();
    const initial = createDemoState();
    const pending = initial.bets.find(
      (bet) => bet.status === 'pending' && bet.opponentId === 'ellis',
    )!;
    commitDemoChange(storage, key, initial, (state) =>
      updateDemoBet(state, pending.id, 1, { type: 'accept' }, 'ellis', now),
    );
    expect(() =>
      commitDemoChange(storage, key, initial, (state) =>
        updateDemoBet(
          state,
          pending.id,
          1,
          { type: 'decline', note: 'Not these terms' },
          'ellis',
          now,
        ),
      ),
    ).toThrow(/changed/i);
    const stored = readDemoState(storage, key, initial).state.bets.find(
      (bet) => bet.id === pending.id,
    )!;
    expect(stored.status).toBe('active');
    expect(stored.events).toHaveLength(2);
  });
  it('rejects actions targeting a missing record', () => {
    expect(() =>
      updateDemoBet(createDemoState(), 'missing', 1, { type: 'accept' }, 'ellis', now),
    ).toThrow(/found/i);
  });
  it('keeps changes usable in memory and warns when storage fails', () => {
    const unavailable: DemoStorage = {
      getItem() {
        throw new Error('Blocked');
      },
      setItem() {
        throw new Error('Full');
      },
    };
    const initial = createDemoState();
    const changed = commitDemoChange(unavailable, key, initial, (state) =>
      appendDemoMember(state, 'Jamie'),
    );
    expect(changed.state.members).toHaveLength(7);
    expect(changed.warning).toMatch(/storage/i);
    expect(readDemoState(undefined, key, changed.state).state.members).toHaveLength(7);
  });
  it('falls back safely when saved data cannot be parsed or lacks ledger structure', () => {
    const initial = createDemoState();
    const storage = memoryStorage();
    storage.setItem(key, '{broken');
    expect(readDemoState(storage, key, initial)).toMatchObject({
      state: initial,
      warning: expect.any(String),
    });
    storage.setItem(key, JSON.stringify({ members: [], bets: [], places: [] }));
    expect(readDemoState(storage, key, initial).warning).not.toBe('');
    expect(readDemoState(storage, key, initial).state).toEqual(initial);
  });
  it('says the sample ledger took the place of unreadable records when that is what it fell back to', () => {
    const sample = createDemoState();
    const storage = memoryStorage();
    storage.setItem(key, '{broken');
    const { state, warning } = readDemoState(storage, key, sample, { sample: true });
    expect(state).toBe(sample);
    // The stored records are gone from the screen, so the notice must not call them "still available".
    expect(warning).toMatch(/sample ledger/i);
    expect(warning).not.toMatch(/still available/i);
    // With the records already on screen as the fallback, the old wording is the true one.
    expect(readDemoState(storage, key, sample).warning).toMatch(/still available/i);
  });
  it.each([
    [' ', MEMBER_NAME_BLANK],
    ['\n\t', MEMBER_NAME_BLANK],
    ['a'.repeat(101), MEMBER_NAME_TOO_LONG],
  ])('rejects an invalid member name %j without adding a member', (name, problem) => {
    const initial = createDemoState();
    expect(() => appendDemoMember(initial, name)).toThrow(problem);
    expect(initial.members).toHaveLength(6);
  });
  it('normalizes a valid member name and keeps identities distinct', () => {
    const state = createDemoState();
    const first = appendDemoMember(state, '  Jamie Chen  ');
    const second = appendDemoMember(first.state, 'Taylor Brooks');
    expect(first.result).toMatchObject({ name: 'Jamie Chen', initials: 'JC' });
    expect(second.result.id).not.toBe(first.result.id);
  });
  it('stores a name with its inner whitespace collapsed', () => {
    const { result } = appendDemoMember(createDemoState(), '  jamie   chen  ');
    expect(result).toMatchObject({ name: 'jamie chen', initials: 'JC' });
  });
  it('measures the name limit on the shared limit, after cleaning', () => {
    const state = createDemoState();
    const longest = 'x'.repeat(LIMITS.memberName.max);
    expect(appendDemoMember(state, ` ${longest} `).result.name).toBe(longest);
    expect(() => appendDemoMember(state, `${longest}x`)).toThrow(MEMBER_NAME_TOO_LONG);
  });
  it.each(['alex', 'ALEX', '  Alex  ', '\talex\n'])(
    'turns away %j because Alex is already at the table, and adds nobody',
    (name) => {
      const state = createDemoState();
      expect(() => appendDemoMember(state, name)).toThrow(
        'Someone named Alex is already at the table.',
      );
      expect(state.members).toHaveLength(6);
    },
  );
  it('turns away a name another tab added while this one was stale', () => {
    const storage = memoryStorage();
    const initial = createDemoState();
    commitDemoChange(storage, key, initial, (state) => appendDemoMember(state, 'Jamie Chen'));
    expect(() =>
      commitDemoChange(storage, key, initial, (state) => appendDemoMember(state, 'jamie  chen')),
    ).toThrow('Someone named Jamie Chen is already at the table.');
    expect(readDemoState(storage, key, initial).state.members).toHaveLength(7);
  });
  it('gives each added member a palette colour the group is not already wearing', () => {
    let state = createDemoState();
    const worn = new Set(state.members.map((member) => member.color));
    for (const name of ['Jamie Chen', 'Taylor Brooks']) {
      const added = appendDemoMember(state, name);
      expect(AVATAR_PALETTE).toContain(added.result.color);
      expect(worn.has(added.result.color)).toBe(false);
      worn.add(added.result.color);
      state = added.state;
    }
  });
  it('draws initials from letters, so an emoji before the name is not the initial', () => {
    const { result } = appendDemoMember(createDemoState(), '🦞 Pat Smith');
    expect(result.initials).toBe('PS');
  });
  it('isolates explicitly named demo sessions and ignores invalid session names', () => {
    expect(demoStorageKey('?demo=1')).toBe('lobster-ledger-demo-v1');
    expect(demoStorageKey('?demo=1&demoSession=qa20260912')).toBe(
      'lobster-ledger-demo-v1:qa20260912',
    );
    expect(demoStorageKey('?demo=1&demoSession=../shared')).toBe('lobster-ledger-demo-v1');
    expect(demoStorageKey('?demoSession=' + 'a'.repeat(41))).toBe('lobster-ledger-demo-v1');
  });
});

describe('committed remote changes', () => {
  it('commits the returned record before refresh and reports success when refresh fails', async () => {
    const bet = createDemoState().bets[0];
    let shown: Bet | undefined;
    let warning = false;
    const result = await commitRemoteChange(
      async () => bet,
      (next) => {
        shown = next;
      },
      async () => {
        expect(shown).toBe(bet);
        throw new Error('Offline');
      },
      () => {
        warning = true;
      },
    );
    expect(result).toBe(bet);
    expect(shown).toBe(bet);
    expect(warning).toBe(true);
  });
  it('hands the reason the refresh failed to the caller, so a lost session can be told apart', async () => {
    const reason = new Error('Unauthorized');
    let reported: unknown;
    await commitRemoteChange(
      async () => 1,
      () => {},
      async () => {
        throw reason;
      },
      (why) => {
        reported = why;
      },
    );
    expect(reported).toBe(reason);
  });
  it('does not commit or refresh when the mutation itself fails', async () => {
    let shown = false;
    let refreshed = false;
    await expect(
      commitRemoteChange(
        async () => {
          throw new Error('Conflict');
        },
        () => {
          shown = true;
        },
        async () => {
          refreshed = true;
        },
        () => {},
      ),
    ).rejects.toThrow('Conflict');
    expect(shown).toBe(false);
    expect(refreshed).toBe(false);
  });
  it('propagates the mutation error without reporting a failed refresh', async () => {
    let warning = false;
    await expect(
      commitRemoteChange(
        async () => {
          throw new Error('Unauthorized');
        },
        () => {},
        async () => {},
        () => {
          warning = true;
        },
      ),
    ).rejects.toThrow('Unauthorized');
    expect(warning).toBe(false);
  });
  it('returns the mutation result unchanged so callers can chain it', async () => {
    const value = { id: 'obs-1', priceCents: 2400 };
    const result = await commitRemoteChange(
      async () => value,
      () => {},
      async () => {},
      () => {},
    );
    expect(result).toBe(value);
  });
});

describe('demo change flow', () => {
  const after = () => createDemoState();

  it('commits the changed ledger and persists it for other tabs', () => {
    const current = after();
    const changed = appendDemoMember(current, 'Jamie');
    const storage = memoryStorage();
    const t = track();
    const result = runDemoChange({
      storage,
      key,
      current,
      change: () => changed,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    expect(result).toBe(changed.result);
    expect(t.committed).toEqual([changed.state]);
    expect(t.warnings).toEqual([]);
    expect(readDemoState(storage, key, current).state.members.map((m) => m.name)).toContain(
      'Jamie',
    );
  });

  it('reports a clean save as recovered, and a save that warned as not', () => {
    const current = after();
    let recovered = 0;
    const t = track();
    runDemoChange({
      storage: memoryStorage(),
      key,
      current,
      change: (state) => appendDemoMember(state, 'Jamie'),
      commit: t.commit,
      onWarning: t.onWarning,
      onRecovered: () => recovered++,
    });
    expect(recovered).toBe(1);
    runDemoChange({
      storage: undefined,
      key,
      current,
      change: (state) => appendDemoMember(state, 'Jamie'),
      commit: t.commit,
      onWarning: t.onWarning,
      onRecovered: () => recovered++,
    });
    expect(recovered).toBe(1);
    expect(t.warnings).toHaveLength(1);
  });

  it('keeps the in-memory change and reports a warning when storage is unavailable', () => {
    const current = after();
    const changed = appendDemoMember(current, 'Jamie');
    const t = track();
    const result = runDemoChange({
      storage: undefined,
      key,
      current,
      change: () => changed,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    expect(result).toBe(changed.result);
    expect(t.committed).toEqual([changed.state]);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toMatch(/storage/i);
  });

  it('reloads the stored ledger and rethrows when the change rejects a stale action', () => {
    const current = after();
    const storage = memoryStorage();
    const stale = current.bets.find(
      (bet) => bet.status === 'pending' && bet.opponentId === 'ellis',
    )!;
    const fresher = withBet(current, applyAction(stale, { type: 'accept' }, 'ellis', now));
    storage.setItem(key, JSON.stringify(fresher));
    const t = track();
    expect(() =>
      runDemoChange({
        storage,
        key,
        current,
        change: (state) =>
          updateDemoBet(state, stale.id, stale.version, { type: 'accept' }, 'ellis'),
        commit: t.commit,
        onWarning: t.onWarning,
      }),
    ).toThrow(/changed since you opened/i);
    expect(t.committed).toHaveLength(1);
    expect(t.committed[0].bets.find((bet) => bet.id === stale.id)).toMatchObject({
      status: 'active',
      version: 2,
    });
  });

  it('rethrows the failure and reloads from memory when storage is unavailable', () => {
    const current = after();
    const stale = current.bets[0];
    const t = track();
    expect(() =>
      runDemoChange({
        storage: undefined,
        key,
        current,
        change: (state) =>
          updateDemoBet(state, stale.id, stale.version + 1, { type: 'accept' }, 'ellis'),
        commit: t.commit,
        onWarning: t.onWarning,
      }),
    ).toThrow(/changed since you opened/i);
    expect(t.committed).toEqual([current]);
    expect(t.warnings[0]).toMatch(/storage/i);
  });
});

describe('cross-tab sync', () => {
  const after = () => createDemoState();

  function makeEvent(key: string | null, newValue: string | null) {
    return { key, newValue };
  }

  it('syncs a valid update from another tab into the ledger', () => {
    const current = after();
    const incoming = appendDemoMember(current, 'Jamie');
    const t = track();
    syncStorageEvent({
      event: makeEvent(key, JSON.stringify(incoming.state)),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    expect(t.committed).toEqual([incoming.state]);
    expect(t.warnings).toEqual([]);
  });

  it('reports a valid update from another tab as recovered, and an unreadable one as not', () => {
    const incoming = appendDemoMember(after(), 'Jamie');
    let recovered = 0;
    const t = track();
    syncStorageEvent({
      event: makeEvent(key, JSON.stringify(incoming.state)),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
      onRecovered: () => recovered++,
    });
    expect(recovered).toBe(1);
    syncStorageEvent({
      event: makeEvent(key, '{broken'),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
      onRecovered: () => recovered++,
    });
    expect(recovered).toBe(1);
  });

  it('propagates one tab change to another tab sharing the same storage key', () => {
    const base = after();
    const storage = memoryStorage();
    const writer = after();
    const member = runDemoChange({
      storage,
      key,
      current: writer,
      change: (state) => appendDemoMember(state, 'Jamie'),
      commit: () => {},
      onWarning: () => {},
    });
    const event = makeEvent(key, storage.getItem(key));
    expect(event.newValue).toContain('Jamie');
    const t = track();
    syncStorageEvent({ event, key, commit: t.commit, onWarning: t.onWarning });
    expect(t.warnings).toEqual([]);
    // The receiving tab merges through commitState, so both sides survive.
    const merged = mergeLedgerState(base, t.committed[0]);
    expect(merged.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(['Jamie', base.members[0].name]),
    );
    expect(member.name).toBe('Jamie');
  });

  it('ignores events for other keys and tab removals without warnings', () => {
    const t = track();
    syncStorageEvent({
      event: makeEvent('other-ledger', JSON.stringify(after())),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    syncStorageEvent({
      event: makeEvent(key, null),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    syncStorageEvent({
      event: makeEvent(null, '{}'),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    expect(t.committed).toEqual([]);
    expect(t.warnings).toEqual([]);
  });

  it('reports a warning and keeps current records when an update cannot be parsed', () => {
    const t = track();
    syncStorageEvent({
      event: makeEvent(key, '{broken'),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    syncStorageEvent({
      event: makeEvent(key, JSON.stringify({ members: [] })),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    expect(t.committed).toEqual([]);
    expect(t.warnings).toHaveLength(2);
    expect(t.warnings[0]).toMatch(/another demo tab/i);
  });

  it('merges the incoming snapshot without dropping records the sender did not have', () => {
    const current = after();
    // The receiving tab already added a member the sender has not seen.
    const added = appendDemoMember(current, 'Taylor');
    const t = track();
    syncStorageEvent({
      event: makeEvent(key, JSON.stringify(current)),
      key,
      commit: t.commit,
      onWarning: t.onWarning,
    });
    const merged = mergeLedgerState(added.state, t.committed[0]);
    expect(merged.members.map((m) => m.name)).toContain('Taylor');
    expect(merged.members).toHaveLength(current.members.length + 1);
  });
});

describe('withdrawn price reports', () => {
  const demo = createDemoState();
  const report = demo.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
  const withdrawn: PriceObservation = {
    ...report,
    withdrawnAt: '2026-10-18T12:00:00.000Z',
    withdrawnReason: 'Wrong restaurant',
  };

  it('replaces the report with its withdrawn record, keeping it in the ledger', () => {
    const next = withPriceWithdrawal(demo, { observation: withdrawn });
    expect(next.priceObservations).toHaveLength(demo.priceObservations!.length);
    expect(next.priceObservations!.find((item) => item.id === report.id)).toEqual(withdrawn);
  });

  it('never lets an older snapshot bring a withdrawn or corrected report back', () => {
    const current = withPriceWithdrawal(demo, { observation: withdrawn });
    const merged = mergeLedgerState(current, demo);
    expect(merged.priceObservations!.find((item) => item.id === report.id)).toMatchObject({
      withdrawnAt: withdrawn.withdrawnAt,
      withdrawnReason: 'Wrong restaurant',
    });
    const corrected = { ...report, correctedAt: '2026-10-18T12:00:00.000Z' };
    const afterCorrection = mergeLedgerState(
      { ...demo, priceObservations: [corrected] },
      { ...demo, priceObservations: [report] },
    );
    expect(afterCorrection.priceObservations![0].correctedAt).toBe(corrected.correctedAt);
  });

  it('loads saved withdrawals, sources and correction reasons, and refuses a malformed one', () => {
    const storage = memoryStorage();
    const saved = {
      ...demo,
      priceObservations: [
        { ...withdrawn, entrySource: 'mcp', correctionReason: 'Typo' },
        ...demo.priceObservations!.filter((item) => item.id !== report.id),
      ],
    };
    storage.setItem(key, JSON.stringify(saved));
    expect(readDemoState(storage, key, demo)).toMatchObject({ state: saved, warning: '' });
    for (const broken of [
      { ...report, withdrawnAt: '2026-10-18T12:00:00.000Z' },
      { ...report, withdrawnReason: 'Why' },
      { ...report, entrySource: 'cli' },
      { ...report, correctionReason: 7 },
    ]) {
      storage.setItem(key, JSON.stringify({ ...demo, priceObservations: [broken] }));
      expect(readDemoState(storage, key, demo).state, JSON.stringify(broken)).toEqual(demo);
    }
  });
});
