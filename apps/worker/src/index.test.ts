import { REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY } from "@repo/artifacts";
import { JOB_TYPES } from "@repo/contracts";
import {
  validBillingReconcileJobPayloadFixture,
  validEmbeddingBatchJobPayloadFixture,
  validEmbeddingRepairJobPayloadFixture,
  validReviewArtifactCleanupJobPayloadFixture,
  validSandboxCleanupJobPayloadFixture,
} from "@repo/contracts/fixtures/jobs.fixture";
import { createFakeIndexerDriver } from "@repo/indexer-driver";
import {
  OBSERVABILITY_METRIC_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
} from "@repo/observability";
import type { PublishOperationType, PublishThrottleSlotInput } from "@repo/publisher";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupExpiredReviewArtifacts,
  createRedisPublishThrottle,
  createWorkerEmbeddingProviderFromEnvironment,
  createWorkerHandlers,
  createWorkerIndexerDriverFromEnvironment,
  createWorkerLlmBudgetFromEnvironment,
  createWorkerLlmGatewayFromEnvironment,
  createWorkerReviewIndexDependencyModeFromEnvironment,
  createWorkerReviewSmokeGateway,
  createWorkerStaticAnalysisRunnerFromEnvironment,
  enqueueWaitingReviewRunsForIndex,
  type RedisPublishThrottleClient,
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
            onConflictDoNothing: async () => undefined,
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                baseSha: "1111111",
                dryRunMetadata: { dryRun: true },
                headSha: "2222222",
                pullRequestNumber: 7,
                reviewRunId: "rrn_waiting",
                trigger: "webhook",
              },
            ],
          }),
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
        from: () => ({
          where: () => ({
            limit: async () => selectRows.shift() ?? [],
          }),
        }),
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
          publishedFindingId: "pub_1",
          reviewRunId: "rrn_1",
          validatedFindingId: "vf_1",
        },
      ],
      [{ candidateFindingId: "cf_1" }],
      [{ repoId: "repo_1" }],
      [{ orgId: "org_1" }],
    ];
    const insertedOutcomes: unknown[] = [];
    const db = {
      insert: () => ({
        values: (value: unknown) => {
          insertedOutcomes.push(value);
          return {
            onConflictDoNothing: async () => undefined,
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => selectRows.shift() ?? [],
          }),
        }),
      }),
    };
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
        candidateFindingId: "cf_1",
        orgId: "org_1",
        outcome: "negative_reaction",
        publishedFindingId: "pub_1",
        repoId: "repo_1",
        source: "provider_webhook",
      }),
    ]);
    expect(insertedOutcomes[0]).toEqual(
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

  it("creates pending memory candidates from trusted provider feedback commands", async () => {
    const selectRows: unknown[][] = [
      [
        {
          publishedFindingId: "pub_1",
          reviewRunId: "rrn_1",
          validatedFindingId: "vf_1",
        },
      ],
      [
        {
          body: "This pattern is noisy for this repository.",
          candidateFindingId: "cf_1",
          category: "maintainability",
          confidence: 0.88,
          findingId: "vf_1",
          fingerprint: "fp_command_1",
          location: { path: "src/generated/client.ts" },
          reviewRunId: "rrn_1",
          severity: "low",
          title: "Generated client method is missing docs",
        },
      ],
      [{ repoId: "repo_1" }],
      [{ orgId: "org_1" }],
    ];
    const insertedRows: unknown[] = [];
    const db = {
      insert: () => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return {
            onConflictDoNothing: async () => undefined,
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => selectRows.shift() ?? [],
          }),
        }),
      }),
    };
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
          onConflictDoNothing: async () => undefined,
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
