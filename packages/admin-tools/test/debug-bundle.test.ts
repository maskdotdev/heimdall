import type { ContextItem, ValidatedFinding } from "@repo/contracts";
import { validValidatedFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import { validContextBundleFixture } from "@repo/contracts/fixtures/review.fixture";
import { describe, expect, it } from "vitest";
import {
  type AdminReviewDebugDetails,
  buildReviewRunEvalCase,
  buildUsageCostInspection,
  compareRetrievalReplayItems,
  compareValidationReplayFindings,
  type ImportReviewRunToEvalRequest,
  redactDebugBundleValue,
} from "../src";

describe("redactDebugBundleValue", () => {
  it("replaces sensitive source, prompt, and provider fields with hash placeholders", () => {
    const redacted = redactDebugBundleValue({
      llm: {
        prompt: "Review this private code.",
        responseBody: "The model response contains source context.",
      },
      reviewRunId: "rrn_1",
      payloadHash: "sha256:already-safe",
      webhook: {
        payload: {
          secret: "provider-token",
        },
      },
    });

    expect(redacted).toMatchObject({
      llm: {
        prompt: {
          redacted: true,
          key: "prompt",
          reason: "sensitive_field",
          sha256: expect.stringMatching(/^sha256:/u),
          valueType: "string",
        },
        responseBody: {
          redacted: true,
          key: "responseBody",
          reason: "sensitive_field",
          sha256: expect.stringMatching(/^sha256:/u),
          valueType: "string",
        },
      },
      reviewRunId: "rrn_1",
      payloadHash: "sha256:already-safe",
      webhook: {
        payload: {
          redacted: true,
          key: "payload",
          reason: "sensitive_field",
          sha256: expect.stringMatching(/^sha256:/u),
          valueType: "object",
        },
      },
    });
  });
});

describe("compareRetrievalReplayItems", () => {
  it("classifies unchanged, changed, added, and removed context items", () => {
    const unchanged = contextItemFixture({ suffix: "unchanged" });
    const changedOriginal = contextItemFixture({ suffix: "changed" });
    const changedReplay = contextItemFixture({
      suffix: "changed",
      priority: 72,
      title: "Changed replay context",
    });
    const removed = contextItemFixture({ suffix: "removed" });
    const added = contextItemFixture({ suffix: "added" });

    const comparisons = compareRetrievalReplayItems(
      [unchanged, changedOriginal, removed],
      [unchanged, changedReplay, added],
    );

    expect(
      Object.fromEntries(comparisons.map((comparison) => [comparison.key, comparison.status])),
    ).toEqual({
      chunk_added: "added",
      chunk_changed: "changed",
      chunk_removed: "removed",
      chunk_unchanged: "unchanged",
    });
    expect(comparisons.find((comparison) => comparison.key === "chunk_changed")).toMatchObject({
      originalPriority: 90,
      originalTitle: "Context changed",
      replayedPriority: 72,
      replayedTitle: "Changed replay context",
    });
  });
});

describe("compareValidationReplayFindings", () => {
  it("classifies unchanged, changed, added, and removed validation output", () => {
    const unchanged = validatedFindingFixture({ suffix: "unchanged" });
    const changedOriginal = validatedFindingFixture({ suffix: "changed" });
    const changedReplay = validatedFindingFixture({
      suffix: "changed",
      decision: "reject",
      reasons: ["budget_exceeded"],
    });
    const removed = validatedFindingFixture({ suffix: "removed" });
    const added = validatedFindingFixture({ suffix: "added" });

    const comparisons = compareValidationReplayFindings(
      [unchanged, changedOriginal, removed],
      [unchanged, changedReplay, added],
    );

    expect(
      Object.fromEntries(comparisons.map((comparison) => [comparison.key, comparison.status])),
    ).toEqual({
      cfnd_added: "added",
      cfnd_changed: "changed",
      cfnd_removed: "removed",
      cfnd_unchanged: "unchanged",
    });
    expect(comparisons.find((comparison) => comparison.key === "cfnd_changed")).toMatchObject({
      originalDecision: "publish",
      replayedDecision: "reject",
      replayedReasons: ["budget_exceeded"],
    });
  });
});

describe("buildReviewRunEvalCase", () => {
  it("creates a schema-valid eval case from review inspector metadata", () => {
    const evalCase = buildReviewRunEvalCase(reviewDetailsFixture(), importRequestFixture());

    expect(evalCase).toMatchObject({
      caseId: expect.stringMatching(/^case_imported_review_/u),
      title: "Imported review",
      changedFiles: [
        {
          path: "src/index.ts",
          changeType: "modified",
          reviewableLines: [7],
        },
      ],
      expectedFindings: [
        {
          expectedFindingId: "expected_fnd_1",
          location: {
            path: "src/index.ts",
            line: 7,
          },
        },
      ],
      actualFindings: [
        {
          findingId: "fnd_1",
          location: {
            path: "src/index.ts",
            line: 7,
          },
        },
      ],
    });
  });
});

describe("buildUsageCostInspection", () => {
  it("summarizes usage events, billable units, cost, and quota state", () => {
    const inspection = buildUsageCostInspection({
      orgId: "org_1",
      repoId: "repo_1",
      reviewRunId: "rrn_1",
      quotaDecisions: [
        {
          consumedAt: "2026-05-05T12:03:00.000Z",
          createdAt: "2026-05-05T12:00:00.000Z",
          expiresAt: "2026-05-05T18:00:00.000Z",
          limitQuantity: 10,
          periodKey: "2026-05",
          quantity: 1,
          quotaKey: "monthly_review_credits",
          quotaReservationId: "qres_1",
          reservedQuantity: 0,
          sourceId: "rrn_1",
          sourceType: "review_run",
          status: "consumed",
          usedQuantity: 1,
        },
      ],
      usageEvents: [
        {
          costMicros: 125,
          eventType: "review.run",
          metadataKeys: ["stage"],
          occurredAt: "2026-05-05T12:00:00.000Z",
          orgId: "org_1",
          quantity: 1,
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          unit: "count",
          usageEventId: "usage_review_run",
        },
        {
          costMicros: 75,
          eventType: "review.credit",
          metadataKeys: [],
          occurredAt: "2026-05-05T12:01:00.000Z",
          orgId: "org_1",
          quantity: 1,
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          unit: "credit",
          usageEventId: "usage_review_credit",
        },
        {
          costMicros: 300,
          eventType: "llm.token",
          metadataKeys: ["model", "provider"],
          occurredAt: "2026-05-05T12:02:00.000Z",
          orgId: "org_1",
          quantity: 900,
          repoId: "repo_1",
          reviewRunId: "rrn_1",
          unit: "token",
          usageEventId: "usage_llm_token",
        },
        {
          costMicros: 999,
          eventType: "review.run",
          metadataKeys: [],
          occurredAt: "2026-05-05T12:03:00.000Z",
          orgId: "org_other",
          quantity: 1,
          repoId: "repo_other",
          reviewRunId: "rrn_other",
          unit: "count",
          usageEventId: "usage_other",
        },
      ],
    });

    expect(inspection).toMatchObject({
      estimatedCostMicros: 500,
      estimatedCostUsd: "0.000500",
      billableUnits: {
        review_credits: 1,
        review_runs: 1,
      },
      warnings: [],
    });
    expect(inspection.usageEvents.map((event) => event.usageEventId)).toEqual([
      "usage_review_run",
      "usage_review_credit",
      "usage_llm_token",
    ]);
    expect(inspection.rollups).toContainEqual({
      costMicros: 300,
      eventCount: 1,
      eventType: "llm.token",
      quantity: 900,
      unit: "token",
    });
    expect(inspection.quotaDecisions[0]).toMatchObject({
      quotaKey: "monthly_review_credits",
      status: "consumed",
      usedQuantity: 1,
    });
  });

  it("warns when review usage has no ledger rows or quota reservation", () => {
    const inspection = buildUsageCostInspection({
      orgId: "org_1",
      repoId: "repo_1",
      reviewRunId: "rrn_1",
      usageEvents: [],
    });

    expect(inspection.warnings).toEqual([
      "No usage events are linked to this review run.",
      "No quota reservation is linked to this review run.",
    ]);
  });
});

/** Creates a context item fixture with a stable retrieval comparison key. */
function contextItemFixture(input: {
  /** Unique suffix for durable context item IDs and chunk IDs. */
  readonly suffix: string;
  /** Optional priority override. */
  readonly priority?: ContextItem["priority"];
  /** Optional title override. */
  readonly title?: string;
}): ContextItem {
  const base = validContextBundleFixture.items[0];
  if (!base) {
    throw new Error("Context bundle fixture must include at least one item.");
  }
  if (!base.snippet) {
    throw new Error("Context item fixture must include a snippet.");
  }

  return {
    ...base,
    contextItemId: `ctxitem_${input.suffix}`,
    title: input.title ?? `Context ${input.suffix}`,
    priority: input.priority ?? base.priority,
    snippet: {
      ...base.snippet,
      chunkId: `chunk_${input.suffix}`,
    },
  };
}

/** Creates a validated finding fixture with a stable comparison key. */
function validatedFindingFixture(input: {
  /** Unique suffix for durable finding IDs and fingerprints. */
  readonly suffix: string;
  /** Validation decision for the fixture. */
  readonly decision?: ValidatedFinding["decision"];
  /** Validation rejection reasons for the fixture. */
  readonly reasons?: ValidatedFinding["validation"]["reasons"];
}): ValidatedFinding {
  return {
    ...validValidatedFindingFixture,
    findingId: `fnd_${input.suffix}`,
    candidateFindingId: `cfnd_${input.suffix}`,
    decision: input.decision ?? "publish",
    fingerprint: `fp_${input.suffix}`,
    validation: {
      ...validValidatedFindingFixture.validation,
      reasons: input.reasons ?? [],
    },
  };
}

/** Creates review inspector details for eval import tests. */
function reviewDetailsFixture(): AdminReviewDebugDetails {
  return {
    reviewRun: {
      reviewRunId: "rrn_1",
      schemaVersion: "review_run.v1",
      repoId: "repo_1",
      pullRequestSnapshotId: "prs_1",
      pullRequestNumber: 12,
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
      trigger: "webhook",
      status: "completed",
      startedAt: "2026-05-05T12:00:00.000Z",
      completedAt: "2026-05-05T12:00:03.000Z",
      createdAt: "2026-05-05T12:00:00.000Z",
      updatedAt: "2026-05-05T12:00:03.000Z",
      artifactRefs: [],
      counts: {
        candidateFindings: 1,
        validatedFindings: 1,
        publishedFindings: 1,
        rejectedFindings: 0,
      },
    },
    snapshot: {
      snapshotId: "prs_1",
      provider: "github",
      repoId: "repo_1",
      installationId: "inst_1",
      pullRequestNumber: 12,
      title: "Change exported value",
      authorLogin: "octocat",
      state: "open",
      isDraft: false,
      baseRef: "main",
      baseSha: "1111111111111111111111111111111111111111",
      headRef: "feature",
      headSha: "2222222222222222222222222222222222222222",
      diffHash: "sha256:test",
      additions: 1,
      deletions: 0,
      changedFileCount: 1,
      changedFiles: [{ path: "src/index.ts", status: "modified" }],
      fetchedAt: "2026-05-05T12:00:00.000Z",
    },
    artifacts: [],
    candidateFindings: [],
    dependencies: [],
    failures: [],
    llmCalls: [
      {
        llmCallId: "llm_1",
        provider: "static",
        model: "deterministic",
        purpose: "review",
        status: "completed",
        promptHash: "sha256:prompt",
        responseHash: "sha256:response",
        inputTokens: 100,
        outputTokens: 20,
        costMicros: 100,
        startedAt: "2026-05-05T12:00:00.000Z",
        completedAt: "2026-05-05T12:00:01.000Z",
      },
    ],
    relatedJobs: [],
    replayAudits: [],
    sandboxRuns: [],
    stageEvents: [],
    validatedFindings: [
      {
        findingId: "fnd_1",
        candidateFindingId: "cfnd_1",
        decision: "publish",
        category: "correctness",
        severity: "high",
        title: "Validate exported value",
        location: { path: "src/index.ts", line: 7 },
        rank: 1,
        fingerprint: "fp_1",
        validation: { reasons: [] },
      },
    ],
  };
}

/** Creates an eval import request for tests. */
function importRequestFixture(): ImportReviewRunToEvalRequest {
  return {
    reviewRunId: "rrn_1",
    suiteId: "smoke-full-pipeline-v1",
    caseName: "Imported review",
    reason: "Cover a production review.",
    includeArtifacts: {
      pullRequestSnapshot: true,
      rawDiff: false,
      contextBundle: false,
      reviewOutputs: true,
      validationOutputs: true,
    },
    redactionLevel: "redacted",
    labels: ["prod-failure"],
  };
}
