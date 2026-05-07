import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import Stripe from "stripe";

/** Non-secret provider metadata used for billing attribution. */
export type BillingProviderMetadata = Readonly<Record<string, unknown>>;

/** Header shape accepted by provider webhook parsers. */
export type BillingWebhookHeaders = Headers | Readonly<Record<string, string | undefined>>;

/** Input used to create or reuse a provider customer. */
export type CreateBillingCustomerInput = {
  /** Organization that owns the customer. */
  readonly orgId: string;
  /** Billing account associated with the customer when known. */
  readonly billingAccountId?: string;
  /** Billing email when available. */
  readonly billingEmail?: string;
  /** Billing display name when available. */
  readonly billingName?: string;
  /** Safe attribution metadata. */
  readonly metadata?: BillingProviderMetadata;
  /** Optional idempotency key for retry-safe provider calls. */
  readonly idempotencyKey?: string;
};

/** Provider customer reference persisted in local billing account mirrors. */
export type BillingCustomerRef = {
  /** Provider name. */
  readonly provider: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
};

/** Input used to create a checkout session. */
export type CreateCheckoutSessionInput = {
  /** Organization that owns the checkout flow. */
  readonly orgId: string;
  /** Billing account associated with the checkout flow when known. */
  readonly billingAccountId?: string;
  /** Existing provider customer ID when one has already been created. */
  readonly providerCustomerId?: string;
  /** Plan key being purchased. */
  readonly planKey: string;
  /** URL the provider redirects to on success. */
  readonly successUrl: string;
  /** URL the provider redirects to when checkout is cancelled. */
  readonly cancelUrl: string;
  /** Optional subscription quantity. */
  readonly quantity?: number;
  /** Safe attribution metadata. */
  readonly metadata?: BillingProviderMetadata;
  /** Optional idempotency key for retry-safe provider calls. */
  readonly idempotencyKey?: string;
};

/** Provider checkout session reference returned to application code. */
export type CheckoutSessionRef = {
  /** Provider name. */
  readonly provider: string;
  /** Provider checkout session ID. */
  readonly checkoutSessionId: string;
  /** Redirect URL for checkout. */
  readonly url: string;
  /** Session expiry timestamp. */
  readonly expiresAt: string;
};

/** Input used to create a customer portal session. */
export type CreatePortalSessionInput = {
  /** Organization that owns the portal flow. */
  readonly orgId: string;
  /** Billing account associated with the portal flow when known. */
  readonly billingAccountId?: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** URL the provider redirects to when the portal flow exits. */
  readonly returnUrl: string;
  /** Optional idempotency key for retry-safe provider calls. */
  readonly idempotencyKey?: string;
};

/** Provider customer portal session reference. */
export type PortalSessionRef = {
  /** Provider name. */
  readonly provider: string;
  /** Provider portal session ID. */
  readonly portalSessionId: string;
  /** Redirect URL for the customer portal. */
  readonly url: string;
};

/** Input used to retrieve a provider subscription. */
export type GetSubscriptionInput = {
  /** Organization associated with the subscription when known. */
  readonly orgId?: string;
  /** Billing account associated with the subscription when known. */
  readonly billingAccountId?: string;
  /** Provider subscription ID. */
  readonly providerSubscriptionId: string;
};

/** Provider subscription state normalized for local mirrors. */
export type ProviderSubscription = {
  /** Provider name. */
  readonly provider: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Provider subscription ID. */
  readonly providerSubscriptionId: string;
  /** Provider subscription status. */
  readonly status: string;
  /** Plan key when the provider event can be mapped locally. */
  readonly planKey?: string;
  /** Current billing period start. */
  readonly currentPeriodStart?: string;
  /** Current billing period end. */
  readonly currentPeriodEnd?: string;
  /** Subscription quantity when present. */
  readonly quantity?: number;
  /** Safe provider status payload. */
  readonly rawProviderStatus: BillingProviderMetadata;
};

/** Input used to send one provider meter event. */
export type SendMeterEventInput = {
  /** Organization that owns the metered usage. */
  readonly orgId: string;
  /** Billing account associated with the meter event when known. */
  readonly billingAccountId?: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Provider meter key. */
  readonly meterKey: string;
  /** Positive usage quantity. */
  readonly quantity: number;
  /** Usage timestamp. */
  readonly timestamp: string;
  /** Provider idempotency key. */
  readonly idempotencyKey: string;
  /** Safe attribution metadata. */
  readonly metadata?: BillingProviderMetadata;
};

/** Provider meter event reference. */
export type ProviderMeterEventRef = {
  /** Provider name. */
  readonly provider: string;
  /** Provider meter event ID. */
  readonly providerMeterEventId: string;
  /** Idempotency key used with the provider. */
  readonly idempotencyKey: string;
  /** Send status. */
  readonly status: "sent";
};

