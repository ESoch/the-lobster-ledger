import { describe, expect, it, vi } from 'vitest';
import { csvCell, exportCsv, exportFilename, exportJson, exportPricesCsv } from './export';
import { createDemoState } from './demo';
import type { Bet, LedgerState, Member, PriceObservation } from './types';

const column = (csv: string, row: number, header: string) => {
  const lines = csv.split('\r\n');
  const columns = lines[0].match(/"(?:[^"]|"")*"/g)!;
  const cells = lines[row].match(/"(?:[^"]|"")*"/g)!;
  return cells[columns.indexOf(csvCell(header))];
};

describe('ledger CSV export', () => {
  it('says who decides each bet and names the judge', () => {
    const { bets, members } = createDemoState();
    const judged = bets.find((bet) => bet.decisionMethod === 'judge')!;
    const mutual = bets.find((bet) => (bet.decisionMethod ?? 'mutual') === 'mutual')!;
    const chatgpt = bets.find((bet) => bet.decisionMethod === 'chatgpt')!;
    const csv = exportCsv([judged, mutual, chatgpt], members);
    const judge = members.find((member) => member.id === judged.judgeId)!;
    expect(column(csv, 1, 'Decided by')).toBe(csvCell('Judge'));
    expect(column(csv, 1, 'Judge')).toBe(csvCell(judge.name));
    expect(column(csv, 2, 'Decided by')).toBe(csvCell('Mutual agreement'));
    expect(column(csv, 2, 'Judge')).toBe(csvCell(''));
    expect(column(csv, 3, 'Decided by')).toBe(csvCell('ChatGPT'));
  });
  it('exports the status people see and keeps the raw code in its own column', () => {
    const { bets, members } = createDemoState();
    const settled = bets.find((bet) => bet.status === 'settled')!;
    const offset: Bet = {
      ...settled,
      settlement: undefined,
      offsets: [
        {
          id: 'offset-1',
          actorId: settled.creatorId,
          counterpartyId: settled.opponentId,
          at: settled.updatedAt,
          rolls: settled.stake,
          allocations: [{ betId: settled.id, version: settled.version, rolls: settled.stake }],
          references: { [settled.id]: settled.reference },
        },
      ],
    };
    const history = bets.find((bet) => bet.history && bet.status === 'pending');
    const pendingHistory: Bet = history ?? {
      ...bets.find((bet) => bet.status === 'pending')!,
      history: {
        stage: 'owed',
        originalDate: { precision: 'year', value: '2025' },
        result: { winnerId: bets[0].creatorId, date: { precision: 'unknown' }, note: 'Won.' },
        proposedBy: bets[0].creatorId,
        revision: 1,
        approvals: [],
      },
    };
    const withdrawn = bets.find((bet) => bet.events.at(-1)?.type === 'withdraw')!;
    const csv = exportCsv([offset, pendingHistory, withdrawn, settled], members);
    expect(column(csv, 1, 'Status')).toBe(csvCell('Settled by offset'));
    expect(column(csv, 1, 'Status code')).toBe(csvCell('settled'));
    expect(column(csv, 2, 'Status')).toBe(csvCell('Confirming history'));
    expect(column(csv, 2, 'Status code')).toBe(csvCell('pending'));
    expect(column(csv, 3, 'Status')).toBe(csvCell('Withdrawn'));
    expect(column(csv, 3, 'Status code')).toBe(csvCell('declined'));
    expect(column(csv, 4, 'Status')).toBe(csvCell('Settled'));
  });
  it("stamps export filenames with the member's local calendar day", () => {
    // Late evening on the member's clock, whatever the UTC day is at that moment.
    const evening = new Date(2026, 9, 18, 23, 30);
    expect(exportFilename('csv', evening)).toBe('lobster-ledger-2026-10-18.csv');
    expect(exportFilename('json', evening)).toBe('lobster-ledger-audit-2026-10-18.json');
    expect(exportFilename('csv', new Date(2026, 0, 2, 0, 15))).toBe('lobster-ledger-2026-01-02.csv');
  });
  it('marks a judge who stepped down in the Judge column', () => {
    const { bets, members } = createDemoState();
    const judged = bets.find((bet) => bet.decisionMethod === 'judge' && !bet.judgeDeclined)!;
    const judge = members.find((member) => member.id === judged.judgeId)!;
    const stepped: Bet = {
      ...judged,
      judgeDeclined: { at: '2026-10-02T00:00:00.000Z', note: 'Conflicted.' },
    };
    expect(column(exportCsv([stepped], members), 1, 'Judge')).toBe(
      csvCell(`${judge.name} (stepped down)`),
    );
  });
  it('handles a judge who is no longer a member without crashing', () => {
    const { bets } = createDemoState();
    const judged = bets.find((bet) => bet.decisionMethod === 'judge')!;
    const members: Member[] = [];
    expect(column(exportCsv([judged], members), 1, 'Judge')).toBe(csvCell(''));
  });
  it('labels a source reported after creation in exports', () => {
    const { bets, members } = createDemoState();
    const csv = exportCsv(
      [
        {
          ...bets[0],
          entrySource: 'mcp',
          entrySourceReport: {
            basis: 'user_report',
            note: 'Entered via MCP.',
            reportedAt: '2026-10-15T17:00:00.000Z',
          },
        },
      ],
      members,
    );
    expect(csv).toContain('"MCP (reported)"');
  });

  it('labels inferred entry sources in exports', () => {
    const { bets, members } = createDemoState();
    const csv = exportCsv(
      [
        {
          ...bets[0],
          entrySource: 'browser',
          entrySourceInference: {
            basis: 'before_cli_release',
            cutoffAt: '2025-01-15T12:00:00.000Z',
            evidenceUrl: 'https://example.org/runs/12345',
            inferredAt: '2026-10-15T17:00:00.000Z',
          },
        },
      ],
      members,
    );
    expect(csv).toContain('"Browser (inferred)"');
  });

  it.each([
    ['browser', 'Browser'],
    ['cli', 'CLI'],
    ['mcp', 'MCP'],
    [undefined, 'Not recorded'],
  ] as const)(
    'exports entry source %s without guessing for older records',
    (entrySource, label) => {
      const { bets, members } = createDemoState();
      const csv = exportCsv([{ ...bets[0], entrySource }], members);
      const [header, row] = csv.split('\r\n');
      const columns = header.match(/"(?:[^"]|"")*"/g)!;
      const cells = row.match(/"(?:[^"]|"")*"/g)!;
      expect(cells[columns.indexOf('"Entry source"')]).toBe(csvCell(label));
    },
  );

  it('quotes commas, line breaks, and quotation marks without corrupting cells', () => {
    expect(csvCell('A, "fair" bet\nnext line')).toBe('"A, ""fair"" bet\nnext line"');
  });
  it('neutralizes spreadsheet formulas in user-controlled text', () => {
    for (const value of ['=HYPERLINK("bad")', '+SUM(1,2)', '-1+2', '@SUM(1)', '\t=1', '\r=1']) {
      expect(csvCell(value).startsWith('"\'')).toBe(true);
    }
  });
  it('exports a useful header even when there are no bets', () => {
    expect(exportCsv([], [])).toContain('Reference');
    expect(exportCsv([], [])).toContain('Created at');
  });
  it('distinguishes reported historical facts from actual recording and confirmations', () => {
    const { bets, members } = createDemoState();
    const bet = structuredClone(bets[0]);
    bet.history = {
      stage: 'settled',
      originalDate: { precision: 'month', value: '2026-06' },
      result: {
        winnerId: bet.creatorId,
        date: { precision: 'unknown' },
        note: 'Published final score.',
      },
      delivery: { date: { precision: 'day', value: '2026-08-01' }, note: 'Actual rolls at lunch.' },
      proposedBy: bet.creatorId,
      revision: 1,
      approvals: [],
    };
    const csv = exportCsv([bet], members);
    expect(csv).toContain('Original bet date');
    expect(csv).toContain('2026-06');
    expect(csv).toContain('History confirmed at');
    expect(csv).toContain('Published final score.');
    expect(csv).toContain('Actual rolls at lunch.');
    expect(csv).toContain(bet.createdAt);
  });
  it('exports event-based timing and a separate cutoff without inventing a decision date', () => {
    const { bets, members } = createDemoState();
    const bet = {
      ...bets[0],
      deadline: '',
      timing: {
        kind: 'event' as const,
        description: 'The acquisition officially closes',
        source: 'Company announcement',
      },
      cutoff: { at: '2026-10-01T00:00:00Z', timezone: 'America/Los_Angeles' },
    };
    const csv = exportCsv([bet], members);
    expect(csv).toContain('The acquisition officially closes');
    expect(csv).toContain('Company announcement');
    expect(csv).toContain('America/Los_Angeles');
    expect(csv).toContain('Wager cutoff');
  });
});

