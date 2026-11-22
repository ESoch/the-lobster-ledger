import type {
  AuditEvent,
  Balance,
  Bet,
  BetAction,
  BetEntrySource,
  DebtOffsetPreview,
  DebtOffset,
  DecisionMethod,
  HistoryRevision,
  Member,
  MemberStats,
  NewBet,
} from './types';
import {
  agreedTiming,
  amendmentKeepsDeclinedJudge,
  betReadiness,
  boundedText,
  textKey,
  validateAcknowledgements,
  validateHistoricalDate,
  validateHistory,
  validateTiming,
  validateZonedDateTime,
} from './bet-workflow';
import { entrySourceLabel } from './entry-source';
import { LIMITS } from './limits';
import { promptKey } from './prompt-diff';
import {
  approvedByBoth,
  getOffsetRolls,
  getRemainingRolls,
  hasConfirmedResult,
  hasDebt,
  parties,
} from './rolls';

export { getOffsetRolls, getRemainingRolls, getDeliveredRolls } from './rolls';

export function previewDebtOffset(
  bets: Bet[],
  actorId: string,
  counterpartyId: string,
): DebtOffsetPreview | null {
  if (!actorId || !counterpartyId || actorId === counterpartyId)
    throw new Error('Choose another bettor to offset mutual debts.');
  // Delivery proposals remain outstanding but cannot participate in an offset.
  const eligible = bets
    .filter(
      (bet) =>
        bet.status === 'owed' &&
        hasDebt(bet) &&
        parties(bet).includes(actorId) &&
        parties(bet).includes(counterpartyId) &&
        getRemainingRolls(bet) > 0,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const incoming = eligible.filter((bet) => bet.resolution!.winnerId === actorId);
  const outgoing = eligible.filter((bet) => bet.resolution!.winnerId === counterpartyId);
  const total = (items: Bet[]) => items.reduce((sum, bet) => sum + getRemainingRolls(bet), 0);
  const rolls = Math.min(total(incoming), total(outgoing));
  if (!rolls) return null;
  const allocate = (items: Bet[]) => {
    let remaining = rolls;
    return items.flatMap((bet) => {
      if (!remaining) return [];
      const amount = Math.min(remaining, getRemainingRolls(bet));
      remaining -= amount;
      return [{ betId: bet.id, version: bet.version, rolls: amount }];
    });
  };
  return { counterpartyId, rolls, allocations: [...allocate(incoming), ...allocate(outgoing)] };
}

export function applyDebtOffset(
  bets: Bet[],
  preview: DebtOffsetPreview,
  actorId: string,
  now = new Date().toISOString(),
): { offset: DebtOffset; bets: Bet[] } {
  const current = previewDebtOffset(bets, actorId, preview.counterpartyId);
  if (
    !current ||
    current.rolls !== preview.rolls ||
    JSON.stringify(current.allocations) !== JSON.stringify(preview.allocations)
  )
    throw new Error('Debts changed. Review a fresh offset preview before applying it.');
  const affected = current.allocations.map((item) => bets.find((bet) => bet.id === item.betId)!);
  const offset: DebtOffset = {
    ...current,
    id: crypto.randomUUID(),
    actorId,
    at: now,
    references: Object.fromEntries(affected.map((bet) => [bet.id, bet.reference])),
  };
  const updated = affected.map((bet): Bet => {
    const amount = current.allocations.find((item) => item.betId === bet.id)!.rolls;
    const remaining = getRemainingRolls(bet) - amount;
    const linked = affected
      .filter((other) => other.id !== bet.id)
      .map((other) => other.reference)
      .join(', ');
    return {
      ...bet,
      offsets: [...(bet.offsets ?? []), offset],
      status: remaining === 0 ? 'settled' : 'owed',
      version: bet.version + 1,
      updatedAt: now,
      events: [
        ...bet.events,
        {
          id: crypto.randomUUID(),
          at: now,
          actorId,
          type: 'offset_debts',
          detail: `Offset ${amount} roll${amount === 1 ? '' : 's'} against mutual debts with ${linked}. ${remaining} remaining. No physical delivery recorded. Offset ${offset.id}.`,
        },
      ],
    };
  });
  return { offset, bets: updated };
}

const requiredText = (value: unknown, label: string, max: number): string =>
  boundedText(value, label, { min: 1, max });
/** "a", "a and b", "a, b and c" for the immutable audit text. */
const listed = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
/** The parts of a reported past bet that its stage includes, as acknowledged by each bettor. */
const reportedParts = (history: { result?: unknown; delivery?: unknown }, delivery: string) =>
  listed(['terms', ...(history.result ? ['result'] : []), ...(history.delivery ? [delivery] : [])]);
/**
 * Plain words for the immutable audit text. A judge's id stays in a "(judge <id>)" token so
 * audit-display can show the member's name without the record ever embedding a name.
 */
const decisionMethodPhrase = (method: { decisionMethod: DecisionMethod; judgeId?: string }) =>
  method.decisionMethod === 'judge'
    ? `a named judge (judge ${method.judgeId})`
    : method.decisionMethod === 'chatgpt'
      ? 'a recorded ChatGPT recommendation'
      : 'mutual agreement';
/** Stable serialisation for "does this proposal change anything" comparisons. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

/** The ChatGPT share link a response records, or a refusal; forms check a link against it too. */
export function shareUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = requiredText(value, 'ChatGPT share link', 500);
  let url: URL;
  try {
    url = new URL(clean);
  } catch {
    throw new Error('Use an official HTTPS ChatGPT share link.');
  }
  if (
    url.protocol !== 'https:' ||
    !['chatgpt.com', 'chat.openai.com'].includes(url.hostname) ||
    !/^\/share\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error('Use an official HTTPS ChatGPT share link.');
  return clean;
}

export function createBet(
  input: NewBet,
  actorId: string,
  members: Member[],
  now = new Date().toISOString(),
  entrySource?: BetEntrySource,
): Bet {
  // Entry points supply this independently of the member-entered agreement.
  if (entrySource !== undefined && !['browser', 'cli', 'mcp'].includes(entrySource))
    throw new Error('Invalid bet entry source.');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Creation time must be valid.');
  now = new Date(now).toISOString();
  if (!members.some((member) => member.id === actorId))
    throw new Error('The creator must be a member of this group.');
  if (actorId === input.opponentId || !members.some((member) => member.id === input.opponentId))
    throw new Error('Choose another member as your opponent.');
  if (!Number.isInteger(input.stake) || input.stake < 1 || input.stake > 100)
    throw new Error('Stake must be a whole number from 1 to 100 lobster rolls.');
  if (!['Work', 'Sports', 'Life', 'Wild card'].includes(input.category))
    throw new Error('Choose a valid category.');
  const decisionMethod = input.decisionMethod ?? 'mutual';
  if (!['mutual', 'judge', 'chatgpt'].includes(decisionMethod))
    throw new Error('Choose a valid decision method.');
  if (decisionMethod === 'judge') {
    if (
      !input.judgeId ||
      [actorId, input.opponentId].includes(input.judgeId) ||
      !members.some((member) => member.id === input.judgeId)
    )
      throw new Error('Choose another registered member as the independent judge.');
  } else if (input.judgeId !== undefined) throw new Error('Only a judged bet can name a judge.');
  const deadline = input.deadline ?? '';
  if (deadline) validateHistoricalDate({ precision: 'day', value: deadline });
  else if (!input.timing && (!input.history || input.history.stage === 'active'))
    throw new Error('Choose a valid decision date or decision timing.');
  const timing = input.timing === undefined ? undefined : validateTiming(input.timing);
  const cutoff = input.cutoff === undefined ? undefined : validateZonedDateTime(input.cutoff);
  const history =
    input.history === undefined
      ? undefined
      : validateHistory(input.history, [actorId, input.opponentId], now);
  const acknowledgements = history
    ? validateAcknowledgements(history, input.acknowledgements)
    : undefined;
  if (!history && input.acknowledgements !== undefined)
    throw new Error('Historical acknowledgements require historical details.');
  let location: Bet['location'];
  if (input.location !== undefined) {
    const place = input.location;
    if (
      !place ||
      !Number.isFinite(place.lat) ||
      Math.abs(place.lat) > 90 ||
      !Number.isFinite(place.lng) ||
      Math.abs(place.lng) > 180
    )
      throw new Error('Choose a location with valid map coordinates.');
    location = {
      id: requiredText(place.id, 'Location ID', 200),
      name: requiredText(place.name, 'Location name', 200),
      address: requiredText(place.address, 'Location address', 500),
      lat: place.lat,
      lng: place.lng,
    };
  }
  const creatorSide = boundedText(input.creatorSide, 'Your position', LIMITS.side);
  const opponentSide = boundedText(input.opponentSide, 'Opponent position', LIMITS.side);
  if (textKey(creatorSide) === textKey(opponentSide))
    throw new Error('The two positions are identical. Each side must take a different position.');
  const id = crypto.randomUUID();
  return {
    title: boundedText(input.title, 'Title', LIMITS.title),
    terms: boundedText(input.terms, 'Decision criteria', LIMITS.terms),
    creatorSide,
    opponentSide,
    opponentId: input.opponentId,
    stake: input.stake,
    category: input.category,
    deadline,
    ...(timing ? { timing } : {}),
    ...(cutoff ? { cutoff } : {}),
    ...(history
      ? {
          history: {
            ...history,
            proposedBy: actorId,
            revision: 1,
            approvals: [{ actorId, at: now, acknowledgements: acknowledgements! }],
          },
        }
      : {}),
    decisionMethod,
    ...(decisionMethod === 'judge' ? { judgeId: input.judgeId } : {}),
    ...(location ? { location } : {}),
    id,
    reference: `LL-${id.slice(0, 8).toUpperCase()}`,
    ...(entrySource ? { entrySource } : {}),
    creatorId: actorId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    version: 1,
    agreementApprovals: [actorId],
    events: [
      {
        id: crypto.randomUUID(),
        at: now,
        actorId,
        type: 'created',
        detail:
          (history
            ? history.stage === 'active'
              ? 'Reported a past bet that is still in play and acknowledged its terms. Awaiting the other bettor.'
              : `Reported a past bet and acknowledged its ${reportedParts(history, 'actual delivery')}. Awaiting the other bettor.`
            : 'Proposed the agreement and approved its terms.') +
          (entrySource ? ` Entered via ${entrySourceLabel(entrySource)}.` : ''),
      },
    ],
  };
}

export function applyAction(
  bet: Bet,
  action: BetAction,
  actorId: string,
  now = new Date().toISOString(),
): Bet {
  const assignedJudge = bet.decisionMethod === 'judge' && bet.judgeId === actorId;
  const judgeActions = ['adjudicate', 'decline_judging'];
  if (!parties(bet).includes(actorId) && !(assignedJudge && judgeActions.includes(action.type)))
    throw new Error(
      'Only the bettors, or the assigned judge recording a recommendation, can act on this bet.',
    );
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(bet.updatedAt))
    throw new Error('Action time cannot precede the latest event.');
  now = new Date(now).toISOString();
  // Errors name the field the person filled in. A recorded ChatGPT response may be as long as
  // the prompt that produced it.
  const noteLabel: Partial<Record<BetAction['type'], string>> = {
    propose_settlement: 'Delivery details',
    dispute_result: 'Reason for disagreeing',
    dispute_settlement: 'Reason for disagreeing',
    dispute_readiness: 'Reason for disagreeing',
    propose_result: 'Evidence or explanation',
    adjudicate:
      bet.decisionMethod === 'chatgpt' ? 'Response and reasoning' : 'Recommendation and reasoning',
    request_history_correction: 'Correction',
  };
  const note =
    'note' in action
      ? boundedText(
          action.note,
          noteLabel[action.type] ?? 'Reason',
          action.type === 'adjudicate' ? LIMITS.response : LIMITS.note,
        )
      : '';
  const next = structuredClone(bet);
  if (
    next.history &&
    next.status === 'pending' &&
    ![
      'confirm_history',
      'request_history_correction',
      'revise_history',
      'decline',
      'withdraw',
      'decline_judging',
    ].includes(action.type)
  )
    throw new Error(
      'Review the historical proposal and explicitly acknowledge its applicable stages.',
    );
  const whileProposalOpen = ['set_check_in', 'withdraw_proposal', 'decline_judging'];
  if (
    (next.amendment &&
      !['confirm_amendment', 'reject_amendment', ...whileProposalOpen].includes(action.type)) ||
    (next.voidProposal &&
      !['confirm_void', 'reject_void', ...whileProposalOpen].includes(action.type))
  )
    throw new Error(
      'Review the pending amendment or no-winner proposal before taking another outcome action.',
    );
  if (
    !['pending', 'declined'].includes(next.status) &&
    !approvedByBoth(next, next.agreementApprovals)
  )
    throw new Error('Both participants must approve the agreement first.');
  const stage = (status: Bet['status']) => {
    if (next.status !== status) throw new Error(`This action requires a ${status} bet.`);
  };
  const counterparty = (approvals: string[], proposer: string) => {
    if (approvals.length !== 1 || approvals[0] !== proposer || !parties(next).includes(proposer))
      throw new Error('The proposal must have exactly one valid participant approval.');
    if (approvals.includes(actorId)) throw new Error('You have already approved this proposal.');
  };
  const resultApprover = () => {
    const resolution = next.resolution;
    if (!resolution) throw new Error('There is no result to review.');
    if ((next.decisionMethod ?? 'mutual') === 'mutual') {
      counterparty(resolution.approvals, resolution.proposedBy);
      return;
    }
    if (
      !next.adjudication ||
      next.adjudication.method !== next.decisionMethod ||
      next.adjudication.recordedBy !== resolution.proposedBy ||
      next.adjudication.winnerId !== resolution.winnerId
    )
      throw new Error('A valid adjudication must be recorded first.');
    if (
      resolution.approvals.length > 1 ||
      resolution.approvals.some((id) => !parties(next).includes(id))
    )
      throw new Error('The result contains invalid approvals.');
    if (resolution.approvals.includes(actorId))
      throw new Error('You have already approved this result.');
  };
  let detail: string;
  let historySnapshot: AuditEvent['historySnapshot'];
  let amendmentSnapshot: AuditEvent['amendmentSnapshot'];
  switch (action.type) {
    case 'confirm_history': {
      stage('pending');
      const history = next.history;
      if (!history) throw new Error('There is no history proposal to confirm.');
      if (history.correction)
        throw new Error('Revise the requested correction before confirming history.');
      counterparty(
        history.approvals.map((approval) => approval.actorId),
        history.proposedBy,
      );
      validateHistory(history, parties(next), now);
      for (const approval of history.approvals)
        validateAcknowledgements(history, approval.acknowledgements);
      const acknowledgements = validateAcknowledgements(history, action.acknowledgements);
      history.approvals.push({ actorId, at: now, acknowledgements });
      history.confirmedAt = now;
      next.agreementApprovals = history.approvals.map((approval) => approval.actorId);
      next.status = history.stage;
      if (history.result)
        next.resolution = {
          winnerId: history.result.winnerId,
          note: history.result.note,
          proposedBy: history.proposedBy,
          approvals: [...next.agreementApprovals],
        };
      if (history.delivery)
        next.settlement = {
          method: 'roll',
          note: history.delivery.note,
          proposedBy: history.proposedBy,
          approvals: [...next.agreementApprovals],
          rolls: next.stake,
        };
      detail = `Both original bettors acknowledged the reported ${reportedParts(history, 'delivery of actual lobster rolls')}. Historical record confirmed.`;
      break;
    }
    case 'request_history_correction':
      stage('pending');
      if (!next.history) throw new Error('There is no historical proposal to correct.');
      if (next.history.proposedBy === actorId)
        throw new Error(
          'This is your own report. Revise it directly instead of requesting a correction.',
        );
      if (next.history.correction) throw new Error('A correction is already awaiting revision.');
      next.history.correction = { requestedBy: actorId, at: now, note };
      detail = `Requested a correction to the historical proposal: ${note}`;
      break;
    case 'revise_history': {
      stage('pending');
      if (!next.history) throw new Error('There is no historical proposal to revise.');
      historySnapshot = { ...historicalRevision(next), proposal: structuredClone(next.history) };
      const revision = action.revision;
      const candidate = createBet(
        {
          title: revision.title,
          terms: revision.terms,
          category: revision.category,
          creatorSide: revision.creatorSide,
          opponentSide: revision.opponentSide,
          stake: revision.stake,
          deadline: revision.deadline,
          location: revision.location,
          history: revision.history,
          timing: revision.timing,
          cutoff: revision.cutoff,
          acknowledgements: action.acknowledgements,
          opponentId: next.opponentId,
          decisionMethod: next.decisionMethod,
          judgeId: next.judgeId,
        },
        next.creatorId,
        [...new Set([...parties(next), ...(next.judgeId ? [next.judgeId] : [])])].map((id) => ({
          id,
          name: id,
          initials: id,
          color: '',
        })),
        now,
      );
      if (canonical(historicalRevision(candidate)) === canonical(historicalRevision(next)))
        throw new Error(
          'This revision changes nothing. Edit the record before proposing it again.',
        );
      next.title = candidate.title;
      next.terms = candidate.terms;
      next.category = candidate.category;
      next.creatorSide = candidate.creatorSide;
      next.opponentSide = candidate.opponentSide;
      next.stake = candidate.stake;
      next.deadline = candidate.deadline;
      delete next.location;
      delete next.timing;
      delete next.cutoff;
      if (candidate.location) next.location = candidate.location;
      if (candidate.timing) next.timing = candidate.timing;
      if (candidate.cutoff) next.cutoff = candidate.cutoff;
      next.history = {
        ...candidate.history!,
        proposedBy: actorId,
        revision: next.history.revision + 1,
        approvals: [
          {
            actorId,
            at: now,
            acknowledgements: validateAcknowledgements(candidate.history!, action.acknowledgements),
          },
        ],
      };
      next.agreementApprovals = [actorId];
      detail =
        'Revised the historical proposal and explicitly acknowledged its applicable stages. All prior approvals require renewal.';
      break;
    }
    case 'mark_ready':
      stage('active');
      // Each bettor's evidence stays theirs: the other bettor disagrees with it, never overwrites it.
      if (next.readiness && next.readiness.markedBy !== actorId)
        throw new Error(
          'The other bettor already added evidence for review. Disagree with it if it does not show the answer, rather than replacing it.',
        );
      next.readiness = {
        markedBy: actorId,
        at: now,
        evidence: requiredText(action.evidence, 'Readiness evidence', 2000),
      };
      detail = `Marked evidence ready for review: ${next.readiness.evidence} No winner or debt has been recorded.`;
      break;
    case 'dispute_readiness':
      stage('active');
      if (!next.readiness) throw new Error('There is no readiness evidence to disagree with.');
      if (next.readiness.markedBy === actorId)
        throw new Error('This is your own evidence. Take it back instead of disagreeing with it.');
      delete next.readiness;
      detail = `Disputed the readiness evidence: ${note}`;
      break;
    case 'set_check_in':
      stage('active');
      next.checkIns = {
        ...next.checkIns,
        [actorId]: action.checkIn === null ? null : validateZonedDateTime(action.checkIn),
      };
      detail =
        action.checkIn === null
          ? 'Removed their personal check-in. The agreed timing is unchanged.'
          : `Set their personal check-in to ${next.checkIns[actorId]!.at} (${next.checkIns[actorId]!.timezone}). The agreed timing is unchanged.`;
      break;
    case 'propose_amendment': {
      stage('active');
      const terms = boundedText(action.terms, 'Revised decision criteria', LIMITS.terms);
      const timing = validateTiming(action.timing);
      const cutoff = action.cutoff ? validateZonedDateTime(action.cutoff) : undefined;
      let method: { decisionMethod: DecisionMethod; judgeId?: string } | undefined;
      if (action.decisionMethod !== undefined) {
        if (!['mutual', 'judge', 'chatgpt'].includes(action.decisionMethod))
          throw new Error('Choose a valid decision method.');
        if (action.decisionMethod === 'judge') {
          if (
            typeof action.judgeId !== 'string' ||
            !action.judgeId.trim() ||
            parties(next).includes(action.judgeId)
          )
            throw new Error('Choose another registered member as the independent judge.');
          if (next.judgeDeclined && action.judgeId === next.judgeId)
            throw new Error('That judge declined this bet. Choose another judge or method.');
          method = { decisionMethod: 'judge', judgeId: action.judgeId };
        } else if (action.judgeId !== undefined)
          throw new Error('Only a judged bet can name a judge.');
        else method = { decisionMethod: action.decisionMethod };
      } else if (action.judgeId !== undefined)
        throw new Error('Choose the judge decision method when naming a judge.');
      const sameMethod =
        !method ||
        (method.decisionMethod === (next.decisionMethod ?? 'mutual') &&
          (method.judgeId ?? null) === (next.judgeId ?? null));
      // A legacy decision date restated as the same day's timing is not a change.
      if (
        terms === next.terms &&
        canonical(timing) === canonical(agreedTiming(next) ?? null) &&
        canonical(cutoff ?? null) === canonical(next.cutoff ?? null) &&
        sameMethod
      )
        throw new Error(
          'This proposal changes nothing. Edit the criteria, timing, cutoff or decision method before proposing it.',
        );
      next.amendment = {
        terms,
        timing,
        ...(cutoff ? { cutoff } : {}),
        ...method,
        note,
        proposedBy: actorId,
        approvals: [actorId],
        at: now,
      };
      amendmentSnapshot = {
        terms: next.terms,
        deadline: next.deadline,
        ...(next.timing ? { timing: structuredClone(next.timing) } : {}),
        ...(next.cutoff ? { cutoff: structuredClone(next.cutoff) } : {}),
        ...(method ? { decisionMethod: next.decisionMethod ?? 'mutual' } : {}),
        ...(method && next.judgeId ? { judgeId: next.judgeId } : {}),
        proposal: structuredClone(next.amendment),
      };
      detail = `Proposed revised decision criteria and timing: ${terms}${
        method ? `\nProposed decision method: ${decisionMethodPhrase(method)}` : ''
      }\nReason: ${note}`;
      break;
    }
    case 'confirm_amendment': {
      stage('active');
      if (!next.amendment) throw new Error('There is no amendment to confirm.');
      counterparty(next.amendment.approvals, next.amendment.proposedBy);
      // A judge who stepped down after this amendment was proposed cannot be put back by it.
      const keepsJudge =
        next.amendment.decisionMethod === 'judge' && next.amendment.judgeId === next.judgeId;
      if (amendmentKeepsDeclinedJudge(next))
        throw new Error('That judge stepped down; propose a new judge or decision method.');
      next.terms = next.amendment.terms;
      next.timing = next.amendment.timing;
      next.deadline = '';
      delete next.cutoff;
      if (next.amendment.cutoff) next.cutoff = next.amendment.cutoff;
      if (next.amendment.decisionMethod) {
        next.decisionMethod = next.amendment.decisionMethod;
        if (next.amendment.judgeId) next.judgeId = next.amendment.judgeId;
        else delete next.judgeId;
        if (!keepsJudge) delete next.judgeDeclined;
      }
      // Personal check-ins scheduled after the newly agreed decision time no longer make sense.
      let checkInsCleared = false;
      if (next.timing.kind === 'date' && next.checkIns) {
        const limit = Date.parse(next.timing.at);
        for (const [id, checkIn] of Object.entries(next.checkIns))
          if (checkIn && Date.parse(checkIn.at) > limit) {
            delete next.checkIns[id];
            checkInsCleared = true;
          }
        if (!Object.keys(next.checkIns).length) delete next.checkIns;
      }
      // The record names only what this approval actually cleared.
      const cleared = [
        ...(next.readiness ? ['readiness evidence'] : []),
        ...(next.promptAgreement ? ['ChatGPT prompt consent'] : []),
      ];
      if (next.promptAgreement)
        next.promptVersion = Math.max(next.promptVersion ?? 0, next.promptAgreement.version);
      delete next.promptAgreement;
      delete next.readiness;
      delete next.adjudication;
      const rewired = next.amendment.decisionMethod
        ? ` The bet is now decided by ${decisionMethodPhrase({ decisionMethod: next.amendment.decisionMethod, judgeId: next.amendment.judgeId })}.`
        : '';
      delete next.amendment;
      detail = `Both bettors approved the revised decision criteria and timing.${rewired}${
        cleared.length
          ? ` Earlier ${listed(cleared)} ${cleared.length === 1 ? 'was' : 'were'} cleared.`
          : ''
      }${checkInsCleared ? ' Personal check-ins after the new decision time were cleared.' : ''}`;
      break;
    }
    case 'reject_amendment':
      stage('active');
      if (!next.amendment) throw new Error('There is no amendment to reject.');
      counterparty(next.amendment.approvals, next.amendment.proposedBy);
      delete next.amendment;
      detail = `Declined the proposed amendment; the current agreement remains: ${note}`;
      break;
    case 'propose_void':
      stage('active');
      next.voidProposal = { note, proposedBy: actorId, approvals: [actorId], at: now };
      detail = `Proposed calling off the bet with no winner: ${note}`;
      break;
    case 'confirm_void':
      stage('active');
      if (!next.voidProposal) throw new Error('There is no no-winner proposal to confirm.');
      counterparty(next.voidProposal.approvals, next.voidProposal.proposedBy);
      next.resolution = {
        winnerId: null,
        note: next.voidProposal.note,
        proposedBy: next.voidProposal.proposedBy,
        approvals: [next.voidProposal.proposedBy, actorId],
      };
      next.status = 'voided';
      delete next.voidProposal;
      detail = 'Both bettors agreed to call off the bet with no winner. No rolls are owed.';
      break;
    case 'reject_void':
      stage('active');
      if (!next.voidProposal) throw new Error('There is no no-winner proposal to reject.');
      counterparty(next.voidProposal.approvals, next.voidProposal.proposedBy);
      delete next.voidProposal;
      detail = `Declined calling off the bet; the current agreement remains: ${note}`;
      break;
    case 'accept':
      stage('pending');
      counterparty(next.agreementApprovals, next.creatorId);
      next.agreementApprovals.push(actorId);
      next.status = 'active';
      detail = 'Accepted the agreement. Both participants have approved the terms.';
      break;
    case 'decline':
      stage('pending');
      counterparty(next.agreementApprovals, next.history?.proposedBy ?? next.creatorId);
      next.status = 'declined';
      detail = `Declined the agreement: ${note}`;
      break;
    case 'withdraw':
      stage('pending');
      if (next.agreementApprovals.length !== 1 || next.agreementApprovals[0] !== actorId)
        throw new Error(
          'Only the person who proposed this bet can withdraw it, until it is answered.',
        );
      next.status = 'declined';
      detail = `Withdrew the proposal: ${note}`;
      break;
    case 'withdraw_proposal': {
      const own = (proposal?: { proposedBy: string; approvals: string[] }) =>
        !!proposal &&
        proposal.proposedBy === actorId &&
        proposal.approvals.length === 1 &&
        proposal.approvals[0] === actorId;
      if (next.amendment || next.voidProposal) {
        if (next.status === 'active' && own(next.amendment)) {
          delete next.amendment;
          detail = `Withdrew their amendment proposal; the current agreement remains: ${note}`;
        } else if (next.status === 'active' && own(next.voidProposal)) {
          delete next.voidProposal;
          detail = `Withdrew their no-winner proposal; the current agreement remains: ${note}`;
        } else throw new Error('Only the person who made this proposal can withdraw it.');
      } else if (next.status === 'confirming') {
        if ((next.decisionMethod ?? 'mutual') !== 'mutual' || !own(next.resolution))
          throw new Error(
            'Only the bettor who proposed this result can withdraw it before the other bettor answers.',
          );
        delete next.resolution;
        next.status = 'active';
        detail = `Withdrew their proposed result; the bet is back in play: ${note}`;
      } else if (next.status === 'settling') {
        if (!own(next.settlement))
          throw new Error('Only the person who reported this delivery can withdraw the report.');
        delete next.settlement;
        next.status = 'owed';
        detail = `Withdrew their delivery report; the rolls remain owed: ${note}`;
      } else if (next.status === 'active' && next.readiness?.markedBy === actorId) {
        delete next.readiness;
        detail = `Withdrew their readiness evidence: ${note}`;
      } else throw new Error('You have no open proposal on this bet to withdraw.');
      break;
    }
    case 'decline_judging':
      if (!assignedJudge) throw new Error('Only the named judge can decline to judge this bet.');
      if (!['pending', 'active'].includes(next.status) || next.resolution || next.adjudication)
        throw new Error('A judge can only step down before a result is recorded.');
      // A reported past bet past its 'active' stage carries a decided result.
      if (next.history && next.history.stage !== 'active')
        throw new Error('The result is already recorded. A judge can no longer step down.');
      if (next.judgeDeclined) throw new Error('You have already declined to judge this bet.');
      next.judgeDeclined = { at: now, note };
      detail = `Declined to act as judge: ${note} Both bettors must agree on a new judge or decision method before a recommendation can be recorded.`;
      break;
    case 'propose_result':
      stage('active');
      if (!betReadiness(next, now).ready)
        throw new Error(
          'Decision timing is not ready for an outcome. Mark the supporting evidence ready for early review.',
        );
      if ((next.decisionMethod ?? 'mutual') !== 'mutual')
        throw new Error('Use the agreed judge or ChatGPT process to record this result.');
      if (action.winnerId !== null && !parties(next).includes(action.winnerId))
        throw new Error('The winner must be one of the two participants.');
      next.resolution = {
        winnerId: action.winnerId,
        note,
        proposedBy: actorId,
        approvals: [actorId],
      };
      next.status = 'confirming';
      detail = `Proposed ${action.winnerId === null ? 'a void result' : `winner ${action.winnerId}`}: ${note}`;
      break;
    case 'propose_prompt': {
      if (next.status !== 'pending' || next.history) stage('active');
      if (next.decisionMethod !== 'chatgpt')
        throw new Error('Prompt agreements are only available for ChatGPT bets.');
      const text = boundedText(action.text, 'Fair adjudication prompt', LIMITS.prompt);
      // Spacing nobody can see is not a revision both bettors must approve again.
      if (next.promptAgreement && promptKey(next.promptAgreement.text) === promptKey(text))
        throw new Error(
          `This prompt is identical to version ${next.promptAgreement.version} and changes nothing. Edit the text before proposing a new version.`,
        );
      const version = Math.max(next.promptVersion ?? 0, next.promptAgreement?.version ?? 0) + 1;
      next.promptVersion = version;
      next.promptAgreement = { text, proposedBy: actorId, approvals: [actorId], at: now, version };
      detail = `Proposed and approved ChatGPT prompt version ${version}. Exact prompt:\n${text}`;
      break;
    }
    case 'approve_prompt':
      stage('active');
      if (next.decisionMethod !== 'chatgpt' || !next.promptAgreement)
        throw new Error('There is no ChatGPT prompt to approve.');
      counterparty(next.promptAgreement.approvals, next.promptAgreement.proposedBy);
      next.promptAgreement.approvals.push(actorId);
      detail = `Both bettors approved the exact text of ChatGPT prompt version ${next.promptAgreement.version}.`;
      break;
    case 'adjudicate': {
      stage('active');
      if (!betReadiness(next, now).ready)
        throw new Error(
          'Decision timing is not ready for adjudication. A bettor must mark the supporting evidence ready for early review.',
        );
      if (next.decisionMethod !== 'judge' && next.decisionMethod !== 'chatgpt')
        throw new Error('This bet uses mutual decision without an adjudicator.');
      if (next.decisionMethod === 'judge' && !assignedJudge)
        throw new Error('Only the assigned judge can record the recommendation.');
      if (next.decisionMethod === 'judge' && next.judgeDeclined)
        throw new Error(
          'The named judge declined this bet. Both bettors must agree on a new judge or decision method first.',
        );
      if (
        next.decisionMethod === 'chatgpt' &&
        (!next.promptAgreement || !approvedByBoth(next, next.promptAgreement.approvals))
      )
        throw new Error(
          'Both bettors must approve the exact ChatGPT prompt before recording its recommendation.',
        );
      if (action.winnerId !== null && !parties(next).includes(action.winnerId))
        throw new Error('The recommended winner must be one of the two bettors.');
      const sourceUrl = shareUrl(action.sourceUrl);
      next.adjudication = {
        method: next.decisionMethod,
        winnerId: action.winnerId,
        reasoning: note,
        recordedBy: actorId,
        at: now,
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(next.decisionMethod === 'chatgpt'
          ? { promptVersion: next.promptAgreement!.version }
          : {}),
      };
      next.resolution = { winnerId: action.winnerId, note, proposedBy: actorId, approvals: [] };
      next.status = 'confirming';
      detail = `Recorded ${next.decisionMethod === 'judge' ? 'the assigned judge’s' : `an externally obtained ChatGPT (prompt version ${next.promptAgreement!.version})`} recommendation for ${action.winnerId === null ? 'no winner' : `winner ${action.winnerId}`}: ${note}${sourceUrl ? `\nChatGPT source: ${sourceUrl}` : ''} Both bettors must separately confirm the result.`;
      break;
    }
    case 'confirm_result':
      stage('confirming');
      if (!next.resolution) throw new Error('There is no result to confirm.');
      resultApprover();
      next.resolution.approvals.push(actorId);
      if (approvedByBoth(next, next.resolution.approvals)) {
        next.status = next.resolution.winnerId === null ? 'voided' : 'owed';
        detail =
          next.status === 'voided'
            ? 'Both participants confirmed the bet is void. No rolls are owed.'
            : 'Both participants confirmed the result. The lobster rolls are now owed.';
      } else
        detail =
          'Confirmed the recommended result. The other bettor must still confirm before any rolls are owed.';
      break;
    case 'dispute_result':
      stage('confirming');
      if (!next.resolution) throw new Error('There is no result to dispute.');
      resultApprover();
      delete next.resolution;
      delete next.adjudication;
      next.status = 'active';
      detail = `Disputed the result: ${note}`;
      break;
    case 'propose_settlement':
      stage('owed');
      if (!hasConfirmedResult(next))
        throw new Error('Both participants must confirm a valid result first.');
      if (action.method !== 'roll')
        throw new Error('A debt can only be settled by buying the actual lobster rolls.');
      next.settlement = {
        method: 'roll',
        note,
        proposedBy: actorId,
        approvals: [actorId],
        rolls: getRemainingRolls(next),
      };
      next.status = 'settling';
      detail = `Reported delivery of ${getRemainingRolls(next)} actual lobster ${getRemainingRolls(next) === 1 ? 'roll' : 'rolls'}: ${note}`;
      break;
    case 'confirm_settlement':
      stage('settling');
      if (!next.settlement) throw new Error('There is no delivery to confirm.');
      counterparty(next.settlement.approvals, next.settlement.proposedBy);
      next.settlement.approvals.push(actorId);
      next.status = 'settled';
      detail = 'Both participants confirmed delivery of the actual lobster rolls. Debt settled.';
      break;
    case 'dispute_settlement':
      stage('settling');
      if (!next.settlement) throw new Error('There is no delivery to dispute.');
      counterparty(next.settlement.approvals, next.settlement.proposedBy);
      delete next.settlement;
      next.status = 'owed';
      detail = `Disputed the delivery: ${note}`;
      break;
    default:
      throw new Error('Unknown ledger action.');
  }
  next.version += 1;
  next.updatedAt = now;
  next.events.push({
    id: crypto.randomUUID(),
    at: now,
    actorId,
    type: action.type,
    detail,
    ...(historySnapshot ? { historySnapshot } : {}),
    ...(amendmentSnapshot ? { amendmentSnapshot } : {}),
  });
  return next;
}

