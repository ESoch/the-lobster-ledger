import { describe, expect, it } from 'vitest';
import {
  captureFormBet,
  getFormSubmissionBet,
  isCurrentPromptCopied,
  isFormBetCurrent,
} from './form-context';
import { createDemoState } from './demo';
import { applyAction } from './ledger';

const promptBet = () => createDemoState().bets.find((bet) => bet.decisionMethod === 'chatgpt')!;
const now = '2026-09-12T12:00:00.000Z';

describe('version-bound action drafts', () => {
  it('captures the exact prompt independently of later changes to the supplied object', () => {
    const bet = promptBet();
    const originalText = bet.promptAgreement!.text;
    const captured = captureFormBet(bet);
    bet.promptAgreement!.text = 'A different prompt';
    bet.events.push({
      id: 'later',
      at: now,
      actorId: 'ellis',
      type: 'test',
      detail: 'A later event',
    });
    expect(captured.promptAgreement?.text).toBe(originalText);
    expect(captured.events).toHaveLength(3);
  });
  it('submits the captured snapshot when its version is still current', () => {
    const bet = promptBet();
    const captured = captureFormBet(bet);
    expect(isFormBetCurrent(captured, bet)).toBe(true);
    expect(getFormSubmissionBet(captured, bet)).toBe(captured);
  });
  it('rejects a stale revision instead of rebasing the old draft onto a newer prompt', () => {
    const bet = promptBet();
    const captured = captureFormBet(bet);
    const updated = applyAction(
      bet,
      {
        type: 'propose_prompt',
        text: bet.promptAgreement!.text + ' Consider the additional evidence.',
      },
      'sarah',
      now,
    );
    expect(isFormBetCurrent(captured, updated)).toBe(false);
    expect(() => getFormSubmissionBet(captured, updated)).toThrow(/changed/i);
    expect(captured.promptAgreement?.version).toBe(1);
    expect(updated.promptAgreement?.version).toBe(2);
  });
  it('rejects a response to prompt v1 even after prompt v2 has acquired both approvals', () => {
    let bet = applyAction(promptBet(), { type: 'approve_prompt' }, 'sarah', now);
    const captured = captureFormBet(bet);
    bet = applyAction(
      bet,
      {
        type: 'propose_prompt',
        text: bet.promptAgreement!.text + ' New jointly reviewed evidence.',
      },
      'sarah',
      now,
    );
    bet = applyAction(bet, { type: 'approve_prompt' }, 'ellis', now);
    expect(bet.promptAgreement?.approvals).toHaveLength(2);
    expect(() => getFormSubmissionBet(captured, bet)).toThrow(/changed/i);
  });
  it('requires a matching record and a captured form context', () => {
    const bet = promptBet();
    expect(isFormBetCurrent(null, bet)).toBe(false);
    expect(() => getFormSubmissionBet(null, bet)).toThrow();
    expect(isFormBetCurrent({ ...bet, id: 'another-record' }, bet)).toBe(false);
  });
});

describe('exact prompt copy confirmation', () => {
  it('shows copied state only for the same prompt version and wording', () => {
    const prompt = promptBet().promptAgreement!;
    const copied = { version: prompt.version, text: prompt.text };
    expect(isCurrentPromptCopied(copied, prompt)).toBe(true);
    expect(isCurrentPromptCopied(copied, { ...prompt, version: prompt.version + 1 })).toBe(false);
    expect(isCurrentPromptCopied(copied, { ...prompt, text: prompt.text + ' Revised.' })).toBe(
      false,
    );
    expect(isCurrentPromptCopied(null, prompt)).toBe(false);
    expect(isCurrentPromptCopied(copied, undefined)).toBe(false);
  });
});
