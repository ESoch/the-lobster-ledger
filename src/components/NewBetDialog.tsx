import { useEffect, useId, useState } from 'react';
import { MapPin, ArrowRight, Info, Check } from 'lucide-react';
import type {
  LedgerState,
  NewBet,
  Category,
  Place,
  DecisionMethod,
  HistoricalDate,
  HistoricalInput,
} from '../lib/types';
import { Modal, ModalCancel, Avatar } from './ui';
import { MapView as PlacesMap } from './MapView';
import { LIMITS } from '../lib/limits';
import { HistoryFieldError, likelyDuplicates, textKey, trimText } from '../lib/bet-workflow';
import {
  DifferentBetField,
  HistoryFields,
  HistoryStageField,
  HistoryAcknowledgementFields,
  StageFields,
  TimingFields,
  historyFieldProblem,
  historyFieldsAnswered,
  historyProblems,
  readHistory,
  readAcknowledgements,
  readTiming,
} from './WorkflowFields';
import {
  FieldError,
  FieldErrorsProvider,
  UnplacedErrors,
  findProblems,
  useFieldErrors,
  type FieldProblem,
} from './form-errors';
import { JUDGE_COPY } from './JudgeCopy';

const pinnedLabel = (name: string) =>
  trimText(name) ? `${trimText(name)} is pinned.` : 'Your pin is placed. Name the location above.';

