import { avatarColorFor, initialsFor } from '../src/lib/avatar-colors';
import {
  memberNameProblem,
  normalizeMemberName,
  sameMemberName,
  uniqueMemberName,
} from '../src/lib/member-name';
import type { Bet, Member, OpenInvite, PriceObservation, Restaurant } from '../src/lib/types';
import { HTTPException } from 'hono/http-exception';
import type { GoogleIdentity } from './security';

export const memberColumns = 'id, name, initials, color';
const memberNamesSnapshot =
  "SELECT json_group_array(json_object('id', id, 'name', name)) AS names FROM (SELECT id, name FROM members ORDER BY id)";

/** Changes the name a member goes by, leaving their account and ledger identity intact. */
export async function updateMemberName(
  db: D1Database,
  memberId: string,
  name: string,
): Promise<Member> {
  const snapshot = (await db.prepare(memberNamesSnapshot).first<string>('names'))!;
  const members = JSON.parse(snapshot) as Pick<Member, 'id' | 'name'>[];
  const problem = memberNameProblem(
    name,
    members.filter((member) => member.id !== memberId),
  );
  if (problem) throw new HTTPException(400, { message: problem });
  const clean = normalizeMemberName(name);
  // Keep the Unicode-aware check and write consistent: a changed or added member invalidates
  // the snapshot inside this statement, so two simultaneous edits cannot claim the same name.
  const member = await db
    .prepare(
      `UPDATE members SET name = ?, initials = ? WHERE id = ? AND (${memberNamesSnapshot}) = ? RETURNING ${memberColumns}`,
    )
    .bind(clean, initialsFor(clean), memberId, snapshot)
    .first<Member>();
  if (!member)
    throw new HTTPException(422, {
      message: 'The names at the table changed. Please try saving again.',
    });
  return member;
}

export async function insertBet(db: D1Database, bet: Bet) {
  await db
    .prepare(
      'INSERT INTO bets (id, reference, creator_id, opponent_id, winner_id, stake, status, version, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      bet.id,
      bet.reference,
      bet.creatorId,
      bet.opponentId,
      bet.resolution?.winnerId ?? null,
      bet.stake,
      bet.status,
      bet.version,
      bet.createdAt,
      bet.updatedAt,
      JSON.stringify(bet),
    )
    .run();
}

export async function updateBet(db: D1Database, bet: Bet, expectedVersion: number) {
  // The SQL trigger appends the audit event within this same statement. A failed
  // comparison changes neither bet nor events; an audit failure rolls both back.
  const result = await db
    .prepare(
      'UPDATE bets SET winner_id = ?, stake = ?, status = ?, version = ?, updated_at = ?, data = ? WHERE id = ? AND version = ? RETURNING id',
    )
    .bind(
      bet.resolution?.winnerId ?? null,
      bet.stake,
      bet.status,
      bet.version,
      bet.updatedAt,
      JSON.stringify(bet),
      bet.id,
      expectedVersion,
    )
    .first<{ id: string }>();
  if (!result)
    throw new HTTPException(409, { message: 'This bet changed. Refresh it before confirming.' });
}

/** The columns of a price report, named as `PriceObservation` names them. */
export const priceColumns =
  'id, restaurant_id AS restaurantId, item_name AS itemName, price_cents AS priceCents, currency, visit_date AS visitDate, visit_date_precision AS visitDatePrecision, reporter_id AS reporterId, reported_at AS reportedAt, note, corrected_from_id AS correctedFromId, corrected_at AS correctedAt, correction_reason AS correctionReason, withdrawn_at AS withdrawnAt, withdrawn_reason AS withdrawnReason, entry_source AS entrySource';

/** The statement that adds a restaurant, so it can share a batch with the report that names it. */
export function restaurantInsert(
  db: D1Database,
  restaurant: Restaurant,
  createdBy: string,
  createdAt: string,
) {
  return db
    .prepare(
      'INSERT INTO restaurants (id, name, address, lat, lng, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      restaurant.id,
      restaurant.name,
      restaurant.address,
      restaurant.lat ?? null,
      restaurant.lng ?? null,
      createdBy,
      createdAt,
    );
}

