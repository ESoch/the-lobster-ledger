// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAuthorization, CliGuide, CliSessions, type CliRequest } from './CliAccess';
import { ApiError } from '../lib/client';
import { CLI_REQUEST_LIFETIME, CLI_REQUEST_STORAGE } from './cli-request';

let root: Root;
let container: HTMLDivElement;
const authorization = {
  codeChallenge: 'a'.repeat(43),
  state: 'b'.repeat(43),
  deviceName: 'Personal laptop',
  redirectUri: 'http://127.0.0.1:49123/callback',
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  );
  expect(button, `Missing button: ${label}`).toBeTruthy();
  await act(async () => button!.click());
}

describe('CLI consent interactions', () => {
  it('authorizes only after explicit consent and returns to the exact matching loopback', async () => {
    const pending = { request: authorization, createdAt: Date.now() };
    window.sessionStorage.setItem(CLI_REQUEST_STORAGE, JSON.stringify(pending));
    const redirectUrl = `${authorization.redirectUri}?code=${'c'.repeat(43)}&state=${authorization.state}`;
    const request = vi.fn().mockResolvedValue({ redirectUrl });
    const onAuthorized = vi.fn();
    await act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending },
          memberName: 'Ellis',
          request: request as CliRequest,
          onSignIn: vi.fn(),
          onDismiss: vi.fn(),
          onAuthorized,
        }),
      ),
    );
    expect(request).not.toHaveBeenCalled();
    await click('Allow CLI access');
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/cli/authorize', {
      method: 'POST',
      body: JSON.stringify(authorization),
    });
    expect(onAuthorized).toHaveBeenCalledExactlyOnceWith(redirectUrl);
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).toBeNull();
  });

  it('does not approve a request that expires while the page is open', async () => {
    const createdAt = Date.now();
    const request = vi.fn();
    await act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending: { request: authorization, createdAt } },
          memberName: 'Ellis',
          request: request as CliRequest,
          onSignIn: vi.fn(),
          onDismiss: vi.fn(),
        }),
      ),
    );
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + CLI_REQUEST_LIFETIME);
    await click('Allow CLI access');
    expect(request).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('expired');
  });

  it('clears a cancelled request without authorizing it', async () => {
    const pending = { request: authorization, createdAt: Date.now() };
    window.sessionStorage.setItem(CLI_REQUEST_STORAGE, JSON.stringify(pending));
    const request = vi.fn();
    const onDismiss = vi.fn();
    await act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending },
          memberName: 'Ellis',
          request: request as CliRequest,
          onSignIn: vi.fn(),
          onDismiss,
        }),
      ),
    );
    await click('Cancel');
    expect(request).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).toBeNull();
  });

  it('leaves the stored request alone when the demo card is cancelled', async () => {
    const pending = { request: authorization, createdAt: Date.now() };
    window.sessionStorage.setItem(CLI_REQUEST_STORAGE, JSON.stringify(pending));
    const onDismiss = vi.fn();
    await act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending },
          memberName: 'Sample member',
          demo: true,
          request: vi.fn() as unknown as CliRequest,
          onSignIn: vi.fn(),
          onDismiss,
        }),
      ),
    );
    await click('Cancel');
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).toBe(JSON.stringify(pending));
  });

  it('rejects a malformed or external authorization response', async () => {
    const request = vi.fn().mockResolvedValue({
      redirectUrl: `https://elsewhere.example/callback?code=${'c'.repeat(43)}&state=${authorization.state}`,
    });
    const onAuthorized = vi.fn();
    await act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending: { request: authorization, createdAt: Date.now() } },
          memberName: 'Ellis',
          request: request as CliRequest,
          onSignIn: vi.fn(),
          onDismiss: vi.fn(),
          onAuthorized,
        }),
      ),
    );
    await click('Allow CLI access');
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('invalid destination');
  });
});

