import { type Static, Type } from "@sinclair/typebox";
import {
  BillingAccountIdSchema,
  BillingMeterEventIdSchema,
  BillingPlanIdSchema,
  BillingPlanVersionIdSchema,
  CreditGrantIdSchema,
  EntitlementIdSchema,
  InvoiceIdSchema,
  OrgIdSchema,
  SubscriptionIdSchema,
  SubscriptionItemIdSchema,
  UserIdSchema,
} from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

/** Billing modes supported by local billing state. */
export const BillingModeSchema = Type.Union([
  Type.Literal("free"),
  Type.Literal("self_serve"),
  Type.Literal("enterprise_contract"),
  Type.Literal("internal"),
  Type.Literal("suspended"),
]);
export type BillingMode = Static<typeof BillingModeSchema>;

/** Lifecycle state for an organization's billing account. */
export const BillingAccountStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("trialing"),
  Type.Literal("past_due"),
  Type.Literal("grace_period"),
  Type.Literal("cancelled"),
  Type.Literal("suspended"),
  Type.Literal("manual_review"),
]);
export type BillingAccountStatus = Static<typeof BillingAccountStatusSchema>;

/** Payment status used for product access decisions. */
export const PaymentStatusSchema = Type.Union([
  Type.Literal("not_required"),
  Type.Literal("current"),
  Type.Literal("past_due"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
]);
export type PaymentStatus = Static<typeof PaymentStatusSchema>;

/** Lifecycle states mirrored from a billing provider subscription. */
export const SubscriptionStatusSchema = Type.Union([
  Type.Literal("incomplete"),
  Type.Literal("incomplete_expired"),
  Type.Literal("trialing"),
  Type.Literal("active"),
  Type.Literal("past_due"),
  Type.Literal("cancelled"),
  Type.Literal("unpaid"),
  Type.Literal("paused"),
]);
export type SubscriptionStatus = Static<typeof SubscriptionStatusSchema>;

/** Subscription item types used by internal billing mirrors. */
export const SubscriptionItemTypeSchema = Type.Union([
  Type.Literal("base_subscription"),
  Type.Literal("seat_quantity"),
  Type.Literal("metered_review_credits"),
  Type.Literal("metered_ai_credits"),
  Type.Literal("enterprise_flat"),
]);
export type SubscriptionItemType = Static<typeof SubscriptionItemTypeSchema>;

/** Credit types that can be granted manually or by promotions. */
export const CreditTypeSchema = Type.Union([
  Type.Literal("review_credit"),
  Type.Literal("ai_credit"),
  Type.Literal("usd_micro_credit"),
]);
export type CreditType = Static<typeof CreditTypeSchema>;

/** Provider invoice states mirrored for customer support. */
export const InvoiceStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("open"),
  Type.Literal("paid"),
  Type.Literal("uncollectible"),
  Type.Literal("void"),
  Type.Literal("deleted"),
]);
export type InvoiceStatus = Static<typeof InvoiceStatusSchema>;

/** Send lifecycle for one provider meter event. */
export const BillingMeterEventStatusSchema = Type.Union([
  Type.Literal("ready_to_send"),
  Type.Literal("sent"),
  Type.Literal("failed"),
]);
export type BillingMeterEventStatus = Static<typeof BillingMeterEventStatusSchema>;

/** Source that granted or denied an entitlement. */
export const EntitlementSourceSchema = Type.Union([
  Type.Literal("plan"),
  Type.Literal("override"),
  Type.Literal("stripe"),
  Type.Literal("manual"),
  Type.Literal("internal"),
  Type.Literal("enterprise_contract"),
]);
export type EntitlementSource = Static<typeof EntitlementSourceSchema>;

