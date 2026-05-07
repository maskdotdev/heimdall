import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHubRepositoryRef, GitProvider } from "@repo/github";

const execFileAsync = promisify(execFile);

/** Git command runner used by repo sync and tests. */
export type GitCommandRunner = (
  args: readonly string[],
  options: { readonly cwd?: string },
) => Promise<string>;

/** Input required to sync one repository workspace. */
export type SyncRepositoryWorkspaceInput = GitHubRepositoryRef & {
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

/** Fetches a GitHub repository, checks out an exact commit, and cleans up the workspace. */
export async function syncRepositoryWorkspace(
  input: SyncRepositoryWorkspaceInput,
  dependencies: SyncRepositoryWorkspaceDependencies,
): Promise<SyncRepositoryWorkspaceResult> {
  const workspacePath = await mkdtemp(join(input.workspaceRoot ?? tmpdir(), "heimdall-repo-"));
  const git = dependencies.gitRunner ?? runGit;
  let cleanedUp = false;

  try {
    const cloneAuth = await dependencies.gitProvider.getCloneAuth(input);
    const authenticatedUrl = createAuthenticatedCloneUrl({
      cloneUrl: cloneAuth.cloneUrl,
      username: cloneAuth.username,
      password: cloneAuth.password,
    });

    await git(["init"], { cwd: workspacePath });
    await git(["remote", "add", "origin", authenticatedUrl], { cwd: workspacePath });
    await git(["fetch", "--depth=1", "origin", input.commitSha], { cwd: workspacePath });
    await git(["checkout", "--detach", input.commitSha], { cwd: workspacePath });

    const checkedOutSha = (await git(["rev-parse", "HEAD"], { cwd: workspacePath })).trim();
    if (checkedOutSha !== input.commitSha) {
      throw new Error(
        `Repository checkout resolved ${checkedOutSha} instead of ${input.commitSha}.`,
      );
    }

    if (!input.keepWorkspace) {
      await rm(workspacePath, { force: true, recursive: true });
      cleanedUp = true;
    }

    return {
      workspacePath,
      checkedOutSha,
      cleanedUp,
    };
  } catch (error) {
    if (!cleanedUp) {
      await rm(workspacePath, { force: true, recursive: true });
    }
    throw error;
  }
}

/** Removes a retained repository workspace. */
export async function cleanupRepositoryWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { force: true, recursive: true });
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

async function runGit(
  args: readonly string[],
  options: { readonly cwd?: string },
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: options.cwd,
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout;
}
