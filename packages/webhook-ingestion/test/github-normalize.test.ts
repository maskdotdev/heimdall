import { describe, expect, it } from "vitest";
import {
  normalizeGitHubInstallation,
  normalizeGitHubPullRequest,
  normalizeGitHubRepositories,
} from "../src";
import { installationPayload, pullRequestPayload } from "./fixtures";

describe("GitHub webhook normalization", () => {
  it("normalizes installation and repository payloads", () => {
    const installation = normalizeGitHubInstallation(installationPayload);
    const [repository] = normalizeGitHubRepositories(installationPayload);

    expect(installation.installationId).toMatch(/^inst_/u);
    expect(installation.providerInstallationId).toBe("123456");
    expect(repository?.repository.repoId).toMatch(/^repo_/u);
    expect(repository?.repository.fullName).toBe("acme/heimdall");
    expect(repository?.settings.reviewPolicy).toBe("inline_comments_and_summary");
  });

  it("normalizes pull request snapshots", () => {
    const pullRequest = normalizeGitHubPullRequest(pullRequestPayload);

    expect(pullRequest.pullRequestId).toMatch(/^pr_/u);
    expect(pullRequest.snapshot.snapshotId).toMatch(/^prs_/u);
    expect(pullRequest.snapshot.pullRequestNumber).toBe(7);
    expect(pullRequest.snapshot.diffHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