export function priceObservationInsert(db: D1Database, observation: PriceObservation) {
  return db
    .prepare(
      'INSERT INTO price_observations (id, restaurant_id, item_name, price_cents, currency, visit_date, visit_date_precision, reporter_id, reported_at, note, entry_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      observation.id,
      observation.restaurantId,
      observation.itemName,
      observation.priceCents,
      observation.currency,
      observation.visitDate,
      observation.visitDatePrecision,
      observation.reporterId,
      observation.reportedAt,
      observation.note ?? null,
      observation.entrySource ?? 'web',
    );
}

/**
 * Adds a report unless its reporter already has a live report (not corrected or withdrawn) of the
 * same visit (restaurant, item ignoring case and outer spaces, date and precision), or only one at the same price when
 * `samePriceOnly` (a separate purchase the member confirmed). The check and the insert are one
 * statement, so of two copies of one report sent at once only one is written. Says whether it was.
 */
export async function insertPriceObservationUnlessReported(
  db: D1Database,
  observation: PriceObservation,
  samePriceOnly: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO price_observations (id, restaurant_id, item_name, price_cents, currency, visit_date, visit_date_precision, reporter_id, reported_at, note, entry_source) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM price_observations WHERE reporter_id = ? AND restaurant_id = ? AND visit_date = ? AND visit_date_precision = ? AND lower(trim(item_name)) = lower(trim(?)) AND corrected_at IS NULL AND withdrawn_at IS NULL${samePriceOnly ? ' AND price_cents = ?' : ''})`,
    )
    .bind(
      observation.id,
      observation.restaurantId,
      observation.itemName,
      observation.priceCents,
      observation.currency,
      observation.visitDate,
      observation.visitDatePrecision,
      observation.reporterId,
      observation.reportedAt,
      observation.note ?? null,
      observation.entrySource ?? 'web',
      observation.reporterId,
      observation.restaurantId,
      observation.visitDate,
      observation.visitDatePrecision,
      observation.itemName,
      ...(samePriceOnly ? [observation.priceCents] : []),
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Supersedes a report with its correction, and says whether the correction was written. A report
 * has at most one successor: the insert happens only while none exists and only once this batch
 * (one transaction) stamped the original, so of two corrections sent at once only one lands, and
 * a report withdrawn a moment ago gets none.
 */
export async function correctPriceObservation(
  db: D1Database,
  originalId: string,
  corrected: PriceObservation,
  correctedAt: string,
): Promise<boolean> {
  const [, inserted] = await db.batch([
    db
      .prepare(
        'UPDATE price_observations SET corrected_at = ? WHERE id = ? AND corrected_at IS NULL AND withdrawn_at IS NULL',
      )
      .bind(correctedAt, originalId),
    db
      .prepare(
        'INSERT INTO price_observations (id, restaurant_id, item_name, price_cents, currency, visit_date, visit_date_precision, reporter_id, reported_at, note, corrected_from_id, correction_reason, entry_source) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM price_observations WHERE id = ? AND corrected_at = ? AND withdrawn_at IS NULL) AND NOT EXISTS (SELECT 1 FROM price_observations WHERE corrected_from_id = ?)',
      )
      .bind(
        corrected.id,
        corrected.restaurantId,
        corrected.itemName,
        corrected.priceCents,
        corrected.currency,
        corrected.visitDate,
        corrected.visitDatePrecision,
        corrected.reporterId,
        corrected.reportedAt,
        corrected.note ?? null,
        originalId,
        corrected.correctionReason ?? null,
        corrected.entrySource ?? 'web',
        originalId,
        correctedAt,
        originalId,
      ),
  ]);
  return (inserted.meta.changes ?? 0) > 0;
}

/**
 * Withdraws a live report (not corrected, not withdrawn) of `reporterId`'s, keeping it on record
 * with the time and reason. Says whether it was withdrawn: of two withdrawals, or a withdrawal and
 * a correction, sent at once, only one changes the report.
 */
export async function withdrawPriceObservation(
  db: D1Database,
  id: string,
  reporterId: string,
  reason: string,
  withdrawnAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE price_observations SET withdrawn_at = ?, withdrawn_reason = ? WHERE id = ? AND reporter_id = ? AND corrected_at IS NULL AND withdrawn_at IS NULL',
    )
    .bind(withdrawnAt, reason, id, reporterId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * The invitations `memberId` made that can still be used, newest first. The id is the stored hash,
 * which names the row but cannot be turned back into the link, so the link is never listed.
 */
export async function listOpenInvites(
  db: D1Database,
  memberId: string,
  now: string,
): Promise<OpenInvite[]> {
  const { results } = await db
    .prepare(
      'SELECT token_hash AS id, name, created_at AS createdAt, expires_at AS expiresAt FROM invites WHERE created_by = ? AND used_by IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC',
    )
    .bind(memberId, now)
    .all<OpenInvite>();
  return results;
}

/**
 * Ends one of `memberId`'s open invitations now, so its link stops starting a sign-in. The row stays
 * as a record of who was invited and by whom; only its expiry moves up. False when there was no such
 * open invitation: unknown, someone else's, already used or already over.
 */
export async function revokeInvite(
  db: D1Database,
  memberId: string,
  id: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE invites SET expires_at = ? WHERE token_hash = ? AND created_by = ? AND used_by IS NULL AND expires_at > ?',
    )
    .bind(now, id, memberId, now)
    .run();
  return result.meta.changes > 0;
}

/** The name typed into an unused, unexpired invitation, cleaned; undefined when it holds none. */
async function invitedName(db: D1Database, inviteHash: string, now: string) {
  const invite = await db
    .prepare('SELECT name FROM invites WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?')
    .bind(inviteHash, now)
    .first<{ name: string }>();
  return normalizeMemberName(invite?.name ?? '') || undefined;
}

export async function admitIdentity(
  db: D1Database,
  identity: GoogleIdentity,
  ownerEmail: string,
  inviteHash?: string,
): Promise<Member> {
  const existing = await db
    .prepare(`SELECT ${memberColumns} FROM members WHERE google_sub = ?`)
    .bind(identity.sub)
    .first<Member>();
  if (existing) return existing;

  const now = new Date().toISOString();
  const asOwner = identity.email === ownerEmail.trim().toLowerCase() && identity.emailAuthoritative;
  const group = (
    await db.prepare('SELECT name, color FROM members').all<{ name: string; color: string }>()
  ).results;
  // A new member goes by the name the inviter typed; the Google profile name is the fallback for the
  // owner, for an invitation that holds no usable name and for a name someone has taken since it was
  // typed. Whichever name is used, no two members share one: a taken name gets a number.
  const taken = group.map((member) => member.name);
  const typed = !asOwner && inviteHash ? await invitedName(db, inviteHash, now) : undefined;
  const profile = normalizeMemberName(identity.name) || identity.email.split('@')[0] || 'Member';
  const isFree = (candidate: string) => !taken.some((other) => sameMemberName(other, candidate));
  const name = uniqueMemberName(
    [typed, profile].find((candidate) => candidate !== undefined && isFree(candidate)) ??
      typed ??
      profile,
    taken,
  );
  // A palette colour from the id's hash, moved to a free one when the group already wears it.
  const id = crypto.randomUUID();
  const member: Member = {
    id,
    name,
    initials: initialsFor(name),
    color: avatarColorFor(
      id,
      group.map((row) => row.color),
    ),
  };
  if (asOwner) {
    await db
      .prepare(
        'INSERT INTO members (id, google_sub, email, name, initials, color, created_at, is_owner) SELECT ?, ?, ?, ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM members WHERE is_owner = 1)',
      )
      .bind(
        member.id,
        identity.sub,
        identity.email,
        member.name,
        member.initials,
        member.color,
        now,
      )
      .run();
  } else if (inviteHash) {
    // D1 batch executes atomically. The insertion reads the unused invitation
    // inside the same transaction that consumes it, preventing dual redemption.
    await db.batch([
      db
        .prepare(
          'INSERT INTO members (id, google_sub, email, name, initials, color, created_at) SELECT ?, ?, ?, ?, ?, ?, ? FROM invites WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?',
        )
        .bind(
          member.id,
          identity.sub,
          identity.email,
          member.name,
          member.initials,
          member.color,
          now,
          inviteHash,
          now,
        ),
      db
        .prepare(
          'UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ? AND used_by IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM members WHERE id = ?)',
        )
        .bind(member.id, now, inviteHash, now, member.id),
    ]);
  }
  const admitted = await db
    .prepare(`SELECT ${memberColumns} FROM members WHERE google_sub = ?`)
    .bind(identity.sub)
    .first<Member>();
  if (!admitted)
    throw new HTTPException(403, { message: 'Ask a member for a new invitation to this ledger.' });
  return admitted;
}
