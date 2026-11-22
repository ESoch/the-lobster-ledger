import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { LIMITS } from '../src/lib/limits';
import { MEMBER_NAME_TOO_LONG } from '../src/lib/member-name';
import type { Bet } from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import { tokenHash } from './security';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

let mf: Miniflare;
let env: WorkerBindings;
let capturedLogs: unknown[][];
let callbackSigningKeys: ReturnType<typeof generateKeyPair> | undefined;
beforeEach(() => {
  capturedLogs = [];
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation((...args) => {
      capturedLogs.push(args);
    });
});
afterEach(() => vi.restoreAllMocks());
const authLog = (path: '/auth/google' | '/auth/callback', status: number) => [
  JSON.stringify({ event: 'auth_request_completed', path, status }),
];
const origin = 'https://ledger.example';
const clientIp = '198.51.100.10';
function rateLimiter(max = Infinity): RateLimit {
  const attempts = new Map<string, number>();
  return {
    async limit({ key }) {
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return { success: count <= max };
    },
  };
}
const input = {
  title: 'Launch by Friday',
  terms: 'The public announcement by 5pm decides',
  category: 'Work',
  opponentId: 'bob',
  creatorSide: 'Yes',
  opponentSide: 'No',
  stake: 2,
  deadline: '2099-01-01',
};
const request = (
  path: string,
  actor?: string,
  body?: unknown,
  extraHeaders = {},
  method?: string,
) =>
  app.request(
    `${origin}${path}`,
    {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'CF-Connecting-IP': clientIp,
        ...(actor ? { Cookie: `__Host-lobster_session=${actor}` } : {}),
        ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
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
    AUTH_RATE_LIMITER: rateLimiter(),
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
  for (const id of ['alice', 'bob', 'charlie', 'diana']) {
    await DB.prepare(
      'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, `${id}@example.com`, id[0], '#153b3e', new Date().toISOString())
      .run();
    await DB.prepare(
      'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(
        await tokenHash(id),
        id,
        new Date().toISOString(),
        new Date(Date.now() + 60000).toISOString(),
      )
      .run();
  }
});

describe('sign-in request diagnostics', () => {
  it('records one fixed metadata event for a start and rejected callback without private request data', async () => {
    const privateQuery = '?state=synthetic-state&code=synthetic-code&nonce=synthetic-nonce';
    const headers = {
      Accept: 'text/html',
      Cookie: '__Host-lobster_session=synthetic-session; arbitrary=synthetic-private-cookie',
      'X-Private-Header': 'synthetic-private-header',
    };
    expect(
      (await request(`/auth/google${privateQuery}`, undefined, undefined, headers)).status,
    ).toBe(302);
    expect(
      (await request(`/auth/callback${privateQuery}`, undefined, undefined, headers)).status,
    ).toBe(400);
    expect(
      (await request('/auth/google?invite=synthetic-invite', undefined, undefined, headers)).status,
    ).toBe(403);
    expect(capturedLogs).toEqual([
      authLog('/auth/google', 302),
      authLog('/auth/callback', 400),
      authLog('/auth/google', 403),
    ]);
    expect(JSON.stringify(capturedLogs)).not.toContain('synthetic-');
  });

  it('records final middleware rejection and provider failure statuses without provider error text', async () => {
    for (const [bindings, status] of [
      [{ ...env, GOOGLE_CLIENT_SECRET: '' }, 503],
      [{ ...env, AUTH_RATE_LIMITER: rateLimiter(0) }, 429],
    ] as const) {
      expect(
        (
          await app.request(
            `${origin}/auth/google`,
            {
              headers: { 'CF-Connecting-IP': clientIp, Accept: 'text/html' },
            },
            bindings,
          )
        ).status,
      ).toBe(status);
    }
    const start = await request('/auth/google');
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) =>
      String(url) === 'https://oauth2.googleapis.com/token'
        ? Promise.resolve(new Response('synthetic-private-provider-body', { status: 400 }))
        : originalFetch(url, init),
    );
    try {
      expect(
        (
          await request(
            `/auth/callback?state=${state}&code=synthetic-private-code`,
            undefined,
            undefined,
            {
              Cookie: start.headers.getSetCookie()[0].split(';')[0],
              Accept: 'text/html',
            },
          )
        ).status,
      ).toBe(401);
      expect(capturedLogs).toEqual([
        authLog('/auth/google', 503),
        authLog('/auth/google', 429),
        authLog('/auth/google', 302),
        authLog('/auth/callback', 401),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('omits unrelated routes and logs an unexpected auth failure only once', async () => {
    expect((await request('/api/config')).status).toBe(200);
    expect((await request('/api/session')).status).toBe(401);
    expect((await request('/not-a-route')).status).toBe(404);
    expect((await request('/auth/unknown')).status).toBe(404);
    expect((await request('/auth/logout', undefined, {})).status).toBe(401);
    expect(capturedLogs).toEqual([]);
    vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(() => {
      throw new Error('synthetic-private-exception');
    });
    expect((await request('/auth/google')).status).toBe(500);
    expect(capturedLogs).toEqual([authLog('/auth/google', 500)]);
  });
});

describe('public OAuth abuse protection', () => {
  const stateCount = () =>
    env.DB.prepare('SELECT COUNT(*) AS count FROM oauth_states').first('count');

  it('limits an edge client before creating state, despite changed forwarded headers and cookies', async () => {
    const limitedEnv = { ...env, AUTH_RATE_LIMITER: rateLimiter(1) };
    const start = (ip: string, forwarded: string, cookie: string) =>
      app.request(
        `${origin}/auth/google`,
        {
          headers: { 'CF-Connecting-IP': ip, 'X-Forwarded-For': forwarded, Cookie: cookie },
        },
        limitedEnv,
      );
    const before = await stateCount();
    expect((await start(clientIp, '203.0.113.1', 'visitor=first')).status).toBe(302);
    const afterFirst = await stateCount();
    expect(afterFirst).toBe(Number(before) + 1);
    const rejected = await start(clientIp, '203.0.113.2', 'visitor=second');
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('Retry-After')).toBe('60');
    expect(rejected.headers.get('Set-Cookie')).toBeNull();
    expect(await stateCount()).toBe(afterFirst);
    expect((await start('2001:db8::10', '203.0.113.2', 'visitor=second')).status).toBe(302);
    expect(await stateCount()).toBe(Number(afterFirst) + 1);
  });

  it('fails closed without a trusted edge IP or a functioning limiter, leaving public config available', async () => {
    const before = await stateCount();
    for (const ip of [undefined, 'attacker-controlled', '198.51.100.1, 198.51.100.2']) {
      const headers: Record<string, string> = { 'X-Forwarded-For': clientIp };
      if (ip !== undefined) headers['CF-Connecting-IP'] = ip;
      expect((await app.request(`${origin}/auth/google`, { headers }, env)).status).toBe(503);
    }
    const unbound = { ...env };
    Reflect.deleteProperty(unbound, 'AUTH_RATE_LIMITER');
    const unavailable = {
      ...env,
      AUTH_RATE_LIMITER: {
        async limit() {
          throw new Error('Synthetic limiter outage');
        },
      },
    };
    for (const bindings of [unbound, unavailable]) {
      expect(
        (
          await app.request(
            `${origin}/auth/google`,
            {
              headers: { 'CF-Connecting-IP': clientIp },
            },
            bindings,
          )
        ).status,
      ).toBe(503);
    }
    expect(await stateCount()).toBe(before);
    const config = await app.request(
      `${origin}/api/config`,
      {},
      {
        ...unbound,
        GOOGLE_CLIENT_SECRET: '',
      },
    );
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ configured: false });
  });

  it('shares the limit with callbacks and preserves state when a callback is throttled', async () => {
    const limitedEnv = { ...env, AUTH_RATE_LIMITER: rateLimiter(1) };
    const start = await app.request(
      `${origin}/auth/google`,
      {
        headers: { 'CF-Connecting-IP': clientIp },
      },
      limitedEnv,
    );
    expect(start.status).toBe(302);
    const google = new URL(start.headers.get('Location')!);
    const state = google.searchParams.get('state')!;
    const headers = {
      'CF-Connecting-IP': clientIp,
      Cookie: start.headers.getSetCookie()[0].split(';')[0],
    };
    const callbackUrl = `${origin}/auth/callback?state=${state}`;
    const throttled = await app.request(callbackUrl, { headers }, limitedEnv);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Set-Cookie')).toBeNull();
    const savedAttempt = () =>
      env.DB.prepare('SELECT state_hash FROM oauth_states WHERE state_hash = ?')
        .bind(tokenHashValue)
        .first();
    const tokenHashValue = await tokenHash(state);
    expect(await savedAttempt()).not.toBeNull();
    // Once admitted, the cancellation consumes the attempt without contacting Google.
    expect((await app.request(callbackUrl, { headers }, env)).status).toBe(400);
    expect(await savedAttempt()).toBeNull();
  });
});

describe('static asset response protection', () => {
  it('protects the SPA and assets while preserving browser resource loading and map referrers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-assets-test-'));
    let assets: Miniflare | undefined;
    try {
      const rules = await readFile(new URL('../public/_headers', import.meta.url), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      await Promise.all([
        writeFile(join(directory, 'index.html'), '<!doctype html><title>Ledger test</title>'),
        writeFile(join(directory, 'app.js'), 'export const ledger = true;'),
        writeFile(join(directory, 'font.woff2'), 'synthetic font asset'),
        writeFile(join(directory, '_headers'), rules),
      ]);
      assets = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response("worker fallback") } }',
          compatibilityDate: '2026-09-12',
          assets: { directory, assetConfig: { not_found_handling: 'single-page-application' } },
        }),
      );
      for (const path of ['/', '/bets/example', '/app.js', '/font.woff2']) {
        const response = await assets.dispatchFetch(`http://localhost${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toBe('worker fallback');
        expect(response.headers.get('X-Frame-Options')).toBe('DENY');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
        const csp = response.headers.get('Content-Security-Policy');
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).not.toContain('default-src');
      }
    } finally {
      await assets?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
afterAll(async () => {
  await mf?.dispose();
});

describe('static asset caching', () => {
  // A missing /assets/* file falls back to index.html (200 text/html), so a year-long immutable
  // rule there would pin the page to a chunk URL that a tab from an older build still asks for.
  // Immutable caching needs a 404 for missing assets first, which is a routing change.
  it('never pins a static response, including the page served for a missing hashed asset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-assets-cache-test-'));
    let assets: Miniflare | undefined;
    try {
      await mkdir(join(directory, 'assets'));
      await Promise.all([
        writeFile(join(directory, 'index.html'), '<!doctype html><title>Ledger test</title>'),
        writeFile(join(directory, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
        writeFile(join(directory, 'assets', 'index-abc123.js'), 'export const ledger = true;'),
        writeFile(join(directory, 'assets', 'index-abc123.css'), 'body{margin:0}'),
        writeFile(
          join(directory, '_headers'),
          await readFile(new URL('../public/_headers', import.meta.url), 'utf8'),
        ),
      ]);
      assets = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response("worker fallback") } }',
          compatibilityDate: '2026-09-12',
          assets: { directory, assetConfig: { not_found_handling: 'single-page-application' } },
        }),
      );
      for (const path of [
        '/assets/index-abc123.js',
        '/assets/index-abc123.css',
        '/',
        '/bets/example',
        '/favicon.svg',
      ]) {
        const response = await assets.dispatchFetch(`http://localhost${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control') ?? '').not.toContain('immutable');
        // The site-wide protections apply to every static response.
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      }
      for (const headers of [
        { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script', Accept: '*/*' },
        { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' },
        {},
      ]) {
        const response = await assets.dispatchFetch('http://localhost/assets/missing-0ld4a5h.js', {
          headers,
        });
        expect(response.headers.get('Cache-Control') ?? '').not.toContain('immutable');
      }
    } finally {
      await assets?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('private API', () => {
  it('exposes only configuration publicly and rejects missing/forged sessions', async () => {
    const config = await request('/api/config');
    expect(await config.json()).toEqual({ configured: true, groupName: 'Test ledger' });
    expect((await request('/api/ledger')).status).toBe(401);
    expect((await request('/api/session', 'forged')).status).toBe(401);
    expect((await request('/api/session', 'alice')).status).toBe(200);
    const unavailable = await app.request(
      `${origin}/api/config`,
      {},
      { ...env, GOOGLE_CLIENT_SECRET: '' },
    );
    expect(await unavailable.json()).toMatchObject({ configured: false });
  });

  it('rejects cross-origin writes, invalid input, and client impersonation', async () => {
    expect(
      (await request('/api/bets', 'alice', input, { Origin: 'https://attacker.example' })).status,
    ).toBe(403);
    expect((await request('/api/bets', 'alice', { ...input, actorId: 'bob' })).status).toBe(400);
    expect((await request('/api/bets', 'alice', { ...input, entrySource: 'mcp' })).status).toBe(
      400,
    );
    expect((await request('/api/bets', 'alice', { ...input, opponentId: 'missing' })).status).toBe(
      400,
    );
  });

  it('records the complete approval lifecycle using the session actor and server time', async () => {
    let response = await request('/api/bets', 'alice', input);
    expect(response.status).toBe(201);
    let bet = (await response.json()) as Bet;
    expect(bet.creatorId).toBe('alice');
    expect(bet.entrySource).toBe('browser');
    expect(bet.events[0].detail).toContain('Entered via Browser.');
    expect(Date.now() - Date.parse(bet.createdAt)).toBeLessThan(5000);
    const outsider = await request(`/api/bets/${bet.id}/actions`, 'charlie', {
      action: { type: 'accept' },
      version: bet.version,
    });
    expect(outsider.status).toBe(403);
    for (const [actor, action, status] of [
      ['bob', { type: 'accept' }, 'active'],
      [
        'alice',
        { type: 'propose_result', winnerId: 'alice', note: 'Announcement appeared Friday' },
        'confirming',
      ],
      ['bob', { type: 'confirm_result' }, 'owed'],
      [
        'bob',
        { type: 'propose_settlement', method: 'roll', note: 'Bought two actual rolls at lunch' },
        'settling',
      ],
      ['alice', { type: 'confirm_settlement' }, 'settled'],
    ] as const) {
      response = await request(`/api/bets/${bet.id}/actions`, actor, {
        action,
        version: bet.version,
      });
      expect(response.status).toBe(200);
      bet = (await response.json()) as Bet;
      expect(bet.status).toBe(status);
      expect(bet.entrySource).toBe('browser');
      expect(bet.events.at(-1)?.actorId).toBe(actor);
    }
    expect(bet.version).toBe(6);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM events WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(6);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM outstanding_obligations WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(0);
    const ledger = await request('/api/ledger', 'alice');
    expect(ledger.headers.get('Cache-Control')).toContain('no-store');
    expect(await ledger.json()).toMatchObject({
      members: expect.any(Array),
      bets: expect.arrayContaining([
        expect.objectContaining({ id: bet.id, status: 'settled', entrySource: 'browser' }),
      ]),
    });
  });

  it('serves official annual lobster history only to authenticated members with validated year ranges', async () => {
    expect((await request('/api/lobster-market')).status).toBe(401);
    const response = await request('/api/lobster-market?fromYear=2020&toYear=2025', 'alice');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      frequency: 'annual',
      unit: 'lb',
      priceBasis: 'ex_vessel',
      observations: expect.arrayContaining([expect.objectContaining({ year: 2020 })]),
    });
    for (const query of [
      'fromYear=2025&toYear=2020',
      'fromYear=bad',
      'fromYear=1949',
      'unknown=value',
    ])
      expect((await request(`/api/lobster-market?${query}`, 'alice')).status).toBe(400);
  });

  it('keeps restaurant price observations separate from wager records', async () => {
    const created = await request('/api/restaurants', 'alice', {
      name: 'Harbor Shack',
      address: 'Seaport, Boston',
    });
    expect(created.status).toBe(201);
    const restaurant = (await created.json()) as { id: string; name: string };
    const price = await request('/api/price-observations', 'bob', {
      restaurantId: restaurant.id,
      itemName: 'Classic lobster roll',
      priceCents: 2800,
      visitDate: '2026-09-11',
      visitDatePrecision: 'day',
      note: 'Menu price before tax and tip',
    });
    expect(price.status).toBe(201);
    const recorded = (await price.json()) as { observation: { id: string }; restaurant: unknown };
    expect(recorded.restaurant).toMatchObject({ id: restaurant.id, name: 'Harbor Shack' });
    const original = recorded.observation;
    expect(original).toMatchObject({
      restaurantId: restaurant.id,
      priceCents: 2800,
      reporterId: 'bob',
      currency: 'USD',
    });
    expect(
      (
        await request(
          `/api/price-observations/${original.id}`,
          'alice',
          {
            restaurantId: restaurant.id,
            itemName: 'Classic lobster roll',
            priceCents: 2900,
            visitDate: '2026-09-11',
            visitDatePrecision: 'day',
          },
          {},
          'PUT',
        )
      ).status,
    ).toBe(403);
    const correction = await request(
      `/api/price-observations/${original.id}`,
      'bob',
      {
        restaurantId: restaurant.id,
        itemName: 'Classic lobster roll',
        priceCents: 2900,
        visitDate: '2026-09-11',
        visitDatePrecision: 'day',
      },
      {},
      'PUT',
    );
    expect(correction.status).toBe(201);
    expect(await correction.json()).toMatchObject({
      corrected: { id: original.id, correctedAt: expect.any(String) },
      observation: { correctedFromId: original.id, priceCents: 2900 },
    });
    expect(
      (
        await request('/api/price-observations', 'bob', {
          restaurantId: restaurant.id,
          itemName: 'Classic lobster roll',
          priceCents: 2800,
          visitDate: '2026-09',
          visitDatePrecision: 'day',
        })
      ).status,
    ).toBe(400);
    const ledger = await request('/api/ledger', 'alice');
    expect(await ledger.json()).toMatchObject({
      restaurants: expect.arrayContaining([expect.objectContaining({ id: restaurant.id })]),
      priceObservations: expect.arrayContaining([
        expect.objectContaining({ restaurantId: restaurant.id, reporterId: 'bob' }),
      ]),
    });
  });

  it('returns conflict for a stale version and never records cash payment', async () => {
    const bet = (await (await request('/api/bets', 'alice', input)).json()) as Bet;
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'bob', {
          action: { type: 'accept' },
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'bob', {
          action: { type: 'accept' },
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'bob', {
          action: { type: 'propose_settlement', method: 'cash', note: 'Paid cash' },
          version: 2,
        })
      ).status,
    ).toBe(400);
  });

  it('allows only the appointed judge to adjudicate and still requires both bettors to confirm', async () => {
    const created = await request('/api/bets', 'alice', {
      ...input,
      decisionMethod: 'judge',
      judgeId: 'charlie',
    });
    expect(created.status).toBe(201);
    let bet = (await created.json()) as Bet;
    expect(bet).toMatchObject({ decisionMethod: 'judge', judgeId: 'charlie' });
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'charlie', {
          action: { type: 'accept' },
          version: bet.version,
        })
      ).status,
    ).toBe(403);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'bob', {
        action: { type: 'accept' },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'diana', {
          action: { type: 'adjudicate', winnerId: 'alice', note: 'I was not appointed.' },
          version: bet.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'alice', {
          action: { type: 'propose_result', winnerId: 'alice', note: 'Skip the agreed judge.' },
          version: bet.version,
        })
      ).status,
    ).toBe(400);
    const ruling = await request(`/api/bets/${bet.id}/actions`, 'charlie', {
      action: {
        type: 'adjudicate',
        winnerId: 'alice',
        note: 'The public announcement meets the agreed deadline.',
      },
      version: bet.version,
    });
    expect(ruling.status).toBe(200);
    bet = (await ruling.json()) as Bet;
    expect(bet).toMatchObject({
      status: 'confirming',
      adjudication: { method: 'judge', recordedBy: 'charlie', winnerId: 'alice' },
      resolution: { approvals: [] },
    });
    expect(bet.events.at(-1)?.actorId).toBe('charlie');
    expect(Date.now() - Date.parse(bet.adjudication!.at)).toBeLessThan(5000);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'charlie', {
          action: { type: 'confirm_result' },
          version: bet.version,
        })
      ).status,
    ).toBe(403);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'alice', {
        action: { type: 'confirm_result' },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.status).toBe('confirming');
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM outstanding_obligations WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(0);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'bob', {
        action: { type: 'confirm_result' },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.status).toBe('owed');
    expect(
      await env.DB.prepare(
        'SELECT from_id, to_id, rolls FROM outstanding_obligations WHERE bet_id = ?',
      )
        .bind(bet.id)
        .first(),
    ).toMatchObject({ from_id: 'bob', to_id: 'alice', rolls: 2 });
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'charlie', {
          action: {
            type: 'propose_settlement',
            method: 'roll',
            note: 'I cannot settle this debt for the bettors.',
          },
          version: bet.version,
        })
      ).status,
    ).toBe(403);
  });

  it('refuses judges who are not group members or who are taking a side', async () => {
    for (const judgeId of ['alice', 'bob', 'missing']) {
      expect(
        (await request('/api/bets', 'alice', { ...input, decisionMethod: 'judge', judgeId }))
          .status,
      ).toBe(400);
    }
    expect(
      (await request('/api/bets', 'alice', { ...input, decisionMethod: 'judge' })).status,
    ).toBe(400);
  });

  it('requires both bettors to approve the exact ChatGPT prompt and then confirm the recorded recommendation', async () => {
    const created = await request('/api/bets', 'alice', { ...input, decisionMethod: 'chatgpt' });
    expect(created.status).toBe(201);
    let bet = (await created.json()) as Bet;
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'bob', {
        action: { type: 'accept' },
        version: bet.version,
      })
    ).json()) as Bet;
    const recommendation = {
      type: 'adjudicate',
      winnerId: 'alice',
      note: 'Copied recommendation: the announcement met the agreed deadline.',
      sourceUrl: 'https://chatgpt.com/share/recommendation-123',
    };
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'alice', {
          action: recommendation,
          version: bet.version,
        })
      ).status,
    ).toBe(400);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'alice', {
        action: {
          type: 'propose_prompt',
          text: 'Evaluate both sides against the recorded public announcement and deadline.',
        },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.promptAgreement?.approvals).toEqual(['alice']);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'alice', {
          action: recommendation,
          version: bet.version,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'charlie', {
          action: { type: 'approve_prompt' },
          version: bet.version,
        })
      ).status,
    ).toBe(403);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'bob', {
        action: { type: 'approve_prompt' },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.promptAgreement?.approvals).toEqual(['alice', 'bob']);
    const oldPromptVersion = bet.promptAgreement!.version;
    const versionBeforeEdit = bet.version;
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'alice', {
        action: {
          type: 'propose_prompt',
          text: 'Evaluate both positions using the public announcement and the exact agreed deadline, without assumptions.',
        },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.promptAgreement?.version).toBe(oldPromptVersion + 1);
    expect(bet.promptAgreement?.approvals).toEqual(['alice']);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'bob', {
          action: { type: 'approve_prompt' },
          version: versionBeforeEdit,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/bets/${bet.id}/actions`, 'alice', {
          action: recommendation,
          version: bet.version,
        })
      ).status,
    ).toBe(400);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'bob', {
        action: { type: 'approve_prompt' },
        version: bet.version,
      })
    ).json()) as Bet;
    const recorded = await request(`/api/bets/${bet.id}/actions`, 'alice', {
      action: recommendation,
      version: bet.version,
    });
    expect(recorded.status).toBe(200);
    bet = (await recorded.json()) as Bet;
    expect(bet).toMatchObject({
      status: 'confirming',
      adjudication: {
        method: 'chatgpt',
        recordedBy: 'alice',
        sourceUrl: recommendation.sourceUrl,
        promptVersion: bet.promptAgreement!.version,
      },
      resolution: { approvals: [] },
    });
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'alice', {
        action: { type: 'confirm_result' },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.status).toBe('confirming');
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM outstanding_obligations WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(0);
    bet = (await (
      await request(`/api/bets/${bet.id}/actions`, 'bob', {
        action: { type: 'confirm_result' },
        version: bet.version,
      })
    ).json()) as Bet;
    expect(bet.status).toBe('owed');
  });

  it('creates hashed invitations and browser-bound OAuth state with PKCE and nonce', async () => {
    const invitation = (await (
      await request('/api/invites', 'alice', { name: 'New friend' })
    ).json()) as { url: string; expiresAt: string };
    expect(invitation.url).toContain(`${origin}/auth/google?invite=`);
    const invite = new URL(invitation.url).searchParams.get('invite')!;
    expect(
      await env.DB.prepare('SELECT token_hash FROM invites WHERE token_hash = ?')
        .bind(invite)
        .first(),
    ).toBeNull();
    const start = await request(`/auth/google?invite=${invite}`);
    expect(start.status).toBe(302);
    expect(start.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(start.headers.get('Set-Cookie')).toContain('Secure');
    const google = new URL(start.headers.get('Location')!);
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    expect(google.searchParams.get('nonce')).toBeTruthy();
    expect(
      (await request(`/auth/callback?code=forged&state=${google.searchParams.get('state')}`))
        .status,
    ).toBe(400);
    expect((await request('/auth/google?invite=missing')).status).toBe(403);
  });

  describe('invitation names', () => {
    const create = async (name: unknown) => request('/api/invites', 'alice', { name });
    const tokenOf = (url: string) => new URL(url).searchParams.get('invite')!;
    const storedName = async (token: string) =>
      env.DB.prepare('SELECT name FROM invites WHERE token_hash = ?')
        .bind(await tokenHash(token))
        .first<{ name: string }>();

    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM invites').run();
    });

    it('refuses a name another open invitation already holds, whatever its case or spacing', async () => {
      expect((await create('Pat Smith')).status).toBe(201);
      for (const name of ['pat smith', '  PAT   SMITH ']) {
        const response = await request('/api/invites', 'bob', { name });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'Pat Smith already has an open invitation. Revoke it to invite them again.',
        });
      }
      expect((await create('Pat Jones')).status).toBe(201);
    });

    it('lets a name be invited again once its earlier invitation is revoked, used or over', async () => {
      const token = tokenOf(((await (await create('Pat Smith')).json()) as { url: string }).url);
      const hash = await tokenHash(token);
      expect((await create('pat smith')).status).toBe(400);
      await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE token_hash = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), hash)
        .run();
      expect((await create('pat smith')).status).toBe(201);
      await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ?').bind('bob', 'x').run();
      expect((await create('PAT SMITH')).status).toBe(201);
    });

    it('refuses a name over the shared limit with a 400 that names the field', async () => {
      const response = await create('x'.repeat(LIMITS.memberName.max + 1));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Check the information you entered.',
        details: [{ path: 'name', message: MEMBER_NAME_TOO_LONG }],
      });
      expect((await create('x'.repeat(LIMITS.memberName.max))).status).toBe(201);
    });

    it.each(['', '   \n ', 7, null])('refuses the name %j', async (name) => {
      const response = await create(name);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ details: [{ path: 'name' }] });
    });

    it('keeps the name trimmed with its inner whitespace collapsed', async () => {
      const response = await create('  jamie   chen  ');
      expect(response.status).toBe(201);
      const { url } = (await response.json()) as { url: string };
      expect(await storedName(tokenOf(url))).toEqual({ name: 'jamie chen' });
    });

    it('refuses a name a member already goes by, whatever its case or spacing', async () => {
      for (const name of ['alice', '  ALICE ', 'Bob']) {
        const response = await create(name);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: `Someone named ${name.trim().toLowerCase()} is already at the table.`,
        });
      }
    });

    it('admits the person who follows the link under the name the inviter typed', async () => {
      const { url } = (await (await create('Jamie  Chen')).json()) as { url: string };
      const start = await request(`/auth/google?invite=${tokenOf(url)}`);
      const google = new URL(start.headers.get('Location')!);
      const browserCookie = start.headers.get('Set-Cookie')!.split(';')[0];
      const { privateKey, publicKey } = await (callbackSigningKeys ??= generateKeyPair('RS256'));
      const publicJwk = await exportJWK(publicKey);
      const idToken = await new SignJWT({
        email: 'jamie@example.com',
        email_verified: true,
        nonce: google.searchParams.get('nonce'),
        name: 'jchen1987',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'callback-key' })
        .setSubject('jamie-google')
        .setIssuer('https://accounts.google.com')
        .setAudience(env.GOOGLE_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const originalFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (target: RequestInfo | URL, init?: RequestInit) => {
        if (String(target) === 'https://oauth2.googleapis.com/token')
          return Response.json({ id_token: idToken });
        if (String(target) === 'https://www.googleapis.com/oauth2/v3/certs')
          return Response.json({
            keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'callback-key' }],
          });
        return originalFetch(target, init);
      });
      try {
        const callback = await request(
          `/auth/callback?code=google-test-code&state=${google.searchParams.get('state')}`,
          undefined,
          undefined,
          { Cookie: browserCookie },
        );
        expect(callback.status).toBe(302);
        const session = callback.headers
          .getSetCookie()
          .find((value) => value.startsWith('__Host-lobster_session='))!
          .split(';')[0];
        const signedIn = (await (
          await request('/api/session', undefined, undefined, { Cookie: session })
        ).json()) as { member: { name: string; initials: string } };
        expect(signedIn.member).toMatchObject({ name: 'Jamie Chen', initials: 'JC' });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('open invitations', () => {
    const create = async (actor: string, name: string) => {
      const response = await request('/api/invites', actor, { name });
      expect(response.status).toBe(201);
      return new URL(((await response.json()) as { url: string }).url).searchParams.get('invite')!;
    };
    const list = async (actor: string) =>
      (await (await request('/api/invites', actor)).json()) as {
        invites: { id: string; name: string; createdAt: string; expiresAt: string }[];
      };
    const revoke = (
      actor: string,
      id: string,
      headers: Record<string, string> = { Origin: origin },
    ) => request(`/api/invites/${encodeURIComponent(id)}`, actor, undefined, headers, 'DELETE');
    const stored = async (token: string) =>
      env.DB.prepare('SELECT used_by FROM invites WHERE token_hash = ?')
        .bind(await tokenHash(token))
        .first();

    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM invites').run();
    });

    it('lists the invitations the caller made that can still be used, newest first, without the link', async () => {
      const first = await create('alice', 'Pat Smith');
      await create('bob', 'Somebody Else');
      const second = await create('alice', 'Quinn Lee');
      const { invites } = await list('alice');
      expect(invites.map((invite) => invite.name)).toEqual(['Quinn Lee', 'Pat Smith']);
      expect(invites[0]).toEqual({
        id: await tokenHash(second),
        name: 'Quinn Lee',
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(JSON.stringify(invites)).not.toContain(first);
      expect(new Date(invites[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('leaves out an invitation that was used or has expired', async () => {
      const used = await create('alice', 'Used Up');
      const lapsed = await create('alice', 'Lapsed Away');
      await create('alice', 'Still Open');
      await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ?')
        .bind('bob', new Date().toISOString(), await tokenHash(used))
        .run();
      await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE token_hash = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), await tokenHash(lapsed))
        .run();
      expect((await list('alice')).invites.map((invite) => invite.name)).toEqual(['Still Open']);
    });

    it('revokes one, so its link no longer starts a sign-in', async () => {
      const token = await create('alice', 'Mis Sent');
      const kept = await create('alice', 'Kept Open');
      expect((await request(`/auth/google?invite=${token}`)).status).toBe(302);
      const [target] = (await list('alice')).invites.filter((invite) => invite.name === 'Mis Sent');
      const response = await revoke('alice', target.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await request(`/auth/google?invite=${token}`)).status).toBe(403);
      expect((await request(`/auth/google?invite=${kept}`)).status).toBe(302);
      expect((await list('alice')).invites.map((invite) => invite.name)).toEqual(['Kept Open']);
    });

    it('does not let one member revoke, or find, another member’s invitation', async () => {
      const token = await create('alice', 'Alice Invited');
      const id = await tokenHash(token);
      expect((await list('bob')).invites).toEqual([]);
      const response = await revoke('bob', id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'That invitation could not be found.' });
      expect(await stored(token)).not.toBeNull();
    });

    it('keeps the record of an invitation that was used, and says it is gone when asked again', async () => {
      const token = await create('alice', 'Joined Already');
      await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ?')
        .bind('bob', new Date().toISOString(), await tokenHash(token))
        .run();
      expect((await revoke('alice', await tokenHash(token))).status).toBe(404);
      expect(await stored(token)).toEqual({ used_by: 'bob' });
      const open = await create('alice', 'Gone Now');
      const id = await tokenHash(open);
      expect((await revoke('alice', id)).status).toBe(200);
      expect((await revoke('alice', id)).status).toBe(404);
    });

    it('asks for a signed-in member and for the ledger’s own origin', async () => {
      const id = await tokenHash(await create('alice', 'Guarded'));
      expect((await request('/api/invites')).status).toBe(401);
      expect((await revoke('alice', id, {})).status).toBe(403);
      expect(
        (await revoke('alice', id, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status,
      ).toBe(403);
      expect((await list('alice')).invites).toHaveLength(1);
    });
  });

  it('revokes a session on logout', async () => {
    expect((await request('/auth/logout', 'charlie', {})).status).toBe(200);
    expect((await request('/api/session', 'charlie')).status).toBe(401);
  });

  it('gives browser sign-in failures a readable recovery page', async () => {
    const response = await request('/auth/callback', undefined, undefined, { Accept: 'text/html' });
    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('Return to the ledger');
  });

  it('renders sign-in failures in the shared themed shell', async () => {
    const response = await request('/auth/callback', undefined, undefined, { Accept: 'text/html' });
    const page = await response.text();
    expect(page).toContain('class="shell-brand"');
    expect(page).toContain('<svg');
    expect(page).toContain('@media (prefers-color-scheme: light)');
    expect(page).toContain('#101b1d');
    expect(page).toContain('clamp(');
    expect(page).toContain('<h1>');
    expect(page).toContain('Sign-in could not be verified. Start again from the ledger.');
    const nonce = /<style nonce="([^"]+)"/.exec(page)?.[1];
    expect(response.headers.get('Content-Security-Policy')).toContain(`style-src 'nonce-${nonce}'`);
  });

  describe('sign-in failure pages name the problem and the next step', () => {
    const browser = { Accept: 'text/html' };
    const heading = (page: string) => /<h1>([^<]*)<\/h1>/.exec(page)?.[1];
    const actions = (page: string) =>
      [...page.matchAll(/<a class="button[^"]*" href="([^"]+)">([^<]+)<\/a>/g)].map(
        ([, href, label]) => [href, label],
      );
    // Runs a Google round trip for a member the ledger does not know, or one where Google refuses.
    async function callback(outcome: 'stranger' | 'refused' | 'unreadable' | 'unreachable') {
      const start = await request('/auth/google');
      const google = new URL(start.headers.get('Location')!);
      const cookie = start.headers.get('Set-Cookie')!.split(';')[0];
      const { privateKey, publicKey } = await (callbackSigningKeys ??= generateKeyPair('RS256'));
      const publicJwk = await exportJWK(publicKey);
      const signed = await new SignJWT({
        email: 'stranger@example.com',
        email_verified: true,
        nonce: google.searchParams.get('nonce'),
        name: 'Stranger',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'callback-key' })
        .setSubject('stranger')
        .setIssuer('https://accounts.google.com')
        .setAudience(env.GOOGLE_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const originalFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          if (outcome === 'unreachable') throw new TypeError('network connection lost');
          if (outcome === 'unreadable') return Response.json({ access_token: 'no id token' });
          return outcome === 'refused'
            ? new Response('no', { status: 400 })
            : Response.json({ id_token: signed });
        }
        if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs')
          return Response.json({
            keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'callback-key' }],
          });
        return originalFetch(url, init);
      });
      try {
        return await request(
          `/auth/callback?code=google-test-code&state=${google.searchParams.get('state')}`,
          undefined,
          undefined,
          { ...browser, Cookie: cookie },
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it('says a sign-in that did not finish can be started again', async () => {
      const response = await request('/auth/callback', undefined, undefined, browser);
      const page = await response.text();
      expect(response.status).toBe(400);
      expect(heading(page)).toBe('Sign-in didn’t finish.');
      expect(actions(page)).toEqual([
        ['/auth/google', 'Try signing in again'],
        ['/', 'Return to the ledger'],
      ]);
    });

    it('tells a Google account that is not a member to switch accounts', async () => {
      const response = await callback('stranger');
      const page = await response.text();
      expect(response.status).toBe(403);
      expect(heading(page)).toBe('This Google account isn’t on the ledger yet.');
      expect(page).toContain('Ask a member for a new invitation to this ledger.');
      expect(actions(page)).toEqual([
        ['/auth/google', 'Use a different Google account'],
        ['/', 'Return to the ledger'],
      ]);
      expect(page).toContain('class="problem"');
    });

    it('separates a Google refusal from the other failures', async () => {
      const response = await callback('refused');
      const page = await response.text();
      expect(response.status).toBe(401);
      expect(heading(page)).toBe('Google sign-in didn’t work.');
      expect(actions(page)[0]).toEqual(['/auth/google', 'Try signing in again']);
    });

    it('shows an unexpected sign-in failure as a page too, never as JSON', async () => {
      for (const outcome of ['unreachable', 'unreadable'] as const) {
        const response = await callback(outcome);
        const page = await response.text();
        expect(response.headers.get('Content-Type')).toContain('text/html');
        expect(response.status).toBe(outcome === 'unreadable' ? 400 : 500);
        expect(heading(page)).toBe('Sign-in didn’t finish.');
        expect(actions(page)).toEqual([
          ['/auth/google', 'Try signing in again'],
          ['/', 'Return to the ledger'],
        ]);
        // Nothing from the failure itself (a stack, a schema dump, a network message) reaches the page.
        expect(page).not.toMatch(/TypeError|network connection|invalid_type|id_token|ZodError/);
      }
    });

    it('keeps JSON for an unexpected failure when the caller did not ask for a page', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('network connection lost');
      });
      try {
        const start = await request('/auth/google');
        const state = new URL(start.headers.get('Location')!).searchParams.get('state');
        const cookie = start.headers.get('Set-Cookie')!.split(';')[0];
        const response = await request(
          `/auth/callback?code=google-test-code&state=${state}`,
          undefined,
          undefined,
          { Cookie: cookie },
        );
        expect(response.status).toBe(500);
        expect(response.headers.get('Content-Type')).toContain('application/json');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does not offer a retry for an invitation that cannot be used', async () => {
      const response = await request('/auth/google?invite=missing', undefined, undefined, browser);
      const page = await response.text();
      expect(response.status).toBe(403);
      expect(heading(page)).toBe('This invitation can’t be used.');
      expect(actions(page)).toEqual([['/', 'Return to the ledger']]);
      expect(page).not.toContain('different Google account');
    });

    it('asks people who are throttled or locked out to wait, without a retry button', async () => {
      const limited = await app.request(
        `${origin}/auth/callback`,
        { headers: { ...browser, 'CF-Connecting-IP': clientIp } },
        { ...env, AUTH_RATE_LIMITER: rateLimiter(0) },
      );
      const throttled = await limited.text();
      expect(limited.status).toBe(429);
      expect(heading(throttled)).toBe('Too many sign-in attempts.');
      expect(actions(throttled)).toEqual([['/', 'Return to the ledger']]);
      const unavailable = await app.request(`${origin}/auth/google`, { headers: browser }, env);
      const outage = await unavailable.text();
      expect(unavailable.status).toBe(503);
      expect(heading(outage)).toBe('Sign-in is unavailable right now.');
      expect(actions(outage)).toEqual([['/', 'Return to the ledger']]);
    });

    it('sends a Connected apps outage only back to the ledger', async () => {
      const response = await app.request(
        `${origin}/oauth/connections`,
        { headers: { ...browser, 'CF-Connecting-IP': clientIp } },
        { ...env, GOOGLE_CLIENT_SECRET: '' },
      );
      const page = await response.text();
      expect(response.status).toBe(503);
      expect(heading(page)).toBe('Connected apps');
      expect(actions(page)).toEqual([['/', 'Return to the ledger']]);
    });

    it('offers Connected apps again when a fresh load can fix the failure', async () => {
      const response = await request('/oauth/connections', 'alice', {}, browser);
      const page = await response.text();
      expect(response.status).toBe(400);
      expect(heading(page)).toBe('Connected apps');
      expect(actions(page)).toEqual([
        ['/oauth/connections', 'Back to Connected apps'],
        ['/', 'Return to the ledger'],
      ]);
    });
  });

  it('sends a signed-out browser from Connected apps through sign-in and back', async () => {
    const response = await request('/oauth/connections', undefined, undefined, {
      Accept: 'text/html,application/xhtml+xml',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${origin}/auth/google?return=connections`);
    // The sign-in start records where it returns, so only this sign-in comes back here.
    const start = await request('/auth/google?return=connections');
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get('Location')!).origin).toBe('https://accounts.google.com');
    const returnCookie = start.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-lobster_return='))!;
    expect(returnCookie).toContain('__Host-lobster_return=connections');
    expect(returnCookie).toContain('HttpOnly');
    expect(returnCookie).toContain('Secure');
    expect(returnCookie).toContain('Max-Age=600');
    // API clients still get the JSON error.
    const api = await request('/oauth/connections');
    expect(api.status).toBe(401);
    expect(api.headers.get('Content-Type')).toContain('application/json');
  });

  it('forgets an earlier Connected apps return when any other sign-in starts', async () => {
    for (const path of ['/auth/google', '/auth/google?return=elsewhere']) {
      const start = await request(path, undefined, undefined, {
        Cookie: '__Host-lobster_return=connections',
      });
      expect(start.status).toBe(302);
      expect(start.headers.getSetCookie().join('\n')).toMatch(/__Host-lobster_return=;.*Max-Age=0/);
    }
    // A sign-in from an invitation link starts afresh too, even when the invitation is refused.
    const invite = await request('/auth/google?invite=missing', undefined, undefined, {
      Cookie: '__Host-lobster_return=connections',
    });
    expect(invite.status).toBe(403);
    expect(invite.headers.getSetCookie().join('\n')).toMatch(/__Host-lobster_return=;.*Max-Age=0/);
    // Nothing to forget, nothing sent.
    const plain = await request('/auth/google');
    expect(plain.headers.getSetCookie().join('\n')).not.toContain('__Host-lobster_return');
  });

  it.each([
    ['the ledger', '', ''],
    ['MCP consent', '; __Host-lobster_mcp_request=pending-request', '/oauth/authorize'],
    ['Connected apps', '; __Host-lobster_return=connections', '/oauth/connections'],
  ])(
    'exchanges a browser-bound code, rotates the cookie, refuses replay and returns to %s',
    async (_, pendingCookie, destination) => {
      const start = await request('/auth/google');
      const google = new URL(start.headers.get('Location')!);
      const browserCookie = start.headers.get('Set-Cookie')!.split(';')[0];
      const { privateKey, publicKey } = await (callbackSigningKeys ??= generateKeyPair('RS256'));
      const publicJwk = await exportJWK(publicKey);
      const signedToken = await new SignJWT({
        email: 'alice@example.com',
        email_verified: true,
        nonce: google.searchParams.get('nonce'),
        name: 'Alice',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'callback-key' })
        .setSubject('alice')
        .setIssuer('https://accounts.google.com')
        .setAudience(env.GOOGLE_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const originalFetch = globalThis.fetch;
      let exchangedVerifier = '';
      vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          exchangedVerifier = new URLSearchParams(String(init?.body)).get('code_verifier') ?? '';
          return Response.json({ id_token: signedToken });
        }
        if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs')
          return Response.json({
            keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'callback-key' }],
          });
        return originalFetch(url, init);
      });
      try {
        const callbackPath = `/auth/callback?code=google-test-code&state=${google.searchParams.get('state')}`;
        const callback = await request(callbackPath, undefined, undefined, {
          Cookie: `${browserCookie}; __Host-lobster_session=alice${pendingCookie}`,
        });
        expect(callback.status).toBe(302);
        expect(callback.headers.get('Location')).toBe(origin + destination);
        if (pendingCookie.includes('lobster_return'))
          expect(callback.headers.getSetCookie().join('\n')).toMatch(
            /__Host-lobster_return=;.*Max-Age=0/,
          );
        expect(await tokenHash(exchangedVerifier)).toBe(google.searchParams.get('code_challenge'));
        const session = callback.headers
          .getSetCookie()
          .find((value) => value.startsWith('__Host-lobster_session='))!;
        expect(session).toContain('HttpOnly');
        expect(session).toContain('Secure');
        expect(session).toContain('SameSite=Lax');
        expect(
          (await request('/api/session', undefined, undefined, { Cookie: session.split(';')[0] }))
            .status,
        ).toBe(200);
        expect((await request('/api/session', 'alice')).status).toBe(401);
        expect(
          (await request(callbackPath, undefined, undefined, { Cookie: browserCookie })).status,
        ).toBe(400);
        expect(capturedLogs).toEqual([
          authLog('/auth/google', 302),
          authLog('/auth/callback', 302),
          authLog('/auth/callback', 400),
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
