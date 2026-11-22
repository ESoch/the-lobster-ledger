# Private deployment configuration

The checked-in `wrangler.jsonc` configures local development and CI packaging. Production uses a generated `wrangler.production.json` in the repository root. It contains the deployment owner's email and environment-specific identifiers. Git ignores this file.

## Existing deployment

Before merging the configuration change, copy the existing Worker settings into the GitHub **production** environment under **Settings → Environments → production**. Keep the same Cloudflare account, Worker name, D1 UUID, OAuth client, origin, owner, and rate-limit namespace. The Cloudflare dashboard shows the Worker bindings and variables. Keeping the same D1 UUID preserves the ledger and its migration history.

| GitHub production setting                            | Source                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Variable `APP_ORIGIN`                                | Public HTTPS origin without a trailing slash or path. It must match the Google OAuth redirect origin.                                        |
| Variable `CLOUDFLARE_ACCOUNT_ID`                     | Cloudflare account containing the Worker and D1 database.                                                                                    |
| Variable `D1_DATABASE_ID`                            | UUID of the intended D1 database. Verify it in the account's D1 dashboard.                                                                   |
| Variable `GOOGLE_CLIENT_ID`                          | Google OAuth web client ID for this deployment.                                                                                              |
| Variable `RATE_LIMIT_NAMESPACE_ID`                   | Positive integer dedicated to this application's rate limiter within the Cloudflare account. Reuse the current value for an existing Worker. |
| Secret `OWNER_EMAIL`                                 | Verified Google email address of the person who should gain owner access.                                                                    |
| Secret `CLOUDFLARE_API_TOKEN`                        | Existing deploy token scoped to the account, with Worker deployment and D1 migration access.                                                 |
| Optional variables `WORKER_NAME`, `D1_DATABASE_NAME` | Both default to `lobster-ledger`. Set each to the actual resource name if different.                                                         |

The Worker secret `GOOGLE_CLIENT_SECRET` lives in Cloudflare. Preserve it on the existing Worker. A fresh deployment needs its own Google web client, correct callback URL, and corresponding Worker secret. The generated file contains only the _name_ of that required secret.

## Generate a configuration locally

From the repository root, supply the table's variables and `OWNER_EMAIL` to the process using your shell or secret manager. Then run:

```sh
node scripts/production-config.mjs
pnpm build
pnpm exec wrangler deploy --dry-run --config wrangler.production.json
```

The generator checks required values before writing the file. Fix any errors and rerun it before using the production configuration. The dry run checks packaging locally. Use the same `--config wrangler.production.json` option on any intended production Wrangler command, including Worker secret setup, D1 migrations and deployment. Do not put either private setting values or the generated file in a pull request or public log.

## GitHub Actions

The **Check** job runs independently of deployment settings. To enable deployments, configure its **production** environment, then set the **repository** Actions variable `ENABLE_PRODUCTION_DEPLOY` to `true`. A successful check on a push or manual dispatch to `main` can then deploy. The workflow validates deployment settings before applying remote migrations, deploys the tested build and verifies the configured origin. Configure any required environment approvals before opting in.

To enable weekly or manually dispatched market refreshes, set the separate repository Actions variable `ENABLE_MARKET_REFRESH` to `true` and allow GitHub Actions to create pull requests in the repository settings.
