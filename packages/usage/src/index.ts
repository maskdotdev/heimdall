import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { BillingProvider, ProviderSubscription } from "@repo/billing";
import {
  type BillingAccount,
  BillingAccountSchema,
  type BillingMeterEvent,
  BillingMeterEventSchema,
  type BillingPlan,
  BillingPlanSchema,
  type BillingPlanVersion,
  BillingPlanVersionSchema,
  type CreditGrant,
  CreditGrantSchema,
  type Entitlement,
  type EntitlementDecision,
  EntitlementDecisionSchema,
  EntitlementSchema,
  type Invoice,
  InvoiceSchema,
  type PlanSnapshot,
  PlanSnapshotSchema,
  parseWithSchema,
  type QuotaCounter,
  QuotaCounterSchema,
  type QuotaReservation,
  QuotaReservationSchema,
  type Subscription,
  type SubscriptionItem,
  SubscriptionItemSchema,
  SubscriptionSchema,
  type UsageEvent,
  UsageEventSchema,
  type UsageEventType,
} from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import {
  billingAccounts,
  billingMeterEvents,
  billingPlans,
  billingPlanVersions,
  creditGrants,
  entitlements,
  invoices,
  quotaCounters,
  quotaReservations,
  subscriptionItems,
  subscriptions,
  usageEvents,
} from "@repo/db";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

/** Metadata accepted when recording usage events. */
export type UsageMetadata = Readonly<Record<string, unknown>>;

/** Input used to create one immutable usage ledger event. */
export type RecordUsageEventInput = {
  /** Optional explicit event ID for migrations and replay tools. */
  readonly usageEventId?: string;
  /** Stable key used to derive the event ID when usageEventId is omitted. */
  readonly idempotencyKey?: string;
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Optional repository that caused the usage. */
  readonly repoId?: string;
  /** Optional review run that caused the usage. */
  readonly reviewRunId?: string;
  /** Product usage event type. */
  readonly eventType: UsageEventType;
  /** Signed integer quantity. Negative values represent correction events. */
  readonly quantity: number;
  /** Unit for the quantity, such as token, file, chunk, byte, or job. */
  readonly unit: string;
  /** Signed internal cost estimate in micro-USD. */
  readonly costMicros?: number;
  /** Event occurrence time. Defaults to the current time. */
  readonly occurredAt?: string;
  /** Optional non-secret metadata for attribution and support. */
  readonly metadata?: UsageMetadata;
};

/** Result returned when an event is recorded through a ledger store. */
export type UsageLedgerRecordResult = {
  /** Persisted usage event. */
  readonly event: UsageEvent;
  /** Whether this call inserted a new event. */
  readonly recorded: boolean;
};

/** Storage boundary for the append-only usage ledger. */
export type UsageLedgerStore = {
  /** Inserts the event if its ID has not already been recorded. */
  readonly insertIfAbsent: (event: UsageEvent) => Promise<UsageLedgerRecordResult>;
};

/** Input used to summarize usage events over a period. */
export type SummarizeUsageEventsInput = {
  /** Events to summarize. */
  readonly events: readonly UsageEvent[];
  /** Inclusive period start. */
  readonly periodStart?: string;
  /** Exclusive period end. */
  readonly periodEnd?: string;
  /** Whether to keep repository IDs in the rollup key. */
  readonly includeRepo?: boolean;
  /** Whether to keep review run IDs in the rollup key. */
  readonly includeReviewRun?: boolean;
};

/** Aggregated usage for one org, event type, unit, and optional source dimensions. */
export type UsageRollup = {
  /** Organization that owns the rollup. */
  readonly orgId: string;
  /** Optional repository dimension. */
  readonly repoId?: string;
  /** Optional review run dimension. */
  readonly reviewRunId?: string;
  /** Event type summarized by this row. */
  readonly eventType: UsageEventType;
  /** Unit summarized by this row. */
  readonly unit: string;
  /** Start of the summarized period. */
  readonly periodStart?: string;
  /** End of the summarized period. */
  readonly periodEnd?: string;
  /** Number of events included in the rollup. */
  readonly eventCount: number;
  /** Signed quantity sum. */
  readonly quantity: number;
  /** Signed internal cost estimate sum in micro-USD. */
  readonly costMicros: number;
};

/** Input for a quota decision based on current usage and one requested increment. */
export type UsageQuotaDecisionInput = {
  /** Stable quota key, such as monthly_review_credits. */
  readonly quotaKey: string;
  /** Billing or quota period key, such as 2026-05. */
  readonly periodKey: string;
  /** Current consumed quantity for the quota period. */
  readonly used: number;
  /** Requested additional quantity. */
  readonly requested: number;
  /** Hard quota limit. */
  readonly limit: number;
  /** Utilization threshold that returns a warning before denial. */
  readonly warnAtPercent?: number;
};

/** Quota decision for product code that wants soft warnings before hard denial. */
export type UsageQuotaDecision = {
  /** Stable quota key that was evaluated. */
  readonly quotaKey: string;
  /** Billing or quota period key that was evaluated. */
  readonly periodKey: string;
  /** Whether the requested usage may proceed. */
  readonly allowed: boolean;
  /** Human-readable decision status for support surfaces. */
  readonly status: "allowed" | "warn" | "denied";
  /** Stable reason code for logs and tests. */
  readonly reasonCode: "under_limit" | "warning_threshold_reached" | "quota_exceeded";
  /** Current consumed quantity. */
  readonly used: number;
  /** Requested additional quantity. */
  readonly requested: number;
  /** Projected usage after the requested increment. */
  readonly projected: number;
  /** Hard quota limit. */
  readonly limit: number;
  /** Remaining quantity after the projected increment. */
  readonly remaining: number;
  /** Projected usage divided by the limit. */
  readonly utilization: number;
};

/** Quota period boundaries used by counter rows. */
export type QuotaPeriod = {
  /** Stable billing period key, such as 2026-05. */
  readonly periodKey: string;
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
};

/** Input used to inspect quota availability. */
export type CheckQuotaInput = {
  /** Organization that owns the quota. */
  readonly orgId: string;
  /** Stable quota key, such as monthly_review_credits. */
  readonly quotaKey: string;
  /** Billing period key. */
  readonly periodKey: string;
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
  /** Requested increment. */
  readonly requested: number;
  /** Hard limit for this period. */
  readonly limit: number;
  /** Source of the counter limit. */
  readonly source?: string;
  /** Warning threshold. */
  readonly warnAtPercent?: number;
  /** Timestamp used when creating missing counters. */
  readonly now?: string;
};

/** Input used to reserve quota before expensive work starts. */
export type ReserveQuotaInput = CheckQuotaInput & {
  /** Source entity type, such as review_run. */
  readonly sourceType: string;
  /** Source entity ID, such as a review run ID. */
  readonly sourceId: string;
  /** Reservation expiration timestamp. Defaults to six hours after now. */
  readonly expiresAt?: string;
};

/** Result from a quota reserve attempt. */
export type ReserveQuotaResult = {
  /** Decision for the requested reservation. */
  readonly decision: UsageQuotaDecision;
  /** Counter row that was evaluated. */
  readonly counter: QuotaCounter;
  /** Reservation row when the request was allowed. */
  readonly reservation?: QuotaReservation;
  /** Whether this call created or reactivated a reservation. */
  readonly reserved: boolean;
};

/** Input used to consume a successful reservation. */
export type ConsumeQuotaReservationInput = {
  /** Reservation row ID. */
  readonly quotaReservationId: string;
  /** Timestamp for the consume transition. */
  readonly now?: string;
};

/** Input used to release an unused reservation. */
export type ReleaseQuotaReservationInput = {
  /** Reservation row ID. */
  readonly quotaReservationId: string;
  /** Timestamp for the release transition. */
  readonly now?: string;
};

/** Storage boundary for quota counters and reservations. */
export type QuotaStore = {
  /** Gets or creates one counter row. */
  readonly getOrCreateCounter: (input: CheckQuotaInput) => Promise<QuotaCounter>;
  /** Gets a reservation by ID. */
  readonly getReservation: (quotaReservationId: string) => Promise<QuotaReservation | undefined>;
  /** Creates or reactivates a reservation row. */
  readonly reserve: (
    input: ReserveQuotaInput & {
      readonly quotaCounterId: string;
      readonly quotaReservationId: string;
    },
  ) => Promise<ReserveQuotaResult>;
  /** Consumes a reservation row idempotently. */
  readonly consumeReservation: (input: ConsumeQuotaReservationInput) => Promise<QuotaReservation>;
  /** Releases a reservation row idempotently. */
  readonly releaseReservation: (input: ReleaseQuotaReservationInput) => Promise<QuotaReservation>;
};

/** Quota service used by product code before expensive work starts. */
export type QuotaService = {
  /** Checks current quota availability without reserving. */
  readonly check: (input: CheckQuotaInput) => Promise<UsageQuotaDecision>;
  /** Reserves quota for a source entity idempotently. */
  readonly reserve: (input: ReserveQuotaInput) => Promise<ReserveQuotaResult>;
  /** Consumes a successful reservation idempotently. */
  readonly consumeReservation: (input: ConsumeQuotaReservationInput) => Promise<QuotaReservation>;
  /** Releases an unused reservation idempotently. */
  readonly releaseReservation: (input: ReleaseQuotaReservationInput) => Promise<QuotaReservation>;
};

/** Monthly review credit quota key used by review orchestration. */
export const MONTHLY_REVIEW_CREDITS_QUOTA_KEY = "monthly_review_credits";

/** Versioned token price data used to estimate internal LLM call cost. */
export type LlmTokenRateCard = {
  /** Stable rate-card version ID used in ledger metadata. */
  readonly rateCardId: string;
  /** Provider that owns the model. */
  readonly provider: string;
  /** Model name the rate card applies to. */
  readonly model: string;
  /** Input-token cost in micro-USD per 1,000 tokens. */
  readonly inputTokenCostMicrosPer1k: number;
  /** Cached input-token cost in micro-USD per 1,000 tokens when distinct. */
  readonly cachedInputTokenCostMicrosPer1k?: number;
  /** Output-token cost in micro-USD per 1,000 tokens. */
  readonly outputTokenCostMicrosPer1k: number;
  /** ISO timestamp when this rate card became effective. */
  readonly effectiveAt: string;
  /** Human-readable source for the rate card. */
  readonly source: "manual" | "provider_api" | "imported_invoice" | "static";
};

/** Zero-cost rate card used by deterministic local gateways and tests. */
export const ZERO_COST_LLM_RATE_CARD: LlmTokenRateCard = {
  rateCardId: "llm_rate_static_zero_v1",
  provider: "static",
  model: "static",
  inputTokenCostMicrosPer1k: 0,
  outputTokenCostMicrosPer1k: 0,
  effectiveAt: "1970-01-01T00:00:00.000Z",
  source: "static",
};

/** Input used to estimate LLM token usage and cost for one provider call. */
export type EstimateLlmTokenUsageInput = {
  /** Optional system prompt included in the model input. */
  readonly system?: string;
  /** User prompt included in the model input. */
  readonly prompt: string;
  /** Structured output or raw response text returned by the model. */
  readonly output: unknown;
  /** Cached input token count reported or estimated by the provider. */
  readonly cachedInputTokens?: number;
  /** Rate card used to estimate cost. Defaults to a zero-cost static card. */
  readonly rateCard?: LlmTokenRateCard;
};

/** Deterministic LLM token and cost estimate. */
export type LlmTokenUsageEstimate = {
  /** Provider from the applied rate card. */
  readonly provider: string;
  /** Model from the applied rate card. */
  readonly model: string;
  /** Rate-card version used for cost estimation. */
  readonly rateCardId: string;
  /** Estimated input tokens. */
  readonly inputTokens: number;
  /** Cached input tokens included in inputTokens. */
  readonly cachedInputTokens: number;
  /** Estimated output tokens. */
  readonly outputTokens: number;
  /** Estimated total tokens. */
  readonly totalTokens: number;
  /** Estimated internal cost in micro-USD. */
  readonly costMicros: number;
};

/** One billing plan with the version that should be evaluated. */
export type BillingPlanCatalogEntry = {
  /** Plan catalog metadata. */
  readonly plan: BillingPlan;
  /** Versioned plan configuration. */
  readonly version: BillingPlanVersion;
};

/** Store used by entitlement services to read local billing state. */
export type EntitlementStore = {
  /** Gets an organization billing account when one exists. */
  readonly getBillingAccount: (orgId: string) => Promise<BillingAccount | undefined>;
  /** Lists plan catalog entries available to the compiler. */
  readonly getPlanCatalog: () => Promise<readonly BillingPlanCatalogEntry[]>;
  /** Lists entitlement rows for an organization. */
  readonly getOrgEntitlements: (orgId: string) => Promise<readonly Entitlement[]>;
};

/** Input used to compile a stable plan snapshot. */
export type CompilePlanSnapshotInput = {
  /** Organization to compile a plan for. */
  readonly orgId: string;
  /** Optional billing account override. */
  readonly billingAccount?: BillingAccount;
  /** Optional plan key override used when no account row exists. */
  readonly planKey?: string;
  /** Optional plan version override. */
  readonly planVersionId?: string;
  /** Optional catalog override. Seeded plans are appended as fallback entries. */
  readonly catalog?: readonly BillingPlanCatalogEntry[];
  /** Optional entitlements applied after plan defaults. */
  readonly entitlements?: readonly Entitlement[];
  /** Timestamp used for active-window checks. */
  readonly now?: string;
};

/** Input used to check one feature against a plan snapshot. */
export type CheckPlanFeatureInput = {
  /** Plan snapshot to check. */
  readonly snapshot: PlanSnapshot;
  /** Feature key or limit key to evaluate. */
  readonly featureKey: string;
  /** Optional active entitlements used to preserve override source in the decision. */
  readonly entitlements?: readonly Entitlement[];
  /** Timestamp used for entitlement active-window checks. */
  readonly now?: string;
};

/** Input used by the async entitlement service to check a feature. */
export type CheckFeatureInput = {
  /** Organization to check. */
  readonly orgId: string;
  /** Feature key or limit key to evaluate. */
  readonly featureKey: string;
  /** Optional precompiled snapshot. */
  readonly snapshot?: PlanSnapshot;
  /** Timestamp used for plan and entitlement active-window checks. */
  readonly now?: string;
};

/** Service boundary for provider-free entitlement decisions. */
export type EntitlementService = {
  /** Gets active and historical entitlements for an organization. */
  readonly getOrgEntitlements: (orgId: string) => Promise<readonly Entitlement[]>;
  /** Compiles a stable plan snapshot for one organization. */
  readonly compilePlanSnapshot: (input: CompilePlanSnapshotInput) => Promise<PlanSnapshot>;
  /** Checks one feature without calling an external billing provider. */
  readonly checkFeature: (input: CheckFeatureInput) => Promise<EntitlementDecision>;
};

/** Input used when a missing organization billing account should be created locally. */
export type GetOrCreateBillingAccountInput = {
  /** Organization that owns the billing account. */
  readonly orgId: string;
  /** Optional default plan key when the account does not exist. */
  readonly planKey?: string;
  /** Optional default plan version when the account does not exist. */
  readonly planVersionId?: string;
  /** Timestamp used for deterministic account creation. */
  readonly now?: string;
};

/** Store used by billing summary services to read local product billing state. */
export type BillingStore = EntitlementStore & {
  /** Gets an existing account or creates the local default account for the organization. */
  readonly getOrCreateBillingAccount: (
    input: GetOrCreateBillingAccountInput,
  ) => Promise<BillingAccount>;
  /** Gets the current subscription mirror for a billing account when one exists. */
  readonly getCurrentSubscription: (billingAccountId: string) => Promise<Subscription | undefined>;
  /** Lists subscription item mirrors for one subscription. */
  readonly listSubscriptionItems: (subscriptionId: string) => Promise<readonly SubscriptionItem[]>;
  /** Lists active and historical credit grants for one organization. */
  readonly listCreditGrants: (orgId: string) => Promise<readonly CreditGrant[]>;
  /** Lists invoice mirrors for one billing account. */
  readonly listInvoices: (billingAccountId: string) => Promise<readonly Invoice[]>;
};

/** Input used to load a complete local billing account summary. */
export type GetBillingSummaryInput = {
  /** Organization to inspect. */
  readonly orgId: string;
  /** Timestamp used for plan and entitlement compilation. */
  readonly now?: string;
};

/** Local billing account state returned to support and customer surfaces. */
export type BillingSummary = {
  /** Organization that owns the summary. */
  readonly orgId: string;
  /** Local billing account row. */
  readonly billingAccount: BillingAccount;
  /** Stable provider-free plan snapshot. */
  readonly planSnapshot: PlanSnapshot;
  /** Current subscription mirror when present. */
  readonly subscription?: Subscription;
  /** Current subscription item mirrors when a subscription exists. */
  readonly subscriptionItems: readonly SubscriptionItem[];
  /** Manual or promotional credit grants for the organization. */
  readonly creditGrants: readonly CreditGrant[];
  /** Provider invoice mirrors for the account. */
  readonly invoices: readonly Invoice[];
  /** Entitlement rows available to the plan compiler. */
  readonly entitlements: readonly Entitlement[];
  /** Timestamp when this summary was compiled. */
  readonly checkedAt: string;
};

/** Billing or usage period summarized for customer and support surfaces. */
export type UsagePeriodSummaryPeriod = {
  /** Stable UTC month key, such as 2026-05. */
  readonly periodKey: string;
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
};

/** Review credit usage compared with plan limits and active grants. */
export type UsagePeriodReviewCreditSummary = {
  /** Review credits consumed in the period. */
  readonly used: number;
  /** Review credits included by the compiled plan snapshot. */
  readonly included: number;
  /** Active granted review credits that can extend the plan allowance. */
  readonly granted: number;
  /** Total customer-facing credit allowance for the period. */
  readonly limit: number;
  /** Credits remaining before overage. */
  readonly remaining: number;
  /** Credits beyond the customer-facing allowance. */
  readonly overage: number;
  /** Used credits divided by the total allowance. */
  readonly utilization: number;
  /** Customer-facing quota state for the period. */
  readonly status: "ok" | "warning" | "over_limit";
};

