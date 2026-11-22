import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CliAuthorization, CliGuide, type CliRequest } from './CliAccess';

const pending = {
  request: {
    codeChallenge: 'a'.repeat(43),
    state: 'b'.repeat(43),
    redirectUri: 'http://127.0.0.1:49123/callback',
    deviceName: 'Personal laptop',
  },
  createdAt: Date.now(),
};

function guideText(origin: string) {
  return renderToStaticMarkup(
    createElement(CliGuide, {
      origin,
      signedIn: false,
      demo: false,
      request: vi.fn() as unknown as CliRequest,
      onSignIn: vi.fn(),
    }),
  ).replace(/<[^>]+>/g, '');
}

describe('CLI onboarding and consent', () => {
  it('makes installation and complete-bet instructions available without login', () => {
    // Commands render as word tokens, so compare page text to the intended terminal commands.
    const text = guideText('https://ledger.example.com');
    expect(text).toContain(
      'npm install -g https://ledger.example.com/downloads/lobster-ledger-cli-0.1.0.tgz',
    );
    expect(text).toContain('Node.js 22 or newer');
    expect(text).toContain('lobster --origin https://ledger.example.com auth login');
    expect(text).toContain('lobster --origin https://ledger.example.com auth status');
    expect(text).toContain('lobster --origin https://ledger.example.com bets create');
    expect(text).toContain(
      'lobster --origin https://ledger.example.com bets create --file bet.json --dry-run',
    );
    expect(text).toContain(
      'lobster --origin https://ledger.example.com bets create --file bet.json --yes',
    );
    expect(text).toContain('lobster --origin https://ledger.example.com auth logout');
    expect(text).toContain('other bettor still needs to confirm');
  });

  it('builds the local CLI and targets the loopback origin in copyable commands', () => {
    const text = guideText('http://127.0.0.1:5173');
    expect(text).toContain('pnpm build:cli');
    expect(text).toContain('npm install -g ./dist/downloads/lobster-ledger-cli-0.1.0.tgz');
    expect(text).toContain('lobster --origin http://127.0.0.1:5173 auth login');
    expect(text).not.toContain('workers.dev');
  });

  it.each([
    'http://localhost:5173',
    'http://ledger.example.com',
    'https://ledger.example.com/path',
  ])('provides connection guidance without current-server commands for %s', (origin) => {
    const text = guideText(origin);
    expect(text).toContain('https://');
    expect(text).toContain('http://127.0.0.1');
    expect(text).not.toContain('npm install -g');
    expect(text).not.toContain('lobster auth login');
    expect(text).not.toContain('workers.dev');
  });

  it('quotes IPv6 hosts in terminal commands', () => {
    const text = guideText('https://[2001:db8::1]:8443').replaceAll('&quot;', '"');
    expect(text).toContain(
      'npm install -g "https://[2001:db8::1]:8443/downloads/lobster-ledger-cli-0.1.0.tgz"',
    );
    expect(text).toContain('lobster --origin "https://[2001:db8::1]:8443" auth login');
  });

  it('scopes the authorization restart command to this ledger', () => {
    const text = renderToStaticMarkup(
      createElement(CliAuthorization, {
        origin: 'https://ledger.example.com',
        requestState: { error: 'Run lobster auth login again.' },
        request: vi.fn() as unknown as CliRequest,
        onSignIn: vi.fn(),
        onDismiss: vi.fn(),
      }),
    ).replace(/<[^>]+>/g, '');
    expect(text).toContain('lobster --origin https://ledger.example.com auth login');
    expect(text).not.toContain('lobster auth login');
  });

  it('requires sign-in before presenting the explicit authorization action', () => {
    const request = vi.fn() as unknown as CliRequest;
    const html = renderToStaticMarkup(
      createElement(CliAuthorization, {
        origin: 'https://ledger.example.com',
        requestState: { pending },
        request,
        onSignIn: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain('Sign in with Google to continue');
    expect(html).not.toContain('>Allow CLI access<');
    expect(request).not.toHaveBeenCalled();
  });

  it('shows device, signed-in account, and consent without automatically approving', () => {
    const request = vi.fn() as unknown as CliRequest;
    const authorized = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CliAuthorization, {
        origin: 'https://ledger.example.com',
        requestState: { pending },
        memberName: 'Ellis',
        request,
        onSignIn: vi.fn(),
        onDismiss: vi.fn(),
        onAuthorized: authorized,
      }),
    );
    expect(html).toContain('Personal laptop');
    expect(html).toContain('Authorizing as');
    expect(html).toContain('Ellis');
    expect(html).toContain('Allow CLI access');
    expect(html).toContain('Other members still confirm their own');
    expect(request).not.toHaveBeenCalled();
    expect(authorized).not.toHaveBeenCalled();
  });

  it('does not authorize demo members or invalid requests', () => {
    const request = vi.fn() as unknown as CliRequest;
    const demoHtml = renderToStaticMarkup(
      createElement(CliAuthorization, {
        origin: 'https://ledger.example.com',
        requestState: { pending },
        memberName: 'Sample member',
        demo: true,
        request,
        onSignIn: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(demoHtml).toContain('demo cannot authorize');
    expect(demoHtml).not.toContain('>Allow CLI access<');
    const invalidHtml = renderToStaticMarkup(
      createElement(CliAuthorization, {
        origin: 'https://ledger.example.com',
        requestState: { error: 'This request has expired.' },
        memberName: 'Ellis',
        request,
        onSignIn: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(invalidHtml).toContain('This request has expired.');
    expect(invalidHtml).not.toContain('Allow CLI access');
    expect(request).not.toHaveBeenCalled();
  });
});
