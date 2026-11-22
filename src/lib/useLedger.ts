import { useCallback, useEffect, useRef, useState } from 'react';
import { createDemoState } from './demo';
import { applyDebtOffset, createBet } from './ledger';
import { api, ApiError } from './client';
import { hadSession, rememberSession } from './session-hint';
import { initialsFor } from './avatar-colors';
import { memberNameProblem, normalizeMemberName } from './member-name';
import {
  appendDemoMember,
  commitRemoteChange,
  demoStorageKey,
  mergeLedgerState,
  readDemoState,
  runDemoChange,
  syncStorageEvent,
  updateDemoBet,
  withBet,
  withPriceCorrection,
  withPriceReport,
  withPriceWithdrawal,
} from './client-state';
import {
  correctionChangesNothing,
  correctionDuplicate,
  DuplicatePriceError,
  planPriceReport,
  plausibility,
  sameSeries,
  UnusualPriceError,
} from './price-observations';
import type { Change, DemoStorage } from './client-state';
import type {
  Bet,
  BetAction,
  DebtOffsetPreview,
  LedgerState,
  Member,
  NewBet,
  PriceCorrectionInput,
  PriceCorrectionResult,
  PriceObservation,
  PriceReportInput,
  PriceReportResult,
  PriceWarning,
  PriceWithdrawalResult,
} from './types';

/** Whether the shared ledger's sign-in is set up, as far as this page could tell. `unreachable` means
 * the question itself got no answer, which says nothing about whether sign-in is configured. */
export type ConfigStatus = 'loading' | 'ready' | 'unconfigured' | 'unreachable';

function browserStorage(): DemoStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function demoLock<T>(key: string, operation: () => T): Promise<T> {
  if (navigator.locks?.request) return navigator.locks.request(key, operation);
  return Promise.resolve().then(operation);
}

/**
 * The ledger's own schemas, which the demo checks a price with. They load only here, so members
 * do not download them with the app, and a deploy since the page opened can take the old file
 * away: the browser's own message for that means nothing to a member.
 */
async function demoSchemas() {
  try {
    return await import('./api-schemas');
  } catch {
    throw new Error(
      'Part of the demo did not load, which happens when the site has just been updated. Reload the page to keep using it.',
    );
  }
}

