/**
 * Text limits shared by the rules engine, the API schemas and the forms.
 * Every limit applies to the trimmed value, so padding never satisfies a minimum.
 */
export const LIMITS = {
  title: { min: 5, max: 160 },
  terms: { min: 10, max: 3000 },
  side: { min: 1, max: 240 },
  note: { min: 1, max: 2000 },
  evidence: { min: 1, max: 2000 },
  description: { min: 1, max: 2000 },
  source: { min: 1, max: 500 },
  prompt: { min: 20, max: 8000 },
  response: { min: 1, max: 8000 },
  memberName: { min: 1, max: 100 },
} as const;
export type TextLimit = { min: number; max: number };
