import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY } from "@repo/artifacts";
import { JOB_TYPES } from "@repo/contracts";
import {
  validBillingReconcileJobPayloadFixture,
  validEmbeddingBatchJobPayloadFixture,
  validEmbeddingRepairJobPayloadFixture,
  validReviewArtifactCleanupJobPayloadFixture,
  validSandboxCleanupJobPayloadFixture,
} from "@repo/contracts/fixtures/jobs.fixture";
import type { GitHubRepositoryRef } from "@repo/github";
import type { IndexArtifact } from "@repo/index-schema";
import { createFakeIndexerDriver } from "@repo/indexer-driver";
import {
  OBSERVABILITY_METRIC_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
} from "@repo/observability";
import type { PublishOperationType, PublishThrottleSlotInput } from "@repo/publisher";
import { QUEUE_NAMES } from "@repo/queue";
import {
  createRepoSyncConfig,
  getRepoSyncMirrorPath,
  getRepoSyncTempMirrorPath,
  getRepoSyncWorktreePath,
  RepoSyncGitCommandError,
} from "@repo/repo-sync";
import { describe, expect, it, vi } from "vitest";
import {
  acquireWorkerRepositoryWorkspace,
  cleanupExpiredReviewArtifacts,
  cleanupWorkerRepoSyncWorktrees,
  createRedisPublishThrottle,
  createWorkerEmbeddingProviderFromEnvironment,
  createWorkerHandlers,
  createWorkerIndexerDriverFromEnvironment,
  createWorkerLlmBudgetFromEnvironment,
  createWorkerLlmGatewayFromEnvironment,
  createWorkerQueueNamesFromEnvironment,
  createWorkerRepoSyncCleanupLimitFromEnvironment,
  createWorkerReviewIndexDependencyModeFromEnvironment,
  createWorkerReviewSmokeGateway,
  createWorkerStaticAnalysisRunnerFromEnvironment,
  enqueueWaitingReviewRunsForIndex,
  loadGitHubInstallationRef,
  persistIndexArtifactForImport,
  type RedisPublishThrottleClient,
  recordWorkerQueueMetrics,
  resolveWorkerEmbeddingApiKey,
  resolveWorkerGitHubPrivateKey,
  resolveWorkerLlmApiKey,
  verifyWorkerIndexerCapabilities,
} from "./index";

