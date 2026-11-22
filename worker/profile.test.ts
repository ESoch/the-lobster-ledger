import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { LIMITS } from '../src/lib/limits';
import { MEMBER_NAME_BLANK, MEMBER_NAME_TOO_LONG } from '../src/lib/member-name';
import type { Bet, LedgerState } from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import { tokenHash } from './security';
import { admitIdentity } from './storage';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

const origin = 'https://ledger.example';
const createdAt = '2026-09-12T00:00:00.000Z';
let mf: Miniflare;
let env: WorkerBindings;

const request = (actor: string | undefined, body: unknown, extraHeaders = {}) =>
  app.request(
    `${origin}/api/profile`,
    {
      method: 'PATCH',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(actor ? { Cookie: `__Host-lobster_session=${actor}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
    env,
  );

const stored = (id = 'alice') =>
  env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();

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
  for (const migration of ['0001_ledger.sql', '0002_roll_prices.sql', '0003_cli_sessions.sql'])
    await DB.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  await applyEntrySourceMigration(DB);
  await applyPriceWithdrawMigration(DB);
  for (const id of ['alice', 'bob', 'zoe'])
    await DB.prepare(
      'INSERT INTO members (id, google_sub, name, email, initials, color, created_at, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        id,
        id,
        id,
        `${id}@example.com`,
        id[0].toUpperCase(),
        '#315b54',
        createdAt,
        id === 'alice' ? 1 : 0,
      )
      .run();
});

beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE members SET name = CASE id WHEN 'alice' THEN 'Alice' WHEN 'bob' THEN 'Bob' ELSE 'Zoë Bell' END, initials = CASE id WHEN 'alice' THEN 'A' WHEN 'bob' THEN 'B' ELSE 'ZB' END",
  ).run();
  await env.DB.prepare('DELETE FROM sessions').run();
  for (const id of ['alice', 'bob'])
    await env.DB.prepare(
      'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await tokenHash(id), id, createdAt, new Date(Date.now() + 60_000).toISOString())
      .run();
});

afterAll(async () => mf?.dispose());

describe('editing a profile display name', () => {
  it('updates only the signed-in member’s name and initials and returns the saved profile', async () => {
    const before = await stored();
    const other = await stored('bob');
    const response = await request('alice', { name: '  🦞 Pat\tSmith  ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      member: { id: 'alice', name: '🦞 Pat Smith', initials: 'PS', color: '#315b54' },
    });
    expect(await stored()).toEqual({ ...before, name: '🦞 Pat Smith', initials: 'PS' });
    expect(await stored('bob')).toEqual(other);
  });

  it('shows the saved name to the current session and ledger while preserving existing bets', async () => {
    const headers = {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: '__Host-lobster_session=alice',
    };
    const created = await app.request(
      `${origin}/api/bets`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Launch by Friday',
          terms: 'The public announcement by 5pm decides',
          category: 'Work',
          opponentId: 'bob',
          creatorSide: 'Yes',
          opponentSide: 'No',
          stake: 2,
          deadline: '2099-01-01',
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const bet = (await created.json()) as Bet;
    expect((await request('alice', { name: 'Alex Cooper' })).status).toBe(200);
    const session = await app.request(`${origin}/api/session`, { headers }, env);
    expect(await session.json()).toMatchObject({
      member: { id: 'alice', name: 'Alex Cooper', initials: 'AC' },
    });
    const ledger = (await (
      await app.request(`${origin}/api/ledger`, { headers }, env)
    ).json()) as LedgerState;
    expect(ledger.members.find((member) => member.id === 'alice')).toMatchObject({
      name: 'Alex Cooper',
      initials: 'AC',
    });
    expect(ledger.bets.find((existing) => existing.id === bet.id)).toEqual(bet);
  });

  it('preserves the edited name when Google next signs the member in under a different name', async () => {
    expect((await request('alice', { name: 'Alex Cooper' })).status).toBe(200);
    expect(
      await admitIdentity(
        env.DB,
        {
          sub: 'alice',
          email: 'alice@example.com',
          name: 'Alice From Google',
          emailAuthoritative: true,
        },
        'alice@example.com',
      ),
    ).toEqual({ id: 'alice', name: 'Alex Cooper', initials: 'AC', color: '#315b54' });
  });

  it('allows keeping one’s own name and changing its capitalization', async () => {
    for (const name of ['Alice', '  ALICE  ']) {
      const response = await request('alice', { name });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ member: { id: 'alice', name: name.trim() } });
    }
  });

  it.each(['BOB', '  bOb  ', 'Zoe\u0308   Bell'])(
    'rejects another member’s equivalent name %j without changing either profile',
    async (name) => {
      const before = await stored();
      const response = await request('alice', { name });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('already at the table'),
      });
      expect(await stored()).toEqual(before);
    },
  );

  it('does not let concurrent edits give two members the same Unicode name', async () => {
    const responses = await Promise.all([
      request('alice', { name: 'Zoë Redwood' }),
      request('bob', { name: 'Zoe\u0308   REDWOOD' }),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const refused = responses.find((response) => response.status !== 200)!;
    expect([400, 422]).toContain(refused.status);
    const saved = await env.DB.prepare(
      "SELECT name FROM members WHERE id IN ('alice', 'bob')",
    ).all<{ name: string }>();
    expect(
      saved.results.filter(
        (member) => member.name.normalize('NFC').toLowerCase() === 'zoë redwood',
      ),
    ).toHaveLength(1);
  });

  it.each(['', '  \n\t  ', null, 7])(
    'rejects an invalid name %j with a field error',
    async (name) => {
      const before = await stored();
      const response = await request('alice', { name });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ details: [{ path: 'name' }] });
      expect(await stored()).toEqual(before);
    },
  );

  it('uses the shared length limit after cleaning whitespace', async () => {
    const blank = await request('alice', { name: '  ' });
    expect(await blank.json()).toMatchObject({
      details: [{ path: 'name', message: MEMBER_NAME_BLANK }],
    });
    const tooLong = await request('alice', { name: 'x'.repeat(LIMITS.memberName.max + 1) });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({
      details: [{ path: 'name', message: MEMBER_NAME_TOO_LONG }],
    });
    const boundary = await request('alice', { name: `  ${'x'.repeat(LIMITS.memberName.max)}  ` });
    expect(boundary.status).toBe(200);
  });

  it.each([
    { name: 'Alex Cooper', id: 'bob' },
    { name: 'Alex Cooper', memberId: 'bob' },
    { name: 'Alex Cooper', email: 'other@example.com' },
    { name: 'Alex Cooper', is_owner: 0 },
    {},
  ])('rejects unsupported profile fields in %j without changing a member', async (body) => {
    const before = await env.DB.prepare('SELECT * FROM members ORDER BY id').all();
    expect((await request('alice', body)).status).toBe(400);
    expect((await env.DB.prepare('SELECT * FROM members ORDER BY id').all()).results).toEqual(
      before.results,
    );
  });

  it('requires a current browser session and the ledger’s own origin', async () => {
    const before = await stored();
    expect((await request(undefined, { name: 'Alex Cooper' })).status).toBe(401);
    expect((await request('forged', { name: 'Alex Cooper' })).status).toBe(401);
    expect(
      (await request('alice', { name: 'Alex Cooper' }, { Origin: 'https://other.example' })).status,
    ).toBe(403);
    expect(
      (await request('alice', { name: 'Alex Cooper' }, { 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(403);
    expect(
      (await request('alice', { name: 'Alex Cooper' }, { Authorization: 'Bearer token' })).status,
    ).toBe(403);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(createdAt).run();
    expect((await request('alice', { name: 'Alex Cooper' })).status).toBe(401);
    expect(await stored()).toEqual(before);
  });
});
