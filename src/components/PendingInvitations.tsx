import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '../lib/client';
import type { OpenInvite } from '../lib/types';
import { SectionTitle, dateLabel } from './ui';
import './pending-invites.css';

const expiryLabel = (value: string) =>
  `${dateLabel(value)}, ${new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

/**
 * The invitations their maker can still revoke. `refreshKey` changes when a new one is made, so the
 * list asks again. It stays out of the way when nothing is waiting.
 */
export function PendingInvitations({ refreshKey = '' }: { refreshKey?: string }) {
  const [invites, setInvites] = useState<OpenInvite[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [revoking, setRevoking] = useState('');
  const [error, setError] = useState('');
  // A fresh object each time, so revoking two people with one name still moves focus. `gone` is for an
  // invitation that was already over: used, expired or revoked from another window.
  const [revoked, setRevoked] = useState<{ name: string; gone?: boolean }>();
  const confirmation = useRef<HTMLParagraphElement>(null);

  // A new invitation changes the list, so what was said about a revoked one no longer describes it.
  useEffect(() => {
    setRevoked(undefined);
    setError('');
  }, [refreshKey]);

  useEffect(() => {
    let current = true;
    api
      .invites()
      .then(({ invites: open }) => {
        if (!current) return;
        setInvites(open);
        setLoadFailed(false);
      })
      .catch(() => {
        if (current) setLoadFailed(true);
      });
    return () => {
      current = false;
    };
  }, [refreshKey, attempt]);

  // The button that was pressed leaves with its row, so focus goes to the confirmation.
  useEffect(() => {
    if (revoked) confirmation.current?.focus();
  }, [revoked]);

  async function revoke(invite: OpenInvite) {
    if (revoking) return;
    setRevoking(invite.id);
    setError('');
    try {
      await api.revokeInvite(invite.id);
      setInvites((open) => open.filter((item) => item.id !== invite.id));
      setRevoked({ name: invite.name });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        // Nothing is left to revoke, so the row goes and the list is asked for again.
        setInvites((open) => open.filter((item) => item.id !== invite.id));
        setRevoked({ name: invite.name, gone: true });
        setAttempt((count) => count + 1);
      } else
        setError(reason instanceof Error ? reason.message : 'Unable to revoke this invitation.');
    } finally {
      setRevoking('');
    }
  }

  if (!invites.length && !revoked && !loadFailed) return null;
  return (
    <section className="panel pending-invites" aria-label="Pending invitations">
      <SectionTitle
        title="Pending invitations"
        subtitle="Each link works once and can’t be shown again. If one went to the wrong person, revoke it and invite again."
      />
      {loadFailed && (
        <p className="pending-invites-note" role="status">
          Pending invitations could not be loaded.{' '}
          <button className="text-button" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </button>
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {revoked && (
        <p className="pending-invites-note" role="status" tabIndex={-1} ref={confirmation}>
          The invitation for <bdi>{revoked.name}</bdi> is{' '}
          {revoked.gone ? 'no longer open' : 'revoked'}.
        </p>
      )}
      {invites.length > 0 && (
        <ul className="pending-invite-list">
          {invites.map((invite) => (
            <li key={invite.id}>
              <div>
                <strong>
                  <bdi>{invite.name}</bdi>
                </strong>
                <span>Expires {expiryLabel(invite.expiresAt)}</span>
              </div>
              <button
                className="button button-secondary"
                aria-label={`Revoke the invitation for ${invite.name}`}
                aria-disabled={revoking === invite.id || undefined}
                onClick={() => void revoke(invite)}
              >
                <X size={16} aria-hidden="true" />
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
