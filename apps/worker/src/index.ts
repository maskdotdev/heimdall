import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  type ReviewPullRequestJobPayload,
  type ReviewTrigger,
  type SandboxCleanupJobPayload,
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
  FeedbackRepository,
  type FindingOutcomeRecord,
  type HeimdallDatabase,
  MemoryCandidateRepository,
  ProviderInstallationRepository,
  type PublishedFindingFeedbackTargetRecord,
  type PublishedSummaryFeedbackTargetRecord,
  RepositoryRepository,
  ReviewRepository,
  type SandboxArtifactInsert,
  type SandboxPolicyDecisionInsert,
  SandboxRepository,
  type SandboxRunInsert,
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
  createIndexImportLimitsFromEnvironment,
  importIndexArtifact,
  importIndexArtifactFromUri,
  reconcileStaleIndexImports,
} from "@repo/index-importer";
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
  type DurableJobHandlerMap,
  dispatchPendingJobs,
  QUEUE_NAMES,
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
import { createLocalEnvSecretsManager, parseSecretRef, type SecretsManager } from "@repo/security";
import { createSandboxToolRunner, type ToolRunner } from "@repo/tool-runner";
import { PostgresUsageLedgerStore, reconcileBillingState, UsageLedger } from "@repo/usage";
import { Worker } from "bullmq";
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
/** URI prefix used after retention cleanup removes review artifact payload bytes. */
const DELETED_REVIEW_ARTIFACT_URI_PREFIX = "deleted://review_artifacts/";
/** Maximum chunk IDs placed in one repair-triggered embedding batch. */
const EMBEDDING_REPAIR_BATCH_SIZE = 128;
/** Maximum completed review runs inspected by one scheduled thread reconciliation job. */
const THREAD_RECONCILIATION_REVIEW_RUN_LIMIT = 10;

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
  /** Optional test hook for embedding repair jobs. */
  readonly embeddingRepairer?: (payload: EmbeddingRepairJobPayload) => Promise<void>;
  /** Optional test hook for sandbox cleanup jobs. */
  readonly sandboxCleaner?: (payload: SandboxCleanupJobPayload) => Promise<void>;
  /** Optional test hook for review artifact cleanup jobs. */
  readonly reviewArtifactCleaner?: (payload: ReviewArtifactCleanupJobPayload) => Promise<void>;
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
  /** Maximum stale running rows to repair in one pass. */
  readonly recoveryBatchSize: number;
  /** Milliseconds between stale running recovery passes. */
  readonly recoveryIntervalMs: number;
  /** Running duration after which a durable job is considered stale. */
  readonly staleRunningTimeoutMs: number;
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
  /** Stops workers, dispatcher resources, Redis, and database connections. */
  readonly close: () => Promise<void>;
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
    [JOB_TYPES.SyncInstallation]: async (envelope) => {
      const payload = asSyncInstallationPayload(envelope.payload);
      const installation = await loadGitHubInstallationRef(options.db, payload.installationId);

      await options.gitProvider.syncInstallation({
        provider: "github",
        installationId: installation.installationId,
        providerInstallationId: installation.providerInstallationId,
        orgId: installation.orgId,
      });
    },
    [JOB_TYPES.IndexRepoCommit]: async (envelope) => {
      const payload = asIndexRepoCommitPayload(envelope.payload);
      const repository = await loadGitHubRepositoryRef(options.db, payload);

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
        if (result.artifactUri) {
          await importIndexArtifact(result.artifact, {
            artifactUri: result.artifactUri,
            db: options.db,
            enqueueEmbeddings: true,
            importLimits,
            ...(options.metrics ? { metrics: options.metrics } : {}),
            ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
            ...(options.traces ? { traces: options.traces } : {}),
          });
        } else {
          const artifactUri = await persistIndexArtifact(
            result.artifact,
            options.indexArtifactRoot ?? DEFAULT_INDEX_ARTIFACT_ROOT,
          );
          await importIndexArtifactFromUri({
            artifactUri,
            db: options.db,
            enqueueEmbeddings: true,
            importLimits,
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
    [JOB_TYPES.EmbeddingBatch]: async (envelope) => {
      const payload = asEmbeddingBatchPayload(envelope.payload);
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
    [JOB_TYPES.EmbeddingRepair]: async (envelope) => {
      const payload = asEmbeddingRepairPayload(envelope.payload);
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
    [JOB_TYPES.ReviewPullRequest]: async (envelope) => {
      const payload = asReviewPullRequestPayload(envelope.payload);

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
    [JOB_TYPES.PublishReview]: async (envelope) => {
      const payload = asPublishReviewPayload(envelope.payload);

      await publishReviewRun(payload, {
        db: options.db,
        gitProvider: options.gitProvider,
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(options.publishThrottle ? { publishThrottle: options.publishThrottle } : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
      });
    },
    [JOB_TYPES.UpdateMemory]: async (envelope) => {
      const payload = asUpdateMemoryPayload(envelope.payload);
      await updateMemoryFromFindingOutcome(options.db, payload);
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
      await recordOutcomeFromProviderFeedback(options.db, payload, envelope.createdAt, {
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
      });
    },
    [JOB_TYPES.BillingReconcile]: async (envelope) => {
      const payload = asBillingReconcilePayload(envelope.payload);
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
    [JOB_TYPES.SandboxCleanup]: async (envelope) => {
      const payload = asSandboxCleanupPayload(envelope.payload);
      if (options.sandboxCleaner) {
        await options.sandboxCleaner(payload);
        return;
      }

      await cleanupSandboxRuns(options.db, payload);
    },
    [JOB_TYPES.ReviewArtifactCleanup]: async (envelope) => {
      const payload = asReviewArtifactCleanupPayload(envelope.payload);
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
  };
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
  const indexerTimeoutMs = indexerConfig.defaultTimeoutMs;
  const workspaceRoot = process.env.REPO_SYNC_WORKSPACE_ROOT;
  const repoSyncConfig = createRepoSyncConfig({
    ...(workspaceRoot ? { cacheRoot: workspaceRoot } : {}),
  });
  const indexArtifactRoot = indexerConfig.artifactRootPath;
  const queueMaintenance = createWorkerQueueMaintenanceConfig(process.env);
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
  await verifyWorkerIndexerCapabilities(indexerDriver);
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
      ...(llmGateway ? { llmGateway } : {}),
      ...(staticAnalysisRunner ? { staticAnalysisRunner } : {}),
      ...(reviewIndexDependencyMode ? { reviewIndexDependencyMode } : {}),
      ...(artifactPayloadStore ? { artifactPayloadStore } : {}),
      publishThrottle,
      repoSyncConfig,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      indexArtifactRoot,
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
  const workers = [
    QUEUE_NAMES.repoSync,
    QUEUE_NAMES.indexing,
    QUEUE_NAMES.embedding,
    QUEUE_NAMES.review,
    QUEUE_NAMES.memory,
    QUEUE_NAMES.publishing,
    QUEUE_NAMES.billing,
  ].map((queueName) => new Worker(queueName, processor, { connection: workerConnection }));
  const dispatch = async () => {
    await dispatchPendingJobs({ store, queueProducer });
  };
  const dispatchInterval = setInterval(() => {
    dispatch().catch((error: unknown) => {
      console.error("outbox dispatch failed", error);
    });
  }, 5_000);
  const staleRunningRecoveryInterval = setInterval(() => {
    recoverStaleRunningJobs().catch((error: unknown) => {
      console.error("worker maintenance recovery failed", error);
    });
  }, queueMaintenance.recoveryIntervalMs);

  await recoverStaleRunningJobs();
  await dispatch();
  observability.logger.info("worker service started", {
    attributes: {
      "event.name": "worker.service.started",
      "queue.count": workers.length,
    },
  });
  observability.metrics.count(OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal, {
    labels: { status: "started" },
  });

  return {
    close: async () => {
      clearInterval(dispatchInterval);
      clearInterval(staleRunningRecoveryInterval);
      observability.logger.info("worker service stopping", {
        attributes: { "event.name": "worker.service.stopping" },
      });
      observability.metrics.count(OBSERVABILITY_METRIC_NAMES.workerServiceStopsTotal, {
        labels: { status: "stopping" },
      });
      await Promise.all(workers.map((worker) => worker.close()));
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

/** Verifies the selected worker indexer before accepting jobs. */
export async function verifyWorkerIndexerCapabilities(
  driver: CodeIndexerDriver,
): Promise<IndexerCapabilities> {
  const capabilities = await driver.getCapabilities();
  assertIndexerSupportsCurrentArtifactSchema(capabilities);
  console.info(
    "indexer.capabilities",
    JSON.stringify({
      driverName: capabilities.driverName,
      driverVersion: capabilities.driverVersion,
      supportedArtifactSchemaVersions: capabilities.supportedArtifactSchemaVersions,
      supportedLanguages: capabilities.supportedLanguages,
      supportedRecordTypes: capabilities.supportedRecordTypes,
      supportsRemoteArtifacts: capabilities.supportsRemoteArtifacts,
    }),
  );

  return capabilities;
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

/** Parses a positive integer environment value. */
function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
export async function persistIndexArtifact(
  artifact: Parameters<typeof importIndexArtifact>[0],
  root: string,
): Promise<string> {
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

/** Creates a filesystem-safe artifact filename from the artifact content hash. */
function artifactFileName(artifact: Parameters<typeof importIndexArtifact>[0]): string {
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

/** Narrows a generic job payload to a sandbox cleanup payload. */
function asSandboxCleanupPayload(payload: JobPayload): SandboxCleanupJobPayload {
  return payload as SandboxCleanupJobPayload;
}

/** Narrows a generic job payload to a review artifact cleanup payload. */
function asReviewArtifactCleanupPayload(payload: JobPayload): ReviewArtifactCleanupJobPayload {
  return payload as ReviewArtifactCleanupJobPayload;
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
      console.error("worker shutdown failed", error);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      console.error("worker shutdown failed", error);
      process.exit(1);
    });
  });
}
