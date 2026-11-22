// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import type { NewBet } from '../lib/types';
import { NewBetDialog } from './NewBetDialog';

// Leaflet needs layout APIs that jsdom lacks. The stub keeps what these tests need: a way to drop a pin.
vi.mock('./MapView', async () => {
  const { createElement: h } = await import('react');
  return {
    MapView: ({
      onPickLocation,
    }: {
      onPickLocation?: (at: { lat: number; lng: number }) => void;
    }) =>
      h(
        'button',
        {
          type: 'button',
          className: 'drop-pin',
          onClick: () => onPickLocation?.({ lat: 41.3, lng: -72.9 }),
        },
        'Drop a pin',
      ),
  };
});

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

const state = createDemoState();
const ellis = state.members.find((member) => member.name === 'Ellis')!;
const sarah = state.members.find((member) => member.name === 'Sarah')!;
const dialog = () => document.querySelector('[role="dialog"]')!;
const field = <T = HTMLInputElement>(name: string) =>
  dialog().querySelector(`[name="${name}"]`) as unknown as T;
const placeName = () => dialog().querySelector<HTMLInputElement>('.custom-place input')!;
const errorFor = (control: { getAttribute(name: string): string | null }) =>
  (control.getAttribute('aria-describedby')?.split(' ') ?? [])
    .map((id) => document.getElementById(id))
    .find((element) => element?.classList.contains('field-error'));
async function write(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')!.set!;
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
async function fillBetWithCustomPlace(onCreate: (input: NewBet) => Promise<void>) {
  await act(async () =>
    root.render(
      createElement(NewBetDialog, {
        open: true,
        onClose: () => {},
        state,
        memberId: ellis.id,
        onCreate,
      }),
    ),
  );
  await write(field('title'), 'The ferry beats the bridge traffic');
  await write(field<HTMLSelectElement>('opponentId'), sarah.id);
  await write(field('creatorSide'), 'It is quicker');
  await write(field('opponentSide'), 'It is slower');
  await write(
    field<HTMLTextAreaElement>('terms'),
    'The ferry schedule against the traffic report.',
  );
  await write(field('timing.local'), '2030-11-02T17:00');
  const places = [...dialog().querySelectorAll('select')].find((select) =>
    [...select.options].some((option) => option.value === 'custom'),
  )!;
  await write(places, 'custom');
}
const dropPin = () =>
  act(async () => dialog().querySelector<HTMLButtonElement>('.drop-pin')!.click());
const submit = () => act(async () => dialog().querySelector('form')!.requestSubmit());

describe('a location name that shows nothing', () => {
  const ZERO = '​‌‍⁠﻿';

  it('is asked for again on the name field, not sent to fail in the footer', async () => {
    const onCreate = vi.fn(async (_input: NewBet) => {});
    await fillBetWithCustomPlace(onCreate);
    await write(placeName(), ZERO);
    await dropPin();
    // The pin is placed but has no name to show, so the status asks for one instead of reading " is pinned."
    expect(dialog().querySelector('.pin-status-text')?.textContent).toBe(
      'Your pin is placed. Name the location above.',
    );
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    expect(errorFor(placeName())?.textContent).toBe('Name the location you are pinning.');
    expect(document.activeElement).toBe(placeName());
    expect(dialog().querySelector('.modal-footer .form-error')).toBeNull();
  });

  it('asks for the name, not the pin, when the pin is still missing', async () => {
    const onCreate = vi.fn(async (_input: NewBet) => {});
    await fillBetWithCustomPlace(onCreate);
    await write(placeName(), ZERO);
    await submit();
    expect(errorFor(placeName())?.textContent).toBe('Name the location you are pinning.');
  });

  it('keeps zero-width padding out of the name that is sent', async () => {
    const onCreate = vi.fn(async (_input: NewBet) => {});
    await fillBetWithCustomPlace(onCreate);
    await write(placeName(), `${ZERO}The office kitchen${ZERO}`);
    await dropPin();
    expect(dialog().querySelector('.pin-status-text')?.textContent).toBe(
      'The office kitchen is pinned.',
    );
    await submit();
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate.mock.calls[0][0].location?.name).toBe('The office kitchen');
  });
});
