import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
  acquireRepositoryWorkspace,
  assertAllowedGitUrl,
  assertFullCommitSha,
  assertInsideRoot,
  assertSafeRepositoryWorkspaceCleanupPath,
  buildBareCloneArgs,
  buildCommitExistsArgs,
  buildFetchRefArgs,
  buildWorkspaceHeadArgs,
  buildWorkspaceRootArgs,
  buildWorkspaceStatusArgs,
  buildWorktreeAddArgs,
  buildWorktreePruneArgs,
  buildWorktreeRemoveArgs,
  cleanupExpiredRepositoryWorktrees,
  cleanupRepositoryWorkspace,
  createAuthenticatedCloneUrl,
  createGitRunner,
  createRepoSyncConfig,
  createRepositoryWorktreeLease,
  ensureRepositoryCommit,
  ensureRepositoryMirror,
  type GitCommandRunner,
  getRepoSyncCacheLayout,
  getRepoSyncCacheStats,
  getRepoSyncLeaseMetadataPath,
  getRepoSyncLockPath,
  getRepoSyncMirrorPath,
  getRepoSyncTempMirrorPath,
  getRepoSyncWorktreePath,
  hashGitUrl,
  loadRepoSyncConfigFromEnvironment,
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

/** Returns fake Git output for worktree validation commands. */
function fakeWorktreeValidationOutput(
  args: readonly string[],
  headSha = commitSha,
): string | undefined {
  if (args[0] !== "-C") {
    return undefined;
  }
  if (args[2] === "rev-parse" && args[3] === "HEAD") {
    return `${headSha}\n`;
  }
  if (args[2] === "rev-parse" && args[3] === "--show-toplevel") {
    return `${args[1]}\n`;
  }
  if (args[2] === "status" && args[3] === "--porcelain=v1") {
    return "";
  }

  return undefined;
}

