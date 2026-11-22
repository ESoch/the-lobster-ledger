// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { DuplicatePriceError, parsePriceCents, UnusualPriceError } from '../lib/price-observations';
import type { LedgerState, PriceObservation } from '../lib/types';
import { PriceEntryDialog } from './PriceEntryDialog';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const state = createDemoState();
const harbor = state.restaurants!.find((restaurant) => restaurant.id === 'harbor-shack')!;
const dialog = () => document.querySelector('[role="dialog"]')!;
const form = () => dialog().querySelector('form')!;
const field = <T = HTMLInputElement>(name: string) =>
  form().querySelector(`[name="${name}"]`) as unknown as T;
const submitButton = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!;
const describedBy = (control: { getAttribute(name: string): string | null }) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => !!element);
const errorFor = (control: { getAttribute(name: string): string | null }) =>
  describedBy(control).find((element) => element.classList.contains('field-error'));
type Props = Parameters<typeof PriceEntryDialog>[0];
let props: Props;
async function open(overrides: Partial<Props> = {}) {
  props = {
    open: true,
    onClose: vi.fn(),
    state,
    memberId: 'ellis',
    onSave: vi.fn(async () => {}),
    onCorrect: vi.fn(async () => {}),
    ...overrides,
  };
  await act(async () => root.render(createElement(PriceEntryDialog, props)));
  return props;
}
const rerender = (overrides: Partial<Props>) =>
  act(async () => root.render(createElement(PriceEntryDialog, { ...props, ...overrides })));
async function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const submit = () => act(async () => form().requestSubmit(submitButton()));
const buttonNamed = (name: string) =>
  [...dialog().querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  )!;
