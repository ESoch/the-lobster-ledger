import { z } from 'zod';
import { LIMITS, type TextLimit } from './limits';
import { MEMBER_NAME_BLANK, MEMBER_NAME_TOO_LONG, normalizeMemberName } from './member-name';
import { isCalendarDay, visitDateProblem } from './price-observations';

const bounded = ({ min, max }: TextLimit) => z.string().trim().min(min).max(max);
const note = bounded(LIMITS.note);
const memberId = z.string().min(1).max(100);
const calendarDay = z
  .string()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDay, 'Choose a valid calendar date');
const historicalDate = z.discriminatedUnion('precision', [
  z.object({ precision: z.literal('day'), value: calendarDay }).strict(),
  z
    .object({
      precision: z.literal('month'),
      value: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
    })
    .strict(),
  z.object({ precision: z.literal('year'), value: z.string().regex(/^(?!0000)\d{4}$/) }).strict(),
  z.object({ precision: z.literal('unknown') }).strict(),
]);
const zonedDateTime = z
  .object({
    at: z
      .string()
      .max(40)
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
            value,
          ) &&
          calendarDay.safeParse(value.slice(0, 10)).success &&
          Number.isFinite(Date.parse(value)),
        'Use a valid date and time with an explicit UTC offset',
      ),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid timezone'),
  })
  .strict();
const timingContext = {
  source: bounded(LIMITS.source).optional(),
  checkIn: zonedDateTime.optional(),
};
const description = bounded(LIMITS.description);
const decisionTiming = z.discriminatedUnion('kind', [
  zonedDateTime.extend({ kind: z.literal('date'), ...timingContext }).strict(),
  z.object({ kind: z.literal('event'), description, ...timingContext }).strict(),
  z.object({ kind: z.literal('evidence'), description, ...timingContext }).strict(),
]);
const acknowledgements = z
  .object({ terms: z.boolean(), result: z.boolean(), delivery: z.boolean() })
  .strict();
const reportedSourceUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTPS evidence link');
const historicalInput = z
  .object({
    stage: z.enum(['active', 'owed', 'settled', 'voided']),
    originalDate: historicalDate,
    result: z
      .object({ winnerId: memberId.nullable(), date: historicalDate, note })
      .strict()
      .optional(),
    delivery: z.object({ date: historicalDate, note }).strict().optional(),
    previousAdjudication: z
      .object({
        method: z.enum(['judge', 'chatgpt']),
        note,
        sourceUrl: reportedSourceUrl.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const agreementFields = {
  title: bounded(LIMITS.title),
  terms: bounded(LIMITS.terms),
  category: z.enum(['Work', 'Sports', 'Life', 'Wild card']),
  creatorSide: bounded(LIMITS.side),
  opponentSide: bounded(LIMITS.side),
  stake: z.number().int().min(1).max(100),
  deadline: calendarDay.optional(),
  location: z
    .object({
      id: z.string().min(1).max(100),
      name: z.string().trim().min(1).max(180),
      address: z.string().max(300),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .strict()
    .optional(),
  timing: decisionTiming.optional(),
  cutoff: zonedDateTime.optional(),
};
const historyRevision = z.object({ ...agreementFields, history: historicalInput }).strict();
const chatGptShareUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) &&
        /^\/share\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Use an official HTTPS ChatGPT share link.');
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confirm_history'), acknowledgements }).strict(),
  z.object({ type: z.literal('request_history_correction'), note }).strict(),
  z
    .object({ type: z.literal('revise_history'), revision: historyRevision, acknowledgements })
    .strict(),
  z.object({ type: z.literal('mark_ready'), evidence: bounded(LIMITS.evidence) }).strict(),
  z.object({ type: z.literal('dispute_readiness'), note }).strict(),
  z.object({ type: z.literal('set_check_in'), checkIn: zonedDateTime.nullable() }).strict(),
  z
    .object({
      type: z.literal('propose_amendment'),
      terms: agreementFields.terms,
      timing: decisionTiming,
      cutoff: zonedDateTime.optional(),
      decisionMethod: z.enum(['mutual', 'judge', 'chatgpt']).optional(),
      judgeId: memberId.optional(),
      note,
    })
    .strict(),
  z.object({ type: z.literal('confirm_amendment') }).strict(),
  z.object({ type: z.literal('reject_amendment'), note }).strict(),
  z.object({ type: z.literal('propose_void'), note }).strict(),
  z.object({ type: z.literal('confirm_void') }).strict(),
  z.object({ type: z.literal('reject_void'), note }).strict(),
  z.object({ type: z.literal('accept') }).strict(),
  z.object({ type: z.literal('decline'), note }).strict(),
  z.object({ type: z.literal('withdraw'), note }).strict(),
  z.object({ type: z.literal('withdraw_proposal'), note }).strict(),
  z.object({ type: z.literal('decline_judging'), note }).strict(),
  z
    .object({
      type: z.literal('propose_result'),
      winnerId: z.string().min(1).max(100).nullable(),
      note,
    })
    .strict(),
  z
    .object({
      type: z.literal('adjudicate'),
      winnerId: z.string().min(1).max(100).nullable(),
      note: bounded(LIMITS.response),
      sourceUrl: chatGptShareUrl.optional(),
    })
    .strict(),
  z.object({ type: z.literal('propose_prompt'), text: bounded(LIMITS.prompt) }).strict(),
  z.object({ type: z.literal('approve_prompt') }).strict(),
  z.object({ type: z.literal('confirm_result') }).strict(),
  z.object({ type: z.literal('dispute_result'), note }).strict(),
  z.object({ type: z.literal('propose_settlement'), method: z.literal('roll'), note }).strict(),
  z.object({ type: z.literal('confirm_settlement') }).strict(),
  z.object({ type: z.literal('dispute_settlement'), note }).strict(),
]);

export const newBetSchema = z
  .object({
    ...agreementFields,
    opponentId: memberId,
    decisionMethod: z.enum(['mutual', 'judge', 'chatgpt']).optional(),
    judgeId: memberId.optional(),
    history: historicalInput.optional(),
    acknowledgements: acknowledgements.optional(),
  })
  .strict();

/** The name an invitation is for: the one the new member will appear under in the ledger. */
export const inviteSchema = z
  .object({
    name: z
      .string()
      .transform(normalizeMemberName)
      .pipe(
        z
          .string()
          .min(LIMITS.memberName.min, MEMBER_NAME_BLANK)
          .max(LIMITS.memberName.max, MEMBER_NAME_TOO_LONG),
      ),
  })
  .strict();

/** Members choose their profile name under the same rules used for invitations. */
export const profileSchema = inviteSchema;

export const restaurantSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    address: z.string().trim().max(240).default(''),
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional(),
  })
  .strict()
  .refine((value) => (value.lat === undefined) === (value.lng === undefined), {
    path: ['lat'],
    message: 'Give both latitude and longitude, or neither.',
  });

const visitDateFields = {
  visitDate: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/),
  visitDatePrecision: z.enum(['day', 'month', 'year']),
};
const checkVisitDate = (
  value: Parameters<typeof visitDateProblem>[0],
  context: z.RefinementCtx,
) => {
  const message = visitDateProblem(value);
  if (message) context.addIssue({ code: 'custom', path: ['visitDate'], message });
};
/** One visit date and its precision, checked the same way on the web, over MCP and in the demo. */
export const visitDateSchema = z.object(visitDateFields).strict().superRefine(checkVisitDate);