/** Input used to parse a provider webhook. */
export type ParseBillingWebhookInput = {
  /** Request headers from the webhook request. */
  readonly headers: BillingWebhookHeaders;
  /** Raw webhook request body. */
  readonly rawBody: Uint8Array;
};

/** Provider webhook event normalized for local billing processors. */
export type ParsedBillingWebhookEvent = {
  /** Provider name. */
  readonly provider: string;
  /** Provider event ID used for idempotency. */
  readonly providerEventId: string;
  /** Provider event type. */
  readonly eventType: string;
  /** Related provider customer ID when available. */
  readonly relatedProviderCustomerId?: string;
  /** Related provider subscription ID when available. */
  readonly relatedProviderSubscriptionId?: string;
  /** Normalized subscription payload when the event carries subscription state. */
  readonly subscription?: ProviderSubscription;
  /** Safe raw event payload for debugging. */
  readonly rawEvent: BillingProviderMetadata;
};

/** Provider-neutral billing adapter used by API routes and workers. */
export type BillingProvider = {
  /** Creates or reuses a provider customer. */
  readonly createCustomer: (input: CreateBillingCustomerInput) => Promise<BillingCustomerRef>;
  /** Creates a provider checkout session. */
  readonly createCheckoutSession: (
    input: CreateCheckoutSessionInput,
  ) => Promise<CheckoutSessionRef>;
  /** Creates a provider customer portal session. */
  readonly createCustomerPortalSession: (
    input: CreatePortalSessionInput,
  ) => Promise<PortalSessionRef>;
  /** Retrieves provider subscription state. */
  readonly getSubscription: (input: GetSubscriptionInput) => Promise<ProviderSubscription>;
  /** Sends one provider meter event idempotently. */
  readonly sendMeterEvent: (input: SendMeterEventInput) => Promise<ProviderMeterEventRef>;
  /** Parses and verifies a provider webhook. */
  readonly parseWebhook: (input: ParseBillingWebhookInput) => Promise<ParsedBillingWebhookEvent>;
};

/** Status stored for outbound provider request audit rows. */
export type BillingProviderRequestStatus = "succeeded" | "failed";

/** Outbound provider request audit entry. */
export type BillingProviderRequestLogInput = {
  /** Organization associated with the provider request when known. */
  readonly orgId?: string;
  /** Billing account associated with the provider request when known. */
  readonly billingAccountId?: string;
  /** Provider name. */
  readonly provider: string;
  /** Provider operation name. */
  readonly operation: string;
  /** Provider idempotency key when used. */
  readonly idempotencyKey?: string;
  /** Provider request ID when available. */
  readonly providerRequestId?: string;
  /** Request status. */
  readonly status: BillingProviderRequestStatus;
  /** Provider error code when a request failed. */
  readonly errorCode?: string;
  /** Provider error message when a request failed. */
  readonly errorMessage?: string;
  /** Non-secret request metadata. */
  readonly requestMetadata: BillingProviderMetadata;
  /** Non-secret response metadata. */
  readonly responseMetadata: BillingProviderMetadata;
  /** Request start timestamp. */
  readonly startedAt: string;
  /** Request completion timestamp. */
  readonly completedAt?: string;
};

/** Logger for durable provider request audit rows. */
export type BillingProviderRequestLogger = {
  /** Records one provider request outcome. */
  readonly record: (input: BillingProviderRequestLogInput) => Promise<void>;
};

/** No-op provider request logger used when durable logging is composed elsewhere. */
export class NoopBillingProviderRequestLogger implements BillingProviderRequestLogger {
  /** Ignores one provider request outcome. */
  public async record(_input: BillingProviderRequestLogInput): Promise<void> {}
}

/** In-memory provider request logger for tests. */
export class InMemoryBillingProviderRequestLogger implements BillingProviderRequestLogger {
  private readonly rows: BillingProviderRequestLogInput[] = [];

  /** Records one provider request outcome. */
  public async record(input: BillingProviderRequestLogInput): Promise<void> {
    this.rows.push(input);
  }

  /** Returns recorded rows in insertion order. */
  public entries(): readonly BillingProviderRequestLogInput[] {
    return this.rows;
  }
}