/** Internal cost summary that support/admin callers can opt into. */
export type UsagePeriodCostSummary = {
  /** Estimated internal cost for included usage in micro-USD. */
  readonly estimatedMicros: number;
};

/** Repository-level customer-safe usage summary. */
export type UsagePeriodRepoSummary = {
  /** Repository that caused the usage. */
  readonly repoId: string;
  /** Completed review usage quantity for this repository. */
  readonly reviewRuns: number;
  /** Review credits consumed by this repository. */
  readonly reviewCredits: number;
  /** Number of usage ledger events included for this repository. */
  readonly eventCount: number;
  /** Estimated internal cost in micro-USD when requested by an internal caller. */
  readonly costMicros?: number;
};

/** Category-level usage summary for dashboards and exports. */
export type UsagePeriodCategorySummary = {
  /** Product category derived from the stable usage event type. */
  readonly category: string;
  /** Usage unit summarized by this row. */
  readonly unit: string;
  /** Signed quantity for the category and unit. */
  readonly quantity: number;
  /** Number of usage ledger events included in the row. */
  readonly eventCount: number;
  /** Estimated internal cost in micro-USD when requested by an internal caller. */
  readonly costMicros?: number;
};

/** Provider meter event state that explains what will be or was sent externally. */
export type UsagePeriodMeterSummary = {
  /** Internal meter key. */
  readonly meterKey: string;
  /** Billing provider that receives the meter event. */
  readonly provider: string;
  /** Quantity planned or sent to the provider. */
  readonly quantity: number;
  /** Meter send status. */
  readonly status: BillingMeterEvent["status"];
  /** Number of source ledger events attached to the meter row. */
  readonly sourceUsageEventCount: number;
  /** Provider meter event ID when the row has been accepted. */
  readonly providerMeterEventId?: string;
  /** Timestamp when the provider accepted the row. */
  readonly sentAt?: string;
  /** Safe last provider error code when a send failed. */
  readonly lastErrorCode?: string;
  /** Safe last provider error message when a send failed. */
  readonly lastErrorMessage?: string;
};

/** Customer-safe invoice mirror summary for one usage period. */
export type UsagePeriodInvoiceSummary = {
  /** Local invoice ID. */
  readonly invoiceId: string;
  /** Billing provider that owns the invoice. */
  readonly provider: string;
  /** Provider invoice ID. */
  readonly providerInvoiceId: string;
  /** Mirrored provider invoice status. */
  readonly status: Invoice["status"];
  /** Three-letter invoice currency. */
  readonly currency: string;
  /** Invoice amount due in micro currency units. */
  readonly amountDueMicros: number;
  /** Invoice amount paid in micro currency units. */
  readonly amountPaidMicros: number;
  /** Invoice amount remaining in micro currency units. */
  readonly amountRemainingMicros: number;
  /** Hosted provider invoice URL when available. */
  readonly hostedInvoiceUrl?: string;
  /** Provider PDF invoice URL when available. */
  readonly invoicePdfUrl?: string;
};

/** Customer and support usage summary for one billing period. */
export type UsagePeriodSummary = {
  /** Organization that owns the usage period. */
  readonly orgId: string;
  /** Billing period being summarized. */
  readonly period: UsagePeriodSummaryPeriod;
  /** Review credit usage and allowance. */
  readonly reviewCredits: UsagePeriodReviewCreditSummary;
  /** Completed review usage quantity. */
  readonly reviewRuns: number;
  /** Repository breakdown for product dashboards. */
  readonly byRepo: readonly UsagePeriodRepoSummary[];
  /** Category breakdown for product dashboards and exports. */
  readonly byCategory: readonly UsagePeriodCategorySummary[];
  /** Meter rows explaining external billable usage sync. */
  readonly meterEvents: readonly UsagePeriodMeterSummary[];
  /** Invoice mirrors that overlap the period. */
  readonly invoices: readonly UsagePeriodInvoiceSummary[];
  /** Internal cost summary when explicitly requested. */
  readonly cost?: UsagePeriodCostSummary;
};

/** Input used to build a customer-safe usage period summary. */
export type BuildUsagePeriodSummaryInput = {
  /** Organization to summarize. */
  readonly orgId: string;
  /** Usage events available for the period. */
  readonly usageEvents: readonly UsageEvent[];
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
  /** Compiled plan snapshot used to derive included review credits. */
  readonly planSnapshot?: PlanSnapshot;
  /** Explicit included review credits override for imports and tests. */
  readonly includedReviewCredits?: number;
  /** Credit grants that can extend customer-facing review credit allowance. */
  readonly creditGrants?: readonly CreditGrant[];
  /** Meter event rows planned or sent for the period. */
  readonly billingMeterEvents?: readonly BillingMeterEvent[];
  /** Provider invoice mirrors that may overlap the period. */
  readonly invoices?: readonly Invoice[];
  /** Whether to include internal cost fields in the returned summary. */
  readonly includeInternalCost?: boolean;
  /** Warning threshold for review credit utilization. Defaults to 0.8. */
  readonly warnAtPercent?: number;
  /** Timestamp used to decide whether credit grants are active. Defaults to periodEnd. */
  readonly now?: string;
};

/** Service boundary for local billing account inspection. */
export type BillingService = {
  /** Gets account, subscription, credit, invoice, and plan state for one organization. */
  readonly getBillingSummary: (input: GetBillingSummaryInput) => Promise<BillingSummary>;
};

/** Mapping from internal usage events to one external provider meter. */
export type BillingMeterConfig = {
  /** Internal meter key used in local support and debug surfaces. */
  readonly meterKey: string;
  /** Provider event name configured on the billing meter. */
  readonly providerEventName: string;
  /** Usage event type that contributes to this meter. */
  readonly usageEventType: UsageEventType;
  /** Optional unit filter for usage events. */
  readonly unit?: string;
};

/** Default billable usage meters for the current product catalog. */
export const DEFAULT_BILLING_METER_CONFIGS: readonly BillingMeterConfig[] = [
  {
    meterKey: "review_credits",
    providerEventName: "review_credits",
    usageEventType: "review.credit",
    unit: "credit",
  },
];

/** Input used to plan usage-based billing meter events for one period. */
export type PlanBillingMeterEventsInput = {
  /** Inclusive usage period start. */
  readonly periodStart: string;
  /** Exclusive usage period end. */
  readonly periodEnd: string;
  /** Provider that receives meter events. Defaults to stripe. */
  readonly provider?: string;
  /** Meter configuration registry. Defaults to DEFAULT_BILLING_METER_CONFIGS. */
  readonly meterConfigs?: readonly BillingMeterConfig[];
  /** Timestamp used for deterministic planned rows. */
  readonly now?: string;
};

/** Result from planning provider meter events. */
export type PlanBillingMeterEventsResult = {
  /** Planned or updated meter event rows. */
  readonly events: readonly BillingMeterEvent[];
  /** Number of rows returned by the planner. */
  readonly planned: number;
};

/** Input used to send ready or retryable provider meter events. */
export type SendBillingMeterEventsInput = {
  /** Provider-neutral billing adapter used to send meter events. */
  readonly billingProvider: BillingProvider;
  /** Maximum number of events to send in one call. */
  readonly limit?: number;
  /** Timestamp used for deterministic send attempts. */
  readonly now?: string;
};

/** Result from sending provider meter events. */
export type SendBillingMeterEventsResult = {
  /** Meter event rows successfully sent. */
  readonly sent: readonly BillingMeterEvent[];
  /** Meter event rows that failed during this send attempt. */
  readonly failed: readonly BillingMeterEvent[];
};

/** Store used by metered billing services. */
export type BillingMeterEventStore = {
  /** Plans provider meter events for one usage period. */
  readonly plan: (input: PlanBillingMeterEventsInput) => Promise<PlanBillingMeterEventsResult>;
  /** Lists ready or failed meter events that can be sent. */
  readonly listReadyToSend: (limit: number) => Promise<readonly BillingMeterEvent[]>;
  /** Marks one meter event as sent. */
  readonly markSent: (
    event: BillingMeterEvent,
    providerMeterEventId: string,
    timestamp: string,
  ) => Promise<BillingMeterEvent>;
  /** Marks one meter event send attempt as failed. */
  readonly markFailed: (
    event: BillingMeterEvent,
    error: { readonly code?: string; readonly message: string },
    timestamp: string,
  ) => Promise<BillingMeterEvent>;
};

/** Service boundary for usage-based billing meter sync. */
export type BillingMeteringService = {
  /** Plans meter event rows from internal usage events. */
  readonly planMeterEvents: (
    input: PlanBillingMeterEventsInput,
  ) => Promise<PlanBillingMeterEventsResult>;
  /** Sends ready meter event rows through the provider-neutral billing adapter. */
  readonly sendReadyMeterEvents: (
    input: SendBillingMeterEventsInput,
  ) => Promise<SendBillingMeterEventsResult>;
};

/** Input used by reconciliation jobs to refresh provider billing state and local counters. */
export type ReconcileBillingStateInput = {
  /** Database used to read and repair local billing state. */
  readonly db: HeimdallDatabase;
  /** Provider-neutral billing adapter used for provider refreshes and meter sends. */
  readonly billingProvider: BillingProvider;
  /** Billing provider to reconcile. Defaults to stripe. */
  readonly provider?: string;
  /** Optional organization filter. */
  readonly orgId?: string;
  /** Billing period key used for quota and meter repair. Defaults to the current UTC month. */
  readonly periodKey?: string;
  /** Inclusive usage period start. Derived from periodKey when omitted. */
  readonly periodStart?: string;
  /** Exclusive usage period end. Derived from periodKey when omitted. */
  readonly periodEnd?: string;
  /** Maximum rows to inspect per reconciliation source. */
  readonly limit?: number;
  /** Timestamp used for deterministic reconciliation results. */
  readonly now?: string;
};

/** Outcome for one provider subscription refresh attempt. */
export type ProviderSubscriptionReconciliation = {
  /** Organization that owns the billing account. */
  readonly orgId: string;
  /** Billing account that was refreshed or skipped. */
  readonly billingAccountId: string;
  /** Provider subscription ID when available. */
  readonly providerSubscriptionId?: string;
  /** Refresh outcome. */
  readonly status: "refreshed" | "skipped" | "failed";
  /** Failure or skip reason. */
  readonly message?: string;
};

/** Quota counter repair performed from immutable usage ledger totals. */
export type QuotaCounterReconciliation = {
  /** Organization that owns the counter. */
  readonly orgId: string;
  /** Quota counter row ID. */
  readonly quotaCounterId: string;
  /** Billing period key. */
  readonly periodKey: string;
  /** Counter value before repair. */
  readonly previousUsedQuantity: number;
  /** Ledger-derived counter value after repair. */
  readonly repairedUsedQuantity: number;
};

/** Result returned by one billing reconciliation job run. */
export type BillingReconciliationRunResult = {
  /** Reconciliation timestamp. */
  readonly checkedAt: string;
  /** Provider that was reconciled. */
  readonly provider: string;
  /** Billing period key that was reconciled. */
  readonly periodKey: string;
  /** Inclusive usage period start. */
  readonly periodStart: string;
  /** Exclusive usage period end. */
  readonly periodEnd: string;
  /** Provider subscription refresh outcomes. */
  readonly providerState: readonly ProviderSubscriptionReconciliation[];
  /** Quota counter repairs made from usage ledger totals. */
  readonly quotaCounters: readonly QuotaCounterReconciliation[];
  /** Number of meter event rows planned or refreshed. */
  readonly plannedMeterEvents: number;
  /** Number of meter events accepted by the provider. */
  readonly sentMeterEvents: number;
  /** Number of meter events that still failed during this run. */
  readonly failedMeterEvents: number;
};

/** Feature keys that represent numeric or string limits instead of booleans. */
export const PLAN_LIMIT_FEATURE_KEYS = [
  "reviews.max_comments_per_pr",
  "reviews.max_monthly_review_credits",
  "reviews.max_changed_files",
  "reviews.max_patch_bytes",
  "indexing.max_repo_bytes",
  "indexing.max_file_bytes",
  "indexing.languages",
] as const;

/** Seeded plans that allow local entitlement decisions before Stripe exists. */
export const SEEDED_BILLING_PLAN_CATALOG: readonly BillingPlanCatalogEntry[] = [
  seededPlan({
    audience: "individual",
    baseAmountMicros: 0,
    description: "Free starter plan for local evaluation.",
    features: {
      "enterprise.byok": false,
      "enterprise.self_hosted": false,
      "indexing.enabled": true,
      "memory.enabled": false,
      "reviews.enabled": true,
      "reviews.inline_comments": false,
      "reviews.pr_summary": true,
      "rules.advanced": false,
      "sandbox.enabled": false,
      "security.audit_logs": false,
      "security.data_retention_custom": false,
      "security.sso": false,
      "static_analysis.enabled": false,
    },
    included: { reviewCreditsPerMonth: 25 },
    limits: {
      "indexing.max_file_bytes": 250_000,
      "indexing.max_repo_bytes": 25_000_000,
      "reviews.max_changed_files": 75,
      "reviews.max_comments_per_pr": 3,
      "reviews.max_monthly_review_credits": 25,
      "reviews.max_patch_bytes": 250_000,
    },
    name: "Free",
    planKey: "free",
    public: true,
  }),
  seededPlan({
    audience: "team",
    baseAmountMicros: 2_900_000,
    billingInterval: "month",
    description: "Shared review automation for active teams.",
    features: {
      "enterprise.byok": false,
      "enterprise.self_hosted": false,
      "indexing.enabled": true,
      "memory.enabled": true,
      "reviews.enabled": true,
      "reviews.inline_comments": true,
      "reviews.pr_summary": true,
      "rules.advanced": true,
      "sandbox.enabled": false,
      "security.audit_logs": true,
      "security.data_retention_custom": false,
      "security.sso": false,
      "static_analysis.enabled": false,
    },
    included: { reviewCreditsPerMonth: 500 },
    limits: {
      "indexing.max_file_bytes": 1_000_000,
      "indexing.max_repo_bytes": 500_000_000,
      "reviews.max_changed_files": 300,
      "reviews.max_comments_per_pr": 8,
      "reviews.max_monthly_review_credits": 500,
      "reviews.max_patch_bytes": 1_500_000,
    },
    name: "Team",
    planKey: "team",
    public: true,
  }),
  seededPlan({
    audience: "business",
    baseAmountMicros: 9_900_000,
    billingInterval: "month",
    description: "Higher limits, audit logs, and advanced policy controls.",
    features: {
      "enterprise.byok": false,
      "enterprise.self_hosted": false,
      "indexing.enabled": true,
      "memory.enabled": true,
      "reviews.enabled": true,
      "reviews.inline_comments": true,
      "reviews.pr_summary": true,
      "rules.advanced": true,
      "sandbox.enabled": false,
      "security.audit_logs": true,
      "security.data_retention_custom": true,
      "security.sso": true,
      "static_analysis.enabled": true,
    },
    included: { reviewCreditsPerMonth: 5_000 },
    limits: {
      "indexing.max_file_bytes": 5_000_000,
      "indexing.max_repo_bytes": 2_000_000_000,
      "reviews.max_changed_files": 1_000,
      "reviews.max_comments_per_pr": 15,
      "reviews.max_monthly_review_credits": 5_000,
      "reviews.max_patch_bytes": 5_000_000,
    },
    name: "Business",
    planKey: "business",
    public: true,
  }),
  seededPlan({
    audience: "internal",
    baseAmountMicros: 0,
    description: "Internal and support validation plan.",
    features: {
      "enterprise.byok": true,
      "enterprise.self_hosted": true,
      "indexing.enabled": true,
      "memory.enabled": true,
      "reviews.enabled": true,
      "reviews.inline_comments": true,
      "reviews.pr_summary": true,
      "rules.advanced": true,
      "sandbox.enabled": true,
      "security.audit_logs": true,
      "security.data_retention_custom": true,
      "security.sso": true,
      "static_analysis.enabled": true,
    },
    included: { reviewCreditsPerMonth: 1_000_000 },
    limits: {
      "indexing.max_file_bytes": 25_000_000,
      "indexing.max_repo_bytes": 25_000_000_000,
      "reviews.max_changed_files": 10_000,
      "reviews.max_comments_per_pr": 50,
      "reviews.max_monthly_review_credits": 1_000_000,
      "reviews.max_patch_bytes": 50_000_000,
    },
    name: "Internal",
    planKey: "internal",
    public: false,
  }),
];

/** Idempotent usage ledger facade used by application and worker code. */
export class UsageLedger {
  /** Creates a usage ledger facade. */
  public constructor(private readonly store: UsageLedgerStore) {}

  /** Records one usage event through the configured store. */
  public async record(input: RecordUsageEventInput): Promise<UsageLedgerRecordResult> {
    return this.store.insertIfAbsent(createUsageEvent(input));
  }

  /** Records several usage events without losing per-event idempotency results. */
  public async recordMany(
    inputs: readonly RecordUsageEventInput[],
  ): Promise<readonly UsageLedgerRecordResult[]> {
    return Promise.all(inputs.map((input) => this.record(input)));
  }
}

/** In-memory usage ledger store for tests, local tools, and deterministic examples. */
export class InMemoryUsageLedgerStore implements UsageLedgerStore {
  private readonly eventsById = new Map<string, UsageEvent>();

  /** Inserts an event if it has not already been seen. */
  public async insertIfAbsent(event: UsageEvent): Promise<UsageLedgerRecordResult> {
    const existing = this.eventsById.get(event.usageEventId);

    if (existing) {
      return { event: existing, recorded: false };
    }

    this.eventsById.set(event.usageEventId, event);
    return { event, recorded: true };
  }

  /** Returns recorded events in deterministic ledger order. */
  public events(): readonly UsageEvent[] {
    return [...this.eventsById.values()].sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.usageEventId.localeCompare(right.usageEventId),
    );
  }

  /** Clears all in-memory state. */
  public clear(): void {
    this.eventsById.clear();
  }
}

/** Postgres-backed store for the durable usage_events table. */
export class PostgresUsageLedgerStore implements UsageLedgerStore {
  /** Creates a Postgres usage ledger store. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts an event unless the same event ID already exists. */
  public async insertIfAbsent(event: UsageEvent): Promise<UsageLedgerRecordResult> {
    const [inserted] = await this.db
      .insert(usageEvents)
      .values(toUsageEventInsert(event))
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return { event: parseUsageEventRow(inserted), recorded: true };
    }

