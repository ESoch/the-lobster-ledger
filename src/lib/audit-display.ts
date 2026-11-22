import type { AuditEvent, Bet, Member } from './types';
import { zonedDateTimeLabel } from './bet-workflow';

/** How one paper-trail record reads. The stored detail itself is never changed. */
export interface AuditDisplay {
  /** System-authored sentences with names and readable times; short member text stays inline. */
  text: string;
  /** Long member text kept on the record (a prompt or a long reasoning), shown behind a disclosure. */
  attachment?: { label: string; text: string };
}

/** Member text longer than this moves behind a disclosure so one record cannot fill the sheet. */
const INLINE_LIMIT = 280;
const isLong = (value: string) => value.length > INLINE_LIMIT || value.split('\n').length > 4;
const CONFIRM_SEPARATELY = 'Both bettors must separately confirm the result.';
/** A recorded recommendation: its prefix, the outcome (and winner id), the reasoning and the extras. */
const RECOMMENDATION =
  /^(Recorded .*? recommendation for )(no winner|winner ([^:\s]+)): ([\s\S]*?)(?:\nChatGPT source: (\S+))?( Both bettors must separately confirm the result\.)?$/;

/**
 * Formats the stored audit detail for display. Only system-authored wording is rewritten: ids
 * become names, UTC stamps become the agreed timezone and run-on sentences get their own line.
 * Evidence, reasons, prompts and reasoning are shown exactly as recorded.
 */
export function auditDisplay(
  event: AuditEvent,
  members: Member[],
  bet?: Pick<Bet, 'creatorId' | 'opponentId'>,
): AuditDisplay {
  const name = (id: string) =>
    members.find((member) => member.id === id)?.name ?? 'a former member';
  const detail = event.detail;
  const text = (value: string): AuditDisplay => ({ text: value });
  switch (event.type) {
    case 'propose_result':
      return text(
        detail
          .replace(
            /^Proposed winner ([^:\s]+):/,
            (_, id: string) => `Proposed ${name(id)} as the winner:`,
          )
          .replace(/^Proposed a void result:/, 'Proposed calling the bet off with no winner:'),
      );
    case 'adjudicate': {
      const match = RECOMMENDATION.exec(detail);
      if (!match) return text(detail);
      const [, prefix, outcome, winnerId, reasoning, sourceUrl, trailer] = match;
      const long = isLong(reasoning);
      return {
        text: `${prefix}${winnerId ? `winner ${name(winnerId)}` : outcome}${long ? '.' : `: ${reasoning}`}${
          sourceUrl ? `\nChatGPT source: ${sourceUrl}` : ''
        }${trailer ? `\n${CONFIRM_SEPARATELY}` : ''}`,
        ...(long ? { attachment: { label: 'Read the full reasoning', text: reasoning } } : {}),
      };
    }
    case 'propose_prompt': {
      const match =
        /^Proposed and approved ChatGPT prompt version (\d+)\. Exact prompt:\n([\s\S]*)$/.exec(
          detail,
        );
      if (!match) return text(detail);
      return {
        text: `Proposed and approved ChatGPT prompt version ${match[1]}.`,
        attachment: { label: `Read prompt v${match[1]} as proposed`, text: match[2] },
      };
    }
    case 'mark_ready': {
      const match =
        /^Marked evidence ready for review: ([\s\S]*) No winner or debt has been recorded\.$/.exec(
          detail,
        );
      if (!match) return text(detail);
      const long = isLong(match[1]);
      return {
        text: `Marked evidence ready for review${long ? '.' : `: ${match[1]}`}\nNo winner or debt has been recorded.`,
        ...(long ? { attachment: { label: 'Read the evidence', text: match[1] } } : {}),
      };
    }
    case 'set_check_in': {
      if (detail.startsWith('Removed their personal check-in.'))
        return text(
          detail.replace(/^Removed their personal check-in\./, 'Removed a personal check-in.'),
        );
      const match = /^Set their personal check-in to (\S+) \(([^)]+)\)\.( .*)?$/.exec(detail);
      if (!match) return text(detail);
      try {
        return text(
          `Set a personal check-in for ${zonedDateTimeLabel({ at: match[1], timezone: match[2] })}.${match[3] ?? ''}`,
        );
      } catch {
        return text(detail);
      }
    }
    case 'offset_debts': {
      const match =
        /^(Offset \d+ rolls? against mutual debts) with (.+?)\. (\d+ remaining\. No physical delivery recorded\.) Offset [0-9a-f-]+\.$/.exec(
          detail,
        );
      if (!match) return text(detail);
      const counterparty = bet
        ? [bet.creatorId, bet.opponentId].find((id) => id !== event.actorId)
        : undefined;
      return text(
        `${match[1]}${counterparty ? ` with ${name(counterparty)} (${match[2]})` : ` on ${match[2]}`}. ${match[3]}`,
      );
    }
    case 'decline_judging':
      return text(
        detail.replace(
          // Older records said "ruling"; both read as the one word the sheet uses.
          / Both bettors must agree on a new judge or decision method before a (?:ruling|recommendation) can be recorded\.$/,
          '\nBoth bettors must agree on a new judge or decision method before a recommendation can be recorded.',
        ),
      );
    // Amendments keep the judge's id in a "(judge <id>)" token on the system-authored line only.
    case 'propose_amendment':
      return text(
        detail.replace(
          /(\nProposed decision method: a named judge \()judge ([^)\s]+)(\)\nReason: )/,
          (_, before: string, id: string, after: string) => `${before}${name(id)}${after}`,
        ),
      );
    case 'confirm_amendment':
      return text(
        detail.replace(
          /( The bet is now decided by a named judge \()judge ([^)\s]+)(\)\.)/,
          (_, before: string, id: string, after: string) => `${before}${name(id)}${after}`,
        ),
      );
    // A bettor's disagreement reads with the one verb the sheet's buttons use. The reason is theirs.
    case 'dispute_result':
      return text(detail.replace(/^Disputed the result: /, 'Disagreed with the result: '));
    case 'dispute_settlement':
      return text(
        detail.replace(/^Disputed the delivery: /, 'Disagreed with the delivery report: '),
      );
    case 'dispute_readiness':
      return text(
        detail.replace(
          /^Disputed the readiness evidence: /,
          'Disagreed with the readiness evidence: ',
        ),
      );
    default:
      return text(detail);
  }
}

/**
 * What a result, recommendation or delivery report said once it has been disagreed with and
 * cleared: who it chose and why, or what was reported. The instruction the record ended with
 * ("Both bettors must separately confirm the result.") stopped applying when it was cleared.
 */
export function clearedResultText(event: AuditEvent, members: Member[]): string {
  const match = event.type === 'adjudicate' ? RECOMMENDATION.exec(event.detail) : null;
  if (!match) return auditDisplay(event, members).text;
  const [, , , winnerId, reasoning] = match;
  const who = winnerId
    ? `${members.find((member) => member.id === winnerId)?.name ?? 'A former member'} wins`
    : 'No winner';
  return isLong(reasoning)
    ? `${who}. The full reasoning is in the paper trail.`
    : `${who}: ${reasoning}`;
}

/** The display text alone, for one-line activity feeds. */
export function formatAuditDetail(
  event: AuditEvent,
  members: Member[],
  bet?: Pick<Bet, 'creatorId' | 'opponentId'>,
): string {
  return auditDisplay(event, members, bet).text;
}
