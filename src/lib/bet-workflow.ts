import type {
  Bet,
  BetStatus,
  DecisionTiming,
  HistoricalDate,
  HistoricalInput,
  HistoryAcknowledgements,
  HistoryRevision,
  NewBet,
  Place,
  ZonedDateTime,
} from './types';
import { LIMITS, type TextLimit } from './limits';
import { getOffsetRolls, getRemainingRolls } from './rolls';

// Characters that take up no room on screen: zero-width space, non-joiner and joiner, the word
// joiner and a byte-order mark. They look like nothing, so they must count for nothing.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const EDGE_SPACE = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

/** Member-entered text without the whitespace and zero-width characters around it. */
export const trimText = (value: string) => value.replace(EDGE_SPACE, '');

/** How many characters of this text show: zero-width characters count for nothing. */
export const visibleLength = (value: string) => value.replace(ZERO_WIDTH, '').trim().length;

/**
 * Trims a member-entered string and enforces a shared limit on it. A minimum counts what shows, so
 * padding of any kind never satisfies it; a maximum counts everything stored, so it cannot swell.
 */
export function boundedText(value: unknown, label: string, limit: TextLimit): string {
  const trimmed = typeof value === 'string' ? trimText(value) : '';
  if (typeof value !== 'string' || visibleLength(trimmed) < limit.min || trimmed.length > limit.max)
    throw new Error(`${label} must contain between ${limit.min} and ${limit.max} characters.`);
  return trimmed;
}
const text = (value: unknown, label: string, max: number): string =>
  boundedText(value, label, { min: 1, max });

/**
 * Case-, spacing- and width-insensitive comparison key for member-entered text, so two things that
 * look the same on screen (stray zero-width characters, full-width letters) compare as the same.
 */
export const textKey = (value: string) =>
  value.normalize('NFKC').replace(ZERO_WIDTH, '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The latest calendar day it currently is anywhere on Earth (UTC+14). */
export function latestCalendarDay(now: string | Date | number): string {
  return new Date(new Date(now).getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function validateHistoricalDate(value: HistoricalDate): HistoricalDate {
  if (!value || !['day', 'month', 'year', 'unknown'].includes(value.precision))
    throw new Error('Choose a valid historical date precision.');
  if (value.precision === 'unknown') return { precision: 'unknown' };
  if (typeof value.value !== 'string') throw new Error('Choose a valid historical date.');
  const candidate =
    value.precision === 'year'
      ? `${value.value}-01-01`
      : value.precision === 'month'
        ? `${value.value}-01`
        : value.value;
  if (!validDay(candidate)) throw new Error('Choose a valid historical date.');
  return { precision: value.precision, value: value.value };
}

export function validateZonedDateTime(value: ZonedDateTime): ZonedDateTime {
  if (
    !value ||
    typeof value.at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at) ||
    !validDay(value.at.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value.at))
  )
    throw new Error('Choose a valid date and time with an explicit timezone offset.');
  const timezone = text(value.timezone, 'Timezone', 100);
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error('Choose a valid named timezone.');
  }
  return { at: new Date(value.at).toISOString(), timezone: canonical };
}

export function validateTiming(value: DecisionTiming): DecisionTiming {
  if (!value || !['date', 'event', 'evidence'].includes(value.kind))
    throw new Error('Choose valid decision timing.');
  const source =
    value.source === undefined ? undefined : text(value.source, 'Expected evidence source', 500);
  const checkIn = value.checkIn === undefined ? undefined : validateZonedDateTime(value.checkIn);
  const optional = { ...(source ? { source } : {}), ...(checkIn ? { checkIn } : {}) };
  return value.kind === 'date'
    ? { kind: 'date', ...validateZonedDateTime(value), ...optional }
    : {
        kind: value.kind,
        description: text(value.description, 'Decision event or evidence', 2000),
        ...optional,
      };
}

export function validateAcknowledgements(
  history: HistoricalInput,
  value: HistoryAcknowledgements | undefined,
): HistoryAcknowledgements {
  if (
    !value ||
    typeof value.terms !== 'boolean' ||
    typeof value.result !== 'boolean' ||
    typeof value.delivery !== 'boolean' ||
    value.terms !== true ||
    (history.stage !== 'active' && value.result !== true) ||
    (history.stage === 'settled' && value.delivery !== true)
  )
    throw new Error(
      'Explicitly acknowledge the historical terms, applicable result, and actual delivery.',
    );
  return { terms: value.terms, result: value.result, delivery: value.delivery };
}

/** A part of a reported past bet, as a path into its HistoricalInput. */
export type HistoryField =
  | 'stage'
  | 'originalDate'
  | 'result.winnerId'
  | 'result.date'
  | 'result.note'
  | 'delivery.date'
  | 'delivery.note'
  | 'previousAdjudication.method'
  | 'previousAdjudication.note'
  | 'previousAdjudication.sourceUrl';

/** A refused reported history, naming the part that is wrong so a form can say it there. */
export class HistoryFieldError extends Error {
  readonly field: HistoryField;
  constructor({ field, message }: { field: HistoryField; message: string }) {
    super(message);
    this.name = 'HistoryFieldError';
    this.field = field;
  }
}

export type HistoryDateField = 'originalDate' | 'result.date' | 'delivery.date';

