import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, parse, posix, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { GitHubRepositoryRef, GitProvider } from "@repo/github";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";

const execFileAsync = promisify(execFile);
const defaultAllowedGitHosts = ["github.com", "www.github.com"] as const;
const defaultGitCommandTimeoutMs = 120_000;
const defaultGitOutputBufferBytes = 256 * 1024;
const defaultRepoSyncCacheRoot = ".local/git-cache";
const defaultRepoSyncCacheNodeId = "local";
const defaultRepoSyncLeaseTtlSeconds = 60 * 30;
const defaultRepoSyncMaxTotalCacheBytes = 100 * 1024 * 1024 * 1024;
const defaultRepoSyncMaxMirrorBytes = 20 * 1024 * 1024 * 1024;
const defaultRepoSyncMaxWorkspaceBytes = 5 * 1024 * 1024 * 1024;
const defaultRepoSyncCleanupLimit = 100;
const defaultRepoSyncLockRetryDelayMs = 25;
const managedWorkspacePrefix = "heimdall-repo-";
const redactedSecret = "***";
const githubTokenPattern = /\bgh[opsu]_[A-Za-z0-9_]+\b/gu;
const githubPatPattern = /\bgithub_pat_[A-Za-z0-9_]+\b/gu;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const authorizationHeaderPattern = /\bAuthorization:\s*[^\r\n]+/giu;
const xAccessTokenPattern = /(x-access-token:)[^@\s/]+/giu;
const fullCommitShaPattern = /^[0-9a-f]{40}$/u;
const safeCachePathSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const windowsDrivePathPattern = /^[A-Za-z]:($|[\\/])/u;

declare const repoPathBrand: unique symbol;

/** Repository-relative path normalized to forward slashes. */
export type RepoPath = string & { readonly [repoPathBrand]: "RepoPath" };

/** Environment record used when loading repo-sync configuration. */
export type RepoSyncEnvironment = Readonly<Record<string, string | undefined>>;

/** Runtime configuration for repo-sync cache and Git behavior. */
export type RepoSyncConfig = {
  /** Root directory that contains mirror, worktree, temp, and lock subdirectories. */
  readonly cacheRoot: string;
  /** Stable identifier for the worker cache node. */
  readonly cacheNodeId: string;
  /** Git executable used by the command runner. */
  readonly gitBinaryPath: string;
  /** Maximum concurrent mirror fetch operations. */
  readonly maxConcurrentFetches: number;
  /** Maximum concurrent worktree operations. */
  readonly maxConcurrentWorktrees: number;
  /** Default fetch timeout in milliseconds. */
  readonly defaultFetchTimeoutMs: number;
  /** Default worktree operation timeout in milliseconds. */
  readonly defaultWorktreeTimeoutMs: number;
  /** Default workspace lease lifetime in seconds. */
  readonly defaultLeaseTtlSeconds: number;
  /** Maximum total cache bytes for one node. */
  readonly maxTotalCacheBytes: number;
  /** Maximum mirror bytes for one repository mirror. */
  readonly maxMirrorBytes: number;
  /** Maximum workspace bytes for one checked-out workspace. */
  readonly maxWorkspaceBytes: number;
  /** Clone URL hosts allowed for this repo-sync instance. */
  readonly allowedGitHosts: readonly string[];
  /** Enables partial clone command construction when true. */
  readonly enablePartialClone: boolean;
  /** Enables sparse checkout support when true. */
  readonly enableSparseCheckout: boolean;
  /** Enables explicit Git LFS content fetching when true. */
  readonly enableLfsFetch: boolean;
  /** Enables submodule initialization when true. */
  readonly enableSubmodules: boolean;
};

/** Partial repo-sync configuration accepted from apps and tests. */
export type CreateRepoSyncConfigInput = Partial<RepoSyncConfig>;

/** Physical cache layout derived from a repo-sync cache root. */
export type RepoSyncCacheLayout = {
  /** Root directory that contains all repo-sync cache paths. */
  readonly cacheRoot: string;
  /** Directory containing bare repository mirrors. */
  readonly mirrorsRoot: string;
  /** Directory containing checked-out worktrees. */
  readonly worktreesRoot: string;
  /** Directory containing temporary clone and staging paths. */
  readonly tmpRoot: string;
  /** Directory containing local lock files. */
  readonly locksRoot: string;
};

/** Git command runner used by repo sync and tests. */
export type GitCommandRunner = (
  args: readonly string[],
  options: GitCommandRunnerOptions,
) => Promise<string>;

/** Options passed to one Git command execution. */
export type GitCommandRunnerOptions = {
  /** Working directory for the Git command. */
  readonly cwd?: string;
  /** Environment overrides for the Git command. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Secrets that must be redacted from command failure details. */
  readonly redact?: readonly string[];
  /** Command timeout in milliseconds. */
  readonly timeoutMs?: number;
};

/** Options used when creating the default Git command runner. */
export type CreateGitRunnerOptions = {
  /** Git binary path, or another binary in tests. */
  readonly gitBinaryPath?: string;
  /** Default command timeout in milliseconds. */
  readonly defaultTimeoutMs?: number;
  /** Maximum stdout or stderr bytes captured by Node. */
  readonly maxBufferBytes?: number;
};

/** Input for constructing a bare clone command. */
export type BuildBareCloneArgsInput = {
  /** Sanitized clone URL used as the remote. */
  readonly cloneUrl: string;
  /** Destination bare mirror path. */
  readonly mirrorPath: string;
  /** Enables `--filter=blob:none` partial clone mode. */
  readonly enablePartialClone?: boolean;
  /** Fetches tags during clone when true. */
  readonly fetchTags?: boolean;
};

/** Input for constructing a fetch command. */
export type BuildFetchRefArgsInput = {
  /** Bare mirror path. */
  readonly mirrorPath: string;
  /** Remote name to fetch from. */
  readonly remote?: string;
  /** Ref or refspec to fetch. */
  readonly ref: string;
  /** Fetches tags when true. */
  readonly fetchTags?: boolean;
};

/** Input for constructing a commit-existence command. */
export type BuildCommitExistsArgsInput = {
  /** Commit SHA that must exist in the mirror. */
  readonly commitSha: string;
  /** Bare mirror path. */
  readonly mirrorPath: string;
};

/** Input for constructing a worktree add command. */
export type BuildWorktreeAddArgsInput = {
  /** Commit SHA to check out detached. */
  readonly commitSha: string;
  /** Bare mirror path. */
  readonly mirrorPath: string;
  /** Workspace path for the new worktree. */
  readonly workspacePath: string;
};

/** Input for constructing a worktree path command. */
export type BuildWorktreePathArgsInput = {
  /** Bare mirror path. */
  readonly mirrorPath: string;
  /** Workspace path for the worktree. */
  readonly workspacePath: string;
};

/** Input for constructing a workspace HEAD verification command. */
export type BuildWorkspaceHeadArgsInput = {
  /** Workspace path that should be checked out at the requested commit. */
  readonly workspacePath: string;
};

/** Input for constructing a mirror-only worktree command. */
export type BuildMirrorWorktreeArgsInput = {
  /** Bare mirror path. */
  readonly mirrorPath: string;
};

/** Provider-neutral Git credential accepted by repo-sync mirror operations. */
export type GitCredential =
  | {
      /** HTTPS basic auth token credential. */
      readonly kind: "https-basic-token";
      /** Username supplied to Git through askpass. */
      readonly username: string;
      /** Token supplied to Git through askpass. */
      readonly token: string;
    }
  | {
      /** Bearer token credential reserved for future provider adapters. */
      readonly kind: "bearer-token";
      /** Token value that must never be logged. */
      readonly token: string;
    }
  | {
      /** SSH private key credential reserved for future provider adapters. */
      readonly kind: "ssh-key";
      /** Secret reference for the SSH private key. */
      readonly privateKeyRef: string;
    };

/** Input required to create or reuse a cached bare repository mirror. */
export type EnsureRepositoryMirrorInput = {
  /** Runtime repo-sync configuration. */
  readonly config: RepoSyncConfig;
  /** Stable product repository ID used in cache paths. */
  readonly repoId: string;
  /** Clone URL for the repository. Credentials, query strings, and fragments are stripped. */
  readonly cloneUrl: string;
  /** Optional credential used for private HTTPS clone operations. */
  readonly credential?: GitCredential;
  /** Overrides partial clone command construction for this mirror. */
  readonly enablePartialClone?: boolean;
  /** Fetches tags during the initial clone when true. */
  readonly fetchTags?: boolean;
};

/** Dependencies for repository mirror creation. */
export type EnsureRepositoryMirrorDependencies = {
  /** Optional Git command runner for tests or hosted runtimes. */
  readonly gitRunner?: GitCommandRunner;
  /** Optional temp ID factory for deterministic tests. */
  readonly tempIdFactory?: () => string;
};

