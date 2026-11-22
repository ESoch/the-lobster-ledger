import { tokenHash, randomToken } from './security';
import { memberColumns } from './storage';
import type { Member } from '../src/lib/types';
import type { McpIdentity } from './mcp-tools';

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 30 * 86400_000;
const HARD_MS = 90 * 86400_000;
export const mcpSecret = (kind: 'a' | 'r' | 'c') => `mcp_${kind}_${randomToken()}`;
const valid = (value: unknown, kind: string): value is string =>
  typeof value === 'string' && new RegExp(`^mcp_${kind}_[A-Za-z0-9_-]{43}$`).test(value);
interface Session {
  id: string;
  member_id: string;
  client_id: string;
  scope: string;
}
export class McpScopeError extends Error {}

async function accessScope(
  db: D1Database,
  input: Record<string, string>,
  resource: string,
  hash: string,
  grant: 'code' | 'refresh',
) {
  if (input.scope === undefined) return null;
  const requested = [...new Set(input.scope.split(' ').filter(Boolean))].sort();
  if (
    !requested.includes('ledger:read') ||
    requested.some((scope) => !['ledger:read', 'ledger:write'].includes(scope))
  )
    throw new McpScopeError('Request ledger:read, optionally with ledger:write.');
  const row =
    grant === 'code'
      ? await db
          .prepare(
            'SELECT scope FROM mcp_authorization_codes WHERE code_hash = ? AND client_id = ? AND resource = ?',
          )
          .bind(hash, input.client_id, resource)
          .first<{ scope: string }>()
      : await db
          .prepare(
            'SELECT s.scope FROM mcp_sessions s JOIN mcp_refresh_tokens t ON t.session_id = s.id WHERE t.token_hash = ? AND s.client_id = ? AND s.resource = ?',
          )
          .bind(hash, input.client_id, resource)
          .first<{ scope: string }>();
  if (row && requested.some((scope) => !row.scope.split(' ').includes(scope)))
    throw new McpScopeError('Scope cannot exceed the permissions approved in the browser.');
  return requested.join(' ');
}
function reply(row: Session | undefined, accessToken: string, refreshToken: string) {
  return row
    ? {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_MS / 1000,
        scope: row.scope,
      }
    : null;
}

export async function exchangeMcpCode(
  db: D1Database,
  input: Record<string, string>,
  resource: string,
  now = Date.now(),
) {
  if (
    !valid(input.code, 'c') ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? '') ||
    input.resource !== resource
  )
    return null;
  const codeHash = await tokenHash(input.code);
  const scope = await accessScope(db, input, resource, codeHash, 'code');
  const session = crypto.randomUUID();
  const access = mcpSecret('a'),
    refresh = mcpSecret('r');
  const [accessHash, refreshHash, challenge] = await Promise.all([
    tokenHash(access),
    tokenHash(refresh),
    tokenHash(input.code_verifier),
  ]);
  const results = await db.batch<Session>([
    db
      .prepare(
        `UPDATE mcp_authorization_codes SET redeemed_at = ?, session_id = ?
      WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND code_challenge = ?
      AND resource = ? AND redeemed_at IS NULL AND expires_at > ?`,
      )
      .bind(now, session, codeHash, input.client_id, input.redirect_uri, challenge, resource, now),
    db
      .prepare(
        `INSERT INTO mcp_sessions
      (id, client_id, member_id, scope, access_scope, resource, access_hash, access_expires_at, refresh_expires_at, hard_expires_at, created_at)
      SELECT ?, client_id, member_id, scope, COALESCE(?, scope), resource, ?, ?, ?, ?, ? FROM mcp_authorization_codes WHERE code_hash = ? AND session_id = ?`,
      )
      .bind(
        session,
        scope,
        accessHash,
        now + ACCESS_MS,
        now + REFRESH_MS,
        now + HARD_MS,
        now,
        codeHash,
        session,
      ),
    db
      .prepare(
        'INSERT INTO mcp_refresh_tokens (token_hash, session_id) SELECT ?, id FROM mcp_sessions WHERE id = ?',
      )
      .bind(refreshHash, session),
    db
      .prepare(
        'SELECT id, member_id, client_id, access_scope AS scope FROM mcp_sessions WHERE id = ?',
      )
      .bind(session),
  ]);
  return reply(results[3].results[0], access, refresh);
}

