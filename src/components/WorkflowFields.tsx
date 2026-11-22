import { useEffect, useId, useState, type ReactNode } from 'react';
import type {
  Bet,
  DecisionCutoff,
  DecisionTiming,
  HistoricalDate,
  HistoricalInput,
  HistoryAcknowledgements,
  Member,
  ZonedDateTime,
} from '../lib/types';
import { LIMITS } from '../lib/limits';
import {
  HistoryFieldError,
  historyDateMessages,
  historyDateStart,
  historyOrderMessage,
  historyStageNames,
  normaliseHistoricalMonth,
  trimText,
  validateHistory,
  type HistoryDateField,
  type HistoryField,
} from '../lib/bet-workflow';
import { FieldError, timezoneProblem, useFieldAria, type FieldProblem } from './form-errors';
import {
  DATE_TIME_MAX,
  DATE_TIME_MIN,
  DATE_TIME_RANGE_MESSAGE,
  localDateTimeToIso,
  zonedInputValue,
} from './workflow-values';
import './workflow.css';

export const historyStageLabels = historyStageNames;

const text = (data: FormData, name: string) => trimText(String(data.get(name) ?? ''));

export function DateTimeField({
  name,
  label,
  value,
  disabled = false,
  future,
  note,
}: {
  name: string;
  /** Names the pair, such as "Review opens on"; the two fields are "Date and time" and "Timezone". */
  label: string;
  value?: ZonedDateTime;
  /** Switched off (and left out of the form) while its branch is hidden, keeping what was typed. */
  disabled?: boolean;
  /** The time must still be ahead: always, or only when it differs from the `value` it opened with. */
  future?: 'always' | 'changed';
  /** Something to know about the value shown, read out with the date and shown under the pair. */
  note?: ReactNode;
}) {
  const zoneList = useId();
  const noteId = useId();
  const { aria, report } = useFieldAria();
  const initialZone = value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <fieldset className="workflow-fieldset workflow-date-time" disabled={disabled}>
      <legend>{label}</legend>
      <div className="field">
        <label>
          Date and time
          <input
            name={`${name}.local`}
            type="datetime-local"
            defaultValue={value ? zonedInputValue(value.at, value.timezone) : ''}
            required
            min={DATE_TIME_MIN}
            max={DATE_TIME_MAX}
            data-required-message="Choose a date and time."
            data-range-message={DATE_TIME_RANGE_MESSAGE}
            data-zone-field={`${name}.timezone`}
            data-future={future}
            {...aria(`${name}.local`, note ? noteId : undefined)}
          />
        </label>
        <FieldError name={`${name}.local`} />
      </div>
      <div className="field">
        <label>
          Timezone
          <input
            name={`${name}.timezone`}
            defaultValue={initialZone}
            list={zoneList}
            required
            maxLength={100}
            spellCheck={false}
            autoCapitalize="none"
            data-check="timezone"
            data-required-message="Choose a timezone, such as America/New_York or UTC."
            onBlur={(event) =>
              report(event.target, `${name}.timezone`, timezoneProblem(event.target.value))
            }
            {...aria(`${name}.timezone`)}
          />
          <datalist id={zoneList}>
            {[
              'UTC',
              'America/Los_Angeles',
              'America/Denver',
              'America/Chicago',
              'America/New_York',
              'Europe/London',
              'Europe/Paris',
              'Asia/Tokyo',
              'Asia/Kolkata',
              'Australia/Sydney',
            ].map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
        <FieldError name={`${name}.timezone`} />
      </div>
      {note && (
        <p className="hint date-note" id={noteId}>
          {note}
        </p>
      )}
    </fieldset>
  );
}

export function readDateTime(data: FormData, name: string): ZonedDateTime {
  const timezone = text(data, `${name}.timezone`);
  return { at: localDateTimeToIso(text(data, `${name}.local`), timezone), timezone };
}