describe("createWorkerReviewSmokeGateway", () => {
  it("emits one anchored smoke finding from the first added diff line", async () => {
    const gateway = createWorkerReviewSmokeGateway();

    const output = await gateway.generateReviewFindings({
      prompt: JSON.stringify({
        changedFiles: [
          {
            path: "heimdall-smoke/pr-review-smoke.txt",
            status: "modified",
            isGenerated: false,
            hunks: [
              {
                lines: [
                  { kind: "context", newLine: 1 },
                  { kind: "addition", newLine: 2 },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(output.findings).toEqual([
      expect.objectContaining({
        path: "heimdall-smoke/pr-review-smoke.txt",
        line: 2,
        severity: "low",
        category: "maintainability",
        title: "Live PR review smoke test",
      }),
    ]);
  });
});

describe("loadGitHubInstallationRef", () => {
  it("maps a GitHub provider installation through the DB boundary", async () => {
    await expect(
      loadGitHubInstallationRef(
        createWorkerProviderInstallationDatabaseStub([
          {
            accountLogin: "acme",
            accountType: "organization",
            deletedAt: null,
            installationId: "inst_worker",
            installedAt: new Date("2026-05-08T00:00:00.000Z"),
            metadata: null,
            orgId: "org_worker",
            permissions: {},
            provider: "github",
            providerInstallationId: "12345",
            suspendedAt: null,
          },
        ]),
        "inst_worker",
      ),
    ).resolves.toEqual({
      installationId: "inst_worker",
      orgId: "org_worker",
      provider: "github",
      providerInstallationId: "12345",
    });
  });

  it("rejects missing or non-GitHub installations", async () => {
    await expect(
      loadGitHubInstallationRef(createWorkerProviderInstallationDatabaseStub([]), "inst_missing"),
    ).rejects.toThrow(/GitHub installation inst_missing was not found/u);
    await expect(
      loadGitHubInstallationRef(
        createWorkerProviderInstallationDatabaseStub([
          {
            accountLogin: "acme",
            accountType: "organization",
            deletedAt: null,
            installationId: "inst_gitlab",
            installedAt: new Date("2026-05-08T00:00:00.000Z"),
            metadata: null,
            orgId: "org_worker",
            permissions: {},
            provider: "gitlab",
            providerInstallationId: "12345",
            suspendedAt: null,
          },
        ]),
        "inst_gitlab",
      ),
    ).rejects.toThrow(/GitHub installation inst_gitlab was not found/u);
  });
});

describe("acquireWorkerRepositoryWorkspace", () => {
  it("resolves clone credentials and acquires a cached repo-sync workspace", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-worker-repo-sync-test-"));
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const mutableCommands: string[][] = [];
    const fetchEnvironments: Readonly<Record<string, string | undefined>>[] = [];
    const cloneAuthInputs: unknown[] = [];
    let commitExists = false;

    try {
      const lease = await acquireWorkerRepositoryWorkspace(
        {
          commitSha,
          gitProvider: {
            getCloneAuth: async (input: GitHubRepositoryRef) => {
              cloneAuthInputs.push(input);
              return {
                cloneUrl: "https://x-access-token:embedded-secret@github.com/acme/api.git?token=1",
                expiresAt: "2026-05-08T00:00:00.000Z",
                password: "token-123",
                username: "x-access-token",
              };
            },
          } as never,
          repoId: "repo_123",
          repoSyncConfig: config,
          repository: {
            installationId: "inst_123",
            owner: "acme",
            provider: "github",
            providerInstallationId: "999",
            providerRepoId: "1000",
            repo: "api",
          },
        },
        {
          gitRunner: async (args, options) => {
            mutableCommands.push([...args]);
            if (args[0] === "clone") {
              await mkdir(args[args.length - 1] ?? "", { recursive: true });
              return "";
            }
            if (args[2] === "cat-file") {
              if (commitExists) {
                return "";
              }
              throw createWorkerMissingCommitGitError();
            }
            if (args[2] === "fetch") {
              fetchEnvironments.push(options.env ?? {});
              commitExists = true;
              return "";
            }
            if (args[2] === "rev-parse" && args[3] === "HEAD") {
              return `${commitSha}\n`;
            }
            if (args[2] === "rev-parse" && args[3] === "--show-toplevel") {
              return `${worktreePath}\n`;
            }
            if (args[2] === "status" && args[3] === "--porcelain=v1") {
              return "";
            }
            if (args[2] === "worktree" && args[3] === "add") {
              await mkdir(worktreePath, { recursive: true });
              return "";
            }
            if (args[2] === "worktree" && args[3] === "remove") {
              await rm(worktreePath, { force: true, recursive: true });
              return "";
            }
            return "";
          },
          leaseIdFactory: () => "lease_123",
          tempIdFactory: () => "tmp_456",
        },
      );

      expect(lease.leaseId).toBe("lease_123");
      expect(lease.workspacePath).toBe(worktreePath);
      await lease.release();

      expect(cloneAuthInputs).toEqual([
        {
          installationId: "inst_123",
          owner: "acme",
          provider: "github",
          providerInstallationId: "999",
          providerRepoId: "1000",
          repo: "api",
        },
      ]);
      expect(mutableCommands).toEqual([
        [
          "clone",
          "--bare",
          "--filter=blob:none",
          "--no-tags",
          "https://github.com/acme/api.git",
          tempMirrorPath,
        ],
        ["-C", mirrorPath, "cat-file", "-e", `${commitSha}^{commit}`],
        ["-C", mirrorPath, "cat-file", "-e", `${commitSha}^{commit}`],
        ["-C", mirrorPath, "fetch", "--no-tags", "origin", commitSha],
        ["-C", mirrorPath, "cat-file", "-e", `${commitSha}^{commit}`],
        ["-C", mirrorPath, "worktree", "add", "--detach", worktreePath, commitSha],
        ["-C", worktreePath, "rev-parse", "HEAD"],
        ["-C", worktreePath, "rev-parse", "--show-toplevel"],
        ["-C", worktreePath, "status", "--porcelain=v1"],
        ["-C", mirrorPath, "worktree", "remove", "--force", worktreePath],
        ["-C", mirrorPath, "worktree", "prune"],
      ]);
      expect(fetchEnvironments).toEqual([
        expect.objectContaining({
          GIT_PASSWORD: "token-123",
          GIT_TERMINAL_PROMPT: "0",
          GIT_USERNAME: "x-access-token",
        }),
      ]);
      expect(JSON.stringify(mutableCommands)).not.toContain("token-123");
      expect(JSON.stringify(mutableCommands)).not.toContain("embedded-secret");
    } finally {
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });
});

describe("cleanupWorkerRepoSyncWorktrees", () => {
  it("passes startup cleanup limits into repo-sync expired worktree cleanup", async () => {
    const config = createRepoSyncConfig({ cacheRoot: "/tmp/heimdall-worker-cleanup" });
    const cleanupInputs: unknown[] = [];

    const result = await cleanupWorkerRepoSyncWorktrees({
      cleanupExpiredWorktrees: async (input) => {
        cleanupInputs.push(input);
        return {
          cutoff: "2026-05-08T00:00:00.000Z",
          dryRun: false,
          expiredWorktreeCount: 2,
          failures: [],
          prunedMirrorCount: 1,
          removedWorktreeCount: 2,
          scannedWorktreeCount: 3,
          skippedWorktreeCount: 1,
        };
      },
      env: {
        REPO_SYNC_EXPIRED_WORKTREE_CLEANUP_LIMIT: "25",
      },
      repoSyncConfig: config,
    });

    expect(result.removedWorktreeCount).toBe(2);
    expect(cleanupInputs).toEqual([
      {
        config,
        limit: 25,
      },
    ]);
  });
});

describe("createWorkerRepoSyncCleanupLimitFromEnvironment", () => {
  it("prefers the worker-specific expired worktree cleanup limit", () => {
    expect(
      createWorkerRepoSyncCleanupLimitFromEnvironment({
        HEIMDALL_REPO_SYNC_EXPIRED_WORKTREE_CLEANUP_LIMIT: "9",
        REPO_SYNC_CLEANUP_LIMIT: "3",
        REPO_SYNC_EXPIRED_WORKTREE_CLEANUP_LIMIT: "5",
      }),
    ).toBe(9);
  });
});

describe("resolveWorkerGitHubPrivateKey", () => {
  it("resolves the local GitHub private key through an env secret ref", async () => {
    await expect(
      resolveWorkerGitHubPrivateKey({
        GITHUB_PRIVATE_KEY: "line-one\\nline-two",
      }),
    ).resolves.toBe("line-one\nline-two");
  });

  it("resolves an explicit GitHub private key secret ref", async () => {
    await expect(
      resolveWorkerGitHubPrivateKey({
        GITHUB_APP_PRIVATE_KEY_SECRET_REF: "env:WORKER_GITHUB_PRIVATE_KEY",
        GITHUB_PRIVATE_KEY: "ignored-direct-value",
        WORKER_GITHUB_PRIVATE_KEY: "resolved\\nprivate-key",
      }),
    ).resolves.toBe("resolved\nprivate-key");
  });

  it("returns undefined when no private key ref or env fallback exists", async () => {
    await expect(resolveWorkerGitHubPrivateKey({})).resolves.toBeUndefined();
  });

  it("fails closed for unsupported production providers", async () => {
    await expect(
      resolveWorkerGitHubPrivateKey({
        GITHUB_APP_PRIVATE_KEY_SECRET_REF: "aws:prod/github-app/private-key",
      }),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });
});

describe("resolveWorkerLlmApiKey", () => {
  it("resolves the local LLM provider API key through an env secret ref", async () => {
    await expect(
      resolveWorkerLlmApiKey({
        OPENAI_API_KEY: "sk-test-openai-key",
      }),
    ).resolves.toBe("sk-test-openai-key");
  });

  it("resolves an explicit LLM provider API key secret ref", async () => {
    await expect(
      resolveWorkerLlmApiKey({
        LLM_PROVIDER_API_KEY_SECRET_REF: "env:WORKER_LLM_API_KEY",
        OPENAI_API_KEY: "ignored-direct-key",
        WORKER_LLM_API_KEY: "sk-resolved-worker-key",
      }),
    ).resolves.toBe("sk-resolved-worker-key");
  });

  it("returns undefined when no LLM provider API key ref or env fallback exists", async () => {
    await expect(resolveWorkerLlmApiKey({})).resolves.toBeUndefined();
  });

  it("fails closed for unsupported LLM provider secret providers", async () => {
    await expect(
      resolveWorkerLlmApiKey({
        LLM_PROVIDER_API_KEY_SECRET_REF: "aws:prod/openai/api-key",
      }),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });
});

describe("resolveWorkerEmbeddingApiKey", () => {
  it("resolves the local embedding provider API key through an env secret ref", async () => {
    await expect(
      resolveWorkerEmbeddingApiKey({
        OPENAI_EMBEDDING_API_KEY: "sk-test-embedding-key",
      }),
    ).resolves.toBe("sk-test-embedding-key");
  });

  it("resolves an explicit embedding provider API key secret ref", async () => {
    await expect(
      resolveWorkerEmbeddingApiKey({
        EMBEDDING_PROVIDER_API_KEY_SECRET_REF: "env:WORKER_EMBEDDING_API_KEY",
        OPENAI_API_KEY: "ignored-direct-key",
        WORKER_EMBEDDING_API_KEY: "sk-resolved-embedding-key",
      }),
    ).resolves.toBe("sk-resolved-embedding-key");
  });

  it("returns undefined when no embedding provider API key ref or env fallback exists", async () => {
    await expect(resolveWorkerEmbeddingApiKey({})).resolves.toBeUndefined();
  });

  it("fails closed for unsupported embedding provider secret providers", async () => {
    await expect(
      resolveWorkerEmbeddingApiKey({
        EMBEDDING_PROVIDER_API_KEY_SECRET_REF: "aws:prod/openai/embeddings-api-key",
      }),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });
});

describe("createWorkerLlmGatewayFromEnvironment", () => {
  it("creates an optional LLM budget from worker environment", () => {
    expect(
      createWorkerLlmBudgetFromEnvironment({
        HEIMDALL_LLM_MAX_PROMPT_CHARS: "100",
        HEIMDALL_LLM_MAX_TOTAL_INPUT_CHARS: "200",
      }),
    ).toEqual({
      maxPromptChars: 100,
      maxTotalInputChars: 200,
    });
  });

  it("keeps the review LLM disabled by default", async () => {
    await expect(createWorkerLlmGatewayFromEnvironment({})).resolves.toBeUndefined();
  });

  it("creates an OpenAI-compatible gateway from explicit worker environment", async () => {
    const calls: RecordedLlmFetchCall[] = [];
    const gateway = await createWorkerLlmGatewayFromEnvironment(
      {
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-openai-key",
        OPENAI_MODEL: "gpt-test",
      },
      {
        fetch: async (url, init) => {
          calls.push({ ...(init ? { init } : {}), url: String(url) });
          return llmChatCompletionResponse({ findings: [] });
        },
      },
    );
    if (!gateway) {
      throw new Error("Expected configured worker LLM gateway.");
    }

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).resolves.toEqual({
      findings: [],
    });

    const call = requireFirstLlmFetchCall(calls);
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.init).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer sk-test-openai-key",
      }),
      method: "POST",
    });
    expect(llmRequestJsonBody(call)).toMatchObject({
      model: "gpt-test",
      response_format: { type: "json_object" },
      store: false,
    });
  });

  it("routes review finding calls to the task-specific OpenAI model", async () => {
    const calls: RecordedLlmFetchCall[] = [];
    const gateway = await createWorkerLlmGatewayFromEnvironment(
      {
        HEIMDALL_LLM_REVIEW_FINDINGS_MODEL: "gpt-review-findings",
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-openai-key",
        OPENAI_MODEL: "gpt-default",
      },
      {
        fetch: async (url, init) => {
          calls.push({ ...(init ? { init } : {}), url: String(url) });
          return llmChatCompletionResponse({ findings: [] });
        },
      },
    );
    if (!gateway) {
      throw new Error("Expected configured worker LLM gateway.");
    }

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).resolves.toEqual({
      findings: [],
    });

    expect(llmRequestJsonBody(requireFirstLlmFetchCall(calls))).toMatchObject({
      model: "gpt-review-findings",
    });
  });

  it("enforces configured LLM input budgets before provider calls", async () => {
    const calls: RecordedLlmFetchCall[] = [];
    const gateway = await createWorkerLlmGatewayFromEnvironment(
      {
        HEIMDALL_LLM_MAX_PROMPT_CHARS: "3",
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-openai-key",
        OPENAI_MODEL: "gpt-test",
      },
      {
        fetch: async (url, init) => {
          calls.push({ ...(init ? { init } : {}), url: String(url) });
          return llmChatCompletionResponse({ findings: [] });
        },
      },
    );
    if (!gateway) {
      throw new Error("Expected configured worker LLM gateway.");
    }

    await expect(gateway.generateReviewFindings({ prompt: "1234" })).rejects.toMatchObject({
      code: "budget_exceeded",
      details: {
        maxPromptChars: 3,
        promptChars: 4,
      },
      retryable: false,
    });
    expect(calls).toEqual([]);
  });

  it("keeps the smoke gateway as an explicit mode", async () => {
    const gateway = await createWorkerLlmGatewayFromEnvironment({
      HEIMDALL_REVIEW_SMOKE_FINDING: "true",
    });
    if (!gateway) {
      throw new Error("Expected smoke worker LLM gateway.");
    }

    const output = await gateway.generateReviewFindings({
      prompt: JSON.stringify({
        changedFiles: [
          {
            hunks: [{ lines: [{ kind: "addition", newLine: 9 }] }],
            path: "heimdall-smoke/pr-review-smoke.txt",
            status: "modified",
          },
        ],
      }),
    });

    expect(output.findings).toEqual([
      expect.objectContaining({
        line: 9,
        path: "heimdall-smoke/pr-review-smoke.txt",
        title: "Live PR review smoke test",
      }),
    ]);
  });

  it("requires an API key when the OpenAI-compatible provider is configured", async () => {
    await expect(
      createWorkerLlmGatewayFromEnvironment({
        LLM_PROVIDER: "openai",
        OPENAI_MODEL: "gpt-test",
      }),
    ).rejects.toThrow(
      "LLM_PROVIDER_API_KEY_SECRET_REF, OPENAI_API_KEY_SECRET_REF, or OPENAI_API_KEY is required",
    );
  });

  it("rejects unsupported worker LLM providers", async () => {
    await expect(
      createWorkerLlmGatewayFromEnvironment({
        LLM_PROVIDER: "bogus",
      }),
    ).rejects.toThrow("Unsupported LLM_PROVIDER: bogus");
  });
});

describe("createWorkerReviewIndexDependencyModeFromEnvironment", () => {
  it("leaves review index dependency behavior unset by default", () => {
    expect(createWorkerReviewIndexDependencyModeFromEnvironment({})).toBeUndefined();
  });

  it("parses supported review index dependency modes", () => {
    expect(
      createWorkerReviewIndexDependencyModeFromEnvironment({
        HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE: "pause",
      }),
    ).toBe("pause");
    expect(
      createWorkerReviewIndexDependencyModeFromEnvironment({
        HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE: " FALLBACK ",
      }),
    ).toBe("fallback");
  });

  it("rejects unsupported review index dependency modes", () => {
    expect(() =>
      createWorkerReviewIndexDependencyModeFromEnvironment({
        HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE: "wait",
      }),
    ).toThrow("Unsupported HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE: wait");
  });
});

describe("createWorkerQueueNamesFromEnvironment", () => {
  it("uses all worker queues when no role is configured", () => {
    expect(createWorkerQueueNamesFromEnvironment({})).toEqual([
      QUEUE_NAMES.repoSync,
      QUEUE_NAMES.indexing,
      QUEUE_NAMES.embedding,
      QUEUE_NAMES.review,
      QUEUE_NAMES.memory,
      QUEUE_NAMES.publishing,
      QUEUE_NAMES.billing,
    ]);
  });

  it("selects independent queues for comma-separated worker roles", () => {
    expect(
      createWorkerQueueNamesFromEnvironment({
        WORKER_ROLE: "review,publisher",
      }),
    ).toEqual([QUEUE_NAMES.review, QUEUE_NAMES.publishing]);
  });

  it("lets the Heimdall-specific role override the generic worker role", () => {
    expect(
      createWorkerQueueNamesFromEnvironment({
        HEIMDALL_WORKER_ROLE: "index",
        WORKER_ROLE: "review",
      }),
    ).toEqual([QUEUE_NAMES.indexing]);
  });

  it("supports a maintenance-only worker with no queue consumers", () => {
    expect(
      createWorkerQueueNamesFromEnvironment({
        WORKER_ROLE: "maintenance",
      }),
    ).toEqual([]);
  });

  it("rejects unknown worker roles", () => {
    expect(() =>
      createWorkerQueueNamesFromEnvironment({
        WORKER_ROLE: "not-a-role",
      }),
    ).toThrow("Unsupported worker role: not-a-role");
  });
});

describe("recordWorkerQueueMetrics", () => {
  it("records queue depth and oldest pending job age gauges", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    const metrics: WorkerRecordedMetric[] = [];

    await recordWorkerQueueMetrics({
      metrics: createWorkerRecordingMetrics(metrics),
      now,
      queues: [
        {
          getJobCounts: async () => ({
            active: 1,
            completed: 8,
            failed: 2,
            waiting: 3,
          }),
          getJobs: async () => [{ timestamp: now.getTime() - 5_000 }],
          queueName: QUEUE_NAMES.review,
        },
      ],
    });

    expect(metrics).toEqual(
      expect.arrayContaining([
        {
          labels: { queue_name: QUEUE_NAMES.review, status: "waiting" },
          name: OBSERVABILITY_METRIC_NAMES.queueDepth,
          value: 3,
        },
        {
          labels: { queue_name: QUEUE_NAMES.review, status: "delayed" },
          name: OBSERVABILITY_METRIC_NAMES.queueDepth,
          value: 0,
        },
        {
          labels: { queue_name: QUEUE_NAMES.review, status: "active" },
          name: OBSERVABILITY_METRIC_NAMES.queueDepth,
          value: 1,
        },
        {
          labels: { queue_name: QUEUE_NAMES.review },
          name: OBSERVABILITY_METRIC_NAMES.queueOldestJobAgeMs,
          value: 5_000,
        },
      ]),
    );
  });
});

describe("createWorkerEmbeddingProviderFromEnvironment", () => {
  it("keeps the local hash embedding provider as the default", async () => {
    const provider = await createWorkerEmbeddingProviderFromEnvironment(
      {},
      { model: "text-embedding-3-small" },
    );

    expect(provider).toMatchObject({
      model: "text-embedding-3-small",
      providerId: "hash",
    });
  });

  it("creates an OpenAI-compatible embedding provider from explicit worker environment", async () => {
    const calls: RecordedEmbeddingFetchCall[] = [];
    const provider = await createWorkerEmbeddingProviderFromEnvironment(
      {
        EMBEDDING_DIMENSIONS: "2",
        EMBEDDING_PROVIDER: "openai",
        OPENAI_EMBEDDING_API_KEY: "sk-test-embedding-key",
      },
      {
        fetch: async (url, init) => {
          calls.push({ ...(init ? { init } : {}), url: String(url) });
          return embeddingResponse({
            data: [{ embedding: [0.1, 0.2], index: 0 }],
          });
        },
        model: "text-embedding-3-small",
      },
    );

    await expect(provider.embedTexts(["first"])).resolves.toEqual([[0.1, 0.2]]);

    const call = requireFirstEmbeddingFetchCall(calls);
    expect(call.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call.init).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer sk-test-embedding-key",
      }),
      method: "POST",
    });
    expect(embeddingRequestJsonBody(call)).toMatchObject({
      dimensions: 2,
      encoding_format: "float",
      input: ["first"],
      model: "text-embedding-3-small",
    });
  });

  it("requires an API key when the OpenAI-compatible embedding provider is configured", async () => {
    await expect(
      createWorkerEmbeddingProviderFromEnvironment({
        EMBEDDING_PROVIDER: "openai",
      }),
    ).rejects.toThrow(
      "EMBEDDING_PROVIDER_API_KEY_SECRET_REF, OPENAI_EMBEDDING_API_KEY_SECRET_REF, OPENAI_API_KEY_SECRET_REF, or OPENAI_API_KEY is required",
    );
  });

  it("rejects unsupported worker embedding providers", async () => {
    await expect(
      createWorkerEmbeddingProviderFromEnvironment({
        EMBEDDING_PROVIDER: "bogus",
      }),
    ).rejects.toThrow("Unsupported EMBEDDING_PROVIDER: bogus");
  });
});

