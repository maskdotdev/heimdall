import { validCandidateFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import {
  validChangedFileFixture,
  validDiffHunkFixture,
  validPullRequestSnapshotFixture,
} from "@repo/contracts/fixtures/pull-request.fixture";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { CandidateFinding } from "@repo/contracts/review/finding";
import { createStaticLLMGateway } from "@repo/llm-gateway";
import type { MemoryFact } from "@repo/memory";
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

  it("rejects findings that duplicate previously published comments", () => {
    const result = validateCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [
        candidateFindingFixture({
          findingId: "fnd_PREVIOUS",
          fingerprint: "fp_current_review_run",
        }),
      ],
      timestamp: validCandidateFindingFixture.createdAt,
      config: {
        previousPublishedFindings: [
          {
            body: validCandidateFindingFixture.body,
            fingerprint: "fp_previous_review_run",
            location: validCandidateFindingFixture.location,
            title: validCandidateFindingFixture.title,
          },
        ],
      },
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.validation.reasons).toContain("duplicate_previous_comment");
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateFindingId: "fnd_PREVIOUS",
          reasons: ["duplicate_previous_comment"],
          stage: "dedupe",
          status: "rejected",
        }),
      ]),
    );
  });

  it("preserves findings that do not match previous published comments", () => {
    const result = validateCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [
        candidateFindingFixture({
          findingId: "fnd_NEW",
          fingerprint: "fp_new_finding",
          title: "Handle a separate arithmetic overflow",
        }),
      ],
      timestamp: validCandidateFindingFixture.createdAt,
      config: {
        previousPublishedFindings: [
          {
            body: "The cache key can collide when user IDs are omitted.",
            fingerprint: "fp_previous_cache_finding",
            location: { ...validCandidateFindingFixture.location, line: 50 },
            title: "Include user ID in the cache key",
          },
        ],
      },
    });

    expect(result.accepted.map((finding) => finding.candidateFindingId)).toEqual(["fnd_NEW"]);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects findings suppressed by configured memory facts", () => {
    const memoryFact = memoryFactFixture({
      appliesTo: { findingFingerprints: [validCandidateFindingFixture.fingerprint] },
      id: "mem_suppress_exact",
      kind: "suppression",
      repoId: validPullRequestSnapshotFixture.repoId,
      scope: {
        level: "repo",
        orgId: "org_1",
        repoId: validPullRequestSnapshotFixture.repoId,
      },
    });

    const result = validateCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [validCandidateFindingFixture],
      timestamp: validCandidateFindingFixture.createdAt,
      config: {
        memorySuppression: {
          orgId: "org_1",
          repoId: validPullRequestSnapshotFixture.repoId,
          memoryFacts: [memoryFact],
        },
      },
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.validation.reasons).toContain("suppressed_by_memory");
    expect(result.rejected[0]?.metadata).toMatchObject({
      memorySuppression: {
        matchKind: "exact_fingerprint",
        memoryFactId: "mem_suppress_exact",
      },
    });
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateFindingId: validCandidateFindingFixture.findingId,
          reasons: ["suppressed_by_memory"],
          stage: "suppression",
          status: "rejected",
        }),
      ]),
    );
  });

  it("rejects core validator failures with canonical reasons", () => {
    const missingEvidence = candidateFindingFixture({
      evidence: [],
      findingId: "fnd_MISSING_EVIDENCE",
      fingerprint: "fp_missing_evidence",
    });
    const lowConfidence = candidateFindingFixture({
      confidence: 0.2,
      findingId: "fnd_LOW_CONFIDENCE",
      fingerprint: "fp_low_confidence",
      location: { ...validCandidateFindingFixture.location, line: 4 },
    });
    const disabledCategory = candidateFindingFixture({
      category: "documentation",
      findingId: "fnd_DISABLED_CATEGORY",
      fingerprint: "fp_disabled_category",
      location: { ...validCandidateFindingFixture.location, line: 5 },
    });
    const leftSideFinding = candidateFindingFixture({
      findingId: "fnd_LEFT_SIDE",
      fingerprint: "fp_left_side",
      location: { ...validCandidateFindingFixture.location, line: 6, side: "LEFT" },
    });

    const result = validateCandidateFindings({
      snapshot: snapshotWithAddedLines([2, 4, 5, 6]),
      findings: [missingEvidence, lowConfidence, disabledCategory, leftSideFinding],
      timestamp: validCandidateFindingFixture.createdAt,
      config: { enabledCategories: ["correctness"] },
    });

    expect(result.accepted).toHaveLength(0);
    expect(rejectionReasonsByCandidateId(result.rejected)).toMatchObject({
      fnd_DISABLED_CATEGORY: expect.arrayContaining(["category_disabled"]),
      fnd_LEFT_SIDE: expect.arrayContaining(["wrong_diff_side"]),
      fnd_LOW_CONFIDENCE: expect.arrayContaining(["low_confidence"]),
      fnd_MISSING_EVIDENCE: expect.arrayContaining(["missing_evidence"]),
    });
  });

  it("rejects generated, deleted, and binary files before publishing", () => {
    const generatedFinding = candidateFindingFixture({
      findingId: "fnd_GENERATED",
      fingerprint: "fp_generated",
      location: { ...validCandidateFindingFixture.location, path: "src/generated/client.ts" },
    });
    const deletedFinding = candidateFindingFixture({
      findingId: "fnd_DELETED",
      fingerprint: "fp_deleted",
      location: { ...validCandidateFindingFixture.location, path: "src/deleted.ts" },
    });
    const binaryFinding = candidateFindingFixture({
      findingId: "fnd_BINARY",
      fingerprint: "fp_binary",
      location: { ...validCandidateFindingFixture.location, path: "assets/logo.png" },
    });

    const result = validateCandidateFindings({
      snapshot: {
        ...validPullRequestSnapshotFixture,
        changedFiles: [
          {
            ...validChangedFileFixture,
            isGenerated: true,
            path: "src/generated/client.ts",
          },
          {
            ...validChangedFileFixture,
            additions: 0,
            path: "src/deleted.ts",
            status: "deleted",
          },
          {
            ...validChangedFileFixture,
            isBinary: true,
            path: "assets/logo.png",
          },
        ],
      },
      findings: [generatedFinding, deletedFinding, binaryFinding],
      timestamp: validCandidateFindingFixture.createdAt,
    });

    expect(result.accepted).toHaveLength(0);
    expect(rejectionReasonsByCandidateId(result.rejected)).toMatchObject({
      fnd_BINARY: expect.arrayContaining(["binary_file"]),
      fnd_DELETED: expect.arrayContaining(["file_deleted"]),
      fnd_GENERATED: expect.arrayContaining(["generated_file"]),
    });
  });

  it("rejects secret-like values in visible finding text", () => {
    const result = validateCandidateFindings({
      snapshot: validPullRequestSnapshotFixture,
      findings: [
        candidateFindingFixture({
          body: "The patch exposes token=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD in logs.",
          findingId: "fnd_SECRET",
          fingerprint: "fp_secret",
        }),
      ],
      timestamp: validCandidateFindingFixture.createdAt,
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.validation.reasons).toContain("contains_secret");
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateFindingId: "fnd_SECRET",
          reasons: ["contains_secret"],
          stage: "evidence",
          status: "rejected",
        }),
      ]),
    );
  });

  it("keeps ranking deterministic and enforces the publishable finding budget", () => {
    const findings = [
      candidateFindingFixture({
        body: "The changed arithmetic still needs a finite-value guard before returning.",
        confidence: 0.8,
        findingId: "fnd_MEDIUM",
        fingerprint: "fp_medium",
        location: { ...validCandidateFindingFixture.location, line: 2 },
        severity: "medium",
        title: "Guard arithmetic result",
      }),
      candidateFindingFixture({
        body: "The changed parser can throw for valid user input and should handle failures.",
        confidence: 0.7,
        findingId: "fnd_HIGH",
        fingerprint: "fp_high",
        location: { ...validCandidateFindingFixture.location, line: 4 },
        severity: "high",
        title: "Handle parser failures",
      }),
      candidateFindingFixture({
        body: "The changed authorization path can allow requests without checking the session.",
        category: "security",
        confidence: 0.95,
        findingId: "fnd_SECURITY",
        fingerprint: "fp_security",
        location: { ...validCandidateFindingFixture.location, line: 5 },
        severity: "medium",
        title: "Check session authorization",
      }),
    ];
    const input = {
      snapshot: snapshotWithAddedLines([2, 4, 5]),
      findings,
      timestamp: validCandidateFindingFixture.createdAt,
      config: { maxPublishableFindings: 2 },
    };

    const firstResult = validateCandidateFindings(input);
    const secondResult = validateCandidateFindings(input);

    expect(firstResult.accepted.map((finding) => finding.candidateFindingId)).toEqual([
      "fnd_HIGH",
      "fnd_SECURITY",
    ]);
    expect(secondResult.accepted.map((finding) => finding.candidateFindingId)).toEqual([
      "fnd_HIGH",
      "fnd_SECURITY",
    ]);
    expect(firstResult.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateFindingId: "fnd_MEDIUM",
          validation: expect.objectContaining({ reasons: ["budget_exceeded"] }),
        }),
      ]),
    );
  });
});

