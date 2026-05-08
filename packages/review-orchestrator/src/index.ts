import { createHash } from "node:crypto";
import {
  InlineReviewArtifactPayloadStore,
  type ReviewArtifactPayloadStore,
  reviewArtifactPayloadDescriptor,
} from "@repo/artifacts";
import type {
  ChangedFile,
  ContextBundle,
  ContextItem,
  IndexRepoCommitJobPayload,
  JobEnvelope,
  LineRange,
  OrgSettings,
  PlanSnapshot,
  PublishReviewJobPayload,
  PullRequestSnapshot,
  ReviewArtifactKind,
  ReviewArtifactRedactionLevel,
  ReviewArtifactRef,
  ReviewRun,
  ReviewTrigger,
} from "@repo/contracts";
import { getReviewArtifactRedactionLevel, JOB_TYPES } from "@repo/contracts";
import {
  BackgroundJobRepository,
  type HeimdallDatabase,
  IndexVersionRepository,
  LlmCallRepository,
  type MemoryFactRecord,
  MemoryFactRepository,
  PullRequestRepository,
  RepoRuleRepository,
  RepositoryRepository,
  ReviewRepository,
  type ReviewRunMetricsInput,
  SecurityAuditRepository,
} from "@repo/db";
import type { GitHubPullRequestRef, GitHubRepositoryRef, GitProvider } from "@repo/github";
import {
  createStaticLLMGateway,
  type LLMGateway,
  REVIEW_FINDINGS_PROMPT_DEFINITION,
} from "@repo/llm-gateway";
import type { MemoryAppliesTo, MemoryFact, MemoryFactKind } from "@repo/memory";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type StructuredTelemetryLogger,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContext,
} from "@repo/observability";
import { buildRawDiffArtifact, buildSnapshotDerivedArtifacts } from "@repo/pr-snapshot";
import { createPublishPlan, hasPlannedPublishOperations, type PublishPlan } from "@repo/publisher";
import {
  type AcquireRepositoryWorkspaceDependencies,
  acquireRepositoryWorkspace,
  cleanupRepositoryWorkspace,
  createRepoSyncConfig,
  type RepoSyncConfig,
  type RepositoryWorktreePurpose,
  type SyncRepositoryWorkspaceResult,
} from "@repo/repo-sync";
import { createDatabaseRetrievalIndex, retrieveContext } from "@repo/retrieval";
import { createReviewEngine, validateCandidateFindings } from "@repo/review-engine";
import {
  type BuildReviewPolicySnapshotResult,
  buildReviewPolicySnapshot,
  MAX_REPO_LOCAL_CONFIG_BYTES,
  type PolicyWarning,
  parseRepoLocalConfig,
  REPO_LOCAL_CONFIG_ALLOWED_PATHS,
  type RepoLocalConfig,
  type ReviewPolicySnapshot,
  type ShouldReviewPrDecision,
  shouldReviewPr,
} from "@repo/rules";
import {
  type RetentionDecision,
  redactPromptSecrets,
  resolveArtifactRetention,
} from "@repo/security";
import {
  type NormalizedToolDiagnostic,
  runStaticAnalysis,
  type StaticAnalysisBudgets,
  type StaticAnalysisMode,
  type StaticAnalysisReport,
  type StaticAnalysisRequest,
  type StaticToolName,
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
  /** Durable job ID used for product-safe review stage logs. */
  readonly jobId?: string;
  /** Runs the review pipeline without enqueueing provider-visible publisher work. */
  readonly dryRun?: boolean;
};

/** Dependencies used by the review orchestrator. */
export type ReviewOrchestratorDependencies = {
  /** Database used to persist review state. */
  readonly db: HeimdallDatabase;
  /** Git provider used to fetch PR data and clone credentials. */
  readonly gitProvider: GitProvider;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
  /** Optional repo-sync configuration used by cached workspace acquisition. */
  readonly repoSyncConfig?: RepoSyncConfig;
  /** Optional cached workspace acquisition hook for tests. */
  readonly workspaceAcquirer?: ReviewRepositoryWorkspaceAcquirer;
  /** Optional workspace sync function for legacy tests. */
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
  /** Missing-index behavior after the bounded index wait. Defaults to diff fallback. */
  readonly indexDependencyMode?: ReviewIndexDependencyMode;
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
  /** Optional structured logger used for product-safe review stage logs. */
  readonly logger?: StructuredTelemetryLogger;
};

/** Missing-index behavior after review orchestration's bounded index wait. */
export type ReviewIndexDependencyMode = "fallback" | "pause";

/** Product-safe reasons review orchestration can skip publisher handoff. */
export type ReviewPublishSkipReason = "dry_run" | "no_planned_publish_operations";

