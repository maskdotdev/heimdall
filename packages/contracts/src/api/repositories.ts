import { Type, type Static } from "@sinclair/typebox";
import { RepositorySchema } from "../repository/repository";
import { RepositorySettingsSchema } from "../repository/settings";
import { ApiSuccessResponseSchema } from "./common";

export const ListRepositoriesResponseSchema = ApiSuccessResponseSchema(
  Type.Object({
    repositories: Type.Array(RepositorySchema)
  }, { additionalProperties: false })
);
export type ListRepositoriesResponse = Static<typeof ListRepositoriesResponseSchema>;

export const UpdateRepositorySettingsRequestSchema = Type.Partial(
  Type.Object({
    reviewPolicy: RepositorySettingsSchema.properties.reviewPolicy,
    severityThreshold: RepositorySettingsSchema.properties.severityThreshold,
    maxCommentsPerReview: RepositorySettingsSchema.properties.maxCommentsPerReview,
    ignoredPaths: RepositorySettingsSchema.properties.ignoredPaths,
    ignoredAuthors: RepositorySettingsSchema.properties.ignoredAuthors,
    ignoredLabels: RepositorySettingsSchema.properties.ignoredLabels,
    requireLabel: RepositorySettingsSchema.properties.requireLabel,
    skipGeneratedFiles: RepositorySettingsSchema.properties.skipGeneratedFiles,
    skipDraftPullRequests: RepositorySettingsSchema.properties.skipDraftPullRequests,
    enabledLanguages: RepositorySettingsSchema.properties.enabledLanguages,
    customInstructions: RepositorySettingsSchema.properties.customInstructions
  }, { additionalProperties: false }),
  { additionalProperties: false }
);
export type UpdateRepositorySettingsRequest = Static<typeof UpdateRepositorySettingsRequestSchema>;
