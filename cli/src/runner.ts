import { parseCommand, HELP, type CliAction } from './args';
import { ApiClient } from './auth';
import { CredentialStore } from './storage';
import { login } from './login';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { betTemplate, collectBet, validateCreateInput, type WizardIO } from './create';
import { PendingSubmissions } from './submission';
import { priceRows, renderPriceTable } from './prices';
import { terminalWizard } from './terminal';
import { getDirectDebts, getMemberStats, getRemainingRolls } from '../../src/lib/ledger';
import { leaderboardLines } from '../../src/lib/standings';
import type { Bet, LedgerState } from '../../src/lib/types';
type Runtime = {
  client?: ApiClient;
  interactive?: boolean;
  io?: WizardIO;
  pending?: PendingSubmissions;
};
const reasonActions: CliAction[] = [
  'decline',
  'withdraw',
  'withdraw_proposal',
  'decline_judging',
  'request_history_correction',
  'dispute_readiness',
  'reject_amendment',
  'propose_void',
  'reject_void',
  'propose_result',
  'adjudicate',
  'dispute_result',
  'propose_settlement',
  'dispute_settlement',
];
/** Shapes a CLI action the way the ledger API expects it; the server applies every rule. */
export function buildCliAction(
  type: CliAction,
  note: string | undefined,
  winner: string | undefined,
): Record<string, unknown> {
  const action: Record<string, unknown> = { type };
  const wantsNote = reasonActions.includes(type) || type === 'mark_ready';
  if (wantsNote && !note?.trim())
    throw new Error(
      `--note is required for ${type}: ${type === 'mark_ready' ? 'describe the evidence' : 'give your reason'}.`,
    );
  if (!wantsNote && note !== undefined) throw new Error(`${type} does not take a --note.`);
  if (note !== undefined) action[type === 'mark_ready' ? 'evidence' : 'note'] = note.trim();
  if (type === 'propose_result' || type === 'adjudicate') {
    if (!winner) throw new Error(`--winner <member-ID|none> is required for ${type}.`);
    action.winnerId = winner === 'none' ? null : winner;
  } else if (winner !== undefined) throw new Error(`${type} does not take a --winner.`);
  if (type === 'propose_settlement') action.method = 'roll';
  return action;
}
/** "Alex", "Alex and James", "Alex, James and Sarah". */
const joinNames = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const timingText = (timing: NonNullable<Bet['timing']>) =>
  timing.kind === 'date' ? `${timing.at} (${timing.timezone})` : `When ${timing.description}`;
const decidedBy = (
  method: Bet['decisionMethod'],
  judgeId: string | undefined,
  name: (id: string) => string,
) =>
  method === 'judge'
    ? `Judge: ${name(judgeId ?? '')}`
    : method === 'chatgpt'
      ? 'ChatGPT recommendation'
      : 'Mutual agreement';
/**
 * What the member is about to approve or refuse, so the review shows the content and not only
 * the action name. Returns nothing for actions that only add the member's own words.
 */
