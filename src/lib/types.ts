export interface Member {
  id: string;
  name: string;
  email?: string;
  initials: string;
  color: string;
}
/** An invitation its maker can still revoke. The link itself is not kept, so it is never listed. */
export interface OpenInvite {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
}
export interface Place {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}
export type PriceDatePrecision = 'day' | 'month' | 'year';
export interface Restaurant {
  id: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}
export interface PriceObservation {
  id: string;
  restaurantId: string;
  itemName: string;
  priceCents: number;
  currency: 'USD';
  visitDate: string;
  visitDatePrecision: PriceDatePrecision;
  reporterId: string;
  reportedAt: string;
  note?: string;
  correctedFromId?: string;
  correctedAt?: string;
  /** Why the member corrected the report this one replaced, when they said. */
  correctionReason?: string;
  /** Withdrawn by its reporter: kept on record, out of every price figure. */
  withdrawnAt?: string;
  withdrawnReason?: string;
  /** Where the report was entered, stamped by the ledger: the website, or an AI connection. */
  entrySource?: PriceEntrySource;
}
export type PriceEntrySource = 'web' | 'mcp';
export interface PriceCorrectionResult {
  observation: PriceObservation;
  corrected: PriceObservation;
}
export interface PriceWithdrawalResult {
  observation: PriceObservation;
}
/** What a member enters for one price; the ledger stamps the id, reporter, time and currency. */
export type PriceInput = Omit<
  PriceObservation,
  | 'id'
  | 'reporterId'
  | 'reportedAt'
  | 'currency'
  | 'correctionReason'
  | 'withdrawnAt'
  | 'withdrawnReason'
  | 'entrySource'
>;
/** A price unusual enough to ask about, and the price it most likely meant. */
export interface PriceWarning {
  code: 'below-usual' | 'above-usual' | 'ten-times-last' | 'tenth-of-last';
  message: string;
  suggestedCents?: number;
}
/** A correction of one of the member's own reports, with an optional reason. */
export interface PriceCorrectionInput extends PriceInput {
  correctionReason?: string;
  /** The member confirmed the visit this moves the report to was a separate purchase. */
  confirmSeparateReport?: boolean;
  /** The member saw the unusual-price warning and kept the price. */
  confirmUnusualPrice?: boolean;
}
/** A new price report: at a restaurant on the record, or at a new one named in the same report. */
export interface PriceReportInput extends Omit<PriceInput, 'restaurantId'> {
  restaurantId?: string;
  restaurant?: Omit<Restaurant, 'id'>;
  /** The member confirmed a second report of the same visit at another price is a separate purchase. */
  confirmSeparateReport?: boolean;
  /** The member saw the unusual-price warning and kept the price. */
  confirmUnusualPrice?: boolean;
}
/** How a named restaurant was found: as typed, ignoring case and spacing, or newly added. */
export type RestaurantMatch = 'exact' | 'normalised' | 'created';
export interface PriceReportResult {
  observation: PriceObservation;
  restaurant: Restaurant;
  /** Set when the report named its restaurant. */
  matched?: RestaurantMatch;
  /** The report already on record for this visit at this price; nothing new was written. */
  duplicateOf?: string;
}
export type BetStatus =
  'pending' | 'active' | 'confirming' | 'owed' | 'settling' | 'settled' | 'voided' | 'declined';
export type Category = 'Work' | 'Sports' | 'Life' | 'Wild card';
export type DecisionMethod = 'mutual' | 'judge' | 'chatgpt';
export type BetEntrySource = 'browser' | 'cli' | 'mcp';
export type HistoricalDate =
  { precision: 'day' | 'month' | 'year'; value: string } | { precision: 'unknown' };
export interface HistoryAcknowledgements {
  terms: boolean;
  result: boolean;
  delivery: boolean;
}
export interface HistoricalInput {
  stage: 'active' | 'owed' | 'settled' | 'voided';
  originalDate: HistoricalDate;
  result?: { winnerId: string | null; date: HistoricalDate; note: string };
  delivery?: { date: HistoricalDate; note: string };
  previousAdjudication?: { method: 'judge' | 'chatgpt'; note: string; sourceUrl?: string };
}
export interface ZonedDateTime {
  at: string;
  timezone: string;
}
export type DecisionTiming =
  | ({ kind: 'date'; source?: string; checkIn?: ZonedDateTime } & ZonedDateTime)
  | { kind: 'event' | 'evidence'; description: string; source?: string; checkIn?: ZonedDateTime };
