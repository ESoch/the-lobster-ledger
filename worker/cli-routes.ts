import type { Hono, Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Member } from '../src/lib/types';
import type { AppEnv } from './index';
import { newBetSchema, readJson } from './security';
import { memberColumns } from './storage';
import {
  exchangeCode,
  issueAuthorization,
  listCliSessions,
  refreshTokens,
  revokeCliSession,
  type CliCredentials,
} from './cli-auth';
import { createCliBet } from './cli-bets';

export function isCliBearerRoute(method: string, path: string) {
  return (
    (method === 'GET' && ['/api/ledger', '/api/cli/me', '/api/lobster-market'].includes(path)) ||
    (method === 'POST' &&
      (['/api/cli/bets', '/api/cli/logout'].includes(path) ||
        /^\/api\/bets\/[^/]+\/actions$/.test(path)))
  );
}
export function isCliTokenRoute(method: string, path: string) {
  return method === 'POST' && path === '/api/cli/token';
}

const tokenInput = z.discriminatedUnion('grantType', [
  z
    .object({
      grantType: z.literal('authorization_code'),
      code: z.string().max(128),
      codeVerifier: z.string().max(128),
      redirectUri: z.string().max(100),
    })
    .strict(),
  z.object({ grantType: z.literal('refresh_token'), refreshToken: z.string().max(128) }).strict(),
]);

async function credentialsResponse(c: Context<AppEnv>, credentials: CliCredentials | null) {
  if (!credentials)
    throw new HTTPException(401, {
      message: 'CLI authorization expired or was revoked. Run lobster auth login again.',
    });
  const member = await c.env.DB.prepare(`SELECT ${memberColumns} FROM members WHERE id = ?`)
    .bind(credentials.memberId)
    .first<Member>();
  if (!member)
    throw new HTTPException(401, { message: 'Your ledger membership could not be verified.' });
  return c.json({
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresIn: credentials.expiresIn,
    sessionId: credentials.sessionId,
    member: { id: member.id, name: member.name },
  });
}

export function registerCliRoutes(
  app: Hono<AppEnv>,
  limitAuth: (c: Context<AppEnv>) => Promise<void>,
) {
  app.post('/api/cli/token', async (c) => {
    await limitAuth(c);
    const input = tokenInput.parse(await readJson(c.req.raw));
    const credentials =
      input.grantType === 'authorization_code'
        ? await exchangeCode(c.env.DB, input)
        : await refreshTokens(c.env.DB, input.refreshToken);
    return credentialsResponse(c, credentials);
  });
  app.post('/api/cli/authorize', async (c) => {
    await limitAuth(c);
    const body = await readJson(c.req.raw);
    try {
      return c.json(await issueAuthorization(c.env.DB, c.get('member').id, body));
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid CLI authorization request.')
        throw new HTTPException(400, { message: error.message });
      throw error;
    }
  });
  app.get('/api/cli/me', (c) =>
    c.json({
      member: { id: c.get('member').id, name: c.get('member').name },
      sessionId: c.get('cliSession')!.sessionId,
    }),
  );
  app.post('/api/cli/logout', async (c) => {
    await revokeCliSession(c.env.DB, c.get('member').id, c.get('cliSession')!.sessionId);
    return c.json({ ok: true });
  });
  app.get('/api/cli/sessions', async (c) =>
    c.json({ sessions: await listCliSessions(c.env.DB, c.get('member').id) }),
  );
  app.delete('/api/cli/sessions/:id', async (c) => {
    if (!(await revokeCliSession(c.env.DB, c.get('member').id, c.req.param('id'))))
      throw new HTTPException(404, { message: 'That CLI device could not be found.' });
    return c.json({ ok: true });
  });
  app.post('/api/cli/bets', async (c) => {
    const input = z
      .object({ bet: newBetSchema, prompt: z.string().trim().min(20).max(8000).optional() })
      .strict()
      .parse(await readJson(c.req.raw));
    const { bet, created } = await createCliBet(
      c.env.DB,
      c.get('member').id,
      c.req.header('Idempotency-Key'),
      input,
      'cli',
    );
    return c.json(bet, created ? 201 : 200);
  });
}
