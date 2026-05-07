import type { PullRequestSnapshot } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  assertSnapshotMatchesJob,
  ReviewInputSnapshotMismatchError,
  type ReviewPullRequestInput,
  reviewRunStatusForStage,
} from "../src";

const reviewInput = {
  repoId: "repo_test",
  installationId: "inst_test",
  pullRequestNumber: 7,
  baseSha: "1111111",
  headSha: "2222222",
  trigger: "webhook",
} satisfies ReviewPullRequestInput;

const pullRequestSnapshot = {
  snapshotId: "prs_test",
  schemaVersion: "pull_request_snapshot.v1",
  provider: "github",
  repoId: "repo_test",
  installationId: "inst_test",
  providerRepoId: "98765",
  providerPullRequestId: "777",
  pullRequestNumber: 7,
  title: "Change app",
  authorLogin: "octocat",
  state: "open",
  isDraft: false,
  labels: [],
  baseRef: "main",
  baseSha: "1111111",
  headRef: "feature",
  headSha: "2222222",
  changedFiles: [],
  diffHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  additions: 0,
  deletions: 0,
  changedFileCount: 0,
  fetchedAt: "2026-04-28T12:00:00.000Z",
} satisfies PullRequestSnapshot;

describe("assertSnapshotMatchesJob", () => {
  it("accepts a fetched snapshot that matches the queued review job", () => {
    expect(() => assertSnapshotMatchesJob(reviewInput, pullRequestSnapshot)).not.toThrow();
  });

  it("rejects a stale fetched snapshot for a different head SHA", () => {
    expect(() =>
      assertSnapshotMatchesJob(reviewInput, {
        ...pullRequestSnapshot,
        headSha: "3333333",
      }),
    ).toThrow(ReviewInputSnapshotMismatchError);
  });
});

describe("reviewRunStatusForStage", () => {
  it("maps orchestration stages to durable review run statuses", () => {
    expect(reviewRunStatusForStage("index")).toBe("waiting_for_index");
    expect(reviewRunStatusForStage("retrieval")).toBe("retrieving_context");
    expect(reviewRunStatusForStage("review")).toBe("reviewing");
    expect(reviewRunStatusForStage("validation")).toBe("validating_findings");
    expect(reviewRunStatusForStage("publish")).toBe("publish_queued");
  });
});
