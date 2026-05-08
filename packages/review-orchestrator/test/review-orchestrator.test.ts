import { JOB_TYPES, type PullRequestSnapshot } from "@repo/contracts";
import { validContextBundleFixture } from "@repo/contracts/fixtures/review.fixture";
import {
  createMemoryTelemetrySpanSink,
  createTelemetrySpanRecorder,
  loadObservabilityConfig,
  OBSERVABILITY_SPAN_NAMES,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
  assertSnapshotMatchesJob,
  buildRetrievalTraceArtifactPayload,
  checkReviewRunCurrent,
  createIndexDependencyJobEnvelope,
  createIndexDependencyJobKey,
  createStaticAnalysisRequestForReview,
  ReviewIndexDependencyPendingError,
  ReviewInputSnapshotMismatchError,
  type ReviewMemoryFactRow,
  type ReviewPullRequestInput,
  reviewMemoryFactFromRow,
  reviewPublishSkipReason,
  reviewRunStatusForStage,
  reviewStalenessDisposition,
  startReviewTelemetryStageSpan,
} from "../src";

const reviewInput = {
  repoId: "repo_test",
  installationId: "inst_test",
  pullRequestNumber: 7,
  baseSha: "1111111",
  headSha: "2222222",
  trigger: "webhook",
} satisfies ReviewPullRequestInput;

const pullRequestSnapshot = {
  snapshotId: "prs_test",
  schemaVersion: "pull_request_snapshot.v1",
  provider: "github",
  repoId: "repo_test",
  installationId: "inst_test",
  providerRepoId: "98765",
  providerPullRequestId: "777",
  pullRequestNumber: 7,
  title: "Change app",
  authorLogin: "octocat",
  state: "open",
  isDraft: false,
  labels: [],
  baseRef: "main",
  baseSha: "1111111",
  headRef: "feature",
  headSha: "2222222",
  changedFiles: [],
  diffHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  additions: 0,
  deletions: 0,
  changedFileCount: 0,
  fetchedAt: "2026-04-28T12:00:00.000Z",
} satisfies PullRequestSnapshot;

const currentCheckInput = {
  provider: "github",
  installationId: "inst_test",
  owner: "octo-org",
  repo: "heimdall-test",
  providerRepoId: "98765",
  pullRequestNumber: 7,
  expectedHeadSha: "2222222",
} as const;

describe("assertSnapshotMatchesJob", () => {
  it("accepts a fetched snapshot that matches the queued review job", () => {
    expect(() => assertSnapshotMatchesJob(reviewInput, pullRequestSnapshot)).not.toThrow();
  });

  it("rejects a stale fetched snapshot for a different head SHA", () => {
    expect(() =>
      assertSnapshotMatchesJob(reviewInput, {
        ...pullRequestSnapshot,
        headSha: "3333333",
      }),
    ).toThrow(ReviewInputSnapshotMismatchError);
  });
});

describe("checkReviewRunCurrent", () => {
  it("returns current when the provider head still matches", async () => {
    await expect(
      checkReviewRunCurrent(providerReturningSnapshot(pullRequestSnapshot), currentCheckInput),
    ).resolves.toBe("current");
  });

  it("returns superseded when the provider head moved", async () => {
    await expect(
      checkReviewRunCurrent(
        providerReturningSnapshot({ ...pullRequestSnapshot, headSha: "3333333" }),
        currentCheckInput,
      ),
    ).resolves.toBe("superseded");
  });

  it("returns closed when the pull request is no longer open", async () => {
    await expect(
      checkReviewRunCurrent(
        providerReturningSnapshot({ ...pullRequestSnapshot, state: "closed" }),
        currentCheckInput,
      ),
    ).resolves.toBe("closed");
  });

  it("returns unknown when the provider state is unknown", async () => {
    await expect(
      checkReviewRunCurrent(
        providerReturningSnapshot({ ...pullRequestSnapshot, state: "unknown" }),
        currentCheckInput,
      ),
    ).resolves.toBe("unknown");
  });

  it("returns unknown when the provider check fails", async () => {
    await expect(
      checkReviewRunCurrent(
        {
          fetchPullRequestSnapshot: async () => {
            throw new Error("GitHub is unavailable.");
          },
        },
        currentCheckInput,
      ),
    ).resolves.toBe("unknown");
  });
});

