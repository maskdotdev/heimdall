import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectAccessReviewEvidence,
  collectAuditLogEvidence,
  collectConfigSnapshotEvidence,
  collectSecurityEventEvidence,
  createFilesystemComplianceEvidenceArtifactStore,
} from "@repo/admin-tools";
import {
  createReviewArtifactPayloadStoreFromEnvironment,
  InlineReviewArtifactPayloadStore,
  type ReviewArtifactPayloadStore,
  reviewArtifactPayloadDeletedMetadata,
} from "@repo/artifacts";
import {
  type BillingProvider,
  type BillingProviderRequestLogger,
  type BillingProviderRequestLogInput,
  FakeBillingProvider,
  StripeBillingProvider,
} from "@repo/billing";
import { type IndexerConfig, loadIndexerConfig, loadRuntimeConfig } from "@repo/config";
import {
  type BillingReconcileJobPayload,
  type ComplianceEvidenceCollectJobPayload,
  ComplianceEvidenceCollectJobPayloadSchema,
  type DataDeletionManifest,
  DataDeletionManifestSchema,
  type DataDeletionPlanJobPayload,
  DataDeletionPlanJobPayloadSchema,
  type EmbeddingBatchJobPayload,
  type EmbeddingRepairJobPayload,
  type IndexRepoCommitJobPayload,
  JOB_TYPES,
  type JobEnvelope,
  type JobPayload,
  type LLMFindingOutput,
  type PublishReviewJobPayload,
  parseWithSchema,
  type ReviewArtifactCleanupJobPayload,
  ReviewArtifactCleanupJobPayloadSchema,
  type ReviewPullRequestJobPayload,
  type ReviewTrigger,
  type SandboxCleanupJobPayload,
  SandboxCleanupJobPayloadSchema,
  type SyncInstallationJobPayload,
  type UpdateMemoryJobPayload,
} from "@repo/contracts";
import {
  BackgroundJobRepository,
  BillingRepository,
  type CreateFeedbackEventInput,
  type CreateFeedbackSignalInput,
  type CreateMemoryCandidateInput,
  createDatabaseClient,
  DataDeletionRepository,
  FeedbackRepository,
  type FindingOutcomeRecord,
  type HeimdallDatabase,
  MemoryCandidateRepository,
  ProviderInstallationRepository,
  type PublishedFindingFeedbackTargetRecord,
  type PublishedSummaryFeedbackTargetRecord,
  QueueHealthRepository,
  type RecordSecurityEventInput,
  RepositoryRepository,
  ReviewRepository,
  type SandboxArtifactInsert,
  type SandboxPolicyDecisionInsert,
  SandboxRepository,
  type SandboxRunInsert,
  SecurityAuditRepository,
} from "@repo/db";
import {
  createEmbeddingProviderFromEnvironment,
  createOpenAIEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingTokenRateCard,
  embedChunkBatch,
  type OpenAIEmbeddingsFetch,
  reconcileEmbeddingJob,
  repairEmbeddingJobs,
} from "@repo/embedding";
import {
  createGitHubProvider,
  type ExistingReviewThreadState,
  type GitHubInstallationRef,
  type GitHubRepositoryRef,
  type GitProvider,
} from "@repo/github";
import {
  createIndexArtifactResolverFromEnvironment,
  createIndexArtifactStoreFromEnvironment,
  createIndexImportLimitsFromEnvironment,
  createIndexImportRecordBatchSizeFromEnvironment,
  type IndexArtifactResolver,
  type IndexArtifactStore,
  importIndexArtifact,
  importIndexArtifactFromUri,
  reconcileStaleIndexImports,
} from "@repo/index-importer";
import type { IndexArtifact } from "@repo/index-schema";
import {
  assertIndexerSupportsCurrentArtifactSchema,
  type CodeIndexerDriver,
  createCliIndexerDriver,
  createFakeIndexerDriver,
  createRemoteIndexerDriver,
  type IndexerCapabilities,
  withIndexerTelemetry,
  withIndexerTimeout,
} from "@repo/indexer-driver";
import { createTypeScriptIndexerDriver } from "@repo/indexer-ts";
import {
  createLLMGateway,
  createOpenAIChatCompletionsProvider,
  type LLMGateway,
  type LLMGatewayBudgetPolicy,
  type LLMProvider,
  type OpenAIChatCompletionsFetch,
  REVIEW_FINDINGS_MODEL_PROFILE,
} from "@repo/llm-gateway";
import {
  classifyFeedbackEvent,
  createMemoryCandidatesFromCommand,
  type FeedbackCommand,
  type FeedbackEvent,
  type FeedbackEventKind,
  type FeedbackSignal,
  type MemoryAppliesTo,
  MemoryAppliesToSchema,
  type MemoryCandidate,
  type MemoryScope,
  MemoryScopeSchema,
  type MemoryTelemetryOptions,
} from "@repo/memory";
import {
  createObservabilityRuntime,
  OBSERVABILITY_METRIC_NAMES,
  type StructuredTelemetryLogger,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import {
  normalizePublishThrottleLimits,
  PUBLISH_THROTTLE_HOUR_WINDOW_MS,
  PUBLISH_THROTTLE_MINUTE_WINDOW_MS,
  type PublishOperationType,
  type PublishThrottle,
  type PublishThrottleLimitReason,
  type PublishThrottleLimits,
  type PublishThrottleSlotInput,
  publishReviewRun,
} from "@repo/publisher";
import {
  BullMqQueueProducer,
  createDurableJobProcessor,
  DrizzleDurableJobStore,
  type DurableJobHandlerContext,
  type DurableJobHandlerMap,
  dispatchPendingJobs,
  QUEUE_NAMES,
  type QueueName,
} from "@repo/queue";
import {
  type AcquireRepositoryWorkspaceDependencies,
  acquireRepositoryWorkspace,
  type CleanupExpiredRepositoryWorktreesInput,
  type CleanupExpiredRepositoryWorktreesResult,
  cleanupExpiredRepositoryWorktrees,
  createRepoSyncConfig,
  type RepoSyncConfig,
} from "@repo/repo-sync";
import { type ReviewIndexDependencyMode, runPullRequestReview } from "@repo/review-orchestrator";
import {
  createDockerContainerSandboxRunner,
  createFakeSandboxRunner,
  createGVisorSandboxRunner,
  createLocalProcessSandboxRunner,
  type DockerContainerSandboxRunnerOptions,
  type SandboxRunner,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxTelemetryOptions,
  withSandboxTelemetry,
} from "@repo/sandbox";
import {
  createLocalEnvSecretsManager,
  parseSecretRef,
  recordSecurityEvent,
  type SecretsManager,
  type SecurityEvent,
  type SecurityEventSink,
} from "@repo/security";
import { createSandboxToolRunner, type ToolRunner } from "@repo/tool-runner";
import { PostgresUsageLedgerStore, reconcileBillingState, UsageLedger } from "@repo/usage";
import { Queue as BullMqQueue, Worker } from "bullmq";
import IORedis from "ioredis";

/** Default durable artifact directory used when INDEX_ARTIFACT_ROOT is unset. */
const DEFAULT_INDEX_ARTIFACT_ROOT = ".heimdall/index-artifacts";
/** Default maximum time allowed for one indexer run. */
const DEFAULT_INDEXER_TIMEOUT_MS = 120_000;
/** Default age after which a running durable job is considered stale. */
const DEFAULT_STALE_RUNNING_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
/** Default delay between stale running job recovery passes. */
const DEFAULT_STALE_RUNNING_JOB_RECOVERY_INTERVAL_MS = 60_000;
/** Default stale running rows repaired by one worker maintenance pass. */
const DEFAULT_STALE_RUNNING_JOB_RECOVERY_BATCH_SIZE = 100;
/** Default age after which an index import batch is considered stale. */
const DEFAULT_STALE_INDEX_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
/** Default stale index import batches repaired by one worker maintenance pass. */
const DEFAULT_STALE_INDEX_IMPORT_RECOVERY_BATCH_SIZE = 50;
/** Default filesystem root for scheduled compliance evidence artifacts. */
const DEFAULT_COMPLIANCE_EVIDENCE_ARTIFACT_ROOT = ".heimdall/compliance-evidence";
/** Default delay between scheduled compliance evidence enqueue attempts. */
const DEFAULT_COMPLIANCE_EVIDENCE_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Default row limit used by scheduled compliance evidence exports. */
const DEFAULT_COMPLIANCE_EVIDENCE_SCHEDULER_LIMIT = 100;
/** Default actor label for scheduled compliance evidence jobs. */
const DEFAULT_COMPLIANCE_EVIDENCE_SCHEDULER_ACTOR = "worker:scheduled_compliance_evidence";
/** Default delay between scheduled retention cleanup enqueue attempts. */
const DEFAULT_RETENTION_CLEANUP_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Default row limit used by scheduled retention cleanup jobs. */
const DEFAULT_RETENTION_CLEANUP_SCHEDULER_LIMIT = 100;
/** Default sandbox run age cleaned up by scheduled retention jobs. */
const DEFAULT_SANDBOX_RETENTION_CLEANUP_OLDER_THAN_DAYS = 30;
/** Default delay between queue health metric samples. */
const DEFAULT_QUEUE_METRICS_INTERVAL_MS = 30_000;
/** URI prefix used after retention cleanup removes review artifact payload bytes. */
const DELETED_REVIEW_ARTIFACT_URI_PREFIX = "deleted://review_artifacts/";
/** Maximum review artifact payloads tombstoned per data-deletion batch. */
const DATA_DELETION_REVIEW_ARTIFACT_BATCH_SIZE = 250;
/** Maximum review artifact batches processed by one data-deletion job. */
const DATA_DELETION_REVIEW_ARTIFACT_MAX_BATCHES = 40;
/** Maximum sandbox runs deleted per repository during one data-deletion job. */
const DATA_DELETION_SANDBOX_RUN_LIMIT = 1_000;
/** Maximum chunk IDs placed in one repair-triggered embedding batch. */
const EMBEDDING_REPAIR_BATCH_SIZE = 128;
/** Maximum completed review runs inspected by one scheduled thread reconciliation job. */
const THREAD_RECONCILIATION_REVIEW_RUN_LIMIT = 10;
/** Worker queues registered when the runtime is started in all-role mode. */
const ALL_WORKER_QUEUE_NAMES = [
  QUEUE_NAMES.repoSync,
  QUEUE_NAMES.indexing,
  QUEUE_NAMES.embedding,
  QUEUE_NAMES.review,
  QUEUE_NAMES.memory,
  QUEUE_NAMES.publishing,
  QUEUE_NAMES.billing,
  QUEUE_NAMES.security,
] as const satisfies readonly QueueName[];
/** BullMQ statuses that contribute queue depth gauges. */
const WORKER_QUEUE_METRIC_STATUSES = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
] as const satisfies readonly WorkerQueueMetricStatus[];
/** BullMQ statuses considered pending when estimating oldest job age. */
const WORKER_QUEUE_OLDEST_JOB_STATUSES = [
  "waiting",
  "delayed",
] as const satisfies readonly WorkerQueueOldestJobStatus[];

/** Worker role names accepted by runtime queue selection. */
export type WorkerRuntimeRole =
  | "all"
  | "repo-sync"
  | "indexing"
  | "embedding"
  | "review"
  | "memory"
  | "publishing"
  | "billing"
  | "security"
  | "maintenance";

/** Environment values used to select worker runtime queue roles. */
export type WorkerRuntimeRoleEnvironment = Readonly<Record<string, string | undefined>>;

/** Environment map used by worker runtime secret resolution. */
type WorkerSecretEnvironment = Readonly<Record<string, string | undefined>>;

/** GitHub installation row shape required by worker handlers. */
type GitHubInstallationRuntimeRef = GitHubInstallationRef & {
  /** GitHub numeric installation ID. */
  readonly providerInstallationId: string;
  /** Heimdall organization ID that owns the installation. */
  readonly orgId: string;
};

/** Input used by the worker to acquire an index workspace. */
export type WorkerRepositoryWorkspaceAcquireInput = {
  /** Repository provider reference loaded from the database. */
  readonly repository: GitHubRepositoryRef;
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Exact commit SHA to make available on disk. */
  readonly commitSha: string;
  /** Git provider used to resolve short-lived clone credentials. */
  readonly gitProvider: GitProvider;
  /** Repo-sync cache/runtime configuration. */
  readonly repoSyncConfig: RepoSyncConfig;
};

/** Leased workspace shape consumed by the worker index job. */
export type WorkerRepositoryWorkspaceLease = {
  /** Repo-sync worktree lease ID used for product-safe job traceability. */
  readonly leaseId: string;
  /** Checked-out workspace path passed to the indexer. */
  readonly workspacePath: string;
  /** Releases the workspace lease. */
  readonly release: () => Promise<void>;
};

/** Worker index-job workspace acquisition boundary. */
export type WorkerRepositoryWorkspaceAcquirer = (
  input: WorkerRepositoryWorkspaceAcquireInput,
) => Promise<WorkerRepositoryWorkspaceLease>;

/** Worker-level repo-sync cleanup runner used by startup maintenance. */
export type WorkerRepoSyncCleanupRunner = (
  input: CleanupExpiredRepositoryWorktreesInput,
) => Promise<CleanupExpiredRepositoryWorktreesResult>;

/** Input used by worker startup repo-sync cleanup. */
export type WorkerRepoSyncStartupCleanupInput = {
  /** Environment values used to parse cleanup settings. */
  readonly env: WorkerSecretEnvironment;
  /** Optional structured logger for startup cleanup summaries. */
  readonly logger?: StructuredTelemetryLogger;
  /** Repo-sync cache/runtime configuration. */
  readonly repoSyncConfig: RepoSyncConfig;
  /** Optional cleanup runner for tests. */
  readonly cleanupExpiredWorktrees?: WorkerRepoSyncCleanupRunner;
};

/** Options used to create worker job handlers. */
export type CreateWorkerHandlersOptions = {
  /** Database used to resolve durable job payload IDs. */
  readonly db: HeimdallDatabase;
  /** Optional billing provider used by billing reconciliation jobs. */
  readonly billingProvider?: BillingProvider;
  /** Optional test hook for billing reconciliation jobs. */
  readonly billingReconciler?: (payload: BillingReconcileJobPayload) => Promise<void>;
  /** Optional test hook for data-deletion planning jobs. */
  readonly dataDeletionPlanner?: (payload: DataDeletionPlanJobPayload) => Promise<void>;
  /** Optional sink used to record worker-originated security events. */
  readonly securityEventSink?: SecurityEventSink;
  /** Optional test hook for embedding repair jobs. */
  readonly embeddingRepairer?: (payload: EmbeddingRepairJobPayload) => Promise<void>;
  /** Optional test hook for sandbox cleanup jobs. */
  readonly sandboxCleaner?: (payload: SandboxCleanupJobPayload) => Promise<void>;
  /** Optional test hook for review artifact cleanup jobs. */
  readonly reviewArtifactCleaner?: (payload: ReviewArtifactCleanupJobPayload) => Promise<void>;
  /** Optional test hook for compliance evidence collection jobs. */
  readonly complianceEvidenceCollector?: (
    payload: ComplianceEvidenceCollectJobPayload,
  ) => Promise<void>;
  /** Git provider used by repo sync handlers. */
  readonly gitProvider: GitProvider;
  /** Optional embedding provider used by embedding jobs. */
  readonly embeddingProvider?: EmbeddingProvider;
  /** Optional token rate card used to estimate embedding provider costs. */
  readonly embeddingUsageRateCard?: EmbeddingTokenRateCard;
  /** Optional model gateway used by review jobs. */
  readonly llmGateway?: LLMGateway;
  /** Optional static-analysis runner used by review jobs. */
  readonly staticAnalysisRunner?: ToolRunner;
  /** Optional missing-index behavior for review orchestration. */
  readonly reviewIndexDependencyMode?: ReviewIndexDependencyMode;
  /** Optional review artifact payload store used by review orchestration. */
  readonly artifactPayloadStore?: ReviewArtifactPayloadStore;
  /** Optional shared throttle for provider-visible publisher writes. */
  readonly publishThrottle?: PublishThrottle;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
  /** Optional repo-sync configuration used by cached workspace acquisition. */
  readonly repoSyncConfig?: RepoSyncConfig;
  /** Optional test hook for index-job workspace acquisition. */
  readonly workspaceAcquirer?: WorkerRepositoryWorkspaceAcquirer;
  /** Durable directory used to store imported index artifacts before workspace cleanup. */
  readonly indexArtifactRoot?: string;
  /** Index artifact upload mode selected by runtime configuration. */
  readonly indexArtifactUploadMode?: IndexerConfig["artifactUploadMode"];
  /** Optional object-storage writer used for durable index artifact URI handoff. */
  readonly indexArtifactStore?: IndexArtifactStore;
  /** Optional resolver used when importing index artifacts from durable URIs. */
  readonly indexArtifactResolver?: IndexArtifactResolver;
  /** Optional normalized record batch size for index import database writes. */
  readonly indexImportRecordBatchSize?: number;
  /** Optional indexer driver selected by runtime configuration or tests. */
  readonly indexerDriver?: CodeIndexerDriver;
  /** Maximum time allowed for one indexer run. */
  readonly indexerTimeoutMs?: number;
  /** Optional metric recorder passed into review-adjacent component instrumentation. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional span recorder passed into review orchestration. */
  readonly traces?: TelemetrySpanRecorder;
  /** Optional structured logger passed into review orchestration. */
  readonly logger?: StructuredTelemetryLogger;
  /** Optional usage ledger shared by review and embedding jobs. */
  readonly usageLedger?: UsageLedger;
};

/** Environment values used to select the worker indexer driver. */
export type WorkerIndexerDriverEnvironment = Readonly<Record<string, string | undefined>>;

/** Environment values used to select the worker static-analysis runner. */
export type WorkerStaticAnalysisRunnerEnvironment = Readonly<Record<string, string | undefined>>;

/** Environment values used to select the worker LLM gateway. */
export type WorkerLlmGatewayEnvironment = Readonly<Record<string, string | undefined>>;

/** Environment values used to select review index dependency behavior. */
export type WorkerReviewIndexDependencyEnvironment = Readonly<Record<string, string | undefined>>;

/** Environment values used to select the worker embedding provider. */
export type WorkerEmbeddingProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Worker queue maintenance settings derived from environment values. */
type WorkerQueueMaintenanceConfig = {
  /** Maximum stale index import batches to mark failed in one pass. */
  readonly indexImportRecoveryBatchSize: number;
  /** Import duration after which an index import batch is considered stale. */
  readonly indexImportStaleTimeoutMs: number;
  /** Milliseconds between queue health metric samples. */
  readonly metricsIntervalMs: number;
  /** Maximum stale running rows to repair in one pass. */
  readonly recoveryBatchSize: number;
  /** Milliseconds between stale running recovery passes. */
  readonly recoveryIntervalMs: number;
  /** Running duration after which a durable job is considered stale. */
  readonly staleRunningTimeoutMs: number;
};

/** Worker-level settings for recurring compliance evidence collection. */
export type WorkerComplianceEvidenceSchedulerConfig = {
  /** Filesystem root where collection jobs write product-safe evidence artifacts. */
  readonly artifactRootDir: string;
  /** Actor label stamped onto scheduled evidence rows. */
  readonly collectedBy: string;
  /** Whether this scheduler should enqueue recurring collection jobs. */
  readonly enabled: boolean;
  /** Milliseconds represented by one idempotent scheduler bucket. */
  readonly intervalMs: number;
  /** Maximum rows each export collector should inspect. */
  readonly limit: number;
  /** Optional organization scope for evidence collection. */
  readonly orgId?: string | undefined;
  /** Evidence collection target requested by the scheduler. */
  readonly target: ComplianceEvidenceCollectJobPayload["target"];
};

/** Result returned after one scheduled compliance evidence enqueue attempt. */
export type EnqueueScheduledComplianceEvidenceCollectionResult = {
  /** Durable background job row ID for the collection job. */
  readonly backgroundJobId: string;
  /** Whether this call inserted a new durable job row. */
  readonly inserted: boolean;
  /** Idempotency key used for the scheduled collection job. */
  readonly jobKey: string;
  /** ISO timestamp for the scheduler bucket represented by the job. */
  readonly scheduledFor: string;
};

/** Worker-level settings for recurring retention cleanup jobs. */
export type WorkerRetentionCleanupSchedulerConfig = {
  /** Whether this scheduler should enqueue recurring retention cleanup jobs. */
  readonly enabled: boolean;
  /** Whether scheduled cleanup jobs should only plan work. */
  readonly dryRun: boolean;
  /** Milliseconds represented by one idempotent scheduler bucket. */
  readonly intervalMs: number;
  /** Maximum rows each cleanup job should inspect. */
  readonly limit: number;
  /** Minimum sandbox run age selected by scheduled sandbox cleanup. */
  readonly sandboxOlderThanDays: number;
};

/** One durable cleanup job created by the retention scheduler. */
export type EnqueuedScheduledRetentionCleanupJob = {
  /** Durable background job row ID for the cleanup job. */
  readonly backgroundJobId: string;
  /** Whether this call inserted a new durable job row. */
  readonly inserted: boolean;
  /** Idempotency key used for the scheduled cleanup job. */
  readonly jobKey: string;
  /** Contract job type that will execute cleanup. */
  readonly jobType: typeof JOB_TYPES.SandboxCleanup | typeof JOB_TYPES.ReviewArtifactCleanup;
};

/** Result returned after one scheduled retention cleanup enqueue attempt. */
export type EnqueueScheduledRetentionCleanupJobsResult = {
  /** Number of cleanup jobs inserted during this attempt. */
  readonly insertedCount: number;
  /** Durable cleanup jobs represented by this schedule bucket. */
  readonly jobs: readonly EnqueuedScheduledRetentionCleanupJob[];
  /** ISO timestamp for the scheduler bucket represented by the jobs. */
  readonly scheduledFor: string;
};