/** Minimal Stripe client surface used by the adapter and tests. */
export type StripeBillingClient = {
  /** Customer API methods. */
  readonly customers: {
    /** Creates a Stripe customer. */
    readonly create: (
      input: BillingProviderMetadata,
      options?: StripeRequestOptions,
    ) => Promise<BillingProviderMetadata>;
  };
  /** Checkout API methods. */
  readonly checkout: {
    /** Checkout session API methods. */
    readonly sessions: {
      /** Creates a Stripe Checkout Session. */
      readonly create: (
        input: BillingProviderMetadata,
        options?: StripeRequestOptions,
      ) => Promise<BillingProviderMetadata>;
    };
  };
  /** Customer portal API methods. */
  readonly billingPortal: {
    /** Portal session API methods. */
    readonly sessions: {
      /** Creates a Stripe customer portal session. */
      readonly create: (
        input: BillingProviderMetadata,
        options?: StripeRequestOptions,
      ) => Promise<BillingProviderMetadata>;
    };
  };
  /** Subscription API methods. */
  readonly subscriptions: {
    /** Retrieves a Stripe subscription. */
    readonly retrieve: (id: string) => Promise<BillingProviderMetadata>;
  };
  /** Optional Stripe billing APIs used by later metered sync work. */
  readonly billing?: {
    /** Meter event API methods. */
    readonly meterEvents?: {
      /** Creates a meter event. */
      readonly create: (
        input: BillingProviderMetadata,
        options?: StripeRequestOptions,
      ) => Promise<BillingProviderMetadata>;
    };
  };
  /** Optional Stripe webhook helpers. */
  readonly webhooks?: {
    /** Constructs and verifies a Stripe event. */
    readonly constructEvent?: (
      payload: string | Buffer,
      signature: string,
      secret: string,
    ) => unknown;
  };
};

/** Stripe request options used for idempotency. */
export type StripeRequestOptions = {
  /** Stripe idempotency key. */
  readonly idempotencyKey?: string;
};

/** Options for the Stripe billing provider. */
export type StripeBillingProviderOptions = {
  /** Stripe secret key. Required when client is not provided. */
  readonly apiKey?: string;
  /** Injected Stripe client for tests. */
  readonly client?: StripeBillingClient;
  /** Stripe Checkout recurring price IDs keyed by local plan key. */
  readonly checkoutPriceByPlanKey: Readonly<Record<string, string>>;
  /** Stripe webhook signing secret. Required for verified webhook parsing. */
  readonly webhookSecret?: string;
  /** Provider request logger. Defaults to no-op. */
  readonly requestLogger?: BillingProviderRequestLogger;
  /** Clock hook for deterministic logs and tests. */
  readonly now?: () => string;
};

/** Options for the fake billing provider. */
export type FakeBillingProviderOptions = {
  /** Base URL used for fake checkout and portal redirect URLs. */
  readonly baseUrl?: string;
  /** Clock hook for deterministic tests. */
  readonly now?: () => string;
};

/** Stripe billing provider backed by Stripe Customers, Checkout, Portal, and Subscription APIs. */
export class StripeBillingProvider implements BillingProvider {
  private readonly provider = "stripe";
  private readonly client: StripeBillingClient;
  private readonly requestLogger: BillingProviderRequestLogger;
  private readonly now: () => string;

