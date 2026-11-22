import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type {
  Bet,
  BetAction,
  HistoricalInput,
  HistoryAcknowledgements,
  HistoryRevision,
  NewBet,
} from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import { tokenHash } from './security';
import { updateBet } from './storage';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

let mf: Miniflare;
let env: WorkerBindings;
const origin = 'https://ledger.example';
const terms = {
  title: 'The original launch wager',
  terms: 'The official public announcement decides the result',
  category: 'Work' as const,
  creatorSide: 'Launch happened',
  opponentSide: 'No launch',
  stake: 2,
};
const acknowledgements = (stage: HistoricalInput['stage']): HistoryAcknowledgements => ({
  terms: true,
  result: stage !== 'active',
  delivery: stage === 'settled',
});
const history = (stage: HistoricalInput['stage']): HistoricalInput => ({
  stage,
  originalDate: { precision: 'year', value: '2024' },
  ...(stage === 'active'
    ? {}
    : {
        result: {
          winnerId: stage === 'voided' ? null : 'alice',
          date: { precision: 'month' as const, value: '2024-06' },
          note: 'The original result was agreed',
        },
      }),
  ...(stage === 'settled'
    ? {
        delivery: {
          date: { precision: 'unknown' as const },
          note: 'Two actual lobster rolls were bought at lunch',
        },
      }
    : {}),
});
const historicalInput = (stage: HistoricalInput['stage']): NewBet => ({
  ...terms,
  opponentId: 'bob',
  history: history(stage),
  acknowledgements: acknowledgements(stage),
  ...(stage === 'active'
    ? {
        timing: {
          kind: 'event',
          description: 'The launch is announced',
          source: 'Official newsroom',
        },
      }
    : {}),
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
const action = (
  bet: Bet,
  actor: string,
  payload: BetAction | Record<string, unknown>,
  version = bet.version,
) => request(`/api/bets/${bet.id}/actions`, actor, { action: payload, version });
async function create(input: NewBet): Promise<Bet> {
  const response = await request('/api/bets', 'alice', input);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body as Bet;
}
async function transition(bet: Bet, actor: string, payload: BetAction): Promise<Bet> {
  const response = await action(bet, actor, payload);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as Bet;
}
const debts = (id: string) =>
  env.DB.prepare('SELECT from_id, to_id, rolls FROM outstanding_obligations WHERE bet_id = ?')
    .bind(id)
    .all();
const statistics = () =>
  env.DB.prepare('SELECT wins, rolls_won FROM member_statistics WHERE member_id = ?')
    .bind('alice')
    .first<{ wins: number; rolls_won: number }>();
async function assertAudit(bet: Bet) {
  const saved = await env.DB.prepare('SELECT version, stake, data FROM bets WHERE id = ?')
    .bind(bet.id)
    .first<{ version: number; stake: number; data: string }>();
  expect(saved!.version).toBe(bet.version);
  expect(saved!.stake).toBe(bet.stake);
  expect(JSON.parse(saved!.data)).toEqual(bet);
  const events = await env.DB.prepare(
    'SELECT actor_id, at FROM events WHERE bet_id = ? ORDER BY version',
  )
    .bind(bet.id)
    .all();
  expect(events.results).toHaveLength(bet.version);
  expect(events.results.map((event) => event.actor_id)).toEqual(
    bet.events.map((event) => event.actorId),
  );
  expect(events.results.map((event) => event.at)).toEqual(bet.events.map((event) => event.at));
}

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
  await DB.exec(await readFile(new URL('../migrations/0001_ledger.sql', import.meta.url), 'utf8'));
  await DB.exec(
    await readFile(new URL('../migrations/0002_roll_prices.sql', import.meta.url), 'utf8'),
  );
  await DB.exec(
    await readFile(new URL('../migrations/0003_cli_sessions.sql', import.meta.url), 'utf8'),
  );
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mf?.dispose();
});

