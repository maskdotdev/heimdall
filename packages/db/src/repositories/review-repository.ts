import type { CandidateFinding, ReviewRun } from "@repo/contracts";
import { eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { candidateFindings, reviewRuns } from "../schema";
import { toCandidateFinding, toReviewRun } from "./row-mappers";

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
}
