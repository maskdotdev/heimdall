import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { billingMeterEvents, billingProviderRequests, billingWebhookEvents } from "../schema";

/** Input used to record one outbound billing provider request. */
export type RecordBillingProviderRequestInput = {
  /** Organization associated with the provider request when known. */
  readonly orgId?: string | undefined;
  /** Billing account associated with the provider request when known. */
  readonly billingAccountId?: string | undefined;
  /** Provider name. */
  readonly provider: string;
  /** Provider operation name. */
  readonly operation: string;
  /** Provider idempotency key when used. */
  readonly idempotencyKey?: string | undefined;
  /** Provider request ID when available. */
  readonly providerRequestId?: string | undefined;
  /** Provider request status. */
  readonly status: string;
  /** Provider error code when a request failed. */
  readonly errorCode?: string | undefined;
  /** Provider error message when a request failed. */
  readonly errorMessage?: string | undefined;
  /** Product-safe request metadata. */
  readonly requestMetadata: Readonly<Record<string, unknown>>;
  /** Product-safe response metadata. */
  readonly responseMetadata: Readonly<Record<string, unknown>>;
  /** Request start timestamp. */
  readonly startedAt: Date | string;
  /** Request completion timestamp. */
  readonly completedAt?: Date | string | undefined;
};

/** Input used to list failed outbound billing provider requests for one organization. */
export type ListFailedBillingProviderRequestsInput = {
  /** Organization to inspect. */
  readonly orgId: string;
  /** Maximum number of failed requests to return. */
  readonly limit?: number | undefined;
};

/** Failed outbound billing provider request row used by admin reconciliation views. */
export type FailedBillingProviderRequestRecord = {
  /** Durable provider request audit row ID. */
  readonly billingProviderRequestId: string;
  /** Provider name. */
  readonly provider: string;
  /** Provider operation name. */
  readonly operation: string;
  /** Provider error message when available. */
  readonly errorMessage: string | null;
  /** Request start timestamp. */
  readonly startedAt: Date;
  /** Request completion timestamp when available. */
  readonly completedAt: Date | null;
};

