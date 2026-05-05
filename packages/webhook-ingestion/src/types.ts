import type { JobEnvelope, JobPayload } from "@repo/contracts";
import type { QueueName } from "@repo/queue";

/** Result returned by webhook ingestion. */
export type WebhookIngestionResult = {
  /** HTTP-like status for the route. */
  readonly status: "accepted" | "duplicate" | "ignored";
  /** Provider delivery ID. */
  readonly deliveryId: string;
  /** Normalized webhook event ID. */
  readonly webhookEventId: string;
  /** Jobs planned for this event. */
  readonly jobs: readonly PlannedJob[];
};

/** Durable job planned from a webhook event. */
export type PlannedJob<TPayload extends JobPayload = JobPayload> = {
  /** Queue name that should receive the job. */
  readonly queueName: QueueName;
  /** Job envelope to persist and enqueue. */
  readonly envelope: JobEnvelope<TPayload>;
  /** Optional organization ID for durable job metadata. */
  readonly orgId?: string;
  /** Optional repository ID for durable job metadata. */
  readonly repoId?: string;
};

/** Error raised for webhook authentication failures. */
export class WebhookAuthenticationError extends Error {
  /** Creates a webhook authentication error. */
  public constructor(message: string) {
    super(message);
    this.name = "WebhookAuthenticationError";
  }
}

/** Error raised for malformed webhook payloads. */
export class WebhookPayloadError extends Error {
  /** Creates a webhook payload error. */
  public constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}