export function useLedger() {
  const demo = new URLSearchParams(window.location.search).get('demo') === '1';
  const storageKey = demoStorageKey(window.location.search);
  const [state, setState] = useState<LedgerState | null>(null);
  const stateRef = useRef<LedgerState | null>(null);
  const refreshSequence = useRef(0);
  const [memberId, setMemberId] = useState('');
  const [loading, setLoading] = useState(true);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>(demo ? 'ready' : 'loading');
  // A request that should have worked did not (no answer, a timeout or a 5xx). A 401 is not one:
  // it is how a visitor who has not signed in yet looks.
  const [loadFailed, setLoadFailed] = useState(false);
  // Who the session says is signed in, even while the ledger itself has not loaded.
  const [sessionMember, setSessionMember] = useState<Member>();
  const [attempt, setAttempt] = useState(0);
  // Only a refresh that failed after the ledger was open: it carries the "updates are paused" line.
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  // A notice about the browser itself (no tab coordination) holds for as long as the page is open, so
  // a clean save brings back this one rather than clearing it, until the member dismisses it.
  const standingWarning = useRef('');
  // A visitor who signed in before and now gets a 401: the session ran out, which is not the same
  // as never having signed in.
  const [sessionEnded, setSessionEnded] = useState(false);
  // The session ended while the ledger was open (signed out in another tab, or it ran out). The
  // records on screen stay, but nothing will refresh until the member signs in again.
  const [sessionExpired, setSessionExpired] = useState(false);

  const commitState = useCallback((incoming: LedgerState) => {
    const next = mergeLedgerState(stateRef.current, incoming);
    stateRef.current = next;
    setState(next);
  }, []);

  /** A refresh failed after the ledger was open. A 401 means the session is gone, which waiting
   * will not fix, so it gets its own notice (a way to sign in) instead of the paused-updates line. */
  const refreshFailed = useCallback((reason: unknown, message: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      setSessionExpired(true);
      setError('');
    } else setError(message);
  }, []);

  const refresh = useCallback(async () => {
    if (demo) return;
    const sequence = ++refreshSequence.current;
    try {
      const incoming = await api.ledger();
      if (sequence === refreshSequence.current) {
        commitState(incoming);
        setError('');
        setSessionExpired(false);
      }
    } catch (reason) {
      if (sequence === refreshSequence.current)
        refreshFailed(reason, 'Updates are paused. Your saved changes remain on record.');
      throw reason;
    }
  }, [demo, commitState, refreshFailed]);

  const retry = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    setAttempt((count) => count + 1);
  }, []);

  const dismissStorageWarning = useCallback(() => {
    standingWarning.current = '';
    setStorageWarning('');
  }, []);
  const storageRecovered = useCallback(() => setStorageWarning(standingWarning.current), []);

  useEffect(() => {
    let mounted = true;
    // Session and ledger fail for different reasons, so each gets its own answer: a 401 means signed
    // out, anything else that is not a success means "try again".
    async function loadShared() {
      try {
        const config = await api.config();
        // An answer that is not a config at all (an error page, say) says nothing about sign-in.
        if (typeof config?.configured !== 'boolean') throw new Error('Unexpected config answer');
        if (!mounted) return;
        setConfigStatus(config.configured ? 'ready' : 'unconfigured');
        if (!config.configured) return;
      } catch {
        if (!mounted) return;
        setConfigStatus('unreachable');
        setLoadFailed(true);
        return;
      }
      let member: Member;
      try {
        member = (await api.session()).member;
      } catch (reason) {
        if (!mounted) return;
        if (reason instanceof ApiError && reason.status === 401) setSessionEnded(hadSession());
        else setLoadFailed(true);
        return;
      }
      if (!mounted) return;
      rememberSession();
      setSessionEnded(false);
      setSessionMember(member);
      setMemberId(member.id);
      try {
        const loaded = await api.ledger();
        if (mounted) commitState(loaded);
      } catch (reason) {
        if (!mounted) return;
        if (reason instanceof ApiError && reason.status === 401) {
          // The session ended between the two requests, so this visitor is signed out after all.
          setSessionMember(undefined);
          setMemberId('');
          setSessionEnded(true);
        } else setLoadFailed(true);
      }
    }
    async function load() {
      try {
        if (demo) {
          const initial = await demoLock(storageKey, () => {
            const storage = browserStorage();
            // The sample ledger is the fallback here, and it is saved over whatever could not be read.
            const loaded = readDemoState(storage, storageKey, createDemoState(), { sample: true });
            // Persist initial UUIDs under the mutation lock so other tabs
            // start from the same records, including during React StrictMode.
            try {
              if (!storage) throw new Error('Storage unavailable');
              storage.setItem(storageKey, JSON.stringify(loaded.state));
            } catch {
              loaded.warning =
                'Browser storage is unavailable. Demo changes will last for this visit.';
            }
            return loaded;
          });
          if (mounted) {
            commitState(initial.state);
            setMemberId(initial.state.members[0].id);
            standingWarning.current = !navigator.locks?.request
              ? 'This browser cannot coordinate demo tabs. Use one tab to avoid conflicting changes.'
              : '';
            setStorageWarning(initial.warning || standingWarning.current);
          }
        } else await loadShared();
      } catch {
        if (mounted) setLoadFailed(true);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [demo, storageKey, commitState, attempt]);

  useEffect(() => {
    if (!demo) return;
    const sync = (event: StorageEvent) => {
      syncStorageEvent({
        event,
        key: storageKey,
        commit: commitState,
        onWarning: setStorageWarning,
        onRecovered: storageRecovered,
      });
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [demo, storageKey, commitState, storageRecovered]);

  useEffect(() => {
    if (demo || !state) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [demo, !!state, refresh]);

  async function changeDemo<T>(change: (current: LedgerState) => Change<T>): Promise<T> {
    return demoLock(storageKey, () => {
      const current = stateRef.current;
      if (!current) throw new Error('Open the ledger before changing a record.');
      return runDemoChange({
        storage: browserStorage(),
        key: storageKey,
        current,
        change,
        commit: commitState,
        onWarning: setStorageWarning,
        onRecovered: storageRecovered,
      });
    });
  }

  async function changeRemote<T>(mutate: () => Promise<T>, commit: (value: T) => void): Promise<T> {
    try {
      return await commitRemoteChange(mutate, commit, refresh, (reason) =>
        refreshFailed(reason, 'Your change was saved. Other updates are temporarily unavailable.'),
      );
    } catch (reason) {
      await refresh().catch(() => {});
      throw reason;
    }
  }

  async function addBet(input: NewBet): Promise<Bet> {
    if (!stateRef.current) throw new Error('Open the ledger before creating a bet.');
    if (!demo)
      return changeRemote(
        () => api.createBet(input),
        (bet) => {
          const current = stateRef.current;
          if (current) commitState(withBet(current, bet));
        },
      );
    return changeDemo((current) => {
      const result = createBet(input, memberId, current.members, undefined, 'browser');
      return { state: withBet(current, result), result };
    });
  }

  async function act(bet: Bet, action: BetAction) {
    if (!stateRef.current) throw new Error('Open the ledger before changing a bet.');
    if (demo)
      await changeDemo((current) => updateDemoBet(current, bet.id, bet.version, action, memberId));
    else
      await changeRemote(
        () => api.action(bet, action),
        (next) => {
          const current = stateRef.current;
          if (current) commitState(withBet(current, next));
        },
      );
  }

  async function offsetDebts(input: DebtOffsetPreview) {
    if (demo) {
      await changeDemo((current) => {
        const result = applyDebtOffset(current.bets, input, memberId);
        return { state: result.bets.reduce(withBet, current), result };
      });
    } else {
      await changeRemote(
        () => api.offsetDebts(input),
        (result) => {
          const current = stateRef.current;
          if (current) commitState(result.bets.reduce(withBet, current));
        },
      );
    }
  }

  async function addDemoMember(name: string): Promise<Member> {
    if (!demo || !stateRef.current)
      throw new Error('Use a member invitation to add someone to the shared ledger.');
    return changeDemo((current) => appendDemoMember(current, name));
  }

  async function updateProfile(name: string): Promise<Member> {
    if (!stateRef.current || !memberId)
      throw new Error('Open the ledger before updating your profile.');
    const withMember = (current: LedgerState, member: Member): LedgerState => ({
      ...current,
      members: current.members.map((item) => (item.id === member.id ? member : item)),
    });
    if (!demo)
      return changeRemote(
        async () => (await api.updateProfile(name)).member,
        (member) => {
          // A read started before this save may still carry the old name.
          refreshSequence.current += 1;
          setSessionMember(member);
          const current = stateRef.current;
          if (current) commitState(withMember(current, member));
        },
      );
    return changeDemo((current) => {
      const member = current.members.find((item) => item.id === memberId);
      if (!member) throw new Error('Your profile could not be found.');
      const problem = memberNameProblem(
        name,
        current.members.filter((item) => item.id !== memberId),
      );
      if (problem) throw new Error(problem);
      const cleanName = normalizeMemberName(name);
      const result = { ...member, name: cleanName, initials: initialsFor(cleanName) };
      return { state: withMember(current, result), result };
    });
  }

  /** The ledger's reasons for refusing demo input, in the words its schemas use. */
  function demoInput<T>(
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
    },
    input: unknown,
  ): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error(parsed.error.issues[0]?.message ?? 'Check the information you entered.');
    return parsed.data;
  }

  /** The ledger's question about an unusual price, in the form the price dialog asks it. */
  const unusualPrice = (reason: unknown) => {
    const warnings =
      reason instanceof ApiError && reason.status === 422
        ? (reason.body as { warnings?: PriceWarning[] } | undefined)?.warnings
        : undefined;
    return warnings?.length ? new UnusualPriceError(warnings) : reason;
  };
  /** The ledger already has this visit from the member: say which report, so it can be named. */
  const duplicateOrUnusual = (reason: unknown) => {
    const existing =
      reason instanceof ApiError && reason.status === 409
        ? (reason.body as { existing?: PriceObservation } | undefined)?.existing
        : undefined;
    return existing ? new DuplicatePriceError(existing) : unusualPrice(reason);
  };

  /** Records a price, and the restaurant it names when that is new, as one change. */
  async function addPriceObservation(input: PriceReportInput): Promise<PriceReportResult> {
    if (!stateRef.current) throw new Error('Open the ledger before recording a price.');
    if (!demo)
      return changeRemote(
        () =>
          api.createPriceObservation(input).catch((reason: unknown) => {
            throw duplicateOrUnusual(reason);
          }),
        (result) => {
          const current = stateRef.current;
          if (current) commitState(withPriceReport(current, result));
        },
      );
    const { demoPriceReportSchema } = await demoSchemas();
    return changeDemo((current) => {
      const plan = planPriceReport({
        input: demoInput(demoPriceReportSchema, input),
        reporterId: memberId,
        restaurants: current.restaurants ?? [],
        observations: current.priceObservations ?? [],
        newId: () => crypto.randomUUID(),
        now: new Date().toISOString(),
      });
      if (plan.kind === 'unknown-restaurant')
        throw new Error('Choose a restaurant from the ledger.');
      if (plan.kind === 'conflict') throw new DuplicatePriceError(plan.existing);
      if (plan.kind === 'unusual') throw new UnusualPriceError(plan.warnings);
      if (plan.kind === 'repeat') return { state: current, result: plan.result };
      return { state: withPriceReport(current, plan.result), result: plan.result };
    });
  }

  async function correctPriceObservation(
    id: string,
    input: PriceCorrectionInput,
  ): Promise<PriceCorrectionResult> {
    if (!stateRef.current) throw new Error('Open the ledger before correcting a price.');
    if (!demo)
      return changeRemote(
        () =>
          api.correctPriceObservation(id, input).catch((reason: unknown) => {
            throw duplicateOrUnusual(reason);
          }),
        (result) => {
          const current = stateRef.current;
          if (current) commitState(withPriceCorrection(current, result));
        },
      );
    const { demoPriceObservationSchema } = await demoSchemas();
    return changeDemo((current) => {
      const parsed = demoInput(demoPriceObservationSchema, input);
      const original = current.priceObservations?.find((item) => item.id === id);
      if (!original) throw new Error('That price report could not be found.');
      if (original.reporterId !== memberId)
        throw new Error('Only your own price reports can be corrected.');
      if (original.correctedAt) throw new Error('That price report has already been corrected.');
      if (original.withdrawnAt) throw new Error('That price report has been withdrawn.');
      if (!current.restaurants?.some((item) => item.id === parsed.restaurantId))
        throw new Error('Choose a restaurant from the ledger.');
      if (correctionChangesNothing(original, parsed))
        throw new Error(
          'This correction changes nothing. Change the restaurant, price, item, date or note first.',
        );
      const duplicate = correctionDuplicate(current.priceObservations ?? [], original, parsed);
      if (duplicate) throw new DuplicatePriceError(duplicate.existing);
      const { confirmUnusualPrice, confirmSeparateReport: _separate, ...fields } = parsed;
      if (!confirmUnusualPrice && fields.priceCents !== original.priceCents) {
        const series = sameSeries(
          current.priceObservations ?? [],
          fields.restaurantId,
          fields.itemName,
        ).filter((item) => item.id !== original.id);
        const warnings = plausibility(fields.priceCents, series);
        if (warnings.length) throw new UnusualPriceError(warnings);
      }
      const correctedAt = new Date().toISOString();
      const observation: PriceObservation = {
        id: crypto.randomUUID(),
        ...fields,
        currency: 'USD',
        reporterId: memberId,
        reportedAt: correctedAt,
        correctedFromId: original.id,
      };
      const result = { observation, corrected: { ...original, correctedAt } };
      return { state: withPriceCorrection(current, result), result };
    });
  }

  /** Withdraws one of the member's own reports, with a reason; it stays on record. */
  async function withdrawPriceObservation(
    id: string,
    reason: string,
  ): Promise<PriceWithdrawalResult> {
    if (!stateRef.current) throw new Error('Open the ledger before withdrawing a price.');
    if (!demo)
      return changeRemote(
        () => api.withdrawPriceObservation(id, reason),
        (result) => {
          const current = stateRef.current;
          if (current) commitState(withPriceWithdrawal(current, result));
        },
      );
    const { priceWithdrawalSchema } = await demoSchemas();
    return changeDemo((current) => {
      const parsed = demoInput(priceWithdrawalSchema, { reason });
      const report = current.priceObservations?.find((item) => item.id === id);
      if (!report) throw new Error('That price report could not be found.');
      if (report.reporterId !== memberId)
        throw new Error('Only the member who reported a price can withdraw it.');
      if (report.withdrawnAt) throw new Error('That price report has already been withdrawn.');
      if (report.correctedAt) throw new Error('That price report has already been corrected.');
      const result = {
        observation: {
          ...report,
          withdrawnAt: new Date().toISOString(),
          withdrawnReason: parsed.reason,
        },
      };
      return { state: withPriceWithdrawal(current, result), result };
    });
  }

  return {
    state,
    memberId,
    setMemberId,
    // The session's word stands in only while the ledger has not opened; once it has, the roster decides.
    member: state ? state.members.find((member) => member.id === memberId) : sessionMember,
    demo,
    loading,
    configStatus,
    // Unknown counts as set up: only the server saying otherwise disables sign-in.
    configured: configStatus !== 'unconfigured',
    loadFailed,
    sessionEnded,
    sessionExpired,
    retry,
    error,
    storageWarning,
    dismissStorageWarning,
    addBet,
    act,
    offsetDebts,
    addDemoMember,
    updateProfile,
    addPriceObservation,
    correctPriceObservation,
    withdrawPriceObservation,
    refresh,
  };
}
