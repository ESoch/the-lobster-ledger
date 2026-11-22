import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits';
import {
  MEMBER_NAME_BLANK,
  MEMBER_NAME_TOO_LONG,
  memberNameProblem,
  normalizeMemberName,
  uniqueMemberName,
} from './member-name';

const members = [{ name: 'Ellis' }, { name: 'Alex' }, { name: 'Ölaf Ünder' }];

describe('normalizeMemberName', () => {
  it('trims the ends and collapses every run of whitespace to one space', () => {
    expect(normalizeMemberName('  jamie   chen  ')).toBe('jamie chen');
    expect(normalizeMemberName('Jamie\t\nChen')).toBe('Jamie Chen');
    expect(normalizeMemberName('Jamie  Chen')).toBe('Jamie Chen');
  });
  it('leaves a name that is already clean as it is', () => {
    expect(normalizeMemberName('Jamie Chen')).toBe('Jamie Chen');
  });
  it('turns a name of only whitespace into an empty string', () => {
    expect(normalizeMemberName(' \n\t ')).toBe('');
  });
});

describe('memberNameProblem', () => {
  it('asks for a name, in those words, when it is empty or only whitespace', () => {
    expect(memberNameProblem('', members)).toBe(MEMBER_NAME_BLANK);
    expect(memberNameProblem('   ', members)).toBe(MEMBER_NAME_BLANK);
    expect(memberNameProblem(' \n\t ', members)).toBe(MEMBER_NAME_BLANK);
    expect(MEMBER_NAME_BLANK).toBe('Enter a name.');
  });
  it('speaks of length only for a name that is too long', () => {
    expect(MEMBER_NAME_TOO_LONG).toBe(`Use ${LIMITS.memberName.max} characters or fewer.`);
    expect(MEMBER_NAME_TOO_LONG).not.toMatch(/between|\b1\b/);
    expect(memberNameProblem('x'.repeat(LIMITS.memberName.max + 1), members)).toBe(
      MEMBER_NAME_TOO_LONG,
    );
  });
  it('lets a one-letter name through, since a name can be an initial or a single character', () => {
    expect(memberNameProblem('A', members)).toBeUndefined();
  });
  it('measures the limit on the cleaned name, so padding neither satisfies nor breaks it', () => {
    const longest = 'x'.repeat(LIMITS.memberName.max);
    expect(memberNameProblem(longest, [])).toBeUndefined();
    expect(memberNameProblem(`  ${longest}  `, [])).toBeUndefined();
    expect(memberNameProblem(`${longest}x`, [])).toBe(MEMBER_NAME_TOO_LONG);
    expect(memberNameProblem(`a ${' '.repeat(40)} b`, [])).toBeUndefined();
  });
  it('rejects a value that is not text', () => {
    expect(memberNameProblem(undefined, [])).toBe(MEMBER_NAME_BLANK);
    expect(memberNameProblem(7, [])).toBe(MEMBER_NAME_BLANK);
  });
  it('turns away a name already at the table in any case or spacing, and names who has it', () => {
    expect(memberNameProblem('alex', members)).toBe('Someone named Alex is already at the table.');
    expect(memberNameProblem('  ALEX ', members)).toBe(
      'Someone named Alex is already at the table.',
    );
    expect(memberNameProblem('ellis', members)).toBe(
      'Someone named Ellis is already at the table.',
    );
  });
  it('compares accented names by what they look like, composed or not', () => {
    expect(memberNameProblem('Ölaf   Ünder', members)).toBe(
      'Someone named Ölaf Ünder is already at the table.',
    );
  });
  it('accepts a different name, including one that only starts like an existing one', () => {
    expect(memberNameProblem('Alexandra', members)).toBeUndefined();
    expect(memberNameProblem('Alex C.', members)).toBeUndefined();
  });
});

describe('uniqueMemberName', () => {
  const taken = ['Ellis', 'Alex', 'Alex (2)', 'Ölaf Ünder'];
  it('keeps a free name, cleaned', () => {
    expect(uniqueMemberName('  Sam   Lee ', taken)).toBe('Sam Lee');
  });
  it('numbers a name a member already goes by, in any case, spacing or composition', () => {
    expect(uniqueMemberName('ellis', taken)).toBe('ellis (2)');
    expect(uniqueMemberName('  Ölaf   Ünder ', taken)).toBe('Ölaf Ünder (2)');
  });
  it('counts on past a number that is taken too', () => {
    expect(uniqueMemberName('Alex', taken)).toBe('Alex (3)');
  });
  it('shortens the base so the numbered name stays within the length limit', () => {
    const longest = 'x'.repeat(LIMITS.memberName.max);
    const numbered = uniqueMemberName(longest, [longest]);
    expect(numbered).toHaveLength(LIMITS.memberName.max);
    expect(numbered.endsWith(' (2)')).toBe(true);
    expect(memberNameProblem(numbered, [{ name: longest }])).toBeUndefined();
  });
});
