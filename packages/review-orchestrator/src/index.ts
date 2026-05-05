import { createHash } from "node:crypto";
import type {
  CandidateFinding,
  JobEnvelope,
  PullRequestSnapshot,
  ReviewArtifactKind,
  ReviewArtifactRef,
  ReviewRun,
  ReviewTrigger,
  ValidatedFinding,
} from "@repo/contracts";
import { JOB_TYPES } from "@repo/contracts";
import {
  backgroundJobs,
  type HeimdallDatabase,
  PullRequestRepository,
  providerInstallations,
  ReviewRepository,
  repositories,
} from "@repo/db";
import type { GitHubRepositoryRef, GitProvider } from "@repo/github";
import { type SyncRepositoryWorkspaceResult, syncRepositoryWorkspace } from "@repo/repo-sync";
import { runReviewPasses } from "@repo/review-engine";
import { and, eq } from "drizzle-orm";

/** Payload required to process one pull request review job. */
export type ReviewPullRequestInput = {
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Heimdall installation ID. */
  readonly installationId: string;
  /** Pull request number. */
  readonly pullRequestNumber: number;
  /** Base commit SHA carried by the job. */
  readonly baseSha: string;
  /** Head commit SHA carried by the job. */
  readonly headSha: string;
  /** Review trigger source. */
  readonly trigger: ReviewTrigger;
};

/** Dependencies used by the review orchestrator. */
export type ReviewOrchestratorDependencies = {
  /** Database used to persist review state. */
  readonly db: HeimdallDatabase;
  /** Git provider used to fetch PR data and clone credentials. */
  readonly gitProvider: GitProvider;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
  /** Optional workspace sync function for tests. */
  readonly syncWorkspace?: SyncWorkspace;
  /** Optional clock for deterministic tests. */
  readonly now?: () => Date;
};

/** Workspace sync function used by review orchestration. */
export type SyncWorkspace = (
  input: GitHubRepositoryRef & {
    readonly commitSha: string;
    readonly workspaceRoot?: string;
  },
) => Promise<SyncRepositoryWorkspaceResult>;

/** Result returned after one review job is orchestrated. */
export type ReviewOrchestrationResult = {
  /** Completed or failed review run ID. */
  readonly reviewRunId: string;
  /** Snapshot ID used by the review run. */
  readonly snapshotId: string;
  /** Number of candidate findings emitted by review-engine passes. */
  readonly candidateFindingCount: number;
  /** Number of findings accepted by the validation and ranking shim. */
  readonly validatedFindingCount: number;
  /** Publish job key persisted for worker handoff. */
  readonly publishJobKey: string;
};

/** Error raised when a fetched PR snapshot does not match the queued review job. */
export class ReviewInputSnapshotMismatchError extends Error {
  /** Creates a snapshot mismatch error. */
  public constructor(
    message: string,
    /** Mismatch metadata useful for job error payloads and debugging. */
    public readonly metadata: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReviewInputSnapshotMismatchError";
  }
}

