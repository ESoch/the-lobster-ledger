import { useState } from 'react';
import { AppWindow, ArrowRight, LifeBuoy, ShieldCheck } from 'lucide-react';
import { CopyBlock, InlineCommand } from './CopyBlock';
import { GuidePanel, NewTabLink, SignInUnavailable } from './CliAccess';
import { READ_TOOL_COUNT, WRITE_TOOL_COUNT } from '../../worker/mcp-tool-catalog';
import './cli.css';
import './mcp.css';

export function McpGuide({
  origin,
  signedIn,
  demo,
  onSignIn,
  signInAvailable = true,
  signInUnavailableReason,
}: {
  origin: string;
  signedIn: boolean;
  demo: boolean;
  onSignIn: () => void;
  signInAvailable?: boolean;
  signInUnavailableReason?: string;
}) {
  const [client, setClient] = useState<'claude' | 'claude-code' | 'codex'>('claude');
  const [write, setWrite] = useState(false);
  const https = new URL(origin).protocol === 'https:';
  const base = https ? new URL(origin).origin : 'https://your-ledger.example';
  const endpoint = `${base}/mcp`;
  const scope = write ? 'ledger:read ledger:write' : 'ledger:read';
  const claudeConfig = JSON.stringify({ type: 'http', url: endpoint, oauth: { scopes: scope } });
  const claudeCommand = `claude mcp add-json lobster-ledger '${claudeConfig}' --scope user`;
  return (
    <div className="cli-guide mcp-guide">
      <header className="page-heading">
        <div>
          <h1>Your ledger, connected to AI.</h1>
          <p>
            Connect Claude or Codex to your wagers and lobster-roll price registry, signed in with
            your ledger account. Claude’s connector reads the ledger; Claude Code and Codex can also
            be allowed to create and update records. Official annual lobster prices per pound are
            available with read access.
          </p>
        </div>
      </header>
      {demo && (
        <p className="connection-notice" role="status">
          This demo cannot connect an AI app. Open your <a href="/">live ledger</a> to authorize a
          real account.
        </p>
      )}
      {!https && (
        <p className="connection-notice" role="status">
          You’re viewing a local preview. Open your deployed ledger’s HTTPS address for a connection
          URL that Claude and Codex can reach. The examples below use a placeholder.
        </p>
      )}
      <div className="cli-guide-layout">
        <div className="cli-steps">
          <GuidePanel id="mcp-address-title" step={1} title="Use this server address">
            <p>
              Choose a remote server using Streamable HTTP and browser OAuth. You do not need to
              install Lobster CLI or supply an API key.
            </p>
            <CopyBlock value={endpoint} label="MCP server URL" />
            <p className="cli-note">
              Connect as a public OAuth client. Leave client secret and fixed authorization headers
              empty. Claude and Codex can register their client automatically.
            </p>
          </GuidePanel>
          <GuidePanel id="mcp-client-title" step={2} title="Choose your app">
            <fieldset className="mcp-client-picker">
              <legend className="sr-only">MCP client</legend>
              {(
                [
                  ['claude', 'Claude'],
                  ['claude-code', 'Claude Code'],
                  ['codex', 'Codex'],
                ] as const
              ).map(([id, label]) => (
                <label key={id} className={client === id ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="mcp-client"
                    value={id}
                    checked={client === id}
                    onChange={() => setClient(id)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {client !== 'claude' && (
              <>
                <label className="mcp-write-choice">
                  <input
                    type="checkbox"
                    checked={write}
                    onChange={(event) => setWrite(event.target.checked)}
                  />{' '}
                  Include tools that create or update records
                </label>
                <p className="mcp-access-state" role="status">
                  {write ? (
                    <>
                      <strong>Read and write.</strong> The setup below also asks for{' '}
                      <InlineCommand value="ledger:write" />, which adds {WRITE_TOOL_COUNT} tools to
                      create bets, act on wagers, add restaurants, record prices and correct or
                      withdraw your own price reports.
                    </>
                  ) : (
                    <>
                      <strong>Read only.</strong> The setup below asks for{' '}
                      <InlineCommand value="ledger:read" />: your AI app can look things up but not
                      change anything.
                    </>
                  )}
                </p>
              </>
            )}
            {client === 'claude' ? (
              <div className="mcp-client-steps">
                <ol className="mcp-instructions">
                  <li>
                    In Claude, open <strong>Customize → Connectors</strong> and add a custom
                    connector named <strong>Lobster Ledger</strong>.
                  </li>
                  <li>
                    Paste the server URL above. Choose <strong>Sign in now</strong> and{' '}
                    <strong>Register automatically</strong> for the OAuth client when those choices
                    appear.
                  </li>
                  <li>
                    Finish adding the connector and select <strong>Connect</strong>. Sign in with
                    Google and review the permissions on this ledger’s consent screen.
                  </li>
                  <li>
                    Enable the connector for your conversation from the <strong>+</strong> menu,
                    then <strong>Connectors</strong>.
                  </li>
                </ol>
                <p className="mcp-access-note">
                  <strong>Claude’s connector is read-only.</strong> It can look up wagers, balances,
                  standings and prices, but it cannot create or change anything. To make bets or
                  record prices from an AI app, use Claude Code or Codex with write access.
                </p>
                <p className="cli-note">
                  For a managed Claude workspace, an owner may need to add the connector in
                  Organization settings first. This server uses automatic registration; choose that
                  option rather than Claude’s published client identity.
                </p>
                <p>
                  <NewTabLink
                    standalone
                    href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
                  >
                    Claude’s connector guide
                  </NewTabLink>
                </p>
              </div>
            ) : client === 'claude-code' ? (
              <div className="mcp-client-steps">
                <p>
                  Run this in your terminal. It adds the connection to your personal Claude Code
                  configuration.
                </p>
                <CopyBlock value={claudeCommand} label="Claude Code setup command" />
                <p>
                  Open Claude Code, run <InlineCommand value="/mcp" />, select{' '}
                  <strong>lobster-ledger</strong> and authenticate in your browser.
                </p>
                <p className="cli-note">
                  To change permissions later, remove the connection with{' '}
                  <InlineCommand value="claude mcp remove lobster-ledger --scope user" />, add it
                  again with the new choice above, and authenticate again.
                </p>
                <p>
                  <NewTabLink standalone href="https://code.claude.com/docs/en/mcp">
                    Claude Code MCP documentation
                  </NewTabLink>
                </p>
              </div>
            ) : (
              <div className="mcp-client-steps">
                <p>Add the server using Codex CLI, then start browser authorization:</p>
                <CopyBlock
                  value={`codex mcp add lobster-ledger --url ${endpoint}`}
                  label="Codex add command"
                />
                <CopyBlock
                  value={`codex mcp login lobster-ledger --scopes ${scope.split(' ').join(',')}`}
                  label="Codex login command"
                />
                <p>
                  Complete the Google sign-in and consent screen, then open or restart your Codex
                  session. Use <InlineCommand value="/mcp" /> to check the connection.
                </p>
                <p className="cli-note">
                  In a desktop or IDE MCP settings screen, use Add server, choose Streamable HTTP,
                  paste the URL, save and authenticate. The CLI configuration is shared with local
                  Codex clients. To change access, run the login command again with your new scope
                  choice.
                </p>
                <p>
                  <NewTabLink
                    standalone
                    href="https://learn.chatgpt.com/docs/extend/mcp?surface=cli"
                  >
                    Official OpenAI MCP documentation
                  </NewTabLink>
                </p>
              </div>
            )}
          </GuidePanel>
          <GuidePanel id="mcp-review-title" step={3} title="Review access and try it">
            <p>
              Check your signed-in name, the requesting client and its return address, then choose{' '}
              <strong>Allow access</strong>. Existing ledger membership is required.
            </p>
            <p>
              Start with: <q>Show my outstanding lobster rolls and the latest reported prices.</q>
            </p>
            <p>
              Read access includes {READ_TOOL_COUNT} tools; write access adds {WRITE_TOOL_COUNT}{' '}
              more, so your app can also create bets, take permitted wager actions, add restaurants,
              record prices and correct or withdraw your own price reports. Review each proposed
              change in your AI app.
            </p>
          </GuidePanel>
          <GuidePanel
            id="mcp-help-title"
            icon={LifeBuoy}
            title="Having trouble connecting?"
            className="mcp-troubleshooting"
          >
            <details>
              <summary>The server asks for authentication</summary>
              <p>
                Opening the MCP URL in a browser shows a page saying the address is for your AI app;
                nothing is wrong. Connect from Claude or Codex and complete its browser sign-in
                flow.
              </p>
            </details>
            <details>
              <summary>Only read tools appear</summary>
              <p>
                Your grant is read-only. Claude’s connector is read-only on this ledger, so use
                Claude Code or Codex for changes. In Claude Code, remove the connection with{' '}
                <InlineCommand value="claude mcp remove lobster-ledger --scope user" />, select the
                write option above, run the new setup command and authenticate again from{' '}
                <InlineCommand value="/mcp" />. In Codex, select the write option and run the{' '}
                <InlineCommand value="codex mcp login" /> command again. Other clients must request{' '}
                <InlineCommand value="ledger:read ledger:write" />. A normal token refresh cannot
                add permissions.
              </p>
            </details>
            <details>
              <summary>Sign-in expired or access was revoked</summary>
              <p>
                Reconnect and sign in again. If the consent page expires, start a fresh connection
                from your AI app. Both cookies and an existing ledger membership are needed for
                browser authorization.
              </p>
            </details>
            <details>
              <summary>The connector cannot reach the server</summary>
              <p>
                Use your deployed HTTPS URL, including <InlineCommand value="/mcp" />. Claude’s
                hosted connector must reach it over the public internet. A local preview or an
                instance awaiting deployment will not work. Check whether your organization allows
                custom MCP servers.
              </p>
            </details>
            <details>
              <summary>A client asks for an OAuth client ID</summary>
              <p>
                Use automatic registration if available. This server advertises{' '}
                <InlineCommand value="/oauth/register" /> for clients that need to register
                themselves. A manually registered public client uses its exact callback address and
                no client secret.
              </p>
            </details>
          </GuidePanel>
        </div>
        <aside className="cli-guide-aside" aria-label="MCP permissions and account access">
          <GuidePanel id="mcp-access-title" icon={ShieldCheck} title="Choose the access you grant">
            <p>
              <strong>Read:</strong> members, wagers, original debts, standings, restaurants and
              price history.
            </p>
            <p>
              <strong>Write:</strong> create agreements and act with your own account’s permissions,
              add restaurants, and record, correct or withdraw your own price reports. Each other
              member still confirms their own agreements, results and deliveries.
            </p>
            <p>
              Write access is available in Claude Code and Codex. Claude’s connector is read-only.
            </p>
            <p>
              Google credentials stay with the ledger. Access expires and renews through the client;
              signing out here does not disconnect an authorized app.
            </p>
          </GuidePanel>
          <GuidePanel id="mcp-apps-title" icon={AppWindow} title="Connected apps">
            <p>
              Review your authorized apps and revoke any connection. Revocation stops its access and
              ability to renew immediately.
            </p>
            {!https ? (
              <p>Open your deployed HTTPS ledger to manage connected apps.</p>
            ) : demo ? (
              <p>
                Manage real connections on your live ledger. Demo members cannot authorize apps.
              </p>
            ) : signedIn && signInAvailable ? (
              <a className="button button-secondary mcp-manage-link" href="/oauth/connections">
                Manage connected apps <ArrowRight size={15} aria-hidden="true" />
              </a>
            ) : (
              <>
                <button
                  className={`button button-secondary${signInAvailable ? '' : ' cli-unavailable'}`}
                  type="button"
                  onClick={onSignIn}
                  disabled={!signInAvailable}
                  aria-describedby={signInAvailable ? undefined : 'mcp-sign-in-unavailable'}
                >
                  Sign in to manage apps
                </button>
                {!signInAvailable && (
                  <SignInUnavailable
                    id="mcp-sign-in-unavailable"
                    reason={signInUnavailableReason}
                  />
                )}
              </>
            )}
          </GuidePanel>
        </aside>
      </div>
    </div>
  );
}