/** Runtime dependencies used while creating a worker static-analysis runner. */
export type WorkerStaticAnalysisRunnerOptions = {
  /** Optional database used to persist sandbox run results. */
  readonly db?: HeimdallDatabase | undefined;
  /** Optional metric recorder used for sandbox run telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional span recorder used for sandbox run telemetry. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Runtime dependencies used while creating a worker LLM gateway. */
export type WorkerLlmGatewayOptions = {
  /** Optional fetch implementation used by provider adapters. */
  readonly fetch?: OpenAIChatCompletionsFetch;
  /** Optional metric recorder used for LLM gateway telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional secrets manager used to resolve provider API keys. */
  readonly secretsManager?: SecretsManager;
  /** Optional span recorder used for LLM gateway telemetry. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Runtime dependencies used while creating a worker embedding provider. */
export type WorkerEmbeddingProviderOptions = {
  /** Optional fetch implementation used by provider adapters. */
  readonly fetch?: OpenAIEmbeddingsFetch;
  /** Model requested by the queued embedding job. */
  readonly model?: string;
  /** Optional secrets manager used to resolve provider API keys. */
  readonly secretsManager?: SecretsManager;
};

/** Runtime handle returned by the worker process bootstrap. */
export type WorkerRuntime = {
  /** Structured logger owned by the worker observability runtime. */
  readonly logger: StructuredTelemetryLogger;
  /** Stops workers, dispatcher resources, Redis, and database connections. */
  readonly close: () => Promise<void>;
};

/** BullMQ statuses sampled by worker queue health metrics. */
export type WorkerQueueMetricStatus = "waiting" | "delayed" | "active" | "completed" | "failed";

/** BullMQ statuses inspected to estimate oldest pending queue age. */
export type WorkerQueueOldestJobStatus = "waiting" | "delayed";

/** Minimal job record needed to derive queue age metrics. */
export type WorkerQueueMetricJob = {
  /** BullMQ job creation timestamp in milliseconds since Unix epoch. */
  readonly timestamp?: number | undefined;
};

/** One normalized queue health snapshot produced by worker sampling. */
export type WorkerQueueMetricSnapshot = {
  /** Logical Heimdall queue name represented by this sample. */
  readonly queueName: QueueName;
  /** Number of jobs currently waiting. */
  readonly waitingCount: number;
  /** Number of delayed jobs currently scheduled. */
  readonly delayedCount: number;
  /** Number of active jobs currently running. */
  readonly activeCount: number;
  /** Number of completed jobs retained by the queue backend. */
  readonly completedCount: number;
  /** Number of failed jobs retained by the queue backend. */
  readonly failedCount: number;
  /** Age of the oldest waiting or delayed job in milliseconds. */
  readonly oldestWaitingAgeMs: number;
  /** Time when the queue backend was sampled. */
  readonly sampledAt: Date;
};

/** Durable store used to retain queue health samples for dashboards. */
export type WorkerQueueMetricSnapshotStore = {
  /** Persists one or more queue health snapshots. */
  readonly recordQueueHealthSnapshots: (input: {
    /** Queue health snapshots to append. */
    readonly snapshots: readonly WorkerQueueMetricSnapshot[];
  }) => Promise<unknown>;
};

/** Queue client boundary used by worker queue metric sampling. */
export type WorkerQueueMetricsClient = {
  /** Logical Heimdall queue name represented by this client. */
  readonly queueName: QueueName;
  /** Closes queue resources when the worker runtime stops. */
  readonly close?: (() => Promise<void>) | undefined;
  /** Reads current BullMQ counts for selected statuses. */
  readonly getJobCounts: (
    ...statuses: WorkerQueueMetricStatus[]
  ) => Promise<Readonly<Record<string, number>>>;
  /** Reads jobs for selected statuses and range. */
  readonly getJobs: (
    statuses: readonly WorkerQueueOldestJobStatus[],
    start: number,
    end: number,
    asc: boolean,
  ) => Promise<readonly WorkerQueueMetricJob[]>;
};

/** Input used when recording worker queue health metrics. */
export type RecordWorkerQueueMetricsInput = {
  /** Metric recorder receiving queue depth and age gauges. */
  readonly metrics: TelemetryMetricRecorder;
  /** Queue clients to sample. */
  readonly queues: readonly WorkerQueueMetricsClient[];
  /** Optional store receiving durable queue health snapshots. */
  readonly snapshotStore?: WorkerQueueMetricSnapshotStore | undefined;
  /** Current time used by deterministic tests. */
  readonly now?: Date;
};

/** Redis commands required by the cross-process publisher throttle. */
export type RedisPublishThrottleClient = {
  /** Runs the atomic throttle reservation script. */
  readonly eval: (
    script: string,
    keyCount: number,
    ...args: readonly (string | number)[]
  ) => Promise<unknown>;
};

/** Options used to create a Redis-backed publisher throttle. */
export type CreateRedisPublishThrottleOptions = {
  /** Optional limit overrides. */
  readonly limits?: Partial<PublishThrottleLimits>;
  /** Optional clock for deterministic tests. */
  readonly now?: () => Date;
  /** Optional sleep implementation for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional Redis key prefix. */
  readonly keyPrefix?: string;
  /** Optional member ID generator for deterministic tests. */
  readonly randomId?: () => string;
};

/** One Redis sorted-set scope used for a publish throttle window. */
type RedisPublishThrottleScope = {
  /** Redis key storing recent reservations for the scope. */
  readonly key: string;
  /** Maximum reservations allowed inside the window. */
  readonly limit: number;
  /** Rolling window duration in milliseconds. */
  readonly windowMs: number;
  /** Stable reason returned when the scope blocks a reservation. */
  readonly limitReason: PublishThrottleLimitReason;
};

/** Parsed result returned by the Redis throttle script. */
type RedisPublishThrottleScriptResult = {
  /** Whether the script reserved the requested publish slot. */
  readonly allowed: boolean;
  /** Milliseconds to wait before retrying when the slot was not reserved. */
  readonly waitMs: number;
  /** First throttle limit that required waiting. */
  readonly limitReason?: PublishThrottleLimitReason;
};

/** Redis key prefix for provider-visible publish throttle reservations. */
const REDIS_PUBLISH_THROTTLE_KEY_PREFIX = "heimdall:publish-throttle";

/** Atomic Redis script that prunes, checks, and reserves publish throttle slots. */
const REDIS_PUBLISH_THROTTLE_SCRIPT = `
local now_ms = tonumber(ARGV[1])
local member = ARGV[2]
local scope_count = tonumber(ARGV[3])

for index = 1, scope_count do
  local arg_offset = 3 + ((index - 1) * 3)
  local limit = tonumber(ARGV[arg_offset + 1])
  local window_ms = tonumber(ARGV[arg_offset + 2])
  local reason = ARGV[arg_offset + 3]
  local cutoff = now_ms - window_ms

  redis.call("ZREMRANGEBYSCORE", KEYS[index], "-inf", cutoff)

  if tonumber(redis.call("ZCARD", KEYS[index])) >= limit then
    local oldest = redis.call("ZRANGE", KEYS[index], 0, 0, "WITHSCORES")
    local oldest_ms = tonumber(oldest[2])
    local wait_ms = window_ms - (now_ms - oldest_ms)
    if wait_ms < 1 then
      wait_ms = 1
    end

    return {0, wait_ms, reason}
  end
end

for index = 1, scope_count do
  local arg_offset = 3 + ((index - 1) * 3)
  local window_ms = tonumber(ARGV[arg_offset + 2])

  redis.call("ZADD", KEYS[index], now_ms, member .. ":" .. index)
  redis.call("PEXPIRE", KEYS[index], window_ms + 1000)
end

return {1, 0, ""}
`;

/** Creates a Redis-backed throttle shared by every worker process using the same Redis prefix. */
export function createRedisPublishThrottle(
  client: RedisPublishThrottleClient,
  options: CreateRedisPublishThrottleOptions = {},
): PublishThrottle {
  const limits = normalizePublishThrottleLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const keyPrefix = options.keyPrefix ?? REDIS_PUBLISH_THROTTLE_KEY_PREFIX;
  const randomId = options.randomId ?? randomUUID;

  return {
    waitForSlot: async (input) => {
      let waitedMs = 0;
      let limitReason: PublishThrottleLimitReason | undefined;

      while (true) {
        const scopes = redisPublishThrottleScopes(input, limits, keyPrefix);
        const scriptResult = asRedisPublishThrottleScriptResult(
          await client.eval(
            REDIS_PUBLISH_THROTTLE_SCRIPT,
            scopes.length,
            ...scopes.map((scope) => scope.key),
            now().getTime(),
            randomId(),
            scopes.length,
            ...scopes.flatMap((scope) => [scope.limit, scope.windowMs, scope.limitReason]),
          ),
        );

        if (scriptResult.allowed) {
          return {
            waitedMs,
            ...(limitReason ? { limitReason } : {}),
            limits,
          };
        }

        limitReason ??= scriptResult.limitReason;
        waitedMs += scriptResult.waitMs;
        await sleep(scriptResult.waitMs);
      }
    },
  };
}

/** Returns the Redis throttle scopes that must all have capacity for one operation. */
function redisPublishThrottleScopes(
  input: PublishThrottleSlotInput,
  limits: PublishThrottleLimits,
  keyPrefix: string,
): readonly RedisPublishThrottleScope[] {
  const scopes: RedisPublishThrottleScope[] = [
    {
      key: redisPublishThrottleKey(keyPrefix, "repo", input.repositoryKey),
      limit: limits.maxPublishOperationsPerRepoPerMinute,
      windowMs: PUBLISH_THROTTLE_MINUTE_WINDOW_MS,
      limitReason: "publish_operations_per_repo_per_minute",
    },
    {
      key: redisPublishThrottleKey(keyPrefix, "installation", input.installationId),
      limit: limits.maxPublishOperationsPerInstallationPerMinute,
      windowMs: PUBLISH_THROTTLE_MINUTE_WINDOW_MS,
      limitReason: "publish_operations_per_installation_per_minute",
    },
  ];

  if (isSummaryPublishOperation(input.operationType)) {
    scopes.push({
      key: redisPublishThrottleKey(
        keyPrefix,
        "summary",
        input.repositoryKey,
        String(input.pullRequestNumber),
      ),
      limit: limits.maxSummaryCommentsPerPrPerHour,
      windowMs: PUBLISH_THROTTLE_HOUR_WINDOW_MS,
      limitReason: "summary_comments_per_pr_per_hour",
    });
  }

  return scopes;
}

/** Builds a Redis key for one publish throttle scope. */
function redisPublishThrottleKey(
  keyPrefix: string,
  scope: string,
  ...parts: readonly string[]
): string {
  return [keyPrefix, scope, ...parts.map((part) => encodeURIComponent(part))].join(":");
}

/** Returns true when an operation publishes or updates a PR summary comment. */
function isSummaryPublishOperation(operationType: PublishOperationType): boolean {
  return (
    operationType === "summary_comment.configured" || operationType === "summary_comment.fallback"
  );
}

/** Parses the atomic Redis throttle script result. */
function asRedisPublishThrottleScriptResult(value: unknown): RedisPublishThrottleScriptResult {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Redis publish throttle returned an invalid result.");
  }

  const allowed = Number(value[0]) === 1;
  const waitMs = Number(value[1]);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error("Redis publish throttle returned an invalid wait duration.");
  }

  const rawReason = value[2];
  return {
    allowed,
    waitMs,
    ...(typeof rawReason === "string" && rawReason.length > 0
      ? { limitReason: asPublishThrottleLimitReason(rawReason) }
      : {}),
  };
}

/** Parses a Redis script reason into a known publish throttle reason. */
function asPublishThrottleLimitReason(value: string): PublishThrottleLimitReason {
  switch (value) {
    case "publish_operations_per_installation_per_minute":
    case "publish_operations_per_repo_per_minute":
    case "summary_comments_per_pr_per_hour":
      return value;
    default:
      throw new Error(`Redis publish throttle returned unsupported limit reason: ${value}`);
  }
}