describe("reviewStalenessDisposition", () => {
  it("maps superseded and closed states to terminal review dispositions", () => {
    expect(reviewStalenessDisposition("superseded", "before_review")).toEqual({
      outcome: "superseded",
      reason: "pull_request_head_changed",
      status: "superseded",
      summary: "Review superseded before review because the pull request head changed.",
    });
    expect(reviewStalenessDisposition("closed", "after_index")).toEqual({
      outcome: "skipped",
      reason: "pull_request_not_open",
      status: "skipped",
      summary: "Review skipped after index wait because the pull request is no longer open.",
    });
  });

  it("does not stop current or unknown states", () => {
    expect(reviewStalenessDisposition("current", "after_snapshot")).toBeUndefined();
    expect(reviewStalenessDisposition("unknown", "before_publish")).toBeUndefined();
  });
});

describe("reviewRunStatusForStage", () => {
  it("maps orchestration stages to durable review run statuses", () => {
    expect(reviewRunStatusForStage("index")).toBe("waiting_for_index");
    expect(reviewRunStatusForStage("retrieval")).toBe("retrieving_context");
    expect(reviewRunStatusForStage("review")).toBe("reviewing");
    expect(reviewRunStatusForStage("validation")).toBe("validating_findings");
    expect(reviewRunStatusForStage("publish")).toBe("publish_queued");
  });
});

describe("createIndexDependencyJobEnvelope", () => {
  it("uses the webhook-compatible index idempotency key for review-owned index gaps", () => {
    const envelope = createIndexDependencyJobEnvelope({
      commitSha: reviewInput.headSha,
      installationId: reviewInput.installationId,
      repoId: reviewInput.repoId,
      timestamp: "2026-05-05T00:00:00.000Z",
      traceContext: { requestId: "req_review" },
    });

    expect(
      createIndexDependencyJobKey({ commitSha: reviewInput.headSha, repoId: reviewInput.repoId }),
    ).toBe("github:index:repo_test:2222222");
    expect(envelope).toMatchObject({
      createdAt: "2026-05-05T00:00:00.000Z",
      idempotencyKey: "github:index:repo_test:2222222",
      jobType: JOB_TYPES.IndexRepoCommit,
      maxAttempts: 3,
      payload: {
        commitSha: reviewInput.headSha,
        installationId: reviewInput.installationId,
        priority: "high",
        reason: "pr_review",
        repoId: reviewInput.repoId,
      },
      traceContext: { requestId: "req_review" },
    });
    expect(envelope.jobId).toMatch(/^job_/u);
  });
});

describe("ReviewIndexDependencyPendingError", () => {
  it("exposes product-safe retry metadata for paused review runs", () => {
    const error = new ReviewIndexDependencyPendingError({
      commitSha: reviewInput.headSha,
      indexJobKey: "github:index:repo_test:2222222",
      repoId: reviewInput.repoId,
      reviewRunId: "rrn_review",
    });

    expect(error).toMatchObject({
      code: "review_orchestrator.index_dependency_pending",
      metadata: {
        commitSha: reviewInput.headSha,
        indexJobKey: "github:index:repo_test:2222222",
        repoId: reviewInput.repoId,
        reviewRunId: "rrn_review",
      },
      name: "ReviewIndexDependencyPendingError",
    });
  });
});

describe("reviewPublishSkipReason", () => {
  it("skips publisher handoff for dry runs before considering planned operations", () => {
    expect(reviewPublishSkipReason({ dryRun: true, hasExternalWrites: true })).toBe("dry_run");
    expect(reviewPublishSkipReason({ dryRun: true, hasExternalWrites: false })).toBe("dry_run");
  });

  it("skips publisher handoff when the publish plan has no external writes", () => {
    expect(reviewPublishSkipReason({ dryRun: false, hasExternalWrites: false })).toBe(
      "no_planned_publish_operations",
    );
    expect(reviewPublishSkipReason({ dryRun: false, hasExternalWrites: true })).toBeUndefined();
  });
});

describe("buildRetrievalTraceArtifactPayload", () => {
  it("summarizes retrieval metadata without copying snippet text", () => {
    const payload = buildRetrievalTraceArtifactPayload({
      contextBundle: {
        ...validContextBundleFixture,
        metadata: {
          packing: { droppedItemCount: 0 },
          ranking: { strategy: "weighted_reciprocal_rank_fusion_v1" },
          warnings: [{ code: "token_budget_exceeded" }],
        },
      },
      generatedAt: "2026-05-05T00:00:01.000Z",
    });

    expect(payload).toMatchObject({
      budget: {
        estimatedTokens: validContextBundleFixture.tokenBudget.estimatedTokens,
        maxTokens: validContextBundleFixture.tokenBudget.maxTokens,
      },
      changeAnalysis: {
        changedFileCount: 1,
        changedSymbolCount: 1,
      },
      completedAt: "2026-05-05T00:00:01.000Z",
      metadata: {
        ranking: { strategy: "weighted_reciprocal_rank_fusion_v1" },
      },
      schemaVersion: "retrieval_trace.v1",
      selectedItems: [
        expect.objectContaining({
          contextItemId: "ctxitem_01HXAMPLE",
          path: "src/math.ts",
          reason: "Changed symbol context",
          retriever: "fixture",
        }),
      ],
      warnings: [{ code: "token_budget_exceeded" }],
    });
    expect(JSON.stringify(payload)).not.toContain("Number(a)");
    expect(JSON.stringify(payload)).not.toContain("return Number");
  });
});

