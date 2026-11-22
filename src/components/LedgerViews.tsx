import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpRight,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Trophy,
  Utensils,
  Search,
  BookOpen,
  Check,
  MapPin,
  Scale,
  ShieldCheck,
  Clock3,
  Plus,
  Users,
  Bell,
  Minus,
  Info,
} from 'lucide-react';
import type {
  Bet,
  BetEntrySource,
  DebtOffsetPreview,
  BetStatus,
  Balance,
  LedgerState,
  Member,
  MemberStats,
  PriceCorrectionInput,
  PriceObservation,
  PriceReportInput,
  Restaurant,
  ZonedDateTime,
} from '../lib/types';
import {
  getDirectDebts,
  getDeliveredRolls,
  getMemberStats,
  getOffsetRolls,
  getRemainingRolls,
  needsAction,
} from '../lib/ledger';
import { formatAuditDetail } from '../lib/audit-display';
import { entrySourceLabel } from '../lib/entry-source';
import {
  betReadiness,
  betStatusLabel,
  betStatusVariant,
  historyDateLabel,
  type BetStatusVariant,
} from '../lib/bet-workflow';
import {
  compareByVisit,
  isLiveReport,
  isOldReport,
  priceDateLabel,
  priceLabel,
  priceSeries,
  seriesChange,
} from '../lib/price-observations';
import { hasDebt, parties } from '../lib/rolls';
import { noun, plural } from '../lib/plural';
import { closedBetNote, placeBetCounts, placeCountLabel } from '../lib/place-stats';
import { RULES } from '../lib/rules-copy';
import {
  ordinal,
  standingKeys,
  standings,
  WIN_RATE_MIN_DECIDED,
  type Standing,
  type StandingSort,
} from '../lib/standings';
import { Avatar, EmptyState, SectionTitle, StatusBadge, dateLabel, timeLabel } from './ui';
import { ActionItem, sortByDuty } from './ActionItem';
import { DebtOffsets } from './DebtOffsets';
import { RollIllustration } from './Brand';
import { MapView as PlacesMap } from './MapView';
import { PriceEntryDialog, PriceWithdrawDialog } from './PriceEntryDialog';
import { PriceHistoryChart } from './PriceHistoryChart';

type ViewProps = { state: LedgerState; memberId: string; onBet: (bet: Bet) => void; now?: string };
const nameOf = (state: LedgerState, id: string) => state.members.find((member) => member.id === id);
const firstName = (member?: Member) => member?.name.trim().split(/\s+/)[0] ?? 'Member';
/**
 * The first name. When another member shares it, "Alex C." tells them apart, and the full name
 * takes over if even the initial would collide.
 */
const shortName = (member?: Member, members: Member[] = []) => {
  const first = firstName(member);
  if (!member) return first;
  const twins = members.filter(
    (other) => other.id !== member.id && firstName(other).toLowerCase() === first.toLowerCase(),
  );
  if (!twins.length) return first;
  const initialed = (person: Member) => {
    const last = person.name.trim().split(/\s+/).slice(1).pop();
    return last ? `${firstName(person)} ${last[0].toUpperCase()}.` : person.name;
  };
  return twins.some((other) => initialed(other) === initialed(member))
    ? member.name
    : initialed(member);
};
/** "+2", "0", "−3": all-time net with a true minus sign, on the Leaderboard and Bragging rights. */
const signedNet = (net: number) => `${net > 0 ? '+' : net < 0 ? '−' : ''}${Math.abs(net)}`;

const compactStatusLabels: Record<BetStatus, string> = {
  pending: 'Pending',
  active: 'In play',
  confirming: 'Confirming',
  owed: 'To settle',
  settling: 'Delivering',
  settled: 'Settled',
  voided: 'No winner',
  declined: 'Declined',
};
const compactVariantLabels: Record<BetStatusVariant, string> = {
  history: 'History',
  correction: 'Correction',
  offset: 'By offset',
  withdrawn: 'Withdrawn',
};
/**
 * Compact tables share a narrow status track, so they use the short filter-tab wording. The full
 * table's track is sized for "Confirming delivery" (bet-table-css.test.ts), which "History needs
 * correction" outgrows; the row's "Made Feb 2024" already says it is a history, and the inbox and
 * the bet sheet keep the full words.
 */
const betRowStatusLabel = (bet: Bet, compact: boolean) => {
  const variant = betStatusVariant(bet);
  if (!compact) return variant === 'correction' ? 'Needs correction' : betStatusLabel(bet);
  return variant ? compactVariantLabels[variant] : compactStatusLabels[bet.status];
};
/** "with Sarah" for a bettor; both names for anyone else, so the row never reads one-sided. */
const counterpartyLabel = (state: LedgerState, bet: Bet, memberId?: string) => {
  const creator = shortName(nameOf(state, bet.creatorId), state.members);
  const opponent = shortName(nameOf(state, bet.opponentId), state.members);
  if (memberId === bet.creatorId) return `with ${opponent}`;
  if (memberId === bet.opponentId) return `with ${creator}`;
  return `${creator} vs ${opponent}`;
};

/** A bettor, or the member named to judge: the bets "Only my bets" and "Your bets" keep. */
const involves = (bet: Bet, memberId: string) =>
  [bet.creatorId, bet.opponentId, bet.judgeId].includes(memberId);

