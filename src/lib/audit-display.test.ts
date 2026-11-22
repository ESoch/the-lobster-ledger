import { describe, expect, it } from 'vitest';
import type { AuditEvent, Member } from './types';
import { auditDisplay, clearedResultText, formatAuditDetail } from './audit-display';

const winnerId = '5b694087-e8e0-47c3-b53a-8fad62034ec9';
const members: Member[] = [
  { id: winnerId, name: 'Peter Miller', initials: 'PM', color: '#153b3e' },
];
const record = (type: string, detail: string): AuditEvent => ({
  id: 'event',
  actorId: 'actor',
  at: '2026-09-12T06:00:00Z',
  type,
  detail,
});

describe('human-readable audit details', () => {
  it('shows the proposed winner name without altering the immutable record or evidence', () => {
    const event = record(
      'propose_result',
      `Proposed winner ${winnerId}: Zillow supports Peter’s win.`,
    );
    expect(formatAuditDetail(event, members)).toBe(
      'Proposed Peter Miller as the winner: Zillow supports Peter’s win.',
    );
    expect(event.detail).toBe(`Proposed winner ${winnerId}: Zillow supports Peter’s win.`);
  });

  it('resolves names in recorded recommendations and handles unavailable members', () => {
    const event = record(
      'adjudicate',
      `Recorded the assigned judge’s recommendation for winner ${winnerId}: Official results.`,
    );
    expect(formatAuditDetail(event, members)).toBe(
      'Recorded the assigned judge’s recommendation for winner Peter Miller: Official results.',
    );
    expect(
      formatAuditDetail(
        record('propose_result', 'Proposed winner absent-member: Evidence.'),
        members,
      ),
    ).toBe('Proposed a former member as the winner: Evidence.');
  });

  it('names the judge proposed or appointed by an amendment and keeps the token on the record', () => {
    const proposed = record(
      'propose_amendment',
      `Proposed revised decision criteria and timing: Decided by the published result (judge ${winnerId}) if unclear.\nProposed decision method: a named judge (judge ${winnerId})\nReason: Peter can judge it.`,
    );
    expect(formatAuditDetail(proposed, members)).toBe(
      `Proposed revised decision criteria and timing: Decided by the published result (judge ${winnerId}) if unclear.\nProposed decision method: a named judge (Peter Miller)\nReason: Peter can judge it.`,
    );
    expect(proposed.detail).toContain(`(judge ${winnerId})\nReason`);
    const agreed = record(
      'confirm_amendment',
      `Both bettors approved the revised decision criteria and timing. The bet is now decided by a named judge (judge ${winnerId}). Prior readiness and ChatGPT prompt consent were cleared.`,
    );
    expect(formatAuditDetail(agreed, members)).toBe(
      'Both bettors approved the revised decision criteria and timing. The bet is now decided by a named judge (Peter Miller). Prior readiness and ChatGPT prompt consent were cleared.',
    );
    expect(
      formatAuditDetail(
        record(
          'confirm_amendment',
          'Both bettors approved the revised decision criteria and timing. The bet is now decided by a named judge (judge gone-member). Prior readiness and ChatGPT prompt consent were cleared.',
        ),
        members,
      ),
    ).toContain('decided by a named judge (a former member).');
    const mutual = record(
      'confirm_amendment',
      'Both bettors approved the revised decision criteria and timing. The bet is now decided by mutual agreement. Prior readiness and ChatGPT prompt consent were cleared.',
    );
    expect(formatAuditDetail(mutual, members)).toBe(mutual.detail);
  });

  it('leaves quoted notes and unrelated identifiers intact', () => {
    const event = record(
      'propose_result',
      `Proposed a void result: Reference ${winnerId} in the original evidence.`,
    );
    expect(formatAuditDetail(event, members)).toBe(
      `Proposed calling the bet off with no winner: Reference ${winnerId} in the original evidence.`,
    );
    expect(event.detail).toBe(
      `Proposed a void result: Reference ${winnerId} in the original evidence.`,
    );
  });
});

