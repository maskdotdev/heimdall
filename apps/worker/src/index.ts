import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createReviewArtifactPayloadStoreFromEnvironment,
  InlineReviewArtifactPayloadStore,
  type ReviewArtifactPayloadStore,
} from "@repo/artifacts";
import {
  type BillingProvider,
  type BillingProviderRequestLogger,
  type BillingProviderRequestLogInput,
  FakeBillingProvider,
  StripeBillingProvider,
} from "@repo/billing";
import { loadRuntimeConfig } from "@repo/config";
import {
  type BillingReconcileJobPayload,
  type EmbeddingBatchJobPayload,
  type IndexRepoCommitJobPayload,
  JOB_TYPES,
  type JobPayload,
  type LLMFindingOutput,
  type PublishReviewJobPayload,
  parseWithSchema,
  type ReviewPullRequestJobPayload,
  type SandboxCleanupJobPayload,
  type SyncInstallationJobPayload,
  type UpdateMemoryJobPayload,
} from "@repo/contracts";
import {
  billingProviderRequests,
  createDatabaseClient,
  findingOutcomes,
  type HeimdallDatabase,
  memoryCandidates,
  providerInstallations,
  publishedFindings,
  repositories,
  reviewRuns,
  sandboxArtifacts,
  sandboxPolicyDecisions,
  sandboxRuns,
  validatedFindings,
} from "@repo/db";
import { createEmbeddingProviderFromEnvironment, embedChunkBatch } from "@repo/embedding";
import {
  createGitHubProvider,
  type GitHubInstallationRef,
  type GitHubRepositoryRef,
  type GitProvider,
} from "@repo/github";
import { importIndexArtifact, importIndexArtifactFromUri } from "@repo/index-importer";
import {
  assertIndexerSupportsCurrentArtifactSchema,
  type CodeIndexerDriver,
  createCliIndexerDriver,
  createRemoteIndexerDriver,
  type IndexerCapabilities,
  withIndexerTimeout,
} from "@repo/indexer-driver";
import { createTypeScriptIndexerDriver } from "@repo/indexer-ts";
import { createLLMGateway, type LLMGateway, type LLMProvider } from "@repo/llm-gateway";
import {
  createMemoryCandidatesFromCommand,
  type FeedbackCommand,
  type MemoryAppliesTo,
  MemoryAppliesToSchema,
  type MemoryCandidate,
  type MemoryScope,
  MemoryScopeSchema,
} from "@repo/memory";
import {
  createObservabilityRuntime,
  OBSERVABILITY_METRIC_NAMES,
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
import { syncRepositoryWorkspace } from "@repo/repo-sync";
import { runPullRequestReview } from "@repo/review-orchestrator";
import {
  createDockerContainerSandboxRunner,
  createFakeSandboxRunner,
  createGVisorSandboxRunner,
  createLocalProcessSandboxRunner,
  type DockerContainerSandboxRunnerOptions,
  type SandboxRunner,
  type SandboxRunRequest,
  type SandboxRunResult,
} from "@repo/sandbox";
import { createSandboxToolRunner, type ToolRunner } from "@repo/tool-runner";
import { reconcileBillingState } from "@repo/usage";
import { Worker } from "bullmq";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import IORedis from "ioredis";

/** Default durable artifact directory used when INDEX_ARTIFACT_ROOT is unset. */
const DEFAULT_INDEX_ARTIFACT_ROOT = ".heimdall/index-artifacts";
/** Default maximum time allowed for one indexer run. */
const DEFAULT_INDEXER_TIMEOUT_MS = 120_000;

/** GitHub installation row shape required by worker handlers. */
type GitHubInstallationRuntimeRef = GitHubInstallationRef & {
  /** GitHub numeric installation ID. */
  readonly providerInstallationId: string;
  /** Heimdall organization ID that owns the installation. */
  readonly orgId: string;
};

/** Options used to create worker job handlers. */
export type CreateWorkerHandlersOptions = {
  /** Database used to resolve durable job payload IDs. */
  readonly db: HeimdallDatabase;
  /** Optional billing provider used by billing reconciliation jobs. */
  readonly billingProvider?: BillingProvider;
  /** Optional test hook for billing reconciliation jobs. */
  readonly billingReconciler?: (payload: BillingReconcileJobPayload) => Promise<void>;
  /** Optional test hook for sandbox cleanup jobs. */
  readonly sandboxCleaner?: (payload: SandboxCleanupJobPayload) => Promise<void>;
  /** Git provider used by repo sync handlers. */
  readonly gitProvider: GitProvider;
  /** Optional model gateway used by review jobs. */
  readonly llmGateway?: LLMGateway;
  /** Optional static-analysis runner used by review jobs. */
  readonly staticAnalysisRunner?: ToolRunner;
  /** Optional review artifact payload store used by review orchestration. */
  readonly artifactPayloadStore?: ReviewArtifactPayloadStore;
  /** Optional shared throttle for provider-visible publisher writes. */
  readonly publishThrottle?: PublishThrottle;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
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
};

/** Environment values used to select the worker indexer driver. */
export type WorkerIndexerDriverEnvironment = Readonly<Record<string, string | undefined>>;

/** Environment values used to select the worker static-analysis runner. */
export type WorkerStaticAnalysisRunnerEnvironment = Readonly<Record<string, string | undefined>>;

/** Runtime dependencies used while creating a worker static-analysis runner. */
export type WorkerStaticAnalysisRunnerOptions = {
  /** Optional database used to persist sandbox run results. */
  readonly db?: HeimdallDatabase | undefined;
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

      const workspace = await syncRepositoryWorkspace(
        {
          ...repository,
          commitSha: payload.commitSha,
          keepWorkspace: true,
          ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        },
        { gitProvider: options.gitProvider },
      );
      try {
        const driver = withIndexerTimeout(
          options.indexerDriver ?? createTypeScriptIndexerDriver(),
          {
            timeoutMs: options.indexerTimeoutMs ?? DEFAULT_INDEXER_TIMEOUT_MS,
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

        if (result.artifactUri) {
          await importIndexArtifact(result.artifact, {
            artifactUri: result.artifactUri,
            db: options.db,
            enqueueEmbeddings: true,
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
          });
        }
      } finally {
        await rm(workspace.workspacePath, { force: true, recursive: true });
      }
    },
    [JOB_TYPES.EmbeddingBatch]: async (envelope) => {
      const payload = asEmbeddingBatchPayload(envelope.payload);
      await embedChunkBatch(payload, {
        db: options.db,
        provider: createEmbeddingProviderFromEnvironment(process.env, {
          model: payload.embeddingModel,
        }),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
      });
    },
    [JOB_TYPES.ReviewPullRequest]: async (envelope) => {
      const payload = asReviewPullRequestPayload(envelope.payload);

      await runPullRequestReview(payload, {
        ...(options.artifactPayloadStore
          ? { artifactPayloadStore: options.artifactPayloadStore }
          : {}),
        db: options.db,
        gitProvider: options.gitProvider,
        ...(options.llmGateway ? { llmGateway: options.llmGateway } : {}),
        ...(options.staticAnalysisRunner
          ? { staticAnalysisRunner: options.staticAnalysisRunner }
          : {}),
        ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(options.traces ? { traces: options.traces } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      });
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
      await recordOutcomeFromProviderFeedback(options.db, payload, envelope.createdAt);
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
  };
}

/** Starts BullMQ workers and a polling outbox dispatcher. */
export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  const observability = createObservabilityRuntime({
    defaultServiceName: "code-review-worker",
  });
  const config = loadRuntimeConfig();
  const githubPrivateKey = process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!config.githubAppId || !githubPrivateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required to start workers.");
  }

  const databaseClient = createDatabaseClient();
  const store = new DrizzleDurableJobStore(databaseClient.db);
  const queueProducer = new BullMqQueueProducer(config.redisUrl);
  const workerConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const billingProvider = createWorkerBillingProviderFromEnv(databaseClient.db);
  const gitProvider = createGitHubProvider({
    appId: config.githubAppId,
    privateKey: githubPrivateKey,
  });
  const llmGateway =
    process.env.HEIMDALL_REVIEW_SMOKE_FINDING === "true"
      ? createWorkerReviewSmokeGateway({
          metrics: observability.metrics,
          traces: observability.traces,
        })
      : undefined;
  const artifactPayloadStore = createWorkerReviewArtifactPayloadStoreFromEnv();
  const staticAnalysisRunner = createWorkerStaticAnalysisRunnerFromEnvironment(process.env, {
    db: databaseClient.db,
  });
  const publishThrottle = createRedisPublishThrottle(workerConnection);
  const indexerTimeoutMs = optionalPositiveInteger(process.env.INDEXER_TIMEOUT_MS);
  const workspaceRoot = process.env.REPO_SYNC_WORKSPACE_ROOT;
  const indexArtifactRoot = process.env.INDEX_ARTIFACT_ROOT ?? DEFAULT_INDEX_ARTIFACT_ROOT;
  const indexerDriver =
    createWorkerIndexerDriverFromEnvironment(process.env, {
      indexArtifactRoot,
      ...(indexerTimeoutMs ? { indexerTimeoutMs } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }) ?? createTypeScriptIndexerDriver();
  await verifyWorkerIndexerCapabilities(indexerDriver);
  const processor = createDurableJobProcessor({
    store,
    handlers: createWorkerHandlers({
      ...(billingProvider ? { billingProvider } : {}),
      db: databaseClient.db,
      gitProvider,
      ...(llmGateway ? { llmGateway } : {}),
      ...(staticAnalysisRunner ? { staticAnalysisRunner } : {}),
      ...(artifactPayloadStore ? { artifactPayloadStore } : {}),
      publishThrottle,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      indexArtifactRoot,
      indexerDriver,
      ...(indexerTimeoutMs ? { indexerTimeoutMs } : {}),
      metrics: observability.metrics,
      traces: observability.traces,
    }),
    metrics: observability.metrics,
    traces: observability.traces,
  });
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
  const sandboxRunner = createWorkerSandboxRunnerFromEnvironment(env);
  if (!sandboxRunner) {
    return undefined;
  }

  return createSandboxToolRunner({
    runner: options.db ? createPersistingSandboxRunner(sandboxRunner, options.db) : sandboxRunner,
  });
}

/** Creates the optional sandbox runner selected by worker environment. */
function createWorkerSandboxRunnerFromEnvironment(
  env: WorkerStaticAnalysisRunnerEnvironment,
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
    return createDockerContainerSandboxRunner(createWorkerDockerRunnerOptions(env));
  }

  if (runnerName === "gvisor") {
    return createGVisorSandboxRunner(createWorkerDockerRunnerOptions(env));
  }

  throw new Error(`Unsupported SANDBOX_RUNNER: ${runnerName}`);
}

/** Creates Docker sandbox runner options from non-secret worker environment values. */
function createWorkerDockerRunnerOptions(
  env: WorkerStaticAnalysisRunnerEnvironment,
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
  await db.transaction(async (transaction) => {
    await transaction
      .insert(sandboxRuns)
      .values(sandboxRunRowFromRequestResult(request, result))
      .onConflictDoUpdate({
        target: sandboxRuns.sandboxRunId,
        set: sandboxRunUpdateFromRequestResult(request, result),
      });
    await transaction
      .delete(sandboxArtifacts)
      .where(eq(sandboxArtifacts.sandboxRunId, result.runId));
    await transaction
      .delete(sandboxPolicyDecisions)
      .where(eq(sandboxPolicyDecisions.sandboxRunId, result.runId));

    const artifactRows = result.artifacts.map((artifact) => ({
      contentType: artifact.contentType ?? null,
      name: artifact.name,
      sandboxArtifactId: stableWorkerId("sart", [result.runId, artifact.name]),
      sandboxRunId: result.runId,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      truncated: artifact.truncated,
      uri: artifact.uri,
    }));
    if (artifactRows.length > 0) {
      await transaction.insert(sandboxArtifacts).values(artifactRows);
    }

    const policyDecisionRows = result.policyDecisions.map((decision, index) => ({
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
    if (policyDecisionRows.length > 0) {
      await transaction.insert(sandboxPolicyDecisions).values(policyDecisionRows);
    }
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
  const conditions = [lt(sandboxRuns.createdAt, cutoff)];
  if (payload.repoId) {
    conditions.push(eq(sandboxRuns.repoId, payload.repoId));
  }

  const selectedRuns = await db
    .select({ sandboxRunId: sandboxRuns.sandboxRunId })
    .from(sandboxRuns)
    .where(and(...conditions))
    .orderBy(asc(sandboxRuns.createdAt))
    .limit(limit);
  const sandboxRunIds = selectedRuns.map((row) => row.sandboxRunId);
  const artifactRows =
    sandboxRunIds.length === 0
      ? []
      : await db
          .select({ uri: sandboxArtifacts.uri })
          .from(sandboxArtifacts)
          .where(inArray(sandboxArtifacts.sandboxRunId, sandboxRunIds));

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
  await db.delete(sandboxRuns).where(inArray(sandboxRuns.sandboxRunId, sandboxRunIds));

  return {
    cutoff: cutoff.toISOString(),
    deletedArtifactFileCount: artifactCleanup.deletedFileCount,
    deletedRunCount: sandboxRunIds.length,
    dryRun,
    selectedRunCount: sandboxRunIds.length,
    skippedArtifactFileCount: artifactCleanup.skippedFileCount,
  };
}

/** Computes the sandbox cleanup cutoff date. */
function sandboxCleanupCutoff(payload: SandboxCleanupJobPayload, now: Date): Date {
  if (payload.before) {
    return new Date(payload.before);
  }

  return new Date(now.getTime() - (payload.olderThanDays ?? 30) * 24 * 60 * 60 * 1000);
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

/** Creates the insert row for a sandbox run. */
function sandboxRunRowFromRequestResult(request: SandboxRunRequest, result: SandboxRunResult) {
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

/** Creates the update row for a sandbox run conflict. */
function sandboxRunUpdateFromRequestResult(request: SandboxRunRequest, result: SandboxRunResult) {
  const row = sandboxRunRowFromRequestResult(request, result);

  return {
    category: row.category,
    commandJson: row.commandJson,
    errorJson: row.errorJson,
    exitCode: row.exitCode,
    finishedAt: row.finishedAt,
    image: row.image,
    imageDigest: row.imageDigest,
    limitsJson: row.limitsJson,
    policyJson: row.policyJson,
    resourceUsageJson: row.resourceUsageJson,
    reviewRunId: row.reviewRunId,
    runnerKind: row.runnerKind,
    signal: row.signal,
    startedAt: row.startedAt,
    staticAnalysisRunId: row.staticAnalysisRunId,
    status: row.status,
    stderrHash: row.stderrHash,
    stderrTruncated: row.stderrTruncated,
    stdoutHash: row.stdoutHash,
    stdoutTruncated: row.stdoutTruncated,
    toolRunId: row.toolRunId,
    trustLevel: row.trustLevel,
    updatedAt: row.updatedAt,
    warningsJson: row.warningsJson,
  };
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
    /** Optional parent directory for repo-sync workspaces. */
    readonly workspaceRoot?: string;
    /** Maximum time allowed for one indexer run. */
    readonly indexerTimeoutMs?: number;
  },
): CodeIndexerDriver | undefined {
  const driverName = env.INDEXER_DRIVER ?? "in_process_ts";
  if (driverName === "in_process_ts" || driverName === "typescript") {
    return undefined;
  }
  if (driverName === "remote") {
    const baseUrl = env.INDEXER_REMOTE_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error("INDEXER_REMOTE_BASE_URL is required when INDEXER_DRIVER=remote.");
    }

    const pollIntervalMs = optionalPositiveInteger(env.INDEXER_REMOTE_POLL_INTERVAL_MS);
    const maxPollMs =
      optionalPositiveInteger(env.INDEXER_REMOTE_MAX_POLL_MS) ?? options.indexerTimeoutMs;

    return createRemoteIndexerDriver({
      baseUrl,
      ...(env.INDEXER_REMOTE_BEARER_TOKEN ? { bearerToken: env.INDEXER_REMOTE_BEARER_TOKEN } : {}),
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(maxPollMs ? { maxPollMs } : {}),
    });
  }
  if (driverName !== "cli") {
    throw new Error(`Unsupported INDEXER_DRIVER: ${driverName}`);
  }

  const command = env.INDEXER_CLI_COMMAND?.trim();
  if (!command) {
    throw new Error("INDEXER_CLI_COMMAND is required when INDEXER_DRIVER=cli.");
  }

  return createCliIndexerDriver({
    artifactRootPath: options.indexArtifactRoot,
    command,
    ...(env.INDEXER_CLI_ARGS_JSON
      ? { args: parseIndexerCliArgsJson(env.INDEXER_CLI_ARGS_JSON) }
      : {}),
    ...(options.indexerTimeoutMs ? { timeoutMs: options.indexerTimeoutMs } : {}),
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

/** Parses a positive integer environment value. */
function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parses INDEXER_CLI_ARGS_JSON into a spawn argument array. */
function parseIndexerCliArgsJson(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("INDEXER_CLI_ARGS_JSON must be a JSON array of strings.");
  }

  return parsed;
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
  const [installation] = await db
    .select({
      installationId: providerInstallations.installationId,
      providerInstallationId: providerInstallations.providerInstallationId,
      orgId: providerInstallations.orgId,
    })
    .from(providerInstallations)
    .where(
      and(
        eq(providerInstallations.provider, "github"),
        eq(providerInstallations.installationId, installationId),
      ),
    )
    .limit(1);

  if (!installation) {
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
  const [repository] = await db
    .select({
      owner: repositories.owner,
      repo: repositories.name,
      providerRepoId: repositories.providerRepoId,
      provider: repositories.provider,
    })
    .from(repositories)
    .where(eq(repositories.repoId, payload.repoId))
    .limit(1);

  if (!repository || repository.provider !== "github") {
    throw new Error(`GitHub repository ${payload.repoId} was not found.`);
  }

  const installation = await loadGitHubInstallationRef(db, payload.installationId);

  return {
    provider: "github",
    installationId: installation.installationId,
    providerInstallationId: installation.providerInstallationId,
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

  const [outcome] = await db
    .select()
    .from(findingOutcomes)
    .where(eq(findingOutcomes.findingOutcomeId, payload.outcomeId))
    .limit(1);
  if (!outcome || outcome.outcome !== "rejected") {
    return;
  }

  const [finding] = await db
    .select({
      body: validatedFindings.body,
      category: validatedFindings.category,
      confidence: validatedFindings.confidence,
      findingId: validatedFindings.findingId,
      fingerprint: validatedFindings.fingerprint,
      location: validatedFindings.location,
      reviewRunId: validatedFindings.reviewRunId,
      severity: validatedFindings.severity,
      title: validatedFindings.title,
    })
    .from(validatedFindings)
    .where(eq(validatedFindings.findingId, payload.findingId))
    .limit(1);
  if (!finding) {
    return;
  }

  const publishedFindingId =
    outcome.publishedFindingId ??
    (await findPublishedFindingIdForValidatedFinding(db, finding.findingId));
  await db
    .insert(memoryCandidates)
    .values(
      memoryCandidateFromRejectedFindingOutcome({
        finding,
        outcome,
        publishedFindingId,
      }),
    )
    .onConflictDoNothing();
}

/** Finds the provider-published finding row for one validated finding when it exists. */
async function findPublishedFindingIdForValidatedFinding(
  db: HeimdallDatabase,
  findingId: string,
): Promise<string | undefined> {
  const [published] = await db
    .select({ findingId: publishedFindings.findingId })
    .from(publishedFindings)
    .where(eq(publishedFindings.validatedFindingId, findingId))
    .limit(1);

  return published?.findingId;
}

/** Records a provider-webhook outcome after feedback has been correlated by provider comment ID. */
async function recordOutcomeFromProviderFeedback(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
  receivedAt: string,
): Promise<void> {
  if (
    (payload.reason !== "comment_reply" && payload.reason !== "provider_reaction") ||
    (!payload.externalCommentId && !payload.externalParentCommentId)
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
    return;
  }

  if (outcome) {
    await db
      .insert(findingOutcomes)
      .values({
        candidateFindingId: published.candidateFindingId,
        findingOutcomeId: stableWorkerId("out", [
          "provider_feedback",
          payload.externalEventId ??
            payload.externalReactionId ??
            payload.externalParentCommentId ??
            payload.externalCommentId,
        ]),
        metadata: providerFeedbackOutcomeMetadata(payload),
        occurredAt: new Date(receivedAt),
        orgId: published.orgId,
        outcome,
        publishedFindingId: published.publishedFindingId,
        repoId: published.repoId,
        source: "provider_webhook",
      })
      .onConflictDoNothing();
  }

  await createMemoryCandidatesFromProviderCommand(db, payload, published, receivedAt);
}

/** Finds a published finding row from provider feedback metadata. */
async function findPublishedFindingForProviderFeedback(
  db: HeimdallDatabase,
  payload: UpdateMemoryJobPayload,
): Promise<
  | {
      readonly candidateFindingId: string;
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
    }
  | undefined
> {
  const commentIds = uniqueStrings([payload.externalParentCommentId, payload.externalCommentId]);

  for (const commentId of commentIds) {
    const [published] = await db
      .select({
        publishedFindingId: publishedFindings.findingId,
        reviewRunId: publishedFindings.reviewRunId,
        validatedFindingId: publishedFindings.validatedFindingId,
      })
      .from(publishedFindings)
      .where(
        and(
          eq(publishedFindings.provider, payload.provider ?? "github"),
          eq(publishedFindings.providerCommentId, commentId),
        ),
      )
      .limit(1);

    if (!published) {
      continue;
    }

    const [finding] = await db
      .select({
        body: validatedFindings.body,
        candidateFindingId: validatedFindings.candidateFindingId,
        category: validatedFindings.category,
        confidence: validatedFindings.confidence,
        findingId: validatedFindings.findingId,
        fingerprint: validatedFindings.fingerprint,
        location: validatedFindings.location,
        reviewRunId: validatedFindings.reviewRunId,
        severity: validatedFindings.severity,
        title: validatedFindings.title,
      })
      .from(validatedFindings)
      .where(eq(validatedFindings.findingId, published.validatedFindingId))
      .limit(1);
    const [reviewRun] = await db
      .select({ repoId: reviewRuns.repoId })
      .from(reviewRuns)
      .where(eq(reviewRuns.reviewRunId, published.reviewRunId))
      .limit(1);

    if (!finding || !reviewRun) {
      return undefined;
    }

    const [repository] = await db
      .select({ orgId: repositories.orgId })
      .from(repositories)
      .where(eq(repositories.repoId, reviewRun.repoId))
      .limit(1);

    if (!repository) {
      return undefined;
    }

    return {
      candidateFindingId: finding.candidateFindingId,
      finding: {
        body: finding.body,
        category: finding.category,
        confidence: finding.confidence,
        findingId: finding.findingId,
        fingerprint: finding.fingerprint,
        location: finding.location,
        reviewRunId: finding.reviewRunId,
        severity: finding.severity,
        title: finding.title,
      },
      orgId: repository.orgId,
      publishedFindingId: published.publishedFindingId,
      repoId: reviewRun.repoId,
    };
  }

  return undefined;
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
): Promise<void> {
  const command = feedbackCommandFromPayload(payload);
  if (!command) {
    return;
  }

  if (command.commandKind === "mark_false_positive") {
    await db
      .insert(memoryCandidates)
      .values(memoryCandidateFromProviderFalsePositiveCommand({ command, payload, published }))
      .onConflictDoNothing();
    return;
  }

  const candidates = createMemoryCandidatesFromCommand({
    command,
    createdAt: receivedAt,
    createdByLogin: payload.actorLogin,
    findingFingerprint: published.finding.fingerprint,
    orgId: published.orgId,
    repoId: published.repoId,
  });

  for (const candidate of candidates) {
    await db
      .insert(memoryCandidates)
      .values(memoryCandidateFromCommandCandidate({ candidate, payload, published }))
      .onConflictDoNothing();
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
}): typeof memoryCandidates.$inferInsert {
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
}): typeof memoryCandidates.$inferInsert {
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
    ...(payload.feedbackKind ? { feedbackKind: payload.feedbackKind } : {}),
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
  readonly outcome: typeof findingOutcomes.$inferSelect;
  /** Published finding row ID when available. */
  readonly publishedFindingId?: string | undefined;
}): typeof memoryCandidates.$inferInsert {
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
  /** Creates a Postgres-backed provider request logger. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Records one provider request outcome. */
  public async record(input: BillingProviderRequestLogInput): Promise<void> {
    await this.db
      .insert(billingProviderRequests)
      .values({
        billingAccountId: input.billingAccountId ?? null,
        billingProviderRequestId: `bpr_${randomUUID()}`,
        completedAt: input.completedAt ? new Date(input.completedAt) : null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        operation: input.operation,
        orgId: input.orgId ?? null,
        provider: input.provider,
        providerRequestId: input.providerRequestId ?? null,
        requestMetadata: input.requestMetadata,
        responseMetadata: input.responseMetadata,
        startedAt: new Date(input.startedAt),
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [billingProviderRequests.provider, billingProviderRequests.idempotencyKey],
        set: {
          billingAccountId: input.billingAccountId ?? null,
          completedAt: input.completedAt ? new Date(input.completedAt) : null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          operation: input.operation,
          orgId: input.orgId ?? null,
          providerRequestId: input.providerRequestId ?? null,
          requestMetadata: input.requestMetadata,
          responseMetadata: input.responseMetadata,
          startedAt: new Date(input.startedAt),
          status: input.status,
        },
      });
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
