import { createHash } from "node:crypto";
import {
  type CandidateFinding,
  DEFAULT_REPOSITORY_SETTINGS,
  type FindingCategory,
  FindingCategorySchema,
  type FindingSeverity,
  FindingSeveritySchema,
  type RepoRule,
  RepoRuleIdSchema,
  RepoRuleSchema,
  type Repository,
  type RepositorySettings,
  type ReviewPolicy,
  ReviewPolicySchema,
} from "@repo/contracts";
import { OrgIdSchema, RepoIdSchema, ReviewRunIdSchema } from "@repo/contracts/primitives/ids";
import { IsoDateTimeSchema } from "@repo/contracts/primitives/time";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Default policy compiler version used for policy snapshot hashing and debugging. */
export const RULES_ENGINE_VERSION = "rules-engine.v2";

/** Default PR actions that can trigger review work in the MVP policy. */
export const DEFAULT_ENABLED_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "labeled",
  "manual",
] as const;

/** Default path patterns excluded from review and indexing decisions. */
export const DEFAULT_IGNORED_PATHS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.map",
] as const;

/** Default generated-code patterns used by path classification and finding validation. */
export const DEFAULT_GENERATED_PATHS = [
  "**/generated/**",
  "**/__generated__/**",
  "**/*.generated.*",
  "**/*.pb.*",
  "**/*.gen.*",
] as const;

/** Default test path patterns used to classify changed files. */
export const DEFAULT_TEST_PATHS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/tests/**",
] as const;

/** Default config path patterns used to classify changed files. */
export const DEFAULT_CONFIG_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "tsconfig*.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  ".github/workflows/**",
] as const;

/** Default documentation path patterns used to classify changed files. */
export const DEFAULT_DOCUMENTATION_PATHS = ["**/*.md", "docs/**"] as const;

/** Default finding categories that can be published without an explicit override. */
export const DEFAULT_ENABLED_FINDING_CATEGORIES = [
  "correctness",
  "security",
  "performance",
  "test_coverage",
  "maintainability",
  "architecture",
  "dependency",
] as const satisfies readonly FindingCategory[];

/** Safety floor that repository settings cannot weaken. */
export const DEFAULT_SAFETY_FLOOR = {
  alwaysRequireEvidence: true,
  alwaysRequireLineAnchorForInlineComments: true,
  alwaysSuppressGeneratedFiles: false,
  maxAllowedCommentsPerReview: 10,
  minimumAllowedConfidence: 0.65,
  minimumPublishSeverity: "medium",
} as const satisfies SafetyFloorPolicy;

/** Default memory policy compiled into review policy snapshots. */
export const DEFAULT_MEMORY_POLICY = {
  allowExactFindingSuppression: true,
  allowNaturalLanguageInstructions: true,
  allowPathCategorySuppression: true,
  enableMemoryContext: true,
  enableMemorySuppression: true,
  maxMemoryFactsInContext: 6,
  memoryTtlDays: 180,
  requireApprovalForMemoryFacts: true,
  trustedFeedbackRoles: ["org_admin", "repo_admin", "maintainer"],
} as const satisfies EffectiveMemoryPolicy;

/** Default sandbox policy compiled into review policy snapshots. */
export const DEFAULT_SANDBOX_POLICY = {
  allowCustomCommands: false,
  allowDependencyInstall: false,
  allowNetwork: false,
  defaultRunner: "docker",
  enabled: true,
  maxArtifactBytes: 25_000_000,
  maxCpuCount: 2,
  maxMemoryBytes: 1_073_741_824,
  maxOutputBytes: 10_000_000,
  maxTimeoutMs: 45_000,
  minimumRunnerForForks: "gvisor",
} as const satisfies EffectiveSandboxPolicy;

/** Policy decision kinds emitted by the rule evaluator. */
export const PolicyDecisionTypeSchema = Type.Union([
  Type.Literal("should_review_pr"),
  Type.Literal("classify_path"),
  Type.Literal("should_publish_finding"),
  Type.Literal("publishing_mode"),
  Type.Literal("memory_allowed"),
]);

/** Policy decision kind emitted by the rule evaluator. */
export type PolicyDecisionType = Static<typeof PolicyDecisionTypeSchema>;

