import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type {
  priceObservationSchema,
  priceReportSchema,
  priceWithdrawalSchema,
  restaurantSchema,
} from '../src/lib/api-schemas';
import {
  correctionChangesNothing,
  correctionDuplicate,
  findRestaurant,
  planPriceReport,
  plausibility,
  priceLabel,
  sameSeries,
  type PriceReportPlan,
} from '../src/lib/price-observations';
import type {
  PriceCorrectionResult,
  PriceEntrySource,
  PriceObservation,
  PriceReportResult,
  PriceWarning,
  PriceWithdrawalResult,
  Restaurant,
  RestaurantMatch,
} from '../src/lib/types';
import {
  correctPriceObservation,
  insertPriceObservationUnlessReported,
  priceColumns,
  priceObservationInsert,
  restaurantInsert,
  withdrawPriceObservation,
} from './storage';

/**
 * The price rules, in one place for every way in: the website's routes and the MCP tools are thin
 * adapters over these functions, so a rule added here holds on both.
 */
export type RestaurantInput = z.output<typeof restaurantSchema>;
export type PriceReportInput = z.output<typeof priceReportSchema>;
export type PriceCorrectionInput = z.output<typeof priceObservationSchema>;
export type PriceWithdrawalInput = z.output<typeof priceWithdrawalSchema>;

/** A second report of a visit the member already reported at another price. */
export class DuplicatePriceReport extends HTTPException {
  readonly existing: PriceObservation;
  constructor(
    existing: PriceObservation,
    message = `You already reported ${priceLabel(existing.priceCents)} for this visit (report ${existing.id}). Correct that report instead, or confirm with confirmSeparateReport that this was a separate purchase.`,
  ) {
    super(409, { message });
    this.existing = existing;
  }
}

/** A price outside what a roll usually costs, or a likely slipped decimal point: asked about first. */
export class UnusualPriceReport extends HTTPException {
  readonly warnings: PriceWarning[];
  constructor(warnings: PriceWarning[]) {
    super(422, {
      message: `${warnings.map((warning) => warning.message).join(' ')} Check the price with the member, then send it again with confirmUnusualPrice: true to keep it.`,
    });
    this.warnings = warnings;
  }
}

const restaurantColumns = 'id, name, address, lat, lng';
/** Reports that still count: not replaced by a correction and not withdrawn. */
const live = 'corrected_at IS NULL AND withdrawn_at IS NULL';

async function matchRestaurant(
  db: D1Database,
  input: RestaurantInput,
): Promise<{ restaurant: Restaurant; matched: RestaurantMatch } | undefined> {
  const exact = await db
    .prepare(`SELECT ${restaurantColumns} FROM restaurants WHERE name = ? AND address = ?`)
    .bind(input.name, input.address)
    .first<Restaurant>();
  if (exact) return { restaurant: exact, matched: 'exact' };
  // Unicode folding is not something SQLite can do, and a group's restaurants are few.
  const all = await db.prepare(`SELECT ${restaurantColumns} FROM restaurants`).all<Restaurant>();
  const restaurant = findRestaurant(all.results, input);
  return restaurant && { restaurant, matched: 'normalised' };
}

/**
 * The restaurant with this name and address, ignoring case and spacing, or a new one. Two members
 * adding the same restaurant at once both get the row that was written first.
 */
export async function getOrCreateRestaurant(
  db: D1Database,
  input: RestaurantInput,
  memberId: string,
  now = new Date().toISOString(),
): Promise<{ restaurant: Restaurant; matched: RestaurantMatch }> {
  const found = await matchRestaurant(db, input);
  if (found) return found;
  const restaurant: Restaurant = { id: crypto.randomUUID(), ...input };
  try {
    await restaurantInsert(db, restaurant, memberId, now).run();
  } catch (error) {
    const raced = await matchRestaurant(db, input);
    if (raced) return { restaurant: raced.restaurant, matched: 'normalised' };
    throw error;
  }
  return { restaurant, matched: 'created' };
}

/** The live reports at one restaurant, which an unusual price is measured against. */
async function liveReportsAt(db: D1Database, restaurantId: string | undefined) {
  if (!restaurantId) return [];
  const { results } = await db
    .prepare(`SELECT ${priceColumns} FROM price_observations WHERE restaurant_id = ? AND ${live}`)
    .bind(restaurantId)
    .all<PriceObservation>();
  return results;
}

/**
 * What one report does, decided from the restaurants, the reporter's reports of that date and the
 * live reports at the restaurant.
 */
