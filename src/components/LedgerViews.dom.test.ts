// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../lib/demo';
import { applyAction, createBet, getRemainingRolls } from '../lib/ledger';
import type { Bet, DebtOffset, LedgerState, Member, NewBet } from '../lib/types';
import {
  BalancesView,
  BetTable,
  InboxView,
  LeaderboardView,
  LedgerView,
  MembersView,
  Overview,
  PlacesView,
} from './LedgerViews';

// Leaflet is not under test here; the lazy map would only load it into jsdom.
vi.mock('./MapView', () => ({ MapView: () => null }));

let root: Root;
let container: HTMLDivElement;
const demo = createDemoState();
const state: LedgerState = {
  ...demo,
  bets: [
    {
      ...demo.bets[0],
      id: 'browser',
      title: 'Browser launch wager',
      entrySource: 'browser',
      entrySourceInference: {
        basis: 'before_cli_release',
        cutoffAt: '2025-01-15T12:00:00.000Z',
        evidenceUrl: 'https://example.org/runs/12345',
        inferredAt: '2026-10-15T17:00:00.000Z',
      },
      status: 'active',
    },
    { ...demo.bets[0], id: 'cli', title: 'CLI launch wager', entrySource: 'cli', status: 'active' },
    {
      ...demo.bets[0],
      id: 'mcp',
      title: 'MCP launch wager',
      entrySource: 'mcp',
      entrySourceReport: {
        basis: 'user_report',
        note: 'Entered via MCP.',
        reportedAt: '2026-10-15T17:00:00.000Z',
      },
      status: 'active',
    },
    {
      ...demo.bets[0],
      id: 'legacy',
      title: 'Older launch wager',
      entrySource: undefined,
      status: 'active',
    },
    {
      ...demo.bets[0],
      id: 'pending',
      title: 'MCP pending wager',
      entrySource: 'mcp',
      status: 'pending',
    },
    {
      ...demo.bets[0],
      id: 'other',
      title: 'MCP other members wager',
      entrySource: 'mcp',
      status: 'active',
      creatorId: 'alex',
      opponentId: 'marcus',
    },
  ],
};

function Harness() {
  const [search, setSearch] = useState('');
  return createElement(LedgerView, { state, memberId: 'ellis', onBet: vi.fn(), search, setSearch });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const titles = () =>
  [...container.querySelectorAll('.bet-title-cell strong')].map((el) => el.textContent);
const sourceSelect = () =>
  container.querySelector('.entry-source-filter select') as unknown as {
    value: string;
    dispatchEvent(event: Event): boolean;
  };
async function selectSource(source: string) {
  await act(async () => {
    sourceSelect().value = source;
    sourceSelect().dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function clickButton(prefix: string) {
  const button = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.startsWith(prefix),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search ledger"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ledger entry source filtering', () => {
  it('shows the automatically recorded source in every row that has one', () => {
    expect(titles()).toHaveLength(6);
    expect(
      [...container.querySelectorAll('.bet-entry-source')].map((el) => el.textContent),
    ).toEqual([
      'Entered via: Browser (inferred)',
      'Entered via: CLI',
      'Entered via: MCP (reported)',
      'Entered via: MCP',
      'Entered via: MCP',
    ]);
  });

  it.each([
    ['browser', ['Browser launch wager']],
    ['cli', ['CLI launch wager']],
    ['mcp', ['MCP launch wager', 'MCP pending wager', 'MCP other members wager']],
    ['unrecorded', ['Older launch wager']],
  ])('filters %s and returns to all sources', async (source, expected) => {
    await selectSource(source as string);
    expect(titles()).toEqual(expected);
    await selectSource('all');
    expect(titles()).toHaveLength(6);
  });

  it('combines source with status, membership, and text search', async () => {
    await selectSource('mcp');
    await clickButton('In play');
    expect(titles()).toEqual(['MCP launch wager', 'MCP other members wager']);
    await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    expect(titles()).toEqual(['MCP launch wager']);
    await search('launch');
    expect(titles()).toEqual(['MCP launch wager']);
    await search('no matching title');
    expect(titles()).toEqual([]);
    await clickButton('Clear filters');
    expect(titles()).toHaveLength(6);
    expect(sourceSelect().value).toBe('all');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Search ledger"]')!.value).toBe(
      '',
    );
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(false);
  });
});

describe('BetTable rows', () => {
  const owed = demo.bets.find((bet) => bet.status === 'owed')!;
  const offsetBet: Bet = {
    ...owed,
    id: 'offset-bet',
    title: 'Offset wager',
    creatorId: 'ellis',
    opponentId: 'sarah',
    stake: 3,
    entrySource: 'cli',
    resolution: {
      winnerId: 'ellis',
      note: 'Done',
      proposedBy: 'ellis',
      approvals: ['ellis', 'sarah'],
    },
    agreementApprovals: ['ellis', 'sarah'],
    offsets: [
      {
        id: 'offset-1',
        actorId: 'ellis',
        at: '2026-10-01T12:00:00.000Z',
        references: {},
        counterpartyId: 'sarah',
        rolls: 2,
        allocations: [{ betId: 'offset-bet', version: 1, rolls: 2 }],
      },
    ],
  };
  const unrecorded: Bet = {
    ...offsetBet,
    id: 'unrecorded-bet',
    title: 'Unrecorded wager',
    entrySource: undefined,
    offsets: undefined,
    status: 'pending',
  };

  const inferredOnly: Bet = {
    ...unrecorded,
    id: 'inferred-only-bet',
    title: 'Inferred only wager',
    entrySourceInference: {
      basis: 'before_cli_release',
      cutoffAt: '2025-01-15T12:00:00.000Z',
      evidenceUrl: 'https://example.org/runs/12345',
      inferredAt: '2026-10-15T17:00:00.000Z',
    },
    entrySourceReport: {
      basis: 'user_report',
      note: 'Entered via MCP.',
      reportedAt: '2026-10-15T17:00:00.000Z',
    },
  };

  async function renderTable(props: Partial<Parameters<typeof BetTable>[0]> = {}) {
    await act(async () =>
      root.render(
        createElement(BetTable, {
          bets: [offsetBet, unrecorded],
          state: { ...state, bets: [offsetBet, unrecorded] },
          onBet: vi.fn(),
          memberId: 'ellis',
          compact: true,
          ...props,
        }),
      ),
    );
  }
  const rows = () => [...container.querySelectorAll<HTMLElement>('.bet-row')];

  it('keeps the offset note in the meta line instead of the stake cell', async () => {
    await renderTable();
    const [row] = rows();
    expect(row.querySelector('.bet-meta')!.textContent).toContain('1 remaining · 2 offset');
    expect(row.querySelector('.stake-cell')!.textContent).not.toMatch(/remaining|offset/);
    expect(row.querySelector('.stake-cell')!.textContent).toBe('3');
    expect(row.querySelector('.offset-stake-note')).toBeNull();
  });

  it('omits the entry source when it was never recorded', async () => {
    await renderTable();
    const [recorded, legacy] = rows();
    expect(recorded.querySelector('.bet-entry-source')!.textContent).toBe('Entered via: CLI');
    expect(legacy.querySelector('.bet-entry-source')).toBeNull();
    expect(legacy.textContent).not.toContain('Entered via');
    expect(legacy.textContent).not.toContain('Not recorded');
  });

  it('omits the entry source when only an inference or report exists without a source', async () => {
    await renderTable({
      bets: [inferredOnly],
      state: { ...state, bets: [inferredOnly] },
    });
    expect(rows()[0].querySelector('.bet-entry-source')).toBeNull();
    expect(rows()[0].textContent).not.toContain('Not recorded');
  });

  it('describes the row button with its meta line so the counterparty and offset reach assistive technology', async () => {
    await renderTable();
    const [first, second] = rows();
    const describedBy = (row: HTMLElement) => {
      const id = row.querySelector('.bet-title-cell')!.getAttribute('aria-describedby');
      expect(id).toBeTruthy();
      return document.getElementById(id!);
    };
    // The button is named by its aria-label, which masks its own children; the description is not.
    expect(describedBy(first)).toBe(first.querySelector('.bet-meta'));
    expect(describedBy(first)!.textContent).toContain('with Sarah');
    expect(describedBy(first)!.textContent).toContain('1 remaining · 2 offset');
    expect(describedBy(second)).toBe(second.querySelector('.bet-meta'));
    expect(describedBy(first)!.id).not.toBe(describedBy(second)!.id);
  });

  it('keeps the description ids apart when two tables list the same bet', async () => {
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          ...[0, 1].map((key) =>
            createElement(BetTable, {
              key,
              bets: [offsetBet],
              state: { ...state, bets: [offsetBet] },
              onBet: vi.fn(),
              memberId: 'ellis',
              compact: true,
            }),
          ),
        ),
      ),
    );
    const ids = [...container.querySelectorAll('.bet-title-cell')].map((el) =>
      el.getAttribute('aria-describedby'),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });

  it('names the counterparty in the meta line for a participant', async () => {
    await renderTable();
    expect(rows()[0].querySelector('.bet-with')!.textContent).toBe('with Sarah');
    await renderTable({ memberId: 'sarah' });
    expect(rows()[0].querySelector('.bet-with')!.textContent).toBe('with Ellis');
  });

  it('names both bettors for a viewer who is not one of them', async () => {
    await renderTable({ memberId: 'james' });
    expect(rows()[0].querySelector('.bet-with')!.textContent).toBe('Ellis vs Sarah');
    await renderTable({ memberId: undefined });
    expect(rows()[0].querySelector('.bet-with')!.textContent).toBe('Ellis vs Sarah');
  });

  it('hides the decorative avatars from assistive technology', async () => {
    await renderTable({ compact: false });
    const avatars = [...container.querySelectorAll('.bet-people .avatar')];
    expect(avatars).toHaveLength(4);
    for (const avatar of avatars) expect(avatar.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('.bet-people')!.textContent).toContain('Ellis');
  });

  it('shows the remaining rolls as the primary number in remaining mode', async () => {
    await renderTable({ stakeMode: 'remaining' });
    const [row] = rows();
    expect(getRemainingRolls(offsetBet)).toBe(1);
    expect(row.querySelector('.stake-cell')!.textContent).toBe('1');
    expect(row.querySelector('.bet-meta')!.textContent).toContain('3 staked · 2 offset');
    expect(container.querySelector('.bet-table-head')!.textContent).toContain('Remaining');
  });

  it('labels a delivery under confirmation so it cannot be mistaken for "To settle"', async () => {
    const settling: Bet = {
      ...offsetBet,
      id: 'settling-bet',
      status: 'settling',
      offsets: undefined,
    };
    await renderTable({ bets: [settling], state: { ...state, bets: [settling] } });
    expect(rows()[0].querySelector('.status-badge')!.textContent).toBe('Delivering');
    await renderTable({ bets: [settling], state: { ...state, bets: [settling] }, compact: false });
    expect(rows()[0].querySelector('.status-badge')!.textContent).toBe('Confirming delivery');
  });

  it('uses short status labels in compact tables only', async () => {
    await renderTable();
    expect(rows()[1].querySelector('.status-badge')!.textContent).toBe('Pending');
    expect(rows()[0].querySelector('.status-badge')!.textContent).toBe('To settle');
    await renderTable({ compact: false });
    expect(rows()[1].querySelector('.status-badge')!.textContent).toBe('Pending agreement');
    expect(rows()[0].querySelector('.status-badge')!.textContent).toBe('Ready to settle');
  });
});

