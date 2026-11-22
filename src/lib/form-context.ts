import type { AuditEvent, Bet, PromptAgreement } from './types';
import { betReadiness } from './bet-workflow';
export interface CopiedPrompt {
  version: number;
  text: string;
}
export function captureFormBet(bet: Bet): Bet {
  return structuredClone(bet);
}
export function isFormBetCurrent(captured: Bet | null, current: Bet): boolean {
  return !!captured && captured.id === current.id && captured.version === current.version;
}
export function getFormSubmissionBet(captured: Bet | null, current: Bet): Bet {
  if (!captured || !isFormBetCurrent(captured, current))
    throw new Error(
      'This record changed while you were writing. Use the latest record, check it, then submit.',
    );
  return captured;
}
export function isCurrentPromptCopied(
  copied: CopiedPrompt | null,
  prompt: PromptAgreement | undefined,
): boolean {
  return !!copied && !!prompt && copied.version === prompt.version && copied.text === prompt.text;
}

/** Events on the current record that the reader has not seen and did not make themselves. */
export function changesSince(seen: Bet, current: Bet, memberId: string): AuditEvent[] {
  const known = new Set(seen.id === current.id ? seen.events.map((event) => event.id) : []);
  return current.events.filter((event) => !known.has(event.id) && event.actorId !== memberId);
}
/**
 * The unseen changes that hold a one-click approval until they are read. A personal check-in is
 * only its maker's reminder: it changes nothing anyone agrees to.
 */
export function approvalChanges(seen: Bet, current: Bet, memberId: string): AuditEvent[] {
  return changesSince(seen, current, memberId).filter((event) => event.type !== 'set_check_in');
}

const changeWords: Record<string, string> = {
  accept: 'agreed to the bet',
  decline: 'declined the bet',
  withdraw: 'withdrew the proposal',
  withdraw_proposal: 'withdrew their proposal',
  decline_judging: 'stepped down as judge',
  confirm_history: 'confirmed the history',
  request_history_correction: 'asked for a correction',
  revise_history: 'revised the history',
  mark_ready: 'added readiness evidence',
  dispute_readiness: 'disagreed with the readiness evidence',
  set_check_in: 'changed their check-in',
  propose_amendment: 'proposed changes to the agreement',
  confirm_amendment: 'agreed to the changes',
  reject_amendment: 'declined the changes',
  propose_void: 'proposed calling off the bet',
  confirm_void: 'agreed to call off the bet',
  reject_void: 'declined calling off the bet',
  propose_prompt: 'proposed a new prompt',
  approve_prompt: 'approved the prompt',
  propose_result: 'proposed a result',
  adjudicate: 'recorded a recommendation',
  confirm_result: 'confirmed the result',
  dispute_result: 'disagreed with the result',
  propose_settlement: 'reported a delivery',
  confirm_settlement: 'confirmed the delivery',
  dispute_settlement: 'disagreed with the delivery report',
};
/** A few plain words for what an event did, to follow the actor's name. */
export function describeChange(event: AuditEvent): string {
  return changeWords[event.type] ?? 'updated this bet';
}

type Proposal = { proposedBy: string; approvals: string[] };
/**
 * Whether a sheet form still applies to the latest record for this member. It mirrors the rules
 * engine closely enough to guide the sheet; the engine still decides when the form is submitted.
 */
