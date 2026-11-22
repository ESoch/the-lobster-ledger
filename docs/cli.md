# Lobster Ledger CLI

The CLI is another interface to the same ledger. It signs in as an individual member, uses the same validation and approval rules as the website, and keeps each lobster-roll obligation between its original two people.

## Install and sign in

Use your ledger's **CLI** page (`/#cli`) for the installation command matching its deployed version and origin. The application serves a versioned npm-compatible archive. Use Node.js 22 or newer.

```sh
export LOBSTER_ORIGIN=https://ledger.example.com
lobster auth login
lobster auth status
lobster bets list
```

A CLI downloaded from a configured deployment defaults to that ledger. A source build made without `APP_ORIGIN` asks you to choose one. Replace the example origin with your ledger's origin before signing in. You can also select it per command with `--origin`. Development builds put the installation archive under `dist/downloads/`.

Sign-in opens your system browser. Review the requested CLI access on the website and approve it as your own ledger member. A short-lived, one-time authorization code returns to the CLI's loopback listener, which answers the browser with a short themed confirmation page. The CLI validates the request state and redeems the code with PKCE. Google credentials remain in the browser's sign-in flow. The approval request is good for five minutes and the page shows how much time is left; **Cancel** only closes that card, so press Ctrl+C in the terminal to stop the waiting login. The demo never shows or clears a real request.

The CLI stores its application credentials in the operating system's secure credential store. macOS uses Keychain, Windows uses Credential Manager, and Linux requires an unlocked Secret Service provider. If secure storage is unavailable, login fails with setup guidance; credentials are not silently written to a plaintext file. Linux servers without a desktop credential service are not an unattended-automation deployment target for this first release.

## Create a complete agreement

```sh
lobster bets create
```

The guided form collects the two people and their positions, title, category, number of rolls, exact decision criteria and the applicable adjudication details. It includes future verification by date/time and timezone, event or evidence, plus an optional claim cutoff, evidence source, personal check-in and location. Historical entries collect the original date precision, reported stage and relevant acknowledgements.

Only the fields applicable to the selected options are requested. Review the agreement before submitting. A successful creation returns its reference and website link. The other bettor must still approve the agreement or historical record. Selecting ChatGPT records a proposed prompt whose exact wording still needs both people's approval.

For structured input, generate a template and use the [complete field reference](../cli/README.md#json-fields):

```sh
lobster bets template > bet.json
lobster bets create --file bet.json --dry-run
lobster bets create --file bet.json --yes
```

A dry run validates against the signed-in ledger without creating a record. Interactive submission requires confirmation; scripts must opt in with `--yes`. The CLI retains a member-bound idempotency key after an uncertain response. Retry the same command and unchanged input to reuse it and prevent duplicate bets; changed input gets a new key.

## Act on a bet

```sh
lobster bets show LL-12345678
lobster bets act LL-12345678 --action accept
lobster bets act LL-12345678 --action decline --note "The terms are too broad." --yes
lobster bets act LL-12345678 --action propose_result --winner <member-ID> --note "The release log is public."
```

`bets act` takes one step on a bet as yourself: `accept`, `decline`, `withdraw` (take back your own unanswered proposal), `withdraw_proposal` (remove your open amendment, call-off, result, delivery report or readiness evidence), `decline_judging` (step down as the named judge), `mark_ready`, `dispute_readiness` (disagree with the other bettor's readiness evidence, which takes it off the bet), `request_history_correction`, `confirm_amendment`, `reject_amendment`, `propose_void`, `confirm_void`, `reject_void`, `propose_result`, `adjudicate`, `approve_prompt`, `confirm_result`, `dispute_result`, `propose_settlement`, `confirm_settlement` and `dispute_settlement`. Exits, disputes, results and delivery reports need a `--note` with your reason or evidence; results and recommendations need `--winner <member-ID>` or `--winner none`. Amendments, history revisions, check-ins and prompt text are edited on the website.

The CLI reads the bet first and submits the action with the version it read, so a bet that changed in the meantime is refused and must be read again. It prints the step for review, including what the action approves or refuses (the terms and sides, the pending amendment with any change of judge or method, the exact prompt text and version, the proposed winner and evidence, or the delivery report and the rolls it settles), and, in a terminal, asks before submitting; scripts must pass `--yes`. Every action is recorded in your name and bumps the bet's version. Where the rules require it, the other bettor must still confirm separately.

## Read lobster roll prices

```sh
lobster prices list
lobster prices list --restaurant "Harbor Shack"
lobster prices list --all --json
```

`prices list` is read-only. It reads the same ledger the other commands download and prints each restaurant's latest live price per item, with the visit date as precisely as it was reported and how many live reports back it. Reports their reporter withdrew and reports replaced by a correction are left out. `--restaurant` takes a restaurant name (any case) or an ID (the table shows names; `--json` also carries each restaurant's ID); `--all` also lists superseded and withdrawn reports, marked as such. `--json` prints the rows for scripts. Prices are reported, corrected and withdrawn on the website; the CLI cannot write them. The website's **Export** dialog downloads every price report, corrected and withdrawn ones included, as a spreadsheet.

## Sessions and privacy

Use `lobster auth status` to verify the selected origin and member. Short-lived access credentials renew automatically while the CLI session remains valid. Sessions have inactivity and absolute expiry limits and can be revoked individually from the website. `lobster auth logout` revokes the session and removes its local credentials.

`lobster leaderboard` uses the website's ranking by all-time net rolls. Members with confirmed results receive ranks, and tied members share a rank. The CLI lists members without confirmed results below the table. With `--json`, each member's object contains `name`, `net`, `won`, `lost`, `winRate`, `decided`, `rank`, and `tied`. Ranked members appear first, followed by members with `rank: null`.

The CLI cannot approve an agreement, result or delivery on the other bettor's behalf, convert net balances into settlements, or mark a physical delivery as confirmed by someone else; `bets act` only ever records your own side of a handshake. API access continues to enforce the member's permissions.

## Package and verify

The CLI source is available under the [MIT License](../LICENSE). The archive contains the client bundle, package manifest, CLI documentation, project license, and bundled Zod notice. The package manager installs the pinned operating-system credential dependency separately. See [Releasing](releasing.md) for archive verification.

After a build, run `pnpm test:cli-install` to verify the checksum and install the archive in a temporary directory. After deployment, verify the archive against the checksum manifest at your ledger's `/downloads/` path, then run `lobster auth status` and `lobster bets list` on the intended instance.
