import type {
  Bet,
  BetAction,
  DebtOffsetPreview,
  DebtOffset,
  LedgerState,
  Member,
  NewBet,
  OpenInvite,
  PriceCorrectionInput,
  PriceCorrectionResult,
  PriceReportInput,
  PriceReportResult,
  PriceWithdrawalResult,
} from './types';

/** A failed API call. `status` is the HTTP status, or 0 when no answer arrived (offline, blocked or
 * timed out), so a caller can tell a normal 401 from a server error or a lost connection. */
export class ApiError extends Error {
  readonly status: number;
  /** The parsed reply, for a refusal that carries more than its message. */
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** How long a request that only reads may wait. Changes get no clock: a slow save must not be
 * reported as lost while the server may still be committing it. */
const READ_TIMEOUT_MS = 15_000;

async function request<T>(path: string, options?: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : undefined;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : undefined;
  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      ...(controller && { signal: controller.signal }),
    });
    const data: unknown = await response.json().catch(() => ({}));
    // An abort that lands while the body streams would otherwise read as an empty, successful reply.
    if (timedOut) throw new Error('Timed out');
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : undefined;
    if (!response.ok)
      throw new ApiError(
        response.status === 409
          ? 'The ledger changed since you opened it. Review the latest records and try again.'
          : (message ?? `Unable to complete the request (${response.status}).`),
        response.status,
        data,
      );
    return data as T;
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    // A change whose answer never came may still have been saved, so it must not say "try again".
    const change = !!options?.method && options.method.toUpperCase() !== 'GET';
    throw new ApiError(
      change
        ? 'The ledger did not confirm that change. Check your connection and the latest records before trying again.'
        : timedOut
          ? 'The ledger took too long to respond. Check your connection and try again.'
          : 'Unable to reach the ledger. Check your connection and try again.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}
export const api = {
  config: () =>
    request<{ configured: boolean; groupName: string }>('/api/config', undefined, READ_TIMEOUT_MS),
  session: () => request<{ member: Member }>('/api/session', undefined, READ_TIMEOUT_MS),
  updateProfile: (name: string) =>
    request<{ member: Member }>('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  ledger: () => request<LedgerState>('/api/ledger', undefined, READ_TIMEOUT_MS),
  createBet: (input: NewBet) =>
    request<Bet>('/api/bets', { method: 'POST', body: JSON.stringify(input) }),
  action: (bet: Bet, action: BetAction) =>
    request<Bet>(`/api/bets/${bet.id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action, version: bet.version }),
    }),
  offsetDebts: (input: DebtOffsetPreview) =>
    request<{ offset: DebtOffset; bets: Bet[] }>('/api/debt-offsets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** One write for the report and, when it names one, its new restaurant. */
  createPriceObservation: (input: PriceReportInput) =>
    request<PriceReportResult>('/api/price-observations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  correctPriceObservation: (id: string, input: PriceCorrectionInput) =>
    request<PriceCorrectionResult>(`/api/price-observations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  withdrawPriceObservation: (id: string, reason: string) =>
    request<PriceWithdrawalResult>(`/api/price-observations/${id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  invite: (name: string) =>
    request<{ url: string; expiresAt: string }>('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  invites: () => request<{ invites: OpenInvite[] }>('/api/invites', undefined, READ_TIMEOUT_MS),
  revokeInvite: (id: string) =>
    request<{ ok: true }>(`/api/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  logout: () => request('/auth/logout', { method: 'POST' }),
};
