import { isIP } from 'node:net';
import {
  debtOffsetSchema,
  inviteSchema,
  priceReportSchema,
  priceWithdrawalSchema,
  profileSchema,
} from '../src/lib/api-schemas';
import { memberNameProblem, openInviteProblem } from '../src/lib/member-name';
import { offsetDebts } from './debt-offsets';
import { actOnBet } from './bet-actions';
import { readLedger } from './ledger-data';
import { marketHistory } from '../src/lib/lobster-market';
import { registerMcpRoutes, OAuthError, mcpRequestCookie, returnPageCookie } from './mcp-routes';
import { renderShell, wantsHtml } from './render-shell';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';
import { authenticateCli, type CliIdentity } from './cli-auth';
import { isCliBearerRoute, isCliTokenRoute, registerCliRoutes } from './cli-routes';
import { createBet } from '../src/lib/ledger';
import type { Bet, Member } from '../src/lib/types';
import {
  actionSchema,
  newBetSchema,
  priceObservationSchema,
  restaurantSchema,
  randomToken,
  readJson,
  requireSameOrigin,
  tokenHash,
  verifyGoogleIdentity,
} from './security';
import {
  admitIdentity,
  insertBet,
  listOpenInvites,
  memberColumns,
  revokeInvite,
  updateMemberName,
} from './storage';
import {
  correctPrice,
  DuplicatePriceReport,
  getOrCreateRestaurant,
  recordPrice,
  UnusualPriceReport,
  withdrawPrice,
} from './prices';

export type WorkerBindings = Omit<Env, 'ASSETS'> & Partial<Pick<Env, 'ASSETS'>>;
export type AppEnv = {
  Bindings: WorkerBindings;
  Variables: { member: Member; cliSession?: CliIdentity };
};
const app = new Hono<AppEnv>();
const sessionCookie = '__Host-lobster_session';
const oauthCookie = '__Host-lobster_oauth';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/' };
const sessionSeconds = 7 * 24 * 60 * 60;

function configured(env: WorkerBindings) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    return Boolean(
      env.DB &&
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.OWNER_EMAIL &&
      origin.protocol === 'https:' &&
      origin.origin === env.APP_ORIGIN,
    );
  } catch {
    return false;
  }
}

async function limitAuth(c: Context<AppEnv>) {
  // Cloudflare supplies this header at the public edge. Forwarded headers and
  // browser cookies are caller-controlled and cannot identify a limiting bucket.
  const clientIp = c.req.header('CF-Connecting-IP');
  const unavailable = () =>
    new HTTPException(503, {
      message: 'Sign-in is temporarily unavailable. Please try again shortly.',
    });
  if (!c.env.AUTH_RATE_LIMITER || !clientIp || !isIP(clientIp)) throw unavailable();
  let success: boolean;
  try {
    ({ success } = await c.env.AUTH_RATE_LIMITER.limit({
      key: `lobster-ledger:oauth:${await tokenHash(clientIp)}`,
    }));
  } catch {
    throw unavailable();
  }
  if (success !== true) {
    c.header('Retry-After', '60');
    throw new HTTPException(429, {
      message: 'Too many sign-in attempts from this network. Please wait a minute and try again.',
    });
  }
}

async function authenticate(c: Context<AppEnv>) {
  const token = getCookie(c, sessionCookie);
  if (!token || token.length > 128)
    throw new HTTPException(401, { message: 'Sign in to your private ledger.' });
  const member = await c.env.DB.prepare(
    'SELECT m.id, m.name, m.initials, m.color FROM members m JOIN sessions s ON s.member_id = m.id WHERE s.token_hash = ? AND s.expires_at > ?',
  )
    .bind(await tokenHash(token), new Date().toISOString())
    .first<Member>();
  if (!member)
    throw new HTTPException(401, { message: 'Your session has expired. Please sign in again.' });
  c.set('member', member);
  return member;
}

function authDiagnosticPath(c: Context<AppEnv>) {
  if (c.req.method !== 'GET') return;
  if (c.req.path === '/auth/google') return '/auth/google';
  if (c.req.path === '/auth/callback') return '/auth/callback';
}

