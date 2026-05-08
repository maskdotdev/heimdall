import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { billingProviderRequests } from "../schema";

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