/** Sleeps for the requested duration. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Creates real handlers for durable job types consumed by this worker app. */
export function createWorkerHandlers(options: CreateWorkerHandlersOptions): DurableJobHandlerMap {
  const repoSyncConfig =
    options.repoSyncConfig ??
    createRepoSyncConfig({
      ...(options.workspaceRoot ? { cacheRoot: options.workspaceRoot } : {}),
    });
  const workspaceAcquirer = options.workspaceAcquirer ?? acquireWorkerRepositoryWorkspace;

  return {
    [JOB_TYPES.SyncInstallation]: async (envelope, context) => {
      const payload = asSyncInstallationPayload(envelope.payload);
      const installation = await loadGitHubInstallationRef(options.db, payload.installationId);
      await throwIfWorkerJobCanceled(context);

      await options.gitProvider.syncInstallation({
        provider: "github",
        installationId: installation.installationId,
        providerInstallationId: installation.providerInstallationId,
        orgId: installation.orgId,
      });
    },
    [JOB_TYPES.IndexRepoCommit]: async (envelope, context) => {
      const payload = asIndexRepoCommitPayload(envelope.payload);
      const repository = await loadGitHubRepositoryRef(options.db, payload);

      await throwIfWorkerJobCanceled(context);
      const workspace = await workspaceAcquirer({
        commitSha: payload.commitSha,
        gitProvider: options.gitProvider,
        repoId: payload.repoId,
        repoSyncConfig,
        repository,
      });
      options.logger?.info("repo-sync workspace lease acquired", {
        attributes: {
          "event.name": "worker.repo_sync.workspace_acquired",
          "job.id": envelope.jobId,
          "repo.id": payload.repoId,
          "repo_sync.lease_id": workspace.leaseId,
          "repo_sync.workspace_purpose": "index",
        },
        target: "worker",
      });
      try {
        const driver = withIndexerTelemetry(
          withIndexerTimeout(options.indexerDriver ?? createTypeScriptIndexerDriver(), {
            timeoutMs: options.indexerTimeoutMs ?? DEFAULT_INDEXER_TIMEOUT_MS,
          }),
          {
            ...(options.metrics ? { metrics: options.metrics } : {}),
            ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
            ...(options.traces ? { traces: options.traces } : {}),
          },
        );
        await throwIfWorkerJobCanceled(context);
        const result = await driver.indexRepository({
          repoId: payload.repoId,
          commitSha: payload.commitSha,
          workspacePath: workspace.workspacePath,
          ...(payload.previousIndexVersionId
            ? { previousIndexVersionId: payload.previousIndexVersionId }
            : {}),
        });
        if (!result.ok) {
          throw new Error(`${result.error.code}: ${result.error.message}`);
        }

        const importLimits = createIndexImportLimitsFromEnvironment(process.env);
        const importRecordBatchSize = options.indexImportRecordBatchSize;
        const artifactUploadMode = options.indexArtifactUploadMode ?? "local_only";
        if (result.artifactUri && artifactUploadMode !== "object_storage") {
          await throwIfWorkerJobCanceled(context);
          await importIndexArtifact(result.artifact, {
            artifactUri: result.artifactUri,
            db: options.db,
            enqueueEmbeddings: true,
            importLimits,
            ...(importRecordBatchSize === undefined ? {} : { importRecordBatchSize }),
            ...(options.metrics ? { metrics: options.metrics } : {}),
            ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
            ...(options.traces ? { traces: options.traces } : {}),
          });
        } else {
          const artifactUri =
            result.artifactUri ??
            (await persistIndexArtifactForImport({
              artifact: result.artifact,
              root: options.indexArtifactRoot ?? DEFAULT_INDEX_ARTIFACT_ROOT,
              ...(options.indexArtifactStore ? { artifactStore: options.indexArtifactStore } : {}),
              ...(result.artifactUri ? { sourceArtifactUri: result.artifactUri } : {}),
              uploadMode: artifactUploadMode,
            }));
          await throwIfWorkerJobCanceled(context);
          await importIndexArtifactFromUri({
            artifactResolver:
              options.indexArtifactResolver ??
              createIndexArtifactResolverFromEnvironment(process.env),
            artifactUri,
            db: options.db,
            enqueueEmbeddings: true,
            importLimits,
            ...(importRecordBatchSize === undefined ? {} : { importRecordBatchSize }),
            ...(options.metrics ? { metrics: options.metrics } : {}),
            ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
            ...(options.traces ? { traces: options.traces } : {}),
          });
        }
        await enqueueWaitingReviewRunsForIndex(options.db, payload, {
          ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
          timestamp: new Date().toISOString(),
        });
      } finally {
        await workspace.release();
        options.logger?.info("repo-sync workspace lease released", {
          attributes: {
            "event.name": "worker.repo_sync.workspace_released",
            "job.id": envelope.jobId,
            "repo.id": payload.repoId,
            "repo_sync.lease_id": workspace.leaseId,
            "repo_sync.workspace_purpose": "index",
          },
          target: "worker",
        });
      }
    },
    [JOB_TYPES.EmbeddingBatch]: async (envelope, context) => {
      const payload = asEmbeddingBatchPayload(envelope.payload);
      await throwIfWorkerJobCanceled(context);
      await embedChunkBatch(payload, {
        db: options.db,
        provider:
          options.embeddingProvider ??
          (await createWorkerEmbeddingProviderFromEnvironment(process.env, {
            model: payload.embeddingModel,
          })),
        ...(options.embeddingUsageRateCard
          ? { usageRateCard: options.embeddingUsageRateCard }
          : {}),
        usageLedger:
          options.usageLedger ?? new UsageLedger(new PostgresUsageLedgerStore(options.db)),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
      });
    },
    [JOB_TYPES.EmbeddingRepair]: async (envelope, context) => {
      const payload = asEmbeddingRepairPayload(envelope.payload);
      await throwIfWorkerJobCanceled(context);
      if (options.embeddingRepairer) {
        await options.embeddingRepairer(payload);
        return;
      }

      if (payload.embeddingJobId) {
        const result = await reconcileEmbeddingJob({
          cleanup: {
            deleteIncompatibleVectors: true,
            deleteOrphanedVectors: true,
          },
          db: options.db,
          embeddingJobId: payload.embeddingJobId,
        });
        if (result && payload.model) {
          await enqueueEmbeddingRepairBatches(options.db, payload, result.missingChunkIds);
        }
        return;
      }

      const result = await repairEmbeddingJobs({
        cleanup: {
          deleteIncompatibleVectors: true,
        },
        db: options.db,
        ...(payload.dimensions ? { dimensions: payload.dimensions } : {}),
        embeddingProfileVersion: payload.embeddingProfileVersion,
        indexVersionId: payload.indexVersionId,
        ...(payload.limit ? { limit: payload.limit } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.provider ? { provider: payload.provider } : {}),
        repoId: payload.repoId,
      });
      if (payload.model) {
        await Promise.all(
          result.jobs.map((job) =>
            enqueueEmbeddingRepairBatches(
              options.db,
              { ...payload, embeddingJobId: job.embeddingJobId },
              job.missingChunkIds,
            ),
          ),
        );
      }
    },
    [JOB_TYPES.ReviewPullRequest]: async (envelope, context) => {
      const payload = asReviewPullRequestPayload(envelope.payload);

      await throwIfWorkerJobCanceled(context);
      await runPullRequestReview(
        { ...payload, jobId: envelope.jobId },
        {
          ...(options.artifactPayloadStore
            ? { artifactPayloadStore: options.artifactPayloadStore }
            : {}),
          db: options.db,
          gitProvider: options.gitProvider,
          ...(options.llmGateway ? { llmGateway: options.llmGateway } : {}),
          ...(options.staticAnalysisRunner
            ? { staticAnalysisRunner: options.staticAnalysisRunner }
            : {}),
          ...(options.reviewIndexDependencyMode
            ? { indexDependencyMode: options.reviewIndexDependencyMode }
            : {}),
          repoSyncConfig,
          ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
          ...(options.logger ? { logger: options.logger } : {}),
          ...(options.metrics ? { metrics: options.metrics } : {}),
          ...(options.traces ? { traces: options.traces } : {}),
          ...(options.usageLedger ? { usageLedger: options.usageLedger } : {}),
          ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        },
      );
    },
    [JOB_TYPES.PublishReview]: async (envelope, context) => {
      const payload = asPublishReviewPayload(envelope.payload);

      await throwIfWorkerJobCanceled(context);
      await publishReviewRun(payload, {
        db: options.db,
        gitProvider: options.gitProvider,
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(options.publishThrottle ? { publishThrottle: options.publishThrottle } : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
      });
    },
    [JOB_TYPES.UpdateMemory]: async (envelope, context) => {
      const payload = asUpdateMemoryPayload(envelope.payload);
      await throwIfWorkerJobCanceled(context);
      await updateMemoryFromFindingOutcome(options.db, payload);
      await throwIfWorkerJobCanceled(context);
      await reconcileScheduledProviderThreadFeedback(
        options.db,
        options.gitProvider,
        payload,
        envelope.createdAt,
        {
          ...(options.metrics ? { metrics: options.metrics } : {}),
          ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
          ...(options.traces ? { traces: options.traces } : {}),
        },
      );
      await throwIfWorkerJobCanceled(context);
      await recordOutcomeFromProviderFeedback(options.db, payload, envelope.createdAt, {
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
      });
    },
    [JOB_TYPES.BillingReconcile]: async (envelope, context) => {
      const payload = asBillingReconcilePayload(envelope.payload);
      await throwIfWorkerJobCanceled(context);
      if (options.billingReconciler) {
        await options.billingReconciler(payload);
        return;
      }

      await reconcileBillingState({
        billingProvider: requireBillingProvider(options.billingProvider),
        db: options.db,
        ...payload,
      });
    },
    [JOB_TYPES.DataDeletionPlan]: async (envelope, context) => {
      const payload = asDataDeletionPlanPayload(envelope.payload);
      try {
        await throwIfWorkerJobCanceled(context);
        if (options.dataDeletionPlanner) {
          await options.dataDeletionPlanner(payload);
          return;
        }

        await planDataDeletionRequest(options.db, payload);
        if (payload.dryRun) {
          return;
        }

        await throwIfWorkerJobCanceled(context);
        const summary = await executeDataDeletionRequest(
          options.db,
          payload.dataDeletionRequestId,
          options.artifactPayloadStore ?? new InlineReviewArtifactPayloadStore(),
        );
        recordWorkerDataDeletionSecurityEvent({
          payload,
          securityEventSink: options.securityEventSink,
          summary,
          type: "data_deletion_completed",
        });
      } catch (error) {
        recordWorkerDataDeletionSecurityEvent({
          error,
          payload,
          securityEventSink: options.securityEventSink,
          type: "data_deletion_failed",
        });
        throw error;
      }
    },
    [JOB_TYPES.SandboxCleanup]: async (envelope, context) => {
      const payload = asSandboxCleanupPayload(envelope.payload);
      await throwIfWorkerJobCanceled(context);
      if (options.sandboxCleaner) {
        await options.sandboxCleaner(payload);
        return;
      }

      await cleanupSandboxRuns(options.db, payload);
    },
    [JOB_TYPES.ReviewArtifactCleanup]: async (envelope, context) => {
      const payload = asReviewArtifactCleanupPayload(envelope.payload);
      await throwIfWorkerJobCanceled(context);
      if (options.reviewArtifactCleaner) {
        await options.reviewArtifactCleaner(payload);
        return;
      }

      await cleanupExpiredReviewArtifacts(
        options.db,
        payload,
        options.artifactPayloadStore ?? new InlineReviewArtifactPayloadStore(),
      );
    },
    [JOB_TYPES.ComplianceEvidenceCollect]: async (envelope, context) => {
      const payload = asComplianceEvidenceCollectPayload(envelope.payload);
      try {
        await throwIfWorkerJobCanceled(context);
        if (options.complianceEvidenceCollector) {
          await options.complianceEvidenceCollector(payload);
        } else {
          await collectScheduledComplianceEvidence(options.db, payload);
        }

        recordWorkerComplianceEvidenceSecurityEvent({
          payload,
          securityEventSink: options.securityEventSink,
          type: "compliance_evidence_collected",
        });
      } catch (error) {
        recordWorkerComplianceEvidenceSecurityEvent({
          error,
          payload,
          securityEventSink: options.securityEventSink,
          type: "compliance_evidence_failed",
        });
        throw error;
      }
    },
  };
}

/** Runs scheduled compliance evidence collectors from a durable worker job payload. */
async function collectScheduledComplianceEvidence(
  db: HeimdallDatabase,
  payload: ComplianceEvidenceCollectJobPayload,
): Promise<void> {
  const artifactStore = createFilesystemComplianceEvidenceArtifactStore({
    rootDir:
      payload.artifactRootDir ??
      process.env.HEIMDALL_COMPLIANCE_EVIDENCE_ARTIFACT_ROOT ??
      DEFAULT_COMPLIANCE_EVIDENCE_ARTIFACT_ROOT,
  });
  const options = {
    artifactStore,
    collectedBy: payload.collectedBy ?? "worker:scheduled_compliance_evidence",
    db,
    ...(payload.limit ? { limit: payload.limit } : {}),
    ...(payload.orgId ? { orgId: payload.orgId } : {}),
  };

  for (const target of expandedComplianceEvidenceJobTargets(payload.target)) {
    switch (target) {
      case "access_review_export":
        await collectAccessReviewEvidence(options);
        break;
      case "audit_log_export":
        await collectAuditLogEvidence(options);
        break;
      case "config_snapshot":
        await collectConfigSnapshotEvidence(options);
        break;
      case "security_event_export":
        await collectSecurityEventEvidence(options);
        break;
    }
  }
}

/** Returns concrete collector targets for one scheduled compliance evidence job. */
function expandedComplianceEvidenceJobTargets(
  target: ComplianceEvidenceCollectJobPayload["target"],
): readonly Exclude<ComplianceEvidenceCollectJobPayload["target"], "all">[] {
  if (target !== "all") {
    return [target];
  }

  return ["access_review_export", "audit_log_export", "security_event_export", "config_snapshot"];
}

/** Enqueues one idempotent scheduled compliance evidence collection job for the current bucket. */
export async function enqueueScheduledComplianceEvidenceCollection(
  db: HeimdallDatabase,
  config: WorkerComplianceEvidenceSchedulerConfig,
  options: {
    /** Current time used to calculate the scheduler bucket. */
    readonly now?: Date;
  } = {},
): Promise<EnqueueScheduledComplianceEvidenceCollectionResult> {
  const now = options.now ?? new Date();
  const scheduledFor = complianceEvidenceSchedulerBucketStart(now, config.intervalMs).toISOString();
  const scope = config.orgId ?? "global";
  const jobKey = `compliance-evidence:collect:${config.target}:${scope}:${scheduledFor}`;
  const payload = parseWithSchema(
    "ComplianceEvidenceCollectJobPayload",
    ComplianceEvidenceCollectJobPayloadSchema,
    {
      artifactRootDir: config.artifactRootDir,
      collectedBy: config.collectedBy,
      limit: config.limit,
      ...(config.orgId ? { orgId: config.orgId } : {}),
      reason: "scheduled",
      target: config.target,
    },
  );
  const envelope: JobEnvelope<ComplianceEvidenceCollectJobPayload> = {
    attempt: 0,
    createdAt: now.toISOString(),
    idempotencyKey: jobKey,
    jobId: stableWorkerId("job", ["compliance_evidence_collect", jobKey, "envelope"]),
    jobType: JOB_TYPES.ComplianceEvidenceCollect,
    maxAttempts: 3,
    payload,
    scheduledFor,
    schemaVersion: "compliance_evidence_collect_job.v1",
  };
  const { inserted, job } = await new BackgroundJobRepository(db).insertBackgroundJob({
    backgroundJobId: stableWorkerId("job", ["compliance_evidence_collect", jobKey]),
    envelope,
    metadata: {
      intervalMs: config.intervalMs,
      scheduledBucket: scheduledFor,
      source: "compliance_evidence_scheduler",
      target: config.target,
    },
    ...(config.orgId ? { orgId: config.orgId } : {}),
    queueName: QUEUE_NAMES.security,
    scheduledAt: scheduledFor,
  });

  return {
    backgroundJobId: job.backgroundJobId,
    inserted,
    jobKey,
    scheduledFor,
  };
}

/** Returns the start of the idempotent scheduler bucket for a compliance evidence run. */
function complianceEvidenceSchedulerBucketStart(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/** Enqueues idempotent scheduled retention cleanup jobs for the current bucket. */
export async function enqueueScheduledRetentionCleanupJobs(
  db: HeimdallDatabase,
  config: WorkerRetentionCleanupSchedulerConfig,
  options: {
    /** Current time used to calculate the scheduler bucket. */
    readonly now?: Date;
  } = {},
): Promise<EnqueueScheduledRetentionCleanupJobsResult> {
  const now = options.now ?? new Date();
  const scheduledFor = retentionCleanupSchedulerBucketStart(now, config.intervalMs).toISOString();
  const jobs: EnqueuedScheduledRetentionCleanupJob[] = [];

  jobs.push(
    await insertScheduledRetentionCleanupJob({
      db,
      envelope: createScheduledSandboxCleanupEnvelope(config, { now, scheduledFor }),
      jobKeyPrefix: "sandbox_cleanup",
      metadataTarget: "sandbox_runs",
      scheduledFor,
    }),
  );
  jobs.push(
    await insertScheduledRetentionCleanupJob({
      db,
      envelope: createScheduledReviewArtifactCleanupEnvelope(config, { now, scheduledFor }),
      jobKeyPrefix: "review_artifact_cleanup",
      metadataTarget: "review_artifacts",
      scheduledFor,
    }),
  );

  return {
    insertedCount: jobs.filter((job) => job.inserted).length,
    jobs,
    scheduledFor,
  };
}

/** Input used to insert one scheduled retention cleanup job. */
type InsertScheduledRetentionCleanupJobInput = {
  /** Database facade used to insert the durable job. */
  readonly db: HeimdallDatabase;
  /** Durable cleanup envelope to persist. */
  readonly envelope: JobEnvelope<SandboxCleanupJobPayload | ReviewArtifactCleanupJobPayload>;
  /** Stable ID namespace for the cleanup job. */
  readonly jobKeyPrefix: string;
  /** Product-safe target label for job metadata. */
  readonly metadataTarget: "sandbox_runs" | "review_artifacts";
  /** ISO timestamp for the scheduler bucket represented by the job. */
  readonly scheduledFor: string;
};

/** Inserts one durable retention cleanup job for a scheduler bucket. */
async function insertScheduledRetentionCleanupJob(
  input: InsertScheduledRetentionCleanupJobInput,
): Promise<EnqueuedScheduledRetentionCleanupJob> {
  const { inserted, job } = await new BackgroundJobRepository(input.db).insertBackgroundJob({
    backgroundJobId: stableWorkerId("job", [input.jobKeyPrefix, input.envelope.idempotencyKey]),
    envelope: input.envelope,
    metadata: {
      scheduledBucket: input.scheduledFor,
      source: "retention_cleanup_scheduler",
      target: input.metadataTarget,
    },
    queueName: QUEUE_NAMES.security,
    scheduledAt: input.scheduledFor,
  });

  return {
    backgroundJobId: job.backgroundJobId,
    inserted,
    jobKey: input.envelope.idempotencyKey,
    jobType: input.envelope.jobType as
      | typeof JOB_TYPES.SandboxCleanup
      | typeof JOB_TYPES.ReviewArtifactCleanup,
  };
}

/** Creates the scheduled sandbox cleanup job envelope for one scheduler bucket. */
function createScheduledSandboxCleanupEnvelope(
  config: WorkerRetentionCleanupSchedulerConfig,
  input: {
    /** Current wall-clock time used for deterministic envelopes. */
    readonly now: Date;
    /** ISO timestamp for the scheduler bucket represented by the job. */
    readonly scheduledFor: string;
  },
): JobEnvelope<SandboxCleanupJobPayload> {
  const jobKey = `sandbox:cleanup:retention:${input.scheduledFor}`;
  const payload = parseWithSchema("SandboxCleanupJobPayload", SandboxCleanupJobPayloadSchema, {
    dryRun: config.dryRun,
    limit: config.limit,
    olderThanDays: config.sandboxOlderThanDays,
    reason: "retention_policy",
  });

  return {
    attempt: 0,
    createdAt: input.now.toISOString(),
    idempotencyKey: jobKey,
    jobId: stableWorkerId("job", ["sandbox_cleanup", jobKey, "envelope"]),
    jobType: JOB_TYPES.SandboxCleanup,
    maxAttempts: 3,
    payload,
    scheduledFor: input.scheduledFor,
    schemaVersion: "sandbox_cleanup_job.v1",
  };
}

/** Creates the scheduled review artifact cleanup job envelope for one scheduler bucket. */
function createScheduledReviewArtifactCleanupEnvelope(
  config: WorkerRetentionCleanupSchedulerConfig,
  input: {
    /** Current wall-clock time used for deterministic envelopes. */
    readonly now: Date;
    /** ISO timestamp for the scheduler bucket represented by the job. */
    readonly scheduledFor: string;
  },
): JobEnvelope<ReviewArtifactCleanupJobPayload> {
  const jobKey = `review-artifact:cleanup:retention:${input.scheduledFor}`;
  const payload = parseWithSchema(
    "ReviewArtifactCleanupJobPayload",
    ReviewArtifactCleanupJobPayloadSchema,
    {
      dryRun: config.dryRun,
      limit: config.limit,
      reason: "retention_policy",
    },
  );

  return {
    attempt: 0,
    createdAt: input.now.toISOString(),
    idempotencyKey: jobKey,
    jobId: stableWorkerId("job", ["review_artifact_cleanup", jobKey, "envelope"]),
    jobType: JOB_TYPES.ReviewArtifactCleanup,
    maxAttempts: 3,
    payload,
    scheduledFor: input.scheduledFor,
    schemaVersion: "review_artifact_cleanup_job.v1",
  };
}

/** Returns the start of the idempotent scheduler bucket for retention cleanup jobs. */
function retentionCleanupSchedulerBucketStart(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/** Runs an optional durable cancellation checkpoint for direct and wrapped handler calls. */
async function throwIfWorkerJobCanceled(
  context: DurableJobHandlerContext | undefined,
): Promise<void> {
  await context?.throwIfCanceled();
}

/** Acquires a cached repository workspace for a worker index job. */
export async function acquireWorkerRepositoryWorkspace(
  input: WorkerRepositoryWorkspaceAcquireInput,
  dependencies: AcquireRepositoryWorkspaceDependencies = {},
): Promise<WorkerRepositoryWorkspaceLease> {
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
      purpose: "index",
      repoId: input.repoId,
    },
    dependencies,
  );

  return {
    leaseId: lease.leaseId,
    release: lease.release,
    workspacePath: lease.path,
  };
}

/** Cleans expired repo-sync worktrees during worker startup. */
export async function cleanupWorkerRepoSyncWorktrees(
  input: WorkerRepoSyncStartupCleanupInput,
): Promise<CleanupExpiredRepositoryWorktreesResult> {
  const cleanupLimit = createWorkerRepoSyncCleanupLimitFromEnvironment(input.env);
  const cleanupExpiredWorktrees =
    input.cleanupExpiredWorktrees ??
    ((cleanupInput: CleanupExpiredRepositoryWorktreesInput) =>
      cleanupExpiredRepositoryWorktrees(cleanupInput));
  const result = await cleanupExpiredWorktrees({
    config: input.repoSyncConfig,
    ...(cleanupLimit ? { limit: cleanupLimit } : {}),
  });

  if (result.removedWorktreeCount > 0 || result.failures.length > 0) {
    input.logger?.warn("repo-sync expired worktree cleanup completed", {
      attributes: {
        "event.name": "worker.repo_sync.expired_worktree_cleanup",
        "repo_sync.cleanup.dry_run": result.dryRun,
        "repo_sync.cleanup.expired_worktree_count": result.expiredWorktreeCount,
        "repo_sync.cleanup.failure_count": result.failures.length,
        "repo_sync.cleanup.pruned_mirror_count": result.prunedMirrorCount,
        "repo_sync.cleanup.removed_worktree_count": result.removedWorktreeCount,
        "repo_sync.cleanup.scanned_worktree_count": result.scannedWorktreeCount,
        "repo_sync.cleanup.skipped_worktree_count": result.skippedWorktreeCount,
      },
    });
  }

  return result;
}

/** Parses the optional worker startup repo-sync cleanup limit from environment. */
export function createWorkerRepoSyncCleanupLimitFromEnvironment(
  env: WorkerSecretEnvironment,
): number | undefined {
  return (
    optionalPositiveInteger(env.HEIMDALL_REPO_SYNC_EXPIRED_WORKTREE_CLEANUP_LIMIT) ??
    optionalPositiveInteger(env.REPO_SYNC_EXPIRED_WORKTREE_CLEANUP_LIMIT) ??
    optionalPositiveInteger(env.REPO_SYNC_CLEANUP_LIMIT)
  );
}

/** Result returned after requeueing reviews that were waiting for a completed index. */
export type EnqueueWaitingReviewRunsForIndexResult = {
  /** Number of waiting review runs found for the completed index commit. */
  readonly inspectedCount: number;
  /** Number of idempotent review resume jobs attempted. */
  readonly enqueuedCount: number;
};

/** Requeues review jobs waiting for the index version that just finished importing. */
export async function enqueueWaitingReviewRunsForIndex(
  db: HeimdallDatabase,
  payload: IndexRepoCommitJobPayload,
  options: {
    /** Timestamp used for deterministic job envelopes. */
    readonly timestamp: string;
    /** Optional trace context propagated from the completed index job. */
    readonly traceContext?: JobEnvelope<IndexRepoCommitJobPayload>["traceContext"];
  },
): Promise<EnqueueWaitingReviewRunsForIndexResult> {
  const waitingRuns = await new ReviewRepository(db).listReviewRunsWaitingForIndex({
    headSha: payload.commitSha,
    limit: 100,
    repoId: payload.repoId,
  });

  const backgroundJobRepository = new BackgroundJobRepository(db);

  for (const run of waitingRuns) {
    const jobKey = `github:review-resume:${payload.repoId}:${run.pullRequestNumber}:${payload.commitSha}:index`;
    const reviewPayload: ReviewPullRequestJobPayload = {
      baseSha: run.baseSha,
      headSha: run.headSha,
      installationId: payload.installationId,
      pullRequestNumber: run.pullRequestNumber,
      repoId: payload.repoId,
      trigger: reviewTriggerFromValue(run.trigger),
      ...(reviewRunDryRunFromMetadata(run.dryRunMetadata) ? { dryRun: true } : {}),
    };
    const envelope: JobEnvelope<ReviewPullRequestJobPayload> = {
      attempt: 0,
      createdAt: options.timestamp,
      idempotencyKey: jobKey,
      jobId: stableWorkerId("job", ["review_resume", jobKey, "envelope"]),
      jobType: JOB_TYPES.ReviewPullRequest,
      maxAttempts: 3,
      payload: reviewPayload,
      schemaVersion: "job_envelope.v1",
      ...(options.traceContext ? { traceContext: options.traceContext } : {}),
    };

    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: stableWorkerId("job", ["review_resume", jobKey]),
      envelope,
      metadata: {
        completedIndexCommitSha: payload.commitSha,
        source: "index_dependency_ready",
      },
      queueName: QUEUE_NAMES.review,
      repoId: payload.repoId,
      reviewRunId: run.reviewRunId,
    });
  }

  return {
    enqueuedCount: waitingRuns.length,
    inspectedCount: waitingRuns.length,
  };
}

/** Returns true when review-run metadata marks the run as dry-run. */
function reviewRunDryRunFromMetadata(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).dryRun === true
  );
}

/** Parses a durable review-run trigger into the review job trigger contract. */
function reviewTriggerFromValue(value: string): ReviewTrigger {
  switch (value) {
    case "manual":
    case "rerun":
    case "scheduled":
    case "webhook":
      return value;
    default:
      throw new Error(`Unsupported waiting review trigger: ${value}`);
  }
}

/** Enqueues missing chunks discovered by an embedding repair pass as bounded batch jobs. */
async function enqueueEmbeddingRepairBatches(
  db: HeimdallDatabase,
  payload: EmbeddingRepairJobPayload,
  chunkIds: readonly string[],
): Promise<void> {
  if (!payload.embeddingJobId || !payload.model || chunkIds.length === 0) {
    return;
  }

  const backgroundJobRepository = new BackgroundJobRepository(db);

  for (let index = 0; index < chunkIds.length; index += EMBEDDING_REPAIR_BATCH_SIZE) {
    const batchChunkIds = chunkIds.slice(index, index + EMBEDDING_REPAIR_BATCH_SIZE);
    const batchIndex = index / EMBEDDING_REPAIR_BATCH_SIZE;
    const jobKey = `embedding:repair:${payload.embeddingJobId}:batch:${batchIndex}`;
    const batchPayload: EmbeddingBatchJobPayload = {
      chunkIds: batchChunkIds,
      embeddingJobId: payload.embeddingJobId,
      embeddingModel: payload.model,
      embeddingProfileVersion: payload.embeddingProfileVersion,
      indexVersionId: payload.indexVersionId,
      repoId: payload.repoId,
    };
    const now = new Date().toISOString();
    const envelope: JobEnvelope<EmbeddingBatchJobPayload> = {
      attempt: 0,
      createdAt: now,
      idempotencyKey: jobKey,
      jobId: stableWorkerId("job", ["embedding_repair_batch", jobKey, "envelope"]),
      jobType: JOB_TYPES.EmbeddingBatch,
      maxAttempts: 3,
      payload: batchPayload,
      schemaVersion: "job_envelope.v1",
    };

    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: stableWorkerId("job", ["embedding_repair_batch", jobKey]),
      envelope,
      metadata: {
        embeddingRepairJobId: payload.embeddingJobId,
        source: "embedding_repair",
      },
      queueName: QUEUE_NAMES.embedding,
      repoId: payload.repoId,
    });
  }
}

/** Persists a planned data-deletion request and product-safe deletion manifest. */
async function planDataDeletionRequest(
  db: HeimdallDatabase,
  payload: DataDeletionPlanJobPayload,
): Promise<void> {
  const repository = new DataDeletionRepository(db);
  const manifest = createDataDeletionManifest(payload);
  const metadata = {
    ...(payload.dryRun === undefined ? {} : { dryRun: payload.dryRun }),
    plannedBy: "worker",
    ...(payload.sourceWebhookEventId ? { sourceWebhookEventId: payload.sourceWebhookEventId } : {}),
  };

  await repository.createDataDeletionRequest({
    dataDeletionRequestId: payload.dataDeletionRequestId,
    ...(payload.orgId ? { orgId: payload.orgId } : {}),
    reason: payload.reason,
    ...(payload.repoId ? { repoId: payload.repoId } : {}),
    requestedAt: payload.requestedAt,
    requestedBy: payload.requestedBy,
    scope: payload.scope,
    status: "requested",
    ...(payload.userId ? { userId: payload.userId } : {}),
    metadata,
  });
  await repository.updateDataDeletionRequestStatus({
    dataDeletionRequestId: payload.dataDeletionRequestId,
    manifest,
    metadata,
    status: "planned",
  });
}

/** Summary returned after executing one data-deletion request. */
export type DataDeletionExecutionSummary = {
  /** Durable data-deletion request ID. */
  readonly dataDeletionRequestId: string;
  /** Whether the request had already reached a terminal state before execution. */
  readonly alreadyTerminal: boolean;
  /** Number of durable job rows canceled before dispatch. */
  readonly canceledJobCount: number;
  /** Number of code chunk embedding rows deleted. */
  readonly deletedEmbeddingCount: number;
  /** Number of repositories disabled by the request. */
  readonly disabledRepositoryCount: number;
  /** Number of review artifact payload rows selected for deletion. */
  readonly selectedReviewArtifactCount: number;
  /** Number of review artifact payloads deleted from backing storage or inline metadata. */
  readonly deletedReviewArtifactPayloadCount: number;
  /** Number of review artifact payloads already absent from backing storage. */
  readonly missingReviewArtifactPayloadCount: number;
  /** Number of review artifact rows updated with deletion tombstones. */
  readonly tombstonedReviewArtifactCount: number;
  /** Number of review artifact payload deletions that failed and should retry. */
  readonly failedReviewArtifactPayloadCount: number;
  /** Number of sandbox run rows selected for deletion. */
  readonly selectedSandboxRunCount: number;
  /** Number of sandbox run rows deleted. */
  readonly deletedSandboxRunCount: number;
  /** Number of local sandbox artifact files deleted. */
  readonly deletedSandboxArtifactFileCount: number;
  /** Number of sandbox artifact URIs skipped by local file cleanup. */
  readonly skippedSandboxArtifactFileCount: number;
  /** Repository IDs covered by the request. */
  readonly repoIds: readonly string[];
  /** Verification evidence URI stored on the request when deletion completed. */
  readonly verificationArtifactUri?: string;
};

/** Input used to record a worker-originated data-deletion security event. */
type RecordWorkerDataDeletionSecurityEventInput = {
  /** Error that caused the deletion workflow to fail. */
  readonly error?: unknown;
  /** Data-deletion planning payload being handled. */
  readonly payload: DataDeletionPlanJobPayload;
  /** Optional sink configured for worker-originated security events. */
  readonly securityEventSink?: SecurityEventSink | undefined;
  /** Execution summary when deletion completed. */
  readonly summary?: DataDeletionExecutionSummary | undefined;
  /** Normalized security event type. */
  readonly type: "data_deletion_completed" | "data_deletion_failed";
};

/** Input used to record a worker-originated compliance evidence security event. */
type RecordWorkerComplianceEvidenceSecurityEventInput = {
  /** Error that caused the evidence collection workflow to fail. */
  readonly error?: unknown;
  /** Compliance evidence collection payload being handled. */
  readonly payload: ComplianceEvidenceCollectJobPayload;
  /** Optional sink configured for worker-originated security events. */
  readonly securityEventSink?: SecurityEventSink | undefined;
  /** Normalized security event type. */
  readonly type: "compliance_evidence_collected" | "compliance_evidence_failed";
};