// Run outside the guards so Hono's error handler finalizes their response first.
app.use('*', async (c, next) => {
  const path = authDiagnosticPath(c);
  await next();
  if (path)
    console.info(JSON.stringify({ event: 'auth_request_completed', path, status: c.res.status }));
});

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (
    c.req.path !== '/api/config' &&
    (c.req.path.startsWith('/api/') ||
      c.req.path.startsWith('/auth/') ||
      c.req.path.startsWith('/oauth/') ||
      c.req.path === '/mcp' ||
      c.req.path.startsWith('/.well-known/'))
  ) {
    if (!configured(c.env))
      throw new HTTPException(503, {
        message: 'Shared sign-in is not configured yet. The demo remains available.',
      });
    if (new URL(c.req.url).origin !== c.env.APP_ORIGIN)
      throw new HTTPException(403, { message: 'Use the configured ledger address.' });
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.path.startsWith('/oauth/') &&
      c.req.path !== '/mcp'
    ) {
      const cliRequest =
        isCliTokenRoute(c.req.method, c.req.path) ||
        (c.req.header('Authorization') !== undefined && isCliBearerRoute(c.req.method, c.req.path));
      // Native clients have no Origin. Browser requests keep the existing CSRF
      // guard, even when they also supply a CLI credential.
      if (
        !cliRequest ||
        c.req.header('Origin') !== undefined ||
        c.req.header('Sec-Fetch-Site') === 'cross-site'
      ) {
        requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
      }
    }
  }
  await next();
});

app.get('/api/config', (c) =>
  c.json({ configured: configured(c.env), groupName: c.env.GROUP_NAME || 'The Lobster Ledger' }),
);

app.use('/api/*', async (c, next) => {
  if (isCliTokenRoute(c.req.method, c.req.path)) {
    await next();
    return;
  }
  const authorization = c.req.header('Authorization');
  if (authorization !== undefined) {
    if (!isCliBearerRoute(c.req.method, c.req.path))
      throw new HTTPException(403, {
        message: 'This endpoint is not available to CLI credentials.',
      });
    const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
    const identity = await authenticateCli(c.env.DB, token);
    if (!identity)
      throw new HTTPException(401, {
        message: 'CLI authorization expired or was revoked. Run lobster auth login again.',
      });
    const member = await c.env.DB.prepare(`SELECT ${memberColumns} FROM members WHERE id = ?`)
      .bind(identity.memberId)
      .first<Member>();
    if (!member)
      throw new HTTPException(401, { message: 'Your ledger membership could not be verified.' });
    c.set('member', member);
    c.set('cliSession', identity);
  } else {
    if (['/api/cli/me', '/api/cli/logout', '/api/cli/bets'].includes(c.req.path))
      throw new HTTPException(401, { message: 'A CLI bearer credential is required.' });
    await authenticate(c);
  }
  await next();
});

registerCliRoutes(app, limitAuth);
app.get('/api/lobster-market', (c) => {
  const query = z
    .object({
      fromYear: z.coerce.number().int().min(1950).max(2100).optional(),
      toYear: z.coerce.number().int().min(1950).max(2100).optional(),
    })
    .strict()
    .refine(
      (value) => (value.fromYear ?? 1950) <= (value.toYear ?? 2100),
      'Choose a valid year range.',
    )
    .parse(c.req.query());
  return c.json(marketHistory(query.fromYear, query.toYear));
});
registerMcpRoutes(app, authenticate, limitAuth);

app.get('/api/session', (c) => c.json({ member: c.get('member') }));
app.patch('/api/profile', async (c) => {
  const input = profileSchema.parse(await readJson(c.req.raw));
  return c.json({ member: await updateMemberName(c.env.DB, c.get('member').id, input.name) });
});
app.get('/api/ledger', async (c) =>
  c.json(await readLedger(c.env.DB, c.env.GROUP_NAME || 'The Lobster Ledger')),
);

app.post('/api/debt-offsets', async (c) => {
  const input = debtOffsetSchema.parse(await readJson(c.req.raw));
  return c.json(await offsetDebts(c.env.DB, c.get('member').id, input), 201);
});

app.post('/api/restaurants', async (c) => {
  const input = restaurantSchema.parse(await readJson(c.req.raw));
  const { restaurant, matched } = await getOrCreateRestaurant(c.env.DB, input, c.get('member').id);
  return c.json(restaurant, matched === 'created' ? 201 : 200);
});