  /** Creates a Stripe billing provider. */
  public constructor(private readonly options: StripeBillingProviderOptions) {
    this.client =
      options.client ??
      (new Stripe(requireApiKey(options.apiKey)) as unknown as StripeBillingClient);
    this.requestLogger = options.requestLogger ?? new NoopBillingProviderRequestLogger();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Creates a Stripe customer for one organization. */
  public async createCustomer(input: CreateBillingCustomerInput): Promise<BillingCustomerRef> {
    const idempotencyKey =
      input.idempotencyKey ?? billingProviderIdempotencyKey("stripe.customer", [input.orgId]);
    return this.recordProviderCall(
      "customers.create",
      {
        billingAccountId: input.billingAccountId,
        idempotencyKey,
        orgId: input.orgId,
        requestMetadata: {
          hasBillingEmail: Boolean(input.billingEmail),
          hasBillingName: Boolean(input.billingName),
          orgId: input.orgId,
        },
      },
      async () => {
        const customer = await this.client.customers.create(
          withoutUndefined({
            email: input.billingEmail,
            metadata: stripeMetadata({ ...input.metadata, orgId: input.orgId }),
            name: input.billingName,
          }),
          { idempotencyKey },
        );
        const providerCustomerId = stringField(customer, "id");
        if (!providerCustomerId) {
          throw new Error("Stripe customer response did not include an id.");
        }

        return {
          providerRequestId: stripeRequestId(customer),
          responseMetadata: { providerCustomerId },
          result: { provider: this.provider, providerCustomerId },
        };
      },
    );
  }

  /** Creates a Stripe Checkout Session for a subscription purchase. */
  public async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionRef> {
    const providerCustomerId =
      input.providerCustomerId ?? (await this.createCustomer(input)).providerCustomerId;
    const priceId = this.options.checkoutPriceByPlanKey[input.planKey];
    if (!priceId) {
      throw new Error(`Stripe checkout price is not configured for plan ${input.planKey}.`);
    }
    const idempotencyKey =
      input.idempotencyKey ??
      billingProviderIdempotencyKey("stripe.checkout", [
        input.orgId,
        input.planKey,
        input.quantity ?? 1,
        input.successUrl,
        input.cancelUrl,
      ]);

    return this.recordProviderCall(
      "checkout.sessions.create",
      {
        billingAccountId: input.billingAccountId,
        idempotencyKey,
        orgId: input.orgId,
        requestMetadata: {
          orgId: input.orgId,
          planKey: input.planKey,
          priceId,
          quantity: input.quantity ?? 1,
        },
      },
      async () => {
        const session = await this.client.checkout.sessions.create(
          {
            cancel_url: input.cancelUrl,
            client_reference_id: input.orgId,
            customer: providerCustomerId,
            line_items: [{ price: priceId, quantity: input.quantity ?? 1 }],
            metadata: stripeMetadata({
              ...input.metadata,
              orgId: input.orgId,
              planKey: input.planKey,
            }),
            mode: "subscription",
            success_url: input.successUrl,
          },
          { idempotencyKey },
        );
        const checkoutSessionId = stringField(session, "id");
        const url = stringField(session, "url");
        if (!checkoutSessionId || !url) {
          throw new Error("Stripe checkout session response did not include an id and url.");
        }

        return {
          providerRequestId: stripeRequestId(session),
          responseMetadata: { checkoutSessionId },
          result: {
            checkoutSessionId,
            expiresAt: isoFromUnixSeconds(numberField(session, "expires_at")) ?? this.now(),
            provider: this.provider,
            url,
          },
        };
      },
    );
  }

  /** Creates a Stripe customer portal session. */
  public async createCustomerPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<PortalSessionRef> {
    const idempotencyKey =
      input.idempotencyKey ??
      billingProviderIdempotencyKey("stripe.portal", [input.orgId, input.providerCustomerId]);
    return this.recordProviderCall(
      "billingPortal.sessions.create",
      {
        billingAccountId: input.billingAccountId,
        idempotencyKey,
        orgId: input.orgId,
        requestMetadata: {
          orgId: input.orgId,
          providerCustomerId: input.providerCustomerId,
        },
      },
      async () => {
        const session = await this.client.billingPortal.sessions.create(
          {
            customer: input.providerCustomerId,
            return_url: input.returnUrl,
          },
          { idempotencyKey },
        );
        const portalSessionId = stringField(session, "id");
        const url = stringField(session, "url");
        if (!portalSessionId || !url) {
          throw new Error("Stripe portal session response did not include an id and url.");
        }

        return {
          providerRequestId: stripeRequestId(session),
          responseMetadata: { portalSessionId },
          result: { portalSessionId, provider: this.provider, url },
        };
      },
    );
  }

  /** Retrieves a Stripe subscription and normalizes the state used by local mirrors. */
  public async getSubscription(input: GetSubscriptionInput): Promise<ProviderSubscription> {
    return this.recordProviderCall(
      "subscriptions.retrieve",
      {
        billingAccountId: input.billingAccountId,
        orgId: input.orgId,
        requestMetadata: { providerSubscriptionId: input.providerSubscriptionId },
      },
      async () => {
        const subscription = await this.client.subscriptions.retrieve(input.providerSubscriptionId);
        return {
          providerRequestId: stripeRequestId(subscription),
          responseMetadata: { providerSubscriptionId: input.providerSubscriptionId },
          result: stripeSubscriptionFromObject(subscription),
        };
      },
    );
  }

  /** Sends a Stripe meter event idempotently when the configured client exposes meter events. */
  public async sendMeterEvent(input: SendMeterEventInput): Promise<ProviderMeterEventRef> {
    const createMeterEvent = this.client.billing?.meterEvents?.create;
    if (!createMeterEvent) {
      throw new Error("Stripe meter events are not available on the configured Stripe client.");
    }

    return this.recordProviderCall(
      "billing.meterEvents.create",
      {
        billingAccountId: input.billingAccountId,
        idempotencyKey: input.idempotencyKey,
        orgId: input.orgId,
        requestMetadata: {
          meterKey: input.meterKey,
          orgId: input.orgId,
          quantity: input.quantity,
        },
      },
      async () => {
        const event = await createMeterEvent(
          {
            event_name: input.meterKey,
            identifier: input.idempotencyKey,
            payload: {
              stripe_customer_id: input.providerCustomerId,
              value: input.quantity.toString(),
              ...stripeMetadata(input.metadata ?? {}),
            },
            timestamp: Math.floor(Date.parse(input.timestamp) / 1_000),
          },
          { idempotencyKey: input.idempotencyKey },
        );
        const providerMeterEventId = stringField(event, "id") ?? input.idempotencyKey;
        return {
          providerRequestId: stripeRequestId(event),
          responseMetadata: { providerMeterEventId },
          result: {
            idempotencyKey: input.idempotencyKey,
            provider: this.provider,
            providerMeterEventId,
            status: "sent",
          },
        };
      },
    );
  }

  /** Parses a Stripe webhook, verifying it when a webhook secret is configured. */
  public async parseWebhook(input: ParseBillingWebhookInput): Promise<ParsedBillingWebhookEvent> {
    const event = this.options.webhookSecret
      ? asRecord(
          this.client.webhooks?.constructEvent?.(
            Buffer.from(input.rawBody).toString("utf8"),
            headerValue(input.headers, "stripe-signature") ?? "",
            this.options.webhookSecret,
          ),
        )
      : asRecord(JSON.parse(Buffer.from(input.rawBody).toString("utf8")));
    const providerEventId = stringField(event, "id");
    const eventType = stringField(event, "type");
    if (!providerEventId || !eventType) {
      throw new Error("Stripe webhook event must include id and type.");
    }

    const object = webhookObject(event);
    const subscription = stripeSubscriptionFromMaybeObject(object);
    return {
      eventType,
      provider: this.provider,
      providerEventId,
      rawEvent: event,
      ...(subscription
        ? {
            relatedProviderCustomerId: subscription.providerCustomerId,
            relatedProviderSubscriptionId: subscription.providerSubscriptionId,
            subscription,
          }
        : {
            ...optionalRelatedProviderCustomerId(object),
            ...optionalRelatedProviderSubscriptionId(object),
          }),
    };
  }

  /** Records one outbound provider call and returns the provider result. */
  private async recordProviderCall<Result>(
    operation: string,
    input: {
      readonly orgId?: string | undefined;
      readonly billingAccountId?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly requestMetadata: BillingProviderMetadata;
    },
    call: () => Promise<{
      readonly providerRequestId?: string | undefined;
      readonly responseMetadata: BillingProviderMetadata;
      readonly result: Result;
    }>,
  ): Promise<Result> {
    const startedAt = this.now();
    try {
      const output = await call();
      await this.requestLogger.record(
        withoutUndefined({
          billingAccountId: input.billingAccountId,
          completedAt: this.now(),
          idempotencyKey: input.idempotencyKey,
          operation,
          orgId: input.orgId,
          provider: this.provider,
          providerRequestId: output.providerRequestId,
          requestMetadata: input.requestMetadata,
          responseMetadata: output.responseMetadata,
          startedAt,
          status: "succeeded",
        }) as BillingProviderRequestLogInput,
      );
      return output.result;
    } catch (error) {
      await this.requestLogger.record(
        withoutUndefined({
          billingAccountId: input.billingAccountId,
          completedAt: this.now(),
          errorCode: providerErrorCode(error),
          errorMessage: providerErrorMessage(error),
          idempotencyKey: input.idempotencyKey,
          operation,
          orgId: input.orgId,
          provider: this.provider,
          requestMetadata: input.requestMetadata,
          responseMetadata: {},
          startedAt,
          status: "failed",
        }) as BillingProviderRequestLogInput,
      );
      throw error;
    }
  }
}

/** Input used to complete a fake checkout session in tests and local tools. */
export type CompleteFakeCheckoutInput = {
  /** Fake checkout session ID. */
  readonly checkoutSessionId: string;
  /** Subscription status to emit. Defaults to active. */
  readonly status?: string;
};

/** Input used to build a fake subscription webhook fixture. */
export type CreateFakeSubscriptionWebhookFixtureInput = {
  /** Provider event ID. */
  readonly providerEventId: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Provider subscription ID. */
  readonly providerSubscriptionId: string;
  /** Provider event type. */
  readonly eventType?: string;
  /** Subscription status. */
  readonly status?: string;
  /** Local plan key when known. */
  readonly planKey?: string;
  /** Subscription quantity when known. */
  readonly quantity?: number;
  /** Current period start. */
  readonly currentPeriodStart?: string;
  /** Current period end. */
  readonly currentPeriodEnd?: string;
};

/** Fake webhook request fixture. */
export type FakeBillingWebhookFixture = {
  /** Request headers to pass to parseWebhook. */
  readonly headers: Readonly<Record<string, string>>;
  /** Raw request body to pass to parseWebhook. */
  readonly rawBody: Uint8Array;
  /** Parsed JSON payload for assertions. */
  readonly event: BillingProviderMetadata;
};

type FakeCheckoutSession = {
  /** Organization that started checkout. */
  readonly orgId: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Local plan key. */
  readonly planKey: string;
  /** Requested subscription quantity. */
  readonly quantity: number;
};

/** Deterministic fake billing provider for local tests and CI. */
export class FakeBillingProvider implements BillingProvider {
  private readonly provider = "fake";
  private readonly customerIdsByOrgId = new Map<string, string>();
  private readonly checkoutSessionsById = new Map<string, FakeCheckoutSession>();
  private readonly subscriptionsById = new Map<string, ProviderSubscription>();
  private readonly meterEventsByIdempotencyKey = new Map<string, ProviderMeterEventRef>();
  private sequence = 0;