/** Executes a planned data-deletion request and records product-safe verification metadata. */
export async function executeDataDeletionRequest(
  db: HeimdallDatabase,
  dataDeletionRequestId: string,
  artifactPayloadStore: ReviewArtifactPayloadStore = new InlineReviewArtifactPayloadStore(),
  now: Date = new Date(),
): Promise<DataDeletionExecutionSummary> {
  const repository = new DataDeletionRepository(db);
  const request = await repository.getDataDeletionRequest(dataDeletionRequestId);
  if (!request) {
    throw new Error(`Data-deletion request ${dataDeletionRequestId} was not found.`);
  }

  if (request.status === "completed" || request.status === "verified") {
    return emptyDataDeletionExecutionSummary({
      alreadyTerminal: true,
      dataDeletionRequestId,
      repoIds: [],
      verificationArtifactUri: request.verificationArtifactUri ?? undefined,
    });
  }

  const manifest = parseWithSchema(
    "DataDeletionManifest",
    DataDeletionManifestSchema,
    request.manifest,
  );
  const repoIds = (
    await repository.listRepositoryIdsForDeletionScope({
      orgId: request.orgId,
      repoId: request.repoId,
    })
  ).map((row) => row.repoId);
  const executionStartedAt = now.toISOString();
  const metadata = dataDeletionMetadataRecord(request.metadata);

  await repository.updateDataDeletionRequestStatus({
    dataDeletionRequestId,
    manifest,
    metadata: {
      ...metadata,
      executionStartedAt,
    },
    now,
    status: "in_progress",
  });

  const disabledRepositoryCount = await repository.disableRepositoriesForDeletion(repoIds);
  const canceledJobCount = await repository.cancelPendingBackgroundJobsForDeletionScope({
    orgId: request.orgId,
    reason: `data deletion request ${dataDeletionRequestId}`,
    repoIds,
    now,
  });
  const reviewArtifactSummary = await deleteReviewArtifactPayloadsForDataDeletion({
    artifactPayloadStore,
    dataDeletionRepository: repository,
    now,
    reviewRepository: new ReviewRepository(db),
    repoIds,
  });
  const sandboxSummary = await cleanupSandboxRunsForDataDeletion(db, repoIds, now);
  const deletedEmbeddingCount = await repository.deleteCodeChunkEmbeddingsForRepositories(repoIds);
  const verificationArtifactUri = dataDeletionVerificationArtifactUri(dataDeletionRequestId);
  const summary: DataDeletionExecutionSummary = {
    alreadyTerminal: false,
    canceledJobCount,
    dataDeletionRequestId,
    deletedEmbeddingCount,
    deletedReviewArtifactPayloadCount: reviewArtifactSummary.deletedPayloadCount,
    deletedSandboxArtifactFileCount: sandboxSummary.deletedArtifactFileCount,
    deletedSandboxRunCount: sandboxSummary.deletedRunCount,
    disabledRepositoryCount,
    failedReviewArtifactPayloadCount: reviewArtifactSummary.failedPayloadCount,
    missingReviewArtifactPayloadCount: reviewArtifactSummary.missingPayloadCount,
    repoIds,
    selectedReviewArtifactCount: reviewArtifactSummary.selectedArtifactCount,
    selectedSandboxRunCount: sandboxSummary.selectedRunCount,
    skippedSandboxArtifactFileCount: sandboxSummary.skippedArtifactFileCount,
    tombstonedReviewArtifactCount: reviewArtifactSummary.tombstonedArtifactCount,
    verificationArtifactUri,
  };
  const completedAt = now;
  const failed =
    reviewArtifactSummary.failedPayloadCount > 0 || reviewArtifactSummary.batchLimitReached;

  await repository.updateDataDeletionRequestStatus({
    completedAt,
    dataDeletionRequestId,
    manifest: {
      ...manifest,
      queueKeys: [
        ...manifest.queueKeys,
        ...(canceledJobCount > 0 ? [`canceled:${canceledJobCount}`] : []),
      ],
      vectorNamespaces: [...new Set([...manifest.vectorNamespaces, ...repoIds])],
    },
    metadata: {
      ...metadata,
      executionCompletedAt: completedAt.toISOString(),
      executionStartedAt,
      executionSummary: summary,
    },
    now,
    status: failed ? "failed" : "completed",
    verificationArtifactUri: failed ? null : verificationArtifactUri,
  });

  if (failed) {
    throw new Error(`Data-deletion request ${dataDeletionRequestId} did not complete.`);
  }

  return summary;
}

/** Review artifact payload deletion counters for one data-deletion execution. */
type DataDeletionReviewArtifactPayloadSummary = {
  /** Whether the bounded batch limit stopped processing before a clean final batch. */
  readonly batchLimitReached: boolean;
  /** Number of payloads removed from backing storage or inline metadata. */
  readonly deletedPayloadCount: number;
  /** Number of payload deletions that failed and should retry. */
  readonly failedPayloadCount: number;
  /** Number of payloads already missing from backing storage. */
  readonly missingPayloadCount: number;
  /** Number of review artifact rows selected. */
  readonly selectedArtifactCount: number;
  /** Number of review artifact rows updated with deletion tombstones. */
  readonly tombstonedArtifactCount: number;
};

/** Input used to delete review artifact payloads for a data-deletion request. */
type DeleteReviewArtifactPayloadsForDataDeletionInput = {
  /** Store used to remove backing review artifact payload bytes. */
  readonly artifactPayloadStore: ReviewArtifactPayloadStore;
  /** Data-deletion query helper. */
  readonly dataDeletionRepository: DataDeletionRepository;
  /** Deletion timestamp. */
  readonly now: Date;
  /** Review query helper used to tombstone artifact rows. */
  readonly reviewRepository: ReviewRepository;
  /** Repository IDs covered by the deletion request. */
  readonly repoIds: readonly string[];
};

/** Deletes review artifact payloads for a data-deletion request in bounded batches. */
async function deleteReviewArtifactPayloadsForDataDeletion(
  input: DeleteReviewArtifactPayloadsForDataDeletionInput,
): Promise<DataDeletionReviewArtifactPayloadSummary> {
  let selectedArtifactCount = 0;
  let deletedPayloadCount = 0;
  let missingPayloadCount = 0;
  let tombstonedArtifactCount = 0;
  let failedPayloadCount = 0;
  let batchLimitReached = false;

  for (
    let batchIndex = 0;
    batchIndex < DATA_DELETION_REVIEW_ARTIFACT_MAX_BATCHES;
    batchIndex += 1
  ) {
    const artifactRows =
      await input.dataDeletionRepository.listReviewArtifactPayloadDeletionTargets({
        excludeUriPrefix: DELETED_REVIEW_ARTIFACT_URI_PREFIX,
        limit: DATA_DELETION_REVIEW_ARTIFACT_BATCH_SIZE,
        repoIds: input.repoIds,
      });

    if (artifactRows.length === 0) {
      break;
    }

    selectedArtifactCount += artifactRows.length;

    for (const artifact of artifactRows) {
      try {
        const result = await input.artifactPayloadStore.deleteJson({
          metadata: artifact.metadata,
          uri: artifact.uri,
        });

        if (result.deleted) {
          deletedPayloadCount += 1;
        } else {
          missingPayloadCount += 1;
        }

        await input.reviewRepository.updateReviewArtifactPayloadTombstone({
          metadata: reviewArtifactPayloadDeletedMetadata({
            deletedAt: input.now.toISOString(),
            metadata: artifact.metadata,
            reason: "data_deletion",
          }),
          reviewArtifactId: artifact.reviewArtifactId,
          sizeBytes: 0,
          uri: deletedReviewArtifactUri(artifact.reviewArtifactId),
        });
        tombstonedArtifactCount += 1;
      } catch {
        failedPayloadCount += 1;
      }
    }

    if (failedPayloadCount > 0 || artifactRows.length < DATA_DELETION_REVIEW_ARTIFACT_BATCH_SIZE) {
      break;
    }

    batchLimitReached = batchIndex === DATA_DELETION_REVIEW_ARTIFACT_MAX_BATCHES - 1;
  }

  return {
    batchLimitReached,
    deletedPayloadCount,
    failedPayloadCount,
    missingPayloadCount,
    selectedArtifactCount,
    tombstonedArtifactCount,
  };
}

/** Sandbox cleanup counters for one data-deletion execution. */
type DataDeletionSandboxCleanupSummary = {
  /** Number of local sandbox artifact files deleted. */
  readonly deletedArtifactFileCount: number;
  /** Number of sandbox run rows deleted. */
  readonly deletedRunCount: number;
  /** Number of sandbox run rows selected. */
  readonly selectedRunCount: number;
  /** Number of sandbox artifact URIs skipped by local file cleanup. */
  readonly skippedArtifactFileCount: number;
};

/** Deletes sandbox run rows and local artifact files covered by a data-deletion request. */
async function cleanupSandboxRunsForDataDeletion(
  db: HeimdallDatabase,
  repoIds: readonly string[],
  now: Date,
): Promise<DataDeletionSandboxCleanupSummary> {
  const summaries = await Promise.all(
    repoIds.map((repoId) =>
      cleanupSandboxRuns(
        db,
        {
          before: now.toISOString(),
          limit: DATA_DELETION_SANDBOX_RUN_LIMIT,
          reason: "retention_policy",
          repoId,
        },
        now,
      ),
    ),
  );

  return summaries.reduce<DataDeletionSandboxCleanupSummary>(
    (total, summary) => ({
      deletedArtifactFileCount: total.deletedArtifactFileCount + summary.deletedArtifactFileCount,
      deletedRunCount: total.deletedRunCount + summary.deletedRunCount,
      selectedRunCount: total.selectedRunCount + summary.selectedRunCount,
      skippedArtifactFileCount: total.skippedArtifactFileCount + summary.skippedArtifactFileCount,
    }),
    {
      deletedArtifactFileCount: 0,
      deletedRunCount: 0,
      selectedRunCount: 0,
      skippedArtifactFileCount: 0,
    },
  );
}

/** Builds a zero-count execution summary for terminal idempotent deletion calls. */
function emptyDataDeletionExecutionSummary(input: {
  /** Whether the request was already terminal. */
  readonly alreadyTerminal: boolean;
  /** Durable data-deletion request ID. */
  readonly dataDeletionRequestId: string;
  /** Repository IDs covered by the request. */
  readonly repoIds: readonly string[];
  /** Existing verification evidence URI, when present. */
  readonly verificationArtifactUri?: string | undefined;
}): DataDeletionExecutionSummary {
  return {
    alreadyTerminal: input.alreadyTerminal,
    canceledJobCount: 0,
    dataDeletionRequestId: input.dataDeletionRequestId,
    deletedEmbeddingCount: 0,
    deletedReviewArtifactPayloadCount: 0,
    deletedSandboxArtifactFileCount: 0,
    deletedSandboxRunCount: 0,
    disabledRepositoryCount: 0,
    failedReviewArtifactPayloadCount: 0,
    missingReviewArtifactPayloadCount: 0,
    repoIds: input.repoIds,
    selectedReviewArtifactCount: 0,
    selectedSandboxRunCount: 0,
    skippedSandboxArtifactFileCount: 0,
    tombstonedReviewArtifactCount: 0,
    ...(input.verificationArtifactUri
      ? { verificationArtifactUri: input.verificationArtifactUri }
      : {}),
  };
}

/** Converts unknown request metadata to a mutable product-safe record. */
function dataDeletionMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return { ...(metadata as Record<string, unknown>) };
}

/** Returns the durable verification evidence URI for a completed data-deletion request. */
function dataDeletionVerificationArtifactUri(dataDeletionRequestId: string): string {
  return `deletion://${dataDeletionRequestId}/verification.json`;
}

/** Records a product-safe security event for worker data-deletion workflow outcomes. */
function recordWorkerDataDeletionSecurityEvent(
  input: RecordWorkerDataDeletionSecurityEventInput,
): void {
  if (!input.securityEventSink) {
    return;
  }

  recordSecurityEvent(input.securityEventSink, {
    actorId: input.payload.requestedBy,
    metadata: {
      dataDeletionRequestId: input.payload.dataDeletionRequestId,
      dryRun: input.payload.dryRun ?? false,
      ...(input.error
        ? { errorName: input.error instanceof Error ? input.error.name : "UnknownError" }
        : {}),
      reason: input.payload.reason,
      scope: input.payload.scope,
      ...(input.summary
        ? {
            canceledJobCount: input.summary.canceledJobCount,
            deletedEmbeddingCount: input.summary.deletedEmbeddingCount,
            deletedReviewArtifactPayloadCount: input.summary.deletedReviewArtifactPayloadCount,
            deletedSandboxRunCount: input.summary.deletedSandboxRunCount,
            disabledRepositoryCount: input.summary.disabledRepositoryCount,
            repoCount: input.summary.repoIds.length,
            tombstonedReviewArtifactCount: input.summary.tombstonedReviewArtifactCount,
          }
        : {}),
    },
    orgId: input.payload.orgId,
    repoId: input.payload.repoId,
    resourceId: input.payload.dataDeletionRequestId,
    resourceType: "data_deletion_request",
    severity: input.type === "data_deletion_failed" ? "high" : "info",
    source: "worker",
    type: input.type,
  });
}

/** Records a product-safe security event for worker compliance evidence collection outcomes. */
function recordWorkerComplianceEvidenceSecurityEvent(
  input: RecordWorkerComplianceEvidenceSecurityEventInput,
): void {
  if (!input.securityEventSink) {
    return;
  }

  recordSecurityEvent(input.securityEventSink, {
    actorId: input.payload.collectedBy ?? "worker:scheduled_compliance_evidence",
    metadata: {
      artifactRootConfigured: Boolean(input.payload.artifactRootDir),
      collectedByConfigured: Boolean(input.payload.collectedBy),
      ...(input.error
        ? { errorName: input.error instanceof Error ? input.error.name : "UnknownError" }
        : {}),
      ...(input.payload.limit ? { limit: input.payload.limit } : {}),
      orgScoped: Boolean(input.payload.orgId),
      reason: input.payload.reason ?? "scheduled",
      target: input.payload.target,
    },
    orgId: input.payload.orgId,
    resourceId: `${input.payload.target}:${input.payload.orgId ?? "global"}`,
    resourceType: "compliance_evidence_collection",
    severity: input.type === "compliance_evidence_failed" ? "high" : "info",
    source: "worker",
    type: input.type,
  });
}

