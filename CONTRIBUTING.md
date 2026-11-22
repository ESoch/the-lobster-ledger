# Contributing

For bugs, open an issue with the steps to reproduce, what you expected, and what happened. Use fictional members, wagers, and locations. For security reports, follow the [security policy](SECURITY.md).

Follow the [local setup](README.md) and start with the demo. Keep each pull request focused and note any change to authentication, migrations, or the CLI/MCP interfaces.

From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm test:cli-install
```

For market importer changes, also run its Python tests as described in the [market data guide](docs/lobster-market.md#refreshing-a-snapshot-locally).