/** Reference to a cached bare repository mirror. */
export type RepositoryMirrorRef = {
  /** Stable product repository ID. */
  readonly repoId: string;
  /** Bare mirror path on the local cache volume. */
  readonly mirrorPath: string;
  /** SHA-256 hash of the sanitized clone URL. */
  readonly cloneUrlHash: string;
  /** True when this call created the mirror. */
  readonly created: boolean;
};

/** Input required to ensure an exact commit exists in the cached mirror. */
export type EnsureRepositoryCommitInput = EnsureRepositoryMirrorInput & {
  /** Commit SHA that must exist in the mirror. */
  readonly commitSha: string;
  /** Optional refs to fetch before falling back to a direct commit fetch. */
  readonly fetchRefHints?: readonly string[];
};

/** Exact commit availability result for one repository mirror. */
export type RepositoryCommitAvailability = RepositoryMirrorRef & {
  /** Commit SHA verified in the mirror. */
  readonly commitSha: string;
  /** True when this call fetched refs after an initial miss. */
  readonly fetched: boolean;
};

/** Reason a repository worktree lease was acquired. */
export type RepositoryWorktreePurpose = "debug" | "index" | "replay" | "review" | "static_analysis";

/** Input required to create a detached worktree lease from a mirror. */
export type CreateRepositoryWorktreeLeaseInput = {
  /** Runtime repo-sync configuration. */
  readonly config: RepoSyncConfig;
  /** Stable product repository ID. */
  readonly repoId: string;
  /** Commit SHA to check out in detached mode. */
  readonly commitSha: string;
  /** Bare mirror path that owns the worktree. */
  readonly mirrorPath: string;
  /** Purpose attached to lease metadata. */
  readonly purpose: RepositoryWorktreePurpose;
  /** Optional deterministic lease ID. */
  readonly leaseId?: string;
  /** Optional lease TTL in seconds. */
  readonly ttlSeconds?: number;
};

/** Dependencies for detached worktree lease creation. */
export type CreateRepositoryWorktreeLeaseDependencies = {
  /** Optional Git command runner for tests or hosted runtimes. */
  readonly gitRunner?: GitCommandRunner;
  /** Optional lease ID factory for deterministic tests. */
  readonly leaseIdFactory?: () => string;
  /** Optional clock for deterministic lease timestamps. */
  readonly now?: () => Date;
};

/** Detached repository worktree lease with idempotent release. */
export type RepositoryWorktreeLease = {
  /** Stable product repository ID. */
  readonly repoId: string;
  /** Lease ID used as the worktree path segment. */
  readonly leaseId: string;
  /** Commit SHA checked out in detached mode. */
  readonly commitSha: string;
  /** Worktree path on disk. */
  readonly path: string;
  /** Bare mirror path that owns the worktree. */
  readonly mirrorPath: string;
  /** ISO timestamp when the lease was created. */
  readonly createdAt: string;
  /** ISO timestamp when the lease should be considered expired. */
  readonly expiresAt: string;
  /** Purpose attached to the lease. */
  readonly purpose: RepositoryWorktreePurpose;
  /** Removes the worktree and prunes stale mirror metadata. */
  readonly release: () => Promise<void>;
};

/** Input required to acquire a cached repository workspace at an exact commit. */
export type AcquireRepositoryWorkspaceInput = EnsureRepositoryCommitInput & {
  /** Purpose attached to the created worktree lease. */
  readonly purpose: RepositoryWorktreePurpose;
  /** Optional deterministic lease ID. */
  readonly leaseId?: string;
  /** Optional lease TTL in seconds. */
  readonly ttlSeconds?: number;
};

/** Dependencies for cached repository workspace acquisition. */
export type AcquireRepositoryWorkspaceDependencies = EnsureRepositoryMirrorDependencies &
  CreateRepositoryWorktreeLeaseDependencies;

/** Cached repository workspace lease with mirror/fetch metadata. */
export type RepositoryWorkspaceLease = RepositoryWorktreeLease & {
  /** SHA-256 hash of the sanitized clone URL used for the mirror. */
  readonly cloneUrlHash: string;
  /** True when workspace acquisition created the mirror. */
  readonly mirrorCreated: boolean;
  /** True when workspace acquisition fetched refs after an initial commit miss. */
  readonly fetched: boolean;
};

/** Input for cleaning expired cached worktree paths after crashes. */
export type CleanupExpiredRepositoryWorktreesInput = {
  /** Runtime repo-sync configuration. */
  readonly config: RepoSyncConfig;
  /** Removes at most this many expired worktrees in one pass. */
  readonly limit?: number;
  /** Cutoff used to select expired worktree directories. */
  readonly expiredBefore?: Date;
  /** Reports eligible cleanup work without deleting paths or pruning mirrors. */
  readonly dryRun?: boolean;
};

/** Dependencies for expired worktree cleanup. */
export type CleanupExpiredRepositoryWorktreesDependencies = {
  /** Optional Git command runner for pruning stale mirror worktree metadata. */
  readonly gitRunner?: GitCommandRunner;
  /** Optional clock for deterministic expiration tests. */
  readonly now?: () => Date;
};

/** Failure captured while cleaning one repo-sync cache path. */
export type RepoSyncCleanupFailure = {
  /** Filesystem path that cleanup attempted to handle. */
  readonly path: string;
  /** Stable product-safe failure reason. */
  readonly reason: string;
  /** Product-safe error message. */
  readonly message: string;
};

/** Summary returned after one expired worktree cleanup pass. */
export type CleanupExpiredRepositoryWorktreesResult = {
  /** Cutoff used to decide whether a worktree had expired. */
  readonly cutoff: string;
  /** Whether this pass only planned cleanup work. */
  readonly dryRun: boolean;
  /** Expired worktree directories selected before the limit was applied. */
  readonly expiredWorktreeCount: number;
  /** Cleanup failures captured without aborting the full pass. */
  readonly failures: readonly RepoSyncCleanupFailure[];
  /** Mirrors pruned after worktree removal. */
  readonly prunedMirrorCount: number;
  /** Worktree directories removed by this pass. */
  readonly removedWorktreeCount: number;
  /** Worktree cache entries inspected. */
  readonly scannedWorktreeCount: number;
  /** Worktree cache entries skipped because they were active, unsafe, or over the limit. */
  readonly skippedWorktreeCount: number;
};

/** Product-safe captured Git command output attached to failures. */
export type CapturedGitOutput = {
  /** Redacted captured text, truncated when needed. */
  readonly text: string;
  /** True when captured text was truncated. */
  readonly truncated: boolean;
  /** Original UTF-8 byte length before truncation. */
  readonly originalBytes: number;
};

/** Git command failure classification. */
export type RepoSyncGitCommandErrorCode = "GIT_COMMAND_FAILED" | "GIT_TIMEOUT";

/** Product-safe Git command failure with redacted command and output details. */
export class RepoSyncGitCommandError extends Error {
  /** Stable error code for retry and telemetry classification. */
  public readonly code: RepoSyncGitCommandErrorCode;
  /** Redacted command line that failed. */
  public readonly command: string;
  /** Process exit code when available. */
  public readonly exitCode: number | undefined;
  /** Process signal when available. */
  public readonly signal: string | undefined;
  /** Redacted stderr captured from the failed command. */
  public readonly stderr: CapturedGitOutput;
  /** Redacted stdout captured from the failed command. */
  public readonly stdout: CapturedGitOutput;
  /** Command timeout in milliseconds. */
  public readonly timeoutMs: number;

