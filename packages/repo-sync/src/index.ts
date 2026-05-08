import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
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
const managedWorkspacePrefix = "heimdall-repo-";

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
};

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
  const telemetry = startRepoSyncTelemetry(input, dependencies);
  const workspaceRoot = resolve(input.workspaceRoot ?? tmpdir());
  const workspacePath = await mkdtemp(join(workspaceRoot, managedWorkspacePrefix));
  const git = dependencies.gitRunner ?? runGit;
  let cleanedUp = false;
  let askPassPath: string | undefined;

  try {
    const cloneAuth = await dependencies.gitProvider.getCloneAuth(input);

    await git(["init"], { cwd: workspacePath });
    await git(["remote", "add", "origin", cloneAuth.cloneUrl], { cwd: workspacePath });
    askPassPath = await createGitAskPassScript(workspacePath);
    await git(["fetch", "--depth=1", "origin", input.commitSha], {
      cwd: workspacePath,
      env: gitAskPassEnvironment(cloneAuth, askPassPath),
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

async function runGit(args: readonly string[], options: GitCommandRunnerOptions): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout;
}
