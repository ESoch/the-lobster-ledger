export function zonedInputValue(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

/** The years a decision time can name. Further out is a slip of the keys, and past year 9999 or
 * before year 1 the date maths below breaks, so the field states the range and the check names it. */
export const DATE_TIME_MIN = '2000-01-01T00:00';
export const DATE_TIME_MAX = '2100-12-31T23:59';
export const DATE_TIME_RANGE_MESSAGE = 'Choose a date between 2000 and 2100.';

export function localDateTimeToIso(value: string, timeZone: string): string {
  // Some browsers let a year run past four digits.
  const typed = /^(\d{4,6})-\d{2}-\d{2}T\d{2}:\d{2}$/.exec(value);
  if (!typed) throw new Error('Choose a date and time.');
  const year = Number(typed[1]);
  if (year < Number(DATE_TIME_MIN.slice(0, 4)) || year > Number(DATE_TIME_MAX.slice(0, 4)))
    throw new Error(DATE_TIME_RANGE_MESSAGE);
  const naive = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== value)
    throw new Error('Choose a valid date and time.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(naive);
  } catch {
    throw new Error('Choose a valid timezone, such as America/Los_Angeles or UTC.');
  }
  const candidates = new Set<string>();
  // Probe either side of a possible offset transition, then verify the wall-clock value.
  for (const offset of [-86400000, 0, 86400000]) {
    const probe = naive + offset;
    const wallClock = Date.parse(`${zonedInputValue(new Date(probe).toISOString(), timeZone)}:00Z`);
    const candidate = new Date(naive - (wallClock - probe)).toISOString();
    if (zonedInputValue(candidate, timeZone) === value) candidates.add(candidate);
  }
  if (!candidates.size)
    throw new Error('This time does not exist because the clocks change. Choose another time.');
  if (candidates.size > 1)
    throw new Error(
      'This time occurs twice because the clocks change. Choose another time or enter it in UTC.',
    );
  return [...candidates][0];
}