/** Builds an initial product-safe manifest for a data-deletion request. */
function createDataDeletionManifest(payload: DataDeletionPlanJobPayload): DataDeletionManifest {
  const predicateDescription = dataDeletionPredicateDescription(payload);

  return {
    dbTables: dataDeletionTablesForScope(payload.scope).map((table) => ({
      predicateDescription,
      rowCountEstimate: 0,
      table,
    })),
    externalProviders: [
      ...(payload.reason === "app_uninstalled"
        ? [{ action: "revoke_installation_state", provider: "github" }]
        : []),
    ],
    objectKeys: [],
    queueKeys: [],
    requestId: payload.dataDeletionRequestId,
    vectorNamespaces: payload.repoId ? [payload.repoId] : [],
    ...(payload.orgId ? { orgId: payload.orgId } : {}),
    ...(payload.repoId ? { repoId: payload.repoId } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
  };
}

/** Returns tables that need inspection for one deletion scope. */
function dataDeletionTablesForScope(scope: DataDeletionPlanJobPayload["scope"]): readonly string[] {
  switch (scope) {
    case "organization":
      return [
        "provider_installations",
        "repositories",
        "background_jobs",
        "review_artifacts",
        "sandbox_runs",
        "code_chunk_embeddings",
        "memory_facts",
        "repo_rules",
      ];
    case "repository":
      return [
        "repositories",
        "repository_settings",
        "background_jobs",
        "pull_request_snapshots",
        "review_runs",
        "review_artifacts",
        "sandbox_runs",
        "code_chunk_embeddings",
        "memory_facts",
        "repo_rules",
      ];
    case "user":
      return ["users", "user_provider_accounts", "user_sessions", "org_memberships", "audit_logs"];
    case "review_run":
      return [
        "review_runs",
        "review_run_stage_events",
        "review_artifacts",
        "candidate_findings",
        "llm_calls",
        "sandbox_runs",
      ];
    case "artifact_class":
      return ["review_artifacts", "sandbox_artifacts", "llm_call_artifacts"];
  }
}

/** Returns the manifest predicate description for one deletion request. */
function dataDeletionPredicateDescription(payload: DataDeletionPlanJobPayload): string {
  if (payload.repoId) {
    return `repo_id = ${payload.repoId}`;
  }
  if (payload.orgId) {
    return `org_id = ${payload.orgId}`;
  }
  if (payload.userId) {
    return `user_id = ${payload.userId}`;
  }

  return `request_id = ${payload.dataDeletionRequestId}`;
}

/** Resolves the GitHub App private key through the security secret boundary. */
export async function resolveWorkerGitHubPrivateKey(
  env: WorkerSecretEnvironment,
  secretsManager: SecretsManager = createLocalEnvSecretsManager({ env }),
): Promise<string | undefined> {
  const secretRefValue =
    optionalEnvString(env.GITHUB_APP_PRIVATE_KEY_SECRET_REF) ??
    optionalEnvString(env.GITHUB_PRIVATE_KEY_SECRET_REF);
  const localEnvName = optionalEnvString(env.GITHUB_PRIVATE_KEY)
    ? "GITHUB_PRIVATE_KEY"
    : optionalEnvString(env.GITHUB_APP_PRIVATE_KEY)
      ? "GITHUB_APP_PRIVATE_KEY"
      : undefined;
  const secretRef = secretRefValue
    ? parseSecretRef(secretRefValue)
    : localEnvName
      ? parseSecretRef(`env:${localEnvName}`)
      : undefined;
  if (!secretRef) {
    return undefined;
  }

  const resolved = await secretsManager.resolveSecret(secretRef, {
    purpose: "github_app_private_key",
    service: "worker",
  });
  return resolved.value.replaceAll("\\n", "\n");
}

/** Resolves the worker LLM provider API key through the security secret boundary. */
export async function resolveWorkerLlmApiKey(
  env: WorkerLlmGatewayEnvironment,
  secretsManager: SecretsManager = createLocalEnvSecretsManager({ env }),
): Promise<string | undefined> {
  const secretRefValue = firstEnvValue(env, [
    "HEIMDALL_LLM_PROVIDER_API_KEY_SECRET_REF",
    "LLM_PROVIDER_API_KEY_SECRET_REF",
    "HEIMDALL_LLM_API_KEY_SECRET_REF",
    "OPENAI_API_KEY_SECRET_REF",
  ]);
  const localEnvName = firstEnvName(env, [
    "HEIMDALL_LLM_PROVIDER_API_KEY",
    "LLM_PROVIDER_API_KEY",
    "HEIMDALL_LLM_API_KEY",
    "OPENAI_API_KEY",
  ]);
  const secretRef = secretRefValue
    ? parseSecretRef(secretRefValue)
    : localEnvName
      ? parseSecretRef(`env:${localEnvName}`)
      : undefined;
  if (!secretRef) {
    return undefined;
  }

  const resolved = await secretsManager.resolveSecret(secretRef, {
    purpose: "llm_provider_api_key",
    service: "llm_gateway",
  });
  return resolved.value;
}

/** Resolves the worker embedding provider API key through the security secret boundary. */
export async function resolveWorkerEmbeddingApiKey(
  env: WorkerEmbeddingProviderEnvironment,
  secretsManager: SecretsManager = createLocalEnvSecretsManager({ env }),
): Promise<string | undefined> {
  const secretRefValue = firstEnvValue(env, [
    "HEIMDALL_EMBEDDING_API_KEY_SECRET_REF",
    "EMBEDDING_PROVIDER_API_KEY_SECRET_REF",
    "OPENAI_EMBEDDING_API_KEY_SECRET_REF",
    "OPENAI_API_KEY_SECRET_REF",
  ]);
  const localEnvName = firstEnvName(env, [
    "HEIMDALL_EMBEDDING_API_KEY",
    "EMBEDDING_PROVIDER_API_KEY",
    "OPENAI_EMBEDDING_API_KEY",
    "OPENAI_API_KEY",
  ]);
  const secretRef = secretRefValue
    ? parseSecretRef(secretRefValue)
    : localEnvName
      ? parseSecretRef(`env:${localEnvName}`)
      : undefined;
  if (!secretRef) {
    return undefined;
  }

  const resolved = await secretsManager.resolveSecret(secretRef, {
    purpose: "llm_provider_api_key",
    service: "worker",
  });
  return resolved.value;
}

/** Creates the optional worker LLM gateway selected by environment configuration. */
export async function createWorkerLlmGatewayFromEnvironment(
  env: WorkerLlmGatewayEnvironment,
  options: WorkerLlmGatewayOptions = {},
): Promise<LLMGateway | undefined> {
  if (env.HEIMDALL_REVIEW_SMOKE_FINDING === "true") {
    return createWorkerReviewSmokeGateway({
      ...(options.metrics ? { metrics: options.metrics } : {}),
      ...(options.traces ? { traces: options.traces } : {}),
    });
  }

  const providerName =
    optionalEnvString(env.HEIMDALL_LLM_PROVIDER) ?? optionalEnvString(env.LLM_PROVIDER);
  if (!providerName && !hasOpenAIProviderConfiguration(env)) {
    return undefined;
  }
  if (providerName && !isOpenAIProviderName(providerName)) {
    throw new Error(`Unsupported LLM_PROVIDER: ${providerName}`);
  }

  const reviewFindingsModel =
    optionalEnvString(env.HEIMDALL_LLM_REVIEW_FINDINGS_MODEL) ??
    optionalEnvString(env.LLM_REVIEW_FINDINGS_MODEL);
  const model =
    optionalEnvString(env.HEIMDALL_LLM_MODEL) ??
    optionalEnvString(env.LLM_MODEL) ??
    optionalEnvString(env.OPENAI_MODEL) ??
    reviewFindingsModel;
  if (!model) {
    throw new Error(
      "HEIMDALL_LLM_MODEL, LLM_MODEL, OPENAI_MODEL, or HEIMDALL_LLM_REVIEW_FINDINGS_MODEL is required when the OpenAI LLM provider is configured.",
    );
  }

  const apiKey = await resolveWorkerLlmApiKey(
    env,
    options.secretsManager ?? createLocalEnvSecretsManager({ env }),
  );
  if (!apiKey) {
    throw new Error(
      "LLM_PROVIDER_API_KEY_SECRET_REF, OPENAI_API_KEY_SECRET_REF, or OPENAI_API_KEY is required when the OpenAI LLM provider is configured.",
    );
  }

  const baseUrl =
    optionalEnvString(env.HEIMDALL_LLM_BASE_URL) ??
    optionalEnvString(env.LLM_PROVIDER_BASE_URL) ??
    optionalEnvString(env.OPENAI_BASE_URL);
  const modelProfile =
    optionalEnvString(env.HEIMDALL_LLM_MODEL_PROFILE) ??
    optionalEnvString(env.LLM_MODEL_PROFILE) ??
    "review_llm";
  const reviewFindingsModelProfile =
    optionalEnvString(env.HEIMDALL_LLM_REVIEW_FINDINGS_MODEL_PROFILE) ??
    optionalEnvString(env.LLM_REVIEW_FINDINGS_MODEL_PROFILE) ??
    REVIEW_FINDINGS_MODEL_PROFILE;
  const timeoutMs =
    optionalPositiveInteger(env.HEIMDALL_LLM_TIMEOUT_MS) ??
    optionalPositiveInteger(env.LLM_PROVIDER_TIMEOUT_MS) ??
    optionalPositiveInteger(env.OPENAI_TIMEOUT_MS);
  const budget = createWorkerLlmBudgetFromEnvironment(env);
  const openAIProviderOptions = {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
  const modelRoutes = reviewFindingsModel
    ? [
        {
          modelProfile: reviewFindingsModelProfile,
          provider: createOpenAIChatCompletionsProvider({
            ...openAIProviderOptions,
            model: reviewFindingsModel,
          }),
          task: "review.findings" as const,
        },
      ]
    : undefined;

  return createLLMGateway(
    createOpenAIChatCompletionsProvider({
      ...openAIProviderOptions,
      model,
    }),
    {
      ...(budget ? { budget } : {}),
      defaultModelProfile: reviewFindingsModel ? reviewFindingsModelProfile : modelProfile,
      ...(options.metrics ? { metrics: options.metrics } : {}),
      ...(modelRoutes ? { modelRoutes } : {}),
      ...(options.traces ? { traces: options.traces } : {}),
    },
  );
}

/** Creates the optional worker LLM input budget from environment configuration. */
export function createWorkerLlmBudgetFromEnvironment(
  env: WorkerLlmGatewayEnvironment,
): LLMGatewayBudgetPolicy | undefined {
  const maxPromptChars =
    optionalPositiveInteger(env.HEIMDALL_LLM_MAX_PROMPT_CHARS) ??
    optionalPositiveInteger(env.LLM_MAX_PROMPT_CHARS);
  const maxSystemChars =
    optionalPositiveInteger(env.HEIMDALL_LLM_MAX_SYSTEM_CHARS) ??
    optionalPositiveInteger(env.LLM_MAX_SYSTEM_CHARS);
  const maxTotalInputChars =
    optionalPositiveInteger(env.HEIMDALL_LLM_MAX_TOTAL_INPUT_CHARS) ??
    optionalPositiveInteger(env.LLM_MAX_TOTAL_INPUT_CHARS);

  if (!maxPromptChars && !maxSystemChars && !maxTotalInputChars) {
    return undefined;
  }

  return {
    ...(maxPromptChars ? { maxPromptChars } : {}),
    ...(maxSystemChars ? { maxSystemChars } : {}),
    ...(maxTotalInputChars ? { maxTotalInputChars } : {}),
  };
}

/** Creates the optional review index dependency mode from worker environment configuration. */
export function createWorkerReviewIndexDependencyModeFromEnvironment(
  env: WorkerReviewIndexDependencyEnvironment,
): ReviewIndexDependencyMode | undefined {
  const mode = optionalEnvString(env.HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE)?.toLowerCase();
  if (!mode) {
    return undefined;
  }
  if (mode === "fallback" || mode === "pause") {
    return mode;
  }

  throw new Error(`Unsupported HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE: ${mode}`);
}

/** Creates the worker embedding provider selected by environment configuration. */
export async function createWorkerEmbeddingProviderFromEnvironment(
  env: WorkerEmbeddingProviderEnvironment,
  options: WorkerEmbeddingProviderOptions = {},
): Promise<EmbeddingProvider> {
  const providerName =
    optionalEnvString(env.HEIMDALL_EMBEDDING_PROVIDER) ?? optionalEnvString(env.EMBEDDING_PROVIDER);

  if (!providerName || isLocalEmbeddingProviderName(providerName)) {
    return createEmbeddingProviderFromEnvironment(env, {
      ...(options.model ? { model: options.model } : {}),
    });
  }
  if (!isOpenAIEmbeddingProviderName(providerName)) {
    throw new Error(`Unsupported EMBEDDING_PROVIDER: ${providerName}`);
  }

  const model =
    options.model ??
    optionalEnvString(env.HEIMDALL_EMBEDDING_MODEL) ??
    optionalEnvString(env.EMBEDDING_MODEL) ??
    "text-embedding-3-small";
  const apiKey = await resolveWorkerEmbeddingApiKey(
    env,
    options.secretsManager ?? createLocalEnvSecretsManager({ env }),
  );
  if (!apiKey) {
    throw new Error(
      "EMBEDDING_PROVIDER_API_KEY_SECRET_REF, OPENAI_EMBEDDING_API_KEY_SECRET_REF, OPENAI_API_KEY_SECRET_REF, or OPENAI_API_KEY is required when the OpenAI embedding provider is configured.",
    );
  }

  const configuredDimensions =
    optionalPositiveInteger(env.HEIMDALL_EMBEDDING_DIMENSIONS) ??
    optionalPositiveInteger(env.EMBEDDING_DIMENSIONS);
  const baseUrl =
    optionalEnvString(env.HEIMDALL_EMBEDDING_BASE_URL) ??
    optionalEnvString(env.EMBEDDING_PROVIDER_BASE_URL) ??
    optionalEnvString(env.OPENAI_BASE_URL);
  const timeoutMs =
    optionalPositiveInteger(env.HEIMDALL_EMBEDDING_TIMEOUT_MS) ??
    optionalPositiveInteger(env.EMBEDDING_PROVIDER_TIMEOUT_MS) ??
    optionalPositiveInteger(env.OPENAI_TIMEOUT_MS);

  return createOpenAIEmbeddingProvider({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(configuredDimensions ? { dimensions: configuredDimensions } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    model,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

/** Options used to create a worker security-event sink backed by Postgres. */
export type WorkerPostgresSecurityEventSinkOptions = {
  /** Database facade that receives durable security events. */
  readonly db: HeimdallDatabase;
  /** Optional product-safe error hook for failed background writes. */
  readonly onError?: (error: unknown, event: SecurityEvent) => void;
};

/** Creates a worker security-event sink that writes normalized events to Postgres. */
export function createWorkerPostgresSecurityEventSink(
  options: WorkerPostgresSecurityEventSinkOptions,
): SecurityEventSink {
  return {
    record: (event) => {
      try {
        const write = new SecurityAuditRepository(options.db).recordSecurityEvent(
          workerSecurityEventRecordFromEvent(event),
        );
        void Promise.resolve(write).catch((error: unknown) => {
          options.onError?.(error, event);
        });
      } catch (error) {
        options.onError?.(error, event);
      }
    },
  };
}

/** Converts a normalized worker security event into a durable security event record. */
function workerSecurityEventRecordFromEvent(event: SecurityEvent): RecordSecurityEventInput {
  const createdAt = new Date(event.createdAt);
  return {
    actorId: event.actorId ?? null,
    createdAt,
    metadata: event.metadata,
    orgId: event.orgId ?? null,
    repoId: event.repoId ?? null,
    resourceId: event.resourceId ?? null,
    resourceType: event.resourceType ?? null,
    securityEventId: event.id,
    severity: event.severity,
    source: event.source,
    status: event.status,
    type: event.type,
  };
}

/** Starts BullMQ workers and a polling outbox dispatcher. */
export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  const observability = createObservabilityRuntime({
    defaultServiceName: "code-review-worker",
  });
  const config = loadRuntimeConfig();
  const githubPrivateKey = await resolveWorkerGitHubPrivateKey(process.env);
  if (!config.githubAppId || !githubPrivateKey) {
    throw new Error(
      "GITHUB_APP_ID and GITHUB_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_SECRET_REF are required to start workers.",
    );
  }

  const databaseClient = createDatabaseClient();
  const securityEventSink = createWorkerPostgresSecurityEventSink({
    db: databaseClient.db,
    onError: (error, event) => {
      observability.logger.warn("worker security event persistence failed", {
        attributes: {
          "error.name": error instanceof Error ? error.name : "UnknownError",
          "event.name": "worker.security_event.persistence_failed",
          "security_event.type": event.type,
        },
      });
    },
  });
  const store = new DrizzleDurableJobStore(databaseClient.db);
  const queueProducer = new BullMqQueueProducer(config.redisUrl);
  const workerConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const billingProvider = createWorkerBillingProviderFromEnv(databaseClient.db);
  const gitProvider = createGitHubProvider(
    {
      appId: config.githubAppId,
      privateKey: githubPrivateKey,
    },
    {
      metrics: observability.metrics,
      traces: observability.traces,
    },
  );
  const llmGateway = await createWorkerLlmGatewayFromEnvironment(process.env, {
    metrics: observability.metrics,
    traces: observability.traces,
  });
  const artifactPayloadStore = createWorkerReviewArtifactPayloadStoreFromEnv();
  const staticAnalysisRunner = createWorkerStaticAnalysisRunnerFromEnvironment(process.env, {
    db: databaseClient.db,
    metrics: observability.metrics,
    traces: observability.traces,
  });
  const publishThrottle = createRedisPublishThrottle(workerConnection);
  const indexerConfig = loadIndexerConfig(process.env, {
    defaultArtifactRootPath: DEFAULT_INDEX_ARTIFACT_ROOT,
    defaultTimeoutMs: DEFAULT_INDEXER_TIMEOUT_MS,
  });
  const indexArtifactResolver = createIndexArtifactResolverFromEnvironment(process.env);
  const indexArtifactStore =
    indexerConfig.artifactUploadMode === "object_storage"
      ? createIndexArtifactStoreFromEnvironment(process.env)
      : undefined;
  const indexImportRecordBatchSize = createIndexImportRecordBatchSizeFromEnvironment(process.env);
  const indexerTimeoutMs = indexerConfig.defaultTimeoutMs;
  const workspaceRoot = process.env.REPO_SYNC_WORKSPACE_ROOT;
  const repoSyncConfig = createRepoSyncConfig({
    ...(workspaceRoot ? { cacheRoot: workspaceRoot } : {}),
  });
  const indexArtifactRoot = indexerConfig.artifactRootPath;
  const queueMaintenance = createWorkerQueueMaintenanceConfig(process.env);
  const complianceEvidenceScheduler = createWorkerComplianceEvidenceSchedulerConfigFromEnvironment(
    process.env,
  );
  const retentionCleanupScheduler = createWorkerRetentionCleanupSchedulerConfigFromEnvironment(
    process.env,
  );
  const shouldRunComplianceEvidenceScheduler =
    shouldRunWorkerMaintenance(process.env) && complianceEvidenceScheduler.enabled;
  const shouldRunRetentionCleanupScheduler =
    shouldRunWorkerMaintenance(process.env) && retentionCleanupScheduler.enabled;
  const workerQueueNames = createWorkerQueueNamesFromEnvironment(process.env);
  const workerRoleLabel = createWorkerRoleLabelFromEnvironment(process.env);
  const queueMetricsClients = createWorkerQueueMetricsClients(process.env, workerConnection);
  const queueHealthRepository = new QueueHealthRepository(databaseClient.db);
  const reviewIndexDependencyMode = createWorkerReviewIndexDependencyModeFromEnvironment(
    process.env,
  );
  const indexerDriver =
    createWorkerIndexerDriverFromEnvironment(process.env, {
      indexerConfig,
      indexArtifactRoot,
      indexerTimeoutMs,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }) ?? createTypeScriptIndexerDriver();
  await verifyWorkerIndexerCapabilities(indexerDriver, { logger: observability.logger });
  await cleanupWorkerRepoSyncWorktrees({
    env: process.env,
    logger: observability.logger,
    repoSyncConfig,
  });
  const processor = createDurableJobProcessor({
    store,
    handlers: createWorkerHandlers({
      ...(billingProvider ? { billingProvider } : {}),
      db: databaseClient.db,
      gitProvider,
      securityEventSink,
      ...(llmGateway ? { llmGateway } : {}),
      ...(staticAnalysisRunner ? { staticAnalysisRunner } : {}),
      ...(reviewIndexDependencyMode ? { reviewIndexDependencyMode } : {}),
      ...(artifactPayloadStore ? { artifactPayloadStore } : {}),
      publishThrottle,
      repoSyncConfig,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      indexArtifactRoot,
      indexArtifactUploadMode: indexerConfig.artifactUploadMode,
      ...(indexArtifactStore ? { indexArtifactStore } : {}),
      indexArtifactResolver,
      indexImportRecordBatchSize,
      indexerDriver,
      ...(indexerTimeoutMs ? { indexerTimeoutMs } : {}),
      logger: observability.logger,
      metrics: observability.metrics,
      traces: observability.traces,
    }),
    metrics: observability.metrics,
    traces: observability.traces,
  });
  const recoverStaleRunningJobs = async () => {
    const jobRecovery = await store.recoverStaleRunningJobs({
      limit: queueMaintenance.recoveryBatchSize,
      staleAfterMs: queueMaintenance.staleRunningTimeoutMs,
    });
    if (jobRecovery.requeued > 0 || jobRecovery.deadLettered > 0) {
      observability.logger.warn("stale durable jobs recovered", {
        attributes: {
          "event.name": "worker.queue.stale_jobs_recovered",
          "job.dead_lettered": jobRecovery.deadLettered,
          "job.inspected": jobRecovery.inspected,
          "job.requeued": jobRecovery.requeued,
        },
      });
    }

    const indexImportRecovery = await reconcileStaleIndexImports({
      db: databaseClient.db,
      limit: queueMaintenance.indexImportRecoveryBatchSize,
      staleAfterMs: queueMaintenance.indexImportStaleTimeoutMs,
    });
    if (indexImportRecovery.importBatchCount > 0) {
      observability.logger.warn("stale index imports marked failed", {
        attributes: {
          "event.name": "worker.index_import.stale_imports_recovered",
          "index_import.batch_count": indexImportRecovery.importBatchCount,
          "index_import.index_version_count": indexImportRecovery.indexVersionIds.length,
        },
      });
    }
  };
  const workers = workerQueueNames.map(
    (queueName) => new Worker(queueName, processor, { connection: workerConnection }),
  );
  const dispatch = async () => {
    await dispatchPendingJobs({ store, queueProducer });
  };
  const recordQueueMetrics = async () => {
    await recordWorkerQueueMetrics({
      metrics: observability.metrics,
      queues: queueMetricsClients,
      snapshotStore: queueHealthRepository,
    });
  };
  const enqueueComplianceEvidenceCollection = async () => {
    const result = await enqueueScheduledComplianceEvidenceCollection(
      databaseClient.db,
      complianceEvidenceScheduler,
    );
    if (result.inserted) {
      observability.metrics.count(OBSERVABILITY_METRIC_NAMES.workerMaintenanceJobsScheduledTotal, {
        labels: {
          job_type: JOB_TYPES.ComplianceEvidenceCollect,
          scheduler: "compliance_evidence",
        },
      });
      observability.logger.info("scheduled compliance evidence collection enqueued", {
        attributes: {
          "compliance_evidence.job_key": result.jobKey,
          "compliance_evidence.scheduled_for": result.scheduledFor,
          "event.name": "worker.compliance_evidence.scheduled",
        },
      });
    }
  };
  const enqueueRetentionCleanupJobs = async () => {
    const result = await enqueueScheduledRetentionCleanupJobs(
      databaseClient.db,
      retentionCleanupScheduler,
    );
    if (result.insertedCount > 0) {
      observability.metrics.count(OBSERVABILITY_METRIC_NAMES.workerMaintenanceJobsScheduledTotal, {
        labels: {
          scheduler: "retention_cleanup",
        },
        value: result.insertedCount,
      });
      observability.logger.info("scheduled retention cleanup jobs enqueued", {
        attributes: {
          "event.name": "worker.retention_cleanup.scheduled",
          "retention_cleanup.inserted_count": result.insertedCount,
          "retention_cleanup.scheduled_for": result.scheduledFor,
        },
      });
    }
  };
  const dispatchInterval = setInterval(() => {
    dispatch().catch((error: unknown) => {
      observability.logger.error("outbox dispatch failed", {
        error,
        target: "worker.outbox",
      });
    });
  }, 5_000);
  const staleRunningRecoveryInterval = setInterval(() => {
    recoverStaleRunningJobs().catch((error: unknown) => {
      observability.logger.error("worker maintenance recovery failed", {
        error,
        target: "worker.maintenance",
      });
    });
  }, queueMaintenance.recoveryIntervalMs);
  const queueMetricsInterval =
    queueMetricsClients.length === 0
      ? undefined
      : setInterval(() => {
          recordQueueMetrics().catch((error: unknown) => {
            observability.logger.error("worker queue metrics failed", {
              error,
              target: "worker.queue_metrics",
            });
          });
        }, queueMaintenance.metricsIntervalMs);
  const complianceEvidenceSchedulerInterval = shouldRunComplianceEvidenceScheduler
    ? setInterval(() => {
        enqueueComplianceEvidenceCollection().catch((error: unknown) => {
          observability.metrics.count(
            OBSERVABILITY_METRIC_NAMES.workerMaintenanceSchedulerFailuresTotal,
            {
              labels: { scheduler: "compliance_evidence" },
            },
          );
          observability.logger.error("compliance evidence scheduler failed", {
            error,
            target: "worker.compliance_evidence_scheduler",
          });
        });
      }, complianceEvidenceScheduler.intervalMs)
    : undefined;
  const retentionCleanupSchedulerInterval = shouldRunRetentionCleanupScheduler
    ? setInterval(() => {
        enqueueRetentionCleanupJobs().catch((error: unknown) => {
          observability.metrics.count(
            OBSERVABILITY_METRIC_NAMES.workerMaintenanceSchedulerFailuresTotal,
            {
              labels: { scheduler: "retention_cleanup" },
            },
          );
          observability.logger.error("retention cleanup scheduler failed", {
            error,
            target: "worker.retention_cleanup_scheduler",
          });
        });
      }, retentionCleanupScheduler.intervalMs)
    : undefined;

  await recoverStaleRunningJobs();
  if (shouldRunComplianceEvidenceScheduler) {
    await enqueueComplianceEvidenceCollection();
  }
  if (shouldRunRetentionCleanupScheduler) {
    await enqueueRetentionCleanupJobs();
  }
  await dispatch();
  if (queueMetricsClients.length > 0) {
    await recordQueueMetrics();
  }
  observability.logger.info("worker service started", {
    attributes: {
      "event.name": "worker.service.started",
      "queue.count": workers.length,
      "queue.names": workerQueueNames.join(","),
      "worker.role": workerRoleLabel,
    },
  });
  observability.metrics.count(OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal, {
    labels: { status: "started" },
  });

  return {
    logger: observability.logger,
    close: async () => {
      clearInterval(dispatchInterval);
      clearInterval(staleRunningRecoveryInterval);
      if (queueMetricsInterval) {
        clearInterval(queueMetricsInterval);
      }
      if (complianceEvidenceSchedulerInterval) {
        clearInterval(complianceEvidenceSchedulerInterval);
      }
      if (retentionCleanupSchedulerInterval) {
        clearInterval(retentionCleanupSchedulerInterval);
      }
      observability.logger.info("worker service stopping", {
        attributes: { "event.name": "worker.service.stopping" },
      });
      observability.metrics.count(OBSERVABILITY_METRIC_NAMES.workerServiceStopsTotal, {
        labels: { status: "stopping" },
      });
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(queueMetricsClients.map((client) => client.close?.() ?? Promise.resolve()));
      await queueProducer.close();
      await workerConnection.quit();
      await databaseClient.close();
      await observability.shutdown();
    },
  };
}

/** Creates the optional review artifact payload store configured for the worker process. */
export function createWorkerReviewArtifactPayloadStoreFromEnv():
  | ReviewArtifactPayloadStore
  | undefined {
  const store = createReviewArtifactPayloadStoreFromEnvironment(process.env);

  return store instanceof InlineReviewArtifactPayloadStore ? undefined : store;
}

/** Creates the optional static-analysis runner selected by worker environment. */
export function createWorkerStaticAnalysisRunnerFromEnvironment(
  env: WorkerStaticAnalysisRunnerEnvironment,
  options: WorkerStaticAnalysisRunnerOptions = {},
): ToolRunner | undefined {
  const sandboxTelemetry = {
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.traces ? { traces: options.traces } : {}),
  };
  const sandboxRunner = createWorkerSandboxRunnerFromEnvironment(env, sandboxTelemetry);
  if (!sandboxRunner) {
    return undefined;
  }

  const instrumentedRunner = withSandboxTelemetry(sandboxRunner, sandboxTelemetry);

  return createSandboxToolRunner({
    runner: options.db
      ? createPersistingSandboxRunner(instrumentedRunner, options.db)
      : instrumentedRunner,
  });
}

/** Creates the optional sandbox runner selected by worker environment. */
function createWorkerSandboxRunnerFromEnvironment(
  env: WorkerStaticAnalysisRunnerEnvironment,
  telemetry: SandboxTelemetryOptions = {},
): SandboxRunner | undefined {
  const runnerName = (env.STATIC_ANALYSIS_RUNNER ?? env.SANDBOX_RUNNER ?? "off").trim();
  if (
    runnerName === "" ||
    runnerName === "off" ||
    runnerName === "none" ||
    runnerName === "disabled"
  ) {
    return undefined;
  }

  if (runnerName === "fake") {
    return createFakeSandboxRunner();
  }

  if (runnerName === "local_process") {
    return createLocalProcessSandboxRunner({ nodeEnv: env.NODE_ENV });
  }

  if (runnerName === "docker") {
    return createDockerContainerSandboxRunner(createWorkerDockerRunnerOptions(env, telemetry));
  }

  if (runnerName === "gvisor") {
    return createGVisorSandboxRunner(createWorkerDockerRunnerOptions(env, telemetry));
  }

  throw new Error(`Unsupported SANDBOX_RUNNER: ${runnerName}`);
}

/** Creates Docker sandbox runner options from non-secret worker environment values. */
function createWorkerDockerRunnerOptions(
  env: WorkerStaticAnalysisRunnerEnvironment,
  telemetry: SandboxTelemetryOptions = {},
): DockerContainerSandboxRunnerOptions {
  return {
    ...(nonEmptyEnv(env.SANDBOX_ARTIFACT_ROOT)
      ? { artifactRoot: nonEmptyEnv(env.SANDBOX_ARTIFACT_ROOT) }
      : {}),
    ...(nonEmptyEnv(env.SANDBOX_DOCKER_EXECUTABLE)
      ? { dockerExecutable: nonEmptyEnv(env.SANDBOX_DOCKER_EXECUTABLE) }
      : {}),
    ...(nonEmptyEnv(env.SANDBOX_DOCKER_RUNTIME)
      ? { runtime: nonEmptyEnv(env.SANDBOX_DOCKER_RUNTIME) }
      : {}),
    ...(nonEmptyEnv(env.SANDBOX_TEMP_ROOT)
      ? { temporaryRoot: nonEmptyEnv(env.SANDBOX_TEMP_ROOT) }
      : {}),
    dockerProcessEnv: dockerProcessEnvironmentFromWorkerEnv(env),
    ...(telemetry.metrics || telemetry.traces || telemetry.traceContext ? { telemetry } : {}),
  };
}

/** Returns Docker CLI process environment values safe to pass from the worker host. */
function dockerProcessEnvironmentFromWorkerEnv(
  env: WorkerStaticAnalysisRunnerEnvironment,
): Readonly<Record<string, string>> {
  const path = nonEmptyEnv(env.PATH);

  return path ? { PATH: path } : {};
}

/** Returns a trimmed non-empty environment value. */
function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Wraps a sandbox runner so completed runs are persisted to the worker database. */
function createPersistingSandboxRunner(runner: SandboxRunner, db: HeimdallDatabase): SandboxRunner {
  return {
    run: async (request) => {
      const result = await runner.run(request);
      await persistSandboxRun(db, request, result);

      return result;
    },
  };
}

/** Persists one sandbox request/result pair and replaces child rows idempotently. */
async function persistSandboxRun(
  db: HeimdallDatabase,
  request: SandboxRunRequest,
  result: SandboxRunResult,
): Promise<void> {
  const sandboxRepository = new SandboxRepository(db);

  await sandboxRepository.upsertSandboxRunWithChildren({
    artifacts: sandboxArtifactRowsFromResult(result),
    policyDecisions: sandboxPolicyDecisionRowsFromRequestResult(request, result),
    run: sandboxRunRowFromRequestResult(request, result),
  });
}

/** Summary returned after one sandbox cleanup pass. */
export type SandboxCleanupSummary = {
  /** Cutoff used to select sandbox runs. */
  readonly cutoff: string;
  /** Whether the cleanup only planned work. */
  readonly dryRun: boolean;
  /** Number of sandbox run rows selected. */
  readonly selectedRunCount: number;
  /** Number of sandbox run rows deleted. */
  readonly deletedRunCount: number;
  /** Number of local artifact files deleted. */
  readonly deletedArtifactFileCount: number;
  /** Number of artifact URIs skipped because they are not local files or could not be removed. */
  readonly skippedArtifactFileCount: number;
};

/** Deletes old sandbox run rows and best-effort local artifact files. */
export async function cleanupSandboxRuns(
  db: HeimdallDatabase,
  payload: SandboxCleanupJobPayload,
  now: Date = new Date(),
): Promise<SandboxCleanupSummary> {
  const cutoff = sandboxCleanupCutoff(payload, now);
  const limit = payload.limit ?? 100;
  const dryRun = payload.dryRun ?? false;
  const sandboxRepository = new SandboxRepository(db);
  const selectedRuns = await sandboxRepository.listSandboxRunCleanupTargets({
    cutoff,
    limit,
    repoId: payload.repoId,
  });
  const sandboxRunIds = selectedRuns.map((row) => row.sandboxRunId);
  const artifactRows = await sandboxRepository.listSandboxArtifactUrisForRuns(sandboxRunIds);

  if (dryRun || sandboxRunIds.length === 0) {
    return {
      cutoff: cutoff.toISOString(),
      deletedArtifactFileCount: 0,
      deletedRunCount: 0,
      dryRun,
      selectedRunCount: sandboxRunIds.length,
      skippedArtifactFileCount: 0,
    };
  }

  const artifactCleanup = await removeSandboxArtifactFiles(artifactRows.map((row) => row.uri));
  await sandboxRepository.deleteSandboxRuns(sandboxRunIds);

  return {
    cutoff: cutoff.toISOString(),
    deletedArtifactFileCount: artifactCleanup.deletedFileCount,
    deletedRunCount: sandboxRunIds.length,
    dryRun,
    selectedRunCount: sandboxRunIds.length,
    skippedArtifactFileCount: artifactCleanup.skippedFileCount,
  };
}

/** Summary returned after one review artifact cleanup pass. */
export type ReviewArtifactCleanupSummary = {
  /** Cutoff used to select expired review artifacts. */
  readonly cutoff: string;
  /** Whether the cleanup only planned work. */
  readonly dryRun: boolean;
  /** Number of review artifact rows selected. */
  readonly selectedArtifactCount: number;
  /** Number of payloads removed from backing storage or inline metadata. */
  readonly deletedPayloadCount: number;
  /** Number of payloads that were already missing from backing storage. */
  readonly missingPayloadCount: number;
  /** Number of review artifact rows updated with a deletion tombstone. */
  readonly updatedArtifactCount: number;
  /** Number of payloads skipped because deletion failed and should be retried. */
  readonly failedPayloadCount: number;
};

/** Deletes expired review artifact payload bytes and leaves product-safe tombstone metadata. */
export async function cleanupExpiredReviewArtifacts(
  db: HeimdallDatabase,
  payload: ReviewArtifactCleanupJobPayload,
  artifactPayloadStore: ReviewArtifactPayloadStore = new InlineReviewArtifactPayloadStore(),
  now: Date = new Date(),
): Promise<ReviewArtifactCleanupSummary> {
  const cutoff = reviewArtifactCleanupCutoff(payload, now);
  const dryRun = payload.dryRun ?? false;
  const reviewRepository = new ReviewRepository(db);
  const artifactRows = await reviewRepository.listExpiredReviewArtifactCleanupTargets({
    cutoff,
    excludeUriPrefix: DELETED_REVIEW_ARTIFACT_URI_PREFIX,
    limit: payload.limit ?? 100,
    ...(payload.repoId ? { repoId: payload.repoId } : {}),
  });

  if (dryRun || artifactRows.length === 0) {
    return {
      cutoff: cutoff.toISOString(),
      deletedPayloadCount: 0,
      dryRun,
      failedPayloadCount: 0,
      missingPayloadCount: 0,
      selectedArtifactCount: artifactRows.length,
      updatedArtifactCount: 0,
    };
  }

  let deletedPayloadCount = 0;
  let missingPayloadCount = 0;
  let updatedArtifactCount = 0;
  let failedPayloadCount = 0;
  const deletedAt = now.toISOString();
  const reason = payload.reason ?? "retention_policy";

  for (const artifact of artifactRows) {
    try {
      const result = await artifactPayloadStore.deleteJson({
        metadata: artifact.metadata,
        uri: artifact.uri,
      });
      if (result.deleted) {
        deletedPayloadCount += 1;
      } else {
        missingPayloadCount += 1;
      }

      await reviewRepository.updateReviewArtifactPayloadTombstone({
        metadata: reviewArtifactPayloadDeletedMetadata({
          deletedAt,
          metadata: artifact.metadata,
          reason,
        }),
        reviewArtifactId: artifact.reviewArtifactId,
        sizeBytes: 0,
        uri: deletedReviewArtifactUri(artifact.reviewArtifactId),
      });
      updatedArtifactCount += 1;
    } catch {
      failedPayloadCount += 1;
    }
  }

  return {
    cutoff: cutoff.toISOString(),
    deletedPayloadCount,
    dryRun,
    failedPayloadCount,
    missingPayloadCount,
    selectedArtifactCount: artifactRows.length,
    updatedArtifactCount,
  };
}

/** Computes the sandbox cleanup cutoff date. */
function sandboxCleanupCutoff(payload: SandboxCleanupJobPayload, now: Date): Date {
  if (payload.before) {
    return new Date(payload.before);
  }

  return new Date(now.getTime() - (payload.olderThanDays ?? 30) * 24 * 60 * 60 * 1000);
}

/** Computes the review artifact cleanup cutoff date. */
function reviewArtifactCleanupCutoff(payload: ReviewArtifactCleanupJobPayload, now: Date): Date {
  return payload.before ? new Date(payload.before) : now;
}

/** Returns a non-readable URI for a payload that retention cleanup removed. */
function deletedReviewArtifactUri(reviewArtifactId: string): string {
  return `${DELETED_REVIEW_ARTIFACT_URI_PREFIX}${reviewArtifactId}`;
}

/** Local artifact file cleanup counters. */
type SandboxArtifactFileCleanup = {
  /** Number of local files deleted. */
  readonly deletedFileCount: number;
  /** Number of artifact URIs skipped. */
  readonly skippedFileCount: number;
};

/** Removes local file artifacts referenced by sandbox artifact rows. */
async function removeSandboxArtifactFiles(
  artifactUris: readonly string[],
): Promise<SandboxArtifactFileCleanup> {
  let deletedFileCount = 0;
  let skippedFileCount = 0;

  for (const artifactUri of artifactUris) {
    if (!artifactUri.startsWith("file:")) {
      skippedFileCount += 1;
      continue;
    }

    try {
      const artifactPath = fileURLToPath(artifactUri);
      await rm(artifactPath, { force: true });
      await removeEmptyDirectory(dirname(artifactPath));
      deletedFileCount += 1;
    } catch {
      skippedFileCount += 1;
    }
  }

  return { deletedFileCount, skippedFileCount };
}

/** Removes a directory only when it is already empty. */
async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      isNodeErrorWithCode(error, "ENOENT") ||
      isNodeErrorWithCode(error, "ENOTEMPTY") ||
      isNodeErrorWithCode(error, "EEXIST")
    ) {
      return;
    }

    throw error;
  }
}

/** Narrows Node-style filesystem errors by code. */
function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Creates the persisted row for a sandbox run. */
function sandboxRunRowFromRequestResult(
  request: SandboxRunRequest,
  result: SandboxRunResult,
): SandboxRunInsert {
  return {
    category: request.category,
    commandJson: request.command,
    createdAt: new Date(request.createdAt),
    errorJson: result.error ?? null,
    exitCode: result.exitCode,
    finishedAt: new Date(result.finishedAt),
    image: request.image.image,
    imageDigest: request.image.digest ?? null,
    limitsJson: request.limits,
    orgId: request.orgId,
    policyJson: sandboxPolicyJsonFromRequest(request, result),
    repoId: request.repoId,
    requestId: request.requestId,
    resourceUsageJson: result.resourceUsage ?? null,
    reviewRunId: request.reviewRunId ?? null,
    runnerKind: result.runner.kind,
    sandboxRunId: result.runId,
    signal: result.signal ?? null,
    startedAt: new Date(result.startedAt),
    staticAnalysisRunId: request.staticAnalysisRunId ?? null,
    status: result.status,
    stderrHash: result.stderr.hash,
    stderrTruncated: result.stderr.truncated,
    stdoutHash: result.stdout.hash,
    stdoutTruncated: result.stdout.truncated,
    toolRunId: request.toolRunId ?? null,
    trustLevel: request.trustLevel,
    updatedAt: new Date(result.finishedAt),
    warningsJson: result.warnings,
  };
}

/** Creates persisted artifact rows for a sandbox run result. */
function sandboxArtifactRowsFromResult(result: SandboxRunResult): readonly SandboxArtifactInsert[] {
  return result.artifacts.map((artifact) => ({
    contentType: artifact.contentType ?? null,
    name: artifact.name,
    sandboxArtifactId: stableWorkerId("sart", [result.runId, artifact.name]),
    sandboxRunId: result.runId,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    truncated: artifact.truncated,
    uri: artifact.uri,
  }));
}

/** Creates persisted policy decision rows for a sandbox run result. */
function sandboxPolicyDecisionRowsFromRequestResult(
  request: SandboxRunRequest,
  result: SandboxRunResult,
): readonly SandboxPolicyDecisionInsert[] {
  return result.policyDecisions.map((decision, index) => ({
    code: decision.code,
    details: {
      index,
      requestId: request.requestId,
    },
    message: decision.message,
    sandboxPolicyDecisionId: stableWorkerId("spol", [
      result.runId,
      index,
      decision.status,
      decision.code,
    ]),
    sandboxRunId: result.runId,
    status: decision.status,
  }));
}

/** Returns product-safe sandbox policy metadata without environment values. */
function sandboxPolicyJsonFromRequest(
  request: SandboxRunRequest,
  result: SandboxRunResult,
): Record<string, unknown> {
  return {
    artifacts: request.artifacts,
    environment: {
      envKeys: Object.keys(request.environment.env).sort(),
      redactedEnvKeys: request.environment.redactedEnvKeys,
    },
    mounts: request.mounts,
    network: request.network,
    output: request.output,
    policyDecisions: result.policyDecisions,
    security: request.security,
    workspace: request.workspace,
  };
}

/** Creates the optional worker indexer driver selected by environment configuration. */
export function createWorkerIndexerDriverFromEnvironment(
  env: WorkerIndexerDriverEnvironment,
  options: {
    /** Durable directory used to store indexer CLI request, logs, and artifact output. */
    readonly indexArtifactRoot: string;
    /** Parsed indexer runtime configuration. */
    readonly indexerConfig?: IndexerConfig;
    /** Optional parent directory for repo-sync workspaces. */
    readonly workspaceRoot?: string;
    /** Maximum time allowed for one indexer run. */
    readonly indexerTimeoutMs?: number;
  },
): CodeIndexerDriver | undefined {
  const indexerConfig =
    options.indexerConfig ??
    loadIndexerConfig(env, {
      defaultArtifactRootPath: options.indexArtifactRoot,
      ...(options.indexerTimeoutMs ? { defaultTimeoutMs: options.indexerTimeoutMs } : {}),
    });

  if (indexerConfig.driver === "in_process_ts") {
    return undefined;
  }
  if (indexerConfig.driver === "fake") {
    return createFakeIndexerDriver();
  }
  if (indexerConfig.driver === "remote") {
    return createRemoteIndexerDriver({
      baseUrl: indexerConfig.remote.baseUrl ?? "",
      ...(indexerConfig.remote.bearerToken
        ? { bearerToken: indexerConfig.remote.bearerToken }
        : {}),
      maxPollMs: indexerConfig.remote.maxPollMs,
      pollIntervalMs: indexerConfig.remote.pollIntervalMs,
      validationMode: indexerConfig.validateArtifacts
        ? indexerConfig.validateRecordMode
        : "manifest_only",
      validationSampleSize: indexerConfig.validationSampleSize,
    });
  }

  return createCliIndexerDriver({
    artifactRootPath: indexerConfig.artifactRootPath,
    command: indexerConfig.cli.executablePath ?? "",
    envAllowlist: indexerConfig.cli.envAllowlist,
    ...(indexerConfig.cli.extraArgs.length > 0 ? { args: indexerConfig.cli.extraArgs } : {}),
    killGraceMs: indexerConfig.cli.killGraceMs,
    stderrMaxBytes: indexerConfig.cli.stderrMaxBytes,
    stdoutMaxBytes: indexerConfig.cli.stdoutMaxBytes,
    timeoutMs: Math.min(indexerConfig.defaultTimeoutMs, indexerConfig.maxTimeoutMs),
    validationMode: indexerConfig.validateArtifacts
      ? indexerConfig.validateRecordMode
      : "manifest_only",
    validationSampleSize: indexerConfig.validationSampleSize,
    ...(options.workspaceRoot ? { workspaceRootPath: options.workspaceRoot } : {}),
  });
}

/** Options used while verifying worker indexer capabilities. */
export type VerifyWorkerIndexerCapabilitiesOptions = {
  /** Optional structured logger that receives product-safe capability metadata. */
  readonly logger?: StructuredTelemetryLogger;
};

/** Verifies the selected worker indexer before accepting jobs. */
export async function verifyWorkerIndexerCapabilities(
  driver: CodeIndexerDriver,
  options: VerifyWorkerIndexerCapabilitiesOptions = {},
): Promise<IndexerCapabilities> {
  const capabilities = await driver.getCapabilities();
  assertIndexerSupportsCurrentArtifactSchema(capabilities);
  options.logger?.info("indexer capabilities verified", {
    attributes: {
      "indexer.driver_name": capabilities.driverName,
      "indexer.driver_version": capabilities.driverVersion,
      "indexer.remote_artifacts_supported": capabilities.supportsRemoteArtifacts,
      "indexer.supported_artifact_schema_version_count":
        capabilities.supportedArtifactSchemaVersions.length,
      "indexer.supported_language_count": capabilities.supportedLanguages.length,
      "indexer.supported_record_type_count": capabilities.supportedRecordTypes.length,
    },
    target: "worker.indexer",
  });

  return capabilities;
}

/** Records queue depth and oldest-pending-age gauges for each sampled worker queue. */
export async function recordWorkerQueueMetrics(
  input: RecordWorkerQueueMetricsInput,
): Promise<void> {
  const sampledAt = input.now ?? new Date();
  const nowMs = sampledAt.getTime();
  const snapshots = await Promise.all(
    input.queues.map(async (queue) => {
      const counts = await queue.getJobCounts(...WORKER_QUEUE_METRIC_STATUSES);
      const normalizedCounts = {
        active: nonNegativeMetricValue(counts.active),
        completed: nonNegativeMetricValue(counts.completed),
        delayed: nonNegativeMetricValue(counts.delayed),
        failed: nonNegativeMetricValue(counts.failed),
        waiting: nonNegativeMetricValue(counts.waiting),
      } as const satisfies Readonly<Record<WorkerQueueMetricStatus, number>>;

      for (const status of WORKER_QUEUE_METRIC_STATUSES) {
        input.metrics.gauge(OBSERVABILITY_METRIC_NAMES.queueDepth, normalizedCounts[status], {
          labels: {
            queue_name: queue.queueName,
            status,
          },
        });
      }

      const oldestJobs = await queue.getJobs(WORKER_QUEUE_OLDEST_JOB_STATUSES, 0, 0, true);
      const oldestTimestamp = oldestQueueJobTimestamp(oldestJobs);
      const oldestWaitingAgeMs =
        oldestTimestamp === undefined ? 0 : Math.max(0, nowMs - oldestTimestamp);
      input.metrics.gauge(OBSERVABILITY_METRIC_NAMES.queueOldestJobAgeMs, oldestWaitingAgeMs, {
        labels: {
          queue_name: queue.queueName,
        },
      });

      return {
        activeCount: normalizedCounts.active,
        completedCount: normalizedCounts.completed,
        delayedCount: normalizedCounts.delayed,
        failedCount: normalizedCounts.failed,
        oldestWaitingAgeMs,
        queueName: queue.queueName,
        sampledAt,
        waitingCount: normalizedCounts.waiting,
      };
    }),
  );

  if (input.snapshotStore && snapshots.length > 0) {
    await input.snapshotStore.recordQueueHealthSnapshots({ snapshots });
  }
}

/** Creates queue metric clients for all logical queues when this runtime owns health sampling. */
function createWorkerQueueMetricsClients(
  env: WorkerRuntimeRoleEnvironment,
  connection: IORedis,
): readonly WorkerQueueMetricsClient[] {
  if (!shouldRecordWorkerQueueMetrics(env)) {
    return [];
  }

  return ALL_WORKER_QUEUE_NAMES.map((queueName) => {
    const queue = new BullMqQueue(queueName, { connection });
    return {
      close: () => queue.close(),
      getJobCounts: (...statuses) => queue.getJobCounts(...statuses),
      getJobs: (statuses, start, end, asc) => queue.getJobs([...statuses], start, end, asc),
      queueName,
    };
  });
}

/** Returns whether this worker runtime should emit global queue health gauges. */
function shouldRecordWorkerQueueMetrics(env: WorkerRuntimeRoleEnvironment): boolean {
  return shouldRunWorkerMaintenance(env);
}

/** Returns whether this worker runtime owns global maintenance responsibilities. */
function shouldRunWorkerMaintenance(env: WorkerRuntimeRoleEnvironment): boolean {
  const roles = createWorkerRolesFromEnvironment(env);
  return roles.includes("all") || roles.includes("maintenance");
}

/** Creates the queue names registered by this worker runtime from environment role values. */
export function createWorkerQueueNamesFromEnvironment(
  env: WorkerRuntimeRoleEnvironment,
): readonly QueueName[] {
  const roles = createWorkerRolesFromEnvironment(env);
  if (roles.includes("all")) {
    return ALL_WORKER_QUEUE_NAMES;
  }

  const queueNames = new Set<QueueName>();
  for (const role of roles) {
    for (const queueName of queueNamesForWorkerRole(role)) {
      queueNames.add(queueName);
    }
  }

  return [...queueNames];
}

/** Creates normalized worker runtime roles from environment values. */
function createWorkerRolesFromEnvironment(
  env: WorkerRuntimeRoleEnvironment,
): readonly WorkerRuntimeRole[] {
  const configuredRoles =
    optionalEnvString(env.HEIMDALL_WORKER_ROLE) ?? optionalEnvString(env.WORKER_ROLE) ?? "all";
  const roles = configuredRoles
    .split(/[,\s]+/)
    .map((role) => role.trim())
    .filter((role) => role.length > 0)
    .map(normalizeWorkerRuntimeRole);

  if (roles.length === 0) {
    return ["all"];
  }

  return [...new Set(roles)];
}

/** Creates the original worker role label used in startup logs. */
function createWorkerRoleLabelFromEnvironment(env: WorkerRuntimeRoleEnvironment): string {
  return optionalEnvString(env.HEIMDALL_WORKER_ROLE) ?? optionalEnvString(env.WORKER_ROLE) ?? "all";
}

/** Normalizes one configured worker role value. */
function normalizeWorkerRuntimeRole(value: string): WorkerRuntimeRole {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "all") {
    return "all";
  }
  if (normalized === "repo-sync" || normalized === "github-sync" || normalized === "sync") {
    return "repo-sync";
  }
  if (normalized === "index" || normalized === "indexing") {
    return "indexing";
  }
  if (normalized === "embedding" || normalized === "embeddings") {
    return "embedding";
  }
  if (normalized === "review" || normalized === "reviews") {
    return "review";
  }
  if (normalized === "memory") {
    return "memory";
  }
  if (normalized === "publish" || normalized === "publisher" || normalized === "publishing") {
    return "publishing";
  }
  if (normalized === "billing") {
    return "billing";
  }
  if (normalized === "security") {
    return "security";
  }
  if (normalized === "maintenance" || normalized === "maint") {
    return "maintenance";
  }

  throw new Error(`Unsupported worker role: ${value}`);
}

