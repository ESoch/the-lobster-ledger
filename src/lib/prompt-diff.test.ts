import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './types';
import { changedRows, diffLines, promptKey, promptTextOf } from './prompt-diff';

const proposed = (version: number, text: string): AuditEvent => ({
  id: `event-${version}`,
  actorId: 'a',
  at: '2026-09-12T06:00:00Z',
  type: 'propose_prompt',
  detail: `Proposed and approved ChatGPT prompt version ${version}. Exact prompt:\n${text}`,
});

describe('prompt version comparison', () => {
  it('reads each version’s exact text from the paper trail', () => {
    const events = [proposed(1, 'First.\nSecond.'), proposed(2, 'First.\nSecond.\nThird.')];
    expect(promptTextOf(events, 1)).toBe('First.\nSecond.');
    expect(promptTextOf(events, 2)).toBe('First.\nSecond.\nThird.');
    expect(promptTextOf(events, 3)).toBeUndefined();
    expect(promptTextOf([{ ...events[0], type: 'accept' }], 1)).toBeUndefined();
  });

  it('marks the lines a revision added and removed, in order', () => {
    expect(diffLines('One\nTwo\nThree', 'One\nTwo and a half\nThree\nFour')).toEqual([
      { kind: 'same', text: 'One' },
      { kind: 'removed', text: 'Two' },
      { kind: 'added', text: 'Two and a half' },
      { kind: 'same', text: 'Three' },
      { kind: 'added', text: 'Four' },
    ]);
  });

  it('finds an inserted block between unchanged lines', () => {
    const lines = diffLines(
      'Intro\n\nEvidence:\nNone yet.\n\nAsk',
      'Intro\n\nEvidence:\nLog line 1\nLog line 2\n\nAsk',
    )!;
    expect(lines.filter((line) => line.kind !== 'same')).toEqual([
      { kind: 'removed', text: 'None yet.' },
      { kind: 'added', text: 'Log line 1' },
      { kind: 'added', text: 'Log line 2' },
    ]);
  });

  it('reports no change for identical text and gives up on texts too long to compare cheaply', () => {
    expect(diffLines('Same\nText', 'Same\nText')!.every((line) => line.kind === 'same')).toBe(true);
    const long = (tag: string) =>
      Array.from({ length: 1500 }, (_, index) => `${tag} line ${index}`).join('\n');
    expect(diffLines(long('a'), long('b'))).toBeNull();
  });

  it('folds each run of unchanged lines into a count', () => {
    expect(changedRows(diffLines('A\nB\nC\nD', 'A\nB\nX\nD')!)).toEqual([
      { kind: 'gap', count: 2 },
      { kind: 'removed', text: 'C' },
      { kind: 'added', text: 'X' },
      { kind: 'gap', count: 1 },
    ]);
  });

  it('treats spacing a reader cannot see as the same wording', () => {
    expect(promptKey('Decide  fairly.   \r\nUse\tthe terms.  ')).toBe(
      promptKey('Decide fairly.\nUse the terms.'),
    );
    expect(promptKey('Decide fairly.')).not.toBe(promptKey('Decide fairly!'));
    const lines = diffLines('One\nTwo three\nFour', 'One  \nTwo   three\nFour\nFive')!;
    expect(lines.filter((line) => line.kind !== 'same')).toEqual([{ kind: 'added', text: 'Five' }]);
  });
});
