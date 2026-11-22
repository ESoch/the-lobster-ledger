import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  compareByVisit,
  correctionChangesNothing,
  DuplicatePriceError,
  isLiveReport,
  itemKey,
  localDay,
  parsePriceCents,
  plausibility,
  priceDateLabel,
  priceLabel,
  priceProblem,
  restaurantsNamed,
  sameSeries,
  UnusualPriceError,
  visitDateProblem,
} from '../lib/price-observations';
import type {
  LedgerState,
  PriceCorrectionInput,
  PriceDatePrecision,
  PriceObservation,
  PriceReportInput,
  PriceWarning,
  Restaurant,
} from '../lib/types';
import { Modal, ModalCancel } from './ui';
import {
  FieldError,
  FieldErrorsProvider,
  UnplacedErrors,
  findProblems,
  useFieldErrors,
  type FieldProblem,
} from './form-errors';
import './price-entry.css';

interface PriceEntryProps {
  open: boolean;
  onClose: () => void;
  state: LedgerState;
  /** The member reporting: their own reports are the ones a repeated visit is checked against. */
  memberId?: string;
  /** Saves a new report, with its new restaurant in the same write. */
  onSave: (input: PriceReportInput) => Promise<unknown>;
  /** The member's own report being corrected. */
  observation?: PriceObservation;
  onCorrect?: (id: string, input: PriceCorrectionInput) => Promise<void>;
  /** The restaurant being viewed, chosen when the dialog opens. */
  initialRestaurantId?: string;
  /** Where focus goes on close when the control that opened the dialog has gone. */
  fallbackFocus?: () => HTMLElement | null;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const FUTURE = 'Use a visit date that has already happened.';
const restaurantLabel = (restaurant: Restaurant) =>
  `${restaurant.name}${restaurant.address ? ` · ${restaurant.address}` : ''}`;

/**
 * Records a member-reported menu price, or corrects one of the member's own. Every opening starts
 * fresh: the form inside is keyed to the opening, so an error or a half-made choice from last time
 * never comes back.
 */
export function PriceEntryDialog(props: PriceEntryProps) {
  const { open, onClose, state, observation } = props;
  const [dirty, setDirty] = useState(false);
  const [opening, setOpening] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpening((count) => count + 1);
    else setDirty(false);
  }
  const restaurant = state.restaurants?.find((item) => item.id === observation?.restaurantId);
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={dirty}
      fallbackFocus={props.fallbackFocus}
      title={observation ? 'Correct a lobster roll price.' : 'Record a lobster roll price.'}
      description={
        observation
          ? `You reported ${priceLabel(observation.priceCents)} for ${observation.itemName} at ${restaurant?.name ?? 'this restaurant'} on ${priceDateLabel(observation)}. The correction replaces it in the price history; the original stays on record under Earlier reports.`
          : 'A member-reported menu price. It does not change any wager or balance.'
      }
    >
      <PriceEntryForm key={opening} {...props} onDirtyChange={setDirty} />
    </Modal>
  );
}

