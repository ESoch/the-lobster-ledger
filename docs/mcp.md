# Connect via MCP

Append `/mcp` to your ledger's configured HTTPS origin. For example, a ledger hosted at `https://ledger.example.com` uses this endpoint.

```text
https://ledger.example.com/mcp
```

The app’s **AI connections** navigation item opens the setup guide at `/#mcp`. The guide is also available from the welcome screen without signing in. It includes this instance’s URL, Claude connector steps, copyable Claude Code and Codex commands, read/write choices with a live summary of the access the checkbox grants, troubleshooting, and a link to manage app access. Local previews use a clearly labeled placeholder instead of presenting a development URL as a hosted endpoint.

## Claude and Codex

For Claude’s hosted connector, add a custom connector from **Customize → Connectors**, paste the remote URL and choose **Register automatically** for the OAuth client. Select **Connect**, sign in and review the requested permissions. Managed workspaces may need an owner to add it first. Enable the connector in the conversation. Claude’s connector is read-only: it requests the `ledger:read` scope advertised in the protected-resource metadata, so it can look up wagers, balances, standings and prices but cannot create or change records. The guide says so on the Claude path and points members who need writes to Claude Code or Codex. See [Claude’s official guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For Claude Code, the in-app guide generates an `add-json` command with `oauth.scopes` set to your selected permissions. Run `/mcp` inside Claude Code and authenticate the connection. To change permissions, run `claude mcp remove lobster-ledger --scope user` first; `add-json` refuses to replace an existing entry. See [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

For Codex CLI, add the server and request the desired scope during login:

```sh
codex mcp add lobster-ledger --url https://ledger.example.com/mcp
codex mcp login lobster-ledger --scopes ledger:read
```

For writes, use `--scopes ledger:read,ledger:write` instead and review the new browser consent. The configuration is shared with local Codex clients; a desktop or IDE MCP settings screen can also add and authenticate a Streamable HTTP server. See [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). These instructions are checked against official documentation; live client authorization must still be verified after deploying this change.

## Connect a client

1. Add the URL above to a client that supports remote MCP over Streamable HTTP and OAuth authorization-code flow with S256 PKCE.
2. Choose browser authorization. Clients can dynamically register public OAuth clients at the advertised registration endpoint; no client secret is required or accepted. For clients that require manual registration, POST `{"client_name":"Your client","redirect_uris":["https://your-client.example/callback"],"token_endpoint_auth_method":"none"}` as JSON to `/oauth/register` and use the returned `client_id`.
3. Sign in with your existing Google account. Membership is required; an MCP connection cannot create a ledger membership or bypass invitations.
4. Check the client name, callback address and requested permissions on the consent screen, then select **Allow access**. Client names are supplied by clients and are not verified identities.

The default scope is `ledger:read` when the authorization request omits scope. Clients may request a different supported set based on discovery; always review the consent screen. To enable writing, configure the client to request `ledger:read ledger:write` and authorize that scope in the browser. Clients with a read-only access token see only read tools. Refresh requests may include the same or a narrower scope, while the rotating refresh credential retains the original browser-approved grant. Expanding the grant requires a new browser authorization. The client must send `resource=<APP_ORIGIN>/mcp` in both authorization and token requests. Tokens are sent only as `Authorization: Bearer …` headers.

Registration returns the effective server policy: public-client authentication, authorization-code and refresh grants, and the supported scope catalog. Registration itself grants no member access. HTTPS and localhost callback addresses must match exactly; native HTTP loopback IP callbacks may change only their port during authorization, as required by RFC 8252. Code exchange must still use the exact redirect URI that received the code.

Google sign-in returns to the consent screen through a short-lived browser cookie. Google credentials and browser-session cookies are never passed to the MCP client. MCP credentials are independent of CLI credentials and work only on `/mcp`.

The consent screen, Connected apps and every sign-in error share one server-rendered template, `worker/render-shell.ts`: the app's colours in dark and light (it follows the device's colour scheme, dark by default), the lobster mark, and fluid padding down to 320px. The consent screen's return address wraps at its joints (after `/`, `?` and `&`, and before a `.label`), so the address a member is asked to check is not cut inside a name on a phone; only a name too long to fit a line by itself is split, and it never widens the page past the screen. Browser navigations (`Accept: text/html`) to `/oauth/authorize`, `/oauth/connections` or `/mcp` get a page rather than raw JSON: an expired or invalid connection request explains how to start again from the AI app, a signed-out visit to Connected apps goes through Google sign-in and returns there, and `/mcp` explains that the address belongs in an AI app while keeping its 401 status and `WWW-Authenticate` challenge, including when the link was followed from another site (the page does nothing, so a cross-site navigation or a `HEAD` check may read it). Protocol clients, which do not ask for HTML, keep the JSON errors. A browser always gets a page, even for an unexpected failure, with a generic message when the cause is not one the person can act on. Sign-in failures are headed by what went wrong, with the one action that can help: **Use a different Google account** for someone who is not a member, **Try signing in again** after a failed or cancelled sign-in, and only a way back where waiting or a new invitation is the cure. A Connected apps failure offers **Back to Connected apps** only when a fresh load can help (a stale form or an expired session), never during an outage.

## Available tools

A read grant lists seven tools and a write grant adds six. `worker/mcp-tool-catalog.ts` names them; the setup guide takes its counts from that file, and `worker/mcp.test.ts` checks it against `tools/list`.

| Tool                 | Scope | Purpose                                                                                                                       |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `get_ledger`         | Read  | Members, wagers, places, restaurants and complete price history                                                               |
| `get_lobster_prices` | Read  | Official Maine DMR annual boat-price history in USD/lb, source dates, and preliminary flags; optional `fromYear` and `toYear` |
| `list_bets`          | Read  | Search wager titles or filter by status                                                                                       |
| `get_bet`            | Read  | Exact bet ID or reference, audit history and browser link                                                                     |
| `get_balances`       | Read  | Signed-in member statistics and original confirmed debts                                                                      |
| `get_leaderboard`    | Read  | Standings as the website ranks them: `rank` (ties share one), `tied`, `decided`; no confirmed result: `rank: null`            |
| `list_prices`        | Read  | Restaurants and live price reports; `includeCorrected` and `includeWithdrawn` add the reports kept on record                  |
| `create_bet`         | Write | Create an agreement as the signed-in member                                                                                   |
| `act_on_bet`         | Write | A permitted action on a bet version: withdrawing one's own proposal, disputing readiness evidence, stepping down as judge     |
| `add_restaurant`     | Write | Register a restaurant, or return the one with the same name and address ignoring case and spacing                             |
| `record_price`       | Write | Record an actual price in USD cents with its reported date precision, optionally adding its restaurant in the same write      |
| `correct_price`      | Write | Correct one of the member's own live price reports once, with an optional reason; the original stays on record                |
| `withdraw_price`     | Write | Withdraw one of the member's own live price reports with a reason; it stays on record. Marked destructive                     |

Review proposed writes in your MCP client before approving them. Wagers, historical confirmations, judgments and physical-delivery confirmations follow the same rules as the website. Each member acts only as themselves. A client cannot supply someone else's consent, and displayed net balances never settle debts automatically. Either bettor can explicitly offset confirmed mutual debts on the website’s Balances page, without a second approval; third-party debts cannot participate. The server does not request or invent ChatGPT adjudication responses.

For `create_bet`, choose a unique `requestKey` of 16–128 letters, numbers, underscores or hyphens. Reuse it with identical input after an uncertain response; the existing durable creation receipt prevents duplicates. For wager actions, fetch the current version and submit it with the action. A conflict requires rereading the wager and reviewing the change again. A price report is safe to resend, even while the first copy is still being written: repeating a report the member already made for the same visit (restaurant, item, date and precision) at the same price, including either of two purchases already confirmed as separate, returns that report with `duplicateOf` and writes nothing. The same visit at a different price is refused with the existing report's id, so the client can offer `correct_price` instead; send `confirmSeparateReport: true` only when the member confirms it was a separate purchase. A `correct_price` that lands on a visit the member already reported follows the same rule: a copy at the same price is refused, and a different price needs `confirmSeparateReport: true` when the correction moves the report onto that visit. A price outside the $8 to $90 a roll usually costs, or about ten times or a tenth of the last live report of the same roll at that restaurant, is refused with `warnings` (each with a message and often a `suggestedCents`), the same question the website asks with HTTP 422; ask the member, and send `confirmUnusualPrice: true` only when they confirm the price. `correct_price` takes the report `id` and the whole corrected report as `correction`, with an optional `correctionReason`; it follows the website's rules: only the member's own report, only once, never a withdrawn one. `withdraw_price` takes the report `id` and the member's `reason` (1 to 500 characters); it is also once only, refused for a report a correction already replaced (withdraw the correction instead), and cannot be undone, so it is marked destructive. A withdrawn report keeps its `withdrawnAt` and `withdrawnReason` and leaves every price figure; `list_prices` leaves out withdrawn and superseded reports unless asked. Each report's `entrySource` is stamped by the server: `mcp` for prices recorded or corrected through these tools, `web` otherwise, including every report made before sources were recorded. A visit date must be a real calendar date, not in the future and not before 1900. `record_price` can name a new restaurant inline (`restaurant: {name, address}`) instead of a `restaurantId`, and both are written together; a name and address already on the record, ignoring case and spacing, reuse that restaurant.

The endpoint is designed for clients that make MCP requests from their own backend or native process. Script and form requests from a browser to `/mcp` must use the ledger's own origin; only a plain visit to the address, which shows the explanatory page, is let through from other sites. Public OAuth registration, token and revocation endpoints support cross-origin requests without browser credentials.

## Manage access

Use **AI connections → Manage connected apps**, or open `/oauth/connections` on your ledger, to inspect grants and revoke an app. A signed-out browser returns to Connected apps after Google sign-in. Revocation invalidates both access and refresh credentials immediately. Authorized apps keep their own grants when you sign out of the website.

Access tokens expire after 15 minutes. Refresh credentials rotate on use, expire after 30 days of inactivity and have a maximum session lifetime of 90 days. Reuse of a spent refresh credential revokes the entire token family. Clients should serialize refresh attempts and store credentials securely.

## Deploy and verify

Follow the [self-hosting guide](deployment.md) to configure and deploy the Worker. The standard D1 migrations add the MCP client, consent, authorization-code, session, and refresh-token tables. MCP uses the same Google OAuth configuration and rate limiter as the browser sign-in. The Worker handles `/mcp`, `/oauth/*`, and `/.well-known/*` before static assets.

```sh
pnpm check
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

`worker/mcp.test.ts` exercises real D1-backed browser consent, discovery, PKCE, credential isolation, refresh rotation and replay, revocation, MCP negotiation and tools, actor permissions, independent agreement confirmation, optimistic concurrency and idempotent wager creation. A dry-run does not deploy or mutate the remote database.

After deployment, verify the discovery document at `/.well-known/oauth-protected-resource/mcp`, then connect a real MCP client. An unauthenticated `/mcp` request should return HTTP 401 with a `WWW-Authenticate` discovery challenge; opened in a browser, the same response carries a short explanatory page. Exercise both read-only and write grants, and revoke a test connection from Connected apps.

Implementation references: [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [official TypeScript SDK for web-standard runtimes](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard).