/** Returns the queues owned by one normalized worker role. */
function queueNamesForWorkerRole(role: WorkerRuntimeRole): readonly QueueName[] {
  switch (role) {
    case "all":
      return ALL_WORKER_QUEUE_NAMES;
    case "repo-sync":
      return [QUEUE_NAMES.repoSync];
    case "indexing":
      return [QUEUE_NAMES.indexing];
    case "embedding":
      return [QUEUE_NAMES.embedding];
    case "review":
      return [QUEUE_NAMES.review];
    case "memory":
      return [QUEUE_NAMES.memory];
    case "publishing":
      return [QUEUE_NAMES.publishing];
    case "billing":
      return [QUEUE_NAMES.billing];
    case "security":
      return [QUEUE_NAMES.security];
    case "maintenance":
      return [];
  }
}

/** Coerces untrusted queue metric counts to non-negative finite values. */
function nonNegativeMetricValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Returns the oldest finite job timestamp from sampled queue jobs. */
function oldestQueueJobTimestamp(jobs: readonly WorkerQueueMetricJob[]): number | undefined {
  const timestamps = jobs
    .map((job) => job.timestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === "number")
    .filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length === 0 ? undefined : Math.min(...timestamps);
}

/** Creates queue maintenance settings from worker environment values. */
function createWorkerQueueMaintenanceConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkerQueueMaintenanceConfig {
  return {
    indexImportRecoveryBatchSize:
      optionalPositiveInteger(env.HEIMDALL_INDEX_IMPORT_STALE_RECOVERY_BATCH_SIZE) ??
      DEFAULT_STALE_INDEX_IMPORT_RECOVERY_BATCH_SIZE,
    indexImportStaleTimeoutMs:
      optionalPositiveInteger(env.HEIMDALL_INDEX_IMPORT_STALE_TIMEOUT_MS) ??
      DEFAULT_STALE_INDEX_IMPORT_TIMEOUT_MS,
    metricsIntervalMs:
      optionalPositiveInteger(env.HEIMDALL_QUEUE_METRICS_INTERVAL_MS) ??
      DEFAULT_QUEUE_METRICS_INTERVAL_MS,
    recoveryBatchSize:
      optionalPositiveInteger(env.HEIMDALL_QUEUE_STALE_RUNNING_JOB_RECOVERY_BATCH_SIZE) ??
      DEFAULT_STALE_RUNNING_JOB_RECOVERY_BATCH_SIZE,
    recoveryIntervalMs:
      optionalPositiveInteger(env.HEIMDALL_QUEUE_STALE_RUNNING_JOB_RECOVERY_INTERVAL_MS) ??
      DEFAULT_STALE_RUNNING_JOB_RECOVERY_INTERVAL_MS,
    staleRunningTimeoutMs:
      optionalPositiveInteger(env.HEIMDALL_QUEUE_STALE_RUNNING_JOB_TIMEOUT_MS) ??
      DEFAULT_STALE_RUNNING_JOB_TIMEOUT_MS,
  };
}

