import { randomUUID } from "node:crypto";
import type {
  CandidateFinding,
  ReviewArtifactRef,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import { and, desc, eq, ne } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  candidateFindings,
  findingDuplicateGroups,
  findingValidationEvents,
  publishedFindings,
  publishPlans,
  reviewArtifacts,
  reviewRunMetrics,
  reviewRunStageEvents,
  reviewRuns,
  validatedFindings,
} from "../schema";
import { toCandidateFinding, toReviewRun, toValidatedFinding } from "./row-mappers";

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Product-safe validation event row to persist for review replay and debugging. */
export type FindingValidationEventInsert = {
  /** Stable validation event ID. */
  readonly findingValidationEventId: string;
  /** Review run that owns the event. */
  readonly reviewRunId: string;
  /** Validated finding produced from the candidate, when one exists. */
  readonly findingId?: string | null;
  /** Candidate finding inspected by the validation event. */
  readonly candidateFindingId: string;
  /** Validation stage that produced the event. */
  readonly stage: string;
  /** Stage result, such as passed or rejected. */
  readonly status: string;
  /** Primary rejection reason for quick filtering, when the stage rejected the candidate. */
  readonly reason?: string | null;
  /** All rejection reasons associated with the stage. */
  readonly reasons: readonly string[];
  /** Optional product-safe event message. */
  readonly message?: string;
  /** Optional product-safe event metadata. */
  readonly metadata?: Record<string, unknown>;
  /** Event creation time. */
  readonly createdAt?: Date | string;
};

/** Duplicate group row to persist for review replay and debugging. */
export type FindingDuplicateGroupInsert = {
  /** Stable duplicate group ID. */
  readonly findingDuplicateGroupId: string;
  /** Review run that owns the duplicate group. */
  readonly reviewRunId: string;
  /** Canonical validated finding retained for publishing. */
  readonly canonicalFindingId?: string | null;
  /** Canonical candidate finding retained by dedupe. */
  readonly canonicalCandidateFindingId: string;
  /** Duplicate grouping strategy. */
  readonly groupKind: string;
  /** Optional duplicate confidence score. */
  readonly confidence?: number | null;
  /** Product-safe duplicate reason. */
  readonly reason?: string | null;
  /** Stable group key emitted by the validator. */
  readonly groupKey: string;
  /** Duplicate validated finding IDs rejected by dedupe. */
  readonly duplicateFindingIds: readonly string[];
  /** Duplicate candidate finding IDs rejected by dedupe. */
  readonly duplicateCandidateFindingIds: readonly string[];
  /** Optional product-safe duplicate metadata. */
  readonly metadata?: Record<string, unknown>;
  /** Group creation time. */
  readonly createdAt?: Date | string;
};

/** Publish plan row to persist for review replay and publisher handoff debugging. */
export type PublishPlanInsert = {
  /** Stable publish plan ID. */
  readonly publishPlanId: string;
  /** Review run that owns the plan. */
  readonly reviewRunId: string;
  /** Review artifact that stores the full publish plan payload. */
  readonly reviewArtifactId?: string | null;
  /** Head commit SHA targeted by the plan. */
  readonly headSha: string;
  /** Compact plan mode, such as check_run, inline_review, summary, mixed, or none. */
  readonly mode: string;
  /** Inline comments planned for provider publishing. */
  readonly inlineComments: readonly unknown[];
  /** File-level comments planned for provider publishing. */
  readonly fileComments: readonly unknown[];
  /** Check annotations planned for provider publishing. */
  readonly checkAnnotations: readonly unknown[];
  /** Summary payload planned for provider publishing. */
  readonly summary: Record<string, unknown>;
  /** Aggregate plan statistics. */
  readonly stats: Record<string, unknown>;
  /** Optional product-safe plan metadata. */
  readonly metadata?: Record<string, unknown>;
  /** Plan creation time. */
  readonly createdAt?: Date | string;
};