async function planFromLedger(
  db: D1Database,
  input: PriceReportInput,
  reporterId: string,
  now: string,
): Promise<PriceReportPlan> {
  const restaurants = input.restaurant
    ? await db.prepare(`SELECT ${restaurantColumns} FROM restaurants`).all<Restaurant>()
    : await db
        .prepare(`SELECT ${restaurantColumns} FROM restaurants WHERE id = ?`)
        .bind(input.restaurantId)
        .all<Restaurant>();
  const sameDay = await db
    .prepare(
      `SELECT ${priceColumns} FROM price_observations WHERE reporter_id = ? AND visit_date = ? AND visit_date_precision = ? AND ${live}`,
    )
    .bind(reporterId, input.visitDate, input.visitDatePrecision)
    .all<PriceObservation>();
  const restaurantId = input.restaurant
    ? findRestaurant(restaurants.results, input.restaurant)?.id
    : restaurants.results[0]?.id;
  const observations = new Map(
    [...sameDay.results, ...(await liveReportsAt(db, restaurantId))].map((item) => [item.id, item]),
  );
  return planPriceReport({
    input,
    reporterId,
    restaurants: restaurants.results,
    observations: [...observations.values()],
    newId: () => crypto.randomUUID(),
    now,
  });
}

/** A report that writes nothing: an unknown restaurant, a question, or the report on record. */
function settle(plan: Exclude<PriceReportPlan, { kind: 'record' }>): PriceReportResult {
  if (plan.kind === 'unknown-restaurant')
    throw new HTTPException(400, { message: 'Choose a restaurant from the ledger.' });
  if (plan.kind === 'conflict') throw new DuplicatePriceReport(plan.existing);
  if (plan.kind === 'unusual') throw new UnusualPriceReport(plan.warnings);
  return plan.result;
}

/** Writes a planned report, or nothing when a report of the same visit landed since the plan. */
async function writePlannedReport(
  db: D1Database,
  plan: Extract<PriceReportPlan, { kind: 'record' }>,
  input: PriceReportInput,
  reporterId: string,
  now: string,
): Promise<PriceReportResult | undefined> {
  const { observation, restaurant } = plan.result;
  const samePriceOnly = Boolean(input.confirmSeparateReport);
  if (!plan.newRestaurant)
    return (await insertPriceObservationUnlessReported(db, observation, samePriceOnly))
      ? plan.result
      : undefined;
  try {
    await db.batch([
      restaurantInsert(db, restaurant, reporterId, now),
      priceObservationInsert(db, observation),
    ]);
    return plan.result;
  } catch (error) {
    // Another member added this restaurant a moment ago: the report joins theirs.
    const raced = input.restaurant && (await matchRestaurant(db, input.restaurant));
    if (!raced) throw error;
    const joined = { ...observation, restaurantId: raced.restaurant.id };
    if (!(await insertPriceObservationUnlessReported(db, joined, samePriceOnly))) return undefined;
    return { observation: joined, restaurant: raced.restaurant, matched: 'normalised' };
  }
}

/**
 * Records one price as `reporterId`, entered through `source`. A restaurant named inline is written
 * in the same batch as the report, so a refused report never leaves an empty restaurant behind. A
 * report of a visit this member already reported (same restaurant, item, date and precision) at the
 * same price returns that report instead, which makes a retry safe, even one sent while the first
 * is still being written; at another price it is refused unless `confirmSeparateReport` says it was
 * a separate purchase. An unusual price is refused with its warnings unless `confirmUnusualPrice`.
 */
export async function recordPrice(
  db: D1Database,
  input: PriceReportInput,
  reporterId: string,
  now = new Date().toISOString(),
  source: PriceEntrySource = 'web',
): Promise<PriceReportResult> {
  const planned = await planFromLedger(db, input, reporterId, now);
  if (planned.kind !== 'record') return settle(planned);
  const plan = {
    ...planned,
    result: {
      ...planned.result,
      observation: { ...planned.result.observation, entrySource: source },
    },
  };
  const written = await writePlannedReport(db, plan, input, reporterId, now);
  if (written) return written;
  // The same visit was reported between the check and the write, as when a client resends a report
  // it is still waiting on: answer as if that report had been read first.
  const again = await planFromLedger(db, input, reporterId, now);
  if (again.kind === 'record')
    throw new HTTPException(409, {
      message: 'This visit was reported a moment ago. Send the report again.',
    });
  return settle(again);
}

const findReport = async (db: D1Database, id: string) => {
  const report = await db
    .prepare(`SELECT ${priceColumns} FROM price_observations WHERE id = ?`)
    .bind(id)
    .first<PriceObservation>();
  if (!report) throw new HTTPException(404, { message: 'That price report could not be found.' });
  return report;
};
const alreadyCorrected = () =>
  new HTTPException(409, { message: 'That price report has already been corrected.' });