describe("createWorkerHandlers", () => {
  it("records embedding usage events through the configured ledger", async () => {
    const usageEvents: unknown[] = [];
    const payload = validEmbeddingBatchJobPayloadFixture;
    const handlers = createWorkerHandlers({
      db: createWorkerEmbeddingDatabaseStub(payload.chunkIds),
      embeddingProvider: {
        dimensions: 2,
        embedTexts: async (texts) => texts.map(() => [0.1, 0.2]),
        model: payload.embeddingModel,
        providerId: "fake",
      },
      gitProvider: {} as never,
      usageLedger: {
        record: async (event: unknown) => {
          usageEvents.push(event);
        },
      } as never,
    });

    await handlers[JOB_TYPES.EmbeddingBatch]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "embedding:batch:idx_01HXAMPLE:chunk_01HXAMPLE",
      jobId: "job_embedding_batch",
      jobType: JOB_TYPES.EmbeddingBatch,
      maxAttempts: 3,
      payload,
      schemaVersion: "embedding_batch_job.v1",
    });

    expect(usageEvents).toEqual([
      expect.objectContaining({
        eventType: "embedding.token",
        metadata: expect.objectContaining({
          dimensions: 2,
          inputCount: 1,
          inputKind: "code_chunk",
          provider: "fake",
          requestedModel: payload.embeddingModel,
        }),
        orgId: "org_1",
        repoId: payload.repoId,
        unit: "token",
      }),
    ]);
    expect(JSON.stringify(usageEvents)).not.toContain("src/private.ts");
    expect(JSON.stringify(usageEvents)).not.toContain("secretValue");
  });

  it("dispatches billing reconciliation jobs through the configured reconciler", async () => {
    const payloads: unknown[] = [];
    const handlers = createWorkerHandlers({
      billingReconciler: async (payload) => {
        payloads.push(payload);
      },
      db: {} as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.BillingReconcile]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "billing:reconcile:org_01HXAMPLE:2026-05",
      jobId: "job_billing_reconcile",
      jobType: JOB_TYPES.BillingReconcile,
      maxAttempts: 3,
      payload: validBillingReconcileJobPayloadFixture,
      schemaVersion: "billing_reconcile_job.v1",
    });

    expect(payloads).toEqual([validBillingReconcileJobPayloadFixture]);
  });

  it("dispatches embedding repair jobs through the configured repairer", async () => {
    const payloads: unknown[] = [];
    const handlers = createWorkerHandlers({
      db: {} as never,
      embeddingRepairer: async (payload) => {
        payloads.push(payload);
      },
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.EmbeddingRepair]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "embedding:repair:idx_01HXAMPLE",
      jobId: "job_embedding_repair",
      jobType: JOB_TYPES.EmbeddingRepair,
      maxAttempts: 3,
      payload: validEmbeddingRepairJobPayloadFixture,
      schemaVersion: "embedding_repair_job.v1",
    });

    expect(payloads).toEqual([validEmbeddingRepairJobPayloadFixture]);
  });

  it("enqueues missing chunks discovered by embedding repair jobs", async () => {
    const insertedRows: unknown[] = [];
    const updatedValues: unknown[] = [];
    const payload = {
      ...validEmbeddingRepairJobPayloadFixture,
      embeddingJobId: "embjob_1",
      model: "text-embedding-3-small",
    };
    const handlers = createWorkerHandlers({
      db: createWorkerEmbeddingRepairDatabaseStub({ insertedRows, updatedValues }),
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.EmbeddingRepair]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "embedding:repair:embjob_1",
      jobId: "job_embedding_repair",
      jobType: JOB_TYPES.EmbeddingRepair,
      maxAttempts: 3,
      payload,
      schemaVersion: "embedding_repair_job.v1",
    });

    expect(updatedValues).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending" })]),
    );
    expect(insertedRows).toEqual([
      expect.objectContaining({
        jobKey: "embedding:repair:embjob_1:batch:0",
        jobType: JOB_TYPES.EmbeddingBatch,
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            chunkIds: ["chunk_missing"],
            embeddingJobId: "embjob_1",
            embeddingModel: "text-embedding-3-small",
          }),
        }),
        queueName: "embedding",
        repoId: payload.repoId,
        status: "pending",
      }),
    ]);
  });

  it("requeues reviews waiting for a completed index dependency", async () => {
    const insertedRows: unknown[] = [];
    const db = {
      insert: () => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [createBackgroundJobInsertedRow(value)],
            }),
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => {
            const rows = [
              {
                baseSha: "1111111",
                dryRunMetadata: { dryRun: true },
                headSha: "2222222",
                pullRequestNumber: 7,
                reviewRunId: "rrn_waiting",
                trigger: "webhook",
              },
            ];

            return {
              limit: async () => rows,
              orderBy: () => ({
                limit: async () => rows,
              }),
            };
          },
        }),
      }),
    };

    await expect(
      enqueueWaitingReviewRunsForIndex(
        db as never,
        {
          commitSha: "2222222",
          installationId: "inst_test",
          priority: "high",
          reason: "pr_review",
          repoId: "repo_test",
        },
        {
          timestamp: "2026-05-08T00:00:00.000Z",
          traceContext: { requestId: "req_index" },
        },
      ),
    ).resolves.toEqual({
      enqueuedCount: 1,
      inspectedCount: 1,
    });

    expect(insertedRows).toEqual([
      expect.objectContaining({
        jobKey: "github:review-resume:repo_test:7:2222222:index",
        jobType: JOB_TYPES.ReviewPullRequest,
        metadata: {
          completedIndexCommitSha: "2222222",
          source: "index_dependency_ready",
        },
        payload: expect.objectContaining({
          createdAt: "2026-05-08T00:00:00.000Z",
          idempotencyKey: "github:review-resume:repo_test:7:2222222:index",
          jobType: JOB_TYPES.ReviewPullRequest,
          payload: {
            baseSha: "1111111",
            dryRun: true,
            headSha: "2222222",
            installationId: "inst_test",
            pullRequestNumber: 7,
            repoId: "repo_test",
            trigger: "webhook",
          },
          traceContext: { requestId: "req_index" },
        }),
        queueName: "review",
        repoId: "repo_test",
        reviewRunId: "rrn_waiting",
        status: "pending",
      }),
    ]);
  });

  it("dispatches sandbox cleanup jobs through the configured cleaner", async () => {
    const payloads: unknown[] = [];
    const handlers = createWorkerHandlers({
      db: {} as never,
      gitProvider: {} as never,
      sandboxCleaner: async (payload) => {
        payloads.push(payload);
      },
    });

    await handlers[JOB_TYPES.SandboxCleanup]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "sandbox:cleanup:repo_01HXAMPLE:2026-05-01",
      jobId: "job_sandbox_cleanup",
      jobType: JOB_TYPES.SandboxCleanup,
      maxAttempts: 3,
      payload: validSandboxCleanupJobPayloadFixture,
      schemaVersion: "sandbox_cleanup_job.v1",
    });

    expect(payloads).toEqual([validSandboxCleanupJobPayloadFixture]);
  });

  it("dispatches review artifact cleanup jobs through the configured cleaner", async () => {
    const payloads: unknown[] = [];
    const handlers = createWorkerHandlers({
      db: {} as never,
      gitProvider: {} as never,
      reviewArtifactCleaner: async (payload) => {
        payloads.push(payload);
      },
    });

    await handlers[JOB_TYPES.ReviewArtifactCleanup]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "review-artifact:cleanup:repo_01HXAMPLE:2026-05-01",
      jobId: "job_review_artifact_cleanup",
      jobType: JOB_TYPES.ReviewArtifactCleanup,
      maxAttempts: 3,
      payload: validReviewArtifactCleanupJobPayloadFixture,
      schemaVersion: "review_artifact_cleanup_job.v1",
    });

    expect(payloads).toEqual([validReviewArtifactCleanupJobPayloadFixture]);
  });

  it("scrubs expired review artifact payload metadata during cleanup", async () => {
    const updates: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  metadata: {
                    payload: { snippets: ["src/index.ts"] },
                    payloadStorage: {
                      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                      mediaType: "application/json",
                      mode: "inline_db",
                      sizeBytes: 31,
                      uri: "db://review_artifacts/rrn_1/context_bundle/context-bundle.json",
                    },
                    redactionLevel: "contains_code",
                  },
                  reviewArtifactId: "art_expired",
                  uri: "db://review_artifacts/rrn_1/context_bundle/context-bundle.json",
                },
              ],
            }),
          }),
        }),
      }),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return {
            where: async () => undefined,
          };
        },
      }),
    };

    await expect(
      cleanupExpiredReviewArtifacts(
        db as never,
        {
          before: "2026-05-07T12:00:00.000Z",
          limit: 100,
          reason: "retention_policy",
        },
        undefined,
        new Date("2026-05-07T12:15:00.000Z"),
      ),
    ).resolves.toEqual({
      cutoff: "2026-05-07T12:00:00.000Z",
      deletedPayloadCount: 1,
      dryRun: false,
      failedPayloadCount: 0,
      missingPayloadCount: 0,
      selectedArtifactCount: 1,
      updatedArtifactCount: 1,
    });

    expect(updates).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          [REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY]: {
            deletedAt: "2026-05-07T12:15:00.000Z",
            reason: "retention_policy",
          },
          redactionLevel: "contains_code",
        }),
        sizeBytes: 0,
        uri: "deleted://review_artifacts/art_expired",
      }),
    ]);
    expect(JSON.stringify(updates)).not.toContain("src/index.ts");
  });

  it("creates pending memory candidates from rejected finding outcome jobs", async () => {
    const selectRows: unknown[][] = [
      [
        {
          candidateFindingId: "cf_1",
          createdAt: new Date("2026-05-07T12:00:00.000Z"),
          findingOutcomeId: "out_1",
          metadata: {},
          occurredAt: new Date("2026-05-07T12:00:00.000Z"),
          orgId: "org_1",
          outcome: "rejected",
          publishedFindingId: "pub_1",
          repoId: "repo_1",
          source: "user_action",
        },
      ],
      [
        {
          body: "This pattern is intentional.",
          category: "correctness",
          confidence: 0.91,
          findingId: "vf_1",
          fingerprint: "fp_1",
          location: { path: "src/auth.ts" },
          reviewRunId: "rrn_1",
          severity: "medium",
          title: "Auth validation is missing here",
        },
      ],
    ];
    const insertedCandidates: unknown[] = [];
    type SelectChain = {
      readonly innerJoin: () => SelectChain;
      readonly leftJoin: () => SelectChain;
      readonly where: () => {
        readonly limit: () => Promise<unknown[]>;
      };
    };
    const selectChain: SelectChain = {
      innerJoin: () => selectChain,
      leftJoin: () => selectChain,
      where: () => ({
        limit: async () => selectRows.shift() ?? [],
      }),
    };
    const db = {
      insert: () => ({
        values: (value: unknown) => {
          insertedCandidates.push(value);
          return {
            onConflictDoNothing: async () => undefined,
          };
        },
      }),
      select: () => ({
        from: () => selectChain,
      }),
    };
    const handlers = createWorkerHandlers({
      db: db as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.UpdateMemory]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "memory:finding_outcome:vf_1:out_1",
      jobId: "job_memory_update",
      jobType: JOB_TYPES.UpdateMemory,
      maxAttempts: 3,
      payload: {
        findingId: "vf_1",
        outcomeId: "out_1",
        reason: "finding_outcome",
        repoId: "repo_1",
      },
      schemaVersion: "job_envelope.v1",
    });

    expect(insertedCandidates).toEqual([
      expect.objectContaining({
        candidateKind: "suppress_similar_finding",
        confidence: 0.91,
        orgId: "org_1",
        repoId: "repo_1",
        sourceFindingId: "pub_1",
        sourceKind: "dashboard",
        status: "pending",
        trustLevel: "admin",
      }),
    ]);
  });

  it("records provider webhook outcomes from correlated feedback jobs", async () => {
    const selectRows: unknown[][] = [
      [
        {
          body: "Leaked debug output should not be committed.",
          candidateFindingId: "cf_1",
          category: "correctness",
          confidence: 0.93,
          findingId: "vf_1",
          fingerprint: "fp_feedback_1",
          location: { path: "src/debug.ts", startLine: 12 },
          orgId: "org_1",
          publishedFindingId: "pub_1",
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          severity: "medium",
          title: "Debug output is still enabled",
        },
      ],
    ];
    const insertedOutcomes: unknown[] = [];
    const db = createWorkerSequentialDatabaseStub({ insertedRows: insertedOutcomes, selectRows });
    const handlers = createWorkerHandlers({
      db: db as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.UpdateMemory]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "github:memory:fb_1",
      jobId: "job_memory_feedback",
      jobType: JOB_TYPES.UpdateMemory,
      maxAttempts: 3,
      payload: {
        actorLogin: "maintainer",
        externalCommentId: "888",
        externalEventId: "fb_1",
        feedbackKind: "negative_reaction",
        provider: "github",
        reason: "provider_reaction",
        repoId: "repo_1",
      },
      schemaVersion: "job_envelope.v1",
    });

    expect(insertedOutcomes).toEqual([
      expect.objectContaining({
        eventKind: "reaction_added",
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        orgId: "org_1",
        payloadRedacted: expect.objectContaining({
          feedbackKind: "negative_reaction",
        }),
        publishedFindingId: "pub_1",
        repoId: "repo_1",
      }),
      expect.objectContaining({
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        polarity: "negative",
        signalKind: "negative_reaction",
      }),
      expect.objectContaining({
        candidateFindingId: "cf_1",
        orgId: "org_1",
        outcome: "negative_reaction",
        publishedFindingId: "pub_1",
        repoId: "repo_1",
        source: "provider_webhook",
      }),
    ]);
    expect(insertedOutcomes[2]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          actorLogin: "maintainer",
          externalCommentId: "888",
          externalEventId: "fb_1",
          feedbackKind: "negative_reaction",
          reason: "provider_reaction",
        }),
      }),
    );
  });

  it("records provider webhook outcomes from review thread resolution feedback jobs", async () => {
    const selectRows: unknown[][] = [
      [
        {
          body: "Leaked debug output should not be committed.",
          candidateFindingId: "cf_1",
          category: "correctness",
          confidence: 0.93,
          findingId: "vf_1",
          fingerprint: "fp_thread_1",
          location: { path: "src/debug.ts", startLine: 12 },
          orgId: "org_1",
          publishedFindingId: "pub_1",
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          severity: "medium",
          title: "Debug output is still enabled",
        },
      ],
    ];
    const insertedRows: unknown[] = [];
    const db = createWorkerSequentialDatabaseStub({ insertedRows, selectRows });
    const handlers = createWorkerHandlers({
      db: db as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.UpdateMemory]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "github:memory:fb_thread",
      jobId: "job_memory_thread_feedback",
      jobType: JOB_TYPES.UpdateMemory,
      maxAttempts: 3,
      payload: {
        actorLogin: "maintainer",
        externalCommentId: "888",
        externalEventId: "fb_thread",
        externalThreadId: "444",
        feedbackKind: "thread_resolved",
        provider: "github",
        reason: "comment_thread",
        repoId: "repo_1",
      },
      schemaVersion: "job_envelope.v1",
    });

    expect(insertedRows).toEqual([
      expect.objectContaining({
        eventKind: "review_thread_resolved",
        externalThreadId: "444",
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        orgId: "org_1",
        payloadRedacted: expect.objectContaining({
          externalThreadId: "444",
          feedbackKind: "thread_resolved",
        }),
        publishedFindingId: "pub_1",
        repoId: "repo_1",
      }),
      expect.objectContaining({
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        polarity: "positive",
        signalKind: "thread_resolved",
      }),
      expect.objectContaining({
        candidateFindingId: "cf_1",
        orgId: "org_1",
        outcome: "resolved",
        publishedFindingId: "pub_1",
        repoId: "repo_1",
        source: "provider_webhook",
      }),
    ]);
  });

  it("reconciles scheduled review thread state into provider feedback outcomes", async () => {
    const selectRows: unknown[][] = [
      [
        {
          installationId: "inst_1",
          owner: "acme",
          provider: "github",
          providerInstallationId: "123456",
          providerRepoId: "987654",
          repo: "heimdall",
        },
      ],
      [
        {
          pullRequestNumber: 7,
          reviewRunId: "rrn_1",
        },
      ],
      [
        {
          body: "Debug logging should not be enabled in production.",
          candidateFindingId: "cf_1",
          category: "correctness",
          confidence: 0.9,
          findingId: "vf_1",
          fingerprint: "fp_reconcile_thread_1",
          location: { path: "src/debug.ts", startLine: 12 },
          orgId: "org_1",
          publishedFindingId: "pub_1",
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          severity: "medium",
          title: "Debug logging is enabled",
        },
      ],
    ];
    const insertedRows: unknown[] = [];
    const db = createWorkerSequentialDatabaseStub({ insertedRows, selectRows });
    const requestedRefs: unknown[] = [];
    const handlers = createWorkerHandlers({
      db: db as never,
      gitProvider: {
        provider: "github",
        fetchReviewThreadStates: async (input: unknown) => {
          requestedRefs.push(input);
          return [
            {
              providerCommentIds: ["888"],
              providerThreadId: "PRRT_1",
              isResolved: true,
            },
          ];
        },
      } as never,
    });

    await handlers[JOB_TYPES.UpdateMemory]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "github:memory:thread-reconcile:repo_1",
      jobId: "job_memory_thread_reconcile",
      jobType: JOB_TYPES.UpdateMemory,
      maxAttempts: 3,
      payload: {
        provider: "github",
        pullRequestNumber: 7,
        reason: "scheduled",
        repoId: "repo_1",
      },
      schemaVersion: "job_envelope.v1",
    });

    expect(requestedRefs).toEqual([
      expect.objectContaining({
        installationId: "inst_1",
        owner: "acme",
        providerInstallationId: "123456",
        providerRepoId: "987654",
        pullRequestNumber: 7,
        repo: "heimdall",
      }),
    ]);
    expect(insertedRows).toEqual([
      expect.objectContaining({
        eventKind: "review_thread_resolved",
        externalThreadId: "PRRT_1",
        payloadRedacted: expect.objectContaining({
          feedbackSource: "reconciliation",
        }),
        publishedFindingId: "pub_1",
        source: "reconciliation",
      }),
      expect.objectContaining({
        polarity: "positive",
        signalKind: "thread_resolved",
      }),
      expect.objectContaining({
        outcome: "resolved",
        publishedFindingId: "pub_1",
        source: "provider_webhook",
      }),
    ]);
  });

  it("creates pending memory candidates from trusted provider feedback commands", async () => {
    const selectRows: unknown[][] = [
      [
        {
          body: "This pattern is noisy for this repository.",
          candidateFindingId: "cf_1",
          category: "maintainability",
          confidence: 0.88,
          findingId: "vf_1",
          fingerprint: "fp_command_1",
          location: { path: "src/generated/client.ts" },
          orgId: "org_1",
          publishedFindingId: "pub_1",
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          severity: "low",
          title: "Generated client method is missing docs",
        },
      ],
    ];
    const insertedRows: unknown[] = [];
    const db = createWorkerSequentialDatabaseStub({ insertedRows, selectRows });
    const handlers = createWorkerHandlers({
      db: db as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.UpdateMemory]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "github:memory:fb_command",
      jobId: "job_memory_feedback_command",
      jobType: JOB_TYPES.UpdateMemory,
      maxAttempts: 3,
      payload: {
        actorLogin: "maintainer",
        bodyHash: `sha256:${"a".repeat(64)}`,
        externalCommentId: "889",
        externalEventId: "fb_command",
        feedbackCommand: {
          commandHash: `sha256:${"b".repeat(64)}`,
          commandKind: "suppress_similar",
          confidence: 0.94,
          content: "generated client documentation noise",
          proposedAppliesTo: {
            titlePatterns: ["generated client documentation noise"],
          },
          proposedScope: {
            level: "repo",
            orgId: "org_1",
            repoId: "repo_1",
          },
        },
        feedbackKind: "comment_reply",
        provider: "github",
        reason: "comment_reply",
        repoId: "repo_1",
      },
      schemaVersion: "job_envelope.v1",
    });

    expect(insertedRows).toEqual([
      expect.objectContaining({
        eventKind: "issue_comment_created",
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        payloadRedacted: expect.objectContaining({
          feedbackCommand: expect.objectContaining({
            commandKind: "suppress_similar",
          }),
          feedbackKind: "comment_reply",
        }),
        publishedFindingId: "pub_1",
      }),
      expect.objectContaining({
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        polarity: "suppression",
        signalKind: "explicit_suppress_command",
      }),
      expect.objectContaining({
        outcome: "dismissed",
        publishedFindingId: "pub_1",
        source: "provider_webhook",
      }),
      expect.objectContaining({
        candidateKind: "suppress_similar_finding",
        createdByLogin: "maintainer",
        proposedAppliesTo: {
          titlePatterns: ["generated client documentation noise"],
        },
        proposedContent: "generated client documentation noise",
        sourceFeedbackEventId: "fb_command",
        sourceFindingId: "pub_1",
        sourceKind: "command",
        status: "pending",
        trustLevel: "explicit_maintainer",
      }),
    ]);
  });

  it("creates pending memory candidates from trusted PR summary commands", async () => {
    const selectRows: unknown[][] = [
      [],
      [
        {
          orgId: "org_1",
          providerCommentId: "summary_1",
          publishedSummaryCommentId: "psc_1",
          repoId: "repo_1",
          reviewRunId: "rrn_1",
        },
      ],
    ];
    const insertedRows: unknown[] = [];
    const db = createWorkerSequentialDatabaseStub({ insertedRows, selectRows });
    const handlers = createWorkerHandlers({
      db: db as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.UpdateMemory]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "github:memory:fb_summary",
      jobId: "job_memory_summary_command",
      jobType: JOB_TYPES.UpdateMemory,
      maxAttempts: 3,
      payload: {
        actorLogin: "maintainer",
        bodyHash: `sha256:${"c".repeat(64)}`,
        externalCommentId: "summary_1",
        externalEventId: "fb_summary",
        feedbackCommand: {
          commandHash: `sha256:${"d".repeat(64)}`,
          commandKind: "remember_fact",
          confidence: 0.96,
          content: "API handlers use shared middleware for authentication.",
          proposedAppliesTo: {},
          proposedScope: {
            level: "repo",
            orgId: "org_1",
            repoId: "repo_1",
          },
        },
        feedbackKind: "comment_reply",
        provider: "github",
        reason: "comment_reply",
        repoId: "repo_1",
      },
      schemaVersion: "job_envelope.v1",
    });

    expect(insertedRows).toEqual([
      expect.objectContaining({
        eventKind: "issue_comment_created",
        feedbackEventId: expect.stringMatching(/^fevt_/u),
        reviewRunId: "rrn_1",
      }),
      expect.objectContaining({
        polarity: "memory",
        signalKind: "explicit_remember_command",
      }),
      expect.objectContaining({
        candidateKind: "repo_fact",
        createdByLogin: "maintainer",
        metadata: expect.objectContaining({
          publishedSummaryCommentId: "psc_1",
          source: "provider_feedback_command",
        }),
        proposedContent: "API handlers use shared middleware for authentication.",
        sourceFeedbackEventId: "fb_summary",
        sourceKind: "command",
        status: "pending",
        trustLevel: "explicit_maintainer",
      }),
    ]);
  });
});

