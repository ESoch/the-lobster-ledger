import { getOffsetRolls, getRemainingRolls, needsAction } from '../lib/ledger';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CalendarDays,
  MapPin,
  Check,
  ArrowRight,
  Clock3,
  ShieldCheck,
  Scale,
  History,
  Utensils,
  Flag,
  Gavel,
  Sparkles,
  Copy,
  ExternalLink,
  FileCheck2,
  FilePlus2,
  ArrowDown,
  ShieldAlert,
  Minus,
  PencilLine,
  X,
} from 'lucide-react';
import type { AuditEvent, Bet, BetAction, Member, Place } from '../lib/types';
import {
  Avatar,
  Modal,
  ModalCancel,
  StatusBadge,
  currentOpener,
  dateLabel,
  timeLabel,
  type LeaveRequest,
} from './ui';
import {
  FieldError,
  FieldErrorsProvider,
  UnplacedErrors,
  findProblems,
  shareLinkProblem,
  useFieldErrors,
  whenPressEnds,
  type FieldProblem,
} from './form-errors';
import { BetLink } from './BetLink';
import {
  addEvidenceToPrompt,
  buildAdjudicationBrief,
  removeEvidenceFromPrompt,
} from '../lib/adjudication';
import {
  answerInstead,
  approvalChanges,
  captureFormBet,
  changesSince,
  describeChange,
  formApplies,
  getFormSubmissionBet,
  isCurrentPromptCopied,
  isFormBetCurrent,
  replacementForm,
} from '../lib/form-context';
import type { CopiedPrompt } from '../lib/form-context';
import {
  amendmentKeepsDeclinedJudge,
  betReadiness,
  betStatusLabel,
  closureOf,
  decisionTimingLabel,
  historySummary,
  judgeWaitingLine,
  likelyDuplicates,
  pendingNames,
  primaryActionLabel,
  promptMissesEvidence,
  promptQuotesRemovedEvidence,
  reviewStatus,
  watcherStatus,
} from '../lib/bet-workflow';
import { closureRecord } from '../lib/bet-closure';
import { JUDGE_COPY } from './JudgeCopy';
import { LIMITS } from '../lib/limits';
import { auditDisplay, clearedResultText } from '../lib/audit-display';
import { LinkifiedText } from './LinkifiedText';
import { changedRows, diffLines, promptTextOf } from '../lib/prompt-diff';
import { entrySourceLabel } from '../lib/entry-source';
import {
  DateTimeField,
  HistoryAcknowledgementFields,
  TimingFields,
  historyFieldsAnswered,
  historyProblems,
  readAcknowledgements,
  readDateTime,
  readTiming,
} from './WorkflowFields';
import {
  HistoryRevisionFields,
  historyRevisionAnswered,
  readHistoryRevision,
} from './HistoryRevisionFields';
import { DecisionMethodFields, readDecisionMethod } from './DecisionMethodFields';
import {
  AgreementProposalRecord,
  HistoryRecord,
  PriorAmendmentRecord,
  PriorHistoryRecord,
  TimingRecord,
} from './WorkflowRecords';

/** What the pin picker stores as the address of a point the bettors chose on the map. */
const PIN_PLACEHOLDER = 'Pinned location';

/** The index of the last item that matches, or -1. */
function findLastIndex<T>(items: readonly T[], match: (item: T, index: number) => boolean) {
  for (let index = items.length - 1; index >= 0; index--)
    if (match(items[index], index)) return index;
  return -1;
}

type ActionForm =
  | 'result'
  | 'settlement'
  | 'dispute_result'
  | 'dispute_settlement'
  | 'decline'
  | 'prompt'
  | 'adjudication'
  | 'history_confirm'
  | 'history_correction'
  | 'history_revision'
  | 'ready'
  | 'check_in'
  | 'amendment'
  | 'void'
  | 'reject_amendment'
  | 'reject_void'
  | 'withdraw'
  | 'withdraw_proposal'
  | 'decline_judging'
  | 'dispute_readiness'
  | null;
