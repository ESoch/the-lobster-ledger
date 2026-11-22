import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { ApiClient } from './auth';

// The browser lands here after "Allow CLI access", so it gets the app's look instead of bare text:
// the app's palette in both colour schemes and the lobster mark. The page runs no script, loads
// nothing and echoes none of the request, and its policy allows only its own nonce'd stylesheet.
const pageStyles = `
*{box-sizing:border-box}
:root{color-scheme:dark;--bg:#101b1d;--surface:#1a292b;--border:#2c3e40;--text:#d2dedb;--heading:#edf5f1;--mark:#ef8a78;--problem:#ef8a78}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#f7f8f5;--surface:#fff;--border:#e4e8e1;--text:#34494a;--heading:#153b3e;--mark:#bd4938;--problem:#b5493b}}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:clamp(12px,4vw,32px);background:var(--bg);color:var(--text);font:15px/1.65 Manrope,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(100%,520px);padding:clamp(20px,6vw,40px);background:var(--surface);border:1px solid var(--border);border-radius:14px}
main.problem{border-top:3px solid var(--problem)}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--heading);font:20px/1.1 Fraunces,Georgia,serif}
.brand svg{flex:none;color:var(--mark)}
h1{margin:22px 0 12px;font:400 clamp(26px,6vw,32px)/1.2 Fraunces,Georgia,serif;letter-spacing:-.02em;color:var(--heading)}
p{margin:0}
`;
const lobsterMark = `<svg width="30" height="33" viewBox="0 0 40 44" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17c-1.9-2.2-2.3-5.2-1.3-8M23 17c1.9-2.2 2.3-5.2 1.3-8"/><path d="M14.5 19c-3.4-1.3-5.2-3.5-5.9-6.4M25.5 19c3.4-1.3 5.2-3.5 5.9-6.4"/><path d="M8.6 13C4 11.4 3.4 7.7 5.6 4.2l2.2 3.1L11 3.2c2.2 4.9 1.3 8-2.4 9.8ZM31.4 13c4.6-1.6 5.2-5.3 3-8.8l-2.2 3.1L29 3.2c-2.2 4.9-1.3 8 2.4 9.8Z"/><path d="M20 15c4.2 0 6.3 3.8 5.5 8.3L23 35h-6l-2.5-11.7C13.7 18.8 15.8 15 20 15Z"/><path d="m15.2 23.5-5.3 1.7-2 3.4m8.4-.4L12.2 30 11 33m13.8-9.5 5.3 1.7 2 3.4m-8.4-.4 4.1 1.8 1.2 3M16.4 25h7.2M17.4 30h5.2"/><path d="m17 35-3 4.5c2 .9 4.1 1.3 6 1.3s4-.4 6-1.3L23 35m-3 1v4"/></g><circle cx="18.1" cy="18.2" r=".8" fill="currentColor"/><circle cx="21.9" cy="18.2" r=".8" fill="currentColor"/></svg>`;

function respond(
  response: ServerResponse,
  status: number,
  heading: string,
  message: string,
  problem = false,
) {
  const nonce = randomBytes(16).toString('base64url');
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${heading} · The Lobster Ledger</title>
<style nonce="${nonce}">${pageStyles}</style>
</head>
<body>
<main class="${problem ? 'problem' : ''}">
<span class="brand">${lobsterMark}<span>the lobster ledger</span></span>
<h1>${heading}</h1>
<p>${message}</p>
</main>
</body>
</html>
`);
}

export function createLoginAttempt() {
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(32).toString('base64url'),
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    codeVerifier,
  };
}
export async function listenForCallback(
  state: string,
  timeout = 300_000,
): Promise<{ redirectUri: string; code: Promise<string>; close: () => void }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Install a rejection handler immediately: cancellation can occur before the caller starts awaiting.
  void code.catch(() => {});
  let redirectUri = '';
  let settled = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') {
      respond(
        response,
        405,
        'This page only accepts a browser visit.',
        'Only GET callbacks are accepted.',
        true,
      );
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', redirectUri);
    } catch {
      respond(
        response,
        400,
        'This sign-in link doesn’t work.',
        'The callback address is not valid.',
        true,
      );
      return;
    }
    const candidate = url.searchParams.get('state') ?? '';
    const expected = Buffer.from(state);
    const received = Buffer.from(candidate);
    if (
      request.headers.host !== new URL(redirectUri).host ||
      url.pathname !== '/callback' ||
      url.searchParams.getAll('code').length !== 1 ||
      url.searchParams.getAll('state').length !== 1 ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received) ||
      !url.searchParams.get('code') ||
      settled
    ) {
      respond(
        response,
        400,
        'This sign-in link doesn’t match.',
        'Return to the browser window where you started signing in, or run lobster auth login again.',
        true,
      );
      return;
    }
    respond(
      response,
      200,
      'You’re connected.',
      'Return to your terminal to finish signing in. You can close this tab.',
    );
    settled = true;
    clearTimeout(timer);
    resolveCode(url.searchParams.get('code')!);
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  if (port < 1024) {
    server.close();
    throw new Error('Could not allocate a nonprivileged local sign-in port.');
  }
  redirectUri = `http://127.0.0.1:${port}/callback`;
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
    if (!settled) {
      settled = true;
      rejectCode(
        new Error('Browser sign-in was cancelled or timed out. Run lobster auth login again.'),
      );
    }
  };
  const timer = setTimeout(close, timeout);
  return { redirectUri, code, close };
}
export function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Browser could not open.')),
    );
  });
}
export async function login(
  client: ApiClient,
  print: (value: string) => void,
  browser = openBrowser,
) {
  if (await client.store.read())
    throw new Error('Already signed in. Run lobster auth logout before switching accounts.');
  const attempt = createLoginAttempt();
  const listener = await listenForCallback(attempt.state);
  const onInterrupt = () => listener.close();
  process.once('SIGINT', onInterrupt);
  try {
    const request = {
      codeChallenge: attempt.codeChallenge,
      redirectUri: listener.redirectUri,
      state: attempt.state,
      deviceName: `Lobster CLI on ${hostname()}`.replace(/[^\x20-\x7e]/g, '').slice(0, 80),
    };
    const url = `${client.origin}/?cli_authorize=${Buffer.from(JSON.stringify(request)).toString('base64url')}#cli`;
    print(`Authorize this device in your browser:\n${url}`);
    await browser(url).catch(() => {
      print('Open the link above in a browser on this computer.');
    });
    const code = await listener.code;
    await client.store.locked(async () => {
      if (await client.store.read())
        throw new Error('Another login completed first. Run lobster auth status.');
      const credentials = await client.exchange({
        grantType: 'authorization_code',
        code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: listener.redirectUri,
      });
      await client.store.write(credentials);
      print(
        `Signed in as ${credentials.member.name}. Credentials are stored in your operating system credential store.`,
      );
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    listener.close();
  }
}
