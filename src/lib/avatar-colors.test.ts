import { describe, expect, it } from 'vitest';
import {
  AVATAR_PALETTE,
  DARK_INK,
  LIGHT_INK,
  avatarColorFor,
  avatarColors,
  contrastRatio,
  initialsFor,
  textColorFor,
} from './avatar-colors';

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The audit measured these two demo colours with white initials.
    expect(contrastRatio('#ffffff', '#a56848')).toBeCloseTo(4.49, 2);
    expect(contrastRatio('#ffffff', '#987044')).toBeCloseTo(4.43, 2);
  });

  it('reads three-digit hex and ignores the order of the arguments', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#315b54', '#fff')).toBeCloseTo(contrastRatio('#fff', '#315b54'), 10);
  });
});

describe('textColorFor', () => {
  it('uses white on a background that carries it at 4.5:1 and the dark ink otherwise', () => {
    expect(textColorFor('#315b54')).toBe(LIGHT_INK);
    expect(textColorFor('#e1e8db')).toBe(DARK_INK);
    // 4.49:1 with white: one hundredth short, so white is not trusted.
    expect(textColorFor('#a56848')).toBe(DARK_INK);
  });
});

describe('avatarColors', () => {
  it('keeps a background the text colour already carries', () => {
    expect(avatarColors('#315b54')).toEqual({ background: '#315b54', color: LIGHT_INK });
    expect(avatarColors('#e1e8db')).toEqual({ background: '#e1e8db', color: DARK_INK });
  });

  it('darkens a mid-tone that neither ink reaches 4.5:1 on, rather than shipping weak initials', () => {
    // 4.49:1 with white and only 2.72:1 with the dark ink.
    const { background, color } = avatarColors('#a56848');
    expect(background).not.toBe('#a56848');
    expect(color).toBe(LIGHT_INK);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    // It stays the same family: only the lightness moves, and not by much.
    expect(contrastRatio('#a56848', background)).toBeLessThan(1.15);
  });

  it('falls back to the neutral tint for a colour it cannot read', () => {
    for (const bad of ['', 'teal', '#12', 'rgb(1,2,3)', undefined]) {
      const { background, color } = avatarColors(bad);
      expect(background).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('AVATAR_PALETTE', () => {
  it('has enough distinct colours for a small group', () => {
    expect(AVATAR_PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AVATAR_PALETTE).size).toBe(AVATAR_PALETTE.length);
  });

  it.each(AVATAR_PALETTE.map((color) => [color]))(
    '%s reaches 4.5:1 with its chosen text colour without being darkened',
    (color) => {
      expect(contrastRatio(textColorFor(color), color)).toBeGreaterThanOrEqual(4.5);
      expect(avatarColors(color).background).toBe(color);
    },
  );
});

describe('avatarColorFor', () => {
  it('always gives the same palette colour to the same id', () => {
    for (const id of ['ellis', 'alex', 'c9f0c4ce-7e1e-4cb1-b8a7-0a2f6d6a2d11', '']) {
      expect(AVATAR_PALETTE).toContain(avatarColorFor(id));
      expect(avatarColorFor(id)).toBe(avatarColorFor(id));
    }
  });

  it('spreads ids across the palette', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `member-${index}`);
    const used = new Set(ids.map((id) => avatarColorFor(id)));
    expect(used.size).toBeGreaterThanOrEqual(AVATAR_PALETTE.length - 1);
  });

  it('moves to the next unused colour when the first choice is already worn in the group', () => {
    const first = avatarColorFor('alex');
    const second = avatarColorFor('alex', [first]);
    expect(second).not.toBe(first);
    expect(AVATAR_PALETTE).toContain(second);
    // Eight members in a group of eight colours all differ.
    const group: string[] = [];
    for (let index = 0; index < AVATAR_PALETTE.length; index++)
      group.push(avatarColorFor(`person-${index}`, group));
    expect(new Set(group).size).toBe(AVATAR_PALETTE.length);
  });

  it('repeats the first choice once every colour is taken', () => {
    expect(avatarColorFor('alex', AVATAR_PALETTE)).toBe(avatarColorFor('alex'));
  });

  it('ignores colours that are not in the palette', () => {
    expect(avatarColorFor('alex', ['#153b3e', '#e1e8db'])).toBe(avatarColorFor('alex'));
  });
});

describe('initialsFor', () => {
  it('takes the first letter of the first two names', () => {
    expect(initialsFor('Pat Smith')).toBe('PS');
    expect(initialsFor('  pat   o’brien  ')).toBe('PO');
    expect(initialsFor('Ana María Gómez')).toBe('AM');
    expect(initialsFor('Sam')).toBe('S');
  });

  it('skips a name made only of symbols and never splits an emoji', () => {
    expect(initialsFor('🦞 Pat')).toBe('P');
    expect(initialsFor('🦞Pat Smith')).toBe('PS');
    expect(initialsFor('Pat 🦞')).toBe('P');
    expect(initialsFor('Dr. & Mrs. Lee')).toBe('DM');
    expect(initialsFor('李雷 韩梅梅')).toBe('李韩');
  });

  it('is never empty and never a lone surrogate', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
    expect(initialsFor('🦞🦞')).toBe('?');
    expect(initialsFor('\u{1d504}lex')).toBe('\u{1d504}');
  });
});
