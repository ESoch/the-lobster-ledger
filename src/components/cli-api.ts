import { ApiError } from '../lib/client';

export async function cliApi<T>(path: string, options?: RequestInit): Promise<T> {
  if (!/^\/api\/cli(?:\/|$)/.test(path)) throw new Error('Invalid CLI endpoint.');
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Unable to complete the request (${response.status}).`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}
