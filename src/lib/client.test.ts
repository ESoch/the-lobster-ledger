import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  throw new Error('The request should have failed.');
}

describe('profile names', () => {
  it('updates the signed-in profile without accepting a target member id', async () => {
    const member = { id: 'sarah', name: 'Sarah Chen', initials: 'SC', color: '#153b3e' };
    const fetcher = vi.fn().mockResolvedValue(json(200, { member }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.updateProfile('Sarah Chen')).resolves.toEqual({ member });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/profile',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'same-origin',
        body: JSON.stringify({ name: 'Sarah Chen' }),
      }),
    );
  });

  it('keeps the server’s name validation message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(json(400, { error: 'Someone named Alex is already at the table.' })),
    );
    expect(await failure(api.updateProfile('Alex'))).toMatchObject({
      status: 400,
      message: 'Someone named Alex is already at the table.',
    });
  });
});

describe('API errors', () => {
  it('carries the HTTP status so a 401 can be told apart from a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(401, { error: 'Sign in to your private ledger.' })),
    );
    const reason = await failure(api.session());
    expect(reason).toBeInstanceOf(ApiError);
    expect(reason).toMatchObject({ status: 401, message: 'Sign in to your private ledger.' });
  });

  it('keeps the server message, or names the status when there is none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(503, {})));
    expect(await failure(api.ledger())).toMatchObject({
      status: 503,
      message: 'Unable to complete the request (503).',
    });
  });

  it('keeps the plain-language conflict message for a 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(409, { error: 'version' })));
    expect(await failure(api.ledger())).toMatchObject({
      status: 409,
      message: 'The ledger changed since you opened it. Review the latest records and try again.',
    });
  });

  it('reports a network failure as status 0 in words, not as "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const reason = await failure(api.config());
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(0);
    expect((reason as ApiError).message).not.toContain('Failed to fetch');
    expect((reason as ApiError).message).toMatch(/reach the ledger/i);
  });

  it('does not tell a lost change to simply try again, since it may have been saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const reason = await failure(api.createBet({} as Parameters<typeof api.createBet>[0]));
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(0);
    expect((reason as ApiError).message).toMatch(/did not confirm that change/i);
    expect((reason as ApiError).message).not.toMatch(/^Unable to reach/);
  });

  it('gives up on a load request that never answers, instead of waiting forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, options: RequestInit) => {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        });
      }),
    );
    const pending = failure(api.config());
    await vi.advanceTimersByTimeAsync(20_000);
    const reason = await pending;
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(0);
    expect((reason as ApiError).message).toMatch(/took too long/i);
  });

  it('does not put a clock on a change, so a slow save is never reported as lost', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, options: RequestInit) => {
        signal = options.signal;
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return json(200, { id: 'bet-1' });
      }),
    );
    const pending = api.createBet({} as Parameters<typeof api.createBet>[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual({ id: 'bet-1' });
    expect(signal?.aborted ?? false).toBe(false);
  });
});

describe('invitations', () => {
  it('reads the open invitations with a GET that has a clock on it', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(200, { invites: [{ id: 'abc', name: 'Pat' }] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.invites()).resolves.toEqual({ invites: [{ id: 'abc', name: 'Pat' }] });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/invites',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('revokes one by its id, escaped for the path, with a DELETE', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await api.revokeInvite('a/b_c-d');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/invites/a%2Fb_c-d',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('keeps the server’s words when the invitation is already gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(404, { error: 'That invitation could not be found.' })),
    );
    expect(await failure(api.revokeInvite('gone'))).toMatchObject({
      status: 404,
      message: 'That invitation could not be found.',
    });
  });
});
