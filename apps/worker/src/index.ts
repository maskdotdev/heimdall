import { loadRuntimeConfig } from "@repo/config";
import {
  type IndexRepoCommitJobPayload,
  JOB_TYPES,
  type JobPayload,
  type PublishReviewJobPayload,
  type ReviewPullRequestJobPayload,
  type SyncInstallationJobPayload,
} from "@repo/contracts";
import {
  createDatabaseClient,
  type HeimdallDatabase,
  providerInstallations,
  repositories,
} from "@repo/db";
import {
  createGitHubProvider,
  type GitHubInstallationRef,
  type GitHubRepositoryRef,
  type GitProvider,
} from "@repo/github";
import { publishReviewRun } from "@repo/publisher";
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
import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import IORedis from "ioredis";

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
  /** Git provider used by repo sync handlers. */
  readonly gitProvider: GitProvider;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
};

/** Runtime handle returned by the worker process bootstrap. */
export type WorkerRuntime = {
  /** Stops workers, dispatcher resources, Redis, and database connections. */
  readonly close: () => Promise<void>;
};

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

      await syncRepositoryWorkspace(
        {
          ...repository,
          commitSha: payload.commitSha,
          ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        },
        { gitProvider: options.gitProvider },
      );
    },
    [JOB_TYPES.ReviewPullRequest]: async (envelope) => {
      const payload = asReviewPullRequestPayload(envelope.payload);

      await runPullRequestReview(payload, {
        db: options.db,
        gitProvider: options.gitProvider,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      });
    },
    [JOB_TYPES.PublishReview]: async (envelope) => {
      const payload = asPublishReviewPayload(envelope.payload);

      await publishReviewRun(payload, {
        db: options.db,
        gitProvider: options.gitProvider,
      });
    },
  };
}

/** Starts BullMQ workers and a polling outbox dispatcher. */
export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  const config = loadRuntimeConfig();
  const githubPrivateKey = process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!config.githubAppId || !githubPrivateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required to start workers.");
  }

  const databaseClient = createDatabaseClient();
  const store = new DrizzleDurableJobStore(databaseClient.db);
  const queueProducer = new BullMqQueueProducer(config.redisUrl);
  const workerConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const gitProvider = createGitHubProvider({
    appId: config.githubAppId,
    privateKey: githubPrivateKey,
  });
  const processor = createDurableJobProcessor({
    store,
    handlers: createWorkerHandlers({
      db: databaseClient.db,
      gitProvider,
      ...(process.env.REPO_SYNC_WORKSPACE_ROOT
        ? { workspaceRoot: process.env.REPO_SYNC_WORKSPACE_ROOT }
        : {}),
    }),
  });
  const workers = [
    QUEUE_NAMES.repoSync,
    QUEUE_NAMES.indexing,
    QUEUE_NAMES.review,
    QUEUE_NAMES.publishing,
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

  return {
    close: async () => {
      clearInterval(dispatchInterval);
      await Promise.all(workers.map((worker) => worker.close()));
      await queueProducer.close();
      await workerConnection.quit();
      await databaseClient.close();
    },
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