describe("createRedisPublishThrottle", () => {
  it("coordinates repository write limits through shared Redis state", async () => {
    let nowMs = Date.parse("2026-05-07T12:00:00.000Z");
    let slotId = 0;
    const sleeps: number[] = [];
    const redis = new InMemoryRedisPublishThrottleClient();
    const firstThrottle = createRedisPublishThrottle(redis, {
      keyPrefix: "test:publish-throttle",
      limits: {
        maxPublishOperationsPerInstallationPerMinute: 10,
        maxPublishOperationsPerRepoPerMinute: 1,
        maxSummaryCommentsPerPrPerHour: 10,
      },
      now: () => new Date(nowMs),
      randomId: () => `slot_${++slotId}`,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    const secondThrottle = createRedisPublishThrottle(redis, {
      keyPrefix: "test:publish-throttle",
      limits: {
        maxPublishOperationsPerInstallationPerMinute: 10,
        maxPublishOperationsPerRepoPerMinute: 1,
        maxSummaryCommentsPerPrPerHour: 10,
      },
      now: () => new Date(nowMs),
      randomId: () => `slot_${++slotId}`,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await firstThrottle.waitForSlot(publishThrottleSlot("check_run.upsert"));
    const decision = await secondThrottle.waitForSlot(
      publishThrottleSlot("review.inline_comments"),
    );

    expect(decision).toMatchObject({
      limitReason: "publish_operations_per_repo_per_minute",
      waitedMs: 60_000,
    });
    expect(sleeps).toEqual([60_000]);
  });

  it("coordinates PR summary comment limits through shared Redis state", async () => {
    let nowMs = Date.parse("2026-05-07T12:00:00.000Z");
    let slotId = 0;
    const sleeps: number[] = [];
    const redis = new InMemoryRedisPublishThrottleClient();
    const firstThrottle = createRedisPublishThrottle(redis, {
      keyPrefix: "test:publish-throttle",
      limits: {
        maxPublishOperationsPerInstallationPerMinute: 10,
        maxPublishOperationsPerRepoPerMinute: 10,
        maxSummaryCommentsPerPrPerHour: 1,
      },
      now: () => new Date(nowMs),
      randomId: () => `slot_${++slotId}`,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    const secondThrottle = createRedisPublishThrottle(redis, {
      keyPrefix: "test:publish-throttle",
      limits: {
        maxPublishOperationsPerInstallationPerMinute: 10,
        maxPublishOperationsPerRepoPerMinute: 10,
        maxSummaryCommentsPerPrPerHour: 1,
      },
      now: () => new Date(nowMs),
      randomId: () => `slot_${++slotId}`,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await firstThrottle.waitForSlot(publishThrottleSlot("summary_comment.configured"));
    const decision = await secondThrottle.waitForSlot(
      publishThrottleSlot("summary_comment.fallback"),
    );

    expect(decision).toMatchObject({
      limitReason: "summary_comments_per_pr_per_hour",
      waitedMs: 3_600_000,
    });
    expect(sleeps).toEqual([3_600_000]);
  });
});

describe("createWorkerStaticAnalysisRunnerFromEnvironment", () => {
  it("keeps static analysis disabled by default", () => {
    expect(createWorkerStaticAnalysisRunnerFromEnvironment({})).toBeUndefined();
  });

  it("creates a fake sandbox-backed static-analysis runner when configured", async () => {
    const runner = createWorkerStaticAnalysisRunnerFromEnvironment({
      STATIC_ANALYSIS_RUNNER: "fake",
    });

    const result = await runner?.run({
      command: {
        args: ["--format", "json"],
        cwd: "/workspace/repo",
        displayCommand: "eslint --format json",
        env: {},
        executable: "eslint",
        filesystemPolicy: "read_only",
        networkPolicy: "none",
      },
      maxOutputBytes: 1_000,
      planId: "plan_worker_static_analysis",
      sandboxContext: {
        commitSha: "abc123",
        orgId: "org_1",
        repoId: "repo_1",
      },
      startedAt: "2026-05-07T12:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      stdout: "",
    });
  });

  it("passes telemetry recorders to configured sandbox runners", async () => {
    const metrics: WorkerRecordedMetric[] = [];
    const runner = createWorkerStaticAnalysisRunnerFromEnvironment(
      {
        STATIC_ANALYSIS_RUNNER: "fake",
      },
      {
        metrics: createWorkerRecordingMetrics(metrics),
      },
    );
    if (!runner) {
      throw new Error("Expected configured static-analysis runner.");
    }

    await runner.run({
      command: {
        args: ["--format", "json"],
        cwd: "/workspace/repo",
        displayCommand: "eslint --format json",
        env: {},
        executable: "eslint",
        filesystemPolicy: "read_only",
        networkPolicy: "none",
      },
      maxOutputBytes: 1_000,
      planId: "plan_worker_static_analysis",
      sandboxContext: {
        commitSha: "abc123",
        orgId: "org_1",
        repoId: "repo_1",
      },
      startedAt: "2026-05-07T12:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(metrics).toContainEqual(
      expect.objectContaining({
        labels: expect.objectContaining({
          category: "lint",
          runner_kind: "fake",
          status: "succeeded",
          trust_level: "trusted_pr",
        }),
        name: OBSERVABILITY_METRIC_NAMES.sandboxRunsTotal,
        value: 1,
      }),
    );
  });

  it("rejects unsafe local-process static analysis in production", () => {
    expect(() =>
      createWorkerStaticAnalysisRunnerFromEnvironment({
        NODE_ENV: "production",
        STATIC_ANALYSIS_RUNNER: "local_process",
      }),
    ).toThrow("local_process sandbox runner is forbidden in production.");
  });

  it("creates Docker and gVisor sandbox-backed static-analysis runners when configured", () => {
    expect(
      createWorkerStaticAnalysisRunnerFromEnvironment({
        PATH: "/usr/bin",
        SANDBOX_ARTIFACT_ROOT: "/tmp/sandbox-artifacts",
        SANDBOX_RUNNER: "docker",
        SANDBOX_TEMP_ROOT: "/tmp/sandbox-tmp",
      }),
    ).toBeDefined();
    expect(
      createWorkerStaticAnalysisRunnerFromEnvironment({
        PATH: "/usr/bin",
        SANDBOX_DOCKER_RUNTIME: "runsc",
        SANDBOX_RUNNER: "gvisor",
      }),
    ).toBeDefined();
  });
});

describe("createWorkerIndexerDriverFromEnvironment", () => {
  it("keeps the in-process TypeScript indexer as the default driver", () => {
    expect(
      createWorkerIndexerDriverFromEnvironment(
        {},
        { indexArtifactRoot: ".heimdall/index-artifacts" },
      ),
    ).toBeUndefined();
  });

  it("creates a CLI driver from explicit worker environment", () => {
    const driver = createWorkerIndexerDriverFromEnvironment(
      {
        INDEXER_CLI_ARGS_JSON: JSON.stringify(["--fake"]),
        INDEXER_CLI_COMMAND: process.execPath,
        INDEXER_DRIVER: "cli",
      },
      {
        indexArtifactRoot: ".heimdall/index-artifacts",
        indexerTimeoutMs: 500,
        workspaceRoot: ".heimdall/workspaces",
      },
    );

    expect(driver).toMatchObject({ name: "cli", version: "0.0.0" });
  });

  it("creates a remote driver from explicit worker environment", () => {
    const driver = createWorkerIndexerDriverFromEnvironment(
      {
        INDEXER_DRIVER: "remote",
        INDEXER_REMOTE_BASE_URL: "https://indexer.example",
        INDEXER_REMOTE_BEARER_TOKEN: "remote-token",
        INDEXER_REMOTE_POLL_INTERVAL_MS: "25",
      },
      {
        indexArtifactRoot: ".heimdall/index-artifacts",
        indexerTimeoutMs: 500,
      },
    );

    expect(driver).toMatchObject({ name: "remote", version: "0.0.0" });
  });

  it("creates a fake driver from central indexer configuration", () => {
    const driver = createWorkerIndexerDriverFromEnvironment(
      {
        INDEXER_DRIVER: "fake",
      },
      {
        indexArtifactRoot: ".heimdall/index-artifacts",
      },
    );

    expect(driver).toMatchObject({ name: "fake", version: "0.0.0" });
  });

  it("requires a remote base URL for remote indexer drivers", () => {
    expect(() =>
      createWorkerIndexerDriverFromEnvironment(
        { INDEXER_DRIVER: "remote" },
        { indexArtifactRoot: ".heimdall/index-artifacts" },
      ),
    ).toThrow("INDEXER_REMOTE_BASE_URL is required when INDEXER_DRIVER=remote.");
  });

  it("rejects unsupported indexer drivers", () => {
    expect(() =>
      createWorkerIndexerDriverFromEnvironment(
        { INDEXER_DRIVER: "bogus" },
        { indexArtifactRoot: ".heimdall/index-artifacts" },
      ),
    ).toThrow("Unsupported INDEXER_DRIVER: bogus");
  });
});

describe("persistIndexArtifactForImport", () => {
  it("writes local artifact files when upload mode is local-only", async () => {
    const artifact = workerIndexArtifact();
    const root = await mkdtemp(join(tmpdir(), "heimdall-worker-index-artifact-"));

    try {
      const artifactUri = await persistIndexArtifactForImport({
        artifact,
        root,
        uploadMode: "local_only",
      });

      expect(artifactUri.startsWith("file:")).toBe(true);
      await expect(readFile(fileURLToPath(artifactUri), "utf8").then(JSON.parse)).resolves.toEqual(
        artifact,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uploads artifacts to the configured store when upload mode is object storage", async () => {
    const artifact = workerIndexArtifact();
    const artifactStore = {
      putArtifact: vi.fn(async () => ({
        hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
        sizeBytes: 128,
        uri: "s3://heimdall-index-artifacts/index-artifacts/repo_1/artifact.json",
      })),
    };

    await expect(
      persistIndexArtifactForImport({
        artifact,
        artifactStore,
        root: "/tmp/unused",
        uploadMode: "object_storage",
      }),
    ).resolves.toBe("s3://heimdall-index-artifacts/index-artifacts/repo_1/artifact.json");
    expect(artifactStore.putArtifact).toHaveBeenCalledWith(artifact);
  });

  it("copies remote artifacts when object storage upload mode receives a source URI", async () => {
    const artifact = workerIndexArtifact();
    const artifactStore = {
      copyArtifact: vi.fn(async () => ({
        hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
        sizeBytes: 128,
        uri: "s3://heimdall-index-artifacts/copied/repo_1/artifact.json",
      })),
      putArtifact: vi.fn(async () => ({
        hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
        sizeBytes: 128,
        uri: "s3://heimdall-index-artifacts/uploaded/repo_1/artifact.json",
      })),
    };

    await expect(
      persistIndexArtifactForImport({
        artifact,
        artifactStore,
        root: "/tmp/unused",
        sourceArtifactUri: "s3://remote-indexer/repo_1/artifact.json",
        uploadMode: "object_storage",
      }),
    ).resolves.toBe("s3://heimdall-index-artifacts/copied/repo_1/artifact.json");
    expect(artifactStore.copyArtifact).toHaveBeenCalledWith({
      artifact,
      sourceUri: "s3://remote-indexer/repo_1/artifact.json",
    });
    expect(artifactStore.putArtifact).not.toHaveBeenCalled();
  });

  it("fails object-storage upload mode without an artifact store", async () => {
    await expect(
      persistIndexArtifactForImport({
        artifact: workerIndexArtifact(),
        root: "/tmp/unused",
        uploadMode: "object_storage",
      }),
    ).rejects.toThrow(
      "Index artifact object-storage upload mode requires an index artifact store.",
    );
  });
});

describe("verifyWorkerIndexerCapabilities", () => {
  it("returns capabilities when the selected indexer supports the current artifact schema", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const capabilities = await verifyWorkerIndexerCapabilities(createFakeIndexerDriver());
    info.mockRestore();

    expect(capabilities).toMatchObject({
      driverName: "fake",
      supportedArtifactSchemaVersions: ["index_artifact.v1"],
    });
  });

  it("rejects indexers that do not support the current artifact schema", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(
      verifyWorkerIndexerCapabilities(
        createFakeIndexerDriver({
          capabilities: { supportedArtifactSchemaVersions: ["index_artifact.v0"] },
          name: "old-indexer",
        }),
      ),
    ).rejects.toThrow("Indexer old-indexer@0.0.0 does not support index_artifact.v1.");
    info.mockRestore();
  });
});

/** Fetch call captured by worker LLM gateway tests. */
type RecordedLlmFetchCall = {
  /** Request init passed to the fake fetch implementation. */
  readonly init?: RequestInit;
  /** Request URL passed to the fake fetch implementation. */
  readonly url: string;
};

/** Fetch call captured by worker embedding provider tests. */
type RecordedEmbeddingFetchCall = {
  /** Request init passed to the fake fetch implementation. */
  readonly init?: RequestInit;
  /** Request URL passed to the fake fetch implementation. */
  readonly url: string;
};

/** Creates a successful Chat Completions response for worker LLM gateway tests. */
function llmChatCompletionResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(content),
            role: "assistant",
          },
        },
      ],
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: 200,
    },
  );
}

/** Returns the first recorded worker LLM fetch call or raises a test setup failure. */
function requireFirstLlmFetchCall(calls: readonly RecordedLlmFetchCall[]): RecordedLlmFetchCall {
  const call = calls[0];
  if (!call) {
    throw new Error("Expected one worker LLM fetch call.");
  }

  return call;
}

/** Parses a worker LLM JSON request body into an object for assertions. */
function llmRequestJsonBody(call: RecordedLlmFetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected worker LLM request body to be a JSON string.");
  }

  const parsed = JSON.parse(call.init.body) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Expected worker LLM request body to be a JSON object.");
  }

  return parsed;
}

/** Creates a successful embeddings response for worker embedding provider tests. */
function embeddingResponse(content: unknown): Response {
  return new Response(JSON.stringify(content), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

/** Returns the first recorded worker embedding fetch call or raises a test setup failure. */
function requireFirstEmbeddingFetchCall(
  calls: readonly RecordedEmbeddingFetchCall[],
): RecordedEmbeddingFetchCall {
  const call = calls[0];
  if (!call) {
    throw new Error("Expected one worker embedding fetch call.");
  }

  return call;
}

/** Parses a worker embedding JSON request body into an object for assertions. */
function embeddingRequestJsonBody(call: RecordedEmbeddingFetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected worker embedding request body to be a JSON string.");
  }

  const parsed = JSON.parse(call.init.body) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Expected worker embedding request body to be a JSON object.");
  }

  return parsed;
}

/** Returns whether a value is a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Metric record captured by worker telemetry assertions. */
type WorkerRecordedMetric = {
  /** Metric labels attached to the record. */
  readonly labels?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric value. */
  readonly value: number;
};

/** Creates a metric recorder that stores worker telemetry records in memory. */
function createWorkerRecordingMetrics(records: WorkerRecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        labels: options?.labels,
        name,
        value: options?.value ?? 1,
      });
    },
    gauge: (name, value, options) => {
      records.push({
        labels: options?.labels,
        name,
        value,
      });
    },
    histogram: (name, value, options) => {
      records.push({
        labels: options?.labels,
        name,
        value,
      });
    },
  };
}

