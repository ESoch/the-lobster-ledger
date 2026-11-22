import { describe, expect, it } from 'vitest';
import {
  addEvidenceToPrompt,
  buildAdjudicationBrief,
  NO_EVIDENCE_YET,
  removeEvidenceFromPrompt,
} from './adjudication';
import { createDemoState } from './demo';

it('preserves the exact agreed terms and positions without implying AI already decided', () => {
  const state = createDemoState();
  const bet = state.bets[0];
  const brief = buildAdjudicationBrief(bet, state.members);
  expect(brief).toContain(bet.terms);
  expect(brief).toContain(bet.creatorSide);
  expect(brief).toContain(bet.opponentSide);
  expect(brief).toContain('Do not invent evidence');
  expect(brief).toContain('Both bettors must still confirm');
  expect(brief).toContain('Evidence to assess:');
});

it('includes the agreed event, separate cutoff and supplied evidence in the prompt draft', () => {
  const state = createDemoState();
  const bet = {
    ...state.bets[0],
    deadline: '',
    timing: {
      kind: 'event' as const,
      description: 'The acquisition officially closes',
      source: 'The closing announcement',
    },
    cutoff: { at: '2026-10-01T00:00:00Z', timezone: 'America/Los_Angeles' },
    readiness: {
      at: '2026-09-30T12:00:00Z',
      markedBy: 'ellis',
      evidence: 'The announcement states the deal closed September 29.',
    },
  };
  const brief = buildAdjudicationBrief(bet, state.members);
  expect(brief).toContain('The acquisition officially closes');
  expect(brief).toContain('America/Los_Angeles');
  expect(brief).toContain('The closing announcement');
  expect(brief).toContain(bet.readiness.evidence);
  expect(brief).not.toContain('No additional evidence has been included');
  expect(brief).not.toContain('Decision date:  (UTC)');
});

it('writes the verification time and cutoff in the agreed timezone, not as raw UTC stamps', () => {
  const state = createDemoState();
  const bet = {
    ...state.bets[0],
    deadline: '',
    timing: {
      kind: 'date' as const,
      at: '2026-10-01T21:30:00.000Z',
      timezone: 'America/New_York',
    },
    cutoff: { at: '2026-09-30T02:00:00.000Z', timezone: 'Pacific/Auckland' },
  };
  const brief = buildAdjudicationBrief(bet, state.members);
  expect(brief).toMatch(
    /Verification can begin: Oct 1, 2026, 5:30\sPM EDT \(America\/New_York\)\./,
  );
  expect(brief).toMatch(/Wager cutoff: Sep 30, 2026, 3:00\sPM GMT\+13 \(Pacific\/Auckland\)\./);
  expect(brief).not.toContain('2026-10-01T21:30');
  expect(brief).not.toContain('2026-09-30T02:00');
  expect(brief).not.toContain('display timezone');
});

it('adds evidence recorded after a prompt where the prompt expects it', () => {
  const state = createDemoState();
  const drafted = buildAdjudicationBrief({ ...state.bets[0], readiness: undefined }, state.members);
  expect(drafted).toContain(NO_EVIDENCE_YET);
  const filled = addEvidenceToPrompt(drafted, 'The scoreboard photo at 9:41.');
  expect(filled).not.toContain(NO_EVIDENCE_YET);
  expect(filled).toContain('Evidence to assess:\nThe scoreboard photo at 9:41.\n\nReturn');
  const again = addEvidenceToPrompt(filled, 'The referee’s report.');
  expect(again).toContain(
    'Evidence to assess:\nThe scoreboard photo at 9:41.\nThe referee’s report.\n\nReturn',
  );
  expect(addEvidenceToPrompt(again, 'The referee’s report.')).toBe(again);
  expect(addEvidenceToPrompt('Decide this bet fairly.', 'The log.')).toBe(
    'Decide this bet fairly.\n\nEvidence recorded on the ledger after this prompt was agreed:\nThe log.',
  );
});

