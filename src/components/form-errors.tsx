import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { trimText, visibleLength } from '../lib/bet-workflow';
import { shareUrl } from '../lib/ledger';
import { localDateTimeToIso } from './workflow-values';

/**
 * Field-level validation shared by every form. Forms set `noValidate` and check on submit: each
 * problem is shown under its own field (or, for a field that has no slot for it, in the list by the
 * buttons), the field is marked aria-invalid and described by its message, and focus moves to the
 * first one. A message clears as soon as its field changes.
 *
 * Fields say what they need with ordinary attributes (`required`, `minLength`, `min`, `max`,
 * `type`) plus optional data attributes for friendlier copy: `data-required-message`,
 * `data-range-message`, `data-step-message`, `data-format-message`, and `data-check` for a named
 * check below. A date and time with `data-zone-field` is checked in its own timezone;
 * `data-future` ("always" or "changed") also wants it to be a time that has not passed.
 */
export type FieldControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
export interface FieldProblem {
  name: string;
  message: string;
  element: FieldControl;
}

const isControl = (element: unknown): element is FieldControl =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLSelectElement ||
  element instanceof HTMLTextAreaElement;
const characters = (count: number) => `${count} ${count === 1 ? 'character' : 'characters'}`;

// The short names the browser knows that never change with daylight saving, where most people who
// type them live somewhere that does. Someone typing "EST" means Eastern time, an hour different
// for half the year. CET, EST5EDT and the like do follow daylight saving, and HST is right for
// Hawaii, which keeps one offset all year.
const fixedOffsetAbbreviation = /^(?:EST|MST)$/i;

/** What is wrong with a timezone name, or nothing when the browser knows it. */
export function timezoneProblem(value: string): string | undefined {
  const zone = value.trim();
  if (!zone) return 'Choose a timezone, such as America/New_York or UTC.';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    return `“${zone}” is not a timezone we know. Use a name such as America/New_York or UTC.`;
  }
  if (fixedOffsetAbbreviation.test(zone))
    return `“${zone}” stays on one offset all year, so it is an hour off while daylight saving is on. Use a place name such as America/New_York or America/Denver, or UTC.`;
  return undefined;
}

/** The ledger's own rule for a recorded ChatGPT source link, with an example of a good one. */
export function shareLinkProblem(value: string): string | undefined {
  try {
    shareUrl(value);
    return undefined;
  } catch {
    return 'Paste a ChatGPT share link, such as https://chatgpt.com/share/abc123.';
  }
}

const namedChecks: Record<string, (value: string) => string | undefined> = {
  timezone: timezoneProblem,
  'chatgpt-share': shareLinkProblem,
};

function requiredMessage(element: FieldControl): string {
  if (element instanceof HTMLSelectElement) return 'Choose one of the options.';
  if (element.type === 'datetime-local') return 'Choose a date and time.';
  if (['date', 'month'].includes(element.type)) return 'Choose a date.';
  if (element.type === 'number') return 'Enter a number.';
  return 'Fill this in.';
}

/** The message for one control, or nothing when it is fine (or switched off). */
export function controlProblem(element: FieldControl, form: HTMLFormElement): string | undefined {
  if (!element.willValidate) return undefined;
  const { validity, dataset } = element;
  if (element instanceof HTMLInputElement && element.type === 'checkbox')
    return element.required && !element.checked
      ? (dataset.requiredMessage ?? 'Tick this box to confirm it.')
      : undefined;
  if (validity.badInput)
    return (
      dataset.formatMessage ??
      (element.type === 'number' ? 'Enter a number.' : 'Choose a complete, valid date.')
    );
  const trimmed = trimText(element.value);
  if (!visibleLength(trimmed))
    return element.required ? (dataset.requiredMessage ?? requiredMessage(element)) : undefined;
  if (!(element instanceof HTMLSelectElement)) {
    // Limits count trimmed text, as the ledger does, so padding (spaces, or zero-width characters
    // that show nothing) never satisfies a minimum.
    if (element.minLength > 0 && visibleLength(trimmed) < element.minLength)
      return `Use at least ${characters(element.minLength)}.`;
    if (element.maxLength > 0 && trimmed.length > element.maxLength)
      return `Use ${characters(element.maxLength)} or fewer.`;
  }
  // A value between steps (a third decimal on a price) is inside the range, so it says so if it can.
  if (
    validity.stepMismatch &&
    !validity.rangeUnderflow &&
    !validity.rangeOverflow &&
    dataset.stepMessage
  )
    return dataset.stepMessage;
  if (validity.rangeUnderflow || validity.rangeOverflow || validity.stepMismatch)
    return (
      dataset.rangeMessage ??
      `Enter a number from ${element.getAttribute('min')} to ${element.getAttribute('max')}.`
    );
  if (validity.typeMismatch)
    return dataset.formatMessage ?? 'Enter a full link that starts with https://.';
  const check = dataset.check ? namedChecks[dataset.check] : undefined;
  const checked = check?.(element.value);
  if (checked) return checked;
  // A date and time is checked against its own timezone: some times do not exist, or occur twice.
  if (
    element instanceof HTMLInputElement &&
    element.type === 'datetime-local' &&
    dataset.zoneField
  ) {
    const zone = form.elements.namedItem(dataset.zoneField);
    if (zone instanceof HTMLInputElement && !timezoneProblem(zone.value)) {
      try {
        const at = localDateTimeToIso(element.value, zone.value.trim());
        // A check-in is a reminder to look again later. `data-future="changed"` lets a time that
        // opened with the form stay (an agreement being amended keeps the check-in it had).
        const kept =
          dataset.future === 'changed' &&
          element.value === element.defaultValue &&
          zone.value === zone.defaultValue;
        if (dataset.future && !kept && Date.parse(at) <= Date.now())
          return 'Choose a time that hasn’t passed yet.';
      } catch (reason) {
        return reason instanceof Error ? reason.message : 'Choose a valid date and time.';
      }
    }
  }
  return validity.valid ? undefined : element.validationMessage || 'Check this field.';
}

