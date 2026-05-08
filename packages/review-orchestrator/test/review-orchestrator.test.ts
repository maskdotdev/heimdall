import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_TYPES, type PullRequestSnapshot } from "@repo/contracts";
import { validOrgSettingsFixture } from "@repo/contracts/fixtures/repository.fixture";
import { validContextBundleFixture } from "@repo/contracts/fixtures/review.fixture";
import { createFakeGitProvider, type GitHubRepositoryRef } from "@repo/github";
import {
  createMemoryTelemetrySpanSink,
  createTelemetrySpanRecorder,
  loadObservabilityConfig,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
} from "@repo/observability";
import {
  createRepoSyncConfig,
  getRepoSyncMirrorPath,
  getRepoSyncTempMirrorPath,
  getRepoSyncWorktreePath,
  RepoSyncGitCommandError,
} from "@repo/repo-sync";
import { buildReviewPolicySnapshot, type ReviewPolicySnapshot } from "@repo/rules";
import { createFakeToolRunner } from "@repo/tool-runner";
import { describe, expect, it } from "vitest";
import {
  acquireReviewRepositoryWorkspace,
  assertSnapshotMatchesJob,
  buildRetrievalTraceArtifactPayload,
  checkReviewRunCurrent,
  createIndexDependencyJobEnvelope,
  createIndexDependencyJobKey,
  createStaticAnalysisBaseSnapshotForReview,
  createStaticAnalysisRequestForReview,
  decideReviewGate,
  detectRepoLocalConfigChange,
  loadTrustedRepoLocalConfig,
  ReviewIndexDependencyPendingError,
  ReviewInputSnapshotMismatchError,
  type ReviewMemoryFactRow,
  type ReviewPullRequestInput,
  recordReviewStageMetrics,
  reviewGateSkipSummary,
  reviewMemoryFactFromRow,
  reviewPublishSkipReason,
  reviewRunStatusForStage,
  reviewStageLogAttributes,
  reviewStalenessDisposition,
  shouldRunBaseHeadStaticAnalysis,
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

describe("loadTrustedRepoLocalConfig", () => {
  it("loads repo-local config from the trusted base SHA", async () => {
    const gitProvider = createFakeGitProvider({
      fileContents: [
        {
          content: [
            "version: 1",
            "review:",
            "  mode: summary_only",
            "paths:",
            "  ignored:",
            "    - dist/**",
          ].join("\n"),
          owner: "octo-org",
          path: ".github/ai-reviewer.yml",
          ref: "1111111",
          repo: "heimdall-test",
          sha: "blobsha",
        },
      ],
    });

    const config = await loadTrustedRepoLocalConfig({
      baseSha: "1111111",
      gitProvider,
      orgSettings: { ...validOrgSettingsFixture, allowRepoLocalConfig: true },
      repository: {
        provider: "github",
        installationId: "inst_test",
        owner: "octo-org",
        repo: "heimdall-test",
        providerRepoId: "98765",
      },
    });

    expect(config).toMatchObject({
      sourceCommitSha: "1111111",
      sourcePath: ".github/ai-reviewer.yml",
      review: { mode: "summary_only" },
      paths: { ignored: ["dist/**"] },
    });
  });

  it("continues past invalid repo-local config files", async () => {
    const gitProvider = createFakeGitProvider({
      fileContents: [
        {
          content: "version: 2\nreview:\n  mode: summary_only\n",
          owner: "octo-org",
          path: ".ai-reviewer.yml",
          ref: "1111111",
          repo: "heimdall-test",
        },
        {
          content: "version: 1\nreview:\n  mode: summary_only\n",
          owner: "octo-org",
          path: ".github/ai-reviewer.yml",
          ref: "1111111",
          repo: "heimdall-test",
        },
      ],
    });

    const config = await loadTrustedRepoLocalConfig({
      baseSha: "1111111",
      gitProvider,
      orgSettings: { ...validOrgSettingsFixture, allowRepoLocalConfig: true },
      repository: {
        provider: "github",
        installationId: "inst_test",
        owner: "octo-org",
        repo: "heimdall-test",
        providerRepoId: "98765",
      },
    });

    expect(config).toMatchObject({
      sourcePath: ".github/ai-reviewer.yml",
      review: { mode: "summary_only" },
    });
  });

  it("skips repo-local config when organization settings do not allow it", async () => {
    const gitProvider = createFakeGitProvider({
      fileContents: [
        {
          content: "version: 1\nreview:\n  mode: summary_only\n",
          owner: "octo-org",
          path: ".github/ai-reviewer.yml",
          ref: "1111111",
          repo: "heimdall-test",
        },
      ],
    });

    await expect(
      loadTrustedRepoLocalConfig({
        baseSha: "1111111",
        gitProvider,
        orgSettings: { ...validOrgSettingsFixture, allowRepoLocalConfig: false },
        repository: {
          provider: "github",
          installationId: "inst_test",
          owner: "octo-org",
          repo: "heimdall-test",
          providerRepoId: "98765",
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("detectRepoLocalConfigChange", () => {
  it("warns when a pull request changes an allowed repo-local config path", () => {
    const notice = detectRepoLocalConfigChange({
      repoLocalConfigEnabled: true,
      snapshot: reviewablePullRequestSnapshot({
        changedFiles: [
          {
            additions: 3,
            changes: 4,
            deletions: 1,
            hunks: [],
            isBinary: false,
            isGenerated: false,
            isTest: false,
            language: "unknown",
            newContentHash:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            oldContentHash:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: ".github/ai-reviewer.yml",
            status: "modified",
          },
        ],
      }),
      trustedConfig: {
        schemaVersion: "repo_local_config.v1",
        configVersion: 1,
        sourceCommitSha: "1111111",
        sourceHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        sourcePath: ".github/ai-reviewer.yml",
      },
    });

    expect(notice).toMatchObject({
      baseSha: "1111111",
      changedFiles: [
        {
          newContentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          oldContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          path: ".github/ai-reviewer.yml",
          status: "modified",
        },
      ],
      headSha: "2222222",
      schemaVersion: "repo_local_config_change_notice.v1",
      trustedConfigSource: {
        sourceHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        sourcePath: ".github/ai-reviewer.yml",
      },
      warning: {
        code: "repo_local_config_changed_in_pull_request",
      },
    });
    expect(notice?.warning.details).toMatchObject({
      activePolicySource: "repo_local_config",
      changedPaths: [".github/ai-reviewer.yml"],
    });
  });

  it("does not warn for config-like changes when repo-local config is disabled", () => {
    expect(
      detectRepoLocalConfigChange({
        repoLocalConfigEnabled: false,
        snapshot: reviewablePullRequestSnapshot({
          changedFiles: [
            {
              additions: 1,
              changes: 1,
              deletions: 0,
              hunks: [],
              isBinary: false,
              isGenerated: false,
              isTest: false,
              language: "unknown",
              path: ".ai-reviewer.yml",
              status: "added",
            },
          ],
        }),
      }),
    ).toBeUndefined();
  });

  it("detects renamed repo-local config files from either side of the rename", () => {
    const notice = detectRepoLocalConfigChange({
      repoLocalConfigEnabled: true,
      snapshot: reviewablePullRequestSnapshot({
        changedFiles: [
          {
            additions: 2,
            changes: 4,
            deletions: 2,
            hunks: [],
            isBinary: false,
            isGenerated: false,
            isTest: false,
            language: "unknown",
            oldPath: ".ai-reviewer.yml",
            path: "docs/ai-reviewer.yml",
            status: "renamed",
          },
        ],
      }),
    });

    expect(notice?.changedFiles).toEqual([
      expect.objectContaining({
        oldPath: ".ai-reviewer.yml",
        path: "docs/ai-reviewer.yml",
        status: "renamed",
      }),
    ]);
    expect(notice?.warning.details).toMatchObject({
      activePolicySource: "repository_settings",
      changedPaths: ["docs/ai-reviewer.yml", ".ai-reviewer.yml"],
    });
  });
});

describe("decideReviewGate", () => {
  it("allows an open reviewable pull request", () => {
    expect(
      decideReviewGate({
        dependencies: {},
        input: reviewInput,
        policySnapshot: reviewPolicySnapshot(),
        snapshot: reviewablePullRequestSnapshot(),
      }),
    ).toMatchObject({
      action: "synchronize",
      reasonCode: "allowed",
      shouldReview: true,
    });
  });

  it("skips draft pull requests with a clear policy reason", () => {
    expect(
      decideReviewGate({
        dependencies: {},
        input: reviewInput,
        policySnapshot: reviewPolicySnapshot(),
        snapshot: reviewablePullRequestSnapshot({ isDraft: true }),
      }),
    ).toMatchObject({
      reasonCode: "draft_pr_skipped",
      shouldReview: false,
    });
    expect(reviewGateSkipSummary("draft_pr_skipped")).toBe(
      "Review skipped because the pull request is a draft.",
    );
  });

  it("skips pull requests that are closed or have no changed files", () => {
    expect(
      decideReviewGate({
        dependencies: {},
        input: reviewInput,
        policySnapshot: reviewPolicySnapshot(),
        snapshot: reviewablePullRequestSnapshot({ state: "closed" }),
      }),
    ).toMatchObject({
      reasonCode: "pull_request_not_open",
      shouldReview: false,
    });

    expect(
      decideReviewGate({
        dependencies: {},
        input: reviewInput,
        policySnapshot: reviewPolicySnapshot(),
        snapshot: pullRequestSnapshot,
      }),
    ).toMatchObject({
      reasonCode: "no_changed_files",
      shouldReview: false,
    });
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

describe("reviewStageLogAttributes", () => {
  it("includes the required product-safe stage log context", () => {
    expect(
      reviewStageLogAttributes({
        attributes: {
          "review.context_item_count": 3,
          "repo_sync.lease_id": "lease_review",
          "review.optional": undefined,
        },
        context: {
          headSha: reviewInput.headSha,
          jobId: "job_review",
          pullRequestNumber: reviewInput.pullRequestNumber,
          repoId: reviewInput.repoId,
          reviewRunId: "rrn_review",
        },
        stage: "retrieval",
        status: "completed",
      }),
    ).toEqual({
      "event.name": "review.stage.completed",
      "job.id": "job_review",
      "pull_request.number": reviewInput.pullRequestNumber,
      "repo.id": reviewInput.repoId,
      "repo_sync.lease_id": "lease_review",
      "review.context_item_count": 3,
      "review.head_sha": reviewInput.headSha,
      "review.run_id": "rrn_review",
      "review.stage": "retrieval",
      "review.stage_status": "completed",
    });
  });
});

describe("recordReviewStageMetrics", () => {
  it("records low-cardinality stage counters and durations", () => {
    const records: RecordedMetric[] = [];
    const metrics = createRecordingMetrics(records);

    recordReviewStageMetrics(metrics, "retrieval", "completed", 42);

    expect(records).toEqual([
      {
        kind: "counter",
        labels: { stage: "retrieval", status: "completed" },
        name: OBSERVABILITY_METRIC_NAMES.reviewStagesTotal,
        value: 1,
      },
      {
        kind: "histogram",
        labels: { stage: "retrieval", status: "completed" },
        name: OBSERVABILITY_METRIC_NAMES.reviewStageDurationMs,
        unit: "ms",
        value: 42,
      },
    ]);
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

describe("acquireReviewRepositoryWorkspace", () => {
  it("resolves clone credentials and acquires a cached repo-sync review workspace", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-review-repo-sync-test-"));
    const commitSha = "2222222222222222222222222222222222222222";
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_test");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_test", "tmp_review");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_review");
    const mutableCommands: string[][] = [];
    const fetchEnvironments: Readonly<Record<string, string | undefined>>[] = [];
    const cloneAuthInputs: unknown[] = [];
    let commitExists = false;

    try {
      const lease = await acquireReviewRepositoryWorkspace(
        {
          commitSha,
          fetchRefHints: ["refs/pull/7/head"],
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
          },
          purpose: "review",
          repoId: "repo_test",
          repoSyncConfig: config,
          repository: {
            installationId: "inst_test",
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
              throw createReviewMissingCommitGitError();
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
          leaseIdFactory: () => "lease_review",
          tempIdFactory: () => "tmp_review",
        },
      );

      expect(lease.leaseId).toBe("lease_review");
      expect(lease.workspacePath).toBe(worktreePath);
      expect(lease.checkedOutSha).toBe(commitSha);
      await lease.release();

      expect(cloneAuthInputs).toEqual([
        {
          installationId: "inst_test",
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
        ["-C", mirrorPath, "fetch", "--no-tags", "origin", "refs/pull/7/head"],
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

describe("shouldRunBaseHeadStaticAnalysis", () => {
  it("requires base-head mode and a configured runner", () => {
    const runner = createFakeToolRunner();

    expect(shouldRunBaseHeadStaticAnalysis({ mode: "base_head_delta", runner })).toBe(true);
    expect(shouldRunBaseHeadStaticAnalysis({ mode: "changed_files_fast", runner })).toBe(false);
    expect(shouldRunBaseHeadStaticAnalysis({ mode: "base_head_delta" })).toBe(false);
  });
});

describe("createStaticAnalysisBaseSnapshotForReview", () => {
  it("excludes added files that do not exist in the base commit", () => {
    const snapshot = reviewablePullRequestSnapshot({
      changedFileCount: 2,
      changedFiles: [
        ...reviewablePullRequestSnapshot().changedFiles,
        {
          additions: 4,
          changes: 4,
          deletions: 0,
          hunks: [],
          isBinary: false,
          isGenerated: false,
          isTest: false,
          language: "typescript",
          path: "src/new-file.ts",
          status: "added",
        },
      ],
    });

    const baseSnapshot = createStaticAnalysisBaseSnapshotForReview(snapshot);

    expect(baseSnapshot.changedFileCount).toBe(1);
    expect(baseSnapshot.changedFiles.map((file) => file.path)).toEqual(["src/value.ts"]);
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

/** Creates a repo-sync command failure for missing commit checks. */
function createReviewMissingCommitGitError(): RepoSyncGitCommandError {
  return new RepoSyncGitCommandError({
    code: "GIT_COMMAND_FAILED",
    command: "git cat-file -e",
    message: "Git command failed: git cat-file -e",
    stderr: { originalBytes: 0, text: "", truncated: false },
    stdout: { originalBytes: 0, text: "", truncated: false },
    timeoutMs: 120_000,
  });
}

/** Creates the minimal provider surface needed for current-head checks. */
function providerReturningSnapshot(snapshot: PullRequestSnapshot): {
  readonly fetchPullRequestSnapshot: () => Promise<PullRequestSnapshot>;
} {
  return {
    fetchPullRequestSnapshot: async () => snapshot,
  };
}

/** Builds a default review policy snapshot for gate tests. */
function reviewPolicySnapshot(): ReviewPolicySnapshot {
  return buildReviewPolicySnapshot({
    repository: {
      enabled: true,
      orgId: "org_test",
      repoId: "repo_test",
    },
    timestamp: "2026-05-07T12:00:00.000Z",
  }).snapshot;
}

/** Builds a pull request snapshot with one reviewable changed file. */
function reviewablePullRequestSnapshot(
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    ...pullRequestSnapshot,
    additions: 1,
    changedFileCount: 1,
    changedFiles: [
      {
        additions: 1,
        changes: 1,
        deletions: 0,
        hunks: [
          {
            header: "@@ -1,1 +1,1 @@",
            hunkId: "hunk_1",
            lines: [{ content: "export const value = 1;", kind: "addition", newLine: 1 }],
            newLines: 1,
            newStart: 1,
            oldLines: 0,
            oldStart: 0,
          },
        ],
        isBinary: false,
        isGenerated: false,
        isTest: false,
        language: "typescript",
        path: "src/value.ts",
        status: "modified",
      },
    ],
    ...overrides,
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

/** Product-safe metric record captured by review orchestrator unit tests. */
type RecordedMetric = {
  /** Metric kind emitted by the recorder. */
  readonly kind: "counter" | "gauge" | "histogram";
  /** Low-cardinality metric labels. */
  readonly labels?: Readonly<Record<string, unknown>> | undefined;
  /** Stable metric name. */
  readonly name: string;
  /** Optional metric unit. */
  readonly unit?: string | undefined;
  /** Numeric metric value. */
  readonly value: number;
};

/** Creates a test metric recorder that captures all emitted metrics in memory. */
function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        value: options?.value ?? 1,
      });
    },
    gauge: (name, value, options) => {
      records.push({
        kind: "gauge",
        labels: options?.labels,
        name,
        value,
      });
    },
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}