    const [existing] = await this.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.usageEventId, event.usageEventId))
      .limit(1);

    if (!existing) {
      throw new Error("Usage event insert conflict did not return an existing ledger row.");
    }

    return { event: parseUsageEventRow(existing), recorded: false };
  }
}

/** In-memory entitlement store for tests, demos, and local tools. */
export class InMemoryEntitlementStore implements EntitlementStore {
  private readonly accountsByOrgId = new Map<string, BillingAccount>();
  private readonly entitlementsByOrgId = new Map<string, Entitlement[]>();

  /** Creates an in-memory entitlement store with optional seed state. */
  public constructor(
    entries: {
      /** Billing accounts keyed by their organization. */
      readonly billingAccounts?: readonly BillingAccount[];
      /** Entitlement rows keyed by their organization. */
      readonly entitlements?: readonly Entitlement[];
    } = {},
  ) {
    for (const account of entries.billingAccounts ?? []) {
      this.accountsByOrgId.set(account.orgId, account);
    }
    for (const entitlement of entries.entitlements ?? []) {
      const rows = this.entitlementsByOrgId.get(entitlement.orgId) ?? [];
      rows.push(entitlement);
      this.entitlementsByOrgId.set(entitlement.orgId, rows);
    }
  }

  /** Gets a billing account by organization. */
  public async getBillingAccount(orgId: string): Promise<BillingAccount | undefined> {
    return this.accountsByOrgId.get(orgId);
  }

  /** Gets the seeded local billing plan catalog. */
  public async getPlanCatalog(): Promise<readonly BillingPlanCatalogEntry[]> {
    return SEEDED_BILLING_PLAN_CATALOG;
  }

  /** Gets organization entitlements in deterministic order. */
  public async getOrgEntitlements(orgId: string): Promise<readonly Entitlement[]> {
    return [...(this.entitlementsByOrgId.get(orgId) ?? [])].sort(compareEntitlements);
  }
}

/** Postgres-backed entitlement store for API and worker decisions. */
export class PostgresEntitlementStore implements EntitlementStore {
  /** Creates a Postgres entitlement store. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Gets a billing account by organization. */
  public async getBillingAccount(orgId: string): Promise<BillingAccount | undefined> {
    const [row] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    return row ? parseBillingAccountRow(row) : undefined;
  }

  /** Gets active plan catalog rows from Postgres. */
  public async getPlanCatalog(): Promise<readonly BillingPlanCatalogEntry[]> {
    const rows = await this.db
      .select({ plan: billingPlans, version: billingPlanVersions })
      .from(billingPlanVersions)
      .innerJoin(billingPlans, eq(billingPlanVersions.billingPlanId, billingPlans.billingPlanId));

    return rows
      .map((row) => ({
        plan: parseBillingPlanRow(row.plan),
        version: parseBillingPlanVersionRow(row.version),
      }))
      .sort(compareCatalogEntries);
  }

  /** Gets organization entitlements from Postgres in deterministic order. */
  public async getOrgEntitlements(orgId: string): Promise<readonly Entitlement[]> {
    const rows = await this.db.select().from(entitlements).where(eq(entitlements.orgId, orgId));

    return rows.map(parseEntitlementRow).sort(compareEntitlements);
  }
}

/** Default entitlement service backed by a local store. */
export class DefaultEntitlementService implements EntitlementService {
  /** Creates a provider-free entitlement service. */
  public constructor(private readonly store: EntitlementStore = new InMemoryEntitlementStore()) {}

  /** Gets entitlement rows for one organization. */
  public async getOrgEntitlements(orgId: string): Promise<readonly Entitlement[]> {
    return this.store.getOrgEntitlements(orgId);
  }

  /** Compiles the current plan snapshot for one organization. */
  public async compilePlanSnapshot(input: CompilePlanSnapshotInput): Promise<PlanSnapshot> {
    const [billingAccount, catalog, entitlementsForOrg] = await Promise.all([
      input.billingAccount
        ? Promise.resolve(input.billingAccount)
        : this.store.getBillingAccount(input.orgId),
      this.store.getPlanCatalog(),
      input.entitlements
        ? Promise.resolve(input.entitlements)
        : this.store.getOrgEntitlements(input.orgId),
    ]);

    return compilePlanSnapshot({
      catalog: input.catalog ?? catalog,
      entitlements: input.entitlements ?? entitlementsForOrg,
      ...(billingAccount ? { billingAccount } : {}),
      ...(input.now ? { now: input.now } : {}),
      orgId: input.orgId,
      ...(input.planKey ? { planKey: input.planKey } : {}),
      ...(input.planVersionId ? { planVersionId: input.planVersionId } : {}),
    });
  }

  /** Checks one feature for an organization without provider calls. */
  public async checkFeature(input: CheckFeatureInput): Promise<EntitlementDecision> {
    const entitlementsForOrg = await this.store.getOrgEntitlements(input.orgId);
    const snapshot =
      input.snapshot ??
      (await this.compilePlanSnapshot({
        entitlements: entitlementsForOrg,
        ...(input.now ? { now: input.now } : {}),
        orgId: input.orgId,
      }));

    return checkPlanFeature({
      entitlements: entitlementsForOrg,
      featureKey: input.featureKey,
      ...(input.now ? { now: input.now } : {}),
      snapshot,
    });
  }
}

/** In-memory billing store for tests, demos, and local tools. */
export class InMemoryBillingStore implements BillingStore {
  private readonly accountsByOrgId = new Map<string, BillingAccount>();
  private readonly entitlementsByOrgId = new Map<string, Entitlement[]>();
  private readonly subscriptionsByAccountId = new Map<string, Subscription[]>();
  private readonly itemsBySubscriptionId = new Map<string, SubscriptionItem[]>();
  private readonly grantsByOrgId = new Map<string, CreditGrant[]>();
  private readonly invoicesByAccountId = new Map<string, Invoice[]>();
  private readonly catalog: readonly BillingPlanCatalogEntry[];

  /** Creates an in-memory billing store with optional seed state. */
  public constructor(
    entries: {
      /** Billing accounts keyed by organization. */
      readonly billingAccounts?: readonly BillingAccount[];
      /** Plan catalog entries available to the compiler. */
      readonly catalog?: readonly BillingPlanCatalogEntry[];
      /** Entitlement rows keyed by organization. */
      readonly entitlements?: readonly Entitlement[];
      /** Subscription mirrors keyed by billing account. */
      readonly subscriptions?: readonly Subscription[];
      /** Subscription item mirrors keyed by subscription. */
      readonly subscriptionItems?: readonly SubscriptionItem[];
      /** Credit grants keyed by organization. */
      readonly creditGrants?: readonly CreditGrant[];
      /** Invoice mirrors keyed by billing account. */
      readonly invoices?: readonly Invoice[];
    } = {},
  ) {
    this.catalog = entries.catalog ?? SEEDED_BILLING_PLAN_CATALOG;
    for (const account of entries.billingAccounts ?? []) {
      this.accountsByOrgId.set(account.orgId, account);
    }
    for (const entitlement of entries.entitlements ?? []) {
      const rows = this.entitlementsByOrgId.get(entitlement.orgId) ?? [];
      rows.push(entitlement);
      this.entitlementsByOrgId.set(entitlement.orgId, rows);
    }
    for (const subscription of entries.subscriptions ?? []) {
      const rows = this.subscriptionsByAccountId.get(subscription.billingAccountId) ?? [];
      rows.push(subscription);
      this.subscriptionsByAccountId.set(subscription.billingAccountId, rows);
    }
    for (const item of entries.subscriptionItems ?? []) {
      const rows = this.itemsBySubscriptionId.get(item.subscriptionId) ?? [];
      rows.push(item);
      this.itemsBySubscriptionId.set(item.subscriptionId, rows);
    }
    for (const grant of entries.creditGrants ?? []) {
      const rows = this.grantsByOrgId.get(grant.orgId) ?? [];
      rows.push(grant);
      this.grantsByOrgId.set(grant.orgId, rows);
    }
    for (const invoice of entries.invoices ?? []) {
      const rows = this.invoicesByAccountId.get(invoice.billingAccountId) ?? [];
      rows.push(invoice);
      this.invoicesByAccountId.set(invoice.billingAccountId, rows);
    }
  }

  /** Gets a billing account by organization. */
  public async getBillingAccount(orgId: string): Promise<BillingAccount | undefined> {
    return this.accountsByOrgId.get(orgId);
  }

  /** Gets an existing billing account or creates the local default. */
  public async getOrCreateBillingAccount(
    input: GetOrCreateBillingAccountInput,
  ): Promise<BillingAccount> {
    const existing = this.accountsByOrgId.get(input.orgId);
    if (existing) {
      return existing;
    }

    const now = input.now ?? new Date().toISOString();
    const entry = selectPlanCatalogEntry({
      catalog: mergePlanCatalog(this.catalog),
      now,
      planKey: input.planKey ?? "free",
      planVersionId: input.planVersionId,
    });
    const account = defaultBillingAccount(input.orgId, entry.plan.planKey, entry.version, now);
    this.accountsByOrgId.set(input.orgId, account);
    return account;
  }

  /** Gets plan catalog entries. */
  public async getPlanCatalog(): Promise<readonly BillingPlanCatalogEntry[]> {
    return this.catalog;
  }

  /** Gets organization entitlements in deterministic order. */
  public async getOrgEntitlements(orgId: string): Promise<readonly Entitlement[]> {
    return [...(this.entitlementsByOrgId.get(orgId) ?? [])].sort(compareEntitlements);
  }

  /** Gets the most relevant current subscription for a billing account. */
  public async getCurrentSubscription(billingAccountId: string): Promise<Subscription | undefined> {
    const [subscription] = [...(this.subscriptionsByAccountId.get(billingAccountId) ?? [])].sort(
      compareSubscriptions,
    );
    return subscription;
  }

  /** Lists subscription items in deterministic order. */
  public async listSubscriptionItems(subscriptionId: string): Promise<readonly SubscriptionItem[]> {
    return [...(this.itemsBySubscriptionId.get(subscriptionId) ?? [])].sort(
      compareSubscriptionItems,
    );
  }

  /** Lists credit grants in deterministic order. */
  public async listCreditGrants(orgId: string): Promise<readonly CreditGrant[]> {
    return [...(this.grantsByOrgId.get(orgId) ?? [])].sort(compareCreditGrants);
  }

  /** Lists invoices in deterministic order. */
  public async listInvoices(billingAccountId: string): Promise<readonly Invoice[]> {
    return [...(this.invoicesByAccountId.get(billingAccountId) ?? [])].sort(compareInvoices);
  }
}

/** Postgres-backed billing store for admin and worker surfaces. */
export class PostgresBillingStore implements BillingStore {
  /** Creates a Postgres billing store. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Gets a billing account by organization. */
  public async getBillingAccount(orgId: string): Promise<BillingAccount | undefined> {
    const [row] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    return row ? parseBillingAccountRow(row) : undefined;
  }

  /** Gets an existing billing account or creates the local default account. */
  public async getOrCreateBillingAccount(
    input: GetOrCreateBillingAccountInput,
  ): Promise<BillingAccount> {
    const existing = await this.getBillingAccount(input.orgId);
    if (existing) {
      return existing;
    }

    const now = input.now ?? new Date().toISOString();
    const entry = selectPlanCatalogEntry({
      catalog: mergePlanCatalog(await this.getPlanCatalog()),
      now,
      planKey: input.planKey ?? "free",
      planVersionId: input.planVersionId,
    });
    const account = defaultBillingAccount(input.orgId, entry.plan.planKey, entry.version, now);
    const [inserted] = await this.db
      .insert(billingAccounts)
      .values(toBillingAccountInsert(account))
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return parseBillingAccountRow(inserted);
    }

    const conflicted = await this.getBillingAccount(input.orgId);
    if (!conflicted) {
      throw new Error("Billing account insert conflict did not return an existing account.");
    }

    return conflicted;
  }

  /** Gets active plan catalog rows from Postgres. */
  public async getPlanCatalog(): Promise<readonly BillingPlanCatalogEntry[]> {
    const rows = await this.db
      .select({ plan: billingPlans, version: billingPlanVersions })
      .from(billingPlanVersions)
      .innerJoin(billingPlans, eq(billingPlanVersions.billingPlanId, billingPlans.billingPlanId));

    return rows
      .map((row) => ({
        plan: parseBillingPlanRow(row.plan),
        version: parseBillingPlanVersionRow(row.version),
      }))
      .sort(compareCatalogEntries);
  }

  /** Gets organization entitlements from Postgres in deterministic order. */
  public async getOrgEntitlements(orgId: string): Promise<readonly Entitlement[]> {
    const rows = await this.db.select().from(entitlements).where(eq(entitlements.orgId, orgId));

    return rows.map(parseEntitlementRow).sort(compareEntitlements);
  }

  /** Gets the current subscription mirror for a billing account. */
  public async getCurrentSubscription(billingAccountId: string): Promise<Subscription | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.billingAccountId, billingAccountId))
      .orderBy(desc(subscriptions.currentPeriodEnd), desc(subscriptions.updatedAt))
      .limit(1);

    return row ? parseSubscriptionRow(row) : undefined;
  }

  /** Lists subscription item mirrors from Postgres. */
  public async listSubscriptionItems(subscriptionId: string): Promise<readonly SubscriptionItem[]> {
    const rows = await this.db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscriptionId));

    return rows.map(parseSubscriptionItemRow).sort(compareSubscriptionItems);
  }

  /** Lists credit grants from Postgres. */
  public async listCreditGrants(orgId: string): Promise<readonly CreditGrant[]> {
    const rows = await this.db.select().from(creditGrants).where(eq(creditGrants.orgId, orgId));

    return rows.map(parseCreditGrantRow).sort(compareCreditGrants);
  }

  /** Lists invoice mirrors from Postgres. */
  public async listInvoices(billingAccountId: string): Promise<readonly Invoice[]> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.billingAccountId, billingAccountId));

    return rows.map(parseInvoiceRow).sort(compareInvoices);
  }
}

/** Default billing summary service backed by local product state. */
export class DefaultBillingService implements BillingService {
  /** Creates a billing summary service. */
  public constructor(private readonly store: BillingStore = new InMemoryBillingStore()) {}

  /** Gets local billing account, subscription, credit, invoice, and plan state. */
  public async getBillingSummary(input: GetBillingSummaryInput): Promise<BillingSummary> {
    const checkedAt = input.now ?? new Date().toISOString();
    const [catalog, entitlementsForOrg] = await Promise.all([
      this.store.getPlanCatalog(),
      this.store.getOrgEntitlements(input.orgId),
    ]);
    const billingAccount = await this.store.getOrCreateBillingAccount({
      now: checkedAt,
      orgId: input.orgId,
    });
    const entitlementService = new DefaultEntitlementService(this.store);
    const planSnapshot = await entitlementService.compilePlanSnapshot({
      billingAccount,
      catalog,
      entitlements: entitlementsForOrg,
      now: checkedAt,
      orgId: input.orgId,
    });
    const [subscription, creditGrantsForOrg, invoicesForAccount] = await Promise.all([
      this.store.getCurrentSubscription(billingAccount.billingAccountId),
      this.store.listCreditGrants(input.orgId),
      this.store.listInvoices(billingAccount.billingAccountId),
    ]);
    const items = subscription
      ? await this.store.listSubscriptionItems(subscription.subscriptionId)
      : [];

    return {
      billingAccount,
      checkedAt,
      creditGrants: creditGrantsForOrg,
      entitlements: entitlementsForOrg,
      invoices: invoicesForAccount,
      orgId: input.orgId,
      planSnapshot,
      ...(subscription ? { subscription } : {}),
      subscriptionItems: items,
    };
  }
}

/** In-memory billing meter event store for tests and local tools. */
export class InMemoryBillingMeterEventStore implements BillingMeterEventStore {
  private readonly usageEventsById = new Map<string, UsageEvent>();
  private readonly billingAccountsById = new Map<string, BillingAccount>();
  private readonly meterEventsById = new Map<string, BillingMeterEvent>();

  /** Creates an in-memory meter event store with optional seed state. */
  public constructor(
    entries: {
      /** Usage ledger rows available for planning. */
      readonly usageEvents?: readonly UsageEvent[];
      /** Billing accounts available for planning. */
      readonly billingAccounts?: readonly BillingAccount[];
      /** Previously planned meter events. */
      readonly billingMeterEvents?: readonly BillingMeterEvent[];
    } = {},
  ) {
    for (const event of entries.usageEvents ?? []) {
      this.usageEventsById.set(event.usageEventId, event);
    }
    for (const account of entries.billingAccounts ?? []) {
      this.billingAccountsById.set(account.billingAccountId, account);
    }
    for (const event of entries.billingMeterEvents ?? []) {
      this.meterEventsById.set(event.billingMeterEventId, event);
    }
  }

  /** Adds one usage event to the in-memory planner source. */
  public addUsageEvent(event: UsageEvent): void {
    this.usageEventsById.set(event.usageEventId, event);
  }

  /** Plans provider meter events for one usage period. */
  public async plan(input: PlanBillingMeterEventsInput): Promise<PlanBillingMeterEventsResult> {
    const planned = planBillingMeterEventsFromUsage({
      billingAccounts: [...this.billingAccountsById.values()],
      ...(input.meterConfigs ? { meterConfigs: input.meterConfigs } : {}),
      ...(input.now ? { now: input.now } : {}),
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      ...(input.provider ? { provider: input.provider } : {}),
      usageEvents: [...this.usageEventsById.values()],
    });
    const events = planned.map((event) => this.upsertPlannedEvent(event));
    return { events, planned: events.length };
  }

  /** Lists ready or failed meter events that can be sent. */
  public async listReadyToSend(limit: number): Promise<readonly BillingMeterEvent[]> {
    return [...this.meterEventsById.values()]
      .filter((event) => event.status === "ready_to_send" || event.status === "failed")
      .sort(compareBillingMeterEvents)
      .slice(0, limit);
  }