export function getMemberStats(bets: Bet[], memberId: string): MemberStats {
  const stats: MemberStats = {
    memberId,
    won: 0,
    lost: 0,
    winRate: 0,
    rollsWon: 0,
    rollsLost: 0,
    net: 0,
    owedToYou: 0,
    youOwe: 0,
    settled: 0,
    active: 0,
  };
  for (const bet of bets) {
    if (!parties(bet).includes(memberId)) continue;
    if (['active', 'confirming'].includes(bet.status)) stats.active += 1;
    if (!hasConfirmedResult(bet)) continue;
    const winner = bet.resolution!.winnerId === memberId;
    if (winner) {
      stats.won += 1;
      stats.rollsWon += bet.stake;
    } else {
      stats.lost += 1;
      stats.rollsLost += bet.stake;
    }
    if (hasDebt(bet)) {
      if (winner) stats.owedToYou += getRemainingRolls(bet);
      else stats.youOwe += getRemainingRolls(bet);
    }
    stats.settled += bet.status === 'settled' ? bet.stake : getOffsetRolls(bet);
  }
  stats.net = stats.rollsWon - stats.rollsLost;
  stats.winRate = stats.won + stats.lost === 0 ? 0 : (stats.won / (stats.won + stats.lost)) * 100;
  return stats;
}