/** The duplicate rule of the visit a correction lands on, over the member's live reports of it. */
async function refuseDuplicateCorrection(
  db: D1Database,
  original: PriceObservation,
  input: PriceCorrectionInput,
) {
  const { results } = await db
    .prepare(
      `SELECT ${priceColumns} FROM price_observations WHERE reporter_id = ? AND restaurant_id = ? AND visit_date = ? AND visit_date_precision = ? AND id != ? AND ${live}`,
    )
    .bind(
      original.reporterId,
      input.restaurantId,
      input.visitDate,
      input.visitDatePrecision,
      original.id,
    )
    .all<PriceObservation>();
  const duplicate = correctionDuplicate(results, original, input);
  if (duplicate?.kind === 'copy')
    throw new DuplicatePriceReport(
      duplicate.existing,
      `You already reported ${priceLabel(duplicate.existing.priceCents)} for this visit (report ${duplicate.existing.id}), so this correction would count it twice. Withdraw this report instead.`,
    );
  if (duplicate)
    throw new DuplicatePriceReport(
      duplicate.existing,
      `You already reported ${priceLabel(duplicate.existing.priceCents)} for this visit (report ${duplicate.existing.id}). Correct that report instead, or confirm with confirmSeparateReport that this correction is a separate purchase.`,
    );
}

/**
 * Replaces the member's own report with a correction, entered through `source`, with an optional
 * reason. The original stays on record, stamped as corrected; a report is corrected at most once,
 * and never once it is withdrawn. A correction follows the duplicate rule of the visit it lands on,
 * and a new price that looks unusual is asked about first.
 */
export async function correctPrice(
  db: D1Database,
  originalId: string,
  input: PriceCorrectionInput,
  memberId: string,
  now = new Date().toISOString(),
  source: PriceEntrySource = 'web',
): Promise<PriceCorrectionResult> {
  const original = await findReport(db, originalId);
  if (original.reporterId !== memberId)
    throw new HTTPException(403, {
      message: 'Only the member who reported a price can correct it.',
    });
  if (original.correctedAt) throw alreadyCorrected();
  if (original.withdrawnAt)
    throw new HTTPException(409, { message: 'That price report has been withdrawn.' });
  const restaurant = await db
    .prepare('SELECT id FROM restaurants WHERE id = ?')
    .bind(input.restaurantId)
    .first<{ id: string }>();
  if (!restaurant)
    throw new HTTPException(400, { message: 'Choose a restaurant from the ledger.' });
  if (correctionChangesNothing(original, input))
    throw new HTTPException(400, {
      message:
        'This correction changes nothing. Change the restaurant, price, item, date or note first.',
    });
  const { confirmUnusualPrice, confirmSeparateReport: _separate, ...fields } = input;
  await refuseDuplicateCorrection(db, original, input);
  // A price the member kept once is not asked about again when only other details change.
  if (!confirmUnusualPrice && input.priceCents !== original.priceCents) {
    const series = sameSeries(
      await liveReportsAt(db, input.restaurantId),
      input.restaurantId,
      input.itemName,
    ).filter((item) => item.id !== original.id);
    const warnings = plausibility(input.priceCents, series);
    if (warnings.length) throw new UnusualPriceReport(warnings);
  }
  const corrected: PriceObservation = {
    id: crypto.randomUUID(),
    ...fields,
    currency: 'USD',
    reporterId: memberId,
    reportedAt: now,
    correctedFromId: original.id,
    entrySource: source,
  };
  if (!(await correctPriceObservation(db, original.id, corrected, now))) {
    const latest = await findReport(db, original.id);
    if (latest.withdrawnAt)
      throw new HTTPException(409, { message: 'That price report has been withdrawn.' });
    throw alreadyCorrected();
  }
  return { observation: corrected, corrected: { ...original, correctedAt: now } };
}

/**
 * Withdraws the member's own report with a reason. It stays on record, stamped with when and why,
 * and leaves every price figure. A report is withdrawn at most once, and never once a correction
 * replaced it (withdraw the correction instead).
 */
export async function withdrawPrice(
  db: D1Database,
  id: string,
  input: PriceWithdrawalInput,
  memberId: string,
  now = new Date().toISOString(),
): Promise<PriceWithdrawalResult> {
  const refusal = (report: PriceObservation) =>
    report.withdrawnAt
      ? new HTTPException(409, { message: 'That price report has already been withdrawn.' })
      : report.correctedAt
        ? alreadyCorrected()
        : undefined;
  const report = await findReport(db, id);
  if (report.reporterId !== memberId)
    throw new HTTPException(403, {
      message: 'Only the member who reported a price can withdraw it.',
    });
  const refused = refusal(report);
  if (refused) throw refused;
  if (!(await withdrawPriceObservation(db, id, memberId, input.reason, now)))
    throw (
      refusal(await findReport(db, id)) ??
      new HTTPException(409, { message: 'That price report changed. Refresh and try again.' })
    );
  return { observation: { ...report, withdrawnAt: now, withdrawnReason: input.reason } };
}
