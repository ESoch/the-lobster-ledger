/**
 * The house rules, written once. How it works and the Balances page both read from here,
 * so the rules can never contradict the offset feature or each other.
 */
const offsets =
  'Either bettor can offset equal confirmed debts between the same two people. Debts never transfer to anyone else, and cash never settles a wager. Remaining rolls need a confirmed delivery.';

export const RULES = {
  houseRule: 'A bet takes two handshakes. Every settlement stays on record.',
  steps: [
    {
      title: 'Make it clear',
      body: 'Describe the wager, both positions, the stakes, and exactly how the answer will be decided.',
    },
    {
      title: 'Shake on it',
      body: 'The proposer signs first. The other person agrees before the bet becomes active, or declines with a note. Until they answer, the proposer can withdraw it. A named judge can step down before a result is recorded.',
    },
    {
      title: 'Settle the score',
      body: 'Follow the agreed decision method: mutual agreement, an appointed judge, or ChatGPT. Both bettors approve the exact ChatGPT prompt before use. Both confirm the final result before any rolls are owed. While the bet is in play, either bettor can propose changes to the terms, timing or who decides; nothing changes until the other agrees. If the bet cannot be decided, either bettor can propose calling it off with no winner; the other must agree.',
    },
    {
      title: 'Settle the rolls',
      body: `Deliver the real rolls and both confirm delivery. ${offsets}`,
    },
  ],
  offsets,
  note: 'Declines, withdrawals and disagreements stay in the history with a name and a time. This is a record of social agreements, not a legal certification.',
} as const;