/** Creates a repo-sync command failure for missing commit checks. */
function createWorkerMissingCommitGitError(): RepoSyncGitCommandError {
  return new RepoSyncGitCommandError({
    code: "GIT_COMMAND_FAILED",
    command: "git cat-file -e",
    message: "Git command failed: git cat-file -e",
    stderr: { originalBytes: 0, text: "", truncated: false },
    stdout: { originalBytes: 0, text: "", truncated: false },
    timeoutMs: 120_000,
  });
}

/** Provider installation row shape used by the worker installation lookup stub. */
type WorkerProviderInstallationRow = {
  /** Durable installation ID. */
  readonly installationId: string;
  /** Owning organization ID. */
  readonly orgId: string;
  /** Git provider. */
  readonly provider: string;
  /** Provider-native installation ID. */
  readonly providerInstallationId: string;
  /** Provider account login. */
  readonly accountLogin: string;
  /** Provider account type. */
  readonly accountType: string;
  /** Provider permission map. */
  readonly permissions: Record<string, unknown>;
  /** Installation creation timestamp. */
  readonly installedAt: Date;
  /** Optional suspension timestamp. */
  readonly suspendedAt: Date | null;
  /** Optional deletion timestamp. */
  readonly deletedAt: Date | null;
  /** Optional metadata payload. */
  readonly metadata: Record<string, unknown> | null;
};

