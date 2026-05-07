import { describe, expect, it } from "vitest";
import { reconcileProviderPublisherArtifacts } from "../src";

describe("reconcileProviderPublisherArtifacts", () => {
  it("reports provider comments that are missing durable rows", () => {
    const issues = reconcileProviderPublisherArtifacts({
      reviewRunId: "rrn_1",
      findings: [{ findingId: "fnd_1" }],
      publishedFindings: [],
      summaryComments: [],
      providerArtifacts: {
        inlineCommentIdsByFindingId: { fnd_1: "comment_1" },
        summaryCommentIds: ["summary_1"],
      },
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "provider_inline_comment_untracked",
      "provider_summary_comment_untracked",
    ]);
    expect(issues.map((issue) => issue.rowId)).toEqual(["comment_1", "summary_1"]);
  });

  it("reports durable rows whose provider comments disappeared", () => {
    const issues = reconcileProviderPublisherArtifacts({
      reviewRunId: "rrn_1",
      findings: [{ findingId: "fnd_1" }],
      publishedFindings: [{ validatedFindingId: "fnd_1", providerCommentId: "comment_deleted" }],
      summaryComments: [{ providerCommentId: "summary_deleted" }],
      providerArtifacts: {
        inlineCommentIdsByFindingId: {},
        summaryCommentIds: [],
      },
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "provider_comment_missing",
      "provider_comment_missing",
    ]);
    expect(issues.map((issue) => issue.rowId)).toEqual(["comment_deleted", "summary_deleted"]);
  });
});
