import { randomUUID } from "node:crypto";
import type {
  CandidateFinding,
  ReviewArtifactRef,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import { eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  candidateFindings,
  reviewArtifacts,
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
}