export function BetTable({
  bets,
  state,
  onBet,
  compact = false,
  memberId,
  stakeMode = 'original',
  now,
}: {
  bets: Bet[];
  state: LedgerState;
  onBet: (bet: Bet) => void;
  compact?: boolean;
  /** The viewer, so a row can say "with Sarah" instead of naming both bettors, and "Your move". */
  memberId?: string;
  /** "remaining" leads with the rolls still owed after offsets (the Balances view). */
  stakeMode?: 'original' | 'remaining';
  /** The clock for "Your move" and for which year an Added date needs; the real time by default. */
  now?: string;
}) {
  const remainingMode = stakeMode === 'remaining';
  const tableId = useId();
  return (
    <table className={`bet-table ${compact ? 'compact-table' : ''}`} aria-label="Lobster roll bets">
      <thead>
        <tr className="bet-table-head">
          <th scope="col">The wager</th>
          <th scope="col">Between</th>
          <th scope="col">Status</th>
          <th scope="col">{remainingMode ? 'Remaining' : 'Stakes'}</th>
          <th>
            <span className="sr-only">Open</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {bets.map((bet) => {
          const offsetRolls = getOffsetRolls(bet);
          const remainingRolls = getRemainingRolls(bet);
          // An inference or report only qualifies a recorded source; alone it would read "Not recorded".
          const hasEntrySource = !!bet.entrySource;
          const metaId = `${tableId}-meta-${bet.id}`;
          // The Balances table lists the viewer's own debts, so it says which way each one runs.
          const winnerId = bet.resolution?.winnerId;
          const direction =
            remainingMode &&
            memberId &&
            winnerId &&
            [bet.creatorId, bet.opponentId].includes(memberId)
              ? winnerId === memberId
                ? 'Owes you'
                : 'You owe'
              : undefined;
          const yourMove = !!direction && !!memberId && needsAction(bet, memberId, now);
          return (
            <tr
              className="bet-row"
              key={bet.id}
              onClick={(event) => {
                // Any cell opens the bet. The row's button takes focus first, as a click on it
                // would, so the sheet hands focus back to the row and Tab carries on from it.
                event.currentTarget
                  .querySelector<HTMLElement>('.bet-title-cell')
                  ?.focus({ preventScroll: true });
                onBet(bet);
              }}
            >
              <td className="wager-cell">
                <button
                  className="bet-title-cell"
                  aria-label={`Open bet: ${bet.title}`}
                  aria-describedby={metaId}
                >
                  <strong>{bet.title}</strong>
                  <small className="bet-meta" id={metaId}>
                    {direction && (
                      <b
                        className={`bet-chip bet-direction ${direction === 'Owes you' ? 'status-active' : 'status-owed'}`}
                      >
                        {direction}
                      </b>
                    )}
                    {yourMove && <b className="bet-chip bet-turn status-pending">Your move</b>}
                    {/* The Balances table says it with its own chip above; every other table here. */}
                    {!direction && memberId && needsAction(bet, memberId, now) && (
                      <span className="bet-move">Your move</span>
                    )}
                    <span className="bet-reference">{bet.reference}</span>
                    <span className="bet-category">{bet.category}</span>
                    <span className="bet-with">{counterpartyLabel(state, bet, memberId)}</span>
                    {offsetRolls > 0 && (
                      <span className="bet-offset">
                        {remainingMode
                          ? `${bet.stake} staked · ${offsetRolls} offset`
                          : `${remainingRolls} remaining · ${offsetRolls} offset`}
                      </span>
                    )}
                    {hasEntrySource && (
                      <span className="bet-entry-source">
                        Entered via:{' '}
                        {entrySourceLabel(
                          bet.entrySource,
                          !!bet.entrySourceInference,
                          !!bet.entrySourceReport,
                        )}
                      </span>
                    )}
                    <span className="bet-date">
                      {bet.history
                        ? bet.history.originalDate.precision === 'unknown'
                          ? 'Original date unknown'
                          : `Made ${historyDateLabel(bet.history.originalDate)}`
                        : `Added ${dateLabel(bet.createdAt, now ?? Date.now())}`}
                    </span>
                  </small>
                </button>
              </td>
              <td className="bet-people">
                <span className="avatar-pair" aria-hidden="true">
                  <Avatar member={nameOf(state, bet.creatorId)} size={28} />
                  <Avatar member={nameOf(state, bet.opponentId)} size={28} />
                </span>
                <span>
                  {shortName(nameOf(state, bet.creatorId), state.members)}
                  <small>vs {shortName(nameOf(state, bet.opponentId), state.members)}</small>
                </span>
              </td>
              <td>
                <StatusBadge
                  status={bet.status}
                  label={betRowStatusLabel(bet, compact)}
                  variant={betStatusVariant(bet)}
                />
              </td>
              <td className="stake-cell">
                {remainingMode ? remainingRolls : bet.stake}
                <Utensils size={13} />
              </td>
              <td className="row-chevron">
                <ChevronRight size={15} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** "Dec 15, 12:00 PM UTC": the zone's own abbreviation once, and the year only when it is not this one. */
function zonedShort(value: ZonedDateTime, now?: string | number | Date) {
  const sameYear =
    new Date(value.at).getUTCFullYear() === new Date(now ?? Date.now()).getUTCFullYear();
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone: value.timezone,
    timeZoneName: 'short',
  }).format(new Date(value.at));
}

/**
 * The date a waiting list is sorted by, named for what it is ("passed" once it has), and what an
 * undated bet waits for. Only a check-in the viewer set is "Your check-in"; the one both bettors
 * agreed is the "Initial check-in", as the bet sheet calls it, and a judge has neither.
 */
function waitingNote(bet: Bet, memberId: string, at: string | undefined, now?: string) {
  const timing = bet.timing!;
  const parts: string[] = [];
  if (at) {
    const bettor = [bet.creatorId, bet.opponentId].includes(memberId);
    const personal = !!bet.checkIns && Object.hasOwn(bet.checkIns, memberId);
    const checkIn = !bettor ? undefined : personal ? bet.checkIns![memberId] : timing.checkIn;
    const passed = Date.parse(at) <= new Date(now ?? Date.now()).getTime();
    const named = (label: string, when: ZonedDateTime) =>
      `${label}${passed ? ' passed' : ''} ${zonedShort(when, now)}`;
    if (timing.kind === 'date' && at === timing.at) parts.push(named('Decision time', timing));
    else if (checkIn && checkIn.at === at)
      parts.push(named(personal ? 'Your check-in' : 'Initial check-in', checkIn));
    else if (bet.cutoff && bet.cutoff.at === at) parts.push(named('Claim cutoff', bet.cutoff));
    else parts.push(`Next step ${dateLabel(at)}`);
  }
  if (timing.kind === 'event') parts.push(`Waits for: ${timing.description}`);
  else if (timing.kind === 'evidence') parts.push(`Waits for evidence: ${timing.description}`);
  return parts.join(' · ');
}

/**
 * A judged bet whose time has come is on the judge, not on the bettors. It asks nothing of them, so
 * it is not one of their duties, but it stays in Waiting on… instead of vanishing the moment it
 * matters. `at` is when the judge's turn began (the decision time, or when evidence was marked
 * ready); a bet with no date of its own has none. Anything else is not on the judge yet, or is
 * paused, or the judge has stepped down and the bettors must act.
 */
function onTheJudge(bet: Bet, memberId: string, now?: string): { at?: string } | undefined {
  if (bet.status !== 'active' || bet.decisionMethod !== 'judge' || bet.judgeDeclined) return;
  if (bet.amendment || bet.voidProposal) return;
  if (![bet.creatorId, bet.opponentId].includes(memberId)) return;
  const readiness = betReadiness(bet, now, memberId);
  if (!readiness.ready) return;
  // A check-in is the bettors' own reminder, so only these two reasons carry the judge's date.
  return readiness.reason === 'date' || readiness.reason === 'evidence' ? { at: readiness.at } : {};
}

function judgeWaitingNote(state: LedgerState, bet: Bet, at: string | undefined, now?: string) {
  const judge = nameOf(state, bet.judgeId ?? '');
  const who = judge ? `${shortName(judge, state.members)}’s` : 'the judge’s';
  if (!at) return `Waiting on ${who} recommendation`;
  const timing = bet.timing;
  // The decision time keeps the zone it was set in. Evidence has no zone of its own, so it reads in
  // the viewer's, named, which is still the exact moment and gives both the same shape.
  const since =
    timing?.kind === 'date' && timing.at === at
      ? zonedShort(timing, now)
      : zonedShort({ at, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, now);
  return `Waiting on ${who} recommendation since ${since}`;
}

const APPROVALS_SHOWN = 3;
const WAITING_SHOWN = 4;
/** Bragging rights shows every top-three place up to this many rows. */
const PODIUM_SHOWN = 5;

/** What Over to you and Your next moves say when nothing waits on the member: one voice for both. */
function NextMovesEmpty({
  hasBets,
  iconSize,
  newBetButton,
}: {
  hasBets: boolean;
  iconSize: number;
  newBetButton?: ReactNode;
}) {
  return hasBets ? (
    <EmptyState
      icon={<ShieldCheck size={iconSize} />}
      title="You’re all caught up"
      description="Nothing is waiting on you. New agreements, results and deliveries needing your approval will appear here."
    />
  ) : (
    <EmptyState
      icon={<BookOpen size={iconSize} />}
      title="Nothing to do yet"
      description="Put the first wager on the record and your next moves will show up here."
      action={newBetButton}
    />
  );
}

export function Overview({
  state,
  memberId,
  onBet,
  onNavigate,
  onNewBet,
  now,
}: ViewProps & { onNavigate: (page: string) => void; onNewBet?: () => void }) {
  const stats = getMemberStats(state.bets, memberId);
  const net = stats.owedToYou - stats.youOwe;
  const decided = stats.won + stats.lost;
  const approvals = sortByDuty(state.bets.filter((bet) => needsAction(bet, memberId, now)));
  const waiting = state.bets
    .flatMap((bet) => {
      if (needsAction(bet, memberId, now)) return [];
      const judging = onTheJudge(bet, memberId, now);
      if (judging) return [{ bet, at: judging.at, onJudge: true }];
      if (
        bet.status !== 'active' ||
        !bet.timing ||
        bet.amendment ||
        bet.voidProposal ||
        ![bet.creatorId, bet.opponentId, bet.judgeId].includes(memberId)
      )
        return [];
      const readiness = betReadiness(bet, now, memberId);
      return readiness.ready ? [] : [{ bet, at: readiness.at, onJudge: false }];
    })
    // The soonest date first; a bet with no date waits at the end but stays in the list.
    .sort(
      (a, b) =>
        (a.at ?? '9').localeCompare(b.at ?? '9') || b.bet.createdAt.localeCompare(a.bet.createdAt),
    );
  const [waitingOpen, setWaitingOpen] = useState(false);
  const recent = [...state.bets].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  // Everyone holding one of the top three places: a tie for third is two members, so the list does
  // not stop at three. A very long tie is capped, and the line under the list counts the rest. The
  // cap never cuts the viewer's own row: it takes the last place, and the members it hides are all
  // level with it, so "more tied for" still holds.
  const podium = standings(state, 'net').ranked.filter((item) => (item.rank ?? 0) <= 3);
  const mine = podium.findIndex((item) => item.member.id === memberId);
  const leaders =
    mine >= PODIUM_SHOWN
      ? [...podium.slice(0, PODIUM_SHOWN - 1), podium[mine]]
      : podium.slice(0, PODIUM_SHOWN);
  const podiumHidden = podium.filter((item) => !leaders.includes(item));
  const allDelivered = state.bets.reduce((total, bet) => total + getDeliveredRolls(bet), 0);
  const inPlay = state.bets.filter((bet) => bet.status === 'active').length;
  const [tab, setTab] = useState('recent');
  const shown =
    tab === 'yours'
      ? [...state.bets]
          .filter((bet) => involves(bet, memberId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 5)
      : recent;
  const newBetButton = onNewBet && (
    <button className="button button-primary" onClick={onNewBet}>
      <Plus size={16} />
      New bet
    </button>
  );
  return (
    <>
      <div className="stats-grid">
        <section className="stat-card balance-feature">
          <div>
            <span className="stat-label">
              Outstanding balance
              <Scale size={15} />
            </span>
            <div className="stat-value">
              {net > 0 ? '+' : ''}
              {net}
              <span>{Math.abs(net) === 1 ? 'roll' : 'rolls'}</span>
            </div>
            <p>
              {net > 0
                ? 'A few lunches to look forward to.'
                : net < 0
                  ? 'Time to make a lunch reservation.'
                  : stats.owedToYou + stats.youOwe > 0
                    ? 'Net zero. Open deliveries remain.'
                    : 'All square. A clean plate.'}
            </p>
            <button onClick={() => onNavigate('balances')}>
              View your balances
              <ArrowUpRight size={14} />
            </button>
          </div>
          <RollIllustration className="balance-illustration" />
        </section>
        <section className="stat-card">
          <span className="stat-label">
            Owed to you
            <span className="stat-icon green-icon">
              <ArrowDownLeft size={17} />
            </span>
          </span>
          <div className="stat-value">
            {stats.owedToYou}
            <span>{stats.owedToYou === 1 ? 'roll' : 'rolls'}</span>
          </div>
          <p>{stats.owedToYou > 0 ? 'Awaiting a very good lunch' : 'Nobody owes you a roll'}</p>
        </section>
        <section className="stat-card">
          <span className="stat-label">
            You owe
            <span className="stat-icon red-icon">
              <ArrowUpRight size={17} />
            </span>
          </span>
          <div className="stat-value">
            {stats.youOwe}
            <span>{stats.youOwe === 1 ? 'roll' : 'rolls'}</span>
          </div>
          <p>{stats.youOwe > 0 ? 'Good debts. Better company.' : 'No rolls to deliver'}</p>
        </section>
        <section className="stat-card">
          <span className="stat-label">
            Your win rate
            <span className="stat-icon gold-icon">
              <Trophy size={16} />
            </span>
          </span>
          <div className="stat-value">
            {decided ? (
              <>
                {Math.round(stats.winRate)}
                <span>%</span>
              </>
            ) : (
              '—'
            )}
          </div>
          <p>
            {decided ? (
              <>
                <span className="green">{stats.won} won</span>
                <span className="dot-separator">·</span>
                {stats.lost} lost <span className="stat-period">All time</span>
              </>
            ) : (
              'No decided bets yet'
            )}
          </p>
        </section>
      </div>
      <div className="overview-grid">
        <aside className="panel approvals-panel" aria-label="Over to you">
          <SectionTitle title="Over to you" subtitle="A handshake is a two-person job." />
          {/* One region for the whole life of the panel, so a change in the count is announced. */}
          <div className={approvals.length ? 'approval-count' : 'sr-only'} role="status">
            {approvals.length ? (
              <>
                <span className="pulsing-dot" aria-hidden="true" />
                {plural(approvals.length, 'action')} waiting
              </>
            ) : (
              'No actions waiting'
            )}
          </div>
          <div className="approval-body">
            {approvals.length ? (
              <>
                <ul className="approval-list action-list">
                  {approvals.slice(0, APPROVALS_SHOWN).map((bet) => (
                    <li key={bet.id}>
                      <ActionItem
                        bet={bet}
                        state={state}
                        memberId={memberId}
                        now={now}
                        size="compact"
                        onOpen={onBet}
                      />
                    </li>
                  ))}
                </ul>
                {approvals.length > APPROVALS_SHOWN && (
                  <p className="approval-more">
                    Showing {APPROVALS_SHOWN} of {approvals.length}
                  </p>
                )}
              </>
            ) : (
              // The latest wagers beside this panel already offer New bet on an empty ledger.
              <NextMovesEmpty hasBets={state.bets.length > 0} iconSize={30} />
            )}
          </div>
          <button className="approval-footer" onClick={() => onNavigate('inbox')}>
            {approvals.length > APPROVALS_SHOWN
              ? `See all ${approvals.length} in your inbox`
              : 'Open activity inbox'}
            <ArrowRight size={15} />
          </button>
        </aside>
        <section className="panel recent-panel">
          <SectionTitle
            title="The latest wagers"
            action="View ledger"
            onAction={() => onNavigate('ledger')}
          />
          <div className="panel-tabs" role="group" aria-label="Wagers to show">
            <button
              aria-pressed={tab === 'recent'}
              className={tab === 'recent' ? 'selected' : ''}
              onClick={() => setTab('recent')}
            >
              All activity
            </button>
            <button
              aria-pressed={tab === 'yours'}
              className={tab === 'yours' ? 'selected' : ''}
              onClick={() => setTab('yours')}
            >
              Your bets
            </button>
            <span>{plural(inPlay, 'bet')} in play</span>
          </div>
          {shown.length ? (
            <BetTable
              bets={shown}
              state={state}
              onBet={onBet}
              memberId={memberId}
              now={now}
              compact
            />
          ) : (
            <EmptyState
              icon={<BookOpen />}
              title={
                tab === 'yours' && state.bets.length
                  ? 'You haven’t made a bet yet'
                  : 'The ledger is open'
              }
              description={
                tab === 'yours' && state.bets.length
                  ? 'Bets you are part of will show up here. Other bets are under All activity.'
                  : 'Your first friendly wager belongs here.'
              }
              action={newBetButton}
            />
          )}
        </section>
        {waiting.length > 0 && (
          <section className="panel waiting-panel">
            <SectionTitle
              title="Waiting on…"
              subtitle="Agreed bets with something still to unfold."
            />
            <ul className="waiting-list">
              {(waitingOpen ? waiting : waiting.slice(0, WAITING_SHOWN)).map(
                ({ bet, at, onJudge }) => (
                  <li key={bet.id}>
                    <button
                      className="waiting-bet"
                      aria-haspopup="dialog"
                      onClick={() => onBet(bet)}
                    >
                      <Clock3 size={19} aria-hidden="true" />
                      <span>
                        <strong>{bet.title}</strong>
                        <small>
                          {[bet.creatorId, bet.opponentId].includes(memberId)
                            ? counterpartyLabel(state, bet, memberId)
                            : `${counterpartyLabel(state, bet)} · you are the judge`}
                        </small>
                        <small>
                          {onJudge
                            ? judgeWaitingNote(state, bet, at, now)
                            : waitingNote(bet, memberId, at, now)}
                        </small>
                      </span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ),
              )}
            </ul>
            {waiting.length > WAITING_SHOWN && (
              <button
                className="approval-footer"
                aria-expanded={waitingOpen}
                onClick={() => setWaitingOpen((open) => !open)}
              >
                {waitingOpen ? 'Show fewer' : `View all ${waiting.length} waiting`}
                <ChevronDown className="disclosure-chevron" size={15} aria-hidden="true" />
              </button>
            )}
          </section>
        )}
        <section className="panel leaderboard-preview">
          <SectionTitle
            title="Bragging rights"
            subtitle="All-time net: wins minus losses."
            action="Leaderboard"
            onAction={() => onNavigate('leaderboard')}
          />
          {/* Ranked as the Leaderboard ranks: only confirmed results, and ties share a rank. */}
          {leaders.length ? (
            <>
              <ol className="mini-leaderboard" aria-label="Top three places by net rolls">
                {leaders.map(({ member, stats, rank, tied }) => (
                  <li key={member.id} className="mini-leader">
                    <span className={`rank rank-${rank}`}>
                      {/* The numbered disc the Leaderboard draws: the rank is written for everyone. */}
                      <span className="rank-medal" aria-hidden="true">
                        {rank}
                      </span>
                      <span className="sr-only">
                        Rank {rank}
                        {tied ? ' (tied)' : ''}
                      </span>
                    </span>
                    <Avatar member={member} size={36} decorative />
                    <div>
                      <strong>
                        {member.name}
                        {member.id === memberId && (
                          <>
                            {' '}
                            <small>you</small>
                          </>
                        )}
                      </strong>
                      <span>
                        {plural(stats.won, 'win')} <i /> {Math.round(stats.winRate)}% win rate
                        {tied && (
                          <>
                            {' '}
                            {/* Read once, from the rank above, so the visible word is hidden. */}
                            <b className="leader-tied" aria-hidden="true">
                              tied
                            </b>
                          </>
                        )}
                      </span>
                    </div>
                    <span className="leader-score">
                      {signedNet(stats.net)}
                      <small>{Math.abs(stats.net) === 1 ? 'roll' : 'rolls'}</small>
                    </span>
                  </li>
                ))}
              </ol>
              {podiumHidden.length > 0 && (
                <p className="mini-leaderboard-more">
                  +{podiumHidden.length} more tied for {ordinal(podiumHidden[0].rank!)}
                </p>
              )}
            </>
          ) : (
            <p className="mini-leaderboard-empty">
              No confirmed results yet. The first one puts someone on the board.
            </p>
          )}
          <div className="leaderboard-foot">
            <Utensils size={16} />
            <span>{plural(allDelivered, 'roll')} delivered. Countless opinions validated.</span>
          </div>
        </section>
        <section className="panel map-preview">
          <SectionTitle
            title="Where it all went down"
            action="Explore map"
            onAction={() => onNavigate('places')}
          />
          <div className="preview-map-wrap">
            <PlacesMap places={state.places} bets={state.bets} compact />
          </div>
          <div className="map-preview-foot">
            <MapPin size={14} />
            {plural(state.places.length, 'place')} with a story to tell
          </div>
        </section>
      </div>
      <footer className="workspace-footer">
        <span>
          <ShieldCheck size={14} />
          Mutually agreed. Always on record.
        </span>
        <span>Friendly wagers. Properly kept.</span>
      </footer>
    </>
  );
}

const filters: { id: string; label: string; statuses?: BetStatus[] }[] = [
  { id: 'all', label: 'All bets' },
  { id: 'pending', label: 'Pending', statuses: ['pending', 'confirming'] },
  { id: 'active', label: 'In play', statuses: ['active'] },
  { id: 'owed', label: 'To settle', statuses: ['owed', 'settling'] },
  { id: 'settled', label: 'Settled', statuses: ['settled'] },
  { id: 'closed', label: 'Other closed', statuses: ['voided', 'declined'] },
];
export function LedgerView({
  state,
  memberId,
  onBet,
  search,
  setSearch,
  onNewBet,
  now,
}: ViewProps & { search: string; setSearch: (value: string) => void; onNewBet?: () => void }) {
  const [filter, setFilter] = useState('all');
  const [onlyMine, setOnlyMine] = useState(false);
  const [entrySource, setEntrySource] = useState<BetEntrySource | 'all' | 'unrecorded'>('all');
  const searchInput = useRef<HTMLInputElement>(null);
  const chosen = filters.find((item) => item.id === filter)!;
  const query = search.trim().toLowerCase();
  // Everything but the status chip narrows the list first, so a chip's count is what it would show.
  const scoped = state.bets.filter(
    (bet) =>
      (!onlyMine || involves(bet, memberId)) &&
      (entrySource === 'all' ||
        (entrySource === 'unrecorded' ? !bet.entrySource : bet.entrySource === entrySource)) &&
      (!query ||
        [
          bet.title,
          bet.reference,
          bet.terms,
          bet.category,
          nameOf(state, bet.creatorId)?.name,
          nameOf(state, bet.opponentId)?.name,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)),
  );
  const countFor = (statuses?: BetStatus[]) =>
    scoped.filter((bet) => !statuses || statuses.includes(bet.status)).length;
  const bets = scoped
    .filter((bet) => !chosen.statuses || chosen.statuses.includes(bet.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtering = filter !== 'all' || onlyMine || entrySource !== 'all' || query !== '';
  const summary = filtering
    ? `${bets.length} of ${plural(state.bets.length, 'bet')}`
    : plural(state.bets.length, 'bet');
  if (!state.bets.length)
    return (
      <section className="panel ledger-page">
        <EmptyState
          as="h2"
          icon={<BookOpen size={30} />}
          title="No bets on the ledger yet"
          description="Put the first lobster-roll wager on the record, or add one you already made."
          action={
            onNewBet && (
              <button className="button button-primary" onClick={onNewBet}>
                <Plus size={16} />
                New bet
              </button>
            )
          }
        />
      </section>
    );
  return (
    <section className="panel ledger-page">
      <div className="ledger-controls">
        <div className="filter-tabs" role="group" aria-label="Filter by status">
          {filters.map((item) => (
            <button
              key={item.id}
              aria-pressed={filter === item.id}
              className={filter === item.id ? 'selected' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span>{countFor(item.statuses)}</span>
            </button>
          ))}
        </div>
        <div className="ledger-search-row">
          <label className="search-field">
            <Search size={16} />
            <input
              ref={searchInput}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search bets, people, or record IDs…"
              aria-label="Search ledger"
            />
          </label>
          <div className="ledger-secondary-filters">
            <label className="sort-control entry-source-filter">
              Entered via
              <select
                value={entrySource}
                onChange={(event) => setEntrySource(event.target.value as typeof entrySource)}
              >
                <option value="all">All sources</option>
                <option value="browser">Browser</option>
                <option value="cli">CLI</option>
                <option value="mcp">MCP</option>
                <option value="unrecorded">Not recorded</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(event) => setOnlyMine(event.target.checked)}
              />
              Only my bets
            </label>
          </div>
        </div>
        <p
          className="ledger-result-summary"
          role="status"
          // A phone folds the line away while nothing narrows the list (readability.css).
          data-unfiltered={filtering ? undefined : ''}
        >
          {summary}
        </p>
      </div>
      {bets.length ? (
        <BetTable bets={bets} state={state} onBet={onBet} memberId={memberId} now={now} />
      ) : (
        <EmptyState
          as="h2"
          icon={<Search size={30} />}
          title="No wagers match"
          description="Try a different search, status, or entry source."
          action={
            <button
              className="button button-secondary"
              onClick={() => {
                setSearch('');
                setFilter('all');
                setOnlyMine(false);
                setEntrySource('all');
                // The button is about to unmount; the search field is where the next try starts.
                searchInput.current?.focus();
              }}
            >
              Clear filters
            </button>
          }
        />
      )}
      <div className="table-footer">
        <span>
          <ShieldCheck size={14} />
          Every agreement has a paper trail
        </span>
      </div>
    </section>
  );
}

/** A signed roll count for the summary strip, with a true minus sign so it reads "minus". */
const signedRolls = (count: number) =>
  `${count > 0 ? '+' : count < 0 ? '\u2212' : ''}${Math.abs(count)}`;
/** Green for good news, red for bad, nothing for zero; a signed figure picks its ink by sign. */
const tone = (count: number, ink: 'green' | 'red' = count > 0 ? 'green' : 'red') =>
  count === 0 ? undefined : ink;
/** What a reported delivery between two people still waits on, or null when none is reported. */
function reportedDelivery(state: LedgerState, fromId: string, toId: string, memberId: string) {
  const reported = state.bets.filter(
    (bet) =>
      bet.status === 'settling' &&
      hasDebt(bet) &&
      bet.resolution?.winnerId === toId &&
      parties(bet).includes(fromId) &&
      parties(bet).includes(toId),
  );
  if (!reported.length) return null;
  const rolls = reported.reduce((sum, bet) => sum + getRemainingRolls(bet), 0);
  const waiting = reported.some((bet) => needsAction(bet, memberId))
    ? 'needs your confirmation'
    : 'awaiting confirmation';
  return `Delivery reported for ${plural(rolls, 'roll')} · ${waiting}`;
}
/** How many of someone else's debts Around the table lists before "Show all". */
const AROUND_THE_TABLE_ROWS = 6;

export function BalancesView({
  state,
  memberId,
  onBet,
  onOffset,
  onNewBet,
}: ViewProps & {
  onOffset?: (preview: DebtOffsetPreview) => Promise<void>;
  /** The first step from an empty Balances page; without it the empty state offers none. */
  onNewBet?: () => void;
}) {
  const balances = getDirectDebts(state.bets);
  const stats = getMemberStats(state.bets, memberId);
  const net = stats.owedToYou - stats.youOwe;
  const personal = balances.filter((balance) => [balance.fromId, balance.toId].includes(memberId));
  const openBets = state.bets.filter(
    (bet) =>
      ['owed', 'settling'].includes(bet.status) &&
      [bet.creatorId, bet.opponentId].includes(memberId),
  );
  const [showAllDebts, setShowAllDebts] = useState(false);
  // Your own debts lead; everyone else's follow in the same order, capped until asked for.
  const around = [...personal, ...balances.filter((balance) => !personal.includes(balance))];
  const aroundShown = showAllDebts ? around : around.slice(0, AROUND_THE_TABLE_ROWS);
  const label = (id: string) => shortName(nameOf(state, id), state.members);
  // Avatars repeat the name beside them, so assistive technology skips them.
  const decorative = (id: string, size: number) => (
    <span className="balance-avatar" aria-hidden="true">
      <Avatar member={nameOf(state, id)} size={size} />
    </span>
  );
  return (
    <>
      <div className="balance-summary">
        <div>
          <span>Owed to you</span>
          <strong className={tone(stats.owedToYou, 'green')}>
            {stats.owedToYou} <small>{noun(stats.owedToYou, 'roll')}</small>
          </strong>
        </div>
        <div>
          <span>You owe</span>
          <strong className={tone(stats.youOwe, 'red')}>
            {stats.youOwe} <small>{noun(stats.youOwe, 'roll')}</small>
          </strong>
        </div>
        <div>
          <span>Outstanding balance</span>
          <strong className={tone(net)}>
            {signedRolls(net)} <small>{noun(Math.abs(net), 'roll')}</small>
          </strong>
        </div>
        <RollIllustration className="balances-roll" />
      </div>
      <div className="balance-columns">
        <section className="panel">
          <SectionTitle
            title="Your original debts"
            subtitle="Each debt stays between the original loser and winner."
          />
          {personal.length ? (
            personal.map((balance) => {
              const incoming = balance.toId === memberId;
              const other = incoming ? balance.fromId : balance.toId;
              const delivery = reportedDelivery(state, balance.fromId, balance.toId, memberId);
              return (
                <div className="person-balance" key={balance.fromId + balance.toId}>
                  {decorative(other, 42)}
                  <div>
                    <strong>{nameOf(state, other)?.name}</strong>
                    <span>{incoming ? 'Owes you' : 'You owe'}</span>
                    {delivery && (
                      <p className="balance-pending">
                        <Clock3 size={13} aria-hidden="true" />
                        {delivery}
                      </p>
                    )}
                  </div>
                  <strong className={incoming ? 'green' : 'red'}>
                    {balance.rolls} <small>{noun(balance.rolls, 'roll')}</small>
                  </strong>
                </div>
              );
            })
          ) : (
            <EmptyState
              icon={<Scale />}
              title={
                stats.owedToYou + stats.youOwe > 0 ? 'Your debts net to zero' : 'You’re all square'
              }
              description={
                stats.owedToYou + stats.youOwe > 0
                  ? 'Use an explicit offset to cancel mutual debts. Physical deliveries still need both confirmations.'
                  : 'Nobody owes you a roll and you owe nobody one. When a confirmed result leaves a roll to deliver, either way, it shows up here.'
              }
              action={
                stats.owedToYou + stats.youOwe === 0 && onNewBet ? (
                  <button className="button button-secondary" onClick={onNewBet}>
                    Start a bet
                  </button>
                ) : undefined
              }
            />
          )}
          <div className="balance-disclaimer">
            <ShieldCheck size={16} />
            <p>{RULES.offsets}</p>
          </div>
        </section>
        <section className="panel">
          <SectionTitle
            title="Around the table"
            subtitle="Who owes whom. Opposing debts stay separate."
          />
          {around.length ? (
            <>
              {aroundShown.map((balance) => {
                const delivery = reportedDelivery(state, balance.fromId, balance.toId, memberId);
                return (
                  <div
                    className={`group-balance${delivery ? ' group-balance-reported' : ''}`}
                    key={balance.fromId + balance.toId}
                  >
                    <span>
                      {decorative(balance.fromId, 27)}
                      {label(balance.fromId)}
                      <span className="sr-only"> owes</span>
                    </span>
                    <ArrowRight size={14} aria-hidden="true" />
                    <span>
                      {decorative(balance.toId, 27)}
                      {label(balance.toId)}
                    </span>
                    <strong>
                      {balance.rolls}
                      <span className="sr-only"> {noun(balance.rolls, 'roll')}</span>
                      <Utensils size={13} aria-hidden="true" />
                    </strong>
                    {delivery && (
                      <p className="balance-pending">
                        <Clock3 size={13} aria-hidden="true" />
                        {delivery}
                      </p>
                    )}
                  </div>
                );
              })}
              {around.length > AROUND_THE_TABLE_ROWS && (
                <button
                  className="approval-footer group-balance-toggle"
                  aria-expanded={showAllDebts}
                  onClick={() => setShowAllDebts(!showAllDebts)}
                >
                  {showAllDebts ? 'Show fewer' : `Show all ${around.length}`}
                </button>
              )}
            </>
          ) : (
            <EmptyState
              icon={<Users />}
              title={
                state.bets.some((bet) => ['owed', 'settling'].includes(bet.status))
                  ? 'Debts are still open'
                  : 'Everyone’s paid up'
              }
              description={
                state.bets.some((bet) => ['owed', 'settling'].includes(bet.status))
                  ? 'Original debts remain open until explicitly offset or the actual rolls are delivered and confirmed.'
                  : 'No one owes anyone a roll right now. A debt appears here once both bettors confirm a result.'
              }
            />
          )}
        </section>
      </div>
      {onOffset && (
        <DebtOffsets
          key={memberId}
          state={state}
          memberId={memberId}
          onApply={onOffset}
          onOpenBet={(betId) => {
            const bet = state.bets.find((item) => item.id === betId);
            if (bet) onBet(bet);
          }}
        />
      )}
      <section className="panel">
        <SectionTitle
          title="Your rolls to settle"
          subtitle="Open a record to report or confirm delivery."
        />
        {openBets.length ? (
          <BetTable
            bets={openBets}
            state={state}
            onBet={onBet}
            memberId={memberId}
            stakeMode="remaining"
          />
        ) : (
          <EmptyState
            icon={<Check />}
            title="Nothing to settle"
            description="The next lunch is anyone’s guess. A confirmed result will land here, whether you owe the roll or are owed it."
          />
        )}
      </section>
    </>
  );
}

/** "Ellis", "Ellis and Olivia", "Ellis, Olivia and Sarah". */
const nameList = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

/** One sentence above the table: who leads, by how much, or who shares the lead. */
function leaderSentence(ranked: Standing[], sort: StandingSort, members: Member[]) {
  const leaders = ranked.filter((item) => item.rank === 1);
  if (!leaders.length) return undefined;
  const name = (item: Standing) => shortName(item.member, members);
  const rate = (item: Standing) => Math.round(item.stats.winRate);
  if (leaders.length > 1) {
    const [first] = leaders;
    const value =
      sort === 'rate'
        ? `a ${rate(first)}% win rate`
        : sort === 'wins'
          ? `${plural(first.stats.won, 'win')} each`
          : `${signedNet(first.stats.net)} net ${noun(first.stats.net, 'roll')} each`;
    return `${nameList(leaders.map(name))} share the lead with ${value}.`;
  }
  const [leader] = leaders;
  // The leader's own figure, then the margin: "leads by 2" alone reads like the leader's total.
  const value =
    sort === 'rate'
      ? `a ${rate(leader)}% win rate`
      : sort === 'wins'
        ? plural(leader.stats.won, 'confirmed win')
        : `${signedNet(leader.stats.net)} net ${noun(leader.stats.net, 'roll')}`;
  const next = ranked.find((item) => item.rank !== 1);
  if (!next) return `${name(leader)} leads with ${value}.`;
  // Everyone level in second place is someone the leader is ahead of.
  const behind = nameList(ranked.filter((item) => item.rank === next.rank).map(name));
  const margin = standingKeys(sort, leader.stats)[0] - standingKeys(sort, next.stats)[0];
  // Level on the ranked figure: the second figure decided it, so say which.
  if (margin === 0)
    return `${name(leader)} leads with ${value}, ahead of ${behind} on ${sort === 'wins' ? 'net rolls' : 'wins'}.`;
  const points = Math.round(margin);
  const ahead = sort !== 'rate' ? String(margin) : points > 0 ? plural(points, 'point') : '';
  return ahead
    ? `${name(leader)} leads with ${value}, ${ahead} ahead of ${behind}.`
    : `${name(leader)} leads with ${value}.`;
}

const leaderboardColumns: { label: string; sort?: StandingSort; record?: boolean }[] = [
  { label: 'Rank' },
  { label: 'Member' },
  { label: 'Wins', sort: 'wins' },
  { label: 'Losses' },
  // Phones swap Wins and Losses for this one column, so a loss is never left off the table.
  { label: 'W–L', sort: 'wins', record: true },
  { label: 'Win rate', sort: 'rate' },
  { label: 'Net rolls', sort: 'net' },
];

/**
 * A member's name, with the reason they are not ranked in small type beneath it. The reason is drawn
 * for the eye only: the rank cell says it in words, and the name stays just the name as the row's
 * header. Without a reason there is no wrapper, so a ranked row is laid out as it always was.
 */
function WithReason({ reason, children }: { reason?: string; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <span className="leaderboard-member-text">
      {children}
      <span className="unranked-reason" aria-hidden="true">
        {reason}
      </span>
    </span>
  );
}

export function LeaderboardView({
  state,
  memberId,
  onViewBets,
}: ViewProps & {
  /** Opens the ledger narrowed to a member, so a win or loss can be traced to its bets. */
  onViewBets?: (member: Member) => void;
}) {
  const [sort, setSort] = useState<StandingSort>('net');
  const board = useMemo(() => standings(state, sort), [state, sort]);
  const rows = [...board.ranked, ...board.unranked];
  const note = leaderSentence(board.ranked, sort, state.members);
  // Win rate needs a few decided bets before it ranks anyone, so say why a member is left out, and
  // say it above the table when that is everyone.
  const rateRule = `${WIN_RATE_MIN_DECIDED} decided bets`;
  const nobodyRanked = sort === 'rate' && rows.length > 0 && !board.ranked.length;
  const label = (member: Member) => shortName(member, state.members);
  return (
    <>
      <div className="leaderboard-banner">
        <div>
          <span className="banner-icon">
            <Trophy size={26} />
          </span>
          <div>
            <h2>Some opinions pay for lunch.</h2>
            <p>Every confirmed result counts. Settling up never erases a win.</p>
          </div>
        </div>
      </div>
      <section className="panel">
        <div className="section-title">
          <div>
            <h2>The roll of honor</h2>
            <p>
              {plural(state.members.length, 'member')}, all time.{' '}
              {/* Phones keep only the scope, so the first rows start higher. */}
              <span className="roll-of-honor-aside">One very good reason to be right.</span>
            </p>
          </div>
          {rows.length > 0 && (
            <label className="sort-control">
              Rank by
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as StandingSort)}
              >
                <option value="net">Net rolls won</option>
                <option value="wins">Most wins</option>
                <option value="rate">Win rate</option>
              </select>
            </label>
          )}
        </div>
        {note && (
          <p className="leader-note">
            <Trophy size={16} aria-hidden="true" />
            {note}
          </p>
        )}
        {nobodyRanked && (
          <p className="leader-note">
            <Info size={16} aria-hidden="true" />
            No one has {rateRule} yet, so no win-rate ranking.
          </p>
        )}
        {rows.length ? (
          <div className="leaderboard-table" role="table" aria-label="The roll of honor">
            <div className="leaderboard-table-head" role="row">
              {leaderboardColumns.map((column) => (
                <span
                  key={column.label}
                  role="columnheader"
                  aria-label={column.record ? 'Record: wins and losses' : undefined}
                  aria-sort={column.sort === sort ? 'descending' : undefined}
                  className={
                    [column.record && 'col-record', column.sort === sort && 'sorted']
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                >
                  {column.label}
                </span>
              ))}
            </div>
            {rows.map(({ member, stats, rank, tied }) => (
              <div
                className={`leaderboard-row${member.id === memberId ? ' your-row' : ''}${rank ? '' : ' unranked'}${onViewBets ? ' interactive' : ''}`}
                key={member.id}
                role="row"
              >
                <span
                  role="cell"
                  className={`rank${rank ? ` rank-${rank <= 3 ? rank : 'n'}` : ''}`}
                >
                  {/* The disc is drawn for the eye; the rank is written for everyone. */}
                  <span
                    className={rank && rank <= 3 ? 'rank-medal' : 'rank-number'}
                    aria-hidden="true"
                  >
                    {rank ?? '–'}
                  </span>
                  <span className="sr-only">
                    {rank
                      ? `${ordinal(rank)}${tied ? ' (tied)' : ''}`
                      : `Not ranked${sort === 'rate' ? `, needs ${rateRule}` : ''}`}
                  </span>
                </span>
                <span className="leaderboard-member" role="rowheader">
                  <Avatar member={member} size={40} decorative />
                  <WithReason reason={rank || sort !== 'rate' ? undefined : `Needs ${rateRule}`}>
                    <strong>
                      {onViewBets ? (
                        // The whole row is the hit area (see .leaderboard-member-link::after).
                        <button
                          className="leaderboard-member-link"
                          // The name stays the button's name, so it is also the row header's: "Ellis you",
                          // not "View bets involving Ellis you" for every cell in the row.
                          title={`View bets involving ${member.name}`}
                          onClick={() => onViewBets(member)}
                        >
                          {member.name}
                        </button>
                      ) : (
                        member.name
                      )}
                      {member.id === memberId && (
                        <>
                          {' '}
                          <small>you</small>
                        </>
                      )}
                    </strong>
                  </WithReason>
                </span>
                <span role="cell">{stats.won}</span>
                <span role="cell">{stats.lost}</span>
                <span className="col-record" role="cell">
                  <span aria-hidden="true">
                    {stats.won}–{stats.lost}
                  </span>
                  <span className="sr-only">
                    {plural(stats.won, 'win')}, {plural(stats.lost, 'loss', 'losses')}
                  </span>
                </span>
                <span className="win-rate-cell" role="cell">
                  {Math.round(stats.winRate)}%
                  <span className="rate-bar" aria-hidden="true">
                    <i style={{ width: `${stats.winRate}%` }} />
                  </span>
                </span>
                <strong
                  role="cell"
                  className={`leaderboard-net${stats.net > 0 ? ' green' : stats.net < 0 ? ' red' : ''}`}
                >
                  {signedNet(stats.net)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Trophy />}
            title="No confirmed results yet"
            description="The roll of honor fills in once a bet’s result is confirmed by both sides. Until then, everyone is level."
          />
        )}
        {rows.length > 0 && board.waiting.length > 0 && (
          <p className="leaderboard-waiting">
            Not ranked yet:{' '}
            {board.waiting.map((member, index) => (
              <Fragment key={member.id}>
                {index > 0 && (index === board.waiting.length - 1 ? ' and ' : ', ')}
                {label(member)}
                {member.id === memberId && (
                  <>
                    {' '}
                    <small>you</small>
                  </>
                )}
              </Fragment>
            ))}{' '}
            {board.waiting.length === 1 ? 'has' : 'have'} no confirmed results.
          </p>
        )}
        {rows.length > 0 && (
          <div className="table-footer">
            Ties and unconfirmed results are excluded.
            <span>
              Win rate = wins ÷ decided bets
              {sort === 'rate' &&
                `; it ranks members with ${WIN_RATE_MIN_DECIDED} or more decided bets`}
            </span>
          </div>
        )}
      </section>
    </>
  );
}

/** "Up $2.00 since Jul 18, 2026": the direction in words and an arrow, never in colour alone. */
function PriceDelta({ cents, previous }: { cents: number; previous: PriceObservation }) {
  const direction = cents > 0 ? 'up' : cents < 0 ? 'down' : 'same';
  const Icon = cents > 0 ? ArrowUpRight : cents < 0 ? ArrowDownRight : Minus;
  return (
    <p className={`price-delta ${direction}`}>
      <Icon size={14} aria-hidden="true" />
      {cents > 0
        ? `Up ${priceLabel(cents)}`
        : cents < 0
          ? `Down ${priceLabel(-cents)}`
          : 'No change'}{' '}
      since {priceDateLabel(previous)}
    </p>
  );
}

function PriceHistory({
  restaurant,
  observations,
  superseded,
  state,
  memberId,
  onCorrect,
  onAddPrice,
  panelRef,
  onWithdraw,
}: {
  restaurant: Restaurant;
  observations: PriceObservation[];
  /** Reports a correction replaced or their reporter withdrew: off every figure, kept on record. */
  superseded: PriceObservation[];
  state: LedgerState;
  memberId: string;
  onCorrect: (observation: PriceObservation) => void;
  onAddPrice: () => void;
  panelRef?: Ref<HTMLElement>;
  onWithdraw?: (id: string, reason: string) => Promise<void>;
}) {
  const [withdrawing, setWithdrawing] = useState<PriceObservation>();
  const earlierRef = useRef<HTMLElement>(null);
  const memberName = (id: string) =>
    state.members.find((member) => member.id === id)?.name ?? 'Member';
  const ordered = [...observations].sort(compareByVisit);
  // The headline, the change and the chart follow one item; other items are named beside it.
  const [primary, ...others] = priceSeries(observations);
  const change = primary && seriesChange(primary);
  // The Correct and Withdraw column is held for a member who has a live report anywhere, not only
  // at this restaurant, so the price column stays where it is when the restaurant changes.
  const correctable = (state.priceObservations ?? []).some(
    (item) => item.reporterId === memberId && isLiveReport(item),
  );
  return (
    <section className="panel price-history-panel" ref={panelRef}>
      <SectionTitle
        title={restaurant.name}
        subtitle={
          restaurant.address
            ? `${restaurant.address} · member-reported menu prices`
            : 'Member-reported menu prices'
        }
      />
      {primary && (
        <div className="price-headline">
          <div className="price-stat">
            {priceLabel(primary.latest.priceCents)}{' '}
            <small>
              Most recent reported · {primary.label} · {priceDateLabel(primary.latest)}
            </small>
          </div>
          {change && <PriceDelta {...change} />}
        </div>
      )}
      {others.length > 0 && (
        <p className="price-also">
          Also reported:{' '}
          {others.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 && ' · '}
              {item.label} <strong>{priceLabel(item.latest.priceCents)}</strong>
            </Fragment>
          ))}
        </p>
      )}
      {primary &&
        (primary.visits > 1 ? (
          <PriceHistoryChart series={primary} restaurantName={restaurant.name} />
        ) : (
          <p className="price-chart-note">
            One visit on record so far. The chart starts with a second visit.
          </p>
        ))}
      <div
        className={`price-history-list${correctable ? ' has-actions' : ''}${correctable && onWithdraw ? ' has-withdraw' : ''}`}
      >
        {ordered.length ? (
          ordered
            .slice()
            .reverse()
            .map((item) => (
              <div className="price-observation" key={item.id}>
                <div>
                  <strong>
                    {item.itemName}
                    {item.correctedFromId && (
                      <>
                        {' '}
                        <span className="price-corrected-tag">Corrected</span>
                      </>
                    )}
                  </strong>
                  <small>
                    {priceDateLabel(item)} · {memberName(item.reporterId)}
                    {item.note ? ` · ${item.note}` : ''}
                    {item.correctionReason ? ` · Correction: ${item.correctionReason}` : ''}
                    {item.entrySource === 'mcp' && (
                      <>
                        {' · '}
                        <span className="price-entry-source">via AI connection</span>
                      </>
                    )}
                  </small>
                </div>
                <strong className="price-observation-price">{priceLabel(item.priceCents)}</strong>
                {correctable && (
                  <span className="price-observation-action">
                    {item.reporterId === memberId && (
                      <button
                        className="price-correct-button"
                        data-corrected-from={item.correctedFromId}
                        aria-label={`Correct the ${priceLabel(item.priceCents)} ${item.itemName} report from ${priceDateLabel(item)}`}
                        onClick={() => onCorrect(item)}
                      >
                        Correct
                      </button>
                    )}
                    {item.reporterId === memberId && onWithdraw && (
                      <button
                        className="price-withdraw-button"
                        aria-label={`Withdraw the ${priceLabel(item.priceCents)} ${item.itemName} report from ${priceDateLabel(item)}`}
                        onClick={() => setWithdrawing(item)}
                      >
                        Withdraw
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))
        ) : (
          <div className="price-history-empty">
            <EmptyState
              icon={<Utensils />}
              title="No prices recorded yet"
              description="Add the price from your last visit to start this restaurant’s history."
              action={
                <button className="button button-secondary" onClick={onAddPrice}>
                  <Plus size={16} /> Add a price for {restaurant.name}
                </button>
              }
            />
          </div>
        )}
      </div>
      {superseded.length > 0 && (
        <details className="price-earlier">
          <summary ref={earlierRef}>Earlier reports ({superseded.length})</summary>
          <ul>
            {[...superseded]
              .sort(compareByVisit)
              .reverse()
              .map((item) => (
                <li key={item.id}>
                  {priceLabel(item.priceCents)} · {item.itemName} · {priceDateLabel(item)} ·{' '}
                  {memberName(item.reporterId)} ·{' '}
                  {item.withdrawnAt
                    ? `withdrawn on ${dateLabel(item.withdrawnAt, { year: true })}: ${item.withdrawnReason}`
                    : `replaced by a correction on ${dateLabel(item.correctedAt!, { year: true })}`}
                </li>
              ))}
          </ul>
        </details>
      )}
      {onWithdraw && (
        <PriceWithdrawDialog
          observation={withdrawing}
          restaurantName={restaurant.name}
          onClose={() => setWithdrawing(undefined)}
          onWithdraw={onWithdraw}
          // The withdrawn report's row has gone with its button; it is now under Earlier reports.
          fallbackFocus={() => earlierRef.current}
        />
      )}
    </section>
  );
}

/** The Places tab the address names: #places/prices opens Roll prices. */
const placesTab = (): 'stories' | 'prices' =>
  window.location.hash === '#places/prices' ? 'prices' : 'stories';
/** At this width the price panel sits below the restaurant list, and the map above the place list. */
const STACKED = '(max-width: 1000px)';

/**
 * Whether the Places page is in its one column, following the screen as it turns. The map and the
 * place list swap places in the markup then, which moves one of them in the page and would drop
 * focus from inside it, so focus goes back where it was.
 */
function useStacked() {
  const [stacked, setStacked] = useState(() => Boolean(window.matchMedia?.(STACKED).matches));
  const focused = useRef<Element | null>(null);
  useEffect(() => {
    const query = window.matchMedia?.(STACKED);
    if (!query) return;
    const follow = () => {
      focused.current = document.activeElement;
      setStacked(query.matches);
    };
    query.addEventListener?.('change', follow);
    return () => query.removeEventListener?.('change', follow);
  }, []);
  useEffect(() => {
    const element = focused.current;
    focused.current = null;
    if (element instanceof HTMLElement && element.isConnected && document.activeElement !== element)
      element.focus({ preventScroll: true });
  }, [stacked]);
  return stacked;
}

/**
 * After a key press chooses a place in the one column: shows the map from its top edge, clear of
 * the pinned top bar (the page's scroll padding), and keeps the chosen row on screen by scrolling
 * only the place list. Says whether both fit; on a short screen, or for a row near the end of a
 * long list, they cannot.
 */
function showMapAndRow(panel: HTMLElement, row: HTMLElement) {
  const clear = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  if (panel.getBoundingClientRect().top < clear) panel.scrollIntoView({ block: 'start' });
  const list = row.closest<HTMLElement>('.place-list-items');
  if (!list) return false;
  const box = list.getBoundingClientRect();
  const { top, bottom } = row.getBoundingClientRect();
  // The part of the list box that is on screen.
  const ceiling = Math.max(box.top, clear);
  const floor = Math.min(box.bottom, window.innerHeight);
  const wanted = top < ceiling ? top - ceiling : Math.max(0, bottom - floor);
  const next = Math.min(
    Math.max(0, list.scrollTop + wanted),
    Math.max(0, list.scrollHeight - list.clientHeight),
  );
  const moved = next - list.scrollTop;
  if (top - moved < ceiling || bottom - moved > floor) return false;
  list.scrollTop = next;
  return true;
}

export function PlacesView({
  state,
  memberId,
  onBet,
  onPriceSaved,
  onPriceCorrected,
  onPriceWithdrawn,
  onNewBet,
  now,
}: ViewProps & {
  /** Opens the new-bet form with a saved place id, or 'custom' for the pin picker. */
  onNewBet?: (placeId?: string) => void;
  /** Saves a price and resolves to the restaurant it went to, so the panel can show it. */
  onPriceSaved: (input: PriceReportInput) => Promise<string | void>;
  onPriceCorrected: (id: string, input: PriceCorrectionInput) => Promise<void>;
  /** Withdraws one of the member's own reports with a reason; it stays under Earlier reports. */
  onPriceWithdrawn?: (id: string, reason: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string>();
  const [reveal, setReveal] = useState(0);
  // Set when a key press's choice cannot stay on screen beside the map: focus goes to the pin.
  const [revealFocus, setRevealFocus] = useState(false);
  // The table's status line speaks only after someone filters it, from the list or the map.
  const [announced, setAnnounced] = useState(false);
  const stacked = useStacked();
  const mapPanelRef = useRef<HTMLElement>(null);
  const allPlacesRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState(placesTab);
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<string>();
  const [cheapestFirst, setCheapestFirst] = useState(false);
  const pricePanelRef = useRef<HTMLElement>(null);
  // Bumped when a restaurant is chosen or a report lands on one; below 1000px the panel then
  // scrolls into view, since it sits under the list.
  const [priceReveal, setPriceReveal] = useState(0);
  useEffect(() => {
    if (!priceReveal || !window.matchMedia?.(STACKED).matches) return;
    pricePanelRef.current?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [priceReveal]);
  useEffect(() => {
    // Back, Forward or a link to #places/prices while the page is open switches the tab too.
    const follow = () => {
      if (window.location.hash.startsWith('#places')) setMode(placesTab());
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  /** Switches tab and keeps it in the address (without a new history entry), so a reload or a shared link reopens it. */
  function showTab(next: 'stories' | 'prices') {
    setMode(next);
    if (window.location.hash.startsWith('#places'))
      window.history.replaceState(
        window.history.state,
        '',
        next === 'prices' ? '#places/prices' : '#places',
      );
  }
  function chooseRestaurant(id: string) {
    setSelectedRestaurantId(id);
    setPriceReveal((count) => count + 1);
  }
  const [priceDialog, setPriceDialog] = useState(false);
  const [editingObservation, setEditingObservation] = useState<PriceObservation>();
  // The report a correction was just saved for. Its row went with the Correct button that opened
  // the dialog, so focus goes to the Correct button of the report that replaced it.
  const correctedFrom = useRef<string>(undefined);
  const place = state.places.find((item) => item.id === selected);
  const locatedBets = state.bets.filter((bet) => bet.location);
  const placeBets = locatedBets.filter((bet) => !selected || bet.location?.id === selected);
  /**
   * Chooses a place from the list. Below 1001px the map sits above the list, so it is brought into
   * view where the choice shows. A tap or a click scrolls up to it. A key press (a click with no
   * pointer, detail 0) shows the map from its top, clear of the top bar, and keeps the focused row
   * on screen, so the next Tab does not scroll the page away from the map. When the two cannot
   * both be on screen, focus goes to the chosen pin, beside its popup; All locations, which opens
   * no popup, keeps its row in view instead.
   */
  function choosePlace(id: string | undefined, event?: React.MouseEvent<HTMLElement>) {
    setSelected(id);
    setAnnounced(true);
    setReveal((count) => count + 1);
    setRevealFocus(false);
    const panel = mapPanelRef.current;
    if (!event || !panel || !stacked) return;
    if (event.detail > 0) {
      panel.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      return;
    }
    const row = event.currentTarget;
    if (showMapAndRow(panel, row)) return;
    if (id) setRevealFocus(true);
    else row.scrollIntoView({ block: 'nearest' });
  }
  const restaurants = state.restaurants ?? [];
  const observations = (state.priceObservations ?? []).filter(isLiveReport);
  const selectedRestaurant =
    restaurants.find((restaurant) => restaurant.id === selectedRestaurantId) ?? restaurants[0];
  const restaurantObservations = selectedRestaurant
    ? observations.filter((observation) => observation.restaurantId === selectedRestaurant.id)
    : [];
  const today = now ? Date.parse(now) : Date.now();
  // Each restaurant's primary series gives its row the same price, item and date as its panel.
  const priced = restaurants.map((restaurant) => {
    const reports = observations.filter((item) => item.restaurantId === restaurant.id);
    return { restaurant, primary: priceSeries(reports)[0], count: reports.length };
  });
  const listedRestaurants = cheapestFirst
    ? [...priced].sort(
        (a, b) =>
          (a.primary?.latest.priceCents ?? Infinity) - (b.primary?.latest.priceCents ?? Infinity),
      )
    : priced;
  const supersededObservations = selectedRestaurant
    ? (state.priceObservations ?? []).filter(
        (observation) =>
          !isLiveReport(observation) && observation.restaurantId === selectedRestaurant.id,
      )
    : [];
  // Keyed, so the map moves rather than reloads when the screen crosses 1000px and it swaps
  // sides with the place list in the markup.
  const mapPanel = (
    <section key="map" className="panel full-map-panel" ref={mapPanelRef} aria-label="Places map">
      <PlacesMap
        places={state.places}
        bets={state.bets}
        selectedPlaceId={selected}
        revealRequest={reveal}
        focusOnReveal={revealFocus}
        onSelectPlace={(item) => {
          setSelected(item.id);
          setAnnounced(true);
        }}
        onAddPlace={onNewBet && (() => onNewBet('custom'))}
      />
    </section>
  );
  return (
    <>
      <div className="places-toolbar">
        <div className="panel-tabs" role="group" aria-label="Places views">
          <button
            aria-pressed={mode === 'stories'}
            className={mode === 'stories' ? 'selected' : ''}
            onClick={() => showTab('stories')}
          >
            Wager stories
          </button>
          <button
            aria-pressed={mode === 'prices'}
            className={mode === 'prices' ? 'selected' : ''}
            onClick={() => showTab('prices')}
          >
            Roll prices
          </button>
        </div>
        {mode === 'prices' && (
          <button className="button button-secondary" onClick={() => setPriceDialog(true)}>
            <Plus size={16} /> Log a visit
          </button>
        )}
      </div>
      {mode === 'prices' ? (
        <div className="price-summary">
          <aside className="panel place-list restaurant-price-list" aria-label="Restaurant prices">
            <SectionTitle
              title="Restaurant prices"
              subtitle={`${plural(restaurants.length, 'restaurant')} · ${plural(observations.length, 'report')}`}
            />
            {restaurants.length >= 4 && (
              <div className="price-sort">
                <button
                  className="price-sort-toggle"
                  aria-pressed={cheapestFirst}
                  onClick={() => setCheapestFirst((value) => !value)}
                >
                  Lowest price first
                </button>
              </div>
            )}
            {listedRestaurants.map(({ restaurant, primary, count }) => {
              const chosen = selectedRestaurant?.id === restaurant.id;
              const old = primary && isOldReport(primary.latest, today);
              return (
                <button
                  key={restaurant.id}
                  className={`place-item${chosen ? ' selected' : ''}${old ? ' old-report' : ''}`}
                  aria-pressed={chosen}
                  onClick={() => chooseRestaurant(restaurant.id)}
                >
                  <span className="place-symbol">
                    <Utensils size={18} />
                  </span>
                  <span>
                    <strong>{restaurant.name}</strong>
                    <small>{restaurant.address || 'Address not added'}</small>
                    {primary ? (
                      <>
                        <span className="restaurant-latest">
                          <b>{priceLabel(primary.latest.priceCents)}</b> · {primary.label}
                        </span>
                        <span className="place-bet-count">
                          {priceDateLabel(primary.latest)} · {plural(count, 'report')}
                          {old && (
                            <>
                              {' '}
                              <span className="price-old-tag">Old report</span>
                            </>
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="place-bet-count">No reports yet</span>
                    )}
                  </span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
            {!restaurants.length && (
              <EmptyState
                icon={<Utensils />}
                title="No restaurants yet"
                description="Log the price from your last visit to add the first one."
              />
            )}
          </aside>
          {selectedRestaurant ? (
            <PriceHistory
              restaurant={selectedRestaurant}
              observations={restaurantObservations}
              superseded={supersededObservations}
              state={state}
              memberId={memberId}
              onCorrect={setEditingObservation}
              onAddPrice={() => setPriceDialog(true)}
              panelRef={pricePanelRef}
              onWithdraw={onPriceWithdrawn}
            />
          ) : (
            <section className="panel">
              <EmptyState
                icon={<Utensils />}
                title="Your roll price book starts here"
                description="Log a restaurant visit to see member-reported prices over time."
                action={
                  <button className="button button-secondary" onClick={() => setPriceDialog(true)}>
                    <Plus size={16} /> Log a visit
                  </button>
                }
              />
            </section>
          )}
        </div>
      ) : (
        <>
          {/* The page order is the drawn order at every width (the CSS grid places them the same
              way): below 1001px the map shows above the list, so it comes first; wider screens draw
              the list on the left and the map to its right, so the list comes first. */}
          <div className="places-layout">
            {stacked && mapPanel}
            <aside key="list" className="panel place-list" aria-label="Places on the record">
              <SectionTitle
                title="Places on the record"
                subtitle={`${plural(locatedBets.length, 'wager')} with a location`}
              />
              <div className="place-list-items">
                <button
                  ref={allPlacesRef}
                  className={`place-item all-places ${!selected ? 'selected' : ''}`}
                  aria-pressed={!selected}
                  onClick={(event) => choosePlace(undefined, event)}
                >
                  <span className="place-symbol">
                    <MapPin size={20} />
                  </span>
                  <span>
                    <strong>All locations</strong>
                    <small>The whole story</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                {state.places.map((item) => (
                  <button
                    key={item.id}
                    className={`place-item ${selected === item.id ? 'selected' : ''}`}
                    aria-pressed={selected === item.id}
                    onClick={(event) => choosePlace(item.id, event)}
                  >
                    <span className="place-symbol">
                      <Utensils size={18} />
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.address}</small>
                      <span className="place-bet-count">
                        {placeCountLabel(placeBetCounts(state.bets, item.id))}
                      </span>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
              <p className="place-help">
                Pin a location when you create a bet to add a new place to the map.
              </p>
            </aside>
            {!stacked && mapPanel}
          </div>
          <section className="panel">
            <SectionTitle
              title={place ? `On the record at ${place.name}` : 'Wagers with a sense of place'}
              subtitle={
                place
                  ? // The place's counts leave out proposals that were withdrawn or declined; the
                    // table lists them, so the heading says how many.
                    [
                      `Showing ${placeBets.length} of ${plural(locatedBets.length, 'wager')}`,
                      closedBetNote(placeBets),
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
              action={place ? 'Show all locations' : undefined}
              onAction={() => {
                // This button leaves with the filter: hand focus to the list control for it.
                allPlacesRef.current?.focus({ preventScroll: true });
                choosePlace(undefined);
              }}
            />
            <p className="sr-only" role="status">
              {announced &&
                (place
                  ? `Showing ${plural(placeBets.length, 'wager')} at ${place.name}.`
                  : `Showing all ${plural(placeBets.length, 'wager')} with a location.`)}
            </p>
            {placeBets.length ? (
              <BetTable bets={placeBets} state={state} onBet={onBet} memberId={memberId} />
            ) : place ? (
              <EmptyState
                icon={<MapPin />}
                title={`No bets at ${place.name} yet`}
                description="Put the next wager on the record here and it joins this spot on the map."
                action={
                  onNewBet && (
                    <button className="button button-secondary" onClick={() => onNewBet(place.id)}>
                      <Plus size={16} /> New bet here
                    </button>
                  )
                }
              />
            ) : (
              <EmptyState
                icon={<MapPin />}
                title="No located wagers yet"
                description="Pin a location when you put a bet on the record, and its story shows up here."
                action={
                  onNewBet && (
                    <button className="button button-secondary" onClick={() => onNewBet('custom')}>
                      <MapPin size={16} /> Start a bet with a place
                    </button>
                  )
                }
              />
            )}
          </section>
        </>
      )}
      <PriceEntryDialog
        key={editingObservation?.id ?? 'new-price'}
        open={priceDialog || Boolean(editingObservation)}
        onClose={() => {
          setPriceDialog(false);
          setEditingObservation(undefined);
        }}
        state={state}
        memberId={memberId}
        observation={editingObservation}
        initialRestaurantId={selectedRestaurant?.id}
        fallbackFocus={() =>
          [...document.querySelectorAll<HTMLElement>('.price-correct-button')].find(
            (button) => button.dataset.correctedFrom === correctedFrom.current,
          ) ?? null
        }
        onSave={async (input) => {
          // The panel follows the report to its restaurant, which may be new.
          const restaurantId = await onPriceSaved(input);
          if (restaurantId) chooseRestaurant(restaurantId);
        }}
        onCorrect={async (id, input) => {
          await onPriceCorrected(id, input);
          correctedFrom.current = id;
          setEditingObservation(undefined);
          setSelectedRestaurantId(input.restaurantId);
        }}
      />
    </>
  );
}

/** What is going on with `member` from the reader's seat: bets in play, and who owes whom. */
function memberLine(
  member: Member,
  stats: MemberStats,
  memberId: string,
  balances: Balance[],
): string[] {
  const parts = [stats.active ? `${plural(stats.active, 'bet')} in play` : 'Nothing in play'];
  if (member.id === memberId) {
    if (stats.owedToYou) parts.push(`owed ${plural(stats.owedToYou, 'roll')}`);
    if (stats.youOwe) parts.push(`you owe ${plural(stats.youOwe, 'roll')}`);
  } else {
    const rolls = (fromId: string, toId: string) =>
      balances.find((balance) => balance.fromId === fromId && balance.toId === toId)?.rolls ?? 0;
    const owesYou = rolls(member.id, memberId);
    const youOwe = rolls(memberId, member.id);
    if (owesYou) parts.push(`owes you ${plural(owesYou, 'roll')}`);
    if (youOwe) parts.push(`you owe ${plural(youOwe, 'roll')}`);
  }
  return parts;
}

export function MembersView({
  state,
  memberId,
  onInvite,
  onBetWith,
  onViewBets,
  invitations,
}: ViewProps & {
  onInvite: () => void;
  /** Start a new bet with this member. */
  onBetWith: (member: Member) => void;
  /** Show the ledger's bets that name this member. */
  onViewBets: (member: Member) => void;
  /** The ledger's open invitations, under the cards; a demo has none to show. */
  invitations?: ReactNode;
}) {
  const inviteHint = useId();
  const balances = getDirectDebts(state.bets);
  return (
    <>
      <section className="members-intro">
        <div>
          <h2>Good company. Strong opinions.</h2>
          <p>Everyone at the table gets an equal say in their own wagers.</p>
        </div>
        <button className="button button-primary" onClick={onInvite}>
          <Plus size={16} />
          Invite a member
        </button>
      </section>
      <div className="members-grid">
        {state.members.map((member) => {
          const stats = getMemberStats(state.bets, member.id);
          const you = member.id === memberId;
          const decided = stats.won + stats.lost;
          return (
            <section className="panel member-card" key={member.id}>
              <Avatar member={member} size={52} decorative />
              <h3>
                {member.name}
                {you && (
                  <>
                    {' '}
                    <small>(you)</small>
                  </>
                )}
              </h3>
              <span className="member-role">
                {memberLine(member, stats, memberId, balances).map((part, index) => (
                  <Fragment key={part}>
                    {index > 0 && ' '}
                    <span>{part}</span>
                  </Fragment>
                ))}
              </span>
              <div className="member-actions">
                {!you && (
                  <button className="button button-secondary" onClick={() => onBetWith(member)}>
                    Bet with {member.name}
                  </button>
                )}
                <button
                  className="button button-secondary"
                  aria-label={`View bets involving ${you ? 'you' : member.name}`}
                  onClick={() => onViewBets(member)}
                >
                  View bets
                </button>
              </div>
              <div className="member-stats">
                <div>
                  <strong>{decided}</strong>
                  <span>decided bets</span>
                </div>
                <div>
                  <strong>
                    {decided ? (
                      `${Math.round(stats.winRate)}%`
                    ) : (
                      <>
                        —<small className="sr-only">none yet</small>
                      </>
                    )}
                  </strong>
                  <span>win rate</span>
                </div>
                <div>
                  <strong className={stats.net > 0 ? 'green' : stats.net < 0 ? 'red' : undefined}>
                    {stats.net > 0 ? '+' : ''}
                    {stats.net}
                  </strong>
                  <span>All-time net</span>
                </div>
              </div>
            </section>
          );
        })}
        <button
          className="invite-member-card"
          onClick={onInvite}
          aria-label="Invite a member"
          aria-describedby={inviteHint}
        >
          <span aria-hidden="true">
            <Users size={26} />
          </span>
          <strong>Room for another opinion.</strong>
          <span className="invite-hint" id={inviteHint}>
            Share an invitation by text or link.
          </span>
          <span className="invite-label">
            Invite a member
            <ArrowRight size={15} />
          </span>
        </button>
      </div>
      <p className="members-footnote">
        All-time net is the rolls a person has won minus the rolls they have lost on decided bets,
        whether or not the rolls have been delivered.
      </p>
      {invitations}
    </>
  );
}

const FEED_PAGE = 10;
/** Up to this many next moves fit a window, so the list can stay in view beside a long feed. */
const SHORT_NEXT_MOVES = 4;
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

export function InboxView({
  state,
  memberId,
  onBet,
  onNewBet,
  now,
}: ViewProps & { onNewBet?: () => void }) {
  const approvals = sortByDuty(state.bets.filter((bet) => needsAction(bet, memberId, now)));
  const activity = state.bets
    .flatMap((bet) => bet.events.map((event) => ({ event, bet })))
    .sort((a, b) => b.event.at.localeCompare(a.event.at));
  const feedId = useId();
  const [shown, setShown] = useState(FEED_PAGE);
  const feed = useRef<HTMLUListElement>(null);
  // Showing more keeps the reader's place: focus lands on the first row that just appeared.
  const revealedFrom = useRef<number | null>(null);
  useEffect(() => {
    if (revealedFrom.current === null) return;
    feed.current?.querySelectorAll<HTMLButtonElement>('li > button')[revealedFrom.current]?.focus();
    revealedFrom.current = null;
  }, [shown]);
  const remaining = activity.length - shown;
  const newBetButton = onNewBet && (
    <button className="button button-primary" onClick={onNewBet}>
      <Plus size={16} />
      New bet
    </button>
  );
  return (
    <div className="inbox-columns">
      <section
        className={`panel inbox-next-moves${approvals.length <= SHORT_NEXT_MOVES ? ' is-short' : ''}`}
      >
        <SectionTitle title="Your next moves" subtitle="Only you can move these forward." />
        {approvals.length ? (
          <ul className="action-list">
            {approvals.map((bet) => (
              <li key={bet.id}>
                <ActionItem
                  bet={bet}
                  state={state}
                  memberId={memberId}
                  now={now}
                  size="expanded"
                  onOpen={onBet}
                />
              </li>
            ))}
          </ul>
        ) : (
          <NextMovesEmpty
            hasBets={state.bets.length > 0}
            iconSize={34}
            newBetButton={newBetButton}
          />
        )}
      </section>
      <section className="panel">
        <SectionTitle
          title="Around the ledger"
          subtitle="The latest signed and timestamped activity."
        />
        {activity.length ? (
          <>
            <ul className="inbox-activity" ref={feed}>
              {activity.slice(0, shown).map(({ event, bet }) => {
                const summary = formatAuditDetail(event, state.members, bet)
                  .replace(/\s+/g, ' ')
                  .trim();
                const metaId = `${feedId}-${event.id}`;
                return (
                  <li key={event.id}>
                    <button
                      type="button"
                      aria-label={`${clip(bet.title, 60)}: ${clip(summary, 120)}`}
                      aria-describedby={metaId}
                      aria-haspopup="dialog"
                      onClick={() => onBet(bet)}
                    >
                      <Avatar member={nameOf(state, event.actorId)} size={30} decorative />
                      <span>
                        <strong>{bet.title}</strong>
                        <p>{summary}</p>
                        <small id={metaId}>
                          <time dateTime={event.at}>{timeLabel(event.at)}</time> ·{' '}
                          {shortName(nameOf(state, event.actorId))}
                        </small>
                      </span>
                      <ChevronRight
                        className="inbox-activity-chevron"
                        size={16}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="inbox-activity-foot">
              <span className="inbox-activity-count">
                Showing {Math.min(shown, activity.length)} of {activity.length}
              </span>
              {remaining > 0 && (
                <button
                  className="button button-secondary"
                  onClick={() => {
                    revealedFrom.current = shown;
                    setShown(shown + FEED_PAGE);
                  }}
                >
                  Show {Math.min(FEED_PAGE, remaining)} more
                </button>
              )}
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Bell size={34} />}
            title="No activity yet"
            description="Agreements, results and deliveries are signed and timestamped here as they happen."
          />
        )}
      </section>
    </div>
  );
}
