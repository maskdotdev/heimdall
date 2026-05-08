import type { OrgSettings, RepoRule, RepositorySettings } from "@repo/contracts";
import { ids, now } from "@repo/contracts/fixtures/common";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
  buildReviewPolicySnapshot,
  classifyPath,
  createDefaultOrgSettings,
  createDefaultRepositorySettings,
  createFindingInputFixture,
  createPolicyFixture,
  createPrInputFixture,
  evaluateFindingPolicy,
  evaluateMemoryPolicy,
  getPublishingPolicyDecision,
  matchesAnyPathPattern,
  shouldReviewPr,
} from "../src/index";

describe("buildReviewPolicySnapshot", () => {
  it("compiles deterministic policy snapshots and clamps weak settings", () => {
    const weakSettings: RepositorySettings = {
      ...createDefaultRepositorySettings(ids.repoId, now),
      severityThreshold: "low",
      maxCommentsPerReview: 50,
      ignoredPaths: ["**/fixtures/**"],
      updatedAt: now,
    };
    const first = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      settings: weakSettings,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });
    const second = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      settings: weakSettings,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(first.snapshot.policyHash).toBe(second.snapshot.policyHash);
    expect(first.snapshot.effectivePolicy.findings.severityThreshold).toBe("medium");
    expect(first.snapshot.effectivePolicy.findings.maxCommentsPerReview).toBe(10);
    expect(first.snapshot.effectivePolicy.memory).toMatchObject({
      enableMemoryContext: true,
      maxMemoryFactsInContext: 6,
      requireApprovalForMemoryFacts: true,
    });
    expect(first.snapshot.effectivePolicy.sandbox).toMatchObject({
      allowNetwork: false,
      defaultRunner: "docker",
      maxTimeoutMs: 45_000,
      minimumRunnerForForks: "gvisor",
    });
    expect(first.snapshot.effectivePolicy.paths.ignoredPaths).toContain("**/fixtures/**");
    expect(first.warnings.map((warning) => warning.code)).toEqual([
      "severity_clamped_by_safety_floor",
      "comment_budget_clamped_by_safety_floor",
    ]);
  });

  it("compiles sandbox policy overrides with MVP safety clamps", () => {
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      sandboxPolicyOverrides: {
        allowCustomCommands: true,
        allowDependencyInstall: true,
        allowNetwork: true,
        defaultRunner: "gvisor",
        maxCpuCount: 32,
        maxOutputBytes: 100_000_000,
        maxTimeoutMs: 600_000,
        minimumRunnerForForks: "microvm",
      },
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.effectivePolicy.sandbox).toMatchObject({
      allowCustomCommands: false,
      allowDependencyInstall: false,
      allowNetwork: false,
      defaultRunner: "gvisor",
      maxCpuCount: 4,
      maxOutputBytes: 25_000_000,
      maxTimeoutMs: 120_000,
      minimumRunnerForForks: "microvm",
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "sandbox_network_disabled_by_mvp_policy",
      "sandbox_dependency_install_disabled_by_mvp_policy",
      "sandbox_custom_commands_disabled_by_mvp_policy",
      "sandbox_maxCpuCount_clamped",
      "sandbox_maxOutputBytes_clamped",
      "sandbox_maxTimeoutMs_clamped",
    ]);
  });

  it("compiles sandbox policy from repository settings", () => {
    const settings: RepositorySettings = {
      ...createDefaultRepositorySettings(ids.repoId, now),
      sandboxPolicy: {
        defaultRunner: "gvisor",
        maxMemoryBytes: 2_147_483_648,
        minimumRunnerForForks: "microvm",
      },
    };
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      settings,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.effectivePolicy.sandbox).toMatchObject({
      defaultRunner: "gvisor",
      maxMemoryBytes: 2_147_483_648,
      minimumRunnerForForks: "microvm",
    });
    expect(result.warnings).toEqual([]);
  });

  it("captures active rule versions and compiled instructions", () => {
    const rule = createRuleFixture({
      effect: "context",
      instruction: "Prefer security findings in authentication paths.",
      matcher: { paths: ["src/auth/**"], categories: ["security"] },
    });
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      activeRules: [rule],
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.activeRuleVersions).toEqual([{ ruleId: ids.ruleId, version: now }]);
    expect(result.snapshot.effectivePolicy.instructions).toEqual([
      "Prefer security findings in authentication paths.",
    ]);
  });

  it("ignores rules that expired before the policy timestamp", () => {
    const expiredRule = createRuleFixture({
      metadata: { expiresAt: "2026-04-27T00:00:00.000Z" },
    });
    const activeRule = createRuleFixture({
      ruleId: "rule_active",
      metadata: { expiresAt: "2026-04-29T00:00:00.000Z" },
    });
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      activeRules: [expiredRule, activeRule],
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.activeRuleVersions).toEqual([{ ruleId: "rule_active", version: now }]);
  });

  it("applies organization settings as policy defaults and guardrails", () => {
    const orgSettings: OrgSettings = {
      ...createDefaultOrgSettings(ids.orgId, now),
      defaultReviewPolicy: "summary_only",
      defaultTriggerPolicy: {
        enabledActions: ["opened"],
        ignoredAuthors: ["automation-bot"],
        ignoredLabels: ["skip-ai"],
        requireLabel: "ready-for-ai",
        skipDraftPullRequests: true,
      },
      defaultFindingPolicy: {
        allowStyleFindings: true,
        enabledCategories: ["security"],
        maxCommentsPerReview: 3,
        minimumConfidence: 0.8,
        severityThreshold: "high",
        suppressGeneratedFileFindings: true,
      },
      defaultPublishingPolicy: {
        maxCommentsPerReview: 3,
        publishCheckRun: false,
        publishInlineComments: false,
        publishSummaryComment: true,
      },
      defaultMemoryPolicy: {
        ...createDefaultOrgSettings(ids.orgId, now).defaultMemoryPolicy,
        maxMemoryFactsInContext: 2,
      },
      allowMemorySuppression: false,
      allowUserDefinedRules: false,
      version: 7,
    };
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      orgSettings,
      activeRules: [createRuleFixture({ effect: "context" })],
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.decisionInputs).toMatchObject({
      allowRepoLocalConfig: false,
      orgSettingsUpdatedAt: now,
      orgSettingsVersion: 7,
    });
    expect(result.snapshot.activeRuleVersions).toEqual([]);
    expect(result.snapshot.effectivePolicy).toMatchObject({
      reviewPolicy: "summary_only",
      findings: {
        allowStyleFindings: true,
        enabledCategories: ["security"],
        maxCommentsPerReview: 3,
        minimumConfidence: 0.8,
        severityThreshold: "high",
      },
      memory: {
        allowExactFindingSuppression: false,
        allowPathCategorySuppression: false,
        enableMemorySuppression: false,
        maxMemoryFactsInContext: 2,
      },
      publishing: {
        maxCommentsPerReview: 3,
        publishInlineComments: false,
        publishSummaryComment: true,
      },
      trigger: {
        enabledActions: ["opened"],
        ignoredAuthors: ["automation-bot"],
        ignoredLabels: ["skip-ai"],
        requireLabel: "ready-for-ai",
      },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "user_rules_disabled_by_org_settings",
    ]);
  });
});

