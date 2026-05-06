import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRuntimeConfig } from "@repo/config";
import {
  type EmbeddingBatchJobPayload,
  type IndexRepoCommitJobPayload,
  JOB_TYPES,
  type JobPayload,
  type LLMFindingOutput,
  LLMFindingOutputSchema,
  type PublishReviewJobPayload,
  parseWithSchema,
  type ReviewPullRequestJobPayload,
  type SyncInstallationJobPayload,
} from "@repo/contracts";
import {
  createDatabaseClient,
  type HeimdallDatabase,
  providerInstallations,
  repositories,
} from "@repo/db";
import { createHashEmbeddingProvider, embedChunkBatch } from "@repo/embedding";
import {
  createGitHubProvider,
  type GitHubInstallationRef,
  type GitHubRepositoryRef,
  type GitProvider,
} from "@repo/github";
import { importIndexArtifact } from "@repo/index-importer";
import { createTypeScriptIndexerDriver } from "@repo/indexer-ts";
import type { LLMGateway } from "@repo/llm-gateway";
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

/** Default durable artifact directory used when INDEX_ARTIFACT_ROOT is unset. */
const DEFAULT_INDEX_ARTIFACT_ROOT = ".heimdall/index-artifacts";

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
  /** Optional model gateway used by review jobs. */
  readonly llmGateway?: LLMGateway;
  /** Optional parent directory for repo-sync workspaces. */
  readonly workspaceRoot?: string;
  /** Durable directory used to store imported index artifacts before workspace cleanup. */
  readonly indexArtifactRoot?: string;
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
        const driver = createTypeScriptIndexerDriver();
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

        const artifactUri = await persistIndexArtifact(
          result.artifact,
          options.indexArtifactRoot ?? DEFAULT_INDEX_ARTIFACT_ROOT,
        );
        await importIndexArtifact(result.artifact, {
          db: options.db,
          artifactUri,
          enqueueEmbeddings: true,
        });
      } finally {
        await rm(workspace.workspacePath, { force: true, recursive: true });
      }
    },
    [JOB_TYPES.EmbeddingBatch]: async (envelope) => {
      const payload = asEmbeddingBatchPayload(envelope.payload);
      await embedChunkBatch(payload, {
        db: options.db,
        provider: createHashEmbeddingProvider(payload.embeddingModel),
      });
    },
    [JOB_TYPES.ReviewPullRequest]: async (envelope) => {
      const payload = asReviewPullRequestPayload(envelope.payload);

      await runPullRequestReview(payload, {
        db: options.db,
        gitProvider: options.gitProvider,
        ...(options.llmGateway ? { llmGateway: options.llmGateway } : {}),
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
  const llmGateway =
    process.env.HEIMDALL_REVIEW_SMOKE_FINDING === "true"
      ? createWorkerReviewSmokeGateway()
      : undefined;
  const processor = createDurableJobProcessor({
    store,
    handlers: createWorkerHandlers({
      db: databaseClient.db,
      gitProvider,
      ...(llmGateway ? { llmGateway } : {}),
      ...(process.env.REPO_SYNC_WORKSPACE_ROOT
        ? { workspaceRoot: process.env.REPO_SYNC_WORKSPACE_ROOT }
        : {}),
      ...(process.env.INDEX_ARTIFACT_ROOT
        ? { indexArtifactRoot: process.env.INDEX_ARTIFACT_ROOT }
        : {}),
    }),
  });
  const workers = [
    QUEUE_NAMES.repoSync,
    QUEUE_NAMES.indexing,
    QUEUE_NAMES.embedding,
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

/** Creates a deterministic smoke-only gateway for live PR review smoke runs. */
export function createWorkerReviewSmokeGateway(): LLMGateway {
  return {
    generateObject: async (input) =>
      parseWithSchema(input.schemaName, input.schema, createSmokeFindingOutput(input.prompt)),
    generateReviewFindings: async (input) =>
      parseWithSchema(
        "LLMFindingOutput",
        LLMFindingOutputSchema,
        createSmokeFindingOutput(input.prompt),
      ),
  };
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
