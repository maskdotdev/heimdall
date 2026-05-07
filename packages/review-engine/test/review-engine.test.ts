import { validCandidateFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import {
  validChangedFileFixture,
  validDiffHunkFixture,
  validPullRequestSnapshotFixture,
} from "@repo/contracts/fixtures/pull-request.fixture";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
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

  it("rejects semantic duplicates without requiring exact fingerprints or locations", () => {
    const snapshot = {
      ...validPullRequestSnapshotFixture,
      changedFiles: [
        {
          ...validChangedFileFixture,
          additions: 2,
          hunks: [
            {
              ...validDiffHunkFixture,
              lines: [
                ...validDiffHunkFixture.lines,
                {
                  kind: "addition",
                  content: "  return Number(a) + Number(b) + Number(c);",
                  newLine: 4,
                },
              ],
            },
          ],
        },
      ],
    } satisfies PullRequestSnapshot;
    const [baseEvidence] = validCandidateFindingFixture.evidence;
    if (!baseEvidence) {
      throw new Error("Expected candidate finding fixture evidence.");
    }
    const semanticDuplicate = {
      ...validCandidateFindingFixture,
      findingId: "fnd_SEMANTIC",
      fingerprint: "fp_math_add_non_finite_alternate",
      title: "Handle numeric inputs that are not finite",
      body: "The new coercion accepts NaN and Infinity and can propagate unexpected values to callers.",
      location: { ...validCandidateFindingFixture.location, line: 4 },
      evidence: [
        {
          ...baseEvidence,
          evidenceId: "ev_SEMANTIC",
          range: { startLine: 4, endLine: 4 },
        },
      ],
    };

    const result = validateCandidateFindings({
      snapshot,
      findings: [validCandidateFindingFixture, semanticDuplicate],
      timestamp: validCandidateFindingFixture.createdAt,
    });

    const rejected = result.rejected.find(
      (finding) => finding.candidateFindingId === "fnd_SEMANTIC",
    );
    expect(rejected?.validation.reasons).toContain("duplicate_semantic");
    expect(rejected?.validation.reasons).not.toContain("duplicate_exact");
    expect(rejected?.validation.reasons).not.toContain("duplicate_location");
    expect(result.duplicateGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalCandidateFindingId: validCandidateFindingFixture.findingId,
          duplicateCandidateFindingIds: ["fnd_SEMANTIC"],
          groupKind: "semantic",
        }),
      ]),
    );
  });
});
