import type { ContractError, WebhookEvent } from "@repo/contracts";
import { and, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { webhookEvents } from "../schema";
import { toWebhookEvent } from "./row-mappers";

/** Database surface required by webhook repository methods. */
type WebhookRepositoryDatabase = Pick<HeimdallDatabase, "insert" | "select" | "update">;

/** Provider delivery identity used for idempotent webhook lookups. */
export type WebhookDeliveryIdentity = {
  /** Git provider that sent the webhook. */
  readonly provider: WebhookEvent["provider"];
  /** Provider-native delivery ID. */
  readonly deliveryId: string;
};

/** Input for inserting an inbound webhook event. */
export type InsertWebhookEventInput = WebhookEvent & {
  /** Optional organization ID used for tenant-scoped debugging queries. */
  readonly orgId?: string;
  /** Optional parsed payload retained for internal debugging. */
  readonly payload?: Record<string, unknown>;
};

/** Result for an idempotent webhook event insert. */
export type InsertWebhookEventResult = {
  /** Contract-shaped webhook event row. */
  readonly event: WebhookEvent;
  /** Whether this call inserted the row. */
  readonly inserted: boolean;
};

/** Input for marking a webhook event as failed. */
export type MarkWebhookFailedInput = {
  /** Stable webhook event ID. */
  readonly webhookEventId: string;
  /** Product-safe failure payload. */
  readonly error: ContractError;
  /** Processing completion timestamp, defaulting to now. */
  readonly processedAt?: string;
};

/** Query helper for inbound webhook event idempotency and status transitions. */
export class WebhookRepository {
  /** Creates a webhook query helper. */
  public constructor(private readonly db: WebhookRepositoryDatabase) {}

  /** Inserts a webhook event by provider delivery ID without duplicating deliveries. */
  public async insertWebhookEvent(
    input: InsertWebhookEventInput,
  ): Promise<InsertWebhookEventResult> {
    const [insertedRow] = await this.db
      .insert(webhookEvents)
      .values({
        webhookEventId: input.webhookEventId,
        provider: input.provider,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        action: input.action,
        installationId: input.installationId,
        orgId: input.orgId,
        repoId: input.repoId,
        receivedAt: new Date(input.receivedAt),
        processedAt: input.processedAt ? new Date(input.processedAt) : undefined,
        status: input.status,
        payloadHash: input.payloadHash,
        payload: input.payload,
        error: input.error,
        metadata: input.metadata,
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.deliveryId],
      })
      .returning();

    if (insertedRow) {
      return { event: toWebhookEvent(insertedRow), inserted: true };
    }

    const existing = await this.getWebhookEventByDelivery(input);
    if (!existing) {
      throw new Error("Webhook insert conflicted but no existing delivery row was found.");
    }

    return { event: existing, inserted: false };
  }

  /** Gets a webhook event by stable event ID. */
  public async getWebhookEvent(webhookEventId: string): Promise<WebhookEvent | undefined> {
    const [row] = await this.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.webhookEventId, webhookEventId))
      .limit(1);

    return row ? toWebhookEvent(row) : undefined;
  }

  /** Gets a webhook event by provider delivery identity. */
  public async getWebhookEventByDelivery(
    input: WebhookDeliveryIdentity,
  ): Promise<WebhookEvent | undefined> {
    const [row] = await this.db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, input.provider),
          eq(webhookEvents.deliveryId, input.deliveryId),
        ),
      )
      .limit(1);

    return row ? toWebhookEvent(row) : undefined;
  }

  /** Marks a webhook event as actively processing. */
  public async markWebhookProcessing(webhookEventId: string): Promise<WebhookEvent> {
    return this.updateWebhookStatus(webhookEventId, { status: "processing" });
  }

  /** Marks a webhook event as processed. */
  public async markWebhookProcessed(
    webhookEventId: string,
    processedAt?: string,
  ): Promise<WebhookEvent> {
    return this.updateWebhookStatus(webhookEventId, {
      processedAt: new Date(processedAt ?? new Date().toISOString()),
      status: "processed",
    });
  }

  /** Marks a webhook event as ignored. */
  public async markWebhookIgnored(
    webhookEventId: string,
    processedAt?: string,
  ): Promise<WebhookEvent> {
    return this.updateWebhookStatus(webhookEventId, {
      processedAt: new Date(processedAt ?? new Date().toISOString()),
      status: "ignored",
    });
  }

  /** Marks a webhook event as failed with a structured error. */
  public async markWebhookFailed(input: MarkWebhookFailedInput): Promise<WebhookEvent> {
    return this.updateWebhookStatus(input.webhookEventId, {
      error: input.error,
      processedAt: new Date(input.processedAt ?? new Date().toISOString()),
      status: "failed",
    });
  }

  /** Applies a webhook status update and returns the updated event. */
  private async updateWebhookStatus(
    webhookEventId: string,
    values: {
      /** Structured processing error, when the event failed. */
      readonly error?: ContractError;
      /** Processing completion time, when terminal. */
      readonly processedAt?: Date;
      /** New webhook event status. */
      readonly status: WebhookEvent["status"];
    },
  ): Promise<WebhookEvent> {
    const [row] = await this.db
      .update(webhookEvents)
      .set(values)
      .where(eq(webhookEvents.webhookEventId, webhookEventId))
      .returning();

    if (!row) {
      throw new Error(`Webhook event ${webhookEventId} was not found.`);
    }

    return toWebhookEvent(row);
  }
}
