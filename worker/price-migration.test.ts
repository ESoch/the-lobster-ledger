import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { applyPriceWithdrawMigration } from './test-price-migration';

let mf: Miniflare;
let db: D1Database;

const insert = (id: string, extra: Record<string, string> = {}) => {
  const columns = [
    'id',
    'restaurant_id',
    'item_name',
    'price_cents',
    'visit_date',
    'visit_date_precision',
    'reporter_id',
    'reported_at',
    ...Object.keys(extra),
  ];
  return db
    .prepare(
      `INSERT INTO price_observations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .bind(
      id,
      'shack',
      'Classic lobster roll',
      2800,
      '2026-09-11',
      'day',
      'ellis',
      '2026-09-11T20:00:00.000Z',
      ...Object.values(extra),
    )
    .run();
};
const row = (id: string) =>
  db
    .prepare('SELECT * FROM price_observations WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-09-12',
      d1Databases: ['DB'],
    }),
  );
  db = await mf.getD1Database('DB');
  for (const file of ['0001_ledger.sql', '0002_roll_prices.sql'])
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  await db
    .prepare(
      "INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES ('ellis', 'ellis', 'Ellis', 'ellis@example.com', 'E', '#153b3e', '2026-09-01T00:00:00.000Z')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO restaurants (id, name, address, created_by, created_at) VALUES ('shack', 'Harbor Shack', '', 'ellis', '2026-09-01T00:00:00.000Z')",
    )
    .run();
  // A report already on the record when the migration runs, as in production.
  await insert('before');
  await applyPriceWithdrawMigration(db);
});
afterEach(async () => {
  await mf?.dispose();
});

describe('migration 0008', () => {
  it('keeps existing reports live and counts them as entered on the website', async () => {
    expect(await row('before')).toMatchObject({
      price_cents: 2800,
      withdrawn_at: null,
      withdrawn_reason: null,
      correction_reason: null,
      entry_source: 'web',
      corrected_at: null,
    });
  });

  it('takes only the website and MCP as where a report came from', async () => {
    await insert('mcp', { entry_source: 'mcp' });
    expect((await row('mcp'))?.entry_source).toBe('mcp');
    await expect(insert('cli', { entry_source: 'cli' })).rejects.toThrow();
  });

  it('never deletes a report', async () => {
    await expect(
      db.prepare("DELETE FROM price_observations WHERE id = 'before'").run(),
    ).rejects.toThrow(/kept on record/);
    expect(await row('before')).not.toBeNull();
  });

  it.each([
    ['the price', 'price_cents = 2900'],
    ['the item', "item_name = 'Connecticut roll'"],
    ['the visit date', "visit_date = '2026-09-12'"],
    ['the reporter', "reporter_id = 'someone'"],
    ['the note', "note = 'edited'"],
    ['where it came from', "entry_source = 'mcp'"],
    ['the correction reason', "correction_reason = 'edited'"],
    ['a withdrawal without a reason', "withdrawn_at = '2026-10-01T00:00:00.000Z'"],
    ['a withdrawal reason without a time', "withdrawn_reason = 'Wrong place'"],
  ])('refuses to change %s', async (_case, assignment) => {
    await expect(
      db.prepare(`UPDATE price_observations SET ${assignment} WHERE id = 'before'`).run(),
    ).rejects.toThrow(/append-only/);
  });

  it('stamps a correction once, and never takes the stamp back', async () => {
    await db
      .prepare(
        "UPDATE price_observations SET corrected_at = '2026-10-01T00:00:00.000Z' WHERE id = 'before'",
      )
      .run();
    expect((await row('before'))?.corrected_at).toBe('2026-10-01T00:00:00.000Z');
    for (const value of ["'2026-10-02T00:00:00.000Z'", 'NULL'])
      await expect(
        db
          .prepare(`UPDATE price_observations SET corrected_at = ${value} WHERE id = 'before'`)
          .run(),
      ).rejects.toThrow(/append-only/);
  });

  it('withdraws a report once, with its reason, and keeps both', async () => {
    await db
      .prepare(
        "UPDATE price_observations SET withdrawn_at = '2026-10-01T00:00:00.000Z', withdrawn_reason = 'Wrong restaurant' WHERE id = 'before'",
      )
      .run();
    expect(await row('before')).toMatchObject({
      withdrawn_at: '2026-10-01T00:00:00.000Z',
      withdrawn_reason: 'Wrong restaurant',
    });
    for (const assignment of [
      "withdrawn_reason = 'Another reason'",
      "withdrawn_at = '2026-10-02T00:00:00.000Z'",
      'withdrawn_at = NULL, withdrawn_reason = NULL',
    ])
      await expect(
        db.prepare(`UPDATE price_observations SET ${assignment} WHERE id = 'before'`).run(),
      ).rejects.toThrow(/append-only/);
  });

  it('never lets one report be both corrected and withdrawn', async () => {
    await insert('corrected', { corrected_at: '2026-10-01T00:00:00.000Z' });
    await expect(
      db
        .prepare(
          "UPDATE price_observations SET withdrawn_at = '2026-10-02T00:00:00.000Z', withdrawn_reason = 'x' WHERE id = 'corrected'",
        )
        .run(),
    ).rejects.toThrow(/append-only/);
    await insert('withdrawn', {
      withdrawn_at: '2026-10-01T00:00:00.000Z',
      withdrawn_reason: 'Wrong restaurant',
    });
    await expect(
      db
        .prepare(
          "UPDATE price_observations SET corrected_at = '2026-10-02T00:00:00.000Z' WHERE id = 'withdrawn'",
        )
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it('gives a report at most one successor', async () => {
    await insert('first-successor', { corrected_from_id: 'before' });
    await expect(insert('second-successor', { corrected_from_id: 'before' })).rejects.toThrow(
      /UNIQUE/,
    );
    // Reports that correct nothing are not limited.
    await insert('plain-one');
    await insert('plain-two');
  });
});