  /** Creates a fake provider. */
  public constructor(private readonly options: FakeBillingProviderOptions = {}) {}

  /** Creates or reuses a fake customer for one organization. */
  public async createCustomer(input: CreateBillingCustomerInput): Promise<BillingCustomerRef> {
    const existing = this.customerIdsByOrgId.get(input.orgId);
    if (existing) {
      return { provider: this.provider, providerCustomerId: existing };
    }

    const providerCustomerId = stableFakeId("cus_fake", ["customer", input.orgId]);
    this.customerIdsByOrgId.set(input.orgId, providerCustomerId);
    return { provider: this.provider, providerCustomerId };
  }

  /** Creates a fake checkout session URL. */
  public async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionRef> {
    const providerCustomerId =
      input.providerCustomerId ??
      (
        await this.createCustomer({
          orgId: input.orgId,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
      ).providerCustomerId;
    const checkoutSessionId = this.nextId("cs_fake", [
      "checkout",
      input.orgId,
      input.planKey,
      providerCustomerId,
    ]);
    this.checkoutSessionsById.set(checkoutSessionId, {
      orgId: input.orgId,
      planKey: input.planKey,
      providerCustomerId,
      quantity: input.quantity ?? 1,
    });

    return {
      checkoutSessionId,
      expiresAt: addHours(this.now(), 1),
      provider: this.provider,
      url: fakeUrl(this.baseUrl(), "checkout", checkoutSessionId, {
        cancel_url: input.cancelUrl,
        success_url: input.successUrl,
      }),
    };
  }

  /** Creates a fake customer portal URL. */
  public async createCustomerPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<PortalSessionRef> {
    const portalSessionId = this.nextId("bps_fake", [
      "portal",
      input.orgId,
      input.providerCustomerId,
    ]);

    return {
      portalSessionId,
      provider: this.provider,
      url: fakeUrl(this.baseUrl(), "portal", portalSessionId, {
        return_url: input.returnUrl,
      }),
    };
  }

  /** Gets a fake subscription by provider ID. */
  public async getSubscription(input: GetSubscriptionInput): Promise<ProviderSubscription> {
    const subscription = this.subscriptionsById.get(input.providerSubscriptionId);
    if (!subscription) {
      throw new Error(`Fake subscription ${input.providerSubscriptionId} was not found.`);
    }

    return subscription;
  }

  /** Sends a fake meter event idempotently. */
  public async sendMeterEvent(input: SendMeterEventInput): Promise<ProviderMeterEventRef> {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new Error("Fake meter event quantity must be a positive safe integer.");
    }

    const existing = this.meterEventsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const event = {
      idempotencyKey: input.idempotencyKey,
      provider: this.provider,
      providerMeterEventId: stableFakeId("mtr_fake", [
        "meter",
        input.providerCustomerId,
        input.meterKey,
        input.idempotencyKey,
      ]),
      status: "sent" as const,
    };
    this.meterEventsByIdempotencyKey.set(input.idempotencyKey, event);
    return event;
  }

  /** Parses a fake billing webhook body. */
  public async parseWebhook(input: ParseBillingWebhookInput): Promise<ParsedBillingWebhookEvent> {
    const rawEvent = asRecord(JSON.parse(Buffer.from(input.rawBody).toString("utf8")));
    const providerEventId = stringField(rawEvent, "id") ?? stringField(rawEvent, "providerEventId");
    const eventType = stringField(rawEvent, "type") ?? stringField(rawEvent, "eventType");
    if (!providerEventId || !eventType) {
      throw new Error("Fake billing webhook must include id and type.");
    }

    const object = webhookObject(rawEvent);
    const subscription = subscriptionFromWebhookObject(this.provider, object);
    if (subscription) {
      this.subscriptionsById.set(subscription.providerSubscriptionId, subscription);
    }

    return {
      eventType,
      provider: this.provider,
      providerEventId,
      rawEvent,
      ...(subscription
        ? {
            relatedProviderCustomerId: subscription.providerCustomerId,
            relatedProviderSubscriptionId: subscription.providerSubscriptionId,
            subscription,
          }
        : {}),
    };
  }

  /** Completes a fake checkout session and emits a normalized webhook event. */
  public async completeCheckoutSession(
    input: CompleteFakeCheckoutInput,
  ): Promise<ParsedBillingWebhookEvent> {
    const session = this.checkoutSessionsById.get(input.checkoutSessionId);
    if (!session) {
      throw new Error(`Fake checkout session ${input.checkoutSessionId} was not found.`);
    }

    const currentPeriodStart = this.now();
    const fixture = createFakeSubscriptionWebhookFixture({
      currentPeriodEnd: addDays(currentPeriodStart, 30),
      currentPeriodStart,
      eventType: "checkout.session.completed",
      planKey: session.planKey,
      providerCustomerId: session.providerCustomerId,
      providerEventId: this.nextId("evt_fake", ["checkout.completed", input.checkoutSessionId]),
      providerSubscriptionId: stableFakeId("sub_fake", [
        "subscription",
        session.providerCustomerId,
        session.planKey,
      ]),
      quantity: session.quantity,
      status: input.status ?? "active",
    });

    return this.parseWebhook(fixture);
  }

  /** Returns the fake redirect base URL. */
  private baseUrl(): string {
    return this.options.baseUrl ?? "https://billing.fake.heimdall.local";
  }

  /** Returns the current timestamp. */
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  /** Returns a unique fake provider ID. */
  private nextId(prefix: string, parts: readonly unknown[]): string {
    this.sequence += 1;
    return stableFakeId(prefix, [...parts, this.sequence]);
  }
}

/** Creates a fake provider subscription webhook fixture. */
export function createFakeSubscriptionWebhookFixture(
  input: CreateFakeSubscriptionWebhookFixtureInput,
): FakeBillingWebhookFixture {
  const event = {
    data: {
      object: withoutUndefined({
        currentPeriodEnd: input.currentPeriodEnd,
        currentPeriodStart: input.currentPeriodStart,
        planKey: input.planKey,
        providerCustomerId: input.providerCustomerId,
        providerSubscriptionId: input.providerSubscriptionId,
        quantity: input.quantity,
        status: input.status ?? "active",
      }),
    },
    id: input.providerEventId,
    type: input.eventType ?? "customer.subscription.updated",
  };

  return {
    event,
    headers: {
      "content-type": "application/json",
      "x-fake-billing-event-id": input.providerEventId,
    },
    rawBody: Buffer.from(JSON.stringify(event)),
  };
}

/** Returns a stable provider idempotency key from bounded, non-secret inputs. */
export function billingProviderIdempotencyKey(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

/** Requires a Stripe API key when a test client is not injected. */
function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error("StripeBillingProvider requires apiKey when client is not provided.");
  }

