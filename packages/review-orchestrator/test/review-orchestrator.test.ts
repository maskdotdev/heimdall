import type { PullRequestSnapshot } from "@repo/contracts";
import {
  createMemoryTelemetrySpanSink,
  createTelemetrySpanRecorder,
  loadObservabilityConfig,
  OBSERVABILITY_SPAN_NAMES,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
  assertSnapshotMatchesJob,
  checkReviewRunCurrent,
  createStaticAnalysisRequestForReview,
  ReviewInputSnapshotMismatchError,
  type ReviewMemoryFactRow,
  type ReviewPullRequestInput,
  reviewMemoryFactFromRow,
  reviewRunStatusForStage,
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

describe("reviewRunStatusForStage", () => {
  it("maps orchestration stages to durable review run statuses", () => {
    expect(reviewRunStatusForStage("index")).toBe("waiting_for_index");
    expect(reviewRunStatusForStage("retrieval")).toBe("retrieving_context");
    expect(reviewRunStatusForStage("review")).toBe("reviewing");
    expect(reviewRunStatusForStage("validation")).toBe("validating_findings");
    expect(reviewRunStatusForStage("publish")).toBe("publish_queued");
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
