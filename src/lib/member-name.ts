import { LIMITS } from './limits';

// One rule for the name a member goes by, shared by the invite form, the demo ledger and the API.

const { min, max } = LIMITS.memberName;
/** A blank name is asked for plainly; the limit is only mentioned to someone who went over it. */
export const MEMBER_NAME_BLANK = 'Enter a name.';
export const MEMBER_NAME_TOO_LONG = `Use ${max} characters or fewer.`;

/** Trimmed, with every run of whitespace (tabs, line breaks, no-break spaces) made a single space. */
export const normalizeMemberName = (name: string): string => name.replace(/\s+/g, ' ').trim();

/** The same name whatever its case, spacing or Unicode composition ("Ö" typed as "O" plus a mark). */
const sameNameKey = (name: string) => normalizeMemberName(name).normalize('NFC').toLowerCase();

/**
 * What is wrong with `name` as a new member's name, or undefined when it is fine. The limits apply to
 * the cleaned name, and a name another member already goes by (in any case) is turned away so two
 * people never share a row on the ledger.
 */
export function memberNameProblem(
  name: unknown,
  members: readonly { name: string }[] = [],
): string | undefined {
  if (typeof name !== 'string') return MEMBER_NAME_BLANK;
  const clean = normalizeMemberName(name);
  if (clean.length < min) return MEMBER_NAME_BLANK;
  if (clean.length > max) return MEMBER_NAME_TOO_LONG;
  const key = sameNameKey(clean);
  const taken = members.find((member) => sameNameKey(member.name) === key);
  return taken ? `Someone named ${taken.name} is already at the table.` : undefined;
}

/** Whether two names are the same person's name by the rule above: case, spacing and composition aside. */
export const sameMemberName = (a: string, b: string): boolean => sameNameKey(a) === sameNameKey(b);

/**
 * `name` made cleaner and, when a member already goes by it (in any case, spacing or composition),
 * numbered ("Alex (2)", then "Alex (3)") so two people never share a row on the ledger. The base is
 * shortened as far as the numbered name needs to stay within the length limit.
 */
export function uniqueMemberName(name: string, taken: readonly string[]): string {
  const clean = normalizeMemberName(name);
  if (!taken.some((other) => sameMemberName(other, clean))) return clean;
  for (let count = 2; ; count++) {
    const suffix = ` (${count})`;
    const numbered = `${clean.slice(0, max - suffix.length).trimEnd()}${suffix}`;
    if (!taken.some((other) => sameMemberName(other, numbered))) return numbered;
  }
}

/**
 * What is wrong with inviting `name` while `invitedNames` hold open invitations: a second link for a
 * name that is already waiting would admit two people under it.
 */
export function openInviteProblem(
  name: string,
  invitedNames: readonly string[],
): string | undefined {
  const waiting = invitedNames.find((invited) => sameMemberName(invited, name));
  return waiting
    ? `${normalizeMemberName(waiting)} already has an open invitation. Revoke it to invite them again.`
    : undefined;
}
