import type { PublishReviewJobPayload } from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import { GitHubRateLimitError, type GitProvider } from "@repo/github";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricOptions,
  type TelemetryMetricRecorder,
  type TelemetrySpanEndOptions,
  type TelemetrySpanOptions,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import { publishReviewRun } from "../src";

type RecordedMetric = {
  /** Metric instrument kind recorded by the fake recorder. */
  readonly kind: "counter" | "histogram";
  /** Low-cardinality metric labels. */
  readonly labels?: TelemetryMetricOptions["labels"] | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

type RecordedSpan = {
  /** Attributes attached when the span ended. */
  readonly endAttributes?: TelemetrySpanEndOptions["attributes"] | undefined;
  /** Error attached when the span ended. */
  readonly error?: unknown;
  /** Span name. */
  readonly name: string;
  /** Attributes attached when the span started. */
  readonly startAttributes?: TelemetrySpanOptions["attributes"] | undefined;
  /** Span status attached when the span ended. */
  readonly status?: TelemetrySpanEndOptions["status"] | undefined;
};

type TestReviewRunRow = {
  /** Artifact references stored on the review run. */
  readonly artifactRefs: unknown;
  /** Base commit SHA for the reviewed pull request. */
  readonly baseSha: string;
  /** Review completion timestamp. */
  readonly completedAt: Date | null;
  /** Finding counts stored on the review run. */
  readonly counts: unknown;
  /** Review creation timestamp. */
  readonly createdAt: Date;
  /** Durable review error payload. */
  readonly error: unknown;
  /** Head commit SHA for the reviewed pull request. */
  readonly headSha: string;
  /** Review metadata payload. */
  readonly metadata: unknown;
  /** Pull request number under review. */
  readonly pullRequestNumber: number;
  /** Pull request snapshot ID used for the review. */
  readonly pullRequestSnapshotId: string;
  /** Repository ID under review. */
  readonly repoId: string;
  /** Durable review run ID. */
  readonly reviewRunId: string;
  /** Review run schema version. */
  readonly schemaVersion: "review_run.v1";
  /** Optional summary stored on the review run. */
  readonly summary: string | null;
  /** Review start timestamp. */
  readonly startedAt: Date | null;
  /** Review status. */
  readonly status: string;
  /** Review trigger. */
  readonly trigger: string;
  /** Review update timestamp. */
  readonly updatedAt: Date;
};

type TestRepositoryRow = {
  /** Heimdall installation ID. */
  readonly installationId: string;
  /** Repository owner login. */
  readonly owner: string;
  /** Repository provider. */
  readonly provider: "github";
  /** Provider installation ID. */
  readonly providerInstallationId: string;
  /** Provider repository ID. */
  readonly providerRepoId: string;
  /** Repository name. */
  readonly repo: string;
};

describe("publishReviewRun telemetry", () => {
  it("records completed publisher metrics and spans", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const result = await publishReviewRun(testPublishPayload(), {
      db: createPublisherDatabaseStub({
        repository: testRepositoryRow(),
        reviewRun: testReviewRunRow(),
        validatedFindings: [],
      }),
      gitProvider: createTelemetryGitProvider({ headSha: "2222222" }),
      metrics: createRecordingMetrics(metrics),
      traces: createRecordingTraces(spans),
    });

    expect(result).toMatchObject({
      annotationCount: 0,
      inlineCommentCount: 0,
      providerCheckRunId: "",
      staleHead: false,
    });
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            provider: "github",
            publish_mode: "live",
            status: "completed",
          },
          name: OBSERVABILITY_METRIC_NAMES.publisherRunsTotal,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: {
            provider: "github",
            publish_mode: "live",
            status: "completed",
          },
          name: OBSERVABILITY_METRIC_NAMES.publisherDurationMs,
          unit: "ms",
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "publisher.inline_comment_count": 0,
          "publisher.stale_head": false,
          "publisher.status": "completed",
        }),
        name: OBSERVABILITY_SPAN_NAMES.publisherPublishReview,
        startAttributes: expect.objectContaining({
          "app.repo_id": "repo_telemetry",
          "app.review_run_id": "rrn_telemetry",
          "publisher.provider": "github",
        }),
        status: "ok",
      }),
    ]);
  });

  it("records skipped publisher telemetry for stale heads", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const result = await publishReviewRun(testPublishPayload(), {
      db: createPublisherDatabaseStub({
        repository: testRepositoryRow(),
        reviewRun: testReviewRunRow(),
        validatedFindings: [],
      }),
      gitProvider: createTelemetryGitProvider({ headSha: "3333333" }),
      metrics: createRecordingMetrics(metrics),
      traces: createRecordingTraces(spans),
    });

    expect(result.staleHead).toBe(true);
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            provider: "github",
            publish_mode: "live",
            status: "skipped",
          },
          name: OBSERVABILITY_METRIC_NAMES.publisherRunsTotal,
        }),
        expect.objectContaining({
          labels: {
            provider: "github",
            publish_mode: "live",
            reason: "stale_head",
          },
          name: OBSERVABILITY_METRIC_NAMES.publisherCommentsSkippedTotal,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "publisher.stale_head": true,
          "publisher.status": "skipped",
        }),
        status: "ok",
      }),
    ]);
  });

  it("records failed and rate-limited publisher telemetry", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];

    await expect(
      publishReviewRun(testPublishPayload(), {
        db: createPublisherDatabaseStub({
          repository: testRepositoryRow(),
          reviewRun: testReviewRunRow(),
          validatedFindings: [],
        }),
        gitProvider: createTelemetryGitProvider({
          error: new GitHubRateLimitError("API rate limit exceeded.", {
            requestId: "req_rate_limit",
            retryAfterSeconds: 60,
            status: 403,
          }),
        }),
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      }),
    ).rejects.toThrow("API rate limit exceeded.");

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            error_class: "rate_limit_error",
            provider: "github",
            publish_mode: "live",
            status: "failed",
          },
          name: OBSERVABILITY_METRIC_NAMES.publisherRunsTotal,
        }),
        expect.objectContaining({
          labels: { operation: "publish_review" },
          name: OBSERVABILITY_METRIC_NAMES.publisherGithubRateLimitedTotal,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "publisher.error_class": "rate_limit_error",
          "publisher.status": "failed",
        }),
        status: "error",
      }),
    ]);
  });
});

