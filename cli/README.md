# Lobster Ledger CLI

Create complete lobster-roll agreements and access your ledger from the terminal.

## Install

Install Node.js 22 or later. Open your ledger’s **CLI** page for its download and login commands. These examples use `https://your-ledger.example` for the address of your ledger.

```sh
npm install --global https://your-ledger.example/downloads/lobster-ledger-cli-0.1.0.tgz
lobster --help
lobster --origin https://your-ledger.example auth login
```

Set `LOBSTER_ORIGIN` in your terminal to your ledger’s address before running the examples below. You can also pass `--origin` to each command. The browser opens on the same computer. Sign in to your ledger and approve the displayed device. Return to the terminal after authorization. Login credentials are stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux requires an unlocked desktop credential store. There is no plaintext credential fallback. No Google password or token needs to be entered in the terminal.

```sh
lobster auth status
lobster members
lobster bets list --status active
lobster bets show LL-12345678
lobster bets act LL-12345678 --action accept
lobster bets act LL-12345678 --action withdraw --note "I mistyped the date." --yes
lobster balances --json
lobster leaderboard --json
lobster prices list
lobster prices list --restaurant "Harbor Shack" --json
lobster api /api/ledger
```

`prices list` is read-only: each restaurant's latest live price per item, with its date and report count. `--restaurant <name-or-ID>` shows one restaurant (a name in any case, or an ID from `--json`), `--json` prints the rows, and `--all` adds superseded and withdrawn reports. Prices are reported on the website.

`bets act` takes one step on a bet in your own name: `accept`, `decline`, `withdraw`, `withdraw_proposal`, `decline_judging`, `mark_ready`, `dispute_readiness`, `request_history_correction`, `confirm_amendment`, `reject_amendment`, `propose_void`, `confirm_void`, `reject_void`, `propose_result`, `adjudicate`, `approve_prompt`, `confirm_result`, `dispute_result`, `propose_settlement`, `confirm_settlement` or `dispute_settlement`. Reasons go in `--note`; results and recommendations name `--winner <member-ID>` or `--winner none`. The CLI shows the step for review and asks before submitting; pass `--yes` in scripts. It submits the bet version it read, so a changed bet is refused until you read it again.

## Create a bet

```sh
lobster bets create
```

The guided form asks about both sides, stakes, decision criteria, judging, timing, locations, and any historical result or physical delivery. Review the complete agreement before confirming. Your opponent must separately confirm; creating a bet cannot approve it on anyone else's behalf. Lobster rolls cannot be transferred or settled in cash.

For scripts, start with a JSON template. Replace example values and member IDs before submitting:

```sh
lobster bets template > bet.json
lobster bets create --file bet.json --dry-run
lobster bets create --file bet.json --yes
```

Dry-run performs local validation against the current signed-in ledger without writing a bet. Noninteractive submission requires `--yes`; it is an explicit approval of the proposed agreement by the signed-in member. Unknown fields and contradictory options are rejected. On an uncertain network response, repeat the same command and file: the CLI retains an opaque request key to avoid duplicate creation. It does not save the wager content in the retry record.

### JSON fields

The file contains `{ "bet": { ... }, "prompt": "optional proposed ChatGPT prompt" }`. Member IDs come from `lobster members --json`. The signed-in account is always the creator; a file cannot impersonate another member or supply someone else's approvals.

Required bet fields are `title` (3–160 characters), `terms` (10–3000), `category` (`Work`, `Sports`, `Life`, or `Wild card`), `opponentId`, `creatorSide` and `opponentSide` (1–300 each), and `stake` (a whole number 1–100). Use decision timing for every new or ongoing bet.

- `decisionMethod`: `mutual`, `judge`, or `chatgpt`. `judge` additionally requires `judgeId`, which must name a registered third member. Other methods cannot include `judgeId`.
- `timing`: one of the exact shapes below. Optional `source` describes where evidence will be checked; optional `checkIn` gives a time to review progress. Passing the date or check-in never automatically decides a winner.
- `cutoff`: optional `{ "at": "2030-10-31T17:00:00-07:00", "timezone": "America/Los_Angeles" }`, defining when qualifying events stop counting. It is separate from decision time.
- `location`: optional `{ "id": "office", "name": "Office", "address": "1 Main Street", "lat": 34.05, "lng": -118.25 }`. Use real coordinates. The wizard also offers existing saved places.
- `deadline`: an optional legacy `YYYY-MM-DD` date. Use either this or `timing`; including both is rejected to avoid an ambiguous deadline.
- Top-level `prompt`: optional, 20–8000 characters, only for a **new** ChatGPT bet. Submitting it approves your own exact prompt text; the other bettor separately approves the prompt and agreement. Historical adjudication uses the fields below.

