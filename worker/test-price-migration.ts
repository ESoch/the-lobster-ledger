import { readFile } from 'node:fs/promises';

/** Applies migration 0008 the way D1 does: one statement at a time, in one batch. */
export async function applyPriceWithdrawMigration(db: D1Database) {
  const sql = await readFile(
    new URL('../migrations/0008_price_withdraw.sql', import.meta.url),
    'utf8',
  );
  await db.batch(
    sql
      .split('-- statement-breakpoint')
      .map((statement) => db.prepare(statement.replace(/^--.*$/gm, '').trim())),
  );
}