function testPublishPayload(): PublishReviewJobPayload {
  return {
    pullRequestNumber: 7,
    repoId: "repo_telemetry",
    reviewRunId: "rrn_telemetry",
  };
}

function testReviewRunRow(): TestReviewRunRow {
  const timestamp = new Date("2026-05-05T12:00:00.000Z");

  return {
    artifactRefs: [],
    baseSha: "1111111",
    completedAt: timestamp,
    counts: {
      candidateFindings: 0,
      publishedFindings: 0,
      rejectedFindings: 0,
      validatedFindings: 0,
    },
    createdAt: timestamp,
    error: null,
    headSha: "2222222",
    metadata: {},
    pullRequestNumber: 7,
    pullRequestSnapshotId: "prs_telemetry",
    repoId: "repo_telemetry",
    reviewRunId: "rrn_telemetry",
    schemaVersion: "review_run.v1",
    startedAt: timestamp,
    status: "completed",
    summary: null,
    trigger: "webhook",
    updatedAt: timestamp,
  };
}

function testRepositoryRow(): TestRepositoryRow {
  return {
    installationId: "inst_telemetry",
    owner: "octo-org",
    provider: "github",
    providerInstallationId: "12345",
    providerRepoId: "98765",
    repo: "heimdall-test",
  };
}

function createPublisherDatabaseStub(options: {
  /** Repository row returned by the fake repository lookup. */
  readonly repository?: TestRepositoryRow;
  /** Review run row returned by the fake review lookup. */
  readonly reviewRun?: TestReviewRunRow;
  /** Validated findings returned by the fake finding lookup. */
  readonly validatedFindings: readonly unknown[];
}): HeimdallDatabase {
  let bareSelectCount = 0;
  const db = {
    insert: (_table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoUpdate: async (_input: unknown) => undefined,
      }),
    }),
    select: (projection?: unknown) => {
      if (projection === undefined) {
        return {
          from: (_table: unknown) => ({
            where: async (_condition: unknown) => {
              const rows =
                bareSelectCount === 0
                  ? options.reviewRun
                    ? [options.reviewRun]
                    : []
                  : options.validatedFindings;
              bareSelectCount += 1;
              return rows;
            },
          }),
        };
      }

      return {
        from: (_table: unknown) => ({
          innerJoin: (_joinTable: unknown, _condition: unknown) => ({
            where: (_whereCondition: unknown) => ({
              limit: async (_limit: number) => (options.repository ? [options.repository] : []),
            }),
          }),
        }),
      };
    },
    update: (_table: unknown) => ({
      set: (_values: unknown) => ({
        where: async (_condition: unknown) => undefined,
      }),
    }),
  };

  return db as unknown as HeimdallDatabase;
}

function createTelemetryGitProvider(options: {
  /** Error thrown while fetching the pull request snapshot. */
  readonly error?: Error;
  /** Head SHA returned by the fake pull request snapshot. */
  readonly headSha?: string;
}): GitProvider {
  return {
    provider: "github",
    fetchBranchCommit: async () => ({ metadata: {}, ref: "feature", sha: "2222222" }),
    fetchChangedFiles: async () => [],
    fetchExistingBotComments: async () => [],
    fetchExistingReviewComments: async () => [],
    fetchPullRequestSnapshot: async () => {
      if (options.error) {
        throw options.error;
      }

      return testPullRequestSnapshot(options.headSha ?? "2222222");
    },
    fetchRepository: async () => {
      throw new Error("fetchRepository is not used by this test.");
    },
    getCloneAuth: async () => ({
      cloneUrl: "https://github.example/octo-org/heimdall-test.git",
      expiresAt: "2099-01-01T00:00:00.000Z",
      password: "token",
      username: "x-access-token",
    }),
    getInstallationToken: async () => ({
      expiresAt: "2099-01-01T00:00:00.000Z",
      token: "token",
    }),
    listInstallationRepositories: async () => [],
    publishReview: async () => ({ commentIds: [], providerReviewId: "review_telemetry" }),
    publishSummaryComment: async () => ({ providerCommentId: "summary_telemetry" }),
    createOrUpdateCheckRun: async () => ({ providerCheckRunId: "check_telemetry" }),
    syncInstallation: async () => ({ repositories: [] }),
  };
}

function testPullRequestSnapshot(headSha: string) {
  return {
    additions: 0,
    authorLogin: "octocat",
    baseRef: "main",
    baseSha: "1111111",
    changedFileCount: 0,
    changedFiles: [],
    deletions: 0,
    diffHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fetchedAt: "2026-05-05T12:00:00.000Z",
    headRef: "feature",
    headSha,
    installationId: "inst_telemetry",
    isDraft: false,
    labels: [],
    provider: "github" as const,
    providerPullRequestId: "777",
    providerRepoId: "98765",
    pullRequestNumber: 7,
    repoId: "repo_telemetry",
    schemaVersion: "pull_request_snapshot.v1" as const,
    snapshotId: `prs_${headSha}`,
    state: "open" as const,
    title: "Telemetry test",
  };
}

function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
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

function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          error: endOptions.error,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}