export function formApplies(
  form: string,
  bet: Bet,
  memberId: string,
  now: string | Date | number = new Date(),
): boolean {
  const participant = [bet.creatorId, bet.opponentId].includes(memberId);
  const method = bet.decisionMethod ?? 'mutual';
  const judge = method === 'judge' && bet.judgeId === memberId;
  const open = !!bet.amendment || !!bet.voidProposal;
  const inPlay = bet.status === 'active' && participant;
  const history = bet.status === 'pending' ? bet.history : undefined;
  const own = (proposal?: Proposal) =>
    !!proposal &&
    proposal.proposedBy === memberId &&
    proposal.approvals.length === 1 &&
    proposal.approvals[0] === memberId;
  // The member is being asked: a participant who has not approved someone else's proposal.
  const answering = (proposal?: Proposal) =>
    !!proposal &&
    participant &&
    proposal.proposedBy !== memberId &&
    !proposal.approvals.includes(memberId);
  const ready = () => betReadiness(bet, now, memberId).ready;
  switch (form) {
    case 'decline':
      return (
        bet.status === 'pending' &&
        answering({
          proposedBy: history?.proposedBy ?? bet.creatorId,
          approvals: bet.agreementApprovals,
        })
      );
    case 'withdraw':
      return (
        bet.status === 'pending' && own({ proposedBy: memberId, approvals: bet.agreementApprovals })
      );
    case 'history_confirm':
      return (
        !!history &&
        participant &&
        !history.correction &&
        !history.approvals.some((approval) => approval.actorId === memberId)
      );
    case 'history_correction':
      return !!history && participant && !history.correction && history.proposedBy !== memberId;
    case 'history_revision':
      return !!history && participant;
    case 'withdraw_proposal':
      return (
        (bet.status === 'active' && (own(bet.amendment) || own(bet.voidProposal))) ||
        // Readiness evidence, once nothing else is open: the engine checks it last.
        (bet.status === 'active' && !open && bet.readiness?.markedBy === memberId) ||
        (bet.status === 'confirming' && method === 'mutual' && own(bet.resolution)) ||
        (bet.status === 'settling' && own(bet.settlement))
      );
    case 'decline_judging':
      return (
        judge &&
        ['pending', 'active'].includes(bet.status) &&
        !bet.resolution &&
        !bet.adjudication &&
        (!bet.history || bet.history.stage === 'active') &&
        !bet.judgeDeclined
      );
    case 'reject_amendment':
      return bet.status === 'active' && answering(bet.amendment);
    case 'reject_void':
      return bet.status === 'active' && answering(bet.voidProposal);
    case 'check_in':
      return inPlay;
    // Evidence on the bet belongs to whoever added it: only they can replace it.
    case 'ready':
      return inPlay && !open && (!bet.readiness || bet.readiness.markedBy === memberId);
    // The other bettor's answer to it: disagreeing takes it off the bet.
    case 'dispute_readiness':
      return inPlay && !open && !!bet.readiness && bet.readiness.markedBy !== memberId;
    case 'amendment':
    case 'void':
      return inPlay && !open;
    case 'result':
      return inPlay && !open && method === 'mutual' && ready();
    case 'prompt':
      return inPlay && !open && method === 'chatgpt';
    case 'adjudication': {
      if (bet.status !== 'active' || open || !ready()) return false;
      if (method === 'judge') return judge && !bet.judgeDeclined;
      const prompt = bet.promptAgreement;
      return (
        method === 'chatgpt' &&
        participant &&
        !!prompt &&
        [bet.creatorId, bet.opponentId].every((id) => prompt.approvals.includes(id))
      );
    }
    case 'dispute_result': {
      const resolution = bet.resolution;
      // An adjudicated result is the recorder's, so each bettor answers it.
      return (
        bet.status === 'confirming' &&
        !!resolution &&
        participant &&
        !resolution.approvals.includes(memberId) &&
        (method !== 'mutual' || resolution.proposedBy !== memberId)
      );
    }
    case 'settlement':
      return bet.status === 'owed' && participant;
    case 'dispute_settlement':
      return bet.status === 'settling' && answering(bet.settlement);
    default:
      return false;
  }
}

export type ReplacementForm = 'void' | 'dispute_result';
// The form that carries the same intent once the bet has moved on: backing out of a bet that was
// agreed meanwhile means calling it off; a result naming a different winner from the one the
// other bettor filed meanwhile becomes a disagreement with it. A delivery report never becomes a
// dispute: two people reporting a delivery agree that it happened.
const replacements: Record<string, ReplacementForm> = {
  decline: 'void',
  withdraw: 'void',
  result: 'dispute_result',
};
/**
 * When an open form no longer applies, the form a draft can move to, if any. A result draft only
 * becomes a disagreement once it names a winner (null for none) other than the one now proposed.
 */
export function replacementForm(
  form: string,
  bet: Bet,
  memberId: string,
  draft: { winnerId?: string | null } = {},
): ReplacementForm | null {
  const next = replacements[form];
  if (
    form === 'result' &&
    (draft.winnerId === undefined || draft.winnerId === bet.resolution?.winnerId)
  )
    return null;
  return next && formApplies(next, bet, memberId) ? next : null;
}
/**
 * A result, delivery or evidence draft overtaken by the other bettor filing their own: the record
 * the member can answer instead of writing theirs. Evidence never becomes a disagreement on its
 * own, since the draft may agree with the evidence now on the bet.
 */
export function answerInstead(
  form: string,
  bet: Bet,
  memberId: string,
): 'result' | 'settlement' | 'readiness' | null {
  if (form === 'result' && formApplies('dispute_result', bet, memberId)) return 'result';
  if (form === 'settlement' && formApplies('dispute_settlement', bet, memberId))
    return 'settlement';
  if (form === 'ready' && formApplies('dispute_readiness', bet, memberId)) return 'readiness';
  return null;
}
