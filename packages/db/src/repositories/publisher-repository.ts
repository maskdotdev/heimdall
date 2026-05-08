import { eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  publishedCheckRuns,
  publishedFindings,
  publishedReviews,
  publishedSummaryComments,
  publishOperations,
  publishRuns,
} from "../schema";

/** Input used to create or reset a running publish run. */
export type UpsertRunningPublishRunInput = {
  /** Stable publish run ID. */
  readonly publishRunId: string;
  /** Review run being published. */
  readonly reviewRunId: string;
  /** Repository being published to. */
  readonly repoId: string;
  /** Durable idempotency key for this publish attempt. */
  readonly idempotencyKey: string;
  /** Timestamp when the publish attempt started. */
  readonly startedAt: Date;
  /** Product-safe publish run metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Input used to transition a publish run to a terminal or intermediate state. */
export type UpdatePublishRunStatusInput = {
  /** Durable idempotency key for the publish run. */
  readonly idempotencyKey: string;
  /** New publish run status. */
  readonly status: string;
  /** Completion timestamp when the status is terminal. */
  readonly completedAt?: Date | null | undefined;
  /** Product-safe structured error payload. */
  readonly error?: Readonly<Record<string, unknown>> | null | undefined;
  /** Product-safe publish run metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Input used to insert one low-level publish operation row. */
export type RecordPublishOperationInput = {
  /** Stable publish operation row ID. */
  readonly publishOperationId: string;
  /** Publish run that owns this operation. */
  readonly publishRunId: string;
  /** Provider-visible or internal operation type. */
  readonly operationType: string;
  /** Operation lifecycle status. */
  readonly status: string;
  /** Optional hash of the provider request payload. */
  readonly requestHash?: string | undefined;
  /** Optional hash of the provider response payload. */
  readonly responseHash?: string | undefined;
  /** Product-safe structured error payload. */
  readonly error?: Readonly<Record<string, unknown>> | undefined;
};

/** Input used to upsert a published check-run row. */
export type UpsertPublishedCheckRunInput = {
  /** Stable published check-run row ID. */
  readonly publishedCheckRunId: string;
  /** Publish run that created or updated the check run. */
  readonly publishRunId: string;
  /** Review run being published. */
  readonly reviewRunId: string;
  /** Source control provider. */
  readonly provider: string;
  /** Provider check-run ID. */
  readonly providerCheckRunId: string;
  /** Durable publish status. */
  readonly status: string;
  /** Provider check-run conclusion. */
  readonly conclusion?: string | null | undefined;
  /** Product-safe check-run metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Input used to upsert a published review row. */
export type UpsertPublishedReviewInput = {
  /** Stable published review row ID. */
  readonly publishedReviewId: string;
  /** Publish run that created or updated the review. */
  readonly publishRunId: string;
  /** Review run being published. */
  readonly reviewRunId: string;
  /** Source control provider. */
  readonly provider: string;
  /** Provider review ID. */
  readonly providerReviewId: string;
  /** Durable publish status. */
  readonly status: string;
  /** Product-safe review metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Input used to upsert a published summary comment row. */
export type UpsertPublishedSummaryCommentInput = {
  /** Stable published summary comment row ID. */
  readonly publishedSummaryCommentId: string;
  /** Publish run that created or updated the comment. */
  readonly publishRunId: string;
  /** Review run being published. */
  readonly reviewRunId: string;
  /** Source control provider. */
  readonly provider: string;
  /** Provider comment ID. */
  readonly providerCommentId: string;
  /** Hash of the rendered summary body. */
  readonly bodyHash: string;
  /** Durable publish status. */
  readonly status: string;
  /** Product-safe summary comment metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Input used to upsert one published finding row. */
export type UpsertPublishedFindingInput = {
  /** Stable published finding row ID. */
  readonly findingId: string;
  /** Validated finding linked to this published row. */
  readonly validatedFindingId: string;
  /** Review run being published. */
  readonly reviewRunId: string;
  /** Source control provider. */
  readonly provider: string;
  /** Provider inline comment ID, when available. */
  readonly providerCommentId?: string | undefined;
  /** Provider grouped review ID, when available. */
  readonly providerReviewId?: string | undefined;
  /** Provider check-run ID, when available. */
  readonly providerCheckRunId?: string | undefined;
  /** Finding location payload. */
  readonly location: unknown;
  /** Finding title. */
  readonly title: string;
  /** Finding body. */
  readonly body: string;
  /** Timestamp when the finding was published or marked. */
  readonly publishedAt: Date;
  /** Durable publish status. */
  readonly status: string;
  /** Product-safe structured error payload. */
  readonly error?: Readonly<Record<string, unknown>> | undefined;
  /** Stable finding fingerprint. */
  readonly fingerprint: string;
  /** Product-safe finding metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Query helper for publisher persistence writes. */
export class PublisherRepository {
  /** Creates a publisher persistence query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Creates or resets a publish run to running using its idempotency key. */
  public async upsertRunningPublishRun(input: UpsertRunningPublishRunInput): Promise<void> {
    await this.db
      .insert(publishRuns)
      .values({
        completedAt: null,
        error: null,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
        publishRunId: input.publishRunId,
        repoId: input.repoId,
        reviewRunId: input.reviewRunId,
        startedAt: input.startedAt,
        status: "running",
      })
      .onConflictDoUpdate({
        target: publishRuns.idempotencyKey,
        set: {
          completedAt: null,
          error: null,
          metadata: input.metadata ?? {},
          startedAt: input.startedAt,
          status: "running",
        },
      });
  }

  /** Updates one publish run by idempotency key. */
  public async updatePublishRunStatus(input: UpdatePublishRunStatusInput): Promise<void> {
    await this.db
      .update(publishRuns)
      .set(publishRunStatusUpdate(input))
      .where(eq(publishRuns.idempotencyKey, input.idempotencyKey));
  }

  /** Records one low-level publish operation row. */
  public async recordPublishOperation(input: RecordPublishOperationInput): Promise<void> {
    await this.db.insert(publishOperations).values({
      error: input.error,
      operationType: input.operationType,
      publishOperationId: input.publishOperationId,
      publishRunId: input.publishRunId,
      requestHash: input.requestHash,
      responseHash: input.responseHash,
      status: input.status,
    });
  }

  /** Upserts the provider check-run publication state. */
  public async upsertPublishedCheckRun(input: UpsertPublishedCheckRunInput): Promise<void> {
    await this.db
      .insert(publishedCheckRuns)
      .values({
        conclusion: input.conclusion,
        metadata: input.metadata,
        provider: input.provider,
        providerCheckRunId: input.providerCheckRunId,
        publishedCheckRunId: input.publishedCheckRunId,
        publishRunId: input.publishRunId,
        reviewRunId: input.reviewRunId,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: publishedCheckRuns.publishedCheckRunId,
        set: {
          conclusion: input.conclusion,
          metadata: input.metadata,
          status: input.status,
        },
      });
  }

  /** Upserts the provider grouped-review publication state. */
  public async upsertPublishedReview(input: UpsertPublishedReviewInput): Promise<void> {
    await this.db
      .insert(publishedReviews)
      .values({
        metadata: input.metadata,
        provider: input.provider,
        providerReviewId: input.providerReviewId,
        publishedReviewId: input.publishedReviewId,
        publishRunId: input.publishRunId,
        reviewRunId: input.reviewRunId,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: publishedReviews.publishedReviewId,
        set: {
          metadata: input.metadata,
          status: input.status,
        },
      });
  }

  /** Upserts the provider summary-comment publication state. */
  public async upsertPublishedSummaryComment(
    input: UpsertPublishedSummaryCommentInput,
  ): Promise<void> {
    await this.db
      .insert(publishedSummaryComments)
      .values({
        bodyHash: input.bodyHash,
        metadata: input.metadata,
        provider: input.provider,
        providerCommentId: input.providerCommentId,
        publishedSummaryCommentId: input.publishedSummaryCommentId,
        publishRunId: input.publishRunId,
        reviewRunId: input.reviewRunId,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: publishedSummaryComments.publishedSummaryCommentId,
        set: {
          bodyHash: input.bodyHash,
          metadata: input.metadata,
          status: input.status,
        },
      });
  }

  /** Upserts one published finding row. */
  public async upsertPublishedFinding(input: UpsertPublishedFindingInput): Promise<void> {
    await this.db
      .insert(publishedFindings)
      .values({
        body: input.body,
        error: input.error,
        findingId: input.findingId,
        fingerprint: input.fingerprint,
        location: input.location,
        metadata: input.metadata,
        provider: input.provider,
        providerCheckRunId: input.providerCheckRunId,
        providerCommentId: input.providerCommentId,
        providerReviewId: input.providerReviewId,
        publishedAt: input.publishedAt,
        reviewRunId: input.reviewRunId,
        status: input.status,
        title: input.title,
        validatedFindingId: input.validatedFindingId,
      })
      .onConflictDoUpdate({
        target: publishedFindings.findingId,
        set: {
          error: input.error,
          metadata: input.metadata,
          providerCheckRunId: input.providerCheckRunId,
          providerCommentId: input.providerCommentId,
          providerReviewId: input.providerReviewId,
          publishedAt: input.publishedAt,
          status: input.status,
        },
      });
  }
}

/** Builds a sparse publish-run status update that preserves omitted fields. */
function publishRunStatusUpdate(input: UpdatePublishRunStatusInput): {
  readonly status: string;
  readonly completedAt?: Date | null;
  readonly error?: Readonly<Record<string, unknown>> | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
} {
  return {
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    status: input.status,
  };
}