/** Creates recurring compliance evidence scheduler settings from worker environment values. */
export function createWorkerComplianceEvidenceSchedulerConfigFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): WorkerComplianceEvidenceSchedulerConfig {
  const orgId = optionalEnvString(env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_ORG_ID);

  return {
    artifactRootDir:
      optionalEnvString(env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_ARTIFACT_ROOT) ??
      optionalEnvString(env.HEIMDALL_COMPLIANCE_EVIDENCE_ARTIFACT_ROOT) ??
      DEFAULT_COMPLIANCE_EVIDENCE_ARTIFACT_ROOT,
    collectedBy:
      optionalEnvString(env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_COLLECTED_BY) ??
      DEFAULT_COMPLIANCE_EVIDENCE_SCHEDULER_ACTOR,
    enabled: optionalEnvBoolean(env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_ENABLED) ?? true,
    intervalMs:
      optionalPositiveInteger(env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_INTERVAL_MS) ??
      DEFAULT_COMPLIANCE_EVIDENCE_SCHEDULER_INTERVAL_MS,
    limit:
      optionalPositiveInteger(env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_LIMIT) ??
      DEFAULT_COMPLIANCE_EVIDENCE_SCHEDULER_LIMIT,
    ...(orgId ? { orgId } : {}),
    target: complianceEvidenceCollectTargetFromEnvironment(
      env.HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_TARGET,
    ),
  };
}

/** Creates recurring retention cleanup scheduler settings from worker environment values. */
export function createWorkerRetentionCleanupSchedulerConfigFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): WorkerRetentionCleanupSchedulerConfig {
  return {
    dryRun: optionalEnvBoolean(env.HEIMDALL_RETENTION_CLEANUP_SCHEDULER_DRY_RUN) ?? false,
    enabled: optionalEnvBoolean(env.HEIMDALL_RETENTION_CLEANUP_SCHEDULER_ENABLED) ?? true,
    intervalMs:
      optionalPositiveInteger(env.HEIMDALL_RETENTION_CLEANUP_SCHEDULER_INTERVAL_MS) ??
      DEFAULT_RETENTION_CLEANUP_SCHEDULER_INTERVAL_MS,
    limit:
      optionalPositiveInteger(env.HEIMDALL_RETENTION_CLEANUP_SCHEDULER_LIMIT) ??
      DEFAULT_RETENTION_CLEANUP_SCHEDULER_LIMIT,
    sandboxOlderThanDays:
      optionalPositiveInteger(env.HEIMDALL_SANDBOX_CLEANUP_OLDER_THAN_DAYS) ??
      DEFAULT_SANDBOX_RETENTION_CLEANUP_OLDER_THAN_DAYS,
  };
}

/** Parses a positive integer environment value. */
function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parses an optional boolean environment value. */
function optionalEnvBoolean(value: string | undefined): boolean | undefined {
  const normalized = optionalEnvString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

/** Parses the scheduled compliance evidence target from an environment value. */
function complianceEvidenceCollectTargetFromEnvironment(
  value: string | undefined,
): ComplianceEvidenceCollectJobPayload["target"] {
  const normalized = optionalEnvString(value)?.toLowerCase();
  switch (normalized) {
    case undefined:
    case "all":
      return "all";
    case "access-review":
    case "access_review":
    case "access_review_export":
      return "access_review_export";
    case "audit-log":
    case "audit_log":
    case "audit_log_export":
      return "audit_log_export";
    case "security-event":
    case "security-events":
    case "security_event":
    case "security_events":
    case "security_event_export":
      return "security_event_export";
    case "config":
    case "config-snapshot":
    case "config_snapshot":
      return "config_snapshot";
    default:
      throw new Error(`Unsupported HEIMDALL_COMPLIANCE_EVIDENCE_SCHEDULER_TARGET: ${value}`);
  }
}

/** Reads a non-empty environment string. */
function optionalEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Returns the first configured environment variable value from an ordered list. */
function firstEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  const name = firstEnvName(env, names);
  return name ? optionalEnvString(env[name]) : undefined;
}

/** Returns the first configured environment variable name from an ordered list. */
function firstEnvName(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    if (optionalEnvString(env[name])) {
      return name;
    }
  }

  return undefined;
}

/** Returns whether OpenAI provider settings are present without an explicit provider selector. */
function hasOpenAIProviderConfiguration(env: WorkerLlmGatewayEnvironment): boolean {
  return Boolean(
    firstEnvValue(env, [
      "HEIMDALL_LLM_MODEL",
      "LLM_MODEL",
      "OPENAI_MODEL",
      "HEIMDALL_LLM_REVIEW_FINDINGS_MODEL",
      "LLM_REVIEW_FINDINGS_MODEL",
    ]),
  );
}

/** Returns whether a provider selector names a local embedding provider. */
function isLocalEmbeddingProviderName(value: string): boolean {
  const normalized = normalizeProviderSelector(value);

  return normalized === "hash" || normalized === "fake" || normalized === "local";
}

/** Returns whether a provider selector names an OpenAI-compatible embeddings provider. */
function isOpenAIEmbeddingProviderName(value: string): boolean {
  const normalized = normalizeProviderSelector(value);

  return (
    normalized === "openai" ||
    normalized === "openai_compatible" ||
    normalized === "openai_embeddings"
  );
}

/** Returns whether a provider selector names an OpenAI-compatible provider. */
function isOpenAIProviderName(value: string): boolean {
  const normalized = normalizeProviderSelector(value);

  return (
    normalized === "openai" ||
    normalized === "openai_chat_completions" ||
    normalized === "openai_compatible"
  );
}

/** Normalizes provider selectors from configuration into low-cardinality tokens. */
function normalizeProviderSelector(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
}

/** Creates a deterministic smoke-only gateway for live PR review smoke runs. */
export function createWorkerReviewSmokeGateway(
  options: {
    /** Optional metric recorder used for smoke LLM gateway telemetry. */
    readonly metrics?: TelemetryMetricRecorder;
    /** Optional span recorder used for smoke LLM gateway telemetry. */
    readonly traces?: TelemetrySpanRecorder;
  } = {},
): LLMGateway {
  const provider: LLMProvider = {
    id: "worker_smoke",
    generateObject: async (input) =>
      parseWithSchema(input.schemaName, input.schema, createSmokeFindingOutput(input.prompt)),
  };

  return createLLMGateway(provider, {
    defaultModelProfile: "review_smoke",
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.traces ? { traces: options.traces } : {}),
  });
}

type SmokePromptFile = {
  /** Repository path for the changed file. */
  readonly path: string;
  /** GitHub file status from the prompt snapshot. */
  readonly status?: string;
  /** Whether the prompt marks the file as generated. */
  readonly isGenerated?: boolean;
  /** Parsed diff hunks for the file. */
  readonly hunks: readonly {
    /** Parsed hunk lines from the prompt. */
    readonly lines: readonly {
      /** Diff line kind, such as addition or context. */
      readonly kind?: string;
      /** 1-based line number on the new side of the diff. */
      readonly newLine?: number;
    }[];
  }[];
};

/** Creates a smoke finding output anchored to the first added diff line. */
function createSmokeFindingOutput(prompt: string): LLMFindingOutput {
  const file = firstSmokeReviewableFile(prompt);
  if (!file) {
    return { findings: [] };
  }

  return {
    findings: [
      {
        path: file.path,
        line: file.line,
        severity: "low",
        category: "maintainability",
        title: "Live PR review smoke test",
        body: "This controlled finding proves the guarded live PR review smoke reached the publisher.",
        evidence: ["The smoke worker gateway selected an added diff line from the live PR."],
        confidence: 1,
      },
    ],
  };
}

function firstSmokeReviewableFile(
  prompt: string,
): { readonly path: string; readonly line: number } | undefined {
  const parsed = parseSmokePrompt(prompt);
  const files = Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [];

  for (const value of files) {
    const file = parseSmokePromptFile(value);
    if (!file || file.status === "deleted" || file.isGenerated === true) {
      continue;
    }

    for (const hunk of file.hunks) {
      const line = hunk.lines.find((candidate) => candidate.kind === "addition")?.newLine;
      if (line) {
        return { path: file.path, line };
      }
    }
  }

  return undefined;
}

/** Parses the review prompt JSON object used by the smoke gateway. */
function parseSmokePrompt(prompt: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(prompt) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parses one changed-file entry from the smoke review prompt. */
function parseSmokePromptFile(value: unknown): SmokePromptFile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") {
    return undefined;
  }

  return {
    path: record.path,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.isGenerated === "boolean" ? { isGenerated: record.isGenerated } : {}),
    hunks: Array.isArray(record.hunks) ? record.hunks.map(parseSmokePromptHunk) : [],
  };
}

/** Parses one hunk entry from the smoke review prompt. */
function parseSmokePromptHunk(value: unknown): SmokePromptFile["hunks"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { lines: [] };
  }

  const record = value as Record<string, unknown>;
  return {
    lines: Array.isArray(record.lines) ? record.lines.map(parseSmokePromptLine) : [],
  };
}

/** Parses one hunk line entry from the smoke review prompt. */
function parseSmokePromptLine(value: unknown): SmokePromptFile["hunks"][number]["lines"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.newLine === "number" ? { newLine: record.newLine } : {}),
  };
}

/** Loads a GitHub installation reference from a Heimdall installation ID. */
export async function loadGitHubInstallationRef(
  db: HeimdallDatabase,
  installationId: string,
): Promise<GitHubInstallationRuntimeRef> {
  const installation = await new ProviderInstallationRepository(db).getProviderInstallation(
    installationId,
  );

  if (!installation || installation.provider !== "github") {
    throw new Error(`GitHub installation ${installationId} was not found.`);
  }

  return {
    provider: "github",
    installationId: installation.installationId,
    providerInstallationId: installation.providerInstallationId,
    orgId: installation.orgId,
  };
}

/** Writes an index artifact to durable local storage and returns its file URI. */
export async function persistIndexArtifact(artifact: IndexArtifact, root: string): Promise<string> {
  const artifactPath = join(
    resolve(root),
    artifact.manifest.repoId,
    artifact.manifest.commitSha,
    artifactFileName(artifact),
  );
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return pathToFileURL(artifactPath).toString();
}

/** Stores an index artifact for importer URI handoff according to the selected upload mode. */
export async function persistIndexArtifactForImport(input: {
  /** Complete artifact returned by the selected indexer driver. */
  readonly artifact: IndexArtifact;
  /** Optional object-storage URI returned by the selected indexer driver. */
  readonly sourceArtifactUri?: string;
  /** Local artifact root used when upload mode is `local_only`. */
  readonly root: string;
  /** Upload mode selected by central indexer runtime configuration. */
  readonly uploadMode: IndexerConfig["artifactUploadMode"];
  /** Object-storage writer required when upload mode is `object_storage`. */
  readonly artifactStore?: IndexArtifactStore;
}): Promise<string> {
  if (input.uploadMode === "object_storage") {
    if (!input.artifactStore) {
      throw new Error(
        "Index artifact object-storage upload mode requires an index artifact store.",
      );
    }

    const storedArtifact =
      input.sourceArtifactUri && input.artifactStore.copyArtifact
        ? await input.artifactStore.copyArtifact({
            artifact: input.artifact,
            sourceUri: input.sourceArtifactUri,
          })
        : await input.artifactStore.putArtifact(input.artifact);
    return storedArtifact.uri;
  }

  return persistIndexArtifact(input.artifact, input.root);
}

