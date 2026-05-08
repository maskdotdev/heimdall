import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricOptions,
  type TelemetryMetricRecorder,
  type TelemetrySpanEndOptions,
  type TelemetrySpanOptions,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeRepositoryWorkspaceCleanupPath,
  cleanupRepositoryWorkspace,
  createAuthenticatedCloneUrl,
  type GitCommandRunner,
  redactGitRemoteUrl,
  syncRepositoryWorkspace,
} from "../src";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const workspaceRoots: string[] = [];

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

describe("repo sync workspace", () => {
  afterEach(async () => {
    for (const root of workspaceRoots.splice(0)) {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fetches an exact commit with GitHub clone auth and cleans up the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-test-"));
    workspaceRoots.push(workspaceRoot);
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const mutableCommands: string[][] = [];
    const fetchEnvironments: Readonly<Record<string, string | undefined>>[] = [];
    const gitRunner: GitCommandRunner = async (args, options) => {
      mutableCommands.push([...args]);
      if (args[0] === "fetch") {
        fetchEnvironments.push(options.env ?? {});
      }
      if (args[0] === "rev-parse") {
        return `${commitSha}\n`;
      }
      return "";
    };

    const result = await syncRepositoryWorkspace(
      {
        provider: "github",
        installationId: "inst_test",
        providerInstallationId: "99",
        owner: "acme",
        repo: "api",
        commitSha,
        repoId: "repo_sync_test",
        workspaceRoot,
      },
      {
        gitProvider: {
          getCloneAuth: async () => ({
            cloneUrl: "https://github.com/acme/api.git",
            username: "x-access-token",
            password: "token-123",
            expiresAt: "2026-01-01T01:00:00.000Z",
          }),
        },
        gitRunner,
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      },
    );

    expect(result).toMatchObject({
      checkedOutSha: commitSha,
      cleanedUp: true,
    });
    expect(mutableCommands).toEqual([
      ["init"],
      ["remote", "add", "origin", "https://github.com/acme/api.git"],
      ["fetch", "--depth=1", "origin", commitSha],
      ["checkout", "--detach", commitSha],
      ["rev-parse", "HEAD"],
    ]);
    expect(fetchEnvironments).toEqual([
      expect.objectContaining({
        GIT_PASSWORD: "token-123",
        GIT_TERMINAL_PROMPT: "0",
        GIT_USERNAME: "x-access-token",
      }),
    ]);
    expect(JSON.stringify(mutableCommands)).not.toContain("token-123");
    await expect(access(result.workspacePath)).rejects.toThrow();
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            operation: "checkout_workspace",
            provider: "github",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.repoSyncOperationsTotal,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: {
            operation: "checkout_workspace",
            provider: "github",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.repoSyncDurationMs,
          unit: "ms",
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "repo_sync.cleaned_up": true,
          "repo_sync.status": "succeeded",
        }),
        name: OBSERVABILITY_SPAN_NAMES.repoSyncCheckoutWorkspace,
        startAttributes: expect.objectContaining({
          "app.repo_id": "repo_sync_test",
          "repo_sync.operation": "checkout_workspace",
          "repo_sync.provider": "github",
        }),
        status: "ok",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("token-123");
    expect(JSON.stringify(spans)).not.toContain("token-123");
  });

  it("removes temporary Git askpass helpers from retained workspaces", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-askpass-test-"));
    workspaceRoots.push(workspaceRoot);
    let askPassPath: string | undefined;
    const gitRunner: GitCommandRunner = async (args, options) => {
      if (args[0] === "fetch") {
        askPassPath = options.env?.GIT_ASKPASS;
      }
      if (args[0] === "rev-parse") {
        return `${commitSha}\n`;
      }
      return "";
    };

    const result = await syncRepositoryWorkspace(
      {
        provider: "github",
        installationId: "inst_test",
        providerInstallationId: "99",
        owner: "acme",
        repo: "api",
        commitSha,
        keepWorkspace: true,
        repoId: "repo_sync_test",
        workspaceRoot,
      },
      {
        gitProvider: {
          getCloneAuth: async () => ({
            cloneUrl: "https://github.com/acme/api.git",
            username: "x-access-token",
            password: "token-123",
            expiresAt: "2026-01-01T01:00:00.000Z",
          }),
        },
        gitRunner,
      },
    );

    expect(result.cleanedUp).toBe(false);
    if (!askPassPath) {
      throw new Error("Expected repo sync to create a temporary Git askpass helper.");
    }
    await expect(access(askPassPath)).rejects.toThrow();
  });

  it("records failed repo sync telemetry without leaking clone credentials", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-failed-test-"));
    workspaceRoots.push(workspaceRoot);
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const gitRunner: GitCommandRunner = async () => {
      throw new Error("git fetch timed out");
    };

    await expect(
      syncRepositoryWorkspace(
        {
          provider: "github",
          installationId: "inst_test",
          providerInstallationId: "99",
          owner: "acme",
          repo: "api",
          commitSha,
          repoId: "repo_sync_test",
          workspaceRoot,
        },
        {
          gitProvider: {
            getCloneAuth: async () => ({
              cloneUrl: "https://github.com/acme/api.git",
              username: "x-access-token",
              password: "token-123",
              expiresAt: "2026-01-01T01:00:00.000Z",
            }),
          },
          gitRunner,
          metrics: createRecordingMetrics(metrics),
          traces: createRecordingTraces(spans),
        },
      ),
    ).rejects.toThrow("git fetch timed out");

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            error_class: "timeout_error",
            operation: "checkout_workspace",
            provider: "github",
            status: "failed",
          },
          name: OBSERVABILITY_METRIC_NAMES.repoSyncOperationsTotal,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "repo_sync.error_class": "timeout_error",
          "repo_sync.status": "failed",
        }),
        status: "error",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("token-123");
    expect(JSON.stringify(spans)).not.toContain("token-123");
  });

  it("encodes clone credentials for HTTPS Git commands", () => {
    expect(
      createAuthenticatedCloneUrl({
        cloneUrl: "https://github.com/acme/api.git",
        username: "x-access-token",
        password: "token:with@chars",
      }),
    ).toBe("https://x-access-token:token%3Awith%40chars@github.com/acme/api.git");
  });

  it("redacts credentialed Git remote URLs for product-safe display", () => {
    expect(redactGitRemoteUrl("https://x-access-token:token-123@github.com/acme/api.git")).toBe(
      "https://x-access-token:***@github.com/acme/api.git",
    );
  });

  it("removes a retained workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-cleanup-test-"));
    workspaceRoots.push(workspaceRoot);
    const workspacePath = await mkdtemp(join(workspaceRoot, "heimdall-repo-"));

    await cleanupRepositoryWorkspace(workspacePath, { workspaceRoot });

    await expect(access(workspacePath)).rejects.toThrow();
  });

  it("refuses to remove unmanaged workspace paths", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-cleanup-test-"));
    workspaceRoots.push(workspaceRoot);
    const unmanagedPath = await mkdtemp(join(workspaceRoot, "workspace-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-"));
    workspaceRoots.push(outsideRoot);

    expect(() => assertSafeRepositoryWorkspaceCleanupPath("heimdall-repo-relative")).toThrow(
      "relative repository workspace path",
    );
    await expect(cleanupRepositoryWorkspace(unmanagedPath, { workspaceRoot })).rejects.toThrow(
      "unmanaged repository workspace path",
    );
    await expect(cleanupRepositoryWorkspace(outsideRoot, { workspaceRoot })).rejects.toThrow(
      "outside the configured root",
    );

    await expect(access(unmanagedPath)).resolves.toBeUndefined();
    await expect(access(outsideRoot)).resolves.toBeUndefined();
  });
});

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