describe('Balances view', () => {
  /** A confirmed result where `loserId` owes `winnerId` the stake. */
  function owed(
    people: Member[],
    loserId: string,
    winnerId: string,
    stake: number,
    title: string,
  ): Bet {
    let bet = createBet(
      {
        title,
        terms: 'The official result determines who won.',
        category: 'Life',
        creatorSide: 'Yes',
        opponentSide: 'No',
        opponentId: winnerId,
        stake,
        deadline: '2026-10-01',
      },
      loserId,
      people,
      '2026-10-01T12:00:00Z',
    );
    bet = applyAction(bet, { type: 'accept' }, winnerId);
    bet = applyAction(bet, { type: 'propose_result', winnerId, note: 'Official result.' }, loserId);
    return applyAction(bet, { type: 'confirm_result' }, winnerId);
  }
  async function renderBalances(
    bets: Bet[],
    memberId = 'ellis',
    members: Member[] = demo.members,
    onNewBet?: () => void,
  ) {
    await act(async () =>
      root.render(
        createElement(BalancesView, {
          state: { ...demo, members, bets },
          memberId,
          onBet: vi.fn(),
          onOffset: vi.fn(),
          onNewBet,
        }),
      ),
    );
  }
  const strip = () =>
    [...container.querySelectorAll('.balance-summary > div')].map((tile) => [
      tile.querySelector('span')!.textContent,
      tile.querySelector('strong')!.textContent,
    ]);
  const settleRow = (title: string) =>
    [...container.querySelectorAll<HTMLElement>('.bet-row')].find((row) =>
      row.textContent?.includes(title),
    )!;

  it('pluralises the summary and names the two net metrics apart', async () => {
    await renderBalances([
      owed(demo.members, 'sarah', 'ellis', 2, 'Sarah pays'),
      owed(demo.members, 'ellis', 'olivia', 1, 'Ellis pays'),
    ]);
    expect(strip()).toEqual([
      ['Owed to you', '2 rolls'],
      ['You owe', '1 roll'],
      ['Outstanding balance', '+1 roll'],
    ]);
    await renderBalances([owed(demo.members, 'ellis', 'olivia', 3, 'Ellis pays')]);
    expect(strip()[2]).toEqual(['Outstanding balance', '−3 rolls']);
    await renderBalances([]);
    expect(strip()).toEqual([
      ['Owed to you', '0 rolls'],
      ['You owe', '0 rolls'],
      ['Outstanding balance', '0 rolls'],
    ]);
  });

  it('colours each strip figure by direction, as the rows below do, and leaves zero neutral', async () => {
    const tones = () =>
      [...container.querySelectorAll('.balance-summary > div strong')].map((figure) =>
        [...figure.classList].filter((name) => ['green', 'red'].includes(name)).join(''),
      );
    // Owed to you reads green, what you owe reads red, and a surplus nets to green.
    await renderBalances([
      owed(demo.members, 'sarah', 'ellis', 2, 'Sarah pays'),
      owed(demo.members, 'ellis', 'olivia', 1, 'Ellis pays'),
    ]);
    expect(tones()).toEqual(['green', 'red', 'green']);
    // Owing more than you are owed nets to red; nothing owed to you is not good news.
    await renderBalances([owed(demo.members, 'ellis', 'olivia', 3, 'Ellis pays')]);
    expect(tones()).toEqual(['', 'red', 'red']);
    // Equal and opposite is neutral, and so is an empty ledger.
    await renderBalances([
      owed(demo.members, 'sarah', 'ellis', 1, 'Sarah pays'),
      owed(demo.members, 'ellis', 'olivia', 1, 'Ellis pays'),
    ]);
    expect(tones()).toEqual(['green', 'red', '']);
    await renderBalances([]);
    expect(tones()).toEqual(['', '', '']);
  });

  it('reads each debt with its direction and unit', async () => {
    await renderBalances([
      owed(demo.members, 'sarah', 'ellis', 1, 'Sarah pays'),
      owed(demo.members, 'ellis', 'olivia', 2, 'Ellis pays'),
      owed(demo.members, 'alex', 'marcus', 1, 'Alex pays'),
    ]);
    const people = [...container.querySelectorAll('.person-balance')].map((row) => row.textContent);
    expect(people).toEqual([expect.stringMatching(/2 rolls$/), expect.stringMatching(/1 roll$/)]);
    const [around] = [...container.querySelectorAll('.group-balance')];
    expect(around.textContent).toMatch(/owes/);
    expect(around.textContent).toMatch(/rolls?$/);
    expect(around.querySelector('.sr-only')).not.toBeNull();
    // The initials in the avatars add nothing once the names are there.
    for (const avatar of container.querySelectorAll(
      '.person-balance .avatar, .group-balance .avatar',
    ))
      expect(avatar.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('says on a debt row that a delivery has been reported, and whose confirmation it waits on', async () => {
    const delivered = (loserId: string, winnerId: string, stake: number, title: string) =>
      applyAction(
        owed(demo.members, loserId, winnerId, stake, title),
        { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
        loserId,
      );
    await renderBalances([
      // Ellis is owed 1 more by Marcus, who has reported delivering a different 2.
      owed(demo.members, 'marcus', 'ellis', 1, 'Marcus still owes'),
      delivered('marcus', 'ellis', 2, 'Marcus delivers'),
      delivered('ellis', 'olivia', 1, 'Ellis delivers'),
      owed(demo.members, 'sarah', 'ellis', 2, 'Sarah pays'),
    ]);
    const note = (row: Element) => row.querySelector('.balance-pending')?.textContent;
    const yours = [...container.querySelectorAll('.person-balance')];
    const byName = (name: string) => yours.find((row) => row.textContent?.includes(name))!;
    // Only the rolls whose delivery is reported are named; the other bet is still just owed.
    expect(note(byName('Marcus'))).toBe('Delivery reported for 2 rolls · needs your confirmation');
    expect(note(byName('Marcus'))).not.toContain('3');
    expect(byName('Marcus').textContent).toContain('3 rolls');
    expect(note(byName('Olivia'))).toBe('Delivery reported for 1 roll · awaiting confirmation');
    expect(note(byName('Sarah'))).toBeUndefined();
    // Around the table says the same, from the same facts.
    const around = [...container.querySelectorAll('.group-balance')];
    const aroundFor = (name: string) => around.find((row) => row.textContent?.includes(name))!;
    expect(note(aroundFor('Marcus'))).toBe(
      'Delivery reported for 2 rolls · needs your confirmation',
    );
    expect(note(aroundFor('Olivia'))).toBe('Delivery reported for 1 roll · awaiting confirmation');
    expect(note(aroundFor('Sarah'))).toBeUndefined();
    // Someone who is not in the pair has nothing to confirm.
    await renderBalances([delivered('marcus', 'ellis', 2, 'Marcus delivers')], 'james');
    expect(note(container.querySelector('.group-balance')!)).toBe(
      'Delivery reported for 2 rolls · awaiting confirmation',
    );
  });

  it('marks the direction of each settle row and whose move it is', async () => {
    const delivering = applyAction(
      owed(demo.members, 'marcus', 'ellis', 1, 'Marcus delivers'),
      { type: 'propose_settlement', method: 'roll', note: 'Delivered.' },
      'marcus',
    );
    await renderBalances([
      owed(demo.members, 'sarah', 'ellis', 2, 'Sarah pays'),
      owed(demo.members, 'ellis', 'olivia', 1, 'Ellis pays'),
      delivering,
    ]);
    const tags = (title: string) => ({
      direction: settleRow(title).querySelector('.bet-direction')?.textContent,
      move: settleRow(title).querySelector('.bet-turn')?.textContent,
    });
    // Owed to you and nothing for you to do yet.
    expect(tags('Sarah pays')).toEqual({ direction: 'Owes you', move: undefined });
    // You are the loser, but owed rolls are never prompted (owner decision 4).
    expect(tags('Ellis pays')).toEqual({ direction: 'You owe', move: undefined });
    // A reported delivery waits on the winner's confirmation.
    expect(tags('Marcus delivers')).toEqual({ direction: 'Owes you', move: 'Your move' });
    // The tags sit in the meta line the row button is described by.
    const describedBy = (title: string) =>
      document.getElementById(
        settleRow(title).querySelector('.bet-title-cell')!.getAttribute('aria-describedby')!,
      )!.textContent;
    expect(describedBy('Ellis pays')).toContain('You owe');
    expect(describedBy('Ellis pays')).not.toContain('Your move');
    expect(describedBy('Marcus delivers')).toContain('Your move');
    // Remaining rolls lead the stakes column.
    expect(container.querySelector('.bet-table-head')!.textContent).toContain('Remaining');
  });

  it('keeps the settle tags out of the ledger table', async () => {
    await act(async () =>
      root.render(
        createElement(BetTable, {
          bets: [owed(demo.members, 'ellis', 'olivia', 1, 'Ellis pays')],
          state: demo,
          onBet: vi.fn(),
          memberId: 'ellis',
        }),
      ),
    );
    expect(container.querySelector('.bet-direction, .bet-turn')).toBeNull();
  });

  it('tells apart two members who share a first name', async () => {
    const twins = demo.members.map((member) =>
      member.id === 'alex'
        ? { ...member, name: 'Alex Chen' }
        : member.id === 'sarah'
          ? { ...member, name: 'Alex Rivera' }
          : member,
    );
    await renderBalances(
      [
        owed(twins, 'alex', 'ellis', 3, 'Chen pays'),
        owed(twins, 'sarah', 'ellis', 2, 'Rivera pays'),
      ],
      'ellis',
      twins,
    );
    const rows = [...container.querySelectorAll('.group-balance')].map((row) => row.textContent);
    expect(rows).toEqual([expect.stringContaining('Alex C.'), expect.stringContaining('Alex R.')]);
    expect(rows.join()).not.toMatch(/Alex(?! [CR]\.)/);
    expect(settleRow('Chen pays').querySelector('.bet-with')!.textContent).toBe('with Alex C.');
    expect(settleRow('Rivera pays').querySelector('.bet-with')!.textContent).toBe('with Alex R.');
  });

  it('falls back to full names when the initial would still collide', async () => {
    const twins = demo.members.map((member) =>
      member.id === 'alex'
        ? { ...member, name: 'Alex Chen' }
        : member.id === 'sarah'
          ? { ...member, name: 'Alex Cole' }
          : member,
    );
    await renderBalances(
      [owed(twins, 'alex', 'ellis', 3, 'Chen pays'), owed(twins, 'sarah', 'ellis', 2, 'Cole pays')],
      'ellis',
      twins,
    );
    const rows = [...container.querySelectorAll('.group-balance')].map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('Alex Chen'),
      expect.stringContaining('Alex Cole'),
    ]);
  });

  it('shows an empty state in both panels when there are no debts', async () => {
    await renderBalances([]);
    const panels = [...container.querySelectorAll('.balance-columns > .panel')];
    expect(panels).toHaveLength(2);
    for (const panel of panels) expect(panel.querySelector('.empty-state')).not.toBeNull();
    expect(container.querySelector('.balance-columns .panel-subtitle')).toBeNull();
  });

  it('words the empty states for both sides of a debt and offers one first step', async () => {
    const onNewBet = vi.fn();
    await renderBalances([], 'ellis', demo.members, onNewBet);
    const [yours, around] = [...container.querySelectorAll('.balance-columns > .panel')];
    // Not only "a roll to collect": it covers owing as well as being owed.
    expect(yours.querySelector('.empty-state p')!.textContent).toMatch(/nobody owes you/i);
    expect(yours.querySelector('.empty-state p')!.textContent).toMatch(/you owe nobody/i);
    // The other empty states say what fills them instead of leaving a dead end.
    expect(around.querySelector('.empty-state p')!.textContent).toMatch(
      /once both bettors confirm/i,
    );
    expect(container.textContent).toMatch(/confirmed result will land here/i);
    // The one action is the first step: start a bet.
    const start = [...container.querySelectorAll('.empty-state button')];
    expect(start.map((el) => el.textContent)).toEqual(['Start a bet']);
    await act(async () => (start[0] as HTMLButtonElement).click());
    expect(onNewBet).toHaveBeenCalledOnce();
  });

  it('offers no first step when the page cannot start a bet', async () => {
    await renderBalances([]);
    expect(container.querySelector('.empty-state button')).toBeNull();
  });

  it('caps Around the table at six rows, viewer first, and shows the rest on request', async () => {
    const pairs = demo.members
      .flatMap((loser) =>
        demo.members.filter((winner) => winner !== loser).map((winner) => [loser, winner]),
      )
      .slice(0, 18);
    const bets = pairs.map(([loser, winner], index) =>
      owed(demo.members, loser.id, winner.id, 1, `Debt ${index + 1}`),
    );
    await renderBalances(bets, 'james');
    const rows = () => [...container.querySelectorAll('.group-balance')];
    expect(rows()).toHaveLength(6);
    // Everyone James is part of comes before anyone else's debts.
    expect(
      rows()
        .slice(0, 3)
        .every((row) => row.textContent!.includes('James')),
    ).toBe(true);
    expect(rows()[3].textContent).not.toContain('James');
    const toggle = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.startsWith('Show all'),
    )!;
    expect(toggle.textContent).toBe('Show all 18');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(rows()).toHaveLength(18);
    expect(toggle.textContent).toBe('Show fewer');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle.click());
    expect(rows()).toHaveLength(6);
  });

  it('offers no toggle when everything fits', async () => {
    await renderBalances([owed(demo.members, 'sarah', 'ellis', 1, 'Sarah pays')]);
    expect(
      [...container.querySelectorAll('button')].some((el) => el.textContent?.startsWith('Show')),
    ).toBe(false);
  });

  it('names the Overview figures the way the Balances page does', async () => {
    await act(async () =>
      root.render(
        createElement(Overview, {
          state: {
            ...demo,
            bets: [
              owed(demo.members, 'sarah', 'ellis', 2, 'Sarah pays'),
              owed(demo.members, 'ellis', 'olivia', 1, 'Ellis pays'),
            ],
          },
          memberId: 'ellis',
          onBet: vi.fn(),
          onNavigate: vi.fn(),
        }),
      ),
    );
    // What you are owed less what you owe is the Balances figure, under the same name.
    const hero = container.querySelector('.balance-feature .stat-label')!;
    expect(hero.textContent).toBe('Outstanding balance');
    expect(container.textContent).not.toContain('net position');
    // The leaderboard's figure is a different measure, so it says so and does not borrow a sign ink.
    const board = container.querySelector('.leaderboard-preview')!;
    expect(board.querySelector('.section-title p')!.textContent).toMatch(/all-time net/i);
    const scores = [...board.querySelectorAll('.leader-score')];
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) expect(score.className).toBe('leader-score');
  });
});