export async function refreshMcpTokens(
  db: D1Database,
  input: Record<string, string>,
  resource: string,
  now = Date.now(),
) {
  if (!valid(input.refresh_token, 'r') || input.resource !== resource) return null;
  const hash = await tokenHash(input.refresh_token);
  const scope = await accessScope(db, input, resource, hash, 'refresh');
  const access = mcpSecret('a'),
    refresh = mcpSecret('r');
  const [accessHash, refreshHash] = await Promise.all([tokenHash(access), tokenHash(refresh)]);
  // Spent hashes stay for the token family's lifetime. Reuse revokes the family.
  const results = await db.batch<Session>([
    db
      .prepare(
        `UPDATE mcp_sessions SET revoked_at = ? WHERE client_id = ? AND resource = ? AND revoked_at IS NULL
      AND id IN (SELECT session_id FROM mcp_refresh_tokens WHERE token_hash = ? AND used_at IS NOT NULL)`,
      )
      .bind(now, input.client_id, resource, hash),
    db
      .prepare(
        `UPDATE mcp_refresh_tokens SET used_at = ?, replacement_hash = ? WHERE token_hash = ? AND used_at IS NULL
      AND session_id IN (SELECT id FROM mcp_sessions WHERE client_id = ? AND resource = ? AND revoked_at IS NULL AND refresh_expires_at > ? AND hard_expires_at > ?)`,
      )
      .bind(now, refreshHash, hash, input.client_id, resource, now, now),
    db
      .prepare(
        `INSERT INTO mcp_refresh_tokens (token_hash, session_id)
      SELECT ?, session_id FROM mcp_refresh_tokens WHERE token_hash = ? AND replacement_hash = ?`,
      )
      .bind(refreshHash, hash, refreshHash),
    db
      .prepare(
        `UPDATE mcp_sessions SET access_hash = ?, access_scope = COALESCE(?, scope), access_expires_at = ?, refresh_expires_at = MIN(?, hard_expires_at)
      WHERE revoked_at IS NULL AND id IN (SELECT session_id FROM mcp_refresh_tokens WHERE token_hash = ?)`,
      )
      .bind(accessHash, scope, now + ACCESS_MS, now + REFRESH_MS, refreshHash),
    db
      .prepare(
        'SELECT id, member_id, client_id, access_scope AS scope FROM mcp_sessions WHERE access_hash = ? AND revoked_at IS NULL',
      )
      .bind(accessHash),
  ]);
  return reply(results[4].results[0], access, refresh);
}

export async function authenticateMcp(
  db: D1Database,
  token: unknown,
  resource: string,
  now = Date.now(),
): Promise<McpIdentity | null> {
  if (!valid(token, 'a')) return null;
  const row = await db
    .prepare(
      `SELECT id, member_id, client_id, access_scope AS scope FROM mcp_sessions WHERE access_hash = ? AND resource = ?
    AND access_expires_at > ? AND refresh_expires_at > ? AND hard_expires_at > ? AND revoked_at IS NULL`,
    )
    .bind(await tokenHash(token), resource, now, now, now)
    .first<Session>();
  if (!row) return null;
  const member = await db
    .prepare(`SELECT ${memberColumns} FROM members WHERE id = ?`)
    .bind(row.member_id)
    .first<Member>();
  return member ? { member, clientId: row.client_id, sessionId: row.id, scope: row.scope } : null;
}

export async function revokeMcpToken(
  db: D1Database,
  clientId: string,
  token: string,
  now = Date.now(),
) {
  const hash = await tokenHash(token);
  await db
    .prepare(
      `UPDATE mcp_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ? AND
    (access_hash = ? OR id IN (SELECT session_id FROM mcp_refresh_tokens WHERE token_hash = ?))`,
    )
    .bind(now, clientId, hash, hash)
    .run();
}
