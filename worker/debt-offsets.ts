import { HTTPException } from 'hono/http-exception';
import { applyDebtOffset } from '../src/lib/ledger';
import type { DebtOffsetPreview } from '../src/lib/types';
import { readLedger } from './ledger-data';

export async function offsetDebts(db: D1Database, actorId: string, input: DebtOffsetPreview) {
  const { bets } = await readLedger(db);
  let result: ReturnType<typeof applyDebtOffset>;
  try {
    result = applyDebtOffset(bets, input, actorId);
  } catch (error) {
    throw new HTTPException(409, {
      message: error instanceof Error ? error.message : 'Review a fresh offset preview.',
    });
  }
  try {
    // The migration's trigger checks all versions first, then applies the entire
    // offset and appends the existing per-bet audit records in one SQL statement.
    await db
      .prepare(
        'INSERT INTO debt_offsets (id, actor_id, counterparty_id, rolls, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        result.offset.id,
        actorId,
        input.counterpartyId,
        result.offset.rolls,
        result.offset.at,
        JSON.stringify(result),
      )
      .run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('Offset debts changed'))
      throw new HTTPException(409, { message: 'Debts changed. Review a fresh offset preview.' });
    throw error;
  }
  return result;
}
