import { createHash } from "node:crypto";
import {
  InlineReviewArtifactPayloadStore,
  type ReviewArtifactPayloadStore,
  reviewArtifactPayloadDescriptor,
} from "@repo/artifacts";
import type {
  JobEnvelope,
  PlanSnapshot,
  PublishReviewJobPayload,
  PullRequestSnapshot,
  ReviewArtifactKind,
  ReviewArtifactRef,
  ReviewRun,
  ReviewTrigger,
} from "@repo/contracts";
import { JOB_TYPES } from "@repo/contracts";
import {
  backgroundJobs,
  codeIndexVersions,
  type HeimdallDatabase,
  llmCalls,
  memoryFacts,
  PullRequestRepository,
  providerInstallations,
  RepoRuleRepository,
  RepositoryRepository,
  ReviewRepository,
  repositories,
} from "@repo/db";
import type { GitHubPullRequestRef, GitHubRepositoryRef, GitProvider } from "@repo/github";
import { createStaticLLMGateway, type LLMGateway } from "@repo/llm-gateway";
import type { MemoryAppliesTo, MemoryFact, MemoryFactKind } from "@repo/memory";
import {
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContext,
} from "@repo/observability";
import { buildRawDiffArtifact, buildSnapshotDerivedArtifacts } from "@repo/pr-snapshot";
import { createPublishPlan, hasPlannedPublishOperations, type PublishPlan } from "@repo/publisher";
import {
  cleanupRepositoryWorkspace,
  type SyncRepositoryWorkspaceResult,
  syncRepositoryWorkspace,
} from "@repo/repo-sync";
import { createDatabaseRetrievalIndex, retrieveContext } from "@repo/retrieval";
import {
  llmReviewPass,
  runReviewPasses,
  staticAnalysisReviewPass,
  validateCandidateFindings,
} from "@repo/review-engine";
import { buildReviewPolicySnapshot, type ReviewPolicySnapshot } from "@repo/rules";
import {
  runStaticAnalysis,
  type StaticAnalysisBudgets,
  type StaticAnalysisMode,
  type StaticAnalysisReport,
  type StaticAnalysisRequest,
} from "@repo/static-analysis";
import type { ToolRunner } from "@repo/tool-runner";
import {
  DefaultEntitlementService,
  DefaultQuotaService,
  type EntitlementService,
  estimateLlmTokenUsage,
  type LlmTokenRateCard,
  MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
  monthlyQuotaPeriod,
  PostgresEntitlementStore,
  PostgresQuotaStore,
  PostgresUsageLedgerStore,
  type QuotaService,
  type ReserveQuotaResult,
  UsageLedger,
  ZERO_COST_LLM_RATE_CARD,
} from "@repo/usage";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";

/** Default bounded wait for the index job planned alongside a review job. */
const DEFAULT_INDEX_WAIT_TIMEOUT_MS = 10_000;

/** Default polling cadence while waiting for a fresh index version. */
const DEFAULT_INDEX_POLL_INTERVAL_MS = 250;

/** Maximum active memory facts to consider during one review validation. */
const REVIEW_MEMORY_FACT_LIMIT = 50;

const MEMORY_FACT_KINDS = new Set<MemoryFactKind>([
  "suppression",
  "repo_fact",
  "team_preference",
  "style_preference",
  "architecture_convention",
  "security_convention",
  "testing_convention",
  "severity_calibration",
  "domain_glossary",
]);

const MEMORY_FACT_STATUSES = new Set<ReviewMemoryFactStatus>([
  "active",
  "disabled",
  "expired",
  "superseded",
  "needs_review",
]);

const FINDING_CATEGORIES = new Set([
  "correctness",
  "security",
  "performance",
  "test_coverage",
  "maintainability",
  "architecture",
  "dependency",
  "documentation",
  "style",
  "other",
]);

const FINDING_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

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
  /** Optional model gateway for LLM-backed review passes. */
  readonly llmGateway?: LLMGateway;
  /** Optional rate card used to estimate LLM token cost. */
  readonly llmUsageRateCard?: LlmTokenRateCard;
  /** Optional usage ledger for recording completed review and model usage. */
  readonly usageLedger?: UsageLedger;
  /** Optional artifact payload store used for durable review artifact payloads. */
  readonly artifactPayloadStore?: ReviewArtifactPayloadStore;
  /** Optional static-analysis runner for changed-file tool diagnostics. */
  readonly staticAnalysisRunner?: ToolRunner;
  /** Optional static-analysis mode. Defaults to changed-files-fast. */
  readonly staticAnalysisMode?: StaticAnalysisMode;
  /** Optional static-analysis budgets. */
  readonly staticAnalysisBudgets?: StaticAnalysisBudgets;
  /** Optional entitlement service for provider-free plan snapshots. */
  readonly entitlementService?: EntitlementService;
  /** Optional quota service for monthly review credit reservations. */
  readonly quotaService?: QuotaService;
  /** Whether indexed retrieval is available for this run. */
  readonly indexAvailable?: boolean;
  /** Maximum time to wait for a newly queued index to become ready before diff fallback. */
  readonly indexWaitTimeoutMs?: number;
  /** Poll interval used while waiting for a newly queued index to become ready. */
  readonly indexPollIntervalMs?: number;
  /** Optional clock for deterministic tests. */
  readonly now?: () => Date;
  /** Optional trace context propagated from the durable review job. */
  readonly traceContext?: TelemetryTraceContext;
  /** Optional metric recorder used for review-adjacent component instrumentation. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional span recorder used for review pipeline instrumentation. */
  readonly traces?: TelemetrySpanRecorder;
};

/** PR snapshot fetch result used by review orchestration. */
type ReviewSnapshotFetchResult = {
  /** Provider-neutral pull request snapshot. */
  readonly snapshot: PullRequestSnapshot;
  /** Exact provider raw unified diff text, when the provider can return it. */
  readonly rawDiff?: string;
  /** Hash of the raw diff text, when available. */
  readonly rawDiffHash?: PullRequestSnapshot["diffHash"];
  /** UTF-8 byte size of the raw diff text, when available. */
  readonly rawDiffBytes?: number;
};

/** Durable memory fact row selected for review validation. */
export type ReviewMemoryFactRow = typeof memoryFacts.$inferSelect;

/** Status values supported by the memory package durable fact type. */
type ReviewMemoryFactStatus = MemoryFact["status"];

/** Input used to check whether a review run still targets the current PR head. */
export type ReviewRunCurrentCheckInput = GitHubPullRequestRef & {
  /** Head commit SHA the review run is about to publish. */
  readonly expectedHeadSha: string;
};

/** Current-head state for a review run just before publish handoff. */
export type ReviewRunCurrentStatus = "current" | "superseded" | "closed" | "unknown";

/** Workspace sync function used by review orchestration. */
export type SyncWorkspace = (
  input: GitHubRepositoryRef & {
    readonly commitSha: string;
    readonly keepWorkspace?: boolean;
    readonly workspaceRoot?: string;
  },
) => Promise<SyncRepositoryWorkspaceResult>;

/** Input for creating a review-owned static-analysis request. */
export type CreateStaticAnalysisRequestForReviewInput = {
  /** Organization ID that owns the review run. */
  readonly orgId: string;
  /** Repository ID being reviewed. */
  readonly repoId: string;
  /** Review run ID that owns the static-analysis report. */
  readonly reviewRunId: string;
  /** Pull request snapshot being reviewed. */
  readonly snapshot: PullRequestSnapshot;
  /** Synced workspace available to static-analysis tools. */
  readonly workspace: SyncRepositoryWorkspaceResult;
  /** Request creation timestamp. */
  readonly timestamp: string;
  /** Optional static-analysis mode. */
  readonly mode?: StaticAnalysisMode | undefined;
  /** Optional static-analysis budgets. */
  readonly budgets?: StaticAnalysisBudgets | undefined;
};

/** Result returned after one review job is orchestrated. */
export type ReviewOrchestrationResult = {
  /** Completed or failed review run ID. */
  readonly reviewRunId: string;
  /** Snapshot ID used by the review run. */
  readonly snapshotId: string;
  /** Number of candidate findings emitted by review-engine passes. */
  readonly candidateFindingCount: number;
  /** Number of findings accepted for publishing after validation and ranking. */
  readonly validatedFindingCount: number;
  /** Publish job key persisted for worker handoff when review work completed. */
  readonly publishJobKey?: string | undefined;
};

/** Durable review orchestration stages that map to review run statuses. */
export type ReviewOrchestrationStage = "index" | "retrieval" | "review" | "validation" | "publish";

/** Review pipeline stages emitted as product-safe telemetry span attributes. */
export type ReviewTelemetryStage =
  | "quota"
  | "snapshot"
  | "workspace"
  | "static_analysis"
  | "index"
  | "retrieval"
  | "review"
  | "validation"
  | "staleness"
  | "publish";

/** Input used to start a product-safe review stage span. */
export type ReviewTelemetryStageSpanInput = {
  /** Low-cardinality attributes attached to the stage span. */
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Review pipeline stage represented by the span. */
  readonly stage: ReviewTelemetryStage;
  /** Optional trace context propagated from the durable review job. */
  readonly traceContext?: TelemetryTraceContext | undefined;
  /** Optional span recorder selected by the worker observability runtime. */
  readonly traces?: TelemetrySpanRecorder | undefined;
};

/** Review orchestration outcomes emitted on the top-level review span. */
type ReviewTelemetryOutcome = "completed" | "failed" | "skipped" | "superseded";

