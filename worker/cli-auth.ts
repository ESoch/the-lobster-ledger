import {
  createSecret,
  hashSecret,
  proofChallenge,
  validateAuthorizeInput,
  validSecret,
} from './cli-crypto';

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 30 * 86400_000;
const MAX_SESSION_MS = 90 * 86400_000;

export interface CliIdentity {
  memberId: string;
  sessionId: string;
}
export interface CliCredentials extends CliIdentity {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
interface SessionRow {
  id: string;
  member_id: string;
}

export async function issueAuthorization(
  db: D1Database,
  memberId: string,
  body: unknown,
  now = Date.now(),
) {
  const input = validateAuthorizeInput(body);
  const code = createSecret('llc');
  await db
    .prepare(
      `INSERT INTO cli_authorization_codes
    (code_hash, member_id, code_challenge, redirect_uri, device_name, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await hashSecret(code),
      memberId,
      input.codeChallenge,
      input.redirectUri,
      input.deviceName,
      now + 120_000,
    )
    .run();
  const redirect = new URL(input.redirectUri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', input.state);
  return { redirectUrl: redirect.toString() };
}

export async function exchangeCode(
  db: D1Database,
  input: { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown },
  now = Date.now(),
): Promise<CliCredentials | null> {
  if (!validSecret(input.code, 'llc') || typeof input.redirectUri !== 'string') return null;
  let challenge: string;
  try {
    challenge = await proofChallenge(input.codeVerifier);
  } catch {
    return null;
  }
  const codeHash = await hashSecret(input.code);
  const sessionId = crypto.randomUUID();
  const accessToken = createSecret('lla');
  const refreshToken = createSecret('llr');
  const [accessHash, refreshHash] = await Promise.all([
    hashSecret(accessToken),
    hashSecret(refreshToken),
  ]);
  // The claim and every resulting credential commit in one D1 transaction. The
  // per-attempt session ID makes a losing concurrent exchange insert nothing.
  const results = await db.batch<SessionRow>([
    db
      .prepare(
        `UPDATE cli_authorization_codes SET redeemed_at = ?, session_id = ?
      WHERE code_hash = ? AND code_challenge = ? AND redirect_uri = ?
      AND redeemed_at IS NULL AND expires_at > ?`,
      )
      .bind(now, sessionId, codeHash, challenge, input.redirectUri, now),
    db
      .prepare(
        `INSERT INTO cli_sessions
      (id, member_id, device_name, created_at, last_used_at, access_hash,
       access_expires_at, refresh_expires_at, hard_expires_at)
      SELECT ?, member_id, device_name, ?, ?, ?, ?, ?, ? FROM cli_authorization_codes
      WHERE code_hash = ? AND session_id = ?`,
      )
      .bind(
        sessionId,
        now,
        now,
        accessHash,
        now + ACCESS_MS,
        now + REFRESH_MS,
        now + MAX_SESSION_MS,
        codeHash,
        sessionId,
      ),
    db
      .prepare(
        `INSERT INTO cli_refresh_tokens (token_hash, session_id)
      SELECT ?, id FROM cli_sessions WHERE id = ?`,
      )
      .bind(refreshHash, sessionId),
    db.prepare('SELECT id, member_id FROM cli_sessions WHERE id = ?').bind(sessionId),
  ]);
  const session = results[3].results[0];
  return session
    ? {
        sessionId,
        memberId: session.member_id,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_MS / 1000,
      }
    : null;
}

export async function refreshTokens(
  db: D1Database,
  token: unknown,
  now = Date.now(),
): Promise<CliCredentials | null> {
  if (!validSecret(token, 'llr')) return null;
  const tokenHash = await hashSecret(token);
  const accessToken = createSecret('lla');
  const refreshToken = createSecret('llr');
  const [accessHash, refreshHash] = await Promise.all([
    hashSecret(accessToken),
    hashSecret(refreshToken),
  ]);
  // Retain spent hashes for the life of the family. A replay invalidates both
  // the fresh access token and the successor refresh token, even across races.
  const results = await db.batch<SessionRow>([
    db
      .prepare(
        `UPDATE cli_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id IN
      (SELECT session_id FROM cli_refresh_tokens WHERE token_hash = ? AND used_at IS NOT NULL)`,
      )
      .bind(now, tokenHash),
    db
      .prepare(
        `UPDATE cli_refresh_tokens SET used_at = ?, replacement_hash = ?
      WHERE token_hash = ? AND used_at IS NULL AND session_id IN
      (SELECT id FROM cli_sessions WHERE revoked_at IS NULL AND refresh_expires_at > ? AND hard_expires_at > ?)`,
      )
      .bind(now, refreshHash, tokenHash, now, now),
    db
      .prepare(
        `INSERT INTO cli_refresh_tokens (token_hash, session_id)
      SELECT ?, session_id FROM cli_refresh_tokens WHERE token_hash = ? AND replacement_hash = ?`,
      )
      .bind(refreshHash, tokenHash, refreshHash),
    db
      .prepare(
        `UPDATE cli_sessions SET access_hash = ?, access_expires_at = ?, last_used_at = ?,
      refresh_expires_at = MIN(?, hard_expires_at)
      WHERE revoked_at IS NULL AND id IN (SELECT session_id FROM cli_refresh_tokens WHERE token_hash = ?)`,
      )
      .bind(accessHash, now + ACCESS_MS, now, now + REFRESH_MS, refreshHash),
    db
      .prepare(
        `SELECT id, member_id FROM cli_sessions
      WHERE access_hash = ? AND revoked_at IS NULL AND hard_expires_at > ? AND refresh_expires_at > ?`,
      )
      .bind(accessHash, now, now),
  ]);
  const session = results[4].results[0];
  return session
    ? {
        sessionId: session.id,
        memberId: session.member_id,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_MS / 1000,
      }
    : null;
}

export async function authenticateCli(
  db: D1Database,
  token: unknown,
  now = Date.now(),
): Promise<CliIdentity | null> {
  if (!validSecret(token, 'lla')) return null;
  const hash = await hashSecret(token);
  const row = await db
    .prepare(
      `SELECT id, member_id FROM cli_sessions
    WHERE access_hash = ? AND access_expires_at > ? AND revoked_at IS NULL
    AND refresh_expires_at > ? AND hard_expires_at > ?`,
    )
    .bind(hash, now, now, now)
    .first<SessionRow>();
  if (!row) return null;
  await db
    .prepare('UPDATE cli_sessions SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, row.id)
    .run();
  return { sessionId: row.id, memberId: row.member_id };
}

export async function revokeCliSession(
  db: D1Database,
  memberId: string,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE cli_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND member_id = ?',
    )
    .bind(now, sessionId, memberId)
    .run();
  return result.meta.changes > 0;
}

export async function listCliSessions(db: D1Database, memberId: string, now = Date.now()) {
  const result = await db
    .prepare(
      `SELECT id, device_name, created_at, last_used_at,
    MIN(refresh_expires_at, hard_expires_at) AS expires_at FROM cli_sessions
    WHERE member_id = ? AND revoked_at IS NULL AND refresh_expires_at > ? AND hard_expires_at > ?
    ORDER BY last_used_at DESC LIMIT 100`,
    )
    .bind(memberId, now, now)
    .all<{
      id: string;
      device_name: string;
      created_at: number;
      last_used_at: number;
      expires_at: number;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    deviceName: row.device_name,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: new Date(row.last_used_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }));
}
