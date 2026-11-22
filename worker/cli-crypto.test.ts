import { describe, expect, it } from 'vitest';
import {
  createSecret,
  hashSecret,
  proofChallenge,
  validateAuthorizeInput,
  validSecret,
} from './cli-crypto';

const verifier = 'v'.repeat(43);
const input = {
  codeChallenge: 'c'.repeat(43),
  redirectUri: 'http://127.0.0.1:49231/callback',
  state: 's'.repeat(43),
  deviceName: 'Ellis’s MacBook',
};

describe('CLI authorization input', () => {
  it('accepts an explicit unprivileged IPv4 loopback callback', () => {
    expect(validateAuthorizeInput(input)).toEqual(input);
  });

  it.each([
    'https://127.0.0.1:49231/callback',
    'http://localhost:49231/callback',
    'http://127.1:49231/callback',
    'http://[::1]:49231/callback',
    'http://127.0.0.1:80/callback',
    'http://127.0.0.1:1023/callback',
    'http://127.0.0.1:65536/callback',
    'http://127.0.0.1:49231/callback?next=evil',
    'http://127.0.0.1:49231/callback#evil',
    'http://127.0.0.1:49231/other',
    'http://user@127.0.0.1:49231/callback',
    'http://127.0.0.1.example.com:49231/callback',
    'http://127.0.0.1:049231/callback',
  ])('rejects unsafe callback %s', (redirectUri) => {
    expect(() => validateAuthorizeInput({ ...input, redirectUri })).toThrow();
  });

  it.each([
    { codeChallenge: verifier + '=' },
    { codeChallenge: 'a'.repeat(42) },
    { codeChallenge: '!'.repeat(43) },
    { state: 'short' },
    { state: 's'.repeat(129) },
    { state: 's'.repeat(32) + '\n' },
    { deviceName: ' ' },
    { deviceName: 'x'.repeat(81) },
    { deviceName: 'name\nSpoofed device' },
    { deviceName: null },
  ])('rejects malformed authorization parameters %j', (overrides) => {
    expect(() => validateAuthorizeInput({ ...input, ...overrides })).toThrow();
  });

  it('rejects non-object input', () => {
    for (const value of [null, [], 'text', 12]) {
      expect(() => validateAuthorizeInput(value)).toThrow();
    }
  });
});

describe('CLI secret generation and proof', () => {
  it('matches the RFC 7636 S256 example', async () => {
    expect(await proofChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it.each(['short', 'a'.repeat(129), 'a'.repeat(42) + '=', 'a'.repeat(42) + '\n'])(
    'rejects malformed proof verifiers',
    async (value) => {
      await expect(proofChallenge(value)).rejects.toThrow();
    },
  );

  it('generates distinct, recognized high-entropy opaque credentials', () => {
    const first = createSecret('lla');
    const second = createSecret('lla');
    expect(first).not.toBe(second);
    expect(validSecret(first, 'lla')).toBe(true);
    expect(validSecret(first, 'llr')).toBe(false);
    expect(validSecret(first + '\n', 'lla')).toBe(false);
  });

  it('hashes credentials deterministically without retaining the bearer secret', async () => {
    expect(await hashSecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