  return apiKey;
}

/** Converts provider metadata to the primitive string map accepted by Stripe metadata fields. */
function stripeMetadata(metadata: BillingProviderMetadata): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      entries.push([key, value]);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      entries.push([key, value.toString()]);
    }
  }

  return Object.fromEntries(entries);
}

/** Reads a Stripe request ID from the SDK response metadata. */
function stripeRequestId(response: BillingProviderMetadata): string | undefined {
  return stringField(asRecord(response.lastResponse), "requestId");
}

/** Converts Unix seconds to an ISO timestamp. */
function isoFromUnixSeconds(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1_000).toISOString();
}

/** Converts a required Stripe subscription object to provider-neutral subscription state. */
function stripeSubscriptionFromObject(object: BillingProviderMetadata): ProviderSubscription {
  const subscription = stripeSubscriptionFromMaybeObject(object);
  if (!subscription) {
    throw new Error("Stripe subscription response did not include required subscription fields.");
  }

  return subscription;
}

/** Converts a Stripe object to provider-neutral subscription state when it carries subscription data. */
function stripeSubscriptionFromMaybeObject(
  object: BillingProviderMetadata,
): ProviderSubscription | undefined {
  const providerSubscriptionId =
    stringField(object, "providerSubscriptionId") ??
    stringField(object, "subscription") ??
    stringField(object, "id");
  const providerCustomerId =
    stringField(object, "providerCustomerId") ?? stripeCustomerIdFromValue(object.customer);
  const status = stringField(object, "status");
  if (!providerCustomerId || !providerSubscriptionId || !status) {
    return undefined;
  }

  const metadata = asRecord(object.metadata);
  const currentPeriodStart =
    stringField(object, "currentPeriodStart") ??
    isoFromUnixSeconds(numberField(object, "current_period_start"));
  const currentPeriodEnd =
    stringField(object, "currentPeriodEnd") ??
    isoFromUnixSeconds(numberField(object, "current_period_end"));
  const planKey = stringField(object, "planKey") ?? stringField(metadata, "planKey");
  const quantity = numberField(object, "quantity") ?? stripeSubscriptionItemQuantity(object);

  return {
    provider: "stripe",
    providerCustomerId,
    providerSubscriptionId,
    rawProviderStatus: withoutUndefined({
      current_period_end: numberField(object, "current_period_end"),
      current_period_start: numberField(object, "current_period_start"),
      metadata,
      status,
    }),
    status,
    ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
    ...(currentPeriodStart ? { currentPeriodStart } : {}),
    ...(planKey ? { planKey } : {}),
    ...(quantity === undefined ? {} : { quantity }),
  };
}

