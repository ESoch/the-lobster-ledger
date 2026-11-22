/** The noun for a count, singular only for one or minus one: "roll" for 1 and -1, "rolls" otherwise. */
export const noun = (count: number, word: string, many = `${word}s`) =>
  Math.abs(count) === 1 ? word : many;
/** A count with its noun: "1 roll", "2 rolls". */
export const plural = (count: number, word: string, many?: string) =>
  `${count} ${noun(count, word, many)}`;
/**
 * A count with its noun, joined by a no-break space so a narrow line cannot end on the bare number
 * ("Answer a proposal · 1" over "roll"). The words are the same as plural(), so only copy that sits
 * in a column that can run out of room needs it.
 */
export const pluralNoBreak = (count: number, word: string, many?: string) =>
  plural(count, word, many).replace(' ', ' ');