  /** Creates a Git command error with product-safe details. */
  public constructor(input: {
    /** Stable error code for retry and telemetry classification. */
    readonly code: RepoSyncGitCommandErrorCode;
    /** Redacted command line that failed. */
    readonly command: string;
    /** Process exit code when available. */
    readonly exitCode?: number | undefined;
    /** Error message to expose to callers. */
    readonly message: string;
    /** Process signal when available. */
    readonly signal?: string | undefined;
    /** Redacted stderr captured from the failed command. */
    readonly stderr: CapturedGitOutput;
    /** Redacted stdout captured from the failed command. */
    readonly stdout: CapturedGitOutput;
    /** Command timeout in milliseconds. */
    readonly timeoutMs: number;
    /** Original command failure. */
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "RepoSyncGitCommandError";
    this.code = input.code;
    this.command = input.command;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stderr = input.stderr;
    this.stdout = input.stdout;
    this.timeoutMs = input.timeoutMs;
  }
}

/** Creates repo-sync configuration with production-safe defaults. */
export function createRepoSyncConfig(input: CreateRepoSyncConfigInput = {}): RepoSyncConfig {
  return {
    allowedGitHosts: normalizeAllowedGitHosts(input.allowedGitHosts ?? defaultAllowedGitHosts),
    cacheNodeId: input.cacheNodeId ?? defaultRepoSyncCacheNodeId,
    cacheRoot: normalizeRepoSyncCacheRoot(input.cacheRoot ?? defaultRepoSyncCacheRoot),
    defaultFetchTimeoutMs: input.defaultFetchTimeoutMs ?? defaultGitCommandTimeoutMs,
    defaultLeaseTtlSeconds: input.defaultLeaseTtlSeconds ?? defaultRepoSyncLeaseTtlSeconds,
    defaultWorktreeTimeoutMs: input.defaultWorktreeTimeoutMs ?? defaultGitCommandTimeoutMs,
    enableLfsFetch: input.enableLfsFetch ?? false,
    enablePartialClone: input.enablePartialClone ?? true,
    enableSparseCheckout: input.enableSparseCheckout ?? true,
    enableSubmodules: input.enableSubmodules ?? false,
    gitBinaryPath: input.gitBinaryPath ?? "git",
    maxConcurrentFetches: input.maxConcurrentFetches ?? 4,
    maxConcurrentWorktrees: input.maxConcurrentWorktrees ?? 16,
    maxMirrorBytes: input.maxMirrorBytes ?? defaultRepoSyncMaxMirrorBytes,
    maxTotalCacheBytes: input.maxTotalCacheBytes ?? defaultRepoSyncMaxTotalCacheBytes,
    maxWorkspaceBytes: input.maxWorkspaceBytes ?? defaultRepoSyncMaxWorkspaceBytes,
  };
}

/** Loads repo-sync configuration from REPO_SYNC_* environment variables. */
export function loadRepoSyncConfigFromEnvironment(env: RepoSyncEnvironment): RepoSyncConfig {
  return createRepoSyncConfig({
    ...optionalString("cacheRoot", env.REPO_SYNC_CACHE_ROOT),
    ...optionalString("cacheNodeId", env.REPO_SYNC_CACHE_NODE_ID),
    ...optionalString("gitBinaryPath", env.REPO_SYNC_GIT_BINARY),
    ...optionalInteger("defaultFetchTimeoutMs", env.REPO_SYNC_FETCH_TIMEOUT_MS),
    ...optionalInteger("defaultWorktreeTimeoutMs", env.REPO_SYNC_WORKTREE_TIMEOUT_MS),
    ...optionalInteger("defaultLeaseTtlSeconds", env.REPO_SYNC_DEFAULT_LEASE_TTL_SECONDS),
    ...optionalInteger("maxConcurrentFetches", env.REPO_SYNC_MAX_CONCURRENT_FETCHES),
    ...optionalInteger("maxConcurrentWorktrees", env.REPO_SYNC_MAX_CONCURRENT_WORKTREES),
    ...optionalInteger("maxMirrorBytes", env.REPO_SYNC_MAX_MIRROR_BYTES),
    ...optionalInteger("maxTotalCacheBytes", env.REPO_SYNC_MAX_TOTAL_CACHE_BYTES),
    ...optionalInteger("maxWorkspaceBytes", env.REPO_SYNC_MAX_WORKSPACE_BYTES),
    ...optionalStringList("allowedGitHosts", env.REPO_SYNC_ALLOWED_GIT_HOSTS),
    ...optionalBoolean("enablePartialClone", env.REPO_SYNC_ENABLE_PARTIAL_CLONE),
    ...optionalBoolean("enableSparseCheckout", env.REPO_SYNC_ENABLE_SPARSE_CHECKOUT),
    ...optionalBoolean("enableLfsFetch", env.REPO_SYNC_ENABLE_LFS_FETCH),
    ...optionalBoolean("enableSubmodules", env.REPO_SYNC_ENABLE_SUBMODULES),
  });
}

/** Returns the physical cache directory layout for a repo-sync cache root. */
export function getRepoSyncCacheLayout(input: RepoSyncCachePathInput): RepoSyncCacheLayout {
  const cacheRoot = normalizeRepoSyncCacheRoot(cacheRootFromPathInput(input));

  return {
    cacheRoot,
    locksRoot: join(cacheRoot, "locks"),
    mirrorsRoot: join(cacheRoot, "mirrors"),
    tmpRoot: join(cacheRoot, "tmp"),
    worktreesRoot: join(cacheRoot, "worktrees"),
  };
}

/** Returns the bare mirror path for one repository ID. */
export function getRepoSyncMirrorPath(input: RepoSyncCachePathInput, repoId: string): string {
  return join(
    getRepoSyncCacheLayout(input).mirrorsRoot,
    `${safeCachePathSegment("repoId", repoId)}.git`,
  );
}

/** Returns the temporary mirror path for one clone attempt. */
export function getRepoSyncTempMirrorPath(
  input: RepoSyncCachePathInput,
  repoId: string,
  tempId: string,
): string {
  return join(
    getRepoSyncCacheLayout(input).tmpRoot,
    `clone_${safeCachePathSegment("repoId", repoId)}_${safeCachePathSegment("tempId", tempId)}.git`,
  );
}

/** Returns the checked-out worktree path for one lease ID. */
export function getRepoSyncWorktreePath(input: RepoSyncCachePathInput, leaseId: string): string {
  return join(
    getRepoSyncCacheLayout(input).worktreesRoot,
    safeCachePathSegment("leaseId", leaseId),
  );
}

/** Returns the lock path for a repo-sync lock ID. */
export function getRepoSyncLockPath(input: RepoSyncCachePathInput, lockId: string): string {
  return join(
    getRepoSyncCacheLayout(input).locksRoot,
    `${safeCachePathSegment("lockId", lockId)}.lock`,
  );
}

/** Runs a cache mutation while holding a bounded repo-sync filesystem lock. */
export async function withRepoSyncLock<T>(
  input: RepoSyncLockInput,
  callback: () => Promise<T>,
): Promise<T> {
  const layout = getRepoSyncCacheLayout(input.config);
  const lockPath = getRepoSyncLockPath(
    input.config,
    `${input.operation}_${safeCachePathSegment("repoId", input.repoId)}`,
  );
  const timeoutMs = normalizeRepoSyncLockTimeout(input.timeoutMs);
  const retryDelayMs = normalizeRepoSyncLockRetryDelay(input.retryDelayMs);
  const startedAtMs = Date.now();

  assertInsideRoot(layout.locksRoot, lockPath);
  await mkdir(layout.locksRoot, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isPathExistsError(error)) {
        throw error;
      }

      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= timeoutMs) {
        throw new Error(
          `Timed out acquiring repo sync ${input.operation} lock for repository ${input.repoId}.`,
        );
      }

      await sleep(Math.min(retryDelayMs, Math.max(1, timeoutMs - elapsedMs)));
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}

/** Creates a cached bare repository mirror when it does not already exist. */
export async function ensureRepositoryMirror(
  input: EnsureRepositoryMirrorInput,
  dependencies: EnsureRepositoryMirrorDependencies = {},
): Promise<RepositoryMirrorRef> {
  const sanitizedCloneUrl = sanitizeGitUrl(input.cloneUrl);
  assertAllowedGitUrl(sanitizedCloneUrl, { allowedHosts: input.config.allowedGitHosts });

  const layout = getRepoSyncCacheLayout(input.config);
  const mirrorPath = getRepoSyncMirrorPath(input.config, input.repoId);
  const cloneUrlHash = hashGitUrl(sanitizedCloneUrl);
  if (await pathExists(mirrorPath)) {
    return { cloneUrlHash, created: false, mirrorPath, repoId: input.repoId };
  }

  return withRepoSyncLock(
    {
      config: input.config,
      operation: "mirror",
      repoId: input.repoId,
      timeoutMs: input.config.defaultFetchTimeoutMs,
    },
    async () => {
      if (await pathExists(mirrorPath)) {
        return { cloneUrlHash, created: false, mirrorPath, repoId: input.repoId };
      }

      await mkdir(layout.mirrorsRoot, { recursive: true });
      await mkdir(layout.tmpRoot, { recursive: true });

      const tempMirrorPath = getRepoSyncTempMirrorPath(
        input.config,
        input.repoId,
        dependencies.tempIdFactory?.() ?? randomUUID(),
      );
      await rm(tempMirrorPath, { force: true, recursive: true });

      const git = dependencies.gitRunner ?? runGit;
      let askPassRoot: string | undefined;

      try {
        const commandOptions = await createMirrorGitCommandOptions(input, layout.tmpRoot);
        askPassRoot = commandOptions.askPassRoot;
        const gitOptions: GitCommandRunnerOptions = {
          ...(commandOptions.env ? { env: commandOptions.env } : {}),
          ...(commandOptions.redact ? { redact: commandOptions.redact } : {}),
          timeoutMs: input.config.defaultFetchTimeoutMs,
        };
        const bareCloneInput: BuildBareCloneArgsInput = {
          cloneUrl: sanitizedCloneUrl,
          enablePartialClone: input.enablePartialClone ?? input.config.enablePartialClone,
          ...(input.fetchTags === undefined ? {} : { fetchTags: input.fetchTags }),
          mirrorPath: tempMirrorPath,
        };
        await git(buildBareCloneArgs(bareCloneInput), gitOptions);

        if (await pathExists(mirrorPath)) {
          await rm(tempMirrorPath, { force: true, recursive: true });
          return { cloneUrlHash, created: false, mirrorPath, repoId: input.repoId };
        }

        try {
          await rename(tempMirrorPath, mirrorPath);
        } catch (error) {
          if (await pathExists(mirrorPath)) {
            await rm(tempMirrorPath, { force: true, recursive: true });
            return { cloneUrlHash, created: false, mirrorPath, repoId: input.repoId };
          }
          throw error;
        }

        return { cloneUrlHash, created: true, mirrorPath, repoId: input.repoId };
      } catch (error) {
        await rm(tempMirrorPath, { force: true, recursive: true });
        throw error;
      } finally {
        if (askPassRoot) {
          await rm(askPassRoot, { force: true, recursive: true });
        }
      }
    },
  );
}

