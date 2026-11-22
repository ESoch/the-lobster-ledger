# Self-hosting The Lobster Ledger

One deployment serves one private group. The operator signs in first with a configured Gmail or Google Workspace account, then invites other members. Follow the [local development guide](development.md) to try the browser demo without setting up a group.

## 1. Choose an origin and create a database

Install the dependencies as described in [local development](development.md). Choose your Worker name and an HTTPS origin for it, such as `https://ledger.example.com`. For a custom domain, choose a hostname in an active Cloudflare zone you control. You will attach it to the Worker in step 4. You can also use the final `workers.dev` hostname.

Sign in to Cloudflare, confirm the target account, and create a D1 database for this ledger. Decline any prompt to update the checked-in local configuration.

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create lobster-ledger
```

Keep the returned database UUID for the next steps. Use a separate Worker, database, origin, and OAuth client for a staging deployment.

## 2. Set up Google sign-in

1. Configure your Google Auth Platform branding, audience, and consent screen.
2. Create an OAuth client of type **Web application** for the basic `openid`, `email`, and `profile` scopes. An External audience allows members from outside your Workspace. See [Google’s audience and basic sign-in requirements](https://support.google.com/cloud/answer/15549945?hl=en).
3. Register your exact origin followed by `/auth/callback` as an authorized redirect URI. For the example above, use `https://ledger.example.com/auth/callback`.
4. Use the resulting client ID as `GOOGLE_CLIENT_ID` and keep the client secret for the interactive Wrangler prompt. Set `OWNER_EMAIL` to the Gmail or Google Workspace account that will bootstrap the group.

Shared mode uses secure cookies and requires HTTPS. A Google account with a third-party email address can join through an invitation after the group exists. The Worker keys members by Google’s stable subject identifier and uses email to authorize the initial owner. See [Google’s guidance on authoritative email addresses](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## 3. Generate and preview the Worker configuration

Set the deployment inputs in your shell using the [configuration reference](deployment-configuration.md). `APP_ORIGIN` must be the exact HTTPS origin without a trailing slash. Use the D1 UUID from step 1 and a positive integer rate-limit namespace dedicated to this ledger. The generator writes the owner email and deployment identifiers into the ignored `wrangler.production.json`. Keep the Google client secret separate.

```sh
node scripts/production-config.mjs
pnpm build
pnpm exec wrangler deploy --config wrangler.production.json --dry-run
```

Review the target account, Worker name, origin, and database before continuing. The local `wrangler.jsonc` stays available for `pnpm db:local` and `pnpm dev:api`.

## 4. Set the secret, migrate, and deploy

Set the required Google client secret before the first application deployment. Supply the value at Wrangler's prompt. If the Worker is new, Wrangler asks to create it and add the secret. Confirm only after checking the Worker name and account. You can also create an empty Worker of the same name in the dashboard and add the secret there. See [Cloudflare's Worker secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/#secrets-on-deployed-workers).

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.json
```

If you chose a custom domain, the Worker now exists. Open its **Settings → Domains & Routes → Add → Custom Domain** in Cloudflare and enter the hostname from step 1. Allow time for the certificate to become active before testing sign-in. [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

Apply the D1 migrations and publish the application to that Worker.

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.production.json
pnpm exec wrangler deploy --config wrangler.production.json
```

For later releases, `pnpm run deploy` regenerates the deployment configuration from the current shell inputs, builds, migrates, and deploys. To automate releases, see [GitHub and deployment automation](github.md). Keep migrations compatible with the currently running Worker because they are applied before deployment.

## 5. Verify the live deployment

Use the [deployment verification checklist](verification.md) to check anonymous access, owner sign-in, and the invite and approval flow. A dry run verifies local packaging. The deployed origin and Google OAuth settings need their own checks.

## Operator notes

- The Worker uses authorization codes, PKCE S256, state, and a nonce for Google sign-in. It validates ID tokens and stores neither Google access tokens nor Google refresh tokens.
- The OAuth start and callback share a Cloudflare rate limit of 60 requests per client network per minute. Coworkers on one network share that budget. Preserve Cloudflare’s `CF-Connecting-IP` header and use a dedicated namespace for each deployment. See [Cloudflare’s rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- The Worker handles `/api/*`, `/auth/*`, `/mcp`, `/oauth/*`, and `/.well-known/*` before static assets. Vite copies `public/_headers` to the asset build. Worker responses set their own headers. See [Cloudflare’s static response headers](https://developers.cloudflare.com/workers/static-assets/headers/).
- Invite links are single-use and expire. Share each link with its intended recipient. The app can open the device’s messaging composer; no server sends texts or emails.
- The map uses OpenStreetMap tiles. Review the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) before operating at significant traffic.
