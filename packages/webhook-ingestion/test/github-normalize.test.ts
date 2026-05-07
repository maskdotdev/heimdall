import { describe, expect, it } from "vitest";
import {
  normalizeGitHubFeedback,
  normalizeGitHubInstallation,
  normalizeGitHubPullRequest,
  normalizeGitHubRepositories,
} from "../src";
import {
  installationPayload,
  issueCommentPayload,
  pullRequestPayload,
  reactionPayload,
} from "./fixtures";

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

  it("normalizes pull request comments and reactions as feedback", () => {
    const comment = normalizeGitHubFeedback(issueCommentPayload, "issue_comment");
    const reaction = normalizeGitHubFeedback(reactionPayload, "reaction");

    expect(comment).toMatchObject({
      actorLogin: "maintainer",
      command: {
        commandKind: "mark_false_positive",
      },
      eventName: "issue_comment",
      feedbackKind: "comment_reply",
      pullRequestNumber: 7,
    });
    expect(comment?.bodyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(comment?.command?.commandHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reaction).toMatchObject({
      actorLogin: "maintainer",
      eventName: "reaction",
      externalCommentId: "888",
      feedbackKind: "negative_reaction",
      pullRequestNumber: 7,
    });
  });
});
