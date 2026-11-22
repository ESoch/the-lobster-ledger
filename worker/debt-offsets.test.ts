import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  applyAction,
  applyDebtOffset,
  createBet,
  getDirectDebts,
  previewDebtOffset,
} from '../src/lib/ledger';
import type { Bet, Member } from '../src/lib/types';
import { insertBet, updateBet } from './storage';
import { offsetDebts } from './debt-offsets';
import { readLedger } from './ledger-data';
import { tokenHash } from './security';
import { applyPriceWithdrawMigration } from './test-price-migration';
import app, { type WorkerBindings } from './index';
let mf: Miniflare;
let db: D1Database;
let env: WorkerBindings;
const origin = 'https://ledger.example';
const members: Member[] = ['tammen', 'ellis', 'peter'].map((id) => ({
  id,
  name: id,
  initials: id[0],
  color: '#153b3e',
}));
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
  await applyPriceWithdrawMigration(db);
  await db.exec('CREATE VIEW bet_records AS SELECT id, created_at, data FROM bets');
  const sql = await readFile(
    new URL('../migrations/0007_manual_debt_offsets.sql', import.meta.url),
    'utf8',
  );
  await db.batch(
    sql
      .split('-- statement-breakpoint')
      .map((statement) => db.prepare(statement.replace(/^--.*$/gm, '').trim())),
  );
  for (const member of members) {
    await db
      .prepare(
        'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        member.id,
        member.id,
        member.name,
        `${member.id}@example.com`,
        member.initials,
        member.color,
        new Date().toISOString(),
      )
      .run();
    await db
      .prepare(
        'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .bind(
        await tokenHash(member.id),
        member.id,
        new Date().toISOString(),
        new Date(Date.now() + 3600_000).toISOString(),
      )
      .run();
  }
  env = {
    DB: db,
    APP_ORIGIN: origin,
    GROUP_NAME: 'Test ledger',
    OWNER_EMAIL: 'tammen@example.com',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test-only',
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
});
afterEach(async () => {
  await mf?.dispose();
});
async function pair() {
  const result: Bet[] = [];
  for (const [winnerId, stake] of [
    ['ellis', 2],
    ['tammen', 5],
  ] as const) {
    const at = '2026-10-01T12:00:00Z';
    let bet = createBet(
      {
        title: 'A friendly wager',
        terms: 'The official published result determines the winner.',
        category: 'Life',
        opponentId: 'ellis',
        creatorSide: 'Yes',
        opponentSide: 'No',
        stake,
        deadline: '2026-10-01',
      },
      'tammen',
      members,
      at,
    );
    await insertBet(db, bet);
    for (const [actor, action] of [
      ['ellis', { type: 'accept' }],
      ['tammen', { type: 'propose_result', winnerId, note: 'Official result.' }],
      ['ellis', { type: 'confirm_result' }],
    ] as const) {
      const next = applyAction(bet, action, actor, at);
      await updateBet(db, next, bet.version);
      bet = next;
    }
    result.push(bet);
  }
  return result;
}
const request = (actor: string | undefined, body: unknown, requestOrigin = origin) =>
  app.request(
    `${origin}/api/debt-offsets`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: requestOrigin,
        ...(actor ? { Cookie: `__Host-lobster_session=${actor}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
const count = (table: string) =>
  db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>('count');
const load = async (id: string) =>
  JSON.parse(
    (await db.prepare('SELECT data FROM bets WHERE id = ?').bind(id).first<string>('data'))!,
  ) as Bet;
const insertOffset = (result: ReturnType<typeof applyDebtOffset>) =>
  db
    .prepare(
      'INSERT INTO debt_offsets (id, actor_id, counterparty_id, rolls, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      result.offset.id,
      result.offset.actorId,
      result.offset.counterpartyId,
      result.offset.rolls,
      result.offset.at,
      JSON.stringify(result),
    )
    .run();

describe('D1 manual debt offsets', () => {
  it('commits the operation, both bet events and partial SQL balances together', async () => {
    const bets = await pair();
    const preview = previewDebtOffset(bets, 'tammen', 'ellis')!;
    const response = await request('tammen', preview);
    expect(response.status).toBe(201);
    const result = (await response.json()) as ReturnType<typeof applyDebtOffset>;
    expect(result.offset.actorId).toBe('tammen');
    for (const bet of result.bets) {
      expect(await load(bet.id)).toEqual(bet);
      expect(
        await db
          .prepare('SELECT type FROM events WHERE bet_id = ? ORDER BY version DESC LIMIT 1')
          .bind(bet.id)
          .first('type'),
      ).toBe('offset_debts');
    }
    expect(
      await db
        .prepare('SELECT from_id, to_id, rolls FROM outstanding_obligations WHERE bet_id IN (?, ?)')
        .bind(bets[0].id, bets[1].id)
        .all(),
    ).toMatchObject({ results: [{ from_id: 'ellis', to_id: 'tammen', rolls: 3 }] });
    expect(getDirectDebts(result.bets)).toEqual([{ fromId: 'ellis', toId: 'tammen', rolls: 3 }]);
    const eventCount = await count('events');
    expect((await request('tammen', preview)).status).toBe(409);
    expect(await count('events')).toBe(eventCount);
    await expect(
      db.prepare('UPDATE debt_offsets SET rolls = 1 WHERE id = ?').bind(result.offset.id).run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.prepare('DELETE FROM debt_offsets WHERE id = ?').bind(result.offset.id).run(),
    ).rejects.toThrow(/immutable/);
  });
  it('rejects anonymous, cross-origin, forged actor and third-party requests', async () => {
    const bets = await pair();
    const input = previewDebtOffset((await readLedger(db)).bets, 'tammen', 'ellis')!;
    expect((await request(undefined, input)).status).toBe(401);
    expect((await request('tammen', input, 'https://elsewhere.example')).status).toBe(403);
    expect((await request('tammen', { ...input, actorId: 'ellis' })).status).toBe(400);
    expect((await request('peter', input)).status).toBe(409);
    expect((await load(bets[0].id)).version).toBe(bets[0].version);
  });
  it('rejects a stale bet version at commit time before changing any bet', async () => {
    await pair();
    const bets = (await readLedger(db)).bets;
    const input = previewDebtOffset(bets, 'tammen', 'ellis')!;
    const result = applyDebtOffset(bets, input, 'tammen');
    const changed = bets.find((bet) => bet.id === input.allocations[1].betId)!;
    await updateBet(
      db,
      applyAction(
        changed,
        { type: 'propose_settlement', method: 'roll', note: 'Delivery pending.' },
        'tammen',
      ),
      changed.version,
    );
    const events = await count('events');
    const offsets = await count('debt_offsets');
    await expect(insertOffset(result)).rejects.toThrow(/Offset debts changed/);
    expect(await count('events')).toBe(events);
    expect(await count('debt_offsets')).toBe(offsets);
    const unchanged = result.bets.find((bet) => bet.id !== changed.id)!;
    expect((await load(unchanged.id)).version).toBe(unchanged.version - 1);
  });
  it('rolls back all bets and the operation if an audit append fails', async () => {
    await pair();
    const bets = (await readLedger(db)).bets;
    const input = previewDebtOffset(bets, 'tammen', 'ellis')!;
    const result = applyDebtOffset(bets, input, 'tammen');
    // Force an event ID collision on the last affected bet.
    result.bets.at(-1)!.events.at(-1)!.id = bets[0].events[0].id;
    const events = await count('events');
    const offsets = await count('debt_offsets');
    await expect(insertOffset(result)).rejects.toThrow();
    expect(await count('events')).toBe(events);
    expect(await count('debt_offsets')).toBe(offsets);
    for (const updated of result.bets)
      expect(await load(updated.id)).toEqual(bets.find((bet) => bet.id === updated.id));
  });
  it('allows only one of two overlapping attempts to commit', async () => {
    await pair();
    const input = previewDebtOffset((await readLedger(db)).bets, 'ellis', 'tammen')!;
    const before = await count('debt_offsets');
    const results = await Promise.allSettled([
      offsetDebts(db, 'ellis', input),
      offsetDebts(db, 'ellis', input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await count('debt_offsets')).toBe(before! + 1);
    const state = await readLedger(db);
    const sql = (
      await db
        .prepare(
          'SELECT from_id, to_id, SUM(rolls) AS rolls FROM outstanding_obligations GROUP BY from_id, to_id ORDER BY from_id',
        )
        .all()
    ).results;
    const calculated = getDirectDebts(state.bets)
      .map(({ fromId, toId, rolls }) => ({ from_id: fromId, to_id: toId, rolls }))
      .sort((a, b) => a.from_id.localeCompare(b.from_id));
    expect(sql).toEqual(calculated);
  });
});
