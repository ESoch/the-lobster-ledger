import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/args';
describe('command parsing', () => {
  it('supports guided and structured creation with global flags anywhere', () => {
    expect(parseCommand(['bets', 'create'])).toMatchObject({ command: 'bets create' });
    expect(
      parseCommand([
        '--origin',
        'https://custom.example',
        'bets',
        'create',
        '--file',
        'bet.json',
        '--dry-run',
        '--json',
      ]),
    ).toMatchObject({
      command: 'bets create',
      origin: 'https://custom.example',
      file: 'bet.json',
      dryRun: true,
      json: true,
    });
  });
  it('rejects misspelled flags, unknown commands, and irrelevant options', () => {
    for (const args of [
      ['bets', 'create', '--stkae', '2'],
      ['bets', 'pay'],
      ['balances', '--file', 'x'],
      ['auth', 'login', '--yes'],
      ['bets', 'show'],
      ['api', 'https://evil.test'],
    ])
      expect(() => parseCommand(args)).toThrow();
  });
  it('parses bet actions with their reason, winner and explicit submission flag', () => {
    expect(
      parseCommand([
        'bets',
        'act',
        'LL-123',
        '--action',
        'decline',
        '--note',
        'The terms are too broad.',
        '--yes',
      ]),
    ).toMatchObject({
      command: 'bets act',
      argument: 'LL-123',
      action: 'decline',
      note: 'The terms are too broad.',
      yes: true,
    });
    expect(
      parseCommand(['bets', 'act', 'LL-123', '--action', 'propose_result', '--winner', 'none']),
    ).toMatchObject({ command: 'bets act', action: 'propose_result', winner: 'none' });
    expect(
      parseCommand(['bets', 'act', 'LL-123', '--action', 'dispute_readiness', '--note', 'No.']),
    ).toMatchObject({ command: 'bets act', action: 'dispute_readiness', note: 'No.' });
    for (const args of [
      ['bets', 'act'],
      ['bets', 'act', 'LL-123'],
      ['bets', 'act', 'LL-123', '--action', 'teleport'],
      ['bets', 'act', 'LL-123', '--action', 'revise_history'],
      ['bets', 'list', '--action', 'accept'],
      ['bets', 'show', 'LL-123', '--note', 'x'],
      ['bets', 'create', '--winner', 'a'],
    ])
      expect(() => parseCommand(args)).toThrow();
  });
  it('supports read-only API access and bet lookup', () => {
    expect(parseCommand(['api', '/api/ledger', '--json'])).toMatchObject({
      command: 'api',
      argument: '/api/ledger',
      json: true,
    });
    expect(parseCommand(['bets', 'show', 'LL-123'])).toMatchObject({
      command: 'bets show',
      argument: 'LL-123',
    });
  });
  it('parses prices list with its restaurant filter and --all', () => {
    expect(parseCommand(['prices', 'list'])).toMatchObject({ command: 'prices list', all: false });
    expect(
      parseCommand(['prices', 'list', '--restaurant', 'Harbor Shack', '--all', '--json']),
    ).toMatchObject({
      command: 'prices list',
      restaurant: 'Harbor Shack',
      all: true,
      json: true,
    });
    for (const args of [
      ['prices'],
      ['prices', 'add'],
      ['prices', 'list', 'extra'],
      ['bets', 'list', '--restaurant', 'x'],
      ['balances', '--all'],
    ])
      expect(() => parseCommand(args)).toThrow();
  });
});
