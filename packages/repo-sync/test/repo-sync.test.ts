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
  assertAllowedGitUrl,
  assertFullCommitSha,
  assertInsideRoot,
  assertSafeRepositoryWorkspaceCleanupPath,
  cleanupRepositoryWorkspace,
  createAuthenticatedCloneUrl,
  createGitRunner,
  type GitCommandRunner,
  hashGitUrl,
  normalizeRepoPath,
  RepoSyncGitCommandError,
  redactGitRemoteUrl,
  redactSecrets,
  safeJoin,
  sanitizeGitUrl,
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
            cloneUrl: "https://x-access-token:embedded-secret@github.com/acme/api.git",
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
      ["fetch", "--depth=1", "--no-tags", "origin", commitSha],
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
    expect(JSON.stringify(mutableCommands)).not.toContain("embedded-secret");
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

  it("requires lowercase full-length commit SHAs before running Git", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-sha-test-"));
    workspaceRoots.push(workspaceRoot);
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      return "";
    };

    expect(() => assertFullCommitSha(commitSha)).not.toThrow();
    expect(() => assertFullCommitSha("main")).toThrow("40-character commit SHA");
    expect(() => assertFullCommitSha(commitSha.toUpperCase())).toThrow("40-character commit SHA");

    await expect(
      syncRepositoryWorkspace(
        {
          provider: "github",
          installationId: "inst_test",
          providerInstallationId: "99",
          owner: "acme",
          repo: "api",
          commitSha: "main",
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
      ),
    ).rejects.toThrow("40-character commit SHA");
    expect(mutableCommands).toEqual([]);
  });

  it("runs commands through the timeout-aware Git runner", async () => {
    const runner = createGitRunner({
      defaultTimeoutMs: 1_000,
      gitBinaryPath: process.execPath,
    });

    await expect(runner(["-e", "process.stdout.write('ok')"], {})).resolves.toBe("ok");
  });

  it("runs Git commands with a narrow safe environment", async () => {
    const previousLeakedValue = process.env.HEIMDALL_REPO_SYNC_SHOULD_NOT_LEAK;
    process.env.HEIMDALL_REPO_SYNC_SHOULD_NOT_LEAK = "process-secret";
    const runner = createGitRunner({
      defaultTimeoutMs: 1_000,
      gitBinaryPath: process.execPath,
    });

    try {
      const output = await runner(
        [
          "-e",
          [
            "process.stdout.write(JSON.stringify({",
            "custom: process.env.CUSTOM_REPO_SYNC_ENV ?? null,",
            "lfs: process.env.GIT_LFS_SKIP_SMUDGE ?? null,",
            "leaked: process.env.HEIMDALL_REPO_SYNC_SHOULD_NOT_LEAK ?? null,",
            "locale: process.env.LC_ALL ?? null,",
            "prompt: process.env.GIT_TERMINAL_PROMPT ?? null,",
            "systemConfig: process.env.GIT_CONFIG_NOSYSTEM ?? null",
            "}));",
          ].join(" "),
        ],
        { env: { CUSTOM_REPO_SYNC_ENV: "custom-value" } },
      );
      const environment = JSON.parse(output) as {
        readonly custom: string | null;
        readonly leaked: string | null;
        readonly lfs: string | null;
        readonly locale: string | null;
        readonly prompt: string | null;
        readonly systemConfig: string | null;
      };

      expect(environment).toEqual({
        custom: "custom-value",
        leaked: null,
        lfs: "1",
        locale: "C",
        prompt: "0",
        systemConfig: "1",
      });
    } finally {
      if (previousLeakedValue === undefined) {
        delete process.env.HEIMDALL_REPO_SYNC_SHOULD_NOT_LEAK;
      } else {
        process.env.HEIMDALL_REPO_SYNC_SHOULD_NOT_LEAK = previousLeakedValue;
      }
    }
  });

  it("redacts command failures from the Git runner", async () => {
    const runner = createGitRunner({
      defaultTimeoutMs: 1_000,
      gitBinaryPath: process.execPath,
    });

    const error = await expectGitCommandError(
      runner(
        [
          "-e",
          [
            "console.error('manual-secret ghs_provider_token');",
            "console.log('manual-secret');",
            "process.exit(7);",
          ].join(" "),
        ],
        { redact: ["manual-secret"] },
      ),
    );

    expect(error.code).toBe("GIT_COMMAND_FAILED");
    expect(error.exitCode).toBe(7);
    expect(error.command).not.toContain("manual-secret");
    expect(error.command).not.toContain("ghs_provider_token");
    expect(error.stderr.text).toContain("***");
    expect(error.stderr.text).not.toContain("manual-secret");
    expect(error.stderr.text).not.toContain("ghs_provider_token");
    expect(error.stdout.text).toContain("***");
  });

  it("times out long-running Git runner commands", async () => {
    const runner = createGitRunner({
      defaultTimeoutMs: 100,
      gitBinaryPath: process.execPath,
    });

    const error = await expectGitCommandError(
      runner(["-e", "setTimeout(() => undefined, 1_000)"], {}),
    );

    expect(error.code).toBe("GIT_TIMEOUT");
    expect(error.message).toContain("timed out after 100ms");
  });

  it("sanitizes and allowlists Git clone URLs", () => {
    const credentialedUrl = "https://x-access-token:secret@github.com/acme/api.git?token=1#main";

    expect(sanitizeGitUrl(credentialedUrl)).toBe("https://github.com/acme/api.git");
    expect(hashGitUrl(credentialedUrl)).toBe(hashGitUrl("https://github.com/acme/api.git"));
    expect(() => assertAllowedGitUrl("https://github.com/acme/api.git")).not.toThrow();
    expect(() =>
      assertAllowedGitUrl("https://github.example/acme/api.git", {
        allowedHosts: ["github.example"],
      }),
    ).not.toThrow();
    expect(() => assertAllowedGitUrl("file:///tmp/repo.git")).toThrow(
      'Git URL scheme "file" is not allowed.',
    );
    expect(() => assertAllowedGitUrl("https://example.com/acme/api.git")).toThrow(
      'Git URL host "example.com" is not allowed.',
    );
  });

  it("rejects disallowed sync clone URLs before adding the remote", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-url-test-"));
    workspaceRoots.push(workspaceRoot);
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      return "";
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
              cloneUrl: "file:///tmp/repo.git",
              username: "x-access-token",
              password: "token-123",
              expiresAt: "2026-01-01T01:00:00.000Z",
            }),
          },
          gitRunner,
        },
      ),
    ).rejects.toThrow('Git URL scheme "file" is not allowed.');
    expect(mutableCommands).toEqual([]);
  });

  it("redacts credentialed Git remote URLs for product-safe display", () => {
    expect(redactGitRemoteUrl("https://x-access-token:token-123@github.com/acme/api.git")).toBe(
      "https://x-access-token:***@github.com/acme/api.git",
    );
  });

  it("redacts exact secrets and common provider token shapes", () => {
    expect(
      redactSecrets(
        [
          "Authorization: Bearer ghs_provider_token",
          "Bearer github_pat_1234567890",
          "https://x-access-token:ghp_exampleToken@github.com/acme/api.git",
          "manual-secret",
        ].join("\n"),
        ["manual-secret"],
      ),
    ).toBe(
      [
        "Authorization: ***",
        "Bearer ***",
        "https://x-access-token:***@github.com/acme/api.git",
        "***",
      ].join("\n"),
    );
  });

  it("normalizes repository paths and prevents root escape", () => {
    const rootPath = join(tmpdir(), "heimdall-repo-path-test");

    expect(normalizeRepoPath("src//app/./index.ts")).toBe("src/app/index.ts");
    expect(normalizeRepoPath("src\\app\\index.ts")).toBe("src/app/index.ts");
    expect(safeJoin(rootPath, "src/index.ts")).toBe(join(rootPath, "src/index.ts"));
    expect(() => assertInsideRoot(rootPath, rootPath)).toThrow(
      "Path resolves outside the configured root.",
    );
    expect(() => normalizeRepoPath("../secrets")).toThrow("traversal segments");
    expect(() => normalizeRepoPath("/etc/passwd")).toThrow("relative");
    expect(() => normalizeRepoPath("C:\\temp\\repo")).toThrow("Windows drive prefix");
    expect(() => safeJoin(rootPath, "src/../../secrets")).toThrow("traversal segments");
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

/** Expects a promise to reject with a repo-sync Git command error. */
async function expectGitCommandError(promise: Promise<string>): Promise<RepoSyncGitCommandError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RepoSyncGitCommandError);
    return error as RepoSyncGitCommandError;
  }

  throw new Error("Expected command to fail.");
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
