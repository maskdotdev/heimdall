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
  DEFAULT_CONFIG_FILE_POLICY,
  evaluateFindingPolicy,
  evaluateMemoryPolicy,
  getPublishingPolicyDecision,
  MAX_REPO_LOCAL_CONFIG_BYTES,
  matchesAnyPathPattern,
  parseRepoLocalConfig,
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

  it("compiles safe repo-local rule actions into finding suppression rules", () => {
    const parsed = parseRepoLocalConfig({
      content: [
        "version: 1",
        "rules:",
        "  - name: Only severe security workflow findings",
        "    when:",
        "      paths:",
        "        - .github/workflows/**",
        "    action:",
        "      enabled_categories:",
        "        - security",
        "        - correctness",
        "      severity_threshold: high",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".github/ai-reviewer.yml",
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      orgSettings: { ...createDefaultOrgSettings(ids.orgId, now), allowRepoLocalConfig: true },
      repoLocalConfig: parsed.config,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });
    const policy = result.snapshot.effectivePolicy;
    const workflowLocation = {
      path: ".github/workflows/ci.yml",
      line: 1,
      side: "RIGHT" as const,
      isInDiff: true,
    };
    const disabledCategory = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          category: "performance",
          location: workflowLocation,
          severity: "critical",
        },
      }),
    );
    const belowSeverity = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          category: "security",
          location: workflowLocation,
          severity: "medium",
        },
      }),
    );
    const allowed = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          category: "security",
          location: workflowLocation,
          severity: "high",
        },
      }),
    );

    expect(result.warnings).toEqual([]);
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules.map((rule) => rule.effect)).toEqual(["suppress", "suppress"]);
    expect(policy.rules.map((rule) => rule.metadata?.source)).toEqual([
      "repo_local_config",
      "repo_local_config",
    ]);
    expect(disabledCategory).toMatchObject({
      reasonCode: "suppressed_by_repo_rule",
      shouldPublish: false,
    });
    expect(disabledCategory.trace.matchedRuleIds[0]).toMatch(/^rule_/u);
    expect(belowSeverity).toMatchObject({
      reasonCode: "suppressed_by_repo_rule",
      shouldPublish: false,
    });
    expect(allowed).toMatchObject({
      reasonCode: "allowed",
      shouldPublish: true,
    });
  });

  it("compiles repo-local minimum confidence actions into confidence suppression rules", () => {
    const parsed = parseRepoLocalConfig({
      content: [
        "version: 1",
        "rules:",
        "  - name: Require high confidence client findings",
        "    when:",
        "      paths:",
        "        - src/client/**",
        "    action:",
        "      minimum_confidence: 0.9",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".github/ai-reviewer.yml",
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      orgSettings: { ...createDefaultOrgSettings(ids.orgId, now), allowRepoLocalConfig: true },
      repoLocalConfig: parsed.config,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });
    const policy = result.snapshot.effectivePolicy;
    const generatedLocation = {
      path: "src/client/api.ts",
      line: 8,
      side: "RIGHT" as const,
      isInDiff: true,
    };
    const belowConfidence = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          confidence: 0.82,
          location: generatedLocation,
        },
      }),
    );
    const atThreshold = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          confidence: 0.9,
          location: generatedLocation,
        },
      }),
    );

    expect(result.warnings).toEqual([]);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.matcher).toMatchObject({
      confidenceLessThan: 0.9,
      paths: ["src/client/**"],
    });
    expect(belowConfidence).toMatchObject({
      reasonCode: "suppressed_by_repo_rule",
      shouldPublish: false,
    });
    expect(atThreshold).toMatchObject({
      reasonCode: "allowed",
      shouldPublish: true,
    });
  });

  it("compiles scoped repo-local suppress actions with advanced matchers", () => {
    const parsed = parseRepoLocalConfig({
      content: [
        "version: 1",
        "rules:",
        "  - name: Suppress generated client noise",
        "    when:",
        "      paths:",
        "        - src/sdk/**",
        "      languages:",
        "        - typescript",
        "      authors:",
        "        - dependabot[bot]",
        "      labels:",
        "        - generated",
        "      title_regex: Generated client",
        "      confidence_less_than: 0.95",
        "    action:",
        "      suppress_findings: Generated client code is reviewed upstream.",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".github/ai-reviewer.yml",
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      orgSettings: { ...createDefaultOrgSettings(ids.orgId, now), allowRepoLocalConfig: true },
      repoLocalConfig: parsed.config,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });
    const policy = result.snapshot.effectivePolicy;
    const matched = evaluateFindingPolicy(
      createFindingInputFixture({
        language: "typescript",
        policy,
        pullRequest: { authorLogin: "dependabot[bot]", labels: ["generated"] },
        finding: {
          location: { path: "src/sdk/client.ts", line: 4, side: "RIGHT", isInDiff: true },
          title: "Generated client wrapper can return undefined",
        },
      }),
    );
    const highConfidence = evaluateFindingPolicy(
      createFindingInputFixture({
        language: "typescript",
        policy,
        pullRequest: { authorLogin: "dependabot[bot]", labels: ["generated"] },
        finding: {
          confidence: 0.95,
          location: { path: "src/sdk/client.ts", line: 4, side: "RIGHT", isInDiff: true },
          title: "Generated client wrapper can return undefined",
        },
      }),
    );
    const missingLabel = evaluateFindingPolicy(
      createFindingInputFixture({
        language: "typescript",
        policy,
        pullRequest: { authorLogin: "dependabot[bot]", labels: ["ready-for-review"] },
        finding: {
          location: { path: "src/sdk/client.ts", line: 4, side: "RIGHT", isInDiff: true },
          title: "Generated client wrapper can return undefined",
        },
      }),
    );

    expect(result.warnings).toEqual([]);
    expect(parsed.config.rules?.[0]).toMatchObject({
      action: {
        suppressFindingsReason: "Generated client code is reviewed upstream.",
      },
      when: {
        authors: ["dependabot[bot]"],
        confidenceLessThan: 0.95,
        labels: ["generated"],
        languages: ["typescript"],
        paths: ["src/sdk/**"],
        titleRegex: "Generated client",
      },
    });
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.metadata).toMatchObject({
      actionKind: "suppress_findings",
      reason: "Generated client code is reviewed upstream.",
      source: "repo_local_config",
    });
    expect(policy.rules[0]?.matcher).toMatchObject({
      authors: ["dependabot[bot]"],
      confidenceLessThan: 0.95,
      labels: ["generated"],
      languages: ["typescript"],
      paths: ["src/sdk/**"],
      titleRegex: "Generated client",
    });
    expect(matched).toMatchObject({
      reasonCode: "suppressed_by_repo_rule",
      shouldPublish: false,
    });
    expect(highConfidence).toMatchObject({
      reasonCode: "allowed",
      shouldPublish: true,
    });
    expect(missingLabel).toMatchObject({
      reasonCode: "allowed",
      shouldPublish: true,
    });
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

  it("merges allowed repo-local config into policy snapshots with source metadata", () => {
    const parsed = parseRepoLocalConfig({
      content: [
        "version: 1",
        "review:",
        "  mode: summary_only",
        "  max_comments_per_pr: 4",
        "  severity_threshold: high",
        "  minimum_confidence: 0.8",
        "triggers:",
        "  enabled_actions:",
        "    - opened",
        "  require_any_label:",
        "    - ai-ready",
        "    - review-me",
        "  include_base_branches:",
        "    - main",
        "    - release/**",
        "  skip_if_any_label:",
        "    - no-ai-review",
        "paths:",
        "  ignored:",
        "    - apps/generated/**",
        "  tests:",
        "    - tests/**/*.ts",
        "categories:",
        "  enabled:",
        "    - security",
        "    - style",
        "publishing:",
        "  summary: true",
        "  inline_comments: false",
        "  check_run: false",
        "  max_comments_per_pr: 3",
        "memory:",
        "  max_memory_facts_in_context: 2",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1234567890",
      sourcePath: ".github/ai-reviewer.yml",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }

    const orgSettings: OrgSettings = {
      ...createDefaultOrgSettings(ids.orgId, now),
      allowRepoLocalConfig: true,
    };
    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      orgSettings,
      repoLocalConfig: parsed.config,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.decisionInputs).toMatchObject({
      repoLocalConfigSourceCommitSha: "abcdef1234567890",
      repoLocalConfigSourceHash: parsed.config.sourceHash,
      repoLocalConfigSourcePath: ".github/ai-reviewer.yml",
      repoLocalConfigVersion: 1,
      source: "repository_settings_with_repo_local_config",
    });
    expect(result.snapshot.effectivePolicy).toMatchObject({
      reviewPolicy: "summary_only",
      findings: {
        enabledCategories: ["security"],
        maxCommentsPerReview: 3,
        minimumConfidence: 0.8,
        severityThreshold: "high",
      },
      memory: {
        maxMemoryFactsInContext: 2,
      },
      publishing: {
        maxCommentsPerReview: 3,
        publishCheckRun: false,
        publishInlineComments: false,
        publishSummaryComment: true,
      },
      trigger: {
        enabledActions: ["opened"],
        includeBaseBranches: ["main", "release/**"],
        ignoredLabels: ["no-ai-review"],
        requireAnyLabels: ["ai-ready", "review-me"],
        requireLabel: "ai-ready",
      },
    });
    expect(result.snapshot.effectivePolicy.paths.ignoredPaths).toContain("apps/generated/**");
    expect(result.snapshot.effectivePolicy.paths.testPaths).toContain("tests/**/*.ts");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "repo_local_categories_clamped_by_org_settings",
      "comment_budget_clamped_by_repo_local_config",
    ]);
  });

  it("ignores repo-local config when organization settings do not allow it", () => {
    const parsed = parseRepoLocalConfig({
      content: "version: 1\nreview:\n  mode: summary_only\n",
      format: "yaml",
      sourceCommitSha: "abcdef1234567890",
      sourcePath: ".ai-reviewer.yml",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }

    const result = buildReviewPolicySnapshot({
      repository: { enabled: true, orgId: ids.orgId, repoId: ids.repoId },
      orgSettings: createDefaultOrgSettings(ids.orgId, now),
      repoLocalConfig: parsed.config,
      timestamp: now,
      reviewRunId: ids.reviewRunId,
    });

    expect(result.snapshot.decisionInputs).toMatchObject({
      allowRepoLocalConfig: false,
      source: "repository_settings",
    });
    expect(result.snapshot.decisionInputs).not.toHaveProperty("repoLocalConfigSourceHash");
    expect(result.snapshot.effectivePolicy.reviewPolicy).toBe("inline_comments_and_summary");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "repo_local_config_disabled_by_org_settings",
    ]);
  });
});