export type DecisionCutoff = ZonedDateTime;
export interface HistoryApproval {
  actorId: string;
  at: string;
  acknowledgements: HistoryAcknowledgements;
}
export interface HistoryProposal extends HistoricalInput {
  proposedBy: string;
  revision: number;
  approvals: HistoryApproval[];
  correction?: { requestedBy: string; at: string; note: string };
  confirmedAt?: string;
}
export interface HistoryRevision {
  title: string;
  terms: string;
  category: Category;
  creatorSide: string;
  opponentSide: string;
  stake: number;
  deadline?: string;
  location?: Place;
  history: HistoricalInput;
  timing?: DecisionTiming;
  cutoff?: DecisionCutoff;
}
export interface AgreementAmendment {
  terms: string;
  timing: DecisionTiming;
  cutoff?: DecisionCutoff;
  /** A proposed change of decision method or judge; absent keeps the agreed method. */
  decisionMethod?: DecisionMethod;
  judgeId?: string;
  note: string;
  proposedBy: string;
  approvals: string[];
  at: string;
}
export interface VoidProposal {
  note: string;
  proposedBy: string;
  approvals: string[];
  at: string;
}
export interface PromptAgreement {
  text: string;
  proposedBy: string;
  approvals: string[];
  at: string;
  version: number;
}
export interface Adjudication {
  method: 'judge' | 'chatgpt';
  winnerId: string | null;
  reasoning: string;
  recordedBy: string;
  at: string;
  sourceUrl?: string;
  promptVersion?: number;
}
export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  type: string;
  detail: string;
  historySnapshot?: HistoryRevision & { proposal: HistoryProposal };
  amendmentSnapshot?: {
    terms: string;
    deadline: string;
    timing?: DecisionTiming;
    cutoff?: DecisionCutoff;
    decisionMethod?: DecisionMethod;
    judgeId?: string;
    proposal: AgreementAmendment;
  };
}
export interface Resolution {
  winnerId: string | null;
  note: string;
  proposedBy: string;
  approvals: string[];
}
export interface Settlement {
  method: 'roll';
  note: string;
  proposedBy: string;
  approvals: string[];
  /** Rolls the report settles: every roll still owed when it was made. */
  rolls?: number;
}
export interface DebtOffsetPreview {
  counterpartyId: string;
  /** Rolls canceled in each direction, not the sum of both directions. */
  rolls: number;
  allocations: { betId: string; version: number; rolls: number }[];
}
export interface DebtOffset extends DebtOffsetPreview {
  id: string;
  actorId: string;
  at: string;
  references: Record<string, string>;
}
export interface Bet {
  id: string;
  reference: string;
  /** Assigned by the creation entry point. Absent on records predating tracking. */
  readonly entrySource?: BetEntrySource;
  readonly entrySourceInference?: {
    basis: 'before_cli_release';
    cutoffAt: string;
    evidenceUrl: string;
    inferredAt: string;
  };
  readonly entrySourceReport?: {
    basis: 'user_report';
    note: string;
    reportedAt: string;
  };
  title: string;
  terms: string;
  category: Category;
  creatorId: string;
  opponentId: string;
  creatorSide: string;
  opponentSide: string;
  stake: number;
  deadline: string;
  location?: Place;
  decisionMethod?: DecisionMethod;
  judgeId?: string;
  /** The named judge stepped down; recommendations wait for an amendment naming a new judge or method. */
  judgeDeclined?: { at: string; note: string };
  adjudication?: Adjudication;
  promptAgreement?: PromptAgreement;
  promptVersion?: number;
  history?: HistoryProposal;
  timing?: DecisionTiming;
  cutoff?: DecisionCutoff;
  readiness?: { markedBy: string; at: string; evidence: string };
  checkIns?: Record<string, ZonedDateTime | null>;
  amendment?: AgreementAmendment;
  voidProposal?: VoidProposal;
  status: BetStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  agreementApprovals: string[];
  resolution?: Resolution;
  settlement?: Settlement;
  offsets?: DebtOffset[];
  events: AuditEvent[];
}
export interface NewBet {
  title: string;
  terms: string;
  category: Category;
  opponentId: string;
  creatorSide: string;
  opponentSide: string;
  stake: number;
  deadline?: string;
  location?: Place;
  decisionMethod?: DecisionMethod;
  judgeId?: string;
  history?: HistoricalInput;
  acknowledgements?: HistoryAcknowledgements;
  timing?: DecisionTiming;
  cutoff?: DecisionCutoff;
}
export type BetAction =
  | { type: 'confirm_history'; acknowledgements: HistoryAcknowledgements }
  | { type: 'request_history_correction'; note: string }
  | { type: 'revise_history'; revision: HistoryRevision; acknowledgements: HistoryAcknowledgements }
  | { type: 'mark_ready'; evidence: string }
  /** The other bettor disagrees with the readiness evidence, which takes it off the bet. */
  | { type: 'dispute_readiness'; note: string }
  | { type: 'set_check_in'; checkIn: ZonedDateTime | null }
  | {
      type: 'propose_amendment';
      terms: string;
      timing: DecisionTiming;
      cutoff?: DecisionCutoff;
      decisionMethod?: DecisionMethod;
      judgeId?: string;
      note: string;
    }
  | { type: 'confirm_amendment' }
  | { type: 'reject_amendment'; note: string }
  | { type: 'propose_void'; note: string }
  | { type: 'confirm_void' }
  | { type: 'reject_void'; note: string }
  | { type: 'accept' }
  | { type: 'decline'; note: string }
  /** The sole approver of a pending proposal takes it back. */
  | { type: 'withdraw'; note: string }
  /** The proposer removes their own unanswered amendment, call-off, result, delivery report or readiness evidence. */
  | { type: 'withdraw_proposal'; note: string }
  /** The named judge steps down before any recommendation. */
  | { type: 'decline_judging'; note: string }
  | { type: 'propose_result'; winnerId: string | null; note: string }
  | { type: 'adjudicate'; winnerId: string | null; note: string; sourceUrl?: string }
  | { type: 'propose_prompt'; text: string }
  | { type: 'approve_prompt' }
  | { type: 'confirm_result' }
  | { type: 'dispute_result'; note: string }
  | { type: 'propose_settlement'; method: 'roll'; note: string }
  | { type: 'confirm_settlement' }
  | { type: 'dispute_settlement'; note: string };
export interface LedgerState {
  members: Member[];
  bets: Bet[];
  places: Place[];
  restaurants?: Restaurant[];
  priceObservations?: PriceObservation[];
  groupName: string;
}
export interface MemberStats {
  memberId: string;
  won: number;
  lost: number;
  winRate: number;
  rollsWon: number;
  rollsLost: number;
  net: number;
  owedToYou: number;
  youOwe: number;
  settled: number;
  active: number;
}
export interface Balance {
  fromId: string;
  toId: string;
  rolls: number;
}