/** Review gate decision recorded before expensive review work starts. */
export type ReviewGateDecision = {
  /** Policy action used to evaluate the gate. */
  readonly action: string;
  /** Stable reason code explaining the gate result. */
  readonly reasonCode: string;
  /** Repository review policy active for this run. */
  readonly reviewPolicy: ShouldReviewPrDecision["reviewPolicy"];
  /** Whether the review pipeline should continue. */
  readonly shouldReview: boolean;
  /** Optional rules-engine trace for policy-driven gate decisions. */
  readonly trace?: ShouldReviewPrDecision["trace"] | undefined;
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
export type ReviewMemoryFactRow = MemoryFactRecord;

/** Status values supported by the memory package durable fact type. */
type ReviewMemoryFactStatus = MemoryFact["status"];

/** Input used to check whether a review run still targets the current PR head. */
export type ReviewRunCurrentCheckInput = GitHubPullRequestRef & {
  /** Head commit SHA the review run is about to publish. */
  readonly expectedHeadSha: string;
};

/** Current-head state for a review run just before publish handoff. */
export type ReviewRunCurrentStatus = "current" | "superseded" | "closed" | "unknown";

/** Staleness checkpoints where orchestration verifies the PR still targets the expected head. */
export type ReviewStalenessCheckpoint =
  | "after_snapshot"
  | "after_index"
  | "before_review"
  | "before_publish";

/** Terminal disposition for a non-current review run. */
export type ReviewStalenessDisposition = {
  /** Product-safe top-level telemetry outcome. */
  readonly outcome: Extract<ReviewTelemetryOutcome, "skipped" | "superseded">;
  /** Stable product-safe reason stored in review metadata. */
  readonly reason: string;
  /** Review-run summary for dashboard and API consumers. */
  readonly summary: string;
  /** Terminal review-run status. */
  readonly status: Extract<ReviewRun["status"], "skipped" | "superseded">;
};

/** Result returned when a staleness checkpoint stops a review run. */
type ReviewStalenessStopResult = {
  /** Whether the checkpoint released a quota reservation. */
  readonly quotaReservationReleased: boolean;
  /** Terminal orchestration result to return to the worker. */
  readonly result: ReviewOrchestrationResult;
  /** Updated terminal review run. */
  readonly reviewRun: ReviewRun;
  /** Product-safe top-level telemetry outcome. */
  readonly telemetryOutcome: Extract<ReviewTelemetryOutcome, "skipped" | "superseded">;
};

/** Product-safe metadata for one repo-local config file changed by a pull request. */
export type RepoLocalConfigChangedFile = {
  /** Current repository-relative config path. */
  readonly path: string;
  /** Previous repository-relative path when the config file was renamed. */
  readonly oldPath?: string | undefined;
  /** Provider-normalized file status. */
  readonly status: ChangedFile["status"];
  /** Added lines reported by the provider. */
  readonly additions: number;
  /** Deleted lines reported by the provider. */
  readonly deletions: number;
  /** Previous content hash when the provider supplied one. */
  readonly oldContentHash?: string | undefined;
  /** New content hash when the provider supplied one. */
  readonly newContentHash?: string | undefined;
};

/** Product-safe source metadata for the trusted repo-local config applied to a review. */
export type TrustedRepoLocalConfigSource = {
  /** Config schema version parsed from the trusted config file. */
  readonly configVersion: number;
  /** Trusted commit SHA used to load the config file. */
  readonly sourceCommitSha: string;
  /** SHA-256 hash of the trusted config file content. */
  readonly sourceHash: string;
  /** Repository-relative trusted config path. */
  readonly sourcePath: string;
};

/** Product-safe warning and audit payload for a repo-local config change in a PR. */
export type RepoLocalConfigChangeNotice = {
  /** Notice schema version. */
  readonly schemaVersion: "repo_local_config_change_notice.v1";
  /** Pull request number that changed config. */
  readonly pullRequestNumber: number;
  /** Trusted base commit SHA used for this review's policy. */
  readonly baseSha: string;
  /** Pull request head commit SHA that contains the config change. */
  readonly headSha: string;
  /** Changed repo-local config files. */
  readonly changedFiles: readonly RepoLocalConfigChangedFile[];
  /** Non-fatal policy warning shown in review metadata and traces. */
  readonly warning: PolicyWarning;
  /** Trusted base config source when one was active for this review. */
  readonly trustedConfigSource?: TrustedRepoLocalConfigSource | undefined;
};

/** Product-safe retrieval trace artifact persisted next to a context bundle. */
export type RetrievalTraceArtifactPayload = {
  /** Token budget and packing summary for the final bundle. */
  readonly budget: Record<string, unknown>;
  /** Aggregate changed-file and changed-symbol counts. */
  readonly changeAnalysis: Record<string, unknown>;
  /** Completion timestamp for trace generation. */
  readonly completedAt: string;
  /** Product-safe input summary for replay/debug inspection. */
  readonly inputSummary: Record<string, unknown>;
  /** Additional product-safe retrieval metadata copied from the context bundle. */
  readonly metadata: Record<string, unknown>;
  /** Repository that owns the retrieval. */
  readonly repoId: string;
  /** Stable retrieval trace ID. */
  readonly retrievalId: string;
  /** Review run that owns the retrieval. */
  readonly reviewRunId: string;
  /** Pull request snapshot that grounded retrieval. */
  readonly pullRequestSnapshotId: string;
  /** Schema version for retrieval trace artifacts. */
  readonly schemaVersion: "retrieval_trace.v1";
  /** Product-safe selected context item trace rows. */
  readonly selectedItems: readonly RetrievalTraceArtifactItem[];
  /** Start timestamp copied from the context bundle creation time. */
  readonly startedAt: string;
  /** Non-fatal product-safe retrieval warnings. */
  readonly warnings: readonly unknown[];
};

/** Product-safe selected context item row for retrieval trace artifacts. */
export type RetrievalTraceArtifactItem = {
  /** Stable context item ID. */
  readonly contextItemId: string;
  /** Context item kind. */
  readonly kind: ContextItem["kind"];
  /** Optional path for snippet-backed items. */
  readonly path?: string | undefined;
  /** Context packing priority. */
  readonly priority: number;
  /** Product-safe provenance reason. */
  readonly reason: string;
  /** Optional related symbol ID. */
  readonly relatedSymbolId?: string | undefined;
  /** Optional snippet range without source text. */
  readonly range?: LineRange | undefined;
  /** Retriever that produced the item. */
  readonly retriever: string;
  /** Optional normalized ranking score. */
  readonly score?: number | undefined;
  /** Context item source. */
  readonly source: ContextItem["source"];
  /** Optional item title. */
  readonly title?: string | undefined;
  /** Estimated token cost for the selected item. */
  readonly tokenEstimate: number;
};

/** Workspace acquired for review orchestration. */
export type ReviewRepositoryWorkspace = SyncRepositoryWorkspaceResult & {
  /** Repo-sync worktree lease ID when the workspace came from the cached lease manager. */
  readonly leaseId?: string | undefined;
  /** Releases the workspace lease idempotently when the workspace was retained for tools. */
  readonly release?: () => Promise<void>;
};

/** Input used by review orchestration to acquire a workspace. */
export type ReviewRepositoryWorkspaceAcquireInput = {
  /** Repository provider reference loaded from the database. */
  readonly repository: GitHubRepositoryRef;
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Exact commit SHA to make available on disk. */
  readonly commitSha: string;
  /** Optional refs to fetch before falling back to direct commit fetch. */
  readonly fetchRefHints?: readonly string[];
  /** Purpose attached to the cached worktree lease. */
  readonly purpose: RepositoryWorktreePurpose;
  /** Git provider used to resolve short-lived clone credentials. */
  readonly gitProvider: Pick<GitProvider, "getCloneAuth">;
  /** Repo-sync cache/runtime configuration. */
  readonly repoSyncConfig: RepoSyncConfig;
};

/** Workspace lease shape consumed by review orchestration. */
export type ReviewRepositoryWorkspaceLease = {
  /** Repo-sync worktree lease ID used for product-safe job traceability. */
  readonly leaseId: string;
  /** Checked-out workspace path passed to downstream tools. */
  readonly workspacePath: string;
  /** Commit SHA checked out in the workspace. */
  readonly checkedOutSha: string;
  /** Releases the cached worktree lease idempotently. */
  readonly release: () => Promise<void>;
};

/** Review workspace acquisition boundary. */
export type ReviewRepositoryWorkspaceAcquirer = (
  input: ReviewRepositoryWorkspaceAcquireInput,
) => Promise<ReviewRepositoryWorkspaceLease>;

/** Workspace sync input used by review orchestration. */
export type ReviewWorkspaceSyncInput = GitHubRepositoryRef & {
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Exact commit SHA to make available on disk. */
  readonly commitSha: string;
  /** Keeps the workspace on disk after sync when true. */
  readonly keepWorkspace?: boolean;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
  /** Optional refs to fetch before falling back to direct commit fetch. */
  readonly fetchRefHints?: readonly string[];
};

/** Workspace sync function used by review orchestration. */
export type SyncWorkspace = (input: ReviewWorkspaceSyncInput) => Promise<ReviewRepositoryWorkspace>;

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
  readonly workspace: ReviewRepositoryWorkspace;
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
  | "gate"
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

/** Product-safe stage status emitted in structured review logs. */
export type ReviewStageLogStatus =
  | "started"
  | "completed"
  | "failed"
  | "skipped"
  | "queued"
  | "paused"
  | "degraded";

/** Terminal or decision status emitted on review stage metrics. */
export type ReviewStageMetricStatus = Exclude<ReviewStageLogStatus, "started">;

/** Product-safe LLM token and cost telemetry values emitted after a successful model call. */
export type LlmUsageTelemetryInput = {
  /** Estimated model-call cost in micro-USD. */
  readonly costMicros: number;
  /** Estimated input tokens for the call. */
  readonly inputTokens: number;
  /** Bounded model profile label selected for the call. */
  readonly modelProfile?: string | undefined;
  /** Estimated output tokens for the call. */
  readonly outputTokens: number;
  /** Provider that handled the model call. */
  readonly provider: string;
  /** Stable LLM task label for the call. */
  readonly task: string;
};

/** Product-safe context attached to every structured review stage log. */
export type ReviewStageLogContext = {
  /** Durable job ID that caused the review stage, or `unknown` when unavailable. */
  readonly jobId: string;
  /** Head commit SHA being reviewed. */
  readonly headSha: string;
  /** Pull request number being reviewed. */
  readonly pullRequestNumber: number;
  /** Repository that owns the review. */
  readonly repoId: string;
  /** Review run that owns the stage. */
  readonly reviewRunId: string;
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
  /** Product-safe context attached to structured stage logs. */
  readonly logContext?: ReviewStageLogContext | undefined;
};

/** Result from optional static-analysis orchestration. */
type ReviewStaticAnalysisResult = {
  /** Static-analysis report from the optional base commit run. */
  readonly baselineReport?: StaticAnalysisReport | undefined;
  /** Whether the optional base static-analysis workspace has been removed. */
  readonly baselineWorkspaceCleanedUp?: boolean | undefined;
  /** Static-analysis report when execution completed. */
  readonly report?: StaticAnalysisReport | undefined;
  /** Whether the synced workspace has been removed. */
  readonly workspaceCleanedUp: boolean;
};

/** Result from the optional base commit static-analysis run. */
type ReviewStaticAnalysisBaselineResult = {
  /** Diagnostics from the base run grouped by static-analysis tool. */
  readonly diagnosticsByTool: Partial<Record<StaticToolName, readonly NormalizedToolDiagnostic[]>>;
  /** Static-analysis report produced for the base commit. */
  readonly report: StaticAnalysisReport;
  /** Whether the base workspace has been removed. */
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

/** Error raised when a review intentionally pauses until an index dependency is ready. */
export class ReviewIndexDependencyPendingError extends Error {
  /** Stable product-safe error code. */
  public readonly code = "review_orchestrator.index_dependency_pending";

  /** Creates an index dependency pause error. */
  public constructor(
    /** Product-safe dependency metadata useful for logs and durable job retry state. */
    public readonly metadata: {
      /** Commit SHA that needs an index. */
      readonly commitSha: string;
      /** Durable index job idempotency key. */
      readonly indexJobKey: string;
      /** Repository that owns the missing index. */
      readonly repoId: string;
      /** Review run waiting on the dependency. */
      readonly reviewRunId: string;
    },
  ) {
    super(`Review ${metadata.reviewRunId} is waiting for index ${metadata.indexJobKey}.`);
    this.name = "ReviewIndexDependencyPendingError";
  }
}

/** Runs the first deterministic end-to-end pull request review skeleton. */
export async function runPullRequestReview(
  input: ReviewPullRequestInput,
  dependencies: ReviewOrchestratorDependencies,
): Promise<ReviewOrchestrationResult> {
  const now = dependencies.now ?? (() => new Date());
  const dryRun = input.dryRun ?? false;
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
  const repoSyncConfig =
    dependencies.repoSyncConfig ??
    createRepoSyncConfig({
      ...(dependencies.workspaceRoot ? { cacheRoot: dependencies.workspaceRoot } : {}),
    });
  const syncWorkspace =
    dependencies.syncWorkspace ??
    createReviewWorkspaceSync({
      gitProvider: dependencies.gitProvider,
      repoSyncConfig,
      workspaceAcquirer: dependencies.workspaceAcquirer ?? acquireReviewRepositoryWorkspace,
    });

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
  const orgSettings = await repositoryRepository.getOrgSettings(repositoryRecord.orgId);
  const repoLocalConfig = await loadTrustedRepoLocalConfig({
    baseSha: snapshot.baseSha,
    gitProvider: dependencies.gitProvider,
    orgSettings,
    repository,
  });
  const activeRules = await new RepoRuleRepository(dependencies.db).listEffectiveRules({
    orgId: repositoryRecord.orgId,
    repoId: input.repoId,
  });
  const policyResult = buildReviewPolicySnapshot({
    activeRules,
    ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
    repository: repositoryRecord,
    ...(orgSettings ? { orgSettings } : {}),
    ...(repoLocalConfig ? { repoLocalConfig } : {}),
    ...(repositorySettings ? { settings: repositorySettings } : {}),
    ...(dependencies.traceContext ? { traceContext: dependencies.traceContext } : {}),
    timestamp: startedAt,
    ...(dependencies.traces ? { traces: dependencies.traces } : {}),
    reviewRunId,
  });
  const repoLocalConfigChange = detectRepoLocalConfigChange({
    repoLocalConfigEnabled: orgSettings?.allowRepoLocalConfig === true,
    snapshot,
    ...(repoLocalConfig ? { trustedConfig: repoLocalConfig } : {}),
  });
  const policyWarnings = repoLocalConfigChange
    ? [...policyResult.warnings, repoLocalConfigChange.warning]
    : policyResult.warnings;
  const planSnapshot = await entitlementService.compilePlanSnapshot({
    now: startedAt,
    orgId: repositoryRecord.orgId,
  });
  let reviewRun = await reviewRepository.upsertReviewRun(
    createReviewRun({
      input,
      planSnapshot,
      policyWarnings,
      ...(repoLocalConfigChange ? { repoLocalConfigChange } : {}),
      policySnapshot: policyResult.snapshot,
      snapshot,
      reviewRunId,
      status: "snapshotting",
      timestamp: startedAt,
    }),
  );
  if (repoLocalConfigChange) {
    await recordRepoLocalConfigChangeAudit(dependencies.db, {
      notice: repoLocalConfigChange,
      orgId: repositoryRecord.orgId,
      repoId: snapshot.repoId,
      reviewRunId,
      timestamp: startedAt,
    });
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "policy",
      status: "warning",
      message: repoLocalConfigChange.warning.message,
      metadata: { repoLocalConfigChange },
    });
  }
  let quotaReservation: ReserveQuotaResult | undefined;
  let quotaReservationFinalized = false;
  let currentStage = "snapshot";
  const acquiredDefaultWorkspaces: ReviewRepositoryWorkspace[] = [];
  const reviewSpan = startPullRequestReviewTelemetrySpan(input, dependencies);
  const reviewStageLogContext = createReviewStageLogContext({
    input,
    reviewRunId,
    snapshot,
  });

  try {
    currentStage = "gate";
    const gateDecision = decideReviewGate({
      dependencies,
      input,
      policySnapshot: policyResult.snapshot,
      snapshot,
    });
    recordReviewTelemetryStage(
      dependencies,
      "gate",
      {
        "review.gate_reason": gateDecision.reasonCode,
        "review.review_policy": gateDecision.reviewPolicy,
        "review.stage_status": gateDecision.shouldReview ? "completed" : "skipped",
      },
      { logContext: reviewStageLogContext },
    );
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "gate",
      status: gateDecision.shouldReview ? "completed" : "skipped",
      metadata: {
        action: gateDecision.action,
        reasonCode: gateDecision.reasonCode,
        reviewPolicy: gateDecision.reviewPolicy,
        ...(gateDecision.trace ? { trace: gateDecision.trace } : {}),
      },
    });
    if (!gateDecision.shouldReview) {
      const skippedAt = now().toISOString();
      reviewRun = await reviewRepository.upsertReviewRun({
        ...reviewRun,
        completedAt: skippedAt,
        status: "skipped",
        summary: reviewGateSkipSummary(gateDecision.reasonCode),
        updatedAt: skippedAt,
        metadata: {
          ...reviewRun.metadata,
          currentStage: "gate",
          gate: {
            action: gateDecision.action,
            reasonCode: gateDecision.reasonCode,
            reviewPolicy: gateDecision.reviewPolicy,
            ...(gateDecision.trace ? { trace: gateDecision.trace } : {}),
          },
          planSnapshot: planSnapshotMetadata(planSnapshot),
          policySnapshot: policySnapshotMetadata(policyResult.snapshot),
        },
      });
      await reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(reviewRun));

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

    currentStage = "quota";
    quotaReservation = await runReviewTelemetryStage(
      dependencies,
      "quota",
      () =>
        reserveReviewCreditQuota({
          now: startedAt,
          orgId: repositoryRecord.orgId,
          planSnapshot,
          quotaService,
          reviewRunId,
        }),
      { logContext: reviewStageLogContext },
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
      await reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(reviewRun));

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
        logContext: reviewStageLogContext,
        endAttributes: () => ({
          "review.changed_file_count": snapshot.changedFileCount,
          "review.raw_diff_available": snapshotFetch.rawDiffBytes !== undefined,
        }),
      },
    );
    currentStage = "staleness";
    const afterSnapshotStaleness = await stopReviewRunIfStale({
      checkpoint: "after_snapshot",
      dependencies,
      logContext: reviewStageLogContext,
      now,
      pullRequestRef,
      quotaReservation,
      quotaService,
      reviewRepository,
      reviewRun,
      snapshot,
    });
    if (afterSnapshotStaleness) {
      quotaReservationFinalized = afterSnapshotStaleness.quotaReservationReleased;
      reviewRun = afterSnapshotStaleness.reviewRun;
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage: "staleness",
        outcome: afterSnapshotStaleness.telemetryOutcome,
        result: afterSnapshotStaleness.result,
      });

      return afterSnapshotStaleness.result;
    }

    const shouldRunStaticAnalysisBaseline = shouldRunBaseHeadStaticAnalysis({
      mode: dependencies.staticAnalysisMode,
      runner: dependencies.staticAnalysisRunner,
    });
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
              fetchRefHints: reviewHeadFetchRefHints(snapshot),
              keepWorkspace: Boolean(dependencies.staticAnalysisRunner),
              repoId: snapshot.repoId,
            },
            dependencies.workspaceRoot,
          ),
        ),
      {
        logContext: reviewStageLogContext,
        endAttributes: (syncedWorkspace) => ({
          ...(syncedWorkspace.leaseId ? { "repo_sync.lease_id": syncedWorkspace.leaseId } : {}),
          "review.workspace_cleaned_up": syncedWorkspace.cleanedUp,
        }),
      },
    );
    if (!dependencies.syncWorkspace && workspace.release) {
      acquiredDefaultWorkspaces.push(workspace);
    }
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "workspace",
      status: "completed",
      metadata: {
        checkedOutSha: workspace.checkedOutSha,
        cleanedUp: workspace.cleanedUp,
        ...(workspace.leaseId ? { leaseId: workspace.leaseId } : {}),
        workspacePath: workspace.workspacePath,
      },
    });
    const staticAnalysisBaselineWorkspace = shouldRunStaticAnalysisBaseline
      ? await runReviewTelemetryStage(
          dependencies,
          "workspace",
          () =>
            syncWorkspace(
              withOptionalWorkspaceRoot(
                {
                  ...repository,
                  commitSha: snapshot.baseSha,
                  fetchRefHints: reviewBaseFetchRefHints(snapshot),
                  keepWorkspace: true,
                  repoId: snapshot.repoId,
                },
                dependencies.workspaceRoot,
              ),
            ),
          {
            attributes: {
              "review.static_analysis_baseline_workspace": true,
            },
            logContext: reviewStageLogContext,
            endAttributes: (syncedWorkspace) => ({
              ...(syncedWorkspace.leaseId ? { "repo_sync.lease_id": syncedWorkspace.leaseId } : {}),
              "review.workspace_cleaned_up": syncedWorkspace.cleanedUp,
            }),
          },
        )
      : undefined;
    if (staticAnalysisBaselineWorkspace) {
      if (!dependencies.syncWorkspace && staticAnalysisBaselineWorkspace.release) {
        acquiredDefaultWorkspaces.push(staticAnalysisBaselineWorkspace);
      }
      await reviewRepository.insertStageEvent({
        reviewRunId,
        stage: "workspace",
        status: "completed",
        metadata: {
          checkedOutSha: staticAnalysisBaselineWorkspace.checkedOutSha,
          cleanedUp: staticAnalysisBaselineWorkspace.cleanedUp,
          ...(staticAnalysisBaselineWorkspace.leaseId
            ? { leaseId: staticAnalysisBaselineWorkspace.leaseId }
            : {}),
          purpose: "static_analysis_baseline",
          workspacePath: staticAnalysisBaselineWorkspace.workspacePath,
        },
      });
    }
    const staticAnalysis = await runReviewTelemetryStage(
      dependencies,
      "static_analysis",
      () =>
        runStaticAnalysisForReview({
          baselineWorkspace: staticAnalysisBaselineWorkspace,
          budgets: dependencies.staticAnalysisBudgets,
          cleanupBaselineWorkspace:
            staticAnalysisBaselineWorkspace !== undefined &&
            !dependencies.syncWorkspace &&
            !staticAnalysisBaselineWorkspace.cleanedUp,
          cleanupWorkspace:
            Boolean(dependencies.staticAnalysisRunner) &&
            !dependencies.syncWorkspace &&
            !workspace.cleanedUp,
          metrics: dependencies.metrics,
          mode: dependencies.staticAnalysisMode,
          now: now().toISOString(),
          orgId: repositoryRecord.orgId,
          repoId: snapshot.repoId,
          reviewRepository,
          reviewRunId,
          runner: dependencies.staticAnalysisRunner,
          snapshot,
          traceContext: dependencies.traceContext,
          traces: dependencies.traces,
          workspace,
        }),
      {
        attributes: {
          "review.static_analysis_configured": Boolean(dependencies.staticAnalysisRunner),
        },
        logContext: reviewStageLogContext,
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
        payload: policySnapshotArtifactPayload(policyResult, policyWarnings, repoLocalConfigChange),
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
      ...(staticAnalysis.baselineReport
        ? [
            await persistArtifact(reviewRepository, artifactPayloadStore, {
              reviewRunId,
              repoId: snapshot.repoId,
              kind: "static_analysis",
              name: "static-analysis-baseline-report.json",
              payload: staticAnalysis.baselineReport,
              metadata: {
                staticAnalysis: staticAnalysisArtifactSummary(staticAnalysis.baselineReport),
                staticAnalysisRole: "baseline",
              },
              createdAt: now().toISOString(),
            }),
          ]
        : []),
      ...(staticAnalysisReport
        ? [
            await persistArtifact(reviewRepository, artifactPayloadStore, {
              reviewRunId,
              repoId: snapshot.repoId,
              kind: "static_analysis",
              name: "static-analysis-report.json",
              payload: staticAnalysisReport,
              metadata: {
                staticAnalysis: staticAnalysisArtifactSummary(staticAnalysisReport),
              },
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
          ...(staticAnalysis.baselineReport
            ? {
                staticAnalysisBaseline: {
                  diagnosticCount: staticAnalysis.baselineReport.summary.diagnosticCount,
                  reportId: staticAnalysis.baselineReport.reportId,
                  status: staticAnalysis.baselineReport.status,
                },
              }
            : {}),
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
          ...(policyWarnings.length > 0 ? { policyWarnings } : {}),
          ...(repoLocalConfigChange ? { repoLocalConfigChange } : {}),
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
        logContext: reviewStageLogContext,
        endAttributes: (readyIndexVersionId) => ({
          "review.index_ready": readyIndexVersionId !== undefined,
        }),
      },
    );
    const indexDependencyJobKey = indexVersionId
      ? undefined
      : await enqueueIndexDependencyJob(dependencies.db, {
          commitSha: snapshot.headSha,
          installationId: snapshot.installationId,
          repoId: snapshot.repoId,
          timestamp: now().toISOString(),
          ...(dependencies.traceContext ? { traceContext: dependencies.traceContext } : {}),
        });
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "index",
      status: indexVersionId
        ? "completed"
        : dependencies.indexDependencyMode === "pause"
          ? "paused"
          : "degraded",
      metadata: {
        commitSha: snapshot.headSha,
        ...(indexVersionId ? { indexVersionId } : {}),
        ...(indexDependencyJobKey ? { queuedIndexJobKey: indexDependencyJobKey } : {}),
      },
    });
    if (!indexVersionId && dependencies.indexDependencyMode === "pause" && indexDependencyJobKey) {
      const pausedAt = now().toISOString();
      if (quotaReservation?.reservation?.status === "reserved" && !quotaReservationFinalized) {
        await quotaService.releaseReservation({
          now: pausedAt,
          quotaReservationId: quotaReservation.reservation.quotaReservationId,
        });
        quotaReservationFinalized = true;
      }
      reviewRun = await reviewRepository.upsertReviewRun({
        ...reviewRun,
        status: "waiting_for_index",
        summary: "Review paused while the repository index is queued.",
        updatedAt: pausedAt,
        metadata: {
          ...reviewRun.metadata,
          indexDependency: {
            commitSha: snapshot.headSha,
            indexJobKey: indexDependencyJobKey,
            mode: "pause",
          },
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
      await reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(reviewRun));
      throw new ReviewIndexDependencyPendingError({
        commitSha: snapshot.headSha,
        indexJobKey: indexDependencyJobKey,
        repoId: snapshot.repoId,
        reviewRunId,
      });
    }
    currentStage = "staleness";
    const afterIndexStaleness = await stopReviewRunIfStale({
      artifactRefs: artifacts,
      checkpoint: "after_index",
      dependencies,
      logContext: reviewStageLogContext,
      now,
      pullRequestRef,
      quotaReservation,
      quotaService,
      reviewRepository,
      reviewRun,
      snapshot,
    });
    if (afterIndexStaleness) {
      quotaReservationFinalized = afterIndexStaleness.quotaReservationReleased;
      reviewRun = afterIndexStaleness.reviewRun;
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage: "staleness",
        outcome: afterIndexStaleness.telemetryOutcome,
        result: afterIndexStaleness.result,
      });

      return afterIndexStaleness.result;
    }
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
          rules: { rules: activeRules },
          ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
          timestamp: now().toISOString(),
          ...(dependencies.traces ? { traces: dependencies.traces } : {}),
        }),
      {
        attributes: {
          "review.index_available":
            Boolean(retrievalIndex) || (dependencies.indexAvailable ?? false),
        },
        logContext: reviewStageLogContext,
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
    const retrievalTraceCreatedAt = now().toISOString();
    const retrievalTraceArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "retrieval_trace",
      name: "retrieval-trace.json",
      payload: buildRetrievalTraceArtifactPayload({
        contextBundle,
        generatedAt: retrievalTraceCreatedAt,
      }),
      createdAt: retrievalTraceCreatedAt,
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
        contextArtifactId: contextArtifact.artifactId,
        contextBundleId: contextBundle.contextBundleId,
        estimatedTokens: contextBundle.tokenBudget.estimatedTokens,
        itemCount: contextBundle.items.length,
        retrievalTraceArtifactId: retrievalTraceArtifact.artifactId,
        ...(indexVersionId ? { indexVersionId } : {}),
        ...(retrievalMode ? { retrievalMode } : {}),
        ...(retrievalWarningCount > 0 ? { warningCount: retrievalWarningCount } : {}),
      },
    });
    currentStage = "staleness";
    const beforeReviewStaleness = await stopReviewRunIfStale({
      artifactRefs: [...artifacts, contextArtifact, retrievalTraceArtifact],
      checkpoint: "before_review",
      dependencies,
      logContext: reviewStageLogContext,
      now,
      pullRequestRef,
      quotaReservation,
      quotaService,
      reviewRepository,
      reviewRun,
      snapshot,
    });
    if (beforeReviewStaleness) {
      quotaReservationFinalized = beforeReviewStaleness.quotaReservationReleased;
      reviewRun = beforeReviewStaleness.reviewRun;
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage: "staleness",
        outcome: beforeReviewStaleness.telemetryOutcome,
        result: beforeReviewStaleness.result,
      });

      return beforeReviewStaleness.result;
    }

    reviewRun = await transitionReviewRunStage(
      reviewRepository,
      reviewRun,
      "review",
      now().toISOString(),
    );
    currentStage = "review";
    const reviewEngineResult = await runReviewTelemetryStage(
      dependencies,
      "review",
      () =>
        createReviewEngine().run({
          metrics: dependencies.metrics,
          traceContext: dependencies.traceContext,
          traces: dependencies.traces,
          context: {
            reviewRunId,
            snapshot,
            contextBundle,
            ...(staticAnalysisReport ? { staticAnalysisReport } : {}),
            llmGateway: createUsageRecordingLlmGateway({
              artifactPayloadStore,
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
              ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
              now,
              orgId: repositoryRecord.orgId,
              rateCard: dependencies.llmUsageRateCard ?? ZERO_COST_LLM_RATE_CARD,
              repoId: snapshot.repoId,
              reviewRepository,
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
        logContext: reviewStageLogContext,
        endAttributes: (result) => ({
          "review.candidate_finding_count": result.findings.length,
          "review.failed_pass_count": result.passResults.filter(
            (passResult) => passResult.status === "failed",
          ).length,
          "review.selected_pass_count": result.selectedPassIds.length,
        }),
      },
    );
    const candidateFindings = reviewEngineResult.findings;
    for (const finding of candidateFindings) {
      await reviewRepository.insertCandidateFinding(finding);
    }
    await reviewRepository.insertStageEvent({
      reviewRunId,
      stage: "review",
      status: "completed",
      metadata: {
        candidateFindingCount: candidateFindings.length,
        failedPassCount: reviewEngineResult.passResults.filter(
          (passResult) => passResult.status === "failed",
        ).length,
        selectedPassIds: reviewEngineResult.selectedPassIds,
      },
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
          metrics: dependencies.metrics,
          traceContext: dependencies.traceContext,
          traces: dependencies.traces,
        });

        return {
          previousPublishedFindings,
          reviewMemoryFacts,
          validationResult,
        };
      },
      {
        logContext: reviewStageLogContext,
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
    await reviewRepository.insertSuppressionMatches(
      validationResult.suppressionMatches.map((match) => ({
        candidateFindingId: match.candidateFindingId,
        confidence: match.confidence,
        createdAt: validationResult.trace.completedAt,
        findingId: match.findingId,
        matchKind: match.matchKind,
        memoryFactId: match.memoryFactId,
        metadata: {
          source: "finding_validation",
          traceCompletedAt: validationResult.trace.completedAt,
          traceStartedAt: validationResult.trace.startedAt,
          validatorVersion: validationResult.trace.validatorVersion,
        },
        orgId: repositoryRecord.orgId,
        reason: match.reason ?? null,
        repoId: snapshot.repoId,
        reviewRunId,
        suppressionMatchId: stableId("sm", [
          reviewRunId,
          match.candidateFindingId,
          match.memoryFactId,
          match.matchKind,
        ]),
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
    const reviewEngineArtifact = await persistArtifact(reviewRepository, artifactPayloadStore, {
      reviewRunId,
      repoId: snapshot.repoId,
      kind: "review_output",
      name: "review-engine-pass-results.json",
      payload: {
        schemaVersion: "review_engine_pass_results.v1",
        selectedPassIds: reviewEngineResult.selectedPassIds,
        passResults: reviewEngineResult.passResults.map((passResult) => ({
          passName: passResult.passName,
          passVersion: passResult.passVersion,
          status: passResult.status,
          startedAt: passResult.startedAt,
          finishedAt: passResult.finishedAt,
          durationMs: passResult.durationMs,
          candidateCount: passResult.candidates.length,
          candidateFindingIds: passResult.candidates.map((finding) => finding.findingId),
          ...(passResult.output !== undefined ? { output: passResult.output } : {}),
          ...(passResult.error ? { error: passResult.error } : {}),
        })),
      },
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
        suppressionMatches: validationResult.suppressionMatches,
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
      dryRun,
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
        dryRun,
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
    const publishSkipReason = reviewPublishSkipReason({
      dryRun,
      hasExternalWrites: publishPlanHasExternalWrites,
    });
    const completedReviewArtifactRefs = [
      ...artifacts,
      contextArtifact,
      retrievalTraceArtifact,
      candidateArtifact,
      reviewEngineArtifact,
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
    currentStage = "staleness";
    const beforePublishStaleness = await stopReviewRunIfStale({
      artifactRefs: completedReviewArtifactRefs,
      checkpoint: "before_publish",
      counts: {
        candidateFindings: candidateFindings.length,
        publishedFindings: 0,
        rejectedFindings: rejectedFindingCount,
        validatedFindings: publishedFindingCount,
      },
      dependencies,
      logContext: reviewStageLogContext,
      metadata: {
        publishPlanArtifactId: publishPlanArtifact.artifactId,
        publishPlanId,
      },
      now,
      pullRequestRef,
      quotaReservation,
      quotaService,
      reviewRepository,
      reviewRun,
      snapshot,
    });
    if (beforePublishStaleness) {
      quotaReservationFinalized = beforePublishStaleness.quotaReservationReleased;
      reviewRun = beforePublishStaleness.reviewRun;
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage: "staleness",
        outcome: beforePublishStaleness.telemetryOutcome,
        result: beforePublishStaleness.result,
      });

      return beforePublishStaleness.result;
    }

    if (publishSkipReason) {
      recordReviewTelemetryStage(
        dependencies,
        "publish",
        {
          "review.dry_run": dryRun,
          "review.publish_enqueued": false,
          "review.publish_mode": publishPlanModeLabel,
          "review.stage_status": "skipped",
        },
        { logContext: reviewStageLogContext },
      );
      await reviewRepository.insertStageEvent({
        reviewRunId,
        stage: "publish",
        status: "skipped",
        metadata: {
          dryRun,
          plannedOperationCount: publishPlan.plannedOperations.length,
          publishPlanHasExternalWrites,
          publishPlanId,
          publishPlanArtifactId: publishPlanArtifact.artifactId,
          publishPlanMode: publishPlanModeLabel,
          reason: publishSkipReason,
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
          publishSkipReason === "dry_run"
            ? "Review dry-run completed without publisher handoff."
            : candidateFindings.length === 0
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
            dryRun,
            reason: publishSkipReason,
          },
        },
      });
      await reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(reviewRun));

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
        logContext: reviewStageLogContext,
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
    await reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(reviewRun));

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
    await releaseDefaultReviewWorkspacesAfterFailure(acquiredDefaultWorkspaces);
    if (error instanceof ReviewIndexDependencyPendingError) {
      endPullRequestReviewTelemetrySpan(reviewSpan, {
        currentStage,
        error,
        outcome: "failed",
      });
      throw error;
    }
    const failedAt = now().toISOString();
    if (quotaReservation?.reservation?.status === "reserved" && !quotaReservationFinalized) {
      await quotaService.releaseReservation({
        now: failedAt,
        quotaReservationId: quotaReservation.reservation.quotaReservationId,
      });
    }
    const failedReviewRun = await reviewRepository.upsertReviewRun({
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
    await reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(failedReviewRun));
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

/** Acquires a cached repository workspace for review orchestration. */
export async function acquireReviewRepositoryWorkspace(
  input: ReviewRepositoryWorkspaceAcquireInput,
  dependencies: AcquireRepositoryWorkspaceDependencies = {},
): Promise<ReviewRepositoryWorkspaceLease> {
  const cloneAuth = await input.gitProvider.getCloneAuth(input.repository);
  const lease = await acquireRepositoryWorkspace(
    {
      cloneUrl: cloneAuth.cloneUrl,
      commitSha: input.commitSha,
      config: input.repoSyncConfig,
      credential: {
        kind: "https-basic-token",
        token: cloneAuth.password,
        username: cloneAuth.username,
      },
      ...(input.fetchRefHints ? { fetchRefHints: input.fetchRefHints } : {}),
      purpose: input.purpose,
      repoId: input.repoId,
    },
    dependencies,
  );

  return {
    checkedOutSha: lease.commitSha,
    leaseId: lease.leaseId,
    release: lease.release,
    workspacePath: lease.path,
  };
}

/** Input used to create the default cached review workspace sync function. */
type CreateReviewWorkspaceSyncInput = {
  /** Git provider used to resolve short-lived clone credentials. */
  readonly gitProvider: Pick<GitProvider, "getCloneAuth">;
  /** Repo-sync cache/runtime configuration. */
  readonly repoSyncConfig: RepoSyncConfig;
  /** Workspace acquisition boundary. */
  readonly workspaceAcquirer: ReviewRepositoryWorkspaceAcquirer;
};

/** Creates a cached workspace sync function for review orchestration. */
function createReviewWorkspaceSync(input: CreateReviewWorkspaceSyncInput): SyncWorkspace {
  return async (workspaceInput) => {
    const lease = await input.workspaceAcquirer({
      commitSha: workspaceInput.commitSha,
      ...(workspaceInput.fetchRefHints ? { fetchRefHints: workspaceInput.fetchRefHints } : {}),
      gitProvider: input.gitProvider,
      purpose: workspaceInput.keepWorkspace ? "static_analysis" : "review",
      repoId: workspaceInput.repoId,
      repoSyncConfig: input.repoSyncConfig,
      repository: workspaceInput,
    });
    const workspace = {
      checkedOutSha: lease.checkedOutSha,
      cleanedUp: false,
      leaseId: lease.leaseId,
      release: lease.release,
      workspacePath: lease.workspacePath,
    } satisfies ReviewRepositoryWorkspace;

    if (workspaceInput.keepWorkspace) {
      return workspace;
    }

    await lease.release();
    return {
      ...workspace,
      cleanedUp: true,
    };
  };
}

/** Releases default cached review workspaces without masking the original review failure. */
async function releaseDefaultReviewWorkspacesAfterFailure(
  workspaces: readonly ReviewRepositoryWorkspace[],
): Promise<void> {
  await Promise.allSettled(workspaces.map((workspace) => workspace.release?.()));
}

/** Returns fetch hints for the pull request head commit. */
function reviewHeadFetchRefHints(snapshot: PullRequestSnapshot): readonly string[] {
  return uniqueStrings([
    `refs/pull/${snapshot.pullRequestNumber}/head`,
    gitHeadRefHint(snapshot.headRef),
  ]);
}

/** Returns fetch hints for the pull request base commit. */
function reviewBaseFetchRefHints(snapshot: PullRequestSnapshot): readonly string[] {
  return [gitHeadRefHint(snapshot.baseRef)];
}

/** Converts a branch-like ref name into a full Git ref hint. */
function gitHeadRefHint(refName: string): string {
  return refName.startsWith("refs/") ? refName : `refs/heads/${refName}`;
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
  dependencies: Pick<
    ReviewOrchestratorDependencies,
    "logger" | "metrics" | "traceContext" | "traces"
  >,
  stage: ReviewTelemetryStage,
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
  options: {
    /** Product-safe context attached to structured stage logs. */
    readonly logContext?: ReviewStageLogContext | undefined;
  } = {},
): void {
  const span = startReviewTelemetryStageSpan({
    attributes,
    stage,
    traceContext: dependencies.traceContext,
    traces: dependencies.traces,
  });
  const stageStatus = reviewStageLogStatusFromAttributes(attributes);
  logReviewStage(dependencies.logger, stage, stageStatus, options.logContext, attributes);
  recordReviewStageMetrics(dependencies.metrics, stage, stageStatus, 0);
  span?.end({
    attributes: {
      "review.stage_status": "completed",
      ...attributes,
    },
  });
}

/** Runs one review stage operation and records success or failure as a telemetry span. */
async function runReviewTelemetryStage<T>(
  dependencies: Pick<
    ReviewOrchestratorDependencies,
    "logger" | "metrics" | "traceContext" | "traces"
  >,
  stage: ReviewTelemetryStage,
  operation: () => Promise<T>,
  options: ReviewTelemetryStageOperationOptions<T> = {},
): Promise<T> {
  const startedAtMs = Date.now();
  const span = startReviewTelemetryStageSpan({
    attributes: options.attributes,
    stage,
    traceContext: dependencies.traceContext,
    traces: dependencies.traces,
  });
  logReviewStage(dependencies.logger, stage, "started", options.logContext, options.attributes);

  try {
    const result = await operation();
    const endAttributes = options.endAttributes?.(result) ?? {};
    logReviewStage(dependencies.logger, stage, "completed", options.logContext, endAttributes);
    recordReviewStageMetrics(dependencies.metrics, stage, "completed", Date.now() - startedAtMs);
    span?.end({
      attributes: {
        ...endAttributes,
        "review.stage_status": "completed",
      },
    });
    return result;
  } catch (error) {
    logReviewStage(dependencies.logger, stage, "failed", options.logContext, undefined, error);
    recordReviewStageMetrics(dependencies.metrics, stage, "failed", Date.now() - startedAtMs);
    span?.end({
      attributes: { "review.stage_status": "failed" },
      error,
    });
    throw error;
  }
}

/** Records low-cardinality counter and duration metrics for one review pipeline stage. */
export function recordReviewStageMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  stage: ReviewTelemetryStage,
  status: ReviewStageMetricStatus,
  durationMs: number,
): void {
  const labels = { stage, status };
  metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewStagesTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.reviewStageDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });
}

/** Records low-cardinality LLM token and internal cost metrics for one successful model call. */
export function recordLlmUsageTelemetry(
  metrics: TelemetryMetricRecorder | undefined,
  input: LlmUsageTelemetryInput,
): void {
  const labels = {
    model_profile: normalizeReviewTelemetryLabel(input.modelProfile, "default"),
    provider: normalizeReviewTelemetryLabel(input.provider, "unknown"),
    task: normalizeReviewTelemetryLabel(input.task, "unknown"),
  };
  metrics?.count(OBSERVABILITY_METRIC_NAMES.llmTokensTotal, {
    labels: { ...labels, token_type: "input" },
    value: Math.max(0, input.inputTokens),
  });
  metrics?.count(OBSERVABILITY_METRIC_NAMES.llmTokensTotal, {
    labels: { ...labels, token_type: "output" },
    value: Math.max(0, input.outputTokens),
  });
  metrics?.count(OBSERVABILITY_METRIC_NAMES.llmEstimatedCostMicrosTotal, {
    labels,
    value: Math.max(0, input.costMicros),
  });
}

/** Builds the product-safe stage log context for one review job. */
function createReviewStageLogContext(input: {
  /** Durable review job payload. */
  readonly input: ReviewPullRequestInput;
  /** Review run that owns stage execution. */
  readonly reviewRunId: string;
  /** Pull request snapshot being reviewed. */
  readonly snapshot: PullRequestSnapshot;
}): ReviewStageLogContext {
  return {
    jobId: input.input.jobId ?? "unknown",
    headSha: input.snapshot.headSha,
    pullRequestNumber: input.snapshot.pullRequestNumber,
    repoId: input.snapshot.repoId,
    reviewRunId: input.reviewRunId,
  };
}

/** Builds product-safe structured log attributes for a review stage. */
export function reviewStageLogAttributes(input: {
  /** Additional product-safe attributes to include with the log. */
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Product-safe review context shared by all stage logs. */
  readonly context: ReviewStageLogContext;
  /** Review pipeline stage represented by the log. */
  readonly stage: ReviewTelemetryStage;
  /** Stage status represented by the log. */
  readonly status: ReviewStageLogStatus;
}): Readonly<Record<string, TelemetryAttributeValue>> {
  return compactTelemetryAttributes({
    ...(input.attributes ?? {}),
    "event.name": `review.stage.${input.status}`,
    "job.id": input.context.jobId,
    "pull_request.number": input.context.pullRequestNumber,
    "repo.id": input.context.repoId,
    "review.head_sha": input.context.headSha,
    "review.run_id": input.context.reviewRunId,
    "review.stage": input.stage,
    "review.stage_status": input.status,
  });
}

/** Emits one product-safe structured review stage log when a logger is configured. */
function logReviewStage(
  logger: StructuredTelemetryLogger | undefined,
  stage: ReviewTelemetryStage,
  status: ReviewStageLogStatus,
  context: ReviewStageLogContext | undefined,
  attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
  error?: unknown,
): void {
  if (!logger || !context) {
    return;
  }

  const logOptions = {
    attributes: reviewStageLogAttributes({ attributes, context, stage, status }),
    ...(error !== undefined ? { error } : {}),
    target: "review-orchestrator",
  };

  if (status === "failed") {
    logger.error("review stage failed", logOptions);
    return;
  }
  if (status === "degraded") {
    logger.warn("review stage degraded", logOptions);
    return;
  }

  logger.info(`review stage ${status}`, logOptions);
}

/** Normalizes stage status attributes into the structured log status vocabulary. */
function reviewStageLogStatusFromAttributes(
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
): ReviewStageMetricStatus {
  const value = attributes["review.stage_status"];
  switch (value) {
    case "skipped":
    case "queued":
    case "paused":
    case "degraded":
      return value;
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

/** Drops undefined telemetry attributes while preserving safe scalar values. */
function compactTelemetryAttributes(
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
): Readonly<Record<string, TelemetryAttributeValue>> {
  const compacted: Record<string, TelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }

  return compacted;
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
  const indexVersionRepository = new IndexVersionRepository(db);
  const indexVersion = await indexVersionRepository.getLatestReadyIndexForCommit({
    commitSha,
    repoId,
  });

  return indexVersion?.indexVersionId;
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
  const memoryFactRepository = new MemoryFactRepository(db);
  const rows = await memoryFactRepository.listActiveReviewMemoryFacts({
    ...input,
    limit: REVIEW_MEMORY_FACT_LIMIT,
  });

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

/** Reads an unknown JSON array field from a record. */
function unknownArrayField(record: Record<string, unknown>, field: string): readonly unknown[] {
  const value = record[field];

  return Array.isArray(value) ? value : [];
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

/** Returns the terminal disposition for a non-current review run at one checkpoint. */
export function reviewStalenessDisposition(
  status: ReviewRunCurrentStatus,
  checkpoint: ReviewStalenessCheckpoint,
): ReviewStalenessDisposition | undefined {
  const checkpointLabel = reviewStalenessCheckpointLabel(checkpoint);
  if (status === "superseded") {
    return {
      outcome: "superseded",
      reason: "pull_request_head_changed",
      status: "superseded",
      summary: `Review superseded ${checkpointLabel} because the pull request head changed.`,
    };
  }
  if (status === "closed") {
    return {
      outcome: "skipped",
      reason: "pull_request_not_open",
      status: "skipped",
      summary: `Review skipped ${checkpointLabel} because the pull request is no longer open.`,
    };
  }

  return undefined;
}

/** Checks current PR state at a checkpoint and terminally stops stale review runs. */
async function stopReviewRunIfStale(input: {
  /** Artifacts persisted before this checkpoint. */
  readonly artifactRefs?: readonly ReviewArtifactRef[] | undefined;
  /** Checkpoint name to record in telemetry and stage metadata. */
  readonly checkpoint: ReviewStalenessCheckpoint;
  /** Terminal counts to store if the checkpoint stops the review. */
  readonly counts?: ReviewRun["counts"] | undefined;
  /** Review orchestration dependencies used for provider checks and telemetry. */
  readonly dependencies: Pick<
    ReviewOrchestratorDependencies,
    "gitProvider" | "logger" | "metrics" | "traceContext" | "traces"
  >;
  /** Product-safe context attached to structured staleness stage logs. */
  readonly logContext: ReviewStageLogContext;
  /** Additional product-safe metadata to merge into the terminal review run. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Clock used for deterministic tests. */
  readonly now: () => Date;
  /** Provider pull request reference to check. */
  readonly pullRequestRef: GitHubPullRequestRef;
  /** Reserved quota to release if this checkpoint stops the run. */
  readonly quotaReservation?: ReserveQuotaResult | undefined;
  /** Quota service that owns release operations. */
  readonly quotaService: QuotaService;
  /** Repository helper for review run updates. */
  readonly reviewRepository: ReviewRepository;
  /** Mutable review run state before the checkpoint. */
  readonly reviewRun: ReviewRun;
  /** Snapshot that owns the expected PR head. */
  readonly snapshot: PullRequestSnapshot;
}): Promise<ReviewStalenessStopResult | undefined> {
  const currentStatus = await runReviewTelemetryStage(
    input.dependencies,
    "staleness",
    () =>
      checkReviewRunCurrent(input.dependencies.gitProvider, {
        ...input.pullRequestRef,
        expectedHeadSha: input.snapshot.headSha,
      }),
    {
      attributes: {
        "review.staleness_checkpoint": input.checkpoint,
      },
      logContext: input.logContext,
      endAttributes: (status) => ({
        "review.staleness_checkpoint": input.checkpoint,
        "review.staleness_status": status,
      }),
    },
  );
  await input.reviewRepository.insertStageEvent({
    reviewRunId: input.reviewRun.reviewRunId,
    stage: "staleness",
    status: currentStatus,
    metadata: {
      checkpoint: input.checkpoint,
      expectedHeadSha: input.snapshot.headSha,
      pullRequestNumber: input.snapshot.pullRequestNumber,
    },
  });
  const disposition = reviewStalenessDisposition(currentStatus, input.checkpoint);
  if (!disposition) {
    return undefined;
  }

  const completedAt = input.now().toISOString();
  let quotaReservationReleased = false;
  if (input.quotaReservation?.reservation) {
    await input.quotaService.releaseReservation({
      now: completedAt,
      quotaReservationId: input.quotaReservation.reservation.quotaReservationId,
    });
    quotaReservationReleased = true;
  }

  const reviewRun = await input.reviewRepository.upsertReviewRun({
    ...input.reviewRun,
    artifactRefs: [...(input.artifactRefs ?? [])],
    completedAt,
    counts: input.counts ?? {
      candidateFindings: 0,
      publishedFindings: 0,
      rejectedFindings: 0,
      validatedFindings: 0,
    },
    metadata: {
      ...input.reviewRun.metadata,
      ...(input.metadata ?? {}),
      currentStage: "staleness",
      staleness: {
        checkpoint: input.checkpoint,
        expectedHeadSha: input.snapshot.headSha,
        reason: disposition.reason,
        status: currentStatus,
      },
    },
    status: disposition.status,
    summary: disposition.summary,
    updatedAt: completedAt,
  });
  await input.reviewRepository.upsertReviewRunMetrics(reviewRunMetricsFromReviewRun(reviewRun));

  return {
    quotaReservationReleased,
    result: {
      candidateFindingCount: reviewRun.counts.candidateFindings,
      reviewRunId: reviewRun.reviewRunId,
      snapshotId: input.snapshot.snapshotId,
      validatedFindingCount: reviewRun.counts.validatedFindings,
    },
    reviewRun,
    telemetryOutcome: disposition.outcome,
  };
}

/** Returns a readable checkpoint phrase for review-run summaries. */
function reviewStalenessCheckpointLabel(checkpoint: ReviewStalenessCheckpoint): string {
  if (checkpoint === "after_snapshot") return "after snapshot";
  if (checkpoint === "after_index") return "after index wait";
  if (checkpoint === "before_review") return "before review";

  return "before publish";
}

/** Loads trusted repo-local config from the PR base SHA when organization policy allows it. */
export async function loadTrustedRepoLocalConfig(input: {
  /** Pull request base commit SHA used as the trusted config ref. */
  readonly baseSha: string;
  /** Git provider that can fetch repository file content by ref. */
  readonly gitProvider: GitProvider;
  /** Organization settings that gate repo-local config usage. */
  readonly orgSettings: OrgSettings | undefined;
  /** GitHub repository reference for the reviewed repository. */
  readonly repository: GitHubRepositoryRef;
}): Promise<RepoLocalConfig | undefined> {
  if (input.orgSettings?.allowRepoLocalConfig !== true || !input.gitProvider.fetchFileContent) {
    return undefined;
  }

  for (const sourcePath of REPO_LOCAL_CONFIG_ALLOWED_PATHS) {
    const content = await input.gitProvider.fetchFileContent({
      ...input.repository,
      maxBytes: MAX_REPO_LOCAL_CONFIG_BYTES,
      path: sourcePath,
      ref: input.baseSha,
    });
    if (!content) {
      continue;
    }

    const parsed = parseRepoLocalConfig({
      content: content.content,
      format: sourcePath.endsWith(".json") ? "json" : "yaml",
      sourceCommitSha: input.baseSha,
      sourcePath,
    });

    if (parsed.ok) {
      return parsed.config;
    }
  }

  return undefined;
}

/** Detects allowed repo-local config files changed by a PR and builds warning metadata. */
export function detectRepoLocalConfigChange(input: {
  /** Whether organization settings allow repo-local config to affect reviews. */
  readonly repoLocalConfigEnabled: boolean;
  /** Pull request snapshot whose changed files are inspected. */
  readonly snapshot: PullRequestSnapshot;
  /** Trusted base config source used by the active review policy, when present. */
  readonly trustedConfig?: RepoLocalConfig | undefined;
}): RepoLocalConfigChangeNotice | undefined {
  if (!input.repoLocalConfigEnabled) {
    return undefined;
  }

  const changedFiles = input.snapshot.changedFiles
    .filter(isRepoLocalConfigChangedFile)
    .map(repoLocalConfigChangedFileMetadata);
  if (changedFiles.length === 0) {
    return undefined;
  }

  const changedPaths = uniqueStrings(
    changedFiles.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]),
  );
  const trustedConfigSource = input.trustedConfig
    ? trustedRepoLocalConfigSource(input.trustedConfig)
    : undefined;
  const warning: PolicyWarning = {
    code: "repo_local_config_changed_in_pull_request",
    message:
      "This pull request changes repo-local reviewer configuration. Heimdall used the trusted base-branch config for this review; changes can affect reviews after merge.",
    details: {
      activePolicySource: trustedConfigSource ? "repo_local_config" : "repository_settings",
      baseSha: input.snapshot.baseSha,
      changedPaths,
      headSha: input.snapshot.headSha,
      pullRequestNumber: input.snapshot.pullRequestNumber,
      ...(trustedConfigSource ? { trustedConfigSource } : {}),
    },
  };

  return {
    schemaVersion: "repo_local_config_change_notice.v1",
    baseSha: input.snapshot.baseSha,
    changedFiles,
    headSha: input.snapshot.headSha,
    pullRequestNumber: input.snapshot.pullRequestNumber,
    ...(trustedConfigSource ? { trustedConfigSource } : {}),
    warning,
  };
}

/** Inserts an idempotent system audit row for one detected repo-local config change. */
async function recordRepoLocalConfigChangeAudit(
  db: HeimdallDatabase,
  input: {
    /** Product-safe config-change notice being audited. */
    readonly notice: RepoLocalConfigChangeNotice;
    /** Organization that owns the reviewed repository. */
    readonly orgId: string;
    /** Repository that owns the pull request. */
    readonly repoId: string;
    /** Review run that detected the config change. */
    readonly reviewRunId: string;
    /** Timestamp to store on the audit row. */
    readonly timestamp: string;
  },
): Promise<void> {
  await new SecurityAuditRepository(db).recordAuditLogIfAbsent({
    action: "repo_local_config.change_detected",
    actorType: "system",
    actorUserId: null,
    auditLogId: stableId("audit", ["repo_local_config.change_detected", input.reviewRunId]),
    metadata: {
      actor: { actorType: "system", source: "review_orchestrator" },
      notice: input.notice,
      repoId: input.repoId,
      reviewRunId: input.reviewRunId,
    },
    occurredAt: input.timestamp,
    orgId: input.orgId,
    resourceId: input.reviewRunId,
    resourceType: "review_run",
  });
}

/** Returns whether a changed file represents an allowed repo-local config path. */
function isRepoLocalConfigChangedFile(file: ChangedFile): boolean {
  return isRepoLocalConfigPath(file.path) || isRepoLocalConfigPath(file.oldPath);
}

/** Returns product-safe changed-file metadata for one repo-local config file. */
function repoLocalConfigChangedFileMetadata(file: ChangedFile): RepoLocalConfigChangedFile {
  return {
    additions: file.additions,
    deletions: file.deletions,
    ...(file.newContentHash ? { newContentHash: file.newContentHash } : {}),
    ...(file.oldContentHash ? { oldContentHash: file.oldContentHash } : {}),
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    path: file.path,
    status: file.status,
  };
}

/** Returns whether a repository path is an allowed repo-local config filename. */
function isRepoLocalConfigPath(path: string | undefined): boolean {
  return (
    path !== undefined &&
    REPO_LOCAL_CONFIG_ALLOWED_PATHS.some((allowedPath) => allowedPath === path)
  );
}

/** Returns stable unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Returns source metadata for a trusted repo-local config without copying file content. */
function trustedRepoLocalConfigSource(config: RepoLocalConfig): TrustedRepoLocalConfigSource {
  return {
    configVersion: config.configVersion,
    sourceCommitSha: config.sourceCommitSha,
    sourceHash: config.sourceHash,
    sourcePath: config.sourcePath,
  };
}

/** Builds the persisted policy artifact payload with orchestration-level warnings attached. */
function policySnapshotArtifactPayload(
  result: BuildReviewPolicySnapshotResult,
  warnings: readonly PolicyWarning[],
  repoLocalConfigChange: RepoLocalConfigChangeNotice | undefined,
): BuildReviewPolicySnapshotResult & {
  readonly repoLocalConfigChange?: RepoLocalConfigChangeNotice | undefined;
} {
  return {
    ...result,
    ...(repoLocalConfigChange ? { repoLocalConfigChange } : {}),
    warnings,
  };
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
  const repository = await new RepositoryRepository(db).getRepositoryProviderRef({
    installationId: input.installationId,
    provider: "github",
    repoId: input.repoId,
  });

  if (!repository) {
    throw new Error(`GitHub repository ${input.repoId} was not found.`);
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

/** Decides whether a fetched pull request snapshot can proceed to expensive review work. */
export function decideReviewGate(input: {
  /** Review job input that requested the run. */
  readonly input: Pick<ReviewPullRequestInput, "trigger">;
  /** Review orchestration dependencies used for rules telemetry. */
  readonly dependencies: Pick<
    ReviewOrchestratorDependencies,
    "metrics" | "traceContext" | "traces"
  >;
  /** Immutable policy snapshot compiled for the run. */
  readonly policySnapshot: ReviewPolicySnapshot;
  /** Live provider snapshot fetched for the run. */
  readonly snapshot: PullRequestSnapshot;
}): ReviewGateDecision {
  const action = reviewGateActionFromTrigger(input.input.trigger);
  if (input.snapshot.state !== "open") {
    return {
      action,
      reasonCode: "pull_request_not_open",
      reviewPolicy: input.policySnapshot.effectivePolicy.reviewPolicy,
      shouldReview: false,
    };
  }

  if (input.snapshot.changedFileCount === 0 || input.snapshot.changedFiles.length === 0) {
    return {
      action,
      reasonCode: "no_changed_files",
      reviewPolicy: input.policySnapshot.effectivePolicy.reviewPolicy,
      shouldReview: false,
    };
  }

  const decision = shouldReviewPr({
    action,
    authorLogin: input.snapshot.authorLogin,
    baseRef: input.snapshot.baseRef,
    isDraft: input.snapshot.isDraft,
    labels: input.snapshot.labels,
    ...(input.dependencies.metrics ? { metrics: input.dependencies.metrics } : {}),
    policy: input.policySnapshot.effectivePolicy,
    ...(input.dependencies.traceContext ? { traceContext: input.dependencies.traceContext } : {}),
    ...(input.dependencies.traces ? { traces: input.dependencies.traces } : {}),
  });

  return {
    action,
    reasonCode: decision.reasonCode,
    reviewPolicy: decision.reviewPolicy,
    shouldReview: decision.shouldReview,
    trace: decision.trace,
  };
}

/** Maps durable review triggers to the policy action used by the cheap review gate. */
export function reviewGateActionFromTrigger(trigger: ReviewTrigger): string {
  if (trigger === "webhook") {
    return "synchronize";
  }

  return "manual";
}

/** Builds a clear terminal review summary for one gate skip reason. */
export function reviewGateSkipSummary(reasonCode: string): string {
  switch (reasonCode) {
    case "pull_request_not_open":
      return "Review skipped because the pull request is no longer open.";
    case "no_changed_files":
      return "Review skipped because the pull request has no changed files.";
    case "draft_pr_skipped":
      return "Review skipped because the pull request is a draft.";
    case "missing_required_label":
      return "Review skipped because the pull request is missing the required review label.";
    case "blocked_label_present":
      return "Review skipped because the pull request has a blocked label.";
    case "author_excluded":
      return "Review skipped because the pull request author is excluded by policy.";
    case "repo_disabled":
    case "review_policy_disabled":
      return "Review skipped because repository review is disabled.";
    default:
      return `Review skipped by policy reason: ${reasonCode}.`;
  }
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

/** Returns whether review orchestration should run a base/head static-analysis delta. */
export function shouldRunBaseHeadStaticAnalysis(input: {
  /** Optional static-analysis mode selected for review orchestration. */
  readonly mode?: StaticAnalysisMode | undefined;
  /** Optional static-analysis runner selected for review orchestration. */
  readonly runner?: ToolRunner | undefined;
}): boolean {
  return input.mode === "base_head_delta" && input.runner !== undefined;
}

/** Builds the snapshot view used to plan a base-commit static-analysis run. */
export function createStaticAnalysisBaseSnapshotForReview(
  snapshot: PullRequestSnapshot,
): PullRequestSnapshot {
  const changedFiles = snapshot.changedFiles.filter((file) => file.status !== "added");

  return {
    ...snapshot,
    changedFileCount: changedFiles.length,
    changedFiles,
  };
}

/** Runs optional static analysis and records non-fatal stage events. */
async function runStaticAnalysisForReview(input: {
  /** Optional base workspace used for base/head diagnostic comparison. */
  readonly baselineWorkspace?: ReviewRepositoryWorkspace | undefined;
  /** Optional static-analysis budgets. */
  readonly budgets?: StaticAnalysisBudgets | undefined;
  /** Whether to remove the optional base workspace after static-analysis execution. */
  readonly cleanupBaselineWorkspace?: boolean | undefined;
  /** Whether to remove the retained workspace after static-analysis execution. */
  readonly cleanupWorkspace: boolean;
  /** Optional metric recorder used for static-analysis component telemetry. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
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
  /** Optional trace context propagated from the durable review job. */
  readonly traceContext?: TelemetryTraceContext | undefined;
  /** Optional span recorder used for static-analysis component telemetry. */
  readonly traces?: TelemetrySpanRecorder | undefined;
  /** Synced workspace for the review run. */
  readonly workspace: ReviewRepositoryWorkspace;
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
  const baseline = await runStaticAnalysisBaselineForReview(input);
  try {
    report = await runStaticAnalysis({
      ...(baseline ? { baselineDiagnosticsByTool: baseline.diagnosticsByTool } : {}),
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
      ...(input.metrics ? { metrics: input.metrics } : {}),
      runner: input.runner,
      ...(input.traceContext ? { traceContext: input.traceContext } : {}),
      ...(input.traces ? { traces: input.traces } : {}),
    });
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis",
      status: report.status,
      metadata: {
        diagnosticCount: report.summary.diagnosticCount,
        newDiagnosticCount: report.summary.newDiagnosticCount,
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
    workspaceCleanedUp = await cleanupStaticAnalysisWorkspaceForReview({
      reviewRepository: input.reviewRepository,
      reviewRunId: input.reviewRunId,
      stage: "workspace_cleanup",
      workspace: input.workspace,
    });
  }

  return {
    ...(baseline ? { baselineReport: baseline.report } : {}),
    ...(baseline ? { baselineWorkspaceCleanedUp: baseline.workspaceCleanedUp } : {}),
    report,
    workspaceCleanedUp,
  };
}

/** Runs the optional base-commit static-analysis pass for base/head comparison. */
async function runStaticAnalysisBaselineForReview(input: {
  /** Optional base workspace used for base/head diagnostic comparison. */
  readonly baselineWorkspace?: ReviewRepositoryWorkspace | undefined;
  /** Optional static-analysis budgets. */
  readonly budgets?: StaticAnalysisBudgets | undefined;
  /** Whether to remove the optional base workspace after static-analysis execution. */
  readonly cleanupBaselineWorkspace?: boolean | undefined;
  /** Optional metric recorder used for static-analysis component telemetry. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
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
  /** Static-analysis runner. */
  readonly runner?: ToolRunner | undefined;
  /** Pull request snapshot being reviewed. */
  readonly snapshot: PullRequestSnapshot;
  /** Optional trace context propagated from the durable review job. */
  readonly traceContext?: TelemetryTraceContext | undefined;
  /** Optional span recorder used for static-analysis component telemetry. */
  readonly traces?: TelemetrySpanRecorder | undefined;
}): Promise<ReviewStaticAnalysisBaselineResult | undefined> {
  if (input.mode !== "base_head_delta" || !input.runner || !input.baselineWorkspace) {
    return undefined;
  }

  let workspaceCleanedUp = input.baselineWorkspace.cleanedUp;
  if (input.baselineWorkspace.cleanedUp) {
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis_baseline",
      status: "skipped",
      metadata: { reason: "baseline_workspace_already_cleaned_up" },
    });
    return undefined;
  }

  try {
    const report = await runStaticAnalysis({
      request: createStaticAnalysisRequestForReview({
        budgets: input.budgets,
        mode: input.mode,
        orgId: input.orgId,
        repoId: input.repoId,
        reviewRunId: input.reviewRunId,
        snapshot: createStaticAnalysisBaseSnapshotForReview(input.snapshot),
        timestamp: input.now,
        workspace: input.baselineWorkspace,
      }),
      ...(input.metrics ? { metrics: input.metrics } : {}),
      runner: input.runner,
      ...(input.traceContext ? { traceContext: input.traceContext } : {}),
      ...(input.traces ? { traces: input.traces } : {}),
    });
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis_baseline",
      status: report.status,
      metadata: {
        diagnosticCount: report.summary.diagnosticCount,
        reportId: report.reportId,
        toolRunCount: report.summary.toolRunCount,
        warningCount: report.warnings.length,
      },
    });

    if (input.cleanupBaselineWorkspace) {
      workspaceCleanedUp = await cleanupStaticAnalysisWorkspaceForReview({
        reviewRepository: input.reviewRepository,
        reviewRunId: input.reviewRunId,
        stage: "static_analysis_baseline_workspace_cleanup",
        workspace: input.baselineWorkspace,
      });
    }

    return {
      diagnosticsByTool: staticAnalysisBaselineDiagnosticsByTool(report),
      report,
      workspaceCleanedUp,
    };
  } catch (error) {
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: "static_analysis_baseline",
      status: "degraded",
      message: error instanceof Error ? error.message : String(error),
    });

    if (input.cleanupBaselineWorkspace) {
      workspaceCleanedUp = await cleanupStaticAnalysisWorkspaceForReview({
        reviewRepository: input.reviewRepository,
        reviewRunId: input.reviewRunId,
        stage: "static_analysis_baseline_workspace_cleanup",
        workspace: input.baselineWorkspace,
      });
    }

    return undefined;
  }
}

/** Groups base diagnostics by tool while preserving tools that ran cleanly. */
function staticAnalysisBaselineDiagnosticsByTool(
  report: StaticAnalysisReport,
): Partial<Record<StaticToolName, readonly NormalizedToolDiagnostic[]>> {
  const diagnosticsByTool: Partial<Record<StaticToolName, readonly NormalizedToolDiagnostic[]>> =
    {};

  for (const toolRun of report.toolRuns) {
    diagnosticsByTool[toolRun.tool] = [];
  }

  for (const diagnostic of report.diagnostics) {
    diagnosticsByTool[diagnostic.tool] = [
      ...(diagnosticsByTool[diagnostic.tool] ?? []),
      diagnostic,
    ];
  }

  return diagnosticsByTool;
}

/** Removes a retained static-analysis workspace and records a stage event. */
async function cleanupStaticAnalysisWorkspaceForReview(input: {
  /** Review repository used for stage events. */
  readonly reviewRepository: ReviewRepository;
  /** Review run ID that owns the static-analysis workspace. */
  readonly reviewRunId: string;
  /** Stage name used for the cleanup event. */
  readonly stage: string;
  /** Workspace to remove. */
  readonly workspace: ReviewRepositoryWorkspace;
}): Promise<boolean> {
  try {
    if (input.workspace.release) {
      await input.workspace.release();
    } else {
      await cleanupRepositoryWorkspace(input.workspace.workspacePath);
    }
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: input.stage,
      status: "completed",
      metadata: { workspacePath: input.workspace.workspacePath },
    });

    return true;
  } catch (error) {
    await input.reviewRepository.insertStageEvent({
      reviewRunId: input.reviewRunId,
      stage: input.stage,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      metadata: { workspacePath: input.workspace.workspacePath },
    });

    return input.workspace.cleanedUp;
  }
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
  readonly policyWarnings: readonly PolicyWarning[];
  readonly repoLocalConfigChange?: RepoLocalConfigChangeNotice | undefined;
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
      dryRun: input.input.dryRun ?? false,
      jobBaseSha: input.input.baseSha,
      jobHeadSha: input.input.headSha,
      planSnapshot: planSnapshotMetadata(input.planSnapshot),
      ...(input.policyWarnings.length > 0 ? { policyWarnings: input.policyWarnings } : {}),
      ...(input.repoLocalConfigChange
        ? { repoLocalConfigChange: input.repoLocalConfigChange }
        : {}),
      policySnapshot: policySnapshotMetadata(input.policySnapshot),
    },
  };
}

/** Builds durable dashboard metrics from a terminal review run row. */
function reviewRunMetricsFromReviewRun(reviewRun: ReviewRun): ReviewRunMetricsInput {
  return {
    reviewRunId: reviewRun.reviewRunId,
    totalDurationMs: reviewRunTotalDurationMs(reviewRun),
    candidateFindings: reviewRun.counts.candidateFindings,
    validatedFindings: reviewRun.counts.validatedFindings,
    publishedFindings: reviewRun.counts.publishedFindings,
    rejectedFindings: reviewRun.counts.rejectedFindings,
  };
}

/** Returns total review duration in milliseconds when both timestamps are known. */
function reviewRunTotalDurationMs(reviewRun: ReviewRun): number | null {
  if (!reviewRun.startedAt || !reviewRun.completedAt) {
    return null;
  }
  const startedAtMs = Date.parse(reviewRun.startedAt);
  const completedAtMs = Date.parse(reviewRun.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return null;
  }

  return Math.max(0, completedAtMs - startedAtMs);
}

/** Returns compact policy metadata safe to store on review runs and traces. */
function policySnapshotMetadata(snapshot: ReviewPolicySnapshot): Record<string, unknown> {
  const decisionInputs = snapshot.decisionInputs;

  return {
    policyHash: snapshot.policyHash,
    policySnapshotId: snapshot.policySnapshotId,
    publishing: snapshot.effectivePolicy.publishing,
    ...(decisionInputs.repoLocalConfigSourcePath
      ? {
          repoLocalConfig: {
            configVersion: decisionInputs.repoLocalConfigVersion,
            sourceCommitSha: decisionInputs.repoLocalConfigSourceCommitSha,
            sourceHash: decisionInputs.repoLocalConfigSourceHash,
            sourcePath: decisionInputs.repoLocalConfigSourcePath,
          },
        }
      : {}),
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

/** Builds a product-safe retrieval trace artifact from a validated context bundle. */
export function buildRetrievalTraceArtifactPayload(input: {
  /** Context bundle returned by retrieval. */
  readonly contextBundle: ContextBundle;
  /** Timestamp when the trace artifact is generated. */
  readonly generatedAt: string;
}): RetrievalTraceArtifactPayload {
  const metadata = recordFromUnknown(input.contextBundle.metadata);
  const ranking = recordField(metadata, "ranking");
  const packing = recordField(metadata, "packing");
  const memory = recordField(metadata, "memory");
  const rules = recordField(metadata, "rules");
  const indexVersionId = stringField(metadata, "indexVersionId");
  const retrievalMode = stringField(metadata, "retrievalMode");

  return {
    budget: {
      estimatedTokens: input.contextBundle.tokenBudget.estimatedTokens,
      maxTokens: input.contextBundle.tokenBudget.maxTokens,
      ...(packing ? { packing } : {}),
    },
    changeAnalysis: {
      changedFileCount: input.contextBundle.changedFiles.length,
      changedFilesByLanguage: countByString(
        input.contextBundle.changedFiles.map((file) => file.language),
      ),
      changedFilesByStatus: countByString(
        input.contextBundle.changedFiles.map((file) => file.status),
      ),
      changedSymbolCount: input.contextBundle.changedSymbols.length,
    },
    completedAt: input.generatedAt,
    inputSummary: {
      baseSha: input.contextBundle.baseSha,
      headSha: input.contextBundle.headSha,
      pullRequestSnapshotId: input.contextBundle.pullRequestSnapshotId,
      ...(indexVersionId ? { indexVersionId } : {}),
      ...(retrievalMode ? { retrievalMode } : {}),
    },
    metadata: {
      ...(ranking ? { ranking } : {}),
      ...(packing ? { packing } : {}),
      ...(memory ? { memory } : {}),
      ...(rules ? { rules } : {}),
    },
    pullRequestSnapshotId: input.contextBundle.pullRequestSnapshotId,
    repoId: input.contextBundle.repoId,
    retrievalId: stableId("retr", [input.contextBundle.contextBundleId]),
    reviewRunId: input.contextBundle.reviewRunId,
    schemaVersion: "retrieval_trace.v1",
    selectedItems: input.contextBundle.items.map(retrievalTraceArtifactItem),
    startedAt: input.contextBundle.createdAt,
    warnings: unknownArrayField(metadata, "warnings"),
  };
}

/** Builds one product-safe selected item row for a retrieval trace artifact. */
function retrievalTraceArtifactItem(item: ContextItem): RetrievalTraceArtifactItem {
  return {
    contextItemId: item.contextItemId,
    kind: item.kind,
    ...(item.snippet ? { path: item.snippet.path, range: item.snippet.range } : {}),
    priority: item.priority,
    reason: item.provenance.reason,
    ...(item.provenance.relatedSymbolId
      ? { relatedSymbolId: item.provenance.relatedSymbolId }
      : {}),
    retriever: item.provenance.retriever,
    ...(item.score === undefined ? {} : { score: item.score }),
    source: item.source,
    ...(item.title ? { title: item.title } : {}),
    tokenEstimate: item.tokenEstimate,
  };
}

/** Counts string labels for product-safe aggregate trace summaries. */
function countByString(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

/** JSON object used inside durable publish plan payloads. */
type PublishPlanPayloadObject = Record<string, unknown>;

/** Durable publish-plan artifact payload shape. */
type ReviewPublishPlanArtifactPayload = {
  /** Artifact schema version. */
  readonly schemaVersion: "publish_plan.v1";
  /** Whether orchestration was requested as a non-mutating dry run. */
  readonly dryRun: boolean;
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
  /** Whether the review job requested a non-mutating dry run. */
  readonly dryRun: boolean;
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
    dryRun: input.dryRun,
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

/** Returns the publisher handoff skip reason for a completed review, when publishing is skipped. */
export function reviewPublishSkipReason(input: {
  /** Whether the review job requested a non-mutating dry run. */
  readonly dryRun: boolean;
  /** Whether the persisted publish plan has provider-visible operations. */
  readonly hasExternalWrites: boolean;
}): ReviewPublishSkipReason | undefined {
  if (input.dryRun) {
    return "dry_run";
  }

  if (!input.hasExternalWrites) {
    return "no_planned_publish_operations";
  }

  return undefined;
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
    readonly metadata?: Record<string, unknown> | undefined;
    readonly createdAt: string;
  },
): Promise<ReviewArtifactRef> {
  const redactionLevel = getReviewArtifactRedactionLevel(input.kind);
  const retention = reviewArtifactRetentionDecision(input.kind, input.createdAt);
  const retentionUntil = reviewArtifactRetentionUntil(retention, input.createdAt);
  const payloadRecord = await artifactPayloadStore.putJson({
    reviewRunId: input.reviewRunId,
    kind: input.kind,
    name: input.name,
    payload: input.payload,
    metadata: {
      redactionLevel,
      retentionClass: retention.retentionClass,
      retentionReason: retention.reason,
      retentionStorage: retention.storage,
      ...input.metadata,
      ...(retentionUntil ? { retentionUntil } : {}),
    },
  });
  const payloadDescriptor = reviewArtifactPayloadDescriptor(payloadRecord);
  const artifact: ReviewArtifactRef = {
    artifactId: stableId("art", [input.reviewRunId, input.kind, input.name, payloadRecord.hash]),
    kind: input.kind,
    uri: payloadRecord.uri,
    contentHash: payloadRecord.hash,
    byteSize: payloadRecord.sizeBytes,
    redactionLevel,
    createdAt: input.createdAt,
    metadata: {
      name: input.name,
      payloadStorage: payloadDescriptor,
      redactionLevel,
      retentionClass: retention.retentionClass,
      retentionReason: retention.reason,
      retentionStorage: retention.storage,
      ...input.metadata,
      ...(retentionUntil ? { retentionUntil } : {}),
    },
  };

  await repository.insertReviewArtifact({
    reviewRunId: input.reviewRunId,
    repoId: input.repoId,
    artifact,
    classification: reviewArtifactClassification(redactionLevel),
    name: input.name,
    sizeBytes: payloadRecord.sizeBytes,
    metadata: payloadRecord.metadata,
    ...(retentionUntil ? { retentionUntil } : {}),
  });

  return artifact;
}

/** Payload-free static-analysis report counters stored on artifact metadata. */
type StaticAnalysisArtifactSummary = {
  /** Metadata schema version. */
  readonly schemaVersion: "static_analysis_artifact_summary.v1";
  /** Static-analysis report ID. */
  readonly reportId: string;
  /** Static-analysis mode used for the report. */
  readonly mode: StaticAnalysisMode;
  /** Final static-analysis report status. */
  readonly status: StaticAnalysisReport["status"];
  /** Total static-analysis duration in milliseconds. */
  readonly durationMs: number;
  /** Planned tool run count. */
  readonly toolRunCount: number;
  /** Successful tool run count. */
  readonly succeededToolRunCount: number;
  /** Failed tool run count. */
  readonly failedToolRunCount: number;
  /** Timed-out tool run count. */
  readonly timedOutToolRunCount: number;
  /** Total normalized diagnostic count. */
  readonly diagnosticCount: number;
  /** Diagnostic count on changed lines. */
  readonly changedLineDiagnosticCount: number;
  /** Diagnostic count marked new by the analyzer. */
  readonly newDiagnosticCount: number;
  /** Error or critical diagnostic count. */
  readonly highSeverityDiagnosticCount: number;
  /** Product-safe warning count. */
  readonly warningCount: number;
};

/** Builds payload-free metadata for static-analysis artifact list/debug views. */
function staticAnalysisArtifactSummary(
  report: StaticAnalysisReport,
): StaticAnalysisArtifactSummary {
  return {
    changedLineDiagnosticCount: report.summary.changedLineDiagnosticCount,
    diagnosticCount: report.summary.diagnosticCount,
    durationMs: report.durationMs,
    failedToolRunCount: report.summary.failedToolRunCount,
    highSeverityDiagnosticCount: report.summary.highSeverityDiagnosticCount,
    mode: report.mode,
    newDiagnosticCount: report.summary.newDiagnosticCount,
    reportId: report.reportId,
    schemaVersion: "static_analysis_artifact_summary.v1",
    status: report.status,
    succeededToolRunCount: report.summary.succeededToolRunCount,
    timedOutToolRunCount: report.summary.timedOutToolRunCount,
    toolRunCount: report.summary.toolRunCount,
    warningCount: report.warnings.length,
  };
}

/** Resolves retention policy for one persisted review artifact kind. */
function reviewArtifactRetentionDecision(
  kind: ReviewArtifactKind,
  createdAt: string,
): RetentionDecision {
  return resolveArtifactRetention({
    artifactType: reviewArtifactRetentionType(kind),
    createdAt,
  });
}

/** Returns the security retention artifact type that maps to one review artifact kind. */
function reviewArtifactRetentionType(kind: ReviewArtifactKind): string {
  if (kind === "raw_diff") {
    return "raw_diff";
  }
  if (kind === "context_bundle") {
    return "context_bundle";
  }
  if (kind === "llm_prompt") {
    return "prompt_artifact";
  }
  if (kind === "llm_response") {
    return "llm_response_artifact";
  }
  if (kind === "static_analysis") {
    return "static_analysis_output";
  }

  return "review_summary";
}

/** Returns the payload cleanup timestamp for one retention decision. */
function reviewArtifactRetentionUntil(
  decision: RetentionDecision,
  createdAt: string,
): string | undefined {
  if (decision.storage === "disabled") {
    return createdAt;
  }

  return decision.expiresAt;
}

/** Storage classifications used by review artifact rows. */
type ReviewArtifactStorageClassification = "customer_confidential" | "customer_code";

/** Maps artifact redaction levels to persistent artifact data classifications. */
function reviewArtifactClassification(
  redactionLevel: ReviewArtifactRedactionLevel,
): ReviewArtifactStorageClassification {
  if (redactionLevel === "contains_code" || redactionLevel === "contains_prompt") {
    return "customer_code";
  }

  return "customer_confidential";
}

/** Creates the idempotent index job envelope used when a review reaches a missing index. */
export function createIndexDependencyJobEnvelope(input: {
  /** Commit SHA that must be indexed before richer retrieval can run. */
  readonly commitSha: string;
  /** GitHub installation used to clone the repository. */
  readonly installationId: string;
  /** Repository that owns the commit. */
  readonly repoId: string;
  /** Timestamp used for deterministic durable job creation. */
  readonly timestamp: string;
  /** Optional trace context propagated from the review job. */
  readonly traceContext?: TelemetryTraceContext | undefined;
}): JobEnvelope<IndexRepoCommitJobPayload> {
  const idempotencyKey = createIndexDependencyJobKey(input);
  return {
    jobId: stableId("job", [idempotencyKey]),
    jobType: JOB_TYPES.IndexRepoCommit,
    schemaVersion: "job_envelope.v1",
    idempotencyKey,
    createdAt: input.timestamp,
    attempt: 0,
    maxAttempts: 3,
    payload: {
      commitSha: input.commitSha,
      installationId: input.installationId,
      priority: "high",
      reason: "pr_review",
      repoId: input.repoId,
    },
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
  };
}

/** Creates the webhook-compatible idempotency key for review-owned index jobs. */
export function createIndexDependencyJobKey(input: {
  /** Commit SHA that must be indexed. */
  readonly commitSha: string;
  /** Repository that owns the commit. */
  readonly repoId: string;
}): string {
  return `github:index:${input.repoId}:${input.commitSha}`;
}

async function enqueueIndexDependencyJob(
  db: HeimdallDatabase,
  input: {
    readonly commitSha: string;
    readonly installationId: string;
    readonly repoId: string;
    readonly timestamp: string;
    readonly traceContext?: TelemetryTraceContext | undefined;
  },
): Promise<string> {
  const envelope = createIndexDependencyJobEnvelope(input);

  await new BackgroundJobRepository(db).insertBackgroundJob({
    backgroundJobId: envelope.jobId,
    queueName: "indexing",
    envelope,
    repoId: input.repoId,
  });

  return envelope.idempotencyKey;
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

  await new BackgroundJobRepository(db).insertBackgroundJob({
    backgroundJobId: envelope.jobId,
    queueName: "publishing",
    envelope,
    repoId: input.repoId,
    reviewRunId: input.reviewRunId,
  });

  return idempotencyKey;
}

function createPublishJobKey(reviewRunId: string): string {
  return `review.publish.v1:${reviewRunId}`;
}

/** Creates an LLM gateway wrapper that records call rows and token usage events. */
function createUsageRecordingLlmGateway(input: {
  /** Artifact payload store used to persist redacted LLM prompt/response payloads. */
  readonly artifactPayloadStore: ReviewArtifactPayloadStore;
  /** Database used to persist LLM call rows. */
  readonly db: HeimdallDatabase;
  /** Gateway that performs the actual model work. */
  readonly gateway: LLMGateway;
  /** Optional metric recorder used for LLM token and cost telemetry. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
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
  /** Review repository used to persist review artifact metadata. */
  readonly reviewRepository: ReviewRepository;
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
      const redactedRequest = redactLlmGatewayRequestPrompt(request);
      const output = await input.gateway.generateObject(redactedRequest);
      const completedAt = input.now().toISOString();
      await recordLlmUsage({
        ...input,
        completedAt,
        ...(redactedRequest.metadata ? { metadata: redactedRequest.metadata } : {}),
        output,
        prompt: redactedRequest.prompt,
        sequence: callSequence,
        startedAt,
        system: redactedRequest.system,
        task: redactedRequest.task,
      });
      return output;
    },
    generateReviewFindings: async (request) => {
      const callSequence = nextSequence();
      const startedAt = input.now().toISOString();
      const redactedRequest = redactReviewFindingPrompt({
        ...request,
        metadata: {
          ...(request.metadata ?? {}),
          promptVersion: REVIEW_FINDINGS_PROMPT_DEFINITION.promptVersion,
        },
      });
      const output = await input.gateway.generateReviewFindings(redactedRequest);
      const completedAt = input.now().toISOString();
      await recordLlmUsage({
        ...input,
        completedAt,
        ...(redactedRequest.metadata ? { metadata: redactedRequest.metadata } : {}),
        output,
        prompt: redactedRequest.prompt,
        sequence: callSequence,
        startedAt,
        system: REVIEW_FINDINGS_PROMPT_DEFINITION.system,
        task: REVIEW_FINDINGS_PROMPT_DEFINITION.task,
      });
      return output;
    },
  };
}

/** Redacts one generic LLM gateway request before provider execution and usage recording. */
function redactLlmGatewayRequestPrompt<
  TRequest extends {
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly prompt: string;
  },
>(request: TRequest): TRequest {
  const redaction = redactPromptSecrets(request.prompt);
  if (!redaction.redacted) {
    return request;
  }

  return {
    ...request,
    metadata: {
      ...(request.metadata ?? {}),
      promptRedacted: true,
      promptRedactionKinds: redaction.matchKinds,
      promptRedactionReplacementCount: redaction.replacementCount,
    },
    prompt: redaction.value,
  };
}

/** Redacts one review-finding prompt before provider execution and usage recording. */
function redactReviewFindingPrompt(
  request: Parameters<LLMGateway["generateReviewFindings"]>[0],
): Parameters<LLMGateway["generateReviewFindings"]>[0] {
  return redactLlmGatewayRequestPrompt(request);
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
  /** Optional metric recorder used for LLM token and cost telemetry. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Usage ledger used for durable token events. */
  readonly usageLedger: UsageLedger;
  /** Rate card used to estimate internal model cost. */
  readonly rateCard: LlmTokenRateCard;
  /** Artifact payload store used to persist redacted LLM prompt/response payloads. */
  readonly artifactPayloadStore: ReviewArtifactPayloadStore;
  /** Review repository used to persist review artifact metadata. */
  readonly reviewRepository: ReviewRepository;
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
  const promptVersion = stringMetadataValue(input.metadata, "promptVersion") ?? "unversioned";
  const estimate = estimateLlmTokenUsage({
    system: input.system,
    prompt: input.prompt,
    output: input.output,
    rateCard: input.rateCard,
  });
  const llmCallId = stableId("llm", [input.reviewRunId, input.sequence, input.task, promptHash]);
  const elapsedMs = Date.parse(input.completedAt) - Date.parse(input.startedAt);
  const latencyMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const artifactRefs = await persistLlmCallArtifacts({
    artifactPayloadStore: input.artifactPayloadStore,
    completedAt: input.completedAt,
    llmCallId,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    output: input.output,
    prompt: input.prompt,
    promptHash,
    promptVersion,
    repoId: input.repoId,
    responseHash,
    reviewRepository: input.reviewRepository,
    reviewRunId: input.reviewRunId,
    sequence: input.sequence,
    system: input.system,
    task: input.task,
  });

  await new LlmCallRepository(input.db).insertLlmCall({
    artifactLinks: artifactRefs.map((artifact) => ({
      artifactRole: artifact.kind === "llm_prompt" ? "prompt" : "response",
      llmCallId,
      reviewArtifactId: artifact.artifactId,
    })),
    call: {
      completedAt: input.completedAt,
      costMicros: estimate.costMicros,
      inputTokens: estimate.inputTokens,
      llmCallId,
      metadata: {
        artifactIds: artifactRefs.map((artifact) => artifact.artifactId),
        cachedInputTokens: estimate.cachedInputTokens,
        latencyMs,
        promptVersion,
        rateCardId: estimate.rateCardId,
        sequence: input.sequence,
        task: input.task,
        ...(input.metadata ? { requestMetadata: input.metadata } : {}),
      },
      model: estimate.model,
      orgId: input.orgId,
      outputTokens: estimate.outputTokens,
      promptHash,
      provider: estimate.provider,
      purpose: input.task,
      repoId: input.repoId,
      responseHash,
      reviewRunId: input.reviewRunId,
      startedAt: input.startedAt,
      status: "succeeded",
    },
  });

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
      promptVersion,
      rateCardId: estimate.rateCardId,
      responseHash,
      task: input.task,
    },
  });

  recordLlmUsageTelemetry(input.metrics, {
    costMicros: estimate.costMicros,
    inputTokens: estimate.inputTokens,
    modelProfile:
      stringMetadataValue(input.metadata, "modelProfile") ??
      stringMetadataValue(input.metadata, "model_profile"),
    outputTokens: estimate.outputTokens,
    provider: estimate.provider,
    task: input.task,
  });
}