describe('paper-trail entries are readable without changing the record', () => {
  const alex: Member = { id: 'alex-id', name: 'Alex Chen', initials: 'AC', color: '#bd4938' };
  const people = [...members, alex];
  const bet = { creatorId: winnerId, opponentId: alex.id };
  it('shows a check-in in its own timezone instead of a raw UTC stamp', () => {
    const set = record(
      'set_check_in',
      'Set their personal check-in to 2026-10-10T16:00:00.000Z (America/New_York). The agreed timing is unchanged.',
    );
    expect(formatAuditDetail(set, people)).toBe(
      'Set a personal check-in for Oct 10, 2026, 12:00 PM EDT (America/New_York). The agreed timing is unchanged.',
    );
    expect(
      formatAuditDetail(
        record('set_check_in', 'Removed their personal check-in. The agreed timing is unchanged.'),
        people,
      ),
    ).toBe('Removed a personal check-in. The agreed timing is unchanged.');
  });
  it('names the other bettor in an offset and leaves out the offset id', () => {
    const offset = {
      ...record(
        'offset_debts',
        'Offset 2 rolls against mutual debts with LL-1038. 0 remaining. No physical delivery recorded. Offset c210b9c9-5abc-4fb1-876a-0998086dbc94.',
      ),
      actorId: winnerId,
    };
    const text = formatAuditDetail(offset, people, bet);
    expect(text).toBe(
      'Offset 2 rolls against mutual debts with Alex Chen (LL-1038). 0 remaining. No physical delivery recorded.',
    );
    expect(text).not.toContain('c210b9c9');
    expect(formatAuditDetail(offset, people)).not.toContain('c210b9c9');
  });
  it('keeps a proposed prompt behind a disclosure instead of inline', () => {
    const prompt =
      'Act as a neutral reviewer of a friendly lobster-roll bet.\n\nWager: Friday demo';
    const shown = auditDisplay(
      record(
        'propose_prompt',
        `Proposed and approved ChatGPT prompt version 2. Exact prompt:\n${prompt}`,
      ),
      people,
    );
    expect(shown.text).toBe('Proposed and approved ChatGPT prompt version 2.');
    expect(shown.attachment).toEqual({ label: 'Read prompt v2 as proposed', text: prompt });
  });
  it('keeps the full reasoning and puts the share link and the next step on their own lines', () => {
    const reasoning = 'The published bracket shows Alex advanced. '.repeat(12).trim();
    const adjudicated = auditDisplay(
      record(
        'adjudicate',
        `Recorded an externally obtained ChatGPT (prompt version 1) recommendation for winner ${alex.id}: ${reasoning}\nChatGPT source: https://chatgpt.com/share/abc123 Both bettors must separately confirm the result.`,
      ),
      people,
    );
    expect(adjudicated.text).toBe(
      'Recorded an externally obtained ChatGPT (prompt version 1) recommendation for winner Alex Chen.\nChatGPT source: https://chatgpt.com/share/abc123\nBoth bettors must separately confirm the result.',
    );
    expect(adjudicated.attachment).toEqual({ label: 'Read the full reasoning', text: reasoning });
    const short = auditDisplay(
      record(
        'adjudicate',
        'Recorded the assigned judge’s recommendation for no winner: The match was rained out. Both bettors must separately confirm the result.',
      ),
      people,
    );
    expect(short.text).toBe(
      'Recorded the assigned judge’s recommendation for no winner: The match was rained out.\nBoth bettors must separately confirm the result.',
    );
    expect(short.attachment).toBeUndefined();
  });
  it('separates evidence and a judge’s reason from the sentence that follows', () => {
    expect(
      formatAuditDetail(
        record(
          'mark_ready',
          'Marked evidence ready for review: https://example.com/result No winner or debt has been recorded.',
        ),
        people,
      ),
    ).toBe(
      'Marked evidence ready for review: https://example.com/result\nNo winner or debt has been recorded.',
    );
    expect(
      formatAuditDetail(
        record(
          'decline_judging',
          'Declined to act as judge: I am conflicted. Both bettors must agree on a new judge or decision method before a ruling can be recorded.',
        ),
        people,
      ),
    ).toBe(
      'Declined to act as judge: I am conflicted.\nBoth bettors must agree on a new judge or decision method before a recommendation can be recorded.',
    );
    // Records written since the wording changed break the same way.
    expect(
      formatAuditDetail(
        record(
          'decline_judging',
          'Declined to act as judge: I am conflicted. Both bettors must agree on a new judge or decision method before a recommendation can be recorded.',
        ),
        people,
      ),
    ).toBe(
      'Declined to act as judge: I am conflicted.\nBoth bettors must agree on a new judge or decision method before a recommendation can be recorded.',
    );
  });
});

