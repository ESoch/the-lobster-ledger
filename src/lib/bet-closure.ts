import type { AuditEvent, Bet } from './types';

/**
 * The latest exit on a bet that the sheet should keep in view: who declined or withdrew a closed
 * proposal, or who disputed a result or delivery that the rules engine has since cleared.
 */
export interface ClosureRecord {
  kind: 'declined' | 'withdrawn' | 'disputed_result' | 'disputed_delivery';
  event: AuditEvent;
  /** The reason the member gave, as they wrote it. */
  note: string;
  /** For a dispute: the proposal it cleared, exactly as the paper trail recorded it. */
  disputed?: AuditEvent;
}

// The engine writes each exit as "<fixed prefix>: <member's reason>".
const prefixes: Record<string, string> = {
  decline: 'Declined the agreement: ',
  withdraw: 'Withdrew the proposal: ',
  dispute_result: 'Disputed the result: ',
  dispute_settlement: 'Disputed the delivery: ',
};
const noteOf = (event: AuditEvent) => {
  const prefix = prefixes[event.type];
  return prefix && event.detail.startsWith(prefix)
    ? event.detail.slice(prefix.length)
    : event.detail;
};
/** The newest event of one of these types, with the events before it. */
function latest(bet: Bet, types: string[]) {
  for (let index = bet.events.length - 1; index >= 0; index--)
    if (types.includes(bet.events[index].type))
      return { event: bet.events[index], before: bet.events.slice(0, index) };
  return undefined;
}
const lastOf = (events: AuditEvent[], types: string[]) =>
  [...events].reverse().find((event) => types.includes(event.type));

export function closureRecord(bet: Bet): ClosureRecord | undefined {
  if (bet.status === 'declined') {
    const found = latest(bet, ['decline', 'withdraw']);
    if (!found) return undefined;
    return {
      kind: found.event.type === 'withdraw' ? 'withdrawn' : 'declined',
      event: found.event,
      note: noteOf(found.event),
    };
  }
  // A dispute stays the latest word on the result until someone proposes a new one.
  if (bet.status === 'active') {
    const found = latest(bet, [
      'propose_result',
      'adjudicate',
      'dispute_result',
      'confirm_amendment',
    ]);
    if (found?.event.type !== 'dispute_result') return undefined;
    return {
      kind: 'disputed_result',
      event: found.event,
      note: noteOf(found.event),
      disputed: lastOf(found.before, ['propose_result', 'adjudicate']),
    };
  }
  if (bet.status === 'owed') {
    const found = latest(bet, ['propose_settlement', 'dispute_settlement']);
    if (found?.event.type !== 'dispute_settlement') return undefined;
    return {
      kind: 'disputed_delivery',
      event: found.event,
      note: noteOf(found.event),
      disputed: lastOf(found.before, ['propose_settlement']),
    };
  }
  return undefined;
}
