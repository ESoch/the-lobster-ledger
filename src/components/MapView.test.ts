import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MapView } from './MapView';

describe('map loading placeholder', () => {
  it('takes the same size class as the map it stands in for, so nothing jumps when it loads', () => {
    const preview = renderToString(createElement(MapView, { places: [], bets: [], compact: true }));
    expect(preview).toContain('map-loading');
    expect(preview).toContain('places-map--compact');
    const full = renderToString(createElement(MapView, { places: [], bets: [] }));
    expect(full).toContain('map-loading');
    expect(full).not.toContain('places-map--compact');
  });

  it('announces itself as a status', () => {
    const html = renderToString(createElement(MapView, { places: [], bets: [] }));
    expect(html).toMatch(/role="status"/);
    expect(html).toContain('Loading places');
  });
});