/** Creates a filesystem-safe artifact filename from the artifact content hash. */
function artifactFileName(artifact: IndexArtifact): string {
  const artifactHash =
    artifact.manifest.artifactHash ??
    `sha256:${createHash("sha256").update(JSON.stringify(artifact)).digest("hex")}`;

  return `${artifactHash.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** Loads a GitHub repository reference from an index job payload. */
export async function loadGitHubRepositoryRef(
  db: HeimdallDatabase,
  payload: IndexRepoCommitJobPayload,
): Promise<GitHubRepositoryRef> {
  const repository = await new RepositoryRepository(db).getRepositoryProviderRef({
    installationId: payload.installationId,
    provider: "github",
    repoId: payload.repoId,
  });

  if (!repository) {
    throw new Error(`GitHub repository ${payload.repoId} was not found.`);
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

/** Processes a memory update job that was produced by a finding outcome. */
async function updateMemoryFromFindingOutcome(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
): Promise<void> {
  if (payload.reason !== "finding_outcome" || !payload.outcomeId || !payload.findingId) {
    return;
  }

  const reviewRepository = new ReviewRepository(db);
  const outcome = await reviewRepository.getFindingOutcome(payload.outcomeId);
  if (!outcome || outcome.outcome !== "rejected") {
    return;
  }

  const finding = await reviewRepository.getReviewFindingByAnyId(payload.findingId);
  if (!finding) {
    return;
  }

  await new MemoryCandidateRepository(db).createMemoryCandidateIfAbsent(
    memoryCandidateFromRejectedFindingOutcome({
      finding,
      outcome,
      publishedFindingId: outcome.publishedFindingId ?? finding.publishedFindingId ?? undefined,
    }),
  );
}

/** Reconciles recent provider thread state when a scheduled memory job requests it. */
async function reconcileScheduledProviderThreadFeedback(
  db: HeimdallDatabase,
  gitProvider: GitProvider,
  payload: UpdateMemoryJobPayload,
  receivedAt: string,
  telemetry: MemoryTelemetryOptions = {},
): Promise<void> {
  if (payload.reason !== "scheduled" || !gitProvider.fetchReviewThreadStates) {
    return;
  }

  const targets = await loadRecentReviewThreadReconciliationTargets(db, payload);
  for (const target of targets) {
    const states = await gitProvider.fetchReviewThreadStates({
      provider: "github",
      installationId: target.installationId,
      providerInstallationId: target.providerInstallationId,
      owner: target.owner,
      repo: target.repo,
      providerRepoId: target.providerRepoId,
      pullRequestNumber: target.pullRequestNumber,
    });
    await recordReconciledReviewThreadStates(db, target, states, receivedAt, telemetry);
  }
}

/** Review-run context needed to reconcile provider review-thread state. */
type ReviewThreadReconciliationTarget = {
  /** Heimdall installation ID. */
  readonly installationId: string;
  /** GitHub installation ID. */
  readonly providerInstallationId: string;
  /** GitHub repository owner. */
  readonly owner: string;
  /** GitHub repository name. */
  readonly repo: string;
  /** GitHub repository ID. */
  readonly providerRepoId: string;
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** GitHub pull request number. */
  readonly pullRequestNumber: number;
  /** Review run being reconciled. */
  readonly reviewRunId: string;
};

/** Loads recent completed review runs that can have review-thread state reconciled. */
async function loadRecentReviewThreadReconciliationTargets(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
): Promise<readonly ReviewThreadReconciliationTarget[]> {
  const repository = await new RepositoryRepository(db).getRepositoryProviderRef({
    provider: "github",
    repoId: payload.repoId,
  });
  if (!repository) {
    return [];
  }

  const runs = await new ReviewRepository(db).listRecentCompletedReviewRuns({
    limit: THREAD_RECONCILIATION_REVIEW_RUN_LIMIT,
    ...(payload.pullRequestNumber ? { pullRequestNumber: payload.pullRequestNumber } : {}),
    repoId: payload.repoId,
  });

  return runs.map((run) => ({
    installationId: repository.installationId,
    providerInstallationId: repository.providerInstallationId,
    owner: repository.owner,
    pullRequestNumber: run.pullRequestNumber,
    providerRepoId: repository.providerRepoId,
    repo: repository.repo,
    repoId: payload.repoId,
    reviewRunId: run.reviewRunId,
  }));
}

/** Records provider-derived reconciliation events for resolved and unresolved review threads. */
async function recordReconciledReviewThreadStates(
  db: HeimdallDatabase,
  target: ReviewThreadReconciliationTarget,
  states: readonly ExistingReviewThreadState[],
  receivedAt: string,
  telemetry: MemoryTelemetryOptions,
): Promise<void> {
  for (const state of states) {
    const action = state.isResolved ? "resolved" : "unresolved";
    const feedbackKind = state.isResolved ? "thread_resolved" : "thread_unresolved";
    const externalEventId = providerFeedbackStableId("fb", [
      "github",
      "pull_request_review_thread",
      action,
      state.providerThreadId,
    ]);

    for (const externalCommentId of state.providerCommentIds) {
      await recordOutcomeFromProviderFeedback(
        db,
        {
          externalCommentId,
          externalEventId,
          externalThreadId: state.providerThreadId,
          feedbackKind,
          feedbackSource: "reconciliation",
          provider: "github",
          pullRequestNumber: target.pullRequestNumber,
          reason: "comment_thread",
          repoId: target.repoId,
        },
        receivedAt,
        telemetry,
      );
    }
  }
}

/** Records a provider-webhook outcome after feedback has been correlated by provider comment ID. */
async function recordOutcomeFromProviderFeedback(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
  receivedAt: string,
  telemetry: MemoryTelemetryOptions = {},
): Promise<void> {
  if (
    (payload.reason !== "comment_reply" &&
      payload.reason !== "comment_thread" &&
      payload.reason !== "provider_reaction") ||
    (!payload.externalCommentId && !payload.externalParentCommentId && !payload.externalThreadId)
  ) {
    return;
  }

  const outcome = outcomeFromProviderFeedbackKind(
    payload.feedbackKind,
    payload.feedbackCommand?.commandKind,
  );
  if (!outcome && !payload.feedbackCommand) {
    return;
  }

  const published = await findPublishedFindingForProviderFeedback(db, payload);
  if (!published) {
    await recordSummaryFeedbackCommand(db, payload, receivedAt, telemetry);
    return;
  }

  const feedbackEvent = providerFeedbackEventFromPayload(
    payload,
    {
      orgId: published.orgId,
      publishedFindingId: published.publishedFindingId,
      repoId: published.repoId,
      reviewRunId: published.finding.reviewRunId,
    },
    receivedAt,
  );
  await persistFeedbackEventAndSignals(db, feedbackEvent, feedbackCommandFromPayload(payload));

  if (outcome) {
    await new ReviewRepository(db).insertFindingOutcomeIfAbsent({
      candidateFindingId: published.candidateFindingId,
      findingOutcomeId: stableWorkerId("out", [
        "provider_feedback",
        payload.externalEventId ??
          payload.externalReactionId ??
          payload.externalParentCommentId ??
          payload.externalCommentId ??
          payload.externalThreadId,
      ]),
      metadata: providerFeedbackOutcomeMetadata(payload),
      occurredAt: new Date(receivedAt),
      orgId: published.orgId,
      outcome,
      publishedFindingId: published.publishedFindingId,
      repoId: published.repoId,
      source: "provider_webhook",
    });
  }

  await createMemoryCandidatesFromProviderCommand(db, payload, published, receivedAt, telemetry);
}

/** Records trusted feedback commands that target a PR summary comment. */
async function recordSummaryFeedbackCommand(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
  receivedAt: string,
  telemetry: MemoryTelemetryOptions = {},
): Promise<void> {
  const command = feedbackCommandFromPayload(payload);
  if (!command || !payload.externalCommentId) {
    return;
  }

  const summary = await findPublishedSummaryForProviderFeedback(db, payload);
  if (!summary) {
    return;
  }

  const feedbackEvent = providerFeedbackEventFromPayload(
    payload,
    {
      orgId: summary.orgId,
      repoId: summary.repoId,
      reviewRunId: summary.reviewRunId,
    },
    receivedAt,
  );
  await persistFeedbackEventAndSignals(db, feedbackEvent, command);

  const candidates = createMemoryCandidatesFromCommand({
    command,
    createdAt: receivedAt,
    createdByLogin: payload.actorLogin,
    ...(telemetry.metrics ? { metrics: telemetry.metrics } : {}),
    orgId: summary.orgId,
    repoId: summary.repoId,
    ...(telemetry.traceContext ? { traceContext: telemetry.traceContext } : {}),
    ...(telemetry.traces ? { traces: telemetry.traces } : {}),
  });

  for (const candidate of candidates) {
    await new MemoryCandidateRepository(db).createMemoryCandidateIfAbsent(
      memoryCandidateFromSummaryCommandCandidate({ candidate, payload, summary }),
    );
  }
}

/** Finds a published finding row from provider feedback metadata. */
async function findPublishedFindingForProviderFeedback(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
): Promise<PublishedFindingFeedbackTargetRecord | undefined> {
  const commentIds = uniqueStrings([payload.externalParentCommentId, payload.externalCommentId]);
  return new ReviewRepository(db).getPublishedFindingFeedbackTarget({
    commentIds,
    provider: payload.provider ?? "github",
  });
}

/** Finds a published PR summary comment row from provider feedback metadata. */
async function findPublishedSummaryForProviderFeedback(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
): Promise<PublishedSummaryFeedbackTargetRecord | undefined> {
  const commentIds = uniqueStrings([payload.externalCommentId]);
  return new ReviewRepository(db).getPublishedSummaryFeedbackTarget({
    commentIds,
    provider: payload.provider ?? "github",
  });
}

/** Provider feedback context used to build normalized feedback events. */
type ProviderFeedbackEventContext = {
  /** Organization that owns the feedback target. */
  readonly orgId: string;
  /** Repository that owns the feedback target. */
  readonly repoId: string;
  /** Review run associated with the feedback target. */
  readonly reviewRunId: string;
  /** Published finding row when the feedback targets an inline finding. */
  readonly publishedFindingId?: string | undefined;
};

/** Builds a normalized durable feedback event from a provider memory job payload. */
function providerFeedbackEventFromPayload(
  payload: UpdateMemoryJobPayload,
  context: ProviderFeedbackEventContext,
  receivedAt: string,
): FeedbackEvent {
  return {
    id: stableWorkerId("fevt", [
      "provider_feedback",
      payload.externalEventId ??
        payload.externalReactionId ??
        payload.externalParentCommentId ??
        payload.externalCommentId ??
        receivedAt,
    ]),
    orgId: context.orgId,
    repoId: context.repoId,
    provider: payload.provider ?? "github",
    source: payload.feedbackSource ?? "webhook",
    eventKind: feedbackEventKindFromPayload(payload),
    ...(payload.externalEventId ? { externalEventId: payload.externalEventId } : {}),
    ...(payload.actorLogin
      ? {
          actor: {
            providerLogin: payload.actorLogin,
            isBot: payload.actorLogin.endsWith("[bot]"),
          },
        }
      : {}),
    ...(payload.pullRequestNumber ? { pullRequestNumber: payload.pullRequestNumber } : {}),
    reviewRunId: context.reviewRunId,
    ...(context.publishedFindingId ? { publishedFindingId: context.publishedFindingId } : {}),
    ...((payload.externalParentCommentId ?? payload.externalCommentId)
      ? { externalCommentId: payload.externalParentCommentId ?? payload.externalCommentId }
      : {}),
    ...(payload.externalThreadId ? { externalThreadId: payload.externalThreadId } : {}),
    payloadRedacted: providerFeedbackPayloadRedacted(payload),
    receivedAt,
  };
}

/** Persists one normalized feedback event and its deterministic classified signals. */
async function persistFeedbackEventAndSignals(
  db: HeimdallDatabase,
  event: FeedbackEvent,
  command: FeedbackCommand | undefined,
): Promise<void> {
  const feedbackRepository = new FeedbackRepository(db);
  await feedbackRepository.createFeedbackEventIfAbsent(feedbackEventInput(event));

  const signals = classifyFeedbackEvent({ command, event });
  for (const signal of signals) {
    await feedbackRepository.createFeedbackSignalIfAbsent(feedbackSignalInput(signal));
  }
}

/** Converts one memory feedback event into the repository insert shape. */
function feedbackEventInput(event: FeedbackEvent): CreateFeedbackEventInput {
  return {
    actorIsBot: event.actor?.isBot ?? false,
    ...(event.actor?.association ? { actorAssociation: event.actor.association } : {}),
    ...(event.actor?.providerLogin ? { actorLogin: event.actor.providerLogin } : {}),
    ...(event.actor?.permission ? { actorPermission: event.actor.permission } : {}),
    ...(event.actor?.providerUserId ? { actorProviderUserId: event.actor.providerUserId } : {}),
    eventKind: event.eventKind,
    ...(event.externalCommentId ? { externalCommentId: event.externalCommentId } : {}),
    ...(event.externalEventId ? { externalEventId: event.externalEventId } : {}),
    ...(event.externalThreadId ? { externalThreadId: event.externalThreadId } : {}),
    feedbackEventId: event.id,
    orgId: event.orgId,
    payloadRedacted: event.payloadRedacted,
    provider: event.provider,
    ...(event.publishedFindingId ? { publishedFindingId: event.publishedFindingId } : {}),
    ...(event.pullRequestNumber ? { pullRequestNumber: event.pullRequestNumber } : {}),
    receivedAt: new Date(event.receivedAt),
    repoId: event.repoId,
    ...(event.reviewRunId ? { reviewRunId: event.reviewRunId } : {}),
    source: event.source,
    ...(event.webhookEventId ? { webhookEventId: event.webhookEventId } : {}),
  };
}

/** Converts one memory feedback signal into the repository insert shape. */
function feedbackSignalInput(signal: FeedbackSignal): CreateFeedbackSignalInput {
  return {
    confidence: signal.confidence,
    createdAt: new Date(signal.createdAt),
    feedbackEventId: signal.feedbackEventId,
    feedbackSignalId: signal.id,
    polarity: signal.polarity,
    ...(signal.publishedFindingId ? { publishedFindingId: signal.publishedFindingId } : {}),
    reason: signal.reason,
    signalKind: signal.signalKind,
    strength: signal.strength,
  };
}

/** Maps provider memory-job metadata to the normalized feedback event vocabulary. */
function feedbackEventKindFromPayload(payload: UpdateMemoryJobPayload): FeedbackEventKind {
  if (payload.reason === "comment_thread") {
    return payload.feedbackKind === "thread_unresolved"
      ? "review_thread_unresolved"
      : "review_thread_resolved";
  }
  if (payload.reason === "provider_reaction") {
    return "reaction_added";
  }
  if (payload.externalParentCommentId) {
    return payload.feedbackKind === "comment_deleted"
      ? "review_comment_deleted"
      : payload.feedbackKind === "comment_edited"
        ? "review_comment_edited"
        : "review_comment_created";
  }
  return payload.feedbackKind === "comment_deleted"
    ? "issue_comment_deleted"
    : payload.feedbackKind === "comment_edited"
      ? "issue_comment_edited"
      : "issue_comment_created";
}

/** Builds product-safe provider feedback metadata for timeline inspection. */
function providerFeedbackPayloadRedacted(payload: UpdateMemoryJobPayload): Record<string, unknown> {
  return {
    ...(payload.bodyHash ? { bodyHash: payload.bodyHash } : {}),
    ...(payload.externalCommentId ? { externalCommentId: payload.externalCommentId } : {}),
    ...(payload.externalEventId ? { externalEventId: payload.externalEventId } : {}),
    ...(payload.externalParentCommentId
      ? { externalParentCommentId: payload.externalParentCommentId }
      : {}),
    ...(payload.externalReactionId ? { externalReactionId: payload.externalReactionId } : {}),
    ...(payload.externalThreadId ? { externalThreadId: payload.externalThreadId } : {}),
    ...(payload.feedbackKind ? { feedbackKind: payload.feedbackKind } : {}),
    ...(payload.feedbackSource ? { feedbackSource: payload.feedbackSource } : {}),
    ...(payload.feedbackCommand
      ? {
          feedbackCommand: {
            commandHash: payload.feedbackCommand.commandHash,
            commandKind: payload.feedbackCommand.commandKind,
            confidence: payload.feedbackCommand.confidence,
          },
        }
      : {}),
    reason: payload.reason,
  };
}

/** Maps provider feedback kind to the durable finding outcome vocabulary. */
function outcomeFromProviderFeedbackKind(
  feedbackKind: string | undefined,
  commandKind: string | undefined,
): string | undefined {
  if (commandKind === "mark_false_positive") {
    return "rejected";
  }
  if (commandKind === "mark_not_useful") {
    return "ignored";
  }
  if (
    commandKind === "suppress_exact" ||
    commandKind === "suppress_similar" ||
    commandKind === "disable_category_in_scope"
  ) {
    return "dismissed";
  }
  if (feedbackKind === "positive_reaction") {
    return "positive_reaction";
  }
  if (feedbackKind === "negative_reaction") {
    return "negative_reaction";
  }
  if (feedbackKind === "thread_resolved") {
    return "resolved";
  }
  if (feedbackKind === "thread_unresolved") {
    return "commented";
  }
  if (
    feedbackKind === "comment_reply" ||
    feedbackKind === "comment_edited" ||
    feedbackKind === "comment_deleted"
  ) {
    return "commented";
  }
  return undefined;
}

/** Creates pending memory candidates from a trusted provider feedback command. */
async function createMemoryCandidatesFromProviderCommand(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
  published: {
    readonly finding: {
      readonly body: string;
      readonly category: string;
      readonly confidence: number;
      readonly findingId: string;
      readonly fingerprint: string;
      readonly location: unknown;
      readonly reviewRunId: string;
      readonly severity: string;
      readonly title: string;
    };
    readonly orgId: string;
    readonly publishedFindingId: string;
    readonly repoId: string;
  },
  receivedAt: string,
  telemetry: MemoryTelemetryOptions = {},
): Promise<void> {
  const command = feedbackCommandFromPayload(payload);
  if (!command) {
    return;
  }

  if (command.commandKind === "mark_false_positive") {
    await new MemoryCandidateRepository(db).createMemoryCandidateIfAbsent(
      memoryCandidateFromProviderFalsePositiveCommand({ command, payload, published }),
    );
    return;
  }

  const candidates = createMemoryCandidatesFromCommand({
    command,
    createdAt: receivedAt,
    createdByLogin: payload.actorLogin,
    findingFingerprint: published.finding.fingerprint,
    ...(telemetry.metrics ? { metrics: telemetry.metrics } : {}),
    orgId: published.orgId,
    repoId: published.repoId,
    ...(telemetry.traceContext ? { traceContext: telemetry.traceContext } : {}),
    ...(telemetry.traces ? { traces: telemetry.traces } : {}),
  });

  for (const candidate of candidates) {
    await new MemoryCandidateRepository(db).createMemoryCandidateIfAbsent(
      memoryCandidateFromCommandCandidate({ candidate, payload, published }),
    );
  }
}

/** Rebuilds the memory-package command contract from redacted job payload metadata. */
function feedbackCommandFromPayload(payload: UpdateMemoryJobPayload): FeedbackCommand | undefined {
  const command = payload.feedbackCommand;
  if (!command) {
    return undefined;
  }

  return {
    commandKind: command.commandKind,
    rawText: command.commandHash,
    confidence: command.confidence,
    ...(command.content ? { content: command.content } : {}),
    ...(command.proposedScope
      ? {
          scope: parseWithSchema(
            "MemoryScope",
            MemoryScopeSchema,
            command.proposedScope,
          ) as MemoryScope,
        }
      : {}),
    ...(command.proposedAppliesTo
      ? {
          appliesTo: parseWithSchema(
            "MemoryAppliesTo",
            MemoryAppliesToSchema,
            command.proposedAppliesTo,
          ) as MemoryAppliesTo,
        }
      : {}),
  };
}

/** Converts a memory-package candidate into the durable database insert shape. */
function memoryCandidateFromCommandCandidate(input: {
  /** Memory-package candidate created from a parsed command. */
  readonly candidate: MemoryCandidate;
  /** Provider feedback job payload. */
  readonly payload: UpdateMemoryJobPayload;
  /** Published finding that the provider feedback was correlated to. */
  readonly published: {
    readonly publishedFindingId: string;
  };
}): CreateMemoryCandidateInput {
  return {
    candidateKind: input.candidate.candidateKind,
    confidence: input.candidate.confidence,
    memoryCandidateId: input.candidate.id,
    metadata: providerFeedbackCommandMetadata(input.payload),
    orgId: input.candidate.orgId,
    proposedAppliesTo: input.candidate.proposedAppliesTo,
    proposedContent: input.candidate.proposedContent,
    proposedScope: input.candidate.proposedScope,
    ...(input.candidate.repoId ? { repoId: input.candidate.repoId } : {}),
    ...(input.candidate.createdByLogin ? { createdByLogin: input.candidate.createdByLogin } : {}),
    sourceFeedbackEventId: input.payload.externalEventId,
    sourceFindingId: input.published.publishedFindingId,
    sourceKind: input.candidate.sourceKind,
    status: input.candidate.status,
    trustLevel: input.candidate.trustLevel,
  };
}

/** Converts a summary-comment command candidate into the durable database insert shape. */
function memoryCandidateFromSummaryCommandCandidate(input: {
  /** Memory-package candidate created from a parsed PR summary command. */
  readonly candidate: MemoryCandidate;
  /** Provider feedback job payload. */
  readonly payload: UpdateMemoryJobPayload;
  /** Published summary comment that received the feedback command. */
  readonly summary: {
    readonly publishedSummaryCommentId: string;
    readonly reviewRunId: string;
  };
}): CreateMemoryCandidateInput {
  return {
    candidateKind: input.candidate.candidateKind,
    confidence: input.candidate.confidence,
    memoryCandidateId: stableWorkerId("mcand", [
      "summary_command",
      input.payload.externalEventId ??
        input.payload.externalCommentId ??
        input.summary.publishedSummaryCommentId,
      input.candidate.id,
    ]),
    metadata: {
      ...providerFeedbackCommandMetadata(input.payload),
      publishedSummaryCommentId: input.summary.publishedSummaryCommentId,
      reviewRunId: input.summary.reviewRunId,
    },
    orgId: input.candidate.orgId,
    proposedAppliesTo: input.candidate.proposedAppliesTo,
    proposedContent: input.candidate.proposedContent,
    proposedScope: input.candidate.proposedScope,
    ...(input.candidate.repoId ? { repoId: input.candidate.repoId } : {}),
    ...(input.candidate.createdByLogin ? { createdByLogin: input.candidate.createdByLogin } : {}),
    sourceFeedbackEventId: input.payload.externalEventId,
    sourceKind: input.candidate.sourceKind,
    status: input.candidate.status,
    trustLevel: input.candidate.trustLevel,
  };
}

/** Builds a pending suppression candidate for an explicit provider false-positive command. */
function memoryCandidateFromProviderFalsePositiveCommand(input: {
  /** Rebuilt memory command. */
  readonly command: FeedbackCommand;
  /** Provider feedback job payload. */
  readonly payload: UpdateMemoryJobPayload;
  /** Published finding that the provider feedback was correlated to. */
  readonly published: {
    readonly finding: {
      readonly category: string;
      readonly confidence: number;
      readonly findingId: string;
      readonly fingerprint: string;
      readonly location: unknown;
      readonly reviewRunId: string;
      readonly severity: string;
      readonly title: string;
    };
    readonly orgId: string;
    readonly publishedFindingId: string;
    readonly repoId: string;
  };
}): CreateMemoryCandidateInput {
  const path = pathFromFindingLocation(input.published.finding.location);
  return {
    candidateKind: "suppress_similar_finding",
    confidence: Math.max(0.5, Math.min(0.98, input.command.confidence)),
    ...(input.payload.actorLogin ? { createdByLogin: input.payload.actorLogin } : {}),
    memoryCandidateId: stableWorkerId("mcand", [
      "provider_command",
      input.payload.externalEventId ??
        input.payload.externalCommentId ??
        input.published.publishedFindingId,
      input.command.commandKind,
    ]),
    metadata: {
      ...providerFeedbackCommandMetadata(input.payload),
      category: input.published.finding.category,
      findingId: input.published.finding.findingId,
      reviewRunId: input.published.finding.reviewRunId,
      severity: input.published.finding.severity,
      title: input.published.finding.title,
      ...(path ? { path } : {}),
    },
    orgId: input.published.orgId,
    proposedAppliesTo: {
      categories: [input.published.finding.category],
      findingFingerprints: [input.published.finding.fingerprint],
      ...(path ? { pathGlobs: [path] } : {}),
      titlePatterns: [input.published.finding.title],
    },
    proposedContent: `Suppress similar findings: ${input.published.finding.title}`,
    proposedScope: {
      findingFingerprints: [input.published.finding.fingerprint],
      level: "finding_fingerprint",
      orgId: input.published.orgId,
      repoId: input.published.repoId,
    },
    repoId: input.published.repoId,
    sourceFeedbackEventId: input.payload.externalEventId,
    sourceFindingId: input.published.publishedFindingId,
    sourceKind: "command",
    status: "pending",
    trustLevel: "explicit_maintainer",
  };
}

/** Builds redacted metadata for provider feedback outcome rows. */
function providerFeedbackOutcomeMetadata(payload: UpdateMemoryJobPayload): Record<string, unknown> {
  return {
    ...(payload.actorLogin ? { actorLogin: payload.actorLogin } : {}),
    ...(payload.bodyHash ? { bodyHash: payload.bodyHash } : {}),
    ...(payload.externalCommentId ? { externalCommentId: payload.externalCommentId } : {}),
    ...(payload.externalEventId ? { externalEventId: payload.externalEventId } : {}),
    ...(payload.externalParentCommentId
      ? { externalParentCommentId: payload.externalParentCommentId }
      : {}),
    ...(payload.externalReactionId ? { externalReactionId: payload.externalReactionId } : {}),
    ...(payload.externalThreadId ? { externalThreadId: payload.externalThreadId } : {}),
    ...(payload.feedbackKind ? { feedbackKind: payload.feedbackKind } : {}),
    ...(payload.feedbackSource ? { feedbackSource: payload.feedbackSource } : {}),
    ...(payload.feedbackCommand
      ? {
          feedbackCommand: {
            commandHash: payload.feedbackCommand.commandHash,
            commandKind: payload.feedbackCommand.commandKind,
            confidence: payload.feedbackCommand.confidence,
          },
        }
      : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.pullRequestNumber ? { pullRequestNumber: payload.pullRequestNumber } : {}),
    reason: payload.reason,
  };
}

/** Builds redacted metadata for memory candidates proposed from provider commands. */
function providerFeedbackCommandMetadata(payload: UpdateMemoryJobPayload): Record<string, unknown> {
  return {
    ...providerFeedbackOutcomeMetadata(payload),
    source: "provider_feedback_command",
  };
}

/** Returns unique non-empty strings in input order. */
function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Builds a pending suppression candidate from a rejected finding outcome. */
function memoryCandidateFromRejectedFindingOutcome(input: {
  /** Finding that was marked as false positive. */
  readonly finding: {
    readonly body: string;
    readonly category: string;
    readonly confidence: number;
    readonly findingId: string;
    readonly fingerprint: string;
    readonly location: unknown;
    readonly reviewRunId: string;
    readonly severity: string;
    readonly title: string;
  };
  /** Outcome row that triggered the memory update. */
  readonly outcome: FindingOutcomeRecord;
  /** Published finding row ID when available. */
  readonly publishedFindingId?: string | undefined;
}): CreateMemoryCandidateInput {
  const path = pathFromFindingLocation(input.finding.location);
  return {
    candidateKind: "suppress_similar_finding",
    confidence: Math.max(0.5, Math.min(0.95, input.finding.confidence)),
    memoryCandidateId: stableWorkerId("mcand", ["finding_outcome", input.outcome.findingOutcomeId]),
    metadata: {
      category: input.finding.category,
      findingId: input.finding.findingId,
      outcome: input.outcome.outcome,
      outcomeId: input.outcome.findingOutcomeId,
      outcomeSource: input.outcome.source,
      ...(path ? { path } : {}),
      reviewRunId: input.finding.reviewRunId,
      severity: input.finding.severity,
      title: input.finding.title,
    },
    orgId: input.outcome.orgId,
    proposedAppliesTo: {
      categories: [input.finding.category],
      findingFingerprints: [input.finding.fingerprint],
      ...(path ? { pathGlobs: [path] } : {}),
      titlePatterns: [input.finding.title],
    },
    proposedContent: `Suppress similar findings: ${input.finding.title}`,
    proposedScope: {
      findingFingerprints: [input.finding.fingerprint],
      level: "finding_fingerprint",
      orgId: input.outcome.orgId,
      repoId: input.outcome.repoId,
    },
    repoId: input.outcome.repoId,
    ...(input.publishedFindingId ? { sourceFindingId: input.publishedFindingId } : {}),
    sourceKind: "dashboard",
    status: "pending",
    trustLevel: input.outcome.source === "user_action" ? "admin" : "system",
  };
}

/** Reads a repository path from a finding location payload when present. */
function pathFromFindingLocation(location: unknown): string | undefined {
  if (!location || typeof location !== "object" || Array.isArray(location)) {
    return undefined;
  }

  const path = (location as Record<string, unknown>).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** Returns a stable ID for worker-created rows. */
function stableWorkerId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

/** Returns a provider-compatible stable ID for reconciliation-created provider events. */
function providerFeedbackStableId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);
  return `${prefix}_${digest}`;
}

function asSyncInstallationPayload(payload: JobPayload): SyncInstallationJobPayload {
  if (!("reason" in payload) || !("provider" in payload) || "commitSha" in payload) {
    throw new Error("Job payload is not a sync installation payload.");
  }

  return payload as SyncInstallationJobPayload;
}

function asIndexRepoCommitPayload(payload: JobPayload): IndexRepoCommitJobPayload {
  if (!("commitSha" in payload) || !("repoId" in payload) || !("installationId" in payload)) {
    throw new Error("Job payload is not an index repo commit payload.");
  }

  return payload as IndexRepoCommitJobPayload;
}

function asEmbeddingBatchPayload(payload: JobPayload): EmbeddingBatchJobPayload {
  if (
    !("chunkIds" in payload) ||
    !("indexVersionId" in payload) ||
    !("embeddingModel" in payload)
  ) {
    throw new Error("Job payload is not an embedding batch payload.");
  }

  return payload as EmbeddingBatchJobPayload;
}

/** Narrows a generic job payload to an embedding repair payload. */
function asEmbeddingRepairPayload(payload: JobPayload): EmbeddingRepairJobPayload {
  if (
    !("repoId" in payload) ||
    !("indexVersionId" in payload) ||
    !("embeddingProfileVersion" in payload) ||
    "chunkIds" in payload
  ) {
    throw new Error("Job payload is not an embedding repair payload.");
  }

  return payload as EmbeddingRepairJobPayload;
}

function asReviewPullRequestPayload(payload: JobPayload): ReviewPullRequestJobPayload {
  if (
    !("pullRequestNumber" in payload) ||
    !("repoId" in payload) ||
    !("installationId" in payload) ||
    !("baseSha" in payload) ||
    !("headSha" in payload) ||
    !("trigger" in payload)
  ) {
    throw new Error("Job payload is not a review pull request payload.");
  }

  return payload as ReviewPullRequestJobPayload;
}

function asPublishReviewPayload(payload: JobPayload): PublishReviewJobPayload {
  if (
    !("reviewRunId" in payload) ||
    !("repoId" in payload) ||
    !("pullRequestNumber" in payload) ||
    "headSha" in payload
  ) {
    throw new Error("Job payload is not a publish review payload.");
  }

  return payload as PublishReviewJobPayload;
}

function asUpdateMemoryPayload(payload: JobPayload): UpdateMemoryJobPayload {
  if (!("repoId" in payload) || !("reason" in payload) || "headSha" in payload) {
    throw new Error("Job payload is not an update memory payload.");
  }

  return payload as UpdateMemoryJobPayload;
}

function asBillingReconcilePayload(payload: JobPayload): BillingReconcileJobPayload {
  return payload as BillingReconcileJobPayload;
}

/** Narrows a generic job payload to a data-deletion planning payload. */
function asDataDeletionPlanPayload(payload: JobPayload): DataDeletionPlanJobPayload {
  return parseWithSchema("DataDeletionPlanJobPayload", DataDeletionPlanJobPayloadSchema, payload);
}

/** Narrows a generic job payload to a sandbox cleanup payload. */
function asSandboxCleanupPayload(payload: JobPayload): SandboxCleanupJobPayload {
  return payload as SandboxCleanupJobPayload;
}

/** Narrows a generic job payload to a review artifact cleanup payload. */
function asReviewArtifactCleanupPayload(payload: JobPayload): ReviewArtifactCleanupJobPayload {
  return payload as ReviewArtifactCleanupJobPayload;
}

/** Narrows a generic job payload to a compliance evidence collection payload. */
function asComplianceEvidenceCollectPayload(
  payload: JobPayload,
): ComplianceEvidenceCollectJobPayload {
  return parseWithSchema(
    "ComplianceEvidenceCollectJobPayload",
    ComplianceEvidenceCollectJobPayloadSchema,
    payload,
  );
}

/** Requires billing provider configuration before provider-mutating billing jobs run. */
function requireBillingProvider(provider: BillingProvider | undefined): BillingProvider {
  if (!provider) {
    throw new Error(
      "Billing reconciliation requires HEIMDALL_BILLING_PROVIDER or STRIPE_SECRET_KEY.",
    );
  }

  return provider;
}

/** Creates the billing provider used by worker-owned reconciliation jobs. */
function createWorkerBillingProviderFromEnv(db: HeimdallDatabase): BillingProvider | undefined {
  if (process.env.HEIMDALL_BILLING_PROVIDER === "fake") {
    return new FakeBillingProvider({
      ...(process.env.HEIMDALL_FAKE_BILLING_BASE_URL
        ? { baseUrl: process.env.HEIMDALL_FAKE_BILLING_BASE_URL }
        : {}),
    });
  }

  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    return undefined;
  }

  return new StripeBillingProvider({
    apiKey,
    checkoutPriceByPlanKey: stripeCheckoutPriceMapFromEnv(
      process.env.HEIMDALL_STRIPE_CHECKOUT_PRICE_MAP,
    ),
    requestLogger: new WorkerBillingProviderRequestLogger(db),
    ...(process.env.STRIPE_WEBHOOK_SECRET
      ? { webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
      : {}),
  });
}

/** Parses the Stripe checkout price map used when the same provider also handles checkout. */
function stripeCheckoutPriceMapFromEnv(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 && typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

/** Durable logger for worker-owned outbound billing provider requests. */
class WorkerBillingProviderRequestLogger implements BillingProviderRequestLogger {
  private readonly billingRepository: BillingRepository;

  /** Creates a Postgres-backed provider request logger. */
  public constructor(db: HeimdallDatabase) {
    this.billingRepository = new BillingRepository(db);
  }

  /** Records one provider request outcome. */
  public async record(input: BillingProviderRequestLogInput): Promise<void> {
    await this.billingRepository.recordBillingProviderRequest(input);
  }
}

if (import.meta.main) {
  const runtime = await startWorkerRuntime();
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch((error: unknown) => {
      runtime.logger.error("worker shutdown failed", {
        error,
        target: "worker.shutdown",
      });
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      runtime.logger.error("worker shutdown failed", {
        error,
        target: "worker.shutdown",
      });
      process.exit(1);
    });
  });
}
