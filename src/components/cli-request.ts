export const CLI_REQUEST_STORAGE = 'lobster-ledger-cli-authorization';
export const CLI_REQUEST_LIFETIME = 5 * 60 * 1000;

export interface CliAuthorizationRequest {
  codeChallenge: string;
  redirectUri: string;
  state: string;
  deviceName: string;
}

export interface PendingCliRequest {
  request: CliAuthorizationRequest;
  createdAt: number;
}

export type CliRequestState =
  | { pending: PendingCliRequest; error?: never }
  | { pending?: never; error: string }
  | { pending?: never; error?: never };

type RequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function validCliRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number(url.port) >= 1024 &&
      Number(url.port) <= 65535 &&
      url.pathname === '/callback' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.href === value
    );
  } catch {
    return false;
  }
}

// Controls (C0, DEL and C1, as the worker rejects) plus the characters that can reorder or hide
// text: line and paragraph separators and every bidirectional mark, embedding, override and isolate.
const UNSAFE_NAME_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export function parseCliRequest(value: unknown): CliAuthorizationRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const request = value as Record<string, unknown>;
  if (
    typeof request.codeChallenge !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge) ||
    typeof request.state !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(request.state) ||
    typeof request.deviceName !== 'string' ||
    !request.deviceName.trim() ||
    request.deviceName.length > 80 ||
    UNSAFE_NAME_CHARACTER.test(request.deviceName) ||
    !validCliRedirect(request.redirectUri)
  ) {
    return;
  }
  return {
    codeChallenge: request.codeChallenge,
    redirectUri: request.redirectUri,
    state: request.state,
    deviceName: request.deviceName,
  };
}

export function cliRequestExpired(pending: PendingCliRequest, now = Date.now()) {
  return (
    !Number.isFinite(pending.createdAt) ||
    now < pending.createdAt ||
    now - pending.createdAt >= CLI_REQUEST_LIFETIME
  );
}

/** Whole minutes left before a pending request lapses, rounded up; 0 once it has expired. */
export function cliRequestMinutesLeft(pending: PendingCliRequest, now = Date.now()) {
  const left = pending.createdAt + CLI_REQUEST_LIFETIME - now;
  return Number.isFinite(left) && left > 0 ? Math.ceil(left / 60_000) : 0;
}

function decodeCliRequest(encoded: string) {
  if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return;
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (character) =>
    character.charCodeAt(0),
  );
  return parseCliRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/**
 * Reads the request from the sign-in link or, after the Google round trip, from session storage.
 * The demo never touches storage: a real request waiting in the same tab is neither shown there nor
 * cleared by it, and a request in a demo link is shown without being kept.
 */
export function restoreCliRequest(
  encoded: string | null,
  storage: RequestStorage,
  now = Date.now(),
  demo = false,
): CliRequestState {
  const invalid = 'This CLI sign-in request is invalid. Run lobster auth login again.';
  if (demo) {
    if (encoded === null) return {};
    try {
      const request = decodeCliRequest(encoded);
      return request ? { pending: { request, createdAt: now } } : { error: invalid };
    } catch {
      return { error: invalid };
    }
  }
  let foundSaved = false;
  try {
    if (encoded !== null) {
      storage.removeItem(CLI_REQUEST_STORAGE);
      const request = decodeCliRequest(encoded);
      if (!request) return { error: invalid };
      const pending = { request, createdAt: now };
      storage.setItem(CLI_REQUEST_STORAGE, JSON.stringify(pending));
      return { pending };
    }
    const saved = storage.getItem(CLI_REQUEST_STORAGE);
    if (!saved) return {};
    foundSaved = true;
    if (saved.length > 5000) throw new Error('Invalid request');
    const value = JSON.parse(saved) as Partial<PendingCliRequest>;
    const request = parseCliRequest(value.request);
    if (!request || typeof value.createdAt !== 'number') throw new Error('Invalid request');
    const pending = { request, createdAt: value.createdAt };
    if (cliRequestExpired(pending, now)) {
      storage.removeItem(CLI_REQUEST_STORAGE);
      return { error: 'This CLI sign-in request has expired. Run lobster auth login again.' };
    }
    return { pending };
  } catch {
    try {
      storage.removeItem(CLI_REQUEST_STORAGE);
    } catch {
      // Storage may be disabled by the browser.
    }
    return encoded === null && !foundSaved ? {} : { error: invalid };
  }
}

export function captureCliRequest(demo = false): CliRequestState {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get('cli_authorize');
  try {
    return restoreCliRequest(encoded, window.sessionStorage, Date.now(), demo);
  } catch {
    return encoded === null
      ? {}
      : { error: 'Allow session storage in this browser, then run lobster auth login again.' };
  }
}

export function cleanCliRequestUrl(state: CliRequestState) {
  const url = new URL(window.location.href);
  if (url.searchParams.has('cli_authorize')) {
    url.searchParams.delete('cli_authorize');
    url.hash = 'cli';
    window.history.replaceState(null, '', url);
  } else if (state.pending) {
    url.hash = 'cli';
    window.history.replaceState(null, '', url);
  }
}

export function clearCliRequest() {
  try {
    window.sessionStorage.removeItem(CLI_REQUEST_STORAGE);
  } catch {
    // Clearing in-memory state also prevents approval on this page.
  }
}

export function validateCliCallback(value: unknown, request: CliAuthorizationRequest): string {
  if (typeof value !== 'string' || !validCliRedirect(request.redirectUri)) {
    throw new Error('The CLI returned an invalid destination. Run lobster auth login again.');
  }
  const destination = new URL(value);
  const expected = new URL(request.redirectUri);
  if (
    destination.origin !== expected.origin ||
    destination.pathname !== expected.pathname ||
    destination.username ||
    destination.password ||
    destination.hash ||
    destination.searchParams.get('state') !== request.state ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(destination.searchParams.get('code') ?? '') ||
    destination.searchParams.getAll('code').length !== 1 ||
    destination.searchParams.getAll('state').length !== 1 ||
    [...destination.searchParams.keys()].some((key) => key !== 'code' && key !== 'state')
  ) {
    throw new Error('The CLI returned an invalid destination. Run lobster auth login again.');
  }
  return destination.href;
}