/** Plan catalog row shared by billing and entitlement code. */
export const BillingPlanSchema = Type.Object(
  {
    billingPlanId: BillingPlanIdSchema,
    planKey: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    audience: Type.String({ minLength: 1 }),
    public: Type.Boolean(),
    active: Type.Boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type BillingPlan = Static<typeof BillingPlanSchema>;

/** Versioned plan configuration used to compile stable snapshots. */
export const BillingPlanVersionSchema = Type.Object(
  {
    billingPlanVersionId: BillingPlanVersionIdSchema,
    billingPlanId: BillingPlanIdSchema,
    version: Type.String({ minLength: 1 }),
    active: Type.Boolean(),
    effectiveFrom: IsoDateTimeSchema,
    effectiveTo: Type.Optional(IsoDateTimeSchema),
    provider: Type.Optional(Type.String()),
    providerProductId: Type.Optional(Type.String()),
    providerBasePriceId: Type.Optional(Type.String()),
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    baseAmountMicros: Type.Optional(Type.Integer()),
    billingInterval: Type.Optional(Type.String()),
    included: Type.Record(Type.String(), Type.Unknown()),
    limits: Type.Record(Type.String(), Type.Unknown()),
    features: Type.Record(Type.String(), Type.Unknown()),
    overage: Type.Record(Type.String(), Type.Unknown()),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type BillingPlanVersion = Static<typeof BillingPlanVersionSchema>;

/** Billing account state for one organization. */
export const BillingAccountSchema = Type.Object(
  {
    billingAccountId: BillingAccountIdSchema,
    orgId: OrgIdSchema,
    billingMode: BillingModeSchema,
    status: BillingAccountStatusSchema,
    provider: Type.String({ minLength: 1 }),
    providerCustomerId: Type.Optional(Type.String()),
    billingEmail: Type.Optional(Type.String()),
    billingName: Type.Optional(Type.String()),
    billingCountry: Type.Optional(Type.String()),
    currentPlanKey: Type.Optional(Type.String()),
    currentPlanVersionId: Type.Optional(BillingPlanVersionIdSchema),
    trialEndsAt: Type.Optional(IsoDateTimeSchema),
    gracePeriodEndsAt: Type.Optional(IsoDateTimeSchema),
    paymentStatus: PaymentStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type BillingAccount = Static<typeof BillingAccountSchema>;

/** Internal mirror of one provider subscription. */
export const SubscriptionSchema = Type.Object(
  {
    subscriptionId: SubscriptionIdSchema,
    billingAccountId: BillingAccountIdSchema,
    provider: Type.String({ minLength: 1 }),
    providerSubscriptionId: Type.Optional(Type.String()),
    status: SubscriptionStatusSchema,
    billingPlanVersionId: Type.Optional(BillingPlanVersionIdSchema),
    currentPeriodStart: Type.Optional(IsoDateTimeSchema),
    currentPeriodEnd: Type.Optional(IsoDateTimeSchema),
    cancelAtPeriodEnd: Type.Boolean(),
    cancelledAt: Type.Optional(IsoDateTimeSchema),
    trialStart: Type.Optional(IsoDateTimeSchema),
    trialEnd: Type.Optional(IsoDateTimeSchema),
    quantity: Type.Optional(Type.Integer()),
    rawProviderStatus: Type.Record(Type.String(), Type.Unknown()),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type Subscription = Static<typeof SubscriptionSchema>;

/** Internal mirror of one provider subscription item. */
export const SubscriptionItemSchema = Type.Object(
  {
    subscriptionItemId: SubscriptionItemIdSchema,
    subscriptionId: SubscriptionIdSchema,
    providerItemId: Type.Optional(Type.String()),
    providerPriceId: Type.Optional(Type.String()),
    itemType: SubscriptionItemTypeSchema,
    quantity: Type.Optional(Type.Integer()),
    meterKey: Type.Optional(Type.String()),
    active: Type.Boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type SubscriptionItem = Static<typeof SubscriptionItemSchema>;

/** Manual or promotional usage credit grant. */
export const CreditGrantSchema = Type.Object(
  {
    creditGrantId: CreditGrantIdSchema,
    orgId: OrgIdSchema,
    creditType: CreditTypeSchema,
    quantity: Type.Integer(),
    remainingQuantity: Type.Integer(),
    reason: Type.String({ minLength: 1 }),
    source: Type.String({ minLength: 1 }),
    sourceId: Type.Optional(Type.String()),
    expiresAt: Type.Optional(IsoDateTimeSchema),
    createdByUserId: Type.Optional(UserIdSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type CreditGrant = Static<typeof CreditGrantSchema>;

/** Provider invoice mirror. */
export const InvoiceSchema = Type.Object(
  {
    invoiceId: InvoiceIdSchema,
    billingAccountId: BillingAccountIdSchema,
    provider: Type.String({ minLength: 1 }),
    providerInvoiceId: Type.String({ minLength: 1 }),
    status: InvoiceStatusSchema,
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    amountDueMicros: Type.Integer(),
    amountPaidMicros: Type.Integer(),
    amountRemainingMicros: Type.Integer(),
    periodStart: Type.Optional(IsoDateTimeSchema),
    periodEnd: Type.Optional(IsoDateTimeSchema),
    hostedInvoiceUrl: Type.Optional(Type.String()),
    invoicePdfUrl: Type.Optional(Type.String()),
    rawProviderInvoice: Type.Record(Type.String(), Type.Unknown()),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type Invoice = Static<typeof InvoiceSchema>;

/** Planned or sent provider meter event for usage-based billing. */
export const BillingMeterEventSchema = Type.Object(
  {
    billingMeterEventId: BillingMeterEventIdSchema,
    billingAccountId: BillingAccountIdSchema,
    orgId: OrgIdSchema,
    provider: Type.String({ minLength: 1 }),
    providerCustomerId: Type.String({ minLength: 1 }),
    meterKey: Type.String({ minLength: 1 }),
    providerEventName: Type.String({ minLength: 1 }),
    periodKey: Type.String({ minLength: 1 }),
    periodStart: IsoDateTimeSchema,
    periodEnd: IsoDateTimeSchema,
    quantity: Type.Integer(),
    idempotencyKey: Type.String({ minLength: 1 }),
    status: BillingMeterEventStatusSchema,
    providerMeterEventId: Type.Optional(Type.String()),
    attemptCount: Type.Integer(),
    lastErrorCode: Type.Optional(Type.String()),
    lastErrorMessage: Type.Optional(Type.String()),
    sourceUsageEventIds: Type.Array(Type.String({ minLength: 1 })),
    sentAt: Type.Optional(IsoDateTimeSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type BillingMeterEvent = Static<typeof BillingMeterEventSchema>;

/** Feature or limit entitlement for one organization. */
export const EntitlementSchema = Type.Object(
  {
    entitlementId: EntitlementIdSchema,
    orgId: OrgIdSchema,
    featureKey: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
    source: EntitlementSourceSchema,
    sourceId: Type.Optional(Type.String()),
    value: Type.Record(Type.String(), Type.Unknown()),
    effectiveFrom: IsoDateTimeSchema,
    effectiveTo: Type.Optional(IsoDateTimeSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type Entitlement = Static<typeof EntitlementSchema>;

/** Stable plan snapshot attached to decisions and future review runs. */
export const PlanSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal("plan_snapshot.v1"),
    orgId: OrgIdSchema,
    billingAccountId: BillingAccountIdSchema,
    planKey: Type.String({ minLength: 1 }),
    planVersionId: BillingPlanVersionIdSchema,
    subscriptionStatus: Type.String({ minLength: 1 }),
    paymentStatus: PaymentStatusSchema,
    features: Type.Record(Type.String(), Type.Unknown()),
    limits: Type.Record(Type.String(), Type.Union([Type.Number(), Type.Boolean(), Type.String()])),
    compiledAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type PlanSnapshot = Static<typeof PlanSnapshotSchema>;

/** Feature access result produced without provider calls. */
export const EntitlementDecisionSchema = Type.Object(
  {
    orgId: OrgIdSchema,
    featureKey: Type.String({ minLength: 1 }),
    allowed: Type.Boolean(),
    reason: Type.Union([
      Type.Literal("enabled"),
      Type.Literal("disabled_by_plan"),
      Type.Literal("disabled_by_admin"),
      Type.Literal("payment_past_due"),
      Type.Literal("trial_expired"),
      Type.Literal("quota_exceeded"),
      Type.Literal("org_suspended"),
    ]),
    source: EntitlementSourceSchema,
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type EntitlementDecision = Static<typeof EntitlementDecisionSchema>;
