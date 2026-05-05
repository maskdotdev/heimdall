import { createHash, randomUUID } from "node:crypto";
import type { PublishReviewJobPayload, ValidatedFinding } from "@repo/contracts";
import {
  type HeimdallDatabase,
  publishedCheckRuns,
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
  /** Number of validated findings included as check-run annotations. */
  readonly annotationCount: number;
};

/** Creates or updates the review check run and persists durable publish state. */
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
  const publishRunId = stableId("pub", [payload.reviewRunId, "check-run"]);
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
    const findings = (await reviewRepository.listValidatedFindings(payload.reviewRunId)).filter(
      (finding) => finding.decision === "publish",
    );
    const checkRunInput = {
      ...repository,
      reviewRunId: payload.reviewRunId,
      name: "Heimdall Review",
      headSha: reviewRun.headSha,
      status: "completed" as const,
      conclusion: findings.length === 0 ? ("success" as const) : ("neutral" as const),
      title: findings.length === 0 ? "No findings" : `${findings.length} review finding(s)`,
      summary: renderSummary(findings),
      annotations: findings.map(toCheckRunAnnotation).slice(0, 50),
    };
    await insertPublishOperation(dependencies.db, publishRunId, "check_run.upsert", {
      status: "running",
      requestHash: hashJson(checkRunInput),
    });
    const checkRun = await dependencies.gitProvider.createOrUpdateCheckRun(checkRunInput);
    const completedAt = now();

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
      .onConflictDoNothing();
    await dependencies.db
      .update(publishRuns)
      .set({
        status: "completed",
        completedAt,
        error: null,
        metadata: { providerCheckRunId: checkRun.providerCheckRunId },
      })
      .where(eq(publishRuns.idempotencyKey, idempotencyKey));
    await insertPublishOperation(dependencies.db, publishRunId, "check_run.upsert", {
      status: "completed",
      responseHash: hashJson(checkRun),
    });

    return {
      publishRunId,
      providerCheckRunId: checkRun.providerCheckRunId,
      annotationCount: checkRunInput.annotations.length,
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

function renderSummary(findings: readonly ValidatedFinding[]): string {
  if (findings.length === 0) {
    return "Heimdall completed the review and found no publishable issues.";
  }

  return findings
    .map((finding, index) => `${index + 1}. **${finding.title}** in \`${finding.location.path}\``)
    .join("\n");
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