const click = (button: HTMLElement) => act(async () => button.click());
const savedInput = (onSave: unknown) =>
  (onSave as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Record<string, unknown>;
/** The name a screen reader builds: the label without anything hidden from it. */
const nameOf = (control: { labels: NodeListOf<HTMLLabelElement> | null }) => {
  const label = control.labels![0].cloneNode(true) as HTMLElement;
  label
    .querySelectorAll('[aria-hidden="true"], input, select, textarea, .optional')
    .forEach((node) => node.remove());
  return label.textContent?.trim();
};

describe('recording a price', () => {
  it('names each missing field under it instead of in a banner, and leaves Save available', async () => {
    const { onSave } = await open();
    expect(form().noValidate).toBe(true);
    submitButton().focus();
    await submit();
    expect(onSave).not.toHaveBeenCalled();
    const restaurant = field<HTMLSelectElement>('restaurantId');
    const price = field('price');
    expect(restaurant.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(restaurant)?.textContent).toBe('Choose a restaurant, or add a new one.');
    expect(errorFor(price)?.textContent).toBe('Enter the menu price for one roll.');
    // Each message sits with its field, inside the form, and focus goes to the first.
    expect(form().contains(errorFor(price)!)).toBe(true);
    expect(document.activeElement).toBe(restaurant);
    expect(form().querySelector('.modal-footer .form-error')).toBeNull();
    expect(submitButton().disabled).toBe(false);
    // A change answers only its own message.
    await choose(restaurant, harbor.id);
    expect(restaurant.hasAttribute('aria-invalid')).toBe(false);
    expect(errorFor(restaurant)).toBeUndefined();
    expect(price.getAttribute('aria-invalid')).toBe('true');
  });

  it('asks for the menu price before tax and tip, on the price field itself', async () => {
    await open();
    const price = field('price');
    expect(nameOf(price)).toBe('Menu price for one roll');
    expect(nameOf(field('restaurantId'))).toBe('Restaurant');
    expect(describedBy(price).map((hint) => hint.textContent)).toContain('Before tax and tip.');
    // The note is only a note now.
    expect(form().textContent).not.toMatch(/optional · before tax/i);
  });

  it('shows an example in the empty price field that cannot be read as a value already typed', async () => {
    await open({ initialRestaurantId: harbor.id });
    const example = field('price').getAttribute('placeholder') ?? '';
    // A bare "28.00" in placeholder grey looks filled in, and is the same number as the last report.
    expect(example).toMatch(/^e\.g\. /);
    expect(parsePriceCents(example)).toBeUndefined();
    expect(field('price').value).toBe('');
  });

  it('takes the price as typed text, so scrolling over the field never changes it', async () => {
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    const price = field('price');
    expect(price.type).toBe('text');
    expect(price.inputMode).toBe('decimal');
    await type(price, '28.00');
    price.focus();
    await act(async () => {
      price.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    });
    expect(price.value).toBe('28.00');
    await submit();
    expect(savedInput(onSave)).toMatchObject({ restaurantId: harbor.id, priceCents: 2800 });
    await open({ initialRestaurantId: harbor.id });
    await type(field('price'), '$28.5');
    await submit();
    expect(savedInput(props.onSave)).toMatchObject({ priceCents: 2850 });
  });

  it('says what a price should be, in dollars and cents', async () => {
    await open();
    const price = field('price');
    for (const [typed, message] of [
      ['0', 'Use a price from $0.01 to $1,000.00.'],
      ['1500', 'Use a price from $0.01 to $1,000.00.'],
      // Inside the range but between cents: the range is not what is wrong.
      ['28.005', 'Use dollars and cents, such as 28.50.'],
      ['twenty', 'Use dollars and cents, such as 28.50.'],
    ]) {
      await type(price, typed);
      await submit();
      expect(errorFor(price)?.textContent, typed).toBe(message);
    }
  });

  it('saves a valid price', async () => {
    const { onSave } = await open();
    await choose(field<HTMLSelectElement>('restaurantId'), harbor.id);
    await type(field('price'), '28.50');
    await submit();
    expect(onSave).toHaveBeenCalledOnce();
    expect(savedInput(onSave)).toMatchObject({
      restaurantId: harbor.id,
      priceCents: 2850,
      itemName: 'Classic lobster roll',
      visitDatePrecision: 'day',
    });
  });

  it('names a new restaurant inside the same report', async () => {
    const { onSave } = await open();
    await click(buttonNamed('Add a restaurant'));
    const name = field('restaurantName');
    // The example is not a restaurant already on the record.
    expect(state.restaurants!.some((item) => item.name === name.placeholder)).toBe(false);
    await type(name, 'Pearl Street Clam Bar');
    await type(field('restaurantAddress'), 'Fort Point');
    await type(field('price'), '31');
    await submit();
    const input = savedInput(onSave);
    expect(input).toMatchObject({
      restaurant: { name: 'Pearl Street Clam Bar', address: 'Fort Point' },
      priceCents: 3100,
    });
    expect(input.restaurantId).toBeUndefined();
  });

  it('asks for a restaurant name, counted without its spaces, when adding one', async () => {
    await open();
    await click(buttonNamed('Add a restaurant'));
    const name = field('restaurantName');
    await type(name, '   ');
    await submit();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(name)?.textContent).toBe('Name the restaurant.');
    expect(document.activeElement).toBe(name);
    await type(name, 'Pearl Street Clam Bar');
    expect(name.hasAttribute('aria-invalid')).toBe(false);
  });

  it('drops the messages of fields that are no longer on screen when the choice switches', async () => {
    await open();
    await submit();
    expect(form().querySelector('.field-error')).not.toBeNull();
    await click(buttonNamed('Add a restaurant'));
    expect(form().querySelector('.field-error')).toBeNull();
  });

  it('shows a refused save by the buttons, says the entry is kept, and holds Save while it is written', async () => {
    let fail: (reason: Error) => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '28');
    submitButton().focus();
    await act(async () => form().requestSubmit(submitButton()));
    expect(submitButton().getAttribute('aria-busy')).toBe('true');
    expect(submitButton().getAttribute('aria-disabled')).toBe('true');
    expect(submitButton().disabled).toBe(false);
    expect(document.activeElement).toBe(submitButton());
    // A second press while it is written sends nothing more.
    await act(async () => form().requestSubmit(submitButton()));
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error('That restaurant is no longer listed.')));
    const message = form().querySelector('.modal-footer .form-error');
    expect(message?.textContent).toBe(
      'That restaurant is no longer listed. Your entry is still here.',
    );
    expect(field('price').value).toBe('28');
    expect(document.activeElement).toBe(submitButton());
    expect(submitButton().hasAttribute('aria-busy')).toBe(false);
  });
});

