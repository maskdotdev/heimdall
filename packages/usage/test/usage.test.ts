import { type BillingProvider, FakeBillingProvider } from "@repo/billing";
import type { BillingAccount, CreditGrant, Invoice } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildUsagePeriodSummary,
  checkPlanFeature,
  compilePlanSnapshot,
  createUsageEvent,
  DefaultBillingMeteringService,
  DefaultBillingService,
  DefaultEntitlementService,
  DefaultQuotaService,
  estimateLlmTokenUsage,
  evaluateUsageQuota,
  InMemoryBillingMeterEventStore,
  InMemoryBillingStore,
  InMemoryEntitlementStore,
  InMemoryQuotaStore,
  InMemoryUsageLedgerStore,
  MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
  monthlyQuotaPeriod,
  planBillingMeterEventsFromUsage,
  summarizeUsageEvents,
  UsageLedger,
} from "../src";

const baseInput = {
  orgId: "org_01HXAMPLE",
  repoId: "repo_01HXAMPLE",
  reviewRunId: "rrn_01HXAMPLE",
  eventType: "llm.token",
  quantity: 100,
  unit: "token",
  costMicros: 50,
  occurredAt: "2026-01-01T00:00:00.000Z",
} as const;

/** Creates a self-serve billing account that can receive provider meter events. */
function meteredBillingAccount(): BillingAccount {
  return {
    billingAccountId: "bill_metered",
    billingMode: "self_serve",
    createdAt: "2026-05-01T00:00:00.000Z",
    currentPlanKey: "team",
    currentPlanVersionId: "planv_team_2026_01",
    orgId: "org_01HXAMPLE",
    paymentStatus: "current",
    provider: "stripe",
    providerCustomerId: "cus_metered",
    status: "active",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

describe("createUsageEvent", () => {
  it("creates deterministic event IDs from idempotency keys", () => {
    const first = createUsageEvent({ ...baseInput, idempotencyKey: "llm-call-1:input" });
    const second = createUsageEvent({ ...baseInput, idempotencyKey: "llm-call-1:input" });

    expect(first.usageEventId).toBe(second.usageEventId);
    expect(first).toMatchObject({
      eventType: "llm.token",
      quantity: 100,
      unit: "token",
      costMicros: 50,
    });
  });

  it("allows signed correction quantities", () => {
    const correction = createUsageEvent({
      ...baseInput,
      idempotencyKey: "correction-1",
      quantity: -25,
      costMicros: -10,
    });

    expect(correction.quantity).toBe(-25);
    expect(correction.costMicros).toBe(-10);
  });
});

describe("UsageLedger", () => {
  it("records events idempotently through the store", async () => {
    const store = new InMemoryUsageLedgerStore();
    const ledger = new UsageLedger(store);
    const first = await ledger.record({ ...baseInput, idempotencyKey: "review-1:tokens" });
    const second = await ledger.record({ ...baseInput, idempotencyKey: "review-1:tokens" });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(store.events()).toHaveLength(1);
  });
});

describe("summarizeUsageEvents", () => {
  it("groups events by stable dimensions and applies corrections", () => {
    const events = [
      createUsageEvent({ ...baseInput, idempotencyKey: "event-1", quantity: 100, costMicros: 40 }),
      createUsageEvent({ ...baseInput, idempotencyKey: "event-2", quantity: 50, costMicros: 20 }),
      createUsageEvent({
        ...baseInput,
        idempotencyKey: "event-3",
        quantity: -25,
        costMicros: -10,
      }),
    ];
    const [rollup] = summarizeUsageEvents({
      events,
      includeRepo: true,
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-01-02T00:00:00.000Z",
    });

    expect(rollup).toMatchObject({
      costMicros: 50,
      eventCount: 3,
      quantity: 125,
      repoId: baseInput.repoId,
      unit: "token",
    });
  });
});

describe("evaluateUsageQuota", () => {
  it("returns warning and denial decisions from projected usage", () => {
    const warning = evaluateUsageQuota({
      quotaKey: "monthly_review_credits",
      periodKey: "2026-01",
      used: 75,
      requested: 10,
      limit: 100,
      warnAtPercent: 0.8,
    });
    const denial = evaluateUsageQuota({
      quotaKey: "monthly_review_credits",
      periodKey: "2026-01",
      used: 95,
      requested: 10,
      limit: 100,
    });

    expect(warning.status).toBe("warn");
    expect(warning.allowed).toBe(true);
    expect(denial.status).toBe("denied");
    expect(denial.allowed).toBe(false);
  });
});

describe("estimateLlmTokenUsage", () => {
  it("estimates token cost from a versioned rate card", () => {
    const estimate = estimateLlmTokenUsage({
      system: "Return JSON.",
      prompt: "Review this patch for correctness.",
      output: { findings: [] },
      rateCard: {
        rateCardId: "llm_rate_test_v1",
        provider: "test",
        model: "reviewer-small",
        inputTokenCostMicrosPer1k: 100,
        outputTokenCostMicrosPer1k: 400,
        effectiveAt: "2026-01-01T00:00:00.000Z",
        source: "manual",
      },
    });

    expect(estimate).toMatchObject({
      provider: "test",
      model: "reviewer-small",
      rateCardId: "llm_rate_test_v1",
    });
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.outputTokens).toBeGreaterThan(0);
    expect(estimate.totalTokens).toBe(estimate.inputTokens + estimate.outputTokens);
    expect(estimate.costMicros).toBeGreaterThan(0);
  });
});

describe("plan entitlements", () => {
  it("compiles seeded plan snapshots with active overrides", () => {
    const snapshot = compilePlanSnapshot({
      entitlements: [
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          enabled: true,
          entitlementId: "ent_comments",
          featureKey: "reviews.max_comments_per_pr",
          orgId: "org_01HXAMPLE",
          source: "override",
          updatedAt: "2026-01-01T00:00:00.000Z",
          value: { value: 12 },
        },
      ],
      now: "2026-05-01T00:00:00.000Z",
      orgId: "org_01HXAMPLE",
      planKey: "team",
    });

    expect(snapshot).toMatchObject({
      paymentStatus: "not_required",
      planKey: "team",
      schemaVersion: "plan_snapshot.v1",
    });
    expect(snapshot.features["reviews.inline_comments"]).toBe(true);
    expect(snapshot.limits["reviews.max_comments_per_pr"]).toBe(12);
  });

  it("checks features without calling a provider", async () => {
    const service = new DefaultEntitlementService(
      new InMemoryEntitlementStore({
        entitlements: [
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            enabled: false,
            entitlementId: "ent_inline_disabled",
            featureKey: "reviews.inline_comments",
            orgId: "org_01HXAMPLE",
            source: "manual",
            updatedAt: "2026-01-01T00:00:00.000Z",
            value: { reason: "support override" },
          },
        ],
      }),
    );
    const snapshot = await service.compilePlanSnapshot({
      now: "2026-05-01T00:00:00.000Z",
      orgId: "org_01HXAMPLE",
      planKey: "business",
    });
    const decision = await service.checkFeature({
      featureKey: "reviews.inline_comments",
      now: "2026-05-01T00:00:00.000Z",
      orgId: "org_01HXAMPLE",
      snapshot,
    });
    const planOnlyDecision = checkPlanFeature({
      featureKey: "security.audit_logs",
      now: "2026-05-01T00:00:00.000Z",
      snapshot,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "disabled_by_admin",
      source: "manual",
    });
    expect(planOnlyDecision).toMatchObject({
      allowed: true,
      reason: "enabled",
      source: "plan",
    });
  });
});