// ---------------------------------------------------------------------------------------------
// Panels: Over to you, Your next moves, the ledger controls and the activity feed.
// ---------------------------------------------------------------------------------------------
const T0 = '2026-09-01T12:00:00.000Z';
const DUE = '2026-09-13T12:00:00.000Z';
const NOW = '2026-10-18T12:00:00.000Z';
const proposal = (
  creator: string,
  opponent: string,
  over: Partial<NewBet> & { at?: string } = {},
) => {
  const { at = T0, ...rest } = over;
  return createBet(
    {
      title: 'Friday release',
      terms: 'Ships by the agreed cutoff.',
      category: 'Work',
      opponentId: opponent,
      creatorSide: 'Ships',
      opponentSide: 'Delayed',
      stake: 2,
      timing: { kind: 'date', at: DUE, timezone: 'UTC' },
      ...rest,
    },
    creator,
    demo.members,
    at,
  );
};
const agreed = (creator: string, opponent: string, over: Partial<NewBet> = {}) =>
  applyAction(proposal(creator, opponent, over), { type: 'accept' }, opponent, T0);
const confirming = (creator: string, opponent: string, over: Partial<NewBet> = {}) =>
  applyAction(
    agreed(creator, opponent, over),
    { type: 'propose_result', winnerId: creator, note: 'Shipped on Thursday.' },
    creator,
    DUE,
  );
const owed = (creator: string, opponent: string, over: Partial<NewBet> = {}) =>
  applyAction(confirming(creator, opponent, over), { type: 'confirm_result' }, opponent, DUE);
const ledgerOf = (...bets: Bet[]): LedgerState => ({ ...demo, bets });

const noop = () => {};
async function renderOverview(bets: Bet[], props: Partial<Parameters<typeof Overview>[0]> = {}) {
  await act(async () =>
    root.render(
      createElement(Overview, {
        state: ledgerOf(...bets),
        memberId: 'ellis',
        onBet: noop,
        onNavigate: noop,
        now: NOW,
        ...props,
      }),
    ),
  );
}
async function renderInbox(bets: Bet[], props: Partial<Parameters<typeof InboxView>[0]> = {}) {
  await act(async () =>
    root.render(
      createElement(InboxView, {
        state: ledgerOf(...bets),
        memberId: 'ellis',
        onBet: noop,
        now: NOW,
        ...props,
      }),
    ),
  );
}
const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttonWith = (scope: Element, label: string) =>
  [...scope.querySelectorAll('button')].find((el) => text(el).startsWith(label));