describe("path matching and classification", () => {
  it("normalizes paths, rejects traversal, and matches bounded glob patterns", () => {
    expect(matchesAnyPathPattern("src/generated/client.ts", ["**/generated/**"])).toBe(true);
    expect(matchesAnyPathPattern("src/auth/session.ts", ["src/auth/**"])).toBe(true);
    expect(() => matchesAnyPathPattern("../secret.ts", ["**/*.ts"])).toThrow("traversal");
  });

  it("classifies ignored, generated, test, config, and documentation files", () => {
    const policy = createPolicyFixture();
    const generated = classifyPath({ policy, path: "src/__generated__/client.ts" });
    const test = classifyPath({ policy, path: "src/math.test.ts" });
    const config = classifyPath({ policy, path: ".github/workflows/ci.yml" });
    const documentation = classifyPath({ policy, path: "docs/usage.md" });

    expect(generated).toMatchObject({
      generated: true,
      ignored: true,
    });
    expect(generated.reasonCodes).toEqual(
      expect.arrayContaining(["path_ignored", "generated_file"]),
    );
    expect(test.test).toBe(true);
    expect(config.config).toBe(true);
    expect(documentation.documentation).toBe(true);
  });
});

describe("shouldReviewPr", () => {
  it("skips disabled, draft, label-blocked, and label-required pull requests", () => {
    const disabled = shouldReviewPr(
      createPrInputFixture({
        policy: createPolicyFixture({ enabled: false, reviewPolicy: "disabled" }),
      }),
    );
    const draft = shouldReviewPr(createPrInputFixture({ isDraft: true }));
    const blockedLabel = shouldReviewPr(
      createPrInputFixture({
        labels: ["no-ai-review"],
        policy: createPolicyFixture({ trigger: { ignoredLabels: ["no-ai-review"] } }),
      }),
    );
    const missingLabel = shouldReviewPr(
      createPrInputFixture({
        labels: ["needs-tests"],
        policy: createPolicyFixture({ trigger: { requireLabel: "ready-for-review" } }),
      }),
    );

    expect(disabled.reasonCode).toBe("review_policy_disabled");
    expect(draft.reasonCode).toBe("draft_pr_skipped");
    expect(blockedLabel.reasonCode).toBe("blocked_label_present");
    expect(missingLabel.reasonCode).toBe("missing_required_label");
  });

  it("allows matching pull requests with an explainable trace", () => {
    const decision = shouldReviewPr(createPrInputFixture());

    expect(decision).toMatchObject({
      shouldReview: true,
      reasonCode: "allowed",
      trace: { decision: "review", decisionType: "should_review_pr" },
    });
  });
});

