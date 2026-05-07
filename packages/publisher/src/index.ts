import { createHash, randomUUID } from "node:crypto";
import type {
  PublishedFindingStatus,
  PublishReviewJobPayload,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import {
  type HeimdallDatabase,
  providerInstallations,
  publishedCheckRuns,
  publishedFindings,
  publishedReviews,
  publishedSummaryComments,
  publishOperations,
  publishRuns,
  ReviewRepository,
  repositories,
} from "@repo/db";
import {
  type GitHubErrorCode,
  GitHubProviderError,
  type GitHubRateLimitSnapshot,
  type GitHubRepositoryRef,
  type GitProvider,
} from "@repo/github";
import type { EffectivePublishingPolicy } from "@repo/rules";
import { and, eq } from "drizzle-orm";

/** Legacy publisher behavior for review runs created before policy snapshots existed. */
const LEGACY_PUBLISHING_POLICY = {
  maxCommentsPerReview: 10,
  publishCheckRun: true,
  publishInlineComments: true,
  publishSummaryComment: false,
} as const satisfies EffectivePublishingPolicy;

/** Dependencies required to publish one completed review run. */
export type ReviewPublisherDependencies = {
  /** Database used to read review output and persist publish state. */
  readonly db: HeimdallDatabase;
  /** Git provider used to create or update external publishing objects. */
  readonly gitProvider: GitProvider;
  /** Optional clock for deterministic tests. */
  readonly now?: () => Date;
};

/** Result returned by one publisher handoff. */
export type PublishReviewResult = {
  /** Durable publish run ID. */
  readonly publishRunId: string;
  /** Provider check run ID returned by GitHub. */
  readonly providerCheckRunId: string;
  /** Provider review ID returned by GitHub, when inline comments were published. */
  readonly providerReviewId?: string;
  /** Provider summary comment ID returned by GitHub, when a summary was published. */
  readonly providerSummaryCommentId?: string;
  /** Number of validated findings included as check-run annotations. */
  readonly annotationCount: number;
  /** Number of inline comments published or reconciled. */
  readonly inlineCommentCount: number;
  /** Whether publishing was skipped because the PR moved to a new head SHA. */
  readonly staleHead: boolean;
};

/** External publish operation types the publisher can plan and execute. */
export type PublishOperationType =
  | "check_run.upsert"
  | "review.inline_comments"
  | "summary_comment.configured"
  | "summary_comment.fallback";

/** Dry-run-friendly description of one publish operation. */
export type PlannedPublishOperation = {
  /** Operation type matching persisted publish operation names where possible. */
  readonly operationType: PublishOperationType;
  /** Number of findings included in the operation payload. */
  readonly findingCount: number;
  /** Whether the publisher expects to perform an external write for this operation. */
  readonly status: "planned" | "skipped";
  /** Product-safe reason when the operation is skipped. */
  readonly reason?: string;
};

/** Policy-derived publish plan for one completed review run. */
export type PublishPlan = {
  /** Effective publishing policy used by the publisher. */
  readonly policy: EffectivePublishingPolicy;
  /** Publishable findings after applying the policy comment budget. */
  readonly findings: readonly ValidatedFinding[];
  /** Findings to include in check-run annotations. */
  readonly checkRunFindings: readonly ValidatedFinding[];
  /** Findings to publish as inline review comments. */
  readonly inlineFindings: readonly ValidatedFinding[];
  /** Findings to include in a configured summary comment. */
  readonly configuredSummaryFindings: readonly ValidatedFinding[];
  /** Dry-run-friendly planned external operations. */
  readonly plannedOperations: readonly PlannedPublishOperation[];
};

/** Stable failure reason recorded with failed publisher runs and operations. */
export type PublisherFailureReason = GitHubErrorCode | "publisher_error" | "unknown_error";

/** Structured publisher failure metadata persisted for dashboard and retry diagnostics. */
export type SerializedPublisherError = {
  /** Publisher operation code that failed. */
  readonly code: string;
  /** Product-facing reason for the failure. */
  readonly reason: PublisherFailureReason;
  /** Human-readable failure message. */
  readonly message: string;
  /** Whether retrying the same operation can reasonably succeed. */
  readonly retryable: boolean;
  /** External provider that returned the failure, when known. */
  readonly provider?: "github";
  /** HTTP status returned by GitHub, when available. */
  readonly status?: number;
  /** GitHub request identifier, when available. */
  readonly requestId?: string;
  /** Retry delay in seconds requested by GitHub, when available. */
  readonly retryAfterSeconds?: number;
  /** Parsed GitHub rate-limit headers, when available. */
  readonly rateLimit?: GitHubRateLimitSnapshot;
  /** Extra diagnostic details for logs and debug views. */
  readonly details?: Record<string, unknown>;
};

/** Creates a policy-derived publish plan from a review run and validated findings. */
export function createPublishPlan(input: {
  /** Review run that owns the publish handoff. */
  readonly reviewRun: Pick<ReviewRun, "metadata">;
  /** Validated publishable findings for the review run. */
  readonly findings: readonly ValidatedFinding[];
}): PublishPlan {
  const policy = publishingPolicyFromReviewRun(input.reviewRun);
  const maxFindings = Math.max(0, Math.floor(policy.maxCommentsPerReview));
  const findings = input.findings.slice(0, maxFindings);
  const plan = {
    policy,
    findings,
    checkRunFindings: policy.publishCheckRun ? findings : [],
    inlineFindings: policy.publishInlineComments
      ? findings.filter((finding) => finding.location.isInDiff !== false)
      : [],
    configuredSummaryFindings: policy.publishSummaryComment ? findings : [],
  };

  return {
    ...plan,
    plannedOperations: planPublishOperations(plan),
  };
}

/** Creates a dry-run-friendly operation list for a publish plan. */
export function planPublishOperations(
  plan: Pick<
    PublishPlan,
    "policy" | "findings" | "checkRunFindings" | "inlineFindings" | "configuredSummaryFindings"
  >,
): readonly PlannedPublishOperation[] {
  const operations: PlannedPublishOperation[] = [];
  if (plan.policy.publishCheckRun) {
    const findingCount = plan.checkRunFindings.length;
    operations.push({
      findingCount,
      operationType: "check_run.upsert",
      status: findingCount > 0 ? "planned" : "skipped",
      ...(findingCount === 0 ? { reason: "no_check_run_findings" } : {}),
    });
  }
  if (plan.policy.publishInlineComments) {
    operations.push({
      findingCount: plan.inlineFindings.length,
      operationType: "review.inline_comments",
      status: plan.inlineFindings.length > 0 ? "planned" : "skipped",
      ...(plan.inlineFindings.length === 0 ? { reason: "no_inline_findings" } : {}),
    });
  }
  if (plan.policy.publishSummaryComment) {
    const findingCount = plan.configuredSummaryFindings.length;
    operations.push({
      findingCount,
      operationType: "summary_comment.configured",
      status: findingCount > 0 ? "planned" : "skipped",
      ...(findingCount === 0 ? { reason: "no_summary_findings" } : {}),
    });
  }
  const fallbackSummaryFindingCount =
    plan.policy.publishInlineComments && !plan.policy.publishSummaryComment
      ? Math.max(0, plan.findings.length - plan.inlineFindings.length)
      : 0;
  if (fallbackSummaryFindingCount > 0) {
    operations.push({
      findingCount: fallbackSummaryFindingCount,
      operationType: "summary_comment.fallback",
      status: "planned",
    });
  }

  return operations;
}

/** Returns true when a publish plan contains at least one external write. */
export function hasPlannedPublishOperations(plan: Pick<PublishPlan, "plannedOperations">): boolean {
  return plan.plannedOperations.some((operation) => operation.status === "planned");
}

/** Creates or updates live PR output and persists durable publish state. */
export async function publishReviewRun(
  payload: PublishReviewJobPayload,
  dependencies: ReviewPublisherDependencies,
): Promise<PublishReviewResult> {
  const now = dependencies.now ?? (() => new Date());
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(payload.reviewRunId);
  if (!reviewRun) {
    throw new Error(`Review run ${payload.reviewRunId} was not found.`);
  }
  if (reviewRun.status !== "completed") {
    throw new Error(`Review run ${payload.reviewRunId} is not complete.`);
  }
  if (reviewRun.repoId !== payload.repoId) {
    throw new Error(`Publish job repo ${payload.repoId} does not match review run repo.`);
  }
  if (reviewRun.pullRequestNumber !== payload.pullRequestNumber) {
    throw new Error(
      `Publish job pull request ${payload.pullRequestNumber} does not match review run pull request.`,
    );
  }

  const repository = await loadGitHubRepositoryRef(dependencies.db, reviewRun.repoId);
  const publishRunId = stableId("pub", [payload.reviewRunId, "live-output"]);
  const idempotencyKey = `review.publish.v1:${payload.reviewRunId}`;
  const startedAt = now();
  await dependencies.db
    .insert(publishRuns)
    .values({
      publishRunId,
      reviewRunId: payload.reviewRunId,
      repoId: reviewRun.repoId,
      idempotencyKey,
      status: "running",
      startedAt,
      metadata: {
        pullRequestNumber: payload.pullRequestNumber,
        ...(payload.publishPlanId ? { publishPlanId: payload.publishPlanId } : {}),
        ...(payload.publishPlanArtifactId
          ? { publishPlanArtifactId: payload.publishPlanArtifactId }
          : {}),
      },
    })
    .onConflictDoUpdate({
      target: publishRuns.idempotencyKey,
      set: {
        status: "running",
        startedAt,
        completedAt: null,
        error: null,
        metadata: {
          pullRequestNumber: payload.pullRequestNumber,
          ...(payload.publishPlanId ? { publishPlanId: payload.publishPlanId } : {}),
          ...(payload.publishPlanArtifactId
            ? { publishPlanArtifactId: payload.publishPlanArtifactId }
            : {}),
        },
      },
    });

  try {
    const currentPullRequest = await dependencies.gitProvider.fetchPullRequestSnapshot({
      ...repository,
      pullRequestNumber: payload.pullRequestNumber,
    });
    if (currentPullRequest.headSha !== reviewRun.headSha) {
      const completedAt = now();
      await dependencies.db
        .update(publishRuns)
        .set({
          status: "skipped",
          completedAt,
          error: null,
          metadata: {
            reason: "stale_head",
            expectedHeadSha: reviewRun.headSha,
            actualHeadSha: currentPullRequest.headSha,
            ...(payload.publishPlanId ? { publishPlanId: payload.publishPlanId } : {}),
            ...(payload.publishPlanArtifactId
              ? { publishPlanArtifactId: payload.publishPlanArtifactId }
              : {}),
          },
        })
        .where(eq(publishRuns.idempotencyKey, idempotencyKey));
      await insertPublishOperation(dependencies.db, publishRunId, "stale_head.check", {
        status: "completed",
        responseHash: hashJson({
          expectedHeadSha: reviewRun.headSha,
          actualHeadSha: currentPullRequest.headSha,
        }),
      });

      return {
        publishRunId,
        providerCheckRunId: "",
        annotationCount: 0,
        inlineCommentCount: 0,
        staleHead: true,
      };
    }

    const findings = (await reviewRepository.listValidatedFindings(payload.reviewRunId)).filter(
      (finding) => finding.decision === "publish",
    );
    const publishPlan = createPublishPlan({ reviewRun, findings });
    const checkRun = hasPlannedPublishOperation(publishPlan, "check_run.upsert")
      ? await publishCheckRun({
          db: dependencies.db,
          gitProvider: dependencies.gitProvider,
          repository,
          publishRunId,
          reviewRunId: payload.reviewRunId,
          headSha: reviewRun.headSha,
          findings: publishPlan.checkRunFindings,
        })
      : undefined;
    const review = hasPlannedPublishOperation(publishPlan, "review.inline_comments")
      ? await publishInlineComments({
          db: dependencies.db,
          gitProvider: dependencies.gitProvider,
          repository,
          publishRunId,
          reviewRunId: payload.reviewRunId,
          pullRequestNumber: payload.pullRequestNumber,
          headSha: reviewRun.headSha,
          findings: publishPlan.inlineFindings,
          publishedAt: now(),
        })
      : undefined;
    const summaryFindingsToMark = summaryPublishedFindingsForPlan({
      plan: publishPlan,
      commentIdsByFindingId: review?.commentIdsByFindingId ?? {},
    });
    const configuredSummary = hasPlannedPublishOperation(publishPlan, "summary_comment.configured")
      ? await publishSummaryComment({
          db: dependencies.db,
          gitProvider: dependencies.gitProvider,
          repository,
          publishRunId,
          reviewRunId: payload.reviewRunId,
          pullRequestNumber: payload.pullRequestNumber,
          findings: publishPlan.configuredSummaryFindings,
          findingsToMark: summaryFindingsToMark,
          publishedAt: now(),
          purpose: "configured",
        })
      : undefined;
    const fallbackSummaryFindings = fallbackSummaryFindingsForPlan({
      plan: publishPlan,
      commentIdsByFindingId: review?.commentIdsByFindingId ?? {},
    });
    const fallbackSummary =
      fallbackSummaryFindings.length === 0
        ? undefined
        : await publishSummaryComment({
            db: dependencies.db,
            gitProvider: dependencies.gitProvider,
            repository,
            publishRunId,
            reviewRunId: payload.reviewRunId,
            pullRequestNumber: payload.pullRequestNumber,
            findings: fallbackSummaryFindings,
            findingsToMark: fallbackSummaryFindings,
            publishedAt: now(),
            purpose: "fallback",
          });
    const summaryComment = configuredSummary ?? fallbackSummary;

    const completedAt = now();
    await dependencies.db
      .update(publishRuns)
      .set({
        status: "completed",
        completedAt,
        error: null,
        metadata: withoutUndefinedValues({
          providerCheckRunId: checkRun?.providerCheckRunId,
          providerReviewId: review?.providerReviewId,
          providerSummaryCommentId: summaryComment?.providerCommentId,
          inlineCommentCount: review?.commentIds.length ?? 0,
          plannedOperations: publishPlan.plannedOperations,
          publishPlanId: payload.publishPlanId,
          publishPlanArtifactId: payload.publishPlanArtifactId,
          publishingPolicy: publishPlan.policy,
          summaryFallback: fallbackSummary !== undefined,
        }),
      })
      .where(eq(publishRuns.idempotencyKey, idempotencyKey));

    return {
      publishRunId,
      providerCheckRunId: checkRun?.providerCheckRunId ?? "",
      ...(review ? { providerReviewId: review.providerReviewId } : {}),
      ...(summaryComment ? { providerSummaryCommentId: summaryComment.providerCommentId } : {}),
      annotationCount: publishPlan.checkRunFindings.length,
      inlineCommentCount: review?.commentIds.length ?? 0,
      staleHead: false,
    };
  } catch (error) {
    await dependencies.db
      .update(publishRuns)
      .set({
        status: "failed",
        completedAt: now(),
        error: serializePublisherError(error, "publisher.failed"),
      })
      .where(eq(publishRuns.idempotencyKey, idempotencyKey));
    throw error;
  }
}

type PublishInlineCommentsInput = {
  readonly db: HeimdallDatabase;
  readonly gitProvider: GitProvider;
  readonly repository: GitHubRepositoryRef;
  readonly publishRunId: string;
  readonly reviewRunId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly findings: readonly ValidatedFinding[];
  readonly publishedAt: Date;
};

type PublishedReviewWithFindingMap = Awaited<ReturnType<GitProvider["publishReview"]>> & {
  readonly commentIdsByFindingId?: Readonly<Record<string, string>>;
};

type PublishedCheckRun = Awaited<ReturnType<GitProvider["createOrUpdateCheckRun"]>>;

type SummaryCommentPurpose = "configured" | "fallback";

function hasPlannedPublishOperation(
  plan: Pick<PublishPlan, "plannedOperations">,
  operationType: PublishOperationType,
): boolean {
  return plan.plannedOperations.some(
    (operation) => operation.operationType === operationType && operation.status === "planned",
  );
}

async function publishCheckRun(input: {
  readonly db: HeimdallDatabase;
  readonly gitProvider: GitProvider;
  readonly repository: GitHubRepositoryRef;
  readonly publishRunId: string;
  readonly reviewRunId: string;
  readonly headSha: string;
  readonly findings: readonly ValidatedFinding[];
}): Promise<PublishedCheckRun> {
  const checkRunInput = {
    ...input.repository,
    reviewRunId: input.reviewRunId,
    name: "Heimdall Review",
    headSha: input.headSha,
    status: "completed" as const,
    conclusion: input.findings.length === 0 ? ("success" as const) : ("neutral" as const),
    title:
      input.findings.length === 0 ? "No findings" : `${input.findings.length} review finding(s)`,
    summary: renderSummary(input.findings),
    annotations: input.findings.map(toCheckRunAnnotation),
  };
  await insertPublishOperation(input.db, input.publishRunId, "check_run.upsert", {
    status: "running",
    requestHash: hashJson(checkRunInput),
  });
  const checkRun = await input.gitProvider.createOrUpdateCheckRun(checkRunInput);

  await input.db
    .insert(publishedCheckRuns)
    .values({
      publishedCheckRunId: stableId("pcr", [input.publishRunId, checkRun.providerCheckRunId]),
      publishRunId: input.publishRunId,
      reviewRunId: input.reviewRunId,
      provider: "github",
      providerCheckRunId: checkRun.providerCheckRunId,
      status: "published",
      conclusion: checkRunInput.conclusion,
      metadata: { htmlUrl: checkRun.htmlUrl, annotationCount: checkRunInput.annotations.length },
    })
    .onConflictDoUpdate({
      target: publishedCheckRuns.publishedCheckRunId,
      set: {
        status: "published",
        conclusion: checkRunInput.conclusion,
        metadata: {
          htmlUrl: checkRun.htmlUrl,
          annotationCount: checkRunInput.annotations.length,
        },
      },
    });
  await insertPublishOperation(input.db, input.publishRunId, "check_run.upsert", {
    status: "completed",
    responseHash: hashJson(checkRun),
  });

  return checkRun;
}

async function publishInlineComments(input: PublishInlineCommentsInput): Promise<{
  readonly providerReviewId: string;
  readonly commentIds: readonly string[];
  readonly commentIdsByFindingId: Readonly<Record<string, string>>;
}> {
  if (input.findings.length === 0) {
    return {
      providerReviewId: stableId("review", [input.reviewRunId, "no-inline-comments"]),
      commentIds: [],
      commentIdsByFindingId: {},
    };
  }

  const reviewInput = {
    ...input.repository,
    pullRequestNumber: input.pullRequestNumber,
    reviewRunId: input.reviewRunId,
    headSha: input.headSha,
    body: "Heimdall review findings.",
    comments: input.findings.map((finding) => ({
      path: finding.location.path,
      line: finding.location.line,
      side: finding.location.side,
      body: renderInlineComment(finding),
      findingId: finding.findingId,
    })),
  };
  await insertPublishOperation(input.db, input.publishRunId, "review.inline_comments", {
    status: "running",
    requestHash: hashJson(reviewInput),
  });

  try {
    const review = await input.gitProvider.publishReview(reviewInput);
    const commentIdsByFindingId = mapCommentIdsByFindingId(review, input.findings);
    await input.db
      .insert(publishedReviews)
      .values({
        publishedReviewId: stableId("prev", [input.publishRunId, review.providerReviewId]),
        publishRunId: input.publishRunId,
        reviewRunId: input.reviewRunId,
        provider: "github",
        providerReviewId: review.providerReviewId,
        status: "published",
        metadata: { commentIds: review.commentIds },
      })
      .onConflictDoUpdate({
        target: publishedReviews.publishedReviewId,
        set: { status: "published", metadata: { commentIds: review.commentIds } },
      });
    await Promise.all(
      input.findings.map((finding) =>
        upsertPublishedFinding(input.db, {
          finding,
          publishRunId: input.publishRunId,
          providerReviewId: review.providerReviewId,
          ...(commentIdsByFindingId[finding.findingId]
            ? { providerCommentId: commentIdsByFindingId[finding.findingId] }
            : {}),
          publishedAt: input.publishedAt,
          status: commentIdsByFindingId[finding.findingId] ? "published" : "skipped",
        }),
      ),
    );
    await insertPublishOperation(input.db, input.publishRunId, "review.inline_comments", {
      status: "completed",
      responseHash: hashJson(review),
    });

    return {
      ...review,
      commentIdsByFindingId,
    };
  } catch (error) {
    await insertPublishOperation(input.db, input.publishRunId, "review.inline_comments", {
      status: "failed",
      responseHash: hashJson({ message: error instanceof Error ? error.message : String(error) }),
      error: serializePublisherError(error, "publisher.inline_comments_failed"),
    });

    return {
      providerReviewId: stableId("review", [input.reviewRunId, "inline-failed"]),
      commentIds: [],
      commentIdsByFindingId: {},
    };
  }
}

async function publishSummaryComment(input: {
  readonly db: HeimdallDatabase;
  readonly gitProvider: GitProvider;
  readonly repository: GitHubRepositoryRef;
  readonly publishRunId: string;
  readonly reviewRunId: string;
  readonly pullRequestNumber: number;
  readonly findings: readonly ValidatedFinding[];
  readonly findingsToMark: readonly ValidatedFinding[];
  readonly publishedAt: Date;
  readonly purpose: SummaryCommentPurpose;
}): Promise<{ readonly providerCommentId: string }> {
  const body =
    input.purpose === "fallback"
      ? renderFallbackSummary(input.findings)
      : renderSummary(input.findings);
  const summaryInput = {
    ...input.repository,
    pullRequestNumber: input.pullRequestNumber,
    reviewRunId: input.reviewRunId,
    body,
  };
  const operationType =
    input.purpose === "fallback" ? "summary_comment.fallback" : "summary_comment.configured";
  await insertPublishOperation(input.db, input.publishRunId, operationType, {
    status: "running",
    requestHash: hashJson(summaryInput),
  });
  const comment = await input.gitProvider.publishSummaryComment(summaryInput);
  await input.db
    .insert(publishedSummaryComments)
    .values({
      publishedSummaryCommentId: stableId("psc", [input.publishRunId, comment.providerCommentId]),
      publishRunId: input.publishRunId,
      reviewRunId: input.reviewRunId,
      provider: "github",
      providerCommentId: comment.providerCommentId,
      bodyHash: hashJson(body),
      status: "published",
      metadata: { htmlUrl: comment.htmlUrl, purpose: input.purpose },
    })
    .onConflictDoUpdate({
      target: publishedSummaryComments.publishedSummaryCommentId,
      set: {
        bodyHash: hashJson(body),
        status: "published",
        metadata: { htmlUrl: comment.htmlUrl, purpose: input.purpose },
      },
    });
  if (input.findingsToMark.length > 0) {
    await Promise.all(
      input.findingsToMark.map((finding) =>
        upsertPublishedFinding(input.db, {
          finding,
          publishRunId: input.publishRunId,
          providerCommentId: comment.providerCommentId,
          publishedAt: input.publishedAt,
          status: "published",
        }),
      ),
    );
  }
  await insertPublishOperation(input.db, input.publishRunId, operationType, {
    status: "completed",
    responseHash: hashJson(comment),
  });

  return comment;
}

async function upsertPublishedFinding(
  db: HeimdallDatabase,
  input: {
    readonly finding: ValidatedFinding;
    readonly publishRunId: string;
    readonly providerReviewId?: string;
    readonly providerCommentId?: string;
    readonly publishedAt: Date;
    readonly status: PublishedFindingStatus;
  },
): Promise<void> {
  await db
    .insert(publishedFindings)
    .values({
      findingId: stableId("pf", [input.publishRunId, input.finding.findingId]),
      validatedFindingId: input.finding.findingId,
      reviewRunId: input.finding.reviewRunId,
      provider: "github",
      providerCommentId: input.providerCommentId,
      providerReviewId: input.providerReviewId,
      location: input.finding.location,
      title: input.finding.title,
      body: input.finding.body,
      publishedAt: input.publishedAt,
      status: input.status,
      fingerprint: input.finding.fingerprint,
      metadata: { rank: input.finding.rank },
    })
    .onConflictDoUpdate({
      target: publishedFindings.findingId,
      set: {
        providerCommentId: input.providerCommentId,
        providerReviewId: input.providerReviewId,
        publishedAt: input.publishedAt,
        status: input.status,
        metadata: { rank: input.finding.rank },
      },
    });
}

async function loadGitHubRepositoryRef(
  db: HeimdallDatabase,
  repoId: string,
): Promise<GitHubRepositoryRef> {
  const [repository] = await db
    .select({
      owner: repositories.owner,
      repo: repositories.name,
      providerRepoId: repositories.providerRepoId,
      installationId: repositories.installationId,
      providerInstallationId: providerInstallations.providerInstallationId,
      provider: repositories.provider,
    })
    .from(repositories)
    .innerJoin(
      providerInstallations,
      eq(providerInstallations.installationId, repositories.installationId),
    )
    .where(and(eq(repositories.repoId, repoId), eq(repositories.provider, "github")))
    .limit(1);

  if (!repository) {
    throw new Error(`GitHub repository ${repoId} was not found.`);
  }

  return {
    provider: "github",
    installationId: repository.installationId,
    providerInstallationId: repository.providerInstallationId,
    owner: repository.owner,
    repo: repository.repo,
    providerRepoId: repository.providerRepoId,
  };
}

function mapCommentIdsByFindingId(
  review: PublishedReviewWithFindingMap,
  findings: readonly ValidatedFinding[],
): Readonly<Record<string, string>> {
  if (review.commentIdsByFindingId) {
    return review.commentIdsByFindingId;
  }

  return Object.fromEntries(
    findings.flatMap((finding, index) => {
      const providerCommentId = review.commentIds[index];
      return providerCommentId ? [[finding.findingId, providerCommentId]] : [];
    }),
  );
}

function fallbackSummaryFindingsForPlan(input: {
  readonly plan: PublishPlan;
  readonly commentIdsByFindingId: Readonly<Record<string, string>>;
}): readonly ValidatedFinding[] {
  if (
    input.plan.policy.publishSummaryComment ||
    !input.plan.policy.publishInlineComments ||
    input.plan.findings.length === 0
  ) {
    return [];
  }

  return input.plan.findings.filter(
    (finding) =>
      finding.location.isInDiff === false || !input.commentIdsByFindingId[finding.findingId],
  );
}

function summaryPublishedFindingsForPlan(input: {
  readonly plan: PublishPlan;
  readonly commentIdsByFindingId: Readonly<Record<string, string>>;
}): readonly ValidatedFinding[] {
  if (!input.plan.policy.publishSummaryComment) {
    return [];
  }
  if (!input.plan.policy.publishInlineComments) {
    return input.plan.findings;
  }

  return input.plan.findings.filter(
    (finding) =>
      finding.location.isInDiff === false || !input.commentIdsByFindingId[finding.findingId],
  );
}

function publishingPolicyFromReviewRun(
  reviewRun: Pick<ReviewRun, "metadata">,
): EffectivePublishingPolicy {
  const metadata = asRecord(reviewRun.metadata);
  const policySnapshot = asRecord(metadata?.policySnapshot);
  const publishing = asRecord(policySnapshot?.publishing);

  if (isPublishingPolicy(publishing)) {
    return publishing;
  }

  return LEGACY_PUBLISHING_POLICY;
}

function isPublishingPolicy(value: unknown): value is EffectivePublishingPolicy {
  const record = asRecord(value);
  const maxCommentsPerReview = record?.maxCommentsPerReview;

  return (
    typeof record?.publishCheckRun === "boolean" &&
    typeof record.publishInlineComments === "boolean" &&
    typeof record.publishSummaryComment === "boolean" &&
    typeof maxCommentsPerReview === "number" &&
    Number.isInteger(maxCommentsPerReview) &&
    maxCommentsPerReview >= 0
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function withoutUndefinedValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
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

function renderInlineComment(finding: ValidatedFinding): string {
  return `**${finding.title}**\n\n${finding.body}`;
}

function toCheckRunAnnotation(finding: ValidatedFinding) {
  return {
    path: finding.location.path,
    startLine: finding.location.startLine ?? finding.location.line,
    endLine: finding.location.line,
    annotationLevel:
      finding.severity === "critical" || finding.severity === "high"
        ? ("failure" as const)
        : ("notice" as const),
    title: finding.title,
    message: finding.body,
  };
}

async function insertPublishOperation(
  db: HeimdallDatabase,
  publishRunId: string,
  operationType: string,
  input: {
    readonly status: string;
    readonly requestHash?: string;
    readonly responseHash?: string;
    readonly error?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(publishOperations).values({
    publishOperationId: `pop_${randomUUID().replaceAll("-", "")}`,
    publishRunId,
    operationType,
    status: input.status,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    error: input.error,
  });
}

/** Converts thrown publisher/provider errors into durable structured failure metadata. */
export function serializePublisherError(error: unknown, code: string): SerializedPublisherError {
  if (error instanceof GitHubProviderError) {
    return {
      code,
      reason: error.code,
      message: error.message,
      retryable: isRetryableGitHubError(error.code),
      provider: "github",
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      ...(error.rateLimit !== undefined ? { rateLimit: error.rateLimit } : {}),
      details: {
        name: error.name,
        providerCode: error.code,
        ...(error.stack ? { stack: error.stack } : {}),
      },
    };
  }

  if (error instanceof Error) {
    return {
      code,
      reason: "publisher_error",
      message: error.message,
      retryable: true,
      details: {
        name: error.name,
        ...(error.stack ? { stack: error.stack } : {}),
      },
    };
  }

  return {
    code,
    reason: "unknown_error",
    message: String(error),
    retryable: true,
  };
}

/** Returns whether a GitHub provider error should be retried without configuration changes. */
function isRetryableGitHubError(code: GitHubErrorCode): boolean {
  return (
    code === "github_rate_limit" ||
    code === "github_secondary_rate_limit" ||
    code === "github_unavailable" ||
    code === "github_unknown"
  );
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}

function hashJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
