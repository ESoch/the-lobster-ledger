import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomToken } from './security';

type Html = ReturnType<typeof html>;

/** True for a browser navigation, which asks for HTML; protocol and API clients never do. */
export function wantsHtml(c: Context) {
  return c.req.header('Accept')?.includes('text/html') ?? false;
}

// The app's palette. Dark is the default, as in the app; a light device preference switches.
// The pages cannot load the app's web fonts, so Fraunces and Manrope fall back to system faces.
const styles = `
*{box-sizing:border-box}
:root{color-scheme:dark;--bg:#101b1d;--surface:#1a292b;--border:#2c3e40;--text:#d2dedb;--heading:#edf5f1;--muted:#9aaba6;--mark:#ef8a78;--problem:#ef8a78;--primary:#8dc8bb;--primary-ink:#10201f;--quiet-border:#415453;--code:#142326;--shadow:0 2px 8px #00000030}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#f7f8f5;--surface:#fff;--border:#e4e8e1;--text:#34494a;--heading:#153b3e;--muted:#63715f;--mark:#bd4938;--problem:#b5493b;--primary:#153b3e;--primary-ink:#fff;--quiet-border:#dce2da;--code:#f1f4ef;--shadow:0 2px 3px #183a3508}}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:clamp(12px,4vw,32px);background:var(--bg);color:var(--text);font:15px/1.65 Manrope,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(100%,560px);padding:clamp(20px,6vw,40px);background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
main.problem{border-top:3px solid var(--problem)}
.shell-brand{display:inline-flex;align-items:center;gap:10px;color:var(--heading);font:20px/1.1 Fraunces,Georgia,serif;text-decoration:none}
.shell-brand svg{flex:none;color:var(--mark)}
h1{margin:22px 0 12px;font:400 clamp(26px,6vw,32px)/1.2 Fraunces,Georgia,serif;letter-spacing:-.02em;color:var(--heading)}
p,ul{margin:0 0 14px}
ul{padding-left:20px}
strong{color:var(--heading);overflow-wrap:anywhere}
a{color:var(--heading)}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;padding:1px 5px;border-radius:5px;background:var(--code);color:var(--heading)}
.muted{color:var(--muted);font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:11px 18px;border:1px solid var(--primary);border-radius:8px;background:var(--primary);color:var(--primary-ink);font:inherit;font-size:14px;font-weight:700;line-height:1.2;text-decoration:none;cursor:pointer}
.button-secondary{background:transparent;color:var(--heading);border-color:var(--quiet-border)}
.connections{list-style:none;padding:0}
.connections li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-top:1px solid var(--border)}
.connections li:last-child{border-bottom:1px solid var(--border)}
.connections li>div{min-width:0}
.connections .muted{display:block;margin:2px 0 0}
.connections time{white-space:nowrap}
:focus-visible{outline:3px solid #c58b42;outline-offset:3px}
`;

// A web address wraps after "/", "?" and "&" (keeping "//" together) and before a ".label", the joints
// the app's command blocks use, so a person checking it never meets a name cut in half. A name wider
// than a line by itself is still split by `code{overflow-wrap:anywhere}`; the address must not get
// `break-word` instead, which leaves those splits out of the card's minimum width and so lets a long
// name widen the card past a phone's edge.
const ADDRESS_JOINTS = /(?<=[/?&])(?!\/)|(?=\.[A-Za-z])/;

/** `address`, escaped, with a break opportunity at each joint. Its text is the address unchanged. */
export function breakableAddress(address: string): Html {
  const parts = address
    .split(ADDRESS_JOINTS)
    .filter(Boolean)
    .map((part) => html`${part}`);
  return html`${parts.flatMap((part, index) => (index ? [raw('<wbr>'), part] : [part]))}`;
}

// The LobsterMark from src/components/Brand.tsx.
const mark = `<svg width="30" height="33" viewBox="0 0 40 44" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17c-1.9-2.2-2.3-5.2-1.3-8M23 17c1.9-2.2 2.3-5.2 1.3-8"/><path d="M14.5 19c-3.4-1.3-5.2-3.5-5.9-6.4M25.5 19c3.4-1.3 5.2-3.5 5.9-6.4"/><path d="M8.6 13C4 11.4 3.4 7.7 5.6 4.2l2.2 3.1L11 3.2c2.2 4.9 1.3 8-2.4 9.8ZM31.4 13c4.6-1.6 5.2-5.3 3-8.8l-2.2 3.1L29 3.2c-2.2 4.9-1.3 8 2.4 9.8Z"/><path d="M20 15c4.2 0 6.3 3.8 5.5 8.3L23 35h-6l-2.5-11.7C13.7 18.8 15.8 15 20 15Z"/><path d="m15.2 23.5-5.3 1.7-2 3.4m8.4-.4L12.2 30 11 33m13.8-9.5 5.3 1.7 2 3.4m-8.4-.4 4.1 1.8 1.2 3M16.4 25h7.2M17.4 30h5.2"/><path d="m17 35-3 4.5c2 .9 4.1 1.3 6 1.3s4-.4 6-1.3L23 35m-3 1v4"/></g><circle cx="18.1" cy="18.2" r=".8" fill="currentColor"/><circle cx="21.9" cy="18.2" r=".8" fill="currentColor"/></svg>`;

export interface ShellPage {
  /** The page heading; the document title adds " · The Lobster Ledger". */
  title: string;
  body: Html;
  status?: ContentfulStatusCode;
  /** Problem pages carry the error accent along the top of the card. */
  problem?: boolean;
  /** Pages with a form may post to this origin; `redirectOrigin` adds a validated callback origin. */
  forms?: { redirectOrigin?: string };
}

/**
 * Every page the Worker renders itself (sign-in errors, MCP consent, Connected apps, browser
 * visits to protocol URLs) uses this one template: the app's tokens in both colour schemes, the
 * lobster mark, fluid padding down to 320px, and a nonce-only style policy.
 */
export function renderShell(c: Context, page: ShellPage) {
  const nonce = randomToken();
  const formAction = page.forms
    ? ` form-action 'self'${page.forms.redirectOrigin ? ` ${page.forms.redirectOrigin}` : ''};`
    : '';
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}';${formAction} frame-ancestors 'none'; base-uri 'none'`,
  );
  return c.html(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <meta name="color-scheme" content="dark light" />
          <title>${page.title} · The Lobster Ledger</title>
          <style nonce="${nonce}">
            ${raw(styles)}
          </style>
        </head>
        <body>
          <main class="${page.problem ? 'problem' : ''}">
            <a class="shell-brand" href="/">${raw(mark)}<span>the lobster ledger</span></a>
            <h1>${page.title}</h1>
            ${page.body}
          </main>
        </body>
      </html>`,
    page.status ?? 200,
  );
}