describe("billing summary", () => {
  it("creates a local default billing account for an organization without provider state", async () => {
    const store = new InMemoryBillingStore();
    const service = new DefaultBillingService(store);
    const summary = await service.getBillingSummary({
      now: "2026-05-07T12:00:00.000Z",
      orgId: "org_01HXAMPLE",
    });
    const second = await service.getBillingSummary({
      now: "2026-05-07T12:05:00.000Z",
      orgId: "org_01HXAMPLE",
    });

    expect(summary.billingAccount).toMatchObject({
      billingAccountId: "bill_default_01HXAMPLE",
      billingMode: "free",
      orgId: "org_01HXAMPLE",
      provider: "internal",
    });
    expect(summary.planSnapshot).toMatchObject({
      billingAccountId: summary.billingAccount.billingAccountId,
      planKey: "free",
    });
    expect(second.billingAccount.billingAccountId).toBe(summary.billingAccount.billingAccountId);
  });

  it("returns subscription, item, credit, and invoice mirrors in billing summaries", async () => {
    const service = new DefaultBillingService(
      new InMemoryBillingStore({
        billingAccounts: [
          {
            billingAccountId: "bill_team",
            billingMode: "self_serve",
            createdAt: "2026-05-01T00:00:00.000Z",
            currentPlanKey: "team",
            currentPlanVersionId: "planv_team_2026_01",
            orgId: "org_01HXAMPLE",
            paymentStatus: "current",
            provider: "stripe",
            providerCustomerId: "cus_123",
            status: "active",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        creditGrants: [
          {
            createdAt: "2026-05-02T00:00:00.000Z",
            creditGrantId: "cred_support",
            creditType: "review_credit",
            orgId: "org_01HXAMPLE",
            quantity: 25,
            reason: "Support adjustment",
            remainingQuantity: 10,
            source: "manual",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
        invoices: [
          {
            amountDueMicros: 2_900_000,
            amountPaidMicros: 2_900_000,
            amountRemainingMicros: 0,
            billingAccountId: "bill_team",
            createdAt: "2026-05-02T00:00:00.000Z",
            currency: "usd",
            invoiceId: "inv_may",
            periodEnd: "2026-06-01T00:00:00.000Z",
            periodStart: "2026-05-01T00:00:00.000Z",
            provider: "stripe",
            providerInvoiceId: "in_123",
            rawProviderInvoice: { status: "paid" },
            status: "paid",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
        subscriptionItems: [
          {
            active: true,
            createdAt: "2026-05-01T00:00:00.000Z",
            itemType: "base_subscription",
            quantity: 3,
            subscriptionId: "sub_team",
            subscriptionItemId: "subitem_team_base",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        subscriptions: [
          {
            billingAccountId: "bill_team",
            billingPlanVersionId: "planv_team_2026_01",
            cancelAtPeriodEnd: false,
            createdAt: "2026-05-01T00:00:00.000Z",
            currentPeriodEnd: "2026-06-01T00:00:00.000Z",
            currentPeriodStart: "2026-05-01T00:00:00.000Z",
            provider: "stripe",
            providerSubscriptionId: "sub_provider_123",
            quantity: 3,
            rawProviderStatus: { status: "active" },
            status: "active",
            subscriptionId: "sub_team",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const summary = await service.getBillingSummary({
      now: "2026-05-07T12:00:00.000Z",
      orgId: "org_01HXAMPLE",
    });

    expect(summary.planSnapshot.planKey).toBe("team");
    expect(summary.subscription?.subscriptionId).toBe("sub_team");
    expect(summary.subscriptionItems).toHaveLength(1);
    expect(summary.creditGrants).toHaveLength(1);
    expect(summary.invoices).toHaveLength(1);
  });
});

describe("buildUsagePeriodSummary", () => {
  it("explains review credits, plan allowance, meter state, invoices, and internal cost", () => {
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const usageEvents = [
      createUsageEvent({
        ...baseInput,
        costMicros: 100,
        eventType: "review.run",
        idempotencyKey: "summary-review-run",
        occurredAt: "2026-05-07T12:00:00.000Z",
        quantity: 1,
        unit: "count",
      }),
      createUsageEvent({
        ...baseInput,
        costMicros: 25,
        eventType: "review.credit",
        idempotencyKey: "summary-review-credit-repo-1",
        occurredAt: "2026-05-07T12:01:00.000Z",
        quantity: 3,
        unit: "credit",
      }),
      createUsageEvent({
        ...baseInput,
        costMicros: 50,
        eventType: "review.credit",
        idempotencyKey: "summary-review-credit-repo-2",
        occurredAt: "2026-05-07T12:02:00.000Z",
        quantity: 2,
        repoId: "repo_02HXAMPLE",
        unit: "credit",
      }),
      createUsageEvent({
        ...baseInput,
        costMicros: 250,
        eventType: "llm.token",
        idempotencyKey: "summary-llm-token",
        occurredAt: "2026-05-07T12:03:00.000Z",
        quantity: 900,
        unit: "token",
      }),
    ];
    const [meterEvent] = planBillingMeterEventsFromUsage({
      billingAccounts: [meteredBillingAccount()],
      now: "2026-05-08T12:00:00.000Z",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      usageEvents,
    });
    const creditGrants = [
      {
        createdAt: "2026-05-01T00:00:00.000Z",
        creditGrantId: "cred_summary",
        creditType: "review_credit",
        expiresAt: "2026-06-01T00:00:00.000Z",
        orgId: "org_01HXAMPLE",
        quantity: 2,
        reason: "Launch credit",
        remainingQuantity: 1,
        source: "manual",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ] satisfies readonly CreditGrant[];
    const invoices = [
      {
        amountDueMicros: 2_900_000,
        amountPaidMicros: 2_900_000,
        amountRemainingMicros: 0,
        billingAccountId: "bill_metered",
        createdAt: "2026-05-31T00:00:00.000Z",
        currency: "usd",
        hostedInvoiceUrl: "https://billing.example.test/invoices/in_summary",
        invoiceId: "inv_summary",
        periodEnd: period.periodEnd,
        periodStart: period.periodStart,
        provider: "stripe",
        providerInvoiceId: "in_summary",
        rawProviderInvoice: { status: "paid" },
        status: "paid",
        updatedAt: "2026-05-31T00:00:00.000Z",
      },
    ] satisfies readonly Invoice[];

    if (!meterEvent) {
      throw new Error("Expected a planned meter event.");
    }

    const summary = buildUsagePeriodSummary({
      billingMeterEvents: [meterEvent],
      creditGrants,
      includeInternalCost: true,
      includedReviewCredits: 4,
      invoices,
      now: "2026-05-15T00:00:00.000Z",
      orgId: "org_01HXAMPLE",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      usageEvents,
    });

    expect(summary.reviewCredits).toMatchObject({
      granted: 1,
      included: 4,
      limit: 5,
      overage: 0,
      remaining: 0,
      status: "warning",
      used: 5,
    });
    expect(summary.reviewRuns).toBe(1);
    expect(summary.cost?.estimatedMicros).toBe(425);
    expect(summary.byRepo[0]).toMatchObject({
      costMicros: 375,
      repoId: "repo_01HXAMPLE",
      reviewCredits: 3,
      reviewRuns: 1,
    });
    expect(summary.byCategory).toContainEqual({
      category: "llm",
      costMicros: 250,
      eventCount: 1,
      quantity: 900,
      unit: "token",
    });
    expect(summary.meterEvents[0]).toMatchObject({
      meterKey: "review_credits",
      quantity: 5,
      sourceUsageEventCount: 2,
      status: "ready_to_send",
    });
    expect(summary.invoices[0]).toMatchObject({
      amountDueMicros: 2_900_000,
      invoiceId: "inv_summary",
      status: "paid",
    });
  });

  it("omits internal cost fields unless an internal caller requests them", () => {
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const usageEvents = [
      createUsageEvent({
        ...baseInput,
        costMicros: 250,
        eventType: "llm.token",
        idempotencyKey: "summary-safe-llm-token",
        occurredAt: "2026-05-07T12:00:00.000Z",
        quantity: 900,
        unit: "token",
      }),
    ];
    const summary = buildUsagePeriodSummary({
      includedReviewCredits: 1,
      orgId: "org_01HXAMPLE",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      usageEvents,
    });

    expect(summary.cost).toBeUndefined();
    expect(summary.byCategory[0]).toEqual({
      category: "llm",
      eventCount: 1,
      quantity: 900,
      unit: "token",
    });
  });
});

describe("billing meter events", () => {
  it("plans monthly review credit meter events from billable usage", () => {
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const usageEvents = [
      createUsageEvent({
        ...baseInput,
        eventType: "review.credit",
        idempotencyKey: "review-credit-1",
        occurredAt: "2026-05-07T12:00:00.000Z",
        quantity: 3,
        unit: "credit",
      }),
      createUsageEvent({
        ...baseInput,
        eventType: "review.credit",
        idempotencyKey: "review-credit-2",
        occurredAt: "2026-05-08T12:00:00.000Z",
        quantity: 2,
        unit: "credit",
      }),
      createUsageEvent({
        ...baseInput,
        eventType: "review.credit",
        idempotencyKey: "review-credit-correction",
        occurredAt: "2026-05-08T13:00:00.000Z",
        quantity: -1,
        unit: "credit",
      }),
      createUsageEvent({
        ...baseInput,
        eventType: "llm.token",
        idempotencyKey: "tokens-not-metered",
        occurredAt: "2026-05-09T12:00:00.000Z",
        quantity: 500,
        unit: "token",
      }),
    ];
    const [event] = planBillingMeterEventsFromUsage({
      billingAccounts: [meteredBillingAccount()],
      now: "2026-05-10T12:00:00.000Z",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      usageEvents,
    });
    const [firstEvent, secondEvent, correctionEvent] = usageEvents;

    if (!firstEvent || !secondEvent || !correctionEvent) {
      throw new Error("Expected review credit usage events to exist.");
    }

    expect(event).toMatchObject({
      billingAccountId: "bill_metered",
      meterKey: "review_credits",
      orgId: "org_01HXAMPLE",
      periodKey: "2026-05",
      provider: "stripe",
      providerCustomerId: "cus_metered",
      providerEventName: "review_credits",
      quantity: 4,
      status: "ready_to_send",
    });
    expect(event?.idempotencyKey).toBe(
      `stripe_meter:org_01HXAMPLE:review_credits:${period.periodStart}:${period.periodEnd}`,
    );
    expect(event?.sourceUsageEventIds).toEqual([
      firstEvent.usageEventId,
      secondEvent.usageEventId,
      correctionEvent.usageEventId,
    ]);
  });

  it("sends ready meter events idempotently through the billing provider", async () => {
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const store = new InMemoryBillingMeterEventStore({
      billingAccounts: [meteredBillingAccount()],
      usageEvents: [
        createUsageEvent({
          ...baseInput,
          eventType: "review.credit",
          idempotencyKey: "review-credit-send",
          occurredAt: "2026-05-07T12:00:00.000Z",
          quantity: 2,
          unit: "credit",
        }),
      ],
    });
    const service = new DefaultBillingMeteringService(store);

    await service.planMeterEvents({
      now: "2026-05-08T12:00:00.000Z",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
    });
    const sent = await service.sendReadyMeterEvents({
      billingProvider: new FakeBillingProvider(),
      now: "2026-05-08T12:05:00.000Z",
    });
    const duplicate = await service.sendReadyMeterEvents({
      billingProvider: new FakeBillingProvider(),
      now: "2026-05-08T12:06:00.000Z",
    });

    expect(sent.failed).toHaveLength(0);
    expect(sent.sent).toHaveLength(1);
    expect(sent.sent[0]).toMatchObject({
      attemptCount: 1,
      providerMeterEventId: expect.stringMatching(/^mtr_fake_/),
      sentAt: "2026-05-08T12:05:00.000Z",
      status: "sent",
    });
    expect(duplicate.sent).toHaveLength(0);
    expect(store.events()).toHaveLength(1);
  });

  it("marks failed provider sends for retry", async () => {
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const store = new InMemoryBillingMeterEventStore({
      billingAccounts: [meteredBillingAccount()],
      usageEvents: [
        createUsageEvent({
          ...baseInput,
          eventType: "review.credit",
          idempotencyKey: "review-credit-fail",
          occurredAt: "2026-05-07T12:00:00.000Z",
          quantity: 1,
          unit: "credit",
        }),
      ],
    });
    const service = new DefaultBillingMeteringService(store);
    const failingProvider: BillingProvider = {
      createCheckoutSession: async () => {
        throw new Error("Unexpected checkout call.");
      },
      createCustomer: async () => {
        throw new Error("Unexpected customer call.");
      },
      createCustomerPortalSession: async () => {
        throw new Error("Unexpected portal call.");
      },
      getSubscription: async () => {
        throw new Error("Unexpected subscription call.");
      },
      parseWebhook: async () => {
        throw new Error("Unexpected webhook call.");
      },
      sendMeterEvent: async () => {
        throw Object.assign(new Error("provider down"), { code: "stripe_unavailable" });
      },
    };

    await service.planMeterEvents({
      now: "2026-05-08T12:00:00.000Z",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
    });
    const result = await service.sendReadyMeterEvents({
      billingProvider: failingProvider,
      now: "2026-05-08T12:05:00.000Z",
    });

    expect(result.sent).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      attemptCount: 1,
      lastErrorCode: "stripe_unavailable",
      lastErrorMessage: "provider down",
      status: "failed",
    });
    expect(store.events()[0]?.status).toBe("failed");
  });
});

describe("quota reservations", () => {
  it("reserves and consumes monthly review credits idempotently", async () => {
    const service = new DefaultQuotaService(new InMemoryQuotaStore());
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const first = await service.reserve({
      ...period,
      expiresAt: "2026-05-07T18:00:00.000Z",
      limit: 2,
      now: "2026-05-07T12:00:00.000Z",
      orgId: "org_01HXAMPLE",
      quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
      requested: 1,
      sourceId: "rrn_01HXAMPLE",
      sourceType: "review_run",
    });
    const duplicate = await service.reserve({
      ...period,
      expiresAt: "2026-05-07T18:00:00.000Z",
      limit: 2,
      now: "2026-05-07T12:01:00.000Z",
      orgId: "org_01HXAMPLE",
      quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
      requested: 1,
      sourceId: "rrn_01HXAMPLE",
      sourceType: "review_run",
    });

    expect(first.decision.allowed).toBe(true);
    expect(first.reserved).toBe(true);
    expect(duplicate.reserved).toBe(false);
    expect(duplicate.reservation?.quotaReservationId).toBe(first.reservation?.quotaReservationId);

    if (!first.reservation) {
      throw new Error("Expected quota reservation to be created.");
    }

    const consumed = await service.consumeReservation({
      now: "2026-05-07T12:05:00.000Z",
      quotaReservationId: first.reservation.quotaReservationId,
    });
    const consumedAgain = await service.consumeReservation({
      now: "2026-05-07T12:06:00.000Z",
      quotaReservationId: first.reservation.quotaReservationId,
    });
    const denied = await service.reserve({
      ...period,
      limit: 2,
      now: "2026-05-07T12:07:00.000Z",
      orgId: "org_01HXAMPLE",
      quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
      requested: 2,
      sourceId: "rrn_02HXAMPLE",
      sourceType: "review_run",
    });

    expect(consumed.status).toBe("consumed");
    expect(consumedAgain.status).toBe("consumed");
    expect(denied.decision.status).toBe("denied");
    expect(denied.reservation).toBeUndefined();
  });

  it("releases unused reservations back to available quota", async () => {
    const service = new DefaultQuotaService(new InMemoryQuotaStore());
    const period = monthlyQuotaPeriod("2026-05-07T12:00:00.000Z");
    const reserved = await service.reserve({
      ...period,
      limit: 1,
      now: "2026-05-07T12:00:00.000Z",
      orgId: "org_01HXAMPLE",
      quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
      requested: 1,
      sourceId: "rrn_release",
      sourceType: "review_run",
    });

    if (!reserved.reservation) {
      throw new Error("Expected quota reservation to be created.");
    }

    const released = await service.releaseReservation({
      now: "2026-05-07T12:05:00.000Z",
      quotaReservationId: reserved.reservation.quotaReservationId,
    });
    const next = await service.reserve({
      ...period,
      limit: 1,
      now: "2026-05-07T12:06:00.000Z",
      orgId: "org_01HXAMPLE",
      quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
      requested: 1,
      sourceId: "rrn_after_release",
      sourceType: "review_run",
    });

    expect(released.status).toBe("released");
    expect(next.decision.allowed).toBe(true);
  });
});
