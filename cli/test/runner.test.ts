import { describe, expect, it, vi } from 'vitest';
import { buildCliAction, pendingReview, runCli } from '../src/runner';
import { ApiClient, type Credentials, type SessionStore } from '../src/auth';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingSubmissions } from '../src/submission';
import { createDemoState } from '../../src/lib/demo';
import { applyAction, createBet } from '../../src/lib/ledger';
import type { Bet, LedgerState } from '../../src/lib/types';
describe('CLI entry point', () => {
  it('asks for a ledger before making a request from an unconfigured source build', async () => {
    vi.stubEnv('LOBSTER_ORIGIN', undefined);
    try {
      await expect(runCli(['members'])).rejects.toThrow('Choose your ledger with --origin');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('prints installation and command help without requiring login or native keyring loading', async () => {
    const lines: string[] = [];
    await runCli(['--help'], (line) => lines.push(line));
    expect(lines.join('\n')).toContain('bets create --file bet.json --dry-run');
    expect(lines.join('\n')).toContain('auth login');
    expect(lines.join('\n')).toContain('prices list [--restaurant <name-or-ID>] [--all]');
    expect(lines.join('\n')).toMatch(/--all adds superseded and\s+withdrawn reports/);
  });
  it('prints its version without making an API request', async () => {
    const lines: string[] = [];
    await runCli(['--version'], (line) => lines.push(line));
    expect(lines).toEqual(['0.1.0']);
  });
  it('explains how to create in noninteractive terminals without hanging or submitting', async () => {
    await expect(runCli(['bets', 'create'], () => {}, { interactive: false })).rejects.toThrow(
      /--file/,
    );
    await expect(
      runCli(['bets', 'create', '--file', 'unused.json'], () => {}, { interactive: false }),
    ).rejects.toThrow(/--yes/);
  });
  it('acts on a bet only after review, posting the action with the version it read', async () => {
    const bet = {
      id: 'bet-id',
      reference: 'LL-123',
      title: 'Release before Friday',
      status: 'pending',
      version: 3,
      creatorId: 'b',
      opponentId: 'a',
      stake: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      agreementApprovals: ['b'],
      events: [],
    };
    let saved: Credentials | undefined = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 999999,
      member: { id: 'a', name: 'Alex' },
      sessionId: 's',
    };
    const store: SessionStore = {
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      clear: async () => {
        saved = undefined;
      },
      locked: async (fn) => fn(),
    };
    const writes: { url: string; body: unknown }[] = [];
    const client = new ApiClient('https://ledger.example', store, async (url, init) => {
      if (String(url).endsWith('/api/cli/me'))
        return Response.json({ member: { id: 'a', name: 'Alex' }, sessionId: 's' });
      if (String(url).endsWith('/api/ledger'))
        return Response.json({
          members: [
            { id: 'a', name: 'Alex' },
            { id: 'b', name: 'Blair' },
          ],
          bets: [bet],
          places: [],
          groupName: 'Friends',
        });
      writes.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ...bet, status: 'declined', version: 4 });
    });
    const output: string[] = [];
    await expect(
      runCli(
        ['bets', 'act', 'll-123', '--action', 'decline', '--note', 'Too broad.'],
        (value) => output.push(value),
        { client, interactive: false },
      ),
    ).rejects.toThrow(/--yes/);
    expect(writes).toHaveLength(0);
    expect(output.join('\n')).toContain('Release before Friday');
    expect(output.join('\n')).toContain('decline');
    await runCli(
      ['bets', 'act', 'LL-123', '--action', 'decline', '--note', 'Too broad.', '--yes', '--json'],
      (value) => output.push(value),
      { client, interactive: false },
    );
    expect(writes).toEqual([
      {
        url: 'https://ledger.example/api/bets/bet-id/actions',
        body: { action: { type: 'decline', note: 'Too broad.' }, version: 3 },
      },
    ]);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: 'declined', version: 4 });
    await expect(
      runCli(
        ['bets', 'act', 'LL-123', '--action', 'decline', '--yes'],
        (value) => output.push(value),
        { client, interactive: false },
      ),
    ).rejects.toThrow(/--note/);
    await expect(
      runCli(
        ['bets', 'act', 'LL-999', '--action', 'accept', '--yes'],
        (value) => output.push(value),
        { client, interactive: false },
      ),
    ).rejects.toThrow(/No bet/);
    expect(writes).toHaveLength(1);
  });
  it('shows the pending terms, prompt, result, delivery or amendment the action approves or refuses', async () => {
    const base = {
      stake: 3,
      creatorId: 'b',
      opponentId: 'a',
      creatorSide: 'It ships',
      opponentSide: 'It slips',
      terms: 'The official release timestamp decides the outcome.',
      createdAt: '2026-10-01T00:00:00.000Z',
      agreementApprovals: ['b', 'a'],
      events: [],
      version: 2,
    };
    const timing = { kind: 'date', at: '2026-10-25T16:00:00.000Z', timezone: 'America/New_York' };
    const bets = [
      {
        ...base,
        id: 'acc',
        reference: 'LL-ACC',
        title: 'Accept me',
        status: 'pending',
        agreementApprovals: ['b'],
        decisionMethod: 'judge',
        judgeId: 'c',
        judgeDeclined: { at: '2026-10-02T00:00:00.000Z', note: 'Too busy.' },
        deadline: '2026-10-31',
        cutoff: { at: '2026-11-01T12:00:00.000Z', timezone: 'America/New_York' },
        location: { id: 'p1', name: 'Row 34', address: 'Fort Point', lat: 42.35, lng: -71.05 },
      },
      {
        ...base,
        id: 'tim',
        reference: 'LL-TIM',
        title: 'Accept my timing',
        status: 'pending',
        agreementApprovals: ['b'],
        deadline: '2026-10-31',
        timing,
      },
      {
        ...base,
        id: 'amd',
        reference: 'LL-AMD',
        title: 'Amend me',
        status: 'active',
        decisionMethod: 'judge',
        judgeId: 'c',
        judgeDeclined: { at: '2026-10-02T00:00:00.000Z', note: 'Conflicted.' },
        amendment: {
          terms: 'Decided by the published release notes; Dana decides if unclear.',
          timing,
          decisionMethod: 'judge',
          judgeId: 'd',
          note: 'Dana can judge it instead.',
          proposedBy: 'b',
          approvals: ['b'],
          at: '2026-10-03T00:00:00.000Z',
        },
      },
      {
        ...base,
        id: 'prm',
        reference: 'LL-PRM',
        title: 'Approve my prompt',
        status: 'active',
        decisionMethod: 'chatgpt',
        promptAgreement: {
          version: 2,
          text: 'Exact prompt wording v2.',
          proposedBy: 'b',
          approvals: ['b'],
          at: '2026-10-03T00:00:00.000Z',
        },
      },
      {
        ...base,
        id: 'res',
        reference: 'LL-RES',
        title: 'Confirm my result',
        status: 'confirming',
        resolution: {
          winnerId: 'b',
          note: 'The release log is public.',
          proposedBy: 'b',
          approvals: ['b'],
        },
      },
      {
        ...base,
        id: 'set',
        reference: 'LL-SET',
        title: 'Confirm my delivery',
        status: 'settling',
        resolution: { winnerId: 'b', note: 'Public.', proposedBy: 'b', approvals: ['b', 'a'] },
        settlement: {
          method: 'roll',
          note: 'Three rolls at lunch at Row 34.',
          proposedBy: 'b',
          approvals: ['b'],
          rolls: 3,
        },
      },
    ];
    const store: SessionStore = {
      read: async () => ({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 999999,
        member: { id: 'a', name: 'Alex' },
        sessionId: 's',
      }),
      write: async () => {},
      clear: async () => {},
      locked: async (fn) => fn(),
    };
    const client = new ApiClient('https://ledger.example', store, async (url) => {
      if (String(url).endsWith('/api/cli/me'))
        return Response.json({ member: { id: 'a', name: 'Alex' }, sessionId: 's' });
      return Response.json({
        members: [
          { id: 'a', name: 'Alex' },
          { id: 'b', name: 'Blair' },
          { id: 'c', name: 'Casey' },
          { id: 'd', name: 'Dana' },
        ],
        bets,
        places: [],
        groupName: 'Friends',
      });
    });
    const review = async (reference: string, action: string, extra: string[] = []) => {
      const output: string[] = [];
      await expect(
        runCli(
          ['bets', 'act', reference, '--action', action, ...extra],
          (value) => output.push(value),
          {
            client,
            interactive: false,
          },
        ),
      ).rejects.toThrow(/--yes/);
      return output.join('\n');
    };
    const accept = await review('LL-ACC', 'accept');
    expect(accept).toContain('The official release timestamp decides the outcome.');
    expect(accept).toContain('Blair: It ships');
    expect(accept).toContain('Alex: It slips');
    expect(accept).toContain('Decided by: Judge: Casey (stepped down)');
    expect(accept).toContain('Deadline: 2026-10-31');
    expect(accept).toContain('Claim cutoff: 2026-11-01T12:00:00.000Z (America/New_York)');
    expect(accept).toContain('Location: Row 34, Fort Point');
    const timed = await review('LL-TIM', 'decline', ['--note', 'Not this week.']);
    expect(timed).toContain('Timing: 2026-10-25T16:00:00.000Z (America/New_York)');
    expect(timed).not.toContain('Deadline:');
    expect(timed).not.toContain('Claim cutoff:');
    expect(timed).not.toContain('Location:');
    expect(timed).not.toContain('stepped down');
    const amend = await review('LL-AMD', 'confirm_amendment');
    expect(amend).toContain('Decided by the published release notes; Dana decides if unclear.');
    expect(amend).toContain('2026-10-25T16:00:00.000Z (America/New_York)');
    expect(amend).toContain('Decided by now: Judge: Casey (stepped down)');
    expect(amend).toContain('Proposed decision: Judge: Dana');
    expect(amend).toContain('Dana can judge it instead.');
    expect(await review('LL-AMD', 'reject_amendment', ['--note', 'Keep Casey.'])).toContain(
      'Proposed decision: Judge: Dana',
    );
    const prompt = await review('LL-PRM', 'approve_prompt');
    expect(prompt).toContain('Prompt v2');
    expect(prompt).toContain('Exact prompt wording v2.');
    const result = await review('LL-RES', 'confirm_result');
    expect(result).toContain('Proposed winner: Blair');
    expect(result).toContain('The release log is public.');
    const delivery = await review('LL-SET', 'confirm_settlement');
    expect(delivery).toContain('Settles 3 rolls');
    expect(delivery).toContain('Three rolls at lunch at Row 34.');
  });
  it('validates a JSON agreement with no bet write on dry-run and requires explicit submission otherwise', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-create-'));
    try {
      const input = {
        bet: {
          title: 'Release before Friday',
          terms: 'The official release timestamp decides the outcome.',
          category: 'Work',
          opponentId: 'b',
          creatorSide: 'Before Friday',
          opponentSide: 'Friday or later',
          stake: 1,
          decisionMethod: 'chatgpt',
          timing: { kind: 'event', description: 'The release happens' },
        },
        prompt: 'Compare both positions fairly using the release timestamp.',
      };
      const file = join(directory, 'bet.json');
      await writeFile(file, JSON.stringify(input));
      let saved: Credentials | undefined = {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 999999,
        member: { id: 'a', name: 'Alex' },
        sessionId: 's',
      };
      const store: SessionStore = {
        read: async () => saved,
        write: async (value) => {
          saved = value;
        },
        clear: async () => {
          saved = undefined;
        },
        locked: async (fn) => fn(),
      };
      const writes: { body: unknown; headers: unknown }[] = [];
      const client = new ApiClient('https://ledger.example', store, async (url, init) => {
        if (String(url).endsWith('/api/cli/me'))
          return Response.json({ member: { id: 'a', name: 'Alex' }, sessionId: 's' });
        if (String(url).endsWith('/api/ledger'))
          return Response.json({
            members: [
              { id: 'a', name: 'Alex' },
              { id: 'b', name: 'Blair' },
            ],
            bets: [],
            places: [],
            groupName: 'Friends',
          });
        writes.push({ body: JSON.parse(String(init?.body)), headers: init?.headers });
        return Response.json({
          id: 'bet-id',
          reference: 'LL-123',
          status: 'pending',
          title: input.bet.title,
        });
      });
      const output: string[] = [];
      const context = {
        client,
        interactive: false,
        pending: new PendingSubmissions(join(directory, 'pending'), client.origin, 'a'),
      };
      await runCli(
        ['bets', 'create', '--file', file, '--dry-run', '--json'],
        (value) => output.push(value),
        context,
      );
      expect(writes).toHaveLength(0);
      expect(JSON.parse(output.at(-1)!).valid).toBe(true);
      await runCli(
        ['bets', 'create', '--file', file, '--yes', '--json'],
        (value) => output.push(value),
        context,
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].body).toEqual(input);
      expect(writes[0].headers).toHaveProperty('Idempotency-Key');
      expect(JSON.parse(output.at(-1)!).url).toBe('https://ledger.example/?bet=bet-id#ledger');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('lets a bettor disagree with the other bettor’s readiness evidence, showing it first', () => {
    expect(buildCliAction('dispute_readiness', ' That page is a draft. ', undefined)).toEqual({
      type: 'dispute_readiness',
      note: 'That page is a draft.',
    });
    expect(() => buildCliAction('dispute_readiness', undefined, undefined)).toThrow(/--note/);
    const bet = {
      readiness: { markedBy: 'b', at: '2026-10-03T00:00:00.000Z', evidence: 'It shipped.' },
    } as Bet;
    expect(pendingReview(bet, 'dispute_readiness', () => 'Blair')).toEqual([
      'Evidence from Blair: It shipped.',
    ]);
  });
});

