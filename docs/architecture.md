# Architecture

The Lobster Ledger is a React and TypeScript app with a Cloudflare Worker API and a D1 database. The same frontend supports a browser-only demo and a shared ledger for invited members.

| Path                      | Responsibility                                                                |
| ------------------------- | ----------------------------------------------------------------------------- |
| `src/components/`         | Wager forms, ledger and balances views, audit history, and maps               |
| `src/lib/ledger.ts`       | Wager transitions and balance and statistics calculations                     |
| `src/lib/client-state.ts` | Browser state synchronization, version handling, and demo persistence         |
| `worker/`                 | Google OAuth, sessions, invitations, authorization, API routes, and D1 access |
| `migrations/`             | Database schema and audit protections                                         |
| `cli/`                    | Command-line access to the shared ledger                                      |

## Demo and shared ledgers

The `?demo=1` route uses fictional sample data. The member selector changes which participant you act as in the demo. The browser stores demo changes locally, and `demoSession` lets you use distinct saved demo sessions in the same browser.

For a shared ledger, the operator configures a Google account as the initial owner. Additional members join using single-use invitations. The Worker gets the actor from the authenticated session, supplies mutation timestamps, and validates the requested transition against the submitted record version. D1 stores the new state and its audit event in one transaction.

New and historical wagers record their entry source on the server. Browser, CLI, and MCP actions preserve that source when updating the record. The two bettors approve the terms, confirm the result, and confirm delivery as separate actions. The [wager workflow design](design.md) describes the full set of transitions.

## Connected clients

The [CLI](cli.md) uses a browser approval flow and stores its credential in the operating-system credential store. [MCP](mcp.md) clients connect to the Worker at `/mcp` and receive the scopes approved by a member in the browser. A member can review and revoke MCP access in the app.

The market price series is bundled at build time from `src/data/lobster-market.json`. The [market data guide](lobster-market.md) covers source provenance and refreshes. Invitations can open a device’s messaging composer. The app sends no automatic texts or emails.