/** Reads the Stripe customer ID from a string or expanded customer object. */
function stripeCustomerIdFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return stringField(asRecord(value), "id");
}

/** Reads the first subscription item quantity from a Stripe subscription object. */
function stripeSubscriptionItemQuantity(object: BillingProviderMetadata): number | undefined {
  const data = arrayField(asRecord(object.items), "data");
  const firstItem = asRecord(data[0]);
  return numberField(firstItem, "quantity");
}

/** Returns an optional related Stripe customer field for webhook events. */
function optionalRelatedProviderCustomerId(
  object: BillingProviderMetadata,
): Partial<ParsedBillingWebhookEvent> {
  const relatedProviderCustomerId =
    stringField(object, "providerCustomerId") ?? stripeCustomerIdFromValue(object.customer);
  return relatedProviderCustomerId ? { relatedProviderCustomerId } : {};
}

/** Returns an optional related Stripe subscription field for webhook events. */
function optionalRelatedProviderSubscriptionId(
  object: BillingProviderMetadata,
): Partial<ParsedBillingWebhookEvent> {
  const relatedProviderSubscriptionId =
    stringField(object, "providerSubscriptionId") ?? stringField(object, "subscription");
  return relatedProviderSubscriptionId ? { relatedProviderSubscriptionId } : {};
}