/** Ensures an exact commit exists in a cached repository mirror. */
export async function ensureRepositoryCommit(
  input: EnsureRepositoryCommitInput,
  dependencies: EnsureRepositoryMirrorDependencies = {},
): Promise<RepositoryCommitAvailability> {
  assertFullCommitSha(input.commitSha);
  const mirror = await ensureRepositoryMirror(input, dependencies);
  const git = dependencies.gitRunner ?? runGit;
  if (
    await repositoryCommitExists(
      git,
      mirror.mirrorPath,
      input.commitSha,
      input.config.defaultFetchTimeoutMs,
    )
  ) {
    return { ...mirror, commitSha: input.commitSha, fetched: false };
  }

  return withRepoSyncLock(
    {
      config: input.config,
      operation: "fetch",
      repoId: input.repoId,
      timeoutMs: input.config.defaultFetchTimeoutMs,
    },
    async () => {
      if (
        await repositoryCommitExists(
          git,
          mirror.mirrorPath,
          input.commitSha,
          input.config.defaultFetchTimeoutMs,
        )
      ) {
        return { ...mirror, commitSha: input.commitSha, fetched: false };
      }

      const layout = getRepoSyncCacheLayout(input.config);
      await mkdir(layout.tmpRoot, { recursive: true });
      const commandOptions = await createMirrorGitCommandOptions(input, layout.tmpRoot);
      try {
        const gitOptions: GitCommandRunnerOptions = {
          ...(commandOptions.env ? { env: commandOptions.env } : {}),
          ...(commandOptions.redact ? { redact: commandOptions.redact } : {}),
          timeoutMs: input.config.defaultFetchTimeoutMs,
        };
        for (const ref of [...(input.fetchRefHints ?? []), input.commitSha]) {
          await git(
            buildFetchArgs({ fetchTags: input.fetchTags, mirrorPath: mirror.mirrorPath, ref }),
            {
              ...gitOptions,
            },
          );
          if (
            await repositoryCommitExists(
              git,
              mirror.mirrorPath,
              input.commitSha,
              input.config.defaultFetchTimeoutMs,
            )
          ) {
            return { ...mirror, commitSha: input.commitSha, fetched: true };
          }
        }
      } finally {
        if (commandOptions.askPassRoot) {
          await rm(commandOptions.askPassRoot, { force: true, recursive: true });
        }
      }

      throw new Error(
        `Repository mirror does not contain commit ${input.commitSha} after fetching requested refs.`,
      );
    },
  );
}

/** Creates a detached repository worktree lease from an existing mirror. */
export async function createRepositoryWorktreeLease(
  input: CreateRepositoryWorktreeLeaseInput,
  dependencies: CreateRepositoryWorktreeLeaseDependencies = {},
): Promise<RepositoryWorktreeLease> {
  assertFullCommitSha(input.commitSha);
  const leaseId = input.leaseId ?? dependencies.leaseIdFactory?.() ?? `lease_${randomUUID()}`;
  const workspacePath = getRepoSyncWorktreePath(input.config, leaseId);
  const layout = getRepoSyncCacheLayout(input.config);
  await mkdir(layout.worktreesRoot, { recursive: true });

  const git = dependencies.gitRunner ?? runGit;
  let worktreeCreated = false;
  try {
    await withRepoSyncLock(
      {
        config: input.config,
        operation: "worktree",
        repoId: input.repoId,
        timeoutMs: input.config.defaultWorktreeTimeoutMs,
      },
      async () => {
        await git(
          buildWorktreeAddArgs({
            commitSha: input.commitSha,
            mirrorPath: input.mirrorPath,
            workspacePath,
          }),
          { timeoutMs: input.config.defaultWorktreeTimeoutMs },
        );
      },
    );
    worktreeCreated = true;
    await verifyRepositoryWorktreeHead({
      commitSha: input.commitSha,
      gitRunner: git,
      timeoutMs: input.config.defaultWorktreeTimeoutMs,
      workspacePath,
    });
  } catch (error) {
    if (worktreeCreated) {
      await cleanupFailedRepositoryWorktreeLease({
        config: input.config,
        gitRunner: git,
        mirrorPath: input.mirrorPath,
        repoId: input.repoId,
        workspacePath,
      });
    }
    await rm(workspacePath, { force: true, recursive: true });
    throw error;
  }

  const createdAtDate = dependencies.now?.() ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? input.config.defaultLeaseTtlSeconds;
  const expiresAtDate = new Date(createdAtDate.getTime() + ttlSeconds * 1_000);
  let released = false;

  return {
    commitSha: input.commitSha,
    createdAt: createdAtDate.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
    leaseId,
    mirrorPath: input.mirrorPath,
    path: workspacePath,
    purpose: input.purpose,
    release: async () => {
      if (released) {
        return;
      }

      await withRepoSyncLock(
        {
          config: input.config,
          operation: "worktree",
          repoId: input.repoId,
          timeoutMs: input.config.defaultWorktreeTimeoutMs,
        },
        async () => {
          await git(buildWorktreeRemoveArgs({ mirrorPath: input.mirrorPath, workspacePath }), {
            timeoutMs: input.config.defaultWorktreeTimeoutMs,
          });
          await rm(workspacePath, { force: true, recursive: true });
          await git(buildWorktreePruneArgs({ mirrorPath: input.mirrorPath }), {
            timeoutMs: input.config.defaultWorktreeTimeoutMs,
          });
        },
      );
      released = true;
    },
    repoId: input.repoId,
  };
}

/** Acquires a cached repository workspace for an exact commit. */
export async function acquireRepositoryWorkspace(
  input: AcquireRepositoryWorkspaceInput,
  dependencies: AcquireRepositoryWorkspaceDependencies = {},
): Promise<RepositoryWorkspaceLease> {
  const commit = await ensureRepositoryCommit(input, dependencies);
  const lease = await createRepositoryWorktreeLease(
    {
      commitSha: input.commitSha,
      config: input.config,
      ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
      mirrorPath: commit.mirrorPath,
      purpose: input.purpose,
      repoId: input.repoId,
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    },
    dependencies,
  );

  return {
    ...lease,
    cloneUrlHash: commit.cloneUrlHash,
    fetched: commit.fetched,
    mirrorCreated: commit.created,
  };
}

/** Input used to verify the exact commit checked out in a worktree. */
type VerifyRepositoryWorktreeHeadInput = {
  /** Expected exact commit SHA. */
  readonly commitSha: string;
  /** Git runner used to inspect the workspace. */
  readonly gitRunner: GitCommandRunner;
  /** Timeout applied to the verification command. */
  readonly timeoutMs: number;
  /** Worktree path that should be pinned to the expected commit. */
  readonly workspacePath: string;
};

/** Verifies that a checked-out worktree resolves to the requested commit SHA. */
async function verifyRepositoryWorktreeHead(
  input: VerifyRepositoryWorktreeHeadInput,
): Promise<void> {
  const checkedOutSha = (
    await input.gitRunner(buildWorkspaceHeadArgs({ workspacePath: input.workspacePath }), {
      timeoutMs: input.timeoutMs,
    })
  ).trim();

  if (checkedOutSha !== input.commitSha) {
    throw new Error(`Repository worktree resolved ${checkedOutSha} instead of ${input.commitSha}.`);
  }
}

/** Input used when removing a worktree that failed validation. */
type CleanupFailedRepositoryWorktreeLeaseInput = {
  /** Runtime repo-sync configuration. */
  readonly config: RepoSyncConfig;
  /** Git runner used to remove worktree metadata. */
  readonly gitRunner: GitCommandRunner;
  /** Bare mirror path that owns the worktree. */
  readonly mirrorPath: string;
  /** Stable product repository ID used in the worktree lock key. */
  readonly repoId: string;
  /** Worktree path to remove after validation failure. */
  readonly workspacePath: string;
};