/**
 * A price report (`report`, which may name a new restaurant inline so both are written together)
 * and a correction of one (`observation`, which keeps a restaurant id). The ledger's ids are
 * UUIDs; the demo's sample records use readable ids under the same rules.
 */
function priceSchemas(id: z.ZodString) {
  const fields = {
    itemName: z.string().trim().min(1).max(160),
    priceCents: z.number().int().min(1).max(100000),
    ...visitDateFields,
    note: z.string().trim().max(500).optional(),
  };
  /** Keep a price the ledger asked about as unusual (outside $8 to $90, or a likely slip). */
  const confirmUnusualPrice = z.boolean().optional();
  /** Record a second report of the same visit at a different price on purpose. */
  const confirmSeparateReport = z.boolean().optional();
  const observation = z
    .object({
      restaurantId: id,
      ...fields,
      /** Why the member is correcting the report, shown with the correction when given. */
      correctionReason: z
        .string()
        .trim()
        .max(500)
        .optional()
        .transform((value) => value || undefined),
      /** Move the report onto a visit already reported at another price, as a separate purchase. */
      confirmSeparateReport,
      confirmUnusualPrice,
    })
    .strict()
    .superRefine(checkVisitDate);
  const report = z
    .object({
      restaurantId: id.optional(),
      restaurant: restaurantSchema.optional(),
      ...fields,
      confirmSeparateReport,
      confirmUnusualPrice,
    })
    .strict()
    .superRefine((value, context) => {
      if (!value.restaurantId === !value.restaurant)
        context.addIssue({
          code: 'custom',
          path: ['restaurantId'],
          message: 'Choose a restaurant from the ledger, or name a new one, but not both.',
        });
      checkVisitDate(value, context);
    });
  return { observation, report };
}
const ledgerPrices = priceSchemas(z.string().uuid());
const demoPrices = priceSchemas(z.string().min(1).max(100));
export const priceObservationSchema = ledgerPrices.observation;
export const priceReportSchema = ledgerPrices.report;
export const demoPriceObservationSchema = demoPrices.observation;
export const demoPriceReportSchema = demoPrices.report;
/** Withdrawing one's own price report: it stays on record, with this reason. */
export const priceWithdrawalSchema = z
  .object({ reason: z.string().trim().min(1, 'Say why you are withdrawing this report.').max(500) })
  .strict();

export const debtOffsetSchema = z
  .object({
    counterpartyId: memberId,
    rolls: z.number().int().positive(),
    allocations: z
      .array(
        z
          .object({
            betId: memberId,
            version: z.number().int().positive(),
            rolls: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .min(2)
      .max(200),
  })
  .strict();
