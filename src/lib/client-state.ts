import { avatarColorFor, initialsFor } from './avatar-colors';
import { applyAction } from './ledger';
import { memberNameProblem, normalizeMemberName } from './member-name';
import type {
  Bet,
  BetAction,
  LedgerState,
  Member,
  PriceCorrectionResult,
  PriceObservation,
  PriceWithdrawalResult,
  Restaurant,
} from './types';

export interface DemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface Change<T> {
  state: LedgerState;
  result: T;
}

export function demoStorageKey(search: string): string {
  const session = new URLSearchParams(search).get('demoSession');
  const base = 'lobster-ledger-demo-v1';
  return session && /^[a-zA-Z0-9_-]{1,40}$/.test(session) ? `${base}:${session}` : base;
}

/** Records are append-only. A slow snapshot must never remove a new record
 * or replace a newer approval history with an earlier version. */
export function mergeLedgerState(current: LedgerState | null, incoming: LedgerState): LedgerState {
  if (!current) return incoming;
  const bets = new Map(current.bets.map((bet) => [bet.id, bet]));
  for (const bet of incoming.bets) {
    const previous = bets.get(bet.id);
    if (!previous || bet.version > previous.version) bets.set(bet.id, bet);
  }
  const members = new Map(
    [...current.members, ...incoming.members].map((member) => [member.id, member]),
  );
  const places = new Map([...current.places, ...incoming.places].map((place) => [place.id, place]));
  const restaurants = new Map(
    [...(current.restaurants ?? []), ...(incoming.restaurants ?? [])].map((restaurant) => [
      restaurant.id,
      restaurant,
    ]),
  );
  // A report's stamps only ever go from empty to set, so a snapshot read before a correction or a
  // withdrawal cannot take one back.
  const priceObservations = new Map<string, PriceObservation>();
  for (const observation of [
    ...(current.priceObservations ?? []),
    ...(incoming.priceObservations ?? []),
  ]) {
    const previous = priceObservations.get(observation.id);
    priceObservations.set(
      observation.id,
      previous
        ? {
            ...observation,
            ...(!observation.correctedAt &&
              previous.correctedAt && { correctedAt: previous.correctedAt }),
            ...(!observation.withdrawnAt &&
              previous.withdrawnAt && {
                withdrawnAt: previous.withdrawnAt,
                withdrawnReason: previous.withdrawnReason,
              }),
          }
        : observation,
    );
  }
  return {
    ...incoming,
    bets: [...bets.values()],
    members: [...members.values()],
    places: [...places.values()],
    restaurants: [...restaurants.values()],
    priceObservations: [...priceObservations.values()],
  };
}

export function withBet(state: LedgerState, bet: Bet): LedgerState {
  return mergeLedgerState(state, {
    ...state,
    bets: [bet],
    places: bet.location ? [bet.location] : [],
  });
}

export function withRestaurant(state: LedgerState, restaurant: Restaurant): LedgerState {
  return {
    ...state,
    restaurants: [
      ...(state.restaurants ?? []).filter((item) => item.id !== restaurant.id),
      restaurant,
    ],
  };
}

export function withPriceObservation(
  state: LedgerState,
  observation: PriceObservation,
): LedgerState {
  return {
    ...state,
    priceObservations: [
      ...(state.priceObservations ?? []).filter((item) => item.id !== observation.id),
      observation,
    ],
  };
}

/** A new report and its restaurant, which may be new too, applied together. */
export function withPriceReport(
  state: LedgerState,
  { observation, restaurant }: { observation: PriceObservation; restaurant: Restaurant },
): LedgerState {
  // A restaurant already listed keeps its place in the list.
  const known = state.restaurants?.some((item) => item.id === restaurant.id);
  return withPriceObservation(known ? state : withRestaurant(state, restaurant), observation);
}

export function withPriceCorrection(
  state: LedgerState,
  result: PriceCorrectionResult,
): LedgerState {
  return {
    ...state,
    priceObservations: [
      ...(state.priceObservations ?? []).map((item) =>
        item.id === result.corrected.id ? result.corrected : item,
      ),
      result.observation,
    ],
  };
}