/** Forms that end or take back something; they need a real reason and a danger-styled submit. */
const exitForms: ActionForm[] = ['decline', 'withdraw', 'withdraw_proposal', 'decline_judging'];
const exitReasonMin = 10;
export function BetDetail({
  bet,
  members,
  memberId,
  onClose,
  onAction,
  bets,
  places,
  onOpenBet,
  openAtNextStep = false,
  leaveRef,
}: {
  bet: Bet;
  members: Member[];
  memberId: string;
  onClose: () => void;
  onAction: (bet: Bet, action: BetAction) => Promise<void>;
  /** Every bet in the ledger, so a linked bet can say who won it. */
  bets?: Bet[];
  /** Saved places, offered when a reported history's location is revised. */
  places?: Place[];
  /** Opens another bet's sheet in place; without it a linked bet opens as a normal page link. */
  onOpenBet?: (betId: string) => void;
  /** Opened right after the viewer proposed this bet: start at the next step, not the top. */
  openAtNextStep?: boolean;
  /** Filled with the sheet's way out for Back and a typed #hash, which asks about a typed draft. */
  leaveRef?: RefObject<LeaveRequest | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The version a refused change was sent against; if the record has moved on since, the refusal
  // was a conflict and the sheet explains what happened instead of showing the bare error.
  const [refused, setRefused] = useState<{
    id: string;
    version: number;
    type: BetAction['type'];
  } | null>(null);
  const [form, setForm] = useState<ActionForm>(null);
  const [formBet, setFormBet] = useState<Bet | null>(null);
  const [formMemberId, setFormMemberId] = useState('');
  const [note, setNote] = useState('');
  const [winner, setWinner] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [copiedPrompt, setCopiedPrompt] = useState<CopiedPrompt | null>(null);
  // A failed copy is about the copy button, so it shows there and clears once a copy works.
  const [copyError, setCopyError] = useState('');
  // Anything typed into the open form: Close and outside clicks ask before discarding it.
  const [formDirty, setFormDirty] = useState(false);
  const fields = useFieldErrors();
  // A new key per opened form; rebasing a draft onto the latest record keeps the same key.
  const [formSession, setFormSession] = useState(0);
  // The version this member last read. One-click approvals are bound to it, so a change made
  // elsewhere while they read is never approved without being seen.
  const [reviewed, setReviewed] = useState({ bet, memberId });
  let reviewedBet = reviewed.bet;
  if (
    reviewed.memberId !== memberId ||
    reviewed.bet.id !== bet.id ||
    (reviewed.bet.version !== bet.version && !approvalChanges(reviewed.bet, bet, memberId).length)
  ) {
    // Nothing new to read (the reader's own change, a check-in, or a different reader).
    reviewedBet = bet;
    setReviewed({ bet, memberId });
  }
  const reviewStale = reviewedBet.version !== bet.version;
  const reviewNoteId = useId();
  const member = (id: string) => members.find((person) => person.id === id);
  const firstName = (id?: string) => member(id ?? '')?.name.split(' ')[0] ?? 'A former member';
  /** Who did something, to whoever is reading: "You" for the reader, a first name for anyone else. */
  const whoIs = (id: string) => (id === memberId ? 'You' : firstName(id));
  const creator = member(bet.creatorId);
  const opponent = member(bet.opponentId);
  const participant = [bet.creatorId, bet.opponentId].includes(memberId);
  const method = bet.decisionMethod ?? 'mutual';
  const isJudge = method === 'judge' && bet.judgeId === memberId;
  const prompt = bet.promptAgreement;
  const copied = isCurrentPromptCopied(copiedPrompt, prompt);
  const staleDraft = !!form && (!isFormBetCurrent(formBet, bet) || formMemberId !== memberId);
  // A refusal is a conflict when the record has moved on since the refused change was sent. An
  // open draft that went stale explains it in its own note, so only one note ever shows.
  const latestEvent = bet.events.at(-1);
  const conflict =
    !!error &&
    !!refused &&
    !!latestEvent &&
    refused.id === bet.id &&
    refused.version !== bet.version;
  const conflictRef = useRef<HTMLDivElement>(null);
  const staleNoteRef = useRef<HTMLDivElement>(null);
  const staleNoteId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  // The words on the button that opened the form: that button is rebuilt when the form closes.
  const openerLabel = useRef('');
  // An approval whose button goes away once it is recorded; the version it was pressed on.
  const approvedOn = useRef<number | null>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const reviewAckRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    // A change that arrives while the reader is on the approval holds it until they have read the
    // change. Focus goes on to the acknowledgement, the next thing to press, which sits before it.
    if (reviewStale && document.activeElement === approveRef.current) reviewAckRef.current?.focus();
  }, [reviewStale]);
  // The sheet's way out from outside it (Back, a typed #hash). It asks about a typed draft as Close
  // does, and is held, as Close is, while a change is recorded.
  const modalLeave = useRef<LeaveRequest | null>(null);
  useLayoutEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = (leave) => {
      if (busy) return false;
      if (modalLeave.current) return modalLeave.current(leave);
      leave();
      return true;
    };
    return () => {
      leaveRef.current = null;
    };
  });
  // The button that was pressed is usually gone by now, so focus would fall to the dialog root.
  useEffect(() => {
    if (conflict) (conflictRef.current ?? staleNoteRef.current)?.focus();
  }, [conflict]);
  // Set by a control that removes itself when pressed: focus goes on to what it enabled.
  const handoff = useRef<'approval' | 'draft' | 'opener' | null>(null);
  // Set when the form closed because its change was recorded, not because it was cancelled.
  const recorded = useRef(false);
  /** The next step's own heading, or the sheet's title once the bet has no next step. */
  function focusNextStep() {
    const heading =
      detailRef.current?.querySelector<HTMLElement>('.next-action h3') ??
      detailRef.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('h2') ??
      null;
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
  /** The rebuilt button that opened the form, or the next step when it is gone. */
  function focusOpener() {
    const label = openerLabel.current;
    const wasRecorded = recorded.current;
    recorded.current = false;
    const match = [
      ...(detailRef.current?.querySelectorAll<HTMLButtonElement>('.next-action button') ?? []),
    ].find((candidate) => !candidate.disabled && candidate.textContent?.trim() === label);
    const closed = match?.closest('details:not([open])');
    // Cancelling goes back to the tools the button was in; a recorded change moves on to the step
    // it led to, rather than to a collapsed summary.
    const target = closed
      ? wasRecorded
        ? null
        : closed.querySelector<HTMLElement>('summary')
      : match;
    if (target) target.focus();
    else focusNextStep();
  }
  useLayoutEffect(() => {
    // An approval button that went away with the change it recorded leaves focus nowhere.
    if (approvedOn.current !== null && approvedOn.current !== bet.version) {
      approvedOn.current = null;
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) focusNextStep();
    }
    const next = handoff.current;
    if (!next) return;
    handoff.current = null;
    // An approval that still waits for a read hands focus to the read acknowledgement.
    if (next === 'approval') (reviewAckRef.current ?? approveRef.current)?.focus();
    else if (next === 'opener') focusOpener();
    else {
      const field = [
        ...(formRef.current?.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]), select, textarea',
        ) ?? []),
      ].find((candidate) => !candidate.matches(':disabled') && !candidate.closest('[hidden]'));
      if (!field) return;
      // The browser would scroll before the sheet has measured the new form's pinned footer, and
      // only far enough to show a textarea's caret. Focus first, then bring the fields in whole, so
      // what submitting does (the line above the buttons) shows; a tall form keeps its field in view.
      field.focus({ preventScroll: true });
      formRef.current?.querySelector('.form-fields')?.scrollIntoView?.({ block: 'nearest' });
      field.scrollIntoView?.({ block: 'nearest' });
    }
  });
  const readiness = betReadiness(bet, undefined, memberId);
  const historyPending = !!bet.history && bet.status === 'pending';
  // Without the ledger's list, the places other bets were made at stand in for it.
  const savedPlaces = places ?? [
    ...new Map(
      (bets ?? []).flatMap((other) =>
        other.location ? [[other.location.id, other.location] as const] : [],
      ),
    ).values(),
  ];
  const changePending = !!bet.amendment || !!bet.voidProposal;
  const ownCheckIn =
    bet.checkIns && Object.hasOwn(bet.checkIns, memberId)
      ? bet.checkIns[memberId]
      : bet.timing?.checkIn;
  const promptAgreed =
    !!prompt && [bet.creatorId, bet.opponentId].every((id) => prompt.approvals.includes(id));
  const agreementDone = !['pending', 'declined'].includes(bet.status);
  const remainingRolls = getRemainingRolls(bet);
  const offsetRolls = getOffsetRolls(bet);
  const resultDone = ['owed', 'settling', 'settled', 'voided'].includes(bet.status);
  const otherName =
    member(memberId === bet.creatorId ? bet.opponentId : bet.creatorId)?.name.split(' ')[0] ??
    'the other member';
  const fullName = (id: string) => member(id)?.name ?? 'A former member';
  const rollsText = (count: number) => `${count} ${count === 1 ? 'lobster roll' : 'lobster rolls'}`;
  const status = reviewStatus(bet, undefined, memberId);
  const winnerId = bet.resolution?.winnerId ?? null;
  const loserId = winnerId ? (winnerId === bet.creatorId ? bet.opponentId : bet.creatorId) : '';
  // The prompt's text decides, not the order things were recorded in: a prompt written after the
  // evidence, or revised for another reason, can leave it out just the same.
  const staleEvidence = promptMissesEvidence(bet);
  // Evidence that came off the bet (disagreed with, taken back or replaced) can stay quoted in it.
  const removedQuoted = promptQuotesRemovedEvidence(bet);
  const quotesRemoved = removedQuoted.length > 0;
  const quotedEvidencePhrase = removedQuoted
    .map(
      (item) =>
        `evidence ${item.by === memberId ? 'you' : firstName(item.by)} ${
          { disagreed: 'disagreed with', withdrawn: 'took back', replaced: 'replaced' }[item.how]
        }`,
    )
    .join(' and ');
  /** Any change the prompt needs before it is sent: new evidence in, or removed evidence out. */
  const promptNeedsRevising = staleEvidence || quotesRemoved;
  // What a revision changed from the version before it, read from the paper trail.
  const promptChanges = useMemo(() => {
    const before =
      prompt && prompt.version > 1 ? promptTextOf(bet.events, prompt.version - 1) : undefined;
    return prompt && before !== undefined ? diffLines(before, prompt.text) : null;
  }, [bet.events, prompt]);
  const responseLength = form === 'adjudication' ? note.trim().length : 0;
  const responseOver = Math.max(0, responseLength - LIMITS.response.max);
  // A prompt is counted the same way: pasting past the limit is named, not silently cut off.
  const promptLength = form === 'prompt' ? note.trim().length : 0;
  const promptOver = Math.max(0, promptLength - LIMITS.prompt.max);
  // Every other note (a reason, delivery details, evidence) is counted the same way.
  const noteField = !!form && !['history_confirm', 'history_revision', 'check_in'].includes(form);
  const counted = noteField && form !== 'prompt' && form !== 'adjudication';
  const noteLength = counted ? note.trim().length : 0;
  // Readiness evidence is bounded by its own limit in the rules engine and the API.
  const noteMax = form === 'ready' ? LIMITS.evidence.max : LIMITS.note.max;
  const noteOver = Math.max(0, noteLength - noteMax);
  const overLimit = responseOver > 0 || promptOver > 0 || noteOver > 0;
  const nextStepHeading = useRef<HTMLHeadingElement>(null);
  const promptDetails = useRef<HTMLDetailsElement>(null);
  const promptText = useRef<HTMLPreElement>(null);
  const yourMove = !form && (participant || isJudge) && needsAction(bet, memberId);
  /** When an event of a type was last recorded by this member, after a given index. */
  const lastAt = (types: string[], actorId: string, after = -1) =>
    bet.events[
      findLastIndex(
        bet.events,
        (event, index) => index > after && types.includes(event.type) && event.actorId === actorId,
      )
    ]?.at;
  async function act(action: BetAction, actionBet: Bet = bet) {
    const fromForm = !!form;
    setError('');
    setCopyError('');
    setRefused(null);
    setBusy(true);
    try {
      await onAction(actionBet, action);
      if (fromForm) {
        recorded.current = true;
        closeForm();
      } else approvedOn.current = actionBet.version;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update the bet.');
      setRefused({ id: actionBet.id, version: actionBet.version, type: action.type });
    } finally {
      setBusy(false);
    }
  }
  /** The prompt as a revision starts: evidence that came off the bet taken out, what is on it in. */
  function revisedPromptText(text: string) {
    const kept = removeEvidenceFromPrompt(
      text,
      removedQuoted.map((item) => item.evidence),
      bet.readiness?.evidence,
    );
    return bet.readiness ? addEvidenceToPrompt(kept, bet.readiness.evidence) : kept;
  }
  function openForm(next: ActionForm, initialNote?: string) {
    openerLabel.current = currentOpener()?.textContent?.trim() ?? '';
    handoff.current = 'draft';
    setForm(next);
    setFormBet(captureFormBet(bet));
    setFormMemberId(memberId);
    setFormSession((session) => session + 1);
    // A revision starts from the current prompt with the evidence for review already in it.
    setNote(
      initialNote ??
        (next !== 'prompt'
          ? ''
          : !prompt
            ? buildAdjudicationBrief(bet, members)
            : revisedPromptText(prompt.text)),
    );
    setError('');
    setCopyError('');
    setRefused(null);
    setWinner('');
    setSourceUrl('');
    setFormDirty(false);
    fields.clearAll();
  }
  /** Cancel, Escape or a recorded submit: everything the form held goes, and focus goes back. */
  function closeForm() {
    setForm(null);
    setFormBet(null);
    setNote('');
    setWinner('');
    setSourceUrl('');
    setError('');
    setRefused(null);
    setFormDirty(false);
    fields.clearAll();
    handoff.current = 'opener';
  }
  /** Brings "The next step" into view and moves focus to its heading. */
  function showNextStep() {
    const heading = nextStepHeading.current;
    if (!heading) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Focus first: the sheet measures its pinned heading as focus moves (a sheet opened at the next
    // step has had none yet), and its scroll padding then lands the heading just below it.
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }
  /** Opens the agreed prompt, selects it and puts focus on it, so a refused copy can be done by hand. */
  function revealPrompt() {
    const details = promptDetails.current;
    const text = promptText.current;
    if (!details || !text) return;
    details.open = true;
    text.focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  /**
   * Move an open draft onto the latest record, keeping everything typed so far. What was attested
   * is not kept: those boxes were ticked against the older record, so they must be ticked again.
   */
  function rebaseForm(next: ActionForm = form) {
    formRef.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name^="acknowledgements."]')
      .forEach((box) => (box.checked = false));
    handoff.current = 'draft';
    setForm(next);
    setFormBet(captureFormBet(bet));
    setError('');
    setRefused(null);
  }
  async function copyPrompt() {
    if (!promptAgreed || !prompt) return;
    const copying = { version: prompt.version, text: prompt.text };
    try {
      await navigator.clipboard.writeText(copying.text);
      setCopiedPrompt(copying);
      setCopyError('');
    } catch {
      revealPrompt();
      setCopyError('Select the agreed prompt above and copy it. Clipboard access is unavailable.');
    }
  }
  /** What the field attributes cannot say: a pin on the map for a revised location. */
  function problems(element: HTMLFormElement): FieldProblem[] {
    const extra: FieldProblem[] = [];
    const place = element.elements.namedItem('location.name');
    const lat = element.elements.namedItem('location.lat');
    const placeId = element.elements.namedItem('location.placeId');
    if (
      placeId instanceof HTMLSelectElement &&
      placeId.value === 'custom' &&
      place instanceof HTMLInputElement &&
      place.value.trim() &&
      lat instanceof HTMLInputElement &&
      !lat.value
    )
      extra.push({
        name: 'location.pin',
        message: 'Choose a point on the map for this location.',
        element: place,
      });
    extra.push(...historyProblems(element, [bet.creatorId, bet.opponentId]));
    return findProblems(element, extra);
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The submit is never disabled, so a press while busy, on a stale draft or over the response
    // limit does nothing here.
    if (busy || staleDraft || overLimit) return;
    setError('');
    if (fields.show(problems(event.currentTarget))) return;
    // The fields are disabled while the change is recorded; focus must not go down with them.
    if (event.currentTarget.contains(document.activeElement)) submitRef.current?.focus();
    try {
      const captured = getFormSubmissionBet(formBet, bet);
      if (formMemberId !== memberId)
        throw new Error('The selected member changed. Reopen this action before confirming.');
      const data = new FormData(event.currentTarget);
      if (form === 'result')
        void act(
          { type: 'propose_result', winnerId: winner === 'tie' ? null : winner, note },
          captured,
        );
      else if (form === 'adjudication')
        void act(
          {
            type: 'adjudicate',
            winnerId: winner === 'tie' ? null : winner,
            note,
            ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
          },
          captured,
        );
      else if (form === 'prompt') void act({ type: 'propose_prompt', text: note }, captured);
      else if (form === 'settlement')
        void act({ type: 'propose_settlement', method: 'roll', note }, captured);
      else if (form === 'history_confirm')
        void act(
          { type: 'confirm_history', acknowledgements: readAcknowledgements(data) },
          captured,
        );
      else if (form === 'history_correction')
        void act({ type: 'request_history_correction', note }, captured);
      else if (form === 'history_revision')
        void act(
          {
            type: 'revise_history',
            revision: readHistoryRevision(data, captured, savedPlaces),
            acknowledgements: readAcknowledgements(data),
          },
          captured,
        );
      else if (form === 'ready') void act({ type: 'mark_ready', evidence: note }, captured);
      else if (form === 'check_in')
        void act({ type: 'set_check_in', checkIn: readDateTime(data, 'checkIn') }, captured);
      else if (form === 'amendment')
        void act(
          {
            type: 'propose_amendment',
            terms: String(data.get('amendmentTerms')),
            ...readTiming(data),
            ...readDecisionMethod(data, captured),
            note,
          },
          captured,
        );
      else if (form === 'void') void act({ type: 'propose_void', note }, captured);
      else if (form) void act({ type: form, note }, captured);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Review the latest record and reopen this action.',
      );
      setRefused(null);
    }
  }
  const closure = closureRecord(bet);
  const dispute =
    closure?.kind === 'disputed_result' || closure?.kind === 'disputed_delivery'
      ? closure
      : undefined;
  const closed = ['settled', 'voided', 'declined'].includes(bet.status);
  const judgeFirst = firstName(bet.judgeId);
  const judgeName = member(bet.judgeId ?? '')?.name ?? 'Appointed member';
  const judgeGone = method === 'judge' && !!bet.judgeDeclined;
  const bettors = `${firstName(bet.creatorId)} and ${firstName(bet.opponentId)}`;
  const watching = !participant && !isJudge ? watcherStatus(bet, firstName) : '';
  // Set while nextStep() renders: the version note only appears beside a one-click approval,
  // and the in-play tools disclosure is skipped when the step already shows those tools.
  let approvalOnScreen = false;
  let toolsInStep = false;
  const approveButton = (action: BetAction, label: string) => {
    approvalOnScreen = true;
    return (
      <button
        ref={approveRef}
        className="button button-primary"
        // Held, not disabled, while it is recorded or waits for a change to be read: a disabled
        // button would drop the focus to the page.
        aria-disabled={busy || reviewStale || undefined}
        aria-busy={busy || undefined}
        aria-describedby={reviewStale ? reviewNoteId : undefined}
        onClick={() => {
          if (!busy && !reviewStale) void act(action, reviewedBet);
        }}
      >
        <Check size={16} />
        {label}
      </button>
    );
  };
  const exitButton = (next: NonNullable<ActionForm>, label: string) => (
    <button className="button button-secondary" disabled={busy} onClick={() => openForm(next)}>
      {label}
    </button>
  );
  const stepDown = formApplies('decline_judging', bet, memberId)
    ? exitButton('decline_judging', 'Step down as judge')
    : null;
  const approvalButtons = (
    confirm: BetAction,
    disagree: 'dispute_result' | 'dispute_settlement',
    label: string,
  ) => (
    <div className="action-buttons">
      {approveButton(confirm, label)}
      <button
        className="button button-secondary"
        disabled={busy}
        onClick={() => openForm(disagree)}
      >
        Disagree
      </button>
    </div>
  );
  // Result and delivery signatures come from the events that recorded them.
  const resultStart = findLastIndex(bet.events, (event) =>
    ['propose_result', 'adjudicate', 'propose_void'].includes(event.type),
  );
  // A call-off is a mutual result even on a judged or ChatGPT bet.
  const mutualResult = method === 'mutual' || bet.events[resultStart]?.type === 'propose_void';
  // A reported past bet signs its result and delivery with the history only when no later
  // event in the app proposed them; one that carried on is signed by those events.
  const resultFromHistory = !!bet.history?.confirmedAt && resultStart < 0;
  function resultMeta(): string {
    const resolution = bet.resolution!;
    if (resultFromHistory) return `Reported by ${fullName(resolution.proposedBy)}`;
    const at = bet.events[resultStart]?.at;
    const when = at ? ` · ${timeLabel(at)}` : '';
    if (mutualResult) return `Proposed by ${fullName(resolution.proposedBy)}${when}`;
    if (method === 'judge')
      return `Recommended by ${fullName(resolution.proposedBy)}, the judge${when}`;
    if (method === 'chatgpt')
      return `ChatGPT recommendation recorded by ${fullName(resolution.proposedBy)}${when}`;
    return `Proposed by ${fullName(resolution.proposedBy)}${when}`;
  }
  function resultSignature(id: string): [string, boolean] {
    const resolution = bet.resolution!;
    const historyApproval = resultFromHistory
      ? bet.history!.approvals.find((approval) => approval.actorId === id)
      : undefined;
    if (historyApproval) return [`Confirmed ${timeLabel(historyApproval.at)}`, true];
    if (!resolution.approvals.includes(id)) return ['Waiting to confirm', false];
    if (mutualResult && id === resolution.proposedBy) {
      const at = bet.events[resultStart]?.at;
      return [at ? `Proposed ${timeLabel(at)}` : 'Proposed', true];
    }
    const at = lastAt(['confirm_result', 'confirm_void'], id, resultStart);
    return [at ? `Confirmed ${timeLabel(at)}` : 'Confirmed', true];
  }
  const deliveryStart = findLastIndex(bet.events, (event) => event.type === 'propose_settlement');
  const deliveryFromHistory = !!bet.history?.confirmedAt && deliveryStart < 0;
  const deliveryReportedAt = () =>
    deliveryFromHistory ? undefined : bet.events[deliveryStart]?.at;
  function deliverySignature(id: string): [string, boolean] {
    const settlement = bet.settlement!;
    const historyApproval = deliveryFromHistory
      ? bet.history!.approvals.find((approval) => approval.actorId === id)
      : undefined;
    if (historyApproval) return [`Confirmed ${timeLabel(historyApproval.at)}`, true];
    if (!settlement.approvals.includes(id)) return ['Waiting to confirm', false];
    if (id === settlement.proposedBy) {
      const at = deliveryReportedAt();
      return [at ? `Reported ${timeLabel(at)}` : 'Reported', true];
    }
    const at = lastAt(['confirm_settlement'], id, deliveryStart);
    return [at ? `Confirmed ${timeLabel(at)}` : 'Confirmed', true];
  }
  const disagreeingClears =
    method === 'judge'
      ? `Disagreeing clears ${judgeFirst}’s recommendation and puts the bet back in play for ${judgeFirst} to record a new one.`
      : method === 'chatgpt'
        ? 'Disagreeing clears the recorded response and puts the bet back in play.'
        : 'Disagreeing clears this result and puts the bet back in play.';
  /** Why a change was refused, in terms of what is now on the record. */
  function conflictSentence(latest: AuditEvent) {
    const own = latest.actorId === memberId;
    const did = `${describeChange(latest)} on ${timeLabel(latest.at)}`;
    // The same member already did this in another window: it is on the record, so nothing is lost.
    if (own && refused?.type === latest.type)
      return `You already ${did}. This second click was not recorded, and nothing more is needed.`;
    return `${own ? 'You' : firstName(latest.actorId)} ${did}, so your change was not recorded. ${
      closed
        ? 'The record above is final.'
        : 'Check the latest record above, then try again if it still applies.'
    }`;
  }
  // A disagreement with readiness evidence stays in view until someone adds evidence again.
  const evidenceAt = findLastIndex(bet.events, (event) =>
    ['mark_ready', 'dispute_readiness'].includes(event.type),
  );
  const evidenceDispute =
    bet.status === 'active' &&
    !bet.readiness &&
    bet.events[evidenceAt]?.type === 'dispute_readiness'
      ? bet.events[evidenceAt]
      : undefined;
  /** "Blair disagreed with your evidence: “Reason”" — worded for whoever is reading. */
  function evidenceDisputeSentence() {
    if (!evidenceDispute) return '';
    const author =
      bet.events[
        findLastIndex(
          bet.events,
          (event, index) => index < evidenceAt && event.type === 'mark_ready',
        )
      ]?.actorId;
    if (evidenceDispute.actorId === memberId)
      return `You disagreed with ${firstName(author)}’s evidence.`;
    const reason = evidenceDispute.detail.replace(/^Disputed the readiness evidence: /, '');
    return `${firstName(evidenceDispute.actorId)} disagreed with ${
      author === memberId ? 'your' : `${firstName(author)}’s`
    } evidence: “${reason}”`;
  }
  /** "Blair disagreed with your proposed result. “Reason”" — worded for whoever is reading. */
  function disputeSentence() {
    if (!dispute) return '';
    const own = dispute.event.actorId === memberId;
    const who = own ? 'You' : firstName(dispute.event.actorId);
    const reason = own ? '' : ` “${dispute.note}”`;
    const proposer = dispute.disputed?.actorId;
    const whose = proposer === memberId ? 'your' : `${firstName(proposer)}’s`;
    if (dispute.kind === 'disputed_delivery')
      return `${who} disagreed with ${whose} delivery report.${reason}`;
    if (method === 'judge')
      return `${who} disagreed with ${isJudge ? 'your' : `${judgeFirst}’s`} recommendation.${reason}`;
    if (method === 'chatgpt')
      return `${who} disagreed with the recorded ChatGPT response.${reason}`;
    return `${who} disagreed with ${whose} proposed result.${reason}`;
  }
  /** The named judge's step: they never agree to the bet, but can step down before a result. */
  function judgeStep(context: string) {
    if (bet.judgeDeclined)
      return (
        <p>
          <Gavel size={17} />
          You stepped down as judge on {timeLabel(bet.judgeDeclined.at)}. {bettors} are choosing a
          new judge or another way to decide.
        </p>
      );
    return (
      <>
        <p>
          <Gavel size={17} />
          {context} If you cannot judge it fairly, you can step down until a result is recorded.
        </p>
        {stepDown && <div className="action-buttons">{stepDown}</div>}
      </>
    );
  }
  function nextStep() {
    if (historyPending && bet.history) {
      if (!participant) return <p>The original two bettors are reviewing this reported history.</p>;
      const confirmed = bet.history.approvals.some((approval) => approval.actorId === memberId);
      const proposer = bet.history.proposedBy === memberId;
      const correction = bet.history.correction;
      // While a correction is open, revising is the one way forward, for either bettor.
      // With no correction open, the choices are explained once, under the buttons they are about.
      const explains = correction ? undefined : 'history-options';
      const revise = (
        <button
          className={`button ${correction ? 'button-primary' : 'button-secondary'}`}
          disabled={busy}
          aria-describedby={explains}
          onClick={() => openForm('history_revision')}
        >
          {correction && <PencilLine size={16} />}
          Revise history
        </button>
      );
      return (
        <>
          <p>
            {correction
              ? correction.requestedBy === memberId
                ? `You asked for a correction. ${firstName(bet.history.proposedBy)} can revise the history to answer it, or you can revise it yourself; either way, you both confirm the new version.`
                : `${firstName(correction.requestedBy)} asked for a correction. Revise the history to answer it; you both confirm the new version.`
              : confirmed
                ? `Your history confirmation is recorded. Waiting for ${otherName} to review the same terms${bet.history.stage !== 'active' ? ' and outcome' : ''}${bet.history.stage === 'settled' ? ' and actual delivery' : ''}.`
                : 'Review the original terms and reported history above. Confirm each applicable part together, or ask for a correction.'}
          </p>
          <div className="action-buttons">
            {correction && revise}
            {!confirmed && !correction && (
              <button
                className="button button-primary"
                disabled={busy}
                aria-describedby={explains}
                onClick={() => openForm('history_confirm')}
              >
                <Check size={16} />
                Review and confirm history
              </button>
            )}
            {!correction && !proposer && (
              <button
                className="button button-secondary"
                disabled={busy}
                aria-describedby={explains}
                onClick={() => openForm('history_correction')}
              >
                Request a correction
              </button>
            )}
            {!correction && revise}
            {formApplies('decline', bet, memberId) && exitButton('decline', 'Decline this record')}
            {formApplies('withdraw', bet, memberId) &&
              exitButton('withdraw', 'Withdraw this record')}
          </div>
          {explains && (
            <p className="hint step-options" id={explains}>
              {proposer
                ? 'Revise history replaces your report with a new one, and you both confirm it again. The earlier version stays in the paper trail.'
                : `Confirm if the history above is right. Request a correction to ask ${firstName(bet.history.proposedBy)} for a change: nothing can be confirmed until it is revised. Revise history makes the change yourself, and you both confirm the new version.`}
            </p>
          )}
        </>
      );
    }
    if (bet.status === 'pending') {
      if (isJudge)
        // Name who still has to agree: the proposer already has.
        return judgeStep(
          `You were named judge for this bet. Waiting for ${pendingNames(bet, bet.agreementApprovals, firstName)} to agree to these terms; nothing is needed from you until the answer is in.`,
        );
      // The named judge can step down before the bet is even agreed.
      const judgeGone = method === 'judge' && bet.judgeDeclined && (
        <p>
          <Gavel size={17} />
          {judgeFirst} stepped down as judge: “{bet.judgeDeclined.note}” Once the bet is agreed, you
          both choose a new judge or another way to decide.
        </p>
      );
      if (formApplies('withdraw', bet, memberId))
        return (
          <>
            {judgeGone}
            <p>
              <Clock3 size={16} />
              Waiting for {otherName} to agree. You can withdraw this proposal until they answer.
            </p>
            <div className="action-buttons">{exitButton('withdraw', 'Withdraw proposal')}</div>
          </>
        );
      return (
        <>
          {judgeGone}
          <p>
            Review the terms and the adjudication method. Your approval makes this bet active. If
            they do not work for you, decline with a reason; nothing is owed.
          </p>
          <div className="action-buttons">
            {approveButton({ type: 'accept' }, 'Agree to bet')}
            {exitButton('decline', 'Decline')}
          </div>
        </>
      );
    }
    if (bet.status === 'active') {
      if (changePending) {
        const proposal = bet.amendment ?? bet.voidProposal!;
        if (isJudge)
          return judgeStep(
            `You were named judge for this bet. Waiting for ${pendingNames(bet, proposal.approvals, firstName)} to review ${firstName(proposal.proposedBy)}’s proposal above.`,
          );
        if (proposal.approvals.includes(memberId))
          return (
            <>
              <p>
                <Clock3 size={16} />
                Waiting for {otherName} to review your proposal above. You can take it back until
                they answer.
              </p>
              {formApplies('withdraw_proposal', bet, memberId) && (
                <div className="action-buttons">
                  {exitButton(
                    'withdraw_proposal',
                    bet.amendment ? 'Take back my changes' : 'Take back my call-off',
                  )}
                </div>
              )}
            </>
          );
        // Agreeing would put a judge who stepped down back on the bet, so the ledger refuses it.
        if (amendmentKeepsDeclinedJudge(bet))
          return (
            <>
              <p>
                <Gavel size={17} />
                {judgeFirst} stepped down as judge after this was proposed, so these changes cannot
                be agreed. Decline them with a reason; then you both choose a new judge or another
                way to decide.
              </p>
              <div className="action-buttons">
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => openForm('reject_amendment')}
                >
                  Decline proposal
                </button>
              </div>
            </>
          );
        return (
          <>
            <p>
              Read the proposal above before deciding. The existing agreement stays in place if you
              decline.
            </p>
            <div className="action-buttons">
              {approveButton(
                { type: bet.amendment ? 'confirm_amendment' : 'confirm_void' },
                bet.amendment ? 'Agree to these changes' : 'Agree to no winner',
              )}
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => openForm(bet.amendment ? 'reject_amendment' : 'reject_void')}
              >
                Decline proposal
              </button>
            </div>
          </>
        );
      }
      if (method === 'judge' && bet.judgeDeclined) {
        if (isJudge) return judgeStep('');
        return (
          <>
            <p>
              <Gavel size={17} />
              {judgeFirst} stepped down as judge: “{bet.judgeDeclined.note}” Choose a new judge or
              another way to decide; {otherName} confirms the change before a result can be
              recorded.
            </p>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => openForm('amendment')}
            >
              <Gavel size={16} />
              Choose a new judge or method
            </button>
          </>
        );
      }
      if (!readiness.ready && (method !== 'chatgpt' || promptAgreed)) {
        if (isJudge)
          return judgeStep(
            `You were named judge for this bet. ${status.detail} You record your recommendation once it is ready for review.`,
          );
        toolsInStep = participant;
        return (
          <>
            <p>
              <Clock3 size={16} />
              {status.detail}{' '}
              {participant
                ? status.tone === 'due'
                  ? 'You can also set a later check-in.'
                  : 'Add readiness evidence when the answer is available, or set a check-in to remind yourself.'
                : 'The bettors can add evidence when the answer is available.'}
            </p>
            {participant && (
              <div className="action-buttons">
                <button
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => openForm('ready')}
                >
                  Add readiness evidence
                </button>
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => openForm('check_in')}
                >
                  Set my check-in
                </button>
                {!!ownCheckIn && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => void act({ type: 'set_check_in', checkIn: null })}
                  >
                    Remove my check-in
                  </button>
                )}
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => openForm('amendment')}
                >
                  Propose changes
                </button>
              </div>
            )}
            {method === 'chatgpt' && quotesRemoved && participant && (
              <p className="prompt-quote-note">
                Prompt v{prompt?.version} still quotes {quotedEvidencePhrase}. Revise it to take it
                out, which needs both approvals again.
              </p>
            )}
            {method === 'chatgpt' && participant && (
              <button
                className="text-button revise-prompt"
                disabled={busy}
                onClick={() => openForm('prompt')}
              >
                Revise prompt and request fresh approval
              </button>
            )}
          </>
        );
      }
      if (method === 'judge')
        return isJudge ? (
          <>
            <p>
              {dispute
                ? `${firstName(dispute.event.actorId)} disagreed with your recommendation: “${dispute.note}” Review it against the agreed criteria and record a new recommendation. Both bettors then confirm the result.`
                : JUDGE_COPY.intro}
            </p>
            <div className="action-buttons">
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => openForm('adjudication')}
              >
                <Gavel size={16} />
                {JUDGE_COPY.recordAction}
              </button>
              {stepDown}
            </div>
          </>
        ) : (
          <p>
            <Gavel size={17} />
            {dispute
              ? `${disputeSentence()} Waiting for ${judgeFirst} to record a new recommendation.`
              : JUDGE_COPY.waiting(judgeFirst)}
          </p>
        );
      if (method === 'chatgpt') {
        if (!prompt)
          return (
            <>
              <p>
                Agree on a fair prompt before taking the bet to ChatGPT. Include the exact criteria
                and the evidence you both want considered.
              </p>
              <button className="button button-primary" onClick={() => openForm('prompt')}>
                <FileCheck2 size={16} />
                Draft a fair prompt
              </button>
            </>
          );
        if (!promptAgreed)
          return (
            <>
              <p>
                {prompt.approvals.includes(memberId)
                  ? `Waiting for ${otherName} to approve prompt v${prompt.version}.`
                  : 'Review the complete prompt above. Your approval applies to this exact wording.'}{' '}
                {staleEvidence &&
                  'It leaves out the evidence added for review, so ChatGPT would not see it. Revise the prompt to add it. '}
                {quotesRemoved &&
                  `It quotes ${quotedEvidencePhrase}. Revise the prompt to take it out. `}
                Any edit requires both people to approve again.
              </p>
              <div className="action-buttons">
                {!prompt.approvals.includes(memberId) &&
                  approveButton({ type: 'approve_prompt' }, 'Approve this prompt')}
                <button className="button button-secondary" onClick={() => openForm('prompt')}>
                  Revise prompt
                </button>
              </div>
            </>
          );
        return (
          <>
            <p>
              {dispute ? `${disputeSentence()} ` : ''}
              {staleEvidence && quotesRemoved
                ? `Prompt v${prompt.version} is approved by both bettors, but the evidence added for review is not in it, and it still quotes ${quotedEvidencePhrase}. Revise the prompt above, which needs both approvals again, or copy v${prompt.version} exactly as agreed.`
                : staleEvidence
                  ? `Prompt v${prompt.version} is approved by both bettors, but the evidence added for review is not in it. Add it to the prompt above, which needs both approvals again, or copy v${prompt.version} exactly as agreed.`
                  : quotesRemoved
                    ? `Prompt v${prompt.version} is approved by both bettors, but it still quotes ${quotedEvidencePhrase}. Take it out of the prompt above, which needs both approvals again, or copy v${prompt.version} exactly as agreed.`
                    : `Prompt v${prompt.version} is approved by both bettors. Copy it into ChatGPT exactly as agreed, then record the response for you both to review.`}
            </p>
            {/* The step leads with what the Your move strip names; the editor opens with the
                evidence changes made, so a second revise button would open the same thing. */}
            {promptNeedsRevising && (
              <button className="button button-primary" onClick={() => openForm('prompt')}>
                <FileCheck2 size={16} />
                {staleEvidence ? 'Add evidence to the prompt' : 'Remove evidence from the prompt'}
              </button>
            )}
            <div className="action-buttons">
              <button className="button button-secondary" onClick={() => void copyPrompt()}>
                <Copy size={15} />
                {copied ? 'Copied agreed prompt' : 'Copy agreed prompt'}
              </button>
              <a
                className="button button-secondary"
                href="https://chatgpt.com/"
                target="_blank"
                rel="noreferrer"
              >
                Open ChatGPT
                <ExternalLink size={14} />
              </a>
            </div>
            {copyError && (
              <p className="form-error" role="alert">
                {copyError}
              </p>
            )}
            <button
              className={`button ${promptNeedsRevising ? 'button-secondary' : 'button-primary'}`}
              onClick={() => openForm('adjudication')}
            >
              <Sparkles size={16} />
              Record ChatGPT response
            </button>
            {!promptNeedsRevising && (
              <button className="text-button revise-prompt" onClick={() => openForm('prompt')}>
                Revise prompt and request fresh approval
              </button>
            )}
          </>
        );
      }
      return (
        <>
          <p>
            {dispute
              ? `${disputeSentence()} Talk it through, then either of you can propose a result again.`
              : 'The bet is on. When the answer is clear, propose a result for both of you to confirm.'}
          </p>
          <button className="button button-primary" onClick={() => openForm('result')}>
            Record outcome
            <ArrowRight size={16} />
          </button>
        </>
      );
    }
    if (bet.status === 'confirming') {
      if (isJudge)
        return (
          <p>
            <Clock3 size={16} />
            {JUDGE_COPY.awaitingConfirmation(
              pendingNames(bet, bet.resolution?.approvals ?? [], firstName),
            )}
          </p>
        );
      if (formApplies('withdraw_proposal', bet, memberId))
        return (
          <>
            <p>
              <Clock3 size={16} />
              Waiting for {otherName} to confirm the result. You can take back your result until
              they answer.
            </p>
            <div className="action-buttons">
              {exitButton('withdraw_proposal', 'Take back my result')}
            </div>
          </>
        );
      if (bet.resolution?.approvals.includes(memberId))
        return (
          <p>
            <Clock3 size={16} />
            Waiting for {otherName} to confirm the result.
          </p>
        );
      return (
        <>
          <p>
            Does this result match the agreed terms
            {method === 'chatgpt' ? ' and the response to your agreed prompt' : ''}?{' '}
            {method === 'mutual'
              ? 'Your confirmation completes the handshake.'
              : 'Each bettor confirms separately.'}{' '}
            {winnerId
              ? memberId === loserId
                ? `Once confirmed, you owe ${firstName(winnerId)} ${rollsText(bet.stake)}.`
                : `Once confirmed, ${firstName(loserId)} owes you ${rollsText(bet.stake)}.`
              : 'Once confirmed, the bet is called off and no rolls are owed.'}{' '}
            {disagreeingClears}
          </p>
          {approvalButtons({ type: 'confirm_result' }, 'dispute_result', 'Confirm result')}
        </>
      );
    }
    if (bet.status === 'owed')
      return isJudge ? (
        <p>
          {JUDGE_COPY.confirmed} {firstName(loserId)} owes {firstName(winnerId ?? '')}{' '}
          {rollsText(remainingRolls)}.
        </p>
      ) : (
        <>
          <p>
            {dispute ? `${disputeSentence()} ` : ''}
            {memberId === loserId
              ? `You owe ${firstName(winnerId ?? '')} ${rollsText(remainingRolls)}. Record delivery once you have handed ${remainingRolls === 1 ? 'it' : 'them'} over; ${firstName(winnerId ?? '')} then confirms it.`
              : `${firstName(loserId)} owes you ${rollsText(remainingRolls)}. Record delivery once you have received ${remainingRolls === 1 ? 'it' : 'them'}; ${firstName(loserId)} then confirms it.`}
          </p>
          <button className="button button-primary" onClick={() => openForm('settlement')}>
            <Utensils size={16} />
            Record delivery
          </button>
        </>
      );
    if (bet.status === 'settling') {
      if (isJudge)
        return (
          <p>
            <Clock3 size={16} />
            Waiting for {pendingNames(bet, bet.settlement?.approvals ?? [], firstName)} to confirm
            the delivery {firstName(bet.settlement?.proposedBy ?? '')} reported.
          </p>
        );
      if (formApplies('withdraw_proposal', bet, memberId))
        return (
          <>
            <p>
              <Clock3 size={16} />
              Waiting for {otherName} to confirm delivery. You can take back your report until they
              answer.
            </p>
            <div className="action-buttons">
              {exitButton('withdraw_proposal', 'Take back my delivery report')}
            </div>
          </>
        );
      if (bet.settlement?.approvals.includes(memberId))
        return (
          <p>
            <Clock3 size={16} />
            Waiting for {otherName} to confirm delivery.
          </p>
        );
      return (
        <>
          <p>
            {memberId === winnerId
              ? `${firstName(bet.settlement?.proposedBy ?? '')} reported delivering ${rollsText(bet.settlement?.rolls ?? remainingRolls)} to you. Confirm only if you received ${(bet.settlement?.rolls ?? remainingRolls) === 1 ? 'it' : 'them'}; confirming settles this debt.`
              : `${firstName(bet.settlement?.proposedBy ?? '')} reported receiving ${rollsText(bet.settlement?.rolls ?? remainingRolls)} from you. Confirm to settle this debt.`}{' '}
            If the report is wrong, disagree: it is removed and the rolls stay owed.
          </p>
          {approvalButtons(
            { type: 'confirm_settlement' },
            'dispute_settlement',
            'Confirm delivery',
          )}
        </>
      );
    }
  }
  const record = bet.history ? 'record' : 'proposal';
  // What the proposer of an open proposal would take back.
  const ownProposal = bet.amendment
    ? 'changes'
    : bet.voidProposal
      ? 'call-off'
      : bet.status === 'confirming'
        ? 'result'
        : bet.status === 'active'
          ? 'evidence'
          : 'delivery report';
  const formTitles: Record<NonNullable<ActionForm>, string> = {
    result: 'Record the outcome',
    settlement: 'Record delivery',
    decline: `Decline this ${record}`,
    dispute_result: 'Explain the disagreement',
    dispute_settlement: 'Explain the disagreement',
    prompt: 'Agree on a fair prompt',
    adjudication: method === 'judge' ? JUDGE_COPY.formTitle : 'Record ChatGPT’s response',
    history_confirm: 'Confirm the reported history',
    history_correction: 'Request a correction',
    history_revision: 'Revise the reported history',
    ready: 'Mark the outcome ready to review',
    check_in: 'Set your next check-in',
    amendment: 'Propose changes to the agreement',
    void: 'Call off this bet',
    reject_amendment: 'Decline these changes',
    reject_void: 'Decline calling it off',
    withdraw: `Withdraw this ${record}`,
    // Each exit keeps one name from its button through the form title to the submit.
    withdraw_proposal: `Take back your ${ownProposal}`,
    decline_judging: 'Step down as judge',
    dispute_readiness: 'Disagree with the evidence',
  };
  const formSubmitLabels: Record<NonNullable<ActionForm>, string> = {
    result: 'Propose result',
    settlement: 'Record delivery',
    decline: `Decline ${record}`,
    dispute_result: 'Record disagreement',
    dispute_settlement: 'Record disagreement',
    prompt: 'Propose this exact prompt',
    adjudication: JUDGE_COPY.submit,
    history_confirm: 'Confirm this history',
    history_correction: 'Request correction',
    history_revision: 'Send revised history',
    ready: 'Record readiness evidence',
    check_in: 'Save my check-in',
    amendment: 'Propose these changes',
    void: 'Ask to call it off',
    reject_amendment: 'Decline proposal',
    reject_void: 'Decline proposal',
    withdraw: `Withdraw ${record}`,
    withdraw_proposal: `Take back my ${ownProposal}`,
    decline_judging: 'Step down as judge',
    dispute_readiness: 'Record disagreement',
  };
  const onRecord = 'This stays on the ledger with your name and the time.';
  // Once evidence comes off the bet, a result can still be recorded only if the timing has come.
  const withoutEvidence = betReadiness({ ...bet, readiness: undefined }, undefined, memberId).ready
    ? 'Its agreed timing has arrived, so a result can still be recorded.'
    : 'No result can be recorded until the agreed timing arrives or someone adds new evidence.';
  /** What submitting the form does, stated before anyone commits to it. */
  const formConsequences: Partial<Record<NonNullable<ActionForm>, string>> = {
    decline: `The ${record} closes. No rolls are owed. ${onRecord}`,
    withdraw: `The ${record} closes before ${otherName} answers. No rolls are owed. ${onRecord}`,
    withdraw_proposal: `${
      ownProposal === 'changes'
        ? 'The current agreement stays in place.'
        : ownProposal === 'call-off'
          ? 'The bet stays in play.'
          : ownProposal === 'result'
            ? 'The bet goes back in play with no result proposed.'
            : ownProposal === 'evidence'
              ? `The evidence comes off the bet. ${withoutEvidence}`
              : 'The rolls stay owed.'
    } ${onRecord}`,
    dispute_readiness: `The evidence comes off the bet. ${withoutEvidence} Your reason stays on the record with ${firstName(bet.readiness?.markedBy)}’s evidence.`,
    decline_judging: `${bettors} will need to agree on a new judge or another way to decide. ${onRecord}`,
    // A correction asks for a change; it does not itself change or confirm anything.
    history_correction: `Nothing can be confirmed until the history is revised, by ${otherName} or by you; then you both confirm the new version. ${onRecord}`,
    void: `${otherName} must agree. Once agreed, the bet closes with no winner and no rolls are owed; until then it stays in play.`,
    dispute_result: `${disagreeingClears} Your reason stays on the record.`,
    // One sentence for the second handshake: either bettor can record the delivery again, and the
    // other confirms it.
    dispute_settlement: `Disagreeing keeps ${rollsText(remainingRolls)} owed until one of you records a delivery and the other confirms it. ${otherName}’s report and your reason stay on the record.`,
    reject_amendment: 'The current agreement stays in place.',
    reject_void: 'The bet stays in play.',
  };
  const danger = !!form && exitForms.includes(form);
  /** Placeholder copy and the message for an empty note, per form. */
  const noteRequired: Partial<Record<NonNullable<ActionForm>, string>> = {
    result: 'Say what shows who won.',
    settlement: 'Say where and when the rolls were delivered.',
    ready: 'Describe the evidence that the answer is available.',
    prompt: 'Write the prompt you both will approve.',
    adjudication:
      method === 'chatgpt' ? 'Paste ChatGPT’s response.' : 'Write your decision and reasoning.',
    amendment: 'Say why you are proposing these changes.',
    history_correction: 'Say what needs to be corrected.',
    dispute_readiness: 'Say why this evidence does not show the answer.',
  };
  const promptCountId = useId();
  const noteCountId = useId();
  /** What a counted note is called when it is over the limit, and what submitting it does. */
  const noteWords = (): [string, string] =>
    form === 'result'
      ? ['explanation', 'proposing']
      : form === 'settlement'
        ? ['delivery note', 'recording']
        : form === 'ready'
          ? ['evidence', 'recording']
          : form === 'history_correction'
            ? ['correction', 'recording']
            : form === 'amendment'
              ? ['reason', 'proposing']
              : ['reason', 'recording'];
  // A draft that no longer matches the record: name the change, keep the text, offer a way on.
  const draftChange = formBet
    ? (changesSince(formBet, bet, memberId).at(-1) ?? bet.events.at(-1))
    : undefined;
  const draftApplies = !!form && formApplies(form, bet, memberId);
  // The change-of-judge form leads with who decides; any other amendment leads with the criteria.
  const methodLeads = formBet?.decisionMethod === 'judge' && !!formBet.judgeDeclined;
  const draftReplacement =
    form && !draftApplies
      ? replacementForm(form, bet, memberId, {
          winnerId: winner === '' ? undefined : winner === 'tie' ? null : winner,
        })
      : null;
  // The other bettor filed the same kind of report meanwhile, and the draft does not dispute it.
  const draftAnswer =
    form && !draftApplies && !draftReplacement ? answerInstead(form, bet, memberId) : null;
  const answerFrom = firstName(
    draftAnswer === 'settlement'
      ? bet.settlement?.proposedBy
      : draftAnswer === 'readiness'
        ? bet.readiness?.markedBy
        : bet.resolution?.proposedBy,
  );
  const latestUnread = reviewStale ? approvalChanges(reviewedBet, bet, memberId).at(-1) : undefined;
  const promptRevised = !!prompt && reviewedBet.promptAgreement?.version !== prompt.version;
  const step = form ? null : nextStep();
  // The in-play tools, unless the step already shows them.
  const inPlayTools = participant && bet.status === 'active' && !changePending && !toolsInStep;
  // What voided a bet: a call-off both agreed to, or a no-winner result both confirmed.
  const voidedBy =
    bet.status === 'voided'
      ? [...bet.events]
          .reverse()
          .find((event) => event.type === 'confirm_void' || event.type === 'confirm_result')
      : undefined;
  const calledOff = voidedBy?.type === 'confirm_void';
  // A bet that closed without settling ends the stepper on the step that closed it.
  const lifecycle: { label: string; done?: boolean; closed?: ReactNode }[] =
    bet.status === 'declined'
      ? [
          { label: 'Proposed', done: true },
          {
            label: closureOf(bet) === 'withdrawn' ? 'Withdrawn' : 'Declined',
            closed: <X size={13} />,
          },
        ]
      : bet.status === 'voided'
        ? [
            { label: 'Proposed', done: true },
            { label: 'Agreed', done: true },
            {
              label: calledOff ? 'Called off · nothing owed' : 'No winner · nothing owed',
              closed: <Minus size={13} />,
            },
          ]
        : [
            { label: 'Proposed', done: true },
            { label: 'Agreed', done: agreementDone },
            { label: 'Decided', done: resultDone },
            { label: 'Settled', done: bet.status === 'settled' },
          ];
  return (
    <Modal
      open
      // Held while a change is recorded, as Escape is: closing then would hide whether it was.
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Bet details"
      // Read out after the title, so this sheet is told apart from any other bet's.
      description={`${bet.reference}: ${bet.title}. ${betStatusLabel(bet)}, ${bet.stake} ${bet.stake === 1 ? 'roll' : 'rolls'} at stake.`}
      sheet
      dirty={!!form && formDirty && !busy}
      leaveRef={modalLeave}
      onOpenAutoFocus={(event) => {
        // A bet the viewer just proposed opens at what happens next ("Waiting for Sarah to
        // agree"), which is otherwise below the fold, rather than at the Close button.
        if (!openAtNextStep || !nextStepHeading.current) return;
        event.preventDefault();
        showNextStep();
      }}
      onEscapeKeyDown={(event, guard) => {
        // The first Escape leaves an open form, asking first when words were typed into it; the
        // next one closes the sheet.
        if (!form || guard.asking) return;
        event.preventDefault();
        if (busy) return;
        if (formDirty) guard.ask(closeForm);
        else closeForm();
      }}
    >
      <div className="bet-detail" ref={detailRef}>
        {/* Close is held while a change is recorded; this says so to those who cannot see the
            button's state. Mounted empty, so the text arriving is what gets announced. */}
        <p className="sr-only busy-status" role="status">
          {busy ? 'Recording this change. The sheet can be closed once it is saved.' : ''}
        </p>
        <div className="detail-meta">
          <span className="record-id">{bet.reference}</span>
          <StatusBadge
            status={bet.status}
            label={
              historyPending
                ? bet.history?.correction
                  ? 'History needs correction'
                  : 'Confirming history'
                : closureOf(bet) === 'withdrawn'
                  ? 'Withdrawn'
                  : closure?.kind === 'disputed_delivery'
                    ? 'Delivery disagreement'
                    : undefined
            }
          />
        </div>
        <h2 className="detail-title">{bet.title}</h2>
        <div className="detail-facts">
          <span>
            <Utensils size={15} />
            {bet.stake} {bet.stake === 1 ? 'roll' : 'rolls'} at stake
          </span>
          {(bet.timing || bet.deadline) && (
            <span>
              <CalendarDays size={15} />
              {bet.timing
                ? decisionTimingLabel(bet.timing)
                : `${dateLabel(bet.deadline, { year: true })} UTC`}
            </span>
          )}
          <span>{bet.category}</span>
          {/* As on the ledger rows: a source that was never recorded is left out, not "Not recorded". */}
          {bet.entrySource && (
            <span>
              Entered via:{' '}
              {entrySourceLabel(
                bet.entrySource,
                !!bet.entrySourceInference,
                !!bet.entrySourceReport,
              )}
            </span>
          )}
        </div>
        {yourMove && (
          // A jump to "The next step" further down the sheet, not a second copy of its button.
          <a
            className="your-move"
            href="#bet-next-step"
            onClick={(event) => {
              event.preventDefault();
              showNextStep();
            }}
          >
            <ArrowDown size={16} aria-hidden="true" />
            <span>
              <strong>Your move: </strong>
              {primaryActionLabel(bet, memberId, undefined, firstName)}
            </span>
          </a>
        )}
        <div className="lifecycle">
          {lifecycle.map((item, index) => {
            // A declined or called-off bet ends on its closing step: no step is left to take.
            const current =
              !item.done &&
              !item.closed &&
              lifecycle.slice(0, index).every((before) => before.done);
            return (
              <div
                key={item.label}
                className={`lifecycle-step${item.done ? ' complete' : ''}${item.closed ? ' closed' : ''}`}
                aria-current={current ? 'step' : undefined}
              >
                <span aria-hidden="true">
                  {item.closed ?? (item.done ? <Check size={13} /> : index + 1)}
                </span>
                <small>{item.label}</small>
                <span className="sr-only">
                  {item.done
                    ? ' (done)'
                    : item.closed
                      ? ' (closed)'
                      : current
                        ? ' (current step)'
                        : ' (not yet)'}
                </span>
              </div>
            );
          })}
        </div>
        {bet.entrySourceInference && (
          <p className="entry-source-note">
            Browser entry inferred because this record predates CLI and MCP support. The original
            wager history is unchanged.
          </p>
        )}
        {bet.entrySourceReport && (
          <p className="entry-source-note">
            Entry source reported afterward. {bet.entrySourceReport.note}
          </p>
        )}
        <h3 className="detail-section-label">Two sides to the story</h3>
        <div className="detail-positions">
          {[
            { person: creator, side: bet.creatorSide },
            { person: opponent, side: bet.opponentSide },
          ].map(({ person, side }) => (
            <div className="position-card" key={person?.id}>
              <div>
                <Avatar member={person} decorative />
                <strong>{person?.name}</strong>
                {/* Only a mark that tells the two bettors apart: after agreement both are always lit. */}
                {!agreementDone && bet.agreementApprovals.includes(person?.id ?? '') && (
                  <span className="position-agreed" title="Agreed to the terms">
                    <Check size={14} className="green" aria-hidden="true" />
                    <span className="sr-only">Agreed to the terms</span>
                  </span>
                )}
              </div>
              <p>“{side}”</p>
            </div>
          ))}
        </div>
        <div className="terms-block">
          <h3>How this is decided</h3>
          <p>{bet.terms}</p>
        </div>
        <HistoryRecord bet={bet} members={members} memberId={memberId} />
        <TimingRecord bet={bet} members={members} memberId={memberId} />
        {/* A bet turned down was never agreed, so no result will be decided and there is no method to
            describe. The one exception is a judge who stepped down first, which is part of what happened. */}
        {(bet.status !== 'declined' || judgeGone) && (
          <div className="adjudication-method">
            {method === 'judge' ? (
              <Gavel size={19} />
            ) : method === 'chatgpt' ? (
              <Sparkles size={19} />
            ) : (
              <ShieldCheck size={19} />
            )}
            <div>
              <strong>
                {method === 'judge'
                  ? judgeGone
                    ? isJudge
                      ? JUDGE_COPY.steppedDownSelf
                      : JUDGE_COPY.steppedDown(judgeName)
                    : isJudge
                      ? JUDGE_COPY.youAreJudge
                      : `Judge: ${judgeName}`
                  : method === 'chatgpt'
                    ? 'ChatGPT, with a mutually agreed prompt'
                    : 'Both bettors agree on the outcome'}
              </strong>
              {/* A judge who stepped down records nothing: the bettors re-appoint one while the bet
                  is open. A closed bet takes no new judge, so the card only says what happened. */}
              <p>
                {method === 'judge'
                  ? `${
                      judgeGone
                        ? closed
                          ? JUDGE_COPY.steppedDownBefore(isJudge ? 'You' : judgeFirst)
                          : isJudge
                            ? JUDGE_COPY.choosing(bettors)
                            : JUDGE_COPY.noJudge(participant ? `You and ${otherName}` : bettors)
                        : isJudge
                          ? JUDGE_COPY.methodHintForJudge
                          : JUDGE_COPY.newBetHint
                    } `
                  : method === 'chatgpt'
                    ? 'Once the bet is agreed, the bettors approve the exact prompt as a separate step before anything goes to ChatGPT. One of them then records the response and both confirm the result. '
                    : 'Both bettors confirm the result. '}
                Debts stay between the original two people.
              </p>
            </div>
          </div>
        )}
        {bet.location && (
          <a
            className="detail-location"
            href={`https://www.openstreetmap.org/?mlat=${bet.location.lat}&mlon=${bet.location.lng}#map=17/${bet.location.lat}/${bet.location.lng}`}
            target="_blank"
            rel="noreferrer"
          >
            <MapPin size={18} />
            <span>
              <strong>{bet.location.name}</strong>
              <small>
                {bet.location.address === PIN_PLACEHOLDER
                  ? `Pinned on the map · ${Number(bet.location.lat).toFixed(4)}, ${Number(bet.location.lng).toFixed(4)}`
                  : bet.location.address}
              </small>
              <span className="sr-only">Opens OpenStreetMap in a new tab</span>
            </span>
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        )}
        {prompt && (
          <section className="prompt-record">
            <div>
              <FileCheck2 size={17} aria-hidden="true" />
              <h3>
                {promptAgreed
                  ? `Agreed ChatGPT prompt v${prompt.version}`
                  : `Prompt v${prompt.version} awaiting approval`}
              </h3>
              <span>
                {promptAgreed ? 'Both approved' : `${prompt.approvals.length} of 2 approved`}
              </span>
            </div>
            <p>
              Proposed by {fullName(prompt.proposedBy)} · {timeLabel(prompt.at)}
            </p>
            {promptNeedsRevising && (
              <div className="prompt-stale">
                {staleEvidence && (
                  <p>
                    The evidence added for review is not in prompt v{prompt.version}, so ChatGPT
                    will not see it.
                  </p>
                )}
                {quotesRemoved && (
                  <p>
                    Prompt v{prompt.version} still quotes {quotedEvidencePhrase}. Revise it to take
                    it out, which needs both approvals again.
                  </p>
                )}
                {participant && bet.status === 'active' && !changePending && !form && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      openForm('prompt');
                      showNextStep();
                    }}
                  >
                    <FilePlus2 size={15} aria-hidden="true" />
                    {staleEvidence
                      ? 'Add evidence to the prompt'
                      : 'Remove evidence from the prompt'}
                  </button>
                )}
              </div>
            )}
            {/* While approval is pending the whole prompt shows; once agreed it is a named scroller.
                Keyed by version, so a newly proposed prompt opens for reading. */}
            <details key={prompt.version} ref={promptDetails} open={!promptAgreed}>
              <summary>
                {promptAgreed
                  ? `Read agreed prompt v${prompt.version}`
                  : `Read prompt v${prompt.version} in full`}
              </summary>
              {promptAgreed ? (
                <pre
                  ref={promptText}
                  className="prompt-text prompt-text-capped"
                  tabIndex={0}
                  role="region"
                  aria-label={`Agreed prompt v${prompt.version}`}
                >
                  {prompt.text}
                </pre>
              ) : (
                <pre className="prompt-text">{prompt.text}</pre>
              )}
            </details>
            {prompt && promptChanges && (
              <details className="prompt-changes" open={!promptAgreed}>
                <summary>What changed since v{prompt.version - 1}</summary>
                {promptChanges.every((line) => line.kind === 'same') ? (
                  <p className="prompt-superseded">
                    The wording is the same as v{prompt.version - 1}.
                  </p>
                ) : (
                  <ul
                    aria-label={`Changes from prompt v${prompt.version - 1} to v${prompt.version}`}
                  >
                    {changedRows(promptChanges).map((row, index) =>
                      row.kind === 'gap' ? (
                        <li key={index} className="diff-gap">
                          {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
                        </li>
                      ) : (
                        <li key={index} className={`diff-${row.kind}`}>
                          <span aria-hidden="true">{row.kind === 'added' ? '+' : '−'}</span>
                          <span className="sr-only">
                            {row.kind === 'added' ? 'Added: ' : 'Removed: '}
                          </span>
                          {row.text || <em>(blank line)</em>}
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </details>
            )}
            <ul
              className="prompt-signatures"
              aria-label={`Approvals for prompt v${prompt.version}`}
            >
              {[bet.creatorId, bet.opponentId].map((id) => {
                const approved = prompt.approvals.includes(id);
                const approvedAt =
                  id === prompt.proposedBy
                    ? prompt.at
                    : bet.events[
                        findLastIndex(
                          bet.events,
                          (event) =>
                            event.type === 'approve_prompt' &&
                            event.actorId === id &&
                            event.detail.includes(`version ${prompt.version}.`),
                        )
                      ]?.at;
                return (
                  <li key={id} className={approved ? undefined : 'waiting'}>
                    <Avatar member={member(id)} size={30} decorative />
                    <span>
                      {fullName(id)} — {approved ? 'Approved' : 'Waiting'}
                      {approved && approvedAt && <small> · {timeLabel(approvedAt)}</small>}
                    </span>
                    {approved ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Clock3 size={13} aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ul>
            {bet.status === 'pending' && (
              // Approving needs an agreed bet, so the opponent's "Waiting" has nothing to act on yet.
              <p className="prompt-superseded">
                {!participant
                  ? 'Both bettors approve this exact prompt once the bet is agreed.'
                  : bet.agreementApprovals.includes(memberId)
                    ? `${otherName} approves this exact prompt after agreeing to the bet.`
                    : 'You approve this exact prompt after you agree to the bet.'}
              </p>
            )}
            {prompt.version > 1 && (
              <p className="prompt-superseded">
                Approvals of earlier versions do not carry over to v{prompt.version}.
              </p>
            )}
          </section>
        )}
        {bet.adjudication && (
          <section className="adjudication-record">
            <h3>{method === 'judge' ? JUDGE_COPY.recordHeading : 'Recorded ChatGPT response'}</h3>
            <p className="adjudication-verdict">
              <strong>
                {bet.adjudication.winnerId
                  ? `Recommended: ${firstName(bet.adjudication.winnerId)} wins`
                  : 'Recommended: no winner'}
              </strong>
              {!bet.adjudication.winnerId &&
                !resultDone &&
                '. If both bettors confirm, the bet is called off and no rolls are owed.'}
            </p>
            <p>
              <LinkifiedText text={bet.adjudication.reasoning} />
            </p>
            <small>
              Recorded by {member(bet.adjudication.recordedBy)?.name} ·{' '}
              {timeLabel(bet.adjudication.at)}
              {bet.adjudication.promptVersion ? ` · Prompt v${bet.adjudication.promptVersion}` : ''}
            </small>
            {bet.adjudication.sourceUrl && (
              <a href={bet.adjudication.sourceUrl} target="_blank" rel="noreferrer">
                View shared ChatGPT conversation
                <ExternalLink size={13} aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            {method === 'chatgpt' && (
              <p className="provenance-note">
                <ShieldAlert size={15} aria-hidden="true" />
                <span>
                  {bet.adjudication.sourceUrl
                    ? `Pasted by ${bet.adjudication.recordedBy === memberId ? 'you' : fullName(bet.adjudication.recordedBy)}. The app does not call ChatGPT or check this text. Open the shared conversation and compare it before confirming.`
                    : bet.adjudication.recordedBy === memberId
                      ? `Pasted by you without a shared conversation link. The app cannot check where this text came from, so ${otherName} may ask to see the original response.`
                      : `Pasted by ${fullName(bet.adjudication.recordedBy)} without a shared conversation link. The app cannot check where this text came from, so ask ${firstName(bet.adjudication.recordedBy)} for the original response before confirming.`}
                </span>
              </p>
            )}
          </section>
        )}
        {bet.resolution && (
          <div className={`result-block ${resultDone ? '' : 'result-pending'}`}>
            {resultDone ? (
              <Flag size={18} aria-hidden="true" />
            ) : (
              <Clock3 size={18} aria-hidden="true" />
            )}
            <div>
              <h3>
                {resultDone
                  ? winnerId
                    ? `${firstName(winnerId)} won`
                    : calledOff
                      ? 'Called off · no winner'
                      : 'No winner'
                  : mutualResult
                    ? winnerId
                      ? `Proposed result: ${firstName(winnerId)} wins`
                      : `${firstName(bet.resolution.proposedBy)} proposes calling the bet off`
                    : `Recommended result: ${winnerId ? `${firstName(winnerId)} wins` : 'no winner'}`}
                {winnerId && resultDone && (
                  <span>
                    {' '}
                    +{bet.stake} {bet.stake === 1 ? 'roll' : 'rolls'}
                  </span>
                )}
              </h3>
              <p className="result-meta">{resultMeta()}</p>
              {!bet.adjudication && bet.resolution.note && (
                <p>
                  <LinkifiedText text={bet.resolution.note} />
                </p>
              )}
              <ul className="result-signatures" aria-label="Result confirmations">
                {[bet.creatorId, bet.opponentId].map((id) => {
                  const [state, done] = resultSignature(id);
                  return (
                    <li key={id} className={done ? undefined : 'waiting'}>
                      {done ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <Clock3 size={14} aria-hidden="true" />
                      )}
                      {fullName(id)} — {state}
                    </li>
                  );
                })}
              </ul>
              {!resultDone && (
                <p className="result-consequence">
                  {winnerId
                    ? `Once both bettors confirm, ${firstName(loserId)} owes ${firstName(winnerId)} ${rollsText(bet.stake)}.`
                    : 'Once both bettors confirm, the bet is called off and no rolls are owed.'}
                </p>
              )}
              {bet.status === 'voided' && (
                <small>
                  {voidedBy ? (
                    <>
                      No rolls are owed ·{' '}
                      {calledOff
                        ? `${firstName(bet.resolution.proposedBy)} proposed it and ${firstName(voidedBy.actorId)} agreed`
                        : 'both bettors confirmed'}{' '}
                      · <time dateTime={voidedBy.at}>{timeLabel(voidedBy.at)}</time>
                    </>
                  ) : (
                    'No rolls are owed'
                  )}
                </small>
              )}
            </div>
          </div>
        )}
        {closure && (
          <div className="result-block closure-block">
            <Flag size={18} />
            <div>
              <h3>
                {whoIs(closure.event.actorId)}{' '}
                {closure.kind === 'declined'
                  ? `declined this ${record}`
                  : closure.kind === 'withdrawn'
                    ? `withdrew this ${record}`
                    : closure.kind === 'disputed_delivery'
                      ? 'disagreed with the delivery report'
                      : method === 'judge'
                        ? `disagreed with ${isJudge ? 'your' : `${judgeFirst}’s`} recommendation`
                        : method === 'chatgpt'
                          ? 'disagreed with the recorded ChatGPT response'
                          : 'disagreed with the proposed result'}
              </h3>
              <p>{closure.note}</p>
              {closure.disputed && (
                // What was cleared, quoted for what it said; it no longer asks anything of anyone.
                <p className="closure-disputed">
                  {closure.kind === 'disputed_delivery'
                    ? 'Earlier delivery report'
                    : method === 'judge'
                      ? 'Earlier recommendation'
                      : method === 'chatgpt'
                        ? 'Earlier response'
                        : 'Earlier result'}{' '}
                  · {whoIs(closure.disputed.actorId)}:{' '}
                  {clearedResultText(closure.disputed, members)}
                </p>
              )}
              <small>
                {closure.kind === 'disputed_result'
                  ? 'The result was cleared and the bet is back in play'
                  : closure.kind === 'disputed_delivery'
                    ? 'The rolls are still owed'
                    : 'No rolls are owed'}{' '}
                · <time dateTime={closure.event.at}>{timeLabel(closure.event.at)}</time>
              </small>
            </div>
          </div>
        )}
        {offsetRolls > 0 && (
          <section className="result-block offset-record">
            <Scale size={18} />
            <div>
              <h3>
                {bet.status === 'settled' && !bet.settlement
                  ? 'Settled by offset'
                  : 'Mutual debt offsets'}
              </h3>
              <p>
                {offsetRolls} offset · {remainingRolls} remaining. Original stake: {bet.stake}.
              </p>
              {(bet.offsets ?? []).map((offset) => (
                <div className="offset-entry" key={offset.id}>
                  <p>
                    {member(offset.actorId)?.name} applied an offset with{' '}
                    {member(offset.counterpartyId)?.name} on {timeLabel(offset.at)}.
                  </p>
                  <ul>
                    {offset.allocations
                      .filter((item) => item.betId !== bet.id)
                      .map((item) => {
                        const winnerId = bets?.find((other) => other.id === item.betId)?.resolution
                          ?.winnerId;
                        return (
                          <li key={item.betId}>
                            Offset against{' '}
                            <BetLink betId={item.betId} onOpen={onOpenBet}>
                              {offset.references[item.betId]}
                            </BetLink>
                            {winnerId && ` · ${member(winnerId)?.name} won`} · {item.rolls} offset
                          </li>
                        );
                      })}
                  </ul>
                  <small>
                    <span title={offset.id}>Offset {offset.id.slice(0, 8)}</span>. No physical
                    delivery recorded.
                  </small>
                </div>
              ))}
            </div>
          </section>
        )}
        {bet.settlement && (
          <div
            className={`result-block settlement-block ${bet.status === 'settled' ? '' : 'result-pending'}`}
          >
            {bet.status === 'settled' ? (
              <Utensils size={18} aria-hidden="true" />
            ) : (
              <Clock3 size={18} aria-hidden="true" />
            )}
            <div>
              <h3>{bet.status === 'settled' ? 'Lobster rolls delivered' : 'Delivery reported'}</h3>
              <p className="result-meta">
                {bet.status === 'settled' ? 'Settled' : 'Settles'}{' '}
                {rollsText(bet.settlement.rolls ?? remainingRolls)} · reported by{' '}
                {fullName(bet.settlement.proposedBy)}
                {deliveryReportedAt() ? ` · ${timeLabel(deliveryReportedAt()!)}` : ''}
              </p>
              <p>
                <LinkifiedText text={bet.settlement.note} />
              </p>
              <ul className="result-signatures" aria-label="Delivery confirmations">
                {[bet.creatorId, bet.opponentId].map((id) => {
                  const [state, done] = deliverySignature(id);
                  return (
                    <li key={id} className={done ? undefined : 'waiting'}>
                      {done ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <Clock3 size={14} aria-hidden="true" />
                      )}
                      {fullName(id)} — {state}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
        <AgreementProposalRecord bet={bet} members={members} memberId={memberId} />
        {conflict && !staleDraft && latestEvent && (
          <div className="form-note conflict-note" role="alert" tabIndex={-1} ref={conflictRef}>
            <History size={16} />
            <p>{conflictSentence(latestEvent)}</p>
          </div>
        )}
        {(participant || isJudge) &&
          (form || !['settled', 'voided', 'declined'].includes(bet.status)) && (
            <section className="next-action">
              <h3 id="bet-next-step" ref={nextStepHeading} tabIndex={-1}>
                {form ? formTitles[form] : 'The next step'}
              </h3>
              {!form && reviewStale && approvalOnScreen && latestUnread && (
                <div className="form-note review-note" id={reviewNoteId} role="status">
                  <History size={16} />
                  <p>
                    {firstName(latestUnread.actorId)} {describeChange(latestUnread)} while you were
                    reading. Read{' '}
                    {promptRevised ? `prompt v${prompt!.version}` : 'the latest record'} above
                    before approving.
                  </p>
                  <button
                    ref={reviewAckRef}
                    className="button button-secondary"
                    onClick={() => {
                      handoff.current = 'approval';
                      setReviewed({ bet, memberId });
                    }}
                  >
                    I’ve read{' '}
                    {promptRevised ? `prompt v${prompt!.version}` : `version ${bet.version}`}
                  </button>
                </div>
              )}
              {!form && participant && evidenceDispute && <p>{evidenceDisputeSentence()}</p>}
              {step}
              {!form &&
                participant &&
                bet.status === 'active' &&
                !changePending &&
                formApplies('withdraw_proposal', bet, memberId) && (
                  <button
                    className="text-button take-back"
                    disabled={busy}
                    onClick={() => openForm('withdraw_proposal')}
                  >
                    Take back my evidence
                  </button>
                )}
              {/* The other bettor's answer to that evidence: it can be disagreed with, not replaced. */}
              {!form &&
                participant &&
                bet.status === 'active' &&
                !changePending &&
                formApplies('dispute_readiness', bet, memberId) && (
                  <button
                    className="text-button take-back"
                    disabled={busy}
                    onClick={() => openForm('dispute_readiness')}
                  >
                    Disagree with {firstName(bet.readiness?.markedBy)}’s evidence
                  </button>
                )}
              {!form && participant && bet.status === 'active' && !changePending && (
                <button
                  className="text-button call-off"
                  disabled={busy}
                  onClick={() => openForm('void')}
                >
                  Call off this bet
                </button>
              )}
              {form && (
                <form
                  key={`${form}-${formSession}-${formMemberId}`}
                  ref={formRef}
                  onSubmit={submit}
                  onChange={(event) => {
                    setFormDirty(true);
                    setError('');
                    const name = (event.target as unknown as HTMLInputElement).name ?? '';
                    fields.clear(
                      name,
                      name.replace(/\.timezone$/, '.local'),
                      ...historyRevisionAnswered(name),
                      ...historyFieldsAnswered(name),
                    );
                  }}
                  onClick={(event) => {
                    // A pin is placed on the map, which is not a form field.
                    if ((event.target as Element).closest?.('.leaflet-container, .places-map'))
                      fields.clear('location.pin');
                  }}
                  className="inline-action-form"
                  noValidate
                >
                  <FieldErrorsProvider value={fields}>
                    {/* Held while the change is recorded; the footer stays live so focus can stay. */}
                    <fieldset className="form-fields" disabled={busy}>
                      {staleDraft &&
                        !busy &&
                        (formMemberId !== memberId ? (
                          <p className="form-error" role="alert" id={staleNoteId}>
                            The selected member changed. Cancel and reopen this action as{' '}
                            {firstName(memberId)}.
                          </p>
                        ) : (
                          <div
                            className="form-note stale-note"
                            role="alert"
                            tabIndex={-1}
                            ref={staleNoteRef}
                            id={staleNoteId}
                          >
                            <p>
                              {draftChange
                                ? `${draftChange.actorId === memberId ? 'You' : firstName(draftChange.actorId)} ${describeChange(draftChange)} while you were writing. `
                                : 'This record changed while you were writing. '}
                              {form === 'history_confirm'
                                ? 'Your ticks were for the earlier version, so the boxes clear when you use the latest record.'
                                : form === 'history_revision'
                                  ? 'Your edits are kept below; the confirmation boxes clear when you use the latest record.'
                                  : 'Your draft is kept below.'}{' '}
                              {draftApplies
                                ? 'Check the latest record above, then use it to submit.'
                                : draftAnswer === 'settlement'
                                  ? `Review ${answerFrom}’s report and confirm the delivery rather than filing a second one.`
                                  : draftAnswer === 'readiness'
                                    ? `Review ${answerFrom}’s evidence, and disagree with it if it does not show the answer.`
                                    : draftAnswer && winner
                                      ? `${answerFrom}’s result names the same winner, so there is nothing to disagree with. Review it and confirm it.`
                                      : draftAnswer
                                        ? `Review ${answerFrom}’s result, then confirm it or disagree with it.`
                                        : draftReplacement === 'dispute_result'
                                          ? `${answerFrom}’s result names a different winner. Review it, or use your text to disagree with it.`
                                          : draftReplacement === 'void'
                                            ? `The bet is now agreed, so it can no longer be ${form === 'decline' ? 'declined' : 'withdrawn'}. Use your text to ask ${otherName} to call it off instead.`
                                            : 'This action no longer applies to the latest record.'}
                            </p>
                            {(draftApplies || draftReplacement) && (
                              <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => rebaseForm(draftApplies ? form : draftReplacement)}
                              >
                                {draftApplies
                                  ? 'Use the latest record'
                                  : draftReplacement === 'void'
                                    ? 'Use my text to call off the bet'
                                    : 'Use my text to disagree with this result'}
                              </button>
                            )}
                            {draftAnswer && (
                              <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => {
                                  closeForm();
                                  // Evidence has no approval: the next step holds its answers.
                                  if (draftAnswer !== 'readiness') handoff.current = 'approval';
                                }}
                              >
                                Review {answerFrom}’s{' '}
                                {draftAnswer === 'settlement'
                                  ? 'delivery report'
                                  : draftAnswer === 'readiness'
                                    ? 'evidence'
                                    : 'result'}
                              </button>
                            )}
                          </div>
                        ))}
                      {form === 'history_confirm' && formBet?.history && (
                        <HistoryAcknowledgementFields
                          stage={formBet.history.stage}
                          turn="second"
                          summary={historySummary(
                            formBet,
                            formBet.history,
                            (id) => member(id)?.name ?? 'Original bettor',
                          )}
                          duplicates={likelyDuplicates(
                            (bets ?? []).filter((other) => other.id !== formBet.id),
                            formBet,
                            formBet.creatorId,
                          )}
                        />
                      )}
                      {form === 'history_revision' && formBet && (
                        <HistoryRevisionFields
                          bet={formBet}
                          members={members}
                          places={savedPlaces}
                          memberId={memberId}
                        />
                      )}
                      {form === 'check_in' && (
                        <>
                          <DateTimeField
                            name="checkIn"
                            label="Your next check-in"
                            future="always"
                            value={
                              formBet?.checkIns && Object.hasOwn(formBet.checkIns, memberId)
                                ? (formBet.checkIns[memberId] ?? undefined)
                                : formBet?.timing?.checkIn
                            }
                          />
                          <p className="hint">
                            Your check-in appears in the ledger while the app is open. It reminds
                            you to check for evidence and leaves the agreed criteria and timing
                            unchanged.
                          </p>
                        </>
                      )}
                      {form === 'amendment' && (
                        <>
                          {/* A judge who stepped down is what this form is for: it leads with who
                              decides, so the criteria and timing below are the optional part. */}
                          {formBet && methodLeads && (
                            <DecisionMethodFields bet={formBet} members={members} />
                          )}
                          <div className="field">
                            <label>
                              Proposed decision criteria
                              <textarea
                                name="amendmentTerms"
                                defaultValue={formBet?.terms}
                                required
                                minLength={LIMITS.terms.min}
                                maxLength={LIMITS.terms.max}
                                rows={4}
                                data-required-message="Write the decision criteria you are proposing."
                                {...fields.aria('amendmentTerms')}
                              />
                            </label>
                            <FieldError name="amendmentTerms" />
                          </div>
                          <TimingFields
                            timing={
                              formBet?.timing ??
                              (formBet?.deadline
                                ? {
                                    kind: 'date',
                                    at: `${formBet.deadline}T00:00:00.000Z`,
                                    timezone: 'UTC',
                                  }
                                : undefined)
                            }
                            cutoff={formBet?.cutoff}
                            dateNote={
                              !formBet?.timing && formBet?.deadline
                                ? `The agreement only named a decision date, ${dateLabel(formBet.deadline, { year: true })} (UTC). It is filled in as 12:00 AM UTC that day; change the time if review should open later.`
                                : undefined
                            }
                          />
                          {formBet && !methodLeads && (
                            <DecisionMethodFields bet={formBet} members={members} />
                          )}
                          <p className="hint">
                            The other bettor must agree before these changes take effect. New terms
                            clear readiness evidence and require a new ChatGPT prompt agreement,
                            when applicable.
                          </p>
                        </>
                      )}
                      {form === 'adjudication' && method === 'chatgpt' && (
                        <p className="form-note prompt-version-note">
                          <FileCheck2 size={16} />
                          Paste the response ChatGPT gave to agreed prompt v
                          {formBet?.promptAgreement?.version}. A response to any other wording does
                          not count.
                        </p>
                      )}
                      {(form === 'result' || form === 'adjudication') && (
                        <div className="field">
                          <label>
                            {form === 'adjudication' ? JUDGE_COPY.winnerLabel : 'Who won?'}
                            <select
                              name="winner"
                              required
                              value={winner}
                              onChange={(event) => setWinner(event.target.value)}
                              data-required-message="Choose an outcome."
                              {...fields.aria('winner')}
                            >
                              <option value="">Choose an outcome</option>
                              <option value={creator?.id}>{creator?.name}</option>
                              <option value={opponent?.id}>{opponent?.name}</option>
                              <option value="tie">
                                {form === 'adjudication' && method === 'chatgpt'
                                  ? 'No winner / insufficient evidence'
                                  : 'No winner — call the bet off'}
                              </option>
                            </select>
                          </label>
                          <FieldError name="winner" />
                        </div>
                      )}
                      {form === 'adjudication' && method === 'chatgpt' && (
                        <p className="hint response-hint">
                          Choose no winner if ChatGPT could not pick one. Once both bettors confirm,
                          the bet is called off with no rolls owed. If evidence is missing, you can
                          instead add the missing evidence and revise the prompt.
                        </p>
                      )}
                      {/* The evidence itself sits far up the sheet, in the timing record. */}
                      {form === 'dispute_readiness' && formBet?.readiness && (
                        <p className="form-note evidence-quote">
                          {firstName(formBet.readiness.markedBy)}’s evidence: “
                          {formBet.readiness.evidence}”
                        </p>
                      )}
                      {!['history_confirm', 'history_revision', 'check_in'].includes(form) && (
                        <div className="field">
                          <label>
                            {form === 'prompt'
                              ? 'Exact prompt for both of you to approve'
                              : form === 'adjudication'
                                ? method === 'chatgpt'
                                  ? 'Paste the response and reasoning'
                                  : JUDGE_COPY.fieldLabel
                                : form === 'result'
                                  ? 'Evidence or explanation'
                                  : form === 'settlement'
                                    ? 'Where and when were the rolls delivered?'
                                    : form === 'ready'
                                      ? 'Evidence that the answer is available'
                                      : form === 'amendment'
                                        ? 'Why are you proposing these changes?'
                                        : form === 'history_correction'
                                          ? 'What needs to be corrected?'
                                          : form === 'dispute_readiness'
                                            ? 'Why does this evidence not show the answer?'
                                            : 'Reason'}
                            <textarea
                              name="note"
                              className={form === 'prompt' ? 'prompt-editor' : ''}
                              value={note}
                              onChange={(event) => setNote(event.target.value)}
                              required
                              minLength={
                                form === 'prompt' ? LIMITS.prompt.min : danger ? exitReasonMin : 3
                              }
                              // A pasted note, prompt or response is counted below rather than silently cut at the limit.
                              rows={form === 'prompt' ? 12 : 4}
                              placeholder={
                                form === 'settlement'
                                  ? 'e.g. Lobster rolls at lunch at Row 34 today.'
                                  : 'Include enough detail for the other person to review.'
                              }
                              data-required-message={
                                noteRequired[form] ??
                                `Write a reason of at least ${exitReasonMin} characters. It stays on the record.`
                              }
                              {...fields.aria(
                                'note',
                                form === 'prompt' && promptCountId,
                                form === 'adjudication' && 'response-count',
                                counted && noteCountId,
                              )}
                            />
                          </label>
                          {form === 'prompt' && (
                            <>
                              <p className="hint field-count" id={promptCountId}>
                                {promptLength.toLocaleString('en-US')} of{' '}
                                {LIMITS.prompt.max.toLocaleString('en-US')} characters
                                {promptOver > 0 &&
                                  ` · ${promptOver.toLocaleString('en-US')} over the limit`}
                              </p>
                              {/* Mounted before any typing and worded without the count, as the response's is. */}
                              <div className="response-limit" role="status">
                                {promptOver > 0 && (
                                  <p className="form-error response-over">
                                    {`The prompt is over the ${LIMITS.prompt.max.toLocaleString('en-US')}-character limit. Trim it before proposing.`}
                                  </p>
                                )}
                              </div>
                            </>
                          )}
                          {counted && (
                            <>
                              <p className="hint field-count" id={noteCountId}>
                                {noteLength.toLocaleString('en-US')} of{' '}
                                {noteMax.toLocaleString('en-US')} characters
                                {noteOver > 0 &&
                                  ` · ${noteOver.toLocaleString('en-US')} over the limit`}
                              </p>
                              {/* Mounted before any typing and worded without the count, as the prompt's is. */}
                              <div className="response-limit" role="status">
                                {noteOver > 0 && (
                                  <p className="form-error response-over">
                                    {`The ${noteWords()[0]} is over the ${noteMax.toLocaleString('en-US')}-character limit. Trim it before ${noteWords()[1]}.`}
                                  </p>
                                )}
                              </div>
                            </>
                          )}
                          <FieldError name="note" />
                        </div>
                      )}
                      {form === 'adjudication' && (
                        <>
                          <p className="hint character-count" id="response-count">
                            {responseLength.toLocaleString('en-US')} of{' '}
                            {LIMITS.response.max.toLocaleString('en-US')} characters
                            {responseOver > 0 &&
                              ` · ${responseOver.toLocaleString('en-US')} over the limit`}
                          </p>
                          {/* Mounted before any typing, and worded without the count, so it speaks once
                          when the response goes over rather than on every keystroke. */}
                          <div className="response-limit" role="status">
                            {responseOver > 0 && (
                              <p className="form-error response-over">
                                {`The response is over the ${LIMITS.response.max.toLocaleString('en-US')}-character limit. Trim it before recording.`}
                              </p>
                            )}
                          </div>
                        </>
                      )}
                      {formConsequences[form] && <p className="hint">{formConsequences[form]}</p>}
                      {form === 'settlement' && (
                        <p className="hint">
                          {/* Either bettor may report it; whoever reads this is "you". */}
                          {`This report settles all ${remainingRolls} ${remainingRolls === 1 ? 'roll' : 'rolls'} ${
                            memberId === winnerId
                              ? `${firstName(loserId)} still owes you`
                              : `you still owe ${firstName(winnerId ?? '')}`
                          }. A delivery report cannot settle part of a debt. ${otherName} confirms this report before the debt is settled.`}
                        </p>
                      )}
                      {form === 'prompt' && (
                        <p className="hint prompt-hint">
                          {formBet?.promptAgreement &&
                          [formBet.creatorId, formBet.opponentId].every((id) =>
                            formBet.promptAgreement!.approvals.includes(id),
                          )
                            ? `Proposing this revision replaces agreed prompt v${formBet.promptAgreement.version}: ${otherName} must approve v${formBet.promptAgreement.version + 1} before a response can be recorded. v${formBet.promptAgreement.version} stays in the paper trail.`
                            : 'Include the evidence in this exact prompt. You approve this wording when proposing it; your opponent must also approve. Revisions reset the approvals.'}
                        </p>
                      )}
                      {form === 'adjudication' && method === 'chatgpt' && (
                        <div className="field">
                          <label>
                            <span className="field-label">
                              Shared ChatGPT conversation <span className="optional">Optional</span>
                            </span>
                            <input
                              name="sourceUrl"
                              type="url"
                              value={sourceUrl}
                              onChange={(event) => setSourceUrl(event.target.value)}
                              onBlur={(event) => {
                                const problem =
                                  event.target.value.trim() && shareLinkProblem(event.target.value);
                                if (problem)
                                  whenPressEnds(event.target, () =>
                                    fields.setError('sourceUrl', problem),
                                  );
                              }}
                              placeholder="https://chatgpt.com/share/…"
                              maxLength={500}
                              data-check="chatgpt-share"
                              data-format-message={shareLinkProblem('')}
                              {...fields.aria('sourceUrl')}
                            />
                          </label>
                          <FieldError name="sourceUrl" />
                        </div>
                      )}
                    </fieldset>
                    {/* One order everywhere: Cancel first, so the submit is never the easy reach by mistake. */}
                    <div className="modal-footer">
                      {error && !conflict && (
                        <p className="form-error" role="alert">
                          {error}
                        </p>
                      )}
                      <UnplacedErrors fields={fields} />
                      {/* Leaves only this form, asking first when something was typed into it. */}
                      <ModalCancel onCancel={closeForm} dirty={formDirty} disabled={busy} />
                      <button
                        ref={submitRef}
                        className={`button ${danger ? 'button-danger' : 'button-primary'}`}
                        type="submit"
                        aria-disabled={busy || staleDraft || overLimit || undefined}
                        aria-busy={busy || undefined}
                        aria-describedby={
                          staleDraft && !busy
                            ? staleNoteId
                            : promptOver > 0
                              ? promptCountId
                              : responseOver > 0
                                ? 'response-count'
                                : noteOver > 0
                                  ? noteCountId
                                  : undefined
                        }
                      >
                        {busy ? 'Recording…' : formSubmitLabels[form]}
                      </button>
                    </div>
                  </FieldErrorsProvider>
                </form>
              )}
              {!form && inPlayTools && (
                <details
                  className="workflow-tools"
                  // Once a cutoff or check-in has passed, the evidence button is the next step.
                  open={!!readiness.reviewDue && !readiness.ready}
                >
                  <summary>Evidence, check-ins, and agreement changes</summary>
                  <div className="action-buttons">
                    {/* Evidence the other bettor added is theirs: it is disagreed with, not replaced. */}
                    {formApplies('ready', bet, memberId) && (
                      <button
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => openForm('ready')}
                      >
                        Add readiness evidence
                      </button>
                    )}
                    <button
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => openForm('check_in')}
                    >
                      Set my check-in
                    </button>
                    {!!ownCheckIn && (
                      <button
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => void act({ type: 'set_check_in', checkIn: null })}
                      >
                        Remove my check-in
                      </button>
                    )}
                    <button
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => openForm('amendment')}
                    >
                      Propose changes
                    </button>
                  </div>
                </details>
              )}
              {error && !conflict && !form && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}
        {!participant && !isJudge && !closed && (
          // Everyone else has no next step of their own, so the note says whose move it is first.
          <p className="form-note permission-note">
            <ShieldCheck size={17} />
            <span>
              {watching && <strong>{watching}</strong>}
              {watching && ' '}
              {`Only ${bettors} can act on this bet${
                // The judge's part is only named while their recommendation is still to come, and
                // not again when the line before this one has just said it.
                method === 'judge' &&
                bet.judgeId &&
                !bet.judgeDeclined &&
                !bet.adjudication &&
                ['pending', 'active'].includes(bet.status) &&
                watching !== judgeWaitingLine(judgeFirst)
                  ? `; ${judgeFirst} records the judge’s recommendation`
                  : ''
              }.`}
            </span>
          </p>
        )}
        <div className="timeline-heading">
          <h3>
            <History size={17} />
            The paper trail
          </h3>
          <span>
            {bet.events.length} {bet.events.length === 1 ? 'record' : 'records'}
          </span>
        </div>
        <ol className="timeline">
          {[...bet.events].reverse().map((event) => {
            const shown = auditDisplay(event, members, bet);
            return (
              <li key={event.id}>
                <span className="timeline-dot" />
                <div>
                  <p>
                    <LinkifiedText text={shown.text} />
                  </p>
                  <small>
                    {member(event.actorId)?.name ?? 'Member'} <span>·</span>
                    <time dateTime={event.at}>{timeLabel(event.at)}</time>
                  </small>
                  {shown.attachment && (
                    <details className="workflow-prior audit-attachment">
                      <summary>{shown.attachment.label}</summary>
                      <p>
                        <LinkifiedText text={shown.attachment.text} />
                      </p>
                    </details>
                  )}
                  <PriorHistoryRecord event={event} members={members} bet={bet} />
                  <PriorAmendmentRecord event={event} members={members} />
                </div>
              </li>
            );
          })}
        </ol>
        <p className="audit-note">
          <ShieldCheck size={14} />
          Every approval is attributed and timestamped. Record revision {bet.version}.
        </p>
      </div>
    </Modal>
  );
}