/** What each date of a reported past bet says when it is unreadable or in the future. */
export function historyDateMessages(
  field: HistoryDateField,
  stage: HistoricalInput['stage'],
): { when: string; future: string; invalid: Record<HistoricalDate['precision'], string> } {
  const when =
    field === 'originalDate'
      ? 'when the bet was made'
      : field === 'delivery.date'
        ? 'when the rolls were delivered'
        : stage === 'voided'
          ? 'when it was called off'
          : 'when the outcome was decided';
  const happened =
    field === 'originalDate'
      ? 'The bet can’t have been made'
      : field === 'delivery.date'
        ? 'The rolls can’t have been delivered'
        : stage === 'voided'
          ? 'The bet can’t have been called off'
          : 'The outcome can’t have been decided';
  return {
    when,
    future: `${happened} in the future. Choose a date up to today.`,
    invalid: {
      day: `Choose the full date for ${when}.`,
      month: `Enter the month for ${when} as year and month, such as 2024-03.`,
      year: `Enter the year for ${when} as four digits, such as 2024.`,
      unknown: `Choose how well you remember ${when}.`,
    },
  };
}

const monthNames = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * A typed month in the forms people write it ("March 2024", "3/2024", "2024-3") as the stored
 * YYYY-MM, for browsers that show a month field as plain text. Anything else is left as typed.
 */
export function normaliseHistoricalMonth(value: string): string {
  const typed = value.trim();
  const pad = (month: number) => String(month).padStart(2, '0');
  let match = /^(\d{4})[-/.](\d{1,2})$/.exec(typed);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12)
    return `${match[1]}-${pad(Number(match[2]))}`;
  match = /^(\d{1,2})[-/.](\d{4})$/.exec(typed);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12)
    return `${match[2]}-${pad(Number(match[1]))}`;
  match = /^([a-z]{3,})\.?,?\s+(\d{4})$/i.exec(typed);
  const word = match?.[1].toLowerCase() ?? '';
  const month = match ? monthNames.findIndex((name) => name.startsWith(word)) : -1;
  if (match && month >= 0) return `${match[2]}-${pad(month + 1)}`;
  return typed;
}