/** A report its reporter withdrew: it stays in the ledger, stamped, and leaves every figure. */
export function withPriceWithdrawal(
  state: LedgerState,
  { observation }: PriceWithdrawalResult,
): LedgerState {
  return {
    ...state,
    priceObservations: (state.priceObservations ?? []).map((item) =>
      item.id === observation.id ? observation : item,
    ),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringFields = (value: Record<string, unknown>, fields: string[]) =>
  fields.every((field) => typeof value[field] === 'string');
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseDemoState(raw: string): LedgerState {
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    typeof value.groupName !== 'string' ||
    !value.groupName.trim() ||
    !Array.isArray(value.members) ||
    !value.members.length ||
    !value.members.every(
      (member) =>
        record(member) &&
        stringFields(member, ['id', 'name', 'initials', 'color']) &&
        !!(member.name as string).trim(),
    ) ||
    !Array.isArray(value.places) ||
    !value.places.every(
      (place) =>
        record(place) &&
        stringFields(place, ['id', 'name', 'address']) &&
        Number.isFinite(place.lat) &&
        Number.isFinite(place.lng),
    ) ||
    (value.restaurants !== undefined &&
      (!Array.isArray(value.restaurants) ||
        !value.restaurants.every(
          (restaurant) =>
            record(restaurant) &&
            stringFields(restaurant, ['id', 'name', 'address']) &&
            (restaurant.lat === undefined || Number.isFinite(restaurant.lat)) &&
            (restaurant.lng === undefined || Number.isFinite(restaurant.lng)),
        ))) ||
    (value.priceObservations !== undefined &&
      (!Array.isArray(value.priceObservations) ||
        !value.priceObservations.every(
          (observation) =>
            record(observation) &&
            stringFields(observation, [
              'id',
              'restaurantId',
              'itemName',
              'currency',
              'visitDate',
              'visitDatePrecision',
              'reporterId',
              'reportedAt',
            ]) &&
            observation.currency === 'USD' &&
            Number.isInteger(observation.priceCents) &&
            (observation.priceCents as number) > 0 &&
            ['correctionReason', 'withdrawnAt', 'withdrawnReason'].every(
              (field) => observation[field] === undefined || typeof observation[field] === 'string',
            ) &&
            (observation.withdrawnAt === undefined) ===
              (observation.withdrawnReason === undefined) &&
            [undefined, 'web', 'mcp'].includes(observation.entrySource as string | undefined),
        ))) ||
    !Array.isArray(value.bets) ||
    !value.bets.every(
      (bet) =>
        record(bet) &&
        stringFields(bet, [
          'id',
          'reference',
          'title',
          'terms',
          'category',
          'creatorId',
          'opponentId',
          'creatorSide',
          'opponentSide',
          'deadline',
          'createdAt',
          'updatedAt',
        ]) &&
        [
          'pending',
          'active',
          'confirming',
          'owed',
          'settling',
          'settled',
          'voided',
          'declined',
        ].includes(bet.status as string) &&
        Number.isInteger(bet.version) &&
        (bet.version as number) > 0 &&
        Number.isInteger(bet.stake) &&
        (bet.stake as number) > 0 &&
        strings(bet.agreementApprovals) &&
        Array.isArray(bet.events) &&
        bet.events.every(
          (event) =>
            record(event) && stringFields(event, ['id', 'at', 'actorId', 'type', 'detail']),
        ) &&
        (bet.resolution === undefined ||
          (record(bet.resolution) && strings(bet.resolution.approvals))) &&
        (bet.settlement === undefined ||
          (record(bet.settlement) && strings(bet.settlement.approvals))),
    )
  ) {
    throw new Error('Saved demo data does not contain a complete ledger.');
  }
  return value as unknown as LedgerState;
}

/** The notice that tells a member to export, so the page can offer the Export button beside it. */
export const STORAGE_FULL_WARNING =
  'Browser storage is full or unavailable. Export your ledger to keep a copy.';

/** `sample` says the fallback is the sample ledger, not records already on screen: when the stored
 * records cannot be read, that is what replaces them, and the notice has to say so. */
export function readDemoState(
  storage: DemoStorage | undefined,
  key: string,
  fallback: LedgerState,
  options: { sample?: boolean } = {},
): { state: LedgerState; warning: string } {
  let raw: string | null;
  try {
    if (!storage) throw new Error('Storage unavailable');
    raw = storage.getItem(key);
  } catch {
    return {
      state: fallback,
      warning: 'Browser storage is unavailable. Demo changes will last for this visit.',
    };
  }
  if (!raw) return { state: fallback, warning: '' };
  try {
    return { state: parseDemoState(raw), warning: '' };
  } catch {
    return {
      state: fallback,
      warning: options.sample
        ? 'Saved demo records could not be read, so the demo started again from the sample ledger.'
        : 'Stored demo records could not be loaded. Your current records are still available.',
    };
  }
}

/** Call inside the browser's Web Lock so read/validate/write is one operation
 * across tabs. A storage failure still returns the new in-memory ledger. */
export function commitDemoChange<T>(
  storage: DemoStorage | undefined,
  key: string,
  current: LedgerState,
  change: (state: LedgerState) => Change<T>,
): Change<T> & { warning: string } {
  const latest = readDemoState(storage, key, current);
  const changed = change(mergeLedgerState(current, latest.state));
  let warning = latest.warning;
  try {
    if (!storage) throw new Error('Storage unavailable');
    storage.setItem(key, JSON.stringify(changed.state));
  } catch {
    warning = STORAGE_FULL_WARNING;
  }
  return { ...changed, warning };
}

export function updateDemoBet(
  state: LedgerState,
  id: string,
  version: number,
  action: BetAction,
  actorId: string,
  now?: string,
): Change<Bet> {
  const current = state.bets.find((bet) => bet.id === id);
  if (!current) throw new Error('This bet could not be found. Refresh the ledger and try again.');
  if (current.version !== version)
    throw new Error(
      'This bet changed since you opened it. Review the refreshed record and try again.',
    );
  const result = applyAction(current, action, actorId, now);
  return { state: withBet(state, result), result };
}

/** Run a remote mutation, commit its result, then refresh. A failed refresh
 * must never discard the committed record, so the caller decides how to report it. */
export async function commitRemoteChange<T>(
  mutate: () => Promise<T>,
  commit: (value: T) => void,
  refresh: () => Promise<void>,
  onRefreshFailed: (reason: unknown) => void,
): Promise<T> {
  const result = await mutate();
  commit(result);
  try {
    await refresh();
  } catch (reason) {
    onRefreshFailed(reason);
  }
  return result;
}

/** Run one demo mutation inside the caller's lock: commit through storage and
 * report the change. On failure, reload the latest stored ledger so the caller
 * can retry with current records, then rethrow. */
export function runDemoChange<T>(options: {
  storage: DemoStorage | undefined;
  key: string;
  current: LedgerState;
  change: (state: LedgerState) => Change<T>;
  commit: (state: LedgerState) => void;
  onWarning: (warning: string) => void;
  /** The change was saved with nothing to warn about, so an earlier warning no longer holds. */
  onRecovered?: () => void;
}): T {
  const { storage, key, current } = options;
  try {
    const changed = commitDemoChange(storage, key, current, options.change);
    options.commit(changed.state);
    if (changed.warning) options.onWarning(changed.warning);
    else options.onRecovered?.();
    return changed.result;
  } catch (reason) {
    // Reject stale actions but reload the record for an informed retry.
    const latest = readDemoState(storage, key, current);
    options.commit(latest.state);
    if (latest.warning) options.onWarning(latest.warning);
    throw reason;
  }
}

/** Merge an update written by another demo tab, or report a warning when its
 * records cannot be loaded. Events for other keys or tab removals are ignored. */
export function syncStorageEvent(options: {
  event: { key: string | null; newValue: string | null };
  key: string;
  commit: (state: LedgerState) => void;
  onWarning: (warning: string) => void;
  /** A readable update arrived, so an earlier warning about an unreadable one no longer holds. */
  onRecovered?: () => void;
}): void {
  const { event } = options;
  if (event.key !== options.key || !event.newValue) return;
  try {
    options.commit(parseDemoState(event.newValue));
    options.onRecovered?.();
  } catch {
    options.onWarning(
      'An update from another demo tab could not be loaded. Your current records are still available.',
    );
  }
}

export function appendDemoMember(state: LedgerState, name: string): Change<Member> {
  const problem = memberNameProblem(name, state.members);
  if (problem) throw new Error(problem);
  const cleanName = normalizeMemberName(name);
  const id = crypto.randomUUID();
  const result: Member = {
    id,
    name: cleanName,
    initials: initialsFor(cleanName),
    color: avatarColorFor(
      id,
      state.members.map((member) => member.color),
    ),
  };
  return { state: { ...state, members: [...state.members, result] }, result };
}