describe("startReviewTelemetryStageSpan", () => {
  it("records product-safe stage spans with propagated trace context", () => {
    const sink = createMemoryTelemetrySpanSink();
    const traces = createTelemetrySpanRecorder(
      loadObservabilityConfig({
        OBSERVABILITY_ENABLED: "true",
        OBSERVABILITY_EXPORTER: "console",
        OBSERVABILITY_SERVICE_NAME: "code-review-worker",
      }),
      sink,
    );
    const span = startReviewTelemetryStageSpan({
      attributes: {
        "review.index_available": true,
      },
      stage: "retrieval",
      traceContext: {
        requestId: "req_1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      traces,
    });

    span?.end({
      attributes: {
        "review.context_item_count": 3,
        "review.stage_status": "completed",
      },
    });

    expect(sink.spans()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "review.context_item_count": 3,
          "review.index_available": true,
          "review.stage": "retrieval",
          "review.stage_status": "completed",
        }),
        kind: "internal",
        name: OBSERVABILITY_SPAN_NAMES.reviewPipelineStage,
        traceContext: {
          requestId: "req_1",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    ]);
  });
});

describe("createStaticAnalysisRequestForReview", () => {
  it("creates a review-owned changed-files static-analysis request", () => {
    const request = createStaticAnalysisRequestForReview({
      orgId: "org_test",
      repoId: pullRequestSnapshot.repoId,
      reviewRunId: "rrn_test",
      snapshot: pullRequestSnapshot,
      timestamp: "2026-05-07T12:00:00.000Z",
      workspace: {
        checkedOutSha: pullRequestSnapshot.headSha,
        cleanedUp: false,
        workspacePath: "/tmp/heimdall-review",
      },
    });

    expect(request).toMatchObject({
      createdAt: "2026-05-07T12:00:00.000Z",
      mode: "changed_files_fast",
      orgId: "org_test",
      reason: "review",
      repoId: "repo_test",
      reviewRunId: "rrn_test",
      schemaVersion: "static_analysis_request.v1",
      workspace: {
        commitSha: pullRequestSnapshot.headSha,
        isTrusted: true,
        path: "/tmp/heimdall-review",
      },
    });
    expect(request.workspace.workspaceId).toMatch(/^ws_[A-Za-z0-9_-]+$/u);
  });
});

describe("reviewMemoryFactFromRow", () => {
  it("maps durable memory metadata into validation suppression facts", () => {
    const fact = reviewMemoryFactFromRow(memoryFactRowFixture());

    expect(fact).toMatchObject({
      id: "mem_test",
      kind: "suppression",
      appliesTo: {
        categories: ["test_coverage"],
        pathGlobs: ["src/generated/**"],
        titlePatterns: ["snapshot test"],
      },
      scope: {
        level: "path",
        pathGlobs: ["src/generated/**"],
        repoId: "repo_test",
      },
      sourceKind: "repeated_signal",
      status: "active",
    });
  });
});

/** Creates the minimal provider surface needed for current-head checks. */
function providerReturningSnapshot(snapshot: PullRequestSnapshot): {
  readonly fetchPullRequestSnapshot: () => Promise<PullRequestSnapshot>;
} {
  return {
    fetchPullRequestSnapshot: async () => snapshot,
  };
}

/** Creates a durable memory fact row with suppression metadata. */
function memoryFactRowFixture(overrides: Partial<ReviewMemoryFactRow> = {}): ReviewMemoryFactRow {
  const now = new Date("2026-05-07T12:00:00.000Z");
  return {
    memoryFactId: "mem_test",
    orgId: "org_test",
    repoId: "repo_test",
    factType: "suppression",
    body: "Do not comment on generated snapshot tests.",
    status: "active",
    confidence: 0.93,
    expiresAt: null,
    metadata: {
      appliesTo: {
        categories: ["test_coverage"],
        pathGlobs: ["src/generated/**"],
        titlePatterns: ["snapshot test"],
      },
      pathGlobs: ["src/generated/**"],
      source: "feedback",
      subject: "Generated snapshot tests",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
