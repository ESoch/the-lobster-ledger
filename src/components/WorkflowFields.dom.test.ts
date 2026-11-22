// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoricalInput, Member } from '../lib/types';
import { findProblems } from './form-errors';
import {
  DateTimeField,
  HistoricalDateField,
  HistoryAcknowledgementFields,
  HistoryFields,
  historyProblems,
  readHistory,
  readTiming,
} from './WorkflowFields';

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
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const precision = () =>
  container.querySelector('select[name="made.precision"]') as unknown as HTMLSelectElement;
const dateValue = () => container.querySelector<HTMLInputElement>('input[name="made.value"]')!;
const local = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

describe('a date and time', () => {
  it('states the years it accepts, so a far-off date is named in plain words', async () => {
    await act(async () =>
      root.render(
        createElement('form', null, createElement(DateTimeField, { name: 'when', label: 'When' })),
      ),
    );
    const field = container.querySelector<HTMLInputElement>('input[name="when.local"]')!;
    expect(field.min).toBe('2000-01-01T00:00');
    expect(field.max).toBe('2100-12-31T23:59');
    expect(field.dataset.rangeMessage).toBe('Choose a date between 2000 and 2100.');
    const form = container.querySelector('form')!;
    for (const value of ['0001-01-01T00:00', '9999-12-31T23:59']) {
      await type(field, value);
      expect(findProblems(form).map((problem) => problem.message)).toEqual([
        'Choose a date between 2000 and 2100.',
      ]);
    }
    await type(field, '2031-05-01T10:00');
    expect(findProblems(form)).toEqual([]);
  });
});

describe('a date from a past bet', () => {
  it('keeps what was typed when the precision changes', async () => {
    await act(async () =>
      root.render(
        createElement(
          'form',
          null,
          createElement(HistoricalDateField, { name: 'made', label: 'When was the bet made?' }),
        ),
      ),
    );
    // The precision comes first: it decides what kind of date can be typed.
    const fieldset = container.querySelector('fieldset')!;
    expect(fieldset.querySelector('select, input')).toBe(precision());
    await choose(precision(), 'day');
    expect(dateValue().type).toBe('date');
    await type(dateValue(), '2024-03-04');
    await choose(precision(), 'month');
    expect(dateValue().type).toBe('month');
    expect(dateValue().value).toBe('2024-03');
    expect(dateValue().max).toBe(local(new Date()).slice(0, 7));
    await choose(precision(), 'year');
    expect(dateValue().value).toBe('2024');
    // Back to the exact day: the day typed earlier still fits the year, so it returns.
    await choose(precision(), 'day');
    expect(dateValue().value).toBe('2024-03-04');
    expect(dateValue().max).toBe(local(new Date()));
  });
  it('reads a month typed as words where the browser shows a text box', async () => {
    await act(async () =>
      root.render(
        createElement(
          'form',
          null,
          createElement(HistoricalDateField, {
            name: 'history.originalDate',
            label: 'When was the bet made?',
            value: { precision: 'month', value: '' },
          }),
        ),
      ),
    );
    const month = container.querySelector<HTMLInputElement>(
      'input[name="history.originalDate.value"]',
    )!;
    expect(month.placeholder).toBe('YYYY-MM');
    expect(month.title).toMatch(/2024-03/);
    // jsdom knows month fields, so the plain text box such a browser shows is built by hand.
    const fallback = document.createElement('form');
    fallback.innerHTML = `
      <input name="history.stage" value="active">
      <input name="history.originalDate.precision" value="month">
      <input name="history.originalDate.value" value="March 2024">`;
    expect(readHistory(new FormData(fallback)).originalDate).toEqual({
      precision: 'month',
      value: '2024-03',
    });
  });
});

describe('checking a reported history before it is sent', () => {
  const members: Member[] = [
    { id: 'a', name: 'Avery', initials: 'A', color: '#000' },
    { id: 'b', name: 'Blair', initials: 'B', color: '#000' },
  ];
  it('puts an outcome dated before the bet on the outcome date', async () => {
    await act(async () =>
      root.render(
        createElement(
          'form',
          null,
          createElement(HistoryFields, {
            members,
            creatorId: 'a',
            opponentId: 'b',
            stage: 'owed',
            onStageChange: () => {},
            value: {
              stage: 'owed',
              originalDate: { precision: 'day', value: '2024-05-01' },
              result: {
                winnerId: 'a',
                date: { precision: 'day', value: '2024-03-01' },
                note: 'Avery won.',
              },
            },
          }),
        ),
      ),
    );
    const form = container.querySelector('form')!;
    const problems = historyProblems(form, ['a', 'b']);
    expect(problems.map((problem) => [problem.name, problem.message])).toEqual([
      ['history.resultDate.value', 'The outcome can’t be decided before the bet was made.'],
    ]);
    expect(problems[0].element).toBe(form.querySelector('input[name="history.resultDate.value"]'));
  });
});

