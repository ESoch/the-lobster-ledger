import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const adjudication = read('./adjudication.css');
const theme = read('./theme.css');
const placesMap = read('./components/places-map.css');
const styles = read('./styles.css');

function rule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}
const declared = (source: string, selector: string, property: string) =>
  rule(source, selector)
    .match(new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`))?.[1]
    ?.trim();

function channels(color: string) {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
}
function luminance(color: string) {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('map loading placeholder', () => {
  it('stays readable on every background it can sit on in the light theme', () => {
    const text = declared(adjudication, '.map-loading', 'color')!;
    // Its own fill, and the fill .places-map gives it once the map stylesheet arrives.
    for (const background of [
      declared(adjudication, '.map-loading', 'background')!,
      declared(placesMap, '.places-map', 'background')!,
    ])
      expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('stays readable in the dark theme', () => {
    expect(declared(adjudication, "html[data-theme='dark'] .map-loading", 'color')).toBe(
      'var(--muted)',
    );
    const token = (name: string) => declared(theme, "html[data-theme='dark']", name)!;
    // Its panel fill, and the map fill that applies once the map stylesheet arrives.
    for (const background of [token('--surface-raised'), token('--surface-inset')])
      expect(contrast(token('--muted'), background)).toBeGreaterThanOrEqual(4.5);
    expect(
      declared(theme, "html[data-theme='dark'] :is(.places-map, .places-map-canvas)", 'background'),
    ).toBe('var(--surface-inset)');
  });

  it('is sized by the same rules as the map in each layout', () => {
    expect(declared(styles, '.full-map-panel .places-map', 'height')).toBe('100%');
    expect(declared(adjudication, '.map-loading-compact', 'height')).toBe('100%');
  });
});