export function pendingReview(bet: Bet, type: CliAction, name: (id: string) => string): string[] {
  const rolls = (count: number) => `${count} ${count === 1 ? 'roll' : 'rolls'}`;
  switch (type) {
    case 'accept':
    case 'decline':
      return [
        `Terms: ${bet.terms}`,
        `${name(bet.creatorId)}: ${bet.creatorSide}`,
        `${name(bet.opponentId)}: ${bet.opponentSide}`,
        `Stake: ${rolls(bet.stake)}`,
        `Decided by: ${decidedBy(bet.decisionMethod, bet.judgeId, name)}${bet.judgeDeclined ? ' (stepped down)' : ''}`,
        ...(bet.timing
          ? [`Timing: ${timingText(bet.timing)}`]
          : bet.deadline
            ? [`Deadline: ${bet.deadline}`]
            : []),
        ...(bet.cutoff ? [`Claim cutoff: ${bet.cutoff.at} (${bet.cutoff.timezone})`] : []),
        ...(bet.location
          ? [`Location: ${[bet.location.name, bet.location.address].filter(Boolean).join(', ')}`]
          : []),
      ];
    case 'confirm_amendment':
    case 'reject_amendment': {
      const amendment = bet.amendment;
      if (!amendment) return [];
      return [
        `Proposed criteria: ${amendment.terms}`,
        `Proposed timing: ${timingText(amendment.timing)}`,
        ...(amendment.cutoff
          ? [`Claim cutoff: ${amendment.cutoff.at} (${amendment.cutoff.timezone})`]
          : []),
        ...(amendment.decisionMethod
          ? [
              `Decided by now: ${decidedBy(bet.decisionMethod, bet.judgeId, name)}${bet.judgeDeclined ? ' (stepped down)' : ''}`,
              `Proposed decision: ${decidedBy(amendment.decisionMethod, amendment.judgeId, name)}`,
            ]
          : []),
        `Reason: ${amendment.note}`,
      ];
    }
    case 'dispute_readiness':
      return bet.readiness
        ? [`Evidence from ${name(bet.readiness.markedBy)}: ${bet.readiness.evidence}`]
        : [];
    case 'confirm_void':
    case 'reject_void':
      return bet.voidProposal ? [`No-winner proposal: ${bet.voidProposal.note}`] : [];
    case 'approve_prompt':
      return bet.promptAgreement
        ? [`Prompt v${bet.promptAgreement.version}:`, bet.promptAgreement.text]
        : [];
    case 'confirm_result':
    case 'dispute_result':
      return bet.resolution
        ? [
            `Proposed winner: ${bet.resolution.winnerId === null ? 'no winner' : name(bet.resolution.winnerId)}`,
            `Evidence: ${bet.resolution.note}`,
          ]
        : [];
    case 'confirm_settlement':
    case 'dispute_settlement':
      return bet.settlement
        ? [
            `Settles ${rolls(bet.settlement.rolls ?? getRemainingRolls(bet))}`,
            `Delivery: ${bet.settlement.note}`,
          ]
        : [];
    default:
      return [];
  }
}
export async function runCli(
  args: string[],
  print: (value: string) => void = console.log,
  runtime: Runtime = {},
): Promise<void> {
  const output = print;
  print = (value) =>
    output(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ''));
  const command = parseCommand(args);
  if (command.help) {
    print(HELP);
    return;
  }
  if (command.version) {
    print('0.1.0');
    return;
  }
  if (command.command === 'bets template') {
    print(JSON.stringify(betTemplate(), null, 2));
    return;
  }
  const interactive = runtime.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (command.command === 'bets create' && !interactive) {
    if (!command.file)
      throw new Error(
        'Noninteractive creation requires --file bet.json. Start with lobster bets template > bet.json.',
      );
    if (!command.dryRun && !command.yes)
      throw new Error(
        'Noninteractive submission requires --yes after reviewing the agreement. Use --dry-run to validate it first.',
      );
  }
  const origin = command.origin ?? runtime.client?.origin;
  if (!origin) throw new Error('Choose your ledger with --origin or set LOBSTER_ORIGIN.');
  const store = new CredentialStore(origin);
  const client = runtime.client ?? new ApiClient(origin, store);
  if (command.command === 'auth login') {
    await login(client, print);
    return;
  }
  if (command.command === 'auth logout') {
    await client.logout();
    print(
      command.json
        ? JSON.stringify({ signedOut: true })
        : 'Signed out. This device session has been revoked and its saved credentials removed.',
    );
    return;
  }
  if (command.command === 'auth status') {
    const status = (await client.get('/api/cli/me')) as {
      member: { name: string };
      sessionId: string;
    };
    print(
      command.json
        ? JSON.stringify(status, null, 2)
        : `Signed in as ${status.member.name} on ${client.origin}`,
    );
    return;
  }
  if (command.command === 'api') {
    print(JSON.stringify(await client.get(command.argument!), null, 2));
    return;
  }
  const ledger = (await client.get('/api/ledger')) as LedgerState;
  const name = (id: string) => ledger.members.find((member) => member.id === id)?.name ?? id;
  if (command.command === 'members') {
    print(
      command.json
        ? JSON.stringify(ledger.members, null, 2)
        : ledger.members.map((member) => `${member.name}\t${member.id}`).join('\n') ||
            'No members yet.',
    );
    return;
  }
  if (command.command === 'bets list') {
    const bets = ledger.bets
      .filter((bet) => !command.status || command.status === 'all' || bet.status === command.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    print(
      command.json
        ? JSON.stringify(bets, null, 2)
        : bets
            .map(
              (bet) =>
                `${bet.reference}\t${bet.status}\t${bet.stake} roll${bet.stake === 1 ? '' : 's'}\t${bet.title}\n  ${name(bet.creatorId)} ↔ ${name(bet.opponentId)}`,
            )
            .join('\n') || 'No bets match.',
    );
    return;
  }
  if (command.command === 'prices list') {
    const rows = priceRows(ledger, { restaurant: command.restaurant, all: command.all });
    print(command.json ? JSON.stringify(rows, null, 2) : renderPriceTable(rows));
    return;
  }
  const findBet = (key: string): Bet => {
    const needle = key.toLowerCase();
    const matches = ledger.bets.filter(
      (bet) => bet.id.toLowerCase() === needle || bet.reference.toLowerCase() === needle,
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'That reference matches multiple bets. Use the full bet ID.'
          : 'No bet matches that ID or reference.',
      );
    return matches[0];
  };
  if (command.command === 'bets show') {
    const bet = findBet(command.argument!);
    print(
      JSON.stringify(
        { ...bet, url: `${client.origin}/?bet=${encodeURIComponent(bet.id)}#ledger` },
        null,
        2,
      ),
    );
    return;
  }
  if (command.command === 'leaderboard') {
    // The website's ranking: only members with a confirmed result are numbered, tied members share a
    // rank, and the rest wait under the table.
    const lines = leaderboardLines(ledger);
    if (command.json) {
      print(
        JSON.stringify(
          lines.map(({ member, ...figures }) => ({ ...figures, name: member.name })),
          null,
          2,
        ),
      );
      return;
    }
    const ranked = lines.filter((line) => line.rank !== null);
    const waiting = lines.filter((line) => line.rank === null).map((line) => line.member.name);
    if (!lines.length) return print('No standings yet.');
    if (!ranked.length) return print('No confirmed results yet.');
    const rows = ranked.map(
      (line) =>
        `${line.rank}. ${line.member.name}${line.tied ? ' (tied)' : ''}\t${line.net >= 0 ? '+' : ''}${line.net} all-time rolls\t${line.won} wins / ${line.lost} losses\t${line.winRate.toFixed(1)}%`,
    );
    if (waiting.length)
      rows.push(
        '',
        `Not ranked yet: ${joinNames(waiting)} ${waiting.length === 1 ? 'has' : 'have'} no confirmed results.`,
      );
    print(rows.join('\n'));
    return;
  }
  const me = (await client.get('/api/cli/me')) as {
    member: { id: string; name: string };
    sessionId: string;
  };
  if (command.command === 'balances') {
    const stats = getMemberStats(ledger.bets, me.member.id);
    const obligations = getDirectDebts(ledger.bets)
      .filter((debt) => [debt.fromId, debt.toId].includes(me.member.id))
      .map((debt) => ({ ...debt, from: name(debt.fromId), to: name(debt.toId) }));
    const data = {
      member: me.member,
      owedToYou: stats.owedToYou,
      youOwe: stats.youOwe,
      netOutstanding: stats.owedToYou - stats.youOwe,
      obligations,
      note: 'Remaining debts require confirmed physical delivery or an explicit mutual-debt offset on the Balances page. Either bettor can offset equal debts between the same two people; debts cannot transfer to anyone else.',
    };
    print(
      command.json
        ? JSON.stringify(data, null, 2)
        : `${me.member.name}: ${stats.owedToYou} rolls owed to you; ${stats.youOwe} rolls you owe.\n${obligations.map((debt) => `${debt.from} owes ${debt.to}: ${debt.rolls} rolls`).join('\n') || 'No confirmed outstanding debts.'}\n${data.note}`,
    );
    return;
  }
  if (command.command === 'bets act') {
    let terminal: ReturnType<typeof terminalWizard> | undefined;
    const io = () => runtime.io ?? (terminal ??= terminalWizard(print));
    try {
      const bet = findBet(command.argument!);
      const action = buildCliAction(command.action!, command.note, command.winner);
      const review = {
        reference: bet.reference,
        title: bet.title,
        status: bet.status,
        version: bet.version,
        actingAs: me.member,
        action,
      };
      if (!command.json) {
        const pending = pendingReview(bet, command.action!, name);
        print(
          `Review this step\n${bet.reference}: ${bet.title}\nStatus: ${bet.status} · version ${bet.version}\nActing as: ${me.member.name}\n${pending.length ? `${pending.join('\n')}\n` : ''}Action: ${JSON.stringify(action, null, 2)}\nThis records one event in your name. Where the rules require it, the other bettor must still confirm separately.`,
        );
      }
      if (!command.yes) {
        if (command.json) print(JSON.stringify({ review }, null, 2));
        if (!interactive) throw new Error('Add --yes to submit this action after reviewing it.');
        const approved = await io().ask('submit', 'Submit this action?', {
          choices: [
            { value: 'no', label: 'Cancel' },
            { value: 'yes', label: 'Submit it in my name' },
          ],
          defaultValue: 'no',
        });
        if (approved !== 'yes') {
          print(
            command.json ? JSON.stringify({ cancelled: true }) : 'Cancelled. Nothing recorded.',
          );
          return;
        }
      }
      const updated = (await client.request(`/api/bets/${encodeURIComponent(bet.id)}/actions`, {
        method: 'POST',
        body: { action, version: bet.version },
      })) as Bet;
      const url = `${client.origin}/?bet=${encodeURIComponent(bet.id)}#ledger`;
      print(
        command.json
          ? JSON.stringify({ ...updated, url }, null, 2)
          : `Recorded ${action.type} on ${bet.reference}. Status: ${updated.status} (version ${updated.version}).\n${url}`,
      );
      return;
    } finally {
      terminal?.close();
    }
  }
  if (command.command === 'bets create') {
    let terminal: ReturnType<typeof terminalWizard> | undefined;
    const io = () => runtime.io ?? (terminal ??= terminalWizard(print));
    try {
      let raw: unknown;
      if (command.file) {
        if ((await stat(command.file)).size > 64 * 1024)
          throw new Error('The bet JSON file must be smaller than 64 KiB.');
        try {
          raw = JSON.parse(await readFile(command.file, 'utf8'));
        } catch {
          throw new Error(
            'Could not parse the bet file as JSON. Use lobster bets template for the required { bet, prompt? } structure.',
          );
        }
      } else raw = await collectBet(io(), ledger, me.member.id);
      const input = validateCreateInput(raw, me.member.id, ledger.members);
      if (command.dryRun) {
        print(
          command.json
            ? JSON.stringify({ valid: true, input }, null, 2)
            : `Valid agreement. No bet was created.\n${JSON.stringify(input, null, 2)}`,
        );
        return;
      }
      if (!command.json)
        print(
          `Review the complete agreement\nCreator: ${me.member.name}\nOpponent: ${name(input.bet.opponentId)}${input.bet.judgeId ? `\nJudge: ${name(input.bet.judgeId)}` : ''}\n${JSON.stringify(input, null, 2)}\nSubmitting confirms your own agreement only. The other bettor must confirm separately.`,
        );
      if (!command.yes) {
        if (command.json) print(JSON.stringify({ review: input }, null, 2));
        const approved = await io().ask('submit', 'Submit this agreement?', {
          choices: [
            { value: 'no', label: 'Cancel' },
            { value: 'yes', label: 'Submit and approve my terms' },
          ],
          defaultValue: 'no',
        });
        if (approved !== 'yes') {
          print(
            command.json ? JSON.stringify({ cancelled: true }) : 'Cancelled. No bet was created.',
          );
          return;
        }
      }
      const pending =
        runtime.pending ??
        new PendingSubmissions(join(store.directory, 'pending'), client.origin, me.member.id);
      const request = await pending.prepare(input);
      let bet: Bet;
      try {
        bet = (await client.request('/api/cli/bets', {
          method: 'POST',
          body: input,
          idempotencyKey: request.key,
        })) as Bet;
      } catch (error) {
        throw new Error(
          `${(error as Error).message} Repeat the same input to retry safely; the request key is retained. Check the ledger before changing the input.`,
        );
      }
      if (!bet?.id || !bet.reference)
        throw new Error(
          'The server response was incomplete. Retry the same input to recover this bet safely.',
        );
      await pending.complete(request);
      const url = `${client.origin}/?bet=${encodeURIComponent(bet.id)}#ledger`;
      print(
        command.json
          ? JSON.stringify({ ...bet, url }, null, 2)
          : `Created ${bet.reference}: ${bet.title}\nAwaiting the other bettor's confirmation.\n${url}`,
      );
      return;
    } finally {
      terminal?.close();
    }
  }
  throw new Error('Unknown command. Run lobster --help.');
}