/** Best-effort cleanup for a worktree whose checkout validation failed. */
async function cleanupFailedRepositoryWorktreeLease(
  input: CleanupFailedRepositoryWorktreeLeaseInput,
): Promise<void> {
  try {
    await withRepoSyncLock(
      {
        config: input.config,
        operation: "worktree",
        repoId: input.repoId,
        timeoutMs: input.config.defaultWorktreeTimeoutMs,
      },
      async () => {
        await input.gitRunner(
          buildWorktreeRemoveArgs({
            mirrorPath: input.mirrorPath,
            workspacePath: input.workspacePath,
          }),
          { timeoutMs: input.config.defaultWorktreeTimeoutMs },
        );
        await input.gitRunner(buildWorktreePruneArgs({ mirrorPath: input.mirrorPath }), {
          timeoutMs: input.config.defaultWorktreeTimeoutMs,
        });
      },
    );
  } catch {
    await rm(input.workspacePath, { force: true, recursive: true });
  }
}

/** Cleans expired cached worktree paths and prunes stale mirror metadata. */
export async function cleanupExpiredRepositoryWorktrees(
  input: CleanupExpiredRepositoryWorktreesInput,
  dependencies: CleanupExpiredRepositoryWorktreesDependencies = {},
): Promise<CleanupExpiredRepositoryWorktreesResult> {
  const layout = getRepoSyncCacheLayout(input.config);
  const dryRun = input.dryRun === true;
  const limit = normalizeRepoSyncCleanupLimit(input.limit);
  const cutoff =
    input.expiredBefore ??
    new Date(
      (dependencies.now?.() ?? new Date()).getTime() - input.config.defaultLeaseTtlSeconds * 1_000,
    );
  const failures: RepoSyncCleanupFailure[] = [];
  let expiredWorktreeCount = 0;
  let removedWorktreeCount = 0;
  let scannedWorktreeCount = 0;
  let skippedWorktreeCount = 0;

  const worktreeEntries = await readRepoSyncDirectoryEntries(layout.worktreesRoot);
  for (const entry of worktreeEntries) {
    scannedWorktreeCount += 1;
    if (!isRepoSyncLeaseWorktreeName(entry.name)) {
      skippedWorktreeCount += 1;
      continue;
    }

    const worktreePath = getRepoSyncWorktreePath(input.config, entry.name);
    try {
      assertInsideRoot(layout.worktreesRoot, worktreePath);
      const worktreeStats = await lstat(worktreePath);
      if (!worktreeStats.isDirectory() || worktreeStats.mtime.getTime() > cutoff.getTime()) {
        skippedWorktreeCount += 1;
        continue;
      }

      expiredWorktreeCount += 1;
      if (removedWorktreeCount >= limit) {
        skippedWorktreeCount += 1;
        continue;
      }

      if (!dryRun) {
        await rm(worktreePath, { force: true, recursive: true });
      }
      removedWorktreeCount += 1;
    } catch (error) {
      failures.push(repoSyncCleanupFailure(worktreePath, "worktree_cleanup_failed", error));
    }
  }

  const prunedMirrorCount =
    dryRun || removedWorktreeCount === 0
      ? 0
      : await pruneRepoSyncMirrors({
          failures,
          gitRunner: dependencies.gitRunner ?? runGit,
          mirrorsRoot: layout.mirrorsRoot,
          timeoutMs: input.config.defaultWorktreeTimeoutMs,
        });

  return {
    cutoff: cutoff.toISOString(),
    dryRun,
    expiredWorktreeCount,
    failures,
    prunedMirrorCount,
    removedWorktreeCount: dryRun ? 0 : removedWorktreeCount,
    scannedWorktreeCount,
    skippedWorktreeCount,
  };
}

/** Input required to sync one repository workspace. */
export type SyncRepositoryWorkspaceInput = GitHubRepositoryRef & {
  /** Heimdall repository ID used for product-safe span correlation. */
  readonly repoId?: string;
  /** Commit SHA that must be checked out. */
  readonly commitSha: string;
  /** Parent directory used for temporary workspaces. */
  readonly workspaceRoot?: string;
  /** Keeps the workspace on disk after sync when true. */
  readonly keepWorkspace?: boolean;
};

/** Dependencies used by repository workspace sync. */
export type SyncRepositoryWorkspaceDependencies = {
  /** Optional clone host allowlist for repository sync. */
  readonly allowedGitHosts?: readonly string[];
  /** Provider that supplies clone credentials. */
  readonly gitProvider: Pick<GitProvider, "getCloneAuth">;
  /** Optional Git command runner for tests. */
  readonly gitRunner?: GitCommandRunner;
  /** Optional metric recorder for aggregate repo-sync telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional trace context propagated from the durable indexing job. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe repo-sync spans. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Options used when removing a retained repository workspace. */
export type CleanupRepositoryWorkspaceOptions = {
  /** Optional root that must contain the workspace path. */
  readonly workspaceRoot?: string;
};

/** Options used when validating a Git clone URL allowlist. */
export type AssertAllowedGitUrlOptions = {
  /** Additional or replacement hostnames that may be cloned from. */
  readonly allowedHosts?: readonly string[];
  /** Allows plain HTTP clone URLs when explicitly enabled. */
  readonly allowHttp?: boolean;
  /** Allows SSH clone URLs when explicitly enabled. */
  readonly allowSsh?: boolean;
};

/** Input accepted by repo-sync cache path builders. */
export type RepoSyncCachePathInput = Pick<RepoSyncConfig, "cacheRoot"> | string;

/** Cache mutation operation protected by a repo-sync filesystem lock. */
export type RepoSyncLockOperation = "cleanup" | "fetch" | "mirror" | "worktree";

/** Input required to acquire a bounded repo-sync filesystem lock. */
export type RepoSyncLockInput = {
  /** Runtime repo-sync configuration. */
  readonly config: RepoSyncConfig;
  /** Cache mutation operation protected by the lock. */
  readonly operation: RepoSyncLockOperation;
  /** Stable product repository ID used in the lock key. */
  readonly repoId: string;
  /** Maximum time to wait for the lock before failing. */
  readonly timeoutMs?: number;
  /** Delay between lock-acquire attempts. */
  readonly retryDelayMs?: number;
};

/** Result returned after a repository workspace sync finishes. */
export type SyncRepositoryWorkspaceResult = {
  /** Temporary workspace path used for the checkout. */
  readonly workspacePath: string;
  /** Commit SHA verified with `git rev-parse HEAD`. */
  readonly checkedOutSha: string;
  /** Whether the temporary workspace was removed before returning. */
  readonly cleanedUp: boolean;
};

type RepoSyncTelemetryStatus = "failed" | "succeeded";

type RepoSyncTelemetryState = {
  /** Low-cardinality labels shared by repo-sync operation metrics. */
  readonly labels: Readonly<{
    readonly operation: "checkout_workspace";
    readonly provider: "github";
  }>;
  /** Monotonic start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Product-safe span for the workspace checkout. */
  readonly span: TelemetrySpanHandle | undefined;
};

/** Fetches a GitHub repository, checks out an exact commit, and cleans up the workspace. */
export async function syncRepositoryWorkspace(
  input: SyncRepositoryWorkspaceInput,
  dependencies: SyncRepositoryWorkspaceDependencies,
): Promise<SyncRepositoryWorkspaceResult> {
  assertFullCommitSha(input.commitSha);
  const telemetry = startRepoSyncTelemetry(input, dependencies);
  const workspaceRoot = resolve(input.workspaceRoot ?? tmpdir());
  const workspacePath = await mkdtemp(join(workspaceRoot, managedWorkspacePrefix));
  const git = dependencies.gitRunner ?? runGit;
  let cleanedUp = false;
  let askPassPath: string | undefined;

  try {
    const cloneAuth = await dependencies.gitProvider.getCloneAuth(input);
    const cloneUrl = sanitizeGitUrl(cloneAuth.cloneUrl);
    assertAllowedGitUrl(cloneUrl, {
      ...(dependencies.allowedGitHosts ? { allowedHosts: dependencies.allowedGitHosts } : {}),
    });

    await git(["init"], { cwd: workspacePath });
    await git(["remote", "add", "origin", cloneUrl], { cwd: workspacePath });
    askPassPath = await createGitAskPassScript(workspacePath);
    await git(["fetch", "--depth=1", "--no-tags", "origin", input.commitSha], {
      cwd: workspacePath,
      env: gitAskPassEnvironment(cloneAuth, askPassPath),
      redact: [cloneAuth.password],
    });
    await removeGitAskPassScript(askPassPath);
    askPassPath = undefined;
    await git(["checkout", "--detach", input.commitSha], { cwd: workspacePath });

    const checkedOutSha = (await git(["rev-parse", "HEAD"], { cwd: workspacePath })).trim();
    if (checkedOutSha !== input.commitSha) {
      throw new Error(
        `Repository checkout resolved ${checkedOutSha} instead of ${input.commitSha}.`,
      );
    }

    if (!input.keepWorkspace) {
      await cleanupRepositoryWorkspace(workspacePath, { workspaceRoot });
      cleanedUp = true;
    }

    const result = {
      workspacePath,
      checkedOutSha,
      cleanedUp,
    };
    finishRepoSyncTelemetry(dependencies.metrics, telemetry, {
      cleanedUp,
      status: "succeeded",
    });
    return result;
  } catch (error) {
    if (askPassPath) {
      await removeGitAskPassScript(askPassPath);
    }
    if (!cleanedUp) {
      await cleanupRepositoryWorkspace(workspacePath, { workspaceRoot });
    }
    finishRepoSyncTelemetry(dependencies.metrics, telemetry, {
      cleanedUp: true,
      error,
      status: "failed",
    });
    throw error;
  }
}

/** Starts product-safe repo-sync telemetry and returns shared metric labels. */
function startRepoSyncTelemetry(
  input: SyncRepositoryWorkspaceInput,
  dependencies: SyncRepositoryWorkspaceDependencies,
): RepoSyncTelemetryState {
  const labels = { operation: "checkout_workspace", provider: "github" } as const;
  const span = dependencies.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.repoSyncCheckoutWorkspace, {
    attributes: {
      ...(input.repoId ? { "app.repo_id": input.repoId } : {}),
      "repo_sync.keep_workspace": Boolean(input.keepWorkspace),
      "repo_sync.operation": labels.operation,
      "repo_sync.provider": labels.provider,
    },
    kind: "client",
    ...(dependencies.traceContext ? { traceContext: dependencies.traceContext } : {}),
  });

  return {
    labels,
    span,
    startedAtMs: Date.now(),
  };
}

