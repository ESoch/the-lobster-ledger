import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { ApiClient, type Credentials, type SessionStore } from '../cli/src/auth';
import { validateCreateInput } from '../cli/src/create';
import type { Bet, LedgerState } from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import { proofChallenge } from './cli-crypto';
import { tokenHash } from './security';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

const origin = 'https://cli-integration.example';
let mf: Miniflare;
let env: WorkerBindings;

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
    GROUP_NAME: 'CLI integration fixture',
    OWNER_EMAIL: 'alice@example.com',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
    AUTH_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  };
  for (const file of ['0001_ledger.sql', '0002_roll_prices.sql', '0003_cli_sessions.sql']) {
    await DB.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  await applyEntrySourceMigration(DB);
  await applyPriceWithdrawMigration(DB);
  for (const id of ['alice', 'bob']) {
    await DB.prepare(
      'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, `${id}@example.com`, id[0], '#153b3e', new Date().toISOString())
      .run();
  }
  await DB.prepare(
    'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(
      await tokenHash('synthetic-browser-session'),
      'alice',
      new Date().toISOString(),
      '2099-01-01T00:00:00Z',
    )
    .run();
});

afterAll(async () => {
  await mf?.dispose();
});

it('uses the real CLI client for approved login, validated wager creation, retry, refresh and revocation', async () => {
  // The transport reaches the actual Worker and Miniflare D1. Only the edge IP
  // and OS credential store are replaced; no network or Keychain access occurs.
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('CF-Connecting-IP', '198.51.100.20');
    return app.request(request, undefined, env);
  };
  let saved: Credentials | undefined;
  const store: SessionStore = {
    read: async () => saved,
    write: async (credentials) => {
      saved = credentials;
    },
    clear: async () => {
      saved = undefined;
    },
    locked: async (operation) => operation(),
  };
  const client = new ApiClient(origin, store, transport);
  const verifier = 'v'.repeat(43);
  const state = 's'.repeat(43);
  const redirectUri = 'http://127.0.0.1:49321/callback';
  const approval = await transport(`${origin}/api/cli/authorize`, {
    method: 'POST',
    headers: {
      Cookie: '__Host-lobster_session=synthetic-browser-session',
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      codeChallenge: await proofChallenge(verifier),
      redirectUri,
      state,
      deviceName: 'Synthetic CLI integration device',
    }),
  });
  expect(approval.status).toBe(200);
  const callback = new URL(((await approval.json()) as { redirectUrl: string }).redirectUrl);
  expect(callback.searchParams.get('state')).toBe(state);
  const credentials = await client.exchange({
    grantType: 'authorization_code',
    code: callback.searchParams.get('code'),
    codeVerifier: verifier,
    redirectUri,
  });
  await store.write(credentials);
  expect(await client.get('/api/cli/me')).toEqual({
    member: { id: 'alice', name: 'alice' },
    sessionId: credentials.sessionId,
  });
  const ledger = (await client.get('/api/ledger')) as LedgerState;

  const input = validateCreateInput(
    JSON.parse(
      JSON.stringify({
        bet: {
          title: 'The official product launch happens before December',
          terms:
            'Use the public announcement date to decide. Before December wins for Alice; December or later wins for Bob.',
          category: 'Work',
          opponentId: 'bob',
          creatorSide: 'Before December',
          opponentSide: 'December or later',
          stake: 2,
          decisionMethod: 'chatgpt',
          timing: {
            kind: 'event',
            description: 'The company publishes the launch announcement',
            source: 'Official newsroom',
          },
          location: {
            id: 'synthetic-location',
            name: 'Fixture cafe',
            address: 'Fixture address',
            lat: 33.6,
            lng: -117.9,
          },
        },
        prompt:
          'Apply the agreed winning conditions to the official public announcement and explain which bettor is correct.',
      }),
    ),
    credentials.member.id,
    ledger.members,
  );
  const key = crypto.randomUUID();
  const bet = (await client.request('/api/cli/bets', {
    method: 'POST',
    body: input,
    idempotencyKey: key,
  })) as Bet;
  expect(bet).toMatchObject({
    creatorId: 'alice',
    opponentId: 'bob',
    status: 'pending',
    version: 2,
    agreementApprovals: ['alice'],
    promptAgreement: { text: input.prompt, approvals: ['alice'] },
    location: input.bet.location,
    timing: input.bet.timing,
  });
  expect(
    await client.request('/api/cli/bets', { method: 'POST', body: input, idempotencyKey: key }),
  ).toEqual(bet);
  expect(
    (
      await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE bet_id = ?')
        .bind(bet.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(2);

  // Expire both the client cache and server access token, then exercise actual
  // refresh rotation rather than supplying a mocked successful token response.
  await store.write({ ...credentials, expiresAt: 0 });
  await env.DB.prepare('UPDATE cli_sessions SET access_expires_at = 0 WHERE id = ?')
    .bind(credentials.sessionId)
    .run();
  const refreshedLedger = (await client.get('/api/ledger')) as LedgerState;
  expect(refreshedLedger.bets).toHaveLength(1);
  expect(refreshedLedger.bets[0]).toEqual(bet);
  const rotated = (await store.read())!;
  expect(rotated.sessionId).toBe(credentials.sessionId);
  expect(rotated.accessToken).not.toBe(credentials.accessToken);
  expect(rotated.refreshToken).not.toBe(credentials.refreshToken);
  expect(
    await client.request('/api/cli/bets', { method: 'POST', body: input, idempotencyKey: key }),
  ).toEqual(bet);

  await client.logout();
  expect(await store.read()).toBeUndefined();
  await expect(client.get('/api/ledger')).rejects.toThrow(/auth login/);
  expect(
    (
      await transport(`${origin}/api/ledger`, {
        headers: { Authorization: `Bearer ${rotated.accessToken}` },
      })
    ).status,
  ).toBe(401);
  await expect(
    client.exchange({ grantType: 'refresh_token', refreshToken: rotated.refreshToken }),
  ).rejects.toMatchObject({ status: 401 });
});