describe("repo sync workspace", () => {
  afterEach(async () => {
    for (const root of workspaceRoots.splice(0)) {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads repo-sync cache configuration with safe defaults and environment overrides", () => {
    const cacheRoot = join(tmpdir(), "heimdall-repo-sync-cache-config-test");

    expect(createRepoSyncConfig({ cacheRoot })).toMatchObject({
      allowedGitHosts: ["github.com", "www.github.com"],
      cacheNodeId: "local",
      cacheRoot,
      defaultFetchTimeoutMs: 120_000,
      defaultLeaseTtlSeconds: 1_800,
      enableLfsFetch: false,
      enablePartialClone: true,
      enableSparseCheckout: true,
      enableSubmodules: false,
      gitBinaryPath: "git",
      maxConcurrentFetches: 4,
      maxConcurrentWorktrees: 16,
    });

    expect(
      loadRepoSyncConfigFromEnvironment({
        REPO_SYNC_ALLOWED_GIT_HOSTS: "github.com,github.example",
        REPO_SYNC_CACHE_NODE_ID: "worker-a",
        REPO_SYNC_CACHE_ROOT: cacheRoot,
        REPO_SYNC_DEFAULT_LEASE_TTL_SECONDS: "900",
        REPO_SYNC_ENABLE_LFS_FETCH: "true",
        REPO_SYNC_ENABLE_PARTIAL_CLONE: "false",
        REPO_SYNC_ENABLE_SPARSE_CHECKOUT: "false",
        REPO_SYNC_ENABLE_SUBMODULES: "true",
        REPO_SYNC_FETCH_TIMEOUT_MS: "30000",
        REPO_SYNC_GIT_BINARY: "/usr/bin/git",
        REPO_SYNC_MAX_CONCURRENT_FETCHES: "2",
        REPO_SYNC_MAX_CONCURRENT_WORKTREES: "8",
        REPO_SYNC_MAX_MIRROR_BYTES: "2048",
        REPO_SYNC_MAX_TOTAL_CACHE_BYTES: "4096",
        REPO_SYNC_MAX_WORKSPACE_BYTES: "1024",
        REPO_SYNC_WORKTREE_TIMEOUT_MS: "45000",
      }),
    ).toMatchObject({
      allowedGitHosts: ["github.com", "github.example"],
      cacheNodeId: "worker-a",
      cacheRoot,
      defaultFetchTimeoutMs: 30_000,
      defaultLeaseTtlSeconds: 900,
      defaultWorktreeTimeoutMs: 45_000,
      enableLfsFetch: true,
      enablePartialClone: false,
      enableSparseCheckout: false,
      enableSubmodules: true,
      gitBinaryPath: "/usr/bin/git",
      maxConcurrentFetches: 2,
      maxConcurrentWorktrees: 8,
      maxMirrorBytes: 2_048,
      maxTotalCacheBytes: 4_096,
      maxWorkspaceBytes: 1_024,
    });

    expect(() => createRepoSyncConfig({ allowedGitHosts: [], cacheRoot })).toThrow(
      "allowed Git hosts",
    );
    expect(() => createRepoSyncConfig({ cacheRoot: "/" })).toThrow("filesystem root");
    expect(() => loadRepoSyncConfigFromEnvironment({ REPO_SYNC_FETCH_TIMEOUT_MS: "0" })).toThrow(
      "positive integer",
    );
    expect(() => loadRepoSyncConfigFromEnvironment({ REPO_SYNC_ENABLE_LFS_FETCH: "yes" })).toThrow(
      "true or false",
    );
  });

  it("builds safe repo-sync cache paths", () => {
    const cacheRoot = join(tmpdir(), "heimdall-repo-sync-cache-path-test");
    const config = createRepoSyncConfig({ cacheRoot });

    expect(getRepoSyncCacheLayout(config)).toEqual({
      cacheRoot,
      leaseMetadataRoot: join(cacheRoot, "metadata", "worktree-leases"),
      locksRoot: join(cacheRoot, "locks"),
      metadataRoot: join(cacheRoot, "metadata"),
      mirrorsRoot: join(cacheRoot, "mirrors"),
      tmpRoot: join(cacheRoot, "tmp"),
      worktreesRoot: join(cacheRoot, "worktrees"),
    });
    expect(getRepoSyncMirrorPath(config, "repo_123")).toBe(
      join(cacheRoot, "mirrors", "repo_123.git"),
    );
    expect(getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456")).toBe(
      join(cacheRoot, "tmp", "clone_repo_123_tmp_456.git"),
    );
    expect(getRepoSyncWorktreePath(config, "lease_123")).toBe(
      join(cacheRoot, "worktrees", "lease_123"),
    );
    expect(getRepoSyncLeaseMetadataPath(config, "lease_123")).toBe(
      join(cacheRoot, "metadata", "worktree-leases", "lease_123.json"),
    );
    expect(getRepoSyncLockPath(config, "fetch_repo_123")).toBe(
      join(cacheRoot, "locks", "fetch_repo_123.lock"),
    );
    expect(() => getRepoSyncMirrorPath(config, "../repo")).toThrow("safe cache path segment");
    expect(() => getRepoSyncWorktreePath(config, "lease/123")).toThrow("safe cache path segment");
  });

  it("builds Git argv arrays for mirror and worktree operations", () => {
    const cacheRoot = join(tmpdir(), "heimdall-repo-sync-command-test");
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");

    expect(
      buildBareCloneArgs({
        cloneUrl: "https://x-access-token:secret@github.com/acme/api.git?token=1",
        mirrorPath: tempMirrorPath,
      }),
    ).toEqual([
      "clone",
      "--bare",
      "--filter=blob:none",
      "--no-tags",
      "https://github.com/acme/api.git",
      tempMirrorPath,
    ]);
    expect(
      buildBareCloneArgs({
        cloneUrl: "https://github.com/acme/api.git",
        enablePartialClone: false,
        fetchTags: true,
        mirrorPath: tempMirrorPath,
      }),
    ).toEqual(["clone", "--bare", "--tags", "https://github.com/acme/api.git", tempMirrorPath]);
    expect(buildFetchRefArgs({ mirrorPath, ref: "refs/pull/1/head" })).toEqual([
      "-C",
      mirrorPath,
      "fetch",
      "--no-tags",
      "origin",
      "refs/pull/1/head",
    ]);
    expect(buildCommitExistsArgs({ commitSha, mirrorPath })).toEqual([
      "-C",
      mirrorPath,
      "cat-file",
      "-e",
      `${commitSha}^{commit}`,
    ]);
    expect(buildWorktreeAddArgs({ commitSha, mirrorPath, workspacePath: worktreePath })).toEqual([
      "-C",
      mirrorPath,
      "worktree",
      "add",
      "--detach",
      worktreePath,
      commitSha,
    ]);
    expect(buildWorkspaceHeadArgs({ workspacePath: worktreePath })).toEqual([
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    expect(buildWorkspaceRootArgs({ workspacePath: worktreePath })).toEqual([
      "-C",
      worktreePath,
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(buildWorkspaceStatusArgs({ workspacePath: worktreePath })).toEqual([
      "-C",
      worktreePath,
      "status",
      "--porcelain=v1",
    ]);
    expect(buildWorktreeRemoveArgs({ mirrorPath, workspacePath: worktreePath })).toEqual([
      "-C",
      mirrorPath,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    expect(buildWorktreePruneArgs({ mirrorPath })).toEqual(["-C", mirrorPath, "worktree", "prune"]);
    expect(() => buildFetchRefArgs({ mirrorPath, ref: "--upload-pack=bad" })).toThrow(
      "must not start with a dash",
    );
    expect(() =>
      buildWorktreeAddArgs({ commitSha: "main", mirrorPath, workspacePath: worktreePath }),
    ).toThrow("40-character commit SHA");
  });

  it("creates and reuses an atomic bare repository mirror", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-mirror-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    const mutableCommands: string[][] = [];
    const mutableEnvironments: Readonly<Record<string, string | undefined>>[] = [];
    const gitRunner: GitCommandRunner = async (args, options) => {
      mutableCommands.push([...args]);
      mutableEnvironments.push(options.env ?? {});
      await mkdir(args[args.length - 1] ?? "", { recursive: true });
      return "";
    };

    const result = await ensureRepositoryMirror(
      {
        cloneUrl: "https://x-access-token:embedded-secret@github.com/acme/api.git?token=1",
        config,
        credential: {
          kind: "https-basic-token",
          token: "token-123",
          username: "x-access-token",
        },
        repoId: "repo_123",
      },
      { gitRunner, tempIdFactory: () => "tmp_456" },
    );

    expect(result).toEqual({
      cloneUrlHash: hashGitUrl("https://github.com/acme/api.git"),
      created: true,
      mirrorPath,
      repoId: "repo_123",
    });
    expect(mutableCommands).toEqual([
      [
        "clone",
        "--bare",
        "--filter=blob:none",
        "--no-tags",
        "https://github.com/acme/api.git",
        tempMirrorPath,
      ],
    ]);
    expect(mutableEnvironments).toEqual([
      expect.objectContaining({
        GIT_PASSWORD: "token-123",
        GIT_TERMINAL_PROMPT: "0",
        GIT_USERNAME: "x-access-token",
      }),
    ]);
    expect(JSON.stringify(mutableCommands)).not.toContain("token-123");
    expect(JSON.stringify(mutableCommands)).not.toContain("embedded-secret");
    await expect(access(mirrorPath)).resolves.toBeUndefined();
    await expect(access(tempMirrorPath)).rejects.toThrow();
    const askPassPath = mutableEnvironments[0]?.GIT_ASKPASS;
    if (!askPassPath) {
      throw new Error("Expected mirror creation to use a temporary Git askpass helper.");
    }
    await expect(access(askPassPath)).rejects.toThrow();

    const reused = await ensureRepositoryMirror(
      {
        cloneUrl: "https://github.com/acme/api.git",
        config,
        repoId: "repo_123",
      },
      { gitRunner, tempIdFactory: () => "tmp_789" },
    );

    expect(reused).toEqual({
      cloneUrlHash: hashGitUrl("https://github.com/acme/api.git"),
      created: false,
      mirrorPath,
      repoId: "repo_123",
    });
    expect(mutableCommands).toHaveLength(1);
  });

  it("cleans temporary mirror clone paths after clone failures", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-mirror-failure-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    let askPassPath: string | undefined;
    const gitRunner: GitCommandRunner = async (args, options) => {
      askPassPath = options.env?.GIT_ASKPASS;
      await mkdir(args[args.length - 1] ?? "", { recursive: true });
      throw new Error("clone failed");
    };

    await expect(
      ensureRepositoryMirror(
        {
          cloneUrl: "https://github.com/acme/api.git",
          config,
          credential: {
            kind: "https-basic-token",
            token: "token-123",
            username: "x-access-token",
          },
          repoId: "repo_123",
        },
        { gitRunner, tempIdFactory: () => "tmp_456" },
      ),
    ).rejects.toThrow("clone failed");

    await expect(access(mirrorPath)).rejects.toThrow();
    await expect(access(tempMirrorPath)).rejects.toThrow();
    if (!askPassPath) {
      throw new Error("Expected mirror creation to create an askpass helper before cloning.");
    }
    await expect(access(askPassPath)).rejects.toThrow();
  });

  it("returns an existing mirror commit without fetching refs", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-commit-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    await mkdir(mirrorPath, { recursive: true });
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      return "";
    };

    await expect(
      ensureRepositoryCommit(
        {
          cloneUrl: "https://github.com/acme/api.git",
          commitSha,
          config,
          repoId: "repo_123",
        },
        { gitRunner },
      ),
    ).resolves.toEqual({
      cloneUrlHash: hashGitUrl("https://github.com/acme/api.git"),
      commitSha,
      created: false,
      fetched: false,
      mirrorPath,
      repoId: "repo_123",
    });

    expect(mutableCommands).toEqual([
      ["-C", mirrorPath, "cat-file", "-e", `${commitSha}^{commit}`],
    ]);
  });

  it("fetches ref hints when a mirror is missing the requested commit", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-commit-fetch-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    const mutableCommands: string[][] = [];
    const fetchEnvironments: Readonly<Record<string, string | undefined>>[] = [];
    let commitExists = false;
    const gitRunner: GitCommandRunner = async (args, options) => {
      mutableCommands.push([...args]);
      if (args[0] === "clone") {
        await mkdir(args[args.length - 1] ?? "", { recursive: true });
        return "";
      }
      if (args[2] === "cat-file") {
        if (commitExists) {
          return "";
        }
        throw createMissingCommitGitError();
      }
      if (args[2] === "fetch") {
        fetchEnvironments.push(options.env ?? {});
        if (args[args.length - 1] === "refs/pull/1/head") {
          commitExists = true;
        }
        return "";
      }
      return "";
    };

    await expect(
      ensureRepositoryCommit(
        {
          cloneUrl: "https://x-access-token:embedded-secret@github.com/acme/api.git?token=1",
          commitSha,
          config,
          credential: {
            kind: "https-basic-token",
            token: "token-123",
            username: "x-access-token",
          },
          fetchRefHints: ["refs/pull/1/head"],
          repoId: "repo_123",
        },
        { gitRunner, tempIdFactory: () => "tmp_456" },
      ),
    ).resolves.toEqual({
      cloneUrlHash: hashGitUrl("https://github.com/acme/api.git"),
      commitSha,
      created: true,
      fetched: true,
      mirrorPath,
      repoId: "repo_123",
    });

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
      ["-C", mirrorPath, "fetch", "--no-tags", "origin", "refs/pull/1/head"],
      ["-C", mirrorPath, "cat-file", "-e", `${commitSha}^{commit}`],
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
    const fetchAskPassPath = fetchEnvironments[0]?.GIT_ASKPASS;
    if (!fetchAskPassPath) {
      throw new Error("Expected commit fetch to use a temporary Git askpass helper.");
    }
    await expect(access(fetchAskPassPath)).rejects.toThrow();
  });

  it("serializes concurrent fetches for the same cached mirror", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-fetch-lock-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, defaultFetchTimeoutMs: 5_000 });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const mutableCommands: string[][] = [];
    let activeFetchCount = 0;
    let commitExists = false;
    let maxActiveFetchCount = 0;

    await mkdir(mirrorPath, { recursive: true });

    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[2] === "cat-file") {
        if (commitExists) {
          return "";
        }
        throw createMissingCommitGitError();
      }
      if (args[2] === "fetch") {
        activeFetchCount += 1;
        maxActiveFetchCount = Math.max(maxActiveFetchCount, activeFetchCount);
        await sleep(30);
        commitExists = true;
        activeFetchCount -= 1;
      }
      return "";
    };

    const results = await Promise.all([
      ensureRepositoryCommit(
        {
          cloneUrl: "https://github.com/acme/api.git",
          commitSha,
          config,
          fetchRefHints: ["refs/pull/1/head"],
          repoId: "repo_123",
        },
        { gitRunner },
      ),
      ensureRepositoryCommit(
        {
          cloneUrl: "https://github.com/acme/api.git",
          commitSha,
          config,
          fetchRefHints: ["refs/pull/1/head"],
          repoId: "repo_123",
        },
        { gitRunner },
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ commitSha, repoId: "repo_123" }),
      expect.objectContaining({ commitSha, repoId: "repo_123" }),
    ]);
    expect(results.filter((result) => result.fetched)).toHaveLength(1);
    expect(maxActiveFetchCount).toBe(1);
    expect(mutableCommands.filter((command) => command[2] === "fetch")).toEqual([
      ["-C", mirrorPath, "fetch", "--no-tags", "origin", "refs/pull/1/head"],
    ]);
  });

  it("fails when fetched refs do not provide the requested commit", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-commit-missing-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[0] === "clone") {
        await mkdir(args[args.length - 1] ?? "", { recursive: true });
        return "";
      }
      if (args[2] === "cat-file") {
        throw createMissingCommitGitError();
      }
      return "";
    };

    await expect(
      ensureRepositoryCommit(
        {
          cloneUrl: "https://github.com/acme/api.git",
          commitSha,
          config,
          fetchRefHints: ["refs/pull/1/head"],
          repoId: "repo_123",
        },
        { gitRunner, tempIdFactory: () => "tmp_456" },
      ),
    ).rejects.toThrow(`Repository mirror does not contain commit ${commitSha}`);

    expect(mutableCommands).toEqual([
      [
        "clone",
        "--bare",
        "--filter=blob:none",
        "--no-tags",
        "https://github.com/acme/api.git",
        tempMirrorPath,
      ],
      ["-C", getRepoSyncMirrorPath(config, "repo_123"), "cat-file", "-e", `${commitSha}^{commit}`],
      ["-C", getRepoSyncMirrorPath(config, "repo_123"), "cat-file", "-e", `${commitSha}^{commit}`],
      [
        "-C",
        getRepoSyncMirrorPath(config, "repo_123"),
        "fetch",
        "--no-tags",
        "origin",
        "refs/pull/1/head",
      ],
      ["-C", getRepoSyncMirrorPath(config, "repo_123"), "cat-file", "-e", `${commitSha}^{commit}`],
      ["-C", getRepoSyncMirrorPath(config, "repo_123"), "fetch", "--no-tags", "origin", commitSha],
      ["-C", getRepoSyncMirrorPath(config, "repo_123"), "cat-file", "-e", `${commitSha}^{commit}`],
    ]);
  });

  it("creates and releases detached worktree leases idempotently", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-worktree-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, defaultLeaseTtlSeconds: 60 });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const metadataPath = getRepoSyncLeaseMetadataPath(config, "lease_123");
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(worktreePath, { recursive: true });
      }
      if (args[2] === "worktree" && args[3] === "remove") {
        await rm(worktreePath, { force: true, recursive: true });
      }
      const validationOutput = fakeWorktreeValidationOutput(args);
      if (validationOutput !== undefined) {
        return validationOutput;
      }
      return "";
    };

    const lease = await createRepositoryWorktreeLease(
      {
        commitSha,
        config,
        leaseId: "lease_123",
        mirrorPath,
        purpose: "index",
        repoId: "repo_123",
      },
      {
        diskUsageProvider: {
          getUsageBytes: async () => 256,
        },
        gitRunner,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    expect(lease).toMatchObject({
      commitSha,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z",
      leaseId: "lease_123",
      mirrorPath,
      path: worktreePath,
      purpose: "index",
      repoId: "repo_123",
      workspaceSizeBytes: 256,
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
    await expect(access(metadataPath)).resolves.toBeUndefined();

    await lease.release();
    await lease.release();

    await expect(access(worktreePath)).rejects.toThrow();
    await expect(access(metadataPath)).rejects.toThrow();
    expect(mutableCommands).toEqual([
      ["-C", mirrorPath, "worktree", "add", "--detach", worktreePath, commitSha],
      ["-C", worktreePath, "rev-parse", "HEAD"],
      ["-C", worktreePath, "rev-parse", "--show-toplevel"],
      ["-C", worktreePath, "status", "--porcelain=v1"],
      ["-C", mirrorPath, "worktree", "remove", "--force", worktreePath],
      ["-C", mirrorPath, "worktree", "prune"],
    ]);
  });

  it("removes residual worktree paths when detached worktree creation fails", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-worktree-failure-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const gitRunner: GitCommandRunner = async (args) => {
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(worktreePath, { recursive: true });
        throw new Error("worktree add failed");
      }
      return "";
    };

    await expect(
      createRepositoryWorktreeLease(
        {
          commitSha,
          config,
          leaseId: "lease_123",
          mirrorPath,
          purpose: "review",
          repoId: "repo_123",
        },
        { gitRunner },
      ),
    ).rejects.toThrow("worktree add failed");

    await expect(access(worktreePath)).rejects.toThrow();
  });

  it("removes worktree leases when checkout validation fails", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-worktree-head-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const wrongCommitSha = "1111111111111111111111111111111111111111";
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(worktreePath, { recursive: true });
        return "";
      }
      const validationOutput = fakeWorktreeValidationOutput(args, wrongCommitSha);
      if (validationOutput !== undefined) {
        return validationOutput;
      }
      if (args[2] === "worktree" && args[3] === "remove") {
        await rm(worktreePath, { force: true, recursive: true });
      }
      return "";
    };

    await expect(
      createRepositoryWorktreeLease(
        {
          commitSha,
          config,
          leaseId: "lease_123",
          mirrorPath,
          purpose: "review",
          repoId: "repo_123",
        },
        { gitRunner },
      ),
    ).rejects.toThrow(`Repository worktree resolved ${wrongCommitSha} instead of ${commitSha}.`);

    await expect(access(worktreePath)).rejects.toThrow();
    expect(mutableCommands).toEqual([
      ["-C", mirrorPath, "worktree", "add", "--detach", worktreePath, commitSha],
      ["-C", worktreePath, "rev-parse", "HEAD"],
      ["-C", mirrorPath, "worktree", "remove", "--force", worktreePath],
      ["-C", mirrorPath, "worktree", "prune"],
    ]);
  });

  it("removes worktree leases when clean-status validation fails", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-worktree-status-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(worktreePath, { recursive: true });
        return "";
      }
      if (args[2] === "rev-parse" && args[3] === "HEAD") {
        return `${commitSha}\n`;
      }
      if (args[2] === "rev-parse" && args[3] === "--show-toplevel") {
        return `${worktreePath}\n`;
      }
      if (args[2] === "status" && args[3] === "--porcelain=v1") {
        return "?? generated.txt\n";
      }
      if (args[2] === "worktree" && args[3] === "remove") {
        await rm(worktreePath, { force: true, recursive: true });
      }
      return "";
    };

    await expect(
      createRepositoryWorktreeLease(
        {
          commitSha,
          config,
          leaseId: "lease_123",
          mirrorPath,
          purpose: "review",
          repoId: "repo_123",
        },
        { gitRunner },
      ),
    ).rejects.toThrow("Repository worktree has uncommitted changes.");

    await expect(access(worktreePath)).rejects.toThrow();
    expect(mutableCommands).toEqual([
      ["-C", mirrorPath, "worktree", "add", "--detach", worktreePath, commitSha],
      ["-C", worktreePath, "rev-parse", "HEAD"],
      ["-C", worktreePath, "rev-parse", "--show-toplevel"],
      ["-C", worktreePath, "status", "--porcelain=v1"],
      ["-C", mirrorPath, "worktree", "remove", "--force", worktreePath],
      ["-C", mirrorPath, "worktree", "prune"],
    ]);
  });

  it("removes worktree leases when workspace quota is exceeded", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-worktree-quota-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, maxWorkspaceBytes: 512 });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(worktreePath, { recursive: true });
        return "";
      }
      const validationOutput = fakeWorktreeValidationOutput(args);
      if (validationOutput !== undefined) {
        return validationOutput;
      }
      if (args[2] === "worktree" && args[3] === "remove") {
        await rm(worktreePath, { force: true, recursive: true });
      }
      return "";
    };

    await expect(
      createRepositoryWorktreeLease(
        {
          commitSha,
          config,
          leaseId: "lease_123",
          mirrorPath,
          purpose: "review",
          repoId: "repo_123",
        },
        {
          diskUsageProvider: {
            getUsageBytes: async () => 1_024,
          },
          gitRunner,
        },
      ),
    ).rejects.toThrow("exceeding configured max 512 bytes");

    await expect(access(worktreePath)).rejects.toThrow();
    expect(mutableCommands).toEqual([
      ["-C", mirrorPath, "worktree", "add", "--detach", worktreePath, commitSha],
      ["-C", worktreePath, "rev-parse", "HEAD"],
      ["-C", worktreePath, "rev-parse", "--show-toplevel"],
      ["-C", worktreePath, "status", "--porcelain=v1"],
      ["-C", mirrorPath, "worktree", "remove", "--force", worktreePath],
      ["-C", mirrorPath, "worktree", "prune"],
    ]);
  });

  it("acquires a cached exact-commit workspace and releases its lease", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-acquire-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, defaultLeaseTtlSeconds: 120 });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const tempMirrorPath = getRepoSyncTempMirrorPath(config, "repo_123", "tmp_456");
    const worktreePath = getRepoSyncWorktreePath(config, "lease_123");
    const mutableCommands: string[][] = [];
    let commitExists = false;
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
      if (args[0] === "clone") {
        await mkdir(args[args.length - 1] ?? "", { recursive: true });
        return "";
      }
      if (args[2] === "cat-file") {
        if (commitExists) {
          return "";
        }
        throw createMissingCommitGitError();
      }
      if (args[2] === "fetch") {
        commitExists = true;
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
      const validationOutput = fakeWorktreeValidationOutput(args);
      if (validationOutput !== undefined) {
        return validationOutput;
      }
      return "";
    };

    const lease = await acquireRepositoryWorkspace(
      {
        cloneUrl: "https://github.com/acme/api.git",
        commitSha,
        config,
        fetchRefHints: ["refs/pull/1/head"],
        leaseId: "lease_123",
        purpose: "review",
        repoId: "repo_123",
      },
      {
        gitRunner,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        tempIdFactory: () => "tmp_456",
      },
    );

    expect(lease).toMatchObject({
      cloneUrlHash: hashGitUrl("https://github.com/acme/api.git"),
      commitSha,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:02:00.000Z",
      fetched: true,
      leaseId: "lease_123",
      mirrorCreated: true,
      mirrorPath,
      path: worktreePath,
      purpose: "review",
      repoId: "repo_123",
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();

    await lease.release();

    await expect(access(worktreePath)).rejects.toThrow();
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
      ["-C", mirrorPath, "fetch", "--no-tags", "origin", "refs/pull/1/head"],
      ["-C", mirrorPath, "cat-file", "-e", `${commitSha}^{commit}`],
      ["-C", mirrorPath, "worktree", "add", "--detach", worktreePath, commitSha],
      ["-C", worktreePath, "rev-parse", "HEAD"],
      ["-C", worktreePath, "rev-parse", "--show-toplevel"],
      ["-C", worktreePath, "status", "--porcelain=v1"],
      ["-C", mirrorPath, "worktree", "remove", "--force", worktreePath],
      ["-C", mirrorPath, "worktree", "prune"],
    ]);
  });

  it("removes expired cached worktrees and prunes stale mirror metadata", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-expired-cleanup-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, defaultLeaseTtlSeconds: 60 });
    const layout = getRepoSyncCacheLayout(config);
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const expiredWorktreePath = getRepoSyncWorktreePath(config, "lease_expired");
    const activeWorktreePath = getRepoSyncWorktreePath(config, "lease_active");
    const ignoredWorktreePath = join(layout.worktreesRoot, "workspace_ignored");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiredTimestamp = new Date("2025-12-31T23:58:00.000Z");
    const mutableCommands: string[][] = [];

    await mkdir(mirrorPath, { recursive: true });
    await mkdir(expiredWorktreePath, { recursive: true });
    await mkdir(activeWorktreePath, { recursive: true });
    await mkdir(ignoredWorktreePath, { recursive: true });
    await utimes(expiredWorktreePath, expiredTimestamp, expiredTimestamp);
    await utimes(activeWorktreePath, now, now);

    const result = await cleanupExpiredRepositoryWorktrees(
      { config },
      {
        gitRunner: async (args) => {
          mutableCommands.push([...args]);
          return "";
        },
        now: () => now,
      },
    );

    expect(result).toEqual({
      cutoff: "2025-12-31T23:59:00.000Z",
      dryRun: false,
      expiredWorktreeCount: 1,
      failures: [],
      prunedMirrorCount: 1,
      removedWorktreeCount: 1,
      scannedWorktreeCount: 3,
      skippedWorktreeCount: 2,
    });
    await expect(access(expiredWorktreePath)).rejects.toThrow();
    await expect(access(activeWorktreePath)).resolves.toBeUndefined();
    await expect(access(ignoredWorktreePath)).resolves.toBeUndefined();
    expect(mutableCommands).toEqual([["-C", mirrorPath, "worktree", "prune"]]);
  });

  it("plans expired cached worktree cleanup without deleting paths during dry runs", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-dry-cleanup-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, defaultLeaseTtlSeconds: 60 });
    const expiredWorktreePath = getRepoSyncWorktreePath(config, "lease_expired");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiredTimestamp = new Date("2025-12-31T23:58:00.000Z");
    const mutableCommands: string[][] = [];

    await mkdir(expiredWorktreePath, { recursive: true });
    await utimes(expiredWorktreePath, expiredTimestamp, expiredTimestamp);

    const result = await cleanupExpiredRepositoryWorktrees(
      { config, dryRun: true },
      {
        gitRunner: async (args) => {
          mutableCommands.push([...args]);
          return "";
        },
        now: () => now,
      },
    );

    expect(result).toEqual({
      cutoff: "2025-12-31T23:59:00.000Z",
      dryRun: true,
      expiredWorktreeCount: 1,
      failures: [],
      prunedMirrorCount: 0,
      removedWorktreeCount: 0,
      scannedWorktreeCount: 1,
      skippedWorktreeCount: 0,
    });
    await expect(access(expiredWorktreePath)).resolves.toBeUndefined();
    expect(mutableCommands).toEqual([]);
  });

  it("reports cache stats and freed worktree bytes after expired cleanup", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-cache-stats-test-"));
    workspaceRoots.push(cacheRoot);
    const config = createRepoSyncConfig({ cacheRoot, defaultLeaseTtlSeconds: 60 });
    const mirrorPath = getRepoSyncMirrorPath(config, "repo_123");
    const expiredWorktreePath = getRepoSyncWorktreePath(config, "lease_expired");
    const activeWorktreePath = getRepoSyncWorktreePath(config, "lease_active");
    const expiredMetadataPath = getRepoSyncLeaseMetadataPath(config, "lease_expired");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const gitRunner: GitCommandRunner = async (args) => {
      if (args[2] === "worktree" && args[3] === "add") {
        const workspacePath = args[5];
        if (workspacePath === undefined) {
          throw new Error("Missing fake worktree path.");
        }
        await mkdir(workspacePath, { recursive: true });
        await writeFile(
          join(workspacePath, "payload.txt"),
          workspacePath.endsWith("lease_expired") ? "expired-worktree".repeat(64) : "active",
          "utf8",
        );
      }
      const validationOutput = fakeWorktreeValidationOutput(args);
      if (validationOutput !== undefined) {
        return validationOutput;
      }
      return "";
    };

    await mkdir(mirrorPath, { recursive: true });
    await writeFile(join(mirrorPath, "objects.dat"), "mirror", "utf8");
    await createRepositoryWorktreeLease(
      {
        commitSha,
        config,
        leaseId: "lease_expired",
        mirrorPath,
        purpose: "review",
        repoId: "repo_123",
      },
      {
        gitRunner,
        now: () => new Date("2025-12-31T23:58:00.000Z"),
      },
    );
    await createRepositoryWorktreeLease(
      {
        commitSha,
        config,
        leaseId: "lease_active",
        mirrorPath,
        purpose: "index",
        repoId: "repo_123",
      },
      {
        gitRunner,
        now: () => now,
      },
    );

    const beforeCleanup = await getRepoSyncCacheStats({ config }, { now: () => now });

    expect(beforeCleanup.worktrees.map((worktree) => worktree.leaseId).sort()).toEqual([
      "lease_active",
      "lease_expired",
    ]);
    expect(beforeCleanup.activeWorkspaces.map((worktree) => worktree.leaseId)).toEqual([
      "lease_active",
    ]);
    expect(beforeCleanup.mirrors).toMatchObject([
      {
        activeWorktreeCount: 1,
        path: mirrorPath,
        repoId: "repo_123",
      },
    ]);
    expect(beforeCleanup.totalBytes).toBeGreaterThan(0);
    expect(beforeCleanup.worktreeBytes).toBeGreaterThan(0);

    await cleanupExpiredRepositoryWorktrees(
      { config },
      {
        gitRunner,
        now: () => now,
      },
    );
    const afterCleanup = await getRepoSyncCacheStats({ config }, { now: () => now });

    expect(afterCleanup.worktrees.map((worktree) => worktree.leaseId)).toEqual(["lease_active"]);
    expect(afterCleanup.worktreeBytes).toBeLessThan(beforeCleanup.worktreeBytes);
    await expect(access(expiredWorktreePath)).rejects.toThrow();
    await expect(access(expiredMetadataPath)).rejects.toThrow();
    await expect(access(activeWorktreePath)).resolves.toBeUndefined();
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

function createMissingCommitGitError(): RepoSyncGitCommandError {
  return new RepoSyncGitCommandError({
    code: "GIT_COMMAND_FAILED",
    command: "git cat-file -e",
    message: "Git command failed: git cat-file -e",
    stderr: { originalBytes: 0, text: "", truncated: false },
    stdout: { originalBytes: 0, text: "", truncated: false },
    timeoutMs: 120_000,
  });
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