describe('the earliest a date of a past bet can be', () => {
  const members: Member[] = [
    { id: 'a', name: 'Avery', initials: 'A', color: '#000' },
    { id: 'b', name: 'Blair', initials: 'B', color: '#000' },
  ];
  const input = (name: string) =>
    container.querySelector<HTMLInputElement>(`input[name="history.${name}.value"]`)!;
  const pick = (name: string) =>
    container.querySelector(
      `select[name="history.${name}.precision"]`,
    ) as unknown as HTMLSelectElement;
  async function renderHistory() {
    await act(async () =>
      root.render(
        createElement(
          'form',
          null,
          createElement(HistoryFields, {
            members,
            creatorId: 'a',
            opponentId: 'b',
            stage: 'settled',
            onStageChange: () => {},
          }),
        ),
      ),
    );
  }
  it('stops a day or a month before 1900, as a year already does', async () => {
    await renderHistory();
    await choose(pick('originalDate'), 'day');
    expect(input('originalDate').min).toBe('1900-01-01');
    await choose(pick('originalDate'), 'month');
    expect(input('originalDate').min).toBe('1900-01');
    await choose(pick('originalDate'), 'year');
    expect(input('originalDate').min).toBe('1900');
  });
  it('holds each stage to the day of the stage before it, at whatever precision it is given', async () => {
    await renderHistory();
    await choose(pick('originalDate'), 'day');
    await type(input('originalDate'), '2024-05-01');
    await choose(pick('resultDate'), 'day');
    expect(input('resultDate').min).toBe('2024-05-01');
    await choose(pick('resultDate'), 'month');
    expect(input('resultDate').min).toBe('2024-05');
    await choose(pick('resultDate'), 'year');
    expect(input('resultDate').min).toBe('2024');
    await choose(pick('resultDate'), 'day');
    await type(input('resultDate'), '2024-06-15');
    await choose(pick('deliveryDate'), 'day');
    expect(input('deliveryDate').min).toBe('2024-06-15');
    // Moving the first date on moves what is allowed after it.
    await type(input('originalDate'), '2024-07-01');
    expect(input('resultDate').min).toBe('2024-07-01');
    expect(input('deliveryDate').min).toBe('2024-07-01');
  });
  it('says which stage a date is too early for, rather than a generic range', async () => {
    await renderHistory();
    await choose(pick('originalDate'), 'day');
    await type(input('originalDate'), '2024-05-01');
    await choose(pick('resultDate'), 'day');
    await type(input('resultDate'), '2024-04-01');
    const form = container.querySelector('form')!;
    const problem = findProblems(form).find((found) => found.name === 'history.resultDate.value');
    expect(problem?.message).toBe('The outcome can’t be decided before the bet was made.');
    await choose(pick('originalDate'), 'day');
    await type(input('originalDate'), '1850-01-01');
    const early = findProblems(form).find((found) => found.name === 'history.originalDate.value');
    expect(early?.message).toMatch(/1900/);
  });
});