describe("evaluateFindingPolicy", () => {
  it("suppresses findings by threshold, path policy, and repository rules", () => {
    const policy = createPolicyFixture({
      rules: [createRuleFixture({ effect: "suppress", matcher: { paths: ["src/auth/**"] } })],
    });
    const lowConfidence = evaluateFindingPolicy(
      createFindingInputFixture({ finding: { confidence: 0.2 } }),
    );
    const ignoredPath = evaluateFindingPolicy(
      createFindingInputFixture({
        finding: { location: { path: "dist/app.js", line: 1, side: "RIGHT" } },
      }),
    );
    const suppressedRule = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: { location: { path: "src/auth/session.ts", line: 4, side: "RIGHT" } },
      }),
    );

    expect(lowConfidence.reasonCode).toBe("confidence_below_threshold");
    expect(ignoredPath.reasonCode).toBe("path_ignored");
    expect(suppressedRule).toMatchObject({
      shouldPublish: false,
      reasonCode: "suppressed_by_repo_rule",
      trace: { matchedRuleIds: [ids.ruleId] },
    });
  });

  it("matches suppression rules by language, pull request author, and labels", () => {
    const policy = createPolicyFixture({
      rules: [
        createRuleFixture({
          effect: "suppress",
          matcher: {
            authors: ["octocat"],
            labels: ["skip-ai"],
            languages: ["typescript"],
            titleRegex: "non-finite",
          },
        }),
      ],
    });
    const matched = evaluateFindingPolicy(
      createFindingInputFixture({
        language: "typescript",
        policy,
        pullRequest: { authorLogin: "octocat", labels: ["skip-ai"] },
      }),
    );
    const missingLabel = evaluateFindingPolicy(
      createFindingInputFixture({
        language: "typescript",
        policy,
        pullRequest: { authorLogin: "octocat", labels: ["ready-for-review"] },
      }),
    );

    expect(matched).toMatchObject({
      shouldPublish: false,
      reasonCode: "suppressed_by_repo_rule",
      trace: { matchedRuleIds: [ids.ruleId] },
    });
    expect(missingLabel).toMatchObject({
      shouldPublish: true,
      reasonCode: "allowed",
      trace: { matchedRuleIds: [] },
    });
  });

  it("allows strong findings and returns publishing policy decisions", () => {
    const policy = createPolicyFixture({ reviewPolicy: "summary_only" });
    const findingDecision = evaluateFindingPolicy(createFindingInputFixture({ policy }));
    const publishingDecision = getPublishingPolicyDecision(policy);

    expect(findingDecision.shouldPublish).toBe(true);
    expect(publishingDecision).toMatchObject({
      publishCheckRun: false,
      publishInlineComments: false,
      publishSummaryComment: true,
      reasonCode: "publishing_enabled",
    });
  });

  it("records rules telemetry without paths or finding text", () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const telemetry = {
      metrics: createRecordingMetrics(metrics),
      traceContext: { requestId: "req_rules" },
      traces: createRecordingTraces(spans),
    };
    const result = buildReviewPolicySnapshot({
      ...telemetry,
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });
    const policy = result.snapshot.effectivePolicy;

    const pathClassification = classifyPath({
      ...telemetry,
      path: "src/private/auth.ts",
      policy,
    });
    const triggerDecision = shouldReviewPr({
      ...telemetry,
      action: "opened",
      authorLogin: "octocat",
      labels: ["ready-for-review"],
      policy,
    });
    const findingDecision = evaluateFindingPolicy({
      ...telemetry,
      finding: {
        ...createFindingInputFixture().finding,
        body: "Never mention this raw body.",
        location: { path: "src/private/auth.ts", line: 8, side: "RIGHT", isInDiff: true },
        title: "Never mention this raw title.",
      },
      policy,
    });
    const publishingDecision = getPublishingPolicyDecision(policy, telemetry);

    expect(pathClassification.ignored).toBe(false);
    expect(triggerDecision.shouldReview).toBe(true);
    expect(findingDecision.shouldPublish).toBe(true);
    expect(publishingDecision.reasonCode).toBe("publishing_enabled");
    expect(metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        OBSERVABILITY_METRIC_NAMES.rulesDecisionsTotal,
        OBSERVABILITY_METRIC_NAMES.rulesPolicyCompileDurationMs,
        OBSERVABILITY_METRIC_NAMES.rulesPolicyCompilationsTotal,
      ]),
    );
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        OBSERVABILITY_SPAN_NAMES.rulesCompilePolicy,
        OBSERVABILITY_SPAN_NAMES.rulesEvaluateFinding,
        OBSERVABILITY_SPAN_NAMES.rulesEvaluatePath,
        OBSERVABILITY_SPAN_NAMES.rulesEvaluateTrigger,
      ]),
    );
    const serializedTelemetry = JSON.stringify({ metrics, spans });
    expect(serializedTelemetry).not.toContain("src/private/auth.ts");
    expect(serializedTelemetry).not.toContain("Never mention");
  });
});

