import { readdirSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyAction, createBet } from '../lib/ledger';
import type { LedgerState, Member } from '../lib/types';
import { ActionItem } from './ActionItem';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** Source with its comments removed, so only code and the words people read remain. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('one word for what a named judge records', () => {
  // Every file whose strings reach people: the sheet and its parts, inbox rows, toasts, the rules
  // engine's refusals and stored records, and the server's refusals.
  const files = [
    ...readdirSync(new URL('.', import.meta.url))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name))
      .map((name) => `./${name}`),
    '../App.tsx',
    '../lib/bet-workflow.ts',
    '../lib/form-context.ts',
    '../lib/ledger.ts',
    '../lib/toast-copy.ts',
    '../../worker/bet-actions.ts',
  ];
  it.each(files)('never calls it a ruling in %s', (path) => {
    expect(withoutComments(read(path))).not.toMatch(/\brulings?\b/i);
  });

  it('labels a judged result in the inbox as a recommendation', () => {
    const members: Member[] = [
      { id: 'a', name: 'Avery Stone', initials: 'AS', color: '#153b3e' },
      { id: 'b', name: 'Blair Reed', initials: 'BR', color: '#4a3b1e' },
      { id: 'c', name: 'Casey Hale', initials: 'CH', color: '#2b4a1e' },
    ];
    const now = '2026-09-01T12:00:00.000Z';
    const agreed = applyAction(
      createBet(
        {
          title: 'Friday release',
          terms: 'Ships by the agreed cutoff.',
          category: 'Work',
          opponentId: 'b',
          creatorSide: 'Ships',
          opponentSide: 'Delayed',
          stake: 2,
          deadline: '2026-09-05',
          decisionMethod: 'judge',
          judgeId: 'c',
        },
        'a',
        members,
        now,
      ),
      { type: 'accept' },
      'b',
      now,
    );
    const judged = applyAction(
      agreed,
      { type: 'adjudicate', winnerId: 'a', note: 'It shipped Thursday.' },
      'c',
      now,
    );
    const state = { members, bets: [judged], places: [], groupName: 'Test' } as LedgerState;
    const markup = renderToStaticMarkup(
      createElement(ActionItem, { bet: judged, state, memberId: 'a', onOpen: () => {} }),
    );
    expect(markup).toContain('Casey recorded a recommendation');
  });
});