/** Input used to list billing meter events for admin inspection. */
export type ListBillingMeterEventsInput = {
  /** Organization that owns the meter events. */
  readonly orgId: string;
  /** Optional meter event send status filter. */
  readonly status?: string | undefined;
  /** Optional billing period key filter. */
  readonly periodKey?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Billing meter event row used by admin inspection and reconciliation views. */
export type BillingMeterEventRecord = {
  /** Durable meter event row ID. */
  readonly billingMeterEventId: string;
  /** Billing account associated with the meter event. */
  readonly billingAccountId: string;
  /** Organization that owns the meter event. */
  readonly orgId: string;
  /** Billing provider that receives the meter event. */
  readonly provider: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Internal meter key. */
  readonly meterKey: string;
  /** Provider meter event name. */
  readonly providerEventName: string;
  /** Billing period key. */
  readonly periodKey: string;
  /** Inclusive period start. */
  readonly periodStart: Date;
  /** Exclusive period end. */
  readonly periodEnd: Date;
  /** Usage quantity planned for the provider. */
  readonly quantity: number;
  /** Provider idempotency key. */
  readonly idempotencyKey: string;
  /** Send status. */
  readonly status: string;
  /** Provider meter event ID after successful send. */
  readonly providerMeterEventId: string | null;
  /** Number of provider send attempts. */
  readonly attemptCount: number;
  /** Last provider error code when failed. */
  readonly lastErrorCode: string | null;
  /** Last provider error message when failed. */
  readonly lastErrorMessage: string | null;
  /** Usage event IDs included in this planned row. */
  readonly sourceUsageEventIds: unknown;
  /** Provider acceptance timestamp when sent. */
  readonly sentAt: Date | null;
  /** Row creation timestamp. */
  readonly createdAt: Date;
  /** Row update timestamp. */
  readonly updatedAt: Date;
};

/** Input used to list failed or stale billing meter events for reconciliation. */
export type ListBillingMeterSyncIssueRowsInput = {
  /** Organization that owns the meter events. */
  readonly orgId: string;
  /** Optional billing period key filter. */
  readonly periodKey?: string | undefined;
  /** Ready-to-send rows updated before this timestamp are stale. */
  readonly lagCutoff: Date | string;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Input used to list failed billing webhook rows for reconciliation. */
export type ListFailedBillingWebhookEventsInput = {
  /** Organization that owns the webhook rows. */
  readonly orgId: string;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Failed inbound billing webhook event row used by reconciliation views. */
export type FailedBillingWebhookEventRecord = {
  /** Durable billing webhook event row ID. */
  readonly billingWebhookEventId: string;
  /** Provider event type. */
  readonly eventType: string;
  /** Product-safe processing error. */
  readonly error: unknown;
  /** Webhook receipt timestamp. */
  readonly receivedAt: Date;
};

/** Query helper for billing audit rows. */
export class BillingRepository {
  /** Creates a billing query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Records one outbound billing provider request outcome idempotently. */
  public async recordBillingProviderRequest(
    input: RecordBillingProviderRequestInput,
  ): Promise<void> {
    await this.db
      .insert(billingProviderRequests)
      .values({
        ...billingProviderRequestMutableValues(input),
        billingProviderRequestId: `bpr_${randomUUID()}`,
        idempotencyKey: input.idempotencyKey ?? null,
        provider: input.provider,
      })
      .onConflictDoUpdate({
        target: [billingProviderRequests.provider, billingProviderRequests.idempotencyKey],
        set: billingProviderRequestMutableValues(input),
      });
  }

  /** Lists failed outbound billing provider requests for one organization. */
  public async listFailedBillingProviderRequests(
    input: ListFailedBillingProviderRequestsInput,
  ): Promise<readonly FailedBillingProviderRequestRecord[]> {
    return this.db
      .select({
        billingProviderRequestId: billingProviderRequests.billingProviderRequestId,
        completedAt: billingProviderRequests.completedAt,
        errorMessage: billingProviderRequests.errorMessage,
        operation: billingProviderRequests.operation,
        provider: billingProviderRequests.provider,
        startedAt: billingProviderRequests.startedAt,
      })
      .from(billingProviderRequests)
      .where(
        and(
          eq(billingProviderRequests.orgId, input.orgId),
          eq(billingProviderRequests.status, "failed"),
        ),
      )
      .orderBy(
        desc(billingProviderRequests.startedAt),
        desc(billingProviderRequests.billingProviderRequestId),
      )
      .limit(billingInspectionLimit(input.limit));
  }

  /** Lists billing meter events for admin inspection. */
  public async listBillingMeterEvents(
    input: ListBillingMeterEventsInput,
  ): Promise<readonly BillingMeterEventRecord[]> {
    const conditions = [eq(billingMeterEvents.orgId, input.orgId)];
    if (input.status) {
      conditions.push(eq(billingMeterEvents.status, input.status));
    }
    if (input.periodKey) {
      conditions.push(eq(billingMeterEvents.periodKey, input.periodKey));
    }

    return this.db
      .select()
      .from(billingMeterEvents)
      .where(and(...conditions))
      .orderBy(desc(billingMeterEvents.updatedAt), asc(billingMeterEvents.billingMeterEventId))
      .limit(billingInspectionLimit(input.limit));
  }

  /** Lists failed or stale billing meter events for reconciliation. */
  public async listBillingMeterSyncIssueRows(
    input: ListBillingMeterSyncIssueRowsInput,
  ): Promise<readonly BillingMeterEventRecord[]> {
    const lagCondition = and(
      eq(billingMeterEvents.status, "ready_to_send"),
      lt(billingMeterEvents.updatedAt, new Date(input.lagCutoff)),
    );
    const conditions = [
      eq(billingMeterEvents.orgId, input.orgId),
      or(eq(billingMeterEvents.status, "failed"), lagCondition ?? sql`false`) ?? sql`false`,
    ];
    if (input.periodKey) {
      conditions.push(eq(billingMeterEvents.periodKey, input.periodKey));
    }

    return this.db
      .select()
      .from(billingMeterEvents)
      .where(and(...conditions))
      .orderBy(desc(billingMeterEvents.updatedAt), asc(billingMeterEvents.billingMeterEventId))
      .limit(billingInspectionLimit(input.limit));
  }

  /** Lists failed inbound billing webhooks for reconciliation. */
  public async listFailedBillingWebhookEvents(
    input: ListFailedBillingWebhookEventsInput,
  ): Promise<readonly FailedBillingWebhookEventRecord[]> {
    return this.db
      .select({
        billingWebhookEventId: billingWebhookEvents.billingWebhookEventId,
        error: billingWebhookEvents.error,
        eventType: billingWebhookEvents.eventType,
        receivedAt: billingWebhookEvents.receivedAt,
      })
      .from(billingWebhookEvents)
      .where(
        and(eq(billingWebhookEvents.orgId, input.orgId), eq(billingWebhookEvents.status, "failed")),
      )
      .orderBy(
        desc(billingWebhookEvents.receivedAt),
        asc(billingWebhookEvents.billingWebhookEventId),
      )
      .limit(billingInspectionLimit(input.limit));
  }
}

/** Builds mutable billing provider request values for inserts and conflict updates. */
function billingProviderRequestMutableValues(input: RecordBillingProviderRequestInput) {
  return {
    billingAccountId: input.billingAccountId ?? null,
    completedAt: optionalDate(input.completedAt),
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    operation: input.operation,
    orgId: input.orgId ?? null,
    providerRequestId: input.providerRequestId ?? null,
    requestMetadata: input.requestMetadata,
    responseMetadata: input.responseMetadata,
    startedAt: new Date(input.startedAt),
    status: input.status,
  };
}

/** Converts an optional timestamp to a Date or null. */
function optionalDate(value: Date | string | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Validates a bounded billing inspection list limit. */
function billingInspectionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Billing inspection list limit must be an integer between 1 and 100.");
  }

  return limit;
}
