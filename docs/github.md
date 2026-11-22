# GitHub and deployment automation

## Release flow

The **Check** job installs the frozen pnpm lockfile, runs the application and market importer tests, checks types, builds the site and CLI, tests installation of the CLI archive, and packages the Worker with a dry run. It runs without Cloudflare credentials.

When enabled, **Deploy production** runs only for passing commits on `main`. It rebuilds the commit, generates the production configuration, applies pending D1 migrations, and deploys the Worker and assets. Deployments run one at a time and skip commits that are no longer at the head of `main`.

Post-deploy checks load the public site and its JavaScript, verify the CLI archive checksum and build manifest, check that sign-in is configured, and confirm that anonymous requests cannot read the ledger. Use the [deployment verification checklist](verification.md) for authenticated testing. To redeploy `main`, choose **Actions → Check and deploy → Run workflow** and select `main`.

## Deployment configuration

Complete the manual [self-hosting steps](deployment.md) before enabling automation. The Worker’s `GOOGLE_CLIENT_SECRET` stays in Cloudflare.

1. Create a GitHub environment named `production` with a deployment branch policy allowing only `main`.
2. Add the environment variables and secrets in the [configuration reference](deployment-configuration.md). The deploy job reads `CLOUDFLARE_API_TOKEN` and `OWNER_EMAIL` as environment secrets.
3. Give the Cloudflare deployment token **Workers Scripts Write**, **Account Settings Read**, and **D1 Edit** in the account hosting the ledger. D1 Edit allows the migration step. Set a rollover date for the token.
4. Set the repository variable `ENABLE_PRODUCTION_DEPLOY` to `true` to enable deployment in your repository. Review pending migrations and the configured account before merging.

Require pull requests and successful **Check** results on `main` where your repository settings support it.

## Lobster market refresh

Set the repository variable `ENABLE_MARKET_REFRESH` to `true` to enable the refresh workflow in your repository. Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** if you want it to open update pull requests. Individual workflow jobs request the required write permissions.

**Refresh lobster market data** runs weekly or by manual dispatch. It validates the upstream PDF and publishes a data pull request when the numeric series changes. The source URL and checksum are kept with the committed numeric JSON. Deployments build from that JSON snapshot.

The workflow runs the pull request checks before pushing the update branch and records the result as the `market-refresh/checks` commit status. GitHub prevents most events created by `GITHUB_TOKEN` from starting additional workflows. Review the status and compare changed years with the upstream source. Merging the update by hand starts the usual main workflow. See the [market data guide](lobster-market.md#refreshing-a-snapshot-locally) for a manual import when the source blocks automated requests.

## Database changes and recovery

Migrations run before the new Worker is published. Keep them compatible with the running code. A migration failure stops publication. For code recovery, prefer a revert pull request to keep `main` and the deployment aligned. An urgent Cloudflare Worker rollback leaves D1 data and applied migrations as they are. See [Cloudflare’s rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