describe('changing where a past bet stands', () => {
  const members: Member[] = [
    { id: 'a', name: 'Avery', initials: 'A', color: '#000' },
    { id: 'b', name: 'Blair', initials: 'B', color: '#000' },
  ];
  /** The history fields with their acknowledgements, the stage held by the form as it is in the dialogs. */
  function Form() {
    const [stage, setStage] = useState<HistoricalInput['stage']>('settled');
    return createElement(
      'form',
      null,
      createElement(HistoryFields, {
        members,
        creatorId: 'a',
        opponentId: 'b',
        stage,
        onStageChange: setStage,
      }),
      createElement(HistoryAcknowledgementFields, { stage }),
    );
  }
  const form = () => container.querySelector('form')!;
  const control = <T = HTMLInputElement>(name: string) =>
    form().querySelector(`[name="${name}"]`) as unknown as T;
  async function typeArea(area: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const tick = (box: HTMLInputElement) => act(async () => box.click());
  async function fillDecided() {
    await choose(control<HTMLSelectElement>('history.winnerId'), 'b');
    await typeArea(control<HTMLTextAreaElement>('history.resultNote'), 'Blair got there first.');
    await typeArea(control<HTMLTextAreaElement>('history.deliveryNote'), 'Delivered at lunch.');
    await tick(control('history.previous'));
    await typeArea(control<HTMLTextAreaElement>('history.previousNote'), 'A judge said Blair.');
  }

  it('keeps the outcome, delivery and earlier decision typed when the stage goes back and forth', async () => {
    await act(async () => root.render(createElement(Form)));
    await fillDecided();
    await choose(control<HTMLSelectElement>('history.stage'), 'active');
    // Nothing about a decision is sent, or checked, for a bet that is still going.
    expect(readHistory(new FormData(form()))).toEqual({
      stage: 'active',
      originalDate: { precision: 'unknown' },
    });
    expect(
      findProblems(form())
        .map((problem) => problem.name)
        .filter((name) => name.startsWith('history.')),
    ).toEqual([]);
    expect(control('history.resultNote').closest('[hidden]')).not.toBeNull();
    await choose(control<HTMLSelectElement>('history.stage'), 'settled');
    expect(control('history.resultNote').closest('[hidden]')).toBeNull();
    expect(control<HTMLSelectElement>('history.winnerId').value).toBe('b');
    expect(control<HTMLTextAreaElement>('history.resultNote').value).toBe('Blair got there first.');
    expect(control<HTMLTextAreaElement>('history.deliveryNote').value).toBe('Delivered at lunch.');
    expect(control('history.previous').checked).toBe(true);
    expect(control<HTMLTextAreaElement>('history.previousNote').value).toBe('A judge said Blair.');
    expect(readHistory(new FormData(form())).delivery?.note).toBe('Delivered at lunch.');
  });

  it('keeps the winner and note through a call-off, which has no winner', async () => {
    await act(async () => root.render(createElement(Form)));
    await fillDecided();
    await choose(control<HTMLSelectElement>('history.stage'), 'voided');
    expect(readHistory(new FormData(form())).result?.winnerId).toBeNull();
    expect(readHistory(new FormData(form())).delivery).toBeUndefined();
    await choose(control<HTMLSelectElement>('history.stage'), 'owed');
    expect(control<HTMLSelectElement>('history.winnerId').value).toBe('b');
    expect(control<HTMLTextAreaElement>('history.resultNote').value).toBe('Blair got there first.');
  });

  it('keeps the terms tick across a change of stage but asks again for the ones worded for a stage', async () => {
    await act(async () => root.render(createElement(Form)));
    for (const name of ['terms', 'result', 'delivery'])
      await tick(control(`acknowledgements.${name}`));
    await choose(control<HTMLSelectElement>('history.stage'), 'owed');
    expect(control('acknowledgements.terms').checked).toBe(true);
    expect(control('acknowledgements.result').checked).toBe(false);
    await tick(control('acknowledgements.result'));
    await choose(control<HTMLSelectElement>('history.stage'), 'active');
    expect(control('acknowledgements.terms').checked).toBe(true);
    expect(control('acknowledgements.result')).toBeNull();
  });
});

describe('optional text that shows nothing', () => {
  // Zero-width space, non-joiner, joiner, word joiner and a byte-order mark: nothing on screen.
  const ZERO = '\u200b\u200c\u200d\u2060\ufeff';
  const read = (source: string) => {
    const data = new FormData();
    data.set('timing.kind', 'evidence');
    data.set('timing.description', `The final whistle${ZERO}`);
    data.set('timing.source', source);
    return readTiming(data).timing;
  };

  it('leaves an expected evidence source of only zero-width characters unset', () => {
    const timing = read(` ${ZERO} `);
    expect(timing).toEqual({ kind: 'evidence', description: 'The final whistle' });
    expect(timing).not.toHaveProperty('source');
  });

  it('sends a source that is there without the zero-width padding around it', () => {
    expect(read(`${ZERO}The official match report${ZERO}`)).toEqual({
      kind: 'evidence',
      description: 'The final whistle',
      source: 'The official match report',
    });
  });

  it('leaves the earlier judge or prompt’s link unset when it holds only zero-width characters', () => {
    const data = new FormData();
    data.set('history.stage', 'owed');
    data.set('history.winnerId', 'b');
    data.set('history.resultNote', 'Blair got there first.');
    data.set('history.previous', 'on');
    data.set('history.previousMethod', 'chatgpt');
    data.set('history.previousNote', 'A prompt said Blair.');
    data.set('history.previousUrl', ZERO);
    expect(readHistory(data).previousAdjudication).not.toHaveProperty('sourceUrl');
  });
});
