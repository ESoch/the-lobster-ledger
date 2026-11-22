import { readFile } from 'node:fs/promises';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { build } from 'esbuild';
import app, { type WorkerBindings } from './index';
import { tokenHash } from './security';
import { authenticateMcp, exchangeMcpCode, refreshMcpTokens } from './mcp-auth';
import { READ_TOOL_COUNT, READ_TOOLS, WRITE_TOOL_COUNT, WRITE_TOOLS } from './mcp-tools';

const origin = 'https://ledger.example';
const resource = `${origin}/mcp`;
const redirect = 'https://client.example/callback';
const verifier = 'v'.repeat(64);
let mf: Miniflare;
let env: WorkerBindings;
const request = (path: string, init: RequestInit = {}) =>
  app.request(
    `${origin}${path}`,
    {
      ...init,
      headers: {
        'CF-Connecting-IP': '198.51.100.10',
        ...Object.fromEntries(new Headers(init.headers)),
      },
    },
    env,
  );
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const form = (body: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});
const cookie = (response: Response, name: string) =>
  new RegExp(`${name}=([^;]+)`).exec(response.headers.get('Set-Cookie') ?? '')?.[0] ?? '';

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import app from './worker/index'; export default { fetch(request, env, ctx) { return app.fetch(request, { ...env, AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } }, ctx); } };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-09-12',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        APP_ORIGIN: origin,
        GROUP_NAME: 'Test ledger',
        OWNER_EMAIL: 'alice@example.com',
        GOOGLE_CLIENT_ID: 'test-client',
        GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
      },
      d1Databases: ['DB'],
    }),
  );
  const DB = await mf.getD1Database('DB');
  for (const file of ['0001_ledger.sql', '0002_roll_prices.sql', '0003_cli_sessions.sql'])
    await DB.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  await applyEntrySourceMigration(DB);
  await applyPriceWithdrawMigration(DB);
  const migration = await readFile(
    new URL('../migrations/0004_mcp_oauth.sql', import.meta.url),
    'utf8',
  );
  await DB.batch(
    migration
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((s) => s.trim())
      .map((s) => DB.prepare(s)),
  );
  env = {
    DB,
    APP_ORIGIN: origin,
    GROUP_NAME: 'Test ledger',
    OWNER_EMAIL: 'alice@example.com',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  for (const id of ['alice', 'bob', 'charlie']) {
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
        new Date(Date.now() + 3600_000).toISOString(),
      )
      .run();
  }
});
afterAll(async () => {
  await mf?.dispose();
});