function PriceEntryForm({
  onClose,
  state,
  memberId,
  onSave,
  observation,
  onCorrect,
  initialRestaurantId,
  onDirtyChange,
}: PriceEntryProps & { onDirtyChange: (dirty: boolean) => void }) {
  const editing = Boolean(observation);
  const restaurants = state.restaurants ?? [];
  const reports = state.priceObservations ?? [];
  // The member's own clock decides "today": a US evening is not tomorrow yet.
  const [today] = useState(() => localDay());
  const [preselected] = useState(() =>
    !editing && restaurants.some((item) => item.id === initialRestaurantId)
      ? initialRestaurantId
      : undefined,
  );
  // With nothing on the record to choose from, the only way forward is to add the restaurant.
  const [mode, setMode] = useState<'choose' | 'add'>(
    editing || restaurants.length ? 'choose' : 'add',
  );
  const [restaurantId, setRestaurantId] = useState(observation?.restaurantId ?? preselected ?? '');
  const [newName, setNewName] = useState('');
  const [itemName, setItemName] = useState(observation?.itemName ?? 'Classic lobster roll');
  const [precision, setPrecision] = useState<PriceDatePrecision>(
    observation?.visitDatePrecision ?? 'day',
  );
  const [day, setDay] = useState(() => {
    if (!observation) return today;
    const padded = observation.visitDate + { day: '', month: '-01', year: '-01-01' }[precision];
    return padded > today ? today : padded;
  });
  const [month, setMonth] = useState((observation?.visitDate ?? today).slice(5, 7) || '01');
  const [year, setYear] = useState((observation?.visitDate ?? today).slice(0, 4));
  const [busy, setBusy] = useState(false);
  // A refusal from the ledger keeps what was typed, and says so; a local notice is just the notice.
  const [failure, setFailure] = useState<{ message: string; kept: boolean }>();
  const [duplicate, setDuplicate] = useState<{
    existing: PriceObservation;
    input: PriceReportInput;
  }>();
  // A correction moved onto a visit the member already reported at another price.
  const [separate, setSeparate] = useState<{
    existing: PriceObservation;
    input: PriceCorrectionInput;
  }>();
  // A price unusual enough to ask about, with what the member was saving when it was asked: a new
  // report, or a correction of the report named by `correcting` (the one being edited, or the
  // earlier report of the same visit the member chose to correct instead).
  const [unusual, setUnusual] = useState<{
    warnings: PriceWarning[];
    input: PriceReportInput | PriceCorrectionInput;
    correcting?: PriceObservation;
  }>();
  const fields = useFieldErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const duplicateRef = useRef<HTMLDivElement>(null);
  const unusualRef = useRef<HTMLDivElement>(null);
  // Whether the last control to take focus was an answer to one of these questions. Answering
  // removes that button, and with it the focus, so the next question has to be handed it again.
  const focusWasInQuestion = useRef(false);
  /** Hands focus to the first answer of a question that has replaced the one just answered. */
  function focusFirstAnswer(question: HTMLElement | null) {
    if (!question || !focusWasInQuestion.current) return;
    const active = document.activeElement;
    // Focus that is still somewhere in the form, such as a field the member went back to, stays.
    if (active && active !== document.body && formRef.current?.contains(active)) return;
    question.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }
  // A question about a visit already reported, or an unusual price, is brought into view where it
  // appears.
  const duplicateShown = Boolean(duplicate ?? separate);
  useEffect(() => {
    if (!duplicateShown) return;
    focusFirstAnswer(duplicateRef.current);
    duplicateRef.current?.scrollIntoView?.({ block: 'center' });
  }, [duplicateShown]);
  const unusualShown = Boolean(unusual);
  useEffect(() => {
    if (!unusualShown) return;
    focusFirstAnswer(unusualRef.current);
    unusualRef.current?.scrollIntoView?.({ block: 'center' });
  }, [unusualShown]);
  const firstHintId = useId();
  const taxHintId = useId();
  const lastReportId = useId();
  const itemListId = useId();

  const atRestaurant = useMemo(
    () =>
      mode === 'choose' && restaurantId
        ? reports.filter((item) => item.restaurantId === restaurantId).sort(compareByVisit)
        : [],
    [mode, restaurantId, reports],
  );
  // The labels already used here, so a second visit reuses "Classic lobster roll" rather than
  // inventing "classic roll" (one spelling per item, the most recent first).
  const itemLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const item of [...atRestaurant].reverse())
      if (!labels.has(itemKey(item.itemName))) labels.set(itemKey(item.itemName), item.itemName);
    return [...labels.values()];
  }, [atRestaurant]);
  const lastReport = useMemo(() => {
    if (editing) return undefined;
    const live = atRestaurant.filter(isLiveReport);
    return (
      live.filter((item) => itemKey(item.itemName) === itemKey(itemName)).at(-1) ?? live.at(-1)
    );
  }, [editing, atRestaurant, itemName]);
  const reporterName = (id: string) =>
    id === memberId
      ? 'you'
      : (state.members.find((member) => member.id === id)?.name ?? 'a member');
  const matches = mode === 'add' ? restaurantsNamed(restaurants, newName) : [];

  // Closing asks first once anything differs from how the form opened.
  const opened = useRef<Map<string, string>>(undefined);
  const values = () =>
    new Map(
      [...new FormData(formRef.current ?? undefined).entries()].map(
        ([name, value]) => [name, String(value).trim()] as const,
      ),
    );
  function reportDirty() {
    if (!formRef.current || !opened.current) return;
    const start = opened.current;
    onDirtyChange([...values()].some(([name, value]) => value !== (start.get(name) ?? '')));
  }
  useLayoutEffect(() => {
    opened.current ??= values();
    reportDirty();
  });
  // A field to move focus to once the next render is on screen, because the control that had it
  // has gone with the step it belonged to.
  const focusNext = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    (formRef.current?.elements.namedItem(focusNext.current) as HTMLElement | null)?.focus();
    focusNext.current = undefined;
  });

  function switchMode(next: 'choose' | 'add', chosen?: string) {
    setMode(next);
    if (chosen) setRestaurantId(chosen);
    fields.clearAll();
    setFailure(undefined);
    setDuplicate(undefined);
    setUnusual(undefined);
  }

  /** The date problems the browser cannot see: a day, month or year still to come, or before 1900. */
  function dateProblems(form: HTMLFormElement): FieldProblem[] {
    const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
    const problem = (name: string, message: string): FieldProblem[] => {
      const element = control(name);
      return element ? [{ name, message, element }] : [];
    };
    if (precision === 'day') {
      if (!day) return [];
      if (day > today) return problem('visitDay', FUTURE);
      const message = visitDateProblem({ visitDate: day, visitDatePrecision: 'day' });
      return message ? problem('visitDay', message) : [];
    }
    if (!year.trim()) return [];
    if (!/^\d{4}$/.test(year.trim()))
      return problem('visitYear', 'Enter a four-digit year, such as 2026.');
    if (year > today.slice(0, 4)) return problem('visitYear', FUTURE);
    if (precision === 'month' && `${year}-${month}` > today.slice(0, 7))
      return problem('visitMonth', FUTURE);
    const message = visitDateProblem({
      visitDate: precision === 'month' ? `${year}-${month}` : year,
      visitDatePrecision: precision,
    });
    return message ? problem('visitYear', message) : [];
  }

  // A question about a visit already reported stays up while its answer is saved, and after a
  // refusal, so the button that was pressed keeps focus and can be pressed again.
  async function save(input: PriceReportInput) {
    setBusy(true);
    setFailure(undefined);
    setUnusual(undefined);
    try {
      await onSave(input);
      onClose();
    } catch (reason) {
      if (reason instanceof DuplicatePriceError) setDuplicate({ existing: reason.existing, input });
      else if (reason instanceof UnusualPriceError)
        setUnusual({ warnings: reason.warnings, input });
      else
        setFailure({
          message: reason instanceof Error ? reason.message : 'Unable to save this price.',
          kept: true,
        });
    } finally {
      setBusy(false);
    }
  }

  async function correct(target: PriceObservation, input: PriceCorrectionInput) {
    if (!onCorrect) return;
    setBusy(true);
    setFailure(undefined);
    setUnusual(undefined);
    try {
      await onCorrect(target.id, input);
      onClose();
    } catch (reason) {
      if (reason instanceof UnusualPriceError) {
        // The question about the visit has been answered by choosing to correct; the price
        // question is now the only one, and its answer saves this correction.
        setDuplicate(undefined);
        setUnusual({ warnings: reason.warnings, input, correcting: target });
      }
      // The same price on the same visit would count one roll twice; another price may be a
      // separate purchase, which the member can confirm. (Correcting the earlier report a new one
      // matched is not this question: its refusal is said as it comes.)
      else if (reason instanceof DuplicatePriceError && observation) {
        if (reason.existing.priceCents !== input.priceCents)
          setSeparate({ existing: reason.existing, input });
        else
          setFailure({
            message: `You already reported ${priceLabel(reason.existing.priceCents)} for that visit, so this correction would count it twice. Withdraw this report instead.`,
            kept: false,
          });
      } else
        setFailure({
          message: reason instanceof Error ? reason.message : 'Unable to correct this price.',
          kept: true,
        });
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFailure(undefined);
    setDuplicate(undefined);
    setSeparate(undefined);
    setUnusual(undefined);
    const form = event.currentTarget;
    const price = form.elements.namedItem('price') as HTMLInputElement;
    const typedPrice = price.value.trim() ? priceProblem(price.value) : undefined;
    const extra = [
      ...(typedPrice ? [{ name: 'price', message: typedPrice, element: price }] : []),
      ...dateProblems(form),
    ];
    // Each problem is named under its own field, and focus goes to the first.
    if (fields.show(findProblems(form, extra))) return;
    const data = new FormData(form);
    const input: PriceCorrectionInput = {
      restaurantId,
      itemName: itemName.trim(),
      priceCents: parsePriceCents(price.value)!,
      visitDate: precision === 'day' ? day : precision === 'month' ? `${year}-${month}` : year,
      visitDatePrecision: precision,
      note: String(data.get('note') ?? '').trim() || undefined,
    };
    // An unusual price is asked about here first, as the ledger would, against the last live
    // report of the same roll at the restaurant (the one being corrected aside).
    const warnings =
      observation && input.priceCents === observation.priceCents
        ? []
        : plausibility(
            input.priceCents,
            mode === 'choose'
              ? sameSeries(reports, restaurantId, input.itemName).filter(
                  (item) => item.id !== observation?.id,
                )
              : [],
          );
    if (observation) {
      if (correctionChangesNothing(observation, input))
        return setFailure({
          message: 'Change the restaurant, price, item, date or note to correct this report.',
          kept: false,
        });
      const correction = {
        ...input,
        correctionReason: String(data.get('correctionReason') ?? '').trim() || undefined,
      };
      if (warnings.length)
        return setUnusual({ warnings, input: correction, correcting: observation });
      return correct(observation, correction);
    }
    const { restaurantId: _, ...named } = input;
    const report: PriceReportInput =
      mode === 'choose'
        ? input
        : {
            ...named,
            restaurant: {
              name: String(data.get('restaurantName') ?? '').trim(),
              address: String(data.get('restaurantAddress') ?? '').trim(),
            },
          };
    if (warnings.length) return setUnusual({ warnings, input: report });
    return save(report);
  }

  /** Sends what was being saved when the unusual price was asked about, changed as given. */
  function resend(change: { priceCents: number } | { confirmUnusualPrice: true }) {
    if (busy || !unusual) return;
    if ('priceCents' in change) {
      const price = formRef.current?.elements.namedItem('price') as HTMLInputElement | null;
      if (price) price.value = (change.priceCents / 100).toFixed(2);
    }
    const input = { ...unusual.input, ...change };
    if (unusual.correcting) return void correct(unusual.correcting, input as PriceCorrectionInput);
    return void save(input as PriceReportInput);
  }
  // The price a correction already has is never a one-tap fix: the ledger refuses a correction
  // that changes nothing. The warning still stands, and the member can keep the price entered.
  const suggestion = unusual?.warnings.find(
    (warning) =>
      warning.suggestedCents && warning.suggestedCents !== unusual.correcting?.priceCents,
  )?.suggestedCents;
  // When the price the question means is the one the report already has, its answer is to keep
  // the report as it is.
  const keepReport =
    suggestion === undefined &&
    unusual?.correcting &&
    unusual.warnings.some((warning) => warning.suggestedCents === unusual.correcting?.priceCents)
      ? unusual.correcting
      : undefined;

  return (
    <form
      ref={formRef}
      className="bet-form price-entry-form"
      onSubmit={submit}
      onFocus={(event) => {
        focusWasInQuestion.current = !!(event.target as Element).closest('.price-entry-notice');
      }}
      onChange={(event) => {
        setFailure(undefined);
        setDuplicate(undefined);
        setUnusual(undefined);
        fields.clear((event.target as unknown as HTMLInputElement).name);
        reportDirty();
      }}
      noValidate
    >
      <FieldErrorsProvider value={fields}>
        {!editing && restaurants.length > 0 && (
          <div className="form-toggle-row" role="group" aria-label="Restaurant">
            <button
              type="button"
              className={`segmented-button ${mode === 'choose' ? 'selected' : ''}`}
              aria-pressed={mode === 'choose'}
              onClick={() => switchMode('choose')}
            >
              Choose a restaurant
            </button>
            <button
              type="button"
              className={`segmented-button ${mode === 'add' ? 'selected' : ''}`}
              aria-pressed={mode === 'add'}
              onClick={() => switchMode('add')}
            >
              Add a restaurant
            </button>
          </div>
        )}
        {mode === 'add' ? (
          <>
            <div className="form-grid">
              <div className="field">
                <label>
                  Restaurant name
                  <input
                    name="restaurantName"
                    placeholder="Name on the sign"
                    required
                    maxLength={160}
                    autoComplete="off"
                    autoFocus={!restaurants.length}
                    data-required-message="Name the restaurant."
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    {...fields.aria('restaurantName', !restaurants.length && firstHintId)}
                  />
                </label>
                {!restaurants.length && (
                  <p className="hint" id={firstHintId}>
                    No restaurants are on the record yet. Add the one you visited.
                  </p>
                )}
                <FieldError name="restaurantName" />
              </div>
              <div className="field">
                <label>
                  <span className="field-label">
                    Neighborhood or address <span className="optional">Optional</span>
                  </span>
                  <input
                    name="restaurantAddress"
                    placeholder="Seaport, Boston"
                    maxLength={240}
                    {...fields.aria('restaurantAddress')}
                  />
                </label>
                <FieldError name="restaurantAddress" />
              </div>
            </div>
            {/* Spoken as it appears, so a member typing a name hears that it is already listed. */}
            <div className="price-entry-match" aria-live="polite">
              {matches.map((match) => (
                <p key={match.id}>
                  <span>{restaurantLabel(match)} is already on the record.</span>
                  <button
                    type="button"
                    className="button button-secondary"
                    aria-label={`Use ${restaurantLabel(match)}`}
                    onClick={() => {
                      // The name field and this prompt give way to the chosen restaurant; the
                      // price for it is the next step.
                      focusNext.current = 'price';
                      switchMode('choose', match.id);
                    }}
                  >
                    Use {match.name}
                  </button>
                </p>
              ))}
            </div>
          </>
        ) : (
          <div className="field">
            <label>
              Restaurant
              <select
                name="restaurantId"
                value={restaurantId}
                onChange={(event) => setRestaurantId(event.target.value)}
                required
                data-required-message="Choose a restaurant, or add a new one."
                {...fields.aria('restaurantId')}
              >
                <option value="">Choose a restaurant</option>
                {restaurants.map((restaurant) => (
                  <option key={restaurant.id} value={restaurant.id}>
                    {restaurantLabel(restaurant)}
                  </option>
                ))}
              </select>
            </label>
            <FieldError name="restaurantId" />
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label>
              Menu price for one roll
              <span className="input-affix">
                <span aria-hidden="true">$</span>
                {/* Text, not a number field: a scroll over a focused number field changes it. */}
                <input
                  name="price"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus={Boolean(preselected)}
                  defaultValue={observation ? (observation.priceCents / 100).toFixed(2) : undefined}
                  placeholder="e.g. 28.00"
                  required
                  data-required-message="Enter the menu price for one roll."
                  {...fields.aria('price', taxHintId, lastReport && lastReportId)}
                />
              </span>
            </label>
            <p className="hint" id={taxHintId}>
              Before tax and tip.
            </p>
            {lastReport && (
              <p className="hint" id={lastReportId}>
                Last reported {priceLabel(lastReport.priceCents)}
                {itemKey(lastReport.itemName) !== itemKey(itemName)
                  ? ` for ${lastReport.itemName}`
                  : ''}{' '}
                on {priceDateLabel(lastReport)} by {reporterName(lastReport.reporterId)}.
              </p>
            )}
            <FieldError name="price" />
          </div>
          <div className="field">
            <label>
              Roll or item
              <input
                name="itemName"
                value={itemName}
                onChange={(event) => setItemName(event.target.value)}
                list={itemLabels.length ? itemListId : undefined}
                maxLength={160}
                required
                data-required-message="Say which roll this price is for."
                {...fields.aria('itemName')}
              />
            </label>
            {itemLabels.length > 0 && (
              <datalist id={itemListId}>
                {itemLabels.map((label) => (
                  <option key={label} value={label} />
                ))}
              </datalist>
            )}
            <FieldError name="itemName" />
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>
              How exact is the date?
              <select
                name="visitDatePrecision"
                value={precision}
                onChange={(event) => {
                  setPrecision(event.target.value as PriceDatePrecision);
                  fields.clear('visitDay', 'visitMonth', 'visitYear');
                }}
              >
                <option value="day">Exact day</option>
                <option value="month">Month only</option>
                <option value="year">Year only</option>
              </select>
            </label>
          </div>
          {precision === 'day' && (
            <div className="field">
              <label>
                Visit date
                <input
                  name="visitDay"
                  type="date"
                  value={day}
                  max={today}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDay(value);
                    if (value.length === 10) {
                      setYear(value.slice(0, 4));
                      setMonth(value.slice(5, 7));
                    }
                  }}
                  required
                  data-required-message="Choose the day you visited."
                  data-range-message={FUTURE}
                  {...fields.aria('visitDay')}
                />
              </label>
              <FieldError name="visitDay" />
            </div>
          )}
          {precision === 'month' && (
            <div className="field">
              <div className="price-entry-month">
                <label>
                  Visit month
                  <select
                    name="visitMonth"
                    value={month}
                    onChange={(event) => setMonth(event.target.value)}
                    {...fields.aria('visitMonth')}
                  >
                    {MONTH_NAMES.map((name, index) => (
                      <option key={name} value={String(index + 1).padStart(2, '0')}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Year
                  <input
                    name="visitYear"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    value={year}
                    onChange={(event) => setYear(event.target.value)}
                    required
                    data-required-message="Enter the year you visited."
                    {...fields.aria('visitYear')}
                  />
                </label>
              </div>
              <FieldError name="visitMonth" />
              <FieldError name="visitYear" />
            </div>
          )}
          {precision === 'year' && (
            <div className="field">
              <label>
                Visit year
                <input
                  name="visitYear"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={year}
                  onChange={(event) => setYear(event.target.value)}
                  required
                  data-required-message="Enter the year you visited."
                  {...fields.aria('visitYear')}
                />
              </label>
              <FieldError name="visitYear" />
            </div>
          )}
        </div>
        <div className="field">
          <label>
            <span className="field-label">
              Note <span className="optional">Optional</span>
            </span>
            <textarea
              name="note"
              rows={2}
              maxLength={500}
              defaultValue={observation?.note}
              placeholder="Anything worth remembering about this visit"
              {...fields.aria('note')}
            />
          </label>
          <FieldError name="note" />
        </div>
        {editing && (
          <div className="field">
            <label>
              <span className="field-label">
                Reason for the correction <span className="optional">Optional</span>
              </span>
              <textarea
                name="correctionReason"
                rows={2}
                maxLength={500}
                placeholder="Such as: misread the menu"
                {...fields.aria('correctionReason')}
              />
            </label>
            <FieldError name="correctionReason" />
          </div>
        )}
        {unusual && (
          <div className="price-entry-notice price-entry-unusual" role="alert" ref={unusualRef}>
            {unusual.warnings.map((warning) => (
              <p key={warning.code}>{warning.message}</p>
            ))}
            <div>
              {suggestion !== undefined && (
                <button
                  type="button"
                  className="button button-primary"
                  aria-disabled={busy || undefined}
                  onClick={() => resend({ priceCents: suggestion })}
                >
                  Use {priceLabel(suggestion)}
                </button>
              )}
              {keepReport && (
                <button
                  type="button"
                  className="button button-primary"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) onClose();
                  }}
                >
                  Keep my {priceLabel(keepReport.priceCents)} report
                </button>
              )}
              <button
                type="button"
                className="button button-secondary"
                aria-disabled={busy || undefined}
                onClick={() => resend({ confirmUnusualPrice: true })}
              >
                Save {priceLabel(unusual.input.priceCents)} anyway
              </button>
            </div>
          </div>
        )}
        {/* The question sits just above the buttons rather than in the pinned footer, which on a
            phone would grow over the fields it asks about. */}
        {duplicate && (
          <div className="price-entry-notice price-entry-duplicate" role="alert" ref={duplicateRef}>
            <p>
              You already reported {priceLabel(duplicate.existing.priceCents)} here{' '}
              {
                { day: 'that day', month: 'that month', year: 'that year' }[
                  duplicate.existing.visitDatePrecision
                ]
              }
              . Correct it instead?
            </p>
            <div>
              {onCorrect && (
                <button
                  type="button"
                  className="button button-primary"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (busy) return;
                    const { restaurant: _, confirmSeparateReport: __, ...fields } = duplicate.input;
                    void correct(duplicate.existing, {
                      ...fields,
                      restaurantId: duplicate.existing.restaurantId,
                    });
                  }}
                >
                  Correct my {priceLabel(duplicate.existing.priceCents)} report
                </button>
              )}
              <button
                type="button"
                className="button button-secondary"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void save({ ...duplicate.input, confirmSeparateReport: true });
                }}
              >
                Save as a separate report
              </button>
            </div>
          </div>
        )}
        {separate && observation && (
          <div className="price-entry-notice price-entry-duplicate" role="alert" ref={duplicateRef}>
            <p>
              You already reported {priceLabel(separate.existing.priceCents)} here{' '}
              {
                { day: 'that day', month: 'that month', year: 'that year' }[
                  separate.existing.visitDatePrecision
                ]
              }
              . Was this a separate purchase?
            </p>
            <div>
              <button
                type="button"
                className="button button-secondary"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy)
                    void correct(observation, {
                      ...separate.input,
                      confirmSeparateReport: true,
                    });
                }}
              >
                Save as a separate purchase
              </button>
            </div>
          </div>
        )}
        <div className="modal-footer">
          {failure && (
            <p className="form-error" role="alert">
              {failure.message}
              {failure.kept && ' Your entry is still here.'}
            </p>
          )}
          <UnplacedErrors fields={fields} />
          <ModalCancel disabled={busy} />
          {/* Never disabled: a missing field is named under the field when this is pressed. */}
          <button
            className="button button-primary"
            type="submit"
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            {busy ? 'Saving…' : editing ? 'Save correction' : 'Save price'}
          </button>
        </div>
      </FieldErrorsProvider>
    </form>
  );
}