describe('CLI connected device interactions', () => {
  const session = {
    id: 'personal-session',
    deviceName: 'Personal laptop',
    createdAt: '2026-09-20T12:00:00Z',
    lastUsedAt: '2026-09-20T12:30:00Z',
    expiresAt: '2026-12-19T12:00:00Z',
  };

  it('requires confirmation before revoking a listed device and removes it after success', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session] })
      .mockResolvedValueOnce({ ok: true });
    await act(async () =>
      root.render(createElement(CliSessions, { request: request as CliRequest })),
    );
    expect(container.querySelector('h3')?.textContent).toBe(session.deviceName);
    await click('Revoke');
    expect(request).toHaveBeenCalledTimes(1);
    await click('Confirm revoke');
    expect(request).toHaveBeenLastCalledWith('/api/cli/sessions/personal-session', {
      method: 'DELETE',
    });
    expect(container.querySelector('h3')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Access revoked for Personal laptop',
    );
  });

  it('keeps the device visible if revocation fails', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session] })
      .mockRejectedValueOnce(new Error('Sign in again to revoke this device.'));
    await act(async () =>
      root.render(createElement(CliSessions, { request: request as CliRequest })),
    );
    await click('Revoke');
    await click('Confirm revoke');
    expect(container.querySelector('h3')?.textContent).toBe(session.deviceName);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sign in again');
  });
});

describe('CLI connected device revoke flow', () => {
  const session = {
    id: 'personal-session',
    deviceName: 'Personal laptop',
    createdAt: '2026-09-20T12:00:00Z',
    lastUsedAt: '2026-09-20T12:30:00Z',
    expiresAt: '2026-12-19T12:00:00Z',
  };
  const renderSessions = (request: CliRequest) =>
    act(async () => root.render(createElement(CliSessions, { request })));
  const byId = (id: string) => document.getElementById(id);

  it('moves focus into the confirmation and back to Revoke when access is kept', async () => {
    await renderSessions(vi.fn().mockResolvedValue({ sessions: [session] }) as CliRequest);
    await click('Revoke');
    expect(document.activeElement).toBe(byId('cli-keep-personal-session'));
    expect(document.activeElement?.textContent).toBe('Keep access');
    await click('Keep access');
    expect(document.activeElement).toBe(byId('cli-revoke-personal-session'));
  });

  it('puts focus on the confirmation message once the device is gone', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session] })
      .mockResolvedValueOnce({ ok: true });
    await renderSessions(request as CliRequest);
    await click('Revoke');
    await click('Confirm revoke');
    const notice = byId('cli-devices-notice')!;
    expect(notice.textContent).toBe('Access revoked for Personal laptop.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(notice);
  });

  it('shows a failed revoke on its own row and retries only that revoke', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session] })
      .mockRejectedValueOnce(new Error('Could not revoke this device. Try again.'))
      .mockResolvedValueOnce({ ok: true });
    await renderSessions(request as CliRequest);
    await click('Revoke');
    await click('Confirm revoke');
    const row = container.querySelector('.cli-device')!;
    expect(row.querySelector('[role="alert"]')?.textContent).toContain('Could not revoke');
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const retry = [...row.querySelectorAll('button')].find(
      (item) => item.textContent === 'Try again',
    )!;
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(retry);
    await click('Try again');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith('/api/cli/sessions/personal-session', {
      method: 'DELETE',
    });
    expect(container.querySelector('.cli-device')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('clears a failed revoke when access is kept', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session] })
      .mockRejectedValueOnce(new Error('Sign in again to revoke this device.'));
    await renderSessions(request as CliRequest);
    await click('Revoke');
    await click('Confirm revoke');
    await click('Keep access');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(byId('cli-revoke-personal-session'));
  });

  it('keeps the list-level retry for a list that failed to load', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('Could not load connected devices.'))
      .mockResolvedValueOnce({ sessions: [session] });
    await renderSessions(request as CliRequest);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    await click('Try again');
    expect(container.querySelector('h3')?.textContent).toBe('Personal laptop');
  });

  it('isolates a device name that tries to reorder the text around it', async () => {
    const spoof = { ...session, deviceName: 'laptop \u202Egpj.exe' };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [spoof] })
      .mockResolvedValueOnce({ ok: true });
    await renderSessions(request as CliRequest);
    expect(container.querySelector('h3 bdi')?.textContent).toBe(spoof.deviceName);
    await click('Revoke');
    await click('Confirm revoke');
    expect(byId('cli-devices-notice')?.querySelector('bdi')?.textContent).toBe(spoof.deviceName);
  });
});