describe('audit archive JSON export', () => {
  const now = () => '2026-09-17T12:00:00.000Z';
  const stateOf = (overrides: Partial<LedgerState> = {}): LedgerState => ({
    groupName: 'The Lobster Ledger',
    members: [],
    places: [],
    restaurants: [],
    priceObservations: [],
    bets: [],
    ...overrides,
  });

  it('preserves the complete ledger state alongside export metadata', () => {
    const demo = createDemoState();
    demo.bets[0].offsets = [
      {
        id: 'offset-1',
        actorId: demo.bets[0].creatorId,
        counterpartyId: demo.bets[0].opponentId,
        at: now(),
        rolls: 1,
        allocations: [{ betId: demo.bets[0].id, version: demo.bets[0].version, rolls: 1 }],
        references: { [demo.bets[0].id]: demo.bets[0].reference },
      },
    ];
    const parsed = JSON.parse(exportJson(demo, { mode: 'demo', now })) as Record<string, unknown>;
    expect(parsed).toEqual({ exportedAt: now(), mode: 'demo', ...demo });
  });

  it('keeps every price report, with its withdrawal, correction reason and source', () => {
    const report = {
      id: 'price-1',
      restaurantId: 'shack',
      itemName: 'Classic lobster roll',
      priceCents: 2800,
      currency: 'USD' as const,
      visitDate: '2026-09-11',
      visitDatePrecision: 'day' as const,
      reporterId: 'ellis',
      reportedAt: '2026-09-11T20:00:00.000Z',
    };
    const state = stateOf({
      priceObservations: [
        {
          ...report,
          withdrawnAt: '2026-09-12T09:00:00.000Z',
          withdrawnReason: 'Wrong restaurant',
          entrySource: 'mcp',
        },
        {
          ...report,
          id: 'price-2',
          correctedFromId: 'price-0',
          correctionReason: 'Misread the menu',
          entrySource: 'web',
        },
      ],
    });
    const parsed = JSON.parse(exportJson(state, { now })) as LedgerState;
    expect(parsed.priceObservations).toEqual(state.priceObservations);
  });

  it('defaults to shared mode and a fresh timestamp', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(now()));
      const parsed = JSON.parse(exportJson(stateOf())) as { exportedAt: string; mode: string };
      expect(parsed.mode).toBe('shared');
      expect(parsed.exportedAt).toBe(now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the ledger group name', () => {
    const parsed = JSON.parse(exportJson(stateOf({ groupName: 'Custom Group' }), { now })) as {
      groupName: string;
    };
    expect(parsed.groupName).toBe('Custom Group');
  });

  it('pretty-prints the archive with stable two-space indentation', () => {
    const text = exportJson(stateOf({ groupName: 'G' }), { now });
    expect(text.startsWith('{\n  "exportedAt"')).toBe(true);
    expect(text).toContain('"groupName": "G"');
  });

  it('exports a structurally valid archive with no bets', () => {
    const parsed = JSON.parse(exportJson(stateOf(), { now })) as {
      bets: unknown[];
      members: unknown[];
    };
    expect(Array.isArray(parsed.bets)).toBe(true);
    expect(Array.isArray(parsed.members)).toBe(true);
    expect(parsed.bets).toHaveLength(0);
  });
});