describe("parseRepoLocalConfig", () => {
  it("parses and normalizes the documented YAML config shape with source metadata", () => {
    const result = parseRepoLocalConfig({
      content: [
        "version: 1",
        "review:",
        "  mode: inline_comments_with_summary",
        "  max_comments_per_pr: 5",
        "  severity_threshold: medium",
        "  minimum_confidence: 0.75",
        "triggers:",
        "  skip_draft_pull_requests: true",
        "  require_any_label: []",
        "  skip_if_any_label:",
        "    - no-ai-review",
        "  include_base_branches:",
        "    - main",
        "    - release/**",
        "paths:",
        "  ignored:",
        '    - "**/generated/**"',
        '    - "**/*.pb.ts"',
        "  tests:",
        '    - "**/*.test.ts"',
        "categories:",
        "  enabled:",
        "    - correctness",
        "    - security",
        "  disabled:",
        "    - style",
        "publishing:",
        "  summary: true",
        "  inline_comments: true",
        "  check_run: false",
        "rules:",
        "  - name: Only security comments in generated config",
        "    when:",
        "      paths:",
        "        - .github/workflows/**",
        "    action:",
        "      enabled_categories:",
        "        - security",
        "        - correctness",
        "      severity_threshold: high",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1234567890",
      sourcePath: ".ai-reviewer.yml",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    expect(result.config).toMatchObject({
      schemaVersion: "repo_local_config.v1",
      configVersion: 1,
      sourcePath: ".ai-reviewer.yml",
      sourceCommitSha: "abcdef1234567890",
      review: {
        maxCommentsPerReview: 5,
        minimumConfidence: 0.75,
        mode: "inline_comments_and_summary",
        severityThreshold: "medium",
      },
      triggers: {
        includeBaseBranches: ["main", "release/**"],
        requireAnyLabel: [],
        skipDraftPullRequests: true,
        skipIfAnyLabel: ["no-ai-review"],
      },
      paths: {
        ignored: ["**/generated/**", "**/*.pb.ts"],
        tests: ["**/*.test.ts"],
      },
      categories: {
        disabled: ["style"],
        enabled: ["correctness", "security"],
      },
      publishing: {
        publishCheckRun: false,
        publishInlineComments: true,
        publishSummaryComment: true,
      },
      rules: [
        {
          action: {
            enabledCategories: ["security", "correctness"],
            severityThreshold: "high",
          },
          name: "Only security comments in generated config",
          when: { paths: [".github/workflows/**"] },
        },
      ],
    });
    expect(result.config.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "repo_local_review_mode_alias",
    ]);
  });

  it("parses JSON config and normalizes leading current-directory path segments", () => {
    const result = parseRepoLocalConfig({
      content: JSON.stringify({
        version: 1,
        paths: { ignored: ["./generated/**"] },
        review: { severity_threshold: "high" },
      }),
      format: "json",
      sourceCommitSha: "abcdef1",
      sourcePath: ".github/ai-reviewer.yaml",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    expect(result.config.paths?.ignored).toEqual(["generated/**"]);
    expect(result.config.review?.severityThreshold).toBe("high");
  });

  it("rejects unknown keys, oversized files, disallowed paths, and dangerous patterns", () => {
    const unknownKey = parseRepoLocalConfig({
      content: "version: 1\nunknown: true\n",
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yaml",
    });
    const oversized = parseRepoLocalConfig({
      content: "version: 1\n",
      format: "yaml",
      maxBytes: 4,
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yaml",
    });
    const disallowedPath = parseRepoLocalConfig({
      content: "version: 1\n",
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: "README.md",
    });
    const dangerousPattern = parseRepoLocalConfig({
      content: [
        "version: 1",
        "paths:",
        "  ignored:",
        "    - ../secret/**",
        "    - src\\\\secret\\\\**",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yaml",
    });

    expect(unknownKey.ok).toBe(false);
    expect(oversized.ok).toBe(false);
    expect(disallowedPath.ok).toBe(false);
    expect(dangerousPattern.ok).toBe(false);
    if (unknownKey.ok || oversized.ok || disallowedPath.ok || dangerousPattern.ok) {
      throw new Error("Expected invalid repo-local config inputs to be rejected.");
    }
    expect(unknownKey.errors.map((error) => error.code)).toContain("invalid_config_schema");
    expect(oversized.errors.map((error) => error.code)).toContain("config_file_too_large");
    expect(disallowedPath.errors.map((error) => error.code)).toContain("source_path_not_allowed");
    expect(dangerousPattern.errors.map((error) => error.code)).toEqual([
      "dangerous_path_pattern",
      "dangerous_path_pattern",
    ]);
  });

  it("rejects config files that try to weaken review gates without policy approval", () => {
    const rejected = parseRepoLocalConfig({
      content: [
        "version: 1",
        "review:",
        "  mode: disabled",
        "  severity_threshold: low",
        "  minimum_confidence: 0.4",
        "rules:",
        "  - name: Lower generated config threshold",
        "    action:",
        "      severity_threshold: info",
        "      minimum_confidence: 0.2",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yml",
    });
    const allowed = parseRepoLocalConfig({
      content: "version: 1\nreview:\n  mode: disabled\n",
      format: "yaml",
      policy: {
        ...DEFAULT_CONFIG_FILE_POLICY,
        allowConfigFileToDisableReviews: true,
      },
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yml",
    });

    expect(rejected.ok).toBe(false);
    if (rejected.ok) {
      throw new Error("Expected weakening repo-local config to be rejected.");
    }
    expect(rejected.errors.map((error) => error.code)).toEqual([
      "review_disable_not_allowed",
      "severity_threshold_below_safety_floor",
      "confidence_threshold_below_safety_floor",
      "severity_threshold_below_safety_floor",
      "confidence_threshold_below_safety_floor",
    ]);
    expect(allowed.ok).toBe(true);
  });

  it("rejects unsafe repo-local runtime suppression rules", () => {
    const unscopedSuppression = parseRepoLocalConfig({
      content: [
        "version: 1",
        "rules:",
        "  - name: Suppress everything",
        "    action:",
        "      suppress_findings: Not scoped enough.",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yml",
    });
    const invalidTitleRegex = parseRepoLocalConfig({
      content: [
        "version: 1",
        "rules:",
        "  - name: Invalid title regex",
        "    when:",
        "      title_regex: '['",
        "    action:",
        "      suppress_findings: Invalid regex should fail validation.",
      ].join("\n"),
      format: "yaml",
      sourceCommitSha: "abcdef1",
      sourcePath: ".ai-reviewer.yml",
    });

    expect(unscopedSuppression.ok).toBe(false);
    expect(invalidTitleRegex.ok).toBe(false);
    if (unscopedSuppression.ok || invalidTitleRegex.ok) {
      throw new Error("Expected unsafe repo-local runtime suppression rules to be rejected.");
    }
    expect(unscopedSuppression.errors.map((error) => error.code)).toEqual([
      "unscoped_suppress_findings",
    ]);
    expect(invalidTitleRegex.errors.map((error) => error.code)).toEqual(["invalid_title_regex"]);
  });

  it("uses the documented default size limit", () => {
    expect(MAX_REPO_LOCAL_CONFIG_BYTES).toBe(64 * 1024);
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

  it("skips pull requests whose base branch is outside compiled trigger filters", () => {
    const policy = createPolicyFixture({
      trigger: { includeBaseBranches: ["main", "release/**"] },
    });
    const allowed = shouldReviewPr(createPrInputFixture({ baseRef: "release/2026.05", policy }));
    const skipped = shouldReviewPr(createPrInputFixture({ baseRef: "develop", policy }));

    expect(allowed).toMatchObject({
      reasonCode: "allowed",
      shouldReview: true,
    });
    expect(skipped).toMatchObject({
      reasonCode: "base_branch_not_included",
      shouldReview: false,
    });
  });

  it("allows pull requests with any compiled required label", () => {
    const policy = createPolicyFixture({
      trigger: { requireAnyLabels: ["ready-for-review", "review-me"] },
    });
    const firstLabel = shouldReviewPr(
      createPrInputFixture({ labels: ["ready-for-review"], policy }),
    );
    const secondLabel = shouldReviewPr(createPrInputFixture({ labels: ["review-me"], policy }));
    const missingLabel = shouldReviewPr(createPrInputFixture({ labels: ["needs-tests"], policy }));

    expect(firstLabel).toMatchObject({ reasonCode: "allowed", shouldReview: true });
    expect(secondLabel).toMatchObject({ reasonCode: "allowed", shouldReview: true });
    expect(missingLabel).toMatchObject({
      reasonCode: "missing_required_label",
      shouldReview: false,
    });
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

  it("matches suppression rules by confidence threshold", () => {
    const policy = createPolicyFixture({
      rules: [
        createRuleFixture({
          effect: "suppress",
          matcher: { confidenceLessThan: 0.8, paths: ["src/**"] },
        }),
      ],
    });
    const lowConfidence = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          confidence: 0.79,
          location: { path: "src/auth/session.ts", line: 4, side: "RIGHT" },
        },
      }),
    );
    const thresholdConfidence = evaluateFindingPolicy(
      createFindingInputFixture({
        policy,
        finding: {
          confidence: 0.8,
          location: { path: "src/auth/session.ts", line: 4, side: "RIGHT" },
        },
      }),
    );

    expect(lowConfidence).toMatchObject({
      shouldPublish: false,
      reasonCode: "suppressed_by_repo_rule",
      trace: { matchedRuleIds: [ids.ruleId] },
    });
    expect(thresholdConfidence).toMatchObject({
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
