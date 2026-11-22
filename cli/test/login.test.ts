import { describe, expect, it } from 'vitest';
import { createLoginAttempt, listenForCallback, login } from '../src/login';
import { ApiClient, type Credentials, type SessionStore } from '../src/auth';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
describe('browser login', () => {
  it('rejects malformed callback request targets without terminating the listener', async () => {
    const listener = await listenForCallback('correct-state', 5000);
    const port = new URL(listener.redirectUri).port;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: 'http://[invalid]/callback' },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    listener.close();
    await expect(listener.code).rejects.toThrow();
  });
  it('rejects callbacks with a forged Host header', async () => {
    const listener = await listenForCallback('correct-state', 5000);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        listener.redirectUri + '?code=a&state=correct-state',
        { headers: { Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    listener.close();
    await expect(listener.code).rejects.toThrow();
  });
  it('uses a fresh high-entropy state and S256 PKCE verifier per attempt', () => {
    const a = createLoginAttempt();
    const b = createLoginAttempt();
    expect(a.state).toMatch(/^[\w-]{43}$/);
    expect(a.codeChallenge).toMatch(/^[\w-]{43}$/);
    expect(a.codeVerifier).not.toBe(a.codeChallenge);
    expect(a.state).not.toBe(b.state);
  });
  it('binds only loopback and rejects mismatched state before accepting the actual callback', async () => {
    const listener = await listenForCallback('correct-state', 5000);
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await fetch(listener.redirectUri + '?code=wrong&state=other')).status).toBe(400);
    expect(
      (await fetch(listener.redirectUri + '?code=correct-code&state=correct-state')).status,
    ).toBe(200);
    await expect(listener.code).resolves.toBe('correct-code');
    listener.close();
  });
  it('answers the approved callback with a themed HTML page under a strict policy', async () => {
    const listener = await listenForCallback('correct-state', 5000);
    const response = await fetch(listener.redirectUri + '?code=correct-code&state=correct-state');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain('unsafe-inline');
    const page = await response.text();
    const nonce = /style-src 'nonce-([\w-]+)'/.exec(policy)![1];
    expect(page).toContain(`<style nonce="${nonce}">`);
    expect(page).toContain('<!doctype html>');
    expect(page).toContain('<h1>You’re connected.</h1>');
    expect(page).toContain('Return to your terminal to finish signing in. You can close this tab.');
    expect(page).toContain('prefers-color-scheme');
    expect(page).not.toContain('correct-code');
    expect(page).not.toContain('<script');
    await expect(listener.code).resolves.toBe('correct-code');
    listener.close();
  });
  it('answers a callback that does not match this login with an HTML page that echoes nothing', async () => {
    const listener = await listenForCallback('correct-state', 5000);
    const response = await fetch(
      listener.redirectUri + '?code=<b>injected</b>&state=other-state-value',
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const page = await response.text();
    expect(page).toContain('<h1>This sign-in link doesn’t match.</h1>');
    expect(page).toContain('Return to the browser window where you started signing in');
    expect(page).not.toContain('injected');
    expect(page).not.toContain('other-state-value');
    listener.close();
    await expect(listener.code).rejects.toThrow();
  });
  it('rejects duplicate code or state parameters and non-GET callbacks', async () => {
    const listener = await listenForCallback('correct-state', 5000);
    expect((await fetch(listener.redirectUri + '?code=a&code=b&state=correct-state')).status).toBe(
      400,
    );
    expect(
      (await fetch(listener.redirectUri + '?code=a&state=correct-state', { method: 'POST' }))
        .status,
    ).toBe(405);
    listener.close();
    await expect(listener.code).rejects.toThrow();
  });
  it('exchanges only the validated browser callback and saves the resulting session', async () => {
    let saved: Credentials | undefined;
    let challenge = '';
    let callback = '';
    const store: SessionStore = {
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      clear: async () => {
        saved = undefined;
      },
      locked: async (fn) => fn(),
    };
    const client = new ApiClient('https://ledger.example', store, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.grantType).toBe('authorization_code');
      expect(body.code).toBe('approved-code');
      expect(body.redirectUri).toBe(callback);
      expect(createHash('sha256').update(body.codeVerifier).digest('base64url')).toBe(challenge);
      return Response.json({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: 900,
        member: { id: 'a', name: 'Alex' },
        sessionId: 's',
      });
    });
    await login(
      client,
      () => {},
      async (url) => {
        const authorization = JSON.parse(
          Buffer.from(new URL(url).searchParams.get('cli_authorize')!, 'base64url').toString(),
        );
        challenge = authorization.codeChallenge;
        callback = authorization.redirectUri;
        await fetch(callback + '?code=approved-code&state=' + authorization.state);
      },
    );
    expect(saved?.member.id).toBe('a');
    expect(saved?.refreshToken).toBe('refresh');
  });
});