/** Trace object returned with each policy decision. */
export const PolicyDecisionTraceSchema = Type.Object(
  {
    schemaVersion: Type.Literal("policy_decision_trace.v1"),
    decisionType: PolicyDecisionTypeSchema,
    decision: Type.String({ minLength: 1 }),
    reasonCode: Type.String({ minLength: 1 }),
    matchedRuleIds: Type.Array(RepoRuleIdSchema),
    evaluatedRuleCount: Type.Integer({ minimum: 0 }),
    details: Type.Record(Type.String({ minLength: 1 }), Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Trace object returned with each policy decision. */
export type PolicyDecisionTrace = Static<typeof PolicyDecisionTraceSchema>;

/** Trigger settings compiled from repository settings. */
export const EffectiveTriggerPolicySchema = Type.Object(
  {
    enabledActions: Type.Array(Type.String({ minLength: 1 })),
    ignoredAuthors: Type.Array(Type.String()),
    ignoredLabels: Type.Array(Type.String()),
    requireLabel: Type.Optional(Type.String({ minLength: 1 })),
    skipDraftPullRequests: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Trigger settings compiled from repository settings. */
export type EffectiveTriggerPolicy = Static<typeof EffectiveTriggerPolicySchema>;

/** Path settings compiled from defaults and repository settings. */
export const EffectivePathPolicySchema = Type.Object(
  {
    configPaths: Type.Array(Type.String({ minLength: 1 })),
    documentationPaths: Type.Array(Type.String({ minLength: 1 })),
    generatedPaths: Type.Array(Type.String({ minLength: 1 })),
    ignoredPaths: Type.Array(Type.String({ minLength: 1 })),
    includedPaths: Type.Array(Type.String({ minLength: 1 })),
    maxFileBytes: Type.Integer({ minimum: 1 }),
    maxFileLines: Type.Integer({ minimum: 1 }),
    pathMatchingMode: Type.Literal("heimdall_glob_v1"),
    skipGeneratedFiles: Type.Boolean(),
    testPaths: Type.Array(Type.String({ minLength: 1 })),
    vendoredPaths: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Path settings compiled from defaults and repository settings. */
export type EffectivePathPolicy = Static<typeof EffectivePathPolicySchema>;

/** Finding validation and publication settings compiled from repository settings. */
export const EffectiveFindingPolicySchema = Type.Object(
  {
    allowStyleFindings: Type.Boolean(),
    enabledCategories: Type.Array(FindingCategorySchema),
    maxCommentsPerReview: Type.Integer({ minimum: 0 }),
    minimumConfidence: Type.Number({ minimum: 0, maximum: 1 }),
    severityThreshold: FindingSeveritySchema,
    suppressGeneratedFileFindings: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Finding validation and publication settings compiled from repository settings. */
export type EffectiveFindingPolicy = Static<typeof EffectiveFindingPolicySchema>;

/** Publishing settings derived from the repository review policy. */
export const EffectivePublishingPolicySchema = Type.Object(
  {
    maxCommentsPerReview: Type.Integer({ minimum: 0 }),
    publishCheckRun: Type.Boolean(),
    publishInlineComments: Type.Boolean(),
    publishSummaryComment: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Publishing settings derived from the repository review policy. */
export type EffectivePublishingPolicy = Static<typeof EffectivePublishingPolicySchema>;

/** Actor roles trusted to create or approve durable memory. */
export const TrustedMemoryActorRoleSchema = Type.Union([
  Type.Literal("org_admin"),
  Type.Literal("repo_admin"),
  Type.Literal("maintainer"),
  Type.Literal("member"),
]);

/** Actor role trusted to create or approve durable memory. */
export type TrustedMemoryActorRole = Static<typeof TrustedMemoryActorRoleSchema>;

/** Memory settings compiled into immutable review policy snapshots. */
export const EffectiveMemoryPolicySchema = Type.Object(
  {
    allowExactFindingSuppression: Type.Boolean(),
    allowNaturalLanguageInstructions: Type.Boolean(),
    allowPathCategorySuppression: Type.Boolean(),
    enableMemoryContext: Type.Boolean(),
    enableMemorySuppression: Type.Boolean(),
    maxMemoryFactsInContext: Type.Integer({ minimum: 0, maximum: 20 }),
    memoryTtlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    requireApprovalForMemoryFacts: Type.Boolean(),
    trustedFeedbackRoles: Type.Array(TrustedMemoryActorRoleSchema),
  },
  { additionalProperties: false },
);

/** Memory settings compiled into immutable review policy snapshots. */
export type EffectiveMemoryPolicy = Static<typeof EffectiveMemoryPolicySchema>;

/** Supported sandbox runners that policy can request for production review work. */
export const EffectiveSandboxRunnerSchema = Type.Union([
  Type.Literal("docker"),
  Type.Literal("gvisor"),
  Type.Literal("microvm"),
]);

/** Supported sandbox runner that policy can request for production review work. */
export type EffectiveSandboxRunner = Static<typeof EffectiveSandboxRunnerSchema>;

/** Minimum sandbox runner policy for untrusted forked pull requests. */
export const MinimumForkSandboxRunnerSchema = Type.Union([
  EffectiveSandboxRunnerSchema,
  Type.Literal("disabled"),
]);

/** Minimum sandbox runner policy for untrusted forked pull requests. */
export type MinimumForkSandboxRunner = Static<typeof MinimumForkSandboxRunnerSchema>;

/** Sandbox settings compiled into immutable review policy snapshots. */
export const EffectiveSandboxPolicySchema = Type.Object(
  {
    allowCustomCommands: Type.Boolean(),
    allowDependencyInstall: Type.Boolean(),
    allowNetwork: Type.Boolean(),
    defaultRunner: EffectiveSandboxRunnerSchema,
    enabled: Type.Boolean(),
    maxArtifactBytes: Type.Integer({ minimum: 0 }),
    maxCpuCount: Type.Integer({ minimum: 1 }),
    maxMemoryBytes: Type.Integer({ minimum: 1 }),
    maxOutputBytes: Type.Integer({ minimum: 0 }),
    maxTimeoutMs: Type.Integer({ minimum: 1 }),
    minimumRunnerForForks: MinimumForkSandboxRunnerSchema,
  },
  { additionalProperties: false },
);

/** Sandbox settings compiled into immutable review policy snapshots. */
export type EffectiveSandboxPolicy = Static<typeof EffectiveSandboxPolicySchema>;

/** Safety settings that clamp weaker repository-level settings. */
export const SafetyFloorPolicySchema = Type.Object(
  {
    alwaysRequireEvidence: Type.Boolean(),
    alwaysRequireLineAnchorForInlineComments: Type.Boolean(),
    alwaysSuppressGeneratedFiles: Type.Boolean(),
    maxAllowedCommentsPerReview: Type.Integer({ minimum: 0 }),
    minimumAllowedConfidence: Type.Number({ minimum: 0, maximum: 1 }),
    minimumPublishSeverity: FindingSeveritySchema,
  },
  { additionalProperties: false },
);

/** Safety settings that clamp weaker repository-level settings. */
export type SafetyFloorPolicy = Static<typeof SafetyFloorPolicySchema>;

/** Immutable policy consumed by review, validation, and publishing code. */
export const EffectiveReviewPolicySchema = Type.Object(
  {
    schemaVersion: Type.Literal("effective_review_policy.v1"),
    compilerVersion: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
    findings: EffectiveFindingPolicySchema,
    instructions: Type.Array(Type.String({ minLength: 1, maxLength: 8000 })),
    memory: EffectiveMemoryPolicySchema,
    paths: EffectivePathPolicySchema,
    publishing: EffectivePublishingPolicySchema,
    repoId: RepoIdSchema,
    reviewPolicy: ReviewPolicySchema,
    rules: Type.Array(RepoRuleSchema),
    sandbox: EffectiveSandboxPolicySchema,
    safetyFloor: SafetyFloorPolicySchema,
    trigger: EffectiveTriggerPolicySchema,
  },
  { additionalProperties: false },
);

/** Immutable policy consumed by review, validation, and publishing code. */
export type EffectiveReviewPolicy = Static<typeof EffectiveReviewPolicySchema>;

/** Active rule version summary captured in a policy snapshot. */
export const ActiveRuleVersionSchema = Type.Object(
  {
    ruleId: RepoRuleIdSchema,
    version: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Active rule version summary captured in a policy snapshot. */
export type ActiveRuleVersion = Static<typeof ActiveRuleVersionSchema>;

/** Immutable review policy snapshot stored with a review run. */
export const ReviewPolicySnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal("review_policy_snapshot.v1"),
    activeRuleVersions: Type.Array(ActiveRuleVersionSchema),
    createdAt: IsoDateTimeSchema,
    decisionInputs: Type.Object(
      {
        repositoryEnabled: Type.Boolean(),
        repositorySettingsUpdatedAt: IsoDateTimeSchema,
        source: Type.Literal("repository_settings"),
      },
      { additionalProperties: false },
    ),
    effectivePolicy: EffectiveReviewPolicySchema,
    orgId: OrgIdSchema,
    policyHash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    policySnapshotId: Type.String({ pattern: "^pol_[A-Za-z0-9_-]+$" }),
    repoId: RepoIdSchema,
    reviewRunId: Type.Optional(ReviewRunIdSchema),
    systemDefaultsVersion: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Immutable review policy snapshot stored with a review run. */
export type ReviewPolicySnapshot = Static<typeof ReviewPolicySnapshotSchema>;

/** Warning emitted when the policy compiler clamps or ignores unsafe input. */
export type PolicyWarning = {
  /** Stable warning code used by dashboards and tests. */
  readonly code: string;
  /** Human-readable warning text. */
  readonly message: string;
  /** Optional structured warning details. */
  readonly details?: Readonly<Record<string, unknown>>;
};

/** Optional telemetry dependencies used by rules and configuration evaluation. */
export type RulesTelemetryOptions = {
  /** Optional metric recorder for policy compilation and decision counters. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Optional trace context propagated from a request or durable job boundary. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe rules spans. */
  readonly traces?: TelemetrySpanRecorder | undefined;
};

/** Inputs required to compile a review policy snapshot. */
export type BuildReviewPolicySnapshotInput = RulesTelemetryOptions & {
  /** Repository identity and enablement state. */
  readonly repository: Pick<Repository, "enabled" | "orgId" | "repoId">;
  /** Repository settings row. Defaults are used when the row is missing. */
  readonly settings?: RepositorySettings;
  /** Active organization and repository rules. */
  readonly activeRules?: readonly RepoRule[];
  /** Optional sandbox policy overrides from higher-level settings or deployment defaults. */
  readonly sandboxPolicyOverrides?: Partial<EffectiveSandboxPolicy>;
  /** Review run that will consume the snapshot. */
  readonly reviewRunId?: string;
  /** Optional deterministic timestamp for tests. */
  readonly timestamp?: string;
};

/** Result returned by the policy snapshot compiler. */
export type BuildReviewPolicySnapshotResult = {
  /** Immutable policy snapshot. */
  readonly snapshot: ReviewPolicySnapshot;
  /** Non-fatal compiler warnings. */
  readonly warnings: readonly PolicyWarning[];
  /** Compiler trace with stable, non-secret inputs. */
  readonly trace: PolicyDecisionTrace;
};

/** Path classification input. */
export type ClassifyPathInput = RulesTelemetryOptions & {
  /** Policy that contains path matchers. */
  readonly policy: EffectiveReviewPolicy;
  /** Repository-relative path to classify. */
  readonly path: string;
  /** Optional file size in bytes. */
  readonly sizeBytes?: number;
  /** Optional file line count. */
  readonly lineCount?: number;
};

/** Deterministic path classification result. */
export type PathClassification = {
  /** Normalized repository-relative path. */
  readonly path: string;
  /** Whether the path passed the include policy. */
  readonly included: boolean;
  /** Whether the path is ignored by policy. */
  readonly ignored: boolean;
  /** Whether the path matches generated-code patterns. */
  readonly generated: boolean;
  /** Whether the path matches vendored-code patterns. */
  readonly vendored: boolean;
  /** Whether the path matches test patterns. */
  readonly test: boolean;
  /** Whether the path matches config patterns. */
  readonly config: boolean;
  /** Whether the path matches documentation patterns. */
  readonly documentation: boolean;
  /** Stable reason codes that explain the classification. */
  readonly reasonCodes: readonly string[];
  /** Glob patterns that matched the path. */
  readonly matchedPatterns: readonly string[];
  /** Trace for the path decision. */
  readonly trace: PolicyDecisionTrace;
};

/** Pull request input needed for a cheap trigger decision. */
export type ShouldReviewPrInput = RulesTelemetryOptions & {
  /** Policy used to decide whether review work should run. */
  readonly policy: EffectiveReviewPolicy;
  /** Pull request action from the webhook or manual trigger. */
  readonly action: string;
  /** Whether the pull request is currently a draft. */
  readonly isDraft?: boolean;
  /** Pull request labels. */
  readonly labels?: readonly string[];
  /** Pull request author login. */
  readonly authorLogin?: string;
};

/** Cheap trigger decision used before enqueueing review work. */
export type ShouldReviewPrDecision = {
  /** Whether the PR should be reviewed. */
  readonly shouldReview: boolean;
  /** Repository review policy mode that shaped the decision. */
  readonly reviewPolicy: ReviewPolicy;
  /** Stable reason code for the decision. */
  readonly reasonCode: string;
  /** Trace for the trigger decision. */
  readonly trace: PolicyDecisionTrace;
};

/** Candidate finding input needed for policy validation. */
export type EvaluateFindingPolicyInput = RulesTelemetryOptions & {
  /** Policy used to evaluate the finding. */
  readonly policy: EffectiveReviewPolicy;
  /** Finding to evaluate. */
  readonly finding: Pick<
    CandidateFinding,
    "body" | "category" | "confidence" | "evidence" | "location" | "severity" | "title"
  >;
  /** Optional precomputed path classification. */
  readonly pathClassification?: PathClassification;
};

/** Candidate finding policy decision. */
export type FindingPolicyDecision = {
  /** Whether the finding may be published. */
  readonly shouldPublish: boolean;
  /** Stable reason code for the decision. */
  readonly reasonCode: string;
  /** Optional severity after policy downgrades. */
  readonly severity: FindingSeverity;
  /** Trace for the finding decision. */
  readonly trace: PolicyDecisionTrace;
};

/** Publishing mode decision for a completed review run. */
export type PublishingPolicyDecision = {
  /** Whether to publish or update a check run. */
  readonly publishCheckRun: boolean;
  /** Whether to publish inline comments. */
  readonly publishInlineComments: boolean;
  /** Whether to publish a summary comment. */
  readonly publishSummaryComment: boolean;
  /** Maximum number of inline comments allowed by policy. */
  readonly maxInlineComments: number;
  /** Stable reason code for the publishing mode. */
  readonly reasonCode: string;
  /** Trace for the publishing decision. */
  readonly trace: PolicyDecisionTrace;
};

/** Memory action evaluated by the policy layer. */
export type MemoryPolicyAction =
  | "context"
  | "create_fact"
  | "suppress_exact_finding"
  | "suppress_path_category"
  | "natural_language_instruction";

/** Input for checking whether memory may influence review behavior. */
export type EvaluateMemoryPolicyInput = RulesTelemetryOptions & {
  /** Policy used to evaluate the memory action. */
  readonly policy: EffectiveReviewPolicy;
  /** Memory action being considered. */
  readonly action: MemoryPolicyAction;
  /** Actor role for feedback-derived memory creation. */
  readonly actorRole?: TrustedMemoryActorRole | undefined;
};

/** Decision for a memory action under repository policy. */
export type MemoryPolicyDecision = {
  /** Whether the memory action is allowed. */
  readonly allowed: boolean;
  /** Stable reason code for the decision. */
  readonly reasonCode: string;
  /** Whether the memory action requires dashboard or admin approval. */
  readonly requiresApproval: boolean;
  /** Maximum number of memory facts allowed in retrieval context. */
  readonly maxFactsInContext: number;
  /** Trace for the memory decision. */
  readonly trace: PolicyDecisionTrace;
};

/** Nested policy fixture overrides for unit tests and local rule testing. */
export type PolicyFixtureOverrides = Omit<
  Partial<EffectiveReviewPolicy>,
  "findings" | "memory" | "paths" | "publishing" | "safetyFloor" | "sandbox" | "trigger"
> & {
  /** Optional finding-policy overrides. */
  readonly findings?: Partial<EffectiveFindingPolicy>;
  /** Optional memory-policy overrides. */
  readonly memory?: Partial<EffectiveMemoryPolicy>;
  /** Optional path-policy overrides. */
  readonly paths?: Partial<EffectivePathPolicy>;
  /** Optional publishing-policy overrides. */
  readonly publishing?: Partial<EffectivePublishingPolicy>;
  /** Optional sandbox-policy overrides. */
  readonly sandbox?: Partial<EffectiveSandboxPolicy>;
  /** Optional safety-floor overrides. */
  readonly safetyFloor?: Partial<SafetyFloorPolicy>;
  /** Optional trigger-policy overrides. */
  readonly trigger?: Partial<EffectiveTriggerPolicy>;
};

/** Creates repository settings with product defaults and deterministic timestamps. */
export function createDefaultRepositorySettings(
  repoId: string,
  timestamp = new Date().toISOString(),
): RepositorySettings {
  return {
    repoId,
    reviewPolicy: DEFAULT_REPOSITORY_SETTINGS.reviewPolicy,
    severityThreshold: DEFAULT_REPOSITORY_SETTINGS.severityThreshold,
    maxCommentsPerReview: DEFAULT_REPOSITORY_SETTINGS.maxCommentsPerReview,
    ignoredPaths: [...DEFAULT_REPOSITORY_SETTINGS.ignoredPaths],
    ignoredAuthors: [...DEFAULT_REPOSITORY_SETTINGS.ignoredAuthors],
    ignoredLabels: [...DEFAULT_REPOSITORY_SETTINGS.ignoredLabels],
    skipGeneratedFiles: DEFAULT_REPOSITORY_SETTINGS.skipGeneratedFiles,
    skipDraftPullRequests: DEFAULT_REPOSITORY_SETTINGS.skipDraftPullRequests,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies RepositorySettings;
}

/** Compiles repository settings and active rules into an immutable policy snapshot. */
export function buildReviewPolicySnapshot(
  input: BuildReviewPolicySnapshotInput,
): BuildReviewPolicySnapshotResult {
  const startedAtMs = Date.now();
  const span = startRulesSpan(input, OBSERVABILITY_SPAN_NAMES.rulesCompilePolicy, {
    "rules.active_rule_input_count": input.activeRules?.length ?? 0,
    "rules.repository_enabled": input.repository.enabled,
    "rules.review_run_attached": Boolean(input.reviewRunId),
    "rules.settings_provided": Boolean(input.settings),
  });

  try {
    const result = buildReviewPolicySnapshotCore(input);
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    recordRulesPolicyCompilationMetrics(input, result, "compiled", durationMs);
    span?.end({
      attributes: {
        "rules.active_rule_count": result.snapshot.activeRuleVersions.length,
        "rules.review_policy": result.snapshot.effectivePolicy.reviewPolicy,
        "rules.warning_count": result.warnings.length,
      },
      status: "ok",
    });

    return result;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    recordRulesPolicyCompilationMetrics(input, undefined, "failed", durationMs);
    span?.end({
      attributes: {
        "rules.status": "failed",
      },
      error,
      status: "error",
    });
    throw error;
  }
}

/** Compiles repository settings without telemetry side effects. */
function buildReviewPolicySnapshotCore(
  input: BuildReviewPolicySnapshotInput,
): BuildReviewPolicySnapshotResult {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const settings =
    input.settings ?? createDefaultRepositorySettings(input.repository.repoId, timestamp);
  const activeRules = (input.activeRules ?? [])
    .filter((rule) => rule.enabled)
    .filter((rule) => !ruleExpired(rule, timestamp))
    .filter((rule) => rule.orgId === input.repository.orgId)
    .filter((rule) => !rule.repoId || rule.repoId === input.repository.repoId)
    .sort(
      (left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId),
    );
  const warnings: PolicyWarning[] = [];
  const safetyFloor = DEFAULT_SAFETY_FLOOR;
  const severityThreshold = stricterSeverity(
    settings.severityThreshold,
    safetyFloor.minimumPublishSeverity,
  );
  const maxCommentsPerReview = Math.min(
    Math.max(0, settings.maxCommentsPerReview),
    safetyFloor.maxAllowedCommentsPerReview,
  );

  if (severityThreshold !== settings.severityThreshold) {
    warnings.push({
      code: "severity_clamped_by_safety_floor",
      message: "Repository severity threshold was clamped by the safety floor.",
      details: {
        requested: settings.severityThreshold,
        effective: severityThreshold,
      },
    });
  }

  if (maxCommentsPerReview !== settings.maxCommentsPerReview) {
    warnings.push({
      code: "comment_budget_clamped_by_safety_floor",
      message: "Repository comment budget was clamped by the safety floor.",
      details: {
        requested: settings.maxCommentsPerReview,
        effective: maxCommentsPerReview,
      },
    });
  }

  const sandbox = compileSandboxPolicy(
    { ...(settings.sandboxPolicy ?? {}), ...(input.sandboxPolicyOverrides ?? {}) },
    warnings,
  );
  const effectivePolicy = parseEffectiveReviewPolicy({
    schemaVersion: "effective_review_policy.v1",
    compilerVersion: RULES_ENGINE_VERSION,
    enabled: input.repository.enabled && settings.reviewPolicy !== "disabled",
    findings: {
      allowStyleFindings: activeRules.some((rule) => rule.effect === "style_preference"),
      enabledCategories: [...DEFAULT_ENABLED_FINDING_CATEGORIES],
      maxCommentsPerReview,
      minimumConfidence: safetyFloor.minimumAllowedConfidence,
      severityThreshold,
      suppressGeneratedFileFindings:
        settings.skipGeneratedFiles || safetyFloor.alwaysSuppressGeneratedFiles,
    },
    instructions: activeRules
      .filter((rule) => rule.effect === "context" || rule.effect === "style_preference")
      .map((rule) => rule.instruction),
    memory: DEFAULT_MEMORY_POLICY,
    paths: {
      configPaths: [...DEFAULT_CONFIG_PATHS],
      documentationPaths: [...DEFAULT_DOCUMENTATION_PATHS],
      generatedPaths: [...DEFAULT_GENERATED_PATHS],
      ignoredPaths: uniqueStrings([...DEFAULT_IGNORED_PATHS, ...settings.ignoredPaths]),
      includedPaths: [],
      maxFileBytes: 512_000,
      maxFileLines: 10_000,
      pathMatchingMode: "heimdall_glob_v1",
      skipGeneratedFiles: settings.skipGeneratedFiles,
      testPaths: [...DEFAULT_TEST_PATHS],
      vendoredPaths: ["**/vendor/**", "**/third_party/**"],
    },
    publishing: publishingPolicyFromReviewPolicy(settings.reviewPolicy, maxCommentsPerReview),
    repoId: input.repository.repoId,
    reviewPolicy: settings.reviewPolicy,
    rules: activeRules,
    sandbox,
    safetyFloor,
    trigger: {
      enabledActions: [...DEFAULT_ENABLED_PR_ACTIONS],
      ignoredAuthors: [...settings.ignoredAuthors],
      ignoredLabels: [...settings.ignoredLabels],
      ...(settings.requireLabel ? { requireLabel: settings.requireLabel } : {}),
      skipDraftPullRequests: settings.skipDraftPullRequests,
    },
  });
  const policyHash = sha256(canonicalJson(effectivePolicy));
  const snapshot = parseReviewPolicySnapshot({
    schemaVersion: "review_policy_snapshot.v1",
    activeRuleVersions: activeRules.map((rule) => ({
      ruleId: rule.ruleId,
      version: rule.updatedAt,
    })),
    createdAt: timestamp,
    decisionInputs: {
      repositoryEnabled: input.repository.enabled,
      repositorySettingsUpdatedAt: settings.updatedAt,
      source: "repository_settings",
    },
    effectivePolicy,
    orgId: input.repository.orgId,
    policyHash,
    policySnapshotId: stableId("pol", [
      input.repository.orgId,
      input.repository.repoId,
      input.reviewRunId ?? "preview",
      policyHash,
    ]),
    repoId: input.repository.repoId,
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    systemDefaultsVersion: RULES_ENGINE_VERSION,
  });

  return {
    snapshot,
    warnings,
    trace: policyTrace({
      decisionType: "should_review_pr",
      decision: "compiled",
      reasonCode: warnings.length === 0 ? "compiled_without_warnings" : "compiled_with_warnings",
      matchedRuleIds: activeRules.map((rule) => rule.ruleId),
      evaluatedRuleCount: activeRules.length,
      details: {
        policyHash,
        sandboxRunner: sandbox.defaultRunner,
        warningCodes: warnings.map((warning) => warning.code),
      },
    }),
  };
}

/** Normalizes and validates a repository-relative path or glob-like path pattern. */
export function normalizeRepoPath(input: string): string {
  const normalized = normalizePathLike(input);
  if (normalized.includes("*") || normalized.includes("?")) {
    throw new Error(`Repository path ${input} must not contain glob tokens.`);
  }

  return normalized;
}

/** Returns whether a repository-relative path matches at least one glob pattern. */
export function matchesAnyPathPattern(path: string, patterns: readonly string[]): boolean {
  const normalizedPath = normalizeRepoPath(path);
  return patterns.some((pattern) => compileGlobPattern(pattern).test(normalizedPath));
}

/** Classifies a path with the compiled path policy. */
export function classifyPath(input: ClassifyPathInput): PathClassification {
  const span = startRulesSpan(input, OBSERVABILITY_SPAN_NAMES.rulesEvaluatePath, {
    "rules.decision_type": "classify_path",
    "rules.line_count_provided": input.lineCount !== undefined,
    "rules.size_provided": input.sizeBytes !== undefined,
  });

  try {
    const result = classifyPathCore(input);
    recordRulesDecisionTelemetry(input, result.trace);
    span?.end({
      attributes: {
        "rules.action": result.trace.decision,
        "rules.generated": result.generated,
        "rules.ignored": result.ignored,
        "rules.matched_pattern_count": result.matchedPatterns.length,
        "rules.reason": result.trace.reasonCode,
      },
      status: "ok",
    });

    return result;
  } catch (error) {
    span?.end({
      attributes: {
        "rules.status": "failed",
      },
      error,
      status: "error",
    });
    throw error;
  }
}

/** Classifies a path without telemetry side effects. */
function classifyPathCore(input: ClassifyPathInput): PathClassification {
  const path = normalizeRepoPath(input.path);
  const policy = input.policy.paths;
  const matchedPatterns: string[] = [];
  const includedMatches = collectMatchingPatterns(path, policy.includedPaths);
  const ignoredMatches = collectMatchingPatterns(path, policy.ignoredPaths);
  const generatedMatches = collectMatchingPatterns(path, policy.generatedPaths);
  const vendoredMatches = collectMatchingPatterns(path, policy.vendoredPaths);
  const testMatches = collectMatchingPatterns(path, policy.testPaths);
  const configMatches = collectMatchingPatterns(path, policy.configPaths);
  const documentationMatches = collectMatchingPatterns(path, policy.documentationPaths);
  const included = policy.includedPaths.length === 0 || includedMatches.length > 0;
  const fileTooLarge = input.sizeBytes !== undefined && input.sizeBytes > policy.maxFileBytes;
  const lineCountTooLarge = input.lineCount !== undefined && input.lineCount > policy.maxFileLines;
  const generated = generatedMatches.length > 0;
  const vendored = vendoredMatches.length > 0;
  const ignored =
    !included ||
    ignoredMatches.length > 0 ||
    (policy.skipGeneratedFiles && generated) ||
    fileTooLarge ||
    lineCountTooLarge;
  const reasonCodes = [
    ...(!included ? ["path_not_included"] : []),
    ...(ignoredMatches.length > 0 ? ["path_ignored"] : []),
    ...(policy.skipGeneratedFiles && generated ? ["generated_file"] : []),
    ...(fileTooLarge ? ["file_too_large"] : []),
    ...(lineCountTooLarge ? ["line_count_too_large"] : []),
  ];

  matchedPatterns.push(
    ...includedMatches,
    ...ignoredMatches,
    ...generatedMatches,
    ...vendoredMatches,
    ...testMatches,
    ...configMatches,
    ...documentationMatches,
  );

  return {
    path,
    included,
    ignored,
    generated,
    vendored,
    test: testMatches.length > 0,
    config: configMatches.length > 0,
    documentation: documentationMatches.length > 0,
    reasonCodes: uniqueStrings(reasonCodes),
    matchedPatterns: uniqueStrings(matchedPatterns),
    trace: policyTrace({
      decisionType: "classify_path",
      decision: ignored ? "ignored" : "included",
      reasonCode: reasonCodes[0] ?? "included",
      matchedRuleIds: [],
      evaluatedRuleCount: input.policy.rules.length,
      details: { matchedPatterns: uniqueStrings(matchedPatterns), path },
    }),
  };
}

/** Decides whether a pull request should be reviewed. */
export function shouldReviewPr(input: ShouldReviewPrInput): ShouldReviewPrDecision {
  const span = startRulesSpan(input, OBSERVABILITY_SPAN_NAMES.rulesEvaluateTrigger, {
    "rules.decision_type": "should_review_pr",
    "rules.pr_action": sanitizeRulesTelemetryLabel(input.action),
  });

  try {
    const result = shouldReviewPrCore(input);
    recordRulesDecisionTelemetry(input, result.trace);
    span?.end({
      attributes: {
        "rules.action": result.trace.decision,
        "rules.reason": result.reasonCode,
        "rules.review_policy": result.reviewPolicy,
        "rules.should_review": result.shouldReview,
      },
      status: "ok",
    });

    return result;
  } catch (error) {
    span?.end({
      attributes: {
        "rules.status": "failed",
      },
      error,
      status: "error",
    });
    throw error;
  }
}

/** Decides whether a pull request should be reviewed without telemetry side effects. */
function shouldReviewPrCore(input: ShouldReviewPrInput): ShouldReviewPrDecision {
  const labels = new Set((input.labels ?? []).map(normalizeComparable));
  const ignoredLabels = input.policy.trigger.ignoredLabels.map(normalizeComparable);
  const ignoredAuthors = input.policy.trigger.ignoredAuthors.map(normalizeComparable);
  const matchedIgnoredLabel = ignoredLabels.find((label) => labels.has(label));
  const author = input.authorLogin ? normalizeComparable(input.authorLogin) : undefined;
  const reviewPolicy = input.policy.reviewPolicy;
  let decision = true;
  let reasonCode = "allowed";

  if (!input.policy.enabled) {
    decision = false;
    reasonCode = reviewPolicy === "disabled" ? "review_policy_disabled" : "repo_disabled";
  } else if (!input.policy.trigger.enabledActions.includes(input.action)) {
    decision = false;
    reasonCode = "event_not_enabled";
  } else if (input.isDraft && input.policy.trigger.skipDraftPullRequests) {
    decision = false;
    reasonCode = "draft_pr_skipped";
  } else if (
    input.policy.trigger.requireLabel &&
    !labels.has(normalizeComparable(input.policy.trigger.requireLabel))
  ) {
    decision = false;
    reasonCode = "missing_required_label";
  } else if (matchedIgnoredLabel) {
    decision = false;
    reasonCode = "blocked_label_present";
  } else if (author && ignoredAuthors.includes(author)) {
    decision = false;
    reasonCode = "author_excluded";
  }

  return {
    shouldReview: decision,
    reviewPolicy,
    reasonCode,
    trace: policyTrace({
      decisionType: "should_review_pr",
      decision: decision ? "review" : "skip",
      reasonCode,
      matchedRuleIds: [],
      evaluatedRuleCount: input.policy.rules.length,
      details: {
        action: input.action,
        labels: [...labels],
        matchedIgnoredLabel,
      },
    }),
  };
}

/** Evaluates whether a candidate finding may be published under policy. */
export function evaluateFindingPolicy(input: EvaluateFindingPolicyInput): FindingPolicyDecision {
  const span = startRulesSpan(input, OBSERVABILITY_SPAN_NAMES.rulesEvaluateFinding, {
    "rules.decision_type": "should_publish_finding",
    "rules.finding_category": input.finding.category,
    "rules.finding_severity": input.finding.severity,
  });

  try {
    const result = evaluateFindingPolicyCore(input);
    recordRulesDecisionTelemetry(input, result.trace);
    span?.end({
      attributes: {
        "rules.action": result.trace.decision,
        "rules.matched_rule_count": result.trace.matchedRuleIds.length,
        "rules.reason": result.reasonCode,
        "rules.should_publish": result.shouldPublish,
      },
      status: "ok",
    });

    return result;
  } catch (error) {
    span?.end({
      attributes: {
        "rules.status": "failed",
      },
      error,
      status: "error",
    });
    throw error;
  }
}

/** Evaluates whether a candidate finding may be published without telemetry side effects. */
function evaluateFindingPolicyCore(input: EvaluateFindingPolicyInput): FindingPolicyDecision {
  const finding = input.finding;
  const classification =
    input.pathClassification ??
    classifyPath({
      policy: input.policy,
      path: finding.location.path,
      ...(input.metrics ? { metrics: input.metrics } : {}),
      ...(input.traceContext ? { traceContext: input.traceContext } : {}),
      ...(input.traces ? { traces: input.traces } : {}),
    });
  const matchedRuleIds = matchingSuppressionRuleIds(input.policy, finding);
  let shouldPublish = true;
  let reasonCode = "allowed";

  if (!input.policy.enabled) {
    shouldPublish = false;
    reasonCode = "review_disabled";
  } else if (classification.ignored) {
    shouldPublish = false;
    reasonCode = classification.generated ? "generated_file" : "path_ignored";
  } else if (
    classification.generated &&
    (input.policy.findings.suppressGeneratedFileFindings ||
      input.policy.safetyFloor.alwaysSuppressGeneratedFiles)
  ) {
    shouldPublish = false;
    reasonCode = "generated_file";
  } else if (finding.evidence.length === 0 && input.policy.safetyFloor.alwaysRequireEvidence) {
    shouldPublish = false;
    reasonCode = "missing_evidence";
  } else if (finding.confidence < input.policy.findings.minimumConfidence) {
    shouldPublish = false;
    reasonCode = "confidence_below_threshold";
  } else if (
    severityRank(finding.severity) < severityRank(input.policy.findings.severityThreshold)
  ) {
    shouldPublish = false;
    reasonCode = "severity_below_threshold";
  } else if (!input.policy.findings.enabledCategories.includes(finding.category)) {
    shouldPublish = false;
    reasonCode = "category_disabled";
  } else if (finding.category === "style" && !input.policy.findings.allowStyleFindings) {
    shouldPublish = false;
    reasonCode = "style_disabled";
  } else if (matchedRuleIds.length > 0) {
    shouldPublish = false;
    reasonCode = "suppressed_by_repo_rule";
  }

  return {
    shouldPublish,
    reasonCode,
    severity: finding.severity,
    trace: policyTrace({
      decisionType: "should_publish_finding",
      decision: shouldPublish ? "publish" : "suppress",
      reasonCode,
      matchedRuleIds,
      evaluatedRuleCount: input.policy.rules.length,
      details: {
        category: finding.category,
        confidence: finding.confidence,
        path: classification.path,
        severity: finding.severity,
      },
    }),
  };
}

/** Returns the publishing mode enabled by a compiled policy. */
export function getPublishingPolicyDecision(
  policy: EffectiveReviewPolicy,
  telemetry: RulesTelemetryOptions = {},
): PublishingPolicyDecision {
  const result = getPublishingPolicyDecisionCore(policy);
  recordRulesDecisionTelemetry(telemetry, result.trace);

  return result;
}

/** Returns the publishing mode decision without telemetry side effects. */
function getPublishingPolicyDecisionCore(policy: EffectiveReviewPolicy): PublishingPolicyDecision {
  const publishing = policy.enabled
    ? policy.publishing
    : {
        maxCommentsPerReview: 0,
        publishCheckRun: false,
        publishInlineComments: false,
        publishSummaryComment: false,
      };
  const hasOutput =
    publishing.publishCheckRun ||
    publishing.publishInlineComments ||
    publishing.publishSummaryComment;

  return {
    publishCheckRun: publishing.publishCheckRun,
    publishInlineComments: publishing.publishInlineComments,
    publishSummaryComment: publishing.publishSummaryComment,
    maxInlineComments: publishing.maxCommentsPerReview,
    reasonCode: hasOutput ? "publishing_enabled" : "publishing_disabled",
    trace: policyTrace({
      decisionType: "publishing_mode",
      decision: hasOutput ? "publish" : "skip",
      reasonCode: hasOutput ? "publishing_enabled" : "publishing_disabled",
      matchedRuleIds: [],
      evaluatedRuleCount: policy.rules.length,
      details: { reviewPolicy: policy.reviewPolicy },
    }),
  };
}

/** Evaluates whether a memory action is allowed by the compiled policy. */
export function evaluateMemoryPolicy(input: EvaluateMemoryPolicyInput): MemoryPolicyDecision {
  const memory = input.policy.memory;
  let allowed = true;
  let reasonCode = "memory_allowed";

  if (!input.policy.enabled) {
    allowed = false;
    reasonCode = "review_disabled";
  } else if (input.action === "context" && !memory.enableMemoryContext) {
    allowed = false;
    reasonCode = "memory_context_disabled";
  } else if (
    input.action !== "context" &&
    input.action !== "create_fact" &&
    !memory.enableMemorySuppression
  ) {
    allowed = false;
    reasonCode = "memory_suppression_disabled";
  } else if (input.action === "suppress_exact_finding" && !memory.allowExactFindingSuppression) {
    allowed = false;
    reasonCode = "exact_suppression_disabled";
  } else if (input.action === "suppress_path_category" && !memory.allowPathCategorySuppression) {
    allowed = false;
    reasonCode = "path_category_suppression_disabled";
  } else if (
    input.action === "natural_language_instruction" &&
    !memory.allowNaturalLanguageInstructions
  ) {
    allowed = false;
    reasonCode = "natural_language_memory_disabled";
  } else if (
    input.action === "create_fact" &&
    (!input.actorRole || !memory.trustedFeedbackRoles.includes(input.actorRole))
  ) {
    allowed = false;
    reasonCode = "actor_not_trusted_for_memory";
  }

  const result = {
    allowed,
    maxFactsInContext: memory.enableMemoryContext ? memory.maxMemoryFactsInContext : 0,
    reasonCode,
    requiresApproval: input.action === "create_fact" && memory.requireApprovalForMemoryFacts,
    trace: policyTrace({
      decisionType: "memory_allowed",
      decision: allowed ? "allow" : "deny",
      reasonCode,
      matchedRuleIds: [],
      evaluatedRuleCount: input.policy.rules.length,
      details: {
        action: input.action,
        actorRole: input.actorRole,
        maxFactsInContext: memory.enableMemoryContext ? memory.maxMemoryFactsInContext : 0,
        requiresApproval: input.action === "create_fact" && memory.requireApprovalForMemoryFacts,
      },
    }),
  };

  recordRulesDecisionTelemetry(input, result.trace);

  return result;
}

/** Creates a valid policy fixture for unit tests and local rule testing. */
export function createPolicyFixture(overrides: PolicyFixtureOverrides = {}): EffectiveReviewPolicy {
  const base = buildReviewPolicySnapshot({
    repository: {
      enabled: true,
      orgId: "org_01HXAMPLE",
      repoId: "repo_01HXAMPLE",
    },
    timestamp: "2026-01-01T00:00:00.000Z",
  }).snapshot.effectivePolicy;
  const findings = { ...base.findings, ...overrides.findings };
  const publishing =
    overrides.publishing || !overrides.reviewPolicy
      ? { ...base.publishing, ...overrides.publishing }
      : publishingPolicyFromReviewPolicy(overrides.reviewPolicy, findings.maxCommentsPerReview);

  return parseEffectiveReviewPolicy({
    ...base,
    ...overrides,
    findings,
    memory: { ...base.memory, ...overrides.memory },
    paths: { ...base.paths, ...overrides.paths },
    publishing,
    sandbox: { ...base.sandbox, ...overrides.sandbox },
    safetyFloor: { ...base.safetyFloor, ...overrides.safetyFloor },
    trigger: { ...base.trigger, ...overrides.trigger },
  });
}

/** Creates a valid PR trigger input fixture for unit tests and local rule testing. */
export function createPrInputFixture(
  overrides: Partial<Omit<ShouldReviewPrInput, "policy">> & {
    /** Optional policy override for the fixture. */
    readonly policy?: EffectiveReviewPolicy;
  } = {},
): ShouldReviewPrInput {
  return {
    policy: overrides.policy ?? createPolicyFixture(),
    action: overrides.action ?? "opened",
    isDraft: overrides.isDraft ?? false,
    labels: overrides.labels ?? ["ready-for-review"],
    authorLogin: overrides.authorLogin ?? "octocat",
  };
}

/** Creates a valid finding policy input fixture for unit tests and local rule testing. */
export function createFindingInputFixture(
  overrides: Partial<Omit<EvaluateFindingPolicyInput, "finding" | "policy">> & {
    /** Optional policy override for the fixture. */
    readonly policy?: EffectiveReviewPolicy;
    /** Optional finding override for the fixture. */
    readonly finding?: Partial<EvaluateFindingPolicyInput["finding"]>;
  } = {},
): EvaluateFindingPolicyInput {
  return {
    policy: overrides.policy ?? createPolicyFixture(),
    finding: {
      body: "The changed line can return NaN.",
      category: "correctness",
      confidence: 0.82,
      evidence: [
        {
          evidenceId: "ev_01HXAMPLE",
          kind: "diff",
          summary: "The changed line coerces both inputs with Number().",
          confidence: 0.82,
        },
      ],
      location: { path: "src/math.ts", line: 2, side: "RIGHT", isInDiff: true },
      severity: "medium",
      title: "Handle non-finite numeric inputs",
      ...overrides.finding,
    },
    ...(overrides.pathClassification ? { pathClassification: overrides.pathClassification } : {}),
  };
}

/** Parses an unknown value as an effective review policy. */
export function parseEffectiveReviewPolicy(value: unknown): EffectiveReviewPolicy {
  if (!Value.Check(EffectiveReviewPolicySchema, value)) {
    throw new Error("Effective review policy does not match the schema.");
  }

  return value as EffectiveReviewPolicy;
}

/** Parses an unknown value as a review policy snapshot. */
export function parseReviewPolicySnapshot(value: unknown): ReviewPolicySnapshot {
  if (!Value.Check(ReviewPolicySnapshotSchema, value)) {
    throw new Error("Review policy snapshot does not match the schema.");
  }

  return value as ReviewPolicySnapshot;
}

/** Converts a review policy mode into publishing booleans. */
function publishingPolicyFromReviewPolicy(
  reviewPolicy: ReviewPolicy,
  maxCommentsPerReview: number,
): EffectivePublishingPolicy {
  const base = { maxCommentsPerReview };

  switch (reviewPolicy) {
    case "disabled":
      return {
        ...base,
        publishCheckRun: false,
        publishInlineComments: false,
        publishSummaryComment: false,
      };
    case "summary_only":
      return {
        ...base,
        publishCheckRun: false,
        publishInlineComments: false,
        publishSummaryComment: true,
      };
    case "inline_comments":
      return {
        ...base,
        publishCheckRun: false,
        publishInlineComments: true,
        publishSummaryComment: false,
      };
    case "inline_comments_and_summary":
      return {
        ...base,
        publishCheckRun: false,
        publishInlineComments: true,
        publishSummaryComment: true,
      };
    case "check_run_only":
      return {
        ...base,
        publishCheckRun: true,
        publishInlineComments: false,
        publishSummaryComment: false,
      };
    case "inline_comments_summary_and_check_run":
      return {
        ...base,
        publishCheckRun: true,
        publishInlineComments: true,
        publishSummaryComment: true,
      };
  }
}

/** Compiles sandbox settings with MVP safety clamps. */
function compileSandboxPolicy(
  overrides: Partial<EffectiveSandboxPolicy>,
  warnings: PolicyWarning[],
): EffectiveSandboxPolicy {
  const requestedNetwork = overrides.allowNetwork ?? DEFAULT_SANDBOX_POLICY.allowNetwork;
  const requestedDependencyInstall =
    overrides.allowDependencyInstall ?? DEFAULT_SANDBOX_POLICY.allowDependencyInstall;
  const requestedCustomCommands =
    overrides.allowCustomCommands ?? DEFAULT_SANDBOX_POLICY.allowCustomCommands;

  if (requestedNetwork) {
    warnings.push({
      code: "sandbox_network_disabled_by_mvp_policy",
      message: "Sandbox network access was disabled by the MVP safety policy.",
    });
  }
  if (requestedDependencyInstall) {
    warnings.push({
      code: "sandbox_dependency_install_disabled_by_mvp_policy",
      message: "Sandbox dependency installation was disabled by the MVP safety policy.",
    });
  }
  if (requestedCustomCommands) {
    warnings.push({
      code: "sandbox_custom_commands_disabled_by_mvp_policy",
      message: "Sandbox custom commands were disabled by the MVP safety policy.",
    });
  }

  return {
    allowCustomCommands: false,
    allowDependencyInstall: false,
    allowNetwork: false,
    defaultRunner: overrides.defaultRunner ?? DEFAULT_SANDBOX_POLICY.defaultRunner,
    enabled: overrides.enabled ?? DEFAULT_SANDBOX_POLICY.enabled,
    maxArtifactBytes: clampedSandboxLimit({
      defaultValue: DEFAULT_SANDBOX_POLICY.maxArtifactBytes,
      field: "maxArtifactBytes",
      maximum: 50_000_000,
      minimum: 0,
      requested: overrides.maxArtifactBytes,
      warnings,
    }),
    maxCpuCount: clampedSandboxLimit({
      defaultValue: DEFAULT_SANDBOX_POLICY.maxCpuCount,
      field: "maxCpuCount",
      maximum: 4,
      minimum: 1,
      requested: overrides.maxCpuCount,
      warnings,
    }),
    maxMemoryBytes: clampedSandboxLimit({
      defaultValue: DEFAULT_SANDBOX_POLICY.maxMemoryBytes,
      field: "maxMemoryBytes",
      maximum: 4_294_967_296,
      minimum: 1,
      requested: overrides.maxMemoryBytes,
      warnings,
    }),
    maxOutputBytes: clampedSandboxLimit({
      defaultValue: DEFAULT_SANDBOX_POLICY.maxOutputBytes,
      field: "maxOutputBytes",
      maximum: 25_000_000,
      minimum: 0,
      requested: overrides.maxOutputBytes,
      warnings,
    }),
    maxTimeoutMs: clampedSandboxLimit({
      defaultValue: DEFAULT_SANDBOX_POLICY.maxTimeoutMs,
      field: "maxTimeoutMs",
      maximum: 120_000,
      minimum: 1,
      requested: overrides.maxTimeoutMs,
      warnings,
    }),
    minimumRunnerForForks:
      overrides.minimumRunnerForForks ?? DEFAULT_SANDBOX_POLICY.minimumRunnerForForks,
  };
}

/** Input for sandbox limit clamping. */
type SandboxLimitClampInput = {
  /** Default value used when no override was supplied. */
  readonly defaultValue: number;
  /** Policy field being clamped. */
  readonly field: keyof Pick<
    EffectiveSandboxPolicy,
    "maxArtifactBytes" | "maxCpuCount" | "maxMemoryBytes" | "maxOutputBytes" | "maxTimeoutMs"
  >;
  /** Maximum value allowed by the MVP safety policy. */
  readonly maximum: number;
  /** Minimum value allowed by the policy schema. */
  readonly minimum: number;
  /** Requested override when available. */
  readonly requested?: number | undefined;
  /** Mutable warning accumulator for the current compiler run. */
  readonly warnings: PolicyWarning[];
};

/** Clamps one numeric sandbox policy limit and records a warning when it changes. */
function clampedSandboxLimit(input: SandboxLimitClampInput): number {
  const requested = input.requested ?? input.defaultValue;
  const clamped = Math.min(input.maximum, Math.max(input.minimum, Math.floor(requested)));
  if (clamped !== requested) {
    input.warnings.push({
      code: `sandbox_${input.field}_clamped`,
      message: "Sandbox limit was clamped by the MVP safety policy.",
      details: {
        effective: clamped,
        field: input.field,
        requested,
      },
    });
  }

  return clamped;
}

/** Returns the stricter severity according to finding severity ranking. */
function stricterSeverity(left: FindingSeverity, right: FindingSeverity): FindingSeverity {
  return severityRank(left) >= severityRank(right) ? left : right;
}

/** Returns the numeric order for finding severities. */
function severityRank(severity: FindingSeverity): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity];
}

/** Returns unique strings while preserving first occurrence order. */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Normalizes a path-like value while preserving glob tokens. */
function normalizePathLike(input: string): string {
  let path = input.trim().replaceAll("\\", "/").normalize("NFC");

  if (!path) {
    throw new Error("Repository path must not be empty.");
  }
  if (path.includes("\0")) {
    throw new Error("Repository path must not contain null bytes.");
  }
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (path.startsWith("/")) {
    throw new Error(`Repository path ${input} must be relative.`);
  }
  if (path.split("/").some((segment) => segment === "..")) {
    throw new Error(`Repository path ${input} must not contain traversal segments.`);
  }

  return path;
}

/** Compiles one bounded glob pattern into a regular expression. */
function compileGlobPattern(pattern: string): RegExp {
  const normalized = normalizePathLike(pattern);
  if (normalized.length > 240) {
    throw new Error(`Glob pattern ${pattern} is too long.`);
  }

  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (!char) {
      continue;
    }
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }

  return new RegExp(`^${source}$`, "u");
}

/** Escapes one regex literal character. */
function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

/** Returns all patterns that match a normalized repository path. */
function collectMatchingPatterns(path: string, patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => compileGlobPattern(pattern).test(path));
}

/** Normalizes labels, authors, and other exact-match values. */
function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

/** Starts a rules telemetry span with product-safe attributes. */
function startRulesSpan(
  telemetry: RulesTelemetryOptions,
  name: string,
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
): TelemetrySpanHandle | undefined {
  return telemetry.traces?.startSpan(name, {
    attributes,
    kind: "internal",
    traceContext: telemetry.traceContext,
  });
}

/** Records policy compilation metrics with bounded status labels. */
function recordRulesPolicyCompilationMetrics(
  telemetry: RulesTelemetryOptions,
  result: BuildReviewPolicySnapshotResult | undefined,
  status: "compiled" | "failed",
  durationMs: number,
): void {
  const labels = {
    status,
    warning_status:
      result === undefined ? "unknown" : result.warnings.length > 0 ? "warnings" : "clean",
  };
  telemetry.metrics?.count(OBSERVABILITY_METRIC_NAMES.rulesPolicyCompilationsTotal, {
    labels,
  });
  telemetry.metrics?.histogram(
    OBSERVABILITY_METRIC_NAMES.rulesPolicyCompileDurationMs,
    durationMs,
    {
      labels,
      unit: "ms",
    },
  );
}

/** Records one low-cardinality rules decision metric from a decision trace. */
function recordRulesDecisionTelemetry(
  telemetry: RulesTelemetryOptions,
  trace: PolicyDecisionTrace,
): void {
  telemetry.metrics?.count(OBSERVABILITY_METRIC_NAMES.rulesDecisionsTotal, {
    labels: {
      action: sanitizeRulesTelemetryLabel(trace.decision),
      decision_type: sanitizeRulesTelemetryLabel(trace.decisionType),
      reason: sanitizeRulesTelemetryLabel(trace.reasonCode),
    },
  });
}

/** Sanitizes rule telemetry label values before handing them to metric sinks. */
function sanitizeRulesTelemetryLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.:-]+/gu, "_")
    .slice(0, 80);

  return normalized.length > 0 ? normalized : "unknown";
}

/** Returns whether a repository rule has expired before the policy timestamp. */
function ruleExpired(rule: RepoRule, timestamp: string): boolean {
  const expiresAt =
    rule.metadata && typeof rule.metadata.expiresAt === "string" ? rule.metadata.expiresAt : "";
  return expiresAt.length > 0 && Date.parse(expiresAt) <= Date.parse(timestamp);
}

/** Returns suppression rule IDs that match a finding. */
function matchingSuppressionRuleIds(
  policy: EffectiveReviewPolicy,
  finding: EvaluateFindingPolicyInput["finding"],
): string[] {
  return policy.rules
    .filter((rule) => rule.effect === "suppress")
    .filter((rule) => ruleMatchesFinding(rule, finding))
    .map((rule) => rule.ruleId);
}

/** Returns whether one repository rule matches a finding. */
function ruleMatchesFinding(
  rule: RepoRule,
  finding: EvaluateFindingPolicyInput["finding"],
): boolean {
  const matcher = rule.matcher;
  if (matcher.paths && !matchesAnyPathPattern(finding.location.path, matcher.paths)) {
    return false;
  }
  if (matcher.categories && !matcher.categories.includes(finding.category)) {
    return false;
  }
  if (matcher.severities && !matcher.severities.includes(finding.severity)) {
    return false;
  }
  if (matcher.titleRegex) {
    try {
      if (!new RegExp(matcher.titleRegex, "iu").test(finding.title)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/** Creates a normalized policy decision trace. */
function policyTrace(input: {
  readonly decisionType: PolicyDecisionType;
  readonly decision: string;
  readonly reasonCode: string;
  readonly matchedRuleIds: readonly string[];
  readonly evaluatedRuleCount: number;
  readonly details: Readonly<Record<string, unknown>>;
}): PolicyDecisionTrace {
  const trace = {
    schemaVersion: "policy_decision_trace.v1",
    decisionType: input.decisionType,
    decision: input.decision,
    reasonCode: input.reasonCode,
    matchedRuleIds: [...input.matchedRuleIds],
    evaluatedRuleCount: input.evaluatedRuleCount,
    details: input.details,
  };

  if (!Value.Check(PolicyDecisionTraceSchema, trace)) {
    throw new Error("Policy decision trace does not match the schema.");
  }

  return trace as PolicyDecisionTrace;
}

/** Serializes a value as canonical JSON with sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

/** Converts a value into a JSON-safe structure with sorted object keys. */
function toCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, toCanonicalValue(entryValue)]),
    );
  }

  return value;
}

/** Creates a deterministic prefixed identifier. */
function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}

/** Returns a sha256 content hash. */
function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
