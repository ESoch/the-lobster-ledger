import {
  BellRing,
  CalendarDays,
  Check,
  CircleCheck,
  CirclePause,
  Clock3,
  ExternalLink,
  History,
  MessageSquareWarning,
  Minus,
  X,
} from 'lucide-react';
import type {
  AgreementAmendment,
  AuditEvent,
  Bet,
  DecisionCutoff,
  DecisionMethod,
  DecisionTiming,
  HistoryRevision,
  Member,
} from '../lib/types';
import {
  agreedTiming,
  decisionTimingLabel,
  historyChanges,
  historyDateLabel,
  historyRevisionAfter,
  pendingNames,
  placeLabel,
  reviewStatus,
  zonedDateTimeLabel,
  type HistoryChange,
} from '../lib/bet-workflow';
import { closureRecord } from '../lib/bet-closure';
import { dateLabel, timeLabel } from './ui';
import { historyStageLabels } from './WorkflowFields';
import { LinkifiedText } from './LinkifiedText';

const zonedDateLabel = zonedDateTimeLabel;

function HistoricalFacts({
  record,
  members,
}: {
  record: Pick<HistoryRevision, 'history'>;
  members: Member[];
}) {
  const history = record.history;
  const winner =
    members.find((member) => member.id === history.result?.winnerId)?.name ?? 'Original bettor';
  return (
    <dl className="workflow-facts">
      <div>
        <dt>Reported stage</dt>
        <dd>{historyStageLabels[history.stage]}</dd>
      </div>
      <div>
        <dt>Original bet date</dt>
        <dd>{historyDateLabel(history.originalDate)}</dd>
      </div>
      {history.result && (
        <>
          <div>
            <dt>{history.stage === 'voided' ? 'Called off' : 'Decided'}</dt>
            <dd>{historyDateLabel(history.result.date)}</dd>
          </div>
          <div>
            <dt>Reported outcome</dt>
            <dd>
              {history.result.winnerId ? `${winner} won` : 'No winner'}
              <p>{history.result.note}</p>
            </dd>
          </div>
        </>
      )}
      {history.delivery && (
        <>
          <div>
            <dt>Rolls delivered</dt>
            <dd>{historyDateLabel(history.delivery.date)}</dd>
          </div>
          <div>
            <dt>Delivery details</dt>
            <dd>{history.delivery.note}</dd>
          </div>
        </>
      )}
      {history.previousAdjudication && (
        <div>
          <dt>
            Previous{' '}
            {history.previousAdjudication.method === 'judge'
              ? 'judge decision'
              : 'ChatGPT response'}
          </dt>
          <dd>
            {history.previousAdjudication.note}
            {history.previousAdjudication.sourceUrl && (
              <>
                <br />
                <a href={history.previousAdjudication.sourceUrl} target="_blank" rel="noreferrer">
                  View reported evidence
                  <ExternalLink size={13} aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** Free text is only marked as edited; the earlier revision in the trail holds the old words. */
const longFormChanges = new Set([
  'Criteria',
  'Reported outcome',
  'Reason for no winner',
  'Delivery details',
  'Previous decision',
]);

/** What a revision changed from the one before it, one part per line. */
function HistoryChanges({ lead, changes }: { lead: React.ReactNode; changes: HistoryChange[] }) {
  return (
    <div className="workflow-changes">
      <p>{lead}</p>
      <ul>
        {changes.map((change) => (
          <li key={change.label}>
            <strong>{change.label}</strong>:{' '}
            {longFormChanges.has(change.label) ? 'edited' : `${change.from} → ${change.to}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Names for the change list: each position is labelled with its bettor. */
function changeNames(bet: Pick<Bet, 'creatorId' | 'opponentId'>, members: Member[]) {
  const name = (id: string) =>
    members.find((member) => member.id === id)?.name ?? 'Original bettor';
  return { creator: name(bet.creatorId), opponent: name(bet.opponentId), name };
}

export function HistoryRecord({
  bet,
  members,
  memberId,
}: {
  bet: Bet;
  members: Member[];
  /** Who is reading: the bettor who asked for a correction is spoken to directly. */
  memberId?: string;
}) {
  if (!bet.history) return null;
  const history = bet.history;
  const names = changeNames(bet, members);
  const name = names.name;
  const correction = history.correction;
  // The latest revision: what it replaced, and the correction it answered, are in its event.
  const revised = [...bet.events].reverse().find((event) => event.historySnapshot);
  const replaced = revised?.historySnapshot;
  const after = revised ? historyRevisionAfter(bet, revised.id) : undefined;
  const changes = replaced && after ? historyChanges(replaced, after, names) : [];
  const answered = replaced?.proposal.correction;
  const whose = (id: string) => (id === memberId ? 'your' : `${name(id)}’s`);
  // A history that was declined or withdrawn is over: it is no longer waiting on anyone.
  const closure = history.confirmedAt ? undefined : closureRecord(bet);
  const bettor = memberId === bet.creatorId || memberId === bet.opponentId;
  return (
    <section className="workflow-record">
      <h3>
        <History size={18} />
        {history.confirmedAt
          ? 'Confirmed history'
          : closure
            ? `History ${closure.kind}`
            : correction
              ? 'History needs correction'
              : 'History awaiting confirmation'}
      </h3>
      <HistoricalFacts record={{ history }} members={members} />
      <p className="workflow-provenance">
        Added to the ledger {timeLabel(bet.createdAt)}.{' '}
        {history.confirmedAt
          ? `Both bettors finished confirming ${timeLabel(history.confirmedAt)}.`
          : closure
            ? 'It was never confirmed, so balances and win statistics were never changed.'
            : 'Balances and win statistics stay unchanged until both original bettors confirm.'}
      </p>
      {revised && replaced && (
        <HistoryChanges
          lead={`Revision ${history.revision}, reported by ${name(history.proposedBy)} on ${timeLabel(revised.at)}.${
            answered
              ? ` It answers ${whose(answered.requestedBy)} correction: “${answered.note}”`
              : ''
          } ${
            changes.length
              ? `Changed from revision ${replaced.proposal.revision}:`
              : `Nothing changed from revision ${replaced.proposal.revision}.`
          }`}
          changes={changes}
        />
      )}
      {history.previousAdjudication && (
        <p className="workflow-provenance">
          The earlier decision is evidence reported by a bettor. No judge approval or ChatGPT prompt
          agreement has been recorded on their behalf.
        </p>
      )}
      <div className="workflow-signatures">
        {[bet.creatorId, bet.opponentId].map((id) => {
          const approval = history.approvals.find((approval) => approval.actorId === id);
          const closedHere = closure?.event.actorId === id;
          const asked = !approval && correction?.requestedBy === id;
          return (
            <div key={id}>
              {closedHere ? (
                <X size={15} />
              ) : approval ? (
                <Check size={15} />
              ) : asked ? (
                <MessageSquareWarning size={15} />
              ) : closure ? (
                <Minus size={15} />
              ) : (
                <Clock3 size={15} />
              )}
              <span>
                {name(id)}
                <small>
                  {closedHere
                    ? `${closure.kind === 'withdrawn' ? 'Withdrew' : 'Declined'} ${timeLabel(closure.event.at)}`
                    : approval
                      ? `Confirmed ${timeLabel(approval.at)}`
                      : asked
                        ? `Asked for a correction ${timeLabel(correction.at)}`
                        : closure
                          ? 'Did not answer'
                          : 'Awaiting confirmation'}
                </small>
              </span>
            </div>
          );
        })}
      </div>
      {correction && (
        <div className="workflow-notice" role="status">
          <p>
            <strong>
              {correction.requestedBy === memberId ? 'You' : name(correction.requestedBy)} asked for
              a correction
            </strong>{' '}
            on <time dateTime={correction.at}>{timeLabel(correction.at)}</time>:
          </p>
          <p className="workflow-notice-quote">“{correction.note}”</p>
          {!closure && (
            <p>
              {bettor
                ? 'Neither of you can confirm this version until the history is revised.'
                : 'This version cannot be confirmed until the history is revised.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

const reviewIcons = {
  ready: CircleCheck,
  due: BellRing,
  waiting: Clock3,
  paused: CirclePause,
  inactive: Clock3,
} as const;

/** A dated value with a "Passed" marker once its time is behind us. */
function ZonedWithPassed({ value, now }: { value: DecisionCutoff; now: number }) {
  return (
    <>
      {zonedDateLabel(value)}
      {Date.parse(value.at) <= now && <span className="workflow-passed">Passed</span>}
    </>
  );
}

export function TimingRecord({
  bet,
  members,
  memberId,
  now,
}: {
  bet: Bet;
  members: Member[];
  memberId: string;
  /** The clock to judge "passed" and review status by; the real clock when omitted. */
  now?: string;
}) {
  const bettor = [bet.creatorId, bet.opponentId].includes(memberId);
  const inPlay = bet.status === 'active';
  // A personal check-in is the bettor's own reminder, so only they see it, and only while it can matter.
  const ownCheckIn =
    bettor && inPlay && bet.checkIns && Object.hasOwn(bet.checkIns, memberId)
      ? bet.checkIns[memberId]
      : undefined;
  if (!bet.timing && !bet.cutoff && !bet.readiness && ownCheckIn === undefined) return null;
  const clock = now ? Date.parse(now) : Date.now();
  const status = reviewStatus(bet, now ?? clock, memberId);
  const StatusIcon = reviewIcons[status.tone];
  const name = (id: string) => members.find((member) => member.id === id)?.name ?? 'a bettor';
  return (
    <section className="workflow-record timing-record">
      <h3>
        <CalendarDays size={18} />
        Decision timing
      </h3>
      <dl className="workflow-facts">
        {inPlay && (
          <div className={`review-status review-status-${status.tone}`}>
            <dt>Review status</dt>
            <dd>
              <StatusIcon size={16} aria-hidden="true" />
              <span>
                <strong>{status.title}</strong> {status.hint}
              </span>
            </dd>
          </div>
        )}
        {bet.timing && (
          <div>
            <dt>Review condition</dt>
            <dd>{decisionTimingLabel(bet.timing)}</dd>
          </div>
        )}
        {bet.timing?.source && (
          <div>
            <dt>Evidence source</dt>
            <dd>{bet.timing.source}</dd>
          </div>
        )}
        {bet.cutoff && (
          <div>
            <dt>Claim cutoff</dt>
            <dd>
              <ZonedWithPassed value={bet.cutoff} now={clock} />
            </dd>
          </div>
        )}
        {bet.timing?.checkIn && (
          <div>
            <dt>Initial check-in</dt>
            <dd>
              <ZonedWithPassed value={bet.timing.checkIn} now={clock} />
            </dd>
          </div>
        )}
        {ownCheckIn !== undefined && (
          <div>
            <dt>Your check-in</dt>
            <dd>
              {ownCheckIn ? (
                <ZonedWithPassed value={ownCheckIn} now={clock} />
              ) : (
                'None. You removed yours.'
              )}
            </dd>
          </div>
        )}
        {bet.readiness && (
          <div>
            <dt>Evidence for review</dt>
            <dd>
              <p className="readiness-evidence">
                <LinkifiedText text={bet.readiness.evidence} />
              </p>
              <small className="workflow-provenance">
                Added by {name(bet.readiness.markedBy)} on {timeLabel(bet.readiness.at)}
              </small>
            </dd>
          </div>
        )}
      </dl>
      <p className="workflow-provenance">
        {bet.status === 'pending'
          ? pendingTimingNote(bet, bettor && !bet.agreementApprovals.includes(memberId))
          : 'Timing brings the bet up for review. A result and any delivery still need both bettors’ confirmation.'}
      </p>
    </section>
  );
}

/** Before the bet is agreed, timing is part of the terms, not a detail the bettors skip past. */
function pendingTimingNote(bet: Bet, toAgree: boolean): string {
  const parts = [
    'decision timing',
    ...(bet.cutoff ? ['claim cutoff'] : []),
    ...(bet.timing?.checkIn ? ['initial check-in'] : []),
  ];
  const named =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `The ${named} above ${parts.length === 1 ? 'is' : 'are'} part of what ${
    toAgree ? 'you agree to when you agree to the bet' : 'each bettor agrees to with the bet'
  }.`;
}

/** How a bet is decided, worded for the proposal record: method plus the judge's name. */
function decisionLabel(
  method: Bet['decisionMethod'],
  judgeId: string | undefined,
  members: Member[],
): string {
  if (method === 'judge')
    return `Judge: ${members.find((member) => member.id === judgeId)?.name ?? 'a former member'}`;
  return method === 'chatgpt' ? 'ChatGPT recommendation' : 'Mutual agreement';
}

/** The agreed parts an amendment can change, as they stand (or stood) before it. */
interface AgreementTerms {
  terms: string;
  deadline?: string;
  timing?: DecisionTiming;
  cutoff?: DecisionCutoff;
  decisionMethod?: DecisionMethod;
  judgeId?: string;
  judgeDeclined?: boolean;
}
interface CompareRow {
  field: string;
  state: 'Changed' | 'Unchanged' | 'Added' | 'Removed';
  now: string;
  proposed: string;
}
function compareRow(field: string, now?: string, proposed?: string): CompareRow {
  const state = now === proposed ? 'Unchanged' : !now ? 'Added' : !proposed ? 'Removed' : 'Changed';
  return { field, state, now: now ?? 'None', proposed: proposed ?? 'None' };
}
/** A legacy decision date reads as the timing it stands for, so restating it is no change. */
function timingNow(terms: AgreementTerms): string | undefined {
  const timing = agreedTiming(terms);
  return timing ? decisionTimingLabel(timing) : undefined;
}
function agreementRows(
  current: AgreementTerms,
  proposal: AgreementAmendment,
  members: Member[],
): CompareRow[] {
  const zoned = (value?: DecisionCutoff) => (value ? zonedDateLabel(value) : undefined);
  const rows = [
    compareRow('Decision criteria', current.terms, proposal.terms),
    compareRow('Decision timing', timingNow(current), decisionTimingLabel(proposal.timing)),
    compareRow('Claim cutoff', zoned(current.cutoff), zoned(proposal.cutoff)),
    compareRow('Evidence source', current.timing?.source, proposal.timing.source),
    compareRow('Initial check-in', zoned(current.timing?.checkIn), zoned(proposal.timing.checkIn)),
  ];
  if (proposal.decisionMethod) {
    const method = current.decisionMethod ?? 'mutual';
    const judge = members.find((member) => member.id === current.judgeId)?.name;
    rows.push({
      ...compareRow(
        'Decided by',
        decisionLabel(method, current.judgeId, members),
        decisionLabel(proposal.decisionMethod, proposal.judgeId, members),
      ),
      now: `${decisionLabel(method, current.judgeId, members)}${
        method === 'judge' && current.judgeDeclined ? ' (stepped down)' : ''
      }`,
      proposed: `${decisionLabel(proposal.decisionMethod, proposal.judgeId, members)}${
        method === 'judge' && proposal.decisionMethod !== 'judge'
          ? ` · ${judge ?? 'The current judge'} is removed as judge`
          : ''
      }`,
    });
  }
  // A field that is absent on both sides says nothing about this proposal.
  return rows.filter((row) => !(row.state === 'Unchanged' && row.now === 'None'));
}

/** Each agreed part side by side with the proposal, marked Changed, Unchanged, Added or Removed. */
function AgreementCompare({ rows, nowLabel }: { rows: CompareRow[]; nowLabel: string }) {
  return (
    <dl className="workflow-compare">
      {rows.map((row) => (
        <div key={row.field} className={`compare-row compare-${row.state.toLowerCase()}`}>
          <dt>
            <span className="compare-field">{row.field}</span>{' '}
            <span className="compare-state">{row.state}</span>
          </dt>
          {row.state === 'Unchanged' ? (
            <dd className="compare-same">{row.now}</dd>
          ) : (
            <>
              <dd className="compare-now">
                <span className="compare-label">{nowLabel}</span>{' '}
                <span className="compare-value">{row.now}</span>
              </dd>
              <dd className="compare-proposed">
                <span className="compare-label">Proposed</span>{' '}
                <span className="compare-value">{row.proposed}</span>
              </dd>
            </>
          )}
        </div>
      ))}
    </dl>
  );
}

export function AgreementProposalRecord({
  bet,
  members,
  memberId,
}: {
  bet: Bet;
  members: Member[];
  memberId: string;
}) {
  const proposal = bet.amendment ?? bet.voidProposal;
  if (!proposal) return null;
  const name = (id: string) => members.find((member) => member.id === id)?.name ?? 'a bettor';
  const waitingFor = pendingNames(bet, proposal.approvals, name);
  // The bettor who still has to answer is asked to, not told to wait for themselves.
  const answerIsYours =
    [bet.creatorId, bet.opponentId].includes(memberId) && !proposal.approvals.includes(memberId);
  // Approval clears only what exists now, the same way the engine records it.
  const cleared = [
    ...(bet.readiness ? ['the evidence already added'] : []),
    ...(bet.promptAgreement ? [`ChatGPT prompt v${bet.promptAgreement.version}`] : []),
  ];
  return (
    <section className="workflow-review">
      <h3>
        {bet.amendment ? 'Proposed changes to the agreement' : 'Proposal to call this bet off'}
      </h3>
      <p>
        {name(proposal.proposedBy)} proposed this on {timeLabel(proposal.at)}.
        {answerIsYours
          ? ' Your answer is needed: agree or decline in the next step.'
          : waitingFor
            ? ` Waiting for ${waitingFor} to agree or decline.`
            : ''}
      </p>
      {bet.amendment && (
        <AgreementCompare
          nowLabel="Now"
          rows={agreementRows(
            { ...bet, judgeDeclined: !!bet.judgeDeclined },
            bet.amendment,
            members,
          )}
        />
      )}
      <dl className="workflow-facts">
        <div>
          <dt>Reason</dt>
          <dd>{proposal.note}</dd>
        </div>
      </dl>
      <p>
        {bet.amendment
          ? `Both bettors must agree.${
              cleared.length ? ` Approving clears ${cleared.join(' and ')}.` : ''
            }`
          : 'If both bettors agree, the bet ends with no winner and no rolls owed.'}{' '}
        Outcome actions pause while this proposal is open.
      </p>
    </section>
  );
}

export function PriorHistoryRecord({
  event,
  members,
  bet,
}: {
  event: AuditEvent;
  members: Member[];
  bet: Bet;
}) {
  const record = event.historySnapshot;
  if (!record) return null;
  const names = changeNames(bet, members);
  const name = names.name;
  const { proposal } = record;
  const after = historyRevisionAfter(bet, event.id);
  const changes = after ? historyChanges(record, after, names) : [];
  return (
    <>
      {changes.length > 0 && (
        <HistoryChanges lead={`Changed from revision ${proposal.revision}:`} changes={changes} />
      )}
      <details className="workflow-prior">
        <summary>Revision {proposal.revision} (replaced here)</summary>
        <dl className="workflow-facts">
          <div>
            <dt>Reported by</dt>
            <dd>
              {name(proposal.proposedBy)}
              {proposal.approvals.map((approval) => (
                <small key={approval.actorId} className="workflow-provenance">
                  Confirmed by {name(approval.actorId)} {timeLabel(approval.at)}
                </small>
              ))}
            </dd>
          </div>
          {proposal.correction && (
            <div>
              <dt>Correction asked for</dt>
              <dd>
                {name(proposal.correction.requestedBy)}, {timeLabel(proposal.correction.at)}: “
                {proposal.correction.note}”
              </dd>
            </div>
          )}
          <div>
            <dt>Bet</dt>
            <dd>{record.title}</dd>
          </div>
          <div>
            <dt>Criteria</dt>
            <dd>{record.terms}</dd>
          </div>
          <div>
            <dt>{names.creator}’s position</dt>
            <dd>{record.creatorSide}</dd>
          </div>
          <div>
            <dt>{names.opponent}’s position</dt>
            <dd>{record.opponentSide}</dd>
          </div>
          <div>
            <dt>Stake</dt>
            <dd>
              {record.stake} {record.stake === 1 ? 'lobster roll' : 'lobster rolls'}
            </dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{record.category}</dd>
          </div>
          {record.location && (
            <div>
              <dt>Location</dt>
              <dd>{placeLabel(record.location)}</dd>
            </div>
          )}
          {record.timing ? (
            <div>
              <dt>Timing</dt>
              <dd>{decisionTimingLabel(record.timing)}</dd>
            </div>
          ) : (
            record.deadline && (
              <div>
                <dt>Decision date</dt>
                <dd>{dateLabel(record.deadline, { year: true })} (UTC)</dd>
              </div>
            )
          )}
          {record.cutoff && (
            <div>
              <dt>Claim cutoff</dt>
              <dd>{zonedDateLabel(record.cutoff)}</dd>
            </div>
          )}
        </dl>
        <HistoricalFacts record={record} members={members} />
      </details>
    </>
  );
}

export function PriorAmendmentRecord({
  event,
  members = [],
}: {
  event: AuditEvent;
  members?: Member[];
}) {
  const record = event.amendmentSnapshot;
  if (!record) return null;
  return (
    <details className="workflow-prior">
      <summary>Compare the agreement with the proposed changes</summary>
      <AgreementCompare
        nowLabel="Agreed then"
        rows={agreementRows(record, record.proposal, members)}
      />
      <dl className="workflow-facts">
        <div>
          <dt>Reason</dt>
          <dd>{record.proposal.note}</dd>
        </div>
      </dl>
    </details>
  );
}
