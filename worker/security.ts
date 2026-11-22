import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HTTPException } from 'hono/http-exception';

export {
  actionSchema,
  newBetSchema,
  restaurantSchema,
  priceObservationSchema,
} from '../src/lib/api-schemas';

export function requireSameOrigin(request: Request, origin: string) {
  if (
    request.headers.get('Origin') !== origin ||
    new URL(request.url).origin !== origin ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  ) {
    throw new HTTPException(403, { message: 'This request must come from your ledger.' });
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const limit = 32_768;
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw new HTTPException(415, { message: 'Send JSON content.' });
  if (Number(request.headers.get('Content-Length')) > limit)
    throw new HTTPException(413, { message: 'Request is too large.' });
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: 'A JSON body is required.' });
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HTTPException(413, { message: 'Request is too large.' });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: 'Send valid JSON.' });
  } finally {
    reader.releaseLock();
  }
}

// Public-key caching is shared by jose; no member/session data is held globally.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  emailAuthoritative: boolean;
}
export async function verifyGoogleIdentity(
  token: string,
  clientId: string,
  nonce: string,
  key?: CryptoKey,
): Promise<GoogleIdentity> {
  const options = {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'email', 'email_verified'],
  };
  const { payload } = key
    ? await jwtVerify(token, key, options)
    : await jwtVerify(token, googleKeys, options);
  if (
    payload.nonce !== nonce ||
    payload.email_verified !== true ||
    typeof payload.email !== 'string' ||
    !payload.sub ||
    payload.sub.length > 255 ||
    (payload.azp !== undefined && payload.azp !== clientId)
  ) {
    throw new HTTPException(401, { message: 'Google identity could not be verified.' });
  }
  const email = payload.email.toLowerCase();
  // Google does not establish ongoing ownership of third-party mailboxes merely
  // through email_verified. Only Gmail or a signed hosted-domain claim does.
  const emailAuthoritative =
    email.endsWith('@gmail.com') || (typeof payload.hd === 'string' && payload.hd.length > 0);
  return {
    sub: payload.sub,
    email,
    emailAuthoritative,
    name:
      typeof payload.name === 'string' ? payload.name.slice(0, 100) : payload.email.split('@')[0],
  };
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function tokenHash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