/** Creates a database stub that supports provider installation lookup. */
function createWorkerProviderInstallationDatabaseStub(
  rows: readonly WorkerProviderInstallationRow[],
): never {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (count: number) => rows.slice(0, count),
        }),
      }),
    }),
  };

  return db as never;
}

/** Options for a sequential database stub used by worker repository-path tests. */
type WorkerSequentialDatabaseStubOptions = {
  /** Inserted row values captured from insert calls. */
  readonly insertedRows: unknown[];
  /** Select result sets returned in call order. */
  readonly selectRows: unknown[][];
};

/** Minimal select chain shape used by worker database stubs. */
type WorkerSequentialSelectChain = {
  /** Continues a joined select chain. */
  readonly innerJoin: () => WorkerSequentialSelectChain;
  /** Continues an optional joined select chain. */
  readonly leftJoin: () => WorkerSequentialSelectChain;
  /** Returns the next queued select result set. */
  readonly where: () => WorkerSequentialSelectWhereChain;
};

/** Minimal where chain shape used by worker database stubs. */
type WorkerSequentialSelectWhereChain = Promise<readonly unknown[]> & {
  /** Returns the selected rows with an optional limit applied. */
  readonly limit: (count?: number) => Promise<readonly unknown[]>;
  /** Keeps the selected rows available after an order-by call. */
  readonly orderBy: () => WorkerSequentialSelectWhereChain;
};