  /** Marks one meter event as sent. */
  public async markSent(
    event: BillingMeterEvent,
    providerMeterEventId: string,
    timestamp: string,
  ): Promise<BillingMeterEvent> {
    const updated = parseBillingMeterEvent({
      ...event,
      attemptCount: event.attemptCount + 1,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
      providerMeterEventId,
      sentAt: timestamp,
      status: "sent",
      updatedAt: timestamp,
    });
    this.meterEventsById.set(updated.billingMeterEventId, updated);
    return updated;
  }

  /** Marks one meter event send attempt as failed. */
  public async markFailed(
    event: BillingMeterEvent,
    error: { readonly code?: string; readonly message: string },
    timestamp: string,
  ): Promise<BillingMeterEvent> {
    const updated = parseBillingMeterEvent({
      ...event,
      attemptCount: event.attemptCount + 1,
      ...(error.code ? { lastErrorCode: error.code } : {}),
      lastErrorMessage: error.message,
      status: "failed",
      updatedAt: timestamp,
    });
    this.meterEventsById.set(updated.billingMeterEventId, updated);
    return updated;
  }

  /** Returns planned meter events in deterministic order. */
  public events(): readonly BillingMeterEvent[] {
    return [...this.meterEventsById.values()].sort(compareBillingMeterEvents);
  }

  private upsertPlannedEvent(event: BillingMeterEvent): BillingMeterEvent {
    const existing = [...this.meterEventsById.values()].find(
      (candidate) =>
        candidate.provider === event.provider && candidate.idempotencyKey === event.idempotencyKey,
    );
    const stored = existing
      ? parseBillingMeterEvent({
          ...existing,
          quantity: event.quantity,
          sourceUsageEventIds: event.sourceUsageEventIds,
          updatedAt: event.updatedAt,
        })
      : event;
    this.meterEventsById.set(stored.billingMeterEventId, stored);
    return stored;
  }
}

/** Postgres-backed billing meter event store. */
export class PostgresBillingMeterEventStore implements BillingMeterEventStore {
  /** Creates a Postgres meter event store. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Plans provider meter events for one usage period. */
  public async plan(input: PlanBillingMeterEventsInput): Promise<PlanBillingMeterEventsResult> {
    const meterConfigs = input.meterConfigs ?? DEFAULT_BILLING_METER_CONFIGS;
    const provider = input.provider ?? "stripe";
    const [accountRows, usageRows] = await Promise.all([
      this.db
        .select()
        .from(billingAccounts)
        .where(
          and(
            eq(billingAccounts.provider, provider),
            eq(billingAccounts.billingMode, "self_serve"),
            inArray(billingAccounts.status, ["active", "trialing", "past_due", "grace_period"]),
            sql`${billingAccounts.providerCustomerId} is not null`,
          ),
        ),
      this.db
        .select()
        .from(usageEvents)
        .where(
          and(
            gte(usageEvents.occurredAt, new Date(input.periodStart)),
            lt(usageEvents.occurredAt, new Date(input.periodEnd)),
            inArray(
              usageEvents.eventType,
              meterConfigs.map((config) => config.usageEventType),
            ),
          ),
        ),
    ]);
    const planned = planBillingMeterEventsFromUsage({
      billingAccounts: accountRows.map(parseBillingAccountRow),
      meterConfigs,
      ...(input.now ? { now: input.now } : {}),
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      provider,
      usageEvents: usageRows.map(parseUsageEventRow),
    });
    const events = await Promise.all(planned.map((event) => this.upsertPlanned(event)));
    return { events, planned: events.length };
  }

  /** Lists ready or failed meter events that can be sent. */
  public async listReadyToSend(limit: number): Promise<readonly BillingMeterEvent[]> {
    const rows = await this.db
      .select()
      .from(billingMeterEvents)
      .where(inArray(billingMeterEvents.status, ["ready_to_send", "failed"]))
      .orderBy(billingMeterEvents.updatedAt, billingMeterEvents.billingMeterEventId)
      .limit(limit);

    return rows.map(parseBillingMeterEventRow);
  }

  /** Marks one meter event as sent. */
  public async markSent(
    event: BillingMeterEvent,
    providerMeterEventId: string,
    timestamp: string,
  ): Promise<BillingMeterEvent> {
    const [row] = await this.db
      .update(billingMeterEvents)
      .set({
        attemptCount: event.attemptCount + 1,
        lastErrorCode: null,
        lastErrorMessage: null,
        providerMeterEventId,
        sentAt: new Date(timestamp),
        status: "sent",
        updatedAt: new Date(timestamp),
      })
      .where(eq(billingMeterEvents.billingMeterEventId, event.billingMeterEventId))
      .returning();

    return parseBillingMeterEventRow(requireReturnedRow(row));
  }

  /** Marks one meter event send attempt as failed. */
  public async markFailed(
    event: BillingMeterEvent,
    error: { readonly code?: string; readonly message: string },
    timestamp: string,
  ): Promise<BillingMeterEvent> {
    const [row] = await this.db
      .update(billingMeterEvents)
      .set({
        attemptCount: event.attemptCount + 1,
        lastErrorCode: error.code ?? null,
        lastErrorMessage: error.message,
        status: "failed",
        updatedAt: new Date(timestamp),
      })
      .where(eq(billingMeterEvents.billingMeterEventId, event.billingMeterEventId))
      .returning();

    return parseBillingMeterEventRow(requireReturnedRow(row));
  }

  private async upsertPlanned(event: BillingMeterEvent): Promise<BillingMeterEvent> {
    const [row] = await this.db
      .insert(billingMeterEvents)
      .values(toBillingMeterEventInsert(event))
      .onConflictDoUpdate({
        target: [billingMeterEvents.provider, billingMeterEvents.idempotencyKey],
        set: {
          quantity: event.quantity,
          sourceUsageEventIds: event.sourceUsageEventIds,
          updatedAt: new Date(event.updatedAt),
        },
      })
      .returning();

    return parseBillingMeterEventRow(requireReturnedRow(row));
  }
}

/** Default usage-based billing meter sync service. */
export class DefaultBillingMeteringService implements BillingMeteringService {
  /** Creates a billing metering service. */
  public constructor(
    private readonly store: BillingMeterEventStore = new InMemoryBillingMeterEventStore(),
  ) {}

  /** Plans meter event rows from internal usage events. */
  public async planMeterEvents(
    input: PlanBillingMeterEventsInput,
  ): Promise<PlanBillingMeterEventsResult> {
    return this.store.plan(input);
  }

  /** Sends ready meter event rows through the provider-neutral billing adapter. */
  public async sendReadyMeterEvents(
    input: SendBillingMeterEventsInput,
  ): Promise<SendBillingMeterEventsResult> {
    const timestamp = input.now ?? new Date().toISOString();
    const candidates = await this.store.listReadyToSend(input.limit ?? 100);
    const sent: BillingMeterEvent[] = [];
    const failed: BillingMeterEvent[] = [];

    for (const event of candidates) {
      try {
        const providerEvent = await input.billingProvider.sendMeterEvent({
          billingAccountId: event.billingAccountId,
          idempotencyKey: event.idempotencyKey,
          metadata: {
            billingMeterEventId: event.billingMeterEventId,
            meterKey: event.meterKey,
            periodKey: event.periodKey,
          },
          meterKey: event.providerEventName,
          orgId: event.orgId,
          providerCustomerId: event.providerCustomerId,
          quantity: event.quantity,
          timestamp: providerMeterTimestamp(event, timestamp),
        });
        sent.push(await this.store.markSent(event, providerEvent.providerMeterEventId, timestamp));
      } catch (error) {
        failed.push(await this.store.markFailed(event, providerError(error), timestamp));
      }
    }

    return { failed, sent };
  }
}

/** Reconciles provider subscription mirrors, quota counters, and metered usage state. */
export async function reconcileBillingState(
  input: ReconcileBillingStateInput,
): Promise<BillingReconciliationRunResult> {
  const checkedAt = input.now ?? new Date().toISOString();
  const provider = input.provider ?? "stripe";
  const period = reconciliationPeriod(input, checkedAt);
  const limit = boundedReconciliationLimit(input.limit);
  const meterService = new DefaultBillingMeteringService(
    new PostgresBillingMeterEventStore(input.db),
  );
  const [providerState, quotaCountersResult, plannedMeterEvents] = await Promise.all([
    reconcileProviderSubscriptions(input.db, input.billingProvider, {
      checkedAt,
      limit,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      provider,
    }),
    reconcileReviewCreditQuotaCounters(input.db, {
      limit,
      periodKey: period.periodKey,
      timestamp: checkedAt,
      ...(input.orgId ? { orgId: input.orgId } : {}),
    }),
    meterService.planMeterEvents({
      now: checkedAt,
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      provider,
    }),
  ]);
  const sentMeterEvents = await meterService.sendReadyMeterEvents({
    billingProvider: input.billingProvider,
    limit,
    now: checkedAt,
  });

  return {
    checkedAt,
    failedMeterEvents: sentMeterEvents.failed.length,
    periodEnd: period.periodEnd,
    periodKey: period.periodKey,
    periodStart: period.periodStart,
    plannedMeterEvents: plannedMeterEvents.planned,
    provider,
    providerState,
    quotaCounters: quotaCountersResult,
    sentMeterEvents: sentMeterEvents.sent.length,
  };
}

/** In-memory quota store for tests and local tools. */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly countersById = new Map<string, QuotaCounter>();
  private readonly counterIdsByScope = new Map<string, string>();
  private readonly reservationsById = new Map<string, QuotaReservation>();

  /** Gets or creates a quota counter. */
  public async getOrCreateCounter(input: CheckQuotaInput): Promise<QuotaCounter> {
    const quotaCounterId = quotaCounterIdFromInput(input);
    const existing = this.countersById.get(quotaCounterId);
    if (existing) {
      const updated = {
        ...existing,
        limitQuantity: input.limit,
        periodEnd: input.periodEnd,
        periodStart: input.periodStart,
        source: input.source ?? existing.source,
        updatedAt: input.now ?? existing.updatedAt,
      };
      this.countersById.set(quotaCounterId, parseQuotaCounter(updated));
      return requireMapValue(this.countersById, quotaCounterId);
    }

    const timestamp = input.now ?? new Date().toISOString();
    const counter = parseQuotaCounter({
      createdAt: timestamp,
      limitQuantity: input.limit,
      orgId: input.orgId,
      periodEnd: input.periodEnd,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      quotaCounterId,
      quotaKey: input.quotaKey,
      reservedQuantity: 0,
      source: input.source ?? "quota_service",
      updatedAt: timestamp,
      usedQuantity: 0,
    });

    this.countersById.set(quotaCounterId, counter);
    this.counterIdsByScope.set(quotaCounterScope(input), quotaCounterId);
    return counter;
  }

  /** Gets a reservation by ID. */
  public async getReservation(quotaReservationId: string): Promise<QuotaReservation | undefined> {
    return this.reservationsById.get(quotaReservationId);
  }

  /** Reserves quota idempotently. */
  public async reserve(
    input: ReserveQuotaInput & {
      readonly quotaCounterId: string;
      readonly quotaReservationId: string;
    },
  ): Promise<ReserveQuotaResult> {
    const counter = await this.getOrCreateCounter(input);
    const existing = this.reservationsById.get(input.quotaReservationId);
    if (existing?.status === "reserved" || existing?.status === "consumed") {
      return {
        counter,
        decision: allowedReservationDecision(input, counter),
        reservation: existing,
        reserved: false,
      };
    }

    const decision = evaluateCounterReservation(input, counter);
    if (!decision.allowed) {
      return { counter, decision, reserved: false };
    }

    const timestamp = input.now ?? new Date().toISOString();
    const reservation = parseQuotaReservation({
      consumedAt: undefined,
      createdAt: existing?.createdAt ?? timestamp,
      expiresAt: input.expiresAt ?? defaultReservationExpiry(timestamp),
      orgId: input.orgId,
      quantity: input.requested,
      quotaCounterId: counter.quotaCounterId,
      quotaReservationId: input.quotaReservationId,
      releasedAt: undefined,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      status: "reserved",
      updatedAt: timestamp,
    });
    const updatedCounter = parseQuotaCounter({
      ...counter,
      reservedQuantity: counter.reservedQuantity + input.requested,
      updatedAt: timestamp,
    });

    this.countersById.set(counter.quotaCounterId, updatedCounter);
    this.reservationsById.set(reservation.quotaReservationId, reservation);
    return { counter: updatedCounter, decision, reservation, reserved: true };
  }

  /** Consumes a reservation idempotently. */
  public async consumeReservation(input: ConsumeQuotaReservationInput): Promise<QuotaReservation> {
    const reservation = requireReservation(this.reservationsById.get(input.quotaReservationId));
    if (reservation.status === "consumed") {
      return reservation;
    }
    if (reservation.status !== "reserved") {
      throw new Error(`Quota reservation ${reservation.quotaReservationId} cannot be consumed.`);
    }

    const counter = requireMapValue(this.countersById, reservation.quotaCounterId);
    const timestamp = input.now ?? new Date().toISOString();
    const updatedReservation = parseQuotaReservation({
      ...reservation,
      consumedAt: timestamp,
      status: "consumed",
      updatedAt: timestamp,
    });
    const updatedCounter = parseQuotaCounter({
      ...counter,
      reservedQuantity: Math.max(0, counter.reservedQuantity - reservation.quantity),
      updatedAt: timestamp,
      usedQuantity: counter.usedQuantity + reservation.quantity,
    });

    this.reservationsById.set(updatedReservation.quotaReservationId, updatedReservation);
    this.countersById.set(counter.quotaCounterId, updatedCounter);
    return updatedReservation;
  }

  /** Releases a reservation idempotently. */
  public async releaseReservation(input: ReleaseQuotaReservationInput): Promise<QuotaReservation> {
    const reservation = requireReservation(this.reservationsById.get(input.quotaReservationId));
    if (reservation.status === "released") {
      return reservation;
    }
    if (reservation.status !== "reserved") {
      return reservation;
    }

    const counter = requireMapValue(this.countersById, reservation.quotaCounterId);
    const timestamp = input.now ?? new Date().toISOString();
    const updatedReservation = parseQuotaReservation({
      ...reservation,
      releasedAt: timestamp,
      status: "released",
      updatedAt: timestamp,
    });
    const updatedCounter = parseQuotaCounter({
      ...counter,
      reservedQuantity: Math.max(0, counter.reservedQuantity - reservation.quantity),
      updatedAt: timestamp,
    });

    this.reservationsById.set(updatedReservation.quotaReservationId, updatedReservation);
    this.countersById.set(counter.quotaCounterId, updatedCounter);
    return updatedReservation;
  }
}

/** Postgres-backed quota store. */
export class PostgresQuotaStore implements QuotaStore {
  /** Creates a Postgres quota store. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Gets or creates a quota counter. */
  public async getOrCreateCounter(input: CheckQuotaInput): Promise<QuotaCounter> {
    return getOrCreateQuotaCounter(this.db, input);
  }

  /** Gets a reservation by ID. */
  public async getReservation(quotaReservationId: string): Promise<QuotaReservation | undefined> {
    const [row] = await this.db
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.quotaReservationId, quotaReservationId))
      .limit(1);

    return row ? parseQuotaReservationRow(row) : undefined;
  }

  /** Reserves quota idempotently. */
  public async reserve(
    input: ReserveQuotaInput & {
      readonly quotaCounterId: string;
      readonly quotaReservationId: string;
    },
  ): Promise<ReserveQuotaResult> {
    return this.db.transaction(async (tx) => reserveQuota(tx as HeimdallDatabase, input));
  }

  /** Consumes a reservation idempotently. */
  public async consumeReservation(input: ConsumeQuotaReservationInput): Promise<QuotaReservation> {
    return this.db.transaction(async (tx) =>
      consumeQuotaReservation(tx as HeimdallDatabase, input),
    );
  }

  /** Releases a reservation idempotently. */
  public async releaseReservation(input: ReleaseQuotaReservationInput): Promise<QuotaReservation> {
    return this.db.transaction(async (tx) =>
      releaseQuotaReservation(tx as HeimdallDatabase, input),
    );
  }
}

/** Default quota service facade. */
export class DefaultQuotaService implements QuotaService {
  /** Creates a quota service with an in-memory default store. */
  public constructor(private readonly store: QuotaStore = new InMemoryQuotaStore()) {}

  /** Checks quota availability without reserving. */
  public async check(input: CheckQuotaInput): Promise<UsageQuotaDecision> {
    const counter = await this.store.getOrCreateCounter(input);
    return evaluateCounterReservation(input, counter);
  }

  /** Reserves quota for one source entity. */
  public async reserve(input: ReserveQuotaInput): Promise<ReserveQuotaResult> {
    return this.store.reserve({
      ...input,
      quotaCounterId: quotaCounterIdFromInput(input),
      quotaReservationId: quotaReservationIdFromInput(input),
    });
  }

  /** Consumes a reservation. */
  public async consumeReservation(input: ConsumeQuotaReservationInput): Promise<QuotaReservation> {
    return this.store.consumeReservation(input);
  }

  /** Releases a reservation. */
  public async releaseReservation(input: ReleaseQuotaReservationInput): Promise<QuotaReservation> {
    return this.store.releaseReservation(input);
  }
}