describe('price CSV export', () => {
  const members: Member[] = [
    { id: 'm1', name: 'Alex', initials: 'A', color: '#000' } as Member,
    { id: 'm2', name: 'Blair', initials: 'B', color: '#111' } as Member,
  ];
  const restaurants = [
    { id: 'r1', name: 'Harbor Shack', address: '1 Pier Rd, Portland, ME' },
    { id: 'r2', name: '=Evil Grill', address: '2 Main St' },
  ];
  const observation = (over: Partial<PriceObservation>): PriceObservation => ({
    id: 'p1',
    restaurantId: 'r1',
    itemName: 'Classic roll',
    priceCents: 2850,
    currency: 'USD',
    visitDate: '2026-09-11',
    visitDatePrecision: 'day',
    reporterId: 'm1',
    reportedAt: '2026-09-12T10:00:00.000Z',
    ...over,
  });
  const state = (priceObservations: PriceObservation[]): LedgerState => ({
    members,
    bets: [],
    places: [],
    restaurants,
    priceObservations,
    groupName: 'Friends',
  });

  it('writes one row per report with dollars, precision, reporter and the correction trail', () => {
    const csv = exportPricesCsv(
      state([
        observation({ id: 'p1', correctedAt: '2026-09-13T09:00:00.000Z' }),
        observation({
          id: 'p2',
          priceCents: 3000,
          reporterId: 'm2',
          reportedAt: '2026-09-13T09:00:00.000Z',
          correctedFromId: 'p1',
        }),
        observation({ id: 'p3', visitDate: '2024', visitDatePrecision: 'year', priceCents: 1999 }),
      ]),
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(column(csv, 1, 'Restaurant')).toBe(csvCell('Harbor Shack'));
    expect(column(csv, 1, 'Address')).toBe(csvCell('1 Pier Rd, Portland, ME'));
    expect(column(csv, 1, 'Item')).toBe(csvCell('Classic roll'));
    // Oldest visit first, then the first report of a visit before its correction.
    expect(column(csv, 1, 'Visit date')).toBe(csvCell('2024'));
    expect(column(csv, 1, 'Precision')).toBe(csvCell('year'));
    expect(column(csv, 1, 'Price')).toBe(csvCell('19.99'));
    expect(column(csv, 1, 'Currency')).toBe(csvCell('USD'));
    expect(column(csv, 2, 'ID')).toBe(csvCell('p1'));
    expect(column(csv, 2, 'Price')).toBe(csvCell('28.50'));
    expect(column(csv, 2, 'Reporter')).toBe(csvCell('Alex'));
    expect(column(csv, 2, 'Reported at')).toBe(csvCell('2026-09-12T10:00:00.000Z'));
    expect(column(csv, 2, 'Corrected at')).toBe(csvCell('2026-09-13T09:00:00.000Z'));
    expect(column(csv, 2, 'Corrected from')).toBe(csvCell(''));
    expect(column(csv, 3, 'ID')).toBe(csvCell('p2'));
    expect(column(csv, 3, 'Price')).toBe(csvCell('30.00'));
    expect(column(csv, 3, 'Reporter')).toBe(csvCell('Blair'));
    expect(column(csv, 3, 'Corrected from')).toBe(csvCell('p1'));
    expect(column(csv, 3, 'Corrected at')).toBe(csvCell(''));
  });

  it('keeps withdrawn reports, with when and why, and the correction reason and entry source', () => {
    const csv = exportPricesCsv(
      state([
        observation({
          id: 'p1',
          visitDate: '2026-09-01',
          withdrawnAt: '2026-09-02T08:00:00.000Z',
          withdrawnReason: 'Wrong restaurant, "Harbor" not Dock',
          entrySource: 'mcp',
        }),
        observation({
          id: 'p2',
          visitDate: '2026-09-02',
          correctedFromId: 'p0',
          correctionReason: 'Misread the menu',
          entrySource: 'web',
        }),
        observation({ id: 'p3', visitDate: '2026-09-03' }),
      ]),
    );
    expect(csv.split('\r\n')).toHaveLength(4);
    expect(column(csv, 1, 'Withdrawn at')).toBe(csvCell('2026-09-02T08:00:00.000Z'));
    expect(column(csv, 1, 'Withdrawn reason')).toBe(csvCell('Wrong restaurant, "Harbor" not Dock'));
    expect(column(csv, 1, 'Correction reason')).toBe(csvCell(''));
    expect(column(csv, 1, 'Entry source')).toBe(csvCell('MCP'));
    expect(column(csv, 2, 'Withdrawn at')).toBe(csvCell(''));
    expect(column(csv, 2, 'Withdrawn reason')).toBe(csvCell(''));
    expect(column(csv, 2, 'Correction reason')).toBe(csvCell('Misread the menu'));
    expect(column(csv, 2, 'Entry source')).toBe(csvCell('Browser'));
    // Reports from before the ledger recorded where they came from say so.
    expect(column(csv, 3, 'Entry source')).toBe(csvCell('Not recorded'));
  });

  it('neutralises spreadsheet formulas in the withdrawn and correction reasons', () => {
    const csv = exportPricesCsv(
      state([
        observation({
          withdrawnAt: '2026-09-02T08:00:00.000Z',
          withdrawnReason: '=HYPERLINK("http://x")',
          correctionReason: '@SUM(A1)',
        }),
      ]),
    );
    expect(column(csv, 1, 'Withdrawn reason')).toBe(csvCell(`'=HYPERLINK("http://x")`));
    expect(column(csv, 1, 'Correction reason')).toBe(csvCell("'@SUM(A1)"));
  });

  it('neutralises spreadsheet formulas in restaurant and item names', () => {
    const csv = exportPricesCsv(state([observation({ restaurantId: 'r2', itemName: '@SUM(A1)' })]));
    expect(column(csv, 1, 'Restaurant')).toBe(csvCell("'=Evil Grill"));
    expect(column(csv, 1, 'Item')).toBe(csvCell("'@SUM(A1)"));
  });

  it('exports only the header when no prices are on record, and survives a missing restaurant', () => {
    expect(
      exportPricesCsv({ ...state([]), restaurants: undefined, priceObservations: undefined }).split(
        '\r\n',
      ),
    ).toHaveLength(1);
    const csv = exportPricesCsv(state([observation({ restaurantId: 'gone', reporterId: 'gone' })]));
    expect(column(csv, 1, 'Restaurant')).toBe(csvCell(''));
    expect(column(csv, 1, 'Reporter')).toBe(csvCell(''));
  });

  it('names the prices file by local day', () => {
    expect(exportFilename('prices', new Date(2026, 9, 18, 23, 30))).toBe(
      'lobster-ledger-prices-2026-10-18.csv',
    );
  });
});
