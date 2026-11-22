import { describe, expect, it } from 'vitest';
import {
  CLI_REQUEST_LIFETIME,
  CLI_REQUEST_STORAGE,
  cliRequestExpired,
  cliRequestMinutesLeft,
  parseCliRequest,
  restoreCliRequest,
  validCliRedirect,
  validateCliCallback,
} from './cli-request';

const request = {
  codeChallenge: 'a'.repeat(43),
  state: 'b'.repeat(43),
  deviceName: 'Ellis’s laptop',
  redirectUri: 'http://127.0.0.1:47123/callback',
};
const now = 1_000_000;

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('CLI browser authorization requests', () => {
  it('preserves a normalized request through sign-in without extending its lifetime', () => {
    const store = storage();
    const first = restoreCliRequest(encoded({ ...request, extra: 'ignored' }), store, now);
    expect(first).toEqual({ pending: { request, createdAt: now } });
    expect(restoreCliRequest(null, store, now + 50_000)).toEqual(first);
  });

  it('expires and clears a pending request after five minutes', () => {
    const store = storage();
    restoreCliRequest(encoded(request), store, now);
    const result = restoreCliRequest(null, store, now + CLI_REQUEST_LIFETIME);
    expect(result.error).toContain('expired');
    expect(store.getItem(CLI_REQUEST_STORAGE)).toBeNull();
    expect(cliRequestExpired({ request, createdAt: now }, now - 1)).toBe(true);
  });

  it.each([
    '',
    'not+base64',
    '!',
    'a'.repeat(4097),
    encoded(null),
    encoded({ ...request, codeChallenge: 'short' }),
    encoded({ ...request, state: 'short' }),
    encoded({ ...request, deviceName: 'bad\nname' }),
  ])('rejects malformed encoded request %s', (value) => {
    const store = storage();
    restoreCliRequest(encoded(request), store, now);
    expect(restoreCliRequest(value, store, now).error).toContain('invalid');
    expect(store.getItem(CLI_REQUEST_STORAGE)).toBeNull();
  });

  it('does not accept malformed or future persisted timestamps', () => {
    const store = storage();
    store.setItem(CLI_REQUEST_STORAGE, JSON.stringify({ request, createdAt: 'yesterday' }));
    expect(restoreCliRequest(null, store, now).error).toContain('invalid');
    store.setItem(CLI_REQUEST_STORAGE, JSON.stringify({ request, createdAt: now + 1 }));
    expect(restoreCliRequest(null, store, now).error).toContain('expired');
  });

  it('fails closed when session storage is unavailable', () => {
    const unavailable = {
      getItem() {
        throw new Error('disabled');
      },
      setItem() {
        throw new Error('disabled');
      },
      removeItem() {
        throw new Error('disabled');
      },
    };
    expect(restoreCliRequest(encoded(request), unavailable, now).pending).toBeUndefined();
    expect(restoreCliRequest(null, unavailable, now)).toEqual({});
  });

  it.each([
    'https://127.0.0.1:47123/callback',
    'http://localhost:47123/callback',
    'http://127.0.0.1:1023/callback',
    'http://127.0.0.1:47123/other',
    'http://127.0.0.1:47123/callback?next=evil',
    'http://127.0.0.1:47123/callback#evil',
    'http://user@127.0.0.1:47123/callback',
    'http://127.0.0.1.example.com:47123/callback',
    'http://2130706433:47123/callback',
  ])('rejects an unsafe loopback redirect %s', (redirectUri) => {
    expect(validCliRedirect(redirectUri)).toBe(false);
    expect(parseCliRequest({ ...request, redirectUri })).toBeUndefined();
  });

  it('accepts only the matching loopback response with one code and state', () => {
    const callback = `${request.redirectUri}?code=${'c'.repeat(43)}&state=${request.state}`;
    expect(validateCliCallback(callback, request)).toBe(callback);
    for (const bad of [
      callback.replace('47123', '47124'),
      callback.replace(request.state, 'd'.repeat(43)),
      `${callback}&state=${request.state}`,
      `${callback}&code=${'c'.repeat(43)}`,
      `${callback}&next=https://example.com`,
      `${callback}#fragment`,
      callback.replace('127.0.0.1', 'example.com'),
      `${request.redirectUri}?state=${request.state}`,
    ])
      expect(() => validateCliCallback(bad, request)).toThrow('invalid destination');
  });
});

describe('CLI request device names', () => {
  it.each([
    ['a next-line control', 'Laptop\u0085'],
    ['a C1 control', 'Laptop\u009f'],
    ['a right-to-left override', 'Laptop \u202Egpj.exe'],
    ['a left-to-right isolate', 'Laptop \u2066'],
    ['a directional mark', 'Laptop\u200F'],
    ['an Arabic letter mark', 'Laptop\u061C'],
    ['a line separator', 'Laptop\u2028'],
  ])('rejects %s in a device name', (_, deviceName) => {
    expect(parseCliRequest({ ...request, deviceName })).toBeUndefined();
    const store = storage();
    expect(restoreCliRequest(encoded({ ...request, deviceName }), store, now).error).toContain(
      'invalid',
    );
  });

  it('keeps accepting ordinary and non-Latin names', () => {
    for (const deviceName of ['Lobster CLI on ellis-mbp.local', 'Ellis’s laptop', 'ラップトップ'])
      expect(parseCliRequest({ ...request, deviceName })?.deviceName).toBe(deviceName);
  });
});

describe('CLI request in the demo', () => {
  const saved = { request, createdAt: now - 1000 };

  it('does not restore, clear or replace a real request stored in the same tab', () => {
    const store = storage();
    store.setItem(CLI_REQUEST_STORAGE, JSON.stringify(saved));
    expect(restoreCliRequest(null, store, now, true)).toEqual({});
    expect(store.getItem(CLI_REQUEST_STORAGE)).toBe(JSON.stringify(saved));
    const other = { ...request, deviceName: 'Demo laptop' };
    expect(restoreCliRequest(encoded(other), store, now, true)).toEqual({
      pending: { request: other, createdAt: now },
    });
    expect(store.getItem(CLI_REQUEST_STORAGE)).toBe(JSON.stringify(saved));
    expect(restoreCliRequest('!', store, now, true).error).toContain('invalid');
    expect(store.getItem(CLI_REQUEST_STORAGE)).toBe(JSON.stringify(saved));
  });

  it('still restores the stored request outside the demo', () => {
    const store = storage();
    store.setItem(CLI_REQUEST_STORAGE, JSON.stringify(saved));
    expect(restoreCliRequest(null, store, now)).toEqual({ pending: saved });
  });
});

describe('CLI request countdown', () => {
  const pending = { request, createdAt: now };
  it('rounds the minutes left up and reaches zero at expiry', () => {
    expect(cliRequestMinutesLeft(pending, now)).toBe(5);
    expect(cliRequestMinutesLeft(pending, now + 1000)).toBe(5);
    expect(cliRequestMinutesLeft(pending, now + 60_000)).toBe(4);
    expect(cliRequestMinutesLeft(pending, now + CLI_REQUEST_LIFETIME - 1)).toBe(1);
    expect(cliRequestMinutesLeft(pending, now + CLI_REQUEST_LIFETIME)).toBe(0);
    expect(cliRequestMinutesLeft({ request, createdAt: Number.NaN }, now)).toBe(0);
  });
});