describe("evaluateMemoryPolicy", () => {
  it("controls memory context, creation, and suppression decisions", () => {
    const contextDisabled = evaluateMemoryPolicy({
      action: "context",
      policy: createPolicyFixture({
        memory: { enableMemoryContext: false, maxMemoryFactsInContext: 4 },
      }),
    });
    const trustedCreate = evaluateMemoryPolicy({
      action: "create_fact",
      actorRole: "maintainer",
      policy: createPolicyFixture(),
    });
    const untrustedCreate = evaluateMemoryPolicy({
      action: "create_fact",
      actorRole: "member",
      policy: createPolicyFixture(),
    });
    const exactSuppressionDisabled = evaluateMemoryPolicy({
      action: "suppress_exact_finding",
      policy: createPolicyFixture({
        memory: { allowExactFindingSuppression: false },
      }),
    });

    expect(contextDisabled).toMatchObject({
      allowed: false,
      maxFactsInContext: 0,
      reasonCode: "memory_context_disabled",
    });
    expect(trustedCreate).toMatchObject({
      allowed: true,
      reasonCode: "memory_allowed",
      requiresApproval: true,
    });
    expect(untrustedCreate.reasonCode).toBe("actor_not_trusted_for_memory");
    expect(exactSuppressionDisabled).toMatchObject({
      allowed: false,
      reasonCode: "exact_suppression_disabled",
      trace: { decisionType: "memory_allowed" },
    });
  });
});

/** Metric record captured by telemetry assertions. */
type RecordedMetric = {
  /** Metric instrument kind. */
  readonly kind: "counter" | "histogram";
  /** Metric labels attached to the record. */
  readonly labels?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

/** Span record captured by telemetry assertions. */
type RecordedSpan = {
  /** Span attributes captured when the span ended. */
  readonly endAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span name. */
  readonly name: string;
  /** Span attributes captured when the span started. */
  readonly startAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span status. */
  readonly status?: "error" | "ok" | "unset" | undefined;
};

/** Creates a metric recorder that stores metric records in memory. */
function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

/** Creates a span recorder that stores span records in memory. */
function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}

/** Creates a repository rule fixture for policy tests. */
function createRuleFixture(overrides: Partial<RepoRule> = {}): RepoRule {
  return {
    ruleId: ids.ruleId,
    orgId: ids.orgId,
    repoId: ids.repoId,
    name: "Suppress generated auth comments",
    effect: "suppress",
    matcher: { paths: ["src/auth/**"] },
    instruction: "Suppress repeated auth-path false positives.",
    priority: 900,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
