import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ExternalLink,
  Globe,
  KeyRound,
  Laptop,
  RefreshCw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '../lib/client';
import { normalizeOrigin } from '../lib/cli-origin';
import { EXAMPLE_LEDGER_ORIGIN, HOSTED_DEMO, SELF_HOSTING_URL } from '../lib/hosted-demo';
import { CopyBlock, InlineCommand } from './CopyBlock';
import { focusPageHeading } from './ui';
import {
  clearCliRequest,
  cliRequestExpired,
  cliRequestMinutesLeft,
  validateCliCallback,
  type CliRequestState,
} from './cli-request';
import './cli.css';

export interface CliSession {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export type CliRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

const LOGIN_COMMAND = 'lobster auth login';
const CLI_ARCHIVE = 'lobster-ledger-cli-0.1.0.tgz';
const CLI_ORIGIN_GUIDANCE =
  'Open this ledger over https:// or use http://127.0.0.1 for local development.';

function cliOrigin(value: string) {
  try {
    const url = new URL(normalizeOrigin(value));
    // Only place DNS names and IP addresses in copyable shell commands.
    return /^(?:[\w.-]+|\[[\da-f:]+\])$/i.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

function shellAddress(address: string) {
  return address.includes('[') ? `"${address}"` : address;
}

function cliCommand(origin: URL, command: string) {
  return `lobster --origin ${shellAddress(origin.origin)} ${command}`;
}

/**
 * Why a sign-in button is off, linked to it with aria-describedby. The default is for a ledger
 * without Google sign-in; the app passes its own reason when sign-in cannot be reached.
 */
export function SignInUnavailable({ id, reason }: { id: string; reason?: string }) {
  return (
    <p className="cli-note" id={id}>
      {reason || 'Google sign-in isn’t set up on this ledger yet.'}
    </p>
  );
}

/**
 * A link that opens another site in a new tab, and says so to everyone, not only sighted readers.
 * `standalone` is for a link that sits alone in its paragraph, which gets a 44px tap target.
 */
export function NewTabLink({
  href,
  children,
  standalone = false,
}: {
  href: string;
  children: ReactNode;
  standalone?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={standalone ? 'cli-standalone-link' : undefined}
    >
      {children} <ExternalLink size={13} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function expiryLabel(minutes: number) {
  return minutes <= 1 ? 'less than a minute' : `${minutes} minutes`;
}

/** Sets every mention of the login command in a message as code. */
function withLoginCommand(message: string, loginCommand: string | null) {
  if (!loginCommand) return message.replaceAll(LOGIN_COMMAND, 'the CLI sign-in command');
  return message
    .split(LOGIN_COMMAND)
    .flatMap((part, index) =>
      index ? [<InlineCommand key={index} value={loginCommand} />, part] : [part],
    );
}

export function CliAuthorization({
  origin,
  requestState,
  memberName,
  demo = false,
  onSignIn,
  onDismiss,
  request,
  onAuthorized = (url) => window.location.assign(url),
  signInAvailable = true,
  signInUnavailableReason,
}: {
  origin: string;
  requestState: CliRequestState;
  memberName?: string;
  demo?: boolean;
  onSignIn: () => void;
  onDismiss: () => void;
  request: CliRequest;
  onAuthorized?: (url: string) => void;
  signInAvailable?: boolean;
  signInUnavailableReason?: string;
}) {
  const address = cliOrigin(HOSTED_DEMO ? EXAMPLE_LEDGER_ORIGIN : origin);
  const loginCommand = address ? cliCommand(address, 'auth login') : null;
  const [busy, setBusy] = useState(false);
  // A failure Allow can be pressed again after (a lost connection, a busy server) keeps the card as it
  // is. One that pressing again cannot fix replaces it: a request the server refuses, or an answer
  // that does not lead back to the CLI, means starting over from the terminal; an ended session
  // means signing in again.
  const [error, setError] = useState('');
  const [restart, setRestart] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [expired, setExpired] = useState(
    () => !!requestState.pending && cliRequestExpired(requestState.pending),
  );
  const pending = requestState.pending;
  const [minutesLeft, setMinutesLeft] = useState(() =>
    pending ? cliRequestMinutesLeft(pending) : 0,
  );
  useEffect(() => {
    if (!pending) return;
    const update = () => {
      setExpired(cliRequestExpired(pending));
      setMinutesLeft(cliRequestMinutesLeft(pending));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const problem =
    requestState.error ||
    restart ||
    (expired ? 'This sign-in request has expired. Run lobster auth login again.' : '');
  // A request that arrives, or fails, takes focus so it is announced and the next Tab is its action.
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = !!pending || !!requestState.error;
  useEffect(() => {
    if (shown) heading.current?.focus();
  }, [shown]);
  // A card whose button just went away (the request expired, was refused, or the session ended) also
  // takes focus, but only from that button: it would otherwise leave focus on <body>. It changes under
  // a timer or a response, so it never pulls focus from a control further down the page or out of an
  // open dialog. A removed button fires no blur, so what remembers focus was in the card stays true
  // until focus moves to something outside it.
  const focusInCard = useRef(false);
  const needsRestart = !!problem;
  useEffect(() => {
    if (!needsRestart && !signedOut) return;
    const active = document.activeElement;
    if (focusInCard.current || !active || active === document.body) heading.current?.focus();
  }, [needsRestart, signedOut]);

  if (!pending && !requestState.error) return null;
  const dismiss = () => {
    // The demo never owns the stored request, so cancelling there must not discard a real one.
    if (!demo) clearCliRequest();
    onDismiss();
    // The card, and the button that was just pressed, are about to go. Focus moves to the page's
    // title, so the next Tab does not start again from the top of the page.
    focusPageHeading();
  };
  async function authorize() {
    if (!pending || !memberName || demo || busy) return;
    if (cliRequestExpired(pending)) {
      setExpired(true);
      return;
    }
    setBusy(true);
    setError('');
    const startOver = (message: string) => {
      // The request cannot succeed now, so a reload must not bring the same card back.
      clearCliRequest();
      setRestart(message);
      setBusy(false);
    };
    let result: { redirectUrl: string };
    try {
      result = await request<{ redirectUrl: string }>('/api/cli/authorize', {
        method: 'POST',
        body: JSON.stringify(pending.request),
      });
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : undefined;
      const message =
        cause instanceof Error ? cause.message : 'Could not connect the CLI. Try again.';
      if (status === 400) return startOver(`${message} Run ${LOGIN_COMMAND} again.`);
      if (status === 401) setSignedOut(true);
      setError(message);
      setBusy(false);
      return;
    }
    let destination: string;
    try {
      destination = validateCliCallback(result.redirectUrl, pending.request);
    } catch (cause) {
      return startOver(
        cause instanceof Error
          ? cause.message
          : `The CLI returned an invalid destination. Run ${LOGIN_COMMAND} again.`,
      );
    }
    clearCliRequest();
    onAuthorized(destination);
  }

  return (
    <section
      className={`cli-authorization${problem ? ' is-problem' : ''}`}
      aria-labelledby="cli-authorization-title"
      onFocus={() => (focusInCard.current = true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInCard.current = false;
      }}
    >
      <div className="cli-section-icon">
        {problem ? (
          <TriangleAlert size={22} aria-hidden="true" />
        ) : (
          <KeyRound size={22} aria-hidden="true" />
        )}
      </div>
      <div className="cli-authorization-body">
        <h2 id="cli-authorization-title" ref={heading} tabIndex={-1}>
          {problem ? 'CLI sign-in needs a fresh start' : 'Connect your command line'}
        </h2>
        {/* In the demo this is the page's only demo notice; the guide leaves its own out. */}
        {demo && (
          <p className="cli-demo-notice">
            {HOSTED_DEMO ? (
              <>
                To authorize a CLI, <a href={SELF_HOSTING_URL}>set up your own ledger</a> and sign
                in there.
              </>
            ) : (
              <>
                The demo cannot authorize a CLI, so there is no Allow button here. To connect your
                own command line, open the <a href="/">live ledger</a> and sign in.
              </>
            )}
          </p>
        )}
        {problem ? (
          <>
            <p className="cli-error" role="alert">
              {withLoginCommand(problem, loginCommand)}
            </p>
            {loginCommand ? (
              <>
                <p>Start again from the terminal on this computer.</p>
                <CopyBlock label="login command" value={loginCommand} />
              </>
            ) : (
              <p>{CLI_ORIGIN_GUIDANCE}</p>
            )}
          </>
        ) : (
          <>
            <p>
              <strong>
                <bdi>{pending?.request.deviceName}</bdi>
              </strong>{' '}
              is requesting access to your Lobster Ledger account.
            </p>
            <ul className="cli-permissions">
              <li>Read the ledger and create bets as you.</li>
              <li>Perform ledger actions with your account’s permissions.</li>
              <li>Stay signed in until the session expires or you revoke access.</li>
            </ul>
            <p className="cli-note">
              Other members still confirm their own agreements, results, and deliveries.
            </p>
            {!demo && (
              <p className="cli-check">
                <strong>
                  Only allow access if you just{' '}
                  {loginCommand ? (
                    <>
                      ran <InlineCommand value={loginCommand} />
                    </>
                  ) : (
                    'started CLI sign-in'
                  )}{' '}
                  on this computer.
                </strong>
              </p>
            )}
            {!demo && memberName && !signedOut && (
              <p className="cli-signed-in">
                Authorizing as <strong>{memberName}</strong>
              </p>
            )}
            {!demo && (
              <p className="cli-note cli-expiry">
                This request expires in {expiryLabel(minutesLeft)}. Cancel only closes this card;
                press Ctrl+C in the terminal to stop the waiting login.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="cli-error" role="alert">
            {withLoginCommand(error, loginCommand)}
          </p>
        )}
        <div className="cli-actions">
          {!problem &&
            !demo &&
            (memberName && !signedOut ? (
              <button
                className="button button-primary"
                onClick={() => void authorize()}
                aria-disabled={busy || undefined}
              >
                <ShieldCheck size={17} aria-hidden="true" />
                {busy ? 'Connecting…' : 'Allow CLI access'}
              </button>
            ) : (
              <button
                className={`button button-primary${signInAvailable ? '' : ' cli-unavailable'}`}
                onClick={onSignIn}
                disabled={!signInAvailable}
                aria-describedby={signInAvailable ? undefined : 'cli-card-sign-in-unavailable'}
              >
                Sign in with Google to continue
              </button>
            ))}
          <button className="button button-secondary" onClick={dismiss} disabled={busy}>
            {problem ? 'Dismiss' : 'Cancel'}
          </button>
        </div>
        {!problem && !demo && (!memberName || signedOut) && !signInAvailable && (
          <SignInUnavailable id="cli-card-sign-in-unavailable" reason={signInUnavailableReason} />
        )}
      </div>
    </section>
  );
}

function formattedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CliSessions({ request }: { request: CliRequest }) {
  const [sessions, setSessions] = useState<CliSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmId, setConfirmId] = useState<string>();
  const [revoking, setRevoking] = useState<string>();
  // A failed revoke belongs to its own row; only a list that failed to load is retried as a whole.
  const [rowError, setRowError] = useState<{ id: string; message: string }>();
  const [revoked, setRevoked] = useState('');
  // Every step moves focus to the control the reader needs next, so it never falls back to <body>.
  const [focusId, setFocusId] = useState<string>();
  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(undefined);
  }, [focusId]);
  async function load() {
    setError('');
    setLoading(true);
    try {
      const result = await request<{ sessions: CliSession[] }>('/api/cli/sessions');
      setSessions(result.sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load connected devices.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [request]);
  async function revoke(session: CliSession) {
    setRowError(undefined);
    setRevoking(session.id);
    try {
      await request<{ ok: true }>(`/api/cli/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE',
      });
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setConfirmId(undefined);
      setRevoked(session.deviceName);
      setFocusId('cli-devices-notice');
    } catch (cause) {
      setRowError({
        id: session.id,
        message:
          cause instanceof Error ? cause.message : 'Could not revoke this device. Try again.',
      });
      setFocusId(`cli-confirm-${session.id}`);
    } finally {
      setRevoking(undefined);
    }
  }
  return (
    <GuidePanel
      id="cli-devices-title"
      icon={Laptop}
      title="Connected command lines"
      className="cli-devices"
    >
      <p>
        Manage the computers with CLI access to your account. Revoking a device signs its CLI out.
      </p>
      {loading ? (
        <p role="status">Loading connected devices…</p>
      ) : !sessions.length && !error ? (
        <p className="cli-empty">No connected devices yet. Your first login will appear here.</p>
      ) : null}
      {error && (
        <div className="cli-error" role="alert">
          <p>{error}</p>
          <button className="button button-secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      <div className="cli-device-list">
        {sessions.map((session) => {
          const failed = rowError?.id === session.id ? rowError.message : '';
          return (
            <article className="cli-device" key={session.id}>
              <Laptop size={20} aria-hidden="true" />
              <div className="cli-device-detail">
                <h3>
                  <bdi>{session.deviceName}</bdi>
                </h3>
                <p>Last used {formattedDate(session.lastUsedAt)}</p>
                <p>
                  Connected {formattedDate(session.createdAt)} · Expires{' '}
                  {formattedDate(session.expiresAt)}
                </p>
                {failed && (
                  <p className="cli-error" role="alert">
                    {failed}
                  </p>
                )}
              </div>
              {confirmId === session.id ? (
                <div className="cli-revoke-confirm">
                  <p>Sign this CLI out?</p>
                  <div className="cli-actions">
                    <button
                      className="button button-secondary"
                      id={`cli-confirm-${session.id}`}
                      disabled={!!revoking}
                      onClick={() => void revoke(session)}
                    >
                      {revoking === session.id
                        ? 'Revoking…'
                        : failed
                          ? 'Try again'
                          : 'Confirm revoke'}
                    </button>
                    <button
                      className="button button-secondary"
                      id={`cli-keep-${session.id}`}
                      disabled={!!revoking}
                      onClick={() => {
                        setConfirmId(undefined);
                        setRowError(undefined);
                        setFocusId(`cli-revoke-${session.id}`);
                      }}
                    >
                      Keep access
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="button button-secondary"
                  id={`cli-revoke-${session.id}`}
                  disabled={!!revoking}
                  onClick={() => {
                    setConfirmId(session.id);
                    setRowError(undefined);
                    setRevoked('');
                    setFocusId(`cli-keep-${session.id}`);
                  }}
                  aria-label={`Revoke access for ${session.deviceName}`}
                >
                  <X size={16} aria-hidden="true" />
                  Revoke
                </button>
              )}
            </article>
          );
        })}
      </div>
      {revoked && (
        <p className="cli-notice" id="cli-devices-notice" role="status" tabIndex={-1}>
          Access revoked for <bdi>{revoked}</bdi>.
        </p>
      )}
    </GuidePanel>
  );
}

/**
 * A guide section in the app's panel anatomy: a section-title row (step number or icon, then the
 * heading) above a padded body. Both connection guides build every step and aside card from it.
 */
export function GuidePanel({
  id,
  title,
  step,
  icon: Icon,
  className,
  children,
}: {
  id: string;
  title: string;
  step?: number;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel cli-panel${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="section-title">
        <div className="cli-panel-heading">
          {step !== undefined && (
            <span className="cli-step-number" aria-hidden="true">
              {step}
            </span>
          )}
          {Icon && <Icon className="cli-panel-icon" size={18} aria-hidden="true" />}
          <h2 id={id}>{title}</h2>
        </div>
      </div>
      <div className="cli-panel-body">{children}</div>
    </section>
  );
}

export function CliGuide({
  origin,
  signedIn,
  demo,
  request,
  onSignIn,
  signInAvailable = true,
  signInUnavailableReason,
  authorization,
}: {
  origin: string;
  signedIn: boolean;
  demo: boolean;
  request: CliRequest;
  onSignIn: () => void;
  signInAvailable?: boolean;
  signInUnavailableReason?: string;
  /**
   * The sign-in request card, shown under the page heading so h1 comes before its h2. Pass it only
   * while there is a request: in the demo it carries the demo notice in place of the guide's.
   */
  authorization?: ReactNode;
}) {
  const address = cliOrigin(origin);
  const local = address?.protocol === 'http:';
  const ledgerAddress = HOSTED_DEMO ? new URL(EXAMPLE_LEDGER_ORIGIN) : address;
  const copyCommand = (label: string, command: string) =>
    ledgerAddress && <CopyBlock label={label} value={cliCommand(ledgerAddress, command)} />;
  const installPath = local
    ? `./dist/downloads/${CLI_ARCHIVE}`
    : address &&
      shellAddress(`${address.origin}${import.meta.env.BASE_URL}downloads/${CLI_ARCHIVE}`);
  return (
    <div className="cli-guide">
      <header className="page-heading">
        <div>
          <h1>Your ledger, from the command line.</h1>
          <p>
            Create a complete agreement, check the standings, and keep your account connected. The
            same ledger rules apply everywhere.
          </p>
        </div>
      </header>
      {demo && !authorization && (
        <p className="connection-notice" role="status">
          {HOSTED_DEMO ? (
            <>
              To connect the CLI, <a href={SELF_HOSTING_URL}>set up your own ledger</a> and replace{' '}
              <code>{EXAMPLE_LEDGER_ORIGIN}</code> in the commands with its address.
            </>
          ) : (
            <>
              This demo cannot connect a CLI. Open your <a href="/">live ledger</a> and sign in to
              connect a real account.
            </>
          )}
        </p>
      )}
      {authorization}
      <div className="cli-guide-layout">
        <div className="cli-steps">
          <GuidePanel id="cli-install-title" step={1} title="Install Lobster CLI">
            <p>
              You’ll need{' '}
              <NewTabLink href="https://nodejs.org/en/download">Node.js 22 or newer</NewTabLink>,
              which includes npm.
            </p>
            {local && (
              <>
                <p>Build and install the CLI from the root of your source checkout.</p>
                <CopyBlock label="build CLI command" value="pnpm build:cli" />
              </>
            )}
            {installPath ? (
              <CopyBlock label="install command" value={`npm install -g ${installPath}`} />
            ) : (
              <p className="cli-note">{CLI_ORIGIN_GUIDANCE}</p>
            )}
            <p className="cli-note">
              Version 0.1.0 · macOS, Windows, and desktop Linux.
              {!local && ' No GitHub access is needed.'}
            </p>
          </GuidePanel>
          <GuidePanel id="cli-login-title" step={2} title="Connect your account">
            <p>
              Keep your terminal open. Sign in with Google in the browser window, check the device
              name, and choose <strong>Allow CLI access</strong>.
            </p>
            {copyCommand('login command', 'auth login')}
            {local && (
              <p className="cli-note">
                The local demo can build the CLI. To sign in, use the CLI page of your deployed
                HTTPS ledger with Google sign-in configured.
              </p>
            )}
            <p className="cli-note">
              The browser and terminal must be on the same computer. An existing ledger membership
              or invitation is required.
            </p>
            {copyCommand('status command', 'auth status')}
          </GuidePanel>
          <GuidePanel id="cli-create-title" step={3} title="Create your first bet">
            <p>
              The guided form covers both sides, the rolls at stake, how and when the result is
              decided, and any judge or ChatGPT prompt. It also handles existing bets and optional
              locations.
            </p>
            {copyCommand('create bet command', 'bets create')}
            <p>
              Review the full agreement before submitting. You’ll get a bet ID and a link to the
              website; the other bettor still needs to confirm.
            </p>
          </GuidePanel>
          <GuidePanel
            id="cli-reference-title"
            icon={Terminal}
            title="Make it part of your workflow"
            className="cli-reference"
          >
            <p>
              Start from a complete JSON template, fill in your agreement, and validate it before
              creating a bet.
            </p>
            <CopyBlock label="template command" value="lobster bets template > bet.json" />
            {copyCommand('validate bet command', 'bets create --file bet.json --dry-run')}
            {copyCommand('submit bet command', 'bets create --file bet.json --yes')}
            <p className="cli-note">
              <InlineCommand value="--yes" /> submits the file without an interactive review. Check
              every field first. Use <InlineCommand value="--json" /> for machine-readable output.
            </p>
            {copyCommand('list bets command', 'bets list --json')}
            {copyCommand('balances command', 'balances')}
            {copyCommand('leaderboard command', 'leaderboard')}
            <CopyBlock label="help command" value="lobster --help" />
          </GuidePanel>
        </div>
        <aside className="cli-guide-aside" aria-label="CLI access and maintenance">
          <GuidePanel id="cli-account-title" icon={ShieldCheck} title="Your account stays yours">
            <p>
              Credentials are kept in macOS Keychain, Windows Credential Manager, or Linux Secret
              Service. Linux needs an unlocked desktop credential store.
            </p>
            <p>
              The CLI renews access securely. It will ask you to sign in again when your session
              expires or is revoked.
            </p>
            <p>
              Approvals belong to each person. A CLI login cannot approve a bet on someone else’s
              behalf.
            </p>
          </GuidePanel>
          <GuidePanel id="cli-update-title" icon={RefreshCw} title="Update or uninstall">
            <p>For the current version, run the install command at the top of this page again.</p>
            <p>To disconnect this computer:</p>
            {copyCommand('logout command', 'auth logout')}
            <p>Then, if you want to remove the CLI:</p>
            <CopyBlock label="uninstall command" value="npm uninstall -g lobster-ledger-cli" />
          </GuidePanel>
          <GuidePanel id="cli-origin-title" icon={Globe} title="Using another ledger?">
            <p>Pass your instance’s HTTPS address when signing in:</p>
            <CopyBlock
              label="custom instance command"
              value="lobster --origin https://ledger.example.com auth login"
            />
            <p className="cli-note">
              Use <InlineCommand value="--origin" /> with later commands for that instance too.
            </p>
          </GuidePanel>
        </aside>
      </div>
      {signedIn && !demo ? (
        <CliSessions request={request} />
      ) : (
        <GuidePanel
          id="cli-devices-title"
          icon={Laptop}
          title="Connected command lines"
          className="cli-devices"
        >
          <p>
            {demo
              ? 'Connected devices appear here once you sign in on the live ledger. The demo does not create real CLI sessions.'
              : 'Sign in to review or revoke the computers connected to your account.'}
          </p>
          {!demo && (
            <div className="cli-actions">
              <button
                className={`button button-secondary${signInAvailable ? '' : ' cli-unavailable'}`}
                onClick={onSignIn}
                disabled={!signInAvailable}
                aria-describedby={signInAvailable ? undefined : 'cli-devices-sign-in-unavailable'}
              >
                Sign in with Google
              </button>
            </div>
          )}
          {!demo && !signInAvailable && (
            <SignInUnavailable
              id="cli-devices-sign-in-unavailable"
              reason={signInUnavailableReason}
            />
          )}
        </GuidePanel>
      )}
    </div>
  );
}
