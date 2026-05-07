import { JOB_TYPES } from "@repo/contracts";
import {
  validBillingReconcileJobPayloadFixture,
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
  createRedisPublishThrottle,
  createWorkerHandlers,
  createWorkerIndexerDriverFromEnvironment,
  createWorkerReviewSmokeGateway,
  createWorkerStaticAnalysisRunnerFromEnvironment,
  type RedisPublishThrottleClient,
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

describe("createWorkerHandlers", () => {
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
