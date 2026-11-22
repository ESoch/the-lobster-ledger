import { HTTPException } from 'hono/http-exception';
import { applyAction, createBet } from '../src/lib/ledger';
import type { Bet, Member, NewBet } from '../src/lib/types';
import { hashSecret } from './cli-crypto';
import { memberColumns } from './storage';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

interface Receipt {
  request_hash: string;
  request_nonce: string;
  response_json: string;
}

export async function createCliBet(
  db: D1Database,
  actor: string,
  key: string | undefined,
  input: { bet: NewBet; prompt?: string },
  entrySource: 'cli' | 'mcp',
) {
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new HTTPException(400, {
      message: 'Provide an Idempotency-Key of 16–128 letters, numbers, underscores or hyphens.',
    });
  }
  const requestHash = await hashSecret(JSON.stringify(canonical(input)));
  const readReceipt = () =>
    db
      .prepare(
        'SELECT request_hash, request_nonce, response_json FROM cli_bet_requests WHERE member_id = ? AND request_key = ?',
      )
      .bind(actor, key)
      .first<Receipt>();
  const response = (receipt: Receipt, nonce?: string) => {
    if (receipt.request_hash !== requestHash)
      throw new HTTPException(409, {
        message:
          'This Idempotency-Key was already used for different bet details. Use the original details to retry, or choose a new key for a new bet.',
      });
    return {
      bet: JSON.parse(receipt.response_json) as Bet,
      created: receipt.request_nonce === nonce,
    };
  };
  const existing = await readReceipt();
  if (existing) return response(existing);
  const members = (await db.prepare(`SELECT ${memberColumns} FROM members`).all<Member>()).results;
  let initial: Bet;
  let final: Bet;
  try {
    initial = createBet(input.bet, actor, members, undefined, entrySource);
    if (input.prompt && input.bet.history)
      throw new Error('Confirm the imported history before proposing a new ChatGPT prompt.');
    final = input.prompt
      ? applyAction(initial, { type: 'propose_prompt', text: input.prompt }, actor)
      : initial;
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : 'Invalid bet.',
    });
  }
  const nonce = crypto.randomUUID();
  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO cli_bet_requests (member_id, request_key, request_hash, request_nonce, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(actor, key, requestHash, nonce, JSON.stringify(final), final.createdAt),
    db
      .prepare(
        `INSERT INTO bets (id, reference, creator_id, opponent_id, winner_id, stake, status, version, created_at, updated_at, data)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM cli_bet_requests WHERE member_id = ? AND request_key = ? AND request_nonce = ?`,
      )
      .bind(
        initial.id,
        initial.reference,
        initial.creatorId,
        initial.opponentId,
        initial.resolution?.winnerId ?? null,
        initial.stake,
        initial.status,
        initial.version,
        initial.createdAt,
        initial.updatedAt,
        JSON.stringify(initial),
        actor,
        key,
        nonce,
      ),
  ];
  if (input.prompt) {
    statements.push(
      db
        .prepare(
          `UPDATE bets SET version = ?, updated_at = ?, data = ?
      WHERE id = ? AND version = 1 AND EXISTS (SELECT 1 FROM cli_bet_requests WHERE member_id = ? AND request_key = ? AND request_nonce = ?)`,
        )
        .bind(final.version, final.updatedAt, JSON.stringify(final), initial.id, actor, key, nonce),
    );
  }
  // Claim, insertion, prompt proposal and audit triggers commit together. Retry
  // receipts intentionally never expire: a delayed offline retry stays safe.
  await db.batch(statements);
  const receipt = await readReceipt();
  if (!receipt) throw new Error('CLI wager receipt was not persisted.');
  return response(receipt, nonce);
}
