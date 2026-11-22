import { HTTPException } from 'hono/http-exception';
import { applyAction } from '../src/lib/ledger';
import type { Bet } from '../src/lib/types';
import { actionSchema } from './security';
import { z } from 'zod';
import { updateBet } from './storage';

/** Actions the appointed judge may take on their own bet. */
const judgeActions = ['adjudicate', 'decline_judging'];

export async function actOnBet(
  db: D1Database,
  actor: string,
  id: string,
  input: { action: z.infer<typeof actionSchema>; version: number },
): Promise<Bet> {
  const row = await db
    .prepare('SELECT data FROM bet_records WHERE id = ?')
    .bind(id)
    .first<{ data: string }>();
  if (!row) throw new HTTPException(404, { message: 'That bet could not be found.' });
  const bet = JSON.parse(row.data) as Bet;
  const isBettor = [bet.creatorId, bet.opponentId].includes(actor);
  const isAppointedJudge =
    judgeActions.includes(input.action.type) &&
    bet.decisionMethod === 'judge' &&
    bet.judgeId === actor;
  if (!isBettor && !isAppointedJudge)
    throw new HTTPException(403, {
      message:
        'Only the bettors, or the appointed judge recording a recommendation, can take this action.',
    });
  if (bet.version !== input.version)
    throw new HTTPException(409, { message: 'This bet changed. Refresh it before confirming.' });
  // The rules engine has no member list; a newly named judge must be a registered member.
  if (input.action.type === 'propose_amendment' && input.action.judgeId !== undefined) {
    const member = await db
      .prepare('SELECT id FROM members WHERE id = ?')
      .bind(input.action.judgeId)
      .first();
    if (!member)
      throw new HTTPException(400, {
        message: 'Choose another registered member as the independent judge.',
      });
  }
  let next: Bet;
  try {
    next = applyAction(bet, input.action, actor);
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : 'Invalid action.',
    });
  }
  await updateBet(db, next, input.version);
  return next;
}
