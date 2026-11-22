import { parseArgs } from 'node:util';
import { normalizeOrigin } from './auth';

// esbuild supplies this only for archives built for a configured deployment.
declare const __LOBSTER_DEFAULT_ORIGIN__: string | undefined;
const packagedOrigin =
  typeof __LOBSTER_DEFAULT_ORIGIN__ === 'string' ? __LOBSTER_DEFAULT_ORIGIN__ : undefined;
/** Actions the CLI can submit with at most a reason and a winner; richer forms stay on the website. */
export const CLI_ACTIONS = [
  'accept',
  'decline',
  'withdraw',
  'withdraw_proposal',
  'decline_judging',
  'request_history_correction',
  'mark_ready',
  'dispute_readiness',
  'confirm_amendment',
  'reject_amendment',
  'propose_void',
  'confirm_void',
  'reject_void',
  'propose_result',
  'adjudicate',
  'approve_prompt',
  'confirm_result',
  'dispute_result',
  'propose_settlement',
  'confirm_settlement',
  'dispute_settlement',
] as const;
export type CliAction = (typeof CLI_ACTIONS)[number];
export type Command = {
  command: string;
  argument?: string;
  origin?: string;
  json: boolean;
  file?: string;
  dryRun: boolean;
  yes: boolean;
  status?: string;
  restaurant?: string;
  all: boolean;
  action?: CliAction;
  note?: string;
  winner?: string;
  help: boolean;
  version: boolean;
};
export function parseCommand(args: string[]): Command {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      origin: { type: 'string' },
      json: { type: 'boolean' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      status: { type: 'string' },
      restaurant: { type: 'string' },
      all: { type: 'boolean' },
      action: { type: 'string' },
      note: { type: 'string' },
      winner: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const origin = values.origin ?? process.env.LOBSTER_ORIGIN ?? packagedOrigin;
  const result: Command = {
    command: '',
    origin: origin === undefined ? undefined : normalizeOrigin(origin),
    json: !!values.json,
    file: values.file,
    dryRun: !!values['dry-run'],
    yes: !!values.yes,
    status: values.status,
    restaurant: values.restaurant,
    all: !!values.all,
    note: values.note,
    winner: values.winner,
    help: !!values.help || (!positionals.length && !values.version),
    version: !!values.version,
  };
  if (result.help || result.version) return result;
  const [first, second, third, ...remaining] = positionals;
  if (first === 'auth' && ['login', 'status', 'logout'].includes(second))
    result.command = `auth ${second}`;
  else if (first === 'bets' && ['list', 'show', 'create', 'template', 'act'].includes(second)) {
    result.command = `bets ${second}`;
    if (second === 'show' || second === 'act') result.argument = third;
  } else if (first === 'prices' && second === 'list') result.command = 'prices list';
  else if (['balances', 'leaderboard', 'members'].includes(first)) result.command = first;
  else if (first === 'api') {
    result.command = first;
    result.argument = second;
  } else throw new Error('Unknown command. Run lobster --help for available commands.');
  const expected = ['bets show', 'bets act'].includes(result.command)
    ? 3
    : result.command.includes(' ') || first === 'api'
      ? 2
      : 1;
  if (
    remaining.length ||
    positionals.length !== expected ||
    (first === 'api' && !second.startsWith('/api/'))
  )
    throw new Error('Unexpected or missing arguments. Run lobster --help for command syntax.');
  if ((result.file || result.dryRun) && result.command !== 'bets create')
    throw new Error('--file and --dry-run apply only to bets create.');
  if (result.yes && !['bets create', 'bets act'].includes(result.command))
    throw new Error('--yes applies only to bets create and bets act.');
  if (
    (values.action !== undefined || result.note !== undefined || result.winner !== undefined) &&
    result.command !== 'bets act'
  )
    throw new Error('--action, --note and --winner apply only to bets act.');
  if (result.command === 'bets act') {
    if (!values.action || !(CLI_ACTIONS as readonly string[]).includes(values.action))
      throw new Error(
        `Choose an action with --action: ${CLI_ACTIONS.join(', ')}. Other changes are made on the website.`,
      );
    result.action = values.action as CliAction;
  }
  if ((result.restaurant !== undefined || result.all) && result.command !== 'prices list')
    throw new Error('--restaurant and --all apply only to prices list.');
  if (result.status && result.command !== 'bets list')
    throw new Error('--status applies only to bets list.');
  if (
    result.status &&
    ![
      'all',
      'pending',
      'active',
      'confirming',
      'owed',
      'settling',
      'settled',
      'voided',
      'declined',
    ].includes(result.status)
  )
    throw new Error(
      'Unknown status. Use all, pending, active, confirming, owed, settling, settled, voided, or declined.',
    );
  return result;
}
export const HELP = `Lobster Ledger CLI 0.1.0

Usage: lobster <command> [options]

  auth login                         Sign in with your browser
  auth status                        Check your signed-in account
  auth logout                        Revoke this device and erase its credentials
  members [--json]                   List people and their member IDs
  bets list [--status active]         List ledger bets
  bets show <ID-or-reference>         Read a complete agreement
  bets create                        Fill in a guided agreement and review it
  bets template                      Print a JSON starting point
  bets create --file bet.json         Review and submit a JSON agreement
  bets create --file bet.json --dry-run  Validate without submitting
  bets create --file bet.json --yes   Explicitly submit without an interactive prompt
  bets act <ID-or-reference> --action <type> [--note "reason"] [--winner <member-ID|none>] [--yes]
                                     Take one step on a bet as yourself: accept, decline,
                                     withdraw, withdraw_proposal, decline_judging, mark_ready,
                                     dispute_readiness, propose_result, adjudicate,
                                     confirm_result, dispute_result, propose_settlement,
                                     confirm_settlement, dispute_settlement, propose_void,
                                     confirm_void, reject_void, confirm_amendment,
                                     reject_amendment, approve_prompt, request_history_correction
  prices list [--restaurant <name-or-ID>] [--all]
                                     Read each restaurant's latest live price per item, with its
                                     date and report count; --all adds superseded and
                                     withdrawn reports
  balances                           Read balances and remaining roll obligations
  leaderboard                        Read all-time standings
  api /api/ledger                    Make a read-only API request

Global options: --json, --origin https://your-ledger.example, --help, --version
LOBSTER_ORIGIN can set your default server. Credentials are isolated per origin.
Read installation and complete field guidance at your ledger's #cli page.
`;
