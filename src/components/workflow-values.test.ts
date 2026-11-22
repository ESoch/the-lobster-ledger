import { describe, expect, it } from 'vitest';
import { localDateTimeToIso, zonedInputValue } from './workflow-values';

describe('timezone-aware form values', () => {
  it('interprets the entered time in the chosen timezone, independently of the browser zone', () => {
    expect(localDateTimeToIso('2026-07-15T09:30', 'America/Los_Angeles')).toBe(
      '2026-07-15T16:30:00.000Z',
    );
    expect(localDateTimeToIso('2026-01-15T09:30', 'America/Los_Angeles')).toBe(
      '2026-01-15T17:30:00.000Z',
    );
    expect(localDateTimeToIso('2026-09-12T00:15', 'Asia/Tokyo')).toBe('2026-09-11T15:15:00.000Z');
  });

  it('restores the same wall-clock time while editing an existing date', () => {
    expect(zonedInputValue('2026-09-11T15:15:00.000Z', 'Asia/Tokyo')).toBe('2026-09-12T00:15');
    expect(zonedInputValue('2026-09-12T09:00:00.000Z', 'UTC')).toBe('2026-09-12T09:00');
  });

  it('rejects nonexistent and ambiguous daylight-saving times instead of changing the agreement', () => {
    expect(() => localDateTimeToIso('2026-03-08T02:30', 'America/Los_Angeles')).toThrow(
      /does not exist/,
    );
    expect(() => localDateTimeToIso('2026-11-01T01:30', 'America/Los_Angeles')).toThrow(
      /occurs twice/,
    );
  });

  it('turns away a year outside 2000 to 2100 in plain words, never a raw range error', () => {
    for (const value of [
      '0001-01-01T00:00',
      '1999-12-31T23:59',
      '2101-01-01T00:00',
      '9999-12-31T23:59',
      // Some browsers let a date go past four digits.
      '10000-01-01T00:00',
      '275760-09-13T00:00',
    ])
      for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])
        expect(() => localDateTimeToIso(value, zone), `${value} ${zone}`).toThrow(
          'Choose a date between 2000 and 2100.',
        );
    expect(localDateTimeToIso('2000-01-01T00:00', 'UTC')).toBe('2000-01-01T00:00:00.000Z');
    expect(localDateTimeToIso('2100-12-31T23:59', 'UTC')).toBe('2100-12-31T23:59:00.000Z');
  });

  it('rejects an invalid date or timezone with a useful field error', () => {
    expect(() => localDateTimeToIso('', 'UTC')).toThrow(/date and time/);
    expect(() => localDateTimeToIso('2026-02-30T09:00', 'UTC')).toThrow(/valid date/);
    expect(() => localDateTimeToIso('2026-09-12T09:00', 'Mars')).toThrow(/timezone/);
  });
});