/** Creates a candidate finding with deterministic defaults for validation tests. */
function candidateFindingFixture(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    ...validCandidateFindingFixture,
    ...overrides,
  };
}

/** Creates a snapshot whose reviewable file has the requested added lines. */
function snapshotWithAddedLines(lines: readonly number[]): PullRequestSnapshot {
  return {
    ...validPullRequestSnapshotFixture,
    changedFiles: [
      {
        ...validChangedFileFixture,
        additions: lines.length,
        hunks: [
          {
            ...validDiffHunkFixture,
            lines: lines.map((line) => ({
              content: `  changed line ${line};`,
              kind: "addition",
              newLine: line,
            })),
            newLines: Math.max(...lines),
          },
        ],
      },
    ],
  };
}

/** Indexes rejected validation reasons by candidate finding ID. */
function rejectionReasonsByCandidateId(
  findings: readonly {
    readonly candidateFindingId: string;
    readonly validation: { readonly reasons: readonly string[] };
  }[],
): Record<string, readonly string[]> {
  return Object.fromEntries(
    findings.map((finding) => [finding.candidateFindingId, finding.validation.reasons]),
  );
}

function memoryFactFixture(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mem_1",
    orgId: "org_1",
    repoId: validPullRequestSnapshotFixture.repoId,
    kind: "suppression",
    content: "Suppress matching findings for this repository.",
    normalizedContent: "suppress matching findings for this repository.",
    scope: { level: "repo", orgId: "org_1", repoId: validPullRequestSnapshotFixture.repoId },
    appliesTo: {},
    sourceKind: "command",
    trustLevel: "explicit_maintainer",
    confidence: 0.95,
    status: "active",
    priority: 700,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  };
}
