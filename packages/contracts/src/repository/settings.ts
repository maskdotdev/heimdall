import { Type, type Static } from "@sinclair/typebox";
import { FindingSeveritySchema } from "../enums/finding";
import { CodeLanguageSchema } from "../enums/language";
import { RepoIdSchema } from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { IsoDateTimeSchema } from "../primitives/time";

export const ReviewPolicySchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("summary_only"),
  Type.Literal("inline_comments"),
  Type.Literal("inline_comments_and_summary"),
  Type.Literal("check_run_only"),
  Type.Literal("inline_comments_summary_and_check_run")
]);
export type ReviewPolicy = Static<typeof ReviewPolicySchema>;

export const ReviewExecutionModeSchema = Type.Union([
  Type.Literal("summary_only"),
  Type.Literal("diff_only"),
  Type.Literal("repo_context"),
  Type.Literal("full")
]);
export type ReviewExecutionMode = Static<typeof ReviewExecutionModeSchema>;

export const ReviewPassModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("summary_only"),
  Type.Literal("normal"),
  Type.Literal("strict"),
  Type.Literal("security_only"),
  Type.Literal("tests_only"),
  Type.Literal("dry_run")
]);
export type ReviewPassMode = Static<typeof ReviewPassModeSchema>;

export const PublishModeSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("summary_only"),
  Type.Literal("inline_comments_only"),
  Type.Literal("check_run_only"),
  Type.Literal("inline_comments_and_summary"),
  Type.Literal("inline_comments_summary_and_check_run")
]);
export type PublishMode = Static<typeof PublishModeSchema>;

export const RepositorySettingsSchema = Type.Object({
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
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema
}, { additionalProperties: false });
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
    "**/__generated__/**"
  ],
  ignoredAuthors: [],
  ignoredLabels: [],
  skipGeneratedFiles: true,
  skipDraftPullRequests: true
} as const;
