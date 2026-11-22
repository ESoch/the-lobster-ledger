import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { html } from 'hono/html';
import { z } from 'zod';
import type { AppEnv } from './index';
import type { Member } from '../src/lib/types';
import { randomToken, tokenHash, readJson, requireSameOrigin } from './security';
import {
  authenticateMcp,
  exchangeMcpCode,
  refreshMcpTokens,
  revokeMcpToken,
  mcpSecret,
  McpScopeError,
} from './mcp-auth';
import { createLedgerMcpServer } from './mcp-tools';
import { breakableAddress, renderShell, wantsHtml } from './render-shell';

export const mcpRequestCookie = '__Host-lobster_mcp_request';
/**
 * Where /auth/callback sends a browser after sign-in; only allow-listed values are honoured.
 * /auth/google sets it for `?return=connections` and clears it for every other sign-in.
 */
export const returnPageCookie = '__Host-lobster_return';
const options = { httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/' };
const scopes = ['ledger:read', 'ledger:write'];
const resource = (c: Context<AppEnv>) => `${c.env.APP_ORIGIN}/mcp`;
export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: string, message: string): never {
  throw new OAuthError(code, message);
}

/** When an app was connected, as the CLI device list writes it ("Oct 18, 2026"). */
function connectedOn(createdAt: number) {
  const date = new Date(createdAt);
  const day = date.toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return html`<time datetime="${date.toISOString()}">${day}</time>`;
}

/** What someone sees on opening /mcp in a browser: the address is for an AI app, not for people. */
function mcpAddressPage(c: Context<AppEnv>) {
  return renderShell(c, {
    title: 'This address is for your AI app',
    status: 401,
    body: html`<p>
        Add <code>${resource(c)}</code> to Claude, Claude Code or Codex as a remote MCP server. Your
        app opens a sign-in window when it connects, so there is nothing to do in this tab.
      </p>
      <div class="actions">
        <a class="button" href="/#mcp">Open the setup guide</a>
        <a class="button button-secondary" href="/">Return to the ledger</a>
      </div>`,
  });
}