/** Persists redacted prompt and response artifacts for a successful LLM call. */
async function persistLlmCallArtifacts(input: {
  /** Artifact payload store used to persist LLM payloads. */
  readonly artifactPayloadStore: ReviewArtifactPayloadStore;
  /** Call completion timestamp. */
  readonly completedAt: string;
  /** Stable LLM call ID. */
  readonly llmCallId: string;
  /** Optional caller metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Structured model output after gateway validation. */
  readonly output: unknown;
  /** Secret-redacted user prompt sent to the gateway. */
  readonly prompt: string;
  /** Hash of the redacted prompt payload. */
  readonly promptHash: string;
  /** Stable prompt version used by the call. */
  readonly promptVersion: string;
  /** Repository that owns the review. */
  readonly repoId: string;
  /** Hash of the structured model output. */
  readonly responseHash: string;
  /** Review repository used to persist artifact metadata. */
  readonly reviewRepository: ReviewRepository;
  /** Review run that caused the model call. */
  readonly reviewRunId: string;
  /** One-based call sequence within the review run. */
  readonly sequence: number;
  /** System prompt sent to the gateway. */
  readonly system: string;
  /** LLM task label. */
  readonly task: string;
}): Promise<readonly ReviewArtifactRef[]> {
  const common = {
    llmCallId: input.llmCallId,
    promptVersion: input.promptVersion,
    sequence: input.sequence,
    task: input.task,
  };

  const [promptArtifact, responseArtifact] = await Promise.all([
    persistArtifact(input.reviewRepository, input.artifactPayloadStore, {
      createdAt: input.completedAt,
      kind: "llm_prompt",
      name: `llm-call-${input.sequence}-${input.task}-prompt`,
      payload: {
        ...common,
        metadata: input.metadata ?? {},
        prompt: input.prompt,
        promptHash: input.promptHash,
        system: input.system,
      },
      repoId: input.repoId,
      reviewRunId: input.reviewRunId,
    }),
    persistArtifact(input.reviewRepository, input.artifactPayloadStore, {
      createdAt: input.completedAt,
      kind: "llm_response",
      name: `llm-call-${input.sequence}-${input.task}-response`,
      payload: {
        ...common,
        output: input.output,
        responseHash: input.responseHash,
      },
      repoId: input.repoId,
      reviewRunId: input.reviewRunId,
    }),
  ]);

  return [promptArtifact, responseArtifact];
}

/** Returns a string metadata value by key when present. */
function stringMetadataValue(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalizes one review telemetry label to a bounded low-cardinality value. */
function normalizeReviewTelemetryLabel(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);

  return normalized && normalized.length > 0 ? normalized : fallback;
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
