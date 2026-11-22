import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import snapshot from '../data/lobster-market.json';
import type { LobsterMarketHistory } from './lobster-market';

// Mirrors scripts/update_lobster_market.py: the importer's metadata, integer cents and
// continuous completed years from 1950. Only the latest years may be preliminary.
const observation = z.strictObject({
  year: z.number().int(),
  priceCentsPerLb: z.number().int().min(1).max(100_000),
  pounds: z.number().int().positive(),
  landedValueUsd: z.number().int().positive(),
  preliminary: z.boolean(),
});

const marketSnapshot = z
  .strictObject({
    schemaVersion: z.literal(1),
    seriesId: z.literal('maine-dmr-american-lobster'),
    sourceName: z.literal('Maine Department of Marine Resources'),
    sourceUrl: z.literal(
      'https://www.maine.gov/dmr/sites/maine.gov.dmr/files/inline-files/lobster_table.pdf',
    ),
    sourcePageUrl: z.literal(
      'https://www.maine.gov/dmr/fisheries/commercial/landings-program/historical-data',
    ),
    sourceUpdatedOn: z.iso.date(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: z.iso.datetime(),
    checkMethod: z.literal('manual-file').optional(),
    species: z.literal('American lobster'),
    region: z.literal('Maine, United States'),
    currency: z.literal('USD'),
    unit: z.literal('lb'),
    priceBasis: z.literal('ex_vessel'),
    frequency: z.literal('annual'),
    refreshCadence: z.literal('weekly'),
    notes: z.array(z.string().trim().min(1)).min(1),
    observations: z.array(observation).min(1),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    value.observations.forEach((row, index) => {
      if (row.year !== 1950 + index)
        issue(`Expected year ${1950 + index}`, ['observations', index, 'year']);
    });
    const firstPreliminary = value.observations.findIndex((row) => row.preliminary);
    if (
      firstPreliminary >= 0 &&
      value.observations.slice(firstPreliminary).some((row) => !row.preliminary)
    )
      issue('Only the latest years may be preliminary', ['observations']);
    if (value.observations.at(-1)!.year >= Number(value.checkedAt.slice(0, 4)))
      issue('Observations must be completed years', ['observations']);
    if (value.sourceUpdatedOn > value.checkedAt.slice(0, 10))
      issue('The source cannot be published after it was checked', ['sourceUpdatedOn']);
  });

const issues = (value: unknown) => marketSnapshot.safeParse(value).error?.issues ?? [];
const changed = (change: (copy: Record<string, any>) => void, base: unknown = snapshot) => {
  const copy = structuredClone(base) as Record<string, any>;
  change(copy);
  return copy;
};
const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Snapshots a refresh can commit after the bundled one, derived from it so they stay later than it.
const laterSnapshots: [string, Record<string, any>][] = [
  [
    'a hand re-check of the same release',
    changed((copy) => {
      copy.checkedAt = new Date(Date.parse(copy.checkedAt) + 4 * DAY_MS).toISOString();
      copy.checkMethod = 'manual-file';
    }),
  ],
  [
    'a newer release that adds the next year',
    changed((copy) => {
      const last = copy.observations.at(-1);
      const published = Date.parse(`${last.year + 2}-02-05T00:00:00Z`);
      copy.sourceUpdatedOn = isoDay(published);
      copy.checkedAt = new Date(published + 3 * DAY_MS + 14 * 3_600_000).toISOString();
      copy.observations.push({ ...last, year: last.year + 1, preliminary: true });
    }),
  ],
];

describe('bundled lobster market snapshot', () => {
  it('matches the importer schema', () => {
    expect(issues(snapshot)).toEqual([]);
    const typed: LobsterMarketHistory = marketSnapshot.parse(snapshot);
    expect(typed.observations.length).toBeGreaterThan(0);
  });

  it('accepts a check made from a manually downloaded file', () => {
    expect(issues(changed((copy) => (copy.checkMethod = 'manual-file')))).toEqual([]);
  });

  const rejected: [string, (copy: Record<string, any>) => void][] = [
    ['a missing year', (copy) => copy.observations.splice(10, 1)],
    ['a series that does not start in 1950', (copy) => copy.observations.shift()],
    ['fractional cents', (copy) => (copy.observations[0].priceCentsPerLb = 35.5)],
    ['zero cents', (copy) => (copy.observations[0].priceCentsPerLb = 0)],
    ['pounds as text', (copy) => (copy.observations[0].pounds = '18352600')],
    ['a non-boolean preliminary flag', (copy) => (copy.observations[0].preliminary = 'false')],
    ['a final year after a preliminary one', (copy) => (copy.observations[0].preliminary = true)],
    ['an unknown observation field', (copy) => (copy.observations[0].adjusted = 1)],
    ['an unknown top-level field', (copy) => (copy.retainedAt = copy.checkedAt)],
    ['a missing checksum', (copy) => delete copy.sourceSha256],
    ['an unknown check method', (copy) => (copy.checkMethod = 'automatic')],
    ['a check time without a time zone', (copy) => (copy.checkedAt = '2026-10-15T17:56:57')],
    ['another schema version', (copy) => (copy.schemaVersion = 2)],
  ];
  // Derived from the snapshot's own check time, so each fails for exactly this reason in any snapshot.
  const rejectedForDates: [string, (copy: Record<string, any>) => void, string][] = [
    [
      'a source published after the check',
      (copy) => (copy.sourceUpdatedOn = isoDay(Date.parse(copy.checkedAt) + DAY_MS)),
      'The source cannot be published after it was checked',
    ],
    [
      'an observation for an unfinished year',
      (copy) => {
        const last = copy.observations.at(-1);
        for (let year = last.year + 1; year <= Number(copy.checkedAt.slice(0, 4)); year++)
          copy.observations.push({ ...last, year, preliminary: true });
      },
      'Observations must be completed years',
    ],
  ];

  it.each(rejected)('rejects %s', (_label, change) => {
    expect(issues(changed(change))).not.toEqual([]);
  });

  it.each(rejectedForDates)('rejects %s', (_label, change, message) => {
    expect(issues(changed(change)).map((issue) => issue.message)).toEqual([message]);
  });

  describe.each(laterSnapshots)('after %s', (_name, later) => {
    it('matches the importer schema', () => {
      expect(issues(later)).toEqual([]);
    });

    it.each(rejected)('rejects %s', (_label, change) => {
      expect(issues(changed(change, later))).not.toEqual([]);
    });

    it.each(rejectedForDates)('rejects %s', (_label, change, message) => {
      expect(issues(changed(change, later)).map((issue) => issue.message)).toEqual([message]);
    });
  });
});
