import { describe, expect, it } from "vitest";
import {
  createFakeSubscriptionWebhookFixture,
  FakeBillingProvider,
  InMemoryBillingProviderRequestLogger,
  type ProviderSubscription,
  type StripeBillingClient,
  StripeBillingProvider,
} from "../src";

type StripeClientCall = {
  /** Stripe operation name. */
  readonly operation: string;
  /** Request body sent to the fake Stripe client. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Request options sent to the fake Stripe client. */
  readonly options?: Readonly<Record<string, unknown>>;
};

describe("FakeBillingProvider", () => {
  it("creates fake customer, checkout, portal, and subscription flows", async () => {
    const provider = new FakeBillingProvider({
      baseUrl: "https://billing.example.test",
      now: () => "2026-05-07T12:00:00.000Z",
    });
    const customer = await provider.createCustomer({ orgId: "org_01HXAMPLE" });
    const sameCustomer = await provider.createCustomer({ orgId: "org_01HXAMPLE" });
    const checkout = await provider.createCheckoutSession({
      cancelUrl: "https://app.example.test/billing",
      orgId: "org_01HXAMPLE",
      planKey: "team",
      quantity: 3,
      successUrl: "https://app.example.test/billing/success",
    });
    const portal = await provider.createCustomerPortalSession({
      orgId: "org_01HXAMPLE",
      providerCustomerId: customer.providerCustomerId,
      returnUrl: "https://app.example.test/billing",
    });
    const completed = await provider.completeCheckoutSession({
      checkoutSessionId: checkout.checkoutSessionId,
    });
    const subscription = await provider.getSubscription({
      providerSubscriptionId: requireSubscription(completed.subscription).providerSubscriptionId,
    });

    expect(sameCustomer.providerCustomerId).toBe(customer.providerCustomerId);
    expect(checkout.url).toContain("/fake-billing/checkout/");
    expect(portal.url).toContain("/fake-billing/portal/");
    expect(completed).toMatchObject({
      eventType: "checkout.session.completed",
      provider: "fake",
    });
    expect(subscription).toMatchObject({
      planKey: "team",
      providerCustomerId: customer.providerCustomerId,
      quantity: 3,
      status: "active",
    });
  });

  it("parses fake subscription webhook fixtures", async () => {
    const provider = new FakeBillingProvider();
    const fixture = createFakeSubscriptionWebhookFixture({
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
      currentPeriodStart: "2026-05-01T00:00:00.000Z",
      planKey: "business",
      providerCustomerId: "cus_fake_123",
      providerEventId: "evt_fake_subscription",
      providerSubscriptionId: "sub_fake_123",
      quantity: 5,
      status: "trialing",
    });
    const parsed = await provider.parseWebhook(fixture);

    expect(parsed).toMatchObject({
      eventType: "customer.subscription.updated",
      providerEventId: "evt_fake_subscription",
      relatedProviderCustomerId: "cus_fake_123",
      subscription: {
        planKey: "business",
        providerSubscriptionId: "sub_fake_123",
        quantity: 5,
        status: "trialing",
      },
    });
  });

  it("sends fake meter events idempotently", async () => {
    const provider = new FakeBillingProvider();
    const first = await provider.sendMeterEvent({
      idempotencyKey: "meter:org_01HXAMPLE:2026-05",
      meterKey: "review_credits",
      orgId: "org_01HXAMPLE",
      providerCustomerId: "cus_fake_123",
      quantity: 10,
      timestamp: "2026-05-07T12:00:00.000Z",
    });
    const second = await provider.sendMeterEvent({
      idempotencyKey: "meter:org_01HXAMPLE:2026-05",
      meterKey: "review_credits",
      orgId: "org_01HXAMPLE",
      providerCustomerId: "cus_fake_123",
      quantity: 10,
      timestamp: "2026-05-07T12:00:01.000Z",
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({ provider: "fake", status: "sent" });
  });
});

describe("StripeBillingProvider", () => {
  it("creates Stripe customers with idempotency and request logging", async () => {
    const calls: StripeClientCall[] = [];
    const logger = new InMemoryBillingProviderRequestLogger();
    const provider = new StripeBillingProvider({
      checkoutPriceByPlanKey: { team: "price_team" },
      client: fakeStripeClient(calls),
      now: fixedClock(),
      requestLogger: logger,
    });

    const customer = await provider.createCustomer({
      billingAccountId: "bill_1",
      billingEmail: "billing@example.test",
      billingName: "Example Org",
      idempotencyKey: "idem_customer",
      orgId: "org_1",
    });

    expect(customer).toEqual({ provider: "stripe", providerCustomerId: "cus_stripe_123" });
    expect(requireCall(calls, 0)).toMatchObject({
      input: {
        email: "billing@example.test",
        metadata: { orgId: "org_1" },
        name: "Example Org",
      },
      operation: "customers.create",
      options: { idempotencyKey: "idem_customer" },
    });
    expect(requireLog(logger, 0)).toMatchObject({
      billingAccountId: "bill_1",
      idempotencyKey: "idem_customer",
      operation: "customers.create",
      provider: "stripe",
      providerRequestId: "req_customer",
      status: "succeeded",
    });
  });

  it("creates Stripe Checkout and Portal sessions with safe request metadata", async () => {
    const calls: StripeClientCall[] = [];
    const logger = new InMemoryBillingProviderRequestLogger();
    const provider = new StripeBillingProvider({
      checkoutPriceByPlanKey: { team: "price_team" },
      client: fakeStripeClient(calls),
      now: fixedClock(),
      requestLogger: logger,
    });

    const checkout = await provider.createCheckoutSession({
      billingAccountId: "bill_1",
      cancelUrl: "https://app.example.test/billing",
      idempotencyKey: "idem_checkout",
      orgId: "org_1",
      planKey: "team",
      providerCustomerId: "cus_stripe_123",
      quantity: 4,
      successUrl: "https://app.example.test/billing/success",
    });
    const portal = await provider.createCustomerPortalSession({
      billingAccountId: "bill_1",
      idempotencyKey: "idem_portal",
      orgId: "org_1",
      providerCustomerId: "cus_stripe_123",
      returnUrl: "https://app.example.test/billing",
    });

    expect(checkout).toMatchObject({
      checkoutSessionId: "cs_stripe_123",
      expiresAt: "2026-06-01T00:00:00.000Z",
      url: "https://checkout.stripe.test/session",
    });
    expect(portal).toMatchObject({
      portalSessionId: "bps_stripe_123",
      url: "https://billing.stripe.test/session",
    });
    expect(requireCall(calls, 0)).toMatchObject({
      input: {
        cancel_url: "https://app.example.test/billing",
        customer: "cus_stripe_123",
        line_items: [{ price: "price_team", quantity: 4 }],
        mode: "subscription",
        success_url: "https://app.example.test/billing/success",
      },
      operation: "checkout.sessions.create",
      options: { idempotencyKey: "idem_checkout" },
    });
    expect(requireCall(calls, 1)).toMatchObject({
      input: {
        customer: "cus_stripe_123",
        return_url: "https://app.example.test/billing",
      },
      operation: "billingPortal.sessions.create",
      options: { idempotencyKey: "idem_portal" },
    });
    expect(logger.entries().map((entry) => entry.operation)).toEqual([
      "checkout.sessions.create",
      "billingPortal.sessions.create",
    ]);
  });

  it("normalizes Stripe subscription retrieval", async () => {
    const calls: StripeClientCall[] = [];
    const provider = new StripeBillingProvider({
      checkoutPriceByPlanKey: { business: "price_business" },
      client: fakeStripeClient(calls),
    });

    const subscription = await provider.getSubscription({
      providerSubscriptionId: "sub_stripe_123",
    });

    expect(subscription).toMatchObject({
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
      currentPeriodStart: "2026-05-01T00:00:00.000Z",
      planKey: "business",
      provider: "stripe",
      providerCustomerId: "cus_stripe_123",
      providerSubscriptionId: "sub_stripe_123",
      quantity: 7,
      status: "active",
    });
    expect(requireCall(calls, 0)).toMatchObject({ operation: "subscriptions.retrieve" });
  });

  it("logs failed Stripe provider requests", async () => {
    const logger = new InMemoryBillingProviderRequestLogger();
    const provider = new StripeBillingProvider({
      checkoutPriceByPlanKey: { team: "price_team" },
      client: fakeStripeClient([], {
        failCustomerCreate: true,
      }),
      now: fixedClock(),
      requestLogger: logger,
    });

    await expect(
      provider.createCustomer({
        idempotencyKey: "idem_failure",
        orgId: "org_1",
      }),
    ).rejects.toThrow("Stripe customer create failed.");

    expect(requireLog(logger, 0)).toMatchObject({
      errorCode: "stripe_error",
      errorMessage: "Stripe customer create failed.",
      idempotencyKey: "idem_failure",
      operation: "customers.create",
      provider: "stripe",
      status: "failed",
    });
  });
});

/** Requires a provider subscription in test code. */
function requireSubscription(subscription: ProviderSubscription | undefined): ProviderSubscription {
  if (!subscription) {
    throw new Error("Expected fake checkout to emit a subscription.");
  }

  return subscription;
}

/** Creates a deterministic fake Stripe client. */
function fakeStripeClient(
  calls: StripeClientCall[],
  options: { readonly failCustomerCreate?: boolean } = {},
): StripeBillingClient {
  return {
    billingPortal: {
      sessions: {
        create: async (input, requestOptions) => {
          calls.push({
            input,
            operation: "billingPortal.sessions.create",
            ...(requestOptions ? { options: requestOptions } : {}),
          });
          return {
            id: "bps_stripe_123",
            lastResponse: { requestId: "req_portal" },
            url: "https://billing.stripe.test/session",
          };
        },
      },
    },
    checkout: {
      sessions: {
        create: async (input, requestOptions) => {
          calls.push({
            input,
            operation: "checkout.sessions.create",
            ...(requestOptions ? { options: requestOptions } : {}),
          });
          return {
            expires_at: 1_780_272_000,
            id: "cs_stripe_123",
            lastResponse: { requestId: "req_checkout" },
            url: "https://checkout.stripe.test/session",
          };
        },
      },
    },
    customers: {
      create: async (input, requestOptions) => {
        calls.push({
          input,
          operation: "customers.create",
          ...(requestOptions ? { options: requestOptions } : {}),
        });
        if (options.failCustomerCreate) {
          throw Object.assign(new Error("Stripe customer create failed."), {
            code: "stripe_error",
          });
        }

        return {
          id: "cus_stripe_123",
          lastResponse: { requestId: "req_customer" },
        };
      },
    },
    subscriptions: {
      retrieve: async (providerSubscriptionId) => {
        calls.push({
          input: { providerSubscriptionId },
          operation: "subscriptions.retrieve",
        });
        return {
          current_period_end: 1_780_272_000,
          current_period_start: 1_777_593_600,
          customer: "cus_stripe_123",
          id: "sub_stripe_123",
          items: { data: [{ quantity: 7 }] },
          lastResponse: { requestId: "req_subscription" },
          metadata: { planKey: "business" },
          status: "active",
        };
      },
    },
  };
}

/** Returns a deterministic clock hook. */
function fixedClock(): () => string {
  return () => "2026-05-07T12:00:00.000Z";
}

/** Requires a recorded fake Stripe call. */
function requireCall(calls: readonly StripeClientCall[], index: number): StripeClientCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected Stripe call ${index} to exist.`);
  }

  return call;
}

/** Requires a recorded provider request log. */
function requireLog(
  logger: InMemoryBillingProviderRequestLogger,
  index: number,
): ReturnType<InMemoryBillingProviderRequestLogger["entries"]>[number] {
  const entry = logger.entries()[index];
  if (!entry) {
    throw new Error(`Expected provider request log ${index} to exist.`);
  }

  return entry;
}