/** A price asked about as unusual: the warnings go back so the member can fix or keep it. */
function unusualPrice(c: Context<AppEnv>, error: unknown) {
  if (error instanceof UnusualPriceReport)
    return c.json({ error: error.message, warnings: error.warnings }, 422);
  throw error;
}
/** Answers with the report already on record, so the member can be offered a correction of it. */
function duplicateReport(c: Context<AppEnv>, error: unknown) {
  if (error instanceof DuplicatePriceReport)
    return c.json(
      { error: error.message, existingId: error.existing.id, existing: error.existing },
      409,
    );
  return unusualPrice(c, error);
}

app.post('/api/price-observations', async (c) => {
  const input = priceReportSchema.parse(await readJson(c.req.raw));
  try {
    const recorded = await recordPrice(c.env.DB, input, c.get('member').id);
    return c.json(recorded, recorded.duplicateOf ? 200 : 201);
  } catch (error) {
    return duplicateReport(c, error);
  }
});

app.put('/api/price-observations/:id', async (c) => {
  const input = priceObservationSchema.parse(await readJson(c.req.raw));
  try {
    return c.json(await correctPrice(c.env.DB, c.req.param('id'), input, c.get('member').id), 201);
  } catch (error) {
    return duplicateReport(c, error);
  }
});

app.post('/api/price-observations/:id/withdraw', async (c) => {
  const input = priceWithdrawalSchema.parse(await readJson(c.req.raw));
  return c.json(await withdrawPrice(c.env.DB, c.req.param('id'), input, c.get('member').id));
});

app.post('/api/bets', async (c) => {
  const input = newBetSchema.parse(await readJson(c.req.raw));
  const members = (await c.env.DB.prepare(`SELECT ${memberColumns} FROM members`).all<Member>())
    .results;
  let bet: Bet;
  try {
    bet = createBet(input, c.get('member').id, members, undefined, 'browser');
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : 'Invalid bet.',
    });
  }
  await insertBet(c.env.DB, bet);
  return c.json(bet, 201);
});

app.post('/api/bets/:id/actions', async (c) => {
  const input = z
    .object({ action: actionSchema, version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
    .strict()
    .parse(await readJson(c.req.raw));
  return c.json(await actOnBet(c.env.DB, c.get('member').id, c.req.param('id'), input));
});

app.post('/api/invites', async (c) => {
  const input = inviteSchema.parse(await readJson(c.req.raw));
  // Two people must not share a name on the ledger, and the form's check only sees the members it loaded.
  const members = (await c.env.DB.prepare('SELECT name FROM members').all<{ name: string }>())
    .results;
  const taken = memberNameProblem(input.name, members);
  if (taken) throw new HTTPException(400, { message: taken });
  const now = new Date().toISOString();
  // Nor may two links wait for the same name, or both would be admitted under it.
  const waiting = (
    await c.env.DB.prepare('SELECT name FROM invites WHERE used_by IS NULL AND expires_at > ?')
      .bind(now)
      .all<{ name: string }>()
  ).results.map((invite) => invite.name);
  const duplicate = openInviteProblem(input.name, waiting);
  if (duplicate) throw new HTTPException(400, { message: duplicate });
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO invites (token_hash, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(await tokenHash(token), input.name, c.get('member').id, now, expiresAt)
    .run();
  return c.json(
    { url: `${c.env.APP_ORIGIN}/auth/google?invite=${encodeURIComponent(token)}`, expiresAt },
    201,
  );
});

app.get('/api/invites', async (c) =>
  c.json({
    invites: await listOpenInvites(c.env.DB, c.get('member').id, new Date().toISOString()),
  }),
);

app.delete('/api/invites/:id', async (c) => {
  if (
    !(await revokeInvite(c.env.DB, c.get('member').id, c.req.param('id'), new Date().toISOString()))
  )
    throw new HTTPException(404, { message: 'That invitation could not be found.' });
  return c.json({ ok: true });
});

app.get('/auth/google', async (c) => {
  await limitAuth(c);
  // Only a sign-in that Connected apps started returns there; any other one forgets an older,
  // unfinished request, so a later sign-in from the welcome page or an invitation lands on the ledger.
  if (c.req.query('return') === 'connections')
    setCookie(c, returnPageCookie, 'connections', { ...cookieOptions, maxAge: 600 });
  else if (getCookie(c, returnPageCookie) !== undefined)
    deleteCookie(c, returnPageCookie, cookieOptions);
  const invite = c.req.query('invite');
  let inviteHash: string | null = null;
  const now = new Date().toISOString();
  if (invite !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(invite))
      throw new HTTPException(403, {
        message: 'This invitation is invalid. Ask a member for a new link.',
      });
    inviteHash = await tokenHash(invite);
    const valid = await c.env.DB.prepare(
      'SELECT token_hash FROM invites WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?',
    )
      .bind(inviteHash, now)
      .first();
    if (!valid)
      throw new HTTPException(403, {
        message: 'This invitation expired or was already used. Ask a member for a new link.',
      });
  }
  const state = randomToken();
  const browser = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now),
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    c.env.DB.prepare(
      'INSERT INTO oauth_states (state_hash, browser_hash, nonce, verifier, invite_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      await tokenHash(state),
      await tokenHash(browser),
      nonce,
      verifier,
      inviteHash,
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ),
  ]);
  setCookie(c, oauthCookie, browser, { ...cookieOptions, maxAge: 600 });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
    state,
    nonce,
    code_challenge: await tokenHash(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(url.toString(), 302);
});

