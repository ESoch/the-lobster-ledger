// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { historyRevisionOf } from '../lib/bet-workflow';
import { applyAction, createBet } from '../lib/ledger';
import type { Bet, Member, NewBet, Place } from '../lib/types';
import { HistoryRevisionFields, readHistoryRevision } from './HistoryRevisionFields';

// Leaflet needs layout APIs that jsdom lacks. The stub is only a way to drop a pin.
vi.mock('./MapView', async () => {
  const { createElement: h } = await import('react');
  return {
    MapView: ({
      onPickLocation,
    }: {
      onPickLocation?: (at: { lat: number; lng: number }) => void;
    }) =>
      onPickLocation
        ? h(
            'button',
            {
              type: 'button',
              className: 'drop-pin',
              onClick: () => onPickLocation({ lat: 41.3, lng: -72.9 }),
            },
            'Drop a pin',
          )
        : null,
  };
});

const now = '2026-10-01T12:00:00.000Z';
const members: Member[] = [
  { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
  { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
];
const places: Place[] = [
  { id: 'harbor', name: 'The harbor café', address: '1 Long Wharf', lat: 41.3, lng: -72.9 },
  {
    id: 'kitchen',
    name: 'The office kitchen',
    address: 'Pinned location',
    lat: 41.31,
    lng: -72.92,
  },
];
const reported = (overrides: Partial<NewBet> = {}) =>
  createBet(
    {
      title: 'The kettle lasts until spring',
      terms: 'It must still boil water on the first day of spring.',
      category: 'Life',
      opponentId: 'b',
      creatorSide: 'It lasts',
      opponentSide: 'It breaks',
      stake: 1,
      timing: { kind: 'event', description: 'The first day of spring' },
      history: { stage: 'active', originalDate: { precision: 'year', value: '2024' } },
      acknowledgements: { terms: true, result: false, delivery: false },
      ...overrides,
    },
    'a',
    members,
    now,
  );

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
});
async function render(bet: Bet) {
  await act(async () =>
    root.render(
      createElement('form', null, createElement(HistoryRevisionFields, { bet, members, places })),
    ),
  );
}
const form = () => container.querySelector('form')!;
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('revising a reported past bet', () => {
  it('offers the saved places and keeps the saved place’s own id', async () => {
    const bet = reported({ location: places[1] });
    await render(bet);
    const place = form().querySelector('select[name="location.placeId"]') as unknown as
      HTMLSelectElement | undefined;
    expect(place).toBeTruthy();
    expect([...place!.options].map((option) => option.textContent)).toEqual([
      'No location',
      'The harbor café',
      'The office kitchen',
      '+ Pin a new location',
    ]);
    expect(place!.value).toBe('kitchen');
    await choose(place!, 'harbor');
    expect(readHistoryRevision(new FormData(form()), bet, places).location).toEqual(places[0]);
    await choose(place!, '');
    expect(readHistoryRevision(new FormData(form()), bet, places).location).toBeUndefined();
  });

  it('starts with the correction it is answering, in the requester’s words', async () => {
    const bet = applyAction(
      reported(),
      { type: 'request_history_correction', note: 'It was two rolls, not one.' },
      'b',
      now,
    );
    await render(bet);
    const recap = form().querySelector('.workflow-notice')!;
    expect(form().firstElementChild).toBe(recap);
    expect(recap.textContent).toContain('Blair Reed asked for this correction');
    expect(recap.textContent).toContain('“It was two rolls, not one.”');
    expect(form().textContent).toContain('The earlier version stays in the paper trail');
  });

  it('reads back an untouched legacy decision date as the same date, so nothing changes', async () => {
    const bet = reported({ timing: undefined, deadline: '2026-10-10', location: places[0] });
    await render(bet);
    const revision = readHistoryRevision(new FormData(form()), bet, places);
    expect(revision.deadline).toBe('2026-10-10');
    expect(revision.timing).toBeUndefined();
    expect(revision).toEqual(historyRevisionOf(bet));
  });

  it('keeps what was typed for a bet still going when the stage is changed and changed back', async () => {
    const bet = reported();
    await render(bet);
    const source = () =>
      form().querySelector('input[name="timing.source"]') as unknown as HTMLInputElement;
    const stage = form().querySelector(
      'select[name="history.stage"]',
    ) as unknown as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(source(), 'The kettle’s maker');
      source().dispatchEvent(new Event('input', { bubbles: true }));
    });
    const outcome = () => form().querySelector('textarea[name="history.resultNote"]')!;
    expect(outcome().closest('[hidden]')).not.toBeNull();
    await choose(stage, 'owed');
    // The timing is set aside while the bet is decided, and the outcome takes its place.
    expect(source().closest('[hidden]')).not.toBeNull();
    expect(outcome().closest('[hidden]')).toBeNull();
    await choose(stage, 'active');
    expect(source().closest('[hidden]')).toBeNull();
    expect(source().value).toBe('The kettle’s maker');
  });

  it('wraps a long title and positions instead of scrolling them sideways, and keeps them to one line', async () => {
    const long = 'The kettle is still boiling water on the very first morning of spring this year';
    const bet = reported({ title: long, creatorSide: long, opponentSide: `${long}, truly` });
    await render(bet);
    for (const name of ['title', 'creatorSide', 'opponentSide']) {
      const control = form().querySelector(`[name="${name}"]`) as unknown as HTMLTextAreaElement;
      expect(control.tagName).toBe('TEXTAREA');
      expect(control.rows).toBeGreaterThanOrEqual(2);
      expect(control.maxLength).toBeGreaterThan(0);
      // Enter does not add a line to what is one line of text.
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      control.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
    }
    // A line break that arrives by paste is a space in the record.
    const title = form().querySelector('[name="title"]') as unknown as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(title, 'The kettle\n lasts until   spring ');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const revision = readHistoryRevision(new FormData(form()), bet, places);
    expect(revision.title).toBe('The kettle lasts until spring');
    expect(revision.creatorSide).toBe(long);
  });
});

describe('a pinned location name that shows nothing', () => {
  const ZERO = '\u200b\u200c\u200d\u2060\ufeff';
  async function pinNamed(name: string, bet: Bet) {
    await render(bet);
    const place = form().querySelector(
      'select[name="location.placeId"]',
    ) as unknown as HTMLSelectElement;
    await choose(place, 'custom');
    const input = form().querySelector(
      'input[name="location.name"]',
    ) as unknown as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form().querySelector<HTMLButtonElement>('.drop-pin')!.click());
  }

  it('is not read back as a name, and the status does not call the pin by it', async () => {
    const bet = reported();
    await pinNamed(ZERO, bet);
    expect(form().querySelector('.pin-status')?.textContent).toContain(
      'Your pin is pinned. Tap the map to move it.',
    );
    expect(() => readHistoryRevision(new FormData(form()), bet, places)).toThrow(
      'Name the location and choose a point on the map.',
    );
  });

  it('is saved without the zero-width padding around the name', async () => {
    const bet = reported();
    await pinNamed(`${ZERO}The office kitchen${ZERO}`, bet);
    expect(form().querySelector('.pin-status')?.textContent).toContain(
      'The office kitchen is pinned.',
    );
    expect(readHistoryRevision(new FormData(form()), bet, places).location?.name).toBe(
      'The office kitchen',
    );
  });
});
