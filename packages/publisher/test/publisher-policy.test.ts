import type { ValidatedFinding } from "@repo/contracts";
import { validValidatedFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import { describe, expect, it } from "vitest";
import {
  createInMemoryPublishThrottle,
  createPublishPlan,
  hasPlannedPublishOperations,
  PUBLISH_LIMITS,
  type PublishOperationType,
  type PublishThrottleLimits,
} from "../src";

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

  it("throttles inline comments and routes overflow findings to a fallback summary", () => {
    const plan = createPublishPlan({
      reviewRun: reviewRunWithPublishingPolicy({
        maxCommentsPerReview: 5,
        publishCheckRun: false,
        publishInlineComments: true,
        publishSummaryComment: false,
      }),
      findings: [findingFixture("fnd_one"), findingFixture("fnd_two"), findingFixture("fnd_three")],
      throttleLimits: { maxInlineCommentsPerReview: 1 },
    });

    expect(plan.inlineFindings.map((finding) => finding.findingId)).toEqual(["fnd_one"]);
    expect(plan.throttle).toMatchObject({
      inlineCommentLimit: 1,
      inlineFindingCountAfterThrottle: 1,
      inlineFindingCountBeforeThrottle: 3,
      inlineFindingsSkippedByThrottle: 2,
    });
    expect(plan.plannedOperations).toEqual([
      {
        findingCount: 1,
        operationType: "review.inline_comments",
        status: "planned",
      },
      {
        findingCount: 2,
        operationType: "summary_comment.fallback",
        status: "planned",
      },
    ]);
  });

  it("plans fallback summary publishing when no findings can be anchored inline", () => {
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
      {
        findingCount: 1,
        operationType: "summary_comment.fallback",
        status: "planned",
      },
    ]);
    expect(hasPlannedPublishOperations(plan)).toBe(true);
  });

  it("treats no accepted findings as a no-op publish plan", () => {
    const plan = createPublishPlan({
      reviewRun: {},
      findings: [],
    });

    expect(plan.checkRunFindings).toHaveLength(0);
    expect(plan.inlineFindings).toHaveLength(0);
    expect(plan.configuredSummaryFindings).toHaveLength(0);
    expect(plan.plannedOperations).toEqual([
      {
        findingCount: 0,
        operationType: "check_run.upsert",
        reason: "no_check_run_findings",
        status: "skipped",
      },
      {
        findingCount: 0,
        operationType: "review.inline_comments",
        reason: "no_inline_findings",
        status: "skipped",
      },
    ]);
    expect(hasPlannedPublishOperations(plan)).toBe(false);
  });
});

describe("createInMemoryPublishThrottle", () => {
  it("waits when the repository operation minute limit is exhausted", async () => {
    let nowMs = Date.parse("2026-05-07T12:00:00.000Z");
    const sleeps: number[] = [];
    const throttle = createInMemoryPublishThrottle({
      limits: throttleLimits({
        maxPublishOperationsPerInstallationPerMinute: 10,
        maxPublishOperationsPerRepoPerMinute: 1,
        maxSummaryCommentsPerPrPerHour: 10,
      }),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await throttle.waitForSlot(throttleSlot("check_run.upsert"));
    const decision = await throttle.waitForSlot(throttleSlot("review.inline_comments"));

    expect(decision).toMatchObject({
      limitReason: "publish_operations_per_repo_per_minute",
      waitedMs: 60_000,
    });
    expect(sleeps).toEqual([60_000]);
  });

  it("waits when the summary comment hourly PR limit is exhausted", async () => {
    let nowMs = Date.parse("2026-05-07T12:00:00.000Z");
    const sleeps: number[] = [];
    const throttle = createInMemoryPublishThrottle({
      limits: throttleLimits({
        maxPublishOperationsPerInstallationPerMinute: 10,
        maxPublishOperationsPerRepoPerMinute: 10,
        maxSummaryCommentsPerPrPerHour: 1,
      }),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await throttle.waitForSlot(throttleSlot("summary_comment.configured"));
    const decision = await throttle.waitForSlot(throttleSlot("summary_comment.fallback"));

    expect(decision).toMatchObject({
      limitReason: "summary_comments_per_pr_per_hour",
      waitedMs: 3_600_000,
    });
    expect(sleeps).toEqual([3_600_000]);
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

/** Creates a complete throttle limit object for tests. */
function throttleLimits(overrides: Partial<PublishThrottleLimits>): PublishThrottleLimits {
  return {
    ...PUBLISH_LIMITS,
    ...overrides,
  };
}

/** Creates a throttle slot input for one test repository. */
function throttleSlot(operationType: PublishOperationType) {
  return {
    installationId: "inst_1",
    operationType,
    pullRequestNumber: 7,
    repositoryKey: "repo_1",
  };
}