app.get('/auth/callback', async (c) => {
  await limitAuth(c);
  const state = c.req.query('state');
  const browser = getCookie(c, oauthCookie);
  if (!state || !browser || state.length > 128 || browser.length > 128)
    throw new HTTPException(400, {
      message: 'Sign-in could not be verified. Start again from the ledger.',
    });
  // Delete-and-return makes the state single-use before exchanging any code.
  const attempt = await c.env.DB.prepare(
    'DELETE FROM oauth_states WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING nonce, verifier, invite_hash',
  )
    .bind(await tokenHash(state), await tokenHash(browser), new Date().toISOString())
    .first<{ nonce: string; verifier: string; invite_hash: string | null }>();
  deleteCookie(c, oauthCookie, cookieOptions);
  if (!attempt)
    throw new HTTPException(400, {
      message: 'Sign-in expired or could not be verified. Start again from the ledger.',
    });
  const code = c.req.query('code');
  if (!code || code.length > 4096 || c.req.query('error'))
    throw new HTTPException(400, {
      message: 'Google sign-in was cancelled. You can try again from the ledger.',
    });
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: attempt.verifier,
    }),
  });
  if (!tokenResponse.ok)
    throw new HTTPException(401, {
      message: 'Google sign-in could not be completed. Please try again.',
    });
  const tokens = z
    .object({ id_token: z.string().min(1).max(20000) })
    .parse(await tokenResponse.json());
  let identity: Awaited<ReturnType<typeof verifyGoogleIdentity>>;
  try {
    identity = await verifyGoogleIdentity(tokens.id_token, c.env.GOOGLE_CLIENT_ID, attempt.nonce);
  } catch {
    throw new HTTPException(401, {
      message: 'Google identity could not be verified. Please sign in again.',
    });
  }
  const member = await admitIdentity(
    c.env.DB,
    identity,
    c.env.OWNER_EMAIL,
    attempt.invite_hash ?? undefined,
  );
  const token = randomToken();
  const now = new Date().toISOString();
  const previousToken = getCookie(c, sessionCookie);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(
      previousToken ? await tokenHash(previousToken) : '',
    ),
    c.env.DB.prepare(
      'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(
      await tokenHash(token),
      member.id,
      now,
      new Date(Date.now() + sessionSeconds * 1000).toISOString(),
    ),
  ]);
  setCookie(c, sessionCookie, token, { ...cookieOptions, maxAge: sessionSeconds });
  const returnPage = getCookie(c, returnPageCookie);
  if (returnPage !== undefined) deleteCookie(c, returnPageCookie, cookieOptions);
  return c.redirect(
    c.env.APP_ORIGIN +
      (getCookie(c, mcpRequestCookie)
        ? '/oauth/authorize'
        : returnPage === 'connections'
          ? '/oauth/connections'
          : ''),
    302,
  );
});