function redirectUri(value: string) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      /^https?:\/\/(?:[a-z\d._-]+|\[[a-f\d:]+\])(?::\d+)?$/i.test(url.origin) &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function matchesMcpRedirect(registered: string, candidate: string) {
  if (registered === candidate) return true;
  if (!redirectUri(candidate)) return false;
  // RFC 8252 permits a native client to choose a new port on the same loopback
  // IP. Every other part of the registered URI must still match byte for byte.
  const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/|$)/;
  if (!loopback.test(registered) || !loopback.test(candidate)) return false;
  return registered.replace(loopback, 'http://$1') === candidate.replace(loopback, 'http://$1');
}
const registration = z.object({
  client_name: z.string().trim().min(1).max(100).default('MCP client'),
  redirect_uris: z.array(z.string().max(2048).refine(redirectUri)).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
  scope: z.string().max(100).optional(),
});
interface Client {
  id: string;
  name: string;
  redirect_uris: string;
}
interface Pending {
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: string;
  resource: string;
  name: string;
}
function parseScope(value: string | undefined) {
  const selected = [...new Set((value ?? 'ledger:read').split(' ').filter(Boolean))];
  if (!selected.includes('ledger:read') || selected.some((s) => !scopes.includes(s)))
    fail('invalid_scope', 'Request ledger:read, optionally with ledger:write.');
  return selected.sort().join(' ');
}
function uniqueParams(params: URLSearchParams) {
  const data: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(data, key))
      fail('invalid_request', 'Duplicate parameters are not supported.');
    data[key] = value;
  }
  return data;
}
async function form(request: Request): Promise<Record<string, string>> {
  if (
    !request.headers
      .get('Content-Type')
      ?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded')
  )
    fail('invalid_request', 'Send an application/x-www-form-urlencoded body.');
  if (Number(request.headers.get('Content-Length')) > 8192)
    fail('invalid_request', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail('invalid_request', 'A form body is required.');
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) {
        void reader.cancel();
        fail('invalid_request', 'The request is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return uniqueParams(new URLSearchParams(text));
}
function callback(c: Context<AppEnv>, pending: Pending, params: Record<string, string>) {
  const url = new URL(pending.redirect_uri);
  for (const [key, value] of Object.entries({
    ...params,
    state: pending.state,
    iss: c.env.APP_ORIGIN,
  }))
    url.searchParams.set(key, value);
  return c.redirect(url.href, 302);
}
function page(
  c: Context<AppEnv>,
  title: string,
  content: ReturnType<typeof html>,
  formRedirect?: string,
) {
  // no-referrer makes native form submissions send Origin: null. Keep the
  // browser's origin for our CSRF check without sharing referrers off-site.
  c.header('Referrer-Policy', 'same-origin');
  // Chrome applies form-action to the redirect after a consent submission too.
  // This origin comes only from a validated, registered authorization request.
  const redirectOrigin =
    formRedirect && redirectUri(formRedirect) ? new URL(formRedirect).origin : undefined;
  return renderShell(c, { title, body: content, forms: { redirectOrigin } });
}

export function registerMcpRoutes(
  app: Hono<AppEnv>,
  authenticate: (c: Context<AppEnv>) => Promise<Member>,
  limitAuth: (c: Context<AppEnv>) => Promise<void>,
) {
  app.use('/oauth/*', async (c, next) => {
    // Public OAuth protocol endpoints never use browser cookies as authorization.
    if (['/oauth/register', '/oauth/token', '/oauth/revoke'].includes(c.req.path)) {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type');
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
    }
    await next();
  });
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: resource(c),
      authorization_servers: [c.env.APP_ORIGIN],
      scopes_supported: ['ledger:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'The Lobster Ledger',
    }),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json({
      resource: resource(c),
      authorization_servers: [c.env.APP_ORIGIN],
      scopes_supported: ['ledger:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'The Lobster Ledger',
    }),
  );
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: c.env.APP_ORIGIN,
      authorization_endpoint: `${c.env.APP_ORIGIN}/oauth/authorize`,
      token_endpoint: `${c.env.APP_ORIGIN}/oauth/token`,
      registration_endpoint: `${c.env.APP_ORIGIN}/oauth/register`,
      revocation_endpoint: `${c.env.APP_ORIGIN}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: scopes,
      authorization_response_iss_parameter_supported: true,
    }),
  );
  app.post('/oauth/register', async (c) => {
    await limitAuth(c);
    const parsed = registration.safeParse(await readJson(c.req.raw));
    if (!parsed.success)
      fail(
        'invalid_client_metadata',
        'Provide valid HTTPS or loopback redirect URIs and public-client authentication (none).',
      );
    const input = parsed.data;
    if (!input.grant_types.includes('authorization_code') || input.response_types.length === 0)
      fail('invalid_client_metadata', 'Authorization-code flow is required.');
    // Every registered client gets the same supported protocol policy. Actual
    // ledger permissions are granted separately by a member in the browser.
    parseScope(input.scope);
    const id = randomToken(),
      now = Date.now();
    await c.env.DB.prepare(
      'INSERT INTO mcp_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(id, input.client_name, JSON.stringify(input.redirect_uris), now)
      .run();
    return c.json(
      {
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: scopes.join(' '),
        client_id: id,
        client_id_issued_at: Math.floor(now / 1000),
      },
      201,
    );
  });

  app.get('/oauth/authorize', async (c) => {
    await limitAuth(c);
    const params = uniqueParams(new URL(c.req.url).searchParams);
    if (Object.keys(params).length) {
      if (
        params.response_type !== 'code' ||
        params.code_challenge_method !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? '') ||
        !params.state ||
        params.state.length > 1024 ||
        params.resource !== resource(c)
      )
        fail(
          'invalid_request',
          'Use authorization code flow with state, S256 PKCE and this server’s exact resource URL.',
        );
      const client = await c.env.DB.prepare(
        'SELECT id, name, redirect_uris FROM mcp_clients WHERE id = ?',
      )
        .bind(params.client_id ?? '')
        .first<Client>();
      if (
        !client ||
        typeof params.redirect_uri !== 'string' ||
        !(JSON.parse(client.redirect_uris) as string[]).some((uri) =>
          matchesMcpRedirect(uri, params.redirect_uri),
        )
      )
        fail('invalid_request', 'The client or exact registered redirect URI is invalid.');
      const scope = parseScope(params.scope);
      const request = randomToken();
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM mcp_authorization_requests WHERE expires_at <= ?').bind(
          Date.now(),
        ),
        c.env.DB.prepare('DELETE FROM mcp_authorization_codes WHERE expires_at <= ?').bind(
          Date.now(),
        ),
        c.env.DB.prepare(
          'INSERT INTO mcp_authorization_requests (request_hash, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          await tokenHash(request),
          client.id,
          params.redirect_uri,
          params.state,
          params.code_challenge,
          scope,
          resource(c),
          Date.now() + 600_000,
        ),
      ]);
      setCookie(c, mcpRequestCookie, request, { ...options, maxAge: 600 });
      // Remove OAuth parameters from the browser address before sign-in or consent.
      return c.redirect(`${c.env.APP_ORIGIN}/oauth/authorize`, 302);
    }
    const request = getCookie(c, mcpRequestCookie);
    if (!request || !/^[A-Za-z0-9_-]{43}$/.test(request))
      fail('invalid_request', 'This connection request expired. Start again from your AI app.');
    const requestHash = await tokenHash(request);
    const pending = await c.env.DB.prepare(
      `SELECT r.*, c.name FROM mcp_authorization_requests r JOIN mcp_clients c ON c.id = r.client_id WHERE request_hash = ? AND expires_at > ?`,
    )
      .bind(requestHash, Date.now())
      .first<Pending>();
    if (!pending) {
      deleteCookie(c, mcpRequestCookie, options);
      fail('invalid_request', 'This connection request expired. Start again from your AI app.');
    }
    let member: Member;
    try {
      member = await authenticate(c);
    } catch (error) {
      if (error instanceof HTTPException && error.status === 401)
        return c.redirect(`${c.env.APP_ORIGIN}/auth/google`, 302);
      throw error;
    }
    const csrf = randomToken();
    await c.env.DB.prepare(
      'UPDATE mcp_authorization_requests SET member_id = ?, csrf_hash = ? WHERE request_hash = ?',
    )
      .bind(member.id, await tokenHash(csrf), requestHash)
      .run();
    return page(
      c,
      'Connect an MCP client',
      html`<p>Signed in as <strong>${member.name}</strong>.</p>
        <p>
          <strong>${pending.name}</strong> wants access to your private ledger. The client supplies
          this name; verify the callback address below.
        </p>
        <p>
          Return address: <code class="address">${breakableAddress(pending.redirect_uri)}</code>
        </p>
        <ul>
          <li>Read members, wagers, original debts, standings, restaurants and price history.</li>
          ${pending.scope.split(' ').includes('ledger:write') ? html`<li>Create wagers, act on your own agreements, add restaurants, record prices and correct or withdraw your own price reports as you. Other members must still confirm separately.</li>` : ''}
        </ul>
        <p>
          Only connect clients you trust. You can revoke access from
          <a href="/oauth/connections">Connected apps</a>.
        </p>
        <form method="post" action="/oauth/authorize">
          <input type="hidden" name="csrf" value="${csrf}" />
          <div class="actions">
            <button name="decision" value="allow" type="submit">Allow access</button>
            <button class="button-secondary" name="decision" value="deny" type="submit">
              Cancel
            </button>
          </div>
        </form>`,
      pending.redirect_uri,
    );
  });

  app.post('/oauth/authorize', async (c) => {
    requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    await limitAuth(c);
    const member = await authenticate(c),
      input = await form(c.req.raw);
    const request = getCookie(c, mcpRequestCookie);
    if (
      !request ||
      request.length > 128 ||
      !input.csrf ||
      input.csrf.length > 128 ||
      !['allow', 'deny'].includes(input.decision)
    )
      fail(
        'invalid_request',
        'This consent page expired or was already used. Start again from your AI app.',
      );
    const requestHash = await tokenHash(request),
      csrfHash = await tokenHash(input.csrf),
      now = Date.now();
    const pending = await c.env.DB.prepare(
      'SELECT * FROM mcp_authorization_requests WHERE request_hash = ? AND csrf_hash = ? AND member_id = ? AND expires_at > ?',
    )
      .bind(requestHash, csrfHash, member.id, now)
      .first<Pending>();
    if (!pending)
      fail(
        'invalid_request',
        'This consent page expired or was already used. Start again from your AI app.',
      );
    const code = mcpSecret('c'),
      codeHash = await tokenHash(code);
    const claim = 'request_hash = ? AND csrf_hash = ? AND member_id = ? AND expires_at > ?';
    const statements =
      input.decision === 'allow'
        ? [
            c.env.DB.prepare(
              `INSERT INTO mcp_authorization_codes (code_hash, client_id, member_id, redirect_uri, code_challenge, scope, resource, expires_at)
      SELECT ?, client_id, member_id, redirect_uri, code_challenge, scope, resource, ? FROM mcp_authorization_requests WHERE ${claim}`,
            ).bind(codeHash, now + 120_000, requestHash, csrfHash, member.id, now),
          ]
        : [];
    statements.push(
      c.env.DB.prepare(`DELETE FROM mcp_authorization_requests WHERE ${claim}`).bind(
        requestHash,
        csrfHash,
        member.id,
        now,
      ),
    );
    const results = await c.env.DB.batch(statements);
    if (!results[0].meta.changes)
      fail('invalid_request', 'Consent was already used. Start again from your AI app.');
    deleteCookie(c, mcpRequestCookie, options);
    return callback(c, pending, input.decision === 'allow' ? { code } : { error: 'access_denied' });
  });

  app.post('/oauth/token', async (c) => {
    c.header('Pragma', 'no-cache');
    await limitAuth(c);
    const input = await form(c.req.raw);
    if (
      !input.client_id ||
      input.client_id.length > 128 ||
      input.client_secret ||
      c.req.header('Authorization')
    )
      fail('invalid_client', 'This endpoint accepts registered public clients using PKCE.');
    if (input.resource !== resource(c))
      fail('invalid_target', 'Use this server’s exact MCP resource URL.');
    if (
      input.grant_type === 'authorization_code' &&
      (!input.code || !input.redirect_uri || !input.code_verifier)
    )
      fail('invalid_request', 'Provide the code, redirect_uri and code_verifier.');
    let tokens;
    try {
      tokens =
        input.grant_type === 'authorization_code'
          ? await exchangeMcpCode(c.env.DB, input, resource(c))
          : input.grant_type === 'refresh_token'
            ? await refreshMcpTokens(c.env.DB, input, resource(c))
            : fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    } catch (error) {
      if (error instanceof McpScopeError) fail('invalid_scope', error.message);
      throw error;
    }
    if (!tokens)
      fail(
        'invalid_grant',
        'Authorization expired, was revoked, or does not match this client, resource and PKCE proof.',
      );
    return c.json(tokens);
  });
  app.post('/oauth/revoke', async (c) => {
    await limitAuth(c);
    const input = await form(c.req.raw);
    if (!input.client_id || !input.token || input.token.length > 128)
      fail('invalid_request', 'Provide client_id and token.');
    await revokeMcpToken(c.env.DB, input.client_id, input.token);
    return c.body(null, 200);
  });

  app.get('/oauth/connections', async (c) => {
    let member: Member;
    try {
      member = await authenticate(c);
    } catch (error) {
      // A signed-out browser signs in and comes straight back here (see returnPageCookie).
      if (error instanceof HTTPException && error.status === 401 && wantsHtml(c))
        return c.redirect(`${c.env.APP_ORIGIN}/auth/google?return=connections`, 302);
      throw error;
    }
    const connections = await c.env.DB.prepare(
      `SELECT s.id, c.name, s.scope, s.created_at FROM mcp_sessions s JOIN mcp_clients c ON c.id = s.client_id WHERE member_id = ? AND revoked_at IS NULL AND refresh_expires_at > ? AND hard_expires_at > ? ORDER BY s.created_at DESC LIMIT 100`,
    )
      .bind(member.id, Date.now(), Date.now())
      .all<{ id: string; name: string; scope: string; created_at: number }>();
    const csrf = randomToken();
    setCookie(c, '__Host-lobster_mcp_manage', csrf, { ...options, maxAge: 600 });
    return page(
      c,
      'Connected apps',
      html`<p>
          Signed in as <strong>${member.name}</strong>. Revoking an app immediately invalidates its
          access and refresh credentials.
        </p>
        ${
          connections.results.length
            ? html`<ul class="connections">
                ${connections.results.map(
                  (s) =>
                    html`<li>
                      <div>
                        <strong>${s.name}</strong>
                        <span class="muted"
                          >${s.scope} · Connected ${connectedOn(s.created_at)}</span
                        >
                      </div>
                      <form method="post" action="/oauth/connections">
                        <input type="hidden" name="csrf" value="${csrf}" />
                        <input type="hidden" name="session" value="${s.id}" />
                        <button class="button-secondary" type="submit">Revoke access</button>
                      </form>
                    </li>`,
                )}
              </ul>`
            : html`<p class="muted">No connected apps.</p>`
        }
        <div class="actions">
          <a class="button button-secondary" href="/">Return to the ledger</a>
        </div>`,
    );
  });
  app.post('/oauth/connections', async (c) => {
    requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const member = await authenticate(c),
      input = await form(c.req.raw);
    const csrf = getCookie(c, '__Host-lobster_mcp_manage');
    if (!csrf || input.csrf !== csrf || !input.session || input.session.length > 100)
      fail('invalid_request', 'Refresh Connected apps before revoking access.');
    await c.env.DB.prepare(
      'UPDATE mcp_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND member_id = ?',
    )
      .bind(Date.now(), input.session, member.id)
      .run();
    return c.redirect(`${c.env.APP_ORIGIN}/oauth/connections`, 303);
  });

  app.all('/mcp', async (c) => {
    const challenge = `Bearer resource_metadata="${c.env.APP_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="ledger:read"`;
    // Someone who opens the address in a browser, typed or followed from another site, gets an
    // explanation with the same challenge. The page does nothing and shows nothing private, so it comes
    // before the origin check that protects the protocol. A credential, a script's request or a post
    // is never a visit: browsers say how a request began, and one that says nothing is a visit unless
    // it carries an Origin.
    const mode = c.req.header('Sec-Fetch-Mode');
    const navigation =
      mode === undefined ? c.req.header('Origin') === undefined : mode === 'navigate';
    const visit =
      ['GET', 'HEAD'].includes(c.req.method) &&
      navigation &&
      wantsHtml(c) &&
      c.req.header('Authorization') === undefined;
    if (visit) {
      c.header('WWW-Authenticate', challenge);
      return mcpAddressPage(c);
    }
    const origin = c.req.header('Origin');
    if (
      (origin !== undefined && origin !== c.env.APP_ORIGIN) ||
      c.req.header('Sec-Fetch-Site') === 'cross-site'
    )
      return c.json({ error: 'This request origin is not allowed.' }, 403);
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Origin', c.env.APP_ORIGIN);
      c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      c.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id',
      );
      return c.body(null, 204);
    }
    const identity = await authenticateMcp(
      c.env.DB,
      /^Bearer (\S+)$/.exec(c.req.header('Authorization') ?? '')?.[1],
      resource(c),
    );
    if (!identity) {
      c.header('WWW-Authenticate', challenge);
      if (c.req.method === 'GET' && wantsHtml(c)) return mcpAddressPage(c);
      return c.json({ error: 'MCP authorization is required.' }, 401);
    }
    let request = c.req.raw;
    if (c.req.method === 'POST') {
      const body = await readJson(request);
      const headers = new Headers(request.headers);
      headers.delete('Content-Length');
      request = new Request(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }
    const handler = createMcpHandler(() =>
      createLedgerMcpServer(
        c.env.DB,
        c.env.APP_ORIGIN,
        c.env.GROUP_NAME || 'The Lobster Ledger',
        identity,
      ),
    );
    return handler.fetch(request);
  });
}