/** Creates and validates one immutable usage event. */
export function createUsageEvent(input: RecordUsageEventInput): UsageEvent {
  assertInteger("quantity", input.quantity);

  if (input.costMicros !== undefined) {
    assertInteger("costMicros", input.costMicros);
  }

  if (input.unit.trim().length === 0) {
    throw new Error("Usage event unit must not be empty.");
  }

  return parseWithSchema("UsageEvent", UsageEventSchema, {
    usageEventId:
      input.usageEventId ??
      (input.idempotencyKey ? usageEventIdFromKey(input.idempotencyKey) : randomUsageEventId()),
    orgId: input.orgId,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    eventType: input.eventType,
    quantity: input.quantity,
    unit: input.unit,
    costMicros: input.costMicros ?? 0,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

/** Compiles plan defaults and active entitlement overrides into a stable snapshot. */
export function compilePlanSnapshot(input: CompilePlanSnapshotInput): PlanSnapshot {
  const now = input.now ?? new Date().toISOString();
  const catalog = mergePlanCatalog(input.catalog ?? []);
  const requestedPlanKey = input.planKey ?? input.billingAccount?.currentPlanKey ?? "free";
  const entry = selectPlanCatalogEntry({
    catalog,
    now,
    planKey: requestedPlanKey,
    planVersionId: input.planVersionId ?? input.billingAccount?.currentPlanVersionId,
  });
  const account =
    input.billingAccount ??
    defaultBillingAccount(input.orgId, entry.plan.planKey, entry.version, now);
  const baseFeatures = recordFromUnknown(entry.version.features);
  const baseLimits = limitRecordFromUnknown(entry.version.limits);
  const activeEntitlements = (input.entitlements ?? []).filter((entitlement) =>
    entitlementIsActive(entitlement, now),
  );
  const { features, limits } = applyEntitlements({
    entitlements: activeEntitlements,
    features: baseFeatures,
    limits: baseLimits,
  });

  return parseWithSchema("PlanSnapshot", PlanSnapshotSchema, {
    billingAccountId: account.billingAccountId,
    compiledAt: now,
    features,
    limits,
    orgId: input.orgId,
    paymentStatus: account.paymentStatus,
    planKey: entry.plan.planKey,
    planVersionId: entry.version.billingPlanVersionId,
    schemaVersion: "plan_snapshot.v1",
    subscriptionStatus: account.status,
  });
}

/** Checks one feature or limit against a stable plan snapshot. */
export function checkPlanFeature(input: CheckPlanFeatureInput): EntitlementDecision {
  const now = input.now ?? new Date().toISOString();
  const entitlement = mostRelevantEntitlement(
    (input.entitlements ?? []).filter(
      (row) => row.featureKey === input.featureKey && entitlementIsActive(row, now),
    ),
  );

  if (input.snapshot.subscriptionStatus === "suspended") {
    return entitlementDecision({
      allowed: false,
      featureKey: input.featureKey,
      orgId: input.snapshot.orgId,
      reason: "org_suspended",
      source: "manual",
    });
  }

  if (input.snapshot.paymentStatus === "blocked" || input.snapshot.paymentStatus === "failed") {
    return entitlementDecision({
      allowed: false,
      featureKey: input.featureKey,
      orgId: input.snapshot.orgId,
      reason: "payment_past_due",
      source: "stripe",
    });
  }

  if (entitlement && !entitlement.enabled) {
    return entitlementDecision({
      allowed: false,
      featureKey: input.featureKey,
      orgId: input.snapshot.orgId,
      reason: "disabled_by_admin",
      source: entitlement.source,
      value: entitlement.value,
    });
  }

  if (entitlement?.enabled) {
    return entitlementDecision({
      allowed: true,
      featureKey: input.featureKey,
      orgId: input.snapshot.orgId,
      reason: "enabled",
      source: entitlement.source,
      value: entitlementValue(entitlement),
    });
  }

  const value =
    input.snapshot.features[input.featureKey] ?? input.snapshot.limits[input.featureKey];
  if (value === undefined || value === false) {
    return entitlementDecision({
      allowed: false,
      featureKey: input.featureKey,
      orgId: input.snapshot.orgId,
      reason: "disabled_by_plan",
      source: "plan",
      value,
    });
  }

  return entitlementDecision({
    allowed: true,
    featureKey: input.featureKey,
    orgId: input.snapshot.orgId,
    reason: "enabled",
    source: "plan",
    value,
  });
}

/** Returns the UTC monthly quota period that contains a timestamp. */
export function monthlyQuotaPeriod(timestamp: string): QuotaPeriod {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Quota period timestamp must be a valid ISO timestamp.");
  }

  const periodStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, "0");

  return {
    periodKey: `${periodStart.getUTCFullYear()}-${month}`,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

/** Builds a customer-safe usage, quota, meter, and invoice summary for one billing period. */
export function buildUsagePeriodSummary(input: BuildUsagePeriodSummaryInput): UsagePeriodSummary {
  const events = input.usageEvents
    .filter((event) => event.orgId === input.orgId && eventIsWithinPeriod(event, input))
    .sort(compareUsageEvents);
  const reviewCreditsUsed = events
    .filter((event) => event.eventType === "review.credit" && event.unit === "credit")
    .reduce((sum, event) => sum + event.quantity, 0);
  const reviewRuns = events
    .filter((event) => event.eventType === "review.run")
    .reduce((sum, event) => sum + event.quantity, 0);
  const included = includedReviewCredits(input);
  const granted = activeReviewCreditGrantQuantity({
    creditGrants: input.creditGrants ?? [],
    now: input.now ?? input.periodEnd,
    orgId: input.orgId,
  });
  const limit = included + granted;
  const utilization = utilizationFor(reviewCreditsUsed, limit);
  const period = {
    periodEnd: input.periodEnd,
    periodKey: monthlyQuotaPeriod(input.periodStart).periodKey,
    periodStart: input.periodStart,
  };
  const costMicros = events.reduce((sum, event) => sum + (event.costMicros ?? 0), 0);

  return {
    ...(input.includeInternalCost ? { cost: { estimatedMicros: costMicros } } : {}),
    byCategory: summarizeUsagePeriodByCategory({
      events,
      includeInternalCost: input.includeInternalCost ?? false,
    }),
    byRepo: summarizeUsagePeriodByRepo({
      events,
      includeInternalCost: input.includeInternalCost ?? false,
    }),
    invoices: summarizeUsagePeriodInvoices({
      invoices: input.invoices ?? [],
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
    }),
    meterEvents: summarizeUsagePeriodMeterEvents({
      billingMeterEvents: input.billingMeterEvents ?? [],
      orgId: input.orgId,
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
    }),
    orgId: input.orgId,
    period,
    reviewCredits: {
      granted,
      included,
      limit,
      overage: Math.max(0, reviewCreditsUsed - limit),
      remaining: Math.max(0, limit - reviewCreditsUsed),
      status: reviewCreditStatus({
        limit,
        used: reviewCreditsUsed,
        ...(input.warnAtPercent === undefined ? {} : { warnAtPercent: input.warnAtPercent }),
      }),
      used: reviewCreditsUsed,
      utilization,
    },
    reviewRuns,
  };
}

/** Plans provider meter events from local usage events and billing accounts. */
export function planBillingMeterEventsFromUsage(input: {
  /** Usage events available for the target period. */
  readonly usageEvents: readonly UsageEvent[];
  /** Billing accounts that may receive provider meter events. */
  readonly billingAccounts: readonly BillingAccount[];
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
  /** Provider that receives meter events. Defaults to stripe. */
  readonly provider?: string;
  /** Meter configuration registry. Defaults to DEFAULT_BILLING_METER_CONFIGS. */
  readonly meterConfigs?: readonly BillingMeterConfig[];
  /** Timestamp used for deterministic planned rows. */
  readonly now?: string;
}): readonly BillingMeterEvent[] {
  const provider = input.provider ?? "stripe";
  const meterConfigs = input.meterConfigs ?? DEFAULT_BILLING_METER_CONFIGS;
  const timestamp = input.now ?? new Date().toISOString();
  const periodKey = monthlyQuotaPeriod(input.periodStart).periodKey;
  const events: BillingMeterEvent[] = [];

  for (const account of [...input.billingAccounts].sort(compareBillingAccounts)) {
    if (!isBillableMeterAccount(account, provider)) {
      continue;
    }

    for (const config of meterConfigs) {
      const sourceEvents = input.usageEvents
        .filter((event) => meterEventMatchesAccountAndConfig(event, account, config, input))
        .sort(compareUsageEvents);
      const quantity = sourceEvents.reduce((sum, event) => sum + event.quantity, 0);
      if (quantity <= 0) {
        continue;
      }

      events.push(
        parseBillingMeterEvent({
          attemptCount: 0,
          billingAccountId: account.billingAccountId,
          billingMeterEventId: billingMeterEventIdFromInput({
            account,
            config,
            periodEnd: input.periodEnd,
            periodStart: input.periodStart,
            provider,
          }),
          createdAt: timestamp,
          idempotencyKey: billingMeterIdempotencyKey({
            account,
            config,
            periodEnd: input.periodEnd,
            periodStart: input.periodStart,
            provider,
          }),
          meterKey: config.meterKey,
          orgId: account.orgId,
          periodEnd: input.periodEnd,
          periodKey,
          periodStart: input.periodStart,
          provider,
          providerCustomerId: account.providerCustomerId,
          providerEventName: config.providerEventName,
          quantity,
          sourceUsageEventIds: sourceEvents.map((event) => event.usageEventId),
          status: "ready_to_send",
          updatedAt: timestamp,
        }),
      );
    }
  }

  return events.sort(compareBillingMeterEvents);
}

/** Reconciles provider subscription mirrors for active billing accounts. */
async function reconcileProviderSubscriptions(
  db: HeimdallDatabase,
  billingProvider: BillingProvider,
  input: {
    readonly checkedAt: string;
    readonly limit: number;
    readonly orgId?: string;
    readonly provider: string;
  },
): Promise<readonly ProviderSubscriptionReconciliation[]> {
  const conditions = [
    eq(billingAccounts.provider, input.provider),
    sql`${billingAccounts.providerCustomerId} is not null`,
  ];
  if (input.orgId) {
    conditions.push(eq(billingAccounts.orgId, input.orgId));
  }
  const accounts = await db
    .select()
    .from(billingAccounts)
    .where(and(...conditions))
    .orderBy(billingAccounts.billingAccountId)
    .limit(input.limit);
  const results: ProviderSubscriptionReconciliation[] = [];

  for (const account of accounts) {
    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, account.billingAccountId),
          sql`${subscriptions.providerSubscriptionId} is not null`,
        ),
      )
      .orderBy(desc(subscriptions.currentPeriodEnd), desc(subscriptions.updatedAt))
      .limit(1);
    if (!subscription?.providerSubscriptionId) {
      results.push({
        billingAccountId: account.billingAccountId,
        message: "No provider subscription mirror is available.",
        orgId: account.orgId,
        status: "skipped",
      });
      continue;
    }

    try {
      const providerSubscription = await billingProvider.getSubscription({
        billingAccountId: account.billingAccountId,
        orgId: account.orgId,
        providerSubscriptionId: subscription.providerSubscriptionId,
      });
      await upsertProviderSubscriptionMirror(db, account, providerSubscription, input.checkedAt);
      results.push({
        billingAccountId: account.billingAccountId,
        orgId: account.orgId,
        providerSubscriptionId: subscription.providerSubscriptionId,
        status: "refreshed",
      });
    } catch (error) {
      results.push({
        billingAccountId: account.billingAccountId,
        message: error instanceof Error ? error.message : String(error),
        orgId: account.orgId,
        providerSubscriptionId: subscription.providerSubscriptionId,
        status: "failed",
      });
    }
  }

  return results;
}

/** Repairs monthly review credit counters from usage ledger totals. */
async function reconcileReviewCreditQuotaCounters(
  db: HeimdallDatabase,
  input: {
    readonly limit: number;
    readonly orgId?: string;
    readonly periodKey: string;
    readonly timestamp: string;
  },
): Promise<readonly QuotaCounterReconciliation[]> {
  const conditions = [
    eq(quotaCounters.quotaKey, "monthly_review_credits"),
    eq(quotaCounters.periodKey, input.periodKey),
  ];
  if (input.orgId) {
    conditions.push(eq(quotaCounters.orgId, input.orgId));
  }
  const counters = await db
    .select()
    .from(quotaCounters)
    .where(and(...conditions))
    .orderBy(quotaCounters.orgId, quotaCounters.periodKey)
    .limit(input.limit);
  const repairs: QuotaCounterReconciliation[] = [];

  for (const counter of counters) {
    const [usage] = await db
      .select({
        quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.orgId, counter.orgId),
          eq(usageEvents.eventType, "review.credit"),
          eq(usageEvents.unit, "credit"),
          gte(usageEvents.occurredAt, counter.periodStart),
          lt(usageEvents.occurredAt, counter.periodEnd),
        ),
      );
    const usageQuantity = usage?.quantity ?? 0;
    if (usageQuantity === counter.usedQuantity) {
      continue;
    }

    await db
      .update(quotaCounters)
      .set({
        updatedAt: new Date(input.timestamp),
        usedQuantity: usageQuantity,
      })
      .where(eq(quotaCounters.quotaCounterId, counter.quotaCounterId));
    repairs.push({
      orgId: counter.orgId,
      periodKey: counter.periodKey,
      previousUsedQuantity: counter.usedQuantity,
      quotaCounterId: counter.quotaCounterId,
      repairedUsedQuantity: usageQuantity,
    });
  }

  return repairs;
}

/** Upserts a local subscription and billing-account mirror from provider subscription state. */
async function upsertProviderSubscriptionMirror(
  db: HeimdallDatabase,
  account: typeof billingAccounts.$inferSelect,
  subscription: ProviderSubscription,
  timestamp: string,
): Promise<void> {
  const billingPlanVersionId = subscription.planKey
    ? await activeBillingPlanVersionId(db, subscription.planKey)
    : account.currentPlanVersionId;
  const status = localSubscriptionStatus(subscription.status);
  const now = new Date(timestamp);

  await db
    .insert(subscriptions)
    .values({
      billingAccountId: account.billingAccountId,
      billingPlanVersionId: billingPlanVersionId ?? null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: optionalDate(subscription.currentPeriodEnd),
      currentPeriodStart: optionalDate(subscription.currentPeriodStart),
      provider: subscription.provider,
      providerSubscriptionId: subscription.providerSubscriptionId,
      quantity: subscription.quantity ?? null,
      rawProviderStatus: subscription.rawProviderStatus,
      status,
      subscriptionId: stableUsageId("sub", [
        subscription.provider,
        subscription.providerSubscriptionId,
      ]),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subscriptions.provider, subscriptions.providerSubscriptionId],
      set: {
        billingPlanVersionId: billingPlanVersionId ?? null,
        currentPeriodEnd: optionalDate(subscription.currentPeriodEnd),
        currentPeriodStart: optionalDate(subscription.currentPeriodStart),
        quantity: subscription.quantity ?? null,
        rawProviderStatus: subscription.rawProviderStatus,
        status,
        updatedAt: now,
      },
    });

  await db
    .update(billingAccounts)
    .set({
      billingMode: "self_serve",
      currentPlanKey: subscription.planKey ?? account.currentPlanKey,
      currentPlanVersionId: billingPlanVersionId ?? account.currentPlanVersionId,
      paymentStatus: paymentStatusFromProviderSubscription(status),
      provider: subscription.provider,
      providerCustomerId: subscription.providerCustomerId,
      status: billingAccountStatusFromProviderSubscription(status),
      updatedAt: now,
    })
    .where(eq(billingAccounts.billingAccountId, account.billingAccountId));
}

/** Summarizes usage events by stable rollup keys. */
export function summarizeUsageEvents(input: SummarizeUsageEventsInput): readonly UsageRollup[] {
  const rollupsByKey = new Map<string, MutableUsageRollup>();

  for (const event of input.events) {
    if (!eventIsWithinPeriod(event, input)) {
      continue;
    }

    const rollup = rollupKeyForEvent(event, input);
    const existing = rollupsByKey.get(rollup.key);

    if (existing) {
      existing.eventCount += 1;
      existing.quantity += event.quantity;
      existing.costMicros += event.costMicros ?? 0;
      continue;
    }

    rollupsByKey.set(rollup.key, {
      ...rollup.value,
      eventCount: 1,
      quantity: event.quantity,
      costMicros: event.costMicros ?? 0,
    });
  }

  return [...rollupsByKey.values()].sort(compareUsageRollups);
}

/** Evaluates whether one requested usage increment is within a quota. */
export function evaluateUsageQuota(input: UsageQuotaDecisionInput): UsageQuotaDecision {
  assertInteger("used", input.used);
  assertInteger("requested", input.requested);
  assertInteger("limit", input.limit);

  if (input.limit < 0) {
    throw new Error("Usage quota limit must not be negative.");
  }

  if (input.requested < 0) {
    throw new Error("Usage quota requested quantity must not be negative.");
  }

  const projected = input.used + input.requested;
  const remaining = input.limit - projected;
  const utilization =
    input.limit === 0 ? (projected === 0 ? 0 : Number.POSITIVE_INFINITY) : projected / input.limit;
  const warnAtPercent = input.warnAtPercent ?? 0.8;

  if (!Number.isFinite(warnAtPercent) || warnAtPercent < 0 || warnAtPercent > 1) {
    throw new Error("Usage quota warning threshold must be between 0 and 1.");
  }

  if (projected > input.limit) {
    return {
      quotaKey: input.quotaKey,
      periodKey: input.periodKey,
      allowed: false,
      status: "denied",
      reasonCode: "quota_exceeded",
      used: input.used,
      requested: input.requested,
      projected,
      limit: input.limit,
      remaining,
      utilization,
    };
  }

  if (utilization >= warnAtPercent) {
    return {
      quotaKey: input.quotaKey,
      periodKey: input.periodKey,
      allowed: true,
      status: "warn",
      reasonCode: "warning_threshold_reached",
      used: input.used,
      requested: input.requested,
      projected,
      limit: input.limit,
      remaining,
      utilization,
    };
  }

  return {
    quotaKey: input.quotaKey,
    periodKey: input.periodKey,
    allowed: true,
    status: "allowed",
    reasonCode: "under_limit",
    used: input.used,
    requested: input.requested,
    projected,
    limit: input.limit,
    remaining,
    utilization,
  };
}

/** Estimates token count for text with a deterministic provider-neutral heuristic. */
export function estimateTextTokenCount(value: string): number {
  const bytes = Buffer.byteLength(value, "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}

/** Estimates LLM input/output token usage and internal cost from a rate card. */
export function estimateLlmTokenUsage(input: EstimateLlmTokenUsageInput): LlmTokenUsageEstimate {
  const rateCard = input.rateCard ?? ZERO_COST_LLM_RATE_CARD;
  const promptText = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;
  const outputText =
    typeof input.output === "string" ? input.output : (JSON.stringify(input.output) ?? "");
  const inputTokens = estimateTextTokenCount(promptText);
  const outputTokens = estimateTextTokenCount(outputText);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, input.cachedInputTokens ?? 0));
  const billableInputTokens = inputTokens - cachedInputTokens;
  const cachedInputCostPer1k =
    rateCard.cachedInputTokenCostMicrosPer1k ?? rateCard.inputTokenCostMicrosPer1k;
  const costMicros =
    tokenCostMicros(billableInputTokens, rateCard.inputTokenCostMicrosPer1k) +
    tokenCostMicros(cachedInputTokens, cachedInputCostPer1k) +
    tokenCostMicros(outputTokens, rateCard.outputTokenCostMicrosPer1k);

  return {
    provider: rateCard.provider,
    model: rateCard.model,
    rateCardId: rateCard.rateCardId,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costMicros,
  };
}