describe('CLI guide anatomy', () => {
  it('uses the app page heading and a titled panel for every step, card and device list', async () => {
    await act(async () =>
      root.render(
        createElement(CliGuide, {
          origin: 'https://ledger.example.com',
          signedIn: false,
          demo: false,
          request: vi.fn() as unknown as CliRequest,
          onSignIn: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector('.page-heading h1')?.textContent).toBe(
      'Your ledger, from the command line.',
    );
    expect(container.querySelector('.cli-intro')).toBeNull();
    const panels = [...container.querySelectorAll('section')];
    expect(panels.length).toBeGreaterThanOrEqual(8);
    for (const panel of panels) {
      expect(panel.classList.contains('panel')).toBe(true);
      const heading = panel.querySelector(':scope > .section-title h2')!;
      expect(panel.getAttribute('aria-labelledby')).toBe(heading.id);
    }
    expect(
      [...container.querySelectorAll('.cli-steps .cli-step-number')].map((n) => n.textContent),
    ).toEqual(['1', '2', '3']);
    // Every aside card carries an icon in its title row, so tablet headings line up.
    const aside = [...container.querySelectorAll('aside .section-title')];
    expect(aside).toHaveLength(3);
    for (const title of aside) expect(title.querySelector('svg + h2')).toBeTruthy();
  });
});

describe('CLI authorization problems', () => {
  const renderProblem = (requestState: Parameters<typeof CliAuthorization>[0]['requestState']) =>
    act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState,
          memberName: 'Ellis',
          request: vi.fn() as unknown as CliRequest,
          onSignIn: vi.fn(),
          onDismiss: vi.fn(),
        }),
      ),
    );

  it.each([
    [
      'an invalid request',
      { error: 'This CLI sign-in request is invalid. Run lobster auth login again.' },
    ],
    [
      'an expired request',
      { pending: { request: authorization, createdAt: Date.now() - CLI_REQUEST_LIFETIME } },
    ],
  ])('shows %s as a problem with a warning icon and a copyable fix', async (_, requestState) => {
    await renderProblem(requestState);
    const card = container.querySelector('.cli-authorization')!;
    expect(card.classList.contains('is-problem')).toBe(true);
    expect(card.querySelector('.cli-section-icon svg.lucide-triangle-alert')).toBeTruthy();
    expect(card.querySelector('.lucide-key-round')).toBeNull();
    const alert = card.querySelector('[role="alert"]')!;
    expect(alert.classList.contains('cli-error')).toBe(true);
    expect(alert.querySelector('code')?.textContent).toBe(
      'lobster --origin https://ledger.example.com auth login',
    );
    expect(card.querySelector('pre code')?.textContent).toBe(
      'lobster --origin https://ledger.example.com auth login',
    );
    expect(card.querySelector('button[aria-label="Copy login command"]')).toBeTruthy();
    expect(card.textContent).not.toContain('Allow CLI access');
  });

  it('keeps a valid request in the normal tone', async () => {
    await renderProblem({ pending: { request: authorization, createdAt: Date.now() } });
    const card = container.querySelector('.cli-authorization')!;
    expect(card.classList.contains('is-problem')).toBe(false);
    expect(card.querySelector('.lucide-key-round')).toBeTruthy();
  });
});

