import { type Static, Type } from "@sinclair/typebox";
import { FindingCategorySchema, FindingSeveritySchema } from "../enums/finding";
import { RepoRuleEffectSchema, RepoRuleMatcherSchema, RepoRuleSchema } from "../memory/repo-rule";
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