/** Every problem in the form, one per field name, in the order the fields appear. */
export function findProblems(form: HTMLFormElement, extra: FieldProblem[] = []): FieldProblem[] {
  const problems = new Map<string, FieldProblem>();
  for (const element of Array.from(form.elements)) {
    if (!isControl(element) || !element.name || problems.has(element.name)) continue;
    const message = controlProblem(element, form);
    if (message) problems.set(element.name, { name: element.name, message, element });
  }
  for (const problem of extra) if (!problems.has(problem.name)) problems.set(problem.name, problem);
  return [...problems.values()].sort((first, second) =>
    first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1,
  );
}

/** The visible label of a control, without the text of the control itself. */
function labelText(element: FieldControl): string {
  // A date's parts are labelled for screen readers only ("… value"); its group says it better.
  const legend =
    element.type !== 'checkbox'
      ? element.closest('fieldset')?.querySelector(':scope > legend')?.textContent?.trim()
      : undefined;
  if (legend) return legend;
  const label = element.labels?.[0];
  const parts: string[] = [];
  label?.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else if (
      node instanceof HTMLElement &&
      !isControl(node) &&
      !node.matches('datalist, .hint, .optional, .field-error')
    )
      parts.push(node.textContent ?? '');
  });
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 70).trimEnd()}…` : text;
}

interface FieldErrorsContextValue {
  errors: Record<string, string>;
  errorId: (name: string) => string;
  setError: (name: string, message: string) => void;
  place: (name: string) => () => void;
}
const FieldErrorsContext = createContext<FieldErrorsContextValue | null>(null);

/** Error state for one form. Render its `Provider` around the form's fields. */
export function useFieldErrors() {
  const prefix = useId();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  // Names that a <FieldError> renders under the field; anything else is listed by the buttons.
  const placed = useRef(new Set<string>());
  // Controls whose aria attributes this hook set by hand because their component cannot.
  const marked = useRef(new Map<string, { element: FieldControl; describedBy: string | null }>());
  const pendingFocus = useRef<FieldControl | null>(null);
  const errorId = useCallback(
    (name: string) => `${prefix}${name.replace(/[^\w-]/g, '_')}-error`,
    [prefix],
  );
  const unmark = useCallback((name: string) => {
    const entry = marked.current.get(name);
    if (!entry) return;
    entry.element.removeAttribute('aria-invalid');
    if (entry.describedBy === null) entry.element.removeAttribute('aria-describedby');
    else entry.element.setAttribute('aria-describedby', entry.describedBy);
    marked.current.delete(name);
  }, []);
  const clear = useCallback(
    (...names: string[]) => {
      names.forEach(unmark);
      setErrors((current) => {
        if (!names.some((name) => name in current)) return current;
        const next = { ...current };
        names.forEach((name) => delete next[name]);
        return next;
      });
    },
    [unmark],
  );
  const clearAll = useCallback(() => {
    [...marked.current.keys()].forEach(unmark);
    setErrors((current) => (Object.keys(current).length ? {} : current));
  }, [unmark]);
  const setError = useCallback(
    (name: string, message: string) =>
      setErrors((current) =>
        current[name] === message ? current : { ...current, [name]: message },
      ),
    [],
  );
  const place = useCallback((name: string) => {
    placed.current.add(name);
    return () => void placed.current.delete(name);
  }, []);
  /** Shows these problems and focuses the first; returns whether there were any. */
  const show = useCallback(
    (problems: FieldProblem[]) => {
      clearAll();
      if (!problems.length) return false;
      setErrors(Object.fromEntries(problems.map((problem) => [problem.name, problem.message])));
      setLabels(
        Object.fromEntries(
          problems.map((problem) => [
            problem.name,
            problem.element.type === 'checkbox'
              ? `Tick “${labelText(problem.element)}” to confirm it.`
              : `${labelText(problem.element)}: ${problem.message}`,
          ]),
        ),
      );
      for (const problem of problems) {
        if (placed.current.has(problem.name)) continue;
        const { element } = problem;
        marked.current.set(problem.name, {
          element,
          describedBy: element.getAttribute('aria-describedby'),
        });
        element.setAttribute('aria-invalid', 'true');
        element.setAttribute(
          'aria-describedby',
          [element.getAttribute('aria-describedby'), errorId(problem.name)]
            .filter(Boolean)
            .join(' '),
        );
      }
      pendingFocus.current = problems[0].element;
      return true;
    },
    [clearAll, errorId],
  );
  // Focus after the messages are in the DOM, so the field is announced with its error.
  useLayoutEffect(() => {
    const element = pendingFocus.current;
    if (!element) return;
    pendingFocus.current = null;
    if (!element.isConnected) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: 'center' });
  });
  const context = useMemo<FieldErrorsContextValue>(
    () => ({ errors, errorId, setError, place }),
    [errors, errorId, setError, place],
  );
  /** aria-invalid and aria-describedby for a control, with any hint ids it is also described by. */
  const aria = useCallback(
    (name: string, ...hints: (string | undefined | false)[]) => {
      const ids = [...hints, errors[name] ? errorId(name) : undefined].filter(Boolean);
      return {
        'aria-invalid': errors[name] ? (true as const) : undefined,
        'aria-describedby': ids.length ? ids.join(' ') : undefined,
      };
    },
    [errors, errorId],
  );
  const unplaced = Object.keys(errors)
    .filter((name) => !placed.current.has(name))
    .map((name) => ({ name, id: errorId(name), text: labels[name] ?? errors[name] }));
  return { errors, context, aria, show, clear, clearAll, setError, errorId, unplaced };
}
export type FieldErrors = ReturnType<typeof useFieldErrors>;

export function FieldErrorsProvider({
  value,
  children,
}: {
  value: FieldErrors;
  children: ReactNode;
}) {
  return (
    <FieldErrorsContext.Provider value={value.context}>{children}</FieldErrorsContext.Provider>
  );
}

// A click needs the press to start and end on the same button. A message shown as a field is left
// pushes the buttons below it down, so a press on Cancel or the submit would miss; while a pointer
// is down, such a message waits until it is released and any click has run (a submit checks the
// field itself).
let pressing = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (pressing = true), true);
  for (const type of ['pointerup', 'pointercancel'])
    document.addEventListener(type, () => (pressing = false), true);
}
/** Runs `show` now, or once a press under way has ended, while `field` is still on the page. */
export function whenPressEnds(field: Element, show: () => void) {
  if (!pressing) return show();
  const release = () => {
    for (const type of ['pointerup', 'pointercancel'])
      document.removeEventListener(type, release, true);
    setTimeout(() => {
      if (field.isConnected) show();
    });
  };
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, release, true);
}

/** For fields inside a provider: aria attributes and a way to report a problem on blur. */
export function useFieldAria() {
  const context = useContext(FieldErrorsContext);
  return {
    /** Several names when one control answers for more than one message (a name, and its pin). */
    aria: (name: string | string[], ...hints: (string | undefined | false)[]) => {
      const shown = [name].flat().filter((each) => context?.errors[each]);
      const ids = [...hints, ...shown.map((each) => context!.errorId(each))].filter(Boolean);
      return {
        'aria-invalid': shown.length ? (true as const) : undefined,
        'aria-describedby': ids.length ? ids.join(' ') : undefined,
      };
    },
    /** Names a problem found as `field` is left, once any press under way has ended. */
    report: (field: Element, name: string, message: string | undefined) => {
      if (message) whenPressEnds(field, () => context?.setError(name, message));
    },
  };
}

/**
 * The message under a field. Render it right after the field's label. `alert` also announces it as
 * it appears, for a one-field form submitted with Enter, where focus is already on the field and
 * moving it there again says nothing.
 */
export function FieldError({ name, alert = false }: { name: string; alert?: boolean }) {
  const context = useContext(FieldErrorsContext);
  const place = context?.place;
  useLayoutEffect(() => place?.(name), [place, name]);
  const message = context?.errors[name];
  return message ? (
    <p className="field-error" id={context!.errorId(name)} role={alert ? 'alert' : undefined}>
      {message}
    </p>
  ) : null;
}

/** Field problems that have no slot under their field, listed by the buttons. */
export function UnplacedErrors({ fields }: { fields: FieldErrors }) {
  if (!fields.unplaced.length) return null;
  return (
    <ul className="form-error field-error-list">
      {fields.unplaced.map((item) => (
        <li key={item.name} id={item.id}>
          {item.text}
        </li>
      ))}
    </ul>
  );
}
