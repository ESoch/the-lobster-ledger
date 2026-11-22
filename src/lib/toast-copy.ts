import { betReadiness } from './bet-workflow';
import { getRemainingRolls } from './ledger';
import type { Bet, BetAction, Member } from './types';

/** Shown only for an action type this build has no wording for. */
export const FALLBACK_TOAST = 'Recorded on the ledger.';
export const BET_NOT_FOUND_TOAST =
  'That bet could not be found in your ledger. Check the link and your account.';
export const SIGN_OUT_FAILED_TOAST = 'Unable to sign out. Please try again.';

const rolls = (count: number) => `${count} lobster ${count === 1 ? 'roll' : 'rolls'}`;
const bets = (count: number) => `${count} ${count === 1 ? 'bet' : 'bets'}`;
const priceReports = (count: number) => `${count} price ${count === 1 ? 'report' : 'reports'}`;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** What a bet in play is left with once its readiness evidence comes off it. */
const afterEvidence = (bet: Bet, actorId: string) =>
  betReadiness({ ...bet, readiness: undefined }, undefined, actorId).ready
    ? 'Its agreed timing has arrived, so a result can still be recorded.'
    : 'The bet waits on its agreed timing or new evidence again.';

export interface ActionToastInput {
  /** The bet as it stood before the action, so "first or final" questions read the earlier approvals. */
  bet: Bet;
  action: BetAction;
  members: Member[];
  actorId: string;
}

/** Everything a message needs, resolved once: names, the other bettor, the winner and the loser. */
export interface CopyContext<A> {
  action: A;
  bet: Bet;
  /** Who acted: the reader of the toast, addressed as "you". */
  actorId: string;
  /** The bettor who is not acting; "the other bettor" if the actor is not one of the two. */
  other: string;
  creator: string;
  opponent: string;
  winner: string;
  loser: string;
  /** Name for any member id; falls back to a plain phrase rather than showing an id. */
  name: (id: string | null | undefined) => string;
}

// What the type system must hold: a message for every BetAction, so adding a member to the union
// breaks the build until it has wording. Actions that are still joining the union are typed as
// optional here and turn into required entries the moment they appear in BetAction.
type ComingSoon = 'withdraw' | 'withdraw_proposal' | 'decline_judging';
type ActionOf<K extends string> = K extends BetAction['type']
  ? Extract<BetAction, { type: K }>
  : { type: K; note: string };
type Copy<K extends string> = (context: CopyContext<ActionOf<K>>) => string;
type ActionCopy = { [K in BetAction['type']]: Copy<K> } & {
  [K in Exclude<ComingSoon, BetAction['type']>]?: Copy<K>;
};