function historicalInterval(date: HistoricalDate): { start: number; end: number } | undefined {
  if (date.precision === 'unknown') return undefined;
  const first =
    date.precision === 'year'
      ? `${date.value}-01-01`
      : date.precision === 'month'
        ? `${date.value}-01`
        : date.value;
  const start = Date.parse(`${first}T00:00:00.000Z`);
  const end = new Date(start);
  if (date.precision === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else if (date.precision === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + 1);
  return { start, end: end.getTime() - 1 };
}

/** The first day a reported date could be: the day itself, or the first of its month or year. */
export function historyDateStart(date: HistoricalDate): string | undefined {
  if (!date || date.precision === 'unknown') return undefined;
  const first =
    date.precision === 'year'
      ? `${date.value}-01-01`
      : date.precision === 'month'
        ? `${date.value}-01`
        : date.value;
  return typeof date.value === 'string' && validDay(first) ? first : undefined;
}

/** What a date says when it falls before the stage ahead of it (the outcome before the bet). */
export function historyOrderMessage(
  field: HistoryDateField,
  earlier: HistoryDateField,
  stage: HistoricalInput['stage'],
): string {
  const called = stage === 'voided';
  const before: Record<HistoryDateField, string> = {
    originalDate: 'the bet was made',
    'result.date': called ? 'it was called off' : 'the outcome was decided',
    'delivery.date': 'the rolls were delivered',
  };
  const subject: Record<HistoryDateField, string> = {
    originalDate: 'The bet can’t be made',
    'result.date': called ? 'The bet can’t be called off' : 'The outcome can’t be decided',
    'delivery.date': 'The rolls can’t be delivered',
  };
  return `${subject[field]} before ${before[earlier]}.`;
}

/** Validates a reported past bet; a refusal is a HistoryFieldError naming the part to fix. */
export function validateHistory(
  value: HistoricalInput,
  participants: string[],
  now?: string,
  today = now === undefined ? undefined : latestCalendarDay(now),
): HistoricalInput {
  const fail = (field: HistoryField, message: string): never => {
    throw new HistoryFieldError({ field, message });
  };
  const within = <T>(field: HistoryField, read: () => T): T => {
    try {
      return read();
    } catch (reason) {
      return fail(field, reason instanceof Error ? reason.message : 'Check this part.');
    }
  };
  if (!value || !['active', 'owed', 'settled', 'voided'].includes(value.stage))
    fail('stage', 'Choose a valid historical stage.');
  const dated = (field: HistoryDateField, date: HistoricalDate): HistoricalDate => {
    try {
      return validateHistoricalDate(date);
    } catch {
      const { invalid } = historyDateMessages(field, value.stage);
      return fail(field, invalid[date && date.precision in invalid ? date.precision : 'unknown']);
    }
  };
  const result: HistoricalInput = {
    stage: value.stage,
    originalDate: dated('originalDate', value.originalDate),
  };
  if (value.stage === 'active') {
    if (
      value.result !== undefined ||
      value.delivery !== undefined ||
      value.previousAdjudication !== undefined
    )
      fail('stage', 'Ongoing history cannot report a completed result or delivery.');
  } else {
    if (
      !value.result ||
      (value.stage === 'voided'
        ? value.result.winnerId !== null
        : !value.result.winnerId || !participants.includes(value.result.winnerId))
    )
      fail(
        'result.winnerId',
        'Historical results must name an original bettor, or no winner for a called-off bet.',
      );
    const reported = value.result!;
    result.result = {
      winnerId: reported.winnerId,
      date: dated('result.date', reported.date),
      note: within('result.note', () => text(reported.note, 'Historical result note', 2000)),
    };
  }
  if (value.stage === 'settled') {
    if (!value.delivery) fail('delivery.note', 'Report delivery of the actual lobster rolls.');
    const delivery = value.delivery!;
    result.delivery = {
      date: dated('delivery.date', delivery.date),
      note: within('delivery.note', () => text(delivery.note, 'Actual delivery note', 2000)),
    };
  } else if (value.delivery !== undefined)
    fail('stage', 'Only delivered history can include delivery.');
  if (value.previousAdjudication !== undefined) {
    const previous = value.previousAdjudication;
    if (!previous || !['judge', 'chatgpt'].includes(previous.method))
      fail('previousAdjudication.method', 'Choose a valid reported adjudication method.');
    let sourceUrl: string | undefined;
    if (previous.sourceUrl !== undefined) {
      const link = within('previousAdjudication.sourceUrl', () =>
        text(previous.sourceUrl, 'Reported evidence link', 500),
      );
      let url: URL | undefined;
      try {
        url = new URL(link);
      } catch {
        url = undefined;
      }
      if (!url || url.protocol !== 'https:' || url.username || url.password)
        fail(
          'previousAdjudication.sourceUrl',
          'Use an HTTPS link for the reported evidence, one that starts with https://.',
        );
      sourceUrl = link;
    }
    result.previousAdjudication = {
      method: previous.method,
      note: within('previousAdjudication.note', () =>
        text(previous.note, 'Reported adjudication note', 2000),
      ),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  const dates: [HistoryDateField, ReturnType<typeof historicalInterval>][] = [
    ['originalDate', historicalInterval(result.originalDate)],
  ];
  if (result.result) dates.push(['result.date', historicalInterval(result.result.date)]);
  if (result.delivery) dates.push(['delivery.date', historicalInterval(result.delivery.date)]);
  // A date is only certainly in the future once it is past the latest calendar day anywhere.
  for (const [field, date] of dates)
    if (today && date && new Date(date.start).toISOString().slice(0, 10) > today)
      fail(field, historyDateMessages(field, result.stage).future);
  for (let index = 0; index < dates.length; index++) {
    for (let earlier = 0; earlier < index; earlier++) {
      const [field, current] = dates[index];
      const [earlierField, previous] = dates[earlier];
      if (current && previous && current.end < previous.start)
        fail(field, historyOrderMessage(field, earlierField, result.stage));
    }
  }
  return result;
}

export function historyDateLabel(date: HistoricalDate): string {
  if (date.precision === 'unknown') return 'Date unknown';
  if (date.precision === 'year') return date.value;
  const day = date.precision === 'month' ? `${date.value}-01` : date.value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    ...(date.precision === 'day' ? { day: 'numeric' } : {}),
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

export function zonedDateTimeLabel(value: ZonedDateTime): string {
  const shown = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: value.timezone,
    timeZoneName: 'short',
  }).format(new Date(value.at));
  // UTC's abbreviation is its own name, so it is said once; any other zone names its place too.
  return shown.endsWith(` ${value.timezone}`) ? shown : `${shown} (${value.timezone})`;
}

/**
 * The decision timing a bet agreed to. A legacy bet only named a decision date: it reads as that
 * day at 12:00 AM UTC, the same timing the amendment form fills in for it.
 */
export function agreedTiming(bet: {
  timing?: DecisionTiming;
  deadline?: string;
}): DecisionTiming | undefined {
  if (bet.timing) return bet.timing;
  return bet.deadline
    ? { kind: 'date', at: `${bet.deadline}T00:00:00.000Z`, timezone: 'UTC' }
    : undefined;
}

export function decisionTimingLabel(timing: DecisionTiming): string {
  return timing.kind === 'date'
    ? `On or after ${zonedDateTimeLabel(timing)}`
    : `${timing.kind === 'event' ? 'When an event happens:' : 'When evidence is available:'} ${timing.description}`;
}

export const historyStageNames: Record<HistoricalInput['stage'], string> = {
  active: 'Still ongoing',
  owed: 'Decided · rolls owed',
  settled: 'Decided · rolls delivered',
  voided: 'Called off · no winner',
};

/** What a reported past bet comes to, in a sentence: where it stands, who won and what is owed. */
export function historySummary(
  bet: Pick<Bet, 'stake' | 'creatorId' | 'opponentId'>,
  history: Pick<HistoricalInput, 'stage' | 'result'>,
  name: (id: string) => string,
): string {
  const rolls = `${bet.stake} ${bet.stake === 1 ? 'lobster roll' : 'lobster rolls'}`;
  const winnerId = history.result?.winnerId;
  if (history.stage === 'active') return `Still ongoing, with ${rolls} at stake.`;
  if (history.stage === 'voided' || !winnerId)
    return 'Called off with no winner. No rolls are owed.';
  const winner = name(winnerId);
  if (history.stage === 'settled')
    return `${winner} won, and ${
      bet.stake === 1 ? 'the lobster roll was' : `all ${rolls} were`
    } delivered. Nothing is owed.`;
  const loser = name(winnerId === bet.creatorId ? bet.opponentId : bet.creatorId);
  return `${winner} won. ${loser} owes ${winner} ${rolls}.`;
}

/** A place with its pin, so two places of the same name (or a moved pin) read differently. */
export function placeLabel(place: Place): string {
  return `${place.name} (${place.lat.toFixed(4)}, ${place.lng.toFixed(4)})`;
}

/** The parts of a reported past bet that a revision can change, as the bet holds them now. */
export function historyRevisionOf(bet: Bet): HistoryRevision {
  const history = bet.history!;
  return {
    title: bet.title,
    terms: bet.terms,
    category: bet.category,
    creatorSide: bet.creatorSide,
    opponentSide: bet.opponentSide,
    stake: bet.stake,
    ...(bet.deadline ? { deadline: bet.deadline } : {}),
    ...(bet.location ? { location: structuredClone(bet.location) } : {}),
    ...(bet.timing ? { timing: structuredClone(bet.timing) } : {}),
    ...(bet.cutoff ? { cutoff: structuredClone(bet.cutoff) } : {}),
    history: {
      stage: history.stage,
      originalDate: history.originalDate,
      ...(history.result ? { result: history.result } : {}),
      ...(history.delivery ? { delivery: history.delivery } : {}),
      ...(history.previousAdjudication
        ? { previousAdjudication: history.previousAdjudication }
        : {}),
    },
  };
}

/**
 * What replaced the history a revision event recorded: the next revision's starting point, or the
 * bet as it stands. Terms and timing come from before any later amendment, which can change them.
 */
export function historyRevisionAfter(bet: Bet, eventId: string): HistoryRevision | undefined {
  const index = bet.events.findIndex((event) => event.id === eventId);
  if (index < 0 || !bet.events[index].historySnapshot || !bet.history) return undefined;
  const later = bet.events.slice(index + 1);
  const next = later.find((event) => event.historySnapshot)?.historySnapshot;
  if (next) {
    const { proposal: _proposal, ...revision } = next;
    return revision;
  }
  const current = historyRevisionOf(bet);
  const amended = later.find((event) => event.amendmentSnapshot)?.amendmentSnapshot;
  if (!amended) return current;
  delete current.deadline;
  delete current.timing;
  delete current.cutoff;
  return {
    ...current,
    terms: amended.terms,
    ...(amended.deadline ? { deadline: amended.deadline } : {}),
    ...(amended.timing ? { timing: amended.timing } : {}),
    ...(amended.cutoff ? { cutoff: amended.cutoff } : {}),
  };
}

export interface HistoryChange {
  label: string;
  from: string;
  to: string;
}

/** Each part a revision of a reported past bet changed, worded as the records word it. */
export function historyChanges(
  before: HistoryRevision,
  after: HistoryRevision,
  {
    creator = 'Creator',
    opponent = 'Opponent',
    name = (id: string) => id,
  }: { creator?: string; opponent?: string; name?: (id: string) => string } = {},
): HistoryChange[] {
  const none = 'None';
  const parts = (revision: HistoryRevision): [string, string | undefined][] => {
    const { history } = revision;
    const called = history.stage === 'voided';
    const previous = history.previousAdjudication;
    return [
      ['Bet', revision.title],
      ['Category', revision.category],
      ['Stake', String(revision.stake)],
      [`${creator}’s position`, revision.creatorSide],
      [`${opponent}’s position`, revision.opponentSide],
      ['Criteria', revision.terms],
      ['Reported stage', historyStageNames[history.stage]],
      ['Original bet date', historyDateLabel(history.originalDate)],
      [
        'Winner',
        history.result
          ? history.result.winnerId
            ? name(history.result.winnerId)
            : 'No winner'
          : undefined,
      ],
      [
        called ? 'Called off' : 'Decided',
        history.result ? historyDateLabel(history.result.date) : undefined,
      ],
      [called ? 'Reason for no winner' : 'Reported outcome', history.result?.note],
      ['Rolls delivered', history.delivery ? historyDateLabel(history.delivery.date) : undefined],
      ['Delivery details', history.delivery?.note],
      [
        'Previous decision',
        previous
          ? `${previous.method === 'judge' ? 'A judge' : 'ChatGPT'}: ${previous.note}${
              previous.sourceUrl ? ` (${previous.sourceUrl})` : ''
            }`
          : undefined,
      ],
      [
        'Decision date',
        revision.deadline
          ? historyDateLabel({ precision: 'day', value: revision.deadline })
          : undefined,
      ],
      ['Timing', revision.timing ? decisionTimingLabel(revision.timing) : undefined],
      ['Claim cutoff', revision.cutoff ? zonedDateTimeLabel(revision.cutoff) : undefined],
      ['Location', revision.location ? placeLabel(revision.location) : undefined],
    ];
  };
  // Both lists hold the same parts in the same order; a label can differ (Decided, Called off).
  const afterParts = parts(after);
  return parts(before).flatMap(([label, from], index) => {
    const [afterLabel, to] = afterParts[index];
    return (from ?? none) === (to ?? none)
      ? []
      : [{ label: to === undefined ? label : afterLabel, from: from ?? none, to: to ?? none }];
  });
}

/** The bettors who have not given this approval yet, joined for a sentence ("Avery and Blair"). */
export function pendingNames(
  bet: Pick<Bet, 'creatorId' | 'opponentId'>,
  approvals: readonly string[],
  name: (id: string) => string,
): string {
  return [bet.creatorId, bet.opponentId]
    .filter((id) => !approvals.includes(id))
    .map(name)
    .join(' and ');
}

export interface BetReadiness {
  ready: boolean;
  reviewDue?: boolean;
  state: 'waiting' | 'ready' | 'legacy' | 'inactive';
  /** Why the bet is in this state, so labels never have to be parsed. */
  reason?: 'proposal' | 'evidence' | 'date' | 'check-in' | 'cutoff' | 'legacy' | 'timing';
  label: string;
  at?: string;
}

export function betReadiness(
  bet: Bet,
  now: string | Date | number = new Date(),
  memberId?: string,
): BetReadiness {
  if (bet.status !== 'active')
    return { ready: false, state: 'inactive', label: 'Awaiting the current approval step' };
  if (bet.amendment || bet.voidProposal)
    return {
      ready: false,
      state: 'waiting',
      reason: 'proposal',
      label: 'Paused while a proposed change is reviewed',
    };
  const clock = new Date(now).getTime();
  if (bet.readiness)
    return {
      ready: true,
      state: 'ready',
      reason: 'evidence',
      label: 'Evidence is ready for review',
      at: bet.readiness.at,
    };
  if (bet.timing?.kind === 'date' && clock >= Date.parse(bet.timing.at))
    return {
      ready: true,
      state: 'ready',
      reason: 'date',
      label: 'Decision time has arrived',
      at: bet.timing.at,
    };
  // A check-in is a bettor's reminder to look for evidence. The judge is not a bettor: the bettors'
  // shared one says nothing about when the judge can decide, so it never stands in for that date.
  const viewerIsBettor = !memberId || memberId === bet.creatorId || memberId === bet.opponentId;
  const checkIn = !viewerIsBettor
    ? undefined
    : memberId && bet.checkIns && Object.hasOwn(bet.checkIns, memberId)
      ? bet.checkIns[memberId]
      : bet.timing?.checkIn;
  if (checkIn && clock >= Date.parse(checkIn.at))
    return {
      ready: !bet.timing,
      reviewDue: true,
      state: bet.timing ? 'waiting' : 'legacy',
      reason: 'check-in',
      label: 'Time to check for evidence',
      at: checkIn.at,
    };
  if (!bet.timing)
    return {
      ready: true,
      state: 'legacy',
      reason: 'legacy',
      label: 'Ready when both bettors have the evidence',
    };
  // A passed claim cutoff on an event or evidence bet brings it up for review without deciding it.
  const cutoffAt = bet.timing.kind === 'date' ? undefined : bet.cutoff?.at;
  if (cutoffAt && clock >= Date.parse(cutoffAt))
    return {
      ready: false,
      reviewDue: true,
      state: 'waiting',
      reason: 'cutoff',
      label: 'The claim cutoff has passed; check whether the evidence is in',
      at: cutoffAt,
    };
  const nextAt = [bet.timing.kind === 'date' ? bet.timing.at : undefined, checkIn?.at, cutoffAt]
    .filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    ready: false,
    state: 'waiting',
    reason: 'timing',
    label: decisionTimingLabel(bet.timing),
    ...(nextAt ? { at: nextAt } : {}),
  };
}

export interface ReviewStatus {
  /** ready: an outcome can be recorded; due: a check-in or cutoff asks for evidence. */
  tone: 'ready' | 'due' | 'waiting' | 'paused' | 'inactive';
  title: string;
  /** A short line for the timing record, which already shows the agreed condition. */
  hint: string;
  /** A standalone sentence for the next step. */
  detail: string;
}

/** Whether an active bet can be reviewed yet, in words that answer yes, no, due or paused. */
export function reviewStatus(
  bet: Bet,
  now: string | Date | number = new Date(),
  memberId?: string,
): ReviewStatus {
  const readiness = betReadiness(bet, now, memberId);
  const same = (title: string, tone: ReviewStatus['tone'], hint: string, detail = hint) => ({
    tone,
    title,
    hint,
    detail,
  });
  switch (readiness.reason) {
    case undefined:
      return same('Not in review', 'inactive', `${readiness.label}.`);
    case 'proposal':
      return same(
        'Paused',
        'paused',
        'Outcome actions pause while a proposed change is reviewed.',
        'Paused while a proposed change is reviewed. Outcome actions resume once it is answered.',
      );
    case 'evidence':
      return same(
        'Ready for review',
        'ready',
        'Evidence has been added.',
        'Ready for review. Evidence has been added.',
      );
    case 'date':
      return same(
        'Ready for review',
        'ready',
        'The decision time has arrived.',
        'Ready for review. The decision time has arrived.',
      );
    case 'legacy':
      return same('Ready for review', 'ready', 'Ready when both bettors have the evidence.');
    case 'check-in':
      return same(
        'Check-in due',
        'due',
        'The check-in time has arrived. Look for the evidence, then add it.',
      );
    case 'cutoff':
      // Looking for the evidence and adding it is the bettors' part; anyone else is only told.
      return same(
        'Cutoff passed',
        'due',
        !memberId || memberId === bet.creatorId || memberId === bet.opponentId
          ? 'The claim cutoff has passed. Check whether the evidence is in, then add it.'
          : 'The claim cutoff has passed.',
      );
    case 'timing': {
      const timing = bet.timing!;
      // The condition itself is on the timing record, so the sentence points to it, not repeats it.
      const waitingFor =
        timing.kind === 'date'
          ? 'Review opens at the agreed decision time.'
          : timing.kind === 'event'
            ? 'Waiting for the agreed event.'
            : 'Waiting for the agreed evidence.';
      return same('Not yet', 'waiting', waitingFor, `Not ready for review yet. ${waitingFor}`);
    }
  }
}

/** How a declined bet was closed: by the other bettor, or taken back by its proposer. */
export function closureOf(bet: Bet): 'declined' | 'withdrawn' | undefined {
  if (bet.status !== 'declined') return undefined;
  return bet.events.at(-1)?.type === 'withdraw' ? 'withdrawn' : 'declined';
}

export const betStatusNames: Record<BetStatus, string> = {
  pending: 'Pending agreement',
  active: 'In play',
  confirming: 'Confirming result',
  owed: 'Ready to settle',
  settling: 'Confirming delivery',
  settled: 'Settled',
  voided: 'No winner',
  declined: 'Declined',
};

/** Why a bet's chip says something other than its plain status. */
export type BetStatusVariant = 'history' | 'correction' | 'offset' | 'withdrawn';

export function betStatusVariant(bet: Bet): BetStatusVariant | undefined {
  if (bet.history && bet.status === 'pending')
    return bet.history.correction ? 'correction' : 'history';
  if (bet.status === 'settled' && !bet.settlement && getOffsetRolls(bet) > 0) return 'offset';
  if (closureOf(bet) === 'withdrawn') return 'withdrawn';
  return undefined;
}

const variantLabels: Record<BetStatusVariant, string> = {
  history: 'Confirming history',
  correction: 'History needs correction',
  offset: 'Settled by offset',
  withdrawn: 'Withdrawn',
};

/** The status label people see on the ledger, inbox, bet sheet and exports. */
export function betStatusLabel(bet: Bet): string {
  const variant = betStatusVariant(bet);
  return variant ? variantLabels[variant] : betStatusNames[bet.status];
}

/** An open amendment that keeps the judge who stepped down after it was proposed: it can only be
 * withdrawn or declined, never agreed. */
export function amendmentKeepsDeclinedJudge(bet: Bet): boolean {
  return (
    !!bet.judgeDeclined &&
    bet.amendment?.decisionMethod === 'judge' &&
    bet.amendment.judgeId === bet.judgeId
  );
}

const rolls = (count: number) => `${count} ${count === 1 ? 'roll' : 'rolls'}`;

/**
 * The readiness evidence on the bet is not in the ChatGPT prompt, so ChatGPT would never see it.
 * Only the text decides: evidence added before a prompt that left it out is missed just the same.
 */
export function promptMissesEvidence(bet: Pick<Bet, 'promptAgreement' | 'readiness'>): boolean {
  return (
    !!bet.promptAgreement &&
    !!bet.readiness &&
    !bet.promptAgreement.text.includes(bet.readiness.evidence)
  );
}

/** The line for a bet that waits on its judge's recommendation, whoever is reading it. */
export const judgeWaitingLine = (judge: string) =>
  `Waiting for ${judge} to record a recommendation.`;

/** Readiness evidence that was on the bet and has come off it. */
export interface RemovedEvidence {
  /** The evidence as it was recorded. */
  evidence: string;
  /** Who took it off: the other bettor who disagreed, or the author who took it back or replaced it. */
  by: string;
  how: 'disagreed' | 'withdrawn' | 'replaced';
}

/** The headings a ChatGPT prompt puts its evidence under (the wording adjudication.ts writes). */
export const PROMPT_EVIDENCE_HEADING = 'Evidence to assess:\n';
export const PROMPT_LATE_EVIDENCE_HEADING =
  'Evidence recorded on the ledger after this prompt was agreed:\n';

/**
 * Where evidence is quoted in a ChatGPT prompt as evidence: its position, or -1. Evidence stands
 * under the prompt's last evidence heading, so the same words above it (the address the bet expects
 * its evidence at, say) are not it; a prompt with no such heading is searched whole, from the end.
 * Words that are part of the evidence now on the bet (`current`) are not the removed evidence either:
 * a prompt that quotes a longer version quotes the old text only as a piece of it.
 */
export function findQuotedEvidence(text: string, evidence: string, current?: string): number {
  if (!evidence) return -1;
  const visible =
    current && current.includes(evidence)
      ? text.split(current).join('\0'.repeat(current.length))
      : text;
  const headingEnd = (heading: string) => {
    const at = text.lastIndexOf(heading);
    return at < 0 ? -1 : at + heading.length;
  };
  const from = Math.max(
    headingEnd(PROMPT_EVIDENCE_HEADING),
    headingEnd(PROMPT_LATE_EVIDENCE_HEADING),
  );
  return from >= 0 ? visible.indexOf(evidence, from) : visible.lastIndexOf(evidence);
}

// The paper trail's own wording (ledger.ts): the evidence is quoted between these two.
const MARKED_EVIDENCE =
  /^Marked evidence ready for review: ([\s\S]+) No winner or debt has been recorded\.$/;
const WITHDREW_EVIDENCE = /^Withdrew their readiness evidence: /;

/**
 * The evidence an agreed or proposed ChatGPT prompt still quotes although it has come off the bet:
 * the other bettor disagreed with it, its author took it back, or its author put a newer version in
 * its place. It is read from the paper trail, since the bet no longer holds it, and newest first.
 * Evidence still on the bet is not removed, and a prompt that has since been rewritten without it
 * quotes nothing.
 */
export function promptQuotesRemovedEvidence(
  bet: Pick<Bet, 'promptAgreement' | 'readiness' | 'events'>,
): RemovedEvidence[] {
  const prompt = bet.promptAgreement;
  if (!prompt) return [];
  const removed: RemovedEvidence[] = [];
  let current: string | undefined;
  for (const event of bet.events) {
    if (event.type === 'mark_ready') {
      if (current !== undefined)
        removed.push({ evidence: current, by: event.actorId, how: 'replaced' });
      current = MARKED_EVIDENCE.exec(event.detail)?.[1];
    } else if (current !== undefined && event.type === 'dispute_readiness') {
      removed.push({ evidence: current, by: event.actorId, how: 'disagreed' });
      current = undefined;
    } else if (
      current !== undefined &&
      event.type === 'withdraw_proposal' &&
      WITHDREW_EVIDENCE.test(event.detail)
    ) {
      removed.push({ evidence: current, by: event.actorId, how: 'withdrawn' });
      current = undefined;
    }
  }
  const seen = new Set<string>();
  return removed.reverse().filter(({ evidence }) => {
    if (seen.has(evidence) || evidence === bet.readiness?.evidence) return false;
    seen.add(evidence);
    return findQuotedEvidence(prompt.text, evidence, bet.readiness?.evidence) >= 0;
  });
}

/**
 * Whose move it is, in one sentence, for a member who is not part of the bet and so has no next
 * step of their own. Empty once the bet is closed.
 */
export function watcherStatus(
  bet: Bet,
  name: (id: string) => string,
  now: string | Date | number = new Date(),
): string {
  const both = `${name(bet.creatorId)} and ${name(bet.opponentId)}`;
  const either = `${name(bet.creatorId)} or ${name(bet.opponentId)}`;
  const waiting = (approvals: readonly string[]) => pendingNames(bet, approvals, name) || both;
  if (bet.status === 'pending' && bet.history)
    return bet.history.correction
      ? `Waiting for ${either} to revise the reported history.`
      : `Waiting for ${waiting(bet.history.approvals.map((approval) => approval.actorId))} to confirm the reported history.`;
  if (bet.status === 'pending') return `Waiting for ${waiting(bet.agreementApprovals)} to agree.`;
  if (bet.status === 'active') {
    const proposal = bet.amendment ?? bet.voidProposal;
    if (proposal)
      return `Waiting for ${waiting(proposal.approvals)} to answer ${name(proposal.proposedBy)}’s ${
        bet.amendment ? 'proposed changes' : 'proposal to call the bet off'
      }.`;
    if (bet.decisionMethod === 'judge' && bet.judgeDeclined)
      return `${name(bet.judgeId ?? '')} stepped down as judge. Waiting for ${both} to choose a new judge or another way to decide.`;
    const prompt = bet.promptAgreement;
    const promptAgreed =
      !!prompt && [bet.creatorId, bet.opponentId].every((id) => prompt.approvals.includes(id));
    if (bet.decisionMethod === 'chatgpt' && !prompt)
      return `Waiting for ${both} to agree on a ChatGPT prompt.`;
    if (bet.decisionMethod === 'chatgpt' && !promptAgreed)
      return `Waiting for ${waiting(prompt!.approvals)} to approve prompt v${prompt!.version}.`;
    const status = reviewStatus(bet, now);
    if (status.tone === 'due') return `Waiting for ${either} to check whether the evidence is in.`;
    if (status.tone !== 'ready') return status.detail;
    // Matches JUDGE_COPY.waiting, the bettors' own line while the judge decides.
    if (bet.decisionMethod === 'judge') return judgeWaitingLine(name(bet.judgeId ?? ''));
    if (bet.decisionMethod === 'chatgpt')
      return `Waiting for ${either} to record ChatGPT’s response.`;
    return `Waiting for ${either} to propose a result.`;
  }
  if (bet.status === 'confirming')
    return `Waiting for ${waiting(bet.resolution?.approvals ?? [])} to confirm the result.`;
  if (bet.status === 'owed') {
    const winner = bet.resolution?.winnerId ?? '';
    const loser = winner === bet.creatorId ? bet.opponentId : bet.creatorId;
    const count = getRemainingRolls(bet);
    return `Waiting for ${name(loser)} to deliver ${count} lobster ${count === 1 ? 'roll' : 'rolls'} to ${name(winner)}.`;
  }
  if (bet.status === 'settling')
    return `Waiting for ${waiting(bet.settlement?.approvals ?? [])} to confirm the delivery.`;
  return '';
}

/**
 * The one move a person can make next. Single-button steps use the sheet's own button words;
 * approve-or-decline pairs get a neutral "Answer / Review / Confirm a …" label instead.
 * BetDetail.inbox.dom.test.ts checks every label against the sheet's visible buttons.
 */
export function primaryActionLabel(
  bet: Bet,
  memberId: string,
  now: string | Date | number = new Date(),
  name: (id: string) => string = (id) => id,
): string {
  const parties = [bet.creatorId, bet.opponentId];
  if (bet.history && bet.status === 'pending')
    return bet.history.correction ? 'Revise history' : 'Review and confirm history';
  if (bet.amendment)
    return amendmentKeepsDeclinedJudge(bet) ? 'Decline proposal' : 'Review revised terms';
  if (bet.voidProposal) return 'Review no-winner proposal';
  if (bet.status === 'pending') return 'Answer a proposal';
  if (bet.status === 'confirming') return 'Confirm a result';
  if (bet.status === 'settling') return 'Confirm a delivery';
  if (bet.status === 'owed') {
    const winner = bet.resolution?.winnerId ?? '';
    const loser = parties.find((id) => id !== winner) ?? '';
    const remaining = getRemainingRolls(bet);
    return winner === memberId
      ? `Waiting on ${name(loser)} · ${rolls(remaining)}`
      : `Record delivery · ${rolls(remaining)} to ${name(winner)}`;
  }
  if (bet.status !== 'active') return 'Nothing to do';
  if (bet.decisionMethod === 'judge' && bet.judgeDeclined)
    return bet.judgeId === memberId ? 'You stepped down as judge' : 'Choose a new judge or method';
  const readiness = betReadiness(bet, now, memberId);
  if (readiness.reviewDue && !readiness.ready) return 'Add readiness evidence';
  if (bet.decisionMethod === 'judge')
    // Matches JUDGE_COPY.recordAction, the judge's button on the sheet.
    return bet.judgeId === memberId ? 'Record your recommendation' : 'Waiting on the judge';
  if (bet.decisionMethod === 'chatgpt') {
    if (!bet.promptAgreement) return 'Draft a fair prompt';
    // An agreed prompt that leaves out the evidence, or still quotes evidence that came off the bet,
    // is revised first, not sent as it is.
    if (parties.every((id) => bet.promptAgreement!.approvals.includes(id)))
      return promptMissesEvidence(bet)
        ? 'Add evidence to the prompt'
        : promptQuotesRemovedEvidence(bet).length
          ? 'Remove evidence from the prompt'
          : 'Record ChatGPT response';
    return bet.promptAgreement.approvals.includes(memberId)
      ? `Waiting on ${name(parties.find((id) => id !== memberId) ?? '')} to approve the prompt`
      : 'Approve a prompt';
  }
  return 'Record outcome';
}

/**
 * The words of a title, ignoring case, accents, punctuation, spacing, zero-width characters and a
 * leading "the", "a" or "an", so "The migration finishes before lunch." and "migration finishes
 * before lunch" are the same title.
 */
export function titleKey(value: string): string {
  return textKey(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]+/g, '')
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(?:the|a|an) /, '');
}

