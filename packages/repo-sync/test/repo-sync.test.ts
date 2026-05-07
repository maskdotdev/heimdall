import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRepositoryWorkspace,
  createAuthenticatedCloneUrl,
  type GitCommandRunner,
  syncRepositoryWorkspace,
} from "../src";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const workspaceRoots: string[] = [];

describe("repo sync workspace", () => {
  afterEach(async () => {
    for (const root of workspaceRoots.splice(0)) {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fetches an exact commit with GitHub clone auth and cleans up the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-test-"));
    workspaceRoots.push(workspaceRoot);
    const mutableCommands: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      mutableCommands.push([...args]);
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

    expect(result).toMatchObject({
      checkedOutSha: commitSha,
      cleanedUp: true,
    });
    expect(mutableCommands).toEqual([
      ["init"],
      ["remote", "add", "origin", "https://x-access-token:token-123@github.com/acme/api.git"],
      ["fetch", "--depth=1", "origin", commitSha],
      ["checkout", "--detach", commitSha],
      ["rev-parse", "HEAD"],
    ]);
    await expect(access(result.workspacePath)).rejects.toThrow();
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

  it("removes a retained workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "heimdall-repo-sync-cleanup-test-"));
    workspaceRoots.push(workspaceRoot);
    const workspacePath = await mkdtemp(join(workspaceRoot, "workspace-"));

    await cleanupRepositoryWorkspace(workspacePath);

    await expect(access(workspacePath)).rejects.toThrow();
  });
});