/** Creates a database stub that returns queued select rows and captures inserted rows. */
function createWorkerSequentialDatabaseStub(options: WorkerSequentialDatabaseStubOptions): never {
  const nextRows = () => options.selectRows.shift() ?? [];
  const selectChain: WorkerSequentialSelectChain = {
    innerJoin: () => selectChain,
    leftJoin: () => selectChain,
    where: () => createWorkerSequentialSelectWhereChain(nextRows()),
  };
  const db = {
    insert: () => ({
      values: (value: unknown) => {
        options.insertedRows.push(value);

        return {
          onConflictDoNothing: async () => undefined,
        };
      },
    }),
    select: () => ({
      from: () => selectChain,
    }),
  };

  return db as never;
}

/** Creates a stub where-chain around one selected row set. */
function createWorkerSequentialSelectWhereChain(
  rows: readonly unknown[],
): WorkerSequentialSelectWhereChain {
  let chain: WorkerSequentialSelectWhereChain;
  chain = Object.assign(Promise.resolve(rows), {
    limit: async (count?: number) => (typeof count === "number" ? rows.slice(0, count) : rows),
    orderBy: () => chain,
  });

  return chain;
}

/** Creates a database stub that supports the embedding handler path. */
function createWorkerEmbeddingDatabaseStub(chunkIds: readonly string[]): never {
  const rows = chunkIds.map((chunkId, index) => ({
    chunkId,
    contentHash: `sha256:${"a".repeat(64)}`,
    endLine: index + 1,
    metadata: { text: "export const secretValue = process.env.SECRET_VALUE;" },
    path: "src/private.ts",
    startLine: index + 1,
    symbolId: null,
  }));
  let rootSelectCount = 0;
  const transaction = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => chunkIds.map((chunkId) => ({ chunkId })),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => [{ embeddedChunkCount: chunkIds.length }],
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const selectedRows =
            rootSelectCount === 0 ? rows : rootSelectCount === 1 ? [] : [{ orgId: "org_1" }];
          rootSelectCount += 1;

          return Object.assign(Promise.resolve(selectedRows), {
            limit: async (count: number) => selectedRows.slice(0, count),
            orderBy: async () => selectedRows,
          });
        },
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction),
  };

  return db as never;
}