describe('the restaurant choice', () => {
  it('is a labelled group of two pressed-state buttons', async () => {
    await open();
    const group = dialog().querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Restaurant');
    const pressed = () =>
      [...group.querySelectorAll('button')].map((button) => [
        button.textContent,
        button.getAttribute('aria-pressed'),
      ]);
    expect(pressed()).toEqual([
      ['Choose a restaurant', 'true'],
      ['Add a restaurant', 'false'],
    ]);
    await click(buttonNamed('Add a restaurant'));
    expect(pressed()).toEqual([
      ['Choose a restaurant', 'false'],
      ['Add a restaurant', 'true'],
    ]);
  });

  it('starts on the restaurant being viewed, with focus on the price and its last report', async () => {
    await open({ initialRestaurantId: harbor.id });
    expect(field<HTMLSelectElement>('restaurantId').value).toBe(harbor.id);
    const price = field('price');
    expect(document.activeElement).toBe(price);
    // A hint, never a prefilled value: a blind Save must not repeat an old price.
    expect(price.value).toBe('');
    expect(describedBy(price).map((hint) => hint.textContent)).toContain(
      'Last reported $28.00 on Sep 11, 2026 by Alex.',
    );
  });

  it('offers the item names already used at the chosen restaurant', async () => {
    await open({ initialRestaurantId: harbor.id });
    const item = field('itemName');
    const list = document.getElementById(item.getAttribute('list') ?? '');
    const labels = [...(list?.querySelectorAll('option') ?? [])].map((option) => option.value);
    expect(labels).toContain('Classic lobster roll');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('opens on adding the first restaurant when there are none yet', async () => {
    const blank: LedgerState = { ...state, restaurants: [], priceObservations: [] };
    await open({ state: blank });
    expect(dialog().querySelector('[role="group"]')).toBeNull();
    expect(field<HTMLSelectElement>('restaurantId')).toBeNull();
    const name = field('restaurantName');
    expect(describedBy(name).map((hint) => hint.textContent)).toContain(
      'No restaurants are on the record yet. Add the one you visited.',
    );
    // The name is the only way forward, so it is where the dialog starts.
    expect(document.activeElement).toBe(name);
  });

  it('points to a restaurant already on the record before adding it again', async () => {
    await open();
    await click(buttonNamed('Add a restaurant'));
    await type(field('restaurantName'), ' harbor  SHACK');
    const match = dialog().querySelector('.price-entry-match')!;
    expect(match.textContent).toContain(
      'Harbor Shack · Seaport, Boston, MA is already on the record.',
    );
    await click(buttonNamed('Use Harbor Shack'));
    expect(field('restaurantName')).toBeNull();
    expect(field<HTMLSelectElement>('restaurantId').value).toBe(harbor.id);
    expect(buttonNamed('Choose a restaurant').getAttribute('aria-pressed')).toBe('true');
  });

  it('moves focus on to the price once the listed restaurant is chosen', async () => {
    await open();
    await click(buttonNamed('Add a restaurant'));
    await type(field('restaurantName'), 'HARBOR SHACK');
    const use = buttonNamed('Use Harbor Shack');
    use.focus();
    await click(use);
    // The pressed button is gone with the name field; the next step is the price at Harbor Shack.
    expect(use.isConnected).toBe(false);
    expect(document.activeElement).toBe(field('price'));
  });

  it('opens fresh each time: no old error, no old choice', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Network request failed.'));
    await open({ onSave });
    await click(buttonNamed('Add a restaurant'));
    await type(field('restaurantName'), 'Pearl Street Clam Bar');
    await type(field('price'), '29.50');
    await submit();
    expect(form().querySelector('.modal-footer .form-error')).not.toBeNull();
    await rerender({ open: false });
    await rerender({ open: true });
    expect(form().querySelector('.form-error')).toBeNull();
    expect(buttonNamed('Choose a restaurant').getAttribute('aria-pressed')).toBe('true');
    expect(field<HTMLSelectElement>('restaurantId').value).toBe('');
    expect(field('price').value).toBe('');
  });
});

describe('the visit date', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it('defaults to the local day, even late on a US evening, and refuses a day still to come', async () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    // 9:30pm on Oct 18 in New York is already Oct 19 in UTC.
    vi.setSystemTime(new Date('2026-10-19T01:30:00Z'));
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    const day = field('visitDay');
    expect(day.value).toBe('2026-10-18');
    expect(day.max).toBe('2026-10-18');
    await type(field('price'), '28');
    await type(day, '2026-10-19');
    await submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(day)?.textContent).toBe('Use a visit date that has already happened.');
    await type(day, '2026-10-18');
    await submit();
    expect(savedInput(onSave)).toMatchObject({
      visitDate: '2026-10-18',
      visitDatePrecision: 'day',
    });
  });

  it('asks for the precision first and then only for what is remembered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 18, 12));
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    const precision = field<HTMLSelectElement>('visitDatePrecision');
    // The precision comes before the date it shapes.
    expect(
      precision.compareDocumentPosition(field('visitDay')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await choose(precision, 'month');
    expect(field('visitDay')).toBeNull();
    const month = field<HTMLSelectElement>('visitMonth');
    expect([month.value, field('visitYear').value]).toEqual(['10', '2026']);
    await type(field('price'), '31');
    await choose(month, '08');
    await submit();
    expect(savedInput(onSave)).toMatchObject({ visitDate: '2026-08', visitDatePrecision: 'month' });
    await choose(month, '11');
    await submit();
    expect(errorFor(month)?.textContent).toBe('Use a visit date that has already happened.');
    await choose(precision, 'year');
    expect(field('visitMonth')).toBeNull();
    await type(field('visitYear'), '2025');
    await submit();
    expect(savedInput(onSave)).toMatchObject({ visitDate: '2025', visitDatePrecision: 'year' });
    for (const [typed, message] of [
      ['2027', 'Use a visit date that has already happened.'],
      ['1899', 'Use a visit date from 1900 or later.'],
      ['25', 'Enter a four-digit year, such as 2026.'],
    ]) {
      await type(field('visitYear'), typed);
      await submit();
      expect(errorFor(field('visitYear'))?.textContent, typed).toBe(message);
    }
  });
});

