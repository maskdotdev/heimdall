import type { CodeIndexVersion } from "#contracts/index-artifact/artifact";
import type { LLMCall } from "#contracts/llm/llm-call";
import type { PromptVersion } from "#contracts/llm/prompt";
import type {
  BillingAccount,
  BillingMeterEvent,
  BillingPlan,
  BillingPlanVersion,
  CreditGrant,
  Entitlement,
  EntitlementDecision,
  Invoice,
  PlanSnapshot,
  Subscription,
  SubscriptionItem,
} from "#contracts/usage/entitlements";
import type { QuotaCounter, QuotaReservation } from "#contracts/usage/quota";
import type { UsageEvent } from "#contracts/usage/usage-event";
import type { WebhookEvent } from "#contracts/webhook/webhook-event";
import { hashA, hashB, ids, now } from "./common";

export const validCodeIndexVersionFixture = {
  indexVersionId: ids.indexVersionId,
  repoId: ids.repoId,
  commitSha: "2222222",
  status: "ready",
  artifactUri: "s3://heimdall-artifacts/indexes/2222222",
  artifactHash: hashA,
  indexerName: "heimdall-ts-indexer",
  indexerVersion: "0.1.0",
  chunkerVersion: "0.1.0",
  fileCount: 1,
  symbolCount: 1,
  edgeCount: 1,
  chunkCount: 1,
  embeddedChunkCount: 1,
  createdAt: now,
  completedAt: now,
} satisfies CodeIndexVersion;

export const validLLMCallFixture = {
  llmCallId: "llm_01HXAMPLE",
  orgId: ids.orgId,
  repoId: ids.repoId,
  reviewRunId: ids.reviewRunId,
  operation: "generate_findings",
  provider: "openai",
  model: "gpt-5.4",
  promptVersion: "review-findings.v1",
  inputHash: hashA,
  outputHash: hashB,
  inputTokens: 1200,
  outputTokens: 300,
  cachedInputTokens: 0,
  latencyMs: 1400,
  costMicros: 950,
  status: "succeeded",
  startedAt: now,
  completedAt: now,
} satisfies LLMCall;

export const validPromptVersionFixture = {
  promptVersion: "review-findings.v1",
  operation: "generate_findings",
  description: "Generate candidate PR findings from context bundle input.",
  createdAt: now,
} satisfies PromptVersion;

export const validUsageEventFixture = {
  usageEventId: "usage_01HXAMPLE",
  orgId: ids.orgId,
  repoId: ids.repoId,
  reviewRunId: ids.reviewRunId,
  eventType: "llm.token",
  quantity: 1500,
  unit: "token",
  costMicros: 950,
  occurredAt: now,
} satisfies UsageEvent;

export const validBillingPlanFixture = {
  billingPlanId: ids.billingPlanId,
  planKey: "team",
  name: "Team",
  description: "Shared review automation for a team.",
  audience: "team",
  public: true,
  active: true,
  createdAt: now,
  updatedAt: now,
} satisfies BillingPlan;

export const validBillingPlanVersionFixture = {
  billingPlanVersionId: ids.billingPlanVersionId,
  billingPlanId: ids.billingPlanId,
  version: "2026-05",
  active: true,
  effectiveFrom: now,
  currency: "usd",
  baseAmountMicros: 2_900_000,
  billingInterval: "month",
  included: { reviewCreditsPerMonth: 500 },
  limits: { "reviews.max_comments_per_pr": 8, "reviews.max_monthly_review_credits": 500 },
  features: { "reviews.enabled": true, "reviews.inline_comments": true },
  overage: {},
  createdAt: now,
} satisfies BillingPlanVersion;

export const validBillingAccountFixture = {
  billingAccountId: ids.billingAccountId,
  orgId: ids.orgId,
  billingMode: "self_serve",
  status: "active",
  provider: "stripe",
  currentPlanKey: "team",
  currentPlanVersionId: ids.billingPlanVersionId,
  paymentStatus: "current",
  createdAt: now,
  updatedAt: now,
} satisfies BillingAccount;

export const validSubscriptionFixture = {
  subscriptionId: ids.subscriptionId,
  billingAccountId: ids.billingAccountId,
  provider: "stripe",
  providerSubscriptionId: "sub_provider_123",
  status: "active",
  billingPlanVersionId: ids.billingPlanVersionId,
  currentPeriodStart: "2026-04-01T00:00:00.000Z",
  currentPeriodEnd: "2026-05-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  quantity: 3,
  rawProviderStatus: { status: "active" },
  createdAt: now,
  updatedAt: now,
} satisfies Subscription;

export const validSubscriptionItemFixture = {
  subscriptionItemId: ids.subscriptionItemId,
  subscriptionId: ids.subscriptionId,
  providerItemId: "si_provider_123",
  providerPriceId: "price_provider_123",
  itemType: "base_subscription",
  quantity: 3,
  active: true,
  createdAt: now,
  updatedAt: now,
} satisfies SubscriptionItem;

