import { createHash, randomUUID } from "node:crypto";
import type {
  PublishedFindingStatus,
  PublishReviewJobPayload,
  ValidatedFinding,
} from "@repo/contracts";
import {
  type HeimdallDatabase,
  publishedCheckRuns,
  publishedFindings,
  publishedReviews,
  publishedSummaryComments,
  publishOperations,
  publishRuns,
  ReviewRepository,
  repositories,
} from "@repo/db";
import type { GitHubRepositoryRef, GitProvider } from "@repo/github";
import { and, eq } from "drizzle-orm";

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
  /** Provider summary comment ID returned by GitHub, when fallback summary was published. */
  readonly providerSummaryCommentId?: string;
  /** Number of validated findings included as check-run annotations. */
  readonly annotationCount: number;
  /** Number of inline comments published or reconciled. */
  readonly inlineCommentCount: number;
  /** Whether publishing was skipped because the PR moved to a new head SHA. */
  readonly staleHead: boolean;
};

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
      metadata: { pullRequestNumber: payload.pullRequestNumber },
    })
    .onConflictDoUpdate({
      target: publishRuns.idempotencyKey,
      set: {
        status: "running",
        startedAt,
        completedAt: null,
        error: null,
        metadata: { pullRequestNumber: payload.pullRequestNumber },
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
    const inlineComments = findings.filter((finding) => finding.location.isInDiff !== false);
    const checkRunInput = {
      ...repository,
      reviewRunId: payload.reviewRunId,
      name: "Heimdall Review",
      headSha: reviewRun.headSha,
      status: "completed" as const,
      conclusion: findings.length === 0 ? ("success" as const) : ("neutral" as const),
      title: findings.length === 0 ? "No findings" : `${findings.length} review finding(s)`,
      summary: renderSummary(findings),
      annotations: findings.map(toCheckRunAnnotation),
    };
    await insertPublishOperation(dependencies.db, publishRunId, "check_run.upsert", {
      status: "running",
      requestHash: hashJson(checkRunInput),
    });
    const checkRun = await dependencies.gitProvider.createOrUpdateCheckRun(checkRunInput);

    await dependencies.db
      .insert(publishedCheckRuns)
      .values({
        publishedCheckRunId: stableId("pcr", [publishRunId, checkRun.providerCheckRunId]),
        publishRunId,
        reviewRunId: payload.reviewRunId,
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
    await insertPublishOperation(dependencies.db, publishRunId, "check_run.upsert", {
      status: "completed",
      responseHash: hashJson(checkRun),
    });

    const review = await publishInlineComments({
      db: dependencies.db,
      gitProvider: dependencies.gitProvider,
      repository,
      publishRunId,
      reviewRunId: payload.reviewRunId,
      pullRequestNumber: payload.pullRequestNumber,
      headSha: reviewRun.headSha,
      findings: inlineComments,
      publishedAt: now(),
    });
    const findingsNeedingSummary = findings.filter(
      (finding) =>
        finding.location.isInDiff === false || !review.commentIdsByFindingId[finding.findingId],
    );
    const fallbackSummary =
      findingsNeedingSummary.length === 0
        ? undefined
        : await publishSummaryFallback({
            db: dependencies.db,
            gitProvider: dependencies.gitProvider,
            repository,
            publishRunId,
            reviewRunId: payload.reviewRunId,
            pullRequestNumber: payload.pullRequestNumber,
            findings: findingsNeedingSummary,
            publishedAt: now(),
          });

    const completedAt = now();
    await dependencies.db
      .update(publishRuns)
      .set({
        status: "completed",
        completedAt,
        error: null,
        metadata: {
          providerCheckRunId: checkRun.providerCheckRunId,
          providerReviewId: review.providerReviewId,
          providerSummaryCommentId: fallbackSummary?.providerCommentId,
          inlineCommentCount: review.commentIds.length,
          summaryFallback: fallbackSummary !== undefined,
        },
      })
      .where(eq(publishRuns.idempotencyKey, idempotencyKey));

    return {
      publishRunId,
      providerCheckRunId: checkRun.providerCheckRunId,
      providerReviewId: review.providerReviewId,
      ...(fallbackSummary ? { providerSummaryCommentId: fallbackSummary.providerCommentId } : {}),
      annotationCount: checkRunInput.annotations.length,
      inlineCommentCount: review.commentIds.length,
      staleHead: false,
    };
  } catch (error) {
    await dependencies.db
      .update(publishRuns)
      .set({
        status: "failed",
        completedAt: now(),
        error: {
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
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
    });

    return {
      providerReviewId: stableId("review", [input.reviewRunId, "inline-failed"]),
      commentIds: [],
      commentIdsByFindingId: {},
    };
  }
}

async function publishSummaryFallback(input: {
  readonly db: HeimdallDatabase;
  readonly gitProvider: GitProvider;
  readonly repository: GitHubRepositoryRef;
  readonly publishRunId: string;
  readonly reviewRunId: string;
  readonly pullRequestNumber: number;
  readonly findings: readonly ValidatedFinding[];
  readonly publishedAt: Date;
}): Promise<{ readonly providerCommentId: string }> {
  const body = renderFallbackSummary(input.findings);
  const summaryInput = {
    ...input.repository,
    pullRequestNumber: input.pullRequestNumber,
    reviewRunId: input.reviewRunId,
    body,
  };
  await insertPublishOperation(input.db, input.publishRunId, "summary_comment.fallback", {
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
      metadata: { htmlUrl: comment.htmlUrl },
    })
    .onConflictDoUpdate({
      target: publishedSummaryComments.publishedSummaryCommentId,
      set: {
        bodyHash: hashJson(body),
        status: "published",
        metadata: { htmlUrl: comment.htmlUrl },
      },
    });
  await Promise.all(
    input.findings.map((finding) =>
      upsertPublishedFinding(input.db, {
        finding,
        publishRunId: input.publishRunId,
        providerCommentId: comment.providerCommentId,
        publishedAt: input.publishedAt,
        status: "published",
      }),
    ),
  );
  await insertPublishOperation(input.db, input.publishRunId, "summary_comment.fallback", {
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
      provider: repositories.provider,
    })
    .from(repositories)
    .where(and(eq(repositories.repoId, repoId), eq(repositories.provider, "github")))
    .limit(1);

  if (!repository) {
    throw new Error(`GitHub repository ${repoId} was not found.`);
  }

  return {
    provider: "github",
    installationId: repository.installationId,
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
  },
): Promise<void> {
  await db.insert(publishOperations).values({
    publishOperationId: `pop_${randomUUID().replaceAll("-", "")}`,
    publishRunId,
    operationType,
    status: input.status,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
  });
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