/** Options used while running a traced review stage operation. */
type ReviewTelemetryStageOperationOptions<T> = {
  /** Low-cardinality attributes attached when the stage starts. */
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Builds low-cardinality attributes from the stage result before the span ends. */
  readonly endAttributes?:
    | ((result: T) => Readonly<Record<string, TelemetryAttributeValue | undefined>>)
    | undefined;
};

/** Result from optional static-analysis orchestration. */
type ReviewStaticAnalysisResult = {
  /** Static-analysis report when execution completed. */
  readonly report?: StaticAnalysisReport | undefined;
  /** Whether the synced workspace has been removed. */
  readonly workspaceCleanedUp: boolean;
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
  const repositoryRepository = new RepositoryRepository(dependencies.db);
  const usageLedger =
    dependencies.usageLedger ?? new UsageLedger(new PostgresUsageLedgerStore(dependencies.db));
  const entitlementService =
    dependencies.entitlementService ??
    new DefaultEntitlementService(new PostgresEntitlementStore(dependencies.db));
  const quotaService =
    dependencies.quotaService ?? new DefaultQuotaService(new PostgresQuotaStore(dependencies.db));
  const artifactPayloadStore =
    dependencies.artifactPayloadStore ?? new InlineReviewArtifactPayloadStore();
  const repositoryRecord = await repositoryRepository.getRepository(input.repoId);
  if (!repositoryRecord) {
    throw new Error(`Repository ${input.repoId} was not found.`);
  }
  const repository = await loadGitHubRepositoryRef(dependencies.db, input);
  const pullRequestRef = { ...repository, pullRequestNumber: input.pullRequestNumber };

  const snapshotFetch = await fetchPullRequestSnapshotForReview(
    dependencies.gitProvider,
    pullRequestRef,
  );
  const snapshot = snapshotFetch.snapshot;
  assertSnapshotMatchesJob(input, snapshot);
  const reviewRunId = stableId("rrn", [
    "github",
    snapshot.repoId,
    snapshot.pullRequestNumber,
    snapshot.headSha,
  ]);
  await pullRequestRepository.insertSnapshot(snapshot);
  const startedAt = now().toISOString();
  const snapshotDerivedArtifacts = buildSnapshotDerivedArtifacts({
    createdAt: startedAt,
    snapshot,
  });
  const rawDiffArtifact =
    snapshotFetch.rawDiff !== undefined
      ? buildRawDiffArtifact({
          createdAt: startedAt,
          rawDiff: snapshotFetch.rawDiff,
          snapshot,
        })
      : undefined;
  const repositorySettings = await repositoryRepository.getSettings(input.repoId);
  const activeRules = await new RepoRuleRepository(dependencies.db).listEffectiveRules({
    orgId: repositoryRecord.orgId,
    repoId: input.repoId,
  });
  const policyResult = buildReviewPolicySnapshot({
    activeRules,
    repository: repositoryRecord,
    ...(repositorySettings ? { settings: repositorySettings } : {}),
    timestamp: startedAt,
    reviewRunId,
  });
  const planSnapshot = await entitlementService.compilePlanSnapshot({
    now: startedAt,
    orgId: repositoryRecord.orgId,
  });
  let reviewRun = await reviewRepository.upsertReviewRun(
    createReviewRun({
      input,
      planSnapshot,
      policySnapshot: policyResult.snapshot,
      snapshot,
      reviewRunId,
      status: "snapshotting",
      timestamp: startedAt,
    }),
  );
  let quotaReservation: ReserveQuotaResult | undefined;
  let quotaReservationFinalized = false;
  let currentStage = "snapshot";
  const reviewSpan = startPullRequestReviewTelemetrySpan(input, dependencies);

  try {
    currentStage = "quota";
    quotaReservation = await runReviewTelemetryStage(dependencies, "quota", () =>
      reserveReviewCreditQuota({
        now: startedAt,
        orgId: repositoryRecord.orgId,
        planSnapshot,
        quotaService,
        reviewRunId,
      }),
    );
    if (!quotaReservation.decision.allowed || !quotaReservation.reservation) {
      const skippedAt = now().toISOString();
      reviewRun = await reviewRepository.upsertReviewRun({
        ...reviewRun,
        completedAt: skippedAt,
        status: "skipped",
        summary: "Review skipped because the monthly review credit quota is exhausted.",
        updatedAt: skippedAt,
        error: {
          code: "review_orchestrator.quota_exceeded",
          message: "Monthly review credit quota is exhausted.",
          retryable: false,
        },
        metadata: {
          ...reviewRun.metadata,
          planSnapshot: planSnapshotMetadata(planSnapshot),
          quota: {
            decision: quotaReservation.decision,
            quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
          },
        },
      });
      await reviewRepository.insertStageEvent({
        reviewRunId,
        stage: "quota",
        status: "skipped",
        metadata: { decision: quotaReservation.decision },
      });

      const result = {
        reviewRunId: reviewRun.reviewRunId,
        snapshotId: snapshot.snapshotId,
        candidateFindingCount: 0,
        validatedFindingCount: 0,
      };
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage,
        outcome: "skipped",
        result,
      });

      return result;
    }
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "quota",
      status: quotaReservation.decision.status,
      metadata: {
        counter: quotaReservation.counter,
        decision: quotaReservation.decision,
        reservationId: quotaReservation.reservation.quotaReservationId,
      },
    });
    currentStage = "snapshot";
    await runReviewTelemetryStage(
      dependencies,
      "snapshot",
      async () => {
        await reviewRepository.insertStageEvent({
          reviewRunId,
          stage: "snapshot",
          status: "completed",
          metadata: {
            changedFileCount: snapshot.changedFileCount,
            changedPathCount: snapshotDerivedArtifacts.changeSet.changedPathSet.length,
            diffHash: snapshot.diffHash,
            fileAnchorCount: snapshotDerivedArtifacts.lineAnchorIndex.files.length,
            lineAnchorCount: snapshotDerivedArtifacts.lineAnchorIndex.lines.length,
            ...(snapshotFetch.rawDiffBytes !== undefined
              ? { rawDiffBytes: snapshotFetch.rawDiffBytes }
              : {}),
            ...(snapshotFetch.rawDiffHash !== undefined
              ? { rawDiffHash: snapshotFetch.rawDiffHash }
              : {}),
            snapshotId: snapshot.snapshotId,
          },
        });
      },
      {
        endAttributes: () => ({
          "review.changed_file_count": snapshot.changedFileCount,
          "review.raw_diff_available": snapshotFetch.rawDiffBytes !== undefined,
        }),
      },
    );

    const syncWorkspace =
      dependencies.syncWorkspace ??
      ((workspaceInput: GitHubRepositoryRef & { readonly commitSha: string }) =>
        syncRepositoryWorkspace(workspaceInput, { gitProvider: dependencies.gitProvider }));
    currentStage = "workspace";
    const workspace = await runReviewTelemetryStage(
      dependencies,
      "workspace",
      () =>
        syncWorkspace(
          withOptionalWorkspaceRoot(
            {
              ...repository,
              commitSha: snapshot.headSha,
              keepWorkspace: Boolean(dependencies.staticAnalysisRunner),
            },
            dependencies.workspaceRoot,
          ),
        ),
      {
        endAttributes: (syncedWorkspace) => ({
          "review.workspace_cleaned_up": syncedWorkspace.cleanedUp,
        }),
      },
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
    const staticAnalysis = await runReviewTelemetryStage(
      dependencies,
      "static_analysis",
      () =>
        runStaticAnalysisForReview({
          budgets: dependencies.staticAnalysisBudgets,
          cleanupWorkspace:
            Boolean(dependencies.staticAnalysisRunner) &&
            !dependencies.syncWorkspace &&
            !workspace.cleanedUp,
          mode: dependencies.staticAnalysisMode,
          now: now().toISOString(),
          orgId: repositoryRecord.orgId,
          repoId: snapshot.repoId,
          reviewRepository,
          reviewRunId,
          runner: dependencies.staticAnalysisRunner,
          snapshot,
          workspace,
        }),
      {
        attributes: {
          "review.static_analysis_configured": Boolean(dependencies.staticAnalysisRunner),
        },
        endAttributes: (result) => ({
          "review.static_analysis_reported": result.report !== undefined,
          "review.workspace_cleaned_up": result.workspaceCleanedUp,
        }),
      },
    );
    const staticAnalysisReport = staticAnalysis.report;

    const artifacts = [
      await persistArtifact(reviewRepository, artifactPayloadStore, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "pull_request_snapshot",
        name: "pull-request-snapshot.json",
        payload: snapshot,
        createdAt: now().toISOString(),
      }),
      ...(rawDiffArtifact
        ? [
            await persistArtifact(reviewRepository, artifactPayloadStore, {
              reviewRunId,
              repoId: snapshot.repoId,
              kind: "raw_diff",
              name: "raw-diff.json",
              payload: rawDiffArtifact,
              createdAt: now().toISOString(),
            }),
          ]
        : []),
      await persistArtifact(reviewRepository, artifactPayloadStore, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "line_anchor_index",
        name: "line-anchor-index.json",
        payload: snapshotDerivedArtifacts.lineAnchorIndex,
        createdAt: now().toISOString(),
      }),
      await persistArtifact(reviewRepository, artifactPayloadStore, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "change_set",
        name: "change-set.json",
        payload: snapshotDerivedArtifacts.changeSet,
        createdAt: now().toISOString(),
      }),
      await persistArtifact(reviewRepository, artifactPayloadStore, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "policy_snapshot",
        name: "policy-snapshot.json",
        payload: policyResult,
        createdAt: now().toISOString(),
      }),
      await persistArtifact(reviewRepository, artifactPayloadStore, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "plan_snapshot",
        name: "plan-snapshot.json",
        payload: planSnapshot,
        createdAt: now().toISOString(),
      }),
      ...(staticAnalysisReport
        ? [
            await persistArtifact(reviewRepository, artifactPayloadStore, {
              reviewRunId,
              repoId: snapshot.repoId,
              kind: "static_analysis",
              name: "static-analysis-report.json",
              payload: staticAnalysisReport,
              createdAt: now().toISOString(),
            }),
          ]
        : []),
      await persistArtifact(reviewRepository, artifactPayloadStore, {
        reviewRunId,
        repoId: snapshot.repoId,
        kind: "orchestrator_trace",
        name: "orchestrator-trace.json",
        payload: {
          schemaVersion: "orchestrator_trace.v1",
          reviewRunId,
          snapshotId: snapshot.snapshotId,
          changeSet: {
            changedPathCount: snapshotDerivedArtifacts.changeSet.changedPathSet.length,
            totalAddedLines: snapshotDerivedArtifacts.changeSet.totalAddedLines,
            totalDeletedLines: snapshotDerivedArtifacts.changeSet.totalDeletedLines,
          },
          lineAnchors: {
            fileCount: snapshotDerivedArtifacts.lineAnchorIndex.files.length,
            lineCount: snapshotDerivedArtifacts.lineAnchorIndex.lines.length,
          },
          ...(rawDiffArtifact
            ? {
                rawDiff: {
                  diffHash: rawDiffArtifact.diffHash,
                  sizeBytes: rawDiffArtifact.sizeBytes,
                },
              }
            : {}),
          workspace: {
            checkedOutSha: workspace.checkedOutSha,
            cleanedUp: staticAnalysis.workspaceCleanedUp,
          },
          ...(staticAnalysisReport
            ? {
                staticAnalysis: {
                  diagnosticCount: staticAnalysisReport.summary.diagnosticCount,
                  reportId: staticAnalysisReport.reportId,
                  status: staticAnalysisReport.status,
                  toolRunCount: staticAnalysisReport.summary.toolRunCount,
                },
              }
            : {}),
          policy: policySnapshotMetadata(policyResult.snapshot),
          plan: planSnapshotMetadata(planSnapshot),
          generatedAt: now().toISOString(),
        },
        createdAt: now().toISOString(),
      }),
    ];

    reviewRun = await transitionReviewRunStage(
      reviewRepository,
      reviewRun,
      "index",
      now().toISOString(),
    );
    currentStage = "index";
    const indexVersionId = await runReviewTelemetryStage(
      dependencies,
      "index",
      () =>
        waitForReadyIndexVersionId(dependencies.db, {
          repoId: snapshot.repoId,
          commitSha: snapshot.headSha,
          timeoutMs: dependencies.indexWaitTimeoutMs ?? DEFAULT_INDEX_WAIT_TIMEOUT_MS,
          pollIntervalMs: dependencies.indexPollIntervalMs ?? DEFAULT_INDEX_POLL_INTERVAL_MS,
        }),
      {
        endAttributes: (readyIndexVersionId) => ({
          "review.index_ready": readyIndexVersionId !== undefined,
        }),
      },
    );
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "index",
      status: indexVersionId ? "completed" : "degraded",
      metadata: {
        commitSha: snapshot.headSha,
        ...(indexVersionId ? { indexVersionId } : {}),
      },
    });
    const retrievalIndex = indexVersionId
      ? createDatabaseRetrievalIndex({
          db: dependencies.db,
          indexVersionId,
        })
      : undefined;
    reviewRun = await transitionReviewRunStage(
      reviewRepository,
      reviewRun,
      "retrieval",
      now().toISOString(),
    );
    currentStage = "retrieval";
    const contextBundle = await runReviewTelemetryStage(
      dependencies,
      "retrieval",
      () =>
        retrieveContext({
          reviewRunId,
          snapshot,
          indexAvailable: Boolean(retrievalIndex) || (dependencies.indexAvailable ?? false),
          ...(retrievalIndex ? { index: retrievalIndex } : {}),
          ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
          timestamp: now().toISOString(),
          ...(dependencies.traces ? { traces: dependencies.traces } : {}),
        }),
      {
        attributes: {
          "review.index_available":
            Boolean(retrievalIndex) || (dependencies.indexAvailable ?? false),
        },
        endAttributes: (bundle) => ({
          "review.context_item_count": bundle.items.length,
          "review.estimated_context_tokens": bundle.tokenBudget.estimatedTokens,
        }),
      },
    );
    const contextArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "context_bundle",
      name: "context-bundle.json",
      payload: contextBundle,
      createdAt: now().toISOString(),
    });
    const retrievalMode =
      contextBundle.metadata && typeof contextBundle.metadata.retrievalMode === "string"
        ? contextBundle.metadata.retrievalMode
        : undefined;
    const retrievalWarningCount = Array.isArray(contextBundle.metadata?.warnings)
      ? contextBundle.metadata.warnings.length
      : 0;
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "retrieval",
      status: "completed",
      metadata: {
        contextBundleId: contextBundle.contextBundleId,
        estimatedTokens: contextBundle.tokenBudget.estimatedTokens,
        itemCount: contextBundle.items.length,
        ...(indexVersionId ? { indexVersionId } : {}),
        ...(retrievalMode ? { retrievalMode } : {}),
        ...(retrievalWarningCount > 0 ? { warningCount: retrievalWarningCount } : {}),
      },
    });

    reviewRun = await transitionReviewRunStage(
      reviewRepository,
      reviewRun,
      "review",
      now().toISOString(),
    );
    currentStage = "review";
    const candidateFindings = await runReviewTelemetryStage(
      dependencies,
      "review",
      () =>
        runReviewPasses({
          passes: staticAnalysisReport
            ? [staticAnalysisReviewPass, llmReviewPass]
            : [llmReviewPass],
          context: {
            reviewRunId,
            snapshot,
            contextBundle,
            ...(staticAnalysisReport ? { staticAnalysisReport } : {}),
            llmGateway: createUsageRecordingLlmGateway({
              db: dependencies.db,
              gateway:
                dependencies.llmGateway ??
                createStaticLLMGateway(
                  { findings: [] },
                  {
                    ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
                    ...(dependencies.traces ? { traces: dependencies.traces } : {}),
                  },
                ),
              now,
              orgId: repositoryRecord.orgId,
              rateCard: dependencies.llmUsageRateCard ?? ZERO_COST_LLM_RATE_CARD,
              repoId: snapshot.repoId,
              reviewRunId,
              usageLedger,
            }),
            timestamp: now().toISOString(),
          },
        }),
      {
        attributes: {
          "review.static_analysis_reported": staticAnalysisReport !== undefined,
        },
        endAttributes: (findings) => ({
          "review.candidate_finding_count": findings.length,
        }),
      },
    );
    for (const finding of candidateFindings) {
      await reviewRepository.insertCandidateFinding(finding);
    }
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "review",
      status: "completed",
      metadata: { candidateFindingCount: candidateFindings.length },
    });

    reviewRun = await transitionReviewRunStage(
      reviewRepository,
      reviewRun,
      "validation",
      now().toISOString(),
    );
    currentStage = "validation";
    const validationTelemetryResult = await runReviewTelemetryStage(
      dependencies,
      "validation",
      async () => {
        const reviewMemoryFacts = await loadReviewMemoryFacts(dependencies.db, {
          now: now(),
          orgId: repositoryRecord.orgId,
          repoId: snapshot.repoId,
        });
        const previousPublishedFindings =
          await reviewRepository.listPublishedFindingsForPullRequest({
            excludeReviewRunId: reviewRunId,
            pullRequestNumber: snapshot.pullRequestNumber,
            repoId: snapshot.repoId,
          });
        const validationConfig = {
          contextBundle,
          memorySuppression: {
            memoryFacts: reviewMemoryFacts,
            orgId: repositoryRecord.orgId,
            repoId: snapshot.repoId,
          },
          policy: policyResult.snapshot.effectivePolicy,
          previousPublishedFindings,
        };
        const validationResult = validateCandidateFindings({
          snapshot,
          findings: candidateFindings,
          timestamp: now().toISOString(),
          config: validationConfig,
        });

        return {
          previousPublishedFindings,
          reviewMemoryFacts,
          validationResult,
        };
      },
      {
        endAttributes: (result) => ({
          "review.memory_fact_count": result.reviewMemoryFacts.length,
          "review.previous_published_finding_count": result.previousPublishedFindings.length,
          "review.validated_finding_count": result.validationResult.validated.length,
        }),
      },
    );
    const { previousPublishedFindings, reviewMemoryFacts, validationResult } =
      validationTelemetryResult;
    const validatedFindings = validationResult.validated;
    for (const finding of validatedFindings) {
      await reviewRepository.insertValidatedFinding(finding);
    }
    const findingIdByCandidateFindingId = new Map(
      validatedFindings.map((finding) => [finding.candidateFindingId, finding.findingId]),
    );
    await reviewRepository.insertFindingValidationEvents(
      validationResult.trace.events.map((event) => ({
        candidateFindingId: event.candidateFindingId,
        createdAt: validationResult.trace.completedAt,
        findingId: findingIdByCandidateFindingId.get(event.candidateFindingId) ?? null,
        findingValidationEventId: event.eventId,
        metadata: {
          traceCompletedAt: validationResult.trace.completedAt,
          traceStartedAt: validationResult.trace.startedAt,
          validatorVersion: validationResult.trace.validatorVersion,
        },
        reason: event.reasons[0] ?? null,
        reasons: event.reasons,
        reviewRunId,
        stage: event.stage,
        status: event.status,
      })),
    );
    await reviewRepository.insertFindingDuplicateGroups(
      validationResult.duplicateGroups.map((group) => {
        const duplicateFindingIds = group.duplicateCandidateFindingIds.flatMap(
          (candidateFindingId) => {
            const findingId = findingIdByCandidateFindingId.get(candidateFindingId);
            return findingId ? [findingId] : [];
          },
        );

        return {
          canonicalCandidateFindingId: group.canonicalCandidateFindingId,
          canonicalFindingId:
            findingIdByCandidateFindingId.get(group.canonicalCandidateFindingId) ?? null,
          createdAt: validationResult.trace.completedAt,
          duplicateCandidateFindingIds: group.duplicateCandidateFindingIds,
          duplicateFindingIds,
          findingDuplicateGroupId: stableId("fdg", [reviewRunId, group.groupKind, group.groupKey]),
          groupKey: group.groupKey,
          groupKind: group.groupKind,
          metadata: {
            duplicateCandidateCount: group.duplicateCandidateFindingIds.length,
            duplicateFindingCount: duplicateFindingIds.length,
          },
          reason: duplicateGroupReason(group.groupKind),
          reviewRunId,
        };
      }),
    );

    const candidateArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "candidate_findings",
      name: "candidate-findings.json",
      payload: { schemaVersion: "candidate_findings.v1", findings: candidateFindings },
      createdAt: now().toISOString(),
    });
    const validatedArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "validated_findings",
      name: "validated-findings.json",
      payload: { schemaVersion: "validated_findings.v1", findings: validatedFindings },
      createdAt: now().toISOString(),
    });
    const rejectedArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "rejected_findings",
      name: "rejected-findings.json",
      payload: {
        schemaVersion: "rejected_findings.v1",
        findings: validationResult.rejected,
        stats: validationResult.stats,
      },
      createdAt: now().toISOString(),
    });
    const rankingArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "ranking_report",
      name: "validation-ranking-report.json",
      payload: {
        schemaVersion: "finding_validation_report.v1",
        acceptedFindingIds: validationResult.accepted.map((finding) => finding.findingId),
        duplicateGroups: validationResult.duplicateGroups,
        rejectedFindingIds: validationResult.rejected.map((finding) => finding.findingId),
        stats: validationResult.stats,
        trace: validationResult.trace,
      },
      createdAt: now().toISOString(),
    });
    const publishPlan = createPublishPlan({
      reviewRun,
      findings: validationResult.accepted,
    });
    const publishPlanPayload = publishPlanArtifactPayload({
      generatedAt: now().toISOString(),
      headSha: snapshot.headSha,
      publishPlan,
      reviewRunId,
    });
    const publishPlanArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "publish_plan",
      name: "publish-plan.json",
      payload: publishPlanPayload,
      createdAt: publishPlanPayload.generatedAt,
    });
    const publishPlanId = stableId("pp", [reviewRunId, publishPlanArtifact.artifactId]);
    await reviewRepository.insertPublishPlan({
      publishPlanId,
      reviewRunId,
      reviewArtifactId: publishPlanArtifact.artifactId,
      headSha: publishPlanPayload.headSha,
      mode: publishPlanPayload.mode,
      inlineComments: publishPlanPayload.inlineComments,
      fileComments: publishPlanPayload.fileComments,
      checkAnnotations: publishPlanPayload.checkAnnotations,
      summary: publishPlanPayload.summary,
      stats: publishPlanPayload.stats,
      metadata: {
        findingIds: publishPlanPayload.findingIds,
        plannedOperations: publishPlanPayload.plannedOperations,
        policy: publishPlanPayload.policy,
      },
      createdAt: publishPlanPayload.generatedAt,
    });
    const publishedFindingCount = validatedFindings.filter(
      (finding) => finding.decision === "publish",
    ).length;
    const rejectedFindingCount = validatedFindings.filter(
      (finding) => finding.decision === "reject",
    ).length;
    const publishPlanModeLabel = publishPlanMode(publishPlan);
    const publishPlanHasExternalWrites = hasPlannedPublishOperations(publishPlan);
    const completedReviewArtifactRefs = [
      ...artifacts,
      contextArtifact,
      candidateArtifact,
      validatedArtifact,
      rejectedArtifact,
      rankingArtifact,
      publishPlanArtifact,
    ];
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "validation",
      status: "completed",
      metadata: {
        publishedFindingCount,
        rejectedFindingCount,
        validatedFindingCount: validatedFindings.length,
        memoryFactCount: reviewMemoryFacts.length,
        previousPublishedFindingCount: previousPublishedFindings.length,
        duplicateGroupCount: validationResult.duplicateGroups.length,
        publishPlanId,
        publishPlanArtifactId: publishPlanArtifact.artifactId,
        publishPlanHasExternalWrites,
        publishPlanMode: publishPlanModeLabel,
        validationEventCount: validationResult.trace.events.length,
        validationStats: validationResult.stats,
      },
    });
    const currentStatus = await runReviewTelemetryStage(
      dependencies,
      "staleness",
      () =>
        checkReviewRunCurrent(dependencies.gitProvider, {
          ...pullRequestRef,
          expectedHeadSha: snapshot.headSha,
        }),
      {
        endAttributes: (status) => ({
          "review.staleness_status": status,
        }),
      },
    );
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "staleness",
      status: currentStatus,
      metadata: {
        expectedHeadSha: snapshot.headSha,
        pullRequestNumber: snapshot.pullRequestNumber,
      },
    });
    if (currentStatus === "superseded" || currentStatus === "closed") {
      const completedAt = now().toISOString();
      await quotaService.releaseReservation({
        now: completedAt,
        quotaReservationId: quotaReservation.reservation.quotaReservationId,
      });
      quotaReservationFinalized = true;
      reviewRun = await reviewRepository.upsertReviewRun({
        ...reviewRun,
        status: currentStatus === "superseded" ? "superseded" : "skipped",
        completedAt,
        updatedAt: completedAt,
        summary:
          currentStatus === "superseded"
            ? "Review superseded before publish because the pull request head changed."
            : "Review skipped before publish because the pull request is no longer open.",
        artifactRefs: completedReviewArtifactRefs,
        counts: {
          candidateFindings: candidateFindings.length,
          validatedFindings: publishedFindingCount,
          publishedFindings: 0,
          rejectedFindings: rejectedFindingCount,
        },
        metadata: {
          ...reviewRun.metadata,
          currentStage: "staleness",
          publishPlanId,
          publishPlanArtifactId: publishPlanArtifact.artifactId,
          staleness: {
            expectedHeadSha: snapshot.headSha,
            status: currentStatus,
          },
        },
      });

      const result = {
        reviewRunId: reviewRun.reviewRunId,
        snapshotId: snapshot.snapshotId,
        candidateFindingCount: candidateFindings.length,
        validatedFindingCount: publishedFindingCount,
      };
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage: "staleness",
        outcome: currentStatus === "superseded" ? "superseded" : "skipped",
        result,
      });

      return result;
    }

    if (!publishPlanHasExternalWrites) {
      recordReviewTelemetryStage(dependencies, "publish", {
        "review.publish_enqueued": false,
        "review.publish_mode": publishPlanModeLabel,
        "review.stage_status": "skipped",
      });
      await reviewRepository.insertStageEvent({
        reviewRunId,
        stage: "publish",
        status: "skipped",
        metadata: {
          reason: "no_planned_publish_operations",
          publishPlanId,
          publishPlanArtifactId: publishPlanArtifact.artifactId,
          publishPlanMode: publishPlanModeLabel,
        },
      });
      const completedAt = now().toISOString();
      await quotaService.consumeReservation({
        now: completedAt,
        quotaReservationId: quotaReservation.reservation.quotaReservationId,
      });
      quotaReservationFinalized = true;
      await usageLedger.recordMany([
        {
          idempotencyKey: `review.run.completed:${reviewRunId}`,
          orgId: repositoryRecord.orgId,
          repoId: snapshot.repoId,
          reviewRunId,
          eventType: "review.run",
          quantity: 1,
          unit: "review",
          occurredAt: completedAt,
          metadata: {
            candidateFindingCount: candidateFindings.length,
            headSha: snapshot.headSha,
            pullRequestNumber: snapshot.pullRequestNumber,
            rejectedFindingCount,
            trigger: input.trigger,
            validatedFindingCount: publishedFindingCount,
          },
        },
        {
          idempotencyKey: `review.credit:${reviewRunId}`,
          orgId: repositoryRecord.orgId,
          repoId: snapshot.repoId,
          reviewRunId,
          eventType: "review.credit",
          quantity: 1,
          unit: "credit",
          occurredAt: completedAt,
          metadata: {
            planKey: planSnapshot.planKey,
            planVersionId: planSnapshot.planVersionId,
            quotaReservationId: quotaReservation.reservation.quotaReservationId,
          },
        },
      ]);
      reviewRun = await reviewRepository.upsertReviewRun({
        ...reviewRun,
        status: "completed",
        completedAt,
        updatedAt: completedAt,
        summary:
          candidateFindings.length === 0
            ? "Review completed with no candidate findings and no publisher handoff."
            : "Review completed with no publishable findings and no publisher handoff.",
        artifactRefs: completedReviewArtifactRefs,
        counts: {
          candidateFindings: candidateFindings.length,
          validatedFindings: publishedFindingCount,
          publishedFindings: 0,
          rejectedFindings: rejectedFindingCount,
        },
        metadata: {
          ...reviewRun.metadata,
          planSnapshot: planSnapshotMetadata(planSnapshot),
          policySnapshot: policySnapshotMetadata(policyResult.snapshot),
          quota: {
            decision: quotaReservation.decision,
            reservationId: quotaReservation.reservation.quotaReservationId,
          },
          workspace: {
            checkedOutSha: workspace.checkedOutSha,
            cleanedUp: staticAnalysis.workspaceCleanedUp,
          },
          currentStage: "completed",
          publishPlanId,
          publishPlanArtifactId: publishPlanArtifact.artifactId,
          publishSkipped: {
            reason: "no_planned_publish_operations",
          },
        },
      });

      const result = {
        reviewRunId: reviewRun.reviewRunId,
        snapshotId: snapshot.snapshotId,
        candidateFindingCount: candidateFindings.length,
        validatedFindingCount: publishedFindingCount,
      };
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage: "publish",
        outcome: "completed",
        result,
      });

      return result;
    }

    const publishJobKey = createPublishJobKey(reviewRunId);
    reviewRun = await transitionReviewRunStage(
      reviewRepository,
      reviewRun,
      "publish",
      now().toISOString(),
    );
    currentStage = "publish";
    await runReviewTelemetryStage(
      dependencies,
      "publish",
      () =>
        enqueuePublishJob(dependencies.db, {
          reviewRunId,
          repoId: snapshot.repoId,
          publishPlanId,
          publishPlanArtifactId: publishPlanArtifact.artifactId,
          pullRequestNumber: snapshot.pullRequestNumber,
          timestamp: now().toISOString(),
          traceContext: dependencies.traceContext,
        }),
      {
        endAttributes: () => ({
          "review.publish_enqueued": true,
          "review.publish_mode": publishPlanModeLabel,
        }),
      },
    );
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "publish",
      status: "queued",
      metadata: {
        publishJobKey,
        publishPlanId,
        publishPlanArtifactId: publishPlanArtifact.artifactId,
      },
    });
    const completedAt = now().toISOString();
    await quotaService.consumeReservation({
      now: completedAt,
      quotaReservationId: quotaReservation.reservation.quotaReservationId,
    });
    quotaReservationFinalized = true;
    await usageLedger.recordMany([
      {
        idempotencyKey: `review.run.completed:${reviewRunId}`,
        orgId: repositoryRecord.orgId,
        repoId: snapshot.repoId,
        reviewRunId,
        eventType: "review.run",
        quantity: 1,
        unit: "review",
        occurredAt: completedAt,
        metadata: {
          candidateFindingCount: candidateFindings.length,
          headSha: snapshot.headSha,
          pullRequestNumber: snapshot.pullRequestNumber,
          rejectedFindingCount,
          trigger: input.trigger,
          validatedFindingCount: publishedFindingCount,
        },
      },
      {
        idempotencyKey: `review.credit:${reviewRunId}`,
        orgId: repositoryRecord.orgId,
        repoId: snapshot.repoId,
        reviewRunId,
        eventType: "review.credit",
        quantity: 1,
        unit: "credit",
        occurredAt: completedAt,
        metadata: {
          planKey: planSnapshot.planKey,
          planVersionId: planSnapshot.planVersionId,
          quotaReservationId: quotaReservation.reservation.quotaReservationId,
        },
      },
    ]);
    reviewRun = await reviewRepository.upsertReviewRun({
      ...reviewRun,
      status: "completed",
      completedAt,
      updatedAt: completedAt,
      summary:
        candidateFindings.length === 0
          ? "Review completed with no candidate findings and queued publisher handoff."
          : "Review completed with validated findings and queued publisher handoff.",
      artifactRefs: completedReviewArtifactRefs,
      counts: {
        candidateFindings: candidateFindings.length,
        validatedFindings: publishedFindingCount,
        publishedFindings: 0,
        rejectedFindings: rejectedFindingCount,
      },
      metadata: {
        ...reviewRun.metadata,
        planSnapshot: planSnapshotMetadata(planSnapshot),
        policySnapshot: policySnapshotMetadata(policyResult.snapshot),
        quota: {
          decision: quotaReservation.decision,
          reservationId: quotaReservation.reservation.quotaReservationId,
        },
        workspace: {
          checkedOutSha: workspace.checkedOutSha,
          cleanedUp: staticAnalysis.workspaceCleanedUp,
        },
        currentStage: "completed",
        publishJobKey,
        publishPlanId,
        publishPlanArtifactId: publishPlanArtifact.artifactId,
      },
    });

    const result = {
      reviewRunId: reviewRun.reviewRunId,
      snapshotId: snapshot.snapshotId,
      candidateFindingCount: candidateFindings.length,
      validatedFindingCount: publishedFindingCount,
      publishJobKey,
    };
    endPullRequestReviewTelemetrySpan(reviewSpan, {
      currentStage: "publish",
      outcome: "completed",
      result,
    });

    return result;
  } catch (error) {
    const failedAt = now().toISOString();
    if (quotaReservation?.reservation?.status === "reserved" && !quotaReservationFinalized) {
      await quotaService.releaseReservation({
        now: failedAt,
        quotaReservationId: quotaReservation.reservation.quotaReservationId,
      });
    }
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
      metadata: {
        ...reviewRun.metadata,
        ...(quotaReservation?.reservation
          ? {
              quota: {
                decision: quotaReservation.decision,
                releasedReservationId: quotaReservation.reservation.quotaReservationId,
              },
            }
          : {}),
      },
    });
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: currentStage,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    endPullRequestReviewTelemetrySpan(reviewSpan, {
      currentStage,
      error,
      outcome: "failed",
    });
    throw error;
  }
}

