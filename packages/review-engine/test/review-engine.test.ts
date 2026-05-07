import { validCandidateFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import {
  validChangedFileFixture,
  validPullRequestSnapshotFixture,
} from "@repo/contracts/fixtures/pull-request.fixture";
import { createStaticLLMGateway } from "@repo/llm-gateway";
import { createPolicyFixture } from "@repo/rules";
import { describe, expect, it } from "vitest";
import {
  llmReviewPass,
  runReviewPasses,
  selectReviewPasses,
  validateAndRankCandidateFindings,
  validateCandidateFindings,
} from "../src/index";

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

describe("selectReviewPasses", () => {
  it("selects summary only for documentation-only changes", () => {
    expect(
      selectReviewPasses({
        snapshot: {
          ...validPullRequestSnapshotFixture,
          changedFiles: [
            {
              ...validChangedFileFixture,
              path: "README.md",
              isTest: false,
            },
          ],
        },
      }),
    ).toEqual(["pr_summary"]);
  });

  it("selects correctness and test coverage for source changes", () => {
    expect(selectReviewPasses({ snapshot: validPullRequestSnapshotFixture })).toEqual([
      "pr_summary",
      "behavior_change",
      "correctness",
      "test_coverage",
      "finding_judge",
    ]);
  });

  it("selects security for security-sensitive changes", () => {
    expect(
      selectReviewPasses({
        snapshot: {
          ...validPullRequestSnapshotFixture,
          changedFiles: [
            {
              ...validChangedFileFixture,
              path: "src/auth/session.ts",
              patch: "@@ -1,0 +1,1 @@\n+export const token = request.headers.authorization;",
            },
          ],
        },
      }),
    ).toContain("security");
  });

  it("honors review modes and pass budgets", () => {
    expect(selectReviewPasses({ mode: "off", snapshot: validPullRequestSnapshotFixture })).toEqual(
      [],
    );
    expect(
      selectReviewPasses({
        budgets: {
          maxCandidatesBeforeJudge: 20,
          maxCandidatesPerPass: 5,
          maxLlmCalls: 8,
          maxPasses: 2,
          maxWallClockMs: 120_000,
        },
        mode: "strict",
        snapshot: validPullRequestSnapshotFixture,
      }),
    ).toEqual(["pr_summary", "behavior_change"]);
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
    for (const finding of findings) {
      expect(finding.findingId).toMatch(/^fnd_[A-Za-z0-9_-]+$/u);
    }
    const duplicateFinding = findings.find(
      (finding) => finding.candidateFindingId === "fnd_DUPLICATE",
    );
    const offDiffFinding = findings.find((finding) => finding.candidateFindingId === "fnd_OFFDIFF");

    expect(duplicateFinding?.decision).toBe("reject");
    expect(duplicateFinding?.validation.reasons).toContain("duplicate_exact");
    expect(offDiffFinding?.decision).toBe("reject");
    expect(offDiffFinding?.validation.reasons).toContain("line_not_in_diff");
  });

  it("applies immutable policy snapshots during finding validation", () => {
    const findings = validateAndRankCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [validCandidateFindingFixture],
      timestamp: validCandidateFindingFixture.createdAt,
      config: {
        policy: createPolicyFixture({
          findings: { minimumConfidence: 0.9, severityThreshold: "high" },
        }),
      },
    });

    expect(findings[0]?.decision).toBe("reject");
    expect(findings[0]?.validation.reasons).toEqual(
      expect.arrayContaining(["low_confidence", "below_severity_threshold"]),
    );
  });

  it("returns an inspectable validation result with stats, duplicate groups, and trace events", () => {
    const duplicate = {
      ...validCandidateFindingFixture,
      findingId: "fnd_DUPLICATE",
    };
    const result = validateCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [validCandidateFindingFixture, duplicate],
      timestamp: validCandidateFindingFixture.createdAt,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.duplicateGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalCandidateFindingId: validCandidateFindingFixture.findingId,
          duplicateCandidateFindingIds: ["fnd_DUPLICATE"],
          groupKind: "exact",
        }),
      ]),
    );
    expect(result.stats).toMatchObject({
      acceptedCount: 1,
      candidateCount: 2,
      duplicateCount: 1,
      rejectedCount: 1,
    });
    expect(result.stats.rejectionReasonCounts.duplicate_exact).toBe(1);
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateFindingId: "fnd_DUPLICATE",
          reasons: expect.arrayContaining(["duplicate_exact"]),
          stage: "dedupe",
          status: "rejected",
        }),
      ]),
    );
  });
});