describe('correcting a price', () => {
  const mine = state.priceObservations!.find(
    (item) => item.id === 'price-harbor-june',
  ) as PriceObservation;

  it('says which report it corrects and has no restaurant choice', async () => {
    await open({ observation: mine });
    expect(dialog().querySelector('.modal-description')?.textContent).toBe(
      'You reported $25.00 for Classic lobster roll at Harbor Shack on Jun 14, 2026. The correction replaces it in the price history; the original stays on record under Earlier reports.',
    );
    expect(dialog().querySelector('[role="group"]')).toBeNull();
    expect(dialog().querySelector('.form-toggle-row')).toBeNull();
    expect(field('price').value).toBe('25.00');
    expect(field('visitDay').value).toBe('2026-06-14');
  });

  it('starts on the restaurant field, with no empty row above it to add dead space', async () => {
    await open({ observation: mine });
    // Every direct child of the form is a field or the footer; an empty one would still take a gap.
    const children = [...form().children];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children)
      expect(
        child.textContent?.trim() || child.querySelector('input,select,textarea'),
      ).toBeTruthy();
    expect(children[0].matches('.field')).toBe(true);
    expect(children[0].contains(field('restaurantId'))).toBe(true);
  });

  it('will not record a correction that changes nothing', async () => {
    const { onCorrect } = await open({ observation: mine });
    await submit();
    expect(onCorrect).not.toHaveBeenCalled();
    expect(form().querySelector('.modal-footer .form-error')?.textContent).toBe(
      'Change the restaurant, price, item, date or note to correct this report.',
    );
    await type(field('price'), '26.50');
    await submit();
    expect(onCorrect).toHaveBeenCalledWith(
      mine.id,
      expect.objectContaining({ priceCents: 2650, restaurantId: harbor.id }),
    );
  });
});