/** Input used to end the top-level pull request review telemetry span. */
type EndPullRequestReviewTelemetrySpanInput = {
  /** Last known review pipeline stage when the review span ended. */
  readonly currentStage: string;
  /** Optional error that caused the review span to fail. */
  readonly error?: unknown;
  /** Product-safe review outcome label. */
  readonly outcome: ReviewTelemetryOutcome;
  /** Optional orchestration result returned by the review run. */
  readonly result?: ReviewOrchestrationResult;
};

/** Starts the top-level pull request review span when tracing is configured. */
function startPullRequestReviewTelemetrySpan(
  input: ReviewPullRequestInput,
  dependencies: Pick<ReviewOrchestratorDependencies, "traceContext" | "traces">,
): TelemetrySpanHandle | undefined {
  return dependencies.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.pullRequestReview, {
    attributes: { "review.trigger": input.trigger },
    kind: "internal",
    ...(dependencies.traceContext ? { traceContext: dependencies.traceContext } : {}),
  });
}

/** Ends the top-level pull request review span with product-safe summary attributes. */
function endPullRequestReviewTelemetrySpan(
  span: TelemetrySpanHandle | undefined,
  input: EndPullRequestReviewTelemetrySpanInput,
): void {
  span?.end({
    attributes: {
      "review.candidate_finding_count": input.result?.candidateFindingCount,
      "review.current_stage": input.currentStage,
      "review.outcome": input.outcome,
      "review.publish_enqueued": input.result?.publishJobKey !== undefined,
      "review.validated_finding_count": input.result?.validatedFindingCount,
    },
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

/** Starts a product-safe telemetry span for one review pipeline stage. */
export function startReviewTelemetryStageSpan(
  input: ReviewTelemetryStageSpanInput,
): TelemetrySpanHandle | undefined {
  return input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.reviewPipelineStage, {
    attributes: {
      ...(input.attributes ?? {}),
      "review.stage": input.stage,
    },
    kind: "internal",
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
  });
}

/** Records an instantaneous review stage span for skipped or decision-only stages. */
function recordReviewTelemetryStage(
  dependencies: Pick<ReviewOrchestratorDependencies, "traceContext" | "traces">,
  stage: ReviewTelemetryStage,
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
): void {
  const span = startReviewTelemetryStageSpan({
    attributes,
    stage,
    traceContext: dependencies.traceContext,
    traces: dependencies.traces,
  });
  span?.end({
    attributes: {
      "review.stage_status": "completed",
      ...attributes,
    },
  });
}

/** Runs one review stage operation and records success or failure as a telemetry span. */
async function runReviewTelemetryStage<T>(
  dependencies: Pick<ReviewOrchestratorDependencies, "traceContext" | "traces">,
  stage: ReviewTelemetryStage,
  operation: () => Promise<T>,
  options: ReviewTelemetryStageOperationOptions<T> = {},
): Promise<T> {
  const span = startReviewTelemetryStageSpan({
    attributes: options.attributes,
    stage,
    traceContext: dependencies.traceContext,
    traces: dependencies.traces,
  });

  try {
    const result = await operation();
    span?.end({
      attributes: {
        ...(options.endAttributes?.(result) ?? {}),
        "review.stage_status": "completed",
      },
    });
    return result;
  } catch (error) {
    span?.end({
      attributes: { "review.stage_status": "failed" },
      error,
    });
    throw error;
  }
}

/** Waits briefly for the ready index version produced by the paired indexing job. */
async function waitForReadyIndexVersionId(
  db: HeimdallDatabase,
  input: {
    readonly repoId: string;
    readonly commitSha: string;
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
  },
): Promise<string | undefined> {
  const timeoutMs = Math.max(0, input.timeoutMs);
  const pollIntervalMs = Math.max(1, input.pollIntervalMs);
  const deadline = Date.now() + timeoutMs;
  let indexVersionId = await findReadyIndexVersionId(db, input.repoId, input.commitSha);

  while (!indexVersionId && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
    indexVersionId = await findReadyIndexVersionId(db, input.repoId, input.commitSha);
  }

  return indexVersionId;
}

/** Returns the newest ready index version for a repository commit. */
async function findReadyIndexVersionId(
  db: HeimdallDatabase,
  repoId: string,
  commitSha: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ indexVersionId: codeIndexVersions.indexVersionId })
    .from(codeIndexVersions)
    .where(
      and(
        eq(codeIndexVersions.repoId, repoId),
        eq(codeIndexVersions.commitSha, commitSha),
        eq(codeIndexVersions.status, "ready"),
      ),
    )
    .orderBy(desc(codeIndexVersions.completedAt))
    .limit(1);

  return row?.indexVersionId;
}