/** Ends a repo-sync span and emits aggregate operation metrics. */
function finishRepoSyncTelemetry(
  metrics: TelemetryMetricRecorder | undefined,
  telemetry: RepoSyncTelemetryState,
  input: {
    /** Whether the workspace was cleaned up before return or failure. */
    readonly cleanedUp: boolean;
    /** Error raised while syncing, when the operation failed. */
    readonly error?: unknown;
    /** Final repo-sync operation status. */
    readonly status: RepoSyncTelemetryStatus;
  },
): void {
  const durationMs = Date.now() - telemetry.startedAtMs;
  const labels = {
    ...telemetry.labels,
    ...(input.error === undefined ? {} : { error_class: classifyTelemetryError(input.error) }),
    status: input.status,
  };

  metrics?.count(OBSERVABILITY_METRIC_NAMES.repoSyncOperationsTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.repoSyncDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });

  telemetry.span?.end({
    ...(input.error === undefined ? {} : { error: input.error }),
    attributes: {
      "repo_sync.cleaned_up": input.cleanedUp,
      "repo_sync.duration_ms": Math.max(0, durationMs),
      ...(input.error === undefined
        ? {}
        : { "repo_sync.error_class": classifyTelemetryError(input.error) }),
      "repo_sync.status": input.status,
    },
    status: input.status === "succeeded" ? "ok" : "error",
  });
}

/** Removes a retained repository workspace. */
export async function cleanupRepositoryWorkspace(
  workspacePath: string,
  options: CleanupRepositoryWorkspaceOptions = {},
): Promise<void> {
  assertSafeRepositoryWorkspaceCleanupPath(workspacePath, options);
  await rm(workspacePath, { force: true, recursive: true });
}

/** Input for pruning mirror worktree metadata after cache cleanup. */
type PruneRepoSyncMirrorsInput = {
  /** Mutable failure list shared with the parent cleanup pass. */
  readonly failures: RepoSyncCleanupFailure[];
  /** Git runner used to prune mirror metadata. */
  readonly gitRunner: GitCommandRunner;
  /** Directory containing bare repository mirrors. */
  readonly mirrorsRoot: string;
  /** Timeout applied to each prune command. */
  readonly timeoutMs: number;
};

/** Prunes stale worktree metadata from every cached mirror. */
async function pruneRepoSyncMirrors(input: PruneRepoSyncMirrorsInput): Promise<number> {
  let prunedMirrorCount = 0;
  const mirrorEntries = await readRepoSyncDirectoryEntries(input.mirrorsRoot);
  for (const entry of mirrorEntries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".git")) {
      continue;
    }

    const mirrorPath = join(input.mirrorsRoot, entry.name);
    try {
      assertInsideRoot(input.mirrorsRoot, mirrorPath);
      await input.gitRunner(buildWorktreePruneArgs({ mirrorPath }), {
        timeoutMs: input.timeoutMs,
      });
      prunedMirrorCount += 1;
    } catch (error) {
      input.failures.push(repoSyncCleanupFailure(mirrorPath, "mirror_prune_failed", error));
    }
  }

  return prunedMirrorCount;
}

/** Reads directory entries and treats missing repo-sync cache roots as empty. */
async function readRepoSyncDirectoryEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

/** Returns true when a filesystem entry name looks like a repo-sync lease worktree. */
function isRepoSyncLeaseWorktreeName(name: string): boolean {
  return name.startsWith("lease_") && safeCachePathSegmentPattern.test(name);
}

/** Normalizes the maximum expired worktrees removed in one cleanup pass. */
function normalizeRepoSyncCleanupLimit(input: number | undefined): number {
  if (input === undefined) {
    return defaultRepoSyncCleanupLimit;
  }
  if (!Number.isInteger(input) || input < 1 || input > 10_000) {
    throw new Error("Repo sync cleanup limit must be an integer between 1 and 10000.");
  }

  return input;
}

/** Normalizes the maximum time spent waiting for a repo-sync lock. */
function normalizeRepoSyncLockTimeout(input: number | undefined): number {
  if (input === undefined) {
    return defaultGitCommandTimeoutMs;
  }
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new Error("Repo sync lock timeout must be a non-negative integer.");
  }

  return input;
}

/** Normalizes the delay between repo-sync lock acquisition attempts. */
function normalizeRepoSyncLockRetryDelay(input: number | undefined): number {
  if (input === undefined) {
    return defaultRepoSyncLockRetryDelayMs;
  }
  if (!Number.isSafeInteger(input) || input < 1) {
    throw new Error("Repo sync lock retry delay must be a positive integer.");
  }

  return input;
}

/** Builds a product-safe cleanup failure record. */
function repoSyncCleanupFailure(
  path: string,
  reason: string,
  error: unknown,
): RepoSyncCleanupFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    path,
    reason,
  };
}

/** Returns true when an error represents a missing filesystem path. */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/** Returns true when an error represents an existing filesystem path. */
function isPathExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

/** Validates that a cleanup target looks like a repo-sync managed workspace. */
export function assertSafeRepositoryWorkspaceCleanupPath(
  workspacePath: string,
  options: CleanupRepositoryWorkspaceOptions = {},
): void {
  if (!isAbsolute(workspacePath)) {
    throw new Error("Refusing to clean up a relative repository workspace path.");
  }

  const resolvedWorkspacePath = resolve(workspacePath);
  const workspaceDirectoryName = basename(resolvedWorkspacePath);
  if (
    !workspaceDirectoryName.startsWith(managedWorkspacePrefix) ||
    workspaceDirectoryName.length <= managedWorkspacePrefix.length
  ) {
    throw new Error("Refusing to clean up an unmanaged repository workspace path.");
  }

  if (
    options.workspaceRoot &&
    !isPathInsideRoot(resolve(options.workspaceRoot), resolvedWorkspacePath)
  ) {
    throw new Error("Refusing to clean up a repository workspace outside the configured root.");
  }
}

/** Returns true when a path is contained by a configured root directory. */
function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** Creates an HTTPS clone URL containing short-lived credentials for Git. */
export function createAuthenticatedCloneUrl(input: {
  /** Sanitized HTTPS clone URL. */
  readonly cloneUrl: string;
  /** Clone credential username. */
  readonly username: string;
  /** Clone credential password or token. */
  readonly password: string;
}): string {
  const url = new URL(input.cloneUrl);
  url.username = input.username;
  url.password = input.password;
  return url.toString();
}

/** Throws unless the input is a lowercase full-length Git commit SHA. */
export function assertFullCommitSha(input: string): void {
  if (!fullCommitShaPattern.test(input)) {
    throw new Error("Repository sync requires a lowercase 40-character commit SHA.");
  }
}

/** Builds argv for a bare clone into a repository mirror path. */
export function buildBareCloneArgs(input: BuildBareCloneArgsInput): readonly string[] {
  assertSafeGitCommandArgument("cloneUrl", sanitizeGitUrl(input.cloneUrl));
  assertSafeGitCommandArgument("mirrorPath", input.mirrorPath);

  return [
    "clone",
    "--bare",
    ...((input.enablePartialClone ?? true) ? ["--filter=blob:none"] : []),
    input.fetchTags ? "--tags" : "--no-tags",
    sanitizeGitUrl(input.cloneUrl),
    input.mirrorPath,
  ];
}