interface PriceWithdrawProps {
  /** The member's own live report being withdrawn; the dialog is open while there is one. */
  observation?: PriceObservation;
  restaurantName: string;
  onClose: () => void;
  onWithdraw: (id: string, reason: string) => Promise<void>;
  /** Where focus goes on close when the Withdraw button that opened the dialog has gone. */
  fallbackFocus?: () => HTMLElement | null;
}

/**
 * Withdraws one of the member's own price reports, with a reason. The report stays on record under
 * Earlier reports and leaves every price figure; nothing undoes it, so the button is the danger one.
 */
export function PriceWithdrawDialog({
  observation,
  restaurantName,
  onClose,
  onWithdraw,
  fallbackFocus,
}: PriceWithdrawProps) {
  const [dirty, setDirty] = useState(false);
  return (
    <Modal
      open={Boolean(observation)}
      onClose={() => {
        setDirty(false);
        onClose();
      }}
      dirty={dirty}
      fallbackFocus={fallbackFocus}
      title="Withdraw this price report?"
      description={
        observation
          ? `Your ${priceLabel(observation.priceCents)} report for ${observation.itemName} at ${restaurantName} on ${priceDateLabel(observation)} leaves the price history and every price figure. It stays on record under Earlier reports with your reason, and cannot be undone.`
          : undefined
      }
    >
      {observation && (
        <PriceWithdrawForm
          key={observation.id}
          observation={observation}
          onWithdraw={onWithdraw}
          onDone={() => {
            setDirty(false);
            onClose();
          }}
          onDirtyChange={setDirty}
        />
      )}
    </Modal>
  );
}

