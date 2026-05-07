import { JOB_TYPES } from "@repo/contracts";
import { validBillingReconcileJobPayloadFixture } from "@repo/contracts/fixtures/jobs.fixture";
import { createFakeIndexerDriver } from "@repo/indexer-driver";
import type { PublishOperationType, PublishThrottleSlotInput } from "@repo/publisher";
import { describe, expect, it, vi } from "vitest";
import {
  createRedisPublishThrottle,
  createWorkerHandlers,
  createWorkerIndexerDriverFromEnvironment,
  createWorkerReviewSmokeGateway,
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