export const validCreditGrantFixture = {
  creditGrantId: ids.creditGrantId,
  orgId: ids.orgId,
  creditType: "review_credit",
  quantity: 50,
  remainingQuantity: 25,
  reason: "Support adjustment",
  source: "manual",
  sourceId: "ticket-123",
  createdByUserId: ids.userId,
  createdAt: now,
  updatedAt: now,
} satisfies CreditGrant;

export const validInvoiceFixture = {
  invoiceId: ids.invoiceId,
  billingAccountId: ids.billingAccountId,
  provider: "stripe",
  providerInvoiceId: "in_provider_123",
  status: "paid",
  currency: "usd",
  amountDueMicros: 2_900_000,
  amountPaidMicros: 2_900_000,
  amountRemainingMicros: 0,
  periodStart: "2026-04-01T00:00:00.000Z",
  periodEnd: "2026-05-01T00:00:00.000Z",
  hostedInvoiceUrl: "https://billing.example.test/invoices/in_provider_123",
  invoicePdfUrl: "https://billing.example.test/invoices/in_provider_123.pdf",
  rawProviderInvoice: { status: "paid" },
  createdAt: now,
  updatedAt: now,
} satisfies Invoice;

export const validBillingMeterEventFixture = {
  billingMeterEventId: ids.billingMeterEventId,
  billingAccountId: ids.billingAccountId,
  orgId: ids.orgId,
  provider: "stripe",
  providerCustomerId: "cus_provider_123",
  meterKey: "review_credits",
  providerEventName: "review_credits",
  periodKey: "2026-04",
  periodStart: "2026-04-01T00:00:00.000Z",
  periodEnd: "2026-05-01T00:00:00.000Z",
  quantity: 12,
  idempotencyKey: "stripe_meter:org_01HXAMPLE:review_credits:2026-04",
  status: "ready_to_send",
  attemptCount: 0,
  sourceUsageEventIds: ["usage_01HXAMPLE"],
  createdAt: now,
  updatedAt: now,
} satisfies BillingMeterEvent;

export const validEntitlementFixture = {
  entitlementId: ids.entitlementId,
  orgId: ids.orgId,
  featureKey: "reviews.max_comments_per_pr",
  enabled: true,
  source: "override",
  sourceId: "support-ticket-123",
  value: { value: 12 },
  effectiveFrom: now,
  createdAt: now,
  updatedAt: now,
} satisfies Entitlement;

export const validPlanSnapshotFixture = {
  schemaVersion: "plan_snapshot.v1",
  orgId: ids.orgId,
  billingAccountId: ids.billingAccountId,
  planKey: "team",
  planVersionId: ids.billingPlanVersionId,
  subscriptionStatus: "active",
  paymentStatus: "current",
  features: { "reviews.enabled": true, "reviews.inline_comments": true },
  limits: { "reviews.max_comments_per_pr": 12, "reviews.max_monthly_review_credits": 500 },
  compiledAt: now,
} satisfies PlanSnapshot;

export const validEntitlementDecisionFixture = {
  orgId: ids.orgId,
  featureKey: "reviews.inline_comments",
  allowed: true,
  reason: "enabled",
  source: "plan",
  value: true,
} satisfies EntitlementDecision;

export const validQuotaCounterFixture = {
  quotaCounterId: ids.quotaCounterId,
  orgId: ids.orgId,
  quotaKey: "monthly_review_credits",
  periodKey: "2026-04",
  periodStart: "2026-04-01T00:00:00.000Z",
  periodEnd: "2026-05-01T00:00:00.000Z",
  usedQuantity: 10,
  reservedQuantity: 1,
  limitQuantity: 500,
  source: "plan_snapshot",
  createdAt: now,
  updatedAt: now,
} satisfies QuotaCounter;

export const validQuotaReservationFixture = {
  quotaReservationId: ids.quotaReservationId,
  orgId: ids.orgId,
  quotaCounterId: ids.quotaCounterId,
  sourceType: "review_run",
  sourceId: ids.reviewRunId,
  quantity: 1,
  status: "reserved",
  expiresAt: "2026-04-28T18:00:00.000Z",
  createdAt: now,
  updatedAt: now,
} satisfies QuotaReservation;

export const validWebhookEventFixture = {
  webhookEventId: "webhook_01HXAMPLE",
  provider: "github",
  deliveryId: "delivery-123",
  eventName: "pull_request",
  action: "opened",
  installationId: ids.installationId,
  repoId: ids.repoId,
  payloadHash: hashA,
  payloadUri: "s3://heimdall-artifacts/webhooks/delivery-123.json",
  status: "processed",
  receivedAt: now,
  processedAt: now,
} satisfies WebhookEvent;
