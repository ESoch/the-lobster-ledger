# Local development

## Browser demo

Use Node.js 24.21.0 (see [`.node-version`](../.node-version)) and pnpm 10.30.3 (see [`package.json`](../package.json)).

From the repository root, install the locked dependencies and start Vite.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/?demo=1>. Use the demo member selector to approve or respond to a wager as the other bettor. Add a `demoSession` query parameter, such as `&demoSession=testing`, to give a test run its own browser storage. Close other tabs showing the same session before using **Reset demo** from the avatar menu.

## Worker and D1

To serve the built site through the local Worker, run these commands from the repository root.

```sh
pnpm build
pnpm db:local
pnpm dev:api
```

Open the address Wrangler prints and append `/?demo=1` to try the demo through the Worker. Wrangler keeps local D1 data separate from any hosted database. The default local configuration reports `configured: false` at `/api/config`; shared ledger requests return HTTP 503 because sign-in is unconfigured. For a shared ledger with Google sign-in, follow the [self-hosting guide](deployment.md) and use an HTTPS origin.

## Checks

```sh
pnpm test
pnpm check
pnpm build
pnpm test:cli-install
pnpm exec wrangler deploy --dry-run
```

The build includes the web app and the CLI package. The CLI install check verifies the archive checksum and tests installation in an isolated temporary directory. Wrangler’s dry run bundles the Worker and assets without deploying them.