describe('leaderboard command', () => {
  const at = '2026-09-01T12:00:00.000Z';
  const demo = createDemoState();
  /** A confirmed result: `winner` beat `loser` for `stake` rolls. */
  function won(winner: string, loser: string, stake = 1): Bet {
    let bet = createBet(
      {
        title: `${winner} beats ${loser}`,
        terms: 'Settled on the night.',
        category: 'Sports',
        opponentId: loser,
        creatorSide: 'Yes',
        opponentSide: 'No',
        stake,
        timing: { kind: 'date', at, timezone: 'UTC' },
      },
      winner,
      demo.members,
      at,
    );
    bet = applyAction(bet, { type: 'accept' }, loser, at);
    bet = applyAction(
      bet,
      { type: 'propose_result', winnerId: winner, note: 'Called it.' },
      winner,
      at,
    );
    return applyAction(bet, { type: 'confirm_result' }, loser, at);
  }
  /** The CLI as a signed-in member sees it, reading `ledger` from a stubbed server. */
  async function leaderboard(ledger: Pick<LedgerState, 'members' | 'bets'>, ...flags: string[]) {
    const store: SessionStore = {
      read: async () => ({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 999999,
        member: { id: 'ellis', name: 'Ellis' },
        sessionId: 's',
      }),
      write: async () => {},
      clear: async () => {},
      locked: async (fn) => fn(),
    };
    const client = new ApiClient('https://ledger.example', store, async () =>
      Response.json({ ...ledger, places: [], groupName: 'Friends' }),
    );
    const output: string[] = [];
    await runCli(['leaderboard', ...flags], (line) => output.push(line), { client });
    return output.join('\n');
  }

  it('numbers only the members with a confirmed result, as the website does, and shares a rank on a tie', async () => {
    const text = await leaderboard({
      members: demo.members,
      bets: [won('ellis', 'sarah'), won('olivia', 'marcus'), won('alex', 'james', 3)],
    });
    expect(text.split('\n').slice(0, 6)).toEqual([
      '1. Alex\t+3 all-time rolls\t1 wins / 0 losses\t100.0%',
      '2. Ellis (tied)\t+1 all-time rolls\t1 wins / 0 losses\t100.0%',
      '2. Olivia (tied)\t+1 all-time rolls\t1 wins / 0 losses\t100.0%',
      '4. Marcus (tied)\t-1 all-time rolls\t0 wins / 1 losses\t0.0%',
      '4. Sarah (tied)\t-1 all-time rolls\t0 wins / 1 losses\t0.0%',
      '6. James\t-3 all-time rolls\t0 wins / 1 losses\t0.0%',
    ]);
  });

  it('names the members still waiting under the table instead of numbering them', async () => {
    const text = await leaderboard({ members: demo.members, bets: [won('ellis', 'sarah')] });
    expect(text.split('\n')).toEqual([
      '1. Ellis\t+1 all-time rolls\t1 wins / 0 losses\t100.0%',
      '2. Sarah\t-1 all-time rolls\t0 wins / 1 losses\t0.0%',
      '',
      'Not ranked yet: Alex, James, Marcus and Olivia have no confirmed results.',
    ]);
    const one = await leaderboard({
      members: demo.members.filter((member) => ['ellis', 'sarah', 'alex'].includes(member.id)),
      bets: [won('ellis', 'sarah')],
    });
    expect(one.split('\n').at(-1)).toBe('Not ranked yet: Alex has no confirmed results.');
  });

  it('does not rank an empty ledger: nobody is first for doing nothing', async () => {
    const text = await leaderboard({ members: demo.members, bets: [] });
    expect(text).toBe('No confirmed results yet.');
    expect(await leaderboard({ members: [], bets: [] })).toBe('No standings yet.');
  });

  it('adds rank, tied and decided to the JSON, ranked members first and waiting ones with a null rank', async () => {
    const lines = JSON.parse(
      await leaderboard({ members: demo.members, bets: [won('ellis', 'sarah')] }, '--json'),
    );
    expect(
      lines.map((line: { name: string; rank: number | null; tied: boolean; decided: number }) => [
        line.name,
        line.rank,
        line.tied,
        line.decided,
      ]),
    ).toEqual([
      ['Ellis', 1, false, 1],
      ['Sarah', 2, false, 1],
      ['Alex', null, false, 0],
      ['James', null, false, 0],
      ['Marcus', null, false, 0],
      ['Olivia', null, false, 0],
    ]);
    // What was there before is still there.
    expect(lines[0]).toMatchObject({ name: 'Ellis', net: 1, won: 1, lost: 0, winRate: 100 });
  });
});
