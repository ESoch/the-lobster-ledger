import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type { Bet } from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import { tokenHash } from './security';
import { hashSecret, proofChallenge } from './cli-crypto';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

let mf: Miniflare;
let env: WorkerBindings;
const origin = 'https://ledger.example';
const redirectUri = 'http://127.0.0.1:49321/callback';
const verifier = 'v'.repeat(43);
const state = 's'.repeat(43);
const betInput = {
  title: 'The official launch occurs before December',
  terms: 'The public announcement published by the company decides this bet.',
  category: 'Work',
  opponentId: 'bob',
  creatorSide: 'Before December',
  opponentSide: 'December or later',
  stake: 2,
  timing: {
    kind: 'event',
    description: 'The company publishes its launch announcement',
    source: 'Official newsroom',
  },
};

const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        'CF-Connecting-IP': '198.51.100.10',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
const browser = (actor = 'alice') => ({
  Cookie: `__Host-lobster_session=${actor}`,
  Origin: origin,
});
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  member: { id: string; name: string };
}
async function authorize(actor = 'alice') {
  return request(
    '/api/cli/authorize',
    'POST',
    {
      codeChallenge: await proofChallenge(verifier),
      redirectUri,
      state,
      deviceName: 'Integration test laptop',
    },
    browser(actor),
  );
}
async function login(actor = 'alice'): Promise<Tokens> {
  const approval = await authorize(actor);
  const approved = (await approval.json()) as { redirectUrl: string };
  expect(approval.status, JSON.stringify(approved)).toBe(200);
  const code = new URL(approved.redirectUrl).searchParams.get('code');
  const exchanged = await request('/api/cli/token', 'POST', {
    grantType: 'authorization_code',
    code,
    codeVerifier: verifier,
    redirectUri,
  });
  const tokens = await exchanged.json();
  expect(exchanged.status, JSON.stringify(tokens)).toBe(200);
  return tokens as Tokens;
}
const create = (token: string, key: string, bet: unknown = betInput, prompt?: string) =>
  request(
    '/api/cli/bets',
    'POST',
    { bet, ...(prompt ? { prompt } : {}) },
    { ...bearer(token), 'Idempotency-Key': key },
  );

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
  for (const id of ['alice', 'bob', 'outsider']) {
    await DB.prepare(
      'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, `${id}@example.com`, id[0], '#153b3e', new Date().toISOString())
      .run();
    await DB.prepare(
      'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await tokenHash(id), id, new Date().toISOString(), '2099-01-01T00:00:00Z')
      .run();
  }
});
afterAll(async () => {
  await mf?.dispose();
});