type SeededPlanInput = {
  /** Stable plan key. */
  readonly planKey: string;
  /** Human-readable plan name. */
  readonly name: string;
  /** Human-readable plan description. */
  readonly description: string;
  /** Target plan audience. */
  readonly audience: string;
  /** Whether the plan can be shown to customers. */
  readonly public: boolean;
  /** Base subscription price in micro-USD. */
  readonly baseAmountMicros: number;
  /** Billing interval when the plan has a recurring price. */
  readonly billingInterval?: string;
  /** Included usage quantities. */
  readonly included: Readonly<Record<string, unknown>>;
  /** Limit defaults. */
  readonly limits: Readonly<Record<string, unknown>>;
  /** Feature defaults. */
  readonly features: Readonly<Record<string, unknown>>;
};

type SelectPlanCatalogEntryInput = {
  /** Available catalog entries. */
  readonly catalog: readonly BillingPlanCatalogEntry[];
  /** Requested plan key. */
  readonly planKey: string;
  /** Requested plan version ID. */
  readonly planVersionId?: string | undefined;
  /** Timestamp used for effective-window checks. */
  readonly now: string;
};

type ApplyEntitlementsInput = {
  /** Base feature values. */
  readonly features: Record<string, unknown>;
  /** Base limit values. */
  readonly limits: Record<string, number | boolean | string>;
  /** Entitlements to apply on top of plan defaults. */
  readonly entitlements: readonly Entitlement[];
};

type EntitlementDecisionInput = {
  /** Organization being checked. */
  readonly orgId: string;
  /** Feature key being checked. */
  readonly featureKey: string;
  /** Whether access is allowed. */
  readonly allowed: boolean;
  /** Stable decision reason. */
  readonly reason: EntitlementDecision["reason"];
  /** Decision source. */
  readonly source: EntitlementDecision["source"];
  /** Optional decision value. */
  readonly value?: unknown;
};

/** Creates one deterministic seeded plan entry. */
function seededPlan(input: SeededPlanInput): BillingPlanCatalogEntry {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const billingPlanId = `plan_${input.planKey}`;
  const billingPlanVersionId = `planv_${input.planKey}_2026_01`;

  return {
    plan: parseWithSchema("BillingPlan", BillingPlanSchema, {
      active: true,
      audience: input.audience,
      billingPlanId,
      createdAt,
      description: input.description,
      name: input.name,
      planKey: input.planKey,
      public: input.public,
      updatedAt: createdAt,
    }),
    version: parseWithSchema("BillingPlanVersion", BillingPlanVersionSchema, {
      active: true,
      baseAmountMicros: input.baseAmountMicros,
      ...(input.billingInterval ? { billingInterval: input.billingInterval } : {}),
      billingPlanId,
      billingPlanVersionId,
      createdAt,
      currency: "usd",
      effectiveFrom: createdAt,
      features: input.features,
      included: input.included,
      limits: input.limits,
      overage: {},
      version: "2026-01",
    }),
  };
}

/** Merges explicit catalog entries with seeded fallback plans. */
function mergePlanCatalog(
  entries: readonly BillingPlanCatalogEntry[],
): readonly BillingPlanCatalogEntry[] {
  const entriesByKey = new Map<string, BillingPlanCatalogEntry>();

  for (const entry of SEEDED_BILLING_PLAN_CATALOG) {
    entriesByKey.set(catalogEntryKey(entry), entry);
  }
  for (const entry of entries) {
    entriesByKey.set(catalogEntryKey(entry), entry);
  }

  return [...entriesByKey.values()].sort(compareCatalogEntries);
}

/** Returns a stable dedupe key for a catalog entry. */
function catalogEntryKey(entry: BillingPlanCatalogEntry): string {
  return `${entry.plan.planKey}:${entry.version.billingPlanVersionId}`;
}

/** Selects the best plan version for a snapshot compile. */
function selectPlanCatalogEntry(input: SelectPlanCatalogEntryInput): BillingPlanCatalogEntry {
  if (input.planVersionId) {
    const byVersion = input.catalog.find(
      (entry) => entry.version.billingPlanVersionId === input.planVersionId,
    );
    if (byVersion) {
      return byVersion;
    }
  }

  const activeEntries = input.catalog.filter(
    (entry) =>
      entry.plan.planKey === input.planKey &&
      entry.plan.active &&
      entry.version.active &&
      planVersionIsActive(entry.version, input.now),
  );

  if (activeEntries.length > 0) {
    return [...activeEntries].sort((left, right) =>
      right.version.effectiveFrom.localeCompare(left.version.effectiveFrom),
    )[0] as BillingPlanCatalogEntry;
  }

  const fallback = input.catalog.find((entry) => entry.plan.planKey === "free");
  if (!fallback) {
    throw new Error("Billing plan catalog must include a free fallback plan.");
  }

  return fallback;
}

/** Creates a deterministic free or internal fallback account. */
function defaultBillingAccount(
  orgId: string,
  planKey: string,
  version: BillingPlanVersion,
  now: string,
): BillingAccount {
  const suffix = orgId.startsWith("org_") ? orgId.slice("org_".length) : orgId;

  return parseWithSchema("BillingAccount", BillingAccountSchema, {
    billingAccountId: `bill_default_${suffix}`,
    billingMode: planKey === "internal" ? "internal" : "free",
    createdAt: now,
    currentPlanKey: planKey,
    currentPlanVersionId: version.billingPlanVersionId,
    orgId,
    paymentStatus: "not_required",
    provider: "internal",
    status: "active",
    updatedAt: now,
  });
}

/** Applies active entitlement rows to feature and limit records. */
function applyEntitlements(input: ApplyEntitlementsInput): {
  readonly features: Record<string, unknown>;
  readonly limits: Record<string, number | boolean | string>;
} {
  const features = { ...input.features };
  const limits = { ...input.limits };

  for (const entitlement of [...input.entitlements].sort(compareEntitlements)) {
    const value = entitlement.enabled ? entitlementValue(entitlement) : false;
    if (isLimitFeatureKey(entitlement.featureKey)) {
      if (isLimitValue(value)) {
        limits[entitlement.featureKey] = value;
      }
      continue;
    }

    features[entitlement.featureKey] = value;
  }

  return { features, limits };
}

/** Extracts the user-facing value from an entitlement row. */
function entitlementValue(entitlement: Entitlement): unknown {
  return Object.hasOwn(entitlement.value, "value") ? entitlement.value.value : entitlement.enabled;
}

/** Checks whether a key belongs in the plan limits record. */
function isLimitFeatureKey(featureKey: string): boolean {
  return (PLAN_LIMIT_FEATURE_KEYS as readonly string[]).includes(featureKey);
}

/** Checks whether a value can be stored in a plan snapshot limits record. */
function isLimitValue(value: unknown): value is number | boolean | string {
  return typeof value === "number" || typeof value === "boolean" || typeof value === "string";
}

/** Returns active entitlement rows according to source precedence. */
function mostRelevantEntitlement(
  entitlementsForFeature: readonly Entitlement[],
): Entitlement | undefined {
  const [entitlement] = [...entitlementsForFeature].sort((left, right) => {
    const sourceOrder =
      entitlementSourcePrecedence(right.source) - entitlementSourcePrecedence(left.source);
    return sourceOrder || right.effectiveFrom.localeCompare(left.effectiveFrom);
  });

  return entitlement;
}

/** Gives higher numbers to stronger entitlement sources. */
function entitlementSourcePrecedence(source: Entitlement["source"]): number {
  if (source === "manual" || source === "override") {
    return 50;
  }
  if (source === "enterprise_contract") {
    return 40;
  }
  if (source === "internal") {
    return 30;
  }
  if (source === "stripe") {
    return 20;
  }

  return 10;
}

/** Builds and validates one entitlement decision. */
function entitlementDecision(input: EntitlementDecisionInput): EntitlementDecision {
  return parseWithSchema("EntitlementDecision", EntitlementDecisionSchema, {
    allowed: input.allowed,
    featureKey: input.featureKey,
    orgId: input.orgId,
    reason: input.reason,
    source: input.source,
    ...(input.value === undefined ? {} : { value: input.value }),
  });
}

/** Returns true when a plan version applies at the given timestamp. */
function planVersionIsActive(version: BillingPlanVersion, now: string): boolean {
  return version.effectiveFrom <= now && (!version.effectiveTo || version.effectiveTo > now);
}

/** Returns true when an entitlement applies at the given timestamp. */
function entitlementIsActive(entitlement: Entitlement, now: string): boolean {
  return (
    entitlement.effectiveFrom <= now && (!entitlement.effectiveTo || entitlement.effectiveTo > now)
  );
}

/** Converts unknown JSON to an object record. */
function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Converts unknown JSON to the limited snapshot value shape. */
function limitRecordFromUnknown(value: unknown): Record<string, number | boolean | string> {
  const limits: Record<string, number | boolean | string> = {};
  for (const [key, entryValue] of Object.entries(recordFromUnknown(value))) {
    if (isLimitValue(entryValue)) {
      limits[key] = entryValue;
    }
  }

  return limits;
}

