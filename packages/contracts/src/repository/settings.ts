import { type Static, Type } from "@sinclair/typebox";
import { FindingCategorySchema, FindingSeveritySchema } from "../enums/finding";
import { CodeLanguageSchema } from "../enums/language";
import { OrgIdSchema, RepoIdSchema, UserIdSchema } from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { IsoDateTimeSchema } from "../primitives/time";

/** Repository review publication modes configured by users. */
export const ReviewPolicySchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("summary_only"),
  Type.Literal("inline_comments"),
  Type.Literal("inline_comments_and_summary"),
  Type.Literal("check_run_only"),
  Type.Literal("inline_comments_summary_and_check_run"),
]);
/** Repository review publication modes configured by users. */
export type ReviewPolicy = Static<typeof ReviewPolicySchema>;

/** Execution depth requested for a review run. */
export const ReviewExecutionModeSchema = Type.Union([
  Type.Literal("summary_only"),
  Type.Literal("diff_only"),
  Type.Literal("repo_context"),
  Type.Literal("full"),
]);
/** Execution depth requested for a review run. */
export type ReviewExecutionMode = Static<typeof ReviewExecutionModeSchema>;

/** Coarse review pass mode used by orchestration and product controls. */
export const ReviewPassModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("summary_only"),
  Type.Literal("normal"),
  Type.Literal("strict"),
  Type.Literal("security_only"),
  Type.Literal("tests_only"),
  Type.Literal("dry_run"),
]);
/** Coarse review pass mode used by orchestration and product controls. */
export type ReviewPassMode = Static<typeof ReviewPassModeSchema>;

/** Publication channels that a compiled policy can request. */
export const PublishModeSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("summary_only"),
  Type.Literal("inline_comments_only"),
  Type.Literal("check_run_only"),
  Type.Literal("inline_comments_and_summary"),
  Type.Literal("inline_comments_summary_and_check_run"),
]);
/** Publication channels that a compiled policy can request. */
export type PublishMode = Static<typeof PublishModeSchema>;

/** Actor roles trusted for durable feedback-derived memory actions. */
export const MemoryTrustedActorRoleSchema = Type.Union([
  Type.Literal("org_admin"),
  Type.Literal("repo_admin"),
  Type.Literal("maintainer"),
  Type.Literal("member"),
]);
/** Actor roles trusted for durable feedback-derived memory actions. */
export type MemoryTrustedActorRole = Static<typeof MemoryTrustedActorRoleSchema>;

/** Organization-level default trigger policy for repositories. */
export const OrgReviewTriggerPolicySchema = Type.Object(
  {
    enabledActions: Type.Array(Type.String({ minLength: 1 })),
    ignoredAuthors: Type.Array(Type.String()),
    ignoredLabels: Type.Array(Type.String()),
    requireLabel: Type.Optional(Type.String({ minLength: 1 })),
    skipDraftPullRequests: Type.Boolean(),
  },
  { additionalProperties: false },
);
/** Organization-level default trigger policy for repositories. */
export type OrgReviewTriggerPolicy = Static<typeof OrgReviewTriggerPolicySchema>;

/** Organization-level default finding policy for repositories. */
export const OrgFindingPolicySchema = Type.Object(
  {
    allowStyleFindings: Type.Boolean(),
    enabledCategories: Type.Array(FindingCategorySchema),
    maxCommentsPerReview: Type.Integer({ minimum: 0, maximum: 50 }),
    minimumConfidence: Type.Number({ minimum: 0, maximum: 1 }),
    severityThreshold: FindingSeveritySchema,
    suppressGeneratedFileFindings: Type.Boolean(),
  },
  { additionalProperties: false },
);
/** Organization-level default finding policy for repositories. */
export type OrgFindingPolicy = Static<typeof OrgFindingPolicySchema>;

/** Organization-level default publishing policy for repositories. */
export const OrgPublishingPolicySchema = Type.Object(
  {
    maxCommentsPerReview: Type.Integer({ minimum: 0, maximum: 50 }),
    publishCheckRun: Type.Boolean(),
    publishInlineComments: Type.Boolean(),
    publishSummaryComment: Type.Boolean(),
  },
  { additionalProperties: false },
);
/** Organization-level default publishing policy for repositories. */
export type OrgPublishingPolicy = Static<typeof OrgPublishingPolicySchema>;

/** Organization-level default memory policy for repositories. */
export const OrgMemoryPolicySchema = Type.Object(
  {
    allowExactFindingSuppression: Type.Boolean(),
    allowNaturalLanguageInstructions: Type.Boolean(),
    allowPathCategorySuppression: Type.Boolean(),
    enableMemoryContext: Type.Boolean(),
    enableMemorySuppression: Type.Boolean(),
    maxMemoryFactsInContext: Type.Integer({ minimum: 0, maximum: 20 }),
    memoryTtlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    requireApprovalForMemoryFacts: Type.Boolean(),
    trustedFeedbackRoles: Type.Array(MemoryTrustedActorRoleSchema),
  },
  { additionalProperties: false },
);
/** Organization-level default memory policy for repositories. */
export type OrgMemoryPolicy = Static<typeof OrgMemoryPolicySchema>;

