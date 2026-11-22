# Deployment verification

Run the [local checks](development.md#checks) before release. Backend tests exercise the real HTTP handlers and SQL triggers with isolated D1 databases and synthetic Google signing keys.

## Check the deployed origin

1. Open the public landing page and the demo in a fresh browser. Verify that the demo loads its fictional records and that refreshing preserves a demo change. Return to the landing page for the shared instance.
2. Open `/api/config` and confirm `configured` is true. From a signed-out browser, confirm `/api/ledger` returns HTTP 401.
3. Sign in with the configured owner account. Create an invitation in **Members**, open it in a separate browser session, and redeem it with a different Google account. Open the already redeemed link again and confirm it cannot admit a second member.
4. On a staging ledger, create a clearly labeled test wager. Confirm that only the other bettor can accept it, both must confirm the result before a debt appears, and both must confirm delivery before that debt drops. Reload both sessions and check the audit history.
5. If you use connected clients, follow the [CLI](cli.md) or [MCP](mcp.md#deploy-and-verify) verification steps. Revoke the test credentials afterwards.

## Diagnose sign-in

Record the browser, approximate time, and hostname of the failing page. A Google-hosted error indicates a different stage of sign-in than a branded ledger callback error. In Workers Logs, filter `event = auth_request_completed`. A successful start and callback each return HTTP 302. A callback can return 400 for a rejected or cancelled attempt, 401 for an identity verification failure, or 403 for denied access. A 429 or 503 can indicate rate limiting or missing configuration.

Use the visible error message and the status to narrow the failure. Start each retry from the ledger origin and finish it in the same browser. Keep invitation links, cookies, complete OAuth URLs, and provider responses out of issue reports.