/** Durable review-run metric rollup values to upsert. */
export type ReviewRunMetricsInput = {
  /** Review run that owns the metrics row. */
  readonly reviewRunId: string;
  /** Total review duration in milliseconds. */
  readonly totalDurationMs?: number | null;
  /** Snapshot stage duration in milliseconds. */
  readonly snapshotDurationMs?: number | null;
  /** Index-wait stage duration in milliseconds. */
  readonly indexWaitDurationMs?: number | null;
  /** Retrieval stage duration in milliseconds. */
  readonly retrievalDurationMs?: number | null;
  /** Review-engine stage duration in milliseconds. */
  readonly reviewEngineDurationMs?: number | null;
  /** Validation stage duration in milliseconds. */
  readonly validationDurationMs?: number | null;
  /** Publishing stage duration in milliseconds. */
  readonly publishingDurationMs?: number | null;
  /** Candidate finding count produced by review passes. */
  readonly candidateFindings?: number | null;
  /** Validated finding count retained for publish decisions. */
  readonly validatedFindings?: number | null;
  /** Finding count marked publishable. */
  readonly publishedFindings?: number | null;
  /** Finding count rejected by validation or policy. */
  readonly rejectedFindings?: number | null;
  /** Estimated model input tokens for the run. */
  readonly inputTokens?: number | null;
  /** Estimated model output tokens for the run. */
  readonly outputTokens?: number | null;
  /** Estimated model cost in USD, serialized for numeric storage. */
  readonly estimatedCostUsd?: string | null;
};

/** Published finding fields used by validation to avoid duplicate comments on reruns. */
export type PublishedFindingForValidation = {
  /** Stable fingerprint emitted by the original finding. */
  readonly fingerprint: string;
  /** Published finding title. */
  readonly title: string;
  /** Published finding body. */
  readonly body: string;
  /** Published finding location. */
  readonly location: ValidatedFinding["location"];
};

/** Query helper for review runs and candidate findings. */
export class ReviewRepository {
  /** Creates a review query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts or updates a review run's mutable execution state. */
  public async upsertReviewRun(reviewRun: ReviewRun): Promise<ReviewRun> {
    const [row] = await this.db
      .insert(reviewRuns)
      .values({
        ...reviewRun,
        startedAt: reviewRun.startedAt ? new Date(reviewRun.startedAt) : undefined,
        completedAt: reviewRun.completedAt ? new Date(reviewRun.completedAt) : undefined,
        createdAt: new Date(reviewRun.createdAt),
        updatedAt: new Date(reviewRun.updatedAt),
      })
      .onConflictDoUpdate({
        target: reviewRuns.reviewRunId,
        set: {
          status: reviewRun.status,
          startedAt: reviewRun.startedAt ? new Date(reviewRun.startedAt) : undefined,
          completedAt: reviewRun.completedAt ? new Date(reviewRun.completedAt) : undefined,
          summary: reviewRun.summary,
          artifactRefs: reviewRun.artifactRefs,
          counts: reviewRun.counts,
          error: reviewRun.error,
          metadata: reviewRun.metadata,
          updatedAt: new Date(reviewRun.updatedAt),
        },
      })
      .returning();

    return toReviewRun(requireReturnedRow(row));
  }