describe('historical bets through the authenticated API', () => {
  it.each(['active', 'owed', 'settled', 'voided'] as const)(
    'keeps imported %s history pending until both bettors acknowledge it',
    async (stage) => {
      const before = (await statistics())!;
      let bet = await create(historicalInput(stage));
      expect(bet.status).toBe('pending');
      expect(bet.resolution).toBeUndefined();
      expect(bet.settlement).toBeUndefined();
      expect((await debts(bet.id)).results).toEqual([]);
      expect(await statistics()).toEqual(before);
      expect(bet.history!.approvals).toMatchObject([
        { actorId: 'alice', acknowledgements: acknowledgements(stage) },
      ]);
      expect(Math.abs(Date.now() - Date.parse(bet.createdAt))).toBeLessThan(5000);
      expect(Math.abs(Date.now() - Date.parse(bet.history!.approvals[0].at))).toBeLessThan(5000);
      bet = await transition(bet, 'bob', {
        type: 'confirm_history',
        acknowledgements: acknowledgements(stage),
      });
      expect(bet.status).toBe(stage);
      expect(bet.history!.approvals.map((approval) => approval.actorId)).toEqual(['alice', 'bob']);
      expect(Math.abs(Date.now() - Date.parse(bet.history!.confirmedAt!))).toBeLessThan(5000);
      expect((await debts(bet.id)).results).toEqual(
        stage === 'owed' ? [{ from_id: 'bob', to_id: 'alice', rolls: 2 }] : [],
      );
      expect(await statistics()).toEqual({
        wins: before.wins + (stage === 'owed' || stage === 'settled' ? 1 : 0),
        rolls_won: before.rolls_won + (stage === 'owed' || stage === 'settled' ? 2 : 0),
      });
      if (stage === 'settled')
        expect(bet.settlement).toMatchObject({ method: 'roll', approvals: ['alice', 'bob'] });
      await assertAudit(bet);
    },
  );

  it('requires terms, result, and delivery consent and rejects forged actors or stored approvals', async () => {
    const proposed = historicalInput('settled');
    for (const missing of ['terms', 'result', 'delivery'] as const) {
      expect(
        (
          await request('/api/bets', 'alice', {
            ...proposed,
            acknowledgements: { ...proposed.acknowledgements, [missing]: false },
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (await request('/api/bets', 'alice', { ...proposed, acknowledgements: undefined })).status,
    ).toBe(400);
    for (const forged of [
      { approvals: ['alice', 'bob'] },
      { proposedBy: 'bob' },
      { confirmedAt: '2024-06-01T00:00:00Z' },
    ]) {
      expect(
        (
          await request('/api/bets', 'alice', {
            ...proposed,
            history: { ...proposed.history, ...forged },
          })
        ).status,
      ).toBe(400);
    }
    let bet = await create(proposed);
    for (const missing of ['terms', 'result', 'delivery'] as const) {
      expect(
        (
          await action(bet, 'bob', {
            type: 'confirm_history',
            acknowledgements: { ...acknowledgements('settled'), [missing]: false },
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await action(bet, 'alice', {
          type: 'confirm_history',
          acknowledgements: acknowledgements('settled'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await action(bet, 'outsider', {
          type: 'confirm_history',
          acknowledgements: acknowledgements('settled'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await action(bet, 'bob', {
          type: 'confirm_history',
          acknowledgements: acknowledgements('settled'),
          actorId: 'alice',
        })
      ).status,
    ).toBe(400);
    expect((await action(bet, 'bob', { type: 'accept' })).status).toBe(400);
    await assertAudit(bet);
    bet = await transition(bet, 'bob', {
      type: 'confirm_history',
      acknowledgements: acknowledgements('settled'),
    });
    expect(
      (
        await action(
          bet,
          'bob',
          { type: 'confirm_history', acknowledgements: acknowledgements('settled') },
          1,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await action(bet, 'bob', {
          type: 'confirm_history',
          acknowledgements: acknowledgements('settled'),
        })
      ).status,
    ).toBe(400);
    await assertAudit(bet);
  });

  it('rejects inconsistent outcomes, delivery claims, dates, and transferred counterparties', async () => {
    const proposed = historicalInput('settled');
    expect(
      (await request('/api/bets', 'alice', { ...historicalInput('active'), timing: undefined }))
        .status,
    ).toBe(400);
    for (const malformed of [
      { ...history('settled'), delivery: undefined },
      { ...history('owed'), result: undefined },
      { ...history('settled'), stage: 'active' },
      { ...history('owed'), result: { ...history('owed').result, winnerId: 'outsider' } },
      { ...history('voided'), result: { ...history('voided').result, winnerId: 'alice' } },
      { ...history('settled'), delivery: { ...history('settled').delivery, method: 'cash' } },
      { ...history('settled'), originalDate: { precision: 'day', value: '2025-02-29' } },
      {
        ...history('settled'),
        result: { ...history('settled').result, date: { precision: 'day', value: '2099-01-01' } },
      },
    ])
      expect(
        (await request('/api/bets', 'alice', { ...proposed, history: malformed })).status,
        JSON.stringify(malformed),
      ).toBe(400);
    const bet = await create(proposed);
    const revision: HistoryRevision = { ...terms, history: history('settled') };
    for (const forged of [
      { opponentId: 'outsider' },
      { creatorId: 'bob' },
      { decisionMethod: 'mutual' },
    ])
      expect(
        (
          await action(bet, 'bob', {
            type: 'revise_history',
            revision: { ...revision, ...forged },
            acknowledgements: acknowledgements('settled'),
          })
        ).status,
      ).toBe(400);
    await assertAudit(bet);
  });

  it.each(['judge', 'chatgpt'] as const)(
    'keeps reported previous %s evidence separate from actual adjudicator and prompt approvals',
    async (method) => {
      const proposed = historicalInput('settled');
      let bet = await create({
        ...proposed,
        decisionMethod: method,
        ...(method === 'judge' ? { judgeId: 'judge' } : {}),
        history: {
          ...proposed.history!,
          previousAdjudication: {
            method,
            note: 'Both bettors report this earlier recommendation',
            sourceUrl: 'https://evidence.example/old-report',
          },
        },
      });
      expect(bet.adjudication).toBeUndefined();
      expect(bet.promptAgreement).toBeUndefined();
      expect(
        (
          await action(bet, 'judge', {
            type: 'confirm_history',
            acknowledgements: acknowledgements('settled'),
          })
        ).status,
      ).toBe(403);
      bet = await transition(bet, 'bob', {
        type: 'confirm_history',
        acknowledgements: acknowledgements('settled'),
      });
      expect(bet.status).toBe('settled');
      expect(bet.adjudication).toBeUndefined();
      expect(bet.promptAgreement).toBeUndefined();
      expect(bet.events.map((event) => event.actorId)).toEqual(['alice', 'bob']);
      await assertAudit(bet);
    },
  );

  it('resets consent on correction and keeps original snapshots and revised SQL debts consistent', async () => {
    let bet = await create(historicalInput('owed'));
    const originalEvent = structuredClone(bet.events[0]);
    bet = await transition(bet, 'bob', {
      type: 'request_history_correction',
      note: 'The original stake was five rolls, not two',
    });
    expect(bet.status).toBe('pending');
    expect(
      (
        await action(bet, 'bob', {
          type: 'confirm_history',
          acknowledgements: acknowledgements('owed'),
        })
      ).status,
    ).toBe(400);
    const revision: HistoryRevision = { ...terms, stake: 5, history: history('owed') };
    bet = await transition(bet, 'bob', {
      type: 'revise_history',
      revision,
      acknowledgements: acknowledgements('owed'),
    });
    expect(bet.history!.approvals.map((approval) => approval.actorId)).toEqual(['bob']);
    expect(bet.agreementApprovals).toEqual(['bob']);
    expect(bet.events[0]).toEqual(originalEvent);
    expect(bet.events.at(-1)?.historySnapshot).toMatchObject({
      stake: 2,
      proposal: { approvals: [{ actorId: 'alice' }] },
    });
    expect((await debts(bet.id)).results).toEqual([]);
    await assertAudit(bet);
    expect(
      (
        await action(bet, 'bob', {
          type: 'confirm_history',
          acknowledgements: acknowledgements('owed'),
        })
      ).status,
    ).toBe(400);
    bet = await transition(bet, 'alice', {
      type: 'confirm_history',
      acknowledgements: acknowledgements('owed'),
    });
    expect((await debts(bet.id)).results).toEqual([{ from_id: 'bob', to_id: 'alice', rolls: 5 }]);
    await assertAudit(bet);
    const rewritten = structuredClone(bet);
    rewritten.version += 1;
    rewritten.events[2].historySnapshot!.stake = 99;
    rewritten.events.push({
      id: crypto.randomUUID(),
      type: 'tampered',
      actorId: 'alice',
      at: new Date().toISOString(),
      detail: 'Attempt to rewrite historical provenance',
    });
    await expect(updateBet(env.DB, rewritten, bet.version)).rejects.toThrow(/immutable/);
    await assertAudit(bet);
  });
});

describe('decision timing and mutual revisions through the authenticated API', () => {
  it('uses the exact decision instant without automatically creating a result at the cutoff or review time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2098-01-02T11:59:59.999Z');
    let bet = await create({
      ...terms,
      opponentId: 'bob',
      timing: { kind: 'date', at: '2098-01-02T12:00:00Z', timezone: 'UTC' },
      cutoff: { at: '2098-01-01T12:00:00Z', timezone: 'UTC' },
    });
    bet = await transition(bet, 'bob', { type: 'accept' });
    const result: BetAction = {
      type: 'propose_result',
      winnerId: 'alice',
      note: 'The public announcement confirms the outcome',
    };
    expect((await action(bet, 'alice', result)).status).toBe(400);
    vi.setSystemTime('2098-01-02T12:00:00.000Z');
    const ledger = (await (await request('/api/ledger', 'alice')).json()) as { bets: Bet[] };
    expect(ledger.bets.find((entry) => entry.id === bet.id)).toMatchObject({
      status: 'active',
      version: 2,
    });
    expect((await debts(bet.id)).results).toEqual([]);
    bet = await transition(bet, 'alice', result);
    expect(bet.status).toBe('confirming');
    expect((await debts(bet.id)).results).toEqual([]);
    bet = await transition(bet, 'bob', { type: 'confirm_result' });
    expect((await debts(bet.id)).results).toEqual([{ from_id: 'bob', to_id: 'alice', rolls: 2 }]);
    await assertAudit(bet);
  });

  it.each(['date', 'event', 'evidence'] as const)(
    'requires evidence to establish early %s readiness and keeps check-ins personal',
    async (kind) => {
      const timing =
        kind === 'date'
          ? { kind, at: '2098-01-02T12:00:00.000Z', timezone: 'UTC' }
          : {
              kind,
              description: 'The official result becomes available',
              source: 'Official newsroom',
            };
      let bet = await create({ ...terms, opponentId: 'bob', timing });
      bet = await transition(bet, 'bob', { type: 'accept' });
      expect(
        (
          await action(bet, 'alice', {
            type: 'propose_result',
            winnerId: 'alice',
            note: 'Unsupported early claim',
          })
        ).status,
      ).toBe(400);
      const aliceCheckIn = { at: '2097-12-30T12:00:00.000Z', timezone: 'UTC' };
      const bobCheckIn = { at: '2097-12-31T12:00:00.000Z', timezone: 'UTC' };
      bet = await transition(bet, 'alice', { type: 'set_check_in', checkIn: aliceCheckIn });
      bet = await transition(bet, 'bob', { type: 'set_check_in', checkIn: bobCheckIn });
      expect(bet.checkIns).toEqual({ alice: aliceCheckIn, bob: bobCheckIn });
      expect(bet.timing).toEqual(timing);
      expect(bet.terms).toBe(terms.terms);
      expect(
        (await action(bet, 'outsider', { type: 'set_check_in', checkIn: bobCheckIn })).status,
      ).toBe(403);
      expect(
        (await action(bet, 'bob', { type: 'set_check_in', checkIn: bobCheckIn, actorId: 'alice' }))
          .status,
      ).toBe(400);
      bet = await transition(bet, 'bob', { type: 'set_check_in', checkIn: null });
      expect(bet.checkIns).toEqual({ alice: aliceCheckIn, bob: null });
      expect((await action(bet, 'alice', { type: 'mark_ready', evidence: ' ' })).status).toBe(400);
      bet = await transition(bet, 'bob', {
        type: 'mark_ready',
        evidence: 'Official announcement: the result is published',
      });
      expect(bet.readiness).toMatchObject({
        markedBy: 'bob',
        evidence: 'Official announcement: the result is published',
      });
      expect(Math.abs(Date.now() - Date.parse(bet.readiness!.at))).toBeLessThan(5000);
      expect(bet.status).toBe('active');
      expect((await debts(bet.id)).results).toEqual([]);
      bet = await transition(bet, 'alice', {
        type: 'propose_result',
        winnerId: 'alice',
        note: 'The published result meets the terms',
      });
      bet = await transition(bet, 'bob', { type: 'confirm_result' });
      expect(bet.status).toBe('owed');
      await assertAudit(bet);
    },
  );

  it('requires mutual amendments, suspends competing outcomes, and resets readiness and prompt consent only when accepted', async () => {
    let bet = await create({
      ...terms,
      opponentId: 'bob',
      decisionMethod: 'chatgpt',
      timing: { kind: 'event', description: 'The launch happens' },
      cutoff: { at: '2097-01-01T12:00:00Z', timezone: 'UTC' },
    });
    bet = await transition(bet, 'bob', { type: 'accept' });
    bet = await transition(bet, 'alice', {
      type: 'propose_prompt',
      text: 'Apply the original wager terms to the published company announcement.',
    });
    bet = await transition(bet, 'bob', { type: 'approve_prompt' });
    bet = await transition(bet, 'alice', {
      type: 'mark_ready',
      evidence: 'The company published the announcement',
    });
    const prompt = structuredClone(bet.promptAgreement);
    const readiness = structuredClone(bet.readiness);
    const proposal: BetAction = {
      type: 'propose_amendment',
      terms: 'Use the final audited public launch report to decide',
      timing: { kind: 'evidence', description: 'Final audited report is available' },
      note: 'The report gives clearer evidence',
    };
    bet = await transition(bet, 'alice', proposal);
    expect(bet.terms).toBe(terms.terms);
    expect(bet.events.at(-1)?.amendmentSnapshot).toMatchObject({
      terms: terms.terms,
      proposal: {
        proposedBy: 'alice',
        terms: 'Use the final audited public launch report to decide',
      },
    });
    expect((await action(bet, 'alice', { type: 'confirm_amendment' })).status).toBe(400);
    expect((await action(bet, 'outsider', { type: 'confirm_amendment' })).status).toBe(403);
    expect(
      (
        await action(bet, 'bob', {
          type: 'adjudicate',
          winnerId: 'alice',
          note: 'Use the old approved prompt',
        })
      ).status,
    ).toBe(400);
    expect(
      (await action(bet, 'bob', { type: 'propose_void', note: 'Competing outcome' })).status,
    ).toBe(400);
    bet = await transition(bet, 'bob', {
      type: 'reject_amendment',
      note: 'Keep the original agreement for now',
    });
    expect(bet.terms).toBe(terms.terms);
    expect(bet.promptAgreement).toEqual(prompt);
    expect(bet.readiness).toEqual(readiness);
    bet = await transition(bet, 'alice', proposal);
    const oldVersion = bet.version;
    bet = await transition(bet, 'bob', { type: 'confirm_amendment' });
    expect(bet.terms).toBe('Use the final audited public launch report to decide');
    expect(bet.timing).toEqual({
      kind: 'evidence',
      description: 'Final audited report is available',
    });
    expect(bet.cutoff).toBeUndefined();
    expect(bet.readiness).toBeUndefined();
    expect(bet.promptAgreement).toBeUndefined();
    expect(bet.amendment).toBeUndefined();
    expect((await action(bet, 'bob', { type: 'confirm_amendment' }, oldVersion)).status).toBe(409);
    expect((await action(bet, 'bob', { type: 'confirm_amendment' })).status).toBe(400);
    await assertAudit(bet);
    const rewritten = structuredClone(bet);
    rewritten.version += 1;
    const amendedEvent = rewritten.events.find((event) => event.amendmentSnapshot)!;
    amendedEvent.amendmentSnapshot!.proposal.terms = 'Rewritten after mutual approval';
    rewritten.events.push({
      id: crypto.randomUUID(),
      type: 'tampered',
      actorId: 'alice',
      at: new Date().toISOString(),
      detail: 'Attempt to rewrite the amendment participants approved',
    });
    await expect(updateBet(env.DB, rewritten, bet.version)).rejects.toThrow(/immutable/);
    await assertAudit(bet);
  });

  it('lets both original bettors call off a judged bet while rejecting judge, self, and replayed consent', async () => {
    let bet = await create({
      ...terms,
      opponentId: 'bob',
      deadline: '2098-01-01',
      decisionMethod: 'judge',
      judgeId: 'judge',
    });
    bet = await transition(bet, 'bob', { type: 'accept' });
    bet = await transition(bet, 'alice', {
      type: 'propose_void',
      note: 'The event was called off, so neither side won',
    });
    expect((await action(bet, 'alice', { type: 'confirm_void' })).status).toBe(400);
    expect((await action(bet, 'judge', { type: 'confirm_void' })).status).toBe(403);
    expect(
      (
        await action(bet, 'judge', {
          type: 'adjudicate',
          winnerId: 'alice',
          note: 'A competing ruling',
        })
      ).status,
    ).toBe(400);
    bet = await transition(bet, 'bob', {
      type: 'reject_void',
      note: 'Keep the wager open for now',
    });
    expect(bet.status).toBe('active');
    expect(bet.voidProposal).toBeUndefined();
    bet = await transition(bet, 'bob', {
      type: 'propose_void',
      note: 'We now agree the event cannot resolve the wager',
    });
    const oldVersion = bet.version;
    bet = await transition(bet, 'alice', { type: 'confirm_void' });
    expect(bet.status).toBe('voided');
    expect(bet.resolution).toMatchObject({
      winnerId: null,
      approvals: expect.arrayContaining(['alice', 'bob']),
    });
    expect((await debts(bet.id)).results).toEqual([]);
    expect((await action(bet, 'alice', { type: 'confirm_void' }, oldVersion)).status).toBe(409);
    expect((await action(bet, 'alice', { type: 'confirm_void' })).status).toBe(400);
    await assertAudit(bet);
  });
});
