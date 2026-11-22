# Releasing Lobster Ledger

## Prepare the release

1. Choose the version and update `package.json`, `scripts/cli-package.mjs`, the CLI help and version command, and their tests or examples together.
2. From a clean checkout of the release commit, install with `pnpm install --frozen-lockfile`, then run `pnpm check` and `pnpm test`. Build the portable release with `APP_ORIGIN= pnpm build` in a POSIX shell, then run `pnpm test:cli-install`. A release CLI built without `APP_ORIGIN` lets users choose their ledger with `--origin` or `LOBSTER_ORIGIN`. A deployment build uses `APP_ORIGIN` for its own download.
3. Open the local demo and smoke-test the release with fictional data. Check that the site output contains `LICENSE.txt`, `THIRD_PARTY_LICENSES.md`, and `THIRD_PARTY_NOTICES.md`. The CLI install check verifies its MIT license and bundled Zod notice.
4. Check for an open issue labeled `market-refresh` in the repository before writing the release notes. When automatic refresh is blocked by the Maine DMR source, the app continues serving the dated snapshot in `src/data/lobster-market.json`. State its date and the known refresh limitation in the notes if the issue is open. Follow the [manual refresh instructions](lobster-market.md#refreshing-a-snapshot-locally) when a new snapshot is available.
5. Draft short release notes with changes, any migration or self-hosting steps, and the relevant known issues.

## Verify and publish the release assets

The build writes a versioned CLI tarball and SHA-256 checksum under `dist/downloads/`. Attach both from the same verified build. Verify the checksum before publishing and after downloading the draft assets. Set `version` to the release version:

```sh
version=0.1.0
cd dist/downloads
shasum -a 256 -c "lobster-ledger-cli-${version}.tgz.sha256"
```

When you are ready to publish, tag the verified default-branch commit as `v<version>` and create a draft GitHub release for that tag. Upload both assets and check the notes and download links before publishing. If immutable releases are enabled, attach the assets while the release is still a draft. Build provenance is an optional additional step when the tarball is built in a trusted tag workflow. [GitHub release workflow](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
