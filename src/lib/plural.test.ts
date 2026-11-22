import { describe, expect, it } from 'vitest';
import { plural, pluralNoBreak } from './plural';

describe('plural', () => {
  it('keeps one as a singular noun', () => {
    expect(plural(1, 'roll')).toBe('1 roll');
    expect(plural(1, 'bet')).toBe('1 bet');
  });

  it('adds an s for zero and for more than one', () => {
    expect(plural(0, 'roll')).toBe('0 rolls');
    expect(plural(2, 'bet')).toBe('2 bets');
    expect(plural(15, 'action')).toBe('15 actions');
  });

  it('takes an irregular plural when the noun needs one', () => {
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(3, 'person', 'people')).toBe('3 people');
  });

  it('treats negative one as singular so a net of -1 reads "-1 roll"', () => {
    expect(plural(-1, 'roll')).toBe('-1 roll');
    expect(plural(-2, 'roll')).toBe('-2 rolls');
  });
});

describe('pluralNoBreak', () => {
  it('is plural with a no-break space, so a narrow line never ends on the bare number', () => {
    expect(pluralNoBreak(1, 'roll')).toBe('1\u00a0roll');
    expect(pluralNoBreak(2, 'roll')).toBe('2\u00a0rolls');
    expect(pluralNoBreak(-2, 'roll')).toBe('-2\u00a0rolls');
    expect(pluralNoBreak(3, 'person', 'people')).toBe('3\u00a0people');
  });

  it('reads as the same words as plural once the space is normalised', () => {
    for (const count of [-1, 0, 1, 2, 40])
      expect(pluralNoBreak(count, 'day').replace('\u00a0', ' ')).toBe(plural(count, 'day'));
  });

  it('keeps a two-word noun breakable between its own words', () => {
    expect(pluralNoBreak(2, 'confirmed win')).toBe('2\u00a0confirmed wins');
  });
});
