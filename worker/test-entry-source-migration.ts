import { readFile } from 'node:fs/promises';

export async function applyEntrySourceMigration(db: D1Database) {
  const sql = await readFile(
    new URL('../migrations/0005_browser_entry_source_backfill.sql', import.meta.url),
    'utf8',
  );
  await db.batch(
    sql
      .split('-- statement-breakpoint')
      .map((statement) => db.prepare(statement.replace(/^--.*$/gm, '').trim())),
  );
}

export async function applyEntrySourceReportMigration(db: D1Database) {
  const sql = await readFile(
    new URL('../migrations/0006_report_negotiable_mcp_source.sql', import.meta.url),
    'utf8',
  );
  await db.batch(
    sql
      .split('-- statement-breakpoint')
      .map((statement) => db.prepare(statement.replace(/^--.*$/gm, '').trim())),
  );
}