/** How far apart two "when was it made" dates may be for the same bet to have been recorded twice. */
const DUPLICATE_WINDOW_DAYS = 7;

/** Whether two reported dates, each as precise as it was remembered, fall within the window. */
function madeAroundTheSameTime(first: HistoricalDate, second: HistoricalDate): boolean {
  // A date still being typed ("20" for a year) is not a date yet.
  if (!historyDateStart(first) || !historyDateStart(second)) return false;
  const a = historicalInterval(first);
  const b = historicalInterval(second);
  if (!a || !b) return false;
  const gap = Math.max(a.start, b.start) - Math.min(a.end, b.end);
  return gap <= DUPLICATE_WINDOW_DAYS * 86_400_000;
}

/**
 * Bets already on the ledger that look like the same wager being added again: the same two people
 * and the same title, either at the same number of rolls, or (when the date it was made is known)
 * at any number of rolls if the two were made within a week of each other. A bet recorded on the
 * ledger itself was made when it was proposed.
 */
export function likelyDuplicates(
  bets: Bet[],
  input: Pick<NewBet, 'title' | 'opponentId' | 'stake'> & {
    history?: { originalDate?: HistoricalDate };
  },
  actorId: string,
): Bet[] {
  const pair = new Set([actorId, input.opponentId]);
  const title = titleKey(input.title ?? '');
  if (!title) return [];
  const madeOn = input.history?.originalDate;
  return bets.filter(
    (bet) =>
      !['declined', 'voided'].includes(bet.status) &&
      pair.has(bet.creatorId) &&
      pair.has(bet.opponentId) &&
      titleKey(bet.title) === title &&
      (bet.stake === input.stake ||
        (!!madeOn &&
          madeAroundTheSameTime(
            madeOn,
            bet.history?.originalDate ?? {
              precision: 'day',
              value: bet.createdAt.slice(0, 10),
            },
          ))),
  );
}