describe('CLI authorization API', () => {
  it('binds single-use codes to the original proof and callback and rejects expiration', async () => {
    const approved = (await (await authorize()).json()) as { redirectUrl: string };
    const code = new URL(approved.redirectUrl).searchParams.get('code');
    const grant = { grantType: 'authorization_code', code, codeVerifier: verifier, redirectUri };
    expect(
      (await request('/api/cli/token', 'POST', { ...grant, codeVerifier: 'w'.repeat(43) })).status,
    ).toBe(401);
    expect(
      (
        await request('/api/cli/token', 'POST', {
          ...grant,
          redirectUri: 'http://127.0.0.1:49999/callback',
        })
      ).status,
    ).toBe(401);
    expect((await request('/api/cli/token', 'POST', grant)).status).toBe(200);
    expect((await request('/api/cli/token', 'POST', grant)).status).toBe(401);
    const pending = (await (await authorize()).json()) as { redirectUrl: string };
    const expiredCode = new URL(pending.redirectUrl).searchParams.get('code')!;
    await env.DB.prepare('UPDATE cli_authorization_codes SET expires_at = ? WHERE code_hash = ?')
      .bind(Date.now(), await hashSecret(expiredCode))
      .run();
    expect((await request('/api/cli/token', 'POST', { ...grant, code: expiredCode })).status).toBe(
      401,
    );
  });

  it('revokes a rotated family on concurrent refresh replay in real D1 transactions', async () => {
    const tokens = await login();
    const attempts = await Promise.all([
      request('/api/cli/token', 'POST', {
        grantType: 'refresh_token',
        refreshToken: tokens.refreshToken,
      }),
      request('/api/cli/token', 'POST', {
        grantType: 'refresh_token',
        refreshToken: tokens.refreshToken,
      }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 401]);
    const fresh = (await attempts.find((response) => response.status === 200)!.json()) as Tokens;
    expect((await request('/api/ledger', 'GET', undefined, bearer(fresh.accessToken))).status).toBe(
      401,
    );
    expect(
      (
        await request('/api/cli/token', 'POST', {
          grantType: 'refresh_token',
          refreshToken: fresh.refreshToken,
        })
      ).status,
    ).toBe(401);
  });

  it('enforces token endpoint rate limits and fails closed if the limiter is unavailable', async () => {
    const original = env.AUTH_RATE_LIMITER;
    try {
      env.AUTH_RATE_LIMITER = {
        async limit() {
          return { success: false };
        },
      };
      const response = await request('/api/cli/token', 'POST', {
        grantType: 'refresh_token',
        refreshToken: 'invalid',
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      env.AUTH_RATE_LIMITER = {
        async limit() {
          throw new Error('unavailable');
        },
      };
      expect(
        (
          await request('/api/cli/token', 'POST', {
            grantType: 'refresh_token',
            refreshToken: 'invalid',
          })
        ).status,
      ).toBe(503);
    } finally {
      env.AUTH_RATE_LIMITER = original;
    }
  });

  it('requires an authenticated browser and same-origin approval', async () => {
    const body = {
      codeChallenge: await proofChallenge(verifier),
      redirectUri,
      state,
      deviceName: 'Laptop',
    };
    expect((await request('/api/cli/authorize', 'POST', body, { Origin: origin })).status).toBe(
      401,
    );
    expect(
      (await request('/api/cli/authorize', 'POST', body, { Cookie: browser().Cookie })).status,
    ).toBe(403);
    expect(
      (
        await request('/api/cli/authorize', 'POST', body, {
          ...browser(),
          Origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/api/cli/authorize',
          'POST',
          { ...body, redirectUri: 'https://evil.example/callback' },
          browser(),
        )
      ).status,
    ).toBe(400);
  });

  it('authorizes a CLI identity, refreshes it, and revokes its current device', async () => {
    const tokens = await login();
    expect(tokens).toMatchObject({ member: { id: 'alice', name: 'alice' }, expiresIn: 900 });
    expect(
      (await request('/api/cli/me', 'GET', undefined, bearer(tokens.accessToken))).status,
    ).toBe(200);
    const refreshed = await request('/api/cli/token', 'POST', {
      grantType: 'refresh_token',
      refreshToken: tokens.refreshToken,
    });
    const next = (await refreshed.json()) as Tokens;
    expect(refreshed.status).toBe(200);
    expect(next.member).toEqual(tokens.member);
    expect(
      (await request('/api/cli/me', 'GET', undefined, bearer(tokens.accessToken))).status,
    ).toBe(401);
    expect(
      (await request('/api/cli/logout', 'POST', undefined, bearer(next.accessToken))).status,
    ).toBe(200);
    expect((await request('/api/ledger', 'GET', undefined, bearer(next.accessToken))).status).toBe(
      401,
    );
    expect(
      (
        await request('/api/cli/token', 'POST', {
          grantType: 'refresh_token',
          refreshToken: next.refreshToken,
        })
      ).status,
    ).toBe(401);
  });

  it('does not let browser cookies replace CLI bearer proof or bearer credentials authorize more devices', async () => {
    const tokens = await login();
    expect((await request('/api/cli/me', 'GET', undefined, browser())).status).toBe(401);
    expect((await request('/api/cli/logout', 'POST', undefined, browser())).status).toBe(401);
    expect(
      (
        await request(
          '/api/cli/authorize',
          'POST',
          {},
          { ...browser(), ...bearer(tokens.accessToken) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/ledger', 'GET', undefined, {
          ...browser(),
          Authorization: 'Bearer invalid',
        })
      ).status,
    ).toBe(401);
  });

  it('limits bearer access to ledger reads, bet creation/actions and its own identity/logout', async () => {
    const tokens = await login();
    expect(
      (await request('/api/ledger', 'GET', undefined, bearer(tokens.accessToken))).status,
    ).toBe(200);
    for (const path of [
      '/api/invites',
      '/api/restaurants',
      '/api/price-observations',
      '/api/bets',
    ]) {
      expect(
        (
          await request(
            path,
            'POST',
            { name: 'New person' },
            { ...bearer(tokens.accessToken), Origin: origin },
          )
        ).status,
        path,
      ).toBe(403);
    }
    expect(
      (await request('/api/cli/sessions', 'GET', undefined, bearer(tokens.accessToken))).status,
    ).toBe(403);
    expect((await request('/api/admin', 'GET', undefined, bearer(tokens.accessToken))).status).toBe(
      403,
    );
  });

  it('preserves browser CSRF checks and denies cross-origin bearer/token calls', async () => {
    const tokens = await login();
    expect(
      (await request('/api/bets', 'POST', betInput, { Cookie: browser().Cookie })).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/api/cli/bets',
          'POST',
          { bet: betInput },
          {
            ...bearer(tokens.accessToken),
            Origin: 'https://evil.example',
            'Idempotency-Key': crypto.randomUUID(),
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/api/cli/token',
          'POST',
          { grantType: 'refresh_token', refreshToken: tokens.refreshToken },
          { Origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
  });

  it('lists and revokes only the browser member’s devices', async () => {
    const alice = await login();
    const bob = await login('bob');
    const response = await request('/api/cli/sessions', 'GET', undefined, browser());
    const body = (await response.json()) as {
      sessions: {
        id: string;
        deviceName: string;
        createdAt: string;
        lastUsedAt: string;
        expiresAt: string;
      }[];
    };
    expect(body.sessions.some((device) => device.id === alice.sessionId)).toBe(true);
    expect(body.sessions.some((device) => device.id === bob.sessionId)).toBe(false);
    expect(
      (await request(`/api/cli/sessions/${bob.sessionId}`, 'DELETE', undefined, browser())).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/cli/sessions/${alice.sessionId}`, 'DELETE', undefined, {
          Cookie: browser().Cookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(`/api/cli/sessions/${alice.sessionId}`, 'DELETE', undefined, browser()))
        .status,
    ).toBe(200);
    expect((await request('/api/ledger', 'GET', undefined, bearer(alice.accessToken))).status).toBe(
      401,
    );
    expect((await request('/api/ledger', 'GET', undefined, bearer(bob.accessToken))).status).toBe(
      200,
    );
  });

  it('never logs authorization codes or credentials', async () => {
    const captures: unknown[][] = [];
    const spies = ['info', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'info').mockImplementation((...args) => {
        captures.push(args);
      }),
    );
    try {
      const tokens = await login();
      await request('/api/cli/token', 'POST', {
        grantType: 'refresh_token',
        refreshToken: tokens.refreshToken,
      });
      expect(JSON.stringify(captures)).not.toContain(tokens.accessToken);
      expect(JSON.stringify(captures)).not.toContain(tokens.refreshToken);
      expect(JSON.stringify(captures)).not.toMatch(/ll[acr]_/);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('CLI wager creation and actor permissions', () => {
  it('rolls back the bet, audit and retry receipt if the initial prompt transition cannot persist', async () => {
    const tokens = await login();
    const key = crypto.randomUUID();
    const title = 'CLI atomic prompt rollback';
    const input = { ...betInput, title, decisionMethod: 'chatgpt' };
    const prompt =
      'Apply the agreed winning conditions to the official company launch announcement.';
    await env.DB.exec(
      `CREATE TRIGGER cli_test_fail BEFORE UPDATE ON bets WHEN json_extract(NEW.data, '$.title') = '${title}' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await create(tokens.accessToken, key, input, prompt)).status).toBe(500);
      expect(
        (
          await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM cli_bet_requests WHERE member_id = ? AND request_key = ?',
          )
            .bind('alice', key)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      expect(
        (
          await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM bets WHERE json_extract(data, '$.title') = ?",
          )
            .bind(title)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
    } finally {
      await env.DB.exec('DROP TRIGGER cli_test_fail');
      log.mockRestore();
    }
    expect((await create(tokens.accessToken, key, input, prompt)).status).toBe(201);
  });

  it('creates a complete wager once and returns the same snapshot across retries', async () => {
    const tokens = await login();
    const key = crypto.randomUUID();
    const first = await create(tokens.accessToken, key);
    const bet = (await first.json()) as Bet;
    expect(first.status, JSON.stringify(bet)).toBe(201);
    expect(bet).toMatchObject({
      creatorId: 'alice',
      opponentId: 'bob',
      status: 'pending',
      agreementApprovals: ['alice'],
      timing: betInput.timing,
      entrySource: 'cli',
    });
    expect(bet.events[0].detail).toContain('Entered via CLI.');
    expect(
      await env.DB.prepare('SELECT detail FROM events WHERE bet_id = ? AND version = 1')
        .bind(bet.id)
        .first('detail'),
    ).toBe(bet.events[0].detail);
    expect(
      (
        await create(tokens.accessToken, crypto.randomUUID(), {
          ...betInput,
          entrySource: 'browser',
        })
      ).status,
    ).toBe(400);
    const replay = await create(
      tokens.accessToken,
      key,
      Object.fromEntries(Object.entries(betInput).reverse()),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(bet);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE bet_id = ?')
          .bind(bet.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect((await create(tokens.accessToken, key, { ...betInput, stake: 3 })).status).toBe(409);
    expect(
      (await request('/api/cli/bets', 'POST', { bet: betInput }, bearer(tokens.accessToken)))
        .status,
    ).toBe(400);
  });

  it('scopes retry keys to the creating member and survives simultaneous duplicate submissions', async () => {
    const alice = await login();
    const bob = await login('bob');
    const key = crypto.randomUUID();
    const results = await Promise.all([
      create(alice.accessToken, key),
      create(alice.accessToken, key),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 201]);
    const first = (await results[0].json()) as Bet;
    expect(await results[1].json()).toEqual(first);
    const ownBet = await create(bob.accessToken, key, { ...betInput, opponentId: 'alice' });
    expect(ownBet.status).toBe(201);
    expect(((await ownBet.json()) as Bet).id).not.toBe(first.id);
  });

  it('stores the proposed ChatGPT prompt and its audit transition atomically without approving the opponent', async () => {
    const tokens = await login();
    const prompt =
      'Apply the agreed winning conditions to the official public announcement and identify which side is correct.';
    const key = crypto.randomUUID();
    const response = await create(
      tokens.accessToken,
      key,
      { ...betInput, decisionMethod: 'chatgpt' },
      prompt,
    );
    const bet = (await response.json()) as Bet;
    expect(response.status, JSON.stringify(bet)).toBe(201);
    expect(bet).toMatchObject({
      status: 'pending',
      version: 2,
      promptAgreement: { text: prompt, approvals: ['alice'] },
      agreementApprovals: ['alice'],
    });
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE bet_id = ?')
          .bind(bet.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    expect(
      (await create(tokens.accessToken, key, { ...betInput, decisionMethod: 'chatgpt' }, prompt))
        .status,
    ).toBe(200);
    expect((await create(tokens.accessToken, crypto.randomUUID(), betInput, prompt)).status).toBe(
      400,
    );
  });

  it('keeps canonical actor checks, field validation and version conflicts for CLI actions', async () => {
    const alice = await login();
    const bob = await login('bob');
    const outsider = await login('outsider');
    const bet = (await (await create(alice.accessToken, crypto.randomUUID())).json()) as Bet;
    const action = { action: { type: 'accept' }, version: bet.version };
    expect(
      (await request(`/api/bets/${bet.id}/actions`, 'POST', action, bearer(outsider.accessToken)))
        .status,
    ).toBe(403);
    expect(
      (await request(`/api/bets/${bet.id}/actions`, 'POST', action, bearer(alice.accessToken)))
        .status,
    ).toBe(400);
    expect(
      (await request(`/api/bets/${bet.id}/actions`, 'POST', action, bearer(bob.accessToken)))
        .status,
    ).toBe(200);
    expect(
      (await request(`/api/bets/${bet.id}/actions`, 'POST', action, bearer(bob.accessToken)))
        .status,
    ).toBe(409);
    expect(
      (await create(alice.accessToken, crypto.randomUUID(), { ...betInput, creatorId: 'bob' }))
        .status,
    ).toBe(400);
    expect(
      (await create(alice.accessToken, crypto.randomUUID(), { ...betInput, stake: 0 })).status,
    ).toBe(400);
    expect(
      (
        await create(alice.accessToken, crypto.randomUUID(), {
          ...betInput,
          opponentId: 'outsider-does-not-exist',
        })
      ).status,
    ).toBe(400);
  });
});