describe('a visit already reported', () => {
  const existing = {
    ...state.priceObservations!.find((item) => item.id === 'price-harbor-june')!,
    visitDate: '2026-10-01',
  } as PriceObservation;

  it('offers to record a separate purchase', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '30');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    const prompt = form().querySelector('.price-entry-duplicate')!;
    expect(prompt.getAttribute('role')).toBe('alert');
    expect(prompt.textContent).toContain(
      'You already reported $25.00 here that day. Correct it instead?',
    );
    await click(buttonNamed('Save as a separate report'));
    expect(savedInput(onSave)).toMatchObject({ priceCents: 3000, confirmSeparateReport: true });
  });

  it('asks in the notice tint, not as an error, and still announces itself', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '30');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    // A decision with a safe default is not a failure, so it does not wear the error's red.
    const prompt = form().querySelector('.price-entry-duplicate')!;
    expect(prompt.getAttribute('role')).toBe('alert');
    expect(prompt.classList.contains('price-entry-notice')).toBe(true);
    expect(prompt.classList.contains('form-error')).toBe(false);
  });

  it('asks just above the buttons, scrolled into view, so the pinned footer stays small', async () => {
    const scrolled = vi.fn();
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
      scrolled(this, options);
    };
    try {
      const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
      await open({ onSave, initialRestaurantId: harbor.id });
      await type(field('price'), '30');
      await type(field('visitDay'), '2026-10-01');
      await submit();
      const prompt = form().querySelector('.price-entry-duplicate')!;
      // On a phone a question pinned in the footer would cover the fields it asks about.
      expect(prompt.closest('.modal-footer')).toBeNull();
      expect(prompt.parentElement).toBe(form());
      expect(prompt.nextElementSibling?.matches('.modal-footer')).toBe(true);
      expect(scrolled).toHaveBeenCalledWith(prompt, { block: 'center' });
    } finally {
      if (native) Object.defineProperty(Element.prototype, 'scrollIntoView', native);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('keeps the question, and focus on its button, while a separate report is saved or refused', async () => {
    let fail: (reason: Error) => void = () => {};
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new DuplicatePriceError(existing))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '30');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    const separate = buttonNamed('Save as a separate report');
    separate.focus();
    await click(separate);
    expect(separate.isConnected).toBe(true);
    expect(separate.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(separate);
    await act(async () => fail(new Error('Network request failed.')));
    // The question still stands, so it can be answered again; the refusal is said beside it.
    expect(separate.isConnected).toBe(true);
    expect(document.activeElement).toBe(separate);
    expect(form().querySelector('p.form-error[role="alert"]')?.textContent).toBe(
      'Network request failed. Your entry is still here.',
    );
  });

  it('offers to correct the earlier report with what was typed', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    const { onCorrect } = await open({ onSave });
    await choose(field<HTMLSelectElement>('restaurantId'), harbor.id);
    await type(field('price'), '30');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    await click(buttonNamed('Correct my $25.00 report'));
    expect(onCorrect).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({
        priceCents: 3000,
        restaurantId: harbor.id,
        visitDate: '2026-10-01',
      }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  // Correcting the earlier report to $90.00 is ten times an older $9.00 report of the same roll.
  const tenTimes = () =>
    new UnusualPriceError([
      {
        code: 'ten-times-last',
        message: 'You entered $90.00, ten times the last report of $9.00. Did you mean $9.00?',
        suggestedCents: 900,
      },
    ]);

  it('keeps an unusual price in the correction it offered, as the one question on screen', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    const onCorrect = vi.fn().mockRejectedValueOnce(tenTimes()).mockResolvedValueOnce(undefined);
    const { onClose } = await open({ onSave, onCorrect, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    await click(buttonNamed('Correct my $25.00 report'));
    // The visit question was answered; only the price question stands.
    expect(form().querySelector('.price-entry-duplicate')).toBeNull();
    expect(form().querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(form().querySelector('.price-entry-unusual')?.textContent).toContain(
      'You entered $90.00, ten times the last report of $9.00.',
    );
    await click(buttonNamed('Save $90.00 anyway'));
    // Saved as the correction it was, not sent again as a new report.
    expect(onSave).toHaveBeenCalledOnce();
    expect(onCorrect).toHaveBeenLastCalledWith(
      existing.id,
      expect.objectContaining({
        priceCents: 9000,
        restaurantId: harbor.id,
        confirmUnusualPrice: true,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves focus where it was when a question first appears', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '30');
    await type(field('visitDay'), '2026-10-01');
    submitButton().focus();
    await submit();
    expect(form().querySelector('.price-entry-duplicate')).not.toBeNull();
    // The question is announced as an alert; the member's place in the form is not taken from them.
    expect(document.activeElement).toBe(submitButton());
  });

  it('puts focus on the new question when it replaces the one that was answered', async () => {
    // Choosing to correct the earlier report ends the visit question and asks about the price.
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    const onCorrect = vi.fn().mockRejectedValueOnce(tenTimes());
    await open({ onSave, onCorrect, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    const correctIt = buttonNamed('Correct my $25.00 report');
    correctIt.focus();
    await click(correctIt);
    expect(correctIt.isConnected).toBe(false);
    // Not the dialog's frame, far above the question: the first answer, so Tab walks the rest.
    expect(document.activeElement).toBe(buttonNamed('Use $9.00'));
    expect(document.activeElement?.closest('.price-entry-unusual')).not.toBeNull();
  });

  it('puts focus on the visit question when it follows a price answered with Save anyway', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(tenTimes())
      .mockRejectedValueOnce(new DuplicatePriceError(existing));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    const saveAnyway = buttonNamed('Save $90.00 anyway');
    saveAnyway.focus();
    await click(saveAnyway);
    expect(saveAnyway.isConnected).toBe(false);
    expect(form().querySelector('.price-entry-duplicate')).not.toBeNull();
    expect(document.activeElement).toBe(buttonNamed('Correct my $25.00 report'));
  });

  it('does not pull focus into a question once the member has moved on to another control', async () => {
    let refuse: (reason: Error) => void = () => {};
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(tenTimes())
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    const saveAnyway = buttonNamed('Save $90.00 anyway');
    saveAnyway.focus();
    await click(saveAnyway);
    // While the answer is on its way the member goes back to the date field.
    field('visitDay').focus();
    await act(async () => refuse(new DuplicatePriceError(existing)));
    expect(form().querySelector('.price-entry-duplicate')).not.toBeNull();
    expect(document.activeElement).toBe(field('visitDay'));
  });

  it('corrects the earlier report with the one-tap price too', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    const onCorrect = vi.fn().mockRejectedValueOnce(tenTimes()).mockResolvedValueOnce(undefined);
    await open({ onSave, onCorrect, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    await click(buttonNamed('Correct my $25.00 report'));
    await click(buttonNamed('Use $9.00'));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onCorrect).toHaveBeenLastCalledWith(
      existing.id,
      expect.objectContaining({ priceCents: 900 }),
    );
    expect(field('price').value).toBe('9.00');
  });

  it('offers no one-tap fix that is the price already on the report it corrects', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    const onCorrect = vi.fn().mockRejectedValueOnce(
      new UnusualPriceError([
        {
          code: 'ten-times-last',
          message: 'You entered $90.00, ten times the last report of $9.00. Did you mean $25.00?',
          suggestedCents: 2500,
        },
      ]),
    );
    await open({ onSave, onCorrect, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    await click(buttonNamed('Correct my $25.00 report'));
    // $25.00 is the earlier report's own price: a correction to it would change nothing.
    expect(buttonNamed('Use $25.00')).toBeUndefined();
    expect(buttonNamed('Save $90.00 anyway')).toBeDefined();
  });

  // The member's report of another day, being corrected onto the visit already reported.
  const mine = { ...existing, id: 'price-harbor-mine', visitDate: '2026-06-14' };

  it('asks whether a correction moved onto that visit is a separate purchase', async () => {
    const onCorrect = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    await open({ observation: mine, onCorrect });
    await type(field('price'), '30');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    const prompt = form().querySelector('.price-entry-duplicate')!;
    expect(prompt.getAttribute('role')).toBe('alert');
    expect(prompt.textContent).toContain(
      'You already reported $25.00 here that day. Was this a separate purchase?',
    );
    expect(buttonNamed('Correct my $25.00 report')).toBeUndefined();
    await click(buttonNamed('Save as a separate purchase'));
    expect(onCorrect).toHaveBeenLastCalledWith(
      mine.id,
      expect.objectContaining({ priceCents: 3000, confirmSeparateReport: true }),
    );
  });

  it('says a correction onto a visit already reported at that price would count it twice', async () => {
    const onCorrect = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    await open({ observation: mine, onCorrect });
    await type(field('price'), '25');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    expect(form().querySelector('.price-entry-duplicate')).toBeNull();
    expect(form().querySelector('p.form-error[role="alert"]')?.textContent).toBe(
      'You already reported $25.00 for that visit, so this correction would count it twice. Withdraw this report instead.',
    );
    expect(onCorrect).toHaveBeenCalledOnce();
  });

  it('asks before closing over a typed entry', async () => {
    const { onClose } = await open({ initialRestaurantId: harbor.id });
    await type(field('price'), '30');
    await click(dialog().querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Discard what you have entered?');
  });
});

describe('text the ledger would refuse', () => {
  const mine = state.priceObservations!.find(
    (item) => item.id === 'price-harbor-june',
  ) as PriceObservation;

  it('will not save an item name of only spaces', async () => {
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    const item = field('itemName');
    await type(item, '   ');
    await type(field('price'), '28');
    await submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(item.getAttribute('aria-invalid')).toBe('true');
    expect(errorFor(item)?.textContent).toBe('Say which roll this price is for.');
    expect(document.activeElement).toBe(item);
  });

  it('will not save a correction whose item name is only spaces', async () => {
    const { onCorrect } = await open({ observation: mine });
    const item = field('itemName');
    await type(item, '   ');
    await type(field('price'), '26.50');
    await submit();
    expect(onCorrect).not.toHaveBeenCalled();
    expect(errorFor(item)?.textContent).toBe('Say which roll this price is for.');
  });

  it('keeps names and notes to the lengths the ledger keeps', async () => {
    await open();
    await click(buttonNamed('Add a restaurant'));
    expect(field('restaurantName').maxLength).toBe(160);
    expect(field('restaurantAddress').maxLength).toBe(240);
    expect(field('itemName').maxLength).toBe(160);
    expect(field<HTMLTextAreaElement>('note').maxLength).toBe(500);
  });

  it('names a restaurant, address or item that is pasted in too long, and saves nothing', async () => {
    const { onSave } = await open();
    await click(buttonNamed('Add a restaurant'));
    // Pasting can pass a field's maxLength, so the dialog checks the text itself.
    await type(field('restaurantName'), 'N'.repeat(161));
    await type(field('restaurantAddress'), 'A'.repeat(241));
    await type(field('itemName'), 'I'.repeat(161));
    await type(field('price'), '28');
    await submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(field('restaurantName'))?.textContent).toBe('Use 160 characters or fewer.');
    expect(errorFor(field('restaurantAddress'))?.textContent).toBe('Use 240 characters or fewer.');
    expect(errorFor(field('itemName'))?.textContent).toBe('Use 160 characters or fewer.');
    expect(document.activeElement).toBe(field('restaurantName'));
  });

  it('accepts a restaurant name, address and item at exactly the limit', async () => {
    const { onSave } = await open();
    await click(buttonNamed('Add a restaurant'));
    await type(field('restaurantName'), 'N'.repeat(160));
    await type(field('restaurantAddress'), 'A'.repeat(240));
    await type(field('itemName'), 'I'.repeat(160));
    await type(field('price'), '28');
    await submit();
    expect(onSave).toHaveBeenCalledOnce();
  });
});

describe('an unusual price', () => {
  const warning = () => form().querySelector('.price-entry-unusual');

  it('asks about a likely slipped decimal point, with a one-tap fix', async () => {
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    await type(field('price'), '2.50');
    await submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(warning()?.getAttribute('role')).toBe('alert');
    expect(warning()?.textContent).toContain('You entered $2.50. Did you mean $25.00?');
    await click(buttonNamed('Use $25.00'));
    expect(onSave).toHaveBeenCalledOnce();
    expect(savedInput(onSave)).toMatchObject({ priceCents: 2500 });
    expect(savedInput(onSave).confirmUnusualPrice).toBeUndefined();
  });

  it('asks in the notice tint, not as an error, and still announces itself', async () => {
    await open({ initialRestaurantId: harbor.id });
    await type(field('price'), '2.50');
    await submit();
    expect(warning()?.getAttribute('role')).toBe('alert');
    expect(warning()?.classList.contains('price-entry-notice')).toBe(true);
    expect(warning()?.classList.contains('form-error')).toBe(false);
  });

  it('keeps the price as entered once the member says it is right', async () => {
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    await type(field('price'), '2.50');
    await submit();
    await click(buttonNamed('Save $2.50 anyway'));
    expect(savedInput(onSave)).toMatchObject({ priceCents: 250, confirmUnusualPrice: true });
  });

  it('compares with the last report of the same roll at the restaurant', async () => {
    const { onSave } = await open({ initialRestaurantId: harbor.id });
    // The last Classic lobster roll at Harbor Shack was $28.00.
    await type(field('price'), '280');
    await submit();
    expect(warning()?.textContent).toContain(
      'You entered $280.00, ten times the last report of $28.00. Did you mean $28.00?',
    );
    // Changing the price takes the question away.
    await type(field('price'), '29');
    expect(warning()).toBeNull();
    await submit();
    expect(savedInput(onSave)).toMatchObject({ priceCents: 2900 });
  });

  it('asks the ledger’s question when the ledger is the one that asks', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(
      new UnusualPriceError([
        {
          code: 'below-usual',
          message: 'You entered $7.50. Did you mean $75.00?',
          suggestedCents: 7500,
        },
      ]),
    );
    await open({ onSave, initialRestaurantId: harbor.id });
    await type(field('price'), '28');
    await submit();
    expect(warning()?.textContent).toContain('You entered $7.50. Did you mean $75.00?');
    expect(form().querySelector('.modal-footer .form-error')).toBeNull();
  });

  it('asks before a correction keeps an unusual price too', async () => {
    const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    const { onCorrect } = await open({ observation: mine });
    await type(field('price'), '2.65');
    await submit();
    expect(onCorrect).not.toHaveBeenCalled();
    await click(buttonNamed('Save $2.65 anyway'));
    expect(onCorrect).toHaveBeenCalledWith(
      mine.id,
      expect.objectContaining({ priceCents: 265, confirmUnusualPrice: true }),
    );
  });

  it('offers no one-tap fix in a correction that is the price already on the report', async () => {
    const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    const { onCorrect } = await open({ observation: mine });
    // The report is $25.00, so $250.00 reads as a slipped decimal point toward the price it has,
    // and correcting a report to its own price is refused as changing nothing.
    await type(field('price'), '250');
    await submit();
    expect(warning()?.textContent).toContain('You entered $250.00. Did you mean $25.00?');
    expect(buttonNamed('Use $25.00')).toBeUndefined();
    expect(onCorrect).not.toHaveBeenCalled();
    await click(buttonNamed('Save $250.00 anyway'));
    expect(onCorrect).toHaveBeenCalledWith(
      mine.id,
      expect.objectContaining({ priceCents: 25000, confirmUnusualPrice: true }),
    );
  });

  it('drops that one-tap fix when the ledger is the one that suggests it', async () => {
    const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    const onCorrect = vi.fn().mockRejectedValueOnce(
      new UnusualPriceError([
        {
          code: 'above-usual',
          message: 'You entered $250.00. Did you mean $25.00?',
          suggestedCents: 2500,
        },
      ]),
    );
    await open({ observation: mine, onCorrect });
    await type(field('price'), '250');
    await submit();
    await click(buttonNamed('Save $250.00 anyway'));
    expect(onCorrect).toHaveBeenCalledOnce();
    expect(warning()?.textContent).toContain('You entered $250.00. Did you mean $25.00?');
    expect(buttonNamed('Use $25.00')).toBeUndefined();
    expect(buttonNamed('Save $250.00 anyway')).toBeDefined();
  });

  it('answers “Did you mean” with keeping the report when the price it means is the one it has', async () => {
    const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    const { onCorrect, onClose } = await open({ observation: mine });
    await type(field('price'), '250');
    await submit();
    expect(warning()?.textContent).toContain('You entered $250.00. Did you mean $25.00?');
    // The question has an answer: yes, $25.00, which is what the report already says.
    await click(buttonNamed('Keep my $25.00 report'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCorrect).not.toHaveBeenCalled();
  });

  it('keeps the report asked about in the duplicate prompt too, when its price is the one meant', async () => {
    const existing = {
      ...state.priceObservations!.find((item) => item.id === 'price-harbor-june')!,
      visitDate: '2026-10-01',
    } as PriceObservation;
    const onSave = vi.fn().mockRejectedValueOnce(new DuplicatePriceError(existing));
    const onCorrect = vi.fn().mockRejectedValueOnce(
      new UnusualPriceError([
        {
          code: 'above-usual',
          message: 'You entered $90.00. Did you mean $25.00?',
          suggestedCents: 2500,
        },
      ]),
    );
    const { onClose } = await open({ onSave, onCorrect, initialRestaurantId: harbor.id });
    await type(field('price'), '90');
    await type(field('visitDay'), '2026-10-01');
    await submit();
    await click(buttonNamed('Correct my $25.00 report'));
    await click(buttonNamed('Keep my $25.00 report'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCorrect).toHaveBeenCalledOnce();
  });

  it('offers no keep button when the price meant is a different one, or for a new report', async () => {
    const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    await open({ observation: mine });
    await type(field('price'), '2.65');
    await submit();
    expect(buttonNamed('Use $26.50')).toBeDefined();
    expect(dialog().textContent).not.toContain('Keep my');
    await open({ initialRestaurantId: harbor.id });
    await type(field('price'), '2.50');
    await submit();
    expect(dialog().textContent).not.toContain('Keep my');
  });

  it('still offers the one-tap fix in a correction when it is a different price', async () => {
    const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;
    const { onCorrect } = await open({ observation: mine });
    await type(field('price'), '2.65');
    await submit();
    await click(buttonNamed('Use $26.50'));
    expect(onCorrect).toHaveBeenCalledWith(mine.id, expect.objectContaining({ priceCents: 2650 }));
  });
});

describe('the reason for a correction', () => {
  const mine = state.priceObservations!.find((item) => item.id === 'price-harbor-june')!;

  it('is optional, and sent when given', async () => {
    const { onCorrect } = await open({ observation: mine });
    const reason = field<HTMLTextAreaElement>('correctionReason');
    expect(reason.required).toBe(false);
    expect(reason.maxLength).toBe(500);
    expect(nameOf(reason)).toBe('Reason for the correction');
    await type(field('price'), '26.50');
    await type(reason, ' Misread the menu ');
    await submit();
    expect(onCorrect).toHaveBeenCalledWith(
      mine.id,
      expect.objectContaining({ priceCents: 2650, correctionReason: 'Misread the menu' }),
    );
  });

  it('is not asked for a new report', async () => {
    await open();
    expect(field('correctionReason')).toBeNull();
  });
});
