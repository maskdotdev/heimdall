import { validCandidateFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { createStaticLLMGateway } from "@repo/llm-gateway";
import { describe, expect, it } from "vitest";
import { llmReviewPass, runReviewPasses, validateAndRankCandidateFindings } from "../src/index";

describe("llmReviewPass", () => {
  it("converts structured gateway output into candidate findings", async () => {
    const findings = await runReviewPasses({
      passes: [llmReviewPass],
      context: {
        reviewRunId: validCandidateFindingFixture.reviewRunId,
        snapshot: validPullRequestSnapshotFixture,
        timestamp: validCandidateFindingFixture.createdAt,
        llmGateway: createStaticLLMGateway({
          findings: [
            {
              path: "src/math.ts",
              line: 2,
              severity: "medium",
              category: "correctness",
              title: "Handle non-finite values",
              body: "The changed coercion accepts NaN and Infinity.",
              evidence: ["The added line calls Number() without a finite check."],
              confidence: 0.82,
            },
          ],
        }),
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "llm",
      sourceName: "llm-review",
      location: { path: "src/math.ts", line: 2, side: "RIGHT", isInDiff: true },
    });
  });
});

describe("validateAndRankCandidateFindings", () => {
  it("rejects unanchored duplicates and publishes ranked findings", () => {
    const duplicate = {
      ...validCandidateFindingFixture,
      findingId: "fnd_DUPLICATE",
    };
    const offDiff = {
      ...validCandidateFindingFixture,
      findingId: "fnd_OFFDIFF",
      fingerprint: "fp_off_diff",
      location: { ...validCandidateFindingFixture.location, line: 99 },
    };

    const findings = validateAndRankCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [validCandidateFindingFixture, duplicate, offDiff],
      timestamp: validCandidateFindingFixture.createdAt,
    });

    expect(findings.filter((finding) => finding.decision === "publish")).toHaveLength(1);
    const duplicateFinding = findings.find(
      (finding) => finding.candidateFindingId === "fnd_DUPLICATE",
    );
    const offDiffFinding = findings.find((finding) => finding.candidateFindingId === "fnd_OFFDIFF");

    expect(duplicateFinding?.decision).toBe("reject");
    expect(duplicateFinding?.validation.reasons).toContain("duplicate_exact");
    expect(offDiffFinding?.decision).toBe("reject");
    expect(offDiffFinding?.validation.reasons).toContain("line_not_in_diff");
  });
});
