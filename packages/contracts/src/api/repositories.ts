import { type Static, Type } from "@sinclair/typebox";
import { RepositorySchema } from "../repository/repository";
import { RepositorySettingsSchema } from "../repository/settings";
import { ApiSuccessResponseSchema } from "./common";

export const ListRepositoriesResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      repositories: Type.Array(RepositorySchema),
    },
    { additionalProperties: false },
  ),
);
export type ListRepositoriesResponse = Static<typeof ListRepositoriesResponseSchema>;

export const UpdateRepositorySettingsRequestSchema = Type.Partial(
  Type.Object(
    {
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
      customInstructions: RepositorySettingsSchema.properties.customInstructions,
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);
export type UpdateRepositorySettingsRequest = Static<typeof UpdateRepositorySettingsRequestSchema>;

/** Control-plane repository settings patch, including repository enablement. */
export const UpdateRepositoryControlPlaneSettingsRequestSchema = Type.Partial(
  Type.Object(
    {
      repositoryEnabled: Type.Boolean(),
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
      customInstructions: RepositorySettingsSchema.properties.customInstructions,
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);
export type UpdateRepositoryControlPlaneSettingsRequest = Static<
  typeof UpdateRepositoryControlPlaneSettingsRequestSchema
>;

/** Control-plane settings response for one repository. */
export const RepositoryControlPlaneSettingsResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      repository: RepositorySchema,
      settings: RepositorySettingsSchema,
    },
    { additionalProperties: false },
  ),
);
export type RepositoryControlPlaneSettingsResponse = Static<
  typeof RepositoryControlPlaneSettingsResponseSchema
>;