/** Resolves after the requested number of milliseconds. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/** Loads active repository and organization memory facts for validation suppression. */
async function loadReviewMemoryFacts(
  db: HeimdallDatabase,
  input: {
    /** Organization that owns the repository. */
    readonly orgId: string;
    /** Repository being reviewed. */
    readonly repoId: string;
    /** Timestamp used for expiration filtering. */
    readonly now: Date;
  },
): Promise<readonly MemoryFact[]> {
  const rows = await db
    .select()
    .from(memoryFacts)
    .where(
      and(
        eq(memoryFacts.orgId, input.orgId),
        eq(memoryFacts.status, "active"),
        or(eq(memoryFacts.repoId, input.repoId), isNull(memoryFacts.repoId)),
        or(isNull(memoryFacts.expiresAt), gt(memoryFacts.expiresAt, input.now)),
      ),
    )
    .orderBy(desc(memoryFacts.updatedAt), asc(memoryFacts.memoryFactId))
    .limit(REVIEW_MEMORY_FACT_LIMIT);

  return rows.flatMap((row) => {
    const fact = reviewMemoryFactFromRow(row);
    return fact ? [fact] : [];
  });
}

/** Converts a durable DB memory row into the memory package validation shape. */
export function reviewMemoryFactFromRow(row: ReviewMemoryFactRow): MemoryFact | undefined {
  const metadata = recordFromUnknown(row.metadata);
  const kind = memoryFactKindFromString(row.factType);
  const status = memoryFactStatusFromString(row.status);
  const createdByLogin = stringField(metadata, "createdByLogin");
  if (!kind || !status) {
    return undefined;
  }

  return {
    id: row.memoryFactId,
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    kind,
    content: row.body,
    normalizedContent: normalizeMemoryText(row.body),
    scope: memoryScopeFromRow(row, metadata),
    appliesTo: memoryAppliesToFromMetadata(metadata),
    sourceKind: memorySourceKindFromMetadata(metadata),
    trustLevel: stringField(metadata, "trustLevel") ?? "explicit_maintainer",
    confidence: row.confidence,
    status,
    priority: numberField(metadata, "priority") ?? (kind === "suppression" ? 700 : 300),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(createdByLogin ? { createdByLogin } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Builds an inferred memory scope from row scope plus optional metadata dimensions. */
function memoryScopeFromRow(
  row: ReviewMemoryFactRow,
  metadata: Record<string, unknown>,
): MemoryFact["scope"] {
  const pathGlobs = stringArrayField(metadata, "pathGlobs");
  const languages = stringArrayField(metadata, "languages");
  const symbolNames = stringArrayField(metadata, "symbolNames");
  const findingFingerprints = stringArrayField(metadata, "findingFingerprints");

  return {
    level: memoryScopeLevel(row, {
      findingFingerprints,
      pathGlobs,
      symbolNames,
    }),
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(pathGlobs.length > 0 ? { pathGlobs } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(symbolNames.length > 0 ? { symbolNames } : {}),
    ...(findingFingerprints.length > 0 ? { findingFingerprints } : {}),
  };
}

/** Chooses the most specific memory scope level represented by the row metadata. */
function memoryScopeLevel(
  row: ReviewMemoryFactRow,
  metadata: {
    /** Path globs carried by row metadata. */
    readonly pathGlobs: readonly string[];
    /** Symbol names carried by row metadata. */
    readonly symbolNames: readonly string[];
    /** Finding fingerprints carried by row metadata. */
    readonly findingFingerprints: readonly string[];
  },
): MemoryFact["scope"]["level"] {
  if (metadata.findingFingerprints.length > 0) return "finding_fingerprint";
  if (metadata.symbolNames.length > 0) return "symbol";
  if (metadata.pathGlobs.length > 0) return "path";
  return row.repoId ? "repo" : "org";
}

/** Builds memory suppression dimensions from metadata. */
function memoryAppliesToFromMetadata(metadata: Record<string, unknown>): MemoryAppliesTo {
  const appliesTo = recordField(metadata, "appliesTo") ?? metadata;
  const categories = stringArrayField(appliesTo, "categories").filter(isFindingCategory);
  const severities = stringArrayField(appliesTo, "severities").filter(isFindingSeverity);
  const pathGlobs = stringArrayField(appliesTo, "pathGlobs");
  const languages = stringArrayField(appliesTo, "languages");
  const findingFingerprints = stringArrayField(appliesTo, "findingFingerprints");
  const titlePatterns = stringArrayField(appliesTo, "titlePatterns");
  const symbolNames = stringArrayField(appliesTo, "symbolNames");

  return {
    ...(categories.length > 0 ? { categories } : {}),
    ...(severities.length > 0 ? { severities } : {}),
    ...(pathGlobs.length > 0 ? { pathGlobs } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(findingFingerprints.length > 0 ? { findingFingerprints } : {}),
    ...(titlePatterns.length > 0 ? { titlePatterns } : {}),
    ...(symbolNames.length > 0 ? { symbolNames } : {}),
  };
}

/** Reads a memory fact kind supported by the memory package. */
function memoryFactKindFromString(value: string): MemoryFactKind | undefined {
  return MEMORY_FACT_KINDS.has(value as MemoryFactKind) ? (value as MemoryFactKind) : "repo_fact";
}

/** Reads a memory fact status supported by the memory package. */
function memoryFactStatusFromString(value: string): ReviewMemoryFactStatus | undefined {
  return MEMORY_FACT_STATUSES.has(value as ReviewMemoryFactStatus)
    ? (value as ReviewMemoryFactStatus)
    : undefined;
}

/** Maps admin/API memory source metadata into memory package source kinds. */
function memorySourceKindFromMetadata(metadata: Record<string, unknown>): MemoryFact["sourceKind"] {
  const source = stringField(metadata, "source");
  if (source === "feedback" || source === "comment_thread") return "repeated_signal";
  if (source === "system") return "system";
  return "dashboard";
}

/** Returns a JSON object record or an empty record for non-object values. */
function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads an object field from a JSON record. */
function recordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field from a JSON record. */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Reads a finite number field from a JSON record. */
function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads a string array field from a JSON record. */
function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Normalizes memory text for deterministic matching helpers. */
function normalizeMemoryText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Returns whether a metadata category is supported by finding contracts. */
function isFindingCategory(
  value: string,
): value is NonNullable<MemoryAppliesTo["categories"]>[number] {
  return FINDING_CATEGORIES.has(value);
}

/** Returns whether a metadata severity is supported by finding contracts. */
function isFindingSeverity(
  value: string,
): value is NonNullable<MemoryAppliesTo["severities"]>[number] {
  return FINDING_SEVERITIES.has(value);
}

/** Fetches the strongest snapshot payload the provider can supply for deterministic review. */
async function fetchPullRequestSnapshotForReview(
  gitProvider: GitProvider,
  input: GitHubPullRequestRef,
): Promise<ReviewSnapshotFetchResult> {
  if (gitProvider.fetchPullRequestSnapshotWithRawDiff) {
    return gitProvider.fetchPullRequestSnapshotWithRawDiff(input);
  }

  return {
    snapshot: await gitProvider.fetchPullRequestSnapshot(input),
  };
}

/** Checks whether the provider PR state still matches the review run's expected head. */
export async function checkReviewRunCurrent(
  gitProvider: Pick<GitProvider, "fetchPullRequestSnapshot">,
  input: ReviewRunCurrentCheckInput,
): Promise<ReviewRunCurrentStatus> {
  try {
    const snapshot = await gitProvider.fetchPullRequestSnapshot(input);
    if (snapshot.state === "closed" || snapshot.state === "merged") {
      return "closed";
    }
    if (snapshot.state !== "open") {
      return "unknown";
    }
    if (snapshot.headSha !== input.expectedHeadSha) {
      return "superseded";
    }

    return "current";
  } catch {
    return "unknown";
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

/** Creates the static-analysis request owned by one review run. */
export function createStaticAnalysisRequestForReview(
  input: CreateStaticAnalysisRequestForReviewInput,
): StaticAnalysisRequest {
  return {
    budgets: input.budgets,
    createdAt: input.timestamp,
    mode: input.mode ?? "changed_files_fast",
    orgId: input.orgId,
    reason: "review",
    repoId: input.repoId,
    reviewRunId: input.reviewRunId,
    schemaVersion: "static_analysis_request.v1",
    snapshot: input.snapshot,
    workspace: {
      commitSha: input.workspace.checkedOutSha,
      isTrusted: true,
      path: input.workspace.workspacePath,
      workspaceId: stableId("ws", [input.reviewRunId, input.workspace.workspacePath]),
    },
  };
}

/** Runs optional static analysis and records non-fatal stage events. */
async function runStaticAnalysisForReview(input: {
  /** Optional static-analysis budgets. */
  readonly budgets?: StaticAnalysisBudgets | undefined;
  /** Whether to remove the retained workspace after static-analysis execution. */
  readonly cleanupWorkspace: boolean;
  /** Optional static-analysis mode. */
  readonly mode?: StaticAnalysisMode | undefined;
  /** Timestamp used for the static-analysis request. */
  readonly now: string;
  /** Organization ID that owns the review run. */
  readonly orgId: string;
  /** Repository ID being reviewed. */
  readonly repoId: string;
  /** Review repository used for stage events. */
  readonly reviewRepository: ReviewRepository;
  /** Review run ID that owns the static-analysis report. */
  readonly reviewRunId: string;
  /** Optional static-analysis runner. */
  readonly runner?: ToolRunner | undefined;
  /** Pull request snapshot being reviewed. */
  readonly snapshot: PullRequestSnapshot;
  /** Synced workspace for the review run. */
  readonly workspace: SyncRepositoryWorkspaceResult;
}): Promise<ReviewStaticAnalysisResult> {
  let workspaceCleanedUp = input.workspace.cleanedUp;
  if (!input.runner) {
    return { workspaceCleanedUp };
  }

  if (input.workspace.cleanedUp) {
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis",
      status: "skipped",
      metadata: { reason: "workspace_already_cleaned_up" },
    });
    return { workspaceCleanedUp };
  }

  let report: StaticAnalysisReport | undefined;
  try {
    report = await runStaticAnalysis({
      request: createStaticAnalysisRequestForReview({
        budgets: input.budgets,
        mode: input.mode,
        orgId: input.orgId,
        repoId: input.repoId,
        reviewRunId: input.reviewRunId,
        snapshot: input.snapshot,
        timestamp: input.now,
        workspace: input.workspace,
      }),
      runner: input.runner,
    });
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis",
      status: report.status,
      metadata: {
        diagnosticCount: report.summary.diagnosticCount,
        reportId: report.reportId,
        toolRunCount: report.summary.toolRunCount,
        warningCount: report.warnings.length,
      },
    });
  } catch (error) {
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis",
      status: "degraded",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (input.cleanupWorkspace) {
    try {
      await cleanupRepositoryWorkspace(input.workspace.workspacePath);
      workspaceCleanedUp = true;
      await input.reviewRepository.insertStageEvent({
        reviewRunId: input.reviewRunId,
        stage: "workspace_cleanup",
        status: "completed",
        metadata: { workspacePath: input.workspace.workspacePath },
      });
    } catch (error) {
      await input.reviewRepository.insertStageEvent({
        reviewRunId: input.reviewRunId,
        stage: "workspace_cleanup",
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        metadata: { workspacePath: input.workspace.workspacePath },
      });
    }
  }

  return { report, workspaceCleanedUp };
}

/** Maps an orchestration stage to the persisted review run status for that stage. */
export function reviewRunStatusForStage(stage: ReviewOrchestrationStage): ReviewRun["status"] {
  switch (stage) {
    case "index":
      return "waiting_for_index";
    case "retrieval":
      return "retrieving_context";
    case "review":
      return "reviewing";
    case "validation":
      return "validating_findings";
    case "publish":
      return "publish_queued";
  }
}

/** Persists the status and current-stage metadata for a durable orchestration stage. */
async function transitionReviewRunStage(
  repository: ReviewRepository,
  reviewRun: ReviewRun,
  stage: ReviewOrchestrationStage,
  timestamp: string,
): Promise<ReviewRun> {
  return repository.upsertReviewRun({
    ...reviewRun,
    status: reviewRunStatusForStage(stage),
    updatedAt: timestamp,
    metadata: {
      ...reviewRun.metadata,
      currentStage: stage,
    },
  });
}

function createReviewRun(input: {
  readonly input: ReviewPullRequestInput;
  readonly planSnapshot: PlanSnapshot;
  readonly policySnapshot: ReviewPolicySnapshot;
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
      planSnapshot: planSnapshotMetadata(input.planSnapshot),
      policySnapshot: policySnapshotMetadata(input.policySnapshot),
    },
  };
}

/** Returns compact policy metadata safe to store on review runs and traces. */
function policySnapshotMetadata(snapshot: ReviewPolicySnapshot): Record<string, unknown> {
  return {
    policyHash: snapshot.policyHash,
    policySnapshotId: snapshot.policySnapshotId,
    publishing: snapshot.effectivePolicy.publishing,
    reviewPolicy: snapshot.effectivePolicy.reviewPolicy,
    sandbox: snapshot.effectivePolicy.sandbox,
  };
}

/** Returns compact plan metadata safe to store on review runs and traces. */
function planSnapshotMetadata(snapshot: PlanSnapshot): Record<string, unknown> {
  return {
    billingAccountId: snapshot.billingAccountId,
    paymentStatus: snapshot.paymentStatus,
    planKey: snapshot.planKey,
    planVersionId: snapshot.planVersionId,
    subscriptionStatus: snapshot.subscriptionStatus,
  };
}

/** JSON object used inside durable publish plan payloads. */
type PublishPlanPayloadObject = Record<string, unknown>;

/** Durable publish-plan artifact payload shape. */
type ReviewPublishPlanArtifactPayload = {
  /** Artifact schema version. */
  readonly schemaVersion: "publish_plan.v1";
  /** Review run that owns the plan. */
  readonly reviewRunId: string;
  /** Head commit SHA the plan targets. */
  readonly headSha: string;
  /** Compact publish mode label. */
  readonly mode: string;
  /** Effective publishing policy used by the plan. */
  readonly policy: PublishPlan["policy"];
  /** Publish throttle details used by the plan. */
  readonly throttle: PublishPlan["throttle"];
  /** Planned external operations. */
  readonly plannedOperations: PublishPlan["plannedOperations"];
  /** Inline comments planned for provider publishing. */
  readonly inlineComments: readonly PublishPlanPayloadObject[];
  /** File comments planned for provider publishing. */
  readonly fileComments: readonly PublishPlanPayloadObject[];
  /** Check annotations planned for provider publishing. */
  readonly checkAnnotations: readonly PublishPlanPayloadObject[];
  /** Summary payload planned for provider publishing. */
  readonly summary: PublishPlanPayloadObject;
  /** Aggregate plan statistics. */
  readonly stats: PublishPlanPayloadObject;
  /** Publishable finding IDs included in the plan. */
  readonly findingIds: readonly string[];
  /** Timestamp when the artifact was generated. */
  readonly generatedAt: string;
};

/** Builds the durable publish-plan artifact payload used for publisher handoff inspection. */
function publishPlanArtifactPayload(input: {
  /** Timestamp when the artifact was generated. */
  readonly generatedAt: string;
  /** Head commit SHA the plan targets. */
  readonly headSha: string;
  /** Policy-derived publish plan. */
  readonly publishPlan: PublishPlan;
  /** Review run that owns the plan. */
  readonly reviewRunId: string;
}): ReviewPublishPlanArtifactPayload {
  return {
    schemaVersion: "publish_plan.v1",
    reviewRunId: input.reviewRunId,
    headSha: input.headSha,
    mode: publishPlanMode(input.publishPlan),
    policy: input.publishPlan.policy,
    throttle: input.publishPlan.throttle,
    plannedOperations: input.publishPlan.plannedOperations,
    inlineComments: input.publishPlan.inlineFindings.map((finding) => ({
      findingId: finding.findingId,
      path: finding.location.path,
      line: finding.location.line,
      side: finding.location.side,
      title: finding.title,
      body: finding.body,
      severity: finding.severity,
      category: finding.category,
    })),
    fileComments: [],
    checkAnnotations: input.publishPlan.checkRunFindings.map((finding) => ({
      findingId: finding.findingId,
      path: finding.location.path,
      startLine: finding.location.startLine ?? finding.location.line,
      endLine: finding.location.line,
      title: finding.title,
      message: finding.body,
      severity: finding.severity,
      category: finding.category,
    })),
    summary: {
      configuredFindingIds: input.publishPlan.configuredSummaryFindings.map(
        (finding) => finding.findingId,
      ),
      findingCount: input.publishPlan.configuredSummaryFindings.length,
    },
    stats: {
      checkAnnotationCount: input.publishPlan.checkRunFindings.length,
      configuredSummaryFindingCount: input.publishPlan.configuredSummaryFindings.length,
      inlineCommentCount: input.publishPlan.inlineFindings.length,
      inlineFindingsSkippedByThrottle: input.publishPlan.throttle.inlineFindingsSkippedByThrottle,
      plannedOperationCount: input.publishPlan.plannedOperations.length,
      publishableFindingCount: input.publishPlan.findings.length,
    },
    findingIds: input.publishPlan.findings.map((finding) => finding.findingId),
    generatedAt: input.generatedAt,
  };
}

/** Returns a compact publish mode label for dashboards and artifacts. */
function publishPlanMode(plan: PublishPlan): string {
  const plannedOperationTypes = plan.plannedOperations
    .filter((operation) => operation.status === "planned")
    .map((operation) => operation.operationType);

  if (plannedOperationTypes.length === 0) {
    return "none";
  }
  if (plannedOperationTypes.length > 1) {
    return "mixed";
  }

  switch (plannedOperationTypes[0]) {
    case "check_run.upsert":
      return "check_run";
    case "review.inline_comments":
      return "inline_review";
    case "summary_comment.configured":
    case "summary_comment.fallback":
      return "summary";
    default:
      return "mixed";
  }
}

/** Maps duplicate group kinds to canonical product-safe rejection reasons. */
function duplicateGroupReason(groupKind: string): string {
  switch (groupKind) {
    case "exact":
      return "duplicate_exact";
    case "location":
      return "duplicate_location";
    case "root_cause":
      return "duplicate_root_cause";
    case "semantic":
      return "duplicate_semantic";
    default:
      return "duplicate";
  }
}

/** Reserves one monthly review credit for a review run. */
async function reserveReviewCreditQuota(input: {
  /** Entitlement-derived plan snapshot. */
  readonly planSnapshot: PlanSnapshot;
  /** Quota service used for the reservation. */
  readonly quotaService: QuotaService;
  /** Organization that owns the review. */
  readonly orgId: string;
  /** Review run that owns the reservation. */
  readonly reviewRunId: string;
  /** Reservation timestamp. */
  readonly now: string;
}): Promise<ReserveQuotaResult> {
  const period = monthlyQuotaPeriod(input.now);
  return input.quotaService.reserve({
    ...period,
    limit: reviewCreditLimitFromPlan(input.planSnapshot),
    now: input.now,
    orgId: input.orgId,
    quotaKey: MONTHLY_REVIEW_CREDITS_QUOTA_KEY,
    requested: 1,
    source: `plan:${input.planSnapshot.planKey}`,
    sourceId: input.reviewRunId,
    sourceType: "review_run",
  });
}

/** Returns the monthly review credit hard limit from a plan snapshot. */
function reviewCreditLimitFromPlan(snapshot: PlanSnapshot): number {
  const value = snapshot.limits["reviews.max_monthly_review_credits"];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  return 0;
}

async function persistArtifact(
  repository: ReviewRepository,
  artifactPayloadStore: ReviewArtifactPayloadStore,
  input: {
    readonly reviewRunId: string;
    readonly repoId: string;
    readonly kind: ReviewArtifactKind;
    readonly name: string;
    readonly payload: unknown;
    readonly createdAt: string;
  },
): Promise<ReviewArtifactRef> {
  const payloadRecord = await artifactPayloadStore.putJson({
    reviewRunId: input.reviewRunId,
    kind: input.kind,
    name: input.name,
    payload: input.payload,
  });
  const payloadDescriptor = reviewArtifactPayloadDescriptor(payloadRecord);
  const artifact: ReviewArtifactRef = {
    artifactId: stableId("art", [input.reviewRunId, input.kind, input.name, payloadRecord.hash]),
    kind: input.kind,
    uri: payloadRecord.uri,
    contentHash: payloadRecord.hash,
    createdAt: input.createdAt,
    metadata: { name: input.name, payloadStorage: payloadDescriptor },
  };

  await repository.insertReviewArtifact({
    reviewRunId: input.reviewRunId,
    repoId: input.repoId,
    artifact,
    name: input.name,
    sizeBytes: payloadRecord.sizeBytes,
    metadata: payloadRecord.metadata,
  });

  return artifact;
}

async function enqueuePublishJob(
  db: HeimdallDatabase,
  input: {
    readonly reviewRunId: string;
    readonly repoId: string;
    readonly publishPlanId: string;
    readonly publishPlanArtifactId: string;
    readonly pullRequestNumber: number;
    readonly timestamp: string;
    readonly traceContext?: TelemetryTraceContext | undefined;
  },
): Promise<string> {
  const idempotencyKey = createPublishJobKey(input.reviewRunId);
  const envelope: JobEnvelope<PublishReviewJobPayload> = {
    jobId: stableId("job", [idempotencyKey]),
    jobType: JOB_TYPES.PublishReview,
    schemaVersion: "job_envelope.v1",
    idempotencyKey,
    createdAt: input.timestamp,
    attempt: 0,
    maxAttempts: 3,
    payload: {
      publishPlanId: input.publishPlanId,
      publishPlanArtifactId: input.publishPlanArtifactId,
      reviewRunId: input.reviewRunId,
      repoId: input.repoId,
      pullRequestNumber: input.pullRequestNumber,
    },
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
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

/** Creates an LLM gateway wrapper that records call rows and token usage events. */
function createUsageRecordingLlmGateway(input: {
  /** Database used to persist LLM call rows. */
  readonly db: HeimdallDatabase;
  /** Gateway that performs the actual model work. */
  readonly gateway: LLMGateway;
  /** Clock used for deterministic timestamps. */
  readonly now: () => Date;
  /** Organization that owns the review. */
  readonly orgId: string;
  /** Repository that owns the review. */
  readonly repoId: string;
  /** Review run that caused the model call. */
  readonly reviewRunId: string;
  /** Usage ledger used for durable token events. */
  readonly usageLedger: UsageLedger;
  /** Rate card used to estimate internal model cost. */
  readonly rateCard: LlmTokenRateCard;
}): LLMGateway {
  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };

  return {
    generateObject: async (request) => {
      const callSequence = nextSequence();
      const startedAt = input.now().toISOString();
      const output = await input.gateway.generateObject(request);
      const completedAt = input.now().toISOString();
      await recordLlmUsage({
        ...input,
        completedAt,
        ...(request.metadata ? { metadata: request.metadata } : {}),
        output,
        prompt: request.prompt,
        sequence: callSequence,
        startedAt,
        system: request.system,
        task: request.task,
      });
      return output;
    },
    generateReviewFindings: async (request) => {
      const callSequence = nextSequence();
      const startedAt = input.now().toISOString();
      const output = await input.gateway.generateReviewFindings(request);
      const completedAt = input.now().toISOString();
      await recordLlmUsage({
        ...input,
        completedAt,
        ...(request.metadata ? { metadata: request.metadata } : {}),
        output,
        prompt: request.prompt,
        sequence: callSequence,
        startedAt,
        system:
          "You are a code review pass. Return only concrete, actionable findings anchored to changed diff lines.",
        task: "review.findings",
      });
      return output;
    },
  };
}

/** Persists one successful model-call row and one matching token usage event. */
async function recordLlmUsage(input: {
  /** Database used to persist LLM call rows. */
  readonly db: HeimdallDatabase;
  /** Organization that owns the review. */
  readonly orgId: string;
  /** Repository that owns the review. */
  readonly repoId: string;
  /** Review run that caused the model call. */
  readonly reviewRunId: string;
  /** Usage ledger used for durable token events. */
  readonly usageLedger: UsageLedger;
  /** Rate card used to estimate internal model cost. */
  readonly rateCard: LlmTokenRateCard;
  /** One-based call sequence within the review run. */
  readonly sequence: number;
  /** LLM task label. */
  readonly task: string;
  /** System prompt sent to the gateway. */
  readonly system: string;
  /** User prompt sent to the gateway. */
  readonly prompt: string;
  /** Structured model output. */
  readonly output: unknown;
  /** Optional caller metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Call start timestamp. */
  readonly startedAt: string;
  /** Call completion timestamp. */
  readonly completedAt: string;
}): Promise<void> {
  const promptHash = sha256(`${input.system}\n\n${input.prompt}`);
  const responseHash = sha256(JSON.stringify(input.output) ?? "");
  const estimate = estimateLlmTokenUsage({
    system: input.system,
    prompt: input.prompt,
    output: input.output,
    rateCard: input.rateCard,
  });
  const llmCallId = stableId("llm", [input.reviewRunId, input.sequence, input.task, promptHash]);
  const elapsedMs = Date.parse(input.completedAt) - Date.parse(input.startedAt);
  const latencyMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;

  await input.db
    .insert(llmCalls)
    .values({
      llmCallId,
      orgId: input.orgId,
      repoId: input.repoId,
      reviewRunId: input.reviewRunId,
      provider: estimate.provider,
      model: estimate.model,
      purpose: input.task,
      status: "succeeded",
      promptHash,
      responseHash,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      costMicros: estimate.costMicros,
      startedAt: new Date(input.startedAt),
      completedAt: new Date(input.completedAt),
      metadata: {
        cachedInputTokens: estimate.cachedInputTokens,
        latencyMs,
        rateCardId: estimate.rateCardId,
        sequence: input.sequence,
        task: input.task,
        ...(input.metadata ? { requestMetadata: input.metadata } : {}),
      },
    })
    .onConflictDoNothing();

  await input.usageLedger.record({
    idempotencyKey: `llm.token:${llmCallId}`,
    orgId: input.orgId,
    repoId: input.repoId,
    reviewRunId: input.reviewRunId,
    eventType: "llm.token",
    quantity: estimate.totalTokens,
    unit: "token",
    costMicros: estimate.costMicros,
    occurredAt: input.completedAt,
    metadata: {
      cachedInputTokens: estimate.cachedInputTokens,
      inputTokens: estimate.inputTokens,
      llmCallId,
      model: estimate.model,
      outputTokens: estimate.outputTokens,
      provider: estimate.provider,
      promptHash,
      rateCardId: estimate.rateCardId,
      responseHash,
      task: input.task,
    },
  });
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