function PriceWithdrawForm({
  observation,
  onWithdraw,
  onDone,
  onDirtyChange,
}: {
  observation: PriceObservation;
  onWithdraw: (id: string, reason: string) => Promise<void>;
  onDone: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const fields = useFieldErrors();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFailure('');
    const form = event.currentTarget;
    if (fields.show(findProblems(form))) return;
    const reason = String(new FormData(form).get('reason') ?? '').trim();
    setBusy(true);
    try {
      await onWithdraw(observation.id, reason);
      onDone();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Unable to withdraw this report.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="bet-form price-withdraw-form"
      onSubmit={submit}
      onChange={(event) => {
        setFailure('');
        fields.clear((event.target as unknown as HTMLTextAreaElement).name);
        onDirtyChange(Boolean((event.target as unknown as HTMLTextAreaElement).value.trim()));
      }}
      noValidate
    >
      <FieldErrorsProvider value={fields}>
        <div className="field">
          <label>
            Why are you withdrawing it?
            <textarea
              name="reason"
              rows={3}
              maxLength={500}
              required
              autoFocus
              placeholder="Such as: logged at the wrong restaurant"
              data-required-message="Say why you are withdrawing this report."
              {...fields.aria('reason')}
            />
          </label>
          <FieldError name="reason" />
        </div>
        <div className="modal-footer">
          {failure && (
            <p className="form-error" role="alert">
              {failure}
            </p>
          )}
          <UnplacedErrors fields={fields} />
          <ModalCancel disabled={busy} />
          <button
            className="button button-danger"
            type="submit"
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            {busy ? 'Withdrawing…' : 'Withdraw report'}
          </button>
        </div>
      </FieldErrorsProvider>
    </form>
  );
}