app.post('/auth/logout', async (c) => {
  await authenticate(c);
  const token = getCookie(c, sessionCookie)!;
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await tokenHash(token))
    .run();
  deleteCookie(c, sessionCookie, cookieOptions);
  return c.json({ ok: true });
});

// A browser that lands on one of these URLs gets a page; protocol and API clients keep JSON.
function browserPage(c: Context<AppEnv>) {
  if (!wantsHtml(c)) return false;
  const { path, method } = c.req;
  if (path.startsWith('/auth/')) return method === 'GET';
  if (path === '/oauth/authorize' || path === '/oauth/connections')
    return method === 'GET' || method === 'POST';
  return path === '/mcp' && method === 'GET';
}

// Each way a sign-in can fail gets its own heading and the one next step that can help: another
// attempt where trying again is sensible, another Google account for a non-member, and only the way
// back where waiting or a fresh invitation is the cure.
function signInFailure(path: string, status: number): [string, ReturnType<typeof html>] {
  const retry = (label: string) => html`<a class="button" href="/auth/google">${label}</a>`;
  const home = (primary: boolean) =>
    html`<a class="button${primary ? '' : ' button-secondary'}" href="/">Return to the ledger</a>`;
  if (status === 403 && path === '/auth/callback')
    return [
      'This Google account isn’t on the ledger yet.',
      html`${retry('Use a different Google account')} ${home(false)}`,
    ];
  if (status === 403) return ['This invitation can’t be used.', home(true)];
  if (status === 429) return ['Too many sign-in attempts.', home(true)];
  if (status === 503) return ['Sign-in is unavailable right now.', home(true)];
  if (status === 401)
    return ['Google sign-in didn’t work.', html`${retry('Try signing in again')} ${home(false)}`];
  if (status === 400 || status >= 500)
    return ['Sign-in didn’t finish.', html`${retry('Try signing in again')} ${home(false)}`];
  return ["Let's get you signed in.", home(true)];
}

function errorPage(c: Context<AppEnv>, status: ContentfulStatusCode, message: string) {
  const path = c.req.path;
  const [title, actions] =
    path === '/oauth/connections'
      ? [
          'Connected apps',
          // A fresh load fixes a stale form or session; for an outage it would only loop back here.
          status === 400 || status === 401
            ? html`<a class="button" href="/oauth/connections">Back to Connected apps</a>
                <a class="button button-secondary" href="/">Return to the ledger</a>`
            : html`<a class="button" href="/">Return to the ledger</a>`,
        ]
      : path.startsWith('/oauth/') || path === '/mcp'
        ? [
            'This connection needs a fresh start',
            html`<a class="button" href="/">Return to the ledger</a>
              <a class="button button-secondary" href="/#mcp">AI connection guide</a>`,
          ]
        : signInFailure(path, status);
  return renderShell(c, {
    title,
    problem: true,
    status,
    body: html`<p>${message}</p>
      <div class="actions">${actions}</div>`,
  });
}

app.notFound((c) => c.json({ error: 'This endpoint does not exist.' }, 404));
// Query strings, cookies, OAuth responses and user content never enter logs.
function logFailure(c: Context<AppEnv>) {
  if (!authDiagnosticPath(c))
    console.error(
      JSON.stringify({ event: 'request_failed', path: c.req.path, method: c.req.method }),
    );
}

app.onError((error, c) => {
  if (browserPage(c)) {
    if (error instanceof OAuthError) return errorPage(c, 400, error.message);
    if (error instanceof HTTPException) return errorPage(c, error.status, error.message);
    // Whatever else goes wrong on a page a person opened is still a page, with nothing of the error in it.
    logFailure(c);
    return error instanceof ZodError
      ? errorPage(c, 400, 'This request could not be read. Start again from the ledger.')
      : errorPage(c, 500, 'The ledger could not finish this request. Please try again.');
  }
  if (error instanceof OAuthError)
    return c.json({ error: error.code, error_description: error.message }, 400);
  if (error instanceof ZodError)
    return c.json(
      {
        error: 'Check the information you entered.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  logFailure(c);
  return c.json(
    { error: 'The ledger could not save or load this request. Please try again.' },
    500,
  );
});

export default app;
