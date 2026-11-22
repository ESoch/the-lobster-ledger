// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/client';
import type { OpenInvite } from '../lib/types';
import { PendingInvitations } from './PendingInvitations';

let root: Root;
let container: HTMLDivElement;

const invite = (name: string, id = name.toLowerCase().replace(/\W+/g, '-')): OpenInvite => ({
  id,
  name,
  createdAt: '2026-10-18T15:00:00.000Z',
  expiresAt: '2026-10-21T15:00:00.000Z',
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show(refreshKey = '') {
  await act(async () => root.render(createElement(PendingInvitations, { refreshKey })));
}
const rows = () => [...container.querySelectorAll('li')];
const revokeButton = (name: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[aria-label="Revoke the invitation for ${name}"]`,
  );
const alert = () => container.querySelector('[role="alert"]')?.textContent;

describe('PendingInvitations', () => {
  it('shows nothing when no invitation is waiting, so a settled table stays uncluttered', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({ invites: [] });
    await show();
    expect(container.innerHTML).toBe('');
  });

  it('lists each open invitation with its name and when it expires', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({
      invites: [invite('Quinn Lee'), invite('Pat Smith')],
    });
    await show();
    expect(container.querySelector('h2')?.textContent).toBe('Pending invitations');
    expect(rows().map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Quinn Lee',
      'Pat Smith',
    ]);
    expect(rows()[0].textContent).toMatch(/Expires Oct 2\d/);
    expect(revokeButton('Quinn Lee')).not.toBeNull();
    expect(revokeButton('Pat Smith')).not.toBeNull();
  });

  it('says the link cannot be shown again, since only its hash is kept', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({ invites: [invite('Pat Smith')] });
    await show();
    expect(container.textContent).toContain('can’t be shown again');
  });

  it('revokes one, drops its row, keeps the others and announces it', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({
      invites: [invite('Quinn Lee'), invite('Pat Smith')],
    });
    const revoke = vi.spyOn(api, 'revokeInvite').mockResolvedValue({ ok: true });
    await show();
    await act(async () => revokeButton('Pat Smith')!.click());
    expect(revoke).toHaveBeenCalledExactlyOnceWith('pat-smith');
    expect(rows().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Quinn Lee']);
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('The invitation for Pat Smith is revoked.');
    // The button that was pressed is gone, so focus moves to the confirmation instead of the page top.
    expect(document.activeElement).toBe(status);
  });

  it('keeps the section, with the confirmation, after the last invitation is revoked', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({ invites: [invite('Pat Smith')] });
    vi.spyOn(api, 'revokeInvite').mockResolvedValue({ ok: true });
    await show();
    await act(async () => revokeButton('Pat Smith')!.click());
    expect(rows()).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Pat Smith');
  });

  it('asks once while a revoke is in flight, and keeps the button focusable', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({ invites: [invite('Pat Smith')] });
    let finish!: (value: { ok: true }) => void;
    const revoke = vi
      .spyOn(api, 'revokeInvite')
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show();
    await act(async () => revokeButton('Pat Smith')!.click());
    const working = revokeButton('Pat Smith')!;
    expect(working.getAttribute('aria-disabled')).toBe('true');
    expect(working.disabled).toBe(false);
    await act(async () => working.click());
    expect(revoke).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
  });

  it('keeps the row and says why when a revoke fails', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({ invites: [invite('Pat Smith')] });
    vi.spyOn(api, 'revokeInvite').mockRejectedValue(new ApiError('The ledger is unreachable.', 0));
    await show();
    await act(async () => revokeButton('Pat Smith')!.click());
    expect(alert()).toBe('The ledger is unreachable.');
    expect(rows()).toHaveLength(1);
    expect(revokeButton('Pat Smith')!.getAttribute('aria-disabled')).toBeNull();
  });

  it('drops the row and says it is no longer open when the invitation was used or ended elsewhere', async () => {
    const invites = vi
      .spyOn(api, 'invites')
      .mockResolvedValueOnce({ invites: [invite('Quinn Lee'), invite('Pat Smith')] })
      .mockResolvedValueOnce({ invites: [invite('Quinn Lee')] });
    vi.spyOn(api, 'revokeInvite').mockRejectedValue(
      new ApiError('That invitation could not be found.', 404),
    );
    await show();
    await act(async () => revokeButton('Pat Smith')!.click());
    expect(rows().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Quinn Lee']);
    expect(alert()).toBeUndefined();
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('The invitation for Pat Smith is no longer open.');
    expect(document.activeElement).toBe(status);
    // The list is asked for again, so nothing else that changed in the meantime is left standing.
    expect(invites).toHaveBeenCalledTimes(2);
  });

  it('asks again for the list when the key changes, as it does after a new invitation', async () => {
    const invites = vi
      .spyOn(api, 'invites')
      .mockResolvedValueOnce({ invites: [invite('Pat Smith')] })
      .mockResolvedValueOnce({ invites: [invite('Quinn Lee'), invite('Pat Smith')] });
    await show('');
    expect(rows()).toHaveLength(1);
    await show('https://ledger.example/auth/google?invite=new');
    expect(invites).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(2);
  });

  it('drops the revoked confirmation once a new invitation is made, as it no longer describes the list', async () => {
    vi.spyOn(api, 'invites')
      .mockResolvedValueOnce({ invites: [invite('Pat Smith')] })
      .mockResolvedValueOnce({ invites: [invite('Quinn Lee')] });
    vi.spyOn(api, 'revokeInvite').mockResolvedValue({ ok: true });
    await show('');
    await act(async () => revokeButton('Pat Smith')!.click());
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await show('https://ledger.example/auth/google?invite=new');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('says so, with a way to try again, when the list cannot be loaded', async () => {
    const invites = vi
      .spyOn(api, 'invites')
      .mockRejectedValueOnce(new ApiError('Unable to reach the ledger.', 0))
      .mockResolvedValueOnce({ invites: [invite('Pat Smith')] });
    await show();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Pending invitations could not be loaded.',
    );
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again',
    )!;
    await act(async () => retry.click());
    expect(invites).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
    expect(container.textContent).not.toContain('could not be loaded');
  });

  it('keeps a long name from pushing the row wider than its card', async () => {
    vi.spyOn(api, 'invites').mockResolvedValue({
      invites: [invite('Wolfeschlegelstein'.repeat(5))],
    });
    await show();
    expect(rows()[0].querySelector('strong bdi')).not.toBeNull();
  });
});
