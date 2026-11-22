import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateCli,
  exchangeCode,
  issueAuthorization,
  listCliSessions,
  refreshTokens,
  revokeCliSession,
} from './cli-auth';
import { proofChallenge } from './cli-crypto';

class Statement {
  constructor(
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}
  bind(...values: SQLInputValue[]) {
    return new Statement(this.sql, values);
  }
  async first<T>() {
    return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }
  async all() {
    const results = sqlite.prepare(this.sql).all(...this.values);
    return {
      results,
      success: true,
      meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get()?.n) },
    };
  }
  async run() {
    return this.all();
  }
}

let sqlite: DatabaseSync;
let transaction = Promise.resolve();
const db = {
  prepare(sql: string) {
    return new Statement(sql);
  },
  batch(statements: Statement[]) {
    const next = transaction.then(async () => {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    });
    transaction = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  },
} as unknown as D1Database;

const now = Date.parse('2026-09-20T12:00:00Z');
const verifier = 'v'.repeat(43);
const redirectUri = 'http://127.0.0.1:49231/callback';

beforeEach(() => {
  transaction = Promise.resolve();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE cli_authorization_codes (
      code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, code_challenge TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, device_name TEXT NOT NULL, expires_at INTEGER NOT NULL,
      redeemed_at INTEGER, session_id TEXT
    );
    CREATE TABLE cli_sessions (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, device_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      access_hash TEXT NOT NULL UNIQUE, access_expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL, hard_expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE cli_refresh_tokens (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES cli_sessions(id),
      used_at INTEGER, replacement_hash TEXT
    );
  `);
});
afterEach(() => sqlite.close());

async function authorize(memberId = 'alice') {
  const { redirectUrl } = await issueAuthorization(
    db,
    memberId,
    {
      codeChallenge: await proofChallenge(verifier),
      redirectUri,
      state: 's'.repeat(43),
      deviceName: 'Test laptop',
    },
    now,
  );
  const url = new URL(redirectUrl);
  expect(url.searchParams.get('state')).toBe('s'.repeat(43));
  return { code: url.searchParams.get('code')!, codeVerifier: verifier, redirectUri };
}

describe('CLI authorization code exchange', () => {
  it('exchanges an approved proof for one opaque session and hashes all credentials at rest', async () => {
    const input = await authorize();
    const tokens = await exchangeCode(db, input, now);
    expect(tokens).toMatchObject({ memberId: 'alice', expiresIn: 900 });
    expect(await authenticateCli(db, tokens!.accessToken, now)).toMatchObject({
      memberId: 'alice',
      sessionId: tokens!.sessionId,
    });
    const persisted =
      JSON.stringify(sqlite.prepare('SELECT * FROM cli_sessions').all()) +
      JSON.stringify(sqlite.prepare('SELECT * FROM cli_refresh_tokens').all()) +
      JSON.stringify(sqlite.prepare('SELECT * FROM cli_authorization_codes').all());
    expect(persisted).not.toContain(tokens!.accessToken);
    expect(persisted).not.toContain(tokens!.refreshToken);
    expect(persisted).not.toContain(input.code);
  });

  it('rejects code reuse and creates only one session', async () => {
    const input = await authorize();
    expect(await exchangeCode(db, input, now)).not.toBeNull();
    expect(await exchangeCode(db, input, now)).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM cli_sessions').get()?.n).toBe(1);
  });

  it('binds redemption to the proof and exact redirect without consuming the valid code', async () => {
    const input = await authorize();
    expect(await exchangeCode(db, { ...input, codeVerifier: 'w'.repeat(43) }, now)).toBeNull();
    expect(
      await exchangeCode(db, { ...input, redirectUri: 'http://127.0.0.1:49232/callback' }, now),
    ).toBeNull();
    expect(await exchangeCode(db, input, now)).not.toBeNull();
  });

  it('rejects expired codes at the expiration boundary', async () => {
    expect(await exchangeCode(db, await authorize(), now + 120_000)).toBeNull();
  });

  it('allows exactly one exchange when the same authorization is redeemed concurrently', async () => {
    const input = await authorize();
    const results = await Promise.all([exchangeCode(db, input, now), exchangeCode(db, input, now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM cli_sessions').get()?.n).toBe(1);
  });

  it('rolls back code redemption if credential creation fails', async () => {
    const input = await authorize();
    sqlite.exec(`CREATE TRIGGER fail_token BEFORE INSERT ON cli_refresh_tokens
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;`);
    await expect(exchangeCode(db, input, now)).rejects.toThrow('simulated storage failure');
    sqlite.exec('DROP TRIGGER fail_token');
    expect(await exchangeCode(db, input, now)).not.toBeNull();
  });
});

describe('CLI persistent sessions', () => {
  it('lists only active devices belonging to the current member', async () => {
    const alice = (await exchangeCode(db, await authorize('alice'), now))!;
    await exchangeCode(db, await authorize('bob'), now);
    expect(await listCliSessions(db, 'alice', now)).toEqual([
      {
        id: alice.sessionId,
        deviceName: 'Test laptop',
        createdAt: new Date(now).toISOString(),
        lastUsedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30 * 86400_000).toISOString(),
      },
    ]);
    await revokeCliSession(db, 'alice', alice.sessionId, now);
    expect(await listCliSessions(db, 'alice', now)).toEqual([]);
    expect(await listCliSessions(db, 'bob', now + 30 * 86400_000)).toEqual([]);
  });

  it('expires access tokens while allowing a refresh to rotate both credentials', async () => {
    const initial = (await exchangeCode(db, await authorize(), now))!;
    expect(await authenticateCli(db, initial.accessToken, now + 900_000)).toBeNull();
    const next = (await refreshTokens(db, initial.refreshToken, now + 900_000))!;
    expect(next.sessionId).toBe(initial.sessionId);
    expect(next.accessToken).not.toBe(initial.accessToken);
    expect(next.refreshToken).not.toBe(initial.refreshToken);
    expect(await authenticateCli(db, next.accessToken, now + 900_000)).not.toBeNull();
    expect(await authenticateCli(db, initial.accessToken, now)).toBeNull();
  });

  it('revokes the entire session when an already-used refresh token is replayed', async () => {
    const initial = (await exchangeCode(db, await authorize(), now))!;
    const next = (await refreshTokens(db, initial.refreshToken, now + 10))!;
    expect(await refreshTokens(db, initial.refreshToken, now + 20)).toBeNull();
    expect(await authenticateCli(db, next.accessToken, now + 20)).toBeNull();
    expect(await refreshTokens(db, next.refreshToken, now + 20)).toBeNull();
  });

  it('detects a concurrent refresh replay and never leaves two usable descendants', async () => {
    const initial = (await exchangeCode(db, await authorize(), now))!;
    const attempts = await Promise.all([
      refreshTokens(db, initial.refreshToken, now + 10),
      refreshTokens(db, initial.refreshToken, now + 10),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const descendant = attempts.find(Boolean)!;
    expect(await authenticateCli(db, descendant.accessToken, now + 10)).toBeNull();
    expect(await refreshTokens(db, descendant.refreshToken, now + 10)).toBeNull();
  });

  it('expires refresh credentials after 30 inactive days', async () => {
    const initial = (await exchangeCode(db, await authorize(), now))!;
    expect(await refreshTokens(db, initial.refreshToken, now + 30 * 86400_000)).toBeNull();
  });

  it('caps a repeatedly refreshed session at 90 days', async () => {
    let tokens = (await exchangeCode(db, await authorize(), now))!;
    for (const day of [20, 40, 60, 80])
      tokens = (await refreshTokens(db, tokens.refreshToken, now + day * 86400_000))!;
    expect(await refreshTokens(db, tokens.refreshToken, now + 90 * 86400_000)).toBeNull();
  });

  it('does not revoke another member’s device', async () => {
    const tokens = (await exchangeCode(db, await authorize(), now))!;
    expect(await revokeCliSession(db, 'bob', tokens.sessionId, now)).toBe(false);
    expect(await authenticateCli(db, tokens.accessToken, now)).not.toBeNull();
    expect(await revokeCliSession(db, 'alice', tokens.sessionId, now)).toBe(true);
    expect(await authenticateCli(db, tokens.accessToken, now)).toBeNull();
    expect(await refreshTokens(db, tokens.refreshToken, now)).toBeNull();
  });

  it('rejects malformed credentials without accepting a bearer from another namespace', async () => {
    const tokens = (await exchangeCode(db, await authorize(), now))!;
    expect(await authenticateCli(db, tokens.refreshToken, now)).toBeNull();
    expect(await refreshTokens(db, tokens.accessToken, now)).toBeNull();
    expect(await authenticateCli(db, 'bad', now)).toBeNull();
  });
});
