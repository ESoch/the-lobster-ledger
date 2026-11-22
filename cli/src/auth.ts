import { normalizeOrigin } from '../../src/lib/cli-origin';

export { normalizeOrigin };

export type Credentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  member: { id: string; name: string };
  sessionId: string;
};
export interface SessionStore {
  read(): Promise<Credentials | undefined>;
  write(value: Credentials): Promise<void>;
  clear(): Promise<void>;
  locked<T>(fn: () => Promise<T>): Promise<T>;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
type TokenReply = Omit<Credentials, 'expiresAt'> & { expiresIn: number };
export function parseTokenReply(value: unknown): Credentials {
  const data = value as TokenReply;
  if (
    !data ||
    typeof data.accessToken !== 'string' ||
    !data.accessToken ||
    typeof data.refreshToken !== 'string' ||
    !data.refreshToken ||
    !Number.isFinite(data.expiresIn) ||
    data.expiresIn <= 0 ||
    typeof data.member?.id !== 'string' ||
    typeof data.member?.name !== 'string' ||
    typeof data.sessionId !== 'string'
  )
    throw new Error('The server returned an invalid login response.');
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + data.expiresIn * 1000,
    member: data.member,
    sessionId: data.sessionId,
  };
}
export class ApiClient {
  readonly origin: string;
  constructor(
    origin: string,
    readonly store: SessionStore,
    private fetcher: typeof fetch = fetch,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private url(path: string): string {
    const url = new URL(path, this.origin);
    if (
      !path.startsWith('/api/') ||
      /[\\\s]|%2e|%2f|%5c/i.test(path) ||
      url.origin !== this.origin ||
      !url.pathname.startsWith('/api/') ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('API requests must use a same-origin /api/ path.');
    return url.href;
  }
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(
        'Could not connect to the ledger. Check the network and configured origin, then retry.',
      );
    }
  }
  async exchange(body: object): Promise<Credentials> {
    const response = await this.send(this.origin + '/api/cli/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new ApiError('Login expired or was revoked. Run lobster auth login.', response.status);
    return parseTokenReply(await response.json());
  }
  private async credential(force = false): Promise<Credentials> {
    return this.store.locked(async () => {
      const current = await this.store.read();
      if (!current) throw new Error('Run lobster auth login to sign in first.');
      if (!force && current.expiresAt > Date.now() + 60_000) return current;
      return this.refreshLocked(current);
    });
  }
  // The caller holds the cross-process session lock through rotation and persistence.
  private async refreshLocked(current: Credentials): Promise<Credentials> {
    try {
      const next = await this.exchange({
        grantType: 'refresh_token',
        refreshToken: current.refreshToken,
      });
      if (next.member.id !== current.member.id || next.sessionId !== current.sessionId)
        throw new Error('The server returned a different CLI session. Sign in again.');
      await this.store.write(next);
      return next;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) await this.store.clear();
      throw error;
    }
  }
  async request(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const url = this.url(path);
    const method = options.method ?? 'GET';
    let current = await this.credential();
    const send = () =>
      this.send(url, {
        method,
        headers: {
          Authorization: `Bearer ${current.accessToken}`,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    let response = await send();
    if (response.status === 401 && (method === 'GET' || options.idempotencyKey)) {
      current = await this.credential(true);
      response = await send();
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        details?: unknown;
      };
      const clean = (text: string) =>
        text
          .replaceAll(current.accessToken, '[redacted]')
          .replaceAll(current.refreshToken, '[redacted]')
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          .slice(0, 500);
      // Validation errors name each field that failed, so the member knows what to change.
      const details = Array.isArray(data.details)
        ? data.details
            .filter(
              (detail): detail is { path: string; message: string } =>
                typeof detail?.path === 'string' && typeof detail?.message === 'string',
            )
            .slice(0, 20)
            .map((detail) => `\n${clean(`${detail.path}: ${detail.message}`)}`)
        : [];
      const message =
        typeof data.error === 'string'
          ? clean(data.error) + details.join('')
          : `Request failed (${response.status}).`;
      throw new ApiError(message, response.status);
    }
    return response.status === 204 ? undefined : response.json();
  }
  get(path: string): Promise<unknown> {
    return this.request(path);
  }
  async logout(): Promise<void> {
    await this.store.locked(async () => {
      let current = await this.store.read();
      if (!current) return;
      const refresh = async (): Promise<boolean> => {
        try {
          current = await this.refreshLocked(current!);
          return true;
        } catch (error) {
          // A rejected refresh credential establishes that this session cannot renew.
          // An access-token rejection alone does not establish session revocation.
          if (error instanceof ApiError && error.status === 401) return false;
          throw error;
        }
      };
      if (current.expiresAt <= Date.now() + 60_000 && !(await refresh())) return;
      const revoke = () =>
        this.send(this.origin + '/api/cli/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${current!.accessToken}` },
        });
      let response = await revoke();
      if (response.status === 401) {
        if (!(await refresh())) return;
        response = await revoke();
      }
      if (!response.ok)
        throw new ApiError(
          `Could not confirm device revocation (${response.status}). Credentials are retained. Retry logout or revoke this device on the website.`,
          response.status,
        );
      await this.store.clear();
    });
  }
}
