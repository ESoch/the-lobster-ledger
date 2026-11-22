export interface CliAuthorizeInput {
  codeChallenge: string;
  redirectUri: string;
  state: string;
  deviceName: string;
}

export function validateAuthorizeInput(input: unknown): CliAuthorizeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid CLI authorization request.');
  }
  const { codeChallenge, redirectUri, state, deviceName } = input as Record<string, unknown>;
  const port =
    typeof redirectUri === 'string'
      ? /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/callback$/.exec(redirectUri)?.[1]
      : undefined;
  if (
    typeof codeChallenge !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
    typeof state !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(state) ||
    typeof redirectUri !== 'string' ||
    !port ||
    Number(port) < 1024 ||
    Number(port) > 65535 ||
    typeof deviceName !== 'string' ||
    !deviceName.trim() ||
    deviceName.length > 80 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(deviceName)
  ) {
    throw new Error('Invalid CLI authorization request.');
  }
  return { codeChallenge, redirectUri, state, deviceName: deviceName.trim() };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function createSecret(prefix: 'lla' | 'llr' | 'llc'): string {
  return `${prefix}_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function validSecret(value: unknown, prefix: 'lla' | 'llr' | 'llc'): value is string {
  return (
    typeof value === 'string' &&
    value.length === 47 &&
    value.startsWith(`${prefix}_`) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.slice(4))
  );
}

export async function proofChallenge(verifier: unknown): Promise<string> {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new Error('Invalid CLI code verifier.');
  }
  return base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
}

export async function hashSecret(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