export function getBalances(bets: Bet[]): Balance[] {
  const pairs = new Map<string, { left: string; right: string; rolls: number }>();
  for (const bet of bets) {
    if (!hasDebt(bet)) continue;
    const [left, right] = parties(bet).sort() as [string, string];
    const key = JSON.stringify([left, right]);
    const pair = pairs.get(key) ?? { left, right, rolls: 0 };
    pair.rolls += (bet.resolution!.winnerId === right ? 1 : -1) * getRemainingRolls(bet);
    pairs.set(key, pair);
  }
  return [...pairs.values()]
    .filter((pair) => pair.rolls !== 0)
    .map((pair) => ({
      fromId: pair.rolls > 0 ? pair.left : pair.right,
      toId: pair.rolls > 0 ? pair.right : pair.left,
      rolls: Math.abs(pair.rolls),
    }))
    .sort((a, b) => b.rolls - a.rolls || a.fromId.localeCompare(b.fromId));
}

export function getDirectDebts(bets: Bet[]): Balance[] {
  const balances = new Map<string, Balance>();
  for (const bet of bets) {
    if (!hasDebt(bet)) continue;
    const toId = bet.resolution!.winnerId!;
    const fromId = toId === bet.creatorId ? bet.opponentId : bet.creatorId;
    const key = JSON.stringify([fromId, toId]);
    const previous = balances.get(key);
    balances.set(key, { fromId, toId, rolls: (previous?.rolls ?? 0) + getRemainingRolls(bet) });
  }
  return [...balances.values()].sort(
    (a, b) => b.rolls - a.rolls || a.fromId.localeCompare(b.fromId),
  );
}

