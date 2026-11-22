import { ChevronRight } from 'lucide-react';
import type { Bet, LedgerState, Member } from '../lib/types';
import { betStatusLabel, betStatusVariant, primaryActionLabel } from '../lib/bet-workflow';
import { pluralNoBreak } from '../lib/plural';
import { Avatar, StatusBadge } from './ui';
import './action-item.css';

/** "Over to you" uses the compact card; the Activity inbox uses the expanded row. */
export type ActionItemSize = 'compact' | 'expanded';

const memberOf = (state: LedgerState, id: string): Member | undefined =>
  state.members.find((member) => member.id === id);
const firstName = (member?: Member) => member?.name.split(' ')[0] ?? 'A former member';

/**
 * What kind of duty a bet is, so the most blocking ones come first:
 * 0 answer a proposal, 1 give the second handshake on a result or delivery,
 * 2 decide or gather evidence on an agreed bet. Owed rolls are not a duty (they live under To
 * settle), so rank 3 is only a fallback that keeps any other bet last rather than unsorted.
 */
export function dutyRank(bet: Bet): number {
  if (bet.amendment || bet.voidProposal || bet.status === 'pending') return 0;
  if (bet.status === 'confirming' || bet.status === 'settling') return 1;
  if (bet.status === 'active') return 2;
  return 3;
}

/** Duty type first, then whichever bet has been waiting longest. */
export function sortByDuty(bets: Bet[]): Bet[] {
  const time = (bet: Bet) => Date.parse(bet.updatedAt) || 0;
  return [...bets].sort((a, b) => dutyRank(a) - dutyRank(b) || time(a) - time(b));
}

/** Who asked this member for something, when somebody did. */
function requestedBy(bet: Bet, memberId: string): string | undefined {
  const proposal = bet.amendment ?? bet.voidProposal;
  if (proposal) return proposal.proposedBy;
  if (bet.status === 'pending')
    return bet.history
      ? (bet.history.correction?.requestedBy ?? bet.history.proposedBy)
      : bet.creatorId;
  if (bet.status === 'confirming' && bet.resolution && !bet.adjudication)
    return bet.resolution.proposedBy;
  if (bet.status === 'settling' && bet.settlement) return bet.settlement.proposedBy;
  if (
    bet.status === 'active' &&
    bet.decisionMethod === 'chatgpt' &&
    bet.promptAgreement &&
    !bet.promptAgreement.approvals.includes(memberId)
  )
    return bet.promptAgreement.proposedBy;
  return undefined;
}

/** The person behind the duty: who is waiting, or both bettors when the member is the judge. */
function personLine(bet: Bet, memberId: string, state: LedgerState): string {
  const name = (id: string) => firstName(memberOf(state, id));
  if (![bet.creatorId, bet.opponentId].includes(memberId))
    return `${name(bet.creatorId)} vs ${name(bet.opponentId)} · you are the judge`;
  const asker = requestedBy(bet, memberId);
  if (asker && asker !== memberId) return `${name(asker)} is waiting for you`;
  if (bet.status === 'confirming' && bet.adjudication)
    return bet.adjudication.method === 'judge'
      ? `${name(bet.judgeId ?? bet.adjudication.recordedBy)} recorded a recommendation`
      : 'ChatGPT response recorded';
  return `with ${name(bet.creatorId === memberId ? bet.opponentId : bet.creatorId)}`;
}

/** Rolls this duty is about: the delivery being confirmed, or the stake. */
function stakeRolls(bet: Bet): number {
  return bet.status === 'settling' ? (bet.settlement?.rolls ?? bet.stake) : bet.stake;
}

function updatedAgo(updatedAt: string, now: string | number | Date): string {
  const minutes = Math.floor((new Date(now).getTime() - Date.parse(updatedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${pluralNoBreak(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${pluralNoBreak(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  if (days < 90) return `Updated ${pluralNoBreak(days, 'day')} ago`;
  return `Updated ${pluralNoBreak(Math.floor(days / 30), 'month')} ago`;
}

/**
 * One next move: the bet, the verb the sheet will offer, the rolls at stake, who is waiting and for
 * how long. The Overview and the Inbox render the same text; only the size and the status chip differ.
 */
export function ActionItem({
  bet,
  state,
  memberId,
  now,
  size = 'compact',
  onOpen,
}: {
  bet: Bet;
  state: LedgerState;
  memberId: string;
  now?: string;
  size?: ActionItemSize;
  onOpen: (bet: Bet) => void;
}) {
  const verb = primaryActionLabel(bet, memberId, now, (id) => firstName(memberOf(state, id)));
  const rolls = stakeRolls(bet);
  const asker = requestedBy(bet, memberId);
  const faceId =
    asker && asker !== memberId
      ? asker
      : [bet.creatorId, bet.opponentId].includes(memberId)
        ? bet.creatorId === memberId
          ? bet.opponentId
          : bet.creatorId
        : bet.creatorId;
  return (
    <button
      type="button"
      className={`action-item action-item-${size}`}
      aria-haspopup="dialog"
      onClick={() => onOpen(bet)}
    >
      <Avatar member={memberOf(state, faceId)} size={size === 'expanded' ? 40 : 28} decorative />
      <span className="action-item-body">
        {size === 'expanded' && (
          <StatusBadge
            status={bet.status}
            label={betStatusLabel(bet)}
            variant={betStatusVariant(bet)}
          />
        )}
        <strong className="action-item-title">{bet.title}</strong>
        <span className="action-item-meta">
          <span className="action-item-verb">{verb}</span>
          {` · ${pluralNoBreak(rolls, 'roll')} · ${personLine(bet, memberId, state)}`}
        </span>
        <time className="action-item-age" dateTime={bet.updatedAt}>
          {updatedAgo(bet.updatedAt, now ?? Date.now())}
        </time>
      </span>
      <ChevronRight className="action-item-chevron" size={16} aria-hidden="true" />
    </button>
  );
}
