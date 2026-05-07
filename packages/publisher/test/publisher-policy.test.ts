import type { ValidatedFinding } from "@repo/contracts";
import { validValidatedFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import { describe, expect, it } from "vitest";
import { createPublishPlan } from "../src";

describe("createPublishPlan", () => {
  it("uses legacy check-run and inline publishing when no policy snapshot exists", () => {
    const plan = createPublishPlan({
      reviewRun: {},
      findings: [findingFixture("fnd_one"), findingFixture("fnd_two")],
    });

    expect(plan.policy).toMatchObject({
      publishCheckRun: true,
      publishInlineComments: true,
      publishSummaryComment: false,
    });
    expect(plan.checkRunFindings).toHaveLength(2);
    expect(plan.inlineFindings).toHaveLength(2);
    expect(plan.configuredSummaryFindings).toHaveLength(0);
    expect(plan.plannedOperations).toEqual([
      { findingCount: 2, operationType: "check_run.upsert", status: "planned" },
      { findingCount: 2, operationType: "review.inline_comments", status: "planned" },
    ]);
  });

  it("routes summary-only policy to summary output without check-run or inline comments", () => {
    const plan = createPublishPlan({
      reviewRun: reviewRunWithPublishingPolicy({
        maxCommentsPerReview: 5,
        publishCheckRun: false,
        publishInlineComments: false,
        publishSummaryComment: true,
      }),
      findings: [findingFixture("fnd_one")],
    });

    expect(plan.checkRunFindings).toHaveLength(0);
    expect(plan.inlineFindings).toHaveLength(0);
    expect(plan.configuredSummaryFindings).toHaveLength(1);
    expect(plan.plannedOperations).toEqual([
      { findingCount: 1, operationType: "summary_comment.configured", status: "planned" },
    ]);
  });

  it("routes check-run-only policy to annotations and applies the comment budget", () => {
    const plan = createPublishPlan({
      reviewRun: reviewRunWithPublishingPolicy({
        maxCommentsPerReview: 1,
        publishCheckRun: true,
        publishInlineComments: false,
        publishSummaryComment: false,
      }),
      findings: [findingFixture("fnd_one"), findingFixture("fnd_two")],
    });

    expect(plan.findings.map((finding) => finding.findingId)).toEqual(["fnd_one"]);
    expect(plan.checkRunFindings).toHaveLength(1);
    expect(plan.inlineFindings).toHaveLength(0);
    expect(plan.configuredSummaryFindings).toHaveLength(0);
  });

  it("excludes non-diff findings from inline comments while keeping them in summaries", () => {
    const plan = createPublishPlan({
      reviewRun: reviewRunWithPublishingPolicy({
        maxCommentsPerReview: 5,
        publishCheckRun: false,
        publishInlineComments: true,
        publishSummaryComment: true,
      }),
      findings: [
        findingFixture("fnd_inline"),
        findingFixture("fnd_summary", { location: { isInDiff: false } }),
      ],
    });

    expect(plan.inlineFindings.map((finding) => finding.findingId)).toEqual(["fnd_inline"]);
    expect(plan.configuredSummaryFindings.map((finding) => finding.findingId)).toEqual([
      "fnd_inline",
      "fnd_summary",
    ]);
  });

  it("marks inline publishing as skipped when no findings can be anchored inline", () => {
    const plan = createPublishPlan({
      reviewRun: reviewRunWithPublishingPolicy({
        maxCommentsPerReview: 5,
        publishCheckRun: false,
        publishInlineComments: true,
        publishSummaryComment: false,
      }),
      findings: [findingFixture("fnd_summary", { location: { isInDiff: false } })],
    });

    expect(plan.inlineFindings).toHaveLength(0);
    expect(plan.plannedOperations).toEqual([
      {
        findingCount: 0,
        operationType: "review.inline_comments",
        reason: "no_inline_findings",
        status: "skipped",
      },
    ]);
  });
});

/** Creates a minimal review-run object with publishing policy metadata. */
function reviewRunWithPublishingPolicy(policy: {
  readonly maxCommentsPerReview: number;
  readonly publishCheckRun: boolean;
  readonly publishInlineComments: boolean;
  readonly publishSummaryComment: boolean;
}) {
  return { metadata: { policySnapshot: { publishing: policy } } };
}

/** Creates a validated finding fixture with a unique ID. */
function findingFixture(
  findingId: string,
  overrides: {
    readonly location?: Partial<ValidatedFinding["location"]>;
  } = {},
): ValidatedFinding {
  return {
    ...validValidatedFindingFixture,
    findingId,
    location: {
      ...validValidatedFindingFixture.location,
      ...overrides.location,
    },
  };
}