export function NewBetDialog({
  open,
  onClose,
  state,
  memberId,
  onCreate,
  mode = 'new',
  initialPlaceId = '',
  initialOpponentId = '',
}: {
  open: boolean;
  onClose: () => void;
  state: LedgerState;
  memberId: string;
  onCreate: (input: NewBet) => Promise<void>;
  mode?: 'new' | 'history';
  /** A saved place id, or 'custom' to open the pin picker. */
  initialPlaceId?: string;
  /** The member to start the bet with, when the dialog is opened from their card. */
  initialOpponentId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Anything typed or chosen: Escape, an outside click or Close then ask before discarding it.
  const [dirty, setDirty] = useState(false);
  const fields = useFieldErrors();
  const [opponent, setOpponent] = useState(
    initialOpponentId !== memberId &&
      state.members.some((member) => member.id === initialOpponentId)
      ? initialOpponentId
      : '',
  );
  const [placeId, setPlaceId] = useState(initialPlaceId);
  const [pin, setPin] = useState<{ lat: number; lng: number }>();
  const [pinNote, setPinNote] = useState('');
  const [customPlace, setCustomPlace] = useState('');
  const [decisionMethod, setDecisionMethod] = useState<DecisionMethod>('mutual');
  const [judgeId, setJudgeId] = useState('');
  const [judgeNote, setJudgeNote] = useState('');
  const [historyStage, setHistoryStage] = useState<HistoricalInput['stage']>('active');
  const [title, setTitle] = useState('');
  const [stake, setStake] = useState(1);
  const [originalDate, setOriginalDate] = useState<HistoricalDate>();
  const ids = useId();
  const historical = mode === 'history';
  const ongoing = !historical || historyStage === 'active';
  const current = state.members.find((member) => member.id === memberId);
  const person = state.members.find((member) => member.id === opponent);
  const opponentFirst = person?.name.split(' ')[0];
  const clearField = fields.clear;
  // A pin placed on the map answers a missing-pin message; the map is not a form field.
  useEffect(() => {
    if (pin) clearField('customPlace');
  }, [pin, clearField]);
  // A past bet that is already on the ledger would count its rolls twice once confirmed.
  const duplicates =
    historical && opponent
      ? likelyDuplicates(
          state.bets,
          { title, opponentId: opponent, stake, history: { originalDate } },
          memberId,
        )
      : [];
  /** What the browser's own checks cannot see: two identical positions and an unfinished pin. */
  function problems(form: HTMLFormElement): FieldProblem[] {
    const extra: FieldProblem[] = [];
    const creatorSide = form.elements.namedItem('creatorSide') as HTMLInputElement | null;
    const opponentSide = form.elements.namedItem('opponentSide') as HTMLInputElement | null;
    if (
      creatorSide &&
      opponentSide &&
      textKey(creatorSide.value) &&
      textKey(creatorSide.value) === textKey(opponentSide.value)
    )
      extra.push({
        name: 'opponentSide',
        message: 'The two positions must be different.',
        element: opponentSide,
      });
    const place = form.querySelector<HTMLInputElement>('.custom-place input');
    if (placeId === 'custom' && place && (!trimText(customPlace) || !pin))
      extra.push({
        name: 'customPlace',
        message: !trimText(customPlace)
          ? 'Name the location you are pinning.'
          : 'Choose a point on the map for this location.',
        element: place,
      });
    // A past bet's dates and links are checked with the ledger's own history rules.
    if (historical) extra.push(...historyProblems(form, [memberId, opponent]));
    return findProblems(form, extra);
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const element = event.currentTarget;
    if (fields.show(problems(element))) return;
    const form = new FormData(element);
    setBusy(true);
    try {
      let location: Place | undefined = state.places.find((place) => place.id === placeId);
      if (placeId === 'custom' && pin)
        location = {
          id: crypto.randomUUID(),
          name: trimText(customPlace),
          address: 'Pinned location',
          ...pin,
        };
      await onCreate({
        title: String(form.get('title')),
        terms: String(form.get('terms')),
        category: form.get('category') as Category,
        opponentId: opponent,
        creatorSide: String(form.get('creatorSide')),
        opponentSide: String(form.get('opponentSide')),
        stake: Number(form.get('stake')),
        ...(ongoing ? readTiming(form) : {}),
        ...(historical
          ? { history: readHistory(form), acknowledgements: readAcknowledgements(form) }
          : {}),
        location,
        decisionMethod: ongoing ? decisionMethod : 'mutual',
        judgeId: ongoing && decisionMethod === 'judge' ? judgeId : undefined,
      });
      onClose();
    } catch (reason) {
      // A refused history names its part, so the message goes under that field.
      const problem =
        reason instanceof HistoryFieldError ? historyFieldProblem(element, reason) : undefined;
      if (problem) fields.show([problem]);
      else setError(reason instanceof Error ? reason.message : 'Unable to create this bet.');
    } finally {
      setBusy(false);
    }
  }
  /** A change answers the message on that field, and on any field it was checked against. */
  function changed(event: React.FormEvent<HTMLFormElement>) {
    setDirty(true);
    setError('');
    const target = event.target as HTMLInputElement;
    const names = [target.name];
    if (['creatorSide', 'opponentSide'].includes(target.name))
      names.push('creatorSide', 'opponentSide');
    if (target.name.endsWith('.timezone')) names.push(target.name.replace(/timezone$/, 'local'));
    names.push(...historyFieldsAnswered(target.name));
    if (target.closest('.custom-place')) names.push('customPlace');
    clearField(...names.filter(Boolean));
  }
  const judgeHint = `${ids}judge-hint`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={historical ? 'Bring an old bet into the ledger.' : 'Put it on the record.'}
      description={
        historical
          ? 'Record what happened, including what you remember about the dates. Both original bettors review the same history before it counts.'
          : 'A good wager starts with clear terms. Your opponent will confirm these before the bet is on.'
      }
      wide
      dirty={dirty}
    >
      <form onSubmit={submit} onChange={changed} className="bet-form" noValidate>
        <FieldErrorsProvider value={fields}>
          {historical && (
            <HistoryStageField
              stage={historyStage}
              onStageChange={setHistoryStage}
              other={opponentFirst}
              autoFocus
            />
          )}
          <div className="field">
            <label>
              What’s the bet?
              <input
                name="title"
                placeholder={
                  historical
                    ? 'e.g. The ferry beats the rideshare to the office'
                    : 'e.g. The new website ships before Friday'
                }
                required
                minLength={LIMITS.title.min}
                maxLength={LIMITS.title.max}
                autoFocus={!historical}
                data-required-message="Say what the bet is in a few words."
                onChange={(event) => setTitle(event.target.value)}
                {...fields.aria('title')}
              />
            </label>
            <FieldError name="title" />
          </div>
          {historical && (
            // Always mounted so assistive tech announces the text when it changes.
            <div className="duplicate-status" role="status" aria-live="polite">
              {duplicates.length > 0 && (
                <p className="form-note duplicate-warning">
                  This looks like a bet already on the ledger:{' '}
                  {duplicates.map((bet) => `${bet.reference} (${bet.title})`).join(', ')}.
                  Confirming it again would count the same rolls twice.
                </p>
              )}
            </div>
          )}
          {duplicates.length > 0 && <DifferentBetField />}
          <div className="form-grid">
            <div className="field">
              <label>
                Who’s on the other side?
                <select
                  name="opponentId"
                  value={opponent}
                  onChange={(event) => {
                    const next = event.target.value;
                    setOpponent(next);
                    // A bettor cannot judge their own bet, so a judge who becomes the opponent goes.
                    if (next && next === judgeId) {
                      setJudgeId('');
                      const name = state.members.find((member) => member.id === next)?.name;
                      setJudgeNote(
                        `${name} is now on the other side, so they can’t judge this bet. Choose another judge.`,
                      );
                    }
                  }}
                  required
                  data-required-message="Choose who is on the other side."
                  {...fields.aria('opponentId')}
                >
                  <option value="">Choose a member</option>
                  {state.members
                    .filter((member) => member.id !== memberId)
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                </select>
              </label>
              <FieldError name="opponentId" />
            </div>
            <div className="field">
              <label>
                Rolls at stake
                <span className="input-affix">
                  <input
                    name="stake"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    step={1}
                    defaultValue={1}
                    required
                    data-required-message="Enter how many rolls are at stake."
                    data-range-message="Use a whole number of rolls from 1 to 100."
                    onChange={(event) => setStake(Number(event.target.value))}
                    {...fields.aria('stake')}
                  />
                  <span aria-hidden="true">{stake === 1 ? 'lobster roll' : 'lobster rolls'}</span>
                </span>
              </label>
              <FieldError name="stake" />
            </div>
          </div>
          <div className="positions-form">
            <div className="field">
              <div className="position-label">
                <Avatar member={current} size={24} decorative />
                <label htmlFor={`${ids}creator-side`}>Your position</label>
              </div>
              <input
                id={`${ids}creator-side`}
                name="creatorSide"
                placeholder={historical ? 'The ferry is faster' : 'It ships by Friday'}
                required
                maxLength={LIMITS.side.max}
                data-required-message="Write your side of the bet."
                {...fields.aria('creatorSide')}
              />
              <FieldError name="creatorSide" />
            </div>
            <span className="versus" aria-hidden="true">
              vs
            </span>
            <div className="field">
              <div className="position-label">
                <Avatar member={person} size={24} decorative />
                <label htmlFor={`${ids}opponent-side`}>
                  {opponentFirst ? `${opponentFirst}’s position` : 'Their position'}
                </label>
              </div>
              <input
                id={`${ids}opponent-side`}
                name="opponentSide"
                placeholder={historical ? 'The rideshare is faster' : 'It ships after Friday'}
                required
                maxLength={LIMITS.side.max}
                data-required-message={`Write ${opponentFirst ? `${opponentFirst}’s` : 'their'} side of the bet.`}
                {...fields.aria('opponentSide')}
              />
              <FieldError name="opponentSide" />
            </div>
          </div>
          <div className="field">
            <label>
              {historical ? 'What were the original decision criteria?' : 'What counts as proof?'}
              <textarea
                name="terms"
                placeholder={
                  historical
                    ? 'Write it as you agreed it then: what would settle it, and what was to happen in a tie?'
                    : 'Be specific. What evidence settles it, and what happens if it’s a tie?'
                }
                required
                minLength={LIMITS.terms.min}
                maxLength={LIMITS.terms.max}
                rows={3}
                data-required-message="Say what evidence settles the bet."
                {...fields.aria('terms')}
              />
            </label>
            <FieldError name="terms" />
          </div>
          {historical && (
            <HistoryFields
              members={state.members}
              creatorId={memberId}
              opponentId={opponent}
              stage={historyStage}
              onStageChange={setHistoryStage}
              showStage={false}
              onOriginalDate={setOriginalDate}
            />
          )}
          {(ongoing || historical) && (
            <StageFields show={ongoing} keep={historical}>
              <div className="field">
                <label>
                  Who makes the call?
                  <select
                    name="decisionMethod"
                    value={decisionMethod}
                    onChange={(event) => setDecisionMethod(event.target.value as DecisionMethod)}
                  >
                    <option value="mutual">Both bettors agree</option>
                    <option value="judge">An appointed judge</option>
                    <option value="chatgpt">ChatGPT, with an agreed prompt</option>
                  </select>
                </label>
              </div>
              {decisionMethod === 'judge' && (
                <div className="field">
                  <label>
                    Appoint a judge
                    <select
                      name="judgeId"
                      value={judgeId}
                      onChange={(event) => {
                        setJudgeId(event.target.value);
                        setJudgeNote('');
                      }}
                      required
                      data-required-message="Choose a judge."
                      {...fields.aria('judgeId', judgeHint)}
                    >
                      <option value="">Choose another member</option>
                      {state.members
                        .filter((person) => ![memberId, opponent].includes(person.id))
                        .map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="hint" id={judgeHint}>
                    {JUDGE_COPY.newBetHint}
                  </p>
                  <p className="hint judge-status" role="status">
                    {judgeNote}
                  </p>
                  <FieldError name="judgeId" />
                </div>
              )}
              {decisionMethod === 'chatgpt' && (
                <p className="form-note">
                  <Info size={16} />
                  After agreeing to the bet, you’ll both approve the exact ChatGPT prompt. Any edit
                  requires fresh approval. Record ChatGPT’s response, then both confirm the result.
                </p>
              )}
              <TimingFields />
            </StageFields>
          )}
          <div className="form-grid">
            <div className="field">
              <label>
                Category
                <select name="category">
                  <option>Work</option>
                  <option>Sports</option>
                  <option>Life</option>
                  <option>Wild card</option>
                </select>
              </label>
            </div>
            <div className="field">
              <label>
                <span className="field-label">
                  <MapPin size={14} aria-hidden="true" /> Where was the bet made?{' '}
                  <span className="optional">Optional</span>
                </span>
                <select
                  value={placeId}
                  onChange={(event) => {
                    setPlaceId(event.target.value);
                    // A message about the pin being named or placed is for the picker it was in.
                    clearField('customPlace');
                  }}
                >
                  <option value="">No location</option>
                  {state.places.map((place) => (
                    <option value={place.id} key={place.id}>
                      {place.name}
                    </option>
                  ))}
                  <option value="custom">+ Pin a new location</option>
                </select>
              </label>
            </div>
          </div>
          {placeId === 'custom' && (
            <div className="custom-place">
              <div className="field">
                <label>
                  Location name
                  <input
                    value={customPlace}
                    onChange={(event) => setCustomPlace(event.target.value)}
                    onBlur={() => pin && setPinNote(pinnedLabel(customPlace))}
                    placeholder="e.g. The office kitchen"
                    maxLength={120}
                    required
                    {...fields.aria('customPlace')}
                  />
                </label>
                {/* A missing name or pin is said here, with the field that holds focus, not out of
                    sight below the map. */}
                <FieldError name="customPlace" />
              </div>
              <PlacesMap
                places={state.places}
                bets={[]}
                compact
                pickedLocation={pin}
                onPickLocation={(location) => {
                  setPin(location);
                  setPinNote(pinnedLabel(customPlace));
                }}
                onClearPin={() => setPin(undefined)}
              />
              <p className={`hint pin-status${pin ? ' is-pinned' : ''}`}>
                {pin && <Check size={14} aria-hidden="true" />}
                {/* What is shown follows the name as it is typed. What is announced waits until the
                    name field is left, so it is not read out again with every key. */}
                <span className="pin-status-text" aria-hidden="true">
                  {pin ? pinnedLabel(customPlace) : 'No pin yet.'}
                </span>
                <span className="sr-only" role="status">
                  {pin ? pinNote : 'No pin yet.'}
                </span>
              </p>
            </div>
          )}
          {historical ? (
            <HistoryAcknowledgementFields stage={historyStage} other={opponentFirst} />
          ) : (
            <p className="form-note">
              <Info size={16} />
              <span>
                Creating this bet is your approval of the terms. Your opponent gets the final say
                before it becomes active. Debts are settled with real lobster rolls.
              </span>
            </p>
          )}
          <div className="modal-footer">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <UnplacedErrors fields={fields} />
            <ModalCancel />
            {/* Never disabled: a missing field is named under the field when this is pressed. */}
            <button
              className="button button-primary"
              type="submit"
              aria-disabled={busy || undefined}
              aria-busy={busy || undefined}
            >
              {busy ? 'Recording…' : historical ? 'Send history for confirmation' : 'Propose bet'}
              <ArrowRight size={16} />
            </button>
          </div>
        </FieldErrorsProvider>
      </form>
    </Modal>
  );
}
