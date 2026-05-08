import { type Static, Type } from "@sinclair/typebox";
import { FindingCategorySchema, FindingSeveritySchema } from "../enums/finding";
import { RepoRuleEffectSchema, RepoRuleMatcherSchema, RepoRuleSchema } from "../memory/repo-rule";
import { RepoPathSchema } from "../primitives/paths";
import { EvidenceSchema, FindingLocationSchema } from "../review/finding";
import { ApiSuccessResponseSchema } from "./common";
import { UpdateRepositoryControlPlaneSettingsRequestSchema } from "./repositories";

export const CreateRepoRuleRequestSchema = Type.Object(
  {
    name: RepoRuleSchema.properties.name,
    description: Type.Optional(RepoRuleSchema.properties.description),
    effect: RepoRuleEffectSchema,
    matcher: RepoRuleMatcherSchema,
    instruction: RepoRuleSchema.properties.instruction,
    priority: Type.Optional(RepoRuleSchema.properties.priority),
    enabled: Type.Optional(RepoRuleSchema.properties.enabled),
  },
  { additionalProperties: false },
);
export type CreateRepoRuleRequest = Static<typeof CreateRepoRuleRequestSchema>;

export const UpdateRepoRuleRequestSchema = Type.Partial(
  Type.Object(
    {
      name: RepoRuleSchema.properties.name,
      description: Type.Optional(RepoRuleSchema.properties.description),
      effect: RepoRuleEffectSchema,
      matcher: RepoRuleMatcherSchema,
      instruction: RepoRuleSchema.properties.instruction,
      priority: RepoRuleSchema.properties.priority,
      enabled: RepoRuleSchema.properties.enabled,
    },
    { additionalProperties: false },
  ),
);
export type UpdateRepoRuleRequest = Static<typeof UpdateRepoRuleRequestSchema>;

export const ListRepoRulesResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      rules: Type.Array(RepoRuleSchema),
    },
    { additionalProperties: false },
  ),
);
export type ListRepoRulesResponse = Static<typeof ListRepoRulesResponseSchema>;

/** Sample finding used to test an effective repository policy. */
export const RepositoryPolicyTestFindingSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
    category: FindingCategorySchema,
    severity: FindingSeveritySchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    location: FindingLocationSchema,
    evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: 10 })),
  },
  { additionalProperties: false },
);
export type RepositoryPolicyTestFinding = Static<typeof RepositoryPolicyTestFindingSchema>;

/** Request body for testing one repository policy against a sample finding. */
export const TestRepositoryPolicyRequestSchema = Type.Object(
  {
    settingsPatch: Type.Optional(UpdateRepositoryControlPlaneSettingsRequestSchema),
    finding: RepositoryPolicyTestFindingSchema,
    pathSizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    pathLineCount: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type TestRepositoryPolicyRequest = Static<typeof TestRepositoryPolicyRequestSchema>;

/** Supported config file content formats for validation previews. */
export const RepoLocalConfigValidationFormatSchema = Type.Union([
  Type.Literal("yaml"),
  Type.Literal("json"),
]);
/** Supported config file content formats for validation previews. */
export type RepoLocalConfigValidationFormat = Static<typeof RepoLocalConfigValidationFormatSchema>;

/** Request body for validating one repo-local reviewer config file draft. */
export const ValidateRepoLocalConfigFileRequestSchema = Type.Object(
  {
    content: Type.String(),
    format: RepoLocalConfigValidationFormatSchema,
    sourcePath: Type.Optional(RepoPathSchema),
  },
  { additionalProperties: false },
);
/** Request body for validating one repo-local reviewer config file draft. */
export type ValidateRepoLocalConfigFileRequest = Static<
  typeof ValidateRepoLocalConfigFileRequestSchema
>;

/** Validation error returned for a rejected repo-local reviewer config draft. */
export const RepoLocalConfigValidationErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Non-fatal warning returned for a repo-local reviewer config draft. */
export const RepoLocalConfigValidationWarningSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/** Response body for validating one repo-local reviewer config file draft. */
export const ValidateRepoLocalConfigFileResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      valid: Type.Boolean(),
      parsed: Type.Optional(Type.Unknown()),
      errors: Type.Array(RepoLocalConfigValidationErrorSchema),
      warnings: Type.Array(RepoLocalConfigValidationWarningSchema),
    },
    { additionalProperties: false },
  ),
);
/** Response body for validating one repo-local reviewer config file draft. */
export type ValidateRepoLocalConfigFileResponse = Static<
  typeof ValidateRepoLocalConfigFileResponseSchema
>;
