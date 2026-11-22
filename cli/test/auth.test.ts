import { describe, expect, it } from 'vitest';
import { ApiClient, normalizeOrigin, type Credentials, type SessionStore } from '../src/auth';

const credentials = (): Credentials => ({
  accessToken: 'access-one',
  refreshToken: 'refresh-one',
  expiresAt: 1,
  member: { id: 'a', name: 'Alex' },
  sessionId: 'session-one',
});
function memoryStore(initial = credentials()) {
  let value: Credentials | undefined = initial;
  const store: SessionStore = {
    read: async () => value,
    write: async (next) => {
      value = next;
    },
    clear: async () => {
      value = undefined;
    },
    locked: async (fn) => fn(),
  };
  return store;
}
describe('CLI authentication safety', () => {
  it('serializes logout and retries a rejected access token before clearing a live session', async () => {
    let value: Credentials | undefined = { ...credentials(), expiresAt: Date.now() + 999999 };
    let locked = false;
    const store: SessionStore = {
      read: async () => {
        expect(locked).toBe(true);
        return value;
      },
      write: async (next) => {
        expect(locked).toBe(true);
        value = next;
      },
      clear: async () => {
        expect(locked).toBe(true);
        value = undefined;
      },
      locked: async (fn) => {
        if (locked) throw new Error('Nested lock');
        locked = true;
        try {
          return await fn();
        } finally {
          locked = false;
        }
      },
    };
    let revokes = 0;
    let refreshes = 0;
    const client = new ApiClient('https://ledger.example', store, async (url, init) => {
      expect(locked).toBe(true);
      if (String(url).endsWith('/token')) {
        refreshes++;
        return Response.json({
          accessToken: 'access-two',
          refreshToken: 'refresh-two',
          expiresIn: 900,
          member: { id: 'a', name: 'Alex' },
          sessionId: 'session-one',
        });
      }
      revokes++;
      if (revokes === 1) return Response.json({ error: 'Access token expired' }, { status: 401 });
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer access-two' });
      expect(value?.refreshToken).toBe('refresh-two');
      return Response.json({ ok: true });
    });
    await client.logout();
    expect(refreshes).toBe(1);
    expect(revokes).toBe(2);
    expect(value).toBeUndefined();
  });
  it('retains rotated credentials if revocation still rejects access after refresh', async () => {
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    const client = new ApiClient('https://ledger.example', store, async (url) =>
      String(url).endsWith('/token')
        ? Response.json({
            accessToken: 'access-two',
            refreshToken: 'refresh-two',
            expiresIn: 900,
            member: { id: 'a', name: 'Alex' },
            sessionId: 'session-one',
          })
        : Response.json({ error: 'Access rejected' }, { status: 401 }),
    );
    await expect(client.logout()).rejects.toThrow(/revocation|revok/i);
    expect((await store.read())?.refreshToken).toBe('refresh-two');
  });
  it('erases credentials on logout only after refresh confirms the session is no longer valid', async () => {
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    let refreshes = 0;
    const client = new ApiClient('https://ledger.example', store, async (url) => {
      if (String(url).endsWith('/token')) refreshes++;
      return Response.json({ error: 'Session invalid' }, { status: 401 });
    });
    await client.logout();
    expect(refreshes).toBe(1);
    expect(await store.read()).toBeUndefined();
  });
  it('accepts secure origins and explicit loopback development origins only', () => {
    expect(normalizeOrigin('https://ledger.example/')).toBe('https://ledger.example');
    expect(normalizeOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    for (const origin of [
      'http://ledger.example',
      'https://user:pass@ledger.example',
      'https://ledger.example/path',
      'https://ledger.example?foo=bar',
    ])
      expect(() => normalizeOrigin(origin)).toThrow();
  });
  it('renews an expired token and stores rotation before authenticated access', async () => {
    const store = memoryStore();
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new ApiClient('https://ledger.example', store, async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith('/token')
        ? Response.json({
            accessToken: 'access-two',
            refreshToken: 'refresh-two',
            expiresIn: 900,
            member: { id: 'a', name: 'Alex' },
            sessionId: 'session-one',
          })
        : Response.json({ ok: true });
    });
    expect(await client.get('/api/cli/me')).toEqual({ ok: true });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      grantType: 'refresh_token',
      refreshToken: 'refresh-one',
    });
    expect(calls[1].init?.headers).toMatchObject({ Authorization: 'Bearer access-two' });
    expect((await store.read())?.refreshToken).toBe('refresh-two');
  });
  it('never sends credentials outside the configured origin or follows redirects', async () => {
    let sent = 0;
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    const client = new ApiClient('https://ledger.example', store, async (_url, init) => {
      sent++;
      expect(init?.redirect).toBe('error');
      return Response.json({ ok: true });
    });
    for (const path of [
      'https://evil.test/api/ledger',
      '//evil.test/api/ledger',
      '/api/../auth/google',
      '/api\\evil.test',
      '/api/%2e%2e/auth',
    ])
      await expect(client.get(path)).rejects.toThrow();
    expect(sent).toBe(0);
  });
  it('revokes the current server session before removing stored credentials', async () => {
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    const client = new ApiClient('https://ledger.example', store, async (url, init) => {
      expect(String(url)).toBe('https://ledger.example/api/cli/logout');
      expect(init?.method).toBe('POST');
      expect(await store.read()).toBeDefined();
      return Response.json({ ok: true });
    });
    await client.logout();
    expect(await store.read()).toBeUndefined();
  });
  it('keeps credentials when logout cannot reach the server so revocation can be retried', async () => {
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    const client = new ApiClient('https://ledger.example', store, async () => {
      throw new Error('offline');
    });
    await expect(client.logout()).rejects.toThrow(/revok|network|connect/i);
    expect(await store.read()).toBeDefined();
  });
  it('clears revoked credentials without leaking token response details', async () => {
    const store = memoryStore();
    const client = new ApiClient('https://ledger.example', store, async () =>
      Response.json({ error: 'refresh-one' }, { status: 401 }),
    );
    await expect(client.get('/api/ledger')).rejects.toThrow('Run lobster auth login');
    expect(await store.read()).toBeUndefined();
  });
  it('does not echo an API error containing a session credential', async () => {
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    const client = new ApiClient('https://ledger.example', store, async () =>
      Response.json({ error: 'Invalid token access-one and refresh-one' }, { status: 400 }),
    );
    await expect(client.get('/api/ledger')).rejects.not.toThrow('access-one');
  });
  it('names each field the server refused, sanitised and capped like the message', async () => {
    const store = memoryStore({ ...credentials(), expiresAt: Date.now() + 999999 });
    const client = new ApiClient('https://ledger.example', store, async () =>
      Response.json(
        {
          error: 'Check the information you entered.',
          details: [
            { path: 'action.note', message: 'Too big: expected string to have <=2000 characters' },
            {
              path: 'action.winnerId',
              message: `Bad\u001b[31m token access-one ${'x'.repeat(600)}`,
            },
            { path: 7, message: 'Not a field.' },
          ],
        },
        { status: 400 },
      ),
    );
    const error = await client.get('/api/ledger').catch((reason: Error) => reason);
    const lines = (error as Error).message.split('\n');
    expect(lines[0]).toBe('Check the information you entered.');
    expect(lines[1]).toBe('action.note: Too big: expected string to have <=2000 characters');
    expect(lines[2]).toMatch(/^action\.winnerId: Bad \[31m token \[redacted\] x+$/);
    expect(lines[2].length).toBeLessThanOrEqual(500);
    expect(lines).toHaveLength(3);
  });
});
