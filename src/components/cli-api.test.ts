import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliApi } from './cli-api';

afterEach(() => vi.unstubAllGlobals());

describe('CLI browser API client', () => {
  it('uses the signed-in browser session for explicit consent', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ redirectUrl: 'http://127.0.0.1:49123/callback' }));
    vi.stubGlobal('fetch', fetch);
    await cliApi('/api/cli/authorize', {
      method: 'POST',
      body: JSON.stringify({ deviceName: 'Laptop' }),
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/cli/authorize',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('surfaces permission errors instead of returning a successful session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'Sign in to manage your devices.' }, { status: 401 }),
        ),
    );
    await expect(cliApi('/api/cli/sessions')).rejects.toThrow('Sign in to manage your devices.');
  });

  it('carries the HTTP status on the error so a caller can tell a rejected request from an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'Invalid CLI authorization request.' }, { status: 400 }),
        ),
    );
    await expect(cliApi('/api/cli/authorize', { method: 'POST' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'Invalid CLI authorization request.',
    });
  });

  it('does not send browser credentials to an external endpoint', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(cliApi('https://elsewhere.example/api/cli/sessions')).rejects.toThrow(
      'Invalid CLI endpoint',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
