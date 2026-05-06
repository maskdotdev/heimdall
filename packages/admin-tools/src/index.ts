import { createHash } from "node:crypto";
import type { PublishReviewJobPayload, ValidatedFinding } from "@repo/contracts";
import {
  type HeimdallDatabase,
  publishedCheckRuns,
  publishedFindings,
  publishedReviews,
  publishedSummaryComments,
  publishOperations,
  publishRuns,
  ReviewRepository,
} from "@repo/db";
import { and, eq } from "drizzle-orm";

/** Publisher replay action that an operator can dispatch after reviewing the plan. */
export type PublisherReplayAction = "publish.review";

/** Summary of comments that the publisher would create or update. */
export type PublisherDryRunCommentPlan = {
  /** Number of inline review comments that are eligible for GitHub review publishing. */
  readonly inlineCommentCount: number;
  /** Number of findings that need the summary-comment fallback. */
  readonly summaryFallbackCount: number;
  /** Stable hash of the rendered fallback body, when a fallback comment is needed. */
  readonly summaryFallbackBodyHash?: `sha256:${string}`;
};

/** Non-mutating publisher plan for a completed review run. */
export type PublisherDryRunPlan = {
  /** Review run that the plan describes. */
  readonly reviewRunId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Pull request number that owns the review run. */
  readonly pullRequestNumber: number;
  /** Head SHA that the publisher must re-check before live publishing. */
  readonly headSha: string;
  /** Total publishable findings. */
  readonly findingCount: number;
  /** Check-run conclusion that live publishing would request. */
  readonly checkRunConclusion: "success" | "neutral";
  /** Stable hash of the rendered check-run summary. */
  readonly checkRunSummaryHash: `sha256:${string}`;
  /** Planned comment outputs. */
  readonly comments: PublisherDryRunCommentPlan;
  /** Whether this dry run performed any external or database mutation. */
  readonly mutatesExternalState: false;
};

/** One reconciliation issue found in durable publisher state. */
export type PublisherReconciliationIssue = {
  /** Machine-readable issue code. */
  readonly code:
    | "publish_run_missing"
    | "check_run_missing"
    | "published_finding_missing"
    | "operation_failed"
    | "operation_still_running";
  /** Human-readable issue description for operator output. */
  readonly message: string;
  /** Related database row ID when available. */
  readonly rowId?: string;
};

/** Reconciliation summary for one review run's publish state. */
export type PublisherReconciliationReport = {
  /** Review run that was reconciled. */
  readonly reviewRunId: string;
  /** Durable publish run ID, when one exists. */
  readonly publishRunId?: string;
  /** Stored publish-run status, or missing when no row exists. */
  readonly status: string;
  /** Number of publish operations recorded for the run. */
  readonly operationCount: number;
  /** Number of persisted check-run rows for the run. */
  readonly checkRunCount: number;
  /** Number of persisted review rows for the run. */
  readonly reviewCount: number;
  /** Number of persisted summary-comment rows for the run. */
  readonly summaryCommentCount: number;
  /** Number of persisted finding rows for the run. */
  readonly publishedFindingCount: number;
  /** Issues that require operator attention. */
  readonly issues: readonly PublisherReconciliationIssue[];
};

/** Safe replay plan for an operator-initiated publisher run. */
export type PublisherReplayPlan = {
  /** Action that a worker or CLI can dispatch after confirmation. */
  readonly action: PublisherReplayAction;
  /** Job payload to dispatch. */
  readonly payload: PublishReviewJobPayload;
  /** Dry-run output that the operator should inspect before dispatch. */
  readonly dryRun: PublisherDryRunPlan;
  /** Reconciliation output that explains current persisted state. */
  readonly reconciliation: PublisherReconciliationReport;
  /** Confirmation token derived from the dry-run and reconciliation state. */
  readonly confirmationToken: string;
  /** Whether dispatching this plan can mutate GitHub state. */
  readonly requiresExplicitConfirmation: true;
};

/** Dependencies for operational publisher controls. */
export type PublisherOperationsDependencies = {
  /** Database used to read review output and publisher state. */
  readonly db: HeimdallDatabase;
};

/** Renders the publisher output plan without writing to GitHub or publisher tables. */
export async function renderPublisherDryRun(
  reviewRunId: string,
  dependencies: PublisherOperationsDependencies,
): Promise<PublisherDryRunPlan> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new Error(`Review run ${reviewRunId} was not found.`);
  }
  if (reviewRun.status !== "completed") {
    throw new Error(`Review run ${reviewRunId} is not complete.`);
  }

  const findings = (await reviewRepository.listValidatedFindings(reviewRunId)).filter(
    (finding) => finding.decision === "publish",
  );
  const inlineComments = findings.filter((finding) => finding.location.isInDiff !== false);
  const fallbackFindings = findings.filter((finding) => finding.location.isInDiff === false);
  const fallbackBody =
    fallbackFindings.length === 0 ? undefined : renderFallbackSummary(fallbackFindings);

  return {
    reviewRunId,
    repoId: reviewRun.repoId,
    pullRequestNumber: reviewRun.pullRequestNumber,
    headSha: reviewRun.headSha,
    findingCount: findings.length,
    checkRunConclusion: findings.length === 0 ? "success" : "neutral",
    checkRunSummaryHash: hashJson(renderSummary(findings)),
    comments: {
      inlineCommentCount: inlineComments.length,
      summaryFallbackCount: fallbackFindings.length,
      ...(fallbackBody ? { summaryFallbackBodyHash: hashJson(fallbackBody) } : {}),
    },
    mutatesExternalState: false,
  };
}