/** Builds argv for fetching one ref or refspec into a mirror. */
export function buildFetchRefArgs(input: BuildFetchRefArgsInput): readonly string[] {
  assertSafeGitCommandArgument("mirrorPath", input.mirrorPath);
  assertSafeGitCommandArgument("remote", input.remote ?? "origin");
  assertSafeGitCommandArgument("ref", input.ref);

  return [
    "-C",
    input.mirrorPath,
    "fetch",
    input.fetchTags ? "--tags" : "--no-tags",
    input.remote ?? "origin",
    input.ref,
  ];
}

/** Builds argv for checking whether a commit exists in a mirror. */
export function buildCommitExistsArgs(input: BuildCommitExistsArgsInput): readonly string[] {
  assertFullCommitSha(input.commitSha);
  assertSafeGitCommandArgument("mirrorPath", input.mirrorPath);

  return ["-C", input.mirrorPath, "cat-file", "-e", `${input.commitSha}^{commit}`];
}

/** Builds argv for creating a detached worktree from a mirror. */
export function buildWorktreeAddArgs(input: BuildWorktreeAddArgsInput): readonly string[] {
  assertFullCommitSha(input.commitSha);
  assertSafeGitCommandArgument("mirrorPath", input.mirrorPath);
  assertSafeGitCommandArgument("workspacePath", input.workspacePath);

  return [
    "-C",
    input.mirrorPath,
    "worktree",
    "add",
    "--detach",
    input.workspacePath,
    input.commitSha,
  ];
}

/** Builds argv for reading the checked-out commit from a workspace. */
export function buildWorkspaceHeadArgs(input: BuildWorkspaceHeadArgsInput): readonly string[] {
  assertSafeGitCommandArgument("workspacePath", input.workspacePath);

  return ["-C", input.workspacePath, "rev-parse", "HEAD"];
}

/** Builds argv for removing a worktree from a mirror. */
export function buildWorktreeRemoveArgs(input: BuildWorktreePathArgsInput): readonly string[] {
  assertSafeGitCommandArgument("mirrorPath", input.mirrorPath);
  assertSafeGitCommandArgument("workspacePath", input.workspacePath);

  return ["-C", input.mirrorPath, "worktree", "remove", "--force", input.workspacePath];
}

/** Builds argv for pruning stale worktree metadata from a mirror. */
export function buildWorktreePruneArgs(input: BuildMirrorWorktreeArgsInput): readonly string[] {
  assertSafeGitCommandArgument("mirrorPath", input.mirrorPath);

  return ["-C", input.mirrorPath, "worktree", "prune"];
}

/** Creates a Git command runner with timeout and redacted failure handling. */
export function createGitRunner(options: CreateGitRunnerOptions = {}): GitCommandRunner {
  const gitBinaryPath = options.gitBinaryPath ?? "git";
  const defaultTimeoutMs = options.defaultTimeoutMs ?? defaultGitCommandTimeoutMs;
  const maxBufferBytes = options.maxBufferBytes ?? defaultGitOutputBufferBytes;

  return async (args, commandOptions) => {
    const timeoutMs = commandOptions.timeoutMs ?? defaultTimeoutMs;
    try {
      const { stdout } = await execFileAsync(gitBinaryPath, [...args], {
        cwd: commandOptions.cwd,
        env: createGitProcessEnvironment(commandOptions.env),
        maxBuffer: maxBufferBytes,
        timeout: timeoutMs,
      });
      return stdout;
    } catch (error) {
      throw createGitCommandError({
        args,
        commandOptions,
        error,
        gitBinaryPath,
        maxOutputBytes: maxBufferBytes,
        timeoutMs,
      });
    }
  };
}

/** Returns a clone URL with credentials, query strings, and fragments removed. */
export function sanitizeGitUrl(input: string): string {
  const url = new URL(input);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Returns a stable SHA-256 hash for a sanitized Git clone URL. */
export function hashGitUrl(input: string): string {
  return createHash("sha256").update(sanitizeGitUrl(input)).digest("hex");
}

/** Throws when a Git clone URL uses an unsupported scheme or host. */
export function assertAllowedGitUrl(input: string, options: AssertAllowedGitUrlOptions = {}): void {
  const url = new URL(input);
  const protocol = url.protocol.toLowerCase();
  const allowedProtocols = new Set(["https:"]);
  if (options.allowHttp) {
    allowedProtocols.add("http:");
  }
  if (options.allowSsh) {
    allowedProtocols.add("ssh:");
  }

  if (!allowedProtocols.has(protocol)) {
    throw new Error(`Git URL scheme "${protocol.replace(/:$/u, "")}" is not allowed.`);
  }

  if (!url.hostname || url.pathname === "/" || url.pathname.length === 0) {
    throw new Error("Git URL must include a host and repository path.");
  }

  const host = normalizeGitHost(url.hostname);
  const allowedHosts = options.allowedHosts ?? defaultAllowedGitHosts;
  const normalizedAllowedHosts = new Set(allowedHosts.map(normalizeGitHost));
  if (!normalizedAllowedHosts.has(host)) {
    throw new Error(`Git URL host "${host}" is not allowed.`);
  }
}

/** Redacts exact secrets and common provider token formats from text. */
export function redactSecrets(input: string, secrets: readonly string[] = []): string {
  let output = input;
  const uniqueSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );

  for (const secret of uniqueSecrets) {
    output = output.split(secret).join(redactedSecret);
  }

  return output
    .replace(githubTokenPattern, redactedSecret)
    .replace(githubPatPattern, redactedSecret)
    .replace(bearerTokenPattern, `Bearer ${redactedSecret}`)
    .replace(authorizationHeaderPattern, `Authorization: ${redactedSecret}`)
    .replace(xAccessTokenPattern, `$1${redactedSecret}`);
}

/** Returns a product-safe display form for a potentially credentialed Git remote URL. */
export function redactGitRemoteUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.password) {
      url.password = "***";
    }

    return url.toString();
  } catch {
    return input.replace(/(https?:\/\/[^:\s/]+:)[^@\s/]+(@)/giu, "$1***$2");
  }
}

/** Normalizes a repository-relative path and rejects traversal or absolute paths. */
export function normalizeRepoPath(input: string): RepoPath {
  if (input.length === 0) {
    throw new Error("Repository path must not be empty.");
  }
  if (input.includes("\0")) {
    throw new Error("Repository path must not contain null bytes.");
  }
  if (windowsDrivePathPattern.test(input)) {
    throw new Error("Repository path must not use a Windows drive prefix.");
  }

  const normalizedSeparators = input.replaceAll("\\", "/");
  if (windowsDrivePathPattern.test(normalizedSeparators)) {
    throw new Error("Repository path must not use a Windows drive prefix.");
  }
  if (normalizedSeparators.startsWith("/")) {
    throw new Error("Repository path must be relative.");
  }
  if (normalizedSeparators.split("/").some((segment) => segment === "..")) {
    throw new Error("Repository path must not contain traversal segments.");
  }

  const normalizedPath = posix.normalize(normalizedSeparators);
  if (normalizedPath === "." || normalizedPath.length === 0) {
    throw new Error("Repository path must not be empty.");
  }
  if (
    normalizedPath.startsWith("../") ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("/")
  ) {
    throw new Error("Repository path must stay inside the repository root.");
  }

  return normalizedPath as RepoPath;
}

/** Returns a path under root after validating a repository-relative path. */
export function safeJoin(root: string, relativePath: string): string {
  const targetPath = resolve(root, normalizeRepoPath(relativePath));
  assertInsideRoot(root, targetPath);
  return targetPath;
}

/** Throws when targetPath does not resolve under root. */
export function assertInsideRoot(root: string, targetPath: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(targetPath);
  const relativePath = relative(resolvedRoot, resolvedTarget);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Path resolves outside the configured root.");
  }
}

/** Normalizes a Git hostname for allowlist comparisons. */
function normalizeGitHost(host: string): string {
  return host.toLowerCase().replace(/\.$/u, "");
}

/** Normalizes and validates a repo-sync cache root. */
function normalizeRepoSyncCacheRoot(input: string): string {
  if (input.trim().length === 0) {
    throw new Error("Repo sync cache root must not be empty.");
  }

  const cacheRoot = resolve(input);
  if (parse(cacheRoot).root === cacheRoot) {
    throw new Error("Repo sync cache root must not be a filesystem root.");
  }

  return cacheRoot;
}

/** Normalizes allowed Git host entries. */
function normalizeAllowedGitHosts(input: readonly string[]): readonly string[] {
  const hosts = [...new Set(input.map((host) => normalizeGitHost(host.trim())).filter(Boolean))];
  if (hosts.length === 0) {
    throw new Error("Repo sync allowed Git hosts must not be empty.");
  }

  return hosts;
}