/** Runs the first deterministic end-to-end pull request review skeleton. */
export async function runPullRequestReview(
  input: ReviewPullRequestInput,
  dependencies: ReviewOrchestratorDependencies,
): Promise<ReviewOrchestrationResult> {
  const now = dependencies.now ?? (() => new Date());
  const reviewRepository = new ReviewRepository(dependencies.db);
  const pullRequestRepository = new PullRequestRepository(dependencies.db);
  const repository = await loadGitHubRepositoryRef(dependencies.db, input);
  const pullRequestRef = { ...repository, pullRequestNumber: input.pullRequestNumber };

  const snapshot = await dependencies.gitProvider.fetchPullRequestSnapshot(pullRequestRef);
  assertSnapshotMatchesJob(input, snapshot);
  const reviewRunId = stableId("rrn", [
    "github",
    snapshot.repoId,
    snapshot.pullRequestNumber,
    snapshot.headSha,
  ]);
  await pullRequestRepository.insertSnapshot(snapshot);
  const startedAt = now().toISOString();
  let reviewRun = await reviewRepository.upsertReviewRun(
    createReviewRun({
      input,
      snapshot,
      reviewRunId,
      status: "snapshotting",
      timestamp: startedAt,
    }),
  );

  try {
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "snapshot",
      status: "completed",
      metadata: { snapshotId: snapshot.snapshotId, diffHash: snapshot.diffHash },
    });

    const syncWorkspace =
      dependencies.syncWorkspace ??
      ((workspaceInput: GitHubRepositoryRef & { readonly commitSha: string }) =>
        syncRepositoryWorkspace(workspaceInput, { gitProvider: dependencies.gitProvider }));
    const workspace = await syncWorkspace(
      withOptionalWorkspaceRoot(
        {
          ...repository,
          commitSha: snapshot.headSha,
        },
        dependencies.workspaceRoot,
      ),
    );
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "workspace",
      status: "completed",
      metadata: {
        checkedOutSha: workspace.checkedOutSha,
        cleanedUp: workspace.cleanedUp,
        workspacePath: workspace.workspacePath,
      },
    });

    const artifacts = [
      await persistArtifact(reviewRepository, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "pull_request_snapshot",
        name: "pull-request-snapshot.json",
        payload: snapshot,
        createdAt: now().toISOString(),
      }),
      await persistArtifact(reviewRepository, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "orchestrator_trace",
        name: "orchestrator-trace.json",
        payload: {
          schemaVersion: "orchestrator_trace.v1",
          reviewRunId,
          snapshotId: snapshot.snapshotId,
          workspace: {
            checkedOutSha: workspace.checkedOutSha,
            cleanedUp: workspace.cleanedUp,
          },
          generatedAt: now().toISOString(),
        },
        createdAt: now().toISOString(),
      }),
    ];

    const candidateFindings = await runReviewPasses({
      context: {
        reviewRunId,
        snapshot,
        timestamp: now().toISOString(),
      },
    });
    for (const finding of candidateFindings) {
      await reviewRepository.insertCandidateFinding(finding);
    }

    const validatedFindings = validateAndRankCandidateFindings({
      findings: candidateFindings,
      timestamp: now().toISOString(),
    });
    for (const finding of validatedFindings) {
      await reviewRepository.insertValidatedFinding(finding);
    }

    const candidateArtifact = await persistArtifact(reviewRepository, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "candidate_findings",
      name: "candidate-findings.json",
      payload: { schemaVersion: "candidate_findings.v1", findings: candidateFindings },
      createdAt: now().toISOString(),
    });
    const validatedArtifact = await persistArtifact(reviewRepository, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "validated_findings",
      name: "validated-findings.json",
      payload: { schemaVersion: "validated_findings.v1", findings: validatedFindings },
      createdAt: now().toISOString(),
    });
    const publishJobKey = createPublishJobKey(reviewRunId);
    const completedAt = now().toISOString();
    reviewRun = await reviewRepository.upsertReviewRun({
      ...reviewRun,
      status: "completed",
      completedAt,
      updatedAt: completedAt,
      summary:
        candidateFindings.length === 0
          ? "Review completed with no candidate findings and queued publisher handoff."
          : "Review completed with deterministic findings and queued publisher handoff.",
      artifactRefs: [...artifacts, candidateArtifact, validatedArtifact],
      counts: {
        candidateFindings: candidateFindings.length,
        validatedFindings: validatedFindings.filter((finding) => finding.decision === "publish")
          .length,
        publishedFindings: 0,
        rejectedFindings: validatedFindings.filter((finding) => finding.decision === "reject")
          .length,
      },
      metadata: {
        ...reviewRun.metadata,
        workspace: {
          checkedOutSha: workspace.checkedOutSha,
          cleanedUp: workspace.cleanedUp,
        },
        publishJobKey,
      },
    });
    await enqueuePublishJob(dependencies.db, {
      reviewRunId,
      repoId: snapshot.repoId,
      pullRequestNumber: snapshot.pullRequestNumber,
      timestamp: now().toISOString(),
    });
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "review",
      status: "completed",
      metadata: { candidateFindingCount: candidateFindings.length },
    });

    return {
      reviewRunId: reviewRun.reviewRunId,
      snapshotId: snapshot.snapshotId,
      candidateFindingCount: candidateFindings.length,
      validatedFindingCount: validatedFindings.length,
      publishJobKey,
    };
  } catch (error) {
    const failedAt = now().toISOString();
    await reviewRepository.upsertReviewRun({
      ...reviewRun,
      status: "failed",
      completedAt: failedAt,
      updatedAt: failedAt,
      error: {
        code: "review_orchestrator.failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    });
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "review",
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Loads a GitHub repository reference for review orchestration. */
export async function loadGitHubReviewRepositoryRef(
  db: HeimdallDatabase,
  input: Pick<ReviewPullRequestInput, "repoId" | "installationId">,
): Promise<GitHubRepositoryRef> {
  return loadGitHubRepositoryRef(db, input);
}

async function loadGitHubRepositoryRef(
  db: HeimdallDatabase,
  input: Pick<ReviewPullRequestInput, "repoId" | "installationId">,
): Promise<GitHubRepositoryRef> {
  const [repository] = await db
    .select({
      owner: repositories.owner,
      repo: repositories.name,
      providerRepoId: repositories.providerRepoId,
      provider: repositories.provider,
    })
    .from(repositories)
    .where(eq(repositories.repoId, input.repoId))
    .limit(1);

  if (!repository || repository.provider !== "github") {
    throw new Error(`GitHub repository ${input.repoId} was not found.`);
  }

  const [installation] = await db
    .select({
      installationId: providerInstallations.installationId,
      providerInstallationId: providerInstallations.providerInstallationId,
    })
    .from(providerInstallations)
    .where(
      and(
        eq(providerInstallations.provider, "github"),
        eq(providerInstallations.installationId, input.installationId),
      ),
    )
    .limit(1);

  if (!installation) {
    throw new Error(`GitHub installation ${input.installationId} was not found.`);
  }

  return {
    provider: "github",
    installationId: installation.installationId,
    providerInstallationId: installation.providerInstallationId,
    owner: repository.owner,
    repo: repository.repo,
    providerRepoId: repository.providerRepoId,
  };
}

/** Verifies that a live fetched snapshot still represents the queued review job. */
export function assertSnapshotMatchesJob(
  input: ReviewPullRequestInput,
  snapshot: PullRequestSnapshot,
): void {
  const mismatches = [
    ["repoId", input.repoId, snapshot.repoId],
    ["installationId", input.installationId, snapshot.installationId],
    ["pullRequestNumber", input.pullRequestNumber, snapshot.pullRequestNumber],
    ["baseSha", input.baseSha, snapshot.baseSha],
    ["headSha", input.headSha, snapshot.headSha],
  ].filter(([, expected, actual]) => expected !== actual);

  if (mismatches.length === 0) {
    return;
  }

  throw new ReviewInputSnapshotMismatchError("Fetched pull request snapshot does not match job.", {
    mismatches: mismatches.map(([field, expected, actual]) => ({ field, expected, actual })),
    snapshotId: snapshot.snapshotId,
  });
}

function createReviewRun(input: {
  readonly input: ReviewPullRequestInput;
  readonly snapshot: PullRequestSnapshot;
  readonly reviewRunId: string;
  readonly status: ReviewRun["status"];
  readonly timestamp: string;
}): ReviewRun {
  return {
    reviewRunId: input.reviewRunId,
    schemaVersion: "review_run.v1",
    repoId: input.snapshot.repoId,
    pullRequestSnapshotId: input.snapshot.snapshotId,
    pullRequestNumber: input.snapshot.pullRequestNumber,
    baseSha: input.snapshot.baseSha,
    headSha: input.snapshot.headSha,
    trigger: input.input.trigger,
    status: input.status,
    startedAt: input.timestamp,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    artifactRefs: [],
    counts: {
      candidateFindings: 0,
      validatedFindings: 0,
      publishedFindings: 0,
      rejectedFindings: 0,
    },
    metadata: {
      jobBaseSha: input.input.baseSha,
      jobHeadSha: input.input.headSha,
    },
  };
}

async function persistArtifact(
  repository: ReviewRepository,
  input: {
    readonly reviewRunId: string;
    readonly repoId: string;
    readonly kind: ReviewArtifactKind;
    readonly name: string;
    readonly payload: unknown;
    readonly createdAt: string;
  },
): Promise<ReviewArtifactRef> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.payload));
  const hash = sha256(bytes);
  const artifact: ReviewArtifactRef = {
    artifactId: stableId("art", [input.reviewRunId, input.kind, input.name, hash]),
    kind: input.kind,
    uri: `db://review_artifacts/${input.reviewRunId}/${input.kind}/${input.name}`,
    contentHash: hash,
    createdAt: input.createdAt,
    metadata: { name: input.name },
  };

  await repository.insertReviewArtifact({
    reviewRunId: input.reviewRunId,
    repoId: input.repoId,
    artifact,
    name: input.name,
    sizeBytes: bytes.byteLength,
    metadata: { payload: input.payload },
  });

  return artifact;
}

function validateAndRankCandidateFindings(input: {
  readonly findings: readonly CandidateFinding[];
  readonly timestamp: string;
}): readonly ValidatedFinding[] {
  return input.findings.map((finding, index) => {
    const publishable = finding.confidence >= 0.5 && finding.evidence.length > 0;
    return {
      findingId: stableId("vfnd", [finding.findingId, "validation.v1"]),
      candidateFindingId: finding.findingId,
      reviewRunId: finding.reviewRunId,
      decision: publishable ? "publish" : "reject",
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
      location: finding.location,
      evidence: finding.evidence,
      confidence: finding.confidence,
      validation: {
        validatedAt: input.timestamp,
        validatorVersion: "validation-ranking-shim.v1",
        reasons: publishable ? [] : ["low_confidence"],
      },
      ...(publishable ? { rank: index + 1 } : {}),
      fingerprint: finding.fingerprint,
      metadata: { candidateSourceName: finding.sourceName },
    };
  });
}

async function enqueuePublishJob(
  db: HeimdallDatabase,
  input: {
    readonly reviewRunId: string;
    readonly repoId: string;
    readonly pullRequestNumber: number;
    readonly timestamp: string;
  },
): Promise<string> {
  const idempotencyKey = createPublishJobKey(input.reviewRunId);
  const envelope: JobEnvelope<{
    readonly reviewRunId: string;
    readonly repoId: string;
    readonly pullRequestNumber: number;
  }> = {
    jobId: stableId("job", [idempotencyKey]),
    jobType: JOB_TYPES.PublishReview,
    schemaVersion: "job_envelope.v1",
    idempotencyKey,
    createdAt: input.timestamp,
    attempt: 0,
    maxAttempts: 3,
    payload: {
      reviewRunId: input.reviewRunId,
      repoId: input.repoId,
      pullRequestNumber: input.pullRequestNumber,
    },
  };

  await db
    .insert(backgroundJobs)
    .values({
      backgroundJobId: envelope.jobId,
      queueName: "publishing",
      jobKey: idempotencyKey,
      jobType: JOB_TYPES.PublishReview,
      status: "pending",
      repoId: input.repoId,
      reviewRunId: input.reviewRunId,
      payload: envelope,
      maxAttempts: envelope.maxAttempts,
    })
    .onConflictDoNothing();

  return idempotencyKey;
}

function createPublishJobKey(reviewRunId: string): string {
  return `review.publish.v1:${reviewRunId}`;
}

function withOptionalWorkspaceRoot<T extends GitHubRepositoryRef & { readonly commitSha: string }>(
  input: T,
  workspaceRoot?: string,
): T & { readonly workspaceRoot?: string } {
  return {
    ...input,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