/** Reconciles durable publisher rows for a review run without mutating external state. */
export async function reconcilePublisherRun(
  reviewRunId: string,
  dependencies: PublisherOperationsDependencies,
): Promise<PublisherReconciliationReport> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new Error(`Review run ${reviewRunId} was not found.`);
  }
  const findings = (await reviewRepository.listValidatedFindings(reviewRunId)).filter(
    (finding) => finding.decision === "publish",
  );
  const [publishRun] = await dependencies.db
    .select()
    .from(publishRuns)
    .where(eq(publishRuns.reviewRunId, reviewRunId));

  if (!publishRun) {
    return {
      reviewRunId,
      status: "missing",
      operationCount: 0,
      checkRunCount: 0,
      reviewCount: 0,
      summaryCommentCount: 0,
      publishedFindingCount: 0,
      issues: [
        {
          code: "publish_run_missing",
          message: `Review run ${reviewRunId} has no durable publish run.`,
        },
      ],
    };
  }

  const [operations, checkRuns, reviews, summaryComments, publishedFindingRows] = await Promise.all(
    [
      dependencies.db
        .select()
        .from(publishOperations)
        .where(eq(publishOperations.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedCheckRuns)
        .where(eq(publishedCheckRuns.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedReviews)
        .where(eq(publishedReviews.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedSummaryComments)
        .where(eq(publishedSummaryComments.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedFindings)
        .where(
          and(
            eq(publishedFindings.reviewRunId, reviewRunId),
            eq(publishedFindings.provider, "github"),
          ),
        ),
    ],
  );

  const issues: PublisherReconciliationIssue[] = [];
  if (publishRun.status === "completed" && checkRuns.length === 0) {
    issues.push({
      code: "check_run_missing",
      message: `Completed publish run ${publishRun.publishRunId} has no check-run row.`,
      rowId: publishRun.publishRunId,
    });
  }
  if (publishRun.status === "completed" && publishedFindingRows.length < findings.length) {
    issues.push({
      code: "published_finding_missing",
      message: `Completed publish run ${publishRun.publishRunId} has ${publishedFindingRows.length} of ${findings.length} published finding row(s).`,
      rowId: publishRun.publishRunId,
    });
  }
  for (const operation of operations) {
    if (operation.status === "failed") {
      issues.push({
        code: "operation_failed",
        message: `Publish operation ${operation.operationType} failed.`,
        rowId: operation.publishOperationId,
      });
    }
    if (operation.status === "running") {
      issues.push({
        code: "operation_still_running",
        message: `Publish operation ${operation.operationType} is still marked running.`,
        rowId: operation.publishOperationId,
      });
    }
  }

  return {
    reviewRunId,
    publishRunId: publishRun.publishRunId,
    status: publishRun.status,
    operationCount: operations.length,
    checkRunCount: checkRuns.length,
    reviewCount: reviews.length,
    summaryCommentCount: summaryComments.length,
    publishedFindingCount: publishedFindingRows.length,
    issues,
  };
}

/** Creates an explicit replay plan for re-dispatching publisher output. */
export async function createPublisherReplayPlan(
  reviewRunId: string,
  dependencies: PublisherOperationsDependencies,
): Promise<PublisherReplayPlan> {
  const dryRun = await renderPublisherDryRun(reviewRunId, dependencies);
  const reconciliation = await reconcilePublisherRun(reviewRunId, dependencies);
  const payload = {
    reviewRunId,
    repoId: dryRun.repoId,
    pullRequestNumber: dryRun.pullRequestNumber,
  };

  return {
    action: "publish.review",
    payload,
    dryRun,
    reconciliation,
    confirmationToken: hashJson({
      action: "publish.review",
      payload,
      dryRun,
      reconciliationStatus: reconciliation.status,
      reconciliationIssues: reconciliation.issues.map((issue) => issue.code),
    }),
    requiresExplicitConfirmation: true,
  };
}

function renderSummary(findings: readonly ValidatedFinding[]): string {
  if (findings.length === 0) {
    return "Heimdall completed the review and found no publishable issues.";
  }

  return findings
    .map((finding, index) => `${index + 1}. **${finding.title}** in \`${finding.location.path}\``)
    .join("\n");
}

function renderFallbackSummary(findings: readonly ValidatedFinding[]): string {
  if (findings.length === 0) {
    return "Heimdall could not publish inline comments, and found no publishable issues.";
  }

  return [
    "Heimdall could not publish every inline review comment, so it is posting the findings here.",
    "",
    ...findings.map(
      (finding, index) =>
        `${index + 1}. **${finding.title}** in \`${finding.location.path}:${finding.location.line}\`\n${finding.body}`,
    ),
  ].join("\n");
}

function hashJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