/** Reads one webhook header from Headers or a plain record. */
function headerValue(headers: BillingWebhookHeaders, key: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(key) ?? undefined;
  }

  return headers[key] ?? headers[key.toLowerCase()];
}

/** Reads a provider error code from a thrown SDK error. */
function providerErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  return stringField(record, "code") ?? stringField(record, "type");
}

/** Reads a safe provider error message from a thrown SDK error. */
function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns a stable fake provider ID. */
function stableFakeId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

/** Adds hours to an ISO timestamp. */
function addHours(timestamp: string, hours: number): string {
  return new Date(Date.parse(timestamp) + hours * 60 * 60 * 1_000).toISOString();
}

/** Adds days to an ISO timestamp. */
function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 24 * 60 * 60 * 1_000).toISOString();
}

/** Builds a fake provider URL. */
function fakeUrl(
  baseUrl: string,
  kind: "checkout" | "portal",
  id: string,
  params: Readonly<Record<string, string>>,
): string {
  const url = new URL(`/fake-billing/${kind}/${encodeURIComponent(id)}`, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Reads the provider object from a webhook event. */
function webhookObject(rawEvent: BillingProviderMetadata): BillingProviderMetadata {
  const data = asRecord(rawEvent.data);
  return asRecord(data?.object) ?? asRecord(rawEvent.object) ?? {};
}

/** Converts a fake webhook object to a provider subscription. */
function subscriptionFromWebhookObject(
  provider: string,
  object: BillingProviderMetadata,
): ProviderSubscription | undefined {
  const providerCustomerId =
    stringField(object, "providerCustomerId") ?? stringField(object, "customer");
  const providerSubscriptionId =
    stringField(object, "providerSubscriptionId") ?? stringField(object, "subscription");
  const status = stringField(object, "status");
  if (!providerCustomerId || !providerSubscriptionId || !status) {
    return undefined;
  }

  return {
    provider,
    providerCustomerId,
    providerSubscriptionId,
    rawProviderStatus: object,
    status,
    ...optionalNumberProperty("quantity", object),
    ...optionalStringProperty("currentPeriodEnd", object),
    ...optionalStringProperty("currentPeriodStart", object),
    ...optionalStringProperty("planKey", object),
  };
}

/** Returns an optional number property. */
function optionalNumberProperty(
  key: keyof Pick<ProviderSubscription, "quantity">,
  object: BillingProviderMetadata,
): Partial<ProviderSubscription> {
  const value = numberField(object, key);
  return value === undefined ? {} : { [key]: value };
}

/** Returns an optional string property. */
function optionalStringProperty(
  key: keyof Pick<ProviderSubscription, "currentPeriodEnd" | "currentPeriodStart" | "planKey">,
  object: BillingProviderMetadata,
): Partial<ProviderSubscription> {
  const value = stringField(object, key);
  return value ? { [key]: value } : {};
}

/** Reads a string field from a record. */
function stringField(object: BillingProviderMetadata, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a numeric field from a record. */
function numberField(object: BillingProviderMetadata, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads an array field from a record. */
function arrayField(object: BillingProviderMetadata, key: string): readonly unknown[] {
  const value = object[key];
  return Array.isArray(value) ? value : [];
}

/** Narrows unknown JSON to a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Removes undefined fields from shallow fixture objects. */
function withoutUndefined(value: BillingProviderMetadata): BillingProviderMetadata {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