describe('CLI authorization after Allow fails', () => {
  const live = { request: authorization, createdAt: Date.now() };
  const renderAllow = (
    request: CliRequest,
    extra: Partial<Parameters<typeof CliAuthorization>[0]> = {},
  ) =>
    act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending: live },
          memberName: 'Ellis',
          request,
          onSignIn: vi.fn(),
          onDismiss: vi.fn(),
          onAuthorized: vi.fn(),
          ...extra,
        }),
      ),
    );
  const card = () => container.querySelector('.cli-authorization')!;
  const heading = () => container.querySelector('#cli-authorization-title');
  const buttons = () => [...card().querySelectorAll('button')].map((item) => item.textContent);

  async function expectFreshStart() {
    expect(card().classList.contains('is-problem')).toBe(true);
    expect(heading()?.textContent).toBe('CLI sign-in needs a fresh start');
    expect(card().querySelector('.cli-section-icon svg.lucide-triangle-alert')).toBeTruthy();
    expect(card().querySelector('[role="alert"] code')?.textContent).toBe(
      'lobster --origin https://ledger.example.com auth login',
    );
    expect(card().querySelector('pre code')?.textContent).toBe(
      'lobster --origin https://ledger.example.com auth login',
    );
    expect(card().querySelector('button[aria-label="Copy login command"]')).toBeTruthy();
    expect(buttons()).not.toContain('Allow CLI access');
    expect(buttons()).toContain('Dismiss');
    expect(document.activeElement).toBe(heading());
  }

  it('turns a request the server rejects as invalid into a fresh-start problem a retry cannot repeat', async () => {
    window.sessionStorage.setItem(CLI_REQUEST_STORAGE, JSON.stringify(live));
    const request = vi
      .fn()
      .mockRejectedValue(new ApiError('Invalid CLI authorization request.', 400));
    await renderAllow(request as CliRequest);
    await click('Allow CLI access');
    await expectFreshStart();
    expect(card().querySelector('[role="alert"]')?.textContent).toContain(
      'Invalid CLI authorization request.',
    );
    // The request is dead, so a reload does not bring the same card back.
    expect(window.sessionStorage.getItem(CLI_REQUEST_STORAGE)).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('turns a destination the server should not have returned into the same fresh-start problem', async () => {
    const onAuthorized = vi.fn();
    const request = vi.fn().mockResolvedValue({
      redirectUrl: `https://elsewhere.example/callback?code=${'c'.repeat(43)}&state=${authorization.state}`,
    });
    await renderAllow(request as CliRequest, { onAuthorized });
    await click('Allow CLI access');
    await expectFreshStart();
    expect(card().querySelector('[role="alert"]')?.textContent).toContain('invalid destination');
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  it('dismisses the fresh-start problem like any other', async () => {
    const onDismiss = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValue(new ApiError('Invalid CLI authorization request.', 400));
    await renderAllow(request as CliRequest, { onDismiss });
    await click('Allow CLI access');
    await click('Dismiss');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  describe('when the card is closed', () => {
    // On the guide page the card sits under the page's title, which is where focus belongs once the
    // card and the button that was pressed are gone: not <body>, where Tab would start at the top.
    const withTitle = () => {
      const main = document.createElement('main');
      const title = document.createElement('h1');
      title.textContent = 'Command-line access';
      main.appendChild(title);
      document.body.insertBefore(main, container);
      return { title, main };
    };
    it('moves focus to the page title when Cancel is pressed on a live request', async () => {
      const { title, main } = withTitle();
      const onDismiss = vi.fn();
      await renderAllow(vi.fn() as unknown as CliRequest, { onDismiss });
      const cancel = [...card().querySelectorAll('button')].find(
        (item) => item.textContent === 'Cancel',
      )!;
      cancel.focus();
      await act(async () => cancel.click());
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(title);
      main.remove();
    });

    it('moves focus to the page title when a fresh-start problem is dismissed', async () => {
      const { title, main } = withTitle();
      const request = vi
        .fn()
        .mockRejectedValue(new ApiError('Invalid CLI authorization request.', 400));
      await renderAllow(request as CliRequest);
      await click('Allow CLI access');
      const dismiss = [...card().querySelectorAll('button')].find(
        (item) => item.textContent === 'Dismiss',
      )!;
      dismiss.focus();
      await act(async () => dismiss.click());
      expect(document.activeElement).toBe(title);
      main.remove();
    });

    it('does the same for the demo card, which has no Allow button', async () => {
      const { title, main } = withTitle();
      await renderAllow(vi.fn() as unknown as CliRequest, { demo: true });
      await click('Cancel');
      expect(document.activeElement).toBe(title);
      main.remove();
    });
  });

  it('offers sign-in, not a retry, when the session has ended', async () => {
    const onSignIn = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValue(new ApiError('Your session has expired. Please sign in again.', 401));
    await renderAllow(request as CliRequest, { onSignIn });
    await click('Allow CLI access');
    expect(card().classList.contains('is-problem')).toBe(false);
    expect(card().querySelector('[role="alert"]')?.textContent).toBe(
      'Your session has expired. Please sign in again.',
    );
    expect(buttons()).toEqual(['Sign in with Google to continue', 'Cancel']);
    expect(card().textContent).not.toContain('Authorizing as');
    expect(document.activeElement).toBe(heading());
    await click('Sign in with Google to continue');
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('keeps Allow, and keeps focus on it, for a failure that trying again can fix', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Unable to complete the request (503).', 503))
      .mockResolvedValueOnce({
        redirectUrl: `${authorization.redirectUri}?code=${'c'.repeat(43)}&state=${authorization.state}`,
      });
    const onAuthorized = vi.fn();
    await renderAllow(request as CliRequest, { onAuthorized });
    const allow = [...card().querySelectorAll('button')].find(
      (item) => item.textContent === 'Allow CLI access',
    )!;
    allow.focus();
    await act(async () => allow.click());
    expect(card().classList.contains('is-problem')).toBe(false);
    expect(card().querySelector('[role="alert"]')?.textContent).toBe(
      'Unable to complete the request (503).',
    );
    expect(allow.isConnected).toBe(true);
    expect(allow.textContent).toBe('Allow CLI access');
    expect(document.activeElement).toBe(allow);
    await act(async () => allow.click());
    expect(onAuthorized).toHaveBeenCalledOnce();
  });

  it('keeps the button focusable, and ignores a second press, while the request is out', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const request = vi.fn().mockReturnValue(new Promise((resolve) => (settle = resolve)));
    await renderAllow(request as CliRequest);
    const allow = [...card().querySelectorAll('button')].find(
      (item) => item.textContent === 'Allow CLI access',
    )!;
    allow.focus();
    await act(async () => allow.click());
    expect(allow.textContent).toBe('Connecting…');
    expect(allow.disabled).toBe(false);
    expect(allow.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(allow);
    await act(async () => allow.click());
    expect(request).toHaveBeenCalledOnce();
    await act(async () => settle(new Error('stop')));
  });

  it('moves focus to the heading when the request expires under the focused Allow button', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const createdAt = Date.now();
      await act(async () =>
        root.render(
          createElement(CliAuthorization, {
            origin: 'https://ledger.example.com',
            requestState: { pending: { request: authorization, createdAt } },
            memberName: 'Ellis',
            request: vi.fn() as unknown as CliRequest,
            onSignIn: vi.fn(),
            onDismiss: vi.fn(),
          }),
        ),
      );
      const allow = [...card().querySelectorAll('button')].find(
        (item) => item.textContent === 'Allow CLI access',
      )!;
      allow.focus();
      expect(document.activeElement).toBe(allow);
      vi.spyOn(Date, 'now').mockReturnValue(createdAt + CLI_REQUEST_LIFETIME);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(card().classList.contains('is-problem')).toBe(true);
      expect(allow.isConnected).toBe(false);
      expect(document.activeElement).toBe(heading());
    } finally {
      vi.useRealTimers();
    }
  });

  describe('when the card changes while focus is somewhere else', () => {
    // The card changes under a timer or a response, not under the person. It takes focus only from
    // what went away with it: focus on the page behind, or inside an open dialog, is not its to move.
    const fixtures: HTMLElement[] = [];
    afterEach(() => {
      fixtures.splice(0).forEach((item) => item.remove());
    });
    const outsideButton = () => {
      const button = document.createElement('button');
      button.textContent = 'Copy command';
      document.body.appendChild(button);
      fixtures.push(button);
      return button;
    };
    const dialogInput = () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Name');
      dialog.appendChild(input);
      document.body.appendChild(dialog);
      fixtures.push(dialog);
      return input;
    };
    const renderLive = (request: CliRequest = vi.fn() as unknown as CliRequest) =>
      act(async () =>
        root.render(
          createElement(CliAuthorization, {
            origin: 'https://ledger.example.com',
            requestState: { pending: live },
            memberName: 'Ellis',
            request,
            onSignIn: vi.fn(),
            onDismiss: vi.fn(),
          }),
        ),
      );
    const expire = async () => {
      vi.spyOn(Date, 'now').mockReturnValue(live.createdAt + CLI_REQUEST_LIFETIME);
      await act(async () => vi.advanceTimersByTime(1000));
    };

    it.each([
      ['a control further down the page', outsideButton],
      ['the name field of an open dialog', dialogInput],
    ])('leaves focus on %s when the request expires', async (_, makeElsewhere) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        await renderLive();
        const elsewhere = makeElsewhere();
        elsewhere.focus();
        expect(document.activeElement).toBe(elsewhere);
        await expire();
        expect(card().classList.contains('is-problem')).toBe(true);
        expect(document.activeElement).toBe(elsewhere);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves focus where it went while Allow was waiting for a refusal', async () => {
      let refuse: (reason: unknown) => void = () => undefined;
      const request = vi.fn().mockReturnValue(new Promise((_, reject) => (refuse = reject)));
      await renderLive(request as CliRequest);
      const allow = [...card().querySelectorAll('button')].find(
        (item) => item.textContent === 'Allow CLI access',
      )!;
      allow.focus();
      await act(async () => allow.click());
      const elsewhere = dialogInput();
      elsewhere.focus();
      await act(async () => refuse(new ApiError('Invalid CLI authorization request.', 400)));
      expect(card().classList.contains('is-problem')).toBe(true);
      expect(document.activeElement).toBe(elsewhere);
    });

    it('still takes focus when it has fallen to the page because the focused control went away', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        await renderLive();
        const allow = [...card().querySelectorAll('button')].find(
          (item) => item.textContent === 'Allow CLI access',
        )!;
        allow.focus();
        allow.blur();
        expect(document.activeElement).toBe(document.body);
        await expire();
        expect(card().classList.contains('is-problem')).toBe(true);
        expect(document.activeElement).toBe(heading());
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('CLI authorization card', () => {
  const live = { request: authorization, createdAt: Date.now() };
  const renderCard = (props: Partial<Parameters<typeof CliAuthorization>[0]> = {}) =>
    act(async () =>
      root.render(
        createElement(CliAuthorization, {
          origin: 'https://ledger.example.com',
          requestState: { pending: live },
          memberName: 'Ellis',
          request: vi.fn() as unknown as CliRequest,
          onSignIn: vi.fn(),
          onDismiss: vi.fn(),
          ...props,
        }),
      ),
    );

  it('explains the missing Allow button before the permission list and links to the live ledger', async () => {
    await renderCard({ demo: true, memberName: 'Sample member' });
    const notice = container.querySelector('.cli-demo-notice')!;
    expect(notice.textContent).toContain('The demo cannot authorize a CLI');
    expect(notice.querySelector('a[href="/"]')?.textContent).toContain('live ledger');
    const list = container.querySelector('.cli-permissions')!;
    expect(notice.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.cli-actions button')?.textContent).toBe('Cancel');
  });

  it('keeps the demo notice when a demo request is invalid', async () => {
    await renderCard({
      demo: true,
      requestState: { error: 'This CLI sign-in request is invalid. Run lobster auth login again.' },
    });
    expect(container.querySelector('.cli-authorization.is-problem')).toBeTruthy();
    const notice = container.querySelector('.cli-demo-notice')!;
    expect(notice.textContent).toContain('The demo cannot authorize a CLI');
    expect(notice.querySelector('a[href="/"]')).toBeTruthy();
  });

  it('states the check before allowing as a plain instruction, not a footnote', async () => {
    await renderCard();
    const instruction = [...container.querySelectorAll('p')].find((item) =>
      item.textContent?.includes('Only allow access if you just ran'),
    )!;
    expect(instruction.classList.contains('cli-note')).toBe(false);
    expect(instruction.querySelector('strong')).toBeTruthy();
    expect(instruction.querySelector('code')?.textContent).toBe(
      'lobster --origin https://ledger.example.com auth login',
    );
  });

  it('moves focus to the card heading when a request arrives and when it fails', async () => {
    await renderCard();
    const heading = container.querySelector<HTMLElement>('#cli-authorization-title')!;
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
    await act(async () => root.render(null));
    await renderCard({ requestState: { error: 'This CLI sign-in request is invalid.' } });
    expect(document.activeElement).toBe(
      container.querySelector<HTMLElement>('#cli-authorization-title'),
    );
  });

  it('puts the card after the guide heading so the page keeps h1 before h2', async () => {
    await act(async () =>
      root.render(
        createElement(CliGuide, {
          origin: 'https://ledger.example.com',
          signedIn: true,
          demo: false,
          request: vi.fn().mockResolvedValue({ sessions: [] }) as unknown as CliRequest,
          onSignIn: vi.fn(),
          authorization: createElement(CliAuthorization, {
            origin: 'https://ledger.example.com',
            requestState: { pending: live },
            memberName: 'Ellis',
            request: vi.fn() as unknown as CliRequest,
            onSignIn: vi.fn(),
            onDismiss: vi.fn(),
          }),
        }),
      ),
    );
    const headings = [...container.querySelectorAll('h1, h2')];
    expect(headings[0].tagName).toBe('H1');
    expect(headings[1].id).toBe('cli-authorization-title');
    expect(container.querySelector('.cli-guide > .cli-authorization')).toBeTruthy();
  });

  it('sets a device name in its own bidi isolate', async () => {
    const request = { ...authorization, deviceName: 'Lobster CLI on wide-host' };
    await renderCard({ requestState: { pending: { request, createdAt: Date.now() } } });
    expect(container.querySelector('strong bdi')?.textContent).toBe('Lobster CLI on wide-host');
  });

  it('shows how long the request lasts and that Cancel does not stop the waiting terminal', async () => {
    await renderCard();
    const timing = container.querySelector('.cli-expiry')!;
    expect(timing.textContent).toContain('expires in 5 minutes');
    expect(timing.textContent).toContain('Ctrl+C');
    expect(timing.textContent).toContain('Cancel only closes this card');
    expect(timing.hasAttribute('aria-live')).toBe(false);
  });

  it('counts the minutes down and calls the last one less than a minute', async () => {
    vi.useFakeTimers();
    try {
      await renderCard({
        requestState: { pending: { request: authorization, createdAt: Date.now() } },
      });
      await act(async () => vi.advanceTimersByTime(2 * 60_000 + 1000));
      expect(container.querySelector('.cli-expiry')?.textContent).toContain('expires in 3 minutes');
      await act(async () => vi.advanceTimersByTime(2 * 60_000));
      expect(container.querySelector('.cli-expiry')?.textContent).toContain(
        'expires in less than a minute',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why a disabled sign-in button is off and describes the button with that reason', async () => {
    await renderCard({ memberName: undefined, signInAvailable: false });
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Sign in with Google'),
    )!;
    expect(button.disabled).toBe(true);
    const reason = container.querySelector(`#${button.getAttribute('aria-describedby')}`)!;
    expect(reason.textContent).toContain('Google sign-in isn’t set up');
    expect(button.classList.contains('cli-unavailable')).toBe(true);
  });
  it('gives the reason it is handed for a sign-in that cannot be reached', async () => {
    await renderCard({
      memberName: undefined,
      signInAvailable: false,
      signInUnavailableReason: 'Sign-in can’t be reached right now. Try again shortly.',
    });
    const button = container.querySelector<HTMLButtonElement>('button.cli-unavailable')!;
    expect(
      container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent,
    ).toBe('Sign-in can’t be reached right now. Try again shortly.');
  });
});

describe('CLI guide for visitors', () => {
  const renderGuide = (props: Partial<Parameters<typeof CliGuide>[0]> = {}) =>
    act(async () =>
      root.render(
        createElement(CliGuide, {
          origin: 'https://ledger.example.com',
          signedIn: false,
          demo: false,
          request: vi.fn() as unknown as CliRequest,
          onSignIn: vi.fn(),
          ...props,
        }),
      ),
    );

  it('opens the demo guide with a notice that links to the live ledger', async () => {
    await renderGuide({ demo: true });
    const notice = container.querySelector('.connection-notice')!;
    expect(notice.textContent).toContain('This demo cannot connect a CLI');
    expect(notice.querySelector('a[href="/"]')).toBeTruthy();
    const heading = container.querySelector('.page-heading')!;
    expect(heading.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('#cli-devices-title')?.textContent).toBe(
      'Connected command lines',
    );
  });

  it('leaves the demo notice to a sign-in request card so the page says it once', async () => {
    await renderGuide({
      demo: true,
      authorization: createElement(CliAuthorization, {
        origin: 'https://ledger.example.com',
        requestState: { pending: { request: authorization, createdAt: Date.now() } },
        demo: true,
        memberName: 'Sample member',
        request: vi.fn() as unknown as CliRequest,
        onSignIn: vi.fn(),
        onDismiss: vi.fn(),
      }),
    });
    expect(container.querySelector('.connection-notice')).toBeNull();
    expect(container.querySelectorAll('.cli-demo-notice')).toHaveLength(1);
  });

  it('tells people the Node.js download opens in a new tab', async () => {
    await renderGuide();
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://nodejs.org/en/download"]',
    )!;
    expect(link.target).toBe('_blank');
    expect(link.querySelector('.sr-only')?.textContent?.trim()).toBe('(opens in a new tab)');
    expect(link.querySelector('.lucide-external-link')).toBeTruthy();
  });

  it('keeps the guide free of a demo notice for real visitors and explains a disabled sign-in', async () => {
    await renderGuide({ signInAvailable: false });
    expect(container.querySelector('.connection-notice')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>('.cli-devices button')!;
    expect(button.disabled).toBe(true);
    expect(
      container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent,
    ).toContain('isn’t set up');
  });
});