describe('Over to you and Your next moves share one ActionItem', () => {
  it('prints the same duty text for a bet in the Overview and in the Inbox', async () => {
    const bet = confirming('alex', 'ellis');
    await renderOverview([bet]);
    const overview = text(container.querySelector('.approvals-panel .action-item-meta'));
    await renderInbox([bet]);
    const inbox = text(container.querySelector('.action-item-meta'));
    expect(overview).toBe('Confirm a result · 2 rolls · Alex is waiting for you');
    expect(inbox).toBe(overview);
  });

  it('joins a count to its noun, so a narrow card never ends a line on "1" or "2"', async () => {
    await renderOverview([confirming('alex', 'ellis', { stake: 1 })]);
    const raw = (selector: string) => container.querySelector(selector)!.textContent!;
    // A no-break space, not a plain one: the words are the same, the line just cannot split there.
    expect(raw('.approvals-panel .action-item-meta')).toContain(' · 1 roll · ');
    expect(raw('.approvals-panel .action-item-meta')).not.toContain('1 roll');
    expect(raw('.approvals-panel .action-item-age')).toMatch(/^Updated \d+ days ago$/);
  });

  it('reads "Alex vs James · you are the judge" on a judge card', async () => {
    const bet = applyAction(
      proposal('alex', 'james', { decisionMethod: 'judge', judgeId: 'ellis' }),
      { type: 'accept' },
      'james',
      T0,
    );
    await renderOverview([bet]);
    expect(text(container.querySelector('.approvals-panel .action-item-meta'))).toContain(
      'Alex vs James · you are the judge',
    );
    expect(container.querySelector('.approvals-panel .action-item-meta')!.textContent).not.toMatch(
      /is waiting for you/,
    );
  });

  it('shows who proposed an amendment rather than assuming it was the creator', async () => {
    const bet = applyAction(
      agreed('alex', 'ellis'),
      {
        type: 'propose_amendment',
        terms: 'Ships by the agreed cutoff, per the release log.',
        timing: { kind: 'date', at: DUE, timezone: 'UTC' },
        note: 'Name the source.',
      },
      'ellis',
      T0,
    );
    // Ellis proposed it, so it is Alex's move and Ellis has nothing to do.
    await renderOverview([bet], { memberId: 'alex' });
    expect(text(container.querySelector('.action-item-meta'))).toBe(
      'Review revised terms · 2 rolls · Ellis is waiting for you',
    );
  });

  it('sorts by duty type, then by the longest-waiting bet first', async () => {
    // Ellis won this one and Sarah reported the delivery, so confirming it is Ellis's move.
    const delivery = applyAction(
      owed('ellis', 'sarah', { title: 'Delivery duty' }),
      { type: 'propose_settlement', method: 'roll', note: 'Two rolls at lunch.' },
      'sarah',
      '2026-09-14T12:00:00.000Z',
    );
    const bets = [
      // The oldest bet, but a decision on an agreed bet comes after the handshakes owed first.
      agreed('alex', 'ellis', { title: 'Outcome duty' }),
      delivery,
      confirming('alex', 'ellis', { title: 'Result duty' }),
      proposal('sarah', 'ellis', { title: 'Newer proposal', at: '2026-09-05T12:00:00.000Z' }),
      proposal('alex', 'ellis', { title: 'Older proposal', at: '2026-09-01T12:00:00.000Z' }),
    ];
    await renderInbox(bets);
    const titles = [...container.querySelectorAll('.action-item-title')].map(text);
    expect(titles).toEqual([
      'Older proposal',
      'Newer proposal',
      'Result duty',
      'Delivery duty',
      'Outcome duty',
    ]);
  });

  it('never lists owed rolls as a next move, for the debtor or the winner', async () => {
    const bet = owed('sarah', 'ellis', { title: 'Rolls owed' });
    for (const memberId of ['ellis', 'sarah']) {
      await renderOverview([bet], { memberId });
      expect(container.querySelectorAll('.approvals-panel .action-item')).toHaveLength(0);
      await renderInbox([bet], { memberId });
      expect(container.querySelectorAll('.inbox-next-moves .action-item')).toHaveLength(0);
      expect(text(container.querySelector('.inbox-next-moves'))).not.toMatch(/Rolls owed/);
    }
  });

  it('caps Over to you at three, says so, and sends the rest to the inbox', async () => {
    const onNavigate = vi.fn();
    const bets = ['One bet', 'Two bets', 'Three bets', 'Four bets'].map((title, index) =>
      proposal('alex', 'ellis', { title, at: `2026-09-0${index + 1}T12:00:00.000Z` }),
    );
    await renderOverview(bets, { onNavigate });
    expect(container.querySelectorAll('.approvals-panel .action-item')).toHaveLength(3);
    expect(text(container.querySelector('.approvals-panel'))).toContain('Showing 3 of 4');
    await act(async () => buttonWith(container, 'See all 4 in your inbox')!.click());
    expect(onNavigate).toHaveBeenCalledWith('inbox');
  });

  it('uses the shared empty state instead of an amber "0 actions waiting" count', async () => {
    await renderOverview([proposal('alex', 'sarah', { title: 'Not your bet' })]);
    const panel = container.querySelector('.approvals-panel')!;
    expect(panel.querySelector('.empty-state h3')?.textContent).toBe('You’re all caught up');
    expect(panel.querySelector('.approval-count')).toBeNull();
    expect(panel.textContent).not.toContain('0 actions waiting');
  });

  it.each([
    [
      'a ledger where nothing waits on the member',
      [proposal('alex', 'sarah', { title: 'Theirs' })],
    ],
    ['an empty ledger', []],
  ])('says the same words in both places for %s', async (_label, bets) => {
    await renderOverview(bets);
    const overview = text(container.querySelector('.approvals-panel .empty-state'));
    await renderInbox(bets);
    const inbox = text(container.querySelector('.inbox-next-moves .empty-state'));
    expect(overview.length).toBeGreaterThan(0);
    expect(inbox).toBe(overview);
  });

  it('counts a single action in the singular', async () => {
    await renderOverview([proposal('alex', 'ellis')]);
    expect(text(container.querySelector('.approval-count'))).toBe('1 action waiting');
  });

  it('puts the status chip and the age on the expanded Inbox row only', async () => {
    const bet = confirming('alex', 'ellis');
    await renderInbox([bet]);
    const row = container.querySelector('.action-item-expanded')!;
    expect(text(row.querySelector('.status-badge'))).toBe('Confirming result');
    expect(text(row.querySelector('.action-item-age'))).toMatch(/^Updated 35 days ago$/);
    await renderOverview([bet]);
    expect(container.querySelector('.approvals-panel .status-badge')).toBeNull();
  });

  it('hides the avatar initials from the card name', async () => {
    await renderOverview([confirming('alex', 'ellis')]);
    const card = container.querySelector('.approvals-panel .action-item')!;
    expect(card.querySelector('.avatar')!.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('Waiting on…', () => {
  const dated = [15, 16, 17, 18].map((day) =>
    agreed('ellis', 'sarah', {
      title: `Dated ${day}`,
      timing: { kind: 'date', at: `2026-12-${day}T12:00:00.000Z`, timezone: 'UTC' },
    }),
  );
  const event = agreed('ellis', 'olivia', {
    title: 'Event bet',
    timing: { kind: 'event', description: 'The acquisition closes' },
  });
  const rows = () => [...container.querySelectorAll('.waiting-bet')];

  it('shows the date the list is sorted by, without a repeated timezone', async () => {
    await renderOverview([dated[1], dated[0]]);
    expect(rows().map((row) => text(row.querySelector('strong')))).toEqual([
      'Dated 15',
      'Dated 16',
    ]);
    const first = text(rows()[0]);
    expect(first).toContain('Decision time Dec 15');
    expect(first).toContain('UTC');
    expect(first).not.toContain('(UTC)');
  });

  it('labels a check-in or claim cutoff as that rather than as the decision time', async () => {
    const withCutoff = agreed('ellis', 'sarah', {
      title: 'Cutoff first',
      timing: { kind: 'evidence', description: 'The press release' },
      cutoff: { at: '2026-11-20T12:00:00.000Z', timezone: 'UTC' },
    });
    await renderOverview([withCutoff]);
    expect(text(rows()[0])).toContain('Claim cutoff Nov 20');
    expect(text(rows()[0])).toContain('The press release');
  });

  it('names the real decision time on a bet you judge, not the bettors’ passed check-in', async () => {
    const judged = (title: string, at: string, checkIn?: string) =>
      agreed('alex', 'james', {
        title,
        decisionMethod: 'judge',
        judgeId: 'ellis',
        timing: {
          kind: 'date',
          at,
          timezone: 'UTC',
          ...(checkIn ? { checkIn: { at: checkIn, timezone: 'UTC' } } : {}),
        },
      });
    // The late bet's shared check-in (Oct 10) is before NOW (Oct 18): the bettors' reminder, not the judge's.
    await renderOverview([
      judged('Judged late', '2026-12-20T12:00:00.000Z', '2026-10-10T12:00:00.000Z'),
      judged('Judged early', '2026-12-10T12:00:00.000Z'),
    ]);
    expect(rows().map((row) => text(row.querySelector('strong')))).toEqual([
      'Judged early',
      'Judged late',
    ]);
    const late = text(rows()[1]);
    expect(late).toContain('Decision time Dec 20');
    expect(late).not.toMatch(/check-in/i);
  });

  it('calls the agreed check-in initial, and only a check-in you set yours', async () => {
    const shared = agreed('ellis', 'sarah', {
      title: 'Shared check-in',
      timing: {
        kind: 'date',
        at: '2026-12-15T12:00:00.000Z',
        timezone: 'UTC',
        checkIn: { at: '2026-10-28T12:00:00.000Z', timezone: 'UTC' },
      },
    });
    const personal = applyAction(
      agreed('ellis', 'olivia', {
        title: 'Personal check-in',
        timing: { kind: 'date', at: '2026-12-16T12:00:00.000Z', timezone: 'UTC' },
      }),
      { type: 'set_check_in', checkIn: { at: '2026-10-30T12:00:00.000Z', timezone: 'UTC' } },
      'ellis',
      T0,
    );
    await renderOverview([shared, personal]);
    const note = (title: string) => text(rows().find((row) => text(row).includes(title)));
    expect(note('Shared check-in')).toContain('Initial check-in Oct 28');
    expect(note('Shared check-in')).not.toContain('Your check-in');
    expect(note('Personal check-in')).toContain('Your check-in Oct 30');
  });

  it('says so when the date a row is sorted by has already passed', async () => {
    const judged = agreed('alex', 'james', {
      title: 'Cutoff gone',
      decisionMethod: 'judge',
      judgeId: 'ellis',
      timing: { kind: 'event', description: 'The merger closes' },
      cutoff: { at: '2026-10-15T12:00:00.000Z', timezone: 'UTC' },
    });
    await renderOverview([judged]);
    expect(text(rows()[0])).toContain('Claim cutoff passed Oct 15');
    expect(text(rows()[0])).toContain('Waits for: The merger closes');
  });

  describe('a judged bet that is now on the judge', () => {
    const judgedDue = (over: Partial<NewBet> = {}) =>
      agreed('ellis', 'alex', {
        title: 'Judge is due',
        decisionMethod: 'judge',
        judgeId: 'sarah',
        timing: { kind: 'date', at: '2026-10-10T12:00:00.000Z', timezone: 'UTC' },
        ...over,
      });

    it('stays in both bettors’ lists, saying the judge has had it since the decision time', async () => {
      for (const memberId of ['ellis', 'alex']) {
        await renderOverview([judgedDue()], { memberId });
        expect(rows()).toHaveLength(1);
        expect(text(rows()[0].querySelector('strong'))).toBe('Judge is due');
        expect(text(rows()[0])).toContain(
          'Waiting on Sarah’s recommendation since Oct 10, 12:00 PM UTC',
        );
      }
    });

    it('asks nothing of a bettor: no duty card, no count, and no claim that it is theirs', async () => {
      await renderOverview([judgedDue()]);
      expect(container.querySelector('.approvals-panel .action-item')).toBeNull();
      expect(text(container.querySelector('.approvals-panel [role="status"]'))).toBe(
        'No actions waiting',
      );
      expect(text(rows()[0])).not.toMatch(/check-in|Your /i);
    });

    it('is the judge’s duty rather than a waiting row for the judge', async () => {
      await renderOverview([judgedDue()], { memberId: 'sarah' });
      expect(rows()).toHaveLength(0);
      expect(text(container.querySelector('.approvals-panel .action-item-meta'))).toContain(
        'Record your recommendation',
      );
    });

    it('leads the list, ahead of bets whose date is still to come', async () => {
      await renderOverview([dated[0], judgedDue()]);
      expect(rows().map((row) => text(row.querySelector('strong')))).toEqual([
        'Judge is due',
        'Dated 15',
      ]);
    });

    it('gives the time and zone the evidence was marked ready, as the decision time is given', async () => {
      const marked = applyAction(
        agreed('ellis', 'alex', {
          title: 'Evidence is in',
          decisionMethod: 'judge',
          judgeId: 'sarah',
          timing: { kind: 'evidence', description: 'The press release' },
        }),
        { type: 'mark_ready', evidence: 'The release went out on Oct 12.' },
        'alex',
        '2026-10-12T12:00:00.000Z',
      );
      const [dated, evidence] = [judgedDue(), marked];
      await renderOverview([dated], { memberId: 'ellis' });
      const decision = text(rows()[0]);
      await renderOverview([evidence], { memberId: 'ellis' });
      const ready = text(rows()[0]);
      // Both read "since <date>, <time> <zone>": the same shape, so the rows do not look unlike.
      const shape = /since [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M \S+$/;
      expect(decision).toMatch(shape);
      expect(ready).toMatch(shape);
    });

    it('names the day the evidence was marked ready, for a bet with no decision date', async () => {
      const marked = applyAction(
        agreed('ellis', 'alex', {
          title: 'Evidence is in',
          decisionMethod: 'judge',
          judgeId: 'sarah',
          timing: { kind: 'evidence', description: 'The press release' },
        }),
        { type: 'mark_ready', evidence: 'The release went out on Oct 12.' },
        'alex',
        '2026-10-12T12:00:00.000Z',
      );
      await renderOverview([marked]);
      expect(rows()).toHaveLength(1);
      expect(text(rows()[0])).toContain('Waiting on Sarah’s recommendation since Oct 12');
    });

    it('leaves a bet whose judge stepped down to Over to you, where both bettors must act', async () => {
      const declined = applyAction(
        judgedDue(),
        { type: 'decline_judging', note: 'Not my call.' },
        'sarah',
        NOW,
      );
      await renderOverview([declined]);
      expect(rows()).toHaveLength(0);
      expect(container.querySelectorAll('.approvals-panel .action-item')).toHaveLength(1);
    });

    it('does not claim the judge has it while a proposed change pauses the bet', async () => {
      const paused = applyAction(
        judgedDue(),
        { type: 'propose_void', note: 'Call it off.' },
        'alex',
        NOW,
      );
      await renderOverview([paused], { memberId: 'ellis' });
      expect(container.textContent).not.toContain('Waiting on Sarah’s recommendation');
    });
  });

  it('keeps an event bet in the list and names the event in plain words', async () => {
    await renderOverview([...dated, event]);
    expect(rows()).toHaveLength(4);
    await act(async () => buttonWith(container, 'View all 5 waiting')!.click());
    expect(rows()).toHaveLength(5);
    const last = text(rows().at(-1));
    expect(last).toContain('Event bet');
    expect(last).toContain('Waits for: The acquisition closes');
    expect(last).not.toMatch(/^Event bet When /);
  });

  it('expands in place instead of leaving for the unfiltered ledger', async () => {
    const onNavigate = vi.fn();
    await renderOverview([...dated, event], { onNavigate });
    const toggle = buttonWith(container, 'View all 5 waiting')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(onNavigate).not.toHaveBeenCalled();
    expect(buttonWith(container, 'Show fewer')!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => buttonWith(container, 'Show fewer')!.click());
    expect(rows()).toHaveLength(4);
  });

  it('draws the expand toggle as a chevron, keeping the arrow for links to another page', async () => {
    await renderOverview([...dated, event]);
    const toggle = buttonWith(container, 'View all 5 waiting')!;
    expect(toggle.querySelector('svg.lucide-chevron-down.disclosure-chevron')).not.toBeNull();
    expect(toggle.querySelector('svg.lucide-arrow-right')).toBeNull();
    expect(
      buttonWith(container, 'Open activity inbox')!.querySelector('svg.lucide-arrow-right'),
    ).not.toBeNull();
  });

  it('adds a role line: the judge, or the counterparty', async () => {
    const judged = agreed('alex', 'james', {
      title: 'Judged later',
      decisionMethod: 'judge',
      judgeId: 'ellis',
      timing: { kind: 'date', at: '2026-12-20T12:00:00.000Z', timezone: 'UTC' },
    });
    await renderOverview([dated[0], judged]);
    const byTitle = (title: string) => rows().find((row) => text(row).includes(title))!;
    expect(text(byTitle('Dated 15'))).toContain('with Sarah');
    expect(text(byTitle('Judged later'))).toContain('Alex vs James · you are the judge');
  });

  it('says that a waiting row opens the bet sheet as a dialog', async () => {
    await renderOverview([dated[0]]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('aria-haspopup')).toBe('dialog');
  });
});

describe('Overview layout and stats', () => {
  it('runs Over to you, the latest wagers, Waiting on…, then the lower panels in the page order', async () => {
    const waiting = agreed('ellis', 'sarah', {
      timing: { kind: 'date', at: '2026-12-15T12:00:00.000Z', timezone: 'UTC' },
    });
    await renderOverview([waiting, proposal('alex', 'ellis', { title: 'Needs an answer' })]);
    expect(container.querySelector('.waiting-panel')).not.toBeNull();
    // The wide grid draws Waiting on… on a row of its own below the wagers, so it has to be
    // tabbed after them; Over to you leads at every width.
    const order = [...container.querySelector('.overview-grid')!.children].map((panel) =>
      panel.className.replace(/^panel /, ''),
    );
    expect(order).toEqual([
      'approvals-panel',
      'recent-panel',
      'waiting-panel',
      'leaderboard-preview',
      'map-preview',
    ]);
  });

  it('exposes the tabs as a group of toggle buttons', async () => {
    await renderOverview([agreed('ellis', 'sarah')]);
    const group = container.querySelector('.panel-tabs')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBeTruthy();
    const pressed = () =>
      [...group.querySelectorAll('button')]
        .filter((el) => el.getAttribute('aria-pressed') === 'true')
        .map(text);
    expect(pressed()).toEqual(['All activity']);
    await act(async () => buttonWith(group, 'Your bets')!.click());
    expect(pressed()).toEqual(['Your bets']);
    expect(group.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('says "1 bet in play" for one active bet, and pluralises the other counts', async () => {
    await renderOverview([agreed('ellis', 'sarah')]);
    expect(text(container.querySelector('.panel-tabs > span'))).toBe('1 bet in play');
    expect(text(container.querySelector('.map-preview-foot'))).toBe(
      `${demo.places.length} places with a story to tell`,
    );
    await renderOverview([agreed('ellis', 'sarah'), agreed('alex', 'james')]);
    expect(text(container.querySelector('.panel-tabs > span'))).toBe('2 bets in play');
  });

  it('writes "+1 roll" and shows a dash for a win rate with nothing decided', async () => {
    await renderOverview([agreed('ellis', 'sarah')]);
    const cards = [...container.querySelectorAll('.stat-card')];
    const winRate = cards[3];
    expect(text(winRate.querySelector('.stat-value'))).toBe('—');
    expect(text(winRate)).toContain('No decided bets yet');
    expect(text(winRate)).not.toContain('0%');
    // The sign-keyed caption under zero values says something true about zero.
    expect(text(cards[1])).not.toContain('Awaiting a very good lunch');
    expect(text(cards[2])).not.toContain('Good debts');

    await renderOverview([owed('ellis', 'sarah', { stake: 1 })]);
    const decided = [...container.querySelectorAll('.stat-card')];
    expect(text(decided[0].querySelector('.stat-value'))).toBe('+1roll');
    expect(text(decided[1].querySelector('.stat-value'))).toBe('1roll');
    expect(text(decided[3].querySelector('.stat-value'))).toBe('100%');
    expect(text(decided[3])).toContain('All time');
  });

  it('offers New bet once on the Overview of an empty ledger, in the latest wagers', async () => {
    const onNewBet = vi.fn();
    await renderOverview([], { onNewBet });
    const newBets = [...container.querySelectorAll('button')].filter(
      (button) => text(button) === 'New bet',
    );
    expect(newBets).toHaveLength(1);
    expect(container.querySelector('.recent-panel')!.contains(newBets[0])).toBe(true);
    // Over to you still says what is true without repeating the action.
    expect(text(container.querySelector('.approvals-panel .empty-state'))).toContain(
      'Nothing to do yet',
    );
  });

  it('gives an empty latest-wagers panel a New bet action and says which tab is empty', async () => {
    const onNewBet = vi.fn();
    await renderOverview([proposal('alex', 'sarah', { title: 'Not your bet' })], { onNewBet });
    await act(async () =>
      buttonWith(container.querySelector('.panel-tabs')!, 'Your bets')!.click(),
    );
    const empty = container.querySelector('.recent-panel .empty-state')!;
    expect(text(empty)).toContain('You haven’t made a bet yet');
    await act(async () => buttonWith(empty, 'New bet')!.click());
    expect(onNewBet).toHaveBeenCalledTimes(1);
  });

  describe('Bragging rights', () => {
    // Ellis beat Sarah for two rolls and Alex beat her for one: Ellis +2, Alex +1, Sarah −3.
    const trio = () => ({
      ...ledgerOf(owed('ellis', 'sarah'), owed('alex', 'sarah', { stake: 1 })),
      members: demo.members.filter((member) => ['ellis', 'alex', 'sarah'].includes(member.id)),
    });
    const items = () => [...container.querySelectorAll('.mini-leaderboard > li')];
    const names = () => items().map((item) => text(item.querySelector('strong')));
    // The rank as it is written for assistive technology; the disc beside it is only drawn.
    const ranks = () => items().map((item) => text(item.querySelector('.rank .sr-only')));

    it('ranks only members with a confirmed result, so nobody holds a medal for doing nothing', async () => {
      await renderOverview([], { state: { ...trio(), bets: [owed('ellis', 'sarah')] } });
      expect(names()).toEqual(['Ellis you', 'Sarah']);
    });

    it('awards no medals before any result is confirmed, and says so', async () => {
      await renderOverview([proposal('ellis', 'alex')]);
      expect(items()).toHaveLength(0);
      expect(container.querySelector('.leaderboard-preview .rank')).toBeNull();
      expect(text(container.querySelector('.leaderboard-preview'))).toContain(
        'No confirmed results yet',
      );
    });

    it('lets tied members share a rank, as the Leaderboard does', async () => {
      // Ellis and Olivia are both 1–0 for one roll; Alex and Sarah are both 0–1.
      await renderOverview([
        owed('ellis', 'sarah', { stake: 1 }),
        owed('olivia', 'alex', { stake: 1 }),
      ]);
      // Alex and Sarah are level for third, so both hold it: the list does not cut the tie at three.
      expect(names()).toEqual(['Ellis you', 'Olivia', 'Alex', 'Sarah']);
      expect(ranks()).toEqual(['Rank 1 (tied)', 'Rank 1 (tied)', 'Rank 3 (tied)', 'Rank 3 (tied)']);
      const medals = items().map((item) => item.querySelector('.rank')!.className);
      expect(medals[1]).toBe(medals[0]);
      expect(medals[3]).toBe(medals[2]);
      expect(medals[2]).not.toBe(medals[0]);
    });

    it('keeps everyone who holds a top-three place, so a tie for third is not cut in half', async () => {
      // Ellis +3, Alex +2, then Marcus and Olivia level on +1: four members share the top three places.
      await renderOverview([
        owed('ellis', 'james', { stake: 3 }),
        owed('alex', 'james', { stake: 2 }),
        owed('olivia', 'sarah', { stake: 1 }),
        owed('marcus', 'sarah', { stake: 1 }),
      ]);
      expect(names()).toEqual(['Ellis you', 'Alex', 'Marcus', 'Olivia']);
      expect(ranks()).toEqual(['Rank 1', 'Rank 2', 'Rank 3 (tied)', 'Rank 3 (tied)']);
      expect(container.querySelector('.mini-leaderboard-more')).toBeNull();
    });

    it('says tied in sight as well as in words, and only for members who are', async () => {
      await renderOverview([
        owed('ellis', 'james', { stake: 3 }),
        owed('alex', 'james', { stake: 2 }),
        owed('olivia', 'sarah', { stake: 1 }),
        owed('marcus', 'sarah', { stake: 1 }),
      ]);
      expect(items().map((item) => item.querySelector('.leader-tied')?.textContent ?? '')).toEqual([
        '',
        '',
        'tied',
        'tied',
      ]);
      // The words are read once, from the rank, not again from the visible tag.
      for (const tag of container.querySelectorAll('.leader-tied'))
        expect(tag.getAttribute('aria-hidden')).toBe('true');
    });

    it('caps a long tie at five and says how many more share the last place', async () => {
      // Two three-way cycles leave all six members level on net and wins: six tied for first.
      const cycle = (first: string, second: string, third: string) => [
        owed(first, second, { title: `${first} beats ${second}` }),
        owed(second, third, { title: `${second} beats ${third}` }),
        owed(third, first, { title: `${third} beats ${first}` }),
      ];
      await renderOverview([
        ...cycle('ellis', 'sarah', 'alex'),
        ...cycle('marcus', 'olivia', 'james'),
      ]);
      expect(items()).toHaveLength(5);
      expect(ranks().every((rank) => rank === 'Rank 1 (tied)')).toBe(true);
      expect(text(container.querySelector('.mini-leaderboard-more'))).toBe('+1 more tied for 1st');
    });

    it('keeps the viewer’s own row when a long tie is capped, taking the last place before it is cut', async () => {
      const cycle = (first: string, second: string, third: string) => [
        owed(first, second, { title: `${first} beats ${second}` }),
        owed(second, third, { title: `${second} beats ${third}` }),
        owed(third, first, { title: `${third} beats ${first}` }),
      ];
      const bets = [...cycle('ellis', 'sarah', 'alex'), ...cycle('marcus', 'olivia', 'james')];
      // Sarah comes last of six level members by name, which is the row the cap would cut.
      await renderOverview(bets, { memberId: 'sarah' });
      expect(items()).toHaveLength(5);
      expect(names()).toEqual(['Alex', 'Ellis', 'James', 'Marcus', 'Sarah you']);
      expect(ranks().every((rank) => rank === 'Rank 1 (tied)')).toBe(true);
      expect(text(container.querySelector('.mini-leaderboard-more'))).toBe('+1 more tied for 1st');
      // Someone the cap does cut is still counted, and a viewer inside the first five loses nothing.
      await renderOverview(bets, { memberId: 'alex' });
      expect(names()).toEqual(['Alex you', 'Ellis', 'James', 'Marcus', 'Olivia']);
    });

    it('keeps the viewer’s row in a capped tie for third, with the places above it unchanged', async () => {
      // Ellis +3 and Alex +1 lead; Marcus, Olivia, Sarah and James are level on −1: six on the podium.
      const bets = [
        owed('ellis', 'marcus', { stake: 1, title: 'Ellis beats Marcus' }),
        owed('ellis', 'olivia', { stake: 1, title: 'Ellis beats Olivia' }),
        owed('ellis', 'sarah', { stake: 1, title: 'Ellis beats Sarah' }),
        owed('alex', 'james', { stake: 1, title: 'Alex beats James' }),
      ];
      await renderOverview(bets, { memberId: 'sarah' });
      expect(names()).toEqual(['Ellis', 'Alex', 'James', 'Marcus', 'Sarah you']);
      expect(ranks()).toEqual([
        'Rank 1',
        'Rank 2',
        'Rank 3 (tied)',
        'Rank 3 (tied)',
        'Rank 3 (tied)',
      ]);
      expect(text(container.querySelector('.mini-leaderboard-more'))).toBe('+1 more tied for 3rd');
    });

    it('lists the top places as an ordered list, so a screen reader hears how many there are', async () => {
      await renderOverview([], { state: trio() });
      const list = container.querySelector('.mini-leaderboard')!;
      expect(list.tagName).toBe('OL');
      expect(list.getAttribute('aria-label')).toBeTruthy();
      expect(items()).toHaveLength(3);
    });

    it('writes the rank in words, so first place is more than a number on a disc', async () => {
      await renderOverview([], { state: trio() });
      expect(ranks()).toEqual(['Rank 1', 'Rank 2', 'Rank 3']);
    });

    it('keeps the name and its "you" tag apart so they are not read as one word', async () => {
      await renderOverview([], { state: trio() });
      expect(text(items()[0].querySelector('strong'))).toBe('Ellis you');
    });

    it('draws each top-three rank as a numbered disc, so the places differ by more than a tint', async () => {
      await renderOverview([], { state: trio() });
      const discs = items().map((item) => item.querySelector('.rank .rank-medal')!);
      expect(discs.map(text)).toEqual(['1', '2', '3']);
      // The disc is drawn for the eye; the rank is written for everyone.
      for (const disc of discs) expect(disc.getAttribute('aria-hidden')).toBe('true');
      expect(container.querySelector('.mini-leader .rank svg')).toBeNull();
      // Each place keeps its own tint behind the number.
      const tints = items().map((item) => item.querySelector('.rank')!.className);
      expect(new Set(tints).size).toBe(3);
    });

    it('signs a negative total with a true minus sign in neutral ink', async () => {
      await renderOverview([], { state: trio() });
      // All-time net is not the Outstanding balance, so it keeps its sign but borrows no sign ink.
      const scores = items().map((item) => item.querySelector('.leader-score')!);
      expect(text(scores[0])).toMatch(/^\+\d/);
      // The same true minus sign as the Leaderboard's.
      expect(text(scores[2])).toMatch(/^−\d/);
      for (const score of scores) expect(score.className).toBe('leader-score');
    });
  });

  it('announces the action count from one status region that stays mounted as the count changes', async () => {
    await renderOverview([
      proposal('alex', 'ellis'),
      proposal('sarah', 'ellis', { title: 'A second proposal' }),
    ]);
    const region = container.querySelector('.approvals-panel [role="status"]')!;
    expect(region).not.toBeNull();
    expect(text(region)).toBe('2 actions waiting');
    await renderOverview([proposal('alex', 'ellis')]);
    expect(container.querySelector('.approvals-panel [role="status"]')).toBe(region);
    expect(text(region)).toBe('1 action waiting');
    await renderOverview([proposal('alex', 'sarah', { title: 'Not your bet' })]);
    expect(container.querySelector('.approvals-panel [role="status"]')).toBe(region);
    expect(text(region)).toBe('No actions waiting');
    // Nothing is waiting, so no amber count is drawn; the words are for assistive technology only.
    expect(container.querySelector('.approval-count')).toBeNull();
  });
});

describe('Ledger filters', () => {
  function LedgerHarness(props: Partial<Parameters<typeof LedgerView>[0]>) {
    const [query, setQuery] = useState('');
    return createElement(LedgerView, {
      state: demo,
      memberId: 'ellis',
      onBet: noop,
      search: query,
      setSearch: setQuery,
      ...props,
    });
  }
  async function renderLedger(props: Partial<Parameters<typeof LedgerView>[0]> = {}) {
    await act(async () => root.render(createElement(LedgerHarness, props)));
  }
  const chips = () => [...container.querySelectorAll<HTMLButtonElement>('.filter-tabs button')];
  const pressed = () =>
    chips()
      .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
      .map((chip) => text(chip).replace(/\d+$/, '').trim());
  const rowCount = () => container.querySelectorAll('.bet-title-cell').length;

  it('exposes the status chips as a labelled group of toggle buttons', async () => {
    await renderLedger();
    expect(chips()).toHaveLength(6);
    for (const chip of chips()) {
      expect(chip.closest('[role="group"]')).not.toBeNull();
      expect(chip.hasAttribute('aria-pressed')).toBe(true);
    }
    expect(container.querySelector('.filter-tabs')!.getAttribute('aria-label')).toBeTruthy();
    expect(pressed()).toEqual(['All bets']);
  });

  it('marks only "Settled" as pressed and announces how many bets that leaves', async () => {
    const total = demo.bets.length;
    const settled = demo.bets.filter((bet) => bet.status === 'settled').length;
    expect(settled).toBeGreaterThan(0);
    await renderLedger();
    expect(text(container.querySelector('[role="status"]'))).toBe(`${total} bets`);
    await act(async () => buttonWith(container, 'Settled')!.click());
    expect(pressed()).toEqual(['Settled']);
    expect(text(container.querySelector('[role="status"]'))).toBe(`${settled} of ${total} bets`);
    expect(rowCount()).toBe(settled);
  });

  it('reads "2 of 14 bets" when two of fourteen are settled', async () => {
    const fourteen = demo.bets.slice(0, 14).map((bet, index) => ({
      ...bet,
      status: index < 2 ? ('settled' as const) : ('active' as const),
    }));
    await renderLedger({ state: ledgerOf(...fourteen) });
    await act(async () => buttonWith(container, 'Settled')!.click());
    expect(text(container.querySelector('[role="status"]'))).toBe('2 of 14 bets');
  });

  it('marks the result summary unfiltered while nothing narrows the list, so a phone can fold it away', async () => {
    const total = demo.bets.length;
    await renderLedger();
    const summary = container.querySelector('.ledger-result-summary')!;
    expect(summary.hasAttribute('data-unfiltered')).toBe(true);
    // Folded away by the stylesheet, not removed: the count stays for assistive technology.
    expect(text(summary)).toBe(`${total} bets`);
    expect(summary.getAttribute('role')).toBe('status');
    await act(async () => buttonWith(container, 'Settled')!.click());
    // The same live region, now saying how many are left, and shown.
    expect(container.querySelector('.ledger-result-summary')).toBe(summary);
    expect(summary.hasAttribute('data-unfiltered')).toBe(false);
    await act(async () => buttonWith(container, 'All bets')!.click());
    expect(summary.hasAttribute('data-unfiltered')).toBe(true);
  });

  it('keeps the result summary under the controls, above the table', async () => {
    await renderLedger();
    const summary = container.querySelector('[role="status"]')!;
    expect(container.querySelector('.ledger-controls')!.contains(summary)).toBe(true);
    expect(
      summary.compareDocumentPosition(container.querySelector('.bet-table')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('scopes every chip count to the rows that chip would show', async () => {
    await renderLedger();
    await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    const counts = chips().map((chip) => Number(text(chip.querySelector('span'))));
    const seen: number[] = [];
    for (let index = 0; index < chips().length; index++) {
      await act(async () => chips()[index].click());
      seen.push(rowCount());
    }
    expect(counts).toEqual(seen);
    // Mine is a strict subset of the whole ledger, so this would fail with global counts.
    expect(counts[0]).toBeLessThan(demo.bets.length);
  });

  it('scopes the chip counts to the search as well', async () => {
    await renderLedger();
    await search('ocean');
    expect(chips().map((chip) => Number(text(chip.querySelector('span'))))[0]).toBe(rowCount());
    expect(text(container.querySelector('[role="status"]'))).toBe(
      `${rowCount()} of ${demo.bets.length} bets`,
    );
  });

  it('finds a bet by its category and ignores spaces around the query', async () => {
    await renderLedger();
    const wild = demo.bets.filter((bet) => bet.category === 'Wild card').map((bet) => bet.title);
    expect(wild.length).toBeGreaterThan(0);
    await search('  wild card  ');
    expect(titles().sort()).toEqual(wild.sort());
  });

  it('names the entry-source select by its visible label', async () => {
    await renderLedger();
    const select = container.querySelector('.entry-source-filter select')!;
    expect(select.hasAttribute('aria-label')).toBe(false);
    expect(select.closest('label')!.textContent).toContain('Entered via');
  });

  it('shows a true-empty state with New bet, and no Clear filters, for an empty ledger', async () => {
    const onNewBet = vi.fn();
    await renderLedger({ state: ledgerOf(), onNewBet });
    const empty = container.querySelector('.empty-state')!;
    expect(text(empty)).toContain('No bets on the ledger yet');
    expect(buttonWith(container, 'Clear filters')).toBeUndefined();
    expect(text(empty)).not.toContain('No wagers match');
    await act(async () => buttonWith(empty, 'New bet')!.click());
    expect(onNewBet).toHaveBeenCalledTimes(1);
    // An empty ledger has nothing to filter, so the heading under the page title is an h2.
    expect(empty.querySelector('h2')).not.toBeNull();
  });

  it('keeps Clear filters for a filtered-empty ledger and sends focus to the search', async () => {
    await renderLedger();
    await search('no matching title');
    expect(rowCount()).toBe(0);
    expect(text(container.querySelector('[role="status"]'))).toBe(`0 of ${demo.bets.length} bets`);
    // Straight under the page title, so the heading is an h2 and not an h3 beneath an h1.
    expect(container.querySelector('.empty-state h2')?.textContent).toBe('No wagers match');
    expect(container.querySelector('.empty-state h3')).toBeNull();
    const clear = buttonWith(container, 'Clear filters')!;
    expect(clear).toBeTruthy();
    await act(async () => clear.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search ledger"]')!;
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(rowCount()).toBe(demo.bets.length);
  });

  it('marks the ledger search as a search field', async () => {
    await renderLedger();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search ledger"]')!;
    expect(input.type).toBe('search');
  });

  it('counts a bet you were named to judge as yours under Only my bets', async () => {
    const judged = applyAction(
      proposal('alex', 'james', {
        title: 'Judged by Ellis',
        decisionMethod: 'judge',
        judgeId: 'ellis',
      }),
      { type: 'accept' },
      'james',
      T0,
    );
    const stranger = proposal('alex', 'sarah', { title: 'Not Ellis’s bet' });
    await renderLedger({ state: ledgerOf(judged, stranger) });
    expect(titles().sort()).toEqual(['Judged by Ellis', 'Not Ellis’s bet']);
    await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    expect(titles()).toEqual(['Judged by Ellis']);
    expect(text(chips()[0].querySelector('span'))).toBe('1');
  });
});

describe('Ledger rows', () => {
  const renderRows = async (bets: Bet[], props: Partial<Parameters<typeof BetTable>[0]> = {}) =>
    act(async () =>
      root.render(
        createElement(BetTable, {
          bets,
          state: ledgerOf(...bets),
          onBet: noop,
          memberId: 'ellis',
          now: NOW,
          ...props,
        }),
      ),
    );
  const metaOf = (title: string) =>
    text(
      [...container.querySelectorAll('.bet-row')]
        .find((row) => text(row).includes(title))!
        .querySelector('.bet-meta'),
    );

  it('says "Your move" on a row that waits on the viewer, and on no other row', async () => {
    await renderRows([
      confirming('alex', 'ellis', { title: 'Needs Ellis' }),
      proposal('ellis', 'sarah', { title: 'Waits on Sarah' }),
    ]);
    expect(metaOf('Needs Ellis')).toContain('Your move');
    expect(metaOf('Waits on Sarah')).not.toContain('Your move');
  });

  it('says it for the judge when a decision is due, and never for a viewer of someone else’s bet', async () => {
    const judged = applyAction(
      proposal('alex', 'james', { title: 'Judge due', decisionMethod: 'judge', judgeId: 'ellis' }),
      { type: 'accept' },
      'james',
      T0,
    );
    await renderRows([judged]);
    expect(metaOf('Judge due')).toContain('Your move');
    await renderRows([judged], { memberId: 'sarah' });
    expect(metaOf('Judge due')).not.toContain('Your move');
  });

  it('keeps the move out of a table that was given no viewer', async () => {
    await renderRows([confirming('alex', 'ellis', { title: 'Needs Ellis' })], {
      memberId: undefined,
    });
    expect(metaOf('Needs Ellis')).not.toContain('Your move');
  });

  it('adds the year to an Added date from another year, and only then', async () => {
    await renderRows([
      proposal('ellis', 'sarah', { title: 'Last year', at: '2025-06-15T12:00:00.000Z' }),
      proposal('ellis', 'sarah', { title: 'This year', at: '2026-06-15T12:00:00.000Z' }),
    ]);
    expect(metaOf('Last year')).toContain('Added Jun 15, 2025');
    expect(metaOf('This year')).toContain('Added Jun 15');
    expect(metaOf('This year')).not.toContain('2026');
  });
});

describe('Status labels', () => {
  const base = demo.bets[0];
  const withHistory = (correction: boolean): Bet => ({
    ...base,
    status: 'pending',
    history: {
      originalDate: { precision: 'month', value: '2024-02' },
      stage: 'active',
      proposedBy: 'ellis',
      revision: 1,
      approvals: [],
      ...(correction
        ? { correction: { requestedBy: 'sarah', note: 'The month is wrong.', at: T0 } }
        : {}),
    },
  });

  const offsetOf = (betId: string): DebtOffset => ({
    id: 'offset-1',
    actorId: 'ellis',
    at: T0,
    references: {},
    counterpartyId: 'sarah',
    rolls: 1,
    allocations: [{ betId, version: 1, rolls: 1 }],
  });

  it('shows "Needs correction" in the ledger table and "History needs correction" on the inbox row', async () => {
    const bet = { ...withHistory(true), creatorId: 'ellis', opponentId: 'sarah' };
    await act(async () =>
      root.render(
        createElement(BetTable, {
          bets: [bet],
          state: ledgerOf(bet),
          onBet: noop,
          memberId: 'ellis',
        }),
      ),
    );
    // The full words outgrow the table's status column, so the table says it shorter.
    expect(text(container.querySelector('.status-badge'))).toBe('Needs correction');
    await act(async () =>
      root.render(
        createElement(BetTable, {
          bets: [bet],
          state: ledgerOf(bet),
          onBet: noop,
          memberId: 'ellis',
          compact: true,
        }),
      ),
    );
    expect(text(container.querySelector('.status-badge'))).toBe('Correction');
    await renderInbox([bet]);
    expect(text(container.querySelector('.action-item .status-badge'))).toBe(
      'History needs correction',
    );
  });

  it('gives every status label its own look: no two chips share a tone and an icon', async () => {
    const fabricated: Bet[] = [
      { ...base, status: 'pending', history: undefined },
      withHistory(false),
      withHistory(true),
      { ...base, status: 'active' },
      { ...base, status: 'confirming' },
      { ...base, status: 'owed' },
      { ...base, status: 'settling' },
      { ...base, status: 'settled', settlement: undefined, offsets: [offsetOf('look-7')] },
      { ...base, status: 'settled', offsets: undefined },
      { ...base, status: 'voided' },
      { ...base, status: 'declined', events: [{ ...base.events[0], type: 'decline' }] },
      { ...base, status: 'declined', events: [{ ...base.events[0], type: 'withdraw' }] },
    ].map((bet, index) => ({ ...bet, id: `look-${index}` }) as Bet);
    await act(async () =>
      root.render(
        createElement(BetTable, {
          bets: fabricated,
          state: ledgerOf(...fabricated),
          onBet: noop,
          memberId: 'ellis',
        }),
      ),
    );
    const badges = [...container.querySelectorAll('.status-badge')];
    expect(badges.map(text)).toEqual([
      'Pending agreement',
      'Confirming history',
      'Needs correction',
      'In play',
      'Confirming result',
      'Ready to settle',
      'Confirming delivery',
      'Settled by offset',
      'Settled',
      'No winner',
      'Declined',
      'Withdrawn',
    ]);
    const looks = badges.map(
      (badge) => `${badge.className}|${badge.querySelector('svg')!.getAttribute('class')}`,
    );
    expect(new Set(looks).size).toBe(badges.length);
  });

  it('keeps every ledger-table status label within the width its status column is sized for', async () => {
    // The column is sized for "Confirming delivery" (19 characters, see bet-table-css.test.ts), so
    // a longer label would run over the chip and under the stake. Compact tables are shorter still.
    const fabricated: Bet[] = [
      ...(
        ['pending', 'active', 'confirming', 'owed', 'settling', 'settled', 'voided'] as const
      ).map((status) => ({ ...base, status, history: undefined })),
      withHistory(false),
      withHistory(true),
      { ...base, status: 'settled', settlement: undefined, offsets: [offsetOf('fit-9')] },
      { ...base, status: 'declined', events: [{ ...base.events[0], type: 'decline' }] },
      { ...base, status: 'declined', events: [{ ...base.events[0], type: 'withdraw' }] },
    ].map((bet, index) => ({ ...bet, id: `fit-${index}` }) as Bet);
    for (const compact of [false, true]) {
      await act(async () =>
        root.render(
          createElement(BetTable, {
            bets: fabricated,
            state: ledgerOf(...fabricated),
            onBet: noop,
            memberId: 'ellis',
            compact,
          }),
        ),
      );
      const labels = [...container.querySelectorAll('.bet-row .status-badge')].map(text);
      expect(labels).toHaveLength(fabricated.length);
      for (const label of labels) expect(label.length).toBeLessThanOrEqual(compact ? 12 : 19);
    }
  });
});

describe('Activity inbox', () => {
  const eventCount = demo.bets.reduce((total, bet) => total + bet.events.length, 0);
  const rows = () => [...container.querySelectorAll('.inbox-activity li')];

  it('shows ten feed rows and a "Show 10 more" button, then ten more', async () => {
    expect(eventCount).toBeGreaterThan(20);
    await renderInbox(demo.bets);
    expect(rows()).toHaveLength(10);
    const more = buttonWith(container, 'Show 10 more')!;
    expect(more).toBeTruthy();
    expect(text(container.querySelector('.inbox-activity-count'))).toContain(`of ${eventCount}`);
    await act(async () => more.click());
    expect(rows()).toHaveLength(20);
  });

  it('keeps the focus on the feed when more rows arrive', async () => {
    await renderInbox(demo.bets);
    await act(async () => buttonWith(container, 'Show 10 more')!.click());
    expect(container.querySelector('.inbox-activity')!.contains(document.activeElement)).toBe(true);
  });

  it('lists the feed as a list of buttons whose names stay short, however long the audit text', async () => {
    const long = 'Act as a neutral reviewer and treat both positions equally. '.repeat(30);
    const bet = proposal('ellis', 'sarah', { title: 'A'.repeat(160) });
    const stuffed: Bet = {
      ...bet,
      events: [{ ...bet.events[0], type: 'propose_prompt', detail: `Proposed a prompt. ${long}` }],
    };
    await renderInbox([stuffed]);
    expect(container.querySelector('ul.inbox-activity')).not.toBeNull();
    const buttons = [...container.querySelectorAll('.inbox-activity li button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? '';
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThan(200);
    }
    expect(buttons[0].getAttribute('aria-label')).toContain('Proposed a prompt.');
    // The initials are decoration; the name starts with the bet, not "EL".
    expect(buttons[0].querySelector('.avatar')!.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('says there is no activity on an empty ledger and does not call that "caught up"', async () => {
    await renderInbox([]);
    expect(text(container.querySelector('.inbox-columns'))).toContain('No activity yet');
    expect(text(container.querySelector('.inbox-columns'))).not.toContain('All caught up');
    expect(text(container.querySelector('.inbox-columns'))).not.toContain('You’re all caught up');
    expect(text(container.querySelector('.inbox-columns'))).toContain('Nothing to do yet');
  });

  it('says "caught up" only when there are bets and nothing waits on the member', async () => {
    await renderInbox([proposal('alex', 'sarah', { title: 'Not your bet' })]);
    expect(text(container.querySelector('.inbox-columns'))).toContain('You’re all caught up');
    expect(text(container.querySelector('.inbox-columns'))).not.toContain('No activity yet');
  });

  it('offers a New bet action from the empty next-moves state', async () => {
    const onNewBet = vi.fn();
    await renderInbox([], { onNewBet });
    await act(async () => buttonWith(container.querySelector('.empty-state')!, 'New bet')!.click());
    expect(onNewBet).toHaveBeenCalledTimes(1);
  });

  it('lists next moves as a list of expanded action items', async () => {
    await renderInbox([
      confirming('alex', 'ellis'),
      proposal('sarah', 'ellis', { title: 'Another one' }),
    ]);
    expect(container.querySelectorAll('ul.action-list > li .action-item-expanded')).toHaveLength(2);
  });

  it('marks a short list of next moves so it can stay in view beside a long feed, and a long one not', async () => {
    const proposals = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        proposal('alex', 'ellis', { title: `Proposal ${index + 1}` }),
      );
    await renderInbox(proposals(4));
    expect(container.querySelector('.inbox-next-moves.is-short')).not.toBeNull();
    await renderInbox(proposals(5));
    expect(container.querySelector('.inbox-next-moves')).not.toBeNull();
    expect(container.querySelector('.inbox-next-moves.is-short')).toBeNull();
    await renderInbox([]);
    expect(container.querySelector('.inbox-next-moves.is-short')).not.toBeNull();
  });

  it('dates every feed row with the year and the time, as a signed record would be', async () => {
    await renderInbox([proposal('alex', 'ellis', { at: '2025-06-15T12:00:00.000Z' })]);
    const meta = container.querySelector('.inbox-activity li small')!;
    expect(text(meta)).toMatch(/Jun 15, 2025/);
    expect(text(meta)).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(meta.querySelector('time')?.getAttribute('datetime')).toBe('2025-06-15T12:00:00.000Z');
    expect(text(meta)).toContain('Alex');
  });

  it('says that a feed row and a next move open the bet sheet as a dialog', async () => {
    await renderInbox([proposal('alex', 'ellis')]);
    for (const row of container.querySelectorAll('.inbox-activity li button, .action-item')) {
      expect(row.getAttribute('aria-haspopup'), text(row)).toBe('dialog');
    }
    expect(container.querySelectorAll('.inbox-activity li button, .action-item')).toHaveLength(2);
  });

  it('leads a feed row with the bet it is about, then what happened, then who and when', async () => {
    await renderInbox([proposal('alex', 'ellis', { title: 'Friday release' })]);
    const row = container.querySelector('.inbox-activity li button')!;
    const body = row.querySelector(':scope > span:not(.avatar)')!;
    const parts = [...body.children].map((el) => el.tagName);
    expect(parts).toEqual(['STRONG', 'P', 'SMALL']);
    expect(text(row.querySelector('strong'))).toBe('Friday release');
    // Like a next move, the row ends in a chevron that assistive technology skips.
    expect(row.querySelector(':scope > svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Places view toggles', () => {
  const props = {
    state: demo,
    memberId: 'ellis',
    onBet: noop,
    onPriceSaved: async () => {},
    onPriceCorrected: async () => {},
  };

  it('exposes Wager stories and Roll prices as pressed toggle buttons, not half a tablist', async () => {
    await act(async () => root.render(createElement(PlacesView, props)));
    const group = container.querySelector('.places-toolbar .panel-tabs')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    const pressed = () =>
      [...group.querySelectorAll('button')]
        .filter((el) => el.getAttribute('aria-pressed') === 'true')
        .map(text);
    expect(pressed()).toEqual(['Wager stories']);
    await act(async () => buttonWith(group, 'Roll prices')!.click());
    expect(pressed()).toEqual(['Roll prices']);
  });

  it('marks the selected place in the stories list as pressed', async () => {
    await act(async () => root.render(createElement(PlacesView, props)));
    const list = container.querySelector('[aria-label="Places on the record"]')!;
    const pressed = () =>
      [...list.querySelectorAll('.place-item')]
        .filter((el) => el.getAttribute('aria-pressed') === 'true')
        .map((el) => text(el.querySelector('strong')));
    expect(pressed()).toEqual(['All locations']);
    await act(async () => list.querySelectorAll<HTMLButtonElement>('.place-item')[1].click());
    expect(pressed()).toEqual([demo.places[0].name]);
  });
});

describe('the invite controls on the Members page', () => {
  const view = (onInvite = vi.fn()) =>
    createElement(MembersView, {
      state: demo,
      memberId: 'ellis',
      onBet: vi.fn(),
      onInvite,
      onBetWith: vi.fn(),
      onViewBets: vi.fn(),
    });
  const trigger = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;

  it('name the action the same way, in the intro button and on the dashed card', async () => {
    await act(async () => root.render(view()));
    expect(text(trigger('.members-intro button'))).toBe('Invite a member');
    expect(trigger('.invite-member-card').getAttribute('aria-label')).toBe('Invite a member');
    expect(text(trigger('.invite-member-card .invite-label'))).toBe('Invite a member');
    expect(container.textContent).not.toMatch(/Invite someone|Invite a friend/);
  });

  it('both open the invitation', async () => {
    const onInvite = vi.fn();
    await act(async () => root.render(view(onInvite)));
    await act(async () => trigger('.members-intro button').click());
    await act(async () => trigger('.invite-member-card').click());
    expect(onInvite).toHaveBeenCalledTimes(2);
  });

  it('keep block elements out of a button, which may hold only phrasing content', async () => {
    await act(async () => root.render(view()));
    expect(container.querySelectorAll('button p, button div, button h2, button h3')).toHaveLength(
      0,
    );
    expect(trigger('.invite-member-card').textContent).toContain(
      'Share an invitation by text or link.',
    );
  });
});

describe('member cards', () => {
  const onBetWith = vi.fn();
  const onViewBets = vi.fn();
  const showMembers = (memberId = 'ellis') =>
    act(async () =>
      root.render(
        createElement(MembersView, {
          state: demo,
          memberId,
          onBet: vi.fn(),
          onInvite: vi.fn(),
          onBetWith,
          onViewBets,
        }),
      ),
    );
  const cards = () => [...container.querySelectorAll<HTMLElement>('.member-card')];
  const card = (name: string) =>
    cards().find((el) => text(el.querySelector('h3')).startsWith(name))!;
  const member = (id: string) => demo.members.find((item) => item.id === id)!;
  const stat = (name: string, label: string) =>
    [...card(name).querySelectorAll('.member-stats > div')].find(
      (el) => text(el.querySelector(':scope > span')) === label,
    )!;

  beforeEach(() => {
    onBetWith.mockClear();
    onViewBets.mockClear();
  });

  it('offers a bet with each of the others, and starts it with that person', async () => {
    await showMembers();
    expect(
      cards().map((el) => text(el.querySelector('.member-actions button:first-child'))),
    ).toEqual([
      'View bets',
      'Bet with Alex',
      'Bet with Sarah',
      'Bet with Marcus',
      'Bet with Olivia',
      'Bet with James',
    ]);
    await act(async () => buttonWith(card('Olivia'), 'Bet with Olivia')!.click());
    expect(onBetWith).toHaveBeenCalledExactlyOnceWith(member('olivia'));
  });

  it('lets every card, the reader’s own included, open the bets that person is in', async () => {
    await showMembers();
    for (const item of demo.members) {
      expect(buttonWith(card(item.name), 'View bets'), item.name).toBeTruthy();
    }
    await act(async () => buttonWith(card('Sarah'), 'View bets')!.click());
    expect(onViewBets).toHaveBeenCalledExactlyOnceWith(member('sarah'));
  });

  it('tells the View bets buttons apart for someone who hears the page read out', async () => {
    await showMembers();
    expect(cards().map((el) => buttonWith(el, 'View bets')!.getAttribute('aria-label'))).toEqual([
      'View bets involving you',
      'View bets involving Alex',
      'View bets involving Sarah',
      'View bets involving Marcus',
      'View bets involving Olivia',
      'View bets involving James',
    ]);
  });

  it('writes the reader’s own heading as Ellis (you), with a space before the marker', async () => {
    await showMembers();
    expect(text(card('Ellis').querySelector('h3'))).toBe('Ellis (you)');
    expect(text(card('Alex').querySelector('h3'))).toBe('Alex');
  });

  it('shows the marker as written, with no visually hidden parentheses to split the spoken name', async () => {
    await showMembers();
    const heading = card('Ellis').querySelector('h3')!;
    // Positioned sr-only spans are laid out as blocks, so a browser reads "Ellis ( you )" from them.
    expect(heading.querySelector('.sr-only')).toBeNull();
    expect(text(heading.querySelector('small'))).toBe('(you)');
  });

  it('says what is going on with each person instead of calling all of them a ledger member', async () => {
    await showMembers();
    expect(container.textContent).not.toContain('Ledger member');
    const line = (name: string) => text(card(name).querySelector('.member-role'));
    expect(line('Ellis')).toBe('4 bets in play owed 6 rolls you owe 1 roll');
    expect(line('Alex')).toBe('2 bets in play owes you 3 rolls');
    expect(line('Sarah')).toBe('1 bet in play owes you 2 rolls');
    expect(line('Marcus')).toBe('1 bet in play owes you 1 roll');
    expect(line('Olivia')).toBe('Nothing in play you owe 1 roll');
    expect(line('James')).toBe('2 bets in play');
  });

  it('reads the same ledger from another seat', async () => {
    await showMembers('alex');
    const line = (name: string) => text(card(name).querySelector('.member-role'));
    expect(line('Ellis')).toBe('4 bets in play you owe 3 rolls');
    expect(text(card('Alex').querySelector('h3'))).toBe('Alex (you)');
    expect(buttonWith(card('Alex'), 'Bet with')).toBeUndefined();
    expect(buttonWith(card('Ellis'), 'Bet with Ellis')).toBeTruthy();
  });

  it('shows a dash, not 0%, for the win rate of someone with no decided bet', async () => {
    await showMembers();
    expect(text(stat('James', 'win rate').querySelector('strong'))).toContain('—');
    expect(text(stat('James', 'win rate').querySelector('strong'))).not.toContain('%');
    expect(text(stat('James', 'win rate').querySelector('.sr-only'))).toBe('none yet');
    // A person who has lost every decided bet really is at 0%.
    expect(text(stat('Alex', 'win rate').querySelector('strong'))).toBe('0%');
    expect(text(stat('Ellis', 'win rate').querySelector('strong'))).toBe('67%');
  });

  it('colours the net only when it is not zero', async () => {
    await showMembers();
    const net = (name: string) => stat(name, 'All-time net').querySelector('strong')!;
    expect(net('Ellis').className).toBe('green');
    expect(text(net('Ellis'))).toBe('+6');
    expect(net('Alex').className).toBe('red');
    expect(net('James').className).toBe('');
    expect(text(net('James'))).toBe('0');
  });

  it('calls the third figure the all-time net, and says once what it counts', async () => {
    await showMembers();
    expect(container.textContent).not.toContain('net rolls');
    expect(
      cards().every((el) =>
        stat(text(el.querySelector('h3')).replace(' (you)', ''), 'All-time net'),
      ),
    ).toBe(true);
    const note = container.querySelector('.members-footnote')!;
    expect(text(note)).toBe(
      'All-time net is the rolls a person has won minus the rolls they have lost on decided bets, whether or not the rolls have been delivered.',
    );
    const grid = container.querySelector('.members-grid')!;
    expect(grid.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('member cards when two people owe each other', () => {
  /** A confirmed result where `loserId` owes `winnerId` the stake. */
  function owed(loserId: string, winnerId: string, stake: number, title: string): Bet {
    let bet = createBet(
      {
        title,
        terms: 'The official result determines who won.',
        category: 'Life',
        creatorSide: 'Yes',
        opponentSide: 'No',
        opponentId: winnerId,
        stake,
        deadline: '2026-10-01',
      },
      loserId,
      demo.members,
      '2026-10-01T12:00:00Z',
    );
    bet = applyAction(bet, { type: 'accept' }, winnerId);
    bet = applyAction(bet, { type: 'propose_result', winnerId, note: 'Official result.' }, loserId);
    return applyAction(bet, { type: 'confirm_result' }, winnerId);
  }
  const line = (name: string) => {
    const card = [...container.querySelectorAll<HTMLElement>('.member-card')].find((el) =>
      text(el.querySelector('h3')).startsWith(name),
    )!;
    return text(card.querySelector('.member-role'));
  };
  async function show(bets: Bet[]) {
    await act(async () =>
      root.render(
        createElement(MembersView, {
          state: { ...demo, bets },
          memberId: 'ellis',
          onBet: vi.fn(),
          onInvite: vi.fn(),
          onBetWith: vi.fn(),
          onViewBets: vi.fn(),
        }),
      ),
    );
  }

  it('keeps each debt apart, as the Balances page does, instead of netting them', async () => {
    await show([
      owed('alex', 'ellis', 3, 'Alex pays'),
      owed('ellis', 'alex', 1, 'Ellis pays Alex'),
    ]);
    expect(line('Alex')).toBe('Nothing in play owes you 3 rolls you owe 1 roll');
    expect(line('Ellis')).toBe('Nothing in play owed 3 rolls you owe 1 roll');
  });

  it('names both sides of an even pair rather than saying nothing', async () => {
    await show([
      owed('sarah', 'ellis', 2, 'Sarah pays'),
      owed('ellis', 'sarah', 2, 'Ellis pays Sarah'),
    ]);
    expect(line('Sarah')).toBe('Nothing in play owes you 2 rolls you owe 2 rolls');
    expect(line('Ellis')).toBe('Nothing in play owed 2 rolls you owe 2 rolls');
  });

  it('agrees with the Balances page about what each person owes', async () => {
    const bets = [
      owed('alex', 'ellis', 3, 'Alex pays'),
      owed('ellis', 'alex', 1, 'Ellis pays Alex'),
      owed('sarah', 'ellis', 2, 'Sarah pays'),
      owed('ellis', 'sarah', 2, 'Ellis pays Sarah'),
    ];
    await show(bets);
    expect(line('Ellis')).toBe('Nothing in play owed 5 rolls you owe 3 rolls');
    expect(line('Alex')).toContain('owes you 3 rolls');
    expect(line('Sarah')).toContain('owes you 2 rolls');
    expect(line('Sarah')).toContain('you owe 2 rolls');
  });
});

describe('avatars beside a name', () => {
  it('stay out of the accessibility tree on the Leaderboard and Members, where the name is written next to them', async () => {
    for (const view of [
      createElement(LeaderboardView, { state: demo, memberId: 'ellis', onBet: vi.fn() }),
      createElement(MembersView, {
        state: demo,
        memberId: 'ellis',
        onBet: vi.fn(),
        onInvite: vi.fn(),
        onBetWith: vi.fn(),
        onViewBets: vi.fn(),
      }),
    ]) {
      await act(async () => root.render(view));
      const avatars = [...container.querySelectorAll('.avatar')];
      expect(avatars.length).toBeGreaterThan(0);
      for (const avatar of avatars) {
        expect(
          avatar.getAttribute('aria-hidden') ?? avatar.closest('[aria-hidden="true"]'),
        ).toBeTruthy();
      }
    }
  });
});

describe('the Leaderboard', () => {
  async function renderBoard(bets: Bet[], over: Partial<LedgerState> = {}) {
    await act(async () =>
      root.render(
        createElement(LeaderboardView, {
          state: { ...ledgerOf(...bets), ...over },
          memberId: 'ellis',
          onBet: noop,
        }),
      ),
    );
  }
  const table = () => container.querySelector('[role="table"]');
  const rows = () => [...container.querySelectorAll('[role="table"] [role="row"]')].slice(1);
  const names = () => rows().map((row) => text(row.querySelector('.leaderboard-member strong')));
  const ranks = () => rows().map((row) => text(row.querySelector('.rank .sr-only')));
  const sortBy = async (value: string) => {
    const select = container.querySelector('.sort-control select') as unknown as {
      value: string;
      dispatchEvent(event: Event): boolean;
    };
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('awards no rank, medal or lead while nobody has a confirmed result', async () => {
    await renderBoard([proposal('ellis', 'sarah')]);
    expect(table()).toBeNull();
    expect(container.querySelector('.rank')).toBeNull();
    expect(container.querySelector('.leader-note')).toBeNull();
    expect(text(container.querySelector('.empty-state'))).toContain('No confirmed results yet');
  });

  it('ranks only the members with a decided bet and names the rest as not ranked yet', async () => {
    await renderBoard([owed('james', 'alex')]);
    expect(names()).toEqual(['James', 'Alex']);
    expect(ranks()).toEqual(['1st', '2nd']);
    expect(text(container.querySelector('.leaderboard-waiting'))).toBe(
      'Not ranked yet: Ellis you, Marcus, Olivia and Sarah have no confirmed results.',
    );
    expect(text(container.querySelector('.leader-note'))).toBe(
      'James leads with +2 net rolls, 4 ahead of Alex.',
    );
  });

  it('gives tied members the same rank and medal and names every leader', async () => {
    await renderBoard([owed('ellis', 'sarah'), owed('olivia', 'marcus')]);
    expect(names()).toEqual(['Ellis you', 'Olivia', 'Marcus', 'Sarah']);
    expect(ranks()).toEqual(['1st (tied)', '1st (tied)', '3rd (tied)', '3rd (tied)']);
    const medals = rows().map((row) => row.querySelector('.rank')!.className);
    expect(medals[0]).toBe(medals[1]);
    expect(medals[0]).toContain('rank-1');
    expect(text(container.querySelector('.leader-note'))).toBe(
      'Ellis and Olivia share the lead with +2 net rolls each.',
    );
  });

  it('is a table with column headers, a marked sort column and the rank in words', async () => {
    await renderBoard([owed('ellis', 'sarah')]);
    expect(table()?.getAttribute('aria-label')).toBe('The roll of honor');
    const headers = [...table()!.querySelectorAll('[role="columnheader"]')];
    expect(headers.map((header) => text(header))).toEqual([
      'Rank',
      'Member',
      'Wins',
      'Losses',
      'W–L',
      'Win rate',
      'Net rolls',
    ]);
    const sorted = () =>
      headers.filter((header) => header.getAttribute('aria-sort')).map((header) => text(header));
    expect(sorted()).toEqual(['Net rolls']);
    expect(
      headers.find((header) => header.getAttribute('aria-sort'))?.getAttribute('aria-sort'),
    ).toBe('descending');
    await sortBy('wins');
    // The phone layout swaps Wins and Losses for W–L, so the sorted mark follows it there too.
    expect(sorted()).toEqual(['Wins', 'W–L']);
    for (const row of rows()) {
      expect(row.querySelectorAll('[role="cell"], [role="rowheader"]')).toHaveLength(7);
      // The medal is drawn for the eye; the rank is written for everyone.
      expect(row.querySelector('.rank [aria-hidden="true"]')).not.toBeNull();
    }
    expect(ranks()[0]).toBe('1st');
    // "Ellis you" stays two words.
    expect(names()[0]).toBe('Ellis you');
  });

  it('opens the bets behind a record from the member’s name, and only when something can open them', async () => {
    await renderBoard([owed('ellis', 'sarah')]);
    expect(container.querySelector('.leaderboard-member-link')).toBeNull();
    const onViewBets = vi.fn();
    await act(async () =>
      root.render(
        createElement(LeaderboardView, {
          state: ledgerOf(owed('ellis', 'sarah')),
          memberId: 'ellis',
          onBet: noop,
          onViewBets,
        }),
      ),
    );
    const links = [...container.querySelectorAll<HTMLButtonElement>('.leaderboard-member-link')];
    // Ranked members and the ones still waiting are all listed; every name is a button.
    expect(links.map((link) => text(link))).toEqual(['Ellis', 'Sarah']);
    // The name is the button's name (and so the row header's); what it does is its description.
    expect(links[1].getAttribute('aria-label')).toBeNull();
    expect(links[1].getAttribute('title')).toBe('View bets involving Sarah');
    // The "you" tag stays beside the name, outside the button.
    expect(text(links[0].closest('strong'))).toBe('Ellis you');
    expect(links[0].closest('.leaderboard-row')!.classList.contains('interactive')).toBe(true);
    await act(async () => links[1].click());
    expect(onViewBets).toHaveBeenCalledExactlyOnceWith(
      demo.members.find((member) => member.id === 'sarah'),
    );
  });

  it('counts one member in the singular', async () => {
    await renderBoard([], { members: demo.members.filter((member) => member.id === 'ellis') });
    expect(text(container.querySelector('.panel .section-title p'))).toMatch(/^1 member, /);
  });

  it('sets the subtitle’s aside apart, so a phone can keep just the scope', async () => {
    await renderBoard([owed('ellis', 'sarah')]);
    const subtitle = container.querySelector('.panel .section-title p')!;
    expect(text(subtitle)).toBe('6 members, all time. One very good reason to be right.');
    expect(text(subtitle.querySelector('.roll-of-honor-aside'))).toBe(
      'One very good reason to be right.',
    );
  });

  it('says the standings are all time in words, not in a chip that looks like a filter', async () => {
    await renderBoard([owed('ellis', 'sarah')]);
    // A pill that cannot be pressed and vanishes on tablets reads as a filter that was lost.
    expect(container.querySelector('.all-time-pill')).toBeNull();
    expect(text(container.querySelector('.panel .section-title p'))).toMatch(
      /^6 members, all time\./,
    );
  });

  it('opens with who leads, above the table, instead of closing with it as a footnote', async () => {
    await renderBoard([owed('ellis', 'sarah')]);
    const note = container.querySelector('.leader-note')!;
    // The leader's own figure first, then the margin: "by 4" alone reads like Ellis's total.
    expect(text(note)).toBe('Ellis leads with +2 net rolls, 4 ahead of Sarah.');
    expect(note.closest('.panel')).toBe(table()!.closest('.panel'));
    expect(note.compareDocumentPosition(table()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names everyone level in second place as the ones the leader is ahead of', async () => {
    // Ellis 2–0 (+4); Olivia and Sarah 1–1 (0); James and Marcus 0–1 (−2).
    await renderBoard([
      owed('ellis', 'sarah'),
      owed('ellis', 'olivia'),
      owed('sarah', 'marcus'),
      owed('olivia', 'james'),
    ]);
    expect(text(container.querySelector('.leader-note'))).toBe(
      'Ellis leads with +4 net rolls, 4 ahead of Olivia and Sarah.',
    );
    await sortBy('wins');
    expect(text(container.querySelector('.leader-note'))).toBe(
      'Ellis leads with 2 confirmed wins, 1 ahead of Olivia and Sarah.',
    );
  });

  it('keeps each record to one wins–losses column for phones, beside the two it replaces there', async () => {
    await renderBoard([owed('ellis', 'sarah'), owed('ellis', 'olivia'), owed('sarah', 'ellis')]);
    const headers = [...table()!.querySelectorAll('[role="columnheader"]')];
    const record = headers.find((header) => header.classList.contains('col-record'))!;
    expect(text(record)).toBe('W–L');
    expect(record.getAttribute('aria-label')).toBe('Record: wins and losses');
    // The columns the phone layout hides stay in the markup for every wider layout.
    expect(headers.map((header) => text(header))).toEqual(
      expect.arrayContaining(['Wins', 'Losses']),
    );
    const cell = (name: string) =>
      rows()
        .find((row) => text(row.querySelector('.leaderboard-member strong')).startsWith(name))!
        .querySelector('.col-record')!;
    const drawn = (name: string) => text(cell(name).querySelector('[aria-hidden="true"]'));
    expect(drawn('Ellis')).toBe('2–1');
    expect(drawn('Olivia')).toBe('0–1');
    // Spoken as counts, not as two numbers with a dash between them.
    expect(cell('Ellis').querySelector('.sr-only')?.textContent).toBe('2 wins, 1 loss');
    expect(cell('Olivia').querySelector('.sr-only')?.textContent).toBe('0 wins, 1 loss');
    // Ranking by wins marks the record column as sorted, as it does the Wins column.
    await sortBy('wins');
    expect(record.getAttribute('aria-sort')).toBe('descending');
  });

  it('ranks by win rate only from three decided bets and says so', async () => {
    const wins = [1, 2, 3].map((n) => owed('ellis', 'sarah', { title: `Ellis win ${n}` }));
    await renderBoard([...wins, owed('sarah', 'ellis'), owed('marcus', 'olivia')]);
    await sortBy('rate');
    // Marcus is 1-0, but one lucky bet does not outrank Ellis's 3-1.
    expect(names().slice(0, 2)).toEqual(['Ellis you', 'Sarah']);
    expect(ranks()).toEqual([
      '1st',
      '2nd',
      'Not ranked, needs 3 decided bets',
      'Not ranked, needs 3 decided bets',
    ]);
    expect(text(container.querySelector('.table-footer'))).toContain('3 or more decided bets');
    expect(text(container.querySelector('.leader-note'))).toBe(
      'Ellis leads with a 75% win rate, 50 points ahead of Sarah.',
    );
  });

  it('says beside an unranked member why a win rate does not rank them yet', async () => {
    const wins = [1, 2, 3].map((n) => owed('ellis', 'sarah', { title: `Ellis win ${n}` }));
    await renderBoard([...wins, owed('sarah', 'ellis'), owed('marcus', 'olivia')]);
    const reasons = () => rows().map((row) => row.querySelector('.unranked-reason'));
    // Ranked by net rolls everyone with a result is ranked, so nobody needs an explanation.
    expect(reasons().every((reason) => reason === null)).toBe(true);
    await sortBy('rate');
    expect(ranks()).toEqual([
      '1st',
      '2nd',
      'Not ranked, needs 3 decided bets',
      'Not ranked, needs 3 decided bets',
    ]);
    expect(reasons().map((reason) => reason && text(reason))).toEqual([
      null,
      null,
      'Needs 3 decided bets',
      'Needs 3 decided bets',
    ]);
    // Drawn for the eye, written for everyone in the rank cell; and the name stays just the name.
    expect(reasons()[2]!.getAttribute('aria-hidden')).toBe('true');
    expect(reasons()[2]!.closest('.leaderboard-member')).not.toBeNull();
    expect(names()).toEqual(['Ellis you', 'Sarah', 'Marcus', 'Olivia']);
    // Ranking by something else again leaves no stale explanation behind.
    await sortBy('wins');
    expect(reasons().every((reason) => reason === null)).toBe(true);
  });

  it('puts the three-bet rule in the lead note when nobody qualifies for a win-rate ranking', async () => {
    await renderBoard([owed('ellis', 'sarah'), owed('olivia', 'marcus')]);
    // By net rolls there is a leader; the note is the sentence about them.
    expect(text(container.querySelector('.leader-note'))).toMatch(/share the lead/);
    await sortBy('rate');
    expect(ranks().every((rank) => rank.startsWith('Not ranked'))).toBe(true);
    const note = container.querySelector('.leader-note')!;
    expect(text(note)).toBe('No one has 3 decided bets yet, so no win-rate ranking.');
    expect(note.compareDocumentPosition(table()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await sortBy('net');
    expect(text(container.querySelector('.leader-note'))).toMatch(/share the lead/);
  });

  it('says nothing about a win-rate rule while no result is confirmed yet', async () => {
    await renderBoard([proposal('ellis', 'sarah')]);
    expect(container.querySelector('.leader-note')).toBeNull();
    expect(container.querySelector('.sort-control')).toBeNull();
  });

  it('draws a level net in neutral ink and a negative one with a minus sign', async () => {
    await renderBoard([owed('ellis', 'sarah'), owed('sarah', 'ellis')]);
    const net = (name: string) =>
      rows()
        .find((row) => text(row.querySelector('.leaderboard-member strong')).startsWith(name))!
        .querySelector('.leaderboard-net')!;
    expect(text(net('Ellis'))).toBe('0');
    expect(net('Ellis').className).not.toMatch(/green|red/);
    await renderBoard([owed('ellis', 'sarah')]);
    expect(text(net('Sarah'))).toBe('−2');
    expect(net('Sarah').className).toContain('red');
  });
});
