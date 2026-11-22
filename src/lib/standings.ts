import { getMemberStats } from './ledger';
import type { LedgerState, Member, MemberStats } from './types';

export type StandingSort = 'net' | 'wins' | 'rate';

/** Win rate ranks only members with this many decided bets: one lucky bet is not a record. */
export const WIN_RATE_MIN_DECIDED = 3;

export interface Standing {
  member: Member;
  stats: MemberStats;
  /** Bets with a confirmed winner this member was a bettor in. */
  decided: number;
  /** Competition rank (1, 1, 3): tied members share it. Absent for a member who is not ranked. */
  rank?: number;
  /** Another ranked member has exactly the same figures. */
  tied: boolean;
}

export interface Standings {
  ranked: Standing[];
  /** Members with a result who are not ranked under this sort: too few decided bets for a rate. */
  unranked: Standing[];
  /** Members with no confirmed result at all, by name. */
  waiting: Member[];
}

/** The figures a sort compares, most important first. Equal figures are a tie. */
export const standingKeys = (sort: StandingSort, stats: MemberStats): [number, number] =>
  sort === 'wins'
    ? [stats.won, stats.net]
    : sort === 'rate'
      ? [stats.winRate, stats.won]
      : [stats.net, stats.won];

const compare = (sort: StandingSort) => (a: Standing, b: Standing) => {
  const [a1, a2] = standingKeys(sort, a.stats);
  const [b1, b2] = standingKeys(sort, b.stats);
  return b1 - a1 || b2 - a2 || a.member.name.localeCompare(b.member.name);
};
const sameKeys = (sort: StandingSort, a: Standing, b: Standing) => {
  const [a1, a2] = standingKeys(sort, a.stats);
  const [b1, b2] = standingKeys(sort, b.stats);
  return a1 === b1 && a2 === b2;
};

/**
 * The roll of honor. Only members with a confirmed result are ranked, so nobody holds a medal for
 * doing nothing; tied members share a rank and the next one skips (1, 1, 3); win rate also needs
 * WIN_RATE_MIN_DECIDED decided bets, and members below it are listed after the ranked ones.
 */
export function standings(
  state: Pick<LedgerState, 'members' | 'bets'>,
  sort: StandingSort,
): Standings {
  const all = state.members.map((member) => {
    const stats = getMemberStats(state.bets, member.id);
    return { member, stats, decided: stats.won + stats.lost, tied: false } as Standing;
  });
  const waiting = all
    .filter((item) => !item.decided)
    .map((item) => item.member)
    .sort((a, b) => a.name.localeCompare(b.name));
  const eligible = (item: Standing) =>
    item.decided > 0 && (sort !== 'rate' || item.decided >= WIN_RATE_MIN_DECIDED);
  const ranked = all.filter(eligible).sort(compare(sort));
  ranked.forEach((item, index) => {
    const first = ranked.findIndex((other) => sameKeys(sort, other, item));
    item.rank = first + 1;
    item.tied = ranked.some((other, at) => at !== index && sameKeys(sort, other, item));
  });
  const unranked = all.filter((item) => item.decided > 0 && !eligible(item)).sort(compare(sort));
  return { ranked, unranked, waiting };
}

/** One member's line on the all-time leaderboard as the CLI and the MCP tool give it. */
export interface LeaderboardLine extends MemberStats {
  member: Member;
  /** Bets with a confirmed winner this member was a bettor in. */
  decided: number;
  /** Competition rank (1, 1, 3), or null for a member with no confirmed result. */
  rank: number | null;
  /** Another ranked member has exactly the same figures. */
  tied: boolean;
}

/**
 * The website's ranking by all-time net rolls, flat: ranked members in rank order, then the members
 * still waiting for a first confirmed result by name, with a null rank. So the CLI, the MCP tool and
 * the Leaderboard page agree on who is ranked, who is tied and who has not played yet.
 */
export function leaderboardLines(state: Pick<LedgerState, 'members' | 'bets'>): LeaderboardLine[] {
  const { ranked, waiting } = standings(state, 'net');
  return [
    ...ranked.map(({ member, stats, decided, rank, tied }) => ({
      ...stats,
      member,
      decided,
      rank: rank ?? null,
      tied,
    })),
    ...waiting.map((member) => ({
      ...getMemberStats(state.bets, member.id),
      member,
      decided: 0,
      rank: null,
      tied: false,
    })),
  ];
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinal(value: number): string {
  const tens = value % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] ?? 'th');
  return `${value}${suffix}`;
}