function historicalRevision(bet: Bet): HistoryRevision {
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
    history: validateHistory(history, parties(bet)),
  };
}

export function needsAction(
  bet: Bet,
  memberId: string,
  now: string | Date | number = new Date(),
): boolean {
  if (bet.amendment || bet.voidProposal) {
    const proposal = bet.amendment ?? bet.voidProposal!;
    return parties(bet).includes(memberId) && !proposal.approvals.includes(memberId);
  }
  const judged = bet.decisionMethod === 'judge';
  if (bet.status === 'active' && judged && bet.judgeId === memberId)
    return !bet.judgeDeclined && betReadiness(bet, now).ready;
  if (!parties(bet).includes(memberId)) return false;
  if (bet.status === 'pending' && bet.history)
    return bet.history.correction
      ? bet.history.correction.requestedBy !== memberId
      : !bet.history.approvals.some((approval) => approval.actorId === memberId);
  if (bet.status === 'active') {
    // The judge stepped down: both bettors must re-appoint by amendment.
    if (judged && bet.judgeDeclined) return true;
    const awaitingPrompt =
      bet.decisionMethod === 'chatgpt' &&
      !!bet.promptAgreement &&
      !approvedByBoth(bet, bet.promptAgreement.approvals);
    if (awaitingPrompt && !bet.promptAgreement!.approvals.includes(memberId)) return true;
    const readiness = betReadiness(bet, now, memberId);
    // Like a judged bet, a prompt this bettor already approved waits on the other bettor.
    if (awaitingPrompt) return readiness.reviewDue === true && !readiness.ready;
    // While a judged bet waits on the judge, only a bettor's own check-in reminder is theirs to act on.
    if (judged) return readiness.reviewDue === true && !readiness.ready;
    return readiness.state === 'ready' || readiness.reviewDue === true;
  }
  if (bet.status === 'pending') return !bet.agreementApprovals.includes(memberId);
  if (bet.status === 'confirming')
    return !!bet.resolution && !bet.resolution.approvals.includes(memberId);
  if (bet.status === 'settling')
    return !!bet.settlement && !bet.settlement.approvals.includes(memberId);
  return false;
}
