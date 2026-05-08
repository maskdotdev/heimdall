import { randomUUID } from "node:crypto";
import type {
  CandidateFinding,
  ReviewArtifactRef,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import { and, asc, desc, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  candidateFindings,
  findingDuplicateGroups,
  findingOutcomes,
  findingValidationEvents,
  memoryFacts,
  publishedFindings,
  publishPlans,
  repositories,
  reviewArtifacts,
  reviewRunMetrics,
  reviewRunStageEvents,
  reviewRuns,
  suppressionMatches,
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

/** Product-safe suppression match row to persist for memory audit history. */
export type SuppressionMatchInsert = {
  /** Stable suppression match row ID. */
  readonly suppressionMatchId: string;
  /** Organization that owns the review run. */
  readonly orgId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Review run that emitted the suppression decision. */
  readonly reviewRunId: string;
  /** Validated finding row produced for the suppressed candidate. */
  readonly findingId: string;
  /** Candidate finding inspected by the memory matcher. */
  readonly candidateFindingId: string;
  /** Durable memory fact responsible for the suppression decision. */
  readonly memoryFactId: string;
  /** Suppression match strategy that produced the decision. */
  readonly matchKind: string;
  /** Suppression matcher confidence from zero to one. */
  readonly confidence: number;
  /** Product-safe matcher reason for audit displays. */
  readonly reason?: string | null;
  /** Optional product-safe match metadata. */
  readonly metadata?: Record<string, unknown>;
  /** Match creation time. */
  readonly createdAt?: Date | string;
};

/** Repository suppression match row joined with memory and finding display fields. */
export type RepositorySuppressionMatchRecord = {
  /** Durable suppression match row ID. */
  readonly suppressionMatchId: string;
  /** Review run that emitted the suppression decision. */
  readonly reviewRunId: string;
  /** Validated finding row suppressed by memory. */
  readonly findingId: string;
  /** Candidate finding inspected by the memory matcher. */
  readonly candidateFindingId: string;
  /** Durable memory fact responsible for suppression. */
  readonly memoryFactId: string;
  /** Human-readable memory fact body. */
  readonly memoryText: string;
  /** Current status of the memory fact. */
  readonly memoryStatus: string;
  /** Finding title associated with the suppressed candidate. */
  readonly findingTitle: string;
  /** Finding category associated with the suppressed candidate. */
  readonly findingCategory: string;
  /** Finding severity associated with the suppressed candidate. */
  readonly findingSeverity: string;
  /** Finding location associated with the suppressed candidate. */
  readonly location: unknown;
  /** Suppression match strategy. */
  readonly matchKind: string;
  /** Suppression matcher confidence from zero to one. */
  readonly confidence: number;
  /** Product-safe matcher reason when available. */
  readonly reason: string | null;
  /** Match creation timestamp. */
  readonly createdAt: Date;
};

/** Input used to list recent suppression matches for one repository. */
export type ListRepositorySuppressionMatchesInput = {
  /** Repository that owns the suppression matches. */
  readonly repoId: string;
  /** Maximum number of rows to return. */
  readonly limit?: number | undefined;
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

/** Joined review finding row used by inspection APIs. */
export type ReviewFindingInspectionRecord = {
  /** Validated finding ID. */
  readonly findingId: string;
  /** Candidate finding ID. */
  readonly candidateFindingId: string;
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Validation decision. */
  readonly decision: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding body. */
  readonly body: string;
  /** Finding location. */
  readonly location: unknown;
  /** Finding evidence. */
  readonly evidence: unknown;
  /** Confidence score. */
  readonly confidence: number;
  /** Validation metadata. */
  readonly validation: unknown;
  /** Rank within the review. */
  readonly rank: number | null;
  /** Finding fingerprint. */
  readonly fingerprint: string;
  /** Finding metadata. */
  readonly metadata: unknown;
  /** Published finding ID. */
  readonly publishedFindingId: string | null;
  /** Publication provider. */
  readonly publicationProvider: string | null;
  /** Provider comment ID. */
  readonly providerCommentId: string | null;
  /** Provider review ID. */
  readonly providerReviewId: string | null;
  /** Provider check-run ID. */
  readonly providerCheckRunId: string | null;
  /** Publication status. */
  readonly publicationStatus: string | null;
  /** Publication timestamp. */
  readonly publishedAt: Date | null;
  /** Publication error payload. */
  readonly publicationError: unknown;
  /** Publication metadata. */
  readonly publicationMetadata: unknown;
};

/** Input used to list validated review findings for inspection. */
export type ListReviewFindingsInput = {
  /** Review run that owns the findings. */
  readonly reviewRunId: string;
  /** Optional validation decision filter. */
  readonly decision?: string | undefined;
  /** Optional severity filter. */
  readonly severity?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit?: number | undefined;
};

/** Durable finding outcome row used by review inspection APIs. */
export type FindingOutcomeRecord = {
  /** Finding outcome row ID. */
  readonly findingOutcomeId: string;
  /** Organization that owns the finding outcome. */
  readonly orgId: string;
  /** Repository that owns the finding outcome. */
  readonly repoId: string;
  /** Candidate finding ID when the outcome is attached before publication. */
  readonly candidateFindingId: string | null;
  /** Published finding ID when the outcome is attached after publication. */
  readonly publishedFindingId: string | null;
  /** Outcome label. */
  readonly outcome: string;
  /** Outcome source. */
  readonly source: string;
  /** Outcome timestamp. */
  readonly occurredAt: Date;
  /** Row creation timestamp. */
  readonly createdAt: Date;
  /** Outcome metadata. */
  readonly metadata: unknown;
};

/** Input used to insert a finding outcome if the stable ID is not already present. */
export type CreateFindingOutcomeInput = {
  /** Stable finding outcome row ID. */
  readonly findingOutcomeId: string;
  /** Organization that owns the finding. */
  readonly orgId: string;
  /** Repository that owns the finding. */
  readonly repoId: string;
  /** Candidate finding ID when present. */
  readonly candidateFindingId: string | null;
  /** Published finding ID when present. */
  readonly publishedFindingId: string | null;
  /** Outcome label. */
  readonly outcome: string;
  /** Outcome source. */
  readonly source: string;
  /** Outcome timestamp. */
  readonly occurredAt: Date;
  /** Outcome metadata. */
  readonly metadata: unknown;
  /** Row creation timestamp. */
  readonly createdAt?: Date | undefined;
};

/** Input used to list outcome rows attached to inspected findings. */
export type ListFindingOutcomesForFindingsInput = {
  /** Candidate finding IDs to inspect. */
  readonly candidateFindingIds: readonly string[];
  /** Published finding IDs to inspect. */
  readonly publishedFindingIds: readonly string[];
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

    return row ? toCandidateFinding(row) : this.getConflictingCandidateFinding(finding);
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

    return row ? toValidatedFinding(row) : this.getValidatedFinding(finding.findingId);
  }

  /** Lists validated findings for one review run. */
  public async listValidatedFindings(reviewRunId: string): Promise<readonly ValidatedFinding[]> {
    const rows = await this.db
      .select()
      .from(validatedFindings)
      .where(eq(validatedFindings.reviewRunId, reviewRunId));

    return rows.map(toValidatedFinding);
  }

  /** Lists validated findings with repository and publication state for inspection. */
  public async listReviewFindings(
    input: ListReviewFindingsInput,
  ): Promise<readonly ReviewFindingInspectionRecord[]> {
    const rows = await this.db
      .select(reviewFindingInspectionSelect())
      .from(validatedFindings)
      .innerJoin(reviewRuns, eq(validatedFindings.reviewRunId, reviewRuns.reviewRunId))
      .innerJoin(repositories, eq(reviewRuns.repoId, repositories.repoId))
      .leftJoin(
        publishedFindings,
        eq(publishedFindings.validatedFindingId, validatedFindings.findingId),
      )
      .where(
        and(
          eq(validatedFindings.reviewRunId, input.reviewRunId),
          ...reviewFindingListFilters(input),
        ),
      )
      .orderBy(asc(validatedFindings.rank), asc(validatedFindings.findingId))
      .limit(repositoryInspectionLimit(input.limit));

    return rows;
  }

  /** Gets one inspection finding by validated, candidate, or published finding ID. */
  public async getReviewFindingByAnyId(
    findingId: string,
  ): Promise<ReviewFindingInspectionRecord | undefined> {
    const [row] = await this.db
      .select(reviewFindingInspectionSelect())
      .from(validatedFindings)
      .innerJoin(reviewRuns, eq(validatedFindings.reviewRunId, reviewRuns.reviewRunId))
      .innerJoin(repositories, eq(reviewRuns.repoId, repositories.repoId))
      .leftJoin(
        publishedFindings,
        eq(publishedFindings.validatedFindingId, validatedFindings.findingId),
      )
      .where(
        or(
          eq(validatedFindings.findingId, findingId),
          eq(validatedFindings.candidateFindingId, findingId),
          eq(publishedFindings.findingId, findingId),
        ),
      )
      .limit(1);

    return row;
  }

  /** Creates one finding outcome or returns the existing row for the same stable ID. */
  public async createFindingOutcomeIfAbsent(
    input: CreateFindingOutcomeInput,
  ): Promise<FindingOutcomeRecord> {
    const [inserted] = await this.db
      .insert(findingOutcomes)
      .values(findingOutcomeInsertValues(input))
      .onConflictDoNothing()
      .returning(findingOutcomeRecordSelect());

    if (inserted) {
      return inserted;
    }

    const existing = await this.getFindingOutcome(input.findingOutcomeId);
    if (!existing) {
      throw new Error(`Finding outcome ${input.findingOutcomeId} was not found after conflict.`);
    }

    return existing;
  }

  /** Inserts one finding outcome and preserves existing idempotent rows. */
  public async insertFindingOutcomeIfAbsent(input: CreateFindingOutcomeInput): Promise<void> {
    await this.db
      .insert(findingOutcomes)
      .values(findingOutcomeInsertValues(input))
      .onConflictDoNothing();
  }

  /** Gets one finding outcome by ID. */
  public async getFindingOutcome(
    findingOutcomeId: string,
  ): Promise<FindingOutcomeRecord | undefined> {
    const [row] = await this.db
      .select(findingOutcomeRecordSelect())
      .from(findingOutcomes)
      .where(eq(findingOutcomes.findingOutcomeId, findingOutcomeId))
      .limit(1);

    return row;
  }

  /** Lists latest-first outcome rows attached to inspected findings. */
  public async listFindingOutcomesForFindings(
    input: ListFindingOutcomesForFindingsInput,
  ): Promise<readonly FindingOutcomeRecord[]> {
    const conditions: SQL[] = [];
    if (input.candidateFindingIds.length > 0) {
      conditions.push(inArray(findingOutcomes.candidateFindingId, [...input.candidateFindingIds]));
    }
    if (input.publishedFindingIds.length > 0) {
      conditions.push(inArray(findingOutcomes.publishedFindingId, [...input.publishedFindingIds]));
    }
    if (conditions.length === 0) {
      return [];
    }
    const filter = conditions.length === 1 ? conditions[0] : or(...conditions);
    if (!filter) {
      return [];
    }

    return this.db
      .select(findingOutcomeRecordSelect())
      .from(findingOutcomes)
      .where(filter)
      .orderBy(desc(findingOutcomes.occurredAt), desc(findingOutcomes.createdAt));
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

  /** Inserts suppression matches and preserves existing stable match IDs. */
  public async insertSuppressionMatches(matches: readonly SuppressionMatchInsert[]): Promise<void> {
    if (matches.length === 0) {
      return;
    }

    await this.db
      .insert(suppressionMatches)
      .values(
        matches.map((match) => ({
          candidateFindingId: match.candidateFindingId,
          confidence: match.confidence,
          createdAt: match.createdAt ? new Date(match.createdAt) : undefined,
          findingId: match.findingId,
          matchKind: match.matchKind,
          memoryFactId: match.memoryFactId,
          metadata: match.metadata,
          orgId: match.orgId,
          reason: match.reason ?? undefined,
          repoId: match.repoId,
          reviewRunId: match.reviewRunId,
          suppressionMatchId: match.suppressionMatchId,
        })),
      )
      .onConflictDoNothing();
  }

  /** Lists recent memory suppression matches for one repository. */
  public async listRepositorySuppressionMatches(
    input: ListRepositorySuppressionMatchesInput,
  ): Promise<readonly RepositorySuppressionMatchRecord[]> {
    const rows = await this.db
      .select({
        candidateFindingId: suppressionMatches.candidateFindingId,
        confidence: suppressionMatches.confidence,
        createdAt: suppressionMatches.createdAt,
        findingCategory: validatedFindings.category,
        findingId: suppressionMatches.findingId,
        findingSeverity: validatedFindings.severity,
        findingTitle: validatedFindings.title,
        location: validatedFindings.location,
        matchKind: suppressionMatches.matchKind,
        memoryFactId: suppressionMatches.memoryFactId,
        memoryStatus: memoryFacts.status,
        memoryText: memoryFacts.body,
        reason: suppressionMatches.reason,
        reviewRunId: suppressionMatches.reviewRunId,
        suppressionMatchId: suppressionMatches.suppressionMatchId,
      })
      .from(suppressionMatches)
      .innerJoin(memoryFacts, eq(suppressionMatches.memoryFactId, memoryFacts.memoryFactId))
      .innerJoin(validatedFindings, eq(suppressionMatches.findingId, validatedFindings.findingId))
      .where(eq(suppressionMatches.repoId, input.repoId))
      .orderBy(desc(suppressionMatches.createdAt), desc(suppressionMatches.suppressionMatchId))
      .limit(repositorySuppressionMatchLimit(input.limit));

    return rows;
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
    /** Optional retention expiration for payload cleanup. */
    readonly retentionUntil?: Date | string | undefined;
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
        ...(input.retentionUntil ? { retentionUntil: new Date(input.retentionUntil) } : {}),
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

  /** Gets the stored candidate row that caused an idempotent insert conflict. */
  private async getConflictingCandidateFinding(
    finding: CandidateFinding,
  ): Promise<CandidateFinding> {
    const [row] = await this.db
      .select()
      .from(candidateFindings)
      .where(
        or(
          eq(candidateFindings.findingId, finding.findingId),
          and(
            eq(candidateFindings.reviewRunId, finding.reviewRunId),
            eq(candidateFindings.fingerprint, finding.fingerprint),
          ),
        ),
      )
      .limit(1);

    return toCandidateFinding(requireReturnedRow(row));
  }

  /** Gets a validated finding by ID after an idempotent insert conflict. */
  private async getValidatedFinding(findingId: string): Promise<ValidatedFinding> {
    const [row] = await this.db
      .select()
      .from(validatedFindings)
      .where(eq(validatedFindings.findingId, findingId))
      .limit(1);

    return toValidatedFinding(requireReturnedRow(row));
  }
}

/** Validates a bounded suppression match inspection limit. */
function repositorySuppressionMatchLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 100;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Suppression match list limit must be an integer between 1 and 500.");
  }

  return limit;
}

/** Selects joined review finding inspection columns. */
function reviewFindingInspectionSelect() {
  return {
    body: validatedFindings.body,
    candidateFindingId: validatedFindings.candidateFindingId,
    category: validatedFindings.category,
    confidence: validatedFindings.confidence,
    decision: validatedFindings.decision,
    evidence: validatedFindings.evidence,
    findingId: validatedFindings.findingId,
    fingerprint: validatedFindings.fingerprint,
    location: validatedFindings.location,
    metadata: validatedFindings.metadata,
    orgId: repositories.orgId,
    providerCheckRunId: publishedFindings.providerCheckRunId,
    providerCommentId: publishedFindings.providerCommentId,
    providerReviewId: publishedFindings.providerReviewId,
    publicationError: publishedFindings.error,
    publicationMetadata: publishedFindings.metadata,
    publicationProvider: publishedFindings.provider,
    publicationStatus: publishedFindings.status,
    publishedAt: publishedFindings.publishedAt,
    publishedFindingId: publishedFindings.findingId,
    rank: validatedFindings.rank,
    repoFullName: repositories.fullName,
    repoId: reviewRuns.repoId,
    reviewRunId: validatedFindings.reviewRunId,
    severity: validatedFindings.severity,
    title: validatedFindings.title,
    validation: validatedFindings.validation,
  };
}

/** Selects durable finding outcome fields used by inspection APIs. */
function findingOutcomeRecordSelect() {
  return {
    candidateFindingId: findingOutcomes.candidateFindingId,
    createdAt: findingOutcomes.createdAt,
    findingOutcomeId: findingOutcomes.findingOutcomeId,
    metadata: findingOutcomes.metadata,
    occurredAt: findingOutcomes.occurredAt,
    outcome: findingOutcomes.outcome,
    orgId: findingOutcomes.orgId,
    publishedFindingId: findingOutcomes.publishedFindingId,
    repoId: findingOutcomes.repoId,
    source: findingOutcomes.source,
  };
}

/** Converts finding outcome input into the Drizzle insert shape. */
function findingOutcomeInsertValues(
  input: CreateFindingOutcomeInput,
): typeof findingOutcomes.$inferInsert {
  return {
    candidateFindingId: input.candidateFindingId ?? undefined,
    createdAt: input.createdAt ?? new Date(),
    findingOutcomeId: input.findingOutcomeId,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    orgId: input.orgId,
    outcome: input.outcome,
    publishedFindingId: input.publishedFindingId ?? undefined,
    repoId: input.repoId,
    source: input.source,
  };
}

/** Builds SQL predicates for review finding inspection. */
function reviewFindingListFilters(input: ListReviewFindingsInput): SQL[] {
  const conditions: SQL[] = [];
  if (input.decision) {
    conditions.push(eq(validatedFindings.decision, input.decision));
  }
  if (input.severity) {
    conditions.push(eq(validatedFindings.severity, input.severity));
  }

  return conditions;
}

/** Validates a bounded review inspection list limit. */
function repositoryInspectionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 100;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Review inspection list limit must be an integer between 1 and 500.");
  }

  return limit;
}
