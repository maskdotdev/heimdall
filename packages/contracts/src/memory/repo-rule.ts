import { type Static, Type } from "@sinclair/typebox";
import { FindingCategorySchema, FindingSeveritySchema } from "../enums/finding";
import { CodeLanguageSchema } from "../enums/language";
import { OrgIdSchema, RepoIdSchema, RepoRuleIdSchema, UserIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const RepoRuleEffectSchema = Type.Union([
  Type.Literal("suppress"),
  Type.Literal("promote"),
  Type.Literal("require"),
  Type.Literal("context"),
  Type.Literal("style_preference"),
]);
export type RepoRuleEffect = Static<typeof RepoRuleEffectSchema>;

export const RepoRuleMatcherSchema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String())),
    languages: Type.Optional(Type.Array(CodeLanguageSchema)),
    categories: Type.Optional(Type.Array(FindingCategorySchema)),
    severities: Type.Optional(Type.Array(FindingSeveritySchema)),
    authors: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    titleRegex: Type.Optional(Type.String()),
    confidenceLessThan: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);
export type RepoRuleMatcher = Static<typeof RepoRuleMatcherSchema>;

export const RepoRuleSchema = Type.Object(
  {
    ruleId: RepoRuleIdSchema,
    orgId: OrgIdSchema,
    repoId: Type.Optional(RepoIdSchema),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    effect: RepoRuleEffectSchema,
    matcher: RepoRuleMatcherSchema,
    instruction: Type.String({ minLength: 1, maxLength: 8000 }),
    priority: Type.Integer({ minimum: 0, maximum: 1000 }),
    enabled: Type.Boolean(),
    createdByUserId: Type.Optional(UserIdSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type RepoRule = Static<typeof RepoRuleSchema>;
