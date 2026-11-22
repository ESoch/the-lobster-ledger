// Shared by the app and the worker: the colours a member's avatar can wear, the text that stays legible
// on each, and the initials drawn on it. Pure functions, no DOM.

export const LIGHT_INK = '#ffffff';
export const DARK_INK = '#1f3a38';
/** The tint an avatar falls back to when its stored colour cannot be read. */
const NEUTRAL = '#dde7e5';
/** WCAG AA for text under 18px (or 14px bold). Initials are small, so they get the full 4.5:1. */
const AA = 4.5;

/** Every colour carries white initials at 4.5:1 or better, so none of them is ever darkened at draw time. */
export const AVATAR_PALETTE: readonly string[] = [
  '#315b54', // teal
  '#9a5f40', // copper
  '#746089', // plum
  '#567582', // slate
  '#8a6532', // amber
  '#687945', // olive
  '#a04a5a', // rose
  '#3d6a99', // blue
];

const parseHex = (color: string | undefined): [number, number, number] | null => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? '');
  if (!match) return null;
  const hex =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : match[1];
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
};
const toHex = (rgb: number[]) =>
  `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

const luminance = (rgb: number[]) => {
  const [red, green, blue] = rgb
    .map((channel) => channel / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

/** WCAG contrast ratio between two `#rgb` / `#rrggbb` colours, 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [first, second]
    .map((color) => luminance(parseHex(color) ?? [0, 0, 0]))
    .sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * White when it reaches 4.5:1 on `background`, the dark ink otherwise. A mid-tone that neither ink
 * reaches 4.5:1 on gets the dark ink here and is darkened by `avatarColors` before it is drawn.
 */
export function textColorFor(background: string): string {
  return contrastRatio(LIGHT_INK, background) >= AA ? LIGHT_INK : DARK_INK;
}

/**
 * The background and text an avatar is drawn with. The stored colour is kept whenever an ink reaches
 * 4.5:1 on it; a mid-tone that neither does is darkened, keeping its hue, until white does.
 */
export function avatarColors(stored: string | undefined): { background: string; color: string } {
  const start = parseHex(stored) ? (stored as string).toLowerCase() : NEUTRAL;
  const color = textColorFor(start);
  if (contrastRatio(color, start) >= AA) return { background: start, color };
  let rgb = parseHex(start) as number[];
  for (let step = 0; step < 100 && contrastRatio(LIGHT_INK, toHex(rgb)) < AA; step++)
    rgb = rgb.map((channel) => channel * 0.98);
  return { background: toHex(rgb), color: LIGHT_INK };
}

// FNV-1a: small, stable across runtimes, and well spread for short ids.
const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

/**
 * The palette colour for a member id: `hash(id) % PALETTE.length`, so the same id always wears the same
 * colour. When `taken` (the colours already worn in the group) holds that colour, the next unused one
 * is chosen instead, so a small group never shares a colour while the palette has one to spare.
 */
export function avatarColorFor(id: string, taken: readonly string[] = []): string {
  const start = hash(id) % AVATAR_PALETTE.length;
  const worn = new Set(taken.map((color) => color.toLowerCase()));
  for (let offset = 0; offset < AVATAR_PALETTE.length; offset++) {
    const color = AVATAR_PALETTE[(start + offset) % AVATAR_PALETTE.length];
    if (!worn.has(color)) return color;
  }
  return AVATAR_PALETTE[start];
}

/**
 * The first letter of the first two names. A name with no letter or number in it (an emoji, "&") is
 * skipped, and a character outside the basic plane is taken whole, never as half a surrogate pair.
 */
export function initialsFor(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((part) => Array.from(part).find((char) => /^[\p{L}\p{N}]$/u.test(char)))
    .filter((char): char is string => char !== undefined)
    .slice(0, 2);
  return letters.length ? letters.join('').toUpperCase() : '?';
}