describe('taking evidence that came off the bet out of a prompt', () => {
  const state = createDemoState();
  const quoted = 'Final standings posted 22:41: Sarah’s team 2nd, Ellis’s 5th.';
  const drafted = buildAdjudicationBrief(
    {
      ...state.bets[0],
      readiness: { at: '2026-09-30T12:00:00Z', markedBy: 'sarah', evidence: quoted },
    },
    state.members,
  );

  it('puts the draft’s placeholder where the evidence was, when nothing replaces it', () => {
    expect(drafted).toContain(quoted);
    const cleaned = removeEvidenceFromPrompt(drafted, [quoted]);
    expect(cleaned).not.toContain(quoted);
    expect(cleaned).toContain(`Evidence to assess:\n${NO_EVIDENCE_YET}\n\nReturn`);
    // The rest of the wording is untouched.
    expect(cleaned.replace(NO_EVIDENCE_YET, quoted)).toBe(drafted);
  });

  it('puts the evidence now on the bet in its place, not beside it', () => {
    const current = 'The league’s corrected table, posted Oct 12.';
    const swapped = removeEvidenceFromPrompt(drafted, [quoted], current);
    expect(swapped).toContain(`Evidence to assess:\n${current}\n\nReturn`);
    expect(swapped).not.toContain(quoted);
    // Adding it afterwards finds it there already.
    expect(addEvidenceToPrompt(swapped, current)).toBe(swapped);
  });

  it('drops the removed evidence outright when the current evidence is already in the prompt', () => {
    const current = 'The league’s corrected table, posted Oct 12.';
    const both = addEvidenceToPrompt(drafted, current);
    expect(both).toContain(`${quoted}\n${current}`);
    const cleaned = removeEvidenceFromPrompt(both, [quoted], current);
    expect(cleaned).toContain(`Evidence to assess:\n${current}\n\nReturn`);
    expect(cleaned).not.toContain(quoted);
  });

  it('leaves a prompt that does not quote it, or has none to remove, as it was', () => {
    expect(removeEvidenceFromPrompt(drafted, ['Something never quoted.'])).toBe(drafted);
    expect(removeEvidenceFromPrompt(drafted, [])).toBe(drafted);
    expect(removeEvidenceFromPrompt(drafted, [''])).toBe(drafted);
  });

  it('leaves a prompt alone that quotes only a longer version of the removed evidence', () => {
    const longer = `${quoted} Confirmed on the league site.`;
    const withLonger = addEvidenceToPrompt(removeEvidenceFromPrompt(drafted, [quoted]), longer);
    expect(withLonger).toContain(`Evidence to assess:\n${longer}\n\nReturn`);
    expect(removeEvidenceFromPrompt(withLonger, [quoted], longer)).toBe(withLonger);
  });

  it('takes the evidence out of the evidence section, not the line naming where to look', () => {
    // The evidence is the address the bet expects it at, so it is in the prompt twice.
    const url = 'https://league.example/standings';
    const sourced = buildAdjudicationBrief(
      {
        ...state.bets[0],
        timing: { kind: 'evidence', description: 'The league posts standings', source: url },
        readiness: { at: '2026-09-30T12:00:00Z', markedBy: 'sarah', evidence: url },
      },
      state.members,
    );
    expect(sourced).toContain(`Expected evidence source: ${url}`);
    expect(sourced).toContain(`Evidence to assess:\n${url}\n\nReturn`);
    const cleaned = removeEvidenceFromPrompt(sourced, [url]);
    expect(cleaned).toContain(`Expected evidence source: ${url}`);
    expect(cleaned).toContain(`Evidence to assess:\n${NO_EVIDENCE_YET}\n\nReturn`);
    // With a prompt that names the address only as where to look, there is nothing to take out.
    const lookedFor = sourced.replace(
      `Evidence to assess:\n${url}`,
      `Evidence to assess:\n${NO_EVIDENCE_YET}`,
    );
    expect(removeEvidenceFromPrompt(lookedFor, [url])).toBe(lookedFor);
  });

  it('takes out the last quote when the prompt has no evidence heading to go by', () => {
    const text = `Judge the table.\n${quoted}\nNo more than that.\n${quoted}`;
    expect(removeEvidenceFromPrompt(text, [quoted])).toBe(
      `Judge the table.\n${quoted}\nNo more than that.\n${NO_EVIDENCE_YET}`,
    );
  });

  it('puts the placeholder in once when several removed pieces of evidence stood there', () => {
    const second = 'The league’s other table.';
    const both = addEvidenceToPrompt(drafted, second);
    expect(both).toContain(`${quoted}\n${second}`);
    const cleaned = removeEvidenceFromPrompt(both, [quoted, second]);
    expect(cleaned).toContain(`Evidence to assess:\n${NO_EVIDENCE_YET}\n\nReturn`);
    expect(cleaned.split(NO_EVIDENCE_YET)).toHaveLength(2);
    expect(cleaned).not.toContain(second);
  });
});