async function register(extra: Record<string, unknown> = {}) {
  const response = await request(
    '/oauth/register',
    json({ client_name: 'Test MCP', redirect_uris: [redirect], ...extra }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { client_id: string };
}
async function start(clientId: string, scope = 'ledger:read', extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: await tokenHash(verifier),
    code_challenge_method: 'S256',
    resource,
    scope,
    state: 'test-state',
    ...extra,
  });
  return request(`/oauth/authorize?${params}`);
}
async function consent(
  actor = 'alice',
  scope = 'ledger:read',
  clientId?: string,
  authorizationParameters: Record<string, string> = {},
) {
  clientId ??= (await register()).client_id;
  const startResponse = await start(clientId, scope, authorizationParameters);
  expect(startResponse.status).toBe(302);
  const browserCookie = `${cookie(startResponse, '__Host-lobster_mcp_request')}; __Host-lobster_session=${actor}`;
  const page = await request('/oauth/authorize', { headers: { Cookie: browserCookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
  const text = await page.text();
  const callbackOrigin = new URL(authorizationParameters.redirect_uri ?? redirect).origin;
  expect(page.headers.get('Content-Security-Policy')).toContain(
    `form-action 'self' ${callbackOrigin};`,
  );
  const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1];
  expect(csrf).toBeTruthy();
  return { clientId, browserCookie, csrf: csrf!, text };
}
async function authorize(actor = 'alice', scope = 'ledger:read') {
  const pending = await consent(actor, scope);
  const response = await request(
    '/oauth/authorize',
    form(
      { csrf: pending.csrf, decision: 'allow' },
      { Cookie: pending.browserCookie, Origin: origin },
    ),
  );
  expect(response.status, await response.clone().text()).toBe(302);
  const target = new URL(response.headers.get('Location')!);
  expect(target.origin + target.pathname).toBe(redirect);
  expect(target.searchParams.get('state')).toBe('test-state');
  expect(target.searchParams.get('iss')).toBe(origin);
  return { ...pending, code: target.searchParams.get('code')! };
}
type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};
async function tokens(actor = 'alice', scope = 'ledger:read') {
  const grant = await authorize(actor, scope);
  const response = await request(
    '/oauth/token',
    form({
      grant_type: 'authorization_code',
      code: grant.code,
      client_id: grant.clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return { ...((await response.json()) as Tokens), clientId: grant.clientId };
}
async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await request('/mcp', {
    ...json({ jsonrpc: '2.0', id: 1, method, params }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
        .at(-1)
    : JSON.parse(text);
  return { response, data };
}
const call = (token: string, name: string, args: unknown = {}) =>
  rpc(token, 'tools/call', { name, arguments: args });

describe('MCP OAuth discovery and browser consent', () => {
  it('advertises discovery and challenges without accepting browser or CLI credentials', async () => {
    const metadata = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(metadata).toMatchObject({
      resource,
      authorization_servers: [origin],
      scopes_supported: ['ledger:read'],
    });
    const server = await (await request('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: origin,
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${origin}/oauth/register`,
    });
    for (const headers of [
      {},
      { Cookie: '__Host-lobster_session=alice' },
      { Authorization: 'Bearer lla_not-an-mcp-token' },
    ] as Record<string, string>[]) {
      const res = await request('/mcp', { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain(
        '/.well-known/oauth-protected-resource/mcp',
      );
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('requires configured bindings and the canonical host for MCP and discovery', async () => {
    for (const path of ['/mcp', '/oauth/register', '/.well-known/oauth-authorization-server']) {
      expect(
        (await app.request(`${origin}${path}`, {}, { ...env, GOOGLE_CLIENT_SECRET: '' })).status,
      ).toBe(503);
      expect((await app.request(`https://other.example${path}`, {}, env)).status).toBe(403);
    }
  });
  it('rejects unsafe registration and respects edge rate limits', async () => {
    for (const uri of [
      'javascript:alert(1)',
      'http://client.example/callback',
      'https://client.example/callback#fragment',
      'https://user:pass@client.example/',
      'https://evil.example;script-src=*/callback',
    ])
      expect((await request('/oauth/register', json({ redirect_uris: [uri] }))).status).toBe(400);
    const limited = await app.request(
      `${origin}/oauth/register`,
      {
        ...json({ redirect_uris: [redirect] }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
      },
      { ...env, AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    );
    expect(limited.status).toBe(429);
    expect(
      (
        await request('/oauth/register', {
          method: 'OPTIONS',
          headers: { Origin: 'https://client.example' },
        })
      ).headers.get('Access-Control-Allow-Origin'),
    ).toBe('*');
  });
  it('rejects wrong redirects, resource, PKCE and duplicate parameters before redirecting', async () => {
    const { client_id } = await register();
    for (const extra of [
      { redirect_uri: 'https://evil.example/' },
      { resource: `${origin}/api/ledger` },
      { code_challenge_method: 'plain' },
      { code_challenge: 'invalid' },
      { scope: 'ledger:admin' },
    ] as Record<string, string>[]) {
      const response = await start(client_id, 'ledger:read', extra);
      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
    }
    const response = await request('/oauth/authorize?client_id=one&client_id=two');
    expect(response.status).toBe(400);
  });
  it('preserves a browser-bound pending request across Google sign-in', async () => {
    const { client_id } = await register();
    const started = await start(client_id);
    expect(started.headers.get('Location')).toBe(`${origin}/oauth/authorize`);
    expect(started.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    expect(started.headers.get('Set-Cookie')).toMatch(/Secure/);
    const pendingCookie = cookie(started, '__Host-lobster_mcp_request');
    const unsigned = await request('/oauth/authorize', { headers: { Cookie: pendingCookie } });
    expect(unsigned.headers.get('Location')).toBe(`${origin}/auth/google`);
    const signed = await request('/oauth/authorize', {
      headers: { Cookie: `${pendingCookie}; __Host-lobster_session=alice` },
    });
    expect(signed.status).toBe(200);
    expect((await request('/oauth/authorize')).status).toBe(400);
  });
  it('answers browser visits to OAuth and MCP URLs with readable pages instead of JSON', async () => {
    const browser = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    const expired = await request('/oauth/authorize', { headers: browser });
    expect(expired.status).toBe(400);
    expect(expired.headers.get('Content-Type')).toContain('text/html');
    const page = await expired.text();
    expect(page).toContain('This connection needs a fresh start');
    expect(page).toContain('Start again from your AI app');
    expect(page).toContain('class="shell-brand"');
    expect(page).toContain('href="/#mcp"');
    const stale = await request(
      '/oauth/authorize',
      form(
        { csrf: 'stale', decision: 'allow' },
        { ...browser, Origin: origin, Cookie: '__Host-lobster_session=alice' },
      ),
    );
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('Start again from your AI app');
    const mcp = await request('/mcp', { headers: browser });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect(mcp.headers.get('Content-Type')).toContain('text/html');
    const mcpPage = await mcp.text();
    expect(mcpPage).toContain('This address is for your AI app');
    expect(mcpPage).toContain(resource);
    // Protocol clients keep the JSON contract.
    const client = await request('/oauth/authorize');
    expect(client.headers.get('Content-Type')).toContain('application/json');
    expect(await client.json()).toMatchObject({ error: 'invalid_request' });
  });
  it('explains /mcp to a browser that arrives from another site, and keeps other cross-site calls refused', async () => {
    // A link followed from another site is a cross-site navigation: the page does nothing, so it is shown.
    const arrival = {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    };
    const visit = await request('/mcp', { headers: arrival });
    expect(visit.status).toBe(401);
    expect(visit.headers.get('Content-Type')).toContain('text/html');
    expect(visit.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect(await visit.text()).toContain('This address is for your AI app');
    const head = await request('/mcp', { method: 'HEAD', headers: arrival });
    expect(head.status).toBe(401);
    expect(head.headers.get('Content-Type')).toContain('text/html');
    // Page scripts and form posts from another site still get the refusal, whatever they accept.
    for (const init of [
      { headers: { ...arrival, 'Sec-Fetch-Mode': 'cors', Origin: 'https://evil.example' } },
      { method: 'POST', headers: { ...arrival, Origin: 'https://evil.example' } },
      { headers: { ...arrival, Authorization: 'Bearer stolen' } },
      { headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'cross-site' } },
    ] satisfies RequestInit[]) {
      const refused = await request('/mcp', init);
      expect(refused.status).toBe(403);
      expect(refused.headers.get('Content-Type')).toContain('application/json');
    }
  });
  it('renders consent and Connected apps in the shared themed shell', async () => {
    const pending = await consent();
    expect(pending.text).toContain('class="shell-brand"');
    expect(pending.text).toContain('@media (prefers-color-scheme: light)');
    expect(pending.text).toContain('<h1>Connect an MCP client</h1>');
    const connections = await request('/oauth/connections', {
      headers: { Cookie: '__Host-lobster_session=alice' },
    });
    const text = await connections.text();
    expect(text).toContain('class="shell-brand"');
    expect(text).toContain('<h1>Connected apps</h1>');
  });
  it('tells a member consenting to write access that it also corrects and withdraws price reports', async () => {
    const pending = await consent('alice', 'ledger:read ledger:write');
    expect(pending.text).toContain('Create wagers, act on your own agreements');
    expect(pending.text).toMatch(/correct or withdraw your own price reports/);
  });
  it('lets the return address wrap at its joints, never inside a name', async () => {
    const callback = 'https://client.example.com/api/mcp/auth_callback/lobster-ledger';
    const { client_id } = await register({ redirect_uris: [callback] });
    const pending = await consent('alice', 'ledger:read', client_id, { redirect_uri: callback });
    const address = /<code class="address">(.*?)<\/code>/s.exec(pending.text)?.[1];
    expect(address).toBeTruthy();
    // The joints are after each "/" (but not between the two of "//") and before ".com": the address
    // reads the same with them removed, and no break falls inside "callback" or "lobster-ledger".
    expect(address!.replaceAll('<wbr>', '')).toBe(callback);
    expect(address!.split('<wbr>')).toEqual([
      'https://',
      'client',
      '.example',
      '.com/',
      'api/',
      'mcp/',
      'auth_callback/',
      'lobster-ledger',
    ]);
    // Only a name too long for a line by itself may be split, and it must not widen the card to fit:
    // `break-word` leaves those break points out of the card's minimum width, `anywhere` counts them.
    expect(pending.text).not.toContain('overflow-wrap:break-word');
    expect(pending.text).toMatch(/\bcode\{[^}]*overflow-wrap:anywhere/);
  });
  it('requires same-origin consent, CSRF proof and the signed-in member; cancellation issues no code', async () => {
    const pending = await consent();
    expect(pending.text.replaceAll('<wbr>', '')).toContain('https://client.example/callback');
    expect(pending.text).not.toContain('Create wagers, act');
    for (const headers of [
      {},
      { Origin: 'null' },
      { Origin: 'https://evil.example' },
      { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
    ] as Record<string, string>[]) {
      expect(
        (
          await request(
            '/oauth/authorize',
            form(
              { csrf: pending.csrf, decision: 'allow' },
              { Cookie: pending.browserCookie, ...headers },
            ),
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(
          '/oauth/authorize',
          form(
            { csrf: 'wrong', decision: 'allow' },
            { Cookie: pending.browserCookie, Origin: origin },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/oauth/authorize',
          form(
            { csrf: pending.csrf, decision: 'allow' },
            {
              Cookie: pending.browserCookie.replace('session=alice', 'session=bob'),
              Origin: origin,
            },
          ),
        )
      ).status,
    ).toBe(400);
    const denied = await request(
      '/oauth/authorize',
      form(
        { csrf: pending.csrf, decision: 'deny' },
        { Cookie: pending.browserCookie, Origin: origin },
      ),
    );
    const target = new URL(denied.headers.get('Location')!);
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.has('code')).toBe(false);
    expect(
      (
        await request(
          '/oauth/authorize',
          form(
            { csrf: pending.csrf, decision: 'allow' },
            { Cookie: pending.browserCookie, Origin: origin },
          ),
        )
      ).status,
    ).toBe(400);
  });
});

describe('MCP credential isolation and rotation', () => {
  it('expires pending consent, authorization codes, inactive refresh grants and hard session lifetimes', async () => {
    const pending = await consent();
    const pendingRequest = pending.browserCookie.split(';')[0].split('=')[1];
    await env.DB.prepare(
      'UPDATE mcp_authorization_requests SET expires_at = ? WHERE request_hash = ?',
    )
      .bind(Date.now() - 1, await tokenHash(pendingRequest))
      .run();
    expect(
      (await request('/oauth/authorize', { headers: { Cookie: pending.browserCookie } })).status,
    ).toBe(400);
    const grant = await authorize();
    expect(
      await exchangeMcpCode(
        env.DB,
        {
          code: grant.code,
          code_verifier: verifier,
          client_id: grant.clientId,
          redirect_uri: redirect,
          resource,
        },
        resource,
        Date.now() + 121_000,
      ),
    ).toBeNull();
    const token = await tokens();
    const input = { client_id: token.clientId, refresh_token: token.refresh_token, resource };
    expect(await refreshMcpTokens(env.DB, input, resource, Date.now() + 31 * 86400_000)).toBeNull();
    await env.DB.prepare('UPDATE mcp_sessions SET hard_expires_at = ? WHERE client_id = ?')
      .bind(Date.now() - 1, token.clientId)
      .run();
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toBeNull();
    expect(await refreshMcpTokens(env.DB, input, resource)).toBeNull();
  });

  it('allows only one concurrent refresh and invalidates the family when the spent credential is replayed', async () => {
    const token = await tokens();
    const input = { client_id: token.clientId, refresh_token: token.refresh_token, resource };
    const results = await Promise.all([
      refreshMcpTokens(env.DB, input, resource),
      refreshMcpTokens(env.DB, input, resource),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rotated = results.find(Boolean)!;
    expect(await authenticateMcp(env.DB, rotated.access_token, resource)).toBeNull();
    expect(
      await refreshMcpTokens(env.DB, { ...input, refresh_token: rotated.refresh_token }, resource),
    ).toBeNull();
  });
  it('accepts a changing native loopback port but preserves host, path, query and the exchanged redirect', async () => {
    const { client_id } = await register({ redirect_uris: ['http://127.0.0.1/callback'] });
    const redirectUri = 'http://127.0.0.1:54321/callback';
    for (const invalid of [
      'http://localhost:54321/callback',
      'http://127.0.0.1:54321/other',
      'http://127.0.0.1:54321/callback?extra=1',
      'http://127.0.0.2:54321/callback',
      'https://127.0.0.1:54321/callback',
    ])
      expect((await start(client_id, 'ledger:read', { redirect_uri: invalid })).status).toBe(400);
    const pending = await consent('alice', 'ledger:read', client_id, { redirect_uri: redirectUri });
    const allowed = await request(
      '/oauth/authorize',
      form(
        { csrf: pending.csrf, decision: 'allow' },
        { Cookie: pending.browserCookie, Origin: origin },
      ),
    );
    const target = new URL(allowed.headers.get('Location')!);
    expect(target.origin + target.pathname).toBe(redirectUri);
    const input = {
      grant_type: 'authorization_code',
      code: target.searchParams.get('code')!,
      client_id,
      code_verifier: verifier,
      resource,
      redirect_uri: 'http://127.0.0.1:54322/callback',
    };
    expect((await request('/oauth/token', form(input))).status).toBe(400);
    expect(
      (await request('/oauth/token', form({ ...input, redirect_uri: redirectUri }))).status,
    ).toBe(200);
    const webClient = await register();
    expect(
      (
        await start(webClient.client_id, 'ledger:read', {
          redirect_uri: 'https://client.example:8443/callback',
        })
      ).status,
    ).toBe(400);
  });

  it('returns its effective public-client registration metadata', async () => {
    const registered = await request(
      '/oauth/register',
      json({
        redirect_uris: [redirect],
        scope: 'ledger:read',
        grant_types: ['authorization_code'],
      }),
    );
    expect(await registered.json()).toMatchObject({
      scope: 'ledger:read ledger:write',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('supports scoped refresh requests without expanding the browser-approved grant', async () => {
    const initial = await tokens('alice', 'ledger:read ledger:write');
    const input = {
      grant_type: 'refresh_token',
      client_id: initial.clientId,
      refresh_token: initial.refresh_token,
      resource,
      scope: 'ledger:read',
    };
    const refreshed = await request('/oauth/token', form(input));
    expect(refreshed.status).toBe(200);
    const reduced = (await refreshed.json()) as Tokens;
    expect(reduced.scope).toBe('ledger:read');
    expect(await authenticateMcp(env.DB, reduced.access_token, resource)).toMatchObject({
      scope: 'ledger:read',
    });
    expect(
      (await rpc(reduced.access_token, 'tools/list')).data.result.tools.every(
        (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint,
      ),
    ).toBe(true);
    const full = await request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        client_id: initial.clientId,
        refresh_token: reduced.refresh_token,
        resource,
      }),
    );
    expect(full.status).toBe(200);
    expect(((await full.json()) as Tokens).scope).toBe('ledger:read ledger:write');
    const readOnly = await tokens();
    const overbroad = await request(
      '/oauth/token',
      form({
        ...input,
        client_id: readOnly.clientId,
        refresh_token: readOnly.refresh_token,
        scope: 'ledger:read ledger:write',
      }),
    );
    expect(overbroad.status).toBe(400);
    expect(await overbroad.json()).toMatchObject({ error: 'invalid_scope' });
    expect(await authenticateMcp(env.DB, readOnly.access_token, resource)).toBeTruthy();
    const same = await request(
      '/oauth/token',
      form({ ...input, client_id: readOnly.clientId, refresh_token: readOnly.refresh_token }),
    );
    expect(same.status).toBe(200);
  });
  it('binds a single-use code to PKCE, exact redirect, resource and client', async () => {
    const grant = await authorize();
    const input = {
      code: grant.code,
      code_verifier: verifier,
      client_id: grant.clientId,
      redirect_uri: redirect,
      resource,
    };
    for (const patch of [
      { code_verifier: 'x'.repeat(64) },
      { redirect_uri: `${redirect}/different` },
      { resource: `${origin}/api` },
      { client_id: 'other-client' },
    ])
      expect(await exchangeMcpCode(env.DB, { ...input, ...patch }, resource)).toBeNull();
    const results = await Promise.all([
      exchangeMcpCode(env.DB, input, resource),
      exchangeMcpCode(env.DB, input, resource),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const token = results.find(Boolean)!;
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toMatchObject({
      member: { id: 'alice' },
      scope: 'ledger:read',
    });
    expect(await authenticateMcp(env.DB, token.access_token, `${origin}/api`)).toBeNull();
    expect(
      await authenticateMcp(env.DB, token.access_token, resource, Date.now() + 16 * 60_000),
    ).toBeNull();
    expect(
      (await request('/api/ledger', { headers: { Authorization: `Bearer ${token.access_token}` } }))
        .status,
    ).toBe(401);
  });
  it('rotates refresh credentials and revokes the family on reuse', async () => {
    const initial = await tokens();
    const input = { client_id: initial.clientId, refresh_token: initial.refresh_token, resource };
    expect(await refreshMcpTokens(env.DB, { ...input, client_id: 'wrong' }, resource)).toBeNull();
    const response = await request('/oauth/token', form({ ...input, grant_type: 'refresh_token' }));
    expect(response.status).toBe(200);
    const next = (await response.json()) as Tokens;
    expect(next.refresh_token).not.toBe(initial.refresh_token);
    expect(await authenticateMcp(env.DB, initial.access_token, resource)).toBeNull();
    expect(await authenticateMcp(env.DB, next.access_token, resource)).toBeTruthy();
    expect(await refreshMcpTokens(env.DB, input, resource)).toBeNull();
    expect(await authenticateMcp(env.DB, next.access_token, resource)).toBeNull();
    expect(
      await refreshMcpTokens(env.DB, { ...input, refresh_token: next.refresh_token }, resource),
    ).toBeNull();
  });
  it('revoke is idempotent and cannot revoke another client’s session', async () => {
    const token = await tokens();
    expect(
      (await request('/oauth/revoke', form({ client_id: 'other', token: token.access_token })))
        .status,
    ).toBe(200);
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toBeTruthy();
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(
            '/oauth/revoke',
            form({ client_id: token.clientId, token: token.refresh_token }),
          )
        ).status,
      ).toBe(200);
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toBeNull();
  });
  it('provides member-owned app revocation protected by browser consent checks', async () => {
    const token = await tokens();
    const identity = await authenticateMcp(env.DB, token.access_token, resource);
    const connections = await request('/oauth/connections', {
      headers: { Cookie: '__Host-lobster_session=alice' },
    });
    const text = await connections.text();
    expect(connections.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(connections.headers.get('Content-Security-Policy')).toContain("form-action 'self';");
    expect(text).toContain(identity!.sessionId);
    const csrf = /name="csrf" value="([^"]+)"/.exec(text)![1];
    const headers = {
      Cookie: `${cookie(connections, '__Host-lobster_mcp_manage')}; __Host-lobster_session=bob`,
      Origin: origin,
    };
    await request('/oauth/connections', form({ csrf, session: identity!.sessionId }, headers));
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toBeTruthy();
    const revoked = await request(
      '/oauth/connections',
      form(
        { csrf, session: identity!.sessionId },
        { ...headers, Cookie: headers.Cookie.replace('session=bob', 'session=alice') },
      ),
    );
    expect(revoked.status).toBe(303);
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toBeNull();
  });
  it('dates each connected app the way the CLI device list does', async () => {
    const token = await tokens();
    const row = await env.DB.prepare('SELECT created_at FROM mcp_sessions WHERE client_id = ?')
      .bind(token.clientId)
      .first<{ created_at: number }>();
    const connections = await request('/oauth/connections', {
      headers: { Cookie: '__Host-lobster_session=alice' },
    });
    const text = await connections.text();
    const created = new Date(row!.created_at);
    const day = created.toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    expect(text).toContain(`Connected <time datetime="${created.toISOString()}">${day}</time>`);
    expect(text).not.toMatch(/Connected \d{4}-\d{2}-\d{2}T/);
  });
  it('stores credential hashes and rejects scope escalation and malformed token requests', async () => {
    const token = await tokens();
    const row = await env.DB.prepare('SELECT access_hash FROM mcp_sessions WHERE client_id = ?')
      .bind(token.clientId)
      .first<{ access_hash: string }>();
    expect(row!.access_hash).toBe(await tokenHash(token.access_token));
    expect(row!.access_hash).not.toContain(token.access_token);
    for (const input of [
      {
        grant_type: 'refresh_token',
        client_id: token.clientId,
        refresh_token: token.refresh_token,
        resource,
        scope: 'ledger:read ledger:write',
      },
      { grant_type: 'client_credentials', client_id: token.clientId, resource },
      { grant_type: 'authorization_code', client_id: token.clientId, resource },
    ] as Record<string, string>[])
      expect((await request('/oauth/token', form(input))).status).toBe(400);
    expect(await authenticateMcp(env.DB, token.access_token, resource)).toBeTruthy();
  });
});

describe('hosted MCP tools', () => {
  it('provides official lobster price history to read-only clients with source and date context', async () => {
    const token = await tokens();
    const result = await call(token.access_token, 'get_lobster_prices', {
      fromYear: 2020,
      toYear: 2023,
    });
    expect(result.data.result?.isError, JSON.stringify(result.data)).not.toBe(true);
    const history = result.data.result.structuredContent.history;
    expect(history.observations.map((row: { year: number }) => row.year)).toEqual([
      2020, 2021, 2022, 2023,
    ]);
    expect(history).toMatchObject({
      frequency: 'annual',
      priceBasis: 'ex_vessel',
      unit: 'lb',
      sourceUpdatedOn: expect.any(String),
      checkedAt: expect.any(String),
    });
    const invalid = await call(token.access_token, 'get_lobster_prices', {
      fromYear: 2025,
      toYear: 2020,
    });
    expect(invalid.data.result?.isError || invalid.data.error).toBeTruthy();
  });
  it('creates and audits a wager inside the actual Worker runtime and recovers an identical retry', async () => {
    const token = await tokens('alice', 'ledger:read ledger:write');
    const input = {
      requestKey: 'mcp-workerd-create-0001',
      bet: {
        title: 'Worker runtime wager',
        terms: 'The published official results decide this agreement.',
        category: 'Work',
        opponentId: 'bob',
        creatorSide: 'Yes',
        opponentSide: 'No',
        stake: 1,
        deadline: '2099-01-01',
      },
    };
    const invoke = async (arguments_: unknown) => {
      const response = await mf.dispatchFetch(resource, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
          Authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_bet', arguments: arguments_ },
        }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return response.headers.get('Content-Type')?.includes('text/event-stream')
        ? JSON.parse(
            text
              .split('\n')
              .find((line) => line.startsWith('data: '))!
              .slice(6),
          )
        : JSON.parse(text);
    };
    const created = await invoke(input);
    expect(created.result.isError, JSON.stringify(created)).not.toBe(true);
    const bet = created.result.structuredContent.bet;
    expect(bet.creatorId).toBe('alice');
    expect(bet.entrySource).toBe('mcp');
    expect(bet.events[0].detail).toContain('Entered via MCP.');
    expect(bet.status).toBe('pending');
    expect((await invoke(input)).result.structuredContent.bet.id).toBe(bet.id);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM events WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(1);
    expect(
      (await invoke({ ...input, bet: { ...input.bet, creatorId: 'bob' } })).result.isError,
    ).toBe(true);
    expect(
      (await invoke({ ...input, bet: { ...input.bet, entrySource: 'cli' } })).result.isError,
    ).toBe(true);
  });
  it('serves discovery and tool calls inside the actual Cloudflare Worker runtime', async () => {
    const token = await tokens();
    const metadata = await mf.dispatchFetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    const response = await mf.dispatchFetch(resource, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_ledger', arguments: {} },
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain('"groupName":"Test ledger"');
    expect(body).not.toContain('alice@example.com');
  });
  it('negotiates MCP and exposes only read tools for read-only grants', async () => {
    const token = await tokens();
    const init = await rpc(token.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.response.status, JSON.stringify(init.data)).toBe(200);
    expect(init.data.result.serverInfo.name).toBe('lobster-ledger');
    const listed = await rpc(token.access_token, 'tools/list');
    expect(listed.data.result.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([
        'get_ledger',
        'list_bets',
        'get_bet',
        'get_balances',
        'get_leaderboard',
        'list_prices',
      ]),
    );
    expect(
      listed.data.result.tools.every(
        (t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint,
      ),
    ).toBe(true);
    const result = await call(token.access_token, 'get_ledger');
    expect(result.data.result.structuredContent.ledger.members).toHaveLength(3);
    expect(JSON.stringify(result.data)).not.toContain('alice@example.com');
    const denied = await call(token.access_token, 'create_bet');
    expect(denied.data.result?.isError || denied.data.error).toBeTruthy();
    const badOrigin = await request('/mcp', {
      ...json({}),
      headers: { Authorization: `Bearer ${token.access_token}`, Origin: 'https://evil.example' },
    });
    expect(badOrigin.status).toBe(403);
  });
  it('lists exactly the catalogued read and write tools that the setup guide counts', async () => {
    const names = async (scope: string) =>
      (await rpc((await tokens('alice', scope)).access_token, 'tools/list')).data.result.tools.map(
        (tool: { name: string }) => tool.name,
      );
    expect(READ_TOOL_COUNT).toBe(READ_TOOLS.length);
    expect(WRITE_TOOL_COUNT).toBe(WRITE_TOOLS.length);
    expect((await names('ledger:read')).sort()).toEqual([...READ_TOOLS].sort());
    expect((await names('ledger:read ledger:write')).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
  });
  it('reuses wager validation, actor identity, idempotency, version checks and independent confirmations', async () => {
    const alice = await tokens('alice', 'ledger:read ledger:write');
    const bob = await tokens('bob', 'ledger:read ledger:write');
    const charlie = await tokens('charlie', 'ledger:read ledger:write');
    const input = {
      requestKey: 'mcp-test-00000001',
      bet: {
        title: 'MCP wager',
        terms: 'The official publication determines the result.',
        category: 'Work',
        opponentId: 'bob',
        creatorSide: 'Yes',
        opponentSide: 'No',
        stake: 2,
        deadline: '2099-01-01',
      },
    };
    const created = await call(alice.access_token, 'create_bet', input);
    expect(created.data.result?.isError, JSON.stringify(created.data)).not.toBe(true);
    const bet = created.data.result.structuredContent.bet;
    expect(bet.creatorId).toBe('alice');
    expect(bet.entrySource).toBe('mcp');
    expect(bet.status).toBe('pending');
    const retry = await call(alice.access_token, 'create_bet', input);
    expect(retry.data.result.structuredContent.bet.id).toBe(bet.id);
    expect(
      (await call(alice.access_token, 'create_bet', { ...input, bet: { ...input.bet, stake: 3 } }))
        .data.result.isError,
    ).toBe(true);
    expect(
      (
        await call(alice.access_token, 'create_bet', {
          ...input,
          bet: { ...input.bet, creatorId: 'bob' },
        })
      ).data.result.isError,
    ).toBe(true);
    const action = { id: bet.id, version: bet.version, action: { type: 'accept' } };
    expect((await call(charlie.access_token, 'act_on_bet', action)).data.result.isError).toBe(true);
    const accepted = await call(bob.access_token, 'act_on_bet', action);
    expect(accepted.data.result.structuredContent.bet.status).toBe('active');
    expect(accepted.data.result.structuredContent.bet.entrySource).toBe('mcp');
    expect((await call(bob.access_token, 'act_on_bet', action)).data.result.isError).toBe(true);
    const fetched = await call(alice.access_token, 'get_bet', { id: bet.reference });
    expect(fetched.data.result.structuredContent.bet.version).toBe(bet.version + 1);
    expect(fetched.data.result.structuredContent.bet.entrySource).toBe('mcp');
    expect(fetched.data.result.structuredContent.url).toContain(encodeURIComponent(bet.id));
    for (const name of ['get_balances', 'get_leaderboard', 'list_bets'])
      expect((await call(alice.access_token, name)).data.result.isError).not.toBe(true);
  });
  it('ranks the leaderboard as the website does: only confirmed results are ranked, the rest wait', async () => {
    const alice = await tokens('alice', 'ledger:read ledger:write');
    const bob = await tokens('bob', 'ledger:read ledger:write');
    type Line = {
      member: { id: string };
      rank: number | null;
      tied: boolean;
      decided: number;
      net: number;
    };
    const lines = async () =>
      (await call(alice.access_token, 'get_leaderboard')).data.result.structuredContent
        .standings as Line[];
    const brief = (list: Line[]) => list.map((line) => [line.member.id, line.rank, line.decided]);
    // Nobody has a confirmed result yet (other tests only propose, accept and withdraw), so nobody
    // is ranked and every member is listed with a null rank, by name.
    const before = await lines();
    expect(before.map((line) => line.member.id)).toEqual(['alice', 'bob', 'charlie']);
    expect(before.every((line) => line.rank === null && !line.tied && line.decided === 0)).toBe(
      true,
    );
    const created = await call(alice.access_token, 'create_bet', {
      requestKey: 'mcp-leaderboard-bet-0001',
      bet: {
        title: 'MCP leaderboard wager',
        terms: 'The official publication determines the result.',
        category: 'Work',
        opponentId: 'bob',
        creatorSide: 'Yes',
        opponentSide: 'No',
        stake: 2,
        deadline: '2099-01-01',
      },
    });
    let bet = created.data.result.structuredContent.bet;
    const act = async (token: string, action: Record<string, unknown>) => {
      const response = await call(token, 'act_on_bet', {
        id: bet.id,
        version: bet.version,
        action,
      });
      expect(response.data.result.isError, JSON.stringify(response.data)).not.toBe(true);
      bet = response.data.result.structuredContent.bet;
    };
    await act(bob.access_token, { type: 'accept' });
    await act(alice.access_token, { type: 'mark_ready', evidence: 'The result is public.' });
    await act(alice.access_token, {
      type: 'propose_result',
      winnerId: 'alice',
      note: 'Published.',
    });
    await act(bob.access_token, { type: 'confirm_result' });
    const after = await lines();
    expect(brief(after)).toEqual([
      ['alice', 1, 1],
      ['bob', 2, 1],
      ['charlie', null, 0],
    ]);
    expect(after.map((line) => [line.tied, line.net])).toEqual([
      [false, 2],
      [false, -2],
      [false, 0],
    ]);
  });
  it('lets the creator withdraw a proposal with exactly one audit row, never from a read-only grant', async () => {
    const alice = await tokens('alice', 'ledger:read ledger:write');
    const reader = await tokens('alice', 'ledger:read');
    const created = await call(alice.access_token, 'create_bet', {
      requestKey: 'mcp-test-00000002',
      bet: {
        title: 'MCP withdrawal wager',
        terms: 'The official publication determines the result.',
        category: 'Work',
        opponentId: 'bob',
        creatorSide: 'Yes',
        opponentSide: 'No',
        stake: 1,
        deadline: '2099-01-01',
      },
    });
    const bet = created.data.result.structuredContent.bet;
    const withdraw = {
      id: bet.id,
      version: bet.version,
      action: { type: 'withdraw', note: 'Proposed the wrong opponent.' },
    };
    const denied = await call(reader.access_token, 'act_on_bet', withdraw);
    expect(denied.data.result?.isError || denied.data.error).toBeTruthy();
    const withdrawn = await call(alice.access_token, 'act_on_bet', withdraw);
    expect(withdrawn.data.result?.isError, JSON.stringify(withdrawn.data)).not.toBe(true);
    expect(withdrawn.data.result.structuredContent.bet.status).toBe('declined');
    expect(withdrawn.data.result.structuredContent.bet.events.at(-1).type).toBe('withdraw');
    const rows = await env.DB.prepare('SELECT type FROM events WHERE bet_id = ? ORDER BY version')
      .bind(bet.id)
      .all<{ type: string }>();
    expect(rows.results.map((row) => row.type)).toEqual(['created', 'withdraw']);
    expect((await call(alice.access_token, 'act_on_bet', withdraw)).data.result.isError).toBe(true);
  });
  it('records actual price reports as the authorized member and supports registry queries', async () => {
    const token = await tokens('alice', 'ledger:read ledger:write');
    const added = await call(token.access_token, 'add_restaurant', {
      name: 'MCP Lobster Shack',
      address: '1 Main Street',
    });
    const restaurant = added.data.result.structuredContent.restaurant;
    expect(restaurant.id).toBeTruthy();
    const recorded = await call(token.access_token, 'record_price', {
      restaurantId: restaurant.id,
      itemName: 'Lobster roll',
      priceCents: 2800,
      visitDate: '2026-10',
      visitDatePrecision: 'month',
    });
    expect(recorded.data.result.structuredContent.observation).toMatchObject({
      reporterId: 'alice',
      currency: 'USD',
      priceCents: 2800,
      visitDatePrecision: 'month',
    });
    expect(recorded.data.result.structuredContent.observation.entrySource).toBe('mcp');
    const listed = await call(token.access_token, 'list_prices', { restaurantId: restaurant.id });
    expect(listed.data.result.structuredContent.priceObservations).toHaveLength(1);
    expect(
      (
        await call(token.access_token, 'record_price', {
          restaurantId: restaurant.id,
          itemName: 'roll',
          priceCents: -1,
          visitDate: '2026',
          visitDatePrecision: 'day',
        })
      ).data.result.isError,
    ).toBe(true);
  });
});

describe('correcting and withdrawing prices over MCP', () => {
  it('offers both to write grants only, with withdraw_price marked destructive', async () => {
    const tools = async (scope: string) =>
      (await rpc((await tokens('alice', scope)).access_token, 'tools/list')).data.result.tools as {
        name: string;
        description: string;
        annotations: Record<string, boolean>;
      }[];
    const read = (await tools('ledger:read')).map((tool) => tool.name);
    expect(read).not.toContain('correct_price');
    expect(read).not.toContain('withdraw_price');
    const write = await tools('ledger:read ledger:write');
    const named = (name: string) => write.find((tool) => tool.name === name)!;
    expect(named('withdraw_price').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(named('correct_price').annotations).toMatchObject({ readOnlyHint: false });
    // Agents ask the member before keeping an unusual price.
    for (const name of ['record_price', 'correct_price'])
      expect(named(name).description).toMatch(/ask the user.*confirmUnusualPrice/i);
  });

  it('lists live reports by default, and earlier ones on request', async () => {
    const token = (await tokens('alice', 'ledger:read ledger:write')).access_token;
    const restaurant = (
      await call(token, 'add_restaurant', { name: 'List Filter Shack', address: 'Pier 9' })
    ).data.result.structuredContent.restaurant;
    const record = async (visitDate: string) =>
      (
        await call(token, 'record_price', {
          restaurantId: restaurant.id,
          itemName: 'Classic lobster roll',
          priceCents: 2800,
          visitDate,
          visitDatePrecision: 'day',
        })
      ).data.result.structuredContent.observation;
    const corrected = await record('2026-09-01');
    const withdrawn = await record('2026-09-02');
    const kept = await record('2026-09-03');
    const correction = await call(token, 'correct_price', {
      id: corrected.id,
      correction: {
        restaurantId: restaurant.id,
        itemName: 'Classic lobster roll',
        priceCents: 2900,
        visitDate: '2026-09-01',
        visitDatePrecision: 'day',
        correctionReason: 'Misread the menu',
      },
    });
    expect(correction.data.result.isError, JSON.stringify(correction.data)).toBeFalsy();
    const successor = correction.data.result.structuredContent.observation;
    expect(successor).toMatchObject({
      correctedFromId: corrected.id,
      correctionReason: 'Misread the menu',
      entrySource: 'mcp',
    });
    const withdrawal = await call(token, 'withdraw_price', {
      id: withdrawn.id,
      reason: 'Logged at the wrong restaurant',
    });
    expect(withdrawal.data.result.structuredContent.observation).toMatchObject({
      id: withdrawn.id,
      withdrawnReason: 'Logged at the wrong restaurant',
    });
    const ids = async (args: Record<string, unknown> = {}) =>
      (
        await call(token, 'list_prices', { restaurantId: restaurant.id, ...args })
      ).data.result.structuredContent.priceObservations
        .map((item: { id: string }) => item.id)
        .sort();
    expect(await ids()).toEqual([kept.id, successor.id].sort());
    expect(await ids({ includeCorrected: true, includeWithdrawn: true })).toEqual(
      [corrected.id, withdrawn.id, kept.id, successor.id].sort(),
    );
    expect(await ids({ includeWithdrawn: true })).toEqual(
      [withdrawn.id, kept.id, successor.id].sort(),
    );
  });
});

describe('price rules on the website and over MCP', () => {
  type Outcome =
    | { ok: true; body: Record<string, any> }
    | { ok: false; message: string; existingId?: string; warnings?: { message: string }[] };
  type Tool = 'add_restaurant' | 'record_price' | 'correct_price' | 'withdraw_price';
  const surfaces: Record<
    'website' | 'MCP',
    () => Promise<(tool: Tool, input: any) => Promise<Outcome>>
  > = {
    website: async () => async (tool, input) => {
      const [path, method, body] =
        tool === 'add_restaurant'
          ? ['/api/restaurants', 'POST', input]
          : tool === 'record_price'
            ? ['/api/price-observations', 'POST', input]
            : tool === 'correct_price'
              ? [`/api/price-observations/${input.id}`, 'PUT', input.correction]
              : [`/api/price-observations/${input.id}/withdraw`, 'POST', { reason: input.reason }];
      const response = await request(path, {
        ...json(body),
        method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: '__Host-lobster_session=bob',
          Origin: origin,
        },
      });
      const answer = (await response.json()) as Record<string, any>;
      if (!response.ok)
        return {
          ok: false,
          message: answer.error,
          existingId: answer.existingId,
          warnings: answer.warnings,
        };
      return { ok: true, body: tool === 'add_restaurant' ? { restaurant: answer } : answer };
    },
    MCP: async () => {
      const { access_token } = await tokens('bob', 'ledger:read ledger:write');
      return async (tool, input) => {
        const { data } = await call(access_token, tool, input);
        if (data.error) return { ok: false, message: data.error.message };
        if (data.result.isError)
          return {
            ok: false,
            message: data.result.content[0].text,
            warnings: data.result.structuredContent?.warnings,
          };
        return { ok: true, body: data.result.structuredContent };
      };
    },
  };
  const bodyOf = (outcome: Outcome) => {
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.body;
  };
  let unique = 0;
  const visit = (restaurantId: string, overrides: Record<string, unknown> = {}) => ({
    restaurantId,
    itemName: 'Classic lobster roll',
    priceCents: 2800,
    visitDate: '2026-09-11',
    visitDatePrecision: 'day',
    ...overrides,
  });

  describe.each(Object.keys(surfaces) as (keyof typeof surfaces)[])('on the %s', (surface) => {
    const restaurant = async (send: Awaited<ReturnType<(typeof surfaces)['MCP']>>) => {
      const added = await send('add_restaurant', {
        name: `Parity Shack ${surface} ${++unique}`,
        address: 'Pier 4',
      });
      expect(added.ok).toBe(true);
      return bodyOf(added).restaurant as { id: string; name: string };
    };

    it.each([
      ['an impossible day', { visitDate: '2026-02-31' }],
      ['a far-future day', { visitDate: '2099-01-01' }],
      ['a year before 1900', { visitDate: '1899', visitDatePrecision: 'year' }],
      ['a restaurant that is not on the record', { restaurantId: crypto.randomUUID() }],
      [
        'a new restaurant with only one coordinate',
        { restaurantId: undefined, restaurant: { name: 'Half Pin', lat: 42.35 } },
      ],
      ['an item name of only spaces', { itemName: '   ' }],
      ['an item name over 160 characters', { itemName: 'I'.repeat(161) }],
      [
        'a new restaurant named only with spaces',
        { restaurantId: undefined, restaurant: { name: '   ' } },
      ],
      [
        'a new restaurant name over 160 characters',
        { restaurantId: undefined, restaurant: { name: 'N'.repeat(161) } },
      ],
      [
        'a new restaurant address over 240 characters',
        { restaurantId: undefined, restaurant: { name: 'Long Address', address: 'A'.repeat(241) } },
      ],
    ])('refuses %s', async (_case, overrides) => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      expect((await send('record_price', visit(id, overrides))).ok).toBe(false);
    });

    it('writes nothing when text is too long or blank, and keeps text at exactly the limit', async () => {
      const send = await surfaces[surface]();
      const total = async () =>
        (await env.DB.prepare(
          'SELECT (SELECT count(*) FROM restaurants) AS r, (SELECT count(*) FROM price_observations) AS p',
        ).first<{
          r: number;
          p: number;
        }>())!;
      const before = await total();
      for (const restaurant of [
        { name: 'N'.repeat(161) },
        { name: '   ' },
        { name: 'Long Address', address: 'A'.repeat(241) },
      ])
        expect(
          (await send('record_price', visit('', { restaurantId: undefined, restaurant }))).ok,
        ).toBe(false);
      for (const restaurant of [
        { name: 'N'.repeat(161) },
        { name: 'Long Address', address: 'A'.repeat(241) },
      ])
        expect((await send('add_restaurant', restaurant)).ok).toBe(false);
      expect(await total()).toEqual(before);
      const limit = await send(
        'record_price',
        visit('', {
          restaurantId: undefined,
          restaurant: {
            name: `${surface} ${'N'.repeat(150)}`.slice(0, 160),
            address: 'A'.repeat(240),
          },
          itemName: 'I'.repeat(160),
        }),
      );
      expect(limit.ok).toBe(true);
      expect(await total()).toEqual({ r: before.r + 1, p: before.p + 1 });
    });

    it('accepts today in the latest timezone on Earth', async () => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      const today = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
      expect(await send('record_price', visit(id, { visitDate: today }))).toMatchObject({
        ok: true,
      });
    });

    it('adds a new restaurant with its report, and reuses one that differs only in case', async () => {
      const send = await surfaces[surface]();
      const name = `Inline Shack ${surface} ${++unique}`;
      const created = await send(
        'record_price',
        visit('', { restaurantId: undefined, restaurant: { name, address: 'Wharf 2' } }),
      );
      expect(created).toMatchObject({
        ok: true,
        body: { restaurant: { name }, matched: 'created' },
      });
      const id = bodyOf(created).restaurant.id as string;
      const reused = await send(
        'record_price',
        visit('', {
          restaurantId: undefined,
          restaurant: { name: name.toUpperCase(), address: ' wharf  2' },
          itemName: 'Connecticut roll',
        }),
      );
      expect(reused).toMatchObject({
        ok: true,
        body: { restaurant: { id }, matched: 'normalised', observation: { restaurantId: id } },
      });
      expect(
        await send('add_restaurant', { name: name.toLowerCase(), address: 'Wharf 2' }),
      ).toMatchObject({ ok: true, body: { restaurant: { id } } });
    });

    it('returns the report already made for a visit, and asks before a second price', async () => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      const first = await send('record_price', visit(id));
      expect(first.ok).toBe(true);
      const firstId = bodyOf(first).observation.id as string;
      expect(
        await send('record_price', visit(id, { itemName: 'classic  lobster ROLL' })),
      ).toMatchObject({ ok: true, body: { duplicateOf: firstId, observation: { id: firstId } } });
      const conflict = await send('record_price', visit(id, { priceCents: 3000 }));
      expect(conflict.ok).toBe(false);
      expect(conflict.ok || conflict.message).toContain(firstId);
      expect(
        await send('record_price', visit(id, { priceCents: 3000, confirmSeparateReport: true })),
      ).toMatchObject({ ok: true, body: { observation: { priceCents: 3000 } } });
      const rows = await env.DB.prepare(
        'SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?',
      )
        .bind(id)
        .first<{ n: number }>();
      expect(rows!.n).toBe(2);
    });

    it('asks about an unusual price with its warnings, and keeps it once confirmed', async () => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      const slip = await send('record_price', visit(id, { priceCents: 250 }));
      expect(slip).toMatchObject({
        ok: false,
        warnings: [{ message: 'You entered $2.50. Did you mean $25.00?' }],
      });
      expect(slip.ok || slip.message).toContain('confirmUnusualPrice');
      expect(
        await send('record_price', visit(id, { priceCents: 250, confirmUnusualPrice: true })),
      ).toMatchObject({ ok: true, body: { observation: { priceCents: 250 } } });
    });

    it('stamps where a report came from, whatever the client says', async () => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      const recorded = await send('record_price', visit(id));
      expect(bodyOf(recorded).observation.entrySource).toBe(surface === 'MCP' ? 'mcp' : 'web');
      expect(
        (await send('record_price', visit(id, { entrySource: 'web', visitDate: '2026-09-12' }))).ok,
      ).toBe(false);
    });

    it('corrects and withdraws only the member’s own live reports, once each', async () => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      const first = bodyOf(await send('record_price', visit(id))).observation;
      const correction = (overrides: Record<string, unknown> = {}) => ({
        id: first.id,
        correction: { ...visit(id, { priceCents: 2900 }), correctionReason: 'Typo', ...overrides },
      });
      // A correction is asked about like any new price.
      expect(await send('correct_price', correction({ priceCents: 29000 }))).toMatchObject({
        ok: false,
        warnings: [{ suggestedCents: 2900 }],
      });
      const corrected = await send('correct_price', correction());
      expect(corrected).toMatchObject({
        ok: true,
        body: { observation: { correctedFromId: first.id, correctionReason: 'Typo' } },
      });
      expect((await send('correct_price', correction({ priceCents: 3000 }))).ok).toBe(false);
      // The replaced report cannot be withdrawn; its correction can, once, with a reason.
      expect((await send('withdraw_price', { id: first.id, reason: 'Wrong place' })).ok).toBe(
        false,
      );
      const successor = bodyOf(corrected).observation.id as string;
      expect((await send('withdraw_price', { id: successor, reason: '   ' })).ok).toBe(false);
      expect(await send('withdraw_price', { id: successor, reason: 'Wrong place' })).toMatchObject({
        ok: true,
        body: { observation: { id: successor, withdrawnReason: 'Wrong place' } },
      });
      expect((await send('withdraw_price', { id: successor, reason: 'Again' })).ok).toBe(false);
      // Another member's report is theirs to change.
      const alice = await env.DB.prepare(
        "INSERT INTO price_observations (id, restaurant_id, item_name, price_cents, visit_date, visit_date_precision, reporter_id, reported_at) VALUES (?, ?, 'Classic lobster roll', 2800, '2026-09-11', 'day', 'alice', '2026-09-11T20:00:00.000Z') RETURNING id",
      )
        .bind(crypto.randomUUID(), id)
        .first<{ id: string }>();
      expect((await send('withdraw_price', { id: alice!.id, reason: 'Not mine' })).ok).toBe(false);
      expect(
        (
          await send('correct_price', {
            id: alice!.id,
            correction: visit(id, { priceCents: 2900 }),
          })
        ).ok,
      ).toBe(false);
    });

    it('holds a correction to the duplicate rule of the visit it lands on', async () => {
      const send = await surfaces[surface]();
      const { id } = await restaurant(send);
      const first = bodyOf(await send('record_price', visit(id))).observation;
      const second = bodyOf(
        await send('record_price', visit(id, { visitDate: '2026-09-12', priceCents: 3000 })),
      ).observation;
      const correct = (reportId: string, overrides: Record<string, unknown>) =>
        send('correct_price', { id: reportId, correction: visit(id, overrides) });
      // A copy of the report on record is refused even when a separate purchase is confirmed.
      for (const overrides of [{}, { confirmSeparateReport: true }, { priceCents: 3000 }]) {
        const refused = await correct(second.id, overrides);
        expect(refused.ok).toBe(false);
        expect(refused.ok || refused.message).toContain(first.id);
        if (surface === 'website') expect(refused).toMatchObject({ existingId: first.id });
      }
      const separate = await correct(second.id, { priceCents: 3000, confirmSeparateReport: true });
      expect(separate).toMatchObject({ ok: true, body: { observation: { priceCents: 3000 } } });
      // Its price can then be corrected without confirming again, but never into a copy.
      const successor = bodyOf(separate).observation.id as string;
      expect((await correct(successor, { priceCents: 3100 })).ok).toBe(true);
      const live = await env.DB.prepare(
        "SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ? AND visit_date = '2026-09-11' AND corrected_at IS NULL AND withdrawn_at IS NULL",
      )
        .bind(id)
        .first<{ n: number }>();
      expect(live!.n).toBe(2);
    });
  });
});