/** Creates a database stub that supports the embedding repair handler path. */
function createWorkerEmbeddingRepairDatabaseStub(options: {
  /** Captures durable job rows inserted by repair requeue handling. */
  readonly insertedRows: unknown[];
  /** Captures progress and item updates from repair reconciliation. */
  readonly updatedValues: unknown[];
}): never {
  const selectedRows: readonly (readonly unknown[])[] = [
    [
      {
        dimensions: 2,
        embeddingJobId: "embjob_1",
        embeddingProfileVersion: "code_embedding_profile.v1",
        indexVersionId: "idx_01HREVIEW",
        model: "text-embedding-3-small",
        provider: "hash",
        repoId: "repo_01HREVIEW",
      },
    ],
    [{ chunkId: "chunk_missing", status: "embedded" }],
    [],
    [],
    [],
    [{ embedded: 0, failed: 0, skipped: 0, total: 1 }],
  ];
  let selectIndex = 0;
  const db = {
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        options.insertedRows.push(values);

        return {
          onConflictDoNothing: () => ({
            returning: async () => [createBackgroundJobInsertedRow(values)],
          }),
        };
      },
    }),
    select: () => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => {
          const rows = selectedRows[selectIndex] ?? [];
          selectIndex += 1;

          return Object.assign(Promise.resolve(rows), {
            limit: async (count: number) => rows.slice(0, count),
          });
        },
      }),
    }),
    update: (_table: unknown) => ({
      set: (values: unknown) => {
        options.updatedValues.push(values);

        return {
          where: async (_condition: unknown) => undefined,
        };
      },
    }),
  };

  return db as never;
}

/** Adds database-default fields expected by the background job repository mapper. */
function createBackgroundJobInsertedRow(values: unknown): unknown {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return values;
  }

  const row = values as Record<string, unknown>;
  const timestamp = new Date("2026-05-08T00:00:00.000Z");

  return {
    ...row,
    attempts: row.attempts ?? 0,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt ?? timestamp,
    error: row.error ?? null,
    orgId: row.orgId ?? null,
    reviewRunId: row.reviewRunId ?? null,
    scheduledAt: row.scheduledAt ?? null,
    startedAt: row.startedAt ?? null,
    updatedAt: row.updatedAt ?? timestamp,
  };
}

/** Creates a minimal valid index artifact for worker persistence tests. */
function workerIndexArtifact(): IndexArtifact {
  return {
    manifest: {
      artifactId: "art_repo_1_abc1234",
      chunkCount: 0,
      chunkerVersion: "chunker.v1",
      commitSha: "abc1234",
      edgeCount: 0,
      fileCount: 0,
      generatedAt: "2026-05-08T00:00:00.000Z",
      indexerName: "worker-test-indexer",
      indexerVersion: "0.0.0",
      languages: [],
      parserVersions: {},
      recordCount: 0,
      recordSchemaVersion: "index_record.v1",
      repoId: "repo_1",
      schemaVersion: "index_artifact.v1",
      symbolCount: 0,
    },
    records: [],
  };
}

/** In-memory Redis script harness shared by cross-process throttle unit tests. */
class InMemoryRedisPublishThrottleClient implements RedisPublishThrottleClient {
  /** Sorted-set state keyed by Redis key, then member. */
  private readonly sortedSets = new Map<string, Map<string, number>>();

  /** Runs the Redis throttle script against the in-memory sorted-set state. */
  public async eval(
    _script: string,
    keyCount: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown> {
    const keys = args.slice(0, keyCount).map(String);
    const nowMs = Number(args[keyCount]);
    const member = String(args[keyCount + 1]);
    const scopeCount = Number(args[keyCount + 2]);
    if (scopeCount !== keyCount) {
      throw new Error("Unexpected Redis throttle scope count.");
    }

    for (let index = 0; index < scopeCount; index += 1) {
      const argOffset = keyCount + 3 + index * 3;
      const limit = Number(args[argOffset]);
      const windowMs = Number(args[argOffset + 1]);
      const reason = String(args[argOffset + 2]);
      const sortedSet = this.sortedSet(keys[index] ?? "");
      this.prune(sortedSet, nowMs - windowMs);

      if (sortedSet.size >= limit) {
        const oldestMs = Math.min(...sortedSet.values());
        const waitMs = Math.max(1, windowMs - (nowMs - oldestMs));

        return [0, waitMs, reason];
      }
    }

    for (let index = 0; index < scopeCount; index += 1) {
      const sortedSet = this.sortedSet(keys[index] ?? "");
      sortedSet.set(`${member}:${index + 1}`, nowMs);
    }

    return [1, 0, ""];
  }

  /** Returns the sorted set for a Redis key, creating it when needed. */
  private sortedSet(key: string): Map<string, number> {
    const existing = this.sortedSets.get(key);
    if (existing) {
      return existing;
    }

    const created = new Map<string, number>();
    this.sortedSets.set(key, created);

    return created;
  }

  /** Removes entries at or before the Redis sorted-set cutoff score. */
  private prune(sortedSet: Map<string, number>, cutoffMs: number): void {
    for (const [member, score] of sortedSet) {
      if (score <= cutoffMs) {
        sortedSet.delete(member);
      }
    }
  }
}

/** Creates one shared publisher throttle slot fixture. */
function publishThrottleSlot(operationType: PublishOperationType): PublishThrottleSlotInput {
  return {
    installationId: "inst_1",
    operationType,
    pullRequestNumber: 7,
    repositoryKey: "repo_1",
  };
}
