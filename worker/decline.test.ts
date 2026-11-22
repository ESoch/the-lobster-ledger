import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type { Bet, BetAction, NewBet } from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import { tokenHash } from './security';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

let mf: Miniflare;
let env: WorkerBindings;
const origin = 'https://ledger.example';
const input = (overrides: Partial<NewBet> = {}): NewBet => ({
  title: 'The launch happens before December',
  terms: 'The public announcement published by the company decides this bet.',
  category: 'Work',
  opponentId: 'bob',
  creatorSide: 'Before December',
  opponentSide: 'December or later',
  stake: 2,
  timing: { kind: 'date', at: '2026-12-01T00:00:00.000Z', timezone: 'UTC' },
  ...overrides,
});
const request = (path: string, actor: string, body?: unknown) =>
  app.request(
    `${origin}${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: `__Host-lobster_session=${actor}`,
        ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
const act = (bet: Bet, actor: string, action: BetAction, version = bet.version) =>
  request(`/api/bets/${bet.id}/actions`, actor, { action, version });
async function create(overrides: Partial<NewBet> = {}): Promise<Bet> {
  const response = await request('/api/bets', 'alice', input(overrides));
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body as Bet;
}
const events = (id: string) =>
  env.DB.prepare('SELECT actor_id, type FROM events WHERE bet_id = ? ORDER BY version')
    .bind(id)
    .all<{ actor_id: string; type: string }>();

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-09-12',
      d1Databases: ['DB'],
    }),
  );
  const DB = await mf.getD1Database('DB');
  env = {
    DB,
    APP_ORIGIN: origin,
    GROUP_NAME: 'Test ledger',
    OWNER_EMAIL: 'alice@example.com',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
    AUTH_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  };
  for (const file of ['0001_ledger.sql', '0002_roll_prices.sql', '0003_cli_sessions.sql'])
    await DB.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  await applyEntrySourceMigration(DB);
  await applyPriceWithdrawMigration(DB);
  for (const id of ['alice', 'bob', 'judge', 'outsider']) {
    await DB.prepare(
      'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, `${id}@example.com`, id[0], '#153b3e', new Date().toISOString())
      .run();
    await DB.prepare(
      'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await tokenHash(id), id, new Date().toISOString(), '2099-12-31T23:59:59Z')
      .run();
  }
});
afterAll(async () => {
  await mf?.dispose();
});

describe('withdrawing and declining through the authenticated API', () => {
  it('lets the creator withdraw a pending proposal with a stale-version guard', async () => {
    const bet = await create();
    const byOpponent = await act(bet, 'bob', { type: 'withdraw', note: 'Not my proposal.' });
    expect(byOpponent.status).toBe(400);
    const stale = await act(bet, 'alice', { type: 'withdraw', note: 'Typo.' }, bet.version + 1);
    expect(stale.status).toBe(409);
    const missing = await act(bet, 'alice', { type: 'withdraw' } as BetAction);
    expect(missing.status).toBe(400);
    const outsider = await act(bet, 'outsider', { type: 'withdraw', note: 'Nope.' });
    expect(outsider.status).toBe(403);
    const response = await act(bet, 'alice', { type: 'withdraw', note: 'I mistyped the date.' });
    const withdrawn = (await response.json()) as Bet;
    expect(response.status, JSON.stringify(withdrawn)).toBe(200);
    expect(withdrawn.status).toBe('declined');
    expect(withdrawn.events.at(-1)).toMatchObject({ type: 'withdraw', actorId: 'alice' });
    expect((await events(bet.id)).results.map((event) => event.type)).toEqual([
      'created',
      'withdraw',
    ]);
    expect((await act(withdrawn, 'bob', { type: 'accept' })).status).toBe(400);
  });
  it('lets only the appointed judge decline judging, before any ruling', async () => {
    const bet = await create({ decisionMethod: 'judge', judgeId: 'judge' });
    expect((await act(bet, 'outsider', { type: 'decline_judging', note: 'No.' })).status).toBe(403);
    expect((await act(bet, 'alice', { type: 'decline_judging', note: 'No.' })).status).toBe(400);
    const response = await act(bet, 'judge', {
      type: 'decline_judging',
      note: 'I have a stake in this one.',
    });
    const declined = (await response.json()) as Bet;
    expect(response.status, JSON.stringify(declined)).toBe(200);
    expect(declined.judgeDeclined).toMatchObject({ note: 'I have a stake in this one.' });
    expect((await act(declined, 'judge', { type: 'decline_judging', note: 'Again.' })).status).toBe(
      400,
    );
    const accepted = (await (await act(declined, 'bob', { type: 'accept' })).json()) as Bet;
    expect(accepted.status).toBe('active');
    expect(
      (await act(accepted, 'judge', { type: 'adjudicate', winnerId: 'alice', note: 'Ruling.' }))
        .status,
    ).toBe(400);
    const unknownJudge = await act(accepted, 'alice', {
      type: 'propose_amendment',
      terms: accepted.terms,
      timing: accepted.timing!,
      note: 'Ask someone who is not a member.',
      decisionMethod: 'judge',
      judgeId: 'nobody',
    });
    expect(unknownJudge.status).toBe(400);
    const proposed = (await (
      await act(accepted, 'alice', {
        type: 'propose_amendment',
        terms: accepted.terms,
        timing: accepted.timing!,
        note: 'We will decide it between us.',
        decisionMethod: 'mutual',
      })
    ).json()) as Bet;
    expect(proposed.amendment).toMatchObject({ decisionMethod: 'mutual' });
    const agreed = (await (
      await act(proposed, 'bob', { type: 'confirm_amendment' })
    ).json()) as Bet;
    expect(agreed).toMatchObject({ decisionMethod: 'mutual', status: 'active' });
    expect(agreed.judgeId).toBeUndefined();
    expect(agreed.judgeDeclined).toBeUndefined();
  });
  it('lets a proposer withdraw their own open amendment and returns the bet to play', async () => {
    let bet = await create();
    bet = (await (await act(bet, 'bob', { type: 'accept' })).json()) as Bet;
    const proposed = (await (
      await act(bet, 'bob', {
        type: 'propose_amendment',
        terms: `${bet.terms} Press releases do not count.`,
        timing: bet.timing!,
        note: 'Tighten the wording.',
      })
    ).json()) as Bet;
    expect(proposed.amendment).toBeTruthy();
    expect(
      (await act(proposed, 'alice', { type: 'withdraw_proposal', note: 'Not mine.' })).status,
    ).toBe(400);
    const response = await act(proposed, 'bob', {
      type: 'withdraw_proposal',
      note: 'I will rephrase it later.',
    });
    const withdrawn = (await response.json()) as Bet;
    expect(response.status, JSON.stringify(withdrawn)).toBe(200);
    expect(withdrawn.amendment).toBeUndefined();
    expect(withdrawn.terms).toBe(bet.terms);
  });
  it('lets the other bettor disagree with readiness evidence, and never overwrite it', async () => {
    let bet = await create();
    bet = (await (await act(bet, 'bob', { type: 'accept' })).json()) as Bet;
    const ready = (await (
      await act(bet, 'alice', { type: 'mark_ready', evidence: 'The announcement is live.' })
    ).json()) as Bet;
    expect(ready.readiness).toMatchObject({ markedBy: 'alice' });
    const overwrite = await act(ready, 'bob', {
      type: 'mark_ready',
      evidence: 'It was postponed.',
    });
    expect(overwrite.status).toBe(400);
    expect(
      (await act(ready, 'outsider', { type: 'dispute_readiness', note: 'Not true.' })).status,
    ).toBe(403);
    expect((await act(ready, 'alice', { type: 'dispute_readiness', note: 'My own.' })).status).toBe(
      400,
    );
    const response = await act(ready, 'bob', {
      type: 'dispute_readiness',
      note: 'That page is a draft, not the announcement.',
    });
    const disputed = (await response.json()) as Bet;
    expect(response.status, JSON.stringify(disputed)).toBe(200);
    expect(disputed.readiness).toBeUndefined();
    expect(disputed.events.at(-1)).toMatchObject({ type: 'dispute_readiness', actorId: 'bob' });
  });
});
