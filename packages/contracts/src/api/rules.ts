import { type Static, Type } from "@sinclair/typebox";
import { RepoRuleEffectSchema, RepoRuleMatcherSchema, RepoRuleSchema } from "../memory/repo-rule";
import { ApiSuccessResponseSchema } from "./common";

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
