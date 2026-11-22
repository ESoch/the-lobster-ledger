import type { ReactNode } from 'react';
import { Info, TriangleAlert } from 'lucide-react';

export type NoticeTone = 'info' | 'warning';
export interface NoticeAction {
  label: string;
  /** With an `href` the action is a link (it leaves the page, as sign-in does); otherwise a button. */
  href?: string;
  onClick?: () => void;
}

const icons = { info: Info, warning: TriangleAlert };

/**
 * One notice for every problem with the connection: a tone and its icon, the words, and the next
 * step as a button (Try again, Reconnect, Export, Dismiss) or, when it leaves the page, a link (Sign in again). `warning` is for something that failed
 * and may pass; `info` is for a state that needs someone to act, such as sign-in not being set up.
 */
export function ConnectionNotice({
  tone = 'warning',
  actions = [],
  children,
}: {
  tone?: NoticeTone;
  actions?: NoticeAction[];
  children: ReactNode;
}) {
  const Icon = icons[tone];
  return (
    <div className="connection-notice" data-tone={tone} role="status">
      <Icon size={17} aria-hidden="true" />
      <p>{children}</p>
      {actions.length > 0 && (
        <div className="connection-notice-actions">
          {actions.map((action) =>
            action.href ? (
              <a
                key={action.label}
                className="button button-secondary"
                href={action.href}
                onClick={action.onClick}
              >
                {action.label}
              </a>
            ) : (
              <button
                key={action.label}
                type="button"
                className="button button-secondary"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