```json
{
  "kind": "date",
  "at": "2030-10-31T17:00:00-07:00",
  "timezone": "America/Los_Angeles",
  "source": "Official results page",
  "checkIn": {
    "at": "2030-10-30T17:00:00-07:00",
    "timezone": "America/Los_Angeles"
  }
}
```

For event-based timing use `{ "kind": "event", "description": "The final is completed", "source": "Official results" }`. For delayed validation use `{ "kind": "evidence", "description": "The audited results are published", "source": "Auditor's report" }`. Both may include the same `checkIn` object. Timestamps require seconds and an explicit UTC offset or `Z`; timezone names must be valid IANA names. The offset identifies the instant; the named timezone controls its presentation.

### Existing bets and actual delivery

Add `bet.history` for an existing agreement. `stage` is `active`, `owed`, `settled`, or `voided`. Every historical record requires `originalDate`; known dates use `{ "precision": "day", "value": "2025-02-01" }`, `month` with `YYYY-MM`, or `year` with `YYYY`. Use `{ "precision": "unknown" }` when unknown. Do not invent a precise date.

Completed stages require `result` with `winnerId`, `date`, and an explanatory `note`. A `voided` result has `winnerId: null`; `owed` and `settled` name one of the two bettors. Only `settled` includes `delivery`, recording when the actual rolls were bought and delivered. Historical dates cannot be in the future or contradict the order of the agreement, result, and delivery.

```json
{
  "stage": "settled",
  "originalDate": { "precision": "month", "value": "2025-01" },
  "result": {
    "winnerId": "REPLACE_WITH_ORIGINAL_BETTOR_ID",
    "date": { "precision": "day", "value": "2025-02-01" },
    "note": "The agreed result was verified from the official record."
  },
  "delivery": {
    "date": { "precision": "unknown" },
    "note": "Bought and delivered the actual lobster roll at lunch."
  },
  "previousAdjudication": {
    "method": "judge",
    "note": "Casey reviewed the evidence at the time.",
    "sourceUrl": "https://example.com/evidence"
  }
}
```

`previousAdjudication` is optional for completed stages; its `method` is `judge` or `chatgpt`, `note` records the original decision, and `sourceUrl` is an optional HTTPS evidence link. Reporting a previous judgment does not create a new approval from that judge.

Every historical input requires `bet.acknowledgements`: `{ "terms": true, "result": true, "delivery": true }` for settled history, `{ "terms": true, "result": true, "delivery": false }` for owed or voided history, and `{ "terms": true, "result": false, "delivery": false }` for ongoing history. These are your attestations; the other bettor still confirms their own. Ongoing history cannot include a completed result, delivery, or previous adjudication.

## Other servers and updates

```sh
lobster --origin https://your-ledger.example auth login
lobster --origin https://your-ledger.example bets create
```

Alternatively set `LOBSTER_ORIGIN`. Use the same origin on future commands; each origin has separate credentials. HTTPS is required, except explicit `http://127.0.0.1:<port>` for local development. API commands are read-only and cannot send credentials to another origin or follow redirects.

To update, reinstall using the current download command on your ledger's CLI page. To remove the CLI, first run `lobster auth logout` for each origin, then `npm uninstall --global lobster-ledger-cli`. Logout revokes the server session before removing local credentials. If the server cannot be reached, retry when online; you can also revoke the device from the site's CLI session controls.

Session changes are serialized across terminal processes. If a process is forcibly killed while holding the lock, subsequent commands name the stale lock file. Close all lobster processes before removing that file. It contains only a process ID; session credentials remain in the OS store.

The CLI source is available under the MIT license. The download includes `LICENSE` and the bundled Zod notice in `THIRD_PARTY_NOTICES.txt`.