/** Parses a billing account database row through the public contract. */
function parseBillingAccountRow(row: {
  billingAccountId: string;
  orgId: string;
  billingMode: string;
  status: string;
  provider: string;
  providerCustomerId: string | null;
  billingEmail: string | null;
  billingName: string | null;
  billingCountry: string | null;
  currentPlanKey: string | null;
  currentPlanVersionId: string | null;
  trialEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;
  paymentStatus: string;
  createdAt: Date;
  updatedAt: Date;
}): BillingAccount {
  return parseWithSchema("BillingAccount", BillingAccountSchema, {
    billingAccountId: row.billingAccountId,
    billingMode: row.billingMode,
    ...(row.billingCountry ? { billingCountry: row.billingCountry } : {}),
    ...(row.billingEmail ? { billingEmail: row.billingEmail } : {}),
    ...(row.billingName ? { billingName: row.billingName } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.currentPlanKey ? { currentPlanKey: row.currentPlanKey } : {}),
    ...(row.currentPlanVersionId ? { currentPlanVersionId: row.currentPlanVersionId } : {}),
    ...(row.gracePeriodEndsAt ? { gracePeriodEndsAt: row.gracePeriodEndsAt.toISOString() } : {}),
    orgId: row.orgId,
    paymentStatus: row.paymentStatus,
    provider: row.provider,
    ...(row.providerCustomerId ? { providerCustomerId: row.providerCustomerId } : {}),
    status: row.status,
    ...(row.trialEndsAt ? { trialEndsAt: row.trialEndsAt.toISOString() } : {}),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses a subscription database row through the public contract. */
function parseSubscriptionRow(row: {
  subscriptionId: string;
  billingAccountId: string;
  provider: string;
  providerSubscriptionId: string | null;
  status: string;
  billingPlanVersionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
  trialStart: Date | null;
  trialEnd: Date | null;
  quantity: number | null;
  rawProviderStatus: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Subscription {
  return parseWithSchema("Subscription", SubscriptionSchema, {
    billingAccountId: row.billingAccountId,
    ...(row.billingPlanVersionId ? { billingPlanVersionId: row.billingPlanVersionId } : {}),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.currentPeriodEnd ? { currentPeriodEnd: row.currentPeriodEnd.toISOString() } : {}),
    ...(row.currentPeriodStart ? { currentPeriodStart: row.currentPeriodStart.toISOString() } : {}),
    provider: row.provider,
    ...(row.providerSubscriptionId ? { providerSubscriptionId: row.providerSubscriptionId } : {}),
    ...(row.quantity === null ? {} : { quantity: row.quantity }),
    rawProviderStatus: recordFromUnknown(row.rawProviderStatus),
    status: row.status,
    subscriptionId: row.subscriptionId,
    ...(row.trialEnd ? { trialEnd: row.trialEnd.toISOString() } : {}),
    ...(row.trialStart ? { trialStart: row.trialStart.toISOString() } : {}),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses a subscription item database row through the public contract. */
function parseSubscriptionItemRow(row: {
  subscriptionItemId: string;
  subscriptionId: string;
  providerItemId: string | null;
  providerPriceId: string | null;
  itemType: string;
  quantity: number | null;
  meterKey: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SubscriptionItem {
  return parseWithSchema("SubscriptionItem", SubscriptionItemSchema, {
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    itemType: row.itemType,
    ...(row.meterKey ? { meterKey: row.meterKey } : {}),
    ...(row.providerItemId ? { providerItemId: row.providerItemId } : {}),
    ...(row.providerPriceId ? { providerPriceId: row.providerPriceId } : {}),
    ...(row.quantity === null ? {} : { quantity: row.quantity }),
    subscriptionId: row.subscriptionId,
    subscriptionItemId: row.subscriptionItemId,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses a credit grant database row through the public contract. */
function parseCreditGrantRow(row: {
  creditGrantId: string;
  orgId: string;
  creditType: string;
  quantity: number;
  remainingQuantity: number;
  reason: string;
  source: string;
  sourceId: string | null;
  expiresAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CreditGrant {
  return parseWithSchema("CreditGrant", CreditGrantSchema, {
    createdAt: row.createdAt.toISOString(),
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
    creditGrantId: row.creditGrantId,
    creditType: row.creditType,
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    orgId: row.orgId,
    quantity: row.quantity,
    reason: row.reason,
    remainingQuantity: row.remainingQuantity,
    source: row.source,
    ...(row.sourceId ? { sourceId: row.sourceId } : {}),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses an invoice database row through the public contract. */
function parseInvoiceRow(row: {
  invoiceId: string;
  billingAccountId: string;
  provider: string;
  providerInvoiceId: string;
  status: string;
  currency: string;
  amountDueMicros: number;
  amountPaidMicros: number;
  amountRemainingMicros: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  rawProviderInvoice: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Invoice {
  return parseWithSchema("Invoice", InvoiceSchema, {
    amountDueMicros: row.amountDueMicros,
    amountPaidMicros: row.amountPaidMicros,
    amountRemainingMicros: row.amountRemainingMicros,
    billingAccountId: row.billingAccountId,
    createdAt: row.createdAt.toISOString(),
    currency: row.currency,
    ...(row.hostedInvoiceUrl ? { hostedInvoiceUrl: row.hostedInvoiceUrl } : {}),
    invoiceId: row.invoiceId,
    ...(row.invoicePdfUrl ? { invoicePdfUrl: row.invoicePdfUrl } : {}),
    ...(row.periodEnd ? { periodEnd: row.periodEnd.toISOString() } : {}),
    ...(row.periodStart ? { periodStart: row.periodStart.toISOString() } : {}),
    provider: row.provider,
    providerInvoiceId: row.providerInvoiceId,
    rawProviderInvoice: recordFromUnknown(row.rawProviderInvoice),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses a billing plan database row through the public contract. */
function parseBillingPlanRow(row: {
  billingPlanId: string;
  planKey: string;
  name: string;
  description: string | null;
  audience: string;
  public: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): BillingPlan {
  return parseWithSchema("BillingPlan", BillingPlanSchema, {
    active: row.active,
    audience: row.audience,
    billingPlanId: row.billingPlanId,
    createdAt: row.createdAt.toISOString(),
    ...(row.description ? { description: row.description } : {}),
    name: row.name,
    planKey: row.planKey,
    public: row.public,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses a billing plan version database row through the public contract. */
function parseBillingPlanVersionRow(row: {
  billingPlanVersionId: string;
  billingPlanId: string;
  version: string;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  provider: string | null;
  providerProductId: string | null;
  providerBasePriceId: string | null;
  currency: string;
  baseAmountMicros: number | null;
  billingInterval: string | null;
  included: unknown;
  limits: unknown;
  features: unknown;
  overage: unknown;
  createdAt: Date;
}): BillingPlanVersion {
  return parseWithSchema("BillingPlanVersion", BillingPlanVersionSchema, {
    active: row.active,
    ...(row.baseAmountMicros === null ? {} : { baseAmountMicros: row.baseAmountMicros }),
    ...(row.billingInterval ? { billingInterval: row.billingInterval } : {}),
    billingPlanId: row.billingPlanId,
    billingPlanVersionId: row.billingPlanVersionId,
    createdAt: row.createdAt.toISOString(),
    currency: row.currency,
    effectiveFrom: row.effectiveFrom.toISOString(),
    ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
    features: recordFromUnknown(row.features),
    included: recordFromUnknown(row.included),
    limits: recordFromUnknown(row.limits),
    overage: recordFromUnknown(row.overage),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.providerBasePriceId ? { providerBasePriceId: row.providerBasePriceId } : {}),
    ...(row.providerProductId ? { providerProductId: row.providerProductId } : {}),
    version: row.version,
  });
}

/** Parses an entitlement database row through the public contract. */
function parseEntitlementRow(row: {
  entitlementId: string;
  orgId: string;
  featureKey: string;
  enabled: boolean;
  source: string;
  sourceId: string | null;
  value: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Entitlement {
  return parseWithSchema("Entitlement", EntitlementSchema, {
    createdAt: row.createdAt.toISOString(),
    effectiveFrom: row.effectiveFrom.toISOString(),
    ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
    enabled: row.enabled,
    entitlementId: row.entitlementId,
    featureKey: row.featureKey,
    orgId: row.orgId,
    source: row.source,
    ...(row.sourceId ? { sourceId: row.sourceId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    value: recordFromUnknown(row.value),
  });
}

/** Sorts catalog entries deterministically. */
function compareCatalogEntries(
  left: BillingPlanCatalogEntry,
  right: BillingPlanCatalogEntry,
): number {
  return (
    left.plan.planKey.localeCompare(right.plan.planKey) ||
    left.version.effectiveFrom.localeCompare(right.version.effectiveFrom) ||
    left.version.billingPlanVersionId.localeCompare(right.version.billingPlanVersionId)
  );
}

/** Sorts entitlement rows by key, source precedence, and recency. */
function compareEntitlements(left: Entitlement, right: Entitlement): number {
  return (
    left.featureKey.localeCompare(right.featureKey) ||
    entitlementSourcePrecedence(right.source) - entitlementSourcePrecedence(left.source) ||
    right.effectiveFrom.localeCompare(left.effectiveFrom) ||
    left.entitlementId.localeCompare(right.entitlementId)
  );
}

/** Sorts subscriptions by current period recency, update time, and ID. */
function compareSubscriptions(left: Subscription, right: Subscription): number {
  return (
    (right.currentPeriodEnd ?? "").localeCompare(left.currentPeriodEnd ?? "") ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.subscriptionId.localeCompare(right.subscriptionId)
  );
}

/** Sorts subscription items by active state, type, and ID. */
function compareSubscriptionItems(left: SubscriptionItem, right: SubscriptionItem): number {
  return (
    Number(right.active) - Number(left.active) ||
    left.itemType.localeCompare(right.itemType) ||
    left.subscriptionItemId.localeCompare(right.subscriptionItemId)
  );
}

/** Sorts credit grants by expiry, creation time, and ID. */
function compareCreditGrants(left: CreditGrant, right: CreditGrant): number {
  return (
    (left.expiresAt ?? "9999-12-31T23:59:59.999Z").localeCompare(
      right.expiresAt ?? "9999-12-31T23:59:59.999Z",
    ) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.creditGrantId.localeCompare(right.creditGrantId)
  );
}

/** Sorts invoices by period recency, creation time, and ID. */
function compareInvoices(left: Invoice, right: Invoice): number {
  return (
    (right.periodEnd ?? "").localeCompare(left.periodEnd ?? "") ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.invoiceId.localeCompare(right.invoiceId)
  );
}

/** Sorts billing accounts by organization and account ID. */
function compareBillingAccounts(left: BillingAccount, right: BillingAccount): number {
  return (
    left.orgId.localeCompare(right.orgId) ||
    left.billingAccountId.localeCompare(right.billingAccountId)
  );
}

/** Sorts usage events by occurrence time and event ID. */
function compareUsageEvents(left: UsageEvent, right: UsageEvent): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.usageEventId.localeCompare(right.usageEventId)
  );
}

/** Sorts billing meter events by status, period, and ID. */
function compareBillingMeterEvents(left: BillingMeterEvent, right: BillingMeterEvent): number {
  return (
    left.status.localeCompare(right.status) ||
    left.periodStart.localeCompare(right.periodStart) ||
    left.billingMeterEventId.localeCompare(right.billingMeterEventId)
  );
}

/** Returns true when a billing account can receive provider meter events. */
function isBillableMeterAccount(
  account: BillingAccount,
  provider: string,
): account is BillingAccount & {
  readonly providerCustomerId: string;
} {
  return (
    account.billingMode === "self_serve" &&
    account.provider === provider &&
    Boolean(account.providerCustomerId) &&
    ["active", "trialing", "past_due", "grace_period"].includes(account.status)
  );
}

/** Checks whether one usage event contributes to a billing meter for one account. */
function meterEventMatchesAccountAndConfig(
  event: UsageEvent,
  account: BillingAccount,
  config: BillingMeterConfig,
  period: Pick<PlanBillingMeterEventsInput, "periodEnd" | "periodStart">,
): boolean {
  return (
    event.orgId === account.orgId &&
    event.eventType === config.usageEventType &&
    (!config.unit || event.unit === config.unit) &&
    event.occurredAt >= period.periodStart &&
    event.occurredAt < period.periodEnd
  );
}

/** Returns the stable local ID for one billing meter event. */
function billingMeterEventIdFromInput(input: {
  readonly account: BillingAccount;
  readonly config: BillingMeterConfig;
  readonly provider: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}): string {
  return stableUsageId("bmtr", [
    "billing_meter_event",
    input.provider,
    input.account.billingAccountId,
    input.config.meterKey,
    input.periodStart,
    input.periodEnd,
  ]);
}

/** Returns the provider idempotency key for one planned meter event. */
function billingMeterIdempotencyKey(input: {
  readonly account: BillingAccount;
  readonly config: BillingMeterConfig;
  readonly provider: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}): string {
  return [
    `${input.provider}_meter`,
    input.account.orgId,
    input.config.meterKey,
    input.periodStart,
    input.periodEnd,
  ].join(":");
}

/** Returns the provider timestamp for one meter event send attempt. */
function providerMeterTimestamp(event: BillingMeterEvent, now: string): string {
  const nowMs = Date.parse(now);
  const eventPeriodEndMs = Date.parse(event.periodEnd);
  if (Number.isNaN(nowMs) || Number.isNaN(eventPeriodEndMs)) {
    return now;
  }

  return new Date(Math.min(nowMs, eventPeriodEndMs - 1_000)).toISOString();
}

/** Converts provider send errors into safe billing meter row fields. */
function providerError(error: unknown): { readonly code?: string; readonly message: string } {
  const record = recordFromUnknown(error);
  const code = stringFromRecord(record, "code") ?? stringFromRecord(record, "type");
  return {
    ...(code ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Returns the reconciliation period from explicit dates, a period key, or the current month. */
function reconciliationPeriod(
  input: Pick<ReconcileBillingStateInput, "periodEnd" | "periodKey" | "periodStart">,
  now: string,
): QuotaPeriod {
  if (input.periodStart && input.periodEnd) {
    return {
      periodEnd: input.periodEnd,
      periodKey: input.periodKey ?? monthlyQuotaPeriod(input.periodStart).periodKey,
      periodStart: input.periodStart,
    };
  }

  if (input.periodKey) {
    return periodFromMonthKey(input.periodKey);
  }

  return monthlyQuotaPeriod(now);
}

/** Returns the UTC monthly quota period for a YYYY-MM key. */
function periodFromMonthKey(periodKey: string): QuotaPeriod {
  const match = /^(?<year>\d{4})-(?<month>\d{2})$/.exec(periodKey);
  const year = Number(match?.groups?.year);
  const month = Number(match?.groups?.month);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new Error("Billing reconciliation periodKey must use YYYY-MM.");
  }

  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));
  return {
    periodEnd: periodEnd.toISOString(),
    periodKey,
    periodStart: periodStart.toISOString(),
  };
}

/** Returns a bounded reconciliation row limit. */
function boundedReconciliationLimit(limit: number | undefined): number {
  if (!limit || !Number.isSafeInteger(limit)) {
    return 100;
  }

  return Math.min(500, Math.max(1, limit));
}

/** Gets the active local plan version for one provider plan key. */
async function activeBillingPlanVersionId(
  db: HeimdallDatabase,
  planKey: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ billingPlanVersionId: billingPlanVersions.billingPlanVersionId })
    .from(billingPlanVersions)
    .innerJoin(billingPlans, eq(billingPlanVersions.billingPlanId, billingPlans.billingPlanId))
    .where(and(eq(billingPlans.planKey, planKey), eq(billingPlanVersions.active, true)))
    .limit(1);

  return row?.billingPlanVersionId;
}

/** Maps provider subscription states into local subscription states. */
function localSubscriptionStatus(status: string): string {
  switch (status) {
    case "active":
    case "incomplete":
    case "incomplete_expired":
    case "past_due":
    case "paused":
    case "trialing":
    case "unpaid":
      return status;
    case "canceled":
      return "cancelled";
    default:
      return "past_due";
  }
}

/** Maps local subscription status into local billing account status. */
function billingAccountStatusFromProviderSubscription(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "cancelled":
      return "cancelled";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "manual_review";
  }
}

/** Maps local subscription status into local payment status. */
function paymentStatusFromProviderSubscription(status: string): string {
  switch (status) {
    case "active":
    case "trialing":
      return "current";
    case "cancelled":
      return "not_required";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "failed";
  }
}

/** Converts an optional ISO timestamp into a Date for Drizzle writes. */
function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Reads a string from a plain record. */
function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Evaluates a reservation request against a counter. */
function evaluateCounterReservation(
  input: CheckQuotaInput,
  counter: QuotaCounter,
): UsageQuotaDecision {
  return evaluateUsageQuota({
    limit: input.limit,
    periodKey: input.periodKey,
    quotaKey: input.quotaKey,
    requested: input.requested,
    used: counter.usedQuantity + counter.reservedQuantity,
    ...(input.warnAtPercent === undefined ? {} : { warnAtPercent: input.warnAtPercent }),
  });
}

/** Returns an allowed decision for an existing idempotent reservation. */
function allowedReservationDecision(
  input: CheckQuotaInput,
  counter: QuotaCounter,
): UsageQuotaDecision {
  return evaluateUsageQuota({
    limit: input.limit,
    periodKey: input.periodKey,
    quotaKey: input.quotaKey,
    requested: 0,
    used: counter.usedQuantity + counter.reservedQuantity,
    ...(input.warnAtPercent === undefined ? {} : { warnAtPercent: input.warnAtPercent }),
  });
}

/** Returns a stable quota counter ID. */
function quotaCounterIdFromInput(
  input: Pick<CheckQuotaInput, "orgId" | "periodKey" | "quotaKey">,
): string {
  return stableUsageId("qctr", ["quota_counter", input.orgId, input.quotaKey, input.periodKey]);
}

/** Returns a stable quota reservation ID. */
function quotaReservationIdFromInput(
  input: Pick<ReserveQuotaInput, "orgId" | "periodKey" | "quotaKey" | "sourceId" | "sourceType">,
): string {
  return stableUsageId("qres", [
    "quota_reservation",
    input.orgId,
    input.quotaKey,
    input.periodKey,
    input.sourceType,
    input.sourceId,
  ]);
}

/** Returns a stable quota counter scope key. */
function quotaCounterScope(
  input: Pick<CheckQuotaInput, "orgId" | "periodKey" | "quotaKey">,
): string {
  return `${input.orgId}:${input.quotaKey}:${input.periodKey}`;
}

/** Returns a deterministic prefixed ID from parts. */
function stableUsageId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

/** Returns a reservation expiry six hours after the timestamp. */
function defaultReservationExpiry(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 6 * 60 * 60 * 1_000).toISOString();
}

/** Parses a quota counter through its public contract. */
function parseQuotaCounter(value: unknown): QuotaCounter {
  return parseWithSchema("QuotaCounter", QuotaCounterSchema, withoutUndefined(value));
}

/** Parses a quota reservation through its public contract. */
function parseQuotaReservation(value: unknown): QuotaReservation {
  return parseWithSchema("QuotaReservation", QuotaReservationSchema, withoutUndefined(value));
}

/** Parses a billing meter event through its public contract. */
function parseBillingMeterEvent(value: unknown): BillingMeterEvent {
  return parseWithSchema("BillingMeterEvent", BillingMeterEventSchema, withoutUndefined(value));
}

/** Removes undefined values before exact TypeBox validation. */
function withoutUndefined(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) => entryValue !== undefined,
    ),
  );
}

/** Requires a map value by key. */
function requireMapValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (!value) {
    throw new Error(`Expected map value ${key} to exist.`);
  }

  return value;
}

/** Requires a quota reservation row. */
function requireReservation(value: QuotaReservation | undefined): QuotaReservation {
  if (!value) {
    throw new Error("Quota reservation was not found.");
  }

  return value;
}

/** Gets or creates a durable quota counter row. */
async function getOrCreateQuotaCounter(
  db: HeimdallDatabase,
  input: CheckQuotaInput,
): Promise<QuotaCounter> {
  const timestamp = input.now ?? new Date().toISOString();
  const [row] = await db
    .insert(quotaCounters)
    .values({
      limitQuantity: input.limit,
      orgId: input.orgId,
      periodEnd: new Date(input.periodEnd),
      periodKey: input.periodKey,
      periodStart: new Date(input.periodStart),
      quotaCounterId: quotaCounterIdFromInput(input),
      quotaKey: input.quotaKey,
      source: input.source ?? "quota_service",
      updatedAt: new Date(timestamp),
    })
    .onConflictDoUpdate({
      target: [quotaCounters.orgId, quotaCounters.quotaKey, quotaCounters.periodKey],
      set: {
        limitQuantity: input.limit,
        periodEnd: new Date(input.periodEnd),
        periodStart: new Date(input.periodStart),
        source: input.source ?? "quota_service",
        updatedAt: new Date(timestamp),
      },
    })
    .returning();

  return parseQuotaCounterRow(requireReturnedRow(row));
}

/** Reserves durable quota inside a transaction. */
async function reserveQuota(
  db: HeimdallDatabase,
  input: ReserveQuotaInput & {
    readonly quotaCounterId: string;
    readonly quotaReservationId: string;
  },
): Promise<ReserveQuotaResult> {
  const counter = await getOrCreateQuotaCounter(db, input);
  const existing = await getQuotaReservationById(db, input.quotaReservationId);
  if (existing?.status === "reserved" || existing?.status === "consumed") {
    return {
      counter,
      decision: allowedReservationDecision(input, counter),
      reservation: existing,
      reserved: false,
    };
  }

  const decision = evaluateCounterReservation(input, counter);
  if (!decision.allowed) {
    return { counter, decision, reserved: false };
  }

  const timestamp = input.now ?? new Date().toISOString();
  const expiresAt = input.expiresAt ?? defaultReservationExpiry(timestamp);
  const [reservationRow] = await db
    .insert(quotaReservations)
    .values({
      expiresAt: new Date(expiresAt),
      orgId: input.orgId,
      quantity: input.requested,
      quotaCounterId: counter.quotaCounterId,
      quotaReservationId: input.quotaReservationId,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      status: "reserved",
      updatedAt: new Date(timestamp),
    })
    .onConflictDoUpdate({
      target: [
        quotaReservations.sourceType,
        quotaReservations.sourceId,
        quotaReservations.quotaCounterId,
      ],
      set: {
        consumedAt: null,
        expiresAt: new Date(expiresAt),
        quantity: input.requested,
        releasedAt: null,
        status: "reserved",
        updatedAt: new Date(timestamp),
      },
    })
    .returning();
  const [counterRow] = await db
    .update(quotaCounters)
    .set({
      reservedQuantity: sql`${quotaCounters.reservedQuantity} + ${input.requested}`,
      updatedAt: new Date(timestamp),
    })
    .where(eq(quotaCounters.quotaCounterId, counter.quotaCounterId))
    .returning();

  return {
    counter: parseQuotaCounterRow(requireReturnedRow(counterRow)),
    decision,
    reservation: parseQuotaReservationRow(requireReturnedRow(reservationRow)),
    reserved: true,
  };
}

/** Consumes a durable reservation inside a transaction. */
async function consumeQuotaReservation(
  db: HeimdallDatabase,
  input: ConsumeQuotaReservationInput,
): Promise<QuotaReservation> {
  const reservation = requireReservation(
    await getQuotaReservationById(db, input.quotaReservationId),
  );
  if (reservation.status === "consumed") {
    return reservation;
  }
  if (reservation.status !== "reserved") {
    throw new Error(`Quota reservation ${reservation.quotaReservationId} cannot be consumed.`);
  }

  const timestamp = input.now ?? new Date().toISOString();
  const [reservationRow] = await db
    .update(quotaReservations)
    .set({
      consumedAt: new Date(timestamp),
      status: "consumed",
      updatedAt: new Date(timestamp),
    })
    .where(eq(quotaReservations.quotaReservationId, reservation.quotaReservationId))
    .returning();
  await db
    .update(quotaCounters)
    .set({
      reservedQuantity: sql`greatest(${quotaCounters.reservedQuantity} - ${reservation.quantity}, 0)`,
      usedQuantity: sql`${quotaCounters.usedQuantity} + ${reservation.quantity}`,
      updatedAt: new Date(timestamp),
    })
    .where(eq(quotaCounters.quotaCounterId, reservation.quotaCounterId));

  return parseQuotaReservationRow(requireReturnedRow(reservationRow));
}

/** Releases a durable reservation inside a transaction. */
async function releaseQuotaReservation(
  db: HeimdallDatabase,
  input: ReleaseQuotaReservationInput,
): Promise<QuotaReservation> {
  const reservation = requireReservation(
    await getQuotaReservationById(db, input.quotaReservationId),
  );
  if (reservation.status === "released" || reservation.status !== "reserved") {
    return reservation;
  }

  const timestamp = input.now ?? new Date().toISOString();
  const [reservationRow] = await db
    .update(quotaReservations)
    .set({
      releasedAt: new Date(timestamp),
      status: "released",
      updatedAt: new Date(timestamp),
    })
    .where(eq(quotaReservations.quotaReservationId, reservation.quotaReservationId))
    .returning();
  await db
    .update(quotaCounters)
    .set({
      reservedQuantity: sql`greatest(${quotaCounters.reservedQuantity} - ${reservation.quantity}, 0)`,
      updatedAt: new Date(timestamp),
    })
    .where(eq(quotaCounters.quotaCounterId, reservation.quotaCounterId));

  return parseQuotaReservationRow(requireReturnedRow(reservationRow));
}

/** Gets one quota reservation row by ID. */
async function getQuotaReservationById(
  db: HeimdallDatabase,
  quotaReservationId: string,
): Promise<QuotaReservation | undefined> {
  const [row] = await db
    .select()
    .from(quotaReservations)
    .where(eq(quotaReservations.quotaReservationId, quotaReservationId))
    .limit(1);

  return row ? parseQuotaReservationRow(row) : undefined;
}

/** Parses a quota counter database row. */
function parseQuotaCounterRow(row: {
  quotaCounterId: string;
  orgId: string;
  quotaKey: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  usedQuantity: number;
  reservedQuantity: number;
  limitQuantity: number | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): QuotaCounter {
  return parseQuotaCounter({
    createdAt: row.createdAt.toISOString(),
    ...(row.limitQuantity === null ? {} : { limitQuantity: row.limitQuantity }),
    orgId: row.orgId,
    periodEnd: row.periodEnd.toISOString(),
    periodKey: row.periodKey,
    periodStart: row.periodStart.toISOString(),
    quotaCounterId: row.quotaCounterId,
    quotaKey: row.quotaKey,
    reservedQuantity: row.reservedQuantity,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
    usedQuantity: row.usedQuantity,
  });
}

/** Parses a quota reservation database row. */
function parseQuotaReservationRow(row: {
  quotaReservationId: string;
  orgId: string;
  quotaCounterId: string;
  sourceType: string;
  sourceId: string;
  quantity: number;
  status: string;
  expiresAt: Date;
  consumedAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): QuotaReservation {
  return parseQuotaReservation({
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    orgId: row.orgId,
    quantity: row.quantity,
    quotaCounterId: row.quotaCounterId,
    quotaReservationId: row.quotaReservationId,
    ...(row.releasedAt ? { releasedAt: row.releasedAt.toISOString() } : {}),
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Requires a returned row from an insert or update query. */
function requireReturnedRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Expected database mutation to return a row.");
  }

  return row;
}

type MutableUsageRollup = Omit<UsageRollup, "eventCount" | "quantity" | "costMicros"> & {
  eventCount: number;
  quantity: number;
  costMicros: number;
};

function assertInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Usage event ${name} must be a safe integer.`);
  }
}

function tokenCostMicros(tokens: number, microsPer1k: number): number {
  assertInteger("tokens", tokens);
  assertInteger("microsPer1k", microsPer1k);
  return Math.ceil((tokens * microsPer1k) / 1_000);
}

function usageEventIdFromKey(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `usage_${digest}`;
}

function randomUsageEventId(): string {
  return `usage_${randomUUID().replaceAll("-", "")}`;
}

/** Converts a billing account contract object to a Drizzle insert shape. */
function toBillingAccountInsert(account: BillingAccount) {
  return {
    billingAccountId: account.billingAccountId,
    billingCountry: account.billingCountry,
    billingEmail: account.billingEmail,
    billingMode: account.billingMode,
    billingName: account.billingName,
    createdAt: new Date(account.createdAt),
    currentPlanKey: account.currentPlanKey,
    currentPlanVersionId: account.currentPlanVersionId,
    gracePeriodEndsAt: account.gracePeriodEndsAt ? new Date(account.gracePeriodEndsAt) : undefined,
    orgId: account.orgId,
    paymentStatus: account.paymentStatus,
    provider: account.provider,
    providerCustomerId: account.providerCustomerId,
    status: account.status,
    trialEndsAt: account.trialEndsAt ? new Date(account.trialEndsAt) : undefined,
    updatedAt: new Date(account.updatedAt),
  };
}

/** Converts a billing meter event contract object to a Drizzle insert shape. */
function toBillingMeterEventInsert(event: BillingMeterEvent) {
  return {
    attemptCount: event.attemptCount,
    billingAccountId: event.billingAccountId,
    billingMeterEventId: event.billingMeterEventId,
    createdAt: new Date(event.createdAt),
    idempotencyKey: event.idempotencyKey,
    lastErrorCode: event.lastErrorCode,
    lastErrorMessage: event.lastErrorMessage,
    meterKey: event.meterKey,
    orgId: event.orgId,
    periodEnd: new Date(event.periodEnd),
    periodKey: event.periodKey,
    periodStart: new Date(event.periodStart),
    provider: event.provider,
    providerCustomerId: event.providerCustomerId,
    providerEventName: event.providerEventName,
    providerMeterEventId: event.providerMeterEventId,
    quantity: event.quantity,
    sentAt: event.sentAt ? new Date(event.sentAt) : undefined,
    sourceUsageEventIds: event.sourceUsageEventIds,
    status: event.status,
    updatedAt: new Date(event.updatedAt),
  };
}

function toUsageEventInsert(event: UsageEvent) {
  return {
    usageEventId: event.usageEventId,
    orgId: event.orgId,
    repoId: event.repoId,
    reviewRunId: event.reviewRunId,
    eventType: event.eventType,
    quantity: event.quantity,
    unit: event.unit,
    costMicros: event.costMicros ?? 0,
    occurredAt: new Date(event.occurredAt),
    metadata: event.metadata,
  };
}

/** Parses a billing meter event database row through the public contract. */
function parseBillingMeterEventRow(row: {
  billingMeterEventId: string;
  billingAccountId: string;
  orgId: string;
  provider: string;
  providerCustomerId: string;
  meterKey: string;
  providerEventName: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  quantity: number;
  idempotencyKey: string;
  status: string;
  providerMeterEventId: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sourceUsageEventIds: unknown;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): BillingMeterEvent {
  return parseBillingMeterEvent({
    attemptCount: row.attemptCount,
    billingAccountId: row.billingAccountId,
    billingMeterEventId: row.billingMeterEventId,
    createdAt: row.createdAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.lastErrorMessage ? { lastErrorMessage: row.lastErrorMessage } : {}),
    meterKey: row.meterKey,
    orgId: row.orgId,
    periodEnd: row.periodEnd.toISOString(),
    periodKey: row.periodKey,
    periodStart: row.periodStart.toISOString(),
    provider: row.provider,
    providerCustomerId: row.providerCustomerId,
    providerEventName: row.providerEventName,
    ...(row.providerMeterEventId ? { providerMeterEventId: row.providerMeterEventId } : {}),
    quantity: row.quantity,
    ...(row.sentAt ? { sentAt: row.sentAt.toISOString() } : {}),
    sourceUsageEventIds: stringArrayFromUnknown(row.sourceUsageEventIds),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Converts unknown JSON into a string array. */
function stringArrayFromUnknown(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

type ActiveReviewCreditGrantQuantityInput = {
  /** Credit grants to inspect. */
  readonly creditGrants: readonly CreditGrant[];
  /** Organization that owns the period. */
  readonly orgId: string;
  /** Timestamp used for expiry checks. */
  readonly now: string;
};

type SummarizeUsagePeriodRowsInput = {
  /** Usage events already filtered to the target org and period. */
  readonly events: readonly UsageEvent[];
  /** Whether to include internal cost fields in each row. */
  readonly includeInternalCost: boolean;
};

type SummarizeUsagePeriodMeterEventsInput = {
  /** Meter event rows to summarize. */
  readonly billingMeterEvents: readonly BillingMeterEvent[];
  /** Organization that owns the period. */
  readonly orgId: string;
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
};

type SummarizeUsagePeriodInvoicesInput = {
  /** Invoice mirrors to summarize. */
  readonly invoices: readonly Invoice[];
  /** Inclusive period start. */
  readonly periodStart: string;
  /** Exclusive period end. */
  readonly periodEnd: string;
};

type MutableUsagePeriodRepoSummary = Omit<
  UsagePeriodRepoSummary,
  "costMicros" | "eventCount" | "reviewCredits" | "reviewRuns"
> & {
  /** Mutable completed review usage quantity. */
  reviewRuns: number;
  /** Mutable review credit usage quantity. */
  reviewCredits: number;
  /** Mutable ledger event count. */
  eventCount: number;
  /** Mutable internal cost estimate. */
  costMicros: number;
};

type MutableUsagePeriodCategorySummary = Omit<
  UsagePeriodCategorySummary,
  "costMicros" | "eventCount" | "quantity"
> & {
  /** Mutable usage quantity. */
  quantity: number;
  /** Mutable ledger event count. */
  eventCount: number;
  /** Mutable internal cost estimate. */
  costMicros: number;
};

/** Returns included review credits from an explicit override or plan limit. */
function includedReviewCredits(input: BuildUsagePeriodSummaryInput): number {
  if (input.includedReviewCredits !== undefined) {
    assertInteger("includedReviewCredits", input.includedReviewCredits);
    return Math.max(0, input.includedReviewCredits);
  }

  const value = input.planSnapshot?.limits["reviews.max_monthly_review_credits"];
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}

/** Sums active review credit grants for one organization. */
function activeReviewCreditGrantQuantity(input: ActiveReviewCreditGrantQuantityInput): number {
  return input.creditGrants
    .filter(
      (grant) =>
        grant.orgId === input.orgId &&
        grant.creditType === "review_credit" &&
        (!grant.expiresAt || grant.expiresAt > input.now),
    )
    .reduce((sum, grant) => sum + Math.max(0, grant.remainingQuantity), 0);
}

/** Returns bounded quota utilization for customer-facing usage displays. */
function utilizationFor(used: number, limit: number): number {
  if (limit === 0) {
    return used === 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  return used / limit;
}

/** Returns the review credit state for one usage period. */
function reviewCreditStatus(input: {
  /** Total customer-facing allowance. */
  readonly limit: number;
  /** Used review credits. */
  readonly used: number;
  /** Warning threshold before over-limit state. */
  readonly warnAtPercent?: number;
}): UsagePeriodReviewCreditSummary["status"] {
  if (input.used > input.limit) {
    return "over_limit";
  }

  const warnAtPercent = input.warnAtPercent ?? 0.8;
  if (!Number.isFinite(warnAtPercent) || warnAtPercent < 0 || warnAtPercent > 1) {
    throw new Error("Usage summary warning threshold must be between 0 and 1.");
  }

  return utilizationFor(input.used, input.limit) >= warnAtPercent ? "warning" : "ok";
}

/** Summarizes period usage by repository without exposing model-level details. */
function summarizeUsagePeriodByRepo(
  input: SummarizeUsagePeriodRowsInput,
): readonly UsagePeriodRepoSummary[] {
  const rowsByRepoId = new Map<string, MutableUsagePeriodRepoSummary>();

  for (const event of input.events) {
    if (!event.repoId) {
      continue;
    }

    const row =
      rowsByRepoId.get(event.repoId) ??
      ({
        costMicros: 0,
        eventCount: 0,
        repoId: event.repoId,
        reviewCredits: 0,
        reviewRuns: 0,
      } satisfies MutableUsagePeriodRepoSummary);
    row.eventCount += 1;
    row.costMicros += event.costMicros ?? 0;
    if (event.eventType === "review.run") {
      row.reviewRuns += event.quantity;
    }
    if (event.eventType === "review.credit" && event.unit === "credit") {
      row.reviewCredits += event.quantity;
    }
    rowsByRepoId.set(event.repoId, row);
  }

  return [...rowsByRepoId.values()]
    .map((row) => usagePeriodRepoSummary(row, input.includeInternalCost))
    .sort(compareUsagePeriodRepoSummaries);
}

/** Converts one mutable repository summary into the public summary shape. */
function usagePeriodRepoSummary(
  row: MutableUsagePeriodRepoSummary,
  includeInternalCost: boolean,
): UsagePeriodRepoSummary {
  return {
    ...(includeInternalCost ? { costMicros: row.costMicros } : {}),
    eventCount: row.eventCount,
    repoId: row.repoId,
    reviewCredits: row.reviewCredits,
    reviewRuns: row.reviewRuns,
  };
}

/** Summarizes period usage by customer-safe product category. */
function summarizeUsagePeriodByCategory(
  input: SummarizeUsagePeriodRowsInput,
): readonly UsagePeriodCategorySummary[] {
  const rowsByKey = new Map<string, MutableUsagePeriodCategorySummary>();

  for (const event of input.events) {
    const category = usageCategoryForEventType(event.eventType);
    const key = `${category}:${event.unit}`;
    const row =
      rowsByKey.get(key) ??
      ({
        category,
        costMicros: 0,
        eventCount: 0,
        quantity: 0,
        unit: event.unit,
      } satisfies MutableUsagePeriodCategorySummary);
    row.eventCount += 1;
    row.quantity += event.quantity;
    row.costMicros += event.costMicros ?? 0;
    rowsByKey.set(key, row);
  }

  return [...rowsByKey.values()]
    .map((row) => usagePeriodCategorySummary(row, input.includeInternalCost))
    .sort(compareUsagePeriodCategorySummaries);
}

/** Converts one mutable category summary into the public summary shape. */
function usagePeriodCategorySummary(
  row: MutableUsagePeriodCategorySummary,
  includeInternalCost: boolean,
): UsagePeriodCategorySummary {
  return {
    category: row.category,
    ...(includeInternalCost ? { costMicros: row.costMicros } : {}),
    eventCount: row.eventCount,
    quantity: row.quantity,
    unit: row.unit,
  };
}

/** Returns a stable product category for a usage event type. */
function usageCategoryForEventType(eventType: UsageEventType): string {
  if (eventType.startsWith("review.")) {
    return "review";
  }
  if (eventType.startsWith("index.")) {
    return "indexing";
  }
  if (eventType.startsWith("embedding.")) {
    return "embedding";
  }
  if (eventType.startsWith("llm.")) {
    return "llm";
  }
  if (eventType.startsWith("github.")) {
    return "github";
  }
  if (eventType.startsWith("storage.")) {
    return "storage";
  }
  if (eventType.startsWith("worker.")) {
    return "worker";
  }

  return "other";
}

/** Summarizes provider meter rows that belong to one usage period. */
function summarizeUsagePeriodMeterEvents(
  input: SummarizeUsagePeriodMeterEventsInput,
): readonly UsagePeriodMeterSummary[] {
  return input.billingMeterEvents
    .filter(
      (event) =>
        event.orgId === input.orgId &&
        event.periodStart === input.periodStart &&
        event.periodEnd === input.periodEnd,
    )
    .sort(compareBillingMeterEvents)
    .map((event) => ({
      ...(event.lastErrorCode ? { lastErrorCode: event.lastErrorCode } : {}),
      ...(event.lastErrorMessage ? { lastErrorMessage: event.lastErrorMessage } : {}),
      meterKey: event.meterKey,
      provider: event.provider,
      ...(event.providerMeterEventId ? { providerMeterEventId: event.providerMeterEventId } : {}),
      quantity: event.quantity,
      ...(event.sentAt ? { sentAt: event.sentAt } : {}),
      sourceUsageEventCount: event.sourceUsageEventIds.length,
      status: event.status,
    }));
}

/** Summarizes invoice mirrors that overlap one usage period. */
function summarizeUsagePeriodInvoices(
  input: SummarizeUsagePeriodInvoicesInput,
): readonly UsagePeriodInvoiceSummary[] {
  return input.invoices
    .filter((invoice) => invoiceOverlapsPeriod(invoice, input.periodStart, input.periodEnd))
    .sort(compareInvoices)
    .map((invoice) => ({
      amountDueMicros: invoice.amountDueMicros,
      amountPaidMicros: invoice.amountPaidMicros,
      amountRemainingMicros: invoice.amountRemainingMicros,
      currency: invoice.currency,
      ...(invoice.hostedInvoiceUrl ? { hostedInvoiceUrl: invoice.hostedInvoiceUrl } : {}),
      invoiceId: invoice.invoiceId,
      ...(invoice.invoicePdfUrl ? { invoicePdfUrl: invoice.invoicePdfUrl } : {}),
      provider: invoice.provider,
      providerInvoiceId: invoice.providerInvoiceId,
      status: invoice.status,
    }));
}

/** Returns true when an invoice period intersects the requested usage period. */
function invoiceOverlapsPeriod(invoice: Invoice, periodStart: string, periodEnd: string): boolean {
  if (!invoice.periodStart || !invoice.periodEnd) {
    return false;
  }

  return invoice.periodStart < periodEnd && invoice.periodEnd > periodStart;
}

/** Sorts repository usage summaries by customer-visible usage and repository ID. */
function compareUsagePeriodRepoSummaries(
  left: UsagePeriodRepoSummary,
  right: UsagePeriodRepoSummary,
): number {
  return (
    right.reviewCredits - left.reviewCredits ||
    right.reviewRuns - left.reviewRuns ||
    left.repoId.localeCompare(right.repoId)
  );
}

/** Sorts category usage summaries by category and unit. */
function compareUsagePeriodCategorySummaries(
  left: UsagePeriodCategorySummary,
  right: UsagePeriodCategorySummary,
): number {
  return left.category.localeCompare(right.category) || left.unit.localeCompare(right.unit);
}

function parseUsageEventRow(row: {
  usageEventId: string;
  orgId: string;
  repoId: string | null;
  reviewRunId: string | null;
  eventType: string;
  quantity: number;
  unit: string;
  costMicros: number;
  occurredAt: Date;
  metadata: unknown;
}): UsageEvent {
  return parseWithSchema("UsageEvent", UsageEventSchema, {
    usageEventId: row.usageEventId,
    orgId: row.orgId,
    ...(row.repoId === null ? {} : { repoId: row.repoId }),
    ...(row.reviewRunId === null ? {} : { reviewRunId: row.reviewRunId }),
    eventType: row.eventType,
    quantity: row.quantity,
    unit: row.unit,
    costMicros: row.costMicros,
    occurredAt: row.occurredAt.toISOString(),
    ...(row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? { metadata: row.metadata }
      : {}),
  });
}

function eventIsWithinPeriod(
  event: UsageEvent,
  input: Pick<SummarizeUsageEventsInput, "periodEnd" | "periodStart">,
): boolean {
  if (input.periodStart && event.occurredAt < input.periodStart) {
    return false;
  }

  if (input.periodEnd && event.occurredAt >= input.periodEnd) {
    return false;
  }

  return true;
}

function rollupKeyForEvent(
  event: UsageEvent,
  input: SummarizeUsageEventsInput,
): { key: string; value: Omit<UsageRollup, "eventCount" | "quantity" | "costMicros"> } {
  const value = {
    orgId: event.orgId,
    ...(input.includeRepo && event.repoId ? { repoId: event.repoId } : {}),
    ...(input.includeReviewRun && event.reviewRunId ? { reviewRunId: event.reviewRunId } : {}),
    eventType: event.eventType,
    unit: event.unit,
    ...(input.periodStart ? { periodStart: input.periodStart } : {}),
    ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
  };

  return { key: JSON.stringify(value), value };
}

function compareUsageRollups(left: UsageRollup, right: UsageRollup): number {
  return (
    left.orgId.localeCompare(right.orgId) ||
    (left.repoId ?? "").localeCompare(right.repoId ?? "") ||
    (left.reviewRunId ?? "").localeCompare(right.reviewRunId ?? "") ||
    left.eventType.localeCompare(right.eventType) ||
    left.unit.localeCompare(right.unit) ||
    (left.periodStart ?? "").localeCompare(right.periodStart ?? "") ||
    (left.periodEnd ?? "").localeCompare(right.periodEnd ?? "")
  );
}