  /** Gets a review run by ID. */
  public async getReviewRun(reviewRunId: string): Promise<ReviewRun | undefined> {
    const [row] = await this.db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.reviewRunId, reviewRunId));

    return row ? toReviewRun(row) : undefined;
  }

  /** Inserts a candidate finding and preserves existing fingerprint idempotency. */
  public async insertCandidateFinding(finding: CandidateFinding): Promise<CandidateFinding> {
    const [row] = await this.db
      .insert(candidateFindings)
      .values({
        ...finding,
        createdAt: new Date(finding.createdAt),
      })
      .onConflictDoNothing()
      .returning();

    return row ? toCandidateFinding(row) : finding;
  }

  /** Lists candidate findings for one review run. */
  public async listCandidateFindings(reviewRunId: string): Promise<readonly CandidateFinding[]> {
    const rows = await this.db
      .select()
      .from(candidateFindings)
      .where(eq(candidateFindings.reviewRunId, reviewRunId));

    return rows.map(toCandidateFinding);
  }

  /** Inserts a validated finding and preserves existing validation idempotency. */
  public async insertValidatedFinding(finding: ValidatedFinding): Promise<ValidatedFinding> {
    const [row] = await this.db
      .insert(validatedFindings)
      .values(finding)
      .onConflictDoNothing()
      .returning();

    return row ? toValidatedFinding(row) : finding;
  }

  /** Lists validated findings for one review run. */
  public async listValidatedFindings(reviewRunId: string): Promise<readonly ValidatedFinding[]> {
    const rows = await this.db
      .select()
      .from(validatedFindings)
      .where(eq(validatedFindings.reviewRunId, reviewRunId));

    return rows.map(toValidatedFinding);
  }

  /** Lists previously published findings for a pull request. */
  public async listPublishedFindingsForPullRequest(input: {
    /** Repository that owns the pull request. */
    readonly repoId: string;
    /** Pull request number to inspect. */
    readonly pullRequestNumber: number;
    /** Review run to exclude from previous-publish matching. */
    readonly excludeReviewRunId?: string;
    /** Maximum rows to return. */
    readonly limit?: number;
  }): Promise<readonly PublishedFindingForValidation[]> {
    const rows = await this.db
      .select({
        body: publishedFindings.body,
        fingerprint: publishedFindings.fingerprint,
        location: publishedFindings.location,
        title: publishedFindings.title,
      })
      .from(publishedFindings)
      .innerJoin(reviewRuns, eq(publishedFindings.reviewRunId, reviewRuns.reviewRunId))
      .where(
        input.excludeReviewRunId
          ? and(
              eq(reviewRuns.repoId, input.repoId),
              eq(reviewRuns.pullRequestNumber, input.pullRequestNumber),
              ne(reviewRuns.reviewRunId, input.excludeReviewRunId),
            )
          : and(
              eq(reviewRuns.repoId, input.repoId),
              eq(reviewRuns.pullRequestNumber, input.pullRequestNumber),
            ),
      )
      .orderBy(desc(publishedFindings.publishedAt))
      .limit(input.limit ?? 100);

    return rows.map((row) => ({
      body: row.body,
      fingerprint: row.fingerprint,
      location: row.location as ValidatedFinding["location"],
      title: row.title,
    }));
  }

  /** Inserts product-safe validation events and preserves existing event IDs. */
  public async insertFindingValidationEvents(
    events: readonly FindingValidationEventInsert[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.db
      .insert(findingValidationEvents)
      .values(
        events.map((event) => ({
          candidateFindingId: event.candidateFindingId,
          createdAt: event.createdAt ? new Date(event.createdAt) : undefined,
          findingId: event.findingId ?? undefined,
          findingValidationEventId: event.findingValidationEventId,
          message: event.message,
          metadata: event.metadata,
          reason: event.reason ?? undefined,
          reasons: [...event.reasons],
          reviewRunId: event.reviewRunId,
          stage: event.stage,
          status: event.status,
        })),
      )
      .onConflictDoNothing();
  }

  /** Inserts duplicate groups and preserves existing group IDs. */
  public async insertFindingDuplicateGroups(
    groups: readonly FindingDuplicateGroupInsert[],
  ): Promise<void> {
    if (groups.length === 0) {
      return;
    }

    await this.db
      .insert(findingDuplicateGroups)
      .values(
        groups.map((group) => ({
          canonicalCandidateFindingId: group.canonicalCandidateFindingId,
          canonicalFindingId: group.canonicalFindingId ?? undefined,
          confidence: group.confidence ?? undefined,
          createdAt: group.createdAt ? new Date(group.createdAt) : undefined,
          duplicateCandidateFindingIds: [...group.duplicateCandidateFindingIds],
          duplicateFindingIds: [...group.duplicateFindingIds],
          findingDuplicateGroupId: group.findingDuplicateGroupId,
          groupKey: group.groupKey,
          groupKind: group.groupKind,
          metadata: group.metadata,
          reason: group.reason ?? undefined,
          reviewRunId: group.reviewRunId,
        })),
      )
      .onConflictDoNothing();
  }

  /** Inserts a publish plan and preserves existing review-run plans. */
  public async insertPublishPlan(plan: PublishPlanInsert): Promise<void> {
    await this.db
      .insert(publishPlans)
      .values({
        checkAnnotations: [...plan.checkAnnotations],
        createdAt: plan.createdAt ? new Date(plan.createdAt) : undefined,
        fileComments: [...plan.fileComments],
        headSha: plan.headSha,
        inlineComments: [...plan.inlineComments],
        metadata: plan.metadata,
        mode: plan.mode,
        publishPlanId: plan.publishPlanId,
        reviewArtifactId: plan.reviewArtifactId ?? undefined,
        reviewRunId: plan.reviewRunId,
        stats: plan.stats,
        summary: plan.summary,
      })
      .onConflictDoNothing();
  }

  /** Inserts a review artifact row and preserves existing run/kind/name rows. */
  public async insertReviewArtifact(input: {
    /** Review run that owns the artifact. */
    readonly reviewRunId: string;
    /** Repository that owns the artifact. */
    readonly repoId: string;
    /** Artifact reference stored on the review run. */
    readonly artifact: ReviewArtifactRef;
    /** Human-readable artifact name scoped to the review run and kind. */
    readonly name: string;
    /** Artifact data classification used for access policy and dashboards. */
    readonly classification?: string;
    /** Artifact payload size in bytes. */
    readonly sizeBytes: number;
    /** Optional artifact metadata. */
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .insert(reviewArtifacts)
      .values({
        reviewArtifactId: input.artifact.artifactId,
        reviewRunId: input.reviewRunId,
        repoId: input.repoId,
        kind: input.artifact.kind,
        name: input.name,
        uri: input.artifact.uri,
        hash: input.artifact.contentHash ?? "",
        ...(input.classification ? { classification: input.classification } : {}),
        sizeBytes: input.sizeBytes,
        metadata: input.metadata ?? input.artifact.metadata,
      })
      .onConflictDoNothing();
  }

  /** Records a review stage timeline event for replay and debugging. */
  public async insertStageEvent(input: {
    /** Review run ID associated with the stage event. */
    readonly reviewRunId: string;
    /** Stage name. */
    readonly stage: string;
    /** Stage status. */
    readonly status: string;
    /** Optional event message. */
    readonly message?: string;
    /** Optional event metadata. */
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(reviewRunStageEvents).values({
      reviewRunStageEventId: `rrse_${randomUUID().replaceAll("-", "")}`,
      reviewRunId: input.reviewRunId,
      stage: input.stage,
      status: input.status,
      message: input.message,
      metadata: input.metadata,
    });
  }

  /** Upserts dashboard-friendly rollup metrics for a terminal review run. */
  public async upsertReviewRunMetrics(input: ReviewRunMetricsInput): Promise<void> {
    const values = {
      reviewRunId: input.reviewRunId,
      totalDurationMs: input.totalDurationMs ?? null,
      snapshotDurationMs: input.snapshotDurationMs ?? null,
      indexWaitDurationMs: input.indexWaitDurationMs ?? null,
      retrievalDurationMs: input.retrievalDurationMs ?? null,
      reviewEngineDurationMs: input.reviewEngineDurationMs ?? null,
      validationDurationMs: input.validationDurationMs ?? null,
      publishingDurationMs: input.publishingDurationMs ?? null,
      candidateFindings: input.candidateFindings ?? null,
      validatedFindings: input.validatedFindings ?? null,
      publishedFindings: input.publishedFindings ?? null,
      rejectedFindings: input.rejectedFindings ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      updatedAt: new Date(),
    };

    await this.db.insert(reviewRunMetrics).values(values).onConflictDoUpdate({
      target: reviewRunMetrics.reviewRunId,
      set: values,
    });
  }
}