/** Organization-wide policy defaults that repository settings can inherit or tighten. */
export const OrgSettingsSchema = Type.Object(
  {
    schemaVersion: Type.Literal("org_settings.v1"),
    orgId: OrgIdSchema,
    defaultReviewPolicy: ReviewPolicySchema,
    defaultTriggerPolicy: OrgReviewTriggerPolicySchema,
    defaultFindingPolicy: OrgFindingPolicySchema,
    defaultPublishingPolicy: OrgPublishingPolicySchema,
    defaultMemoryPolicy: OrgMemoryPolicySchema,
    allowedModelProfiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowRepoLocalConfig: Type.Boolean(),
    allowMemorySuppression: Type.Boolean(),
    allowUserDefinedRules: Type.Boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    updatedByUserId: Type.Union([UserIdSchema, Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
/** Organization-wide policy defaults that repository settings can inherit or tighten. */
export type OrgSettings = Static<typeof OrgSettingsSchema>;

/** Sandbox runner kinds that repository settings can request. */
export const SandboxRunnerSettingSchema = Type.Union([
  Type.Literal("docker"),
  Type.Literal("gvisor"),
  Type.Literal("microvm"),
]);
export type SandboxRunnerSetting = Static<typeof SandboxRunnerSettingSchema>;

/** Minimum sandbox runner setting for forked pull requests. */
export const SandboxForkRunnerSettingSchema = Type.Union([
  SandboxRunnerSettingSchema,
  Type.Literal("disabled"),
]);
export type SandboxForkRunnerSetting = Static<typeof SandboxForkRunnerSettingSchema>;

/** Optional repository-level sandbox policy overrides. */
export const RepositorySandboxSettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    defaultRunner: Type.Optional(SandboxRunnerSettingSchema),
    minimumRunnerForForks: Type.Optional(SandboxForkRunnerSettingSchema),
    allowNetwork: Type.Optional(Type.Boolean()),
    allowDependencyInstall: Type.Optional(Type.Boolean()),
    allowCustomCommands: Type.Optional(Type.Boolean()),
    maxTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
    maxMemoryBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 8_589_934_592 })),
    maxCpuCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    maxOutputBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000 })),
    maxArtifactBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 250_000_000 })),
  },
  { additionalProperties: false },
);
/** Optional repository-level sandbox policy overrides. */
export type RepositorySandboxSettings = Static<typeof RepositorySandboxSettingsSchema>;

export const RepositorySettingsSchema = Type.Object(
  {
    repoId: RepoIdSchema,
    reviewPolicy: ReviewPolicySchema,
    severityThreshold: FindingSeveritySchema,
    maxCommentsPerReview: Type.Integer({ minimum: 0, maximum: 50 }),
    ignoredPaths: Type.Array(RepoPathSchema),
    ignoredAuthors: Type.Array(Type.String()),
    ignoredLabels: Type.Array(Type.String()),
    requireLabel: Type.Optional(Type.String()),
    skipGeneratedFiles: Type.Boolean(),
    skipDraftPullRequests: Type.Boolean(),
    enabledLanguages: Type.Optional(Type.Array(CodeLanguageSchema)),
    customInstructions: Type.Optional(Type.String({ maxLength: 12000 })),
    sandboxPolicy: Type.Optional(RepositorySandboxSettingsSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type RepositorySettings = Static<typeof RepositorySettingsSchema>;

export const DEFAULT_REPOSITORY_SETTINGS = {
  reviewPolicy: "inline_comments_and_summary",
  severityThreshold: "medium",
  maxCommentsPerReview: 5,
  ignoredPaths: [
    "node_modules/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "**/*.generated.*",
    "**/__generated__/**",
  ],
  ignoredAuthors: [],
  ignoredLabels: [],
  skipGeneratedFiles: true,
  skipDraftPullRequests: true,
} as const;

/** Default organization policy values used when an org has no saved settings row. */
export const DEFAULT_ORG_SETTINGS = {
  defaultReviewPolicy: "inline_comments_and_summary",
  defaultTriggerPolicy: {
    enabledActions: ["opened", "synchronize", "reopened", "ready_for_review", "labeled", "manual"],
    ignoredAuthors: [],
    ignoredLabels: [],
    skipDraftPullRequests: true,
  },
  defaultFindingPolicy: {
    allowStyleFindings: false,
    enabledCategories: [
      "correctness",
      "security",
      "performance",
      "test_coverage",
      "maintainability",
      "architecture",
      "dependency",
    ],
    maxCommentsPerReview: 5,
    minimumConfidence: 0.65,
    severityThreshold: "medium",
    suppressGeneratedFileFindings: true,
  },
  defaultPublishingPolicy: {
    maxCommentsPerReview: 5,
    publishCheckRun: false,
    publishInlineComments: true,
    publishSummaryComment: true,
  },
  defaultMemoryPolicy: {
    allowExactFindingSuppression: true,
    allowNaturalLanguageInstructions: true,
    allowPathCategorySuppression: true,
    enableMemoryContext: true,
    enableMemorySuppression: true,
    maxMemoryFactsInContext: 6,
    memoryTtlDays: 180,
    requireApprovalForMemoryFacts: true,
    trustedFeedbackRoles: ["org_admin", "repo_admin", "maintainer"],
  },
  allowRepoLocalConfig: false,
  allowMemorySuppression: true,
  allowUserDefinedRules: true,
} as const;