describe('a result or recommendation that was disagreed with', () => {
  const alex: Member = { id: 'alex-id', name: 'Alex Chen', initials: 'AC', color: '#bd4938' };
  const people = [...members, alex];
  it('quotes who a recommendation chose and why, without the instruction that no longer applies', () => {
    expect(
      clearedResultText(
        record(
          'adjudicate',
          `Recorded the assigned judge’s recommendation for winner ${winnerId}: Peter wins on the timestamps in the build log. Both bettors must separately confirm the result.`,
        ),
        people,
      ),
    ).toBe('Peter Miller wins: Peter wins on the timestamps in the build log.');
    expect(
      clearedResultText(
        record(
          'adjudicate',
          'Recorded an externally obtained ChatGPT (prompt version 2) recommendation for no winner: The sources disagree.\nChatGPT source: https://chatgpt.com/share/abc123 Both bettors must separately confirm the result.',
        ),
        people,
      ),
    ).toBe('No winner: The sources disagree.');
  });
  it('points to the paper trail for reasoning too long to quote', () => {
    const reasoning = 'The published bracket shows Alex advanced. '.repeat(12).trim();
    expect(
      clearedResultText(
        record(
          'adjudicate',
          `Recorded the assigned judge’s recommendation for winner ${alex.id}: ${reasoning} Both bettors must separately confirm the result.`,
        ),
        people,
      ),
    ).toBe('Alex Chen wins. The full reasoning is in the paper trail.');
  });
  it('reads a proposed result or a delivery report as the paper trail does', () => {
    expect(
      clearedResultText(
        record('propose_result', `Proposed winner ${winnerId}: Zillow supports Peter’s win.`),
        people,
      ),
    ).toBe('Proposed Peter Miller as the winner: Zillow supports Peter’s win.');
    expect(
      clearedResultText(
        record(
          'propose_settlement',
          'Reported delivery of 2 actual lobster rolls: Row 34 at lunch.',
        ),
        people,
      ),
    ).toBe('Reported delivery of 2 actual lobster rolls: Row 34 at lunch.');
  });
  it('words a disagreement with a result, delivery or evidence the way the buttons do', () => {
    expect(
      formatAuditDetail(record('dispute_result', 'Disputed the result: Wrong match.'), people),
    ).toBe('Disagreed with the result: Wrong match.');
    expect(
      formatAuditDetail(
        record('dispute_settlement', 'Disputed the delivery: Nothing arrived.'),
        people,
      ),
    ).toBe('Disagreed with the delivery report: Nothing arrived.');
    expect(
      formatAuditDetail(
        record('dispute_readiness', 'Disputed the readiness evidence: Wrong release.'),
        people,
      ),
    ).toBe('Disagreed with the readiness evidence: Wrong release.');
    // The member's own words are never touched.
    expect(
      formatAuditDetail(
        record('dispute_result', 'Disputed the result: Disputed the delivery: ha.'),
        people,
      ),
    ).toBe('Disagreed with the result: Disputed the delivery: ha.');
  });
});
