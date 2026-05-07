import type { PullRequestSnapshot } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  assertSnapshotMatchesJob,
  checkReviewRunCurrent,
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

const currentCheckInput = {
  provider: "github",
  installationId: "inst_test",
  owner: "octo-org",
  repo: "heimdall-test",
  providerRepoId: "98765",
  pullRequestNumber: 7,
  expectedHeadSha: "2222222",
} as const;

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

describe("checkReviewRunCurrent", () => {
  it("returns current when the provider head still matches", async () => {
    await expect(
      checkReviewRunCurrent(providerReturningSnapshot(pullRequestSnapshot), currentCheckInput),
    ).resolves.toBe("current");
  });

  it("returns superseded when the provider head moved", async () => {
    await expect(
      checkReviewRunCurrent(
        providerReturningSnapshot({ ...pullRequestSnapshot, headSha: "3333333" }),
        currentCheckInput,
      ),
    ).resolves.toBe("superseded");
  });

  it("returns closed when the pull request is no longer open", async () => {
    await expect(
      checkReviewRunCurrent(
        providerReturningSnapshot({ ...pullRequestSnapshot, state: "closed" }),
        currentCheckInput,
      ),
    ).resolves.toBe("closed");
  });

  it("returns unknown when the provider state is unknown", async () => {
    await expect(
      checkReviewRunCurrent(
        providerReturningSnapshot({ ...pullRequestSnapshot, state: "unknown" }),
        currentCheckInput,
      ),
    ).resolves.toBe("unknown");
  });

  it("returns unknown when the provider check fails", async () => {
    await expect(
      checkReviewRunCurrent(
        {
          fetchPullRequestSnapshot: async () => {
            throw new Error("GitHub is unavailable.");
          },
        },
        currentCheckInput,
      ),
    ).resolves.toBe("unknown");
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

/** Creates the minimal provider surface needed for current-head checks. */
function providerReturningSnapshot(snapshot: PullRequestSnapshot): {
  readonly fetchPullRequestSnapshot: () => Promise<PullRequestSnapshot>;
} {
  return {
    fetchPullRequestSnapshot: async () => snapshot,
  };
}