export const actionCopy: ActionCopy = {
  accept: ({ other }) => `Terms agreed with ${other}. The bet is on.`,
  decline: ({ other }) =>
    `You declined ${other}’s proposal. It stays on the ledger as declined, with your reason.`,
  withdraw: ({ other }) =>
    `You withdrew your proposal to ${other}. It stays on the ledger as closed, with your reason.`,
  withdraw_proposal: ({ bet, other, actorId }) => {
    if (bet.amendment)
      return `Revised terms withdrawn. The agreement with ${other} stays as it was.`;
    if (bet.voidProposal) return `Call-off withdrawn. The bet with ${other} stays in play.`;
    if (bet.status === 'confirming')
      return `Result withdrawn. The bet with ${other} is back in play.`;
    if (bet.status === 'settling')
      return `Delivery report withdrawn. ${rolls(getRemainingRolls(bet))} still owed.`;
    if (bet.readiness) return `Readiness evidence withdrawn. ${afterEvidence(bet, actorId)}`;
    return 'Proposal withdrawn. The agreement stays as it was.';
  },
  decline_judging: ({ creator, opponent }) =>
    `You stepped down as judge. ${creator} and ${opponent} must agree on a new judge or method before a recommendation can be recorded.`,

  propose_result: ({ action, bet, other, winner, loser }) =>
    action.winnerId === null
      ? `Proposed that nobody wins. ${other} must confirm before the bet closes.`
      : `Proposed that ${winner} wins and ${loser} owes ${rolls(bet.stake)}. ${other} must confirm before it counts.`,
  adjudicate: ({ action, creator, opponent, winner }) =>
    action.winnerId === null
      ? `Recommendation recorded: no winner. ${creator} and ${opponent} must each confirm before the bet closes.`
      : `Recommendation recorded: ${winner} wins. ${creator} and ${opponent} must each confirm before any rolls are owed.`,
  confirm_result: ({ bet, other, winner, loser }) => {
    // The proposer of a bettor-made result has already approved it; a judge's recommendation has not.
    if ((bet.resolution?.approvals.length ?? 0) < 1)
      return `You confirmed the recommendation. ${other} must still confirm before any rolls are owed.`;
    return bet.resolution?.winnerId === null
      ? 'Both of you confirmed: no winner, so no rolls are owed.'
      : `Both of you confirmed. ${loser} owes ${winner} ${rolls(bet.stake)}.`;
  },
  dispute_result: ({ bet }) =>
    `You disagreed with the ${bet.adjudication ? 'recommendation' : 'proposed result'}. The bet is back in play and nothing is owed. Your reason is on the record.`,

  propose_settlement: ({ bet, other }) =>
    `Delivery of ${rolls(getRemainingRolls(bet))} reported. ${other} must confirm they arrived before the debt is settled.`,
  confirm_settlement: ({ bet, winner, loser }) =>
    `Delivery confirmed: ${loser} delivered ${rolls(getRemainingRolls(bet))} to ${winner}. This debt is settled.`,
  // Either bettor can disagree with the other's report; whoever reads it is "you".
  dispute_settlement: ({ bet, winner, loser, actorId }) =>
    `You disagreed with the delivery report. ${
      actorId === bet.resolution?.winnerId ? `${loser} still owes you` : `You still owe ${winner}`
    } ${rolls(getRemainingRolls(bet))} until one of you records a delivery and the other confirms it.`,

  propose_prompt: ({ bet, other }) => {
    const version = Math.max(bet.promptVersion ?? 0, bet.promptAgreement?.version ?? 0) + 1;
    return `Prompt version ${version} proposed. ${other} must approve the exact wording before ChatGPT is asked.`;
  },
  approve_prompt: ({ bet, other }) =>
    `Prompt${bet.promptAgreement ? ` version ${bet.promptAgreement.version}` : ''} approved by you and ${other}. ChatGPT can now be asked for a recommendation.`,

  propose_amendment: ({ other }) =>
    `Revised terms proposed. ${other} must agree; the current agreement stays in place until then.`,
  confirm_amendment: ({ other }) =>
    `Revised terms agreed with ${other}. The updated agreement now applies.`,
  reject_amendment: ({ other }) =>
    `Revised terms declined. The existing agreement with ${other} stays in place.`,
  propose_void: ({ other }) =>
    `Call-off proposed. ${other} must agree before the bet closes with no winner.`,
  confirm_void: () => 'Both agreed: the bet is called off with no winner. No rolls are owed.',
  reject_void: ({ other }) => `Call-off declined. The bet with ${other} stays in play.`,

  confirm_history: ({ bet, other, winner, loser }) => {
    // What confirming settles depends on how far the reported bet had got.
    const confirmed = `History confirmed with ${other}.`;
    switch (bet.history?.stage) {
      case 'owed':
        return `${confirmed} ${loser} owes ${winner} ${rolls(bet.stake)}.`;
      case 'settled':
        return `${confirmed} ${loser} delivered ${rolls(bet.stake)} to ${winner}, so the debt is settled.`;
      case 'voided':
        return `${confirmed} No winner, so no rolls are owed.`;
      case 'active':
        return `${confirmed} The bet is in play.`;
      default:
        return `${confirmed} The record is now part of your ledger.`;
    }
  },
  request_history_correction: ({ other }) =>
    `Correction requested. ${other} can revise the history; it stays unconfirmed until then.`,
  revise_history: ({ other }) => `Revised history sent. ${other} must confirm it again.`,
  mark_ready: () => 'Evidence recorded. The outcome is ready for review.',
  dispute_readiness: ({ bet, name, actorId }) =>
    `You disagreed with ${name(bet.readiness?.markedBy)}’s evidence and it is off the bet. ${afterEvidence(bet, actorId)}`,
  set_check_in: ({ action }) =>
    action.checkIn ? 'Your next check-in is saved.' : 'Your check-in is cleared.',
};