/** Today on this device, as YYYY-MM-DD: the latest day a past bet can be dated. */
function localToday(): string {
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type DatePrecision = Exclude<HistoricalDate['precision'], 'unknown'>;
const precisionLength: Record<DatePrecision, number> = { year: 4, month: 7, day: 10 };

/** The earliest a past bet's dates can be dated: before this a year is a typing slip. */
const earliestDay = '1900-01-01';

/**
 * One date of a past bet: how well it is remembered first, then the date in that precision. What
 * was typed carries over when the precision changes (a day becomes its month and year, and comes
 * back if it still fits). Day and month stop at today and at 1900, or at the date of the stage
 * before this one; a problem shows under the group.
 */
export function HistoricalDateField({
  name,
  label,
  value = { precision: 'unknown' },
  field = 'originalDate',
  stage = 'active',
  notBefore,
  onStart,
  onDate,
}: {
  name: string;
  label: string;
  value?: HistoricalDate;
  /** Which date this is, for messages that name it. */
  field?: HistoryDateField;
  stage?: HistoricalInput['stage'];
  /** The first day of the stage before this one, which this date cannot come before. */
  notBefore?: { day: string; field: HistoryDateField };
  /** Told the first day this date could be whenever it changes (nothing while it is unfinished). */
  onStart?: (day: string | undefined) => void;
  /** Told the date as typed (with its precision) whenever either changes, finished or not. */
  onDate?: (date: HistoricalDate) => void;
}) {
  const [precision, setPrecision] = useState(value.precision);
  const [values, setValues] = useState<Record<DatePrecision, string>>(() => ({
    day: '',
    month: '',
    year: '',
    ...(value.precision !== 'unknown' ? { [value.precision]: value.value } : {}),
  }));
  const { aria } = useFieldAria();
  const messages = historyDateMessages(field, stage);
  const today = localToday();
  const typedValue =
    precision === 'unknown'
      ? ''
      : precision === 'month'
        ? normaliseHistoricalMonth(values.month)
        : values[precision].trim();
  const start = historyDateStart(
    precision === 'unknown' ? { precision } : { precision, value: typedValue },
  );
  useEffect(() => onStart?.(start), [start, onStart]);
  useEffect(
    () => onDate?.(precision === 'unknown' ? { precision } : { precision, value: typedValue }),
    [precision, typedValue, onDate],
  );
  // Never before the stage ahead of this one, nor before 1900.
  const afterStage = !!notBefore && notBefore.day > earliestDay;
  const earliest = afterStage ? notBefore.day : earliestDay;
  const earliestHere = precision === 'unknown' ? '' : earliest.slice(0, precisionLength[precision]);
  const tooEarly =
    precision !== 'unknown' &&
    typedValue.length === precisionLength[precision] &&
    typedValue < earliestHere;
  function changePrecision(next: HistoricalDate['precision']) {
    if (precision !== 'unknown') {
      const typed =
        precision === 'month' ? normaliseHistoricalMonth(values.month) : values[precision].trim();
      // Only a complete date is carried over; anything else stays where it was typed.
      if (
        /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(typed) &&
        typed.length === precisionLength[precision]
      )
        setValues((current) => {
          const updated = { ...current, [precision]: typed };
          for (const other of ['day', 'month', 'year'] as const) {
            if (other === precision) continue;
            if (precisionLength[other] <= typed.length)
              updated[other] = typed.slice(0, precisionLength[other]);
            else if (!updated[other].startsWith(typed)) updated[other] = '';
          }
          return updated;
        });
    }
    setPrecision(next);
  }
  return (
    <fieldset className="workflow-fieldset historical-date-field">
      <legend>{label}</legend>
      <div className="workflow-date-grid">
        <label>
          <span className="sr-only">{label} precision</span>
          <select
            name={`${name}.precision`}
            value={precision}
            onChange={(event) => changePrecision(event.target.value as HistoricalDate['precision'])}
            {...aria(`${name}.precision`)}
          >
            <option value="unknown">Date unknown</option>
            <option value="day">Exact day</option>
            <option value="month">Month and year</option>
            <option value="year">Year only</option>
          </select>
        </label>
        {precision !== 'unknown' && (
          <label>
            <span className="sr-only">{label} value</span>
            <input
              key={precision}
              name={`${name}.value`}
              type={precision === 'year' ? 'number' : precision === 'month' ? 'month' : 'date'}
              min={precision === 'year' ? Number(earliestHere) : earliestHere}
              max={
                precision === 'year'
                  ? Number(today.slice(0, 4))
                  : today.slice(0, precisionLength[precision])
              }
              step={precision === 'year' ? 1 : undefined}
              // Seen only where the browser shows a month as a plain text box.
              placeholder={
                precision === 'year' ? 'e.g. 2024' : precision === 'month' ? 'YYYY-MM' : undefined
              }
              title={precision === 'month' ? 'Year and month, such as 2024-03' : undefined}
              required
              value={values[precision]}
              onChange={(event) =>
                setValues((current) => ({ ...current, [precision]: event.target.value }))
              }
              onBlur={() => {
                if (precision !== 'month') return;
                const month = normaliseHistoricalMonth(values.month);
                if (month !== values.month) setValues((current) => ({ ...current, month }));
              }}
              data-required-message={messages.invalid[precision]}
              data-format-message={messages.invalid[precision]}
              data-range-message={
                tooEarly && afterStage
                  ? historyOrderMessage(field, notBefore.field, stage)
                  : precision === 'year'
                    ? `Enter a year from 1900 to ${today.slice(0, 4)} for ${messages.when}.`
                    : tooEarly
                      ? `Choose a date from 1900 on for ${messages.when}.`
                      : messages.future
              }
              {...aria(`${name}.value`)}
            />
          </label>
        )}
      </div>
      <FieldError name={`${name}.precision`} />
      <FieldError name={`${name}.value`} />
    </fieldset>
  );
}

function readHistoricalDate(data: FormData, name: string): HistoricalDate {
  const precision = text(data, `${name}.precision`) as HistoricalDate['precision'];
  const value = text(data, `${name}.value`);
  return precision === 'unknown'
    ? { precision }
    : { precision, value: precision === 'month' ? normaliseHistoricalMonth(value) : value };
}

/** What opens review for each kind of timing, said once, right under the choice. */
const reviewOpens: Record<DecisionTiming['kind'], string> = {
  date: 'Review opens at this time, or sooner if either of you adds evidence. Both bettors still confirm the result.',
  event:
    'Review opens when either of you adds evidence that the event has happened. Both bettors still confirm the result.',
  evidence:
    'Review opens when either of you adds the evidence. Both bettors still confirm the result.',
};

export function TimingFields({
  timing,
  cutoff,
  name = 'timing',
  dateNote,
}: {
  timing?: DecisionTiming;
  cutoff?: DecisionCutoff;
  name?: string;
  /** Said under the date and time, such as where a prefilled value came from. */
  dateNote?: ReactNode;
}) {
  const [kind, setKind] = useState<DecisionTiming['kind']>(timing?.kind ?? 'date');
  const [hasCutoff, setHasCutoff] = useState(!!cutoff);
  const [hasCheckIn, setHasCheckIn] = useState(!!timing?.checkIn);
  const kindHint = useId();
  const cutoffHint = useId();
  const checkInHint = useId();
  const { aria } = useFieldAria();
  return (
    <section className="workflow-fields">
      <h3>When review opens</h3>
      <div className="field">
        <label>
          What opens review?
          <select
            name={`${name}.kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value as DecisionTiming['kind'])}
            aria-describedby={kindHint}
          >
            <option value="date">A date and time</option>
            <option value="event">An event</option>
            <option value="evidence">Evidence becoming available</option>
          </select>
        </label>
        <p className="hint" id={kindHint}>
          {reviewOpens[kind]}
        </p>
      </div>
      {/* Both branches stay mounted, so switching back keeps what was typed in each. */}
      <div hidden={kind !== 'date'}>
        <DateTimeField
          name={name}
          label="Review opens on"
          value={timing?.kind === 'date' ? timing : undefined}
          disabled={kind !== 'date'}
          note={dateNote}
        />
      </div>
      <div className="field" hidden={kind === 'date'}>
        <label>
          {kind === 'evidence' ? 'Which evidence opens review?' : 'Which event opens review?'}
          <textarea
            name={`${name}.description`}
            defaultValue={timing && timing.kind !== 'date' ? timing.description : ''}
            disabled={kind === 'date'}
            required
            minLength={3}
            maxLength={LIMITS.description.max}
            rows={3}
            placeholder={
              kind === 'evidence'
                ? 'e.g. The official quarterly results are published'
                : 'e.g. The final whistle in the championship game'
            }
            data-required-message={
              kind === 'evidence'
                ? 'Describe the evidence that opens review.'
                : 'Describe the event that opens review.'
            }
            {...aria(`${name}.description`)}
          />
        </label>
        <FieldError name={`${name}.description`} />
      </div>
      <div className="field">
        <label>
          <span className="field-label">
            Expected evidence source <span className="optional">Optional</span>
          </span>
          <input
            name={`${name}.source`}
            defaultValue={timing?.source ?? ''}
            maxLength={LIMITS.source.max}
            placeholder="e.g. Official match report or published results"
            {...aria(`${name}.source`)}
          />
        </label>
        <FieldError name={`${name}.source`} />
      </div>
      <label className="workflow-checkbox">
        <input
          type="checkbox"
          name={`${name}.hasCutoff`}
          checked={hasCutoff}
          onChange={(event) => setHasCutoff(event.target.checked)}
          aria-describedby={hasCutoff ? cutoffHint : undefined}
        />
        <span>Set a separate deadline for the claim to come true</span>
      </label>
      {hasCutoff && (
        <div className="workflow-inset">
          <DateTimeField
            name={`${name}.cutoff`}
            label="The claim must come true by"
            value={cutoff}
          />
          <p className="hint" id={cutoffHint}>
            This deadline is part of the agreed terms. Passing it does not decide a winner.
          </p>
        </div>
      )}
      <label className="workflow-checkbox">
        <input
          type="checkbox"
          name={`${name}.hasCheckIn`}
          checked={hasCheckIn}
          onChange={(event) => setHasCheckIn(event.target.checked)}
          aria-describedby={hasCheckIn ? checkInHint : undefined}
        />
        <span>Add an initial check-in</span>
      </label>
      {hasCheckIn && (
        <div className="workflow-inset">
          <DateTimeField
            name={`${name}.checkIn`}
            label="First check-in"
            value={timing?.checkIn}
            future="changed"
          />
          <p className="hint" id={checkInHint}>
            A check-in reminds you to look for evidence while the app is open. Each bettor can move
            their own check-in later.
          </p>
        </div>
      )}
    </section>
  );
}

export function readTiming(
  data: FormData,
  name = 'timing',
): { timing: DecisionTiming; cutoff?: DecisionCutoff } {
  const kind = text(data, `${name}.kind`) as DecisionTiming['kind'];
  const extra = {
    ...(text(data, `${name}.source`) ? { source: text(data, `${name}.source`) } : {}),
    ...(data.has(`${name}.hasCheckIn`) ? { checkIn: readDateTime(data, `${name}.checkIn`) } : {}),
  };
  return {
    timing:
      kind === 'date'
        ? { kind, ...readDateTime(data, name), ...extra }
        : { kind, description: text(data, `${name}.description`), ...extra },
    ...(data.has(`${name}.hasCutoff`) ? { cutoff: readDateTime(data, `${name}.cutoff`) } : {}),
  };
}

/** What each answer to "where does this bet stand?" puts on the ledger once both bettors confirm. */
const stageRecords: Record<HistoricalInput['stage'], string> = {
  active: 'It is recorded as an ongoing bet, with the review timing you set below.',
  owed: 'The decided outcome is recorded, and the loser owes the winner the rolls.',
  settled: 'The decided outcome and the delivery are recorded, so nothing is owed.',
  voided: 'The bet is recorded as called off, with no winner and no rolls owed.',
};

export function HistoryStageField({
  stage,
  onStageChange,
  other,
  autoFocus = false,
}: {
  stage: HistoricalInput['stage'];
  onStageChange: (stage: HistoricalInput['stage']) => void;
  /** The other bettor's name, once known: they confirm the same history. */
  other?: string;
  autoFocus?: boolean;
}) {
  const hint = useId();
  return (
    <div className="field">
      <label>
        Where does this bet stand?
        <select
          name="history.stage"
          value={stage}
          onChange={(event) => onStageChange(event.target.value as HistoricalInput['stage'])}
          aria-describedby={hint}
          autoFocus={autoFocus}
        >
          {Object.entries(historyStageLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint" id={hint}>
        {stageRecords[stage]} {other ?? 'The other bettor'} confirms the same history before it
        counts.
      </p>
    </div>
  );
}

export function HistoryFields({
  value,
  members,
  creatorId,
  opponentId,
  stage,
  onStageChange,
  showStage = true,
  other,
  onOriginalDate,
}: {
  value?: HistoricalInput;
  members: Member[];
  creatorId: string;
  opponentId: string;
  stage: HistoricalInput['stage'];
  onStageChange: (stage: HistoricalInput['stage']) => void;
  showStage?: boolean;
  /** The other bettor's name, who confirms the same history. */
  other?: string;
  /** Told when the bet was made, as typed, whenever it changes. */
  onOriginalDate?: (date: HistoricalDate) => void;
}) {
  const [previous, setPrevious] = useState(!!value?.previousAdjudication);
  // Where each date begins, so a later stage cannot be dated before an earlier one.
  const [originalStart, setOriginalStart] = useState<string>();
  const [resultStart, setResultStart] = useState<string>();
  const { aria } = useFieldAria();
  const beforeDelivery: { day: string; field: HistoryDateField } | undefined =
    resultStart && (!originalStart || resultStart >= originalStart)
      ? { day: resultStart, field: 'result.date' }
      : originalStart
        ? { day: originalStart, field: 'originalDate' }
        : undefined;
  return (
    <section className="workflow-fields">
      <h3>The original record</h3>
      {showStage && <HistoryStageField stage={stage} onStageChange={onStageChange} other={other} />}
      <HistoricalDateField
        name="history.originalDate"
        label="When was the bet made?"
        value={value?.originalDate}
        field="originalDate"
        stage={stage}
        onStart={setOriginalStart}
        onDate={onOriginalDate}
      />
      <p className="hint">Record only what you remember. Approximate dates stay approximate.</p>
      {/* What belongs to a stage stays in the form, set aside and out of the way, when the stage
          changes, so going to another stage and back never costs what was typed. */}
      <HistoryInset show={stage !== 'active'}>
        <h4>{stage === 'voided' ? 'Why it ended' : 'The decided outcome'}</h4>
        <div className="field" hidden={stage === 'voided'}>
          <label>
            Who won?
            <select
              name="history.winnerId"
              required
              disabled={stage === 'voided'}
              defaultValue={value?.result?.winnerId ?? ''}
              data-required-message="Choose who won."
              {...aria('history.winnerId')}
            >
              <option value="">Choose the winner</option>
              {members
                .filter((member) => [creatorId, opponentId].includes(member.id))
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
            </select>
          </label>
          <FieldError name="history.winnerId" />
        </div>
        <HistoricalDateField
          name="history.resultDate"
          label={stage === 'voided' ? 'When was it called off?' : 'When was the outcome decided?'}
          value={value?.result?.date}
          field="result.date"
          stage={stage}
          notBefore={originalStart ? { day: originalStart, field: 'originalDate' } : undefined}
          onStart={setResultStart}
        />
        <div className="field">
          <label>
            {stage === 'voided' ? 'Reason for no winner' : 'Result and supporting evidence'}
            <textarea
              name="history.resultNote"
              defaultValue={value?.result?.note ?? ''}
              required
              minLength={3}
              maxLength={2000}
              rows={3}
              placeholder={
                stage === 'voided'
                  ? 'e.g. We agreed the event was cancelled and neither person won.'
                  : 'What happened, and how did it meet the original terms?'
              }
              data-required-message={
                stage === 'voided'
                  ? 'Say why the bet ended with no winner.'
                  : 'Say what happened and how it met the original terms.'
              }
              {...aria('history.resultNote')}
            />
          </label>
          <FieldError name="history.resultNote" />
        </div>
      </HistoryInset>
      <HistoryInset show={stage === 'settled'}>
        <h4>The actual delivery</h4>
        <HistoricalDateField
          name="history.deliveryDate"
          label="When were the rolls delivered?"
          value={value?.delivery?.date}
          field="delivery.date"
          stage={stage}
          notBefore={beforeDelivery}
        />
        <div className="field">
          <label>
            Delivery details
            <textarea
              name="history.deliveryNote"
              defaultValue={value?.delivery?.note ?? ''}
              required
              minLength={3}
              maxLength={2000}
              rows={3}
              placeholder="Where and how did the original winner receive all the lobster rolls?"
              data-required-message="Say where and how the rolls were delivered."
              {...aria('history.deliveryNote')}
            />
          </label>
          <FieldError name="history.deliveryNote" />
        </div>
        <p className="hint">
          Only real lobster rolls delivered to the original winner count as settlement.
        </p>
      </HistoryInset>
      <label className="workflow-checkbox" hidden={stage === 'active'}>
        <input
          name="history.previous"
          type="checkbox"
          disabled={stage === 'active'}
          checked={previous}
          onChange={(event) => setPrevious(event.target.checked)}
        />
        <span>Include a previous judge or ChatGPT decision</span>
      </label>
      <HistoryInset show={stage !== 'active' && previous}>
        <div className="field">
          <label>
            Reported decision source
            <select
              name="history.previousMethod"
              defaultValue={value?.previousAdjudication?.method ?? 'judge'}
              {...aria('history.previousMethod')}
            >
              <option value="judge">A judge</option>
              <option value="chatgpt">ChatGPT</option>
            </select>
          </label>
          <FieldError name="history.previousMethod" />
        </div>
        <div className="field">
          <label>
            Previous decision and context
            <textarea
              name="history.previousNote"
              defaultValue={value?.previousAdjudication?.note ?? ''}
              required
              minLength={3}
              maxLength={2000}
              rows={3}
              placeholder="Who or what decided it, what was said, and what evidence remains?"
              data-required-message="Say who or what decided it and what was said."
              {...aria('history.previousNote')}
            />
          </label>
          <FieldError name="history.previousNote" />
        </div>
        <div className="field">
          <label>
            <span className="field-label">
              Evidence link <span className="optional">Optional</span>
            </span>
            <input
              type="url"
              name="history.previousUrl"
              defaultValue={value?.previousAdjudication?.sourceUrl ?? ''}
              maxLength={500}
              placeholder="https://…"
              data-format-message="Enter a full link that starts with https://."
              {...aria('history.previousUrl')}
            />
          </label>
          <FieldError name="history.previousUrl" />
        </div>
        <p className="hint">
          This is history reported by a bettor. It does not stand in for a judge’s approval or an
          agreed ChatGPT prompt.
        </p>
      </HistoryInset>
    </section>
  );
}

/**
 * The fields of a stage a past bet may leave and come back to. With `keep` they stay in the form
 * while `show` is off, set aside (hidden, disabled, so not sent or checked) with what was typed;
 * without it they are simply not there.
 */
export function StageFields({
  show,
  keep = false,
  children,
}: {
  show: boolean;
  keep?: boolean;
  children: ReactNode;
}) {
  return keep ? (
    <fieldset className="workflow-stage-fields" hidden={!show} disabled={!show}>
      {children}
    </fieldset>
  ) : show ? (
    <>{children}</>
  ) : null;
}

/** A part of the history that belongs to some stages: out of sight and out of the form otherwise. */
function HistoryInset({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <fieldset className="workflow-inset" hidden={!show} disabled={!show}>
      {children}
    </fieldset>
  );
}

/**
 * The fields a change to `name` answers: a past bet's dates are checked against each other, so a
 * change to any one of them (its precision or its value) clears the messages on all of them.
 */
export function historyFieldsAnswered(name: string): string[] {
  return /^history\.\w+Date\.(?:precision|value)$/.test(name)
    ? ['originalDate', 'resultDate', 'deliveryDate'].flatMap((date) => [
        `history.${date}.precision`,
        `history.${date}.value`,
      ])
    : [];
}

/** The form control that holds each part of a reported history. */
const historyControls: Record<HistoryField, string[]> = {
  stage: ['history.stage'],
  originalDate: ['history.originalDate.value', 'history.originalDate.precision'],
  'result.winnerId': ['history.winnerId', 'history.stage'],
  'result.date': ['history.resultDate.value', 'history.resultDate.precision'],
  'result.note': ['history.resultNote'],
  'delivery.date': ['history.deliveryDate.value', 'history.deliveryDate.precision'],
  'delivery.note': ['history.deliveryNote'],
  'previousAdjudication.method': ['history.previousMethod'],
  'previousAdjudication.note': ['history.previousNote'],
  'previousAdjudication.sourceUrl': ['history.previousUrl'],
};

/** A refusal from the ledger's history rules, placed on the control it is about. */
export function historyFieldProblem(
  form: HTMLFormElement,
  error: HistoryFieldError,
): FieldProblem | undefined {
  for (const name of historyControls[error.field]) {
    const element = form.elements.namedItem(name);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    )
      return { name, message: error.message, element };
  }
  return undefined;
}

/**
 * What the ledger would refuse in a reported history (a date in the future or before an earlier
 * stage, an unreadable month, a link that is not HTTPS), checked with its own rules before sending.
 * Forms without history fields have nothing to check.
 */
export function historyProblems(
  form: HTMLFormElement,
  participants: string[],
  now = new Date().toISOString(),
): FieldProblem[] {
  if (!form.elements.namedItem('history.stage')) return [];
  try {
    validateHistory(readHistory(new FormData(form)), participants, now);
    return [];
  } catch (reason) {
    const problem =
      reason instanceof HistoryFieldError ? historyFieldProblem(form, reason) : undefined;
    return problem ? [problem] : [];
  }
}

export function readHistory(data: FormData): HistoricalInput {
  const stage = text(data, 'history.stage') as HistoricalInput['stage'];
  return {
    stage,
    originalDate: readHistoricalDate(data, 'history.originalDate'),
    ...(stage !== 'active'
      ? {
          result: {
            winnerId: stage === 'voided' ? null : text(data, 'history.winnerId'),
            date: readHistoricalDate(data, 'history.resultDate'),
            note: text(data, 'history.resultNote'),
          },
        }
      : {}),
    ...(stage === 'settled'
      ? {
          delivery: {
            date: readHistoricalDate(data, 'history.deliveryDate'),
            note: text(data, 'history.deliveryNote'),
          },
        }
      : {}),
    ...(data.has('history.previous')
      ? {
          previousAdjudication: {
            method: text(data, 'history.previousMethod') as 'judge' | 'chatgpt',
            note: text(data, 'history.previousNote'),
            ...(text(data, 'history.previousUrl')
              ? { sourceUrl: text(data, 'history.previousUrl') }
              : {}),
          },
        }
      : {}),
  };
}

/** A tick that a bet which looks like one already on the ledger is really another bet. */
export function DifferentBetField() {
  const { aria } = useFieldAria();
  return (
    <div className="field">
      <label className="workflow-checkbox">
        <input
          type="checkbox"
          name="differentBet"
          required
          data-required-message="Tick this only if it is a different bet. If it is the same one, it already counts: cancel instead."
          {...aria('differentBet')}
        />
        <span>This is a different bet, not the one already on the ledger.</span>
      </label>
      <FieldError name="differentBet" />
    </div>
  );
}

/** What the second bettor's confirmation does, said before they press it. */
const secondConfirmation: Record<HistoricalInput['stage'], string> = {
  active: 'the bet is on the ledger as ongoing.',
  owed: 'the decision is on the record and the owed rolls count on balances.',
  settled: 'the decision and the delivery are on the record and count in win statistics.',
  voided: 'the bet is closed with no winner and no rolls owed.',
};

export function HistoryAcknowledgementFields({
  stage,
  duplicates = [],
  summary,
  turn = 'first',
  other,
}: {
  stage: HistoricalInput['stage'];
  /** Bets already on the ledger that this one looks like; confirming it would count twice. */
  duplicates?: Pick<Bet, 'id' | 'reference' | 'title'>[];
  /** What the history comes to (who won, what is owed), shown above the boxes it asks about. */
  summary?: ReactNode;
  /** Whether this confirmation is the first (sent with the history) or the second (completing it). */
  turn?: 'first' | 'second';
  /** The other bettor's name, who confirms after a first confirmation. */
  other?: string;
}) {
  return (
    <fieldset className="workflow-acknowledgements workflow-fieldset">
      <legend>Your confirmation</legend>
      {summary && <p className="history-summary">{summary}</p>}
      {duplicates.length > 0 && (
        <>
          <p className="form-note duplicate-warning">
            This looks like a bet already on the ledger:{' '}
            {duplicates.map((bet) => `${bet.reference} (${bet.title})`).join(', ')}. Confirming this
            one too would count the same rolls twice.
          </p>
          <DifferentBetField />
        </>
      )}
      <label className="workflow-checkbox">
        <input type="checkbox" name="acknowledgements.terms" required />
        <span>I confirm the original terms, both positions, and the number of rolls at stake.</span>
      </label>
      {/* Worded for the stage, so a tick given for one stage is asked for again in another. The
          terms are the same for every stage, so theirs stays ticked. */}
      {stage !== 'active' && (
        <label className="workflow-checkbox" key={`result-${stage}`}>
          <input type="checkbox" name="acknowledgements.result" required />
          <span>
            {stage === 'voided'
              ? 'I confirm that this bet ended with no winner and no rolls owed.'
              : 'I confirm the reported winner and the result described above.'}
          </span>
        </label>
      )}
      {stage === 'settled' && (
        <label className="workflow-checkbox">
          <input type="checkbox" name="acknowledgements.delivery" required />
          <span>
            I confirm that all the actual lobster rolls were delivered to the original winner.
          </span>
        </label>
      )}
      <p className="hint">
        {turn === 'second'
          ? `You are the second confirmation. Once you confirm, ${secondConfirmation[stage]}`
          : `Sending this records your confirmation. ${other ?? 'The other bettor'} confirms next, and balances and win statistics stay unchanged until both of you have.`}
      </p>
    </fieldset>
  );
}

export function readAcknowledgements(data: FormData): HistoryAcknowledgements {
  return {
    terms: data.has('acknowledgements.terms'),
    result: data.has('acknowledgements.result'),
    delivery: data.has('acknowledgements.delivery'),
  };
}
