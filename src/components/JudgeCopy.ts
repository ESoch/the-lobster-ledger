/**
 * One vocabulary for what a named judge records. It is a recommendation, not a ruling or a
 * decision, because both bettors still confirm it before any rolls are owed. The sheet, its forms,
 * the inbox label and the new-bet hint all use these words.
 */
export const JUDGE_COPY = {
  /** The judge's button on the sheet and the matching inbox label. */
  recordAction: 'Record your recommendation',
  formTitle: 'Record your recommendation',
  submit: 'Record recommendation',
  fieldLabel: 'Recommendation and reasoning',
  winnerLabel: 'Recommended winner',
  recordHeading: 'Judge’s recommendation',
  intro:
    'You are the appointed judge. Apply the agreed criteria and record your recommendation with your reasoning. Both bettors then confirm the result.',
  newBetHint: 'The judge records a recommendation. Both bettors still confirm the result.',
  /** The method card, read by the judge themself. */
  youAreJudge: 'You are the judge',
  methodHintForJudge: 'You record a recommendation. Both bettors still confirm the result.',
  /** The method card once the judge has stepped down: nobody is the judge any more. */
  steppedDownSelf: 'You stepped down as judge',
  steppedDown: (judge: string) => `Judge stepped down: ${judge}`,
  /** Who re-appoints: "Avery and Blair", or "You and Blair" for a bettor. */
  choosing: (who: string) => `${who} choose a new judge or another way to decide.`,
  noJudge: (who: string) => `No judge is set. ${who} choose a new judge or another way to decide.`,
  /** A closed bet takes no new judge: "Casey stepped down…", or "You stepped down…" for the judge. */
  steppedDownBefore: (who: string) => `${who} stepped down before a recommendation was recorded.`,
  waiting: (judge: string) => `Waiting for ${judge} to record a recommendation.`,
  awaitingConfirmation: (names: string) => `Waiting for ${names} to confirm your recommendation.`,
  confirmed: 'Your recommendation is confirmed.',
} as const;