export function actionToast({ bet, action, members, actorId }: ActionToastInput): string {
  const name = (id: string | null | undefined) =>
    members.find((member) => member.id === id)?.name ?? 'the other bettor';
  const isBettor = actorId === bet.creatorId || actorId === bet.opponentId;
  // A result being proposed names its own winner; every later step reads the recorded one.
  const winnerId =
    'winnerId' in action && action.winnerId !== undefined
      ? action.winnerId
      : (bet.resolution?.winnerId ?? bet.history?.result?.winnerId ?? null);
  const loserId = winnerId === bet.creatorId ? bet.opponentId : bet.creatorId;
  const context: CopyContext<BetAction> = {
    action,
    bet,
    actorId,
    other: name(
      isBettor ? (actorId === bet.creatorId ? bet.opponentId : bet.creatorId) : undefined,
    ),
    creator: name(bet.creatorId),
    opponent: name(bet.opponentId),
    winner: name(winnerId),
    loser: name(winnerId ? loserId : undefined),
    name,
  };
  const copy = (
    actionCopy as Record<string, ((context: CopyContext<never>) => string) | undefined>
  )[action.type];
  return copy ? copy(context as CopyContext<never>) : FALLBACK_TOAST;
}

/** After a bet is created from the New bet dialog or the Add existing bet form. */
export function betCreatedToast(otherName: string, history: boolean): string {
  return history
    ? `${otherName} has been asked to confirm this past bet. It joins your ledger once they do.`
    : `Proposed to ${otherName}. The bet is on once they agree.`;
}
export const priceSavedToast = (priceCents: number, restaurant: string) =>
  `Saved ${dollars(priceCents)} at ${restaurant}.`;
export const priceCorrectedToast = (priceCents: number, restaurant: string) =>
  `Corrected to ${dollars(priceCents)} at ${restaurant}. The earlier report stays on record under Earlier reports.`;
export const priceWithdrawnToast = (priceCents: number, restaurant: string) =>
  `Withdrew your ${dollars(priceCents)} report at ${restaurant}. It stays on record under Earlier reports and no longer counts in any price.`;
/** A report of a visit already on record at the same price: a retry, so nothing was added. */
export const priceAlreadyRecordedToast = (priceCents: number, restaurant: string) =>
  `Your ${dollars(priceCents)} at ${restaurant} for that visit was already on record, so nothing new was saved.`;
export const offsetToast = (otherName: string, rollCount: number, betCount: number) =>
  `Offset ${rolls(rollCount)} each way with ${otherName}. Recorded on ${bets(betCount)}.`;
export const exportToast = (filename: string, betCount: number) =>
  `Downloaded ${filename} with ${bets(betCount)}.`;
export const pricesExportToast = (filename: string, reportCount: number) =>
  `Downloaded ${filename} with ${priceReports(reportCount)}.`;
export const archiveExportToast = (filename: string, betCount: number, reportCount: number) =>
  `Downloaded ${filename} with ${bets(betCount)} and ${priceReports(reportCount)}.`;
/** The Lobster prices CSV: one row per year of the range on screen. */
export const marketExportToast = (filename: string, yearCount: number) =>
  `Downloaded ${filename} with ${yearCount} ${yearCount === 1 ? 'year' : 'years'} of prices.`;
export const memberSwitchedToast = (name: string) =>
  `Now viewing as ${name}. Approvals use their perspective.`;