/** Returns the cache root from a path-builder input. */
function cacheRootFromPathInput(input: RepoSyncCachePathInput): string {
  return typeof input === "string" ? input : input.cacheRoot;
}

/** Validates one path segment used in cache paths. */
function safeCachePathSegment(label: string, value: string): string {
  if (!safeCachePathSegmentPattern.test(value)) {
    throw new Error(`${label} must be a safe cache path segment.`);
  }

  return value;
}

/** Validates one Git argv value before command construction. */
function assertSafeGitCommandArgument(label: string, value: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty Git command argument.`);
  }
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with a dash.`);
  }
}

/** Returns true when a filesystem path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Returns true when a full commit SHA exists in a mirror. */
async function repositoryCommitExists(
  git: GitCommandRunner,
  mirrorPath: string,
  commitSha: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await git(buildCommitExistsArgs({ commitSha, mirrorPath }), { timeoutMs });
    return true;
  } catch (error) {
    if (error instanceof RepoSyncGitCommandError && error.code === "GIT_COMMAND_FAILED") {
      return false;
    }
    throw error;
  }
}

/** Builds fetch args while preserving exact optional property semantics. */
function buildFetchArgs(input: {
  /** Fetches tags when true. */
  readonly fetchTags?: boolean | undefined;
  /** Bare mirror path. */
  readonly mirrorPath: string;
  /** Ref or refspec to fetch. */
  readonly ref: string;
}): readonly string[] {
  return buildFetchRefArgs({
    ...(input.fetchTags === undefined ? {} : { fetchTags: input.fetchTags }),
    mirrorPath: input.mirrorPath,
    ref: input.ref,
  });
}

/** Git mirror command options derived from an optional repo credential. */
type MirrorGitCommandOptions = {
  /** Private askpass directory that must be removed after the clone attempt. */
  readonly askPassRoot?: string | undefined;
  /** Environment overrides supplied to the Git command. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Secrets that must be redacted from command failures. */
  readonly redact?: readonly string[] | undefined;
};

/** Creates askpass options for an authenticated mirror Git command. */
async function createMirrorGitCommandOptions(
  input: Pick<EnsureRepositoryMirrorInput, "credential">,
  tmpRoot: string,
): Promise<MirrorGitCommandOptions> {
  if (!input.credential) {
    return {};
  }

  if (input.credential.kind !== "https-basic-token") {
    throw new Error(
      `Git credential kind "${input.credential.kind}" is not supported for mirror clones.`,
    );
  }

  const askPassRoot = await mkdtemp(join(tmpRoot, "askpass_"));
  const askPassPath = await createGitAskPassScript(askPassRoot);

  return {
    askPassRoot,
    env: gitBasicCredentialAskPassEnvironment(input.credential, askPassPath),
    redact: [input.credential.token],
  };
}

/** Returns an optional string config property when an environment value is present. */
function optionalString(key: keyof CreateRepoSyncConfigInput, value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return {};
  }

  return { [key]: value.trim() } as CreateRepoSyncConfigInput;
}

/** Returns an optional string-list config property from a comma-separated environment value. */
function optionalStringList(key: keyof CreateRepoSyncConfigInput, value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return {};
  }

  return {
    [key]: value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  } as CreateRepoSyncConfigInput;
}

/** Returns an optional positive integer config property when an environment value is present. */
function optionalInteger(key: keyof CreateRepoSyncConfigInput, value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return {};
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${String(key)} must be a positive integer.`);
  }

  return { [key]: parsed } as CreateRepoSyncConfigInput;
}

/** Returns an optional boolean config property when an environment value is present. */
function optionalBoolean(key: keyof CreateRepoSyncConfigInput, value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return {};
  }

  if (value === "true") {
    return { [key]: true } as CreateRepoSyncConfigInput;
  }
  if (value === "false") {
    return { [key]: false } as CreateRepoSyncConfigInput;
  }

  throw new Error(`${String(key)} must be true or false.`);
}

/** Builds the narrow environment used for Git subprocesses. */
function createGitProcessEnvironment(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...overrides,
  };
}

/** Creates a product-safe Git command failure from a Node process error. */
function createGitCommandError(input: {
  /** Git command arguments. */
  readonly args: readonly string[];
  /** Git command options. */
  readonly commandOptions: GitCommandRunnerOptions;
  /** Original process error. */
  readonly error: unknown;
  /** Git binary path. */
  readonly gitBinaryPath: string;
  /** Maximum output bytes exposed on the error. */
  readonly maxOutputBytes: number;
  /** Command timeout in milliseconds. */
  readonly timeoutMs: number;
}): RepoSyncGitCommandError {
  const processError = extractProcessError(input.error);
  const redactions = input.commandOptions.redact ?? [];
  const command = redactSecrets([input.gitBinaryPath, ...input.args].join(" "), redactions);
  const stdout = captureOutput(processError.stdout, redactions, input.maxOutputBytes);
  const stderr = captureOutput(processError.stderr, redactions, input.maxOutputBytes);
  const timedOut = processError.killed === true && input.timeoutMs > 0;
  const code: RepoSyncGitCommandErrorCode = timedOut ? "GIT_TIMEOUT" : "GIT_COMMAND_FAILED";
  const message = timedOut
    ? `Git command timed out after ${input.timeoutMs}ms: ${command}`
    : `Git command failed: ${command}`;

  return new RepoSyncGitCommandError({
    cause: input.error,
    code,
    command,
    exitCode: processError.exitCode,
    message,
    signal: processError.signal,
    stderr,
    stdout,
    timeoutMs: input.timeoutMs,
  });
}

/** Process error details returned by child_process helpers. */
type ProcessErrorDetails = {
  /** Process exit code when available. */
  readonly exitCode?: number | undefined;
  /** True when Node killed the process. */
  readonly killed?: boolean | undefined;
  /** Process signal when available. */
  readonly signal?: string | undefined;
  /** Raw stderr captured from the process. */
  readonly stderr?: unknown;
  /** Raw stdout captured from the process. */
  readonly stdout?: unknown;
};

/** Extracts typed process details from an unknown Node execFile error. */
function extractProcessError(error: unknown): ProcessErrorDetails {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.code === "number" ? { exitCode: record.code } : {}),
    ...(typeof record.killed === "boolean" ? { killed: record.killed } : {}),
    ...(typeof record.signal === "string" ? { signal: record.signal } : {}),
    stderr: record.stderr,
    stdout: record.stdout,
  };
}

/** Captures and redacts a command output value with a byte limit. */
function captureOutput(
  value: unknown,
  redactions: readonly string[],
  maxOutputBytes: number,
): CapturedGitOutput {
  const text = redactSecrets(outputValueToString(value), redactions);
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxOutputBytes) {
    return {
      originalBytes: buffer.byteLength,
      text,
      truncated: false,
    };
  }

  return {
    originalBytes: buffer.byteLength,
    text: buffer.subarray(0, maxOutputBytes).toString("utf8"),
    truncated: true,
  };
}

/** Converts a Node command output value to text. */
function outputValueToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

/** Creates a temporary Git askpass helper that reads credentials from process environment. */
async function createGitAskPassScript(workspacePath: string): Promise<string> {
  const askPassPath = join(workspacePath, ".heimdall-git-askpass.sh");
  await writeFile(
    askPassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      '*Username*) printf "%s\\n" "$GIT_USERNAME" ;;',
      '*Password*) printf "%s\\n" "$GIT_PASSWORD" ;;',
      '*) printf "\\n" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(askPassPath, 0o700);
  return askPassPath;
}

/** Removes the temporary Git askpass helper after the authenticated fetch finishes. */
async function removeGitAskPassScript(askPassPath: string): Promise<void> {
  await rm(askPassPath, { force: true });
}

/** Builds environment overrides for a Git fetch that needs short-lived credentials. */
function gitAskPassEnvironment(
  cloneAuth: Awaited<ReturnType<GitProvider["getCloneAuth"]>>,
  askPassPath: string,
): Readonly<Record<string, string>> {
  return {
    GIT_ASKPASS: askPassPath,
    GIT_PASSWORD: cloneAuth.password,
    GIT_TERMINAL_PROMPT: "0",
    GIT_USERNAME: cloneAuth.username,
  };
}

/** Builds askpass environment overrides for a basic HTTPS Git credential. */
function gitBasicCredentialAskPassEnvironment(
  credential: Extract<GitCredential, { readonly kind: "https-basic-token" }>,
  askPassPath: string,
): Readonly<Record<string, string>> {
  return {
    GIT_ASKPASS: askPassPath,
    GIT_PASSWORD: credential.token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_USERNAME: credential.username,
  };
}

async function runGit(args: readonly string[], options: GitCommandRunnerOptions): Promise<string> {
  return createGitRunner()(args, options);
}
